import { Dice, Unknown, runInt, type Value } from '../expr';
import { rollModsOf } from './collect';
import { controllerOf, d20Test, evaluateMods, filterMatches } from './d20';
import { applyEffect, concentrationOf, effectiveView, effectsOf, endConcentration, endEffect } from './effects';
import { makeEnv, nameOf } from './scope';
import { fireWindow } from './triggers';
import type { Tx } from './tx';
import type { AttackInfo, Id } from './types';

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
  cancel?: boolean;
  reduce: Array<{ value: number; types?: string[] }>;
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
  斩击: '挥砍', B: '钝击', P: '穿刺', S: '挥砍', A: '强酸', C: '寒冷', F: '火焰', O: '力场', N: '暗蚀', R: '光耀',
  Y: '心灵', T: '毒素', L: '闪电', I: '雷鸣', E: '力场',
  bludgeoning: '钝击', piercing: '穿刺', slashing: '挥砍', acid: '强酸', cold: '寒冷', fire: '火焰', force: '力场',
  necrotic: '暗蚀', radiant: '光耀', psychic: '心灵', poison: '毒素', lightning: '闪电', thunder: '雷鸣',
};
export const normType = (t: string): string => TYPE_ALIAS[t] ?? t;

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

/**
 * 掷一个组件。重击按核心参数：
 *   doubleDice（RAW）—— 伤害骰掷两次；maxPlusRoll（常见房规）—— 一份取最大值 + 一份正常掷。
 * minDie：巨武器战斗把 1、2 当 3。
 */
export function rollComponent(tx: Tx, c: DamageComponent, crit: boolean, user: string, minDie: number): { faces: number[][]; total: number } {
  const mode = crit ? tx.rules.coreParam<string>('critDamage') : 'none';
  const dice = mode === 'doubleDice' ? c.dice.doubled() : c.dice;
  if (dice.isConstant) return { faces: [], total: dice.flat };
  const faces = tx.roll(dice.terms.map((t) => ({ faces: t.faces, count: t.count })), user, `${c.from}（${c.type}）`);
  const adj = faces.map((fs) => fs.map((f) => Math.max(f, minDie)));
  let total = dice.flat;
  dice.terms.forEach((t, i) => { total += t.sign * sum(adj[i]); });
  if (mode === 'maxPlusRoll') for (const t of dice.terms) total += t.sign * t.count * t.faces;
  return { faces: adj, total };
}

