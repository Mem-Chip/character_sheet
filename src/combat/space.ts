/**
 * 地图上的事：一格一格走（借机攻击、进出区域）、推离 / 拉近、区域的生效、放下 / 挪动 / 移除区域。
 *
 * 棋子位置不在遭遇状态里（地图是服务器的），引擎每笔操作拿一份快照（tx.pos）。
 * 引擎移动了棋子就发 `moved` 事件（最后停在哪），服务器照着改地图。
 */
import { activeTemplates, effectiveView, effectsOf, endEffect, entryOf } from './effects';
import { currentAction, spellMetaOf, type ActionInstance } from './instance';
import { runNodes, collectDamageDefs } from './exec';
import { nameOf } from './scope';
import { fireWindow } from './triggers';
import type { Positions, Tx } from './tx';
import type { Id, Zone, ZoneWhen } from './types';

type Cell = { x: number; y: number };
type Pos = Positions[string];

const key = (x: number, y: number) => `${x},${y}`;

export const sizeToGrid = (sz?: string): number =>
  sz === 'L' || sz === '大型' ? 2 : sz === 'H' || sz === '巨型' ? 3 : sz === 'G' || sz === '超巨型' ? 4 : 1;

/** 棋子占的格子 */
export function cellsOf(p: Pos): string[] {
  const out: string[] = [];
  for (let dx = 0; dx < p.s; dx++) for (let dy = 0; dy < p.s; dy++) out.push(key(p.x + dx, p.y + dy));
  return out;
}

/** 召唤物入场：若召唤者在地图上有位置，在召唤者身旁找最近空位放上棋子并发 moved 事件 */
export function placeSummon(tx: Tx, summoner: Id, summonId: Id, size: string | undefined, cause: number | null): void {
  const pos = tx.pos;
  const sp = pos?.[summoner];
  if (!pos || !sp) return;
  const s = sizeToGrid(size);
  const taken = new Set<string>();
  for (const [k, p] of Object.entries(pos)) {
    const c = tx.state.combatants[k];
    if (c && !c.live.dead) for (const cell of cellsOf(p)) taken.add(cell);
  }
  const free = (x: number, y: number) => {
    if (x < 0 || y < 0) return false;
    return cellsOf({ x, y, s }).every((c) => !taken.has(c));
  };
  let picked: Cell = { x: sp.x + sp.s, y: sp.y };
  outer: for (let r = 1; r <= 6; r++) {
    for (let dy = -r; dy <= sp.s - 1 + r; dy++) {
      for (let dx = -r; dx <= sp.s - 1 + r; dx++) {
        const x = sp.x + dx;
        const y = sp.y + dy;
        if (free(x, y)) {
          picked = { x, y };
          break outer;
        }
      }
    }
  }
  pos[summonId] = { x: picked.x, y: picked.y, s };
  tx.emit('moved', { id: summonId, from: picked, to: picked, forced: true }, cause);
}

/** 在不在区域里：占到一格就算；标了 fully 的要每一格都在里面（「完全位于」） */
const inZone = (z: Zone, p: Pos) => (z.fully ? cellsOf(p).every((c) => z.cells.includes(c)) : cellsOf(p).some((c) => z.cells.includes(c)));

/**
 * 沿路径走要多花的移动力（困难地形）：每一步的落脚处（棋子占的任何一格）在困难地形里就多 5 尺。
 * 纯函数：引擎扣移动力、地图上拖棋子时的预览都用它。
 */
export function difficultExtra(zones: Record<string, Zone> | undefined, path: Cell[], s: number): number {
  const rough = new Set<string>();
  for (const z of Object.values(zones ?? {})) if (z.difficult) for (const c of z.cells) rough.add(c);
  if (!rough.size) return 0;
  let extra = 0;
  for (let i = 1; i < path.length; i++) if (cellsOf({ ...path[i], s }).some((c) => rough.has(c))) extra += 5;
  return extra;
}

/** 困难地形不多花移动力的（效应 flags.ignores 里有 difficultTerrain） */
export function ignoresDifficult(tx: Tx, id: Id): boolean {
  return activeTemplates(tx, id).some((a) => a.tpl.flags?.ignores?.includes('difficultTerrain'));
}

/** 一个参与者现在在哪些区域里 */
export function zonesAt(tx: Tx, id: Id): Zone[] {
  const p = tx.pos?.[id];
  if (!p) return [];
  return Object.values(tx.state.zones ?? {}).filter((z) => inZone(z, p));
}

