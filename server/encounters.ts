/**
 * 服务器跑遭遇（SERVER-DESIGN.md 第五节、九.4）。
 *
 * - 遭遇属于一个战役。服务器上有权威的 Session（和浏览器里同一份引擎、同一份规则书），
 *   骰子由服务器掷；存的就是 Session 的存档（起点 + 每笔事务的输入），每次变化后写库。
 * - 客户端通过 SSE 收到完整存档，在本地 Session.restore 一遍用来画界面；所有操作都发给服务器。
 * - 权限：DM 什么都能做；玩家只能操作自己的参与者（参与者的控制者 → 用户，记在 owners 里），
 *   只能回答发给自己的决定，回合推进只能在自己的回合「结束回合」。
 * - 骰子：每个控制者选「服务器掷 / 实体骰」（dice）；实体骰会停下来等那个人填骰面。
 * - 隐藏：DM 可以把参与者藏起来（hidden），怪物的数值也只给 DM 看。只在界面上藏 ——
 *   数据照样发给所有人，私人网站够用了。
 * - 地图（map）：格子、底图、画笔、棋子。和战斗规则分开存，改地图不进撤销记录，走单独的 SSE 事件 `map`。
 *   新操作发起时把棋子位置拍进事务（TxInput.positions），引擎据此自动算距离。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import {
  DICE_MODES, RuleBook, Session, createEncounter, defaultDiceMode, diceSourceFor, footprint, type DiceMode,
  type Command, type DispatchResult, type EngineCtx, type Diagonal, type OverridePatch, type Positions, type SessionSave,
} from '../src/combat';
import { RULE_FILES } from '../src/bridge/rule-files';

type Row = Record<string, unknown>;
interface User { id: number; name: string }
export interface Deps {
  one: (sql: string, ...a: Array<string | number | null>) => Row | undefined;
  all: (sql: string, ...a: Array<string | number | null>) => Row[];
  run: (sql: string, ...a: Array<string | number | null | Uint8Array>) => unknown;
  exec: (sql: string) => void;
  bodyOf: (req: IncomingMessage) => Promise<Row>;
  send: (res: ServerResponse, status: number, data: unknown, headers?: Record<string, string>) => void;
  roleIn: (u: User, campaignId: string) => 'dm' | 'player' | null;
  fail: (status: number, message: string) => Error;
}

export interface Stroke { id: string; by: number; color: string; width: number; pts: number[] }
export interface MapState {
  /** 一格多少像素（底图坐标）、格子原点偏移、格子铺多大、显不显示 */
  grid: { size: number; ox: number; oy: number; cols: number; rows: number; show: boolean; diagonal?: Diagonal };
  bg: { img: string; w: number; h: number } | null;
  strokes: Stroke[];
  /** 参与者 id → 格子坐标（占的左上角那一格） */
  tokens: Record<string, { x: number; y: number }>;
}
const newMap = (): MapState => ({ grid: { size: 50, ox: 0, oy: 0, cols: 30, rows: 20, show: true }, bg: null, strokes: [], tokens: {} });
const MAX_STROKES = 3000;
const MAX_PTS = 4000;

