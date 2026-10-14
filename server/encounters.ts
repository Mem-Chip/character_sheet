/**
 * 服务器跑遭遇（SERVER-DESIGN.md 第五节、九.4）。
 *
 * - 遭遇属于一个战役。服务器上有权威的 Session（和浏览器里同一份引擎、同一份规则书），
 *   骰子由服务器掷；存的就是 Session 的存档（起点 + 每笔事务的输入），每次变化后写库。
 * - 客户端通过 SSE 收到完整存档，在本地 Session.restore 一遍用来画界面；所有操作都发给服务器。
 * - 权限：DM 什么都能做；玩家只能操作自己的参与者（参与者的控制者 → 用户，记在 owners 里），
 *   只能回答发给自己的决定，回合推进只能在自己的回合「结束回合」。
 * - 还没做：按人过滤可见性（怪物 AC、DM 暗骰）——现在所有人看到的都一样。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { RuleBook, Session, createEncounter, engineDice, type Command, type DispatchResult, type EngineCtx, type OverridePatch, type SessionSave } from '../src/combat';
import { RULE_FILES } from '../src/bridge/rule-files';

type Row = Record<string, unknown>;
interface User { id: number; name: string }
export interface Deps {
  one: (sql: string, ...a: Array<string | number | null>) => Row | undefined;
  all: (sql: string, ...a: Array<string | number | null>) => Row[];
  run: (sql: string, ...a: Array<string | number | null>) => unknown;
  exec: (sql: string) => void;
  bodyOf: (req: IncomingMessage) => Promise<Row>;
  send: (res: ServerResponse, status: number, data: unknown, headers?: Record<string, string>) => void;
  roleIn: (u: User, campaignId: string) => 'dm' | 'player' | null;
  fail: (status: number, message: string) => Error;
}

interface Live {
  id: string;
  campaignId: string;
  name: string;
  session: Session;
  /** 控制者 id → 用户 id（PC 的控制者就是参与者 id；没登记的都归 DM） */
  owners: Record<string, number>;
  /** 参与者 id → 人物卡 id（写回用） */
  cards: Record<string, string>;
  seq: number;
  watchers: Set<ServerResponse>;
}

