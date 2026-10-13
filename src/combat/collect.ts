import { Unknown, runBool, type Question } from '../expr';
import { activeTemplates, effectiveView } from './effects';
import { makeEnv, nameOf } from './scope';
import type { Tx } from './tx';
import type { ActiveEffect, Aura, Entry, Id, RollMod, Trigger } from './types';

/**
 * 「谁身上有哪些动态声明」的统一收集：
 *   常驻条目（view.sources）+ 全局条目（武器精通、可选核心规则）+ 身上的效应（含隐含状态）+ 覆盖到他的灵光。
 * 检定修正、触发器、灵光都从这里拿，保证三处看到的是同一份事实。
 */

export interface Declared<T> {
  item: T;
  /** 声明的持有者（rollMod 的 bearer / trigger 的 self） */
  owner: Id;
  /** 效应来源 / 灵光主人；常驻能力为 owner 自己 */
  source: Id | null;
  effect?: ActiveEffect;
  /** 条目键（模板解析的基准，也用于回执上的「来自」） */
  from: string;
  /** 灵光授予的：额外的「在不在灵光范围内」条件 */
  auraGate?: { aura: Aura; holder: Id };
  stackGroup?: string;
}

/** 条目的动态声明是否生效（`automation: 'manual'` = 这一条由人裁定，引擎不碰） */
const live = (e: Entry | undefined): e is Entry => !!e && e.automation !== 'manual';

function permanentEntries(tx: Tx, id: Id): Array<[string, Entry]> {
  const out: Array<[string, Entry]> = [];
  const seen = new Set<string>();
  for (const k of effectiveView(tx, id).sources) {
    if (seen.has(k)) continue;
    seen.add(k);
    const e = tx.rules.entry(k);
    if (live(e)) out.push([k, e]);
  }
  for (const [k, e] of tx.rules.globals()) if (!seen.has(k) && live(e)) out.push([k, e]);
  return out;
}

export function rollModsOf(tx: Tx, id: Id): Declared<RollMod>[] {
  const out: Declared<RollMod>[] = [];
  for (const [k, e] of permanentEntries(tx, id)) for (const m of e.rollMods ?? []) out.push({ item: m, owner: id, source: id, from: k });
  for (const at of activeTemplates(tx, id)) {
    for (const m of at.tpl.rollMods ?? []) out.push({ item: m, owner: id, source: at.effect.source, effect: at.effect, from: at.key });
  }
  for (const g of aurasCovering(tx, id)) {
    for (const m of g.aura.grant.rollMods ?? []) {
      out.push({ item: m, owner: id, source: g.holder, from: g.from, auraGate: { aura: g.aura, holder: g.holder }, stackGroup: g.aura.stackKey ?? `${g.from}:${g.aura.id}` });
    }
  }
  return out;
}

export function triggersOf(tx: Tx, id: Id): Declared<Trigger>[] {
  const out: Declared<Trigger>[] = [];
  for (const [k, e] of permanentEntries(tx, id)) for (const t of e.triggers ?? []) out.push({ item: t, owner: id, source: id, from: k });
  for (const at of activeTemplates(tx, id)) {
    for (const t of at.tpl.triggers ?? []) out.push({ item: t, owner: id, source: at.effect.source, effect: at.effect, from: at.key });
  }
  for (const g of aurasCovering(tx, id)) {
    for (const t of g.aura.grant.triggers ?? []) {
      out.push({ item: t, owner: id, source: g.holder, from: g.from, auraGate: { aura: g.aura, holder: g.holder } });
    }
  }
  return out;
}

/** 某人身上由窗口触发的动作（护盾术：反应；至圣斩：命中后的附赠动作）—— 写了 trigger 的 Action */
export function triggeredActionsOf(tx: Tx, id: Id): Array<{ key: string; action: NonNullable<Entry['actions']>[number] }> {
  const out: Array<{ key: string; action: NonNullable<Entry['actions']>[number] }> = [];
  for (const [k, e] of permanentEntries(tx, id)) {
    for (const a of e.actions ?? []) if (a.trigger) out.push({ key: k, action: a });
  }
  return out;
}

interface AuraHit { aura: Aura; holder: Id; from: string }

/** 所有「可能覆盖到 who」的灵光（阵营与自身规则已经过滤；距离留给 auraGate 在求值时问） */
export function aurasCovering(tx: Tx, who: Id): AuraHit[] {
  const out: AuraHit[] = [];
  const whoC = tx.state.combatants[who];
  if (!whoC) return out;
  for (const holder of Object.keys(tx.state.combatants)) {
    const hc = tx.state.combatants[holder];
    if (hc.live.dead) continue;
    const list: Array<{ aura: Aura; from: string }> = [];
    for (const k of effectiveView(tx, holder).sources) {
      const e = tx.rules.entry(k);
      if (live(e)) for (const a of e.auras ?? []) list.push({ aura: a, from: k });
    }
    for (const at of activeTemplates(tx, holder)) if (at.tpl.aura) list.push({ aura: at.tpl.aura, from: at.key });
    for (const { aura, from } of list) {
      if (holder === who && !aura.includeSelf) continue;
      const ally = hc.side === whoC.side;
      if (aura.affects === 'allies' && !ally) continue;
      if (aura.affects === 'enemies' && ally) continue;
      out.push({ aura, holder, from });
    }
  }
  return out;
}

/** 灵光门槛：灵光主人满足 requires，且 who 在范围内（无地图 → 问，按回合记住） */
export function auraGate(tx: Tx, gate: { aura: Aura; holder: Id }, who: Id): boolean | Unknown {
  const { aura, holder } = gate;
  if (aura.requires !== undefined) {
    const r = runBool(aura.requires, makeEnv(tx, { self: holder }));
    if (r === false) return false;
    if (r instanceof Unknown) return r;
  }
  if (holder === who) return true;
  const d = tx.ctx.spatial?.distance(holder, who);
  if (typeof d === 'number') return d <= aura.radius;
  const q: Question = {
    id: `aura:${holder}:${aura.id}:${who}`,
    text: `${nameOf(tx, who)} 在 ${nameOf(tx, holder)} 的灵光（${aura.radius} 尺）范围内吗？`,
    subjects: [holder, who],
    scope: 'turn',
  };
  const a = tx.answerOf(q.id);
  return a !== undefined ? a : new Unknown([q]);
}
