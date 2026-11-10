import { Dice, Unknown, runDice, runInt, type ExprSrc, type Value } from '../expr';
import { rollModsOf } from './collect';
import { currentAction, hideMarksOfRoll, markAction, resultOf } from './instance';
import { controllerOf, d20Test, evaluateMods, filterMatches } from './d20';
import { activeTemplates, applyEffect, concentrationOf, effectiveView, effectsOf, endConcentration, endEffect } from './effects';
import { makeEnv, nameOf } from './scope';
import { fireWindow } from './triggers';
import type { Tx } from './tx';
import type { ActiveEffect, AttackInfo, Id } from './types';

/**
 * 伤害管线（COMBAT-DESIGN §七）：
 *   ① 掷骰（重击：伤害骰翻倍，调整值不翻）→ ② 按类型合计 → ③ damageIncoming 窗口（直觉闪避…）
 *   → ④ 调整顺序：加减值 → 抗性（减半向下取整）→ 易伤（加倍）；免疫 → 0
 *   → ⑤ 先扣临时生命值 → ⑥ 降至 0 前窗口 → ⑦ 后果（即死 / 昏迷 / 死亡豁免 / 专注检定）→ ⑧ damageTaken 窗口
 */

export interface DamageComponent {
  dice: Dice;
  type: string;
  from: string;
  /** 已经掷过（共享伤害：火球术对每个目标用同一次掷骰） */
  rolled?: { faces: number[][]; total: number; crit: boolean };
}

export interface DamagePacket {
  source: Id | null;
  target: Id;
  components: DamageComponent[];
  crit: boolean;
  label: string;
  attack?: AttackInfo;
  /** 豁免成功减半之类 */
  scale?: number;
  halve?: boolean;
  double?: boolean;
  cancel?: boolean;
  /** 来自豁免的伤害：哪项豁免、成没成功、成功是否只受一半（反射闪避看这个） */
  save?: { ability: string; success: boolean; half: boolean };
  /** 伤害骰全部取最大值（超限导能） */
  max?: boolean;
  /** 共享掷骰的 id（火球术各目标同一次掷骰）：同一次掷骰算一次「伤害掷骰」 */
  rollKey?: string;
  /** 这次伤害无视抗性 / 免疫（damage 节点的 ignoreResist / ignoreImmunity） */
  ignoreResist?: boolean;
  ignoreImmunity?: boolean;
  reduce: Array<{ value: number; types?: string[] }>;
  /** 替承受者吸收伤害的人（投射守御用 tempHp 吸收，溢出仍归原目标；护卫灵光用 hp 吸收全部） */
  absorbers?: Array<{ id: Id; from: 'tempHp' | 'hp'; label: string }>;
}

export interface DamageResult {
  byType: Record<string, number>;
  total: number;
  hpBefore: number;
  hpAfter: number;
  tempAbsorbed: number;
  downed: boolean;
  killed: boolean;
  seq: number;
}

/** 伤害类型规范名：站点 2024 译名为准（「斩击」是旧译 → 挥砍） */
const TYPE_ALIAS: Record<string, string> = {
// 站点和引擎两边对「黯蚀」的写法不一样（5etools 写「暗蚀」、官方译名「黯蚀」）：
// 两种都收进同一个类型，否则数据里写「黯蚀」的伤害匹配不上「暗蚀」的抗性
  黯蚀: '暗蚀',
  斩击: '挥砍', B: '钝击', P: '穿刺', S: '挥砍', A: '强酸', C: '寒冷', F: '火焰', O: '力场', N: '暗蚀', R: '光耀',
  Y: '心灵', I: '毒素', L: '闪电', T: '雷鸣', E: '力场',
  bludgeoning: '钝击', piercing: '穿刺', slashing: '挥砍', acid: '强酸', cold: '寒冷', fire: '火焰', force: '力场',
  necrotic: '暗蚀', radiant: '光耀', psychic: '心灵', poison: '毒素', lightning: '闪电', thunder: '雷鸣',
};
export const normType = (t: string): string => TYPE_ALIAS[t] ?? t;

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

/** 这包伤害由哪几项组成（来源名，去重）：damage.parts / action.damage.parts，「这次有没有偷袭」看它 */
const partsOf = (p: DamagePacket): string[] => [...new Set(p.components.map((c) => c.from).filter(Boolean))];