export function createEncounters(d: Deps) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS encounters (
      id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      name TEXT NOT NULL, save TEXT NOT NULL, meta TEXT NOT NULL DEFAULT '{}',
      created INTEGER NOT NULL, updated INTEGER NOT NULL, closed INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS encounters_campaign ON encounters(campaign_id);
  `);
  const rules = new RuleBook(RULE_FILES);
  if (rules.problems.length) console.warn('规则书问题：', rules.problems.slice(0, 5));
  const ctx: EngineCtx = { rules, diceFor: () => engineDice() };
  const live = new Map<string, Live>();

  function load(id: string): Live | null {
    const hit = live.get(id);
    if (hit) return hit;
    const r = d.one('SELECT * FROM encounters WHERE id = ?', id);
    if (!r) return null;
    const meta = JSON.parse(String(r.meta || '{}'));
    const e: Live = {
      id, campaignId: String(r.campaign_id), name: String(r.name),
      session: Session.restore(JSON.parse(String(r.save)) as SessionSave, ctx),
      owners: meta.owners ?? {}, cards: meta.cards ?? {}, seq: 0, watchers: new Set(),
    };
    live.set(id, e);
    return e;
  }

  const stateOf = (e: Live) => ({ id: e.id, name: e.name, campaignId: e.campaignId, seq: e.seq, owners: e.owners, cards: e.cards, save: e.session.save() });

  function changed(e: Live): void {
    e.seq++;
    d.run('UPDATE encounters SET save = ?, meta = ?, updated = ? WHERE id = ?',
      JSON.stringify(e.session.save()), JSON.stringify({ owners: e.owners, cards: e.cards }), Date.now(), e.id);
    const msg = `event: state\ndata: ${JSON.stringify(stateOf(e))}\n\n`;
    for (const w of e.watchers) w.write(msg);
  }

  /** 这条命令针对哪个参与者（玩家只能动自己的） */
  function subjectOf(cmd: Command): string | null {
    const c = cmd as unknown as Row;
    return String(c.actor ?? c.roller ?? c.id ?? (c.combatant as Row | undefined)?.id ?? '') || null;
  }
  const ownerOf = (e: Live, combatantId: string) => {
    const ctl = e.session.state.combatants[combatantId]?.controller ?? combatantId;
    return e.owners[ctl];
  };

  /** 玩家能发的命令 */
  const PLAYER_CMDS = new Set(['useAction', 'roll', 'addCombatant', 'removeCombatant', 'heal', 'tempHp', 'setUsage', 'manualCast', 'damage']);

  function check(e: Live, u: User, role: 'dm' | 'player', cmd: Command): string | null {
    if (role === 'dm') return null;
    if (cmd.type === 'nextTurn') {
      const st = e.session.state;
      const cur = st.round !== null ? st.order[st.turnIndex] : null;
      return cur && ownerOf(e, cur) === u.id ? null : '只能结束自己的回合';
    }
    if (!PLAYER_CMDS.has(cmd.type)) return '这件事要 DM 来做';
    if (cmd.type === 'addCombatant') return cmd.combatant.kind === 'pc' ? null : '玩家只能加自己的角色';
    const who = subjectOf(cmd);
    if (!who || ownerOf(e, who) !== u.id) return '只能操作自己的角色';
    return null;
  }

  return async function handle(req: IncomingMessage, res: ServerResponse, u: User, path: string, method: string): Promise<boolean> {
    let m = path.match(/^\/api\/campaigns\/([\w-]{1,64})\/encounters$/);
    if (m) {
      const role = d.roleIn(u, m[1]);
      if (!role) throw d.fail(404, '没有这个战役');
      if (method === 'GET') {
        const list = d.all('SELECT id, name, updated, closed FROM encounters WHERE campaign_id = ? ORDER BY updated DESC', m[1]);
        d.send(res, 200, { encounters: list });
        return true;
      }
      if (method === 'POST') {
        if (role !== 'dm') throw d.fail(403, '只有 DM 能开遭遇');
        const b = await d.bodyOf(req);
        const id = randomUUID();
        const name = String(b.name ?? '').trim().slice(0, 40) || '遭遇';
        const s = new Session(createEncounter(id), ctx);
        const now = Date.now();
        d.run('INSERT INTO encounters (id, campaign_id, name, save, created, updated) VALUES (?, ?, ?, ?, ?, ?)', id, m[1], name, JSON.stringify(s.save()), now, now);
        d.send(res, 200, { id, name });
        return true;
      }
    }

    m = path.match(/^\/api\/encounters\/([\w-]{1,64})(\/[a-z]+)?$/);
    if (!m) return false;
    const e = load(m[1]);
    const role = e ? d.roleIn(u, e.campaignId) : null;
    if (!e || !role) throw d.fail(404, '没有这个遭遇');
    const sub = m[2] ?? '';

    if (method === 'GET' && sub === '') { d.send(res, 200, { ...stateOf(e), role, me: u.id }); return true; }

    if (method === 'GET' && sub === '/stream') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store',
        connection: 'keep-alive', 'x-accel-buffering': 'no',   // nginx：别攒着，来一条发一条
      });
      res.write(`event: state\ndata: ${JSON.stringify(stateOf(e))}\n\n`);
      e.watchers.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
      req.on('close', () => { clearInterval(ping); e.watchers.delete(res); });
      return true;
    }

    if (method === 'DELETE' && sub === '') {
      if (role !== 'dm') throw d.fail(403, '只有 DM 能删遭遇');
      for (const w of e.watchers) w.end();
      live.delete(e.id);
      d.run('DELETE FROM encounters WHERE id = ?', e.id);
      d.send(res, 200, { ok: true });
      return true;
    }

    if (method === 'POST' && sub === '/act') {
      const b = await d.bodyOf(req);
      const op = String(b.op ?? '');
      let r: DispatchResult = { status: 'done', events: [] };
      const s = e.session;
      if (op === 'dispatch') {
        const cmd = b.cmd as Command;
        if (!cmd || typeof cmd !== 'object' || !cmd.type) throw d.fail(400, '缺命令');
        const why = check(e, u, role, cmd);
        if (why) { d.send(res, 200, { status: 'rejected', reason: why }); return true; }
        if (s.pending) { d.send(res, 200, { status: 'rejected', reason: '还有一个决定没做完' }); return true; }
        r = s.dispatch(cmd);
        if (r.status !== 'rejected' && cmd.type === 'addCombatant') {
          const ctl = cmd.combatant.controller ?? cmd.combatant.id;
          // 玩家加的归自己；DM 替玩家加（带了卡主）就归卡主；DM 自己的怪不登记
          const owner = role === 'player' ? u.id : typeof b.owner === 'number' ? b.owner : null;
          if (owner != null) e.owners[ctl] = owner;
          if (typeof b.cardId === 'string') e.cards[cmd.combatant.id] = b.cardId;
        }
      } else if (op === 'decide' || op === 'cancelPending') {
        if (!s.pending) { d.send(res, 200, { status: 'rejected', reason: '没有等待中的决定' }); return true; }
        const to = s.pending.decision.to;
        if (role !== 'dm' && e.owners[to] !== u.id) { d.send(res, 200, { status: 'rejected', reason: '这个决定不是问你的' }); return true; }
        if (op === 'decide') r = s.decide(b.value);
        else s.cancelPending();
      } else if (op === 'undo' || op === 'override' || op === 'reset') {
        if (role !== 'dm') { d.send(res, 200, { status: 'rejected', reason: '只有 DM 能撤销、裁定、清空' }); return true; }
        if (op === 'undo') s.undo(Math.max(1, Number(b.n ?? 1)));
        else if (op === 'override') r = s.override(Number(b.txIndex), b.patch as OverridePatch);
        else { e.session = new Session(createEncounter(e.id), ctx); e.owners = {}; e.cards = {}; }
      } else throw d.fail(400, '不认识的操作');
      changed(e);
      d.send(res, 200, r.status === 'rejected' ? { status: 'rejected', reason: r.reason } : { status: r.status });
      return true;
    }
    return false;
  };
}