/** 从 a 走到 b 的格子（先斜着走，再直走），含两端 */
export function lineCells(a: Cell, b: Cell): Cell[] {
  const out = [{ ...a }];
  let { x, y } = a;
  while (x !== b.x || y !== b.y) {
    x += Math.sign(b.x - x);
    y += Math.sign(b.y - y);
    out.push({ x, y });
  }
  return out;
}

/* ------------------------------ 借机攻击 ------------------------------ */

/** 近战触及（尺）：有触及词条的武器 10 尺，否则 5 尺；没有近战攻击 = null */
export function reachOf(tx: Tx, id: Id): number | null {
  const melee = effectiveView(tx, id).attacks.filter((a) => a.melee);
  if (!melee.length) return null;
  return melee.some((a) => a.reach) ? 10 : 5;
}

/** mover 从 from 走到 to 时触及关系的变化：离开了谁的触及范围、进了谁的（只看敌人；没有近战攻击的没有触及） */
export function reachChanges(tx: Tx, mover: Id, from: Cell, to: Cell): { left: Id[]; entered: Id[] } {
  const pos = tx.pos, me = pos?.[mover], sp = tx.spatial;
  const out = { left: [] as Id[], entered: [] as Id[] };
  if (!pos || !me || !sp) return out;
  const side = tx.state.combatants[mover]?.side;
  const at = (c: Cell) => { me.x = c.x; me.y = c.y; };
  const back = { x: me.x, y: me.y };
  for (const e of Object.values(tx.state.combatants)) {
    if (e.id === mover || e.side === side || e.live.dead || !pos[e.id]) continue;
    const reach = reachOf(tx, e.id);
    if (reach === null) continue;
    at(from);
    const d0 = sp.distance(e.id, mover);
    at(to);
    const d1 = sp.distance(e.id, mover);
    if (d0 === null || d1 === null) continue;
    if (d0 <= reach && d1 > reach) out.left.push(e.id);
    if (d0 > reach && d1 <= reach) out.entered.push(e.id);
  }
  at(back);
  return out;
}

/** 谁会因为 mover 从 from 走到 to 而能借机攻击（离开了他的触及范围） */
export const provokers = (tx: Tx, mover: Id, from: Cell, to: Cell): Id[] => reachChanges(tx, mover, from, to).left;

/** 移动不引发借机攻击（撤离、各种「不会引发借机攻击」的能力）：效应上的 `flags.cannot: ['provoke']` */
function disengaged(tx: Tx, id: Id): boolean {
  return activeTemplates(tx, id).some((a) => a.tpl.flags?.cannot?.includes('provoke'));
}

/**
 * 走一步离开了谁的触及：发 leftReach、开窗口。借机攻击本身是规则数据（rules-2024 的「借机攻击」：
 * 挂在这个窗口上的反应），哨兵、战地施法者这些和它在同一个窗口里一起问。
 * event.provokes = 这次移动会不会引发借机攻击（撤离了就不会；哨兵这类「撤离了也能打」的看它）。
 */
function opportunity(tx: Tx, mover: Id, from: Cell, to: Cell, cause: number | null): void {
  for (const e of provokers(tx, mover, from, to)) {
    if (!tx.state.combatants[mover] || tx.state.combatants[mover].live.dead) return;
    const provokes = !disengaged(tx, mover);
    const seq = tx.emit('leftReach', { id: mover, from: e, provokes }, cause);
    fireWindow(tx, { event: 'leftReach', window: 'after', actor: mover, target: e, scope: { event: { provokes, forced: false } }, cause: seq });
  }
}

/* ------------------------------ 走 ------------------------------ */

/**
 * 一格一格走过 path（含起点）。
 *
 * 移动和施法一样有前后两个窗口（event = { id, by, forced, ft }）：
 *   - moved before：还没走，cancel = 拦下这次移动（新锻臂铠「阻止盟友被推离 / 拉近」）；
 *   - moved after：走完了，ft = 实际走了几尺（轰雷剑「目标自愿移动 5 尺以上就受伤」）。
 * 每一步：先看离开了谁的触及范围（还在原来那格时，借机攻击挂在 leftReach 上），走过去，再看进了谁的触及范围（enteredReach：
 * 长柄武器大师）、进出了哪些区域。forced = 被推、被拉（不引发借机攻击；进触及、进区域照算）。走的人倒下 / 速度变成 0 就停下。
 */
