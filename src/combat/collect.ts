import { Unknown, runBool, type Question } from '../expr';
import { activeTemplates, aurasCovering, auraGate, effectiveView, entryOf, live } from './effects';
import { makeEnv, nameOf } from './scope';
import type { Tx } from './tx';
import type { ActiveEffect, Aura, Entry, Id, RollMod, Trigger } from './types';

/** 灵光与「条目在哪」的收集挪到 effects.ts 了（effectiveView 要用灵光授予的静态修正），这里保留下面的收集器 */
export { aurasCovering, auraGate, entryOf, live } from './effects';

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

/** 某个参与者身上的条目：规则书里写好的优先，没有就用他自带的（怪物数据卡、自动生成的物品动作） */

function permanentEntries(tx: Tx, id: Id): Array<[string, Entry]> {
  const out: Array<[string, Entry]> = [];
  const seen = new Set<string>();
  for (const k of effectiveView(tx, id).sources) {
    if (seen.has(k)) continue;
    seen.add(k);
    const e = entryOf(tx, id, k);
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