/**
 * 掷一个组件。重击按核心参数：
 *   doubleDice（RAW）—— 伤害骰掷两次；maxPlusRoll（常见房规）—— 一份取最大值 + 一份正常掷。
 * minDie：巨武器战斗把 1、2 当 3。
 */
export function rollComponent(tx: Tx, c: DamageComponent, crit: boolean, user: string, minDie: number, max = false): { faces: number[][]; total: number } {
  const mode = crit ? tx.rules.coreParam<string>('critDamage') : 'none';
  const dice = mode === 'doubleDice' ? c.dice.doubled() : c.dice;
  if (dice.isConstant) return { faces: [], total: dice.flat };
  // 取最大值：不用掷
  const faces = max ? dice.terms.map((t) => Array<number>(t.count).fill(t.faces))
    : tx.roll(dice.terms.map((t) => ({ faces: t.faces, count: t.count })), user, `${c.from}（${c.type}）`, 'damage');
  const adj = faces.map((fs) => fs.map((f) => Math.max(f, minDie)));
  let total = dice.flat;
  dice.terms.forEach((t, i) => { total += t.sign * sum(adj[i]); });
  if (mode === 'maxPlusRoll') for (const t of dice.terms) total += t.sign * t.count * t.faces;
  return { faces: adj, total };
}

/** 不是攻击造成的伤害：表达式里的 attack.* 都是 false（`!attack.weapon` 这种写法不至于报错） */
const NO_ATTACK: AttackInfo = {
  melee: false, ranged: false, weapon: false, spell: false, unarmed: false, finesse: false, reach: false,
  ability: null, damageType: '', item: null, mastery: null,
};

/**
 * rerollDamage：把这次伤害里最小的几颗骰子重掷（按「点数 / 面数」排，1 点的 d12 比 1 点的 d4 先重掷），
 * 改写伤害包的骰面并重算各类型的合计；共享掷骰记到动作实例上，同一次掷骰的其他目标照用。
 */
function rerollLowest(tx: Tx, p: DamagePacket, count: ExprSrc, by: { owner: Id; source: Id | null; effect?: ActiveEffect; label: string }, byType: Record<string, number>, cause: number): void {
  // 共享掷骰（火球术）已经重掷过：同一次掷骰不再重掷（骰面在 ② 已经换成重掷后的了）
  if (p.rollKey && currentAction(tx)?.rerolled?.[p.rollKey]) return;
  const k = runInt(count, makeEnv(tx, { self: by.owner, source: by.source, effect: by.effect }));
  if (typeof k !== 'number' || k <= 0) return;
  const mode = tx.rules.coreParam<string>('critDamage');
  const slots: Array<{ ci: number; ti: number; fi: number; faces: number; v: number }> = [];
  p.components.forEach((c, ci) => {
    const r = c.rolled;
    if (!r || c.dice.isConstant) return;
    const dice = r.crit && mode === 'doubleDice' ? c.dice.doubled() : c.dice;
    r.faces.forEach((fs, ti) => fs.forEach((v, fi) => { const f = dice.terms[ti]?.faces; if (f) slots.push({ ci, ti, fi, faces: f, v }); }));
  });
  if (!slots.length) return;
  slots.sort((a, b) => a.v / a.faces - b.v / b.faces);
  const pickd = slots.slice(0, k);
  const user = controllerOf(tx, by.owner);
  const fresh = tx.roll(pickd.map((s) => ({ faces: s.faces, count: 1 })), user, `${by.label}：重掷伤害骰`, 'damage');
  pickd.forEach((s, i) => { p.components[s.ci].rolled!.faces[s.ti][s.fi] = fresh[i][0]; });
  // 重算每一项的合计、各类型合计
  for (const ci of new Set(pickd.map((s) => s.ci))) {
    const c = p.components[ci];
    const r = c.rolled!;
    const dice = r.crit && mode === 'doubleDice' ? c.dice.doubled() : c.dice;
    let total = dice.flat;
    dice.terms.forEach((t, ti) => { total += t.sign * sum(r.faces[ti] ?? []); });
    if (r.crit && mode === 'maxPlusRoll') for (const t of c.dice.terms) total += t.sign * t.count * t.faces;
    r.total = total;
  }
  for (const key of Object.keys(byType)) delete byType[key];
  for (const c of p.components) { const t = normType(c.type); byType[t] = (byType[t] ?? 0) + Math.max(0, c.rolled?.total ?? 0); }
  if (p.scale !== undefined) for (const key of Object.keys(byType)) byType[key] = Math.floor(byType[key] * p.scale);
  const inst = currentAction(tx);
  if (inst && p.rollKey) (inst.rerolled ??= {})[p.rollKey] = p.components.map((c) => (c.rolled ? { faces: c.rolled.faces.map((f) => f.slice()), total: c.rolled.total, crit: !!c.rolled.crit } : undefined));
  tx.emit('note', { text: `${by.label}：重掷 ${pickd.length} 颗伤害骰（${pickd.map((s) => s.v).join('、')} → ${fresh.map((f) => f[0]).join('、')}）`, owner: by.owner, target: p.target }, cause);
}

