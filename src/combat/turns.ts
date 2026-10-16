import { ABIL_CN, Unknown, runInt } from '../expr';
import { applyHeal, kill } from './damage';
import { d20Test } from './d20';
import { effectiveView, effectsOf, endEffect, roundsOf } from './effects';
import { makeEnv } from './scope';
import { expireZones, zonesOnTurn } from './space';
import { fireWindow } from './triggers';
import { Rejected, type Tx } from './tx';
import { freshEconomy } from './view';
import type { ActiveEffect, Id } from './types';

/**
 * 回合流程与持续时间（COMBAT-DESIGN §3.4）。
 *
 * 持续时间的计数方式：
 * - rounds / minutes / max：按「施加时轮到的那个人」的回合开始计数（ticks）；
 * - until { at, of, nth }：数 `of` 那个人在锚点之后**开始**的回合（untilCount），第 nth 个时到期；
 *   `extendEffect` 把 untilCount 归零 = 重新锚定（狂暴延长）。
 */

const untilOf = (e: ActiveEffect): Id | null => {
  const u = e.duration.until;
  if (!u) return null;
  return u.of === 'bearer' ? e.bearer : e.source;
};

export function rollInitiative(tx: Tx, id: Id, cause: number | null): number {
  const v = effectiveView(tx, id);
  const r = d20Test(tx, { roller: id, kind: 'check', sub: 'initiative', ability: 'dex', bonus: v.initiative, label: '先攻', cause });
  tx.emit('initiativeSet', { id, value: r.total }, r.seq);
  return r.total;
}

export function startCombat(tx: Tx, order: Id[] | undefined, cause: number | null): void {
  if (tx.state.round !== null) throw new Rejected('战斗已经开始了');
  const ids = Object.keys(tx.state.combatants);
  if (!ids.length) throw new Rejected('遭遇里还没有参与者');
  let finalOrder = order?.filter((x) => ids.includes(x));
  if (!finalOrder?.length) {
    for (const id of ids) if (tx.state.combatants[id].initiative === null) rollInitiative(tx, id, cause);
    finalOrder = ids.slice().sort((a, b) => {
      const ca = tx.state.combatants[a];
      const cb = tx.state.combatants[b];
      return (cb.initiative ?? 0) - (ca.initiative ?? 0)
        || effectiveView(tx, b).score.dex - effectiveView(tx, a).score.dex
        || a.localeCompare(b);
    });
  }
  const seq = tx.emit('combatStarted', { order: finalOrder }, cause);
  // 战斗开始前施加的效应：从现在起按第一个行动者的回合计数
  for (const e of Object.values(tx.state.effects)) {
    if (e.timing.tickOf === null) tx.emit('effectUpdated', { id: e.id, patch: { timing: { ...e.timing, tickOf: finalOrder[0] } } }, seq);
  }
  for (const id of finalOrder) fireWindow(tx, { event: 'initiativeRolled', window: 'after', actor: id, scope: {}, cause: seq });
  beginTurn(tx, finalOrder[0], seq);
}

export function nextTurn(tx: Tx, cause: number | null): void {
  if (tx.state.round === null) throw new Rejected('还没有开始战斗');
  const order = tx.state.order;
  endTurn(tx, order[tx.state.turnIndex], cause);
  let idx = tx.state.turnIndex;
  let round = tx.state.round;
  for (let i = 0; i < order.length; i++) {
    idx++;
    if (idx >= order.length) { idx = 0; round++; }
    const c = tx.state.combatants[order[idx]];
    if (c && !(c.live.dead && c.kind !== 'pc')) break;     // 死掉的怪物跳过；PC 死了也照常轮到（方便 DM 处理）
  }
  if (round !== tx.state.round) {
    tx.emit('roundStarted', { round }, cause);
    expireZones(tx, round, cause);
  }
  const seq = tx.emit('turnChanged', { round, turnIndex: idx }, cause);
  beginTurn(tx, order[idx], seq);
}

