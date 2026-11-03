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
 * - 指令框（chat）：/r、/pr 掷骰，服务器掷，单独的 SSE 事件 `chat`，不进战斗事务。
 * - 地图（map）：格子、底图、画笔、棋子。和战斗规则分开存，改地图不进撤销记录，走单独的 SSE 事件 `map`。
 *   新操作发起时把棋子位置拍进事务（TxInput.positions），引擎据此自动算距离。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import {
  DICE_MODES, RuleBook, Session, createEncounter, defaultDiceMode, diceSourceFor, encounterLayers, footprint, gridFeet, lineCells, chatEntry, type ChatRoll, type DiceMode,
  type Command, type DispatchResult, type EngineCtx, type Diagonal, type HouseRule, type OverridePatch, type Positions, type RuleLayer, type SessionSave,
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
  /** 战役资料里的战斗部分（开遭遇时抄进遭遇） */
  campaignRules?: (campaignId: string) => HouseRule[];
  /** 某个账户自己的资料库的战斗部分（参战者带卡进场时叠成一层） */
  ownerRules?: (ownerId: number, campaignId?: string) => HouseRule[];
}

export interface Stroke { id: string; by: number; color: string; width: number; pts: number[] }
/** 测量用的形状（app/lib/area.ts 的 Tpl：圆 / 方 / 锥 / 线，世界坐标） */
export interface Shape { id: string; by: number; color: string; tpl: Record<string, number | string> }
/** 当前回合的人这一回合走过的格子（key = 轮次:先攻位置，换人就作废） */
export interface Trail { id: string; key: string; cells: Array<{ x: number; y: number }> }
export interface MapState {
  /** 一格多少像素（底图坐标）、格子原点偏移、格子铺多大、显不显示 */
  grid: { size: number; ox: number; oy: number; cols: number; rows: number; show: boolean; diagonal?: Diagonal; paper?: string; line?: string; cover?: 'center' | 'corners'; coverK?: number };
  bg: { img: string; w: number; h: number } | null;
  strokes: Stroke[];
  /** 参与者 id → 格子坐标（占的左上角那一格） */
  tokens: Record<string, { x: number; y: number }>;
  /** 参与者 id → 自定义立绘头像 dataURL */
  avatars?: Record<string, string>;
  shapes: Shape[];
  trail: Trail | null;
  /** 战争迷雾：开着时，玩家只看得到揭开了的格子（"x,y"）；DM 用笔刷揭开 / 盖上 */
  fog?: { on: boolean; open: string[] };
}
const MAX_FOG = 40000;
/** '#abc' / '#aabbcc' / '#aabbcc80'；'' 清掉；其余保持原值 */
const hexOr = (v: unknown, old?: string): string | undefined =>
  v === '' ? undefined : typeof v === 'string' && /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v) ? v : old;