interface Live {
  id: string;
  campaignId: string;
  name: string;
  session: Session;
  /** 控制者 id → 用户 id（PC 的控制者就是参与者 id；没登记的都归 DM） */
  owners: Record<string, number>;
  /** 参与者 id → 人物卡 id（写回用） */
  cards: Record<string, string>;
  /** 控制者 id（'*' = 默认，'dm' = DM 和怪物）→ 骰子来源 */
  dice: Record<string, DiceMode>;
  /** DM 藏起来的参与者 */
  hidden: string[];
  map: MapState;
  ctx: EngineCtx;
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
    CREATE TABLE IF NOT EXISTS map_images (
      id TEXT PRIMARY KEY, encounter_id TEXT NOT NULL REFERENCES encounters(id) ON DELETE CASCADE,
      mime TEXT NOT NULL, data BLOB NOT NULL, created INTEGER NOT NULL
    );
  `);
  const rules = new RuleBook(RULE_FILES);
  if (rules.problems.length) console.warn('规则书问题：', rules.problems.slice(0, 5));
  const live = new Map<string, Live>();

  /** 每场遭遇自己的引擎上下文：骰子按这场的设置，棋子位置按这场的地图 */
  function ctxOf(e: { dice: Live['dice']; map: MapState; session?: Session }): EngineCtx {
    return {
      rules,
      diceFor: (user) => diceSourceFor(e.dice[user] ?? e.dice['*'] ?? defaultDiceMode(user)),
      positions: () => {
        const st = e.session?.state;
        if (!st) return null;
        const out: Positions = {};
        for (const [id, t] of Object.entries(e.map.tokens)) {
          const c = st.combatants[id];
          if (c) out[id] = { x: t.x, y: t.y, s: footprint(c.base.size) };
        }
        return Object.keys(out).length ? out : null;
      },
      diagonal: () => e.map.grid.diagonal ?? '5',
    };
  }

  function load(id: string): Live | null {
    const hit = live.get(id);
    if (hit) return hit;
    const r = d.one('SELECT * FROM encounters WHERE id = ?', id);
    if (!r) return null;
    const meta = JSON.parse(String(r.meta || '{}'));
    const e = {
      id, campaignId: String(r.campaign_id), name: String(r.name),
      owners: meta.owners ?? {}, cards: meta.cards ?? {}, dice: meta.dice ?? {}, hidden: meta.hidden ?? [],
      map: { ...newMap(), ...(meta.map ?? {}) }, seq: 0, watchers: new Set(),
    } as unknown as Live;
    e.ctx = ctxOf(e);
    e.session = Session.restore(JSON.parse(String(r.save)) as SessionSave, e.ctx);
    live.set(id, e);
    return e;
  }

  const stateOf = (e: Live) => ({
    id: e.id, name: e.name, campaignId: e.campaignId, seq: e.seq, owners: e.owners, cards: e.cards,
    dice: e.dice, hidden: e.hidden, map: e.map, save: e.session.save(),
  });
  const metaOf = (e: Live) => JSON.stringify({ owners: e.owners, cards: e.cards, dice: e.dice, hidden: e.hidden, map: e.map });
  const broadcast = (e: Live, event: string, data: unknown) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const w of e.watchers) w.write(msg);
  };

  function changed(e: Live): void {
    e.seq++;
    d.run('UPDATE encounters SET save = ?, meta = ?, updated = ? WHERE id = ?', JSON.stringify(e.session.save()), metaOf(e), Date.now(), e.id);
    broadcast(e, 'state', stateOf(e));
  }
  /** 只改了地图：不重发整场战斗（客户端重放要时间） */
  function mapChanged(e: Live): void {
    d.run('UPDATE encounters SET meta = ?, updated = ? WHERE id = ?', metaOf(e), Date.now(), e.id);
    broadcast(e, 'map', e.map);
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
  const PLAYER_CMDS = new Set(['useAction', 'roll', 'addCombatant', 'removeCombatant', 'refreshCombatant', 'heal', 'tempHp', 'setUsage', 'manualCast', 'damage']);

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

  /** 地图操作；返回拒绝原因 */
  function mapOp(e: Live, u: User, role: 'dm' | 'player', b: Row): string | null {
    const m = e.map;
    const dm = role === 'dm';
    const num = (v: unknown, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(Number(v) || 0)));
    switch (String(b.action ?? '')) {
      case 'token': {
        const id = String(b.id ?? '');
        if (!e.session.state.combatants[id]) return '没有这个参与者';
        if (!dm && ownerOf(e, id) !== u.id) return '只能移动自己的棋子';
        if (b.x == null) delete m.tokens[id];
        else m.tokens[id] = { x: num(b.x, -200, 1000), y: num(b.y, -200, 1000) };
        return null;
      }
      case 'stroke': {
        const pts = Array.isArray(b.pts) ? (b.pts as unknown[]).slice(0, MAX_PTS * 2).map((v) => Math.round(Number(v) * 10) / 10) : [];
        if (pts.length < 4 || pts.some((v) => !Number.isFinite(v))) return '线太短';
        if (m.strokes.length >= MAX_STROKES) return '画得太多了，先擦掉一些';
        const color = /^#[0-9a-f]{6}$/i.test(String(b.color)) ? String(b.color) : '#c0392b';
        m.strokes.push({ id: randomUUID().slice(0, 8), by: u.id, color, width: num(b.width, 1, 40), pts });
        return null;
      }
      case 'erase': {
        const ids = new Set((Array.isArray(b.ids) ? b.ids : [b.id]).map(String));
        const hit = m.strokes.filter((x) => ids.has(x.id));
        if (!dm && hit.some((x) => x.by !== u.id)) return '只能擦自己画的';
        m.strokes = m.strokes.filter((x) => !ids.has(x.id));
        return null;
      }
      case 'clear':
        // DM 清全部；玩家（或 DM 选「只清我的」）清自己画的
        m.strokes = dm && !b.mine ? [] : m.strokes.filter((x) => x.by !== u.id);
        return null;
      case 'grid':
        if (!dm) return '只有 DM 能调格子';
        m.grid = {
          size: num(b.size ?? m.grid.size, 8, 400), ox: num(b.ox ?? m.grid.ox, -400, 400), oy: num(b.oy ?? m.grid.oy, -400, 400),
          cols: num(b.cols ?? m.grid.cols, 1, 200), rows: num(b.rows ?? m.grid.rows, 1, 200), show: b.show == null ? m.grid.show : !!b.show,
          diagonal: b.diagonal === '5-10-5' ? '5-10-5' : b.diagonal === '5' ? '5' : m.grid.diagonal ?? '5',
        };
        return null;
      case 'bg': {
        if (!dm) return '只有 DM 能换底图';
        d.run('DELETE FROM map_images WHERE encounter_id = ?', e.id);
        if (b.dataUrl == null) { m.bg = null; return null; }
        const hit = String(b.dataUrl).match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/);
        if (!hit) return '底图要 png / jpg / webp / gif';
        const img = randomUUID();
        d.run('INSERT INTO map_images (id, encounter_id, mime, data, created) VALUES (?, ?, ?, ?, ?)', img, e.id, hit[1], Buffer.from(hit[2], 'base64'), Date.now());
        m.bg = { img, w: num(b.w, 1, 20000), h: num(b.h, 1, 20000) };
        // 换了底图：格子按新图铺满（格子大小留着，DM 再对齐）
        m.grid = { ...m.grid, ox: 0, oy: 0, cols: Math.ceil(m.bg.w / m.grid.size), rows: Math.ceil(m.bg.h / m.grid.size) };
        return null;
      }
      default: return '不认识的地图操作';
    }
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
        const s = new Session(createEncounter(id), ctxOf({ dice: {}, map: newMap() }));
        const now = Date.now();
        // 从上一场复制地图（底图、格子、画笔；棋子不带）
        const src = typeof b.copyMapFrom === 'string' ? load(b.copyMapFrom) : null;
        const map = src && src.campaignId === m[1] ? { ...structuredClone(src.map), tokens: {} } : null;
        if (map?.bg) map.bg.img = randomUUID();
        d.run('INSERT INTO encounters (id, campaign_id, name, save, meta, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?)',
          id, m[1], name, JSON.stringify(s.save()), map ? JSON.stringify({ map }) : '{}', now, now);
        if (map?.bg) d.run('INSERT INTO map_images (id, encounter_id, mime, data, created) SELECT ?, ?, mime, data, ? FROM map_images WHERE encounter_id = ?', map.bg.img, id, now, src!.id);
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

    if (method === 'GET' && sub === '/bg') {
      const img = d.one('SELECT mime, data FROM map_images WHERE encounter_id = ?', e.id);
      if (!img) throw d.fail(404, '没有底图');
      // URL 里带着图的 id（?v=），换图就换 URL，可以放心缓存
      res.writeHead(200, { 'content-type': String(img.mime), 'cache-control': 'private, max-age=31536000, immutable' });
      res.end(img.data as Uint8Array);
      return true;
    }

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
      const reject = (reason: string) => { d.send(res, 200, { status: 'rejected', reason }); return true; };
      if (op === 'dispatch') {
        const cmd = b.cmd as Command;
        if (!cmd || typeof cmd !== 'object' || !cmd.type) throw d.fail(400, '缺命令');
        const why = check(e, u, role, cmd);
        if (why) return reject(why);
        if (s.pending) return reject('还有一个决定没做完');
        r = s.dispatch(cmd);
        if (r.status !== 'rejected' && cmd.type === 'addCombatant') {
          const ctl = cmd.combatant.controller ?? cmd.combatant.id;
          // 玩家加的归自己；DM 替玩家加（带了卡主）就归卡主；DM 自己的怪不登记
          const owner = role === 'player' ? u.id : typeof b.owner === 'number' ? b.owner : null;
          if (owner != null) e.owners[ctl] = owner;
          if (typeof b.cardId === 'string') e.cards[cmd.combatant.id] = b.cardId;
          if (role === 'dm' && b.hidden) e.hidden.push(cmd.combatant.id);
        }
        if (r.status !== 'rejected' && cmd.type === 'removeCombatant') {
          delete e.map.tokens[cmd.id];
          e.hidden = e.hidden.filter((x) => x !== cmd.id);
        }
      } else if (op === 'decide' || op === 'cancelPending') {
        if (!s.pending) return reject('没有等待中的决定');
        const to = s.pending.decision.to;
        if (role !== 'dm' && e.owners[to] !== u.id) return reject('这个决定不是问你的');
        if (op === 'decide') r = s.decide(b.value);
        else s.cancelPending();
      } else if (op === 'undo' || op === 'override' || op === 'reset') {
        if (role !== 'dm') return reject('只有 DM 能撤销、裁定、清空');
        if (op === 'undo') s.undo(Math.max(1, Number(b.n ?? 1)));
        else if (op === 'override') r = s.override(Number(b.txIndex), b.patch as OverridePatch);
        else { e.owners = {}; e.cards = {}; e.hidden = []; e.map.tokens = {}; e.session = new Session(createEncounter(e.id), e.ctx); }
      } else if (op === 'setDice') {
        // 玩家只能改自己控制的；DM 什么都能改（包括默认 '*' 和怪物 'dm'）
        const who = String(b.user ?? '');
        if (!who) throw d.fail(400, '缺 user');
        if (role !== 'dm' && e.owners[who] !== u.id) return reject('只能改自己的骰子');
        if (DICE_MODES.includes(b.mode as DiceMode)) e.dice[who] = b.mode as DiceMode;
        else delete e.dice[who];
      } else if (op === 'setHidden') {
        if (role !== 'dm') return reject('只有 DM 能藏人');
        const id = String(b.id ?? '');
        e.hidden = e.hidden.filter((x) => x !== id);
        if (b.hidden) e.hidden.push(id);
      } else if (op === 'map') {
        const why = mapOp(e, u, role, b);
        if (why) return reject(why);
        mapChanged(e);
        d.send(res, 200, { status: 'done' });
        return true;
      } else throw d.fail(400, '不认识的操作');
      changed(e);
      d.send(res, 200, r.status === 'rejected' ? { status: 'rejected', reason: r.reason } : { status: r.status });
      return true;
    }
    return false;
  };
}