export function applyDamagePacket(tx: Tx, p: DamagePacket, cause: number | null): DamageResult {
  const user = p.source ? controllerOf(tx, p.source) : 'dm';

  // ① 攻击者的伤害修正（狂暴伤害、巨武器战斗…）
  //    攻击造成的伤害：所有 damage 修正都看；不是攻击的伤害（火球术这类豁免法术）：只看写了 on.spell 的
  //    （强效塑能、强力施法），免得「近战伤害 +2」这类没写攻击过滤的修正跑到法术伤害上
  // minDie / maxDice 按伤害组成记：没写 part 的管整包，写了的只管那几项
  const dieMods: Array<{ min: number; max: boolean; parts: string[] | null }> = [];
  if (p.source && tx.state.combatants[p.source]) {
    const primary = p.components[0]?.type ?? '';
    const req = { kind: 'attack' as const, attack: p.attack };
    const inst = currentAction(tx);
    const fromSpell = p.attack ? !!p.attack.spell : !!inst && inst.kind === 'spell' && inst.by === p.source;
    const cands = rollModsOf(tx, p.source)
      .filter((d) => d.item.who === 'bearer' && d.item.on.kind !== undefined && [d.item.on.kind].flat().includes('damage')
        && (p.attack ? filterMatches({ ...d.item.on, kind: 'attack' }, req) : d.item.on.spell !== undefined && !d.item.on.attack)
        && (d.item.on.spell === undefined || d.item.on.spell === fromSpell)
        && (d.item.on.part === undefined || [d.item.on.part].flat().some((x) => p.components.some((c) => c.from === x))))
      .map((d) => ({
        d,
        scope: {
          self: p.source!, source: d.source, target: p.target, attacker: p.source!, attack: p.attack ?? NO_ATTACK, effect: d.effect,
          damage: { type: primary, amount: 0, crit: p.crit, isAttack: !!p.attack, parts: partsOf(p) } as Record<string, Value>,
        },
      }));
    if (cands.length) {
      const { active } = hideMarksOfRoll(tx, p.rollKey, () => evaluateMods(tx, cands, p.source!, `${p.label} 伤害`));
      for (const { d } of active) if (d.item.mark) markAction(tx, d.item.mark, true, p.rollKey);
      for (const { d, value } of active) {
        const parts = d.item.on.part === undefined ? null : [d.item.on.part].flat();
        if (d.item.op === 'minDie' && typeof value === 'number') dieMods.push({ min: value, max: false, parts });
        if (d.item.op === 'maxDice' && (d.item.on.spell === undefined || d.item.on.spell === !!p.attack?.spell)) {
          if (parts) dieMods.push({ min: 0, max: true, parts }); else p.max = true;
        }
        if ((d.item.op === 'add' || d.item.op === 'addDice') && value !== undefined) {
          const dice = value instanceof Dice ? value : Dice.constant(value);
          p.components.push({ dice, type: primary, from: d.item.label });
        }
      }
    }
  }

  // ② 掷骰与合计
  const rolledParts: Array<{ from: string; type: string; dice: string; faces: number[]; total: number }> = [];
  const byType: Record<string, number> = {};
  const rer = p.rollKey ? currentAction(tx)?.rerolled?.[p.rollKey] : undefined;
  p.components.forEach((c, i) => { const x = rer?.[i]; if (x && c.rolled) c.rolled = { faces: x.faces.map((f) => f.slice()), total: x.total, crit: x.crit }; });
  for (const c of p.components) {
    const mine = dieMods.filter((m) => !m.parts || m.parts.includes(c.from));
    const minDie = Math.max(0, ...mine.map((m) => m.min));
    const r = c.rolled ?? { ...rollComponent(tx, c, p.crit, user, minDie, p.max || mine.some((m) => m.max)), crit: p.crit };
    c.rolled = r;
    const type = normType(c.type);
    rolledParts.push({ from: c.from, type, dice: (r.crit ? c.dice.doubled() : c.dice).toString(), faces: r.faces.flat(), total: r.total });
    byType[type] = (byType[type] ?? 0) + Math.max(0, r.total);
  }
  if (p.scale !== undefined) for (const k of Object.keys(byType)) byType[k] = Math.floor(byType[k] * p.scale);
  const rolledTotal = sum(Object.values(byType));
  // 动作实例记下这次的伤害骰（「再掷一颗同样的骰子」用 action.damage.die）：取第一项（武器 / 法术本身的伤害）
  const dinst = currentAction(tx);
  if (dinst && p.source === dinst.by && p.components[0]) {
    dinst.damage = { dice: p.components[0].dice.toString(), type: normType(p.components[0].type), total: rolledTotal, parts: partsOf(p) };
  }
  const index = tx.damageIdx++;
  const rolledSeq = tx.emit('damageRolled', {
    index, source: p.source, target: p.target, label: p.label, crit: p.crit, parts: rolledParts, byType: { ...byType }, scale: p.scale ?? 1,
  }, cause);

  // ③ 承受方减伤窗口
  fireWindow(tx, {
    event: 'damageIncoming', window: 'before', actor: p.source ?? undefined, target: p.target,
    scope: {
      attack: p.attack,
      // save：这次伤害来自哪项豁免（不是豁免带来的 = 空字符串）；saved：豁免成功了没有
      damage: { type: p.components[0]?.type ?? '', amount: rolledTotal, crit: p.crit, save: p.save?.ability ?? '', saved: !!p.save?.success, isAttack: !!p.attack, parts: partsOf(p) },
      event: { label: p.label, source: p.source },
    },
    cause: rolledSeq,
    packet: p,
    modify: (m, by) => {
      if (m.op === 'halveDamage') p.halve = true;
      else if (m.op === 'doubleDamage') p.double = true;
      else if (m.op === 'cancel') p.cancel = true;
      else if (m.op === 'evasion') {
        // 只管「豁免成功只受一半」的伤害：成功 → 不受伤害，失败 → 一半
        if (!p.save?.half) return;
        if (p.save.success) p.cancel = true;
        else p.halve = true;
      } else if (m.op === 'reduceDamage') {
        // 可以带骰子（拦截 1d10 + 熟练加值）：由能力持有者的控制者掷一次
        const v = runDice(m.value, makeEnv(tx, { self: by.owner, source: by.source, effect: by.effect }));
        if (v instanceof Unknown) return;
        const fs = v.isConstant ? [] : tx.roll(v.terms.map((t) => ({ faces: t.faces, count: t.count })), controllerOf(tx, by.owner), by.label);
        let total = v.flat;
        v.terms.forEach((t, i) => { total += t.sign * fs[i].reduce((a, b) => a + b, 0); });
        p.reduce.push({ value: Math.max(0, total), types: m.types });
      } else if (m.op === 'redirect') {
        if (by.owner !== p.target && tx.state.combatants[by.owner] && !tx.state.combatants[by.owner].live.dead) {
          const old = p.target;
          p.target = by.owner;
          tx.emit('note', { text: `${by.label}：由 ${nameOf(tx, by.owner)} 代替 ${nameOf(tx, old)} 承受伤害`, owner: by.owner, target: old }, rolledSeq);
        }
      } else if (m.op === 'absorb') {
        (p.absorbers ??= []).push({ id: by.owner, from: m.from ?? 'tempHp', label: by.label });
      } else if (m.op === 'rerollDamage') {
        rerollLowest(tx, p, m.count, by, byType, rolledSeq);
      }
    },
  });

  // ④ 调整：加减值 → 抗性 → 易伤；免疫（redirect 后按新承受者算）
  const target = tx.state.combatants[p.target];
  const tv = effectiveView(tx, p.target);
  const notes: string[] = [];
  const final: Record<string, number> = {};
  // 伤害来源身上「无视抗性 / 免疫」的标记（castFrom 的 with、效应 flags.ignores）
  const srcIgnores = new Set(p.source && tx.state.combatants[p.source] ? activeTemplates(tx, p.source).flatMap((a) => a.tpl.flags?.ignores ?? []) : []);
  for (const [type, raw] of Object.entries(byType)) {
    let v = raw;
    if (p.cancel) { v = 0; notes.push('伤害被抵消'); }
    if (p.double) v *= 2;
    if (p.halve) v = Math.floor(v / 2);
    for (const r of p.reduce) if (!r.types || r.types.includes(type)) v = Math.max(0, v - r.value);
    const noImmune = p.ignoreImmunity || srcIgnores.has('immunity');
    const noResist = p.ignoreResist || srcIgnores.has('resistance');
    if (!noImmune && tv.immune.includes(type)) { v = 0; notes.push(`免疫${type}`); }
    else {
      if (!noResist && (tv.resist.includes(type) || tv.resist.includes('*'))) { v = Math.floor(v / 2); notes.push(`抗性：${type}减半`); }
      if (!noResist && tv.vuln.includes(type)) { v *= 2; notes.push(`易伤：${type}加倍`); }
    }
    final[type] = v;
  }
  if (p.halve) notes.unshift('伤害减半');
  if (p.double) notes.unshift('伤害加倍');
  const ov = tx.overrideDamage(index);
  if (ov) {
    for (const k of Object.keys(final)) final[k] = ov.amounts[k] ?? final[k];
    for (const [k, v] of Object.entries(ov.amounts)) final[k] = v;
    notes.push(`[DM 裁定] ${ov.reason ?? '伤害改写'}`);
  }
  let total = sum(Object.values(final));

  // ④.5 替承受者吸收伤害（投射守御：先算原目标的抗性与易伤，再扣法师的临时生命值，溢出仍归原目标；护卫灵光：代受全部）
  for (const ab of p.absorbers ?? []) {
    const ac = tx.state.combatants[ab.id];
    if (!ac || ac.live.dead || total <= 0) continue;
    if (ab.from === 'tempHp') {
      const taken = Math.min(ac.live.tempHp, total);
      if (taken > 0) {
        total -= taken;
        tx.emit('hpChanged', { id: ab.id, hp: ac.live.hp, tempHp: ac.live.tempHp - taken }, rolledSeq);
        notes.push(`${nameOf(tx, ab.id)}（${ab.label}）吸收 ${taken} 点伤害`);
      }
    } else {
      const taken = total;
      total = 0;
      const tAbs = Math.min(ac.live.tempHp, taken);
      const hpLoss = taken - tAbs;
      const abBefore = ac.live.hp;
      const abAfter = Math.max(0, abBefore - hpLoss);
      tx.emit('hpChanged', { id: ab.id, hp: abAfter, tempHp: ac.live.tempHp - tAbs }, rolledSeq);
      notes.push(`${nameOf(tx, ab.id)}（${ab.label}）代受 ${taken} 点伤害（生命值 ${abBefore} → ${abAfter}${tAbs ? `，临时生命值吸收 ${tAbs}` : ''}）`);
      if (abBefore > 0 && abAfter === 0) {
        if (ac.summoner || (ac.kind !== 'pc' && tx.state.settings.monsterAt0 === 'dead')) kill(tx, ab.id, `${nameOf(tx, ab.id)} 被击倒`, rolledSeq);
        else knockOut(tx, ab.id, rolledSeq);
      }
    }
  }

  // ⑤ 临时生命值先扣
  const hpBefore = target.live.hp;
  const tempBefore = target.live.tempHp;
  const tempAbsorbed = Math.min(tempBefore, total);
  const rest = total - tempAbsorbed;
  let hpAfter = Math.max(0, hpBefore - rest);

  // ⑥ 降至 0 之前：坚韧不屈、神之狂暴……
  if (hpBefore > 0 && hpAfter === 0 && rest > 0) {
    fireWindow(tx, {
      event: 'reducedTo0', window: 'before', actor: p.source ?? undefined, target: p.target,
      scope: { attack: p.attack, damage: { type: p.components[0]?.type ?? '', amount: total, crit: p.crit, isAttack: !!p.attack, parts: partsOf(p) } },
      cause: rolledSeq,
      modify: (m, by) => {
        if (m.op === 'setHp') {
          const v = runInt(m.value, makeEnv(tx, { self: by.owner, source: by.source, effect: by.effect, target: p.target }));
          if (typeof v === 'number' && v > 0) hpAfter = v;
        }
      },
    });
  }

  const seq = tx.emit('damageApplied', {
    index, source: p.source, target: p.target, label: p.label, crit: p.crit, byType: final, total, tempAbsorbed,
    hpBefore, hpAfter, notes,
  }, rolledSeq);
  tx.emit('hpChanged', { id: p.target, hp: hpAfter, tempHp: tempBefore - tempAbsorbed }, seq);

  // ⑦ 后果
  let downed = false;
  let killed = false;
  const massive = tx.rules.coreParam<boolean>('massiveDamage');
  if (total > 0 && !target.live.dead) {
    if (hpBefore > 0 && hpAfter === 0) {
      const overflow = rest - hpBefore;
      if (target.kind !== 'pc') {
        if (target.summoner || tx.state.settings.monsterAt0 === 'dead') { kill(tx, p.target, `${nameOf(tx, p.target)} 被击倒`, seq); killed = true; }
        else { knockOut(tx, p.target, seq); downed = true; }
      } else if (massive && overflow >= tv.hpMax) {
        kill(tx, p.target, `即死：溢出伤害 ${overflow} ≥ 生命值上限 ${tv.hpMax}`, seq);
        killed = true;
      } else {
        knockOut(tx, p.target, seq);
        downed = true;
      }
    } else if (hpBefore === 0 && target.kind === 'pc') {
      if (massive && rest >= tv.hpMax) {
        kill(tx, p.target, `即死：0 生命值时受到 ${rest} 点伤害 ≥ 生命值上限`, seq);
        killed = true;
      } else if (rest > 0) {
        const f = target.live.deathSaves.f + (p.crit ? 2 : 1);
        tx.emit('deathSavesChanged', { id: p.target, s: target.live.deathSaves.s, f: Math.min(3, f) }, seq);
        if (target.live.stable) tx.emit('stableChanged', { id: p.target, stable: false }, seq);
        tx.emit('deathSaveFailed', { id: p.target, by: p.crit ? '重击伤害（2 次）' : '受到伤害', failures: f }, seq);
        if (f >= 3) { kill(tx, p.target, '死亡豁免失败 3 次', seq); killed = true; }
      }
    }
  }

  // 专注检定（每个伤害来源单独一次）
  if (rest > 0 && !killed && concentrationOf(tx, p.target)) {
    const dcExpr = tx.rules.coreParam<string>('concentrationDc');
    const dc = runInt(dcExpr, makeEnv(tx, { self: p.target, damage: { type: '', amount: rest, crit: p.crit } }));
    if (typeof dc === 'number') {
      const r = d20Test(tx, {
        roller: p.target, kind: 'save', sub: 'concentration', ability: 'con', bonus: effectiveView(tx, p.target).save.con,
        vs: dc, label: '专注检定（体质豁免）', cause: seq,
      });
      if (r.outcome === 'fail') endConcentration(tx, p.target, `专注检定失败（DC ${dc}）`, r.seq);
    }
  }

  // 动作实例：这次动作对这个目标造成了多少、打倒了没有（action.result.*）
  const ainst = currentAction(tx);
  if (ainst && p.source === ainst.by) {
    const r = resultOf(ainst, p.target, false);
    r.damage += total;
    // 「降到 0」看生命值本身：怪物降到 0 直接算死（killed），不是 downed
    if (hpBefore > 0 && hpAfter === 0) r.reducedTo0 = true;
    if (killed) r.killed = true;
  }

  // ⑧ 受到伤害之后
  if (total > 0) {
    // 注意：damageTaken 既是窗口也要**发一个事件** —— 效应的 `endsOn: [{ event: 'damageTaken' }]`
    // 是靠 checkEndsOn 匹配事件的，只开窗口的话「受到伤害后结束」永远不触发（数据里有很多这种写法）
    tx.emit('damageTaken', { id: p.target, from: p.source ?? null, amount: total, type: p.components[0]?.type ?? '', crit: !!p.crit, tempAbsorbed, downed, killed }, seq);
    fireWindow(tx, {
      event: 'damageTaken', window: 'after', actor: p.source ?? undefined, target: p.target,
      scope: { attack: p.attack, damage: { type: p.components[0]?.type ?? '', amount: total, crit: p.crit, isAttack: !!p.attack, parts: partsOf(p) } },
      cause: seq,
    });
  }
  return { byType: final, total, hpBefore, hpAfter, tempAbsorbed, downed, killed, seq };
}