export function beginTurn(tx: Tx, id: Id, cause: number | null): void {
  const seq = tx.emit('turnStarted', { id, round: tx.state.round }, cause);
  const c = tx.state.combatants[id];
  tx.emit('economyReset', { id, economy: { ...freshEconomy(effectiveView(tx, id)), once: c.economy.once } }, seq);

  for (const e of Object.values(tx.state.effects)) {
    if (!tx.state.effects[e.id]) continue;
    const timing = { ...e.timing };
    let changed = false;
    if (timing.tickOf === id) { timing.ticks++; changed = true; }
    if (untilOf(e) === id) { timing.untilCount++; changed = true; }
    if (!changed) continue;
    tx.emit('effectUpdated', { id: e.id, patch: { timing } }, seq);
    const rounds = roundsOf(e.duration);
    if (rounds > 0 && timing.ticks >= rounds) { endEffect(tx, e.id, '持续时间到', seq); continue; }
    const max = roundsOf(e.duration.max);
    if (max > 0 && timing.ticks >= max) { endEffect(tx, e.id, '达到持续时间上限', seq); continue; }
    const u = e.duration.until;
    if (u && u.at === 'turnStart' && untilOf(e) === id && timing.untilCount >= (u.nth ?? 1)) endEffect(tx, e.id, '持续时间到', seq);
  }
  rechargeCheck(tx, id, seq);
  saveEndsCheck(tx, id, 'turnStart', seq);
  if (c.kind === 'pc' && c.live.hp === 0 && !c.live.dead && !c.live.stable) deathSave(tx, id, seq);
  fireWindow(tx, { event: 'turnStarted', window: 'after', actor: id, scope: {}, cause: seq });
  zonesOnTurn(tx, id, 'turnStart', seq);
}

export function endTurn(tx: Tx, id: Id, cause: number | null): void {
  const seq = tx.emit('turnEnding', { id, round: tx.state.round }, cause);
  saveEndsCheck(tx, id, 'turnEnd', seq);
  for (const e of Object.values(tx.state.effects)) {
    if (!tx.state.effects[e.id]) continue;
    const u = e.duration.until;
    if (u && u.at === 'turnEnd' && untilOf(e) === id && e.timing.untilCount >= (u.nth ?? 1)) endEffect(tx, e.id, '持续时间到', seq);
  }
  fireWindow(tx, { event: 'turnEnded', window: 'after', actor: id, scope: {}, cause: seq });
  zonesOnTurn(tx, id, 'turnEnd', seq);
  tx.emit('turnEnded', { id }, seq);
}

/** 充能（吐息武器）：用过的在自己回合开始时掷 d6，达到阈值就又能用 */
function rechargeCheck(tx: Tx, id: Id, cause: number | null): void {
  const c = tx.state.combatants[id];
  for (const [k, used] of Object.entries(c.live.resourcesUsed)) {
    const m = /^充能:(\d):(.*)$/.exec(k);
    if (!m || !used) continue;
    const [[f]] = tx.roll([{ faces: 6, count: 1 }], c.controller, `${m[2]} 充能`);
    const ok = f >= Number(m[1]);
    const seq = tx.emit('note', { text: `${c.name} 的「${m[2]}」充能：d6 = ${f}${ok ? '，恢复' : '，还没好'}`, owner: id }, cause);
    if (ok) tx.emit('resourceUsed', { id, resource: k, used: 0 }, seq);
  }
}

/** 「目标在其每回合结束时可以重新进行这次豁免」 */
function saveEndsCheck(tx: Tx, bearer: Id, at: 'turnStart' | 'turnEnd', cause: number | null): void {
  for (const e of effectsOf(tx, bearer)) {
    const se = e.duration.saveEnds;
    if (!se || se.at !== at || !tx.state.effects[e.id]) continue;
    let dc = typeof e.snap.dc === 'number' ? e.snap.dc : undefined;
    if (dc === undefined && se.dc !== undefined && e.source && tx.state.combatants[e.source]) {
      const v = runInt(se.dc, makeEnv(tx, { self: e.source }));
      dc = v instanceof Unknown ? undefined : v;
    }
    if (dc === undefined) {
      tx.emit('ruleError', { where: `效应「${e.name}」`, message: '豁免结束：没有 DC（施加时没有记录，也没写 saveEnds.dc）' }, cause);
      continue;
    }
    const r = d20Test(tx, {
      roller: bearer, kind: 'save', ability: se.ability, bonus: effectiveView(tx, bearer).save[se.ability], vs: dc,
      label: `${ABIL_CN[se.ability]}豁免（摆脱「${e.name}」）`, cause,
    });
    if (r.outcome === 'success') endEffect(tx, e.id, '豁免成功', r.seq);
  }
}