const newMap = (): MapState => ({ grid: { size: 50, ox: 0, oy: 0, cols: 30, rows: 20, show: true }, bg: null, strokes: [], tokens: {}, shapes: [], trail: null });
const SHAPE_KEYS: Record<string, string[]> = { circle: ['cx', 'cy', 'r'], rect: ['x', 'y', 'w', 'h'], cone: ['x', 'y', 'len', 'dir'], line: ['x', 'y', 'len', 'width', 'dir'] };
const MAX_SHAPES = 200;
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
  /** 指令框掷的骰（/r、/pr），最近 300 条 */
  chat: ChatRoll[];
  /** DM 在替玩家的角色操作：这一笔里问这个控制者的事（掷骰、选项）都算 DM 的，骰子按 DM 的设置 */
  actingAs: string | null;
  /** 死了自动藏起来过的（DM 亮出来之后不再藏；活过来就清掉，再死再藏） */
  autoHid: string[];
  /** 3D 骰子的物理参数（会改变滚法，各端必须一样，所以存在遭遇上、只有 DM 能改） */
  dicePhys: { tableWidth?: number; tableDepth?: number; tableGrow?: boolean; dieScale?: number; layFlat?: boolean };
  /** 每个人的骰子颜色（用户 id → hex；DM 的同时记在 'dm' 下，怪物的骰子用它） */
  diceColors: Record<string, string>;
  /** 怪物 / NPC 的骰子在玩家那边的 3D 动画显示点数（明骰）；默认暗骰（空白骰子） */
  diceOpen: boolean;
  /** DM 在日志里把某次掷骰转明 / 转暗（'r:事务:第几次 d20' / 'd:事务:第几次伤害' → true = 明骰）；不写 = 按默认 */
  reveal: Record<string, boolean>;
  /** 开遭遇时抄进来的本团房规（之后重放都用这份；DM 点「更新规则」才换） */
  rules: HouseRule[];
  /** 参战者自己的资料库（按加入顺序叠上来，一个人的只叠一次；也是快照，点「更新规则」才换） */
  ownerRules: Array<{ ownerId: number; name: string; rules: HouseRule[] }>;
  ctx: EngineCtx;
  seq: number;
  watchers: Set<ServerResponse>;
  /** 带编号的连接（浏览器之间的 WebRTC 握手要点对点转发：DM 共享音乐用） */
  peers: Map<string, { res: ServerResponse; userId: number; name: string; role: 'dm' | 'player' }>;
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
  /** 带房规 / 参战者资料库的规则书（同一份层共用一本） */
  const books = new Map<string, RuleBook>();
  function bookOf(layers: RuleLayer[]): RuleBook {
    if (!layers.length) return rules;
    const k = JSON.stringify(layers);
    let b = books.get(k);
    if (!b) {
      b = new RuleBook(RULE_FILES, layers);
      if (books.size > 50) books.clear();
      books.set(k, b);
    }
    return b;
  }

  function ctxOf(e: { dice: Live['dice']; map: MapState; session?: Session; actingAs?: string | null; owners?: Record<string, number>; rules?: HouseRule[]; ownerRules?: Live['ownerRules'] }): EngineCtx {
    const modeOf = (user: string) => {
      if (e.dice[user]) return e.dice[user];
      const who = e.actingAs === user || (e.owners && e.owners[user] == null) ? 'dm' : user;
      return e.dice[who] ?? e.dice['*'] ?? defaultDiceMode(who);
    };
    return {
      rules: bookOf(encounterLayers(e.rules, e.ownerRules)),
      diceFor: (user) => diceSourceFor(e.actingAs === user ? modeOf('dm') : modeOf(user)),
      positions: () => {
        const st = e.session?.state;
        if (!st) return null;
        const out: Positions = {};
        for (const [id, t] of Object.entries(e.map.tokens)) {
          const c = st.combatants[id];
          if (c) out[id] = { x: t.x, y: t.y, s: footprint(e.session!.view(id).size) };
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
      owners: meta.owners ?? {}, cards: meta.cards ?? {}, dice: meta.dice ?? {}, hidden: meta.hidden ?? [], chat: meta.chat ?? [],
      actingAs: meta.actingAs ?? null, autoHid: meta.autoHid ?? [], dicePhys: meta.dicePhys ?? {}, diceColors: meta.diceColors ?? {}, diceOpen: !!meta.diceOpen, reveal: meta.reveal ?? {}, map: { ...newMap(), ...(meta.map ?? {}) }, rules: meta.rules ?? [], ownerRules: meta.ownerRules ?? [], seq: 0, watchers: new Set(), peers: new Map(),
    } as unknown as Live;
    e.ctx = ctxOf(e);
    e.session = Session.restore(JSON.parse(String(r.save)) as SessionSave, e.ctx);
    live.set(id, e);
    return e;
  }

  const stateOf = (e: Live) => ({
    id: e.id, name: e.name, campaignId: e.campaignId, seq: e.seq, owners: e.owners, cards: e.cards,
    dice: e.dice, hidden: e.hidden, map: e.map, chat: e.chat, actingAs: e.actingAs, dicePhys: e.dicePhys, diceColors: e.diceColors, diceOpen: e.diceOpen, reveal: e.reveal, rules: e.rules,
    // 参战者各自的资料库也发给客户端：它要按同一份层重放
    ownerRules: e.ownerRules.map(({ name, rules: rs }) => ({ name, rules: rs })),
    save: e.session.save(),
  });
  const metaOf = (e: Live) => JSON.stringify({ owners: e.owners, cards: e.cards, dice: e.dice, hidden: e.hidden, map: e.map, chat: e.chat, actingAs: e.actingAs, autoHid: e.autoHid, dicePhys: e.dicePhys, diceColors: e.diceColors, diceOpen: e.diceOpen, reveal: e.reveal, rules: e.rules, ownerRules: e.ownerRules });

  /**
   * 参战者带着卡进来：把卡主资料库的战斗部分叠成一层，然后重放（这样他的自定义数据从进场就生效）。
   * 一个人的库只叠一次；这层规则让重放失败的话撤回去（别把整场弄坏），DM 可以点「更新规则」再试。
   */
  function addOwnerLayer(e: Live, cardId: string): void {
    if (!d.ownerRules) return;
    const ownerId = Number(d.one('SELECT owner_id FROM cards WHERE id = ?', cardId)?.owner_id ?? 0);
    if (!ownerId || e.ownerRules.some((o) => o.ownerId === ownerId)) return;
    const rs = d.ownerRules(ownerId, e.campaignId);
    if (!rs.length) return;
    const name = String(d.one('SELECT name FROM users WHERE id = ?', ownerId)?.name ?? '玩家');
    const before = e.ownerRules;
    e.ownerRules = [...before, { ownerId, name, rules: rs }];
    e.ctx = ctxOf(e);
    try {
      e.session = Session.restore(e.session.save(), e.ctx);
    } catch (err) {
      e.ownerRules = before;
      e.ctx = ctxOf(e);
      e.session = Session.restore(e.session.save(), e.ctx);
      console.warn(`「${name}」的资料库规则叠加失败，这一场先不用它：`, (err as Error).message);
    }
  }
  const broadcast = (e: Live, event: string, data: unknown) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const w of e.watchers) w.write(msg);
  };

  function changed(e: Live): void {
    e.seq++;
    for (const id of Object.keys(e.map.tokens)) {
      if (!e.session.state.combatants[id]) delete e.map.tokens[id];
    }
    if (e.map.avatars) {
      for (const id of Object.keys(e.map.avatars)) {
        if (!e.session.state.combatants[id]) delete e.map.avatars[id];
      }
    }
    // 怪物、NPC 死了：在玩家那边藏起来（DM 那边变淡，可以再亮出来；玩家自己的角色与召唤物不藏）
    for (const c of Object.values(e.session.state.combatants)) {
      if (c.kind === 'pc' || c.side === 'party' || c.summoner) continue;
      if (c.live.dead && !e.autoHid.includes(c.id)) {
        e.autoHid.push(c.id);
        if (!e.hidden.includes(c.id)) e.hidden.push(c.id);
      } else if (!c.live.dead && e.autoHid.includes(c.id)) e.autoHid = e.autoHid.filter((x) => x !== c.id);
    }
    d.run('UPDATE encounters SET save = ?, meta = ?, updated = ? WHERE id = ?', JSON.stringify(e.session.save()), metaOf(e), Date.now(), e.id);
    broadcast(e, 'state', stateOf(e));
  }
  /** 握手消息：from 发给 to（null = 除自己外所有人） */
  function rtcSend(e: Live, from: string, to: string | null, data: unknown): void {
    const p = e.peers.get(from);
    const msg = `event: rtc\ndata: ${JSON.stringify({ from, fromName: p?.name ?? '', fromRole: p?.role ?? 'player', data })}\n\n`;
    if (to) { e.peers.get(to)?.res.write(msg); return; }
    for (const [id, x] of e.peers) if (id !== from) x.res.write(msg);
  }
  /** 只改了地图：不重发整场战斗（客户端重放要时间） */
  function mapChanged(e: Live): void {
    d.run('UPDATE encounters SET meta = ?, updated = ? WHERE id = ?', metaOf(e), Date.now(), e.id);
    broadcast(e, 'map', e.map);
  }

  /** 引擎移动了棋子（推离、拉近，被借机攻击打倒停在半路）：照着改地图 */
  function applyMoves(e: Live, r: DispatchResult): void {
    if (r.status !== 'done') return;
    for (const ev of r.events) {
      if (ev.type !== 'moved') continue;
      const p = ev.payload as { id: string; to: { x: number; y: number } };
      if (e.session.state.combatants[p.id]) e.map.tokens[p.id] = { x: p.to.x, y: p.to.y };
    }
  }

  /** 撤销了几笔事务：这几笔里移动过的棋子放回第一笔发起时的位置，走过的路线也退回去 */
  function undoMoves(e: Live, gone: ReadonlyArray<{ input: { cmd: Command; positions?: Positions }; events: ReadonlyArray<{ type: string; payload: unknown }> }>): void {
    const before = gone[0]?.input.positions;
    if (!before) return;
    const ids = new Set<string>();
    for (const t of gone) {
      if (t.input.cmd.type === 'move') ids.add(t.input.cmd.id);
      for (const ev of t.events) if (ev.type === 'moved') ids.add((ev.payload as { id: string }).id);
    }
    const m = e.map;
    for (const id of ids) {
      const p = before[id];
      if (!p || !e.session.state.combatants[id]) continue;
      m.tokens[id] = { x: p.x, y: p.y };
      if (m.trail?.id === id) {
        const i = m.trail.cells.map((c) => c.x === p.x && c.y === p.y).lastIndexOf(true);
        m.trail = i > 0 ? { ...m.trail, cells: m.trail.cells.slice(0, i + 1) } : null;
      }
    }
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
  const PLAYER_CMDS = new Set(['useAction', 'roll', 'addCombatant', 'removeCombatant', 'refreshCombatant', 'heal', 'tempHp', 'setUsage', 'spendHitDie', 'rest', 'manualCast', 'damage', 'setEconomy', 'endConcentration', 'groupRoll', 'setTriggerOff', 'moveZone', 'removeZone']);

  function check(e: Live, u: User, role: 'dm' | 'player', cmd: Command): string | null {
    if (role === 'dm') return null;
    if (cmd.type === 'nextTurn') {
      const st = e.session.state;
      const cur = st.round !== null ? st.order[st.turnIndex] : null;
      return cur && ownerOf(e, cur) === u.id ? null : '只能结束自己的回合';
    }
    if (!PLAYER_CMDS.has(cmd.type)) return '这件事要 DM 来做';
    if ((cmd as { quiet?: boolean }).quiet) return '只有 DM 能暗中执行（日志里不给玩家看）';
    if (cmd.type === 'addCombatant') {
      if (cmd.combatant.kind === 'pc') return null;
      if (cmd.combatant.summoner && ownerOf(e, cmd.combatant.summoner) === u.id) return null;
      return '玩家只能加自己的角色或召唤物';
    }
    if (cmd.type === 'rest') {
      if (!cmd.ids?.length || !cmd.ids.every((id) => ownerOf(e, id) === u.id)) return '只能让自己的角色休息';
      return null;
    }
    // 群体豁免：玩家只能让自己的角色掷（伤害由 DM 来）
    if (cmd.type === 'groupRoll') {
      if (!cmd.ids.length || !cmd.ids.every((id) => ownerOf(e, id) === u.id)) return '只能让自己的角色豁免';
      return null;
    }
    // 区域：玩家只能挪 / 撤自己的人放下的（DM 画的、别人的不行）
    if (cmd.type === 'moveZone' || cmd.type === 'removeZone') {
      const src = e.session.state.zones?.[cmd.id]?.source;
      return src && ownerOf(e, src) === u.id ? null : '只能动自己放下的区域';
    }
    const who = subjectOf(cmd);
    if (!who || ownerOf(e, who) !== u.id) return '只能操作自己的角色';
    return null;
  }

  /** 地图操作；返回拒绝原因 */
  /** out.state：这次地图操作也动了战斗（扣了移动力），要整场重发 */
  function mapOp(e: Live, u: User, role: 'dm' | 'player', b: Row, out: { state: boolean }): string | null {
    const m = e.map;
    const dm = role === 'dm';
    const num = (v: unknown, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(Number(v) || 0)));
    switch (String(b.action ?? '')) {
      case 'token': {
        const id = String(b.id ?? '');
        if (!e.session.state.combatants[id]) return '没有这个参与者';
        if (!dm && ownerOf(e, id) !== u.id) return '只能移动自己的棋子';
        const from = m.tokens[id];
        if (b.x == null) { delete m.tokens[id]; return null; }
        const to = { x: num(b.x, -200, 1000), y: num(b.y, -200, 1000) };
        const st = e.session.state;
        const turn = !!from && st.round !== null && st.order[st.turnIndex] === id && (from.x !== to.x || from.y !== to.y);
        // 回合中，轮到的人移动：扣移动力（不够就不让走）。DM 按住 Shift 拖 = 不扣（推开、传送之类）
        if (turn && !(dm && b.free)) {
          if (e.session.pending) return '还有一个决定没做完';
          const ft = gridFeet(to.x - from.x, to.y - from.y, m.grid.diagonal ?? '5');
          // 带上一格一格走过的格子：引擎据此问借机攻击、算进入区域（要等决定的话棋子先放到终点）
          const r = e.session.dispatch({ type: 'move', id, ft, path: lineCells(from, to) });
          if (r.status === 'rejected') return r.reason + (dm ? '（按住 Shift 拖不扣移动）' : '');
          out.state = true;
          m.tokens[id] = to;
          applyMoves(e, r);
        } else m.tokens[id] = to;
        // 记下这一回合走过的路（换人、换轮就重新开始）
        if (turn) {
          const key = `${st.round}:${st.turnIndex}`;
          if (m.trail?.id === id && m.trail.key === key) m.trail.cells = [...m.trail.cells, to].slice(-200);
          else m.trail = { id, key, cells: [from, to] };
        }
        return null;
      }
      case 'teleport': {
        // 传送：直接把棋子放过去 —— **不扣移动力、不引发借机攻击、不进轨迹**（王车易位、任意门这类）
        const id = String(b.id ?? '');
        if (!e.session.state.combatants[id]) return '没有这个参与者';
        if (!dm && ownerOf(e, id) !== u.id) return '只能移动自己的棋子';
        const to = { x: num(b.x, -200, 1000), y: num(b.y, -200, 1000) };
        const from = m.tokens[id];
        // 距离上限（尺）：给了就查，超了不许传（免得手滑传半个地图）
        if (b.maxFt != null && from) {
          const max = num(b.maxFt, 0, 1000);
          const ft = gridFeet(to.x - from.x, to.y - from.y, m.grid.diagonal ?? '5');
          if (ft > max) return `太远了：${ft} 尺超过 ${max} 尺`;
        }
        m.tokens[id] = to;
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
      case 'shape': {
        const t = (b.tpl ?? {}) as Row;
        const keys = SHAPE_KEYS[String(t.shape)];
        if (!keys) return '不认识的形状';
        const tpl: Shape['tpl'] = { shape: String(t.shape) };
        for (const k of keys) {
          const v = Math.round(Number(t[k]) * 1000) / 1000;
          if (!Number.isFinite(v) || Math.abs(v) > 1e6) return '形状的数不对';
          tpl[k] = v;
        }
        if (m.shapes.length >= MAX_SHAPES) return '形状太多了，先擦掉一些';
        const color = /^#[0-9a-f]{6}$/i.test(String(b.color)) ? String(b.color) : '#1f5f99';
        m.shapes.push({ id: randomUUID().slice(0, 8), by: u.id, color, tpl });
        return null;
      }
      case 'shapeMove': {
        // 挪形状：平移 dx, dy（世界像素）。自己放的，或者 DM
        const sh = m.shapes.find((x) => x.id === String(b.id ?? ''));
        if (!sh) return '没有这个形状';
        if (!dm && sh.by !== u.id) return '只能挪自己放的形状';
        const dx = Number(b.dx), dy = Number(b.dy);
        if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.abs(dx) > 1e5 || Math.abs(dy) > 1e5) return '挪的距离不对';
        const t = sh.tpl;
        if (t.shape === 'circle') { t.cx = Number(t.cx) + dx; t.cy = Number(t.cy) + dy; } else { t.x = Number(t.x) + dx; t.y = Number(t.y) + dy; }
        return null;
      }
      case 'shapeRotate': {
        // 转锥 / 线：只改朝向
        const sh = m.shapes.find((x) => x.id === String(b.id ?? ''));
        if (!sh) return '没有这个形状';
        if (!dm && sh.by !== u.id) return '只能转自己放的形状';
        const dir = Number(b.dir);
        if (!Number.isFinite(dir) || (sh.tpl.shape !== 'cone' && sh.tpl.shape !== 'line')) return '这个形状不能转';
        sh.tpl.dir = Math.round(dir * 1000) / 1000;
        return null;
      }
      case 'erase': {
        // 线和形状一起擦
        const ids = new Set((Array.isArray(b.ids) ? b.ids : [b.id]).map(String));
        const hit = [...m.strokes, ...m.shapes].filter((x) => ids.has(x.id));
        if (!dm && hit.some((x) => x.by !== u.id)) return '只能擦自己画的';
        m.strokes = m.strokes.filter((x) => !ids.has(x.id));
        m.shapes = m.shapes.filter((x) => !ids.has(x.id));
        return null;
      }
      case 'clear':
        // DM 清全部；玩家（或 DM 选「只清我的」）清自己画的（线和形状）
        m.strokes = dm && !b.mine ? [] : m.strokes.filter((x) => x.by !== u.id);
        m.shapes = dm && !b.mine ? [] : m.shapes.filter((x) => x.by !== u.id);
        return null;
      case 'grid':
        if (!dm) return '只有 DM 能调格子';
        m.grid = {
          size: num(b.size ?? m.grid.size, 8, 400), ox: num(b.ox ?? m.grid.ox, -400, 400), oy: num(b.oy ?? m.grid.oy, -400, 400),
          cols: num(b.cols ?? m.grid.cols, 1, 200), rows: num(b.rows ?? m.grid.rows, 1, 200), show: b.show == null ? m.grid.show : !!b.show,
          diagonal: b.diagonal === '5-10-5' ? '5-10-5' : b.diagonal === '5' ? '5' : m.grid.diagonal ?? '5',
          // 没底图时的底色、格线颜色：hex，空字符串 = 默认
          paper: hexOr(b.paper, m.grid.paper), line: hexOr(b.line, m.grid.line),
          // 范围判定：格子中心 / 中心或小方格（coverK 倍边长）的角
          cover: b.cover === 'corners' ? 'corners' : b.cover === 'center' ? 'center' : m.grid.cover,
          coverK: b.coverK == null ? m.grid.coverK : Math.max(0.1, Math.min(1, Number(b.coverK) || 0.75)),
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
      case 'avatar': {
        const id = String(b.id ?? '');
        if (!e.session.state.combatants[id]) return '没有这个参与者';
        if (!dm && ownerOf(e, id) !== u.id) return '只能修改自己角色的立绘';
        m.avatars ??= {};
        if (b.dataUrl == null || b.dataUrl === '') {
          delete m.avatars[id];
          return null;
        }
        const s = String(b.dataUrl);
        if (!/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(s) || s.length > 512 * 1024) {
          return '立绘图片格式不对或太大了';
        }
        m.avatars[id] = s;
        return null;
      }
      case 'fog': {
        // 战争迷雾：开关；笔刷揭开 / 盖上一批格子；全部揭开 / 全部盖上
        if (!dm) return '只有 DM 能改迷雾';
        const fog = (m.fog ??= { on: false, open: [] });
        if (b.on != null) fog.on = !!b.on;
        const cellList = (v: unknown): string[] | null => {
          if (v == null) return [];
          if (!Array.isArray(v) || v.length > 5000) return null;
          const out = v.map(String);
          return out.every((k) => /^-?\d{1,4},-?\d{1,4}$/.test(k)) ? out : null;
        };
        const add = cellList(b.open), del = cellList(b.hide);
        if (!add || !del) return '格子不对';
        if (b.all === 'hide') fog.open = [];
        else if (b.all === 'open') {
          if (m.grid.cols * m.grid.rows > MAX_FOG) return '地图太大，全部揭开请直接关掉迷雾';
          fog.open = [];
          for (let y = 0; y < m.grid.rows; y++) for (let x = 0; x < m.grid.cols; x++) fog.open.push(`${x},${y}`);
        }
        const set = new Set(fog.open);
        for (const k of add) set.add(k);
        for (const k of del) set.delete(k);
        if (set.size > MAX_FOG) return '揭开的格子太多了';
        fog.open = [...set];
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
        const hr = d.campaignRules?.(m[1]) ?? [];
        const s = new Session(createEncounter(id), ctxOf({ dice: {}, map: newMap(), rules: hr }));
        const now = Date.now();
        // 从上一场复制地图（底图、格子、画笔；棋子不带）
        const src = typeof b.copyMapFrom === 'string' ? load(b.copyMapFrom) : null;
        const map = src && src.campaignId === m[1] ? { ...structuredClone(src.map), tokens: {}, trail: null } : null;
        if (map?.bg) map.bg.img = randomUUID();
        d.run('INSERT INTO encounters (id, campaign_id, name, save, meta, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?)',
          id, m[1], name, JSON.stringify(s.save()), JSON.stringify({ ...(map ? { map } : {}), rules: hr }), now, now);
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
      // ?peer=：这条连接的编号（页面每次打开随机生成），握手消息按它转发
      const peer = new URL(req.url ?? '', 'http://x').searchParams.get('peer');
      const pid = peer && /^[\w-]{4,32}$/.test(peer) ? peer : null;
      if (pid) e.peers.set(pid, { res, userId: u.id, name: u.name, role });
      const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
      req.on('close', () => {
        clearInterval(ping);
        e.watchers.delete(res);
        if (pid && e.peers.get(pid)?.res === res) {
          e.peers.delete(pid);
          rtcSend(e, pid, null, { t: 'left' });
        }
      });
      return true;
    }

    // WebRTC 握手：只转发，不存。to 空 = 发给这场遭遇里的其他所有连接
    if (method === 'POST' && sub === '/rtc') {
      const b = await d.bodyOf(req);
      const from = String(b.from ?? '');
      if (e.peers.get(from)?.userId !== u.id) throw d.fail(400, '连接编号不对，刷新一下页面');
      const data = b.data as Row | undefined;
      if (!data || typeof data !== 'object' || JSON.stringify(data).length > 20_000) throw d.fail(400, '消息不对');
      // 只有 DM 能当「放音乐的人」
      if ((data.t === 'hello' || data.t === 'offer') && role !== 'dm') throw d.fail(403, '只有 DM 能共享音乐');
      rtcSend(e, from, b.to ? String(b.to) : null, data);
      d.send(res, 200, { ok: true });
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
        // DM 动玩家的角色：这一笔里 DM 就是它的主人
        const subj = subjectOf(cmd);
        const ctl = subj ? e.session.state.combatants[subj]?.controller ?? subj : null;
        e.actingAs = role === 'dm' && ctl && e.owners[ctl] != null ? ctl : null;
        r = s.dispatch(cmd);
        applyMoves(e, r);
        if (r.status !== 'rejected' && cmd.type === 'addCombatant') {
          const ctl = cmd.combatant.controller ?? cmd.combatant.id;
          // 玩家加的归自己；DM 替玩家加（带了非 DM 的卡主）就归卡主；绑定 DM 或 DM 自己的卡/怪不登记，直接归 DM
          const rawOwner = role === 'player' ? u.id : typeof b.owner === 'number' ? b.owner : null;
          const ownerRole = rawOwner != null ? d.roleIn({ id: rawOwner, name: '' }, e.campaignId) : null;
          if (rawOwner != null && ownerRole !== 'dm') e.owners[ctl] = rawOwner;
          if (typeof b.cardId === 'string') {
            e.cards[cmd.combatant.id] = b.cardId;
            // 卡主自己的资料库（自定义战斗数据）从进场就生效
            addOwnerLayer(e, b.cardId);
          }
          if (role === 'dm' && b.hidden) e.hidden.push(cmd.combatant.id);
        }
        if (r.status !== 'rejected' && cmd.type === 'removeCombatant') {
          delete e.map.tokens[cmd.id];
          if (e.map.avatars) delete e.map.avatars[cmd.id];
          e.hidden = e.hidden.filter((x) => x !== cmd.id);
        }
      } else if (op === 'decide' || op === 'cancelPending') {
        if (!s.pending) return reject('没有等待中的决定');
        const to = s.pending.decision.to;
        if (role !== 'dm' && e.owners[to] !== u.id) return reject('这个决定不是问你的');
        // 暗骰只有 DM 能选；玩家发来的当普通确认
        if (op === 'decide') {
          r = s.decide(b.value === 'roll-dark' && role !== 'dm' ? 'roll' : b.value);
          applyMoves(e, r);
        } else s.cancelPending();
      } else if (op === 'refreshRules') {
        // 战役资料 / 参战者各自的资料库改了，想在这场里立刻生效：换成现在的，整场按新规则重算
        if (role !== 'dm') return reject('只有 DM 能更新规则');
        if (s.pending) return reject('还有一个决定没做完');
        const before = { rules: e.rules, ownerRules: e.ownerRules };
        e.rules = d.campaignRules?.(e.campaignId) ?? [];
        e.ownerRules = e.ownerRules.map((o) => ({ ...o, rules: d.ownerRules?.(o.ownerId) ?? [] }));
        e.ctx = ctxOf(e);
        try { e.session = Session.restore(s.save(), e.ctx); } catch (err) {
          e.rules = before.rules;
          e.ownerRules = before.ownerRules;
          e.ctx = ctxOf(e);
          return reject('按新规则重算失败：' + (err as Error).message);
        }
      } else if (op === 'undo' || op === 'override' || op === 'reset') {
        if (role !== 'dm') return reject('只有 DM 能撤销、裁定、清空');
        if (op === 'undo') {
          const count = Math.max(1, Number(b.n ?? 1));
          const gone = s.transactions.slice(Math.max(0, s.transactions.length - count));
          s.undo(count);
          undoMoves(e, gone);
          // 撤掉的那几笔上的转明 / 转暗也去掉（不然落到之后的新事务上）
          const n = s.transactions.length;
          e.reveal = Object.fromEntries(Object.entries(e.reveal).filter(([k]) => Number(k.split(':')[1]) < n));
        }
        else if (op === 'override') r = s.override(Number(b.txIndex), b.patch as OverridePatch);
        else { e.owners = {}; e.cards = {}; e.hidden = []; e.chat = []; e.reveal = {}; e.autoHid = []; e.map.tokens = {}; e.map.avatars = {}; e.map.trail = null; e.session = new Session(createEncounter(e.id), e.ctx); }
      } else if (op === 'setDice') {
        // 玩家只能改自己控制的；DM 什么都能改（包括默认 '*' 和怪物 'dm'）
        const who = String(b.user ?? '');
        if (!who) throw d.fail(400, '缺 user');
        if (role !== 'dm' && e.owners[who] !== u.id) return reject('只能改自己的骰子');
        if (DICE_MODES.includes(b.mode as DiceMode)) e.dice[who] = b.mode as DiceMode;
        else delete e.dice[who];
      } else if (op === 'dicePhys') {
        // 3D 骰子的物理参数：空值 = 用默认
        if (role !== 'dm') return reject('只有 DM 能改骰子的物理参数');
        const n = (v: unknown, lo: number, hi: number) => (v == null || v === '' || !Number.isFinite(Number(v)) ? undefined : Math.max(lo, Math.min(hi, Number(v))));
        e.dicePhys = Object.fromEntries(Object.entries({
          tableWidth: n(b.tableWidth, 4, 200), tableDepth: n(b.tableDepth, 4, 200), dieScale: n(b.dieScale, 0.2, 5),
          layFlat: typeof b.layFlat === 'boolean' ? b.layFlat : undefined,
          tableGrow: typeof b.tableGrow === 'boolean' ? b.tableGrow : undefined,
        }).filter(([, v]) => v !== undefined));
      } else if (op === 'diceOpen') {
        if (role !== 'dm') return reject('只有 DM 能改');
        e.diceOpen = !!b.open;
      } else if (op === 'reveal') {
        // 日志里把一次掷骰转明 / 转暗。指令框的骰子（chat）：DM 和掷的人都能改；战斗里的只有 DM
        const open = b.open == null ? null : !!b.open;
        if (typeof b.chat === 'string') {
          const c = e.chat.find((x) => x.id === b.chat);
          if (!c) return reject('找不到这次掷骰');
          if (role !== 'dm' && c.by !== u.id) return reject('只能改自己掷的');
          c.private = open === null ? !c.private : !open;
        } else {
          if (role !== 'dm') return reject('只有 DM 能改');
          const key = String(b.key ?? '');
          if (!/^[rd]:\d+:\d+$/.test(key)) return reject('不认识的掷骰');
          if (open === null) delete e.reveal[key];
          else e.reveal[key] = open;
        }
      } else if (op === 'diceColor') {
        // 自己的骰子颜色（大家看到的都是这个颜色）；空 = 回到默认
        const c = String(b.color ?? '');
        if (c && !/^#[0-9a-f]{6}$/i.test(c)) return reject('颜色要写成 #rrggbb');
        const keys = role === 'dm' ? [String(u.id), 'dm'] : [String(u.id)];
        for (const k of keys) { if (c) e.diceColors[k] = c; else delete e.diceColors[k]; }
      } else if (op === 'setHidden') {
        if (role !== 'dm') return reject('只有 DM 能藏人');
        const id = String(b.id ?? '');
        e.hidden = e.hidden.filter((x) => x !== id);
        if (b.hidden) e.hidden.push(id);
      } else if (op === 'setOwner') {
        if (role !== 'dm') return reject('只有 DM 能更改角色控制权');
        const ctl = String(b.controller ?? '');
        if (!ctl) throw d.fail(400, '缺 controller');
        if (b.owner == null) delete e.owners[ctl];
        else e.owners[ctl] = Number(b.owner);
      } else if (op === 'ping') {
        // 标点 / 分享测距：只广播，不存（客户端过一会儿淡出）
        const n = (v: unknown) => { const x = Math.round(Number(v) * 10) / 10; return Number.isFinite(x) && Math.abs(x) < 1e6 ? x : 0; };
        const ping = b.kind === 'measure'
          ? { kind: 'measure', cells: (Array.isArray(b.cells) ? b.cells : []).slice(0, 50).map((c: Row) => ({ x: Math.round(n(c?.x)), y: Math.round(n(c?.y)) })) }
          : { kind: 'point', x: n(b.x), y: n(b.y) };
        if (ping.kind === 'measure' && (ping.cells as unknown[]).length < 2) return reject('量的线太短');
        broadcast(e, 'ping', { ...ping, id: randomUUID().slice(0, 8), by: u.id, byName: u.name });
        d.send(res, 200, { status: 'done' });
        return true;
      } else if (op === 'chat') {
        // 指令框：骰子由服务器掷；私密的照样发给所有人，界面上只给本人（和点开的 DM）看
        let entry: ChatRoll | null;
        const who = { id: randomUUID().slice(0, 8), by: u.id, byName: u.name, at: Date.now(), afterTx: e.session.transactions.length };
        const t = b.term as Row | undefined;
        if (t && typeof t === 'object') {
          // /match 分享条目：只存引用，各自的客户端按引用查原文
          const str = (v: unknown) => (typeof v === 'string' && v.length <= 80 ? v : undefined);
          const kind = str(t.kind), name = str(t.name);
          if (!kind || !name) return reject('条目不对');
          entry = { ...who, private: false, note: '', results: [], term: { kind, name, ...(str(t.source) ? { source: str(t.source) } : {}) } };
        } else {
          try {
            entry = chatEntry(String(b.text ?? ''), who);
          } catch (err) { return reject((err as Error).message); }
        }
        if (!entry) return reject('空的');
        e.chat = [...e.chat, entry].slice(-300);
        d.run('UPDATE encounters SET meta = ?, updated = ? WHERE id = ?', metaOf(e), Date.now(), e.id);
        broadcast(e, 'chat', entry);
        d.send(res, 200, { status: 'done' });
        return true;
      } else if (op === 'map') {
        const out = { state: false };
        const why = mapOp(e, u, role, b, out);
        if (why) return reject(why);
        if (out.state) changed(e);
        else mapChanged(e);
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