export function travel(tx: Tx, id: Id, path: Cell[], o: { forced: boolean; by?: Id; cause: number | null }): void {
  const me = tx.pos?.[id];
  if (!me || path.length < 2) return;
  const by = o.by ?? id;
  const plan = { cancelled: false };
  fireWindow(tx, {
    event: 'moved', window: 'before', actor: by, target: id,
    scope: { event: { id, by, forced: o.forced, ft: (path.length - 1) * 5 } },
    modify: (m) => { if (m.op === 'cancel') plan.cancelled = true; },
    cause: o.cause,
  });
  if (plan.cancelled) {
    tx.emit('note', { text: `${nameOf(tx, id)} 的这次移动被拦下了`, owner: id }, o.cause);
    return;
  }
  const from = { x: me.x, y: me.y };
  let steps = 0;
  for (let i = 1; i < path.length; i++) {
    const c = tx.state.combatants[id];
    if (!c || c.live.dead || c.live.hp <= 0) break;
    const prev = { x: me.x, y: me.y };
    if (!o.forced) {
      opportunity(tx, id, prev, path[i], o.cause);
      const after = tx.state.combatants[id];
      if (!after || after.live.dead || after.live.hp <= 0) break;
      if (effectiveView(tx, id).speed === 0) break;
    }
    const entered = reachChanges(tx, id, prev, path[i]).entered;
    me.x = path[i].x;
    me.y = path[i].y;
    steps++;
    for (const e of entered) {
      if (!tx.state.combatants[id] || tx.state.combatants[id].live.dead) break;
      const seq = tx.emit('enteredReach', { id, of: e, forced: o.forced }, o.cause);
      fireWindow(tx, { event: 'enteredReach', window: 'after', actor: id, target: e, scope: { event: { id, of: e, forced: o.forced } }, cause: seq });
    }
    for (const z of Object.values(tx.state.zones ?? {})) {
      const was = inZone(z, { ...prev, s: me.s }), now = inZone(z, me);
      if (!was && now) enterZone(tx, z, id, o.cause);
      else if (was && !now) leaveZone(tx, z, id, o.cause);
      // 「在里面每移动 5 尺」：这一步落在里面就算（走进来那一步也算）
      if (now && tx.state.zones?.[z.id]) runZone(tx, z, id, 'move', o.cause);
    }
  }
  if (me.x !== from.x || me.y !== from.y) {
    const seq = tx.emit('moved', { id, from, to: { x: me.x, y: me.y }, forced: o.forced }, o.cause);
    fireWindow(tx, {
      event: 'moved', window: 'after', actor: by, target: id,
      scope: { event: { id, by, forced: o.forced, ft: steps * 5, from, to: { x: me.x, y: me.y } } }, cause: seq,
    });
  }
}

/** 推离 / 拉近：沿着两者连线的方向走直线，碰到别的棋子就停；拉近到贴身为止 */
export function shove(tx: Tx, by: Id, target: Id, ft: number, mode: 'push' | 'pull', cause: number | null): boolean {
  const pos = tx.pos, a = pos?.[by], b = pos?.[target], sp = tx.spatial;
  if (!pos || !a || !b || !sp || by === target) return false;
  const ca = { x: a.x + (a.s - 1) / 2, y: a.y + (a.s - 1) / 2 }, cb = { x: b.x + (b.s - 1) / 2, y: b.y + (b.s - 1) / 2 };
  let dx = cb.x - ca.x, dy = cb.y - ca.y;
  if (mode === 'pull') { dx = -dx; dy = -dy; }
  // 方向取最接近的八个方向之一
  const sx = Math.abs(dx) >= Math.abs(dy) / 2 ? Math.sign(dx) : 0;
  const sy = Math.abs(dy) >= Math.abs(dx) / 2 ? Math.sign(dy) : 0;
  if (!sx && !sy) return false;
  const others = Object.entries(pos).filter(([k]) => k !== target && tx.state.combatants[k] && !tx.state.combatants[k].live.dead);
  const blocked = (c: Cell) => {
    const mine = cellsOf({ ...c, s: b.s });
    return others.some(([, p]) => cellsOf(p).some((x) => mine.includes(x)));
  };
  const path: Cell[] = [{ x: b.x, y: b.y }];
  let cur = { x: b.x, y: b.y };
  for (let i = 0; i < Math.floor(ft / 5); i++) {
    const next = { x: cur.x + sx, y: cur.y + sy };
    if (blocked(next)) break;
    if (mode === 'pull') {
      const save = { x: b.x, y: b.y };
      b.x = cur.x; b.y = cur.y;
      const d = sp.distance(by, target);
      b.x = save.x; b.y = save.y;
      if (d !== null && d <= 5) break;
    }
    path.push(next);
    cur = next;
  }
  if (path.length < 2) return true;
  travel(tx, target, path, { forced: true, by, cause });
  return true;
}

/* ------------------------------ 区域 ------------------------------ */