export function deathSave(tx: Tx, id: Id, cause: number | null): void {
  const c = tx.state.combatants[id];
  const rule = tx.rules.coreParam<{ dc: number; nat20: string; nat1: number }>('deathSave');
  const r = d20Test(tx, { roller: id, kind: 'save', sub: 'deathSave', bonus: 0, vs: rule.dc, label: '死亡豁免', cause });
  let { s, f } = c.live.deathSaves;
  if (r.natural === 20 && rule.nat20 === 'heal1' && !r.overridden) {
    tx.emit('deathSaveResult', { id, result: '天然 20：恢复 1 点生命值' }, r.seq);
    applyHeal(tx, id, 1, '死亡豁免天然 20', r.seq);
    return;
  }
  if (r.natural === 1 && !r.overridden) f += rule.nat1;
  else if (r.outcome === 'success') s += 1;
  else f += 1;
  tx.emit('deathSavesChanged', { id, s: Math.min(3, s), f: Math.min(3, f) }, r.seq);
  if (f >= 3) { kill(tx, id, '死亡豁免失败 3 次', r.seq); return; }
  if (s >= 3) {
    tx.emit('stableChanged', { id, stable: true }, r.seq);
    tx.emit('deathSaveResult', { id, result: '伤势稳定' }, r.seq);
  }
}

/** 战斗外推进时间：按轮计数的效应一起走；回合相对的效应（「直到你的下一回合开始」）视为已经过去 */
export function advanceTime(tx: Tx, minutes: number, cause: number | null): void {
  const seq = tx.emit('timeAdvanced', { minutes }, cause);
  const rounds = Math.round(minutes * 10);
  for (const e of Object.values(tx.state.effects)) {
    if (!tx.state.effects[e.id]) continue;
    const total = roundsOf(e.duration);
    const max = roundsOf(e.duration.max);
    const ticks = e.timing.ticks + rounds;
    if ((total > 0 && ticks >= total) || (max > 0 && ticks >= max) || e.duration.until) {
      endEffect(tx, e.id, '时间流逝', seq);
      continue;
    }
    if (total > 0 || max > 0) tx.emit('effectUpdated', { id: e.id, patch: { timing: { ...e.timing, ticks } } }, seq);
  }
}

export function rest(tx: Tx, kind: 'short' | 'long', ids: Id[] | undefined, cause: number | null): void {
  const who = ids?.length ? ids : Object.keys(tx.state.combatants).filter((x) => tx.state.combatants[x].kind === 'pc');
  const seq = tx.emit('restStarted', { kind, ids: who }, cause);
  advanceTime(tx, kind === 'long' ? tx.rules.coreParam<{ long: number }>('rest').long : tx.rules.coreParam<{ short: number }>('rest').short, seq);
  for (const id of who) {
    const c = tx.state.combatants[id];
    if (!c || c.live.dead) continue;
    if (kind === 'long') {
      tx.emit('hpChanged', { id, hp: effectiveView(tx, id).hpMax, tempHp: 0 }, seq);
      tx.emit('deathSavesChanged', { id, s: 0, f: 0 }, seq);
      for (const lvl of Object.keys(c.live.slotsUsed)) tx.emit('slotUsed', { id, level: Number(lvl), used: 0 }, seq);
      for (const r of Object.keys(c.live.resourcesUsed)) tx.emit('resourceUsed', { id, resource: r, used: 0 }, seq);
      const ex = effectsOf(tx, id).find((e) => e.name === '力竭');
      if (ex) {
        const level = Number(ex.state.level ?? 1) - 1;
        if (level <= 0) endEffect(tx, ex.id, '长休', seq);
        else tx.emit('effectUpdated', { id: ex.id, patch: { state: { ...ex.state, level } } }, seq);
      }
    }
  }
  tx.emit('restCompleted', { kind, ids: who }, seq);
  for (const id of who) fireWindow(tx, { event: 'restCompleted', window: 'after', actor: id, scope: { event: { kind } }, cause: seq });
}

