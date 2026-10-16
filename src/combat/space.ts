/**
 * 地图上的事：一格一格走（借机攻击、进入区域）、推离 / 拉近、区域的生效。
 *
 * 棋子位置不在遭遇状态里（地图是服务器的），引擎每笔操作拿一份快照（tx.pos）。
 * 引擎移动了棋子就发 `moved` 事件（最后停在哪），服务器照着改地图。
 */
import { controllerOf } from './d20';
import { activeTemplates, effectiveView, effectsOf } from './effects';
import { executeAction, findAction, runNodes, collectDamageDefs } from './exec';
import { nameOf } from './scope';
import { blockedEconomy, fireWindow } from './triggers';
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

const inZone = (z: Zone, p: Pos) => cellsOf(p).some((c) => z.cells.includes(c));

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

/** 谁会因为 mover 从 from 走到 to 而能借机攻击（离开了他的触及范围） */
export function provokers(tx: Tx, mover: Id, from: Cell, to: Cell): Id[] {
  const pos = tx.pos, me = pos?.[mover], sp = tx.spatial;
  if (!pos || !me || !sp) return [];
  const side = tx.state.combatants[mover]?.side;
  const out: Id[] = [];
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
    if (d0 !== null && d1 !== null && d0 <= reach && d1 > reach) out.push(e.id);
  }
  at(back);
  return out;
}

/** 能不能用反应来借机攻击（有反应、没失能、有近战武器） */
function canReact(tx: Tx, id: Id): boolean {
  const c = tx.state.combatants[id];
  if (!c || c.live.dead || c.live.hp <= 0) return false;
  if (tx.state.round !== null && c.economy.reaction <= 0) return false;
  return !blockedEconomy(tx, id).has('reaction');
}

/** 撤离了（或者有别的「移动不引发借机攻击」） */
function disengaged(tx: Tx, id: Id): boolean {
  return effectsOf(tx, id).some((e) => e.name === '撤离')
    || activeTemplates(tx, id).some((a) => a.tpl.flags?.cannot?.includes('provoke'));
}

function opportunity(tx: Tx, mover: Id, from: Cell, to: Cell, cause: number | null): void {
  for (const e of provokers(tx, mover, from, to)) {
    if (!tx.state.combatants[mover] || tx.state.combatants[mover].live.dead) return;
    // 给数据里的触发器（哨兵之类）一个时机：发起者 = 走的人，承受者 = 被离开的人
    const seq = tx.emit('leftReach', { id: mover, from: e }, cause);
    fireWindow(tx, { event: 'leftReach', window: 'after', actor: mover, target: e, scope: {}, cause: seq });
    if (disengaged(tx, mover) || !canReact(tx, e)) continue;
    const weapons = effectiveView(tx, e).attacks.filter((a) => a.melee);
    const v = tx.decide({
      kind: 'choose', to: controllerOf(tx, e),
      prompt: `${nameOf(tx, mover)} 离开了 ${nameOf(tx, e)} 的触及范围。借机攻击吗？（用反应）`,
      options: [...weapons.map((a) => ({ id: a.id, label: `借机攻击：${a.name}` })), { id: '', label: '不攻击' }],
      default: '',
    });
    const pick = String(Array.isArray(v) ? v[0] ?? '' : v ?? '');
    if (!pick || !weapons.some((a) => a.id === pick)) continue;
    const { key: k, action } = findAction(tx, e, `weapon:${pick}`);
    executeAction(tx, { actor: e, actionKey: k, action, targets: [mover], cause: seq, viaReaction: true, options: { as: 'reaction' } });
  }
}

/* ------------------------------ 走 ------------------------------ */

/**
 * 一格一格走过 path（含起点）。每一步：先看有没有人能借机攻击（还在原来那格时打），再看进了哪些区域。
 * forced = 被推、被拉（不引发借机攻击，进区域照算）。走的人倒下 / 速度变成 0 就停下。
 */
export function travel(tx: Tx, id: Id, path: Cell[], o: { forced: boolean; cause: number | null }): void {
  const me = tx.pos?.[id];
  if (!me || path.length < 2) return;
  const from = { x: me.x, y: me.y };
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
    me.x = path[i].x;
    me.y = path[i].y;
    for (const z of Object.values(tx.state.zones ?? {})) {
      if (!inZone(z, { ...prev, s: me.s }) && inZone(z, me)) runZone(tx, z, id, 'enter', o.cause);
    }
  }
  if (me.x !== from.x || me.y !== from.y) tx.emit('moved', { id, from, to: { x: me.x, y: me.y }, forced: o.forced }, o.cause);
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
  travel(tx, target, path, { forced: true, cause });
  return true;
}

/* ------------------------------ 区域 ------------------------------ */

const WHY_CN: Record<ZoneWhen, string> = { enter: '进入', turnStart: '在里面开始回合', turnEnd: '在里面结束回合' };

/** 区域对一个生物生效一次 */
export function runZone(tx: Tx, z: Zone, victim: Id, why: ZoneWhen, cause: number | null): void {
  const c = tx.state.combatants[victim];
  if (!c || c.live.dead || !z.on.includes(why)) return;
  const live = tx.state.zones?.[z.id];
  if (!live) return;
  if (live.affects !== 'all' && live.source && tx.state.combatants[live.source]) {
    const same = tx.state.combatants[live.source].side === c.side;
    if (live.affects === 'enemies' ? same : !same) return;
  }
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
  const self = live.source && tx.state.combatants[live.source] ? live.source : victim;
  runNodes(tx, live.do, {
    self, source: live.source, targets: [victim], target: victim, attacker: self,
    entryKey: live.entryKey, actionName: live.name, cause: seq, locals: {}, slot: live.slot,
    damageDefs: collectDamageDefs(live.do), originKind: live.source ? 'spell' : 'feature', vars: {},
  });
}

/** 回合开始 / 结束：这个人所在的区域各生效一次 */
export function zonesOnTurn(tx: Tx, id: Id, why: 'turnStart' | 'turnEnd', cause: number | null): void {
  for (const z of zonesAt(tx, id)) runZone(tx, z, id, why, cause);
}

/** 新一轮开始：到期的区域消失 */
export function expireZones(tx: Tx, round: number, cause: number | null): void {
  for (const z of Object.values(tx.state.zones ?? {})) {
    if (z.untilRound !== null && round >= z.untilRound) tx.emit('zoneRemoved', { id: z.id, name: z.name, reason: '持续时间到' }, cause);
  }
}

/** 专注结束：随它的区域消失 */
export function zonesOfConcentration(tx: Tx, concId: string, cause: number | null): void {
  for (const z of Object.values(tx.state.zones ?? {})) {
    if (z.link === concId) tx.emit('zoneRemoved', { id: z.id, name: z.name, reason: '专注结束' }, cause);
  }
}