const WHY_CN: Record<ZoneWhen, string> = {
  enter: '进入', turnStart: '在里面开始回合', turnEnd: '在里面结束回合', create: '在区域出现的地方', leave: '离开', move: '在里面移动',
};

/** 这个区域对这个人起不起作用（只对敌人 / 盟友的） */
function affects(tx: Tx, z: Zone, victim: Id): boolean {
  if (z.affects === 'all' || !z.source || !tx.state.combatants[z.source]) return true;
  const same = tx.state.combatants[z.source].side === tx.state.combatants[victim]?.side;
  return z.affects === 'enemies' ? !same : same;
}

function zoneCtx(tx: Tx, z: Zone, victim: Id, nodes: Zone['do'], cause: number | null) {
  const self = z.source && tx.state.combatants[z.source] ? z.source : victim;
  return {
    self, source: z.source, targets: [victim], target: victim, attacker: self,
    entryKey: z.entryKey, actionName: z.name, cause, locals: {}, slot: z.slot, zone: z.id,
    damageDefs: collectDamageDefs(nodes), originKind: (z.source ? 'spell' : 'feature') as 'spell' | 'feature', vars: { ...(z.vars ?? {}) },
  };
}

/** 「待在里面就有」的效果：还没挂上就挂（同一个区域挂的效应只留一份） */
function applyWhile(tx: Tx, z: Zone, victim: Id, cause: number | null): void {
  const live = tx.state.zones?.[z.id];
  const c = tx.state.combatants[victim];
  if (!live?.while?.length || !c || c.live.dead || !affects(tx, live, victim)) return;
  if (effectsOf(tx, victim).some((e) => e.zone === live.id)) return;
  runNodes(tx, live.while, { ...zoneCtx(tx, live, victim, live.while, cause), zoneWhile: true });
}

/** 摘掉这个人（null = 所有人）身上随这个区域的效应 */
function dropWhile(tx: Tx, zoneId: string, victim: Id | null, reason: string, cause: number | null): void {
  for (const e of Object.values(tx.state.effects)) {
    if (e.zone === zoneId && (victim === null || e.bearer === victim)) endEffect(tx, e.id, reason, cause);
  }
}

/** 进入区域：先挂「待在里面」的效果，再按 enter 结算 */
export function enterZone(tx: Tx, z: Zone, victim: Id, cause: number | null): void {
  applyWhile(tx, z, victim, cause);
  runZone(tx, z, victim, 'enter', cause);
}

/** 离开区域：摘掉随区域的效应，再按 leave 结算 */
export function leaveZone(tx: Tx, z: Zone, victim: Id, cause: number | null): void {
  dropWhile(tx, z.id, victim, `离开「${z.name}」`, cause);
  runZone(tx, z, victim, 'leave', cause);
}

/** 区域对一个生物生效一次 */
export function runZone(tx: Tx, z: Zone, victim: Id, why: ZoneWhen, cause: number | null): void {
  const c = tx.state.combatants[victim];
  if (!c || c.live.dead || !z.on.includes(why)) return;
  const live = tx.state.zones?.[z.id];
  if (!live || !affects(tx, live, victim)) return;
  if (live.oncePerTurn && live.hits[victim] === tx.turnKey()) return;
  if (live.confirm) {
    const ans = tx.decide({
      kind: 'ask', to: 'dm', prompt: `区域「${live.name}」`, options: [],
      questions: [{ id: 'zone', text: `${nameOf(tx, victim)} ${WHY_CN[why]}「${live.name}」：生效吗？`, guess: true, scope: 'once' }],
      default: { zone: true },
    }) as Record<string, boolean>;
    if (!ans?.zone) return;
  }
  const seq = tx.emit('zoneHit', { zone: live.id, name: live.name, id: victim, at: tx.turnKey(), why }, cause);
  withZoneInstance(tx, live, victim, seq, () => runNodes(tx, live.do, zoneCtx(tx, live, victim, live.do, seq)));
}

/**
 * 区域每次生效都算「放出它的那道法术」的一次结算：压一个动作实例（instance.ts），
 * 这样区域造成的伤害也是法术伤害（强效塑能这类修正认得出来），区域的 do 里也能读 action.spell.*。
 * 实例从区域记着的条目键、施法者、环阶现搭 —— 不用另存，已经放在地图上的区域也认得。DM 画的区域没有施法者，不压。
 */