/** 降至 0：PC 陷入昏迷（随之倒地），死亡豁免归零。挂哪个状态由规则书说（`core.downed`） */
export function knockOut(tx: Tx, id: Id, cause: number | null): void {
  const ref = tx.rules.coreOr('downed', 'XPHB:condition:昏迷');
  tx.emit('deathSavesChanged', { id, s: 0, f: 0 }, cause);
  tx.emit('stableChanged', { id, stable: false }, cause);
  applyEffect(tx, {
    bearer: id, source: null, ref, baseKey: ref,
    duration: { manual: true }, origin: { kind: 'rule', ref: '0hp' }, cause,
  });
}

export function kill(tx: Tx, id: Id, reason: string, cause: number | null): void {
  tx.emit('deadChanged', { id, dead: true }, cause);
  tx.emit('died', { id, reason }, cause);
  endConcentration(tx, id, '死亡', cause);
}

export function applyHeal(tx: Tx, id: Id, amount: number, label: string, cause: number | null): void {
  const c = tx.state.combatants[id];
  if (!c || c.live.dead) {
    tx.emit('note', { text: `${nameOf(tx, id)} 已经死亡，治疗无效`, target: id }, cause);
    return;
  }
  const max = effectiveView(tx, id).hpMax;
  const before = c.live.hp;
  const after = Math.min(max, before + Math.max(0, amount));
  const seq = tx.emit('healed', { target: id, amount, label, hpBefore: before, hpAfter: after }, cause);
  tx.emit('hpChanged', { id, hp: after, tempHp: c.live.tempHp }, seq);
  if (before === 0 && after > 0) {
    tx.emit('deathSavesChanged', { id, s: 0, f: 0 }, seq);
    tx.emit('stableChanged', { id, stable: false }, seq);
    // 因 0 生命值陷入的昏迷随之结束（倒地不结束 —— 原文如此）
    for (const e of effectsOf(tx, id)) if (e.origin.kind === 'rule' && e.origin.ref === '0hp') endEffect(tx, e.id, '恢复了生命值', seq);
  }
}