export function applyDamagePacket(tx: Tx, p: DamagePacket, cause: number | null): DamageResult {
  const target = tx.state.combatants[p.target];
  const tv = effectiveView(tx, p.target);
  const user = p.source ? controllerOf(tx, p.source) : 'dm';

  // ① 攻击者的伤害修正（狂暴伤害、巨武器战斗…）
  let minDie = 0;
  if (p.source && tx.state.combatants[p.source]) {
    const primary = p.components[0]?.type ?? '';
    const req = { kind: 'attack' as const, attack: p.attack };
    const cands = rollModsOf(tx, p.source)
      .filter((d) => d.item.who === 'bearer' && d.item.on.kind !== undefined && [d.item.on.kind].flat().includes('damage')
        && filterMatches({ ...d.item.on, kind: 'attack' }, req))
      .map((d) => ({
        d,
        scope: {
          self: p.source!, source: d.source, target: p.target, attacker: p.source!, attack: p.attack, effect: d.effect,
          damage: { type: primary, amount: 0, crit: p.crit } as Record<string, Value>,
        },
      }));
    if (p.attack && cands.length) {
      const { active } = evaluateMods(tx, cands, p.source, `${p.label} 伤害`);
      for (const { d, value } of active) {
        if (d.item.op === 'minDie' && typeof value === 'number') minDie = Math.max(minDie, value);
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
  for (const c of p.components) {
    const r = c.rolled ?? { ...rollComponent(tx, c, p.crit, user, minDie), crit: p.crit };
    c.rolled = r;
    const type = normType(c.type);
    rolledParts.push({ from: c.from, type, dice: (r.crit ? c.dice.doubled() : c.dice).toString(), faces: r.faces.flat(), total: r.total });
    byType[type] = (byType[type] ?? 0) + Math.max(0, r.total);
  }
  if (p.scale !== undefined) for (const k of Object.keys(byType)) byType[k] = Math.floor(byType[k] * p.scale);
  const rolledTotal = sum(Object.values(byType));
  const index = tx.damageIdx++;
  const rolledSeq = tx.emit('damageRolled', {
    index, source: p.source, target: p.target, label: p.label, crit: p.crit, parts: rolledParts, byType: { ...byType }, scale: p.scale ?? 1,
  }, cause);

  // ③ 承受方减伤窗口
  fireWindow(tx, {
    event: 'damageIncoming', window: 'before', actor: p.source ?? undefined, target: p.target,
    scope: {
      attack: p.attack,
      damage: { type: p.components[0]?.type ?? '', amount: rolledTotal, crit: p.crit },
      event: { label: p.label, source: p.source },
    },
    cause: rolledSeq,
    packet: p,
    modify: (m, by) => {
      if (m.op === 'halveDamage') p.halve = true;
      else if (m.op === 'cancel') p.cancel = true;
      else if (m.op === 'reduceDamage') {
        const v = runInt(m.value, makeEnv(tx, { self: by.owner, source: by.source, effect: by.effect }));
        if (typeof v === 'number') p.reduce.push({ value: v, types: m.types });
      }
    },
  });

  // ④ 调整：加减值 → 抗性 → 易伤；免疫
  const notes: string[] = [];
  const final: Record<string, number> = {};
  for (const [type, raw] of Object.entries(byType)) {
    let v = raw;
    if (p.cancel) { v = 0; notes.push('伤害被抵消'); }
    if (p.halve) v = Math.floor(v / 2);
    for (const r of p.reduce) if (!r.types || r.types.includes(type)) v = Math.max(0, v - r.value);
    if (tv.immune.includes(type)) { v = 0; notes.push(`免疫${type}`); }
    else {
      if (tv.resist.includes(type) || tv.resist.includes('*')) { v = Math.floor(v / 2); notes.push(`抗性：${type}减半`); }
      if (tv.vuln.includes(type)) { v *= 2; notes.push(`易伤：${type}加倍`); }
    }
    final[type] = v;
  }
  if (p.halve) notes.unshift('伤害减半');
  const ov = tx.overrideDamage(index);
  if (ov) {
    for (const k of Object.keys(final)) final[k] = ov.amounts[k] ?? final[k];
    for (const [k, v] of Object.entries(ov.amounts)) final[k] = v;
    notes.push(`[DM 裁定] ${ov.reason ?? '伤害改写'}`);
  }
  const total = sum(Object.values(final));

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
      scope: { attack: p.attack, damage: { type: p.components[0]?.type ?? '', amount: total, crit: p.crit } },
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
        if (tx.state.settings.monsterAt0 === 'dead') { kill(tx, p.target, `${nameOf(tx, p.target)} 被击倒`, seq); killed = true; }
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

  // ⑧ 受到伤害之后
  if (total > 0) {
    fireWindow(tx, {
      event: 'damageTaken', window: 'after', actor: p.source ?? undefined, target: p.target,
      scope: { attack: p.attack, damage: { type: p.components[0]?.type ?? '', amount: total, crit: p.crit } },
      cause: seq,
    });
  }
  return { byType: final, total, hpBefore, hpAfter, tempAbsorbed, downed, killed, seq };
}

/** 降至 0：PC 陷入昏迷（随之倒地），死亡豁免归零 */
export function knockOut(tx: Tx, id: Id, cause: number | null): void {
  tx.emit('deathSavesChanged', { id, s: 0, f: 0 }, cause);
  tx.emit('stableChanged', { id, stable: false }, cause);
  applyEffect(tx, {
    bearer: id, source: null, ref: 'XPHB:condition:昏迷', baseKey: 'XPHB:condition:昏迷',
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