function withZoneInstance(tx: Tx, z: Zone, victim: Id, seq: number, fn: () => void): void {
  if (!z.source || !tx.state.combatants[z.source]) { fn(); return; }
  const entry = entryOf(tx, z.source, z.entryKey);
  const action = entry?.actions?.[0];
  const isSpell = /:spell:/.test(z.entryKey) || !!action?.tags?.includes('spell');
  const meta = isSpell ? spellMetaOf(z.entryKey, entry, action ?? { id: '', name: z.name, activation: 'none', root: [] }) : null;
  const inst: ActionInstance = {
    seq, by: z.source, name: entry?.name ?? z.name, key: z.entryKey, kind: isSpell ? 'spell' : 'feature',
    economy: 'none', onMyTurn: tx.state.round === null || tx.state.order[tx.state.turnIndex] === z.source,
    spell: meta ? { ...meta, slot: z.slot ?? meta.level } : null,
    attack: null, targets: [victim], marks: { ...((z.marks ?? {}) as ActionInstance['marks']) }, markRoll: {}, paid: { resources: [] },
    parent: currentAction(tx), pending: null, zone: z.id, results: {}, last: victim, damage: null,
  };
  const before = JSON.stringify(inst.marks);
  tx.actions.push(inst);
  try { fn(); } finally { tx.actions.pop(); }
  // 这次生效做了新记号：记回区域上（走事件，撤销 / 重放才对得上）
  const after = JSON.stringify(inst.marks);
  if (after !== before && tx.state.zones?.[z.id]) tx.emit('zoneMarked', { zone: z.id, marks: JSON.parse(after) }, seq);
}

/**
 * 回合开始 / 结束：这个人所在的区域各生效一次。
 * 顺带对一遍账：DM 按住 Shift 摆位置、传送这些不经过引擎的移动 —— 已经不在里面的摘掉随区域的效应，新到里面的补挂。
 */
export function zonesOnTurn(tx: Tx, id: Id, why: 'turnStart' | 'turnEnd', cause: number | null): void {
  const here = zonesAt(tx, id);
  if (tx.pos?.[id]) {
    for (const e of effectsOf(tx, id)) {
      if (e.zone && !here.some((z) => z.id === e.zone)) endEffect(tx, e.id, '已经不在区域里', cause);
    }
  }
  for (const z of here) applyWhile(tx, z, id, cause);
  for (const z of here) runZone(tx, z, id, why, cause);
}

/** 地图上有位置、活着的参与者里，哪些在这个区域里 */
function inside(tx: Tx, z: Zone): Id[] {
  const pos = tx.pos;
  if (!pos) return [];
  return Object.keys(pos).filter((id) => tx.state.combatants[id] && !tx.state.combatants[id].live.dead && inZone(z, pos[id]));
}

/** 放下一块区域：已经在里面的挂上「待在里面」的效果、按 create 结算 */
export function placeZone(tx: Tx, zone: Zone, cause: number | null): void {
  const seq = tx.emit('zoneCreated', { zone }, cause);
  const z = tx.state.zones?.[zone.id];
  if (!z) return;
  for (const id of inside(tx, z)) {
    applyWhile(tx, z, id, seq);
    runZone(tx, z, id, 'create', seq);
  }
}

/** 把区域挪到新格子：挪走后不在里面的算离开，新压到的算进入（「区域移入生物的空间」） */
export function relocateZone(tx: Tx, z: Zone, cells: string[], tpl: Record<string, unknown> | undefined, cause: number | null): void {
  const before = new Set(inside(tx, z));
  const seq = tx.emit('zoneMoved', { id: z.id, name: z.name, cells: cells.slice(), ...(tpl ? { tpl } : {}) }, cause);
  const live = tx.state.zones?.[z.id];
  if (!live) return;
  const after = inside(tx, live);
  for (const id of before) if (!after.includes(id)) leaveZone(tx, live, id, seq);
  for (const id of after) if (!before.has(id) && tx.state.zones?.[z.id]) enterZone(tx, live, id, seq);
}

/** 区域消失：随它的效应一起摘掉 */
export function removeZone(tx: Tx, z: Zone, reason: string, cause: number | null): void {
  const seq = tx.emit('zoneRemoved', { id: z.id, name: z.name, reason }, cause);
  dropWhile(tx, z.id, null, `「${z.name}」消失`, seq);
}

/** 新一轮开始：到期的区域消失 */
export function expireZones(tx: Tx, round: number, cause: number | null): void {
  for (const z of Object.values(tx.state.zones ?? {})) {
    if (z.untilRound !== null && round >= z.untilRound) removeZone(tx, z, '持续时间到', cause);
  }
}

/** 专注结束：随它的区域消失 */
export function zonesOfConcentration(tx: Tx, concId: string, cause: number | null): void {
  for (const z of Object.values(tx.state.zones ?? {})) {
    if (z.link === concId) removeZone(tx, z, '专注结束', cause);
  }
}