export function grantTempHp(tx: Tx, id: Id, amount: number, label: string, cause: number | null): void {
  const c = tx.state.combatants[id];
  // 临时生命值不叠加：取较高的那个
  const next = Math.max(c.live.tempHp, amount);
  const seq = tx.emit('tempHpGained', { target: id, amount, label, kept: next }, cause);
  tx.emit('hpChanged', { id, hp: c.live.hp, tempHp: next }, seq);
}

export const isUnknown = (v: unknown): v is Unknown => v instanceof Unknown;

/**
 * 这次掷骰要不要全部取最大值（rollMods 里的 maxDice：极效治疗、超限导能）。
 * kind = damage / heal；on.spell = 只管法术的；when 里能用 slot、target。
 */
export function maxDiceFor(tx: Tx, roller: Id, kind: 'damage' | 'heal', scope: { target?: Id; slot?: number; spell?: boolean; attack?: AttackInfo }): boolean {
  /** 某个人的身上有没有「把这次骰子取最大」的修正 */
  const maxedBy = (who: Id): boolean => {
    if (!tx.state.combatants[who]) return false;
    const cands = rollModsOf(tx, who)
      .filter((d) => d.item.who === 'bearer' && d.item.op === 'maxDice' && [d.item.on.kind].flat().includes(kind)
        && (d.item.on.spell === undefined || d.item.on.spell === !!scope.spell)
        && (!d.item.on.attack || filterMatches({ ...d.item.on, kind: 'attack' }, { kind: 'attack', attack: scope.attack })))
      .map((d) => ({
        d,
        scope: { self: who, source: d.source, target: scope.target, slot: scope.slot, attack: scope.attack, effect: d.effect },
      }));
    if (!cands.length) return false;
    return evaluateMods(tx, cands, who, kind === 'heal' ? '治疗骰' : '伤害骰').active.length > 0;
  };
  // 治疗骰还要看**被治疗的人**：2024 里「你受到治疗时恢复最大值」是承受者身上的能力（永生者赠礼这类）
  if (maxedBy(roller)) return true;
  if (kind === 'heal' && scope.target && scope.target !== roller && tx.state.combatants[scope.target]) return maxedBy(scope.target);
  return false;
}
