import { Dice, Unknown, runBool, runDice, runInt, type Ability, type Question, type Value } from '../expr';
import { auraGate, rollModsOf, type Declared } from './collect';
import { makeEnv, nameOf, type ScopeData } from './scope';
import { fireWindow } from './triggers';
import type { Tx } from './tx';
import type { AttackInfo, Id, RollFilter, RollKind, RollMod, RollOp } from './types';

/**
 * D20 检定管线（COMBAT-DESIGN §六）：
 *   ① 请求 → ② 收集修正（三值求值，问不出来的一次问完）→ ③ 合成（优劣势抵消）
 *   → ④ 掷骰 → ⑤ 重骰窗口 → ⑥ 判定 → 发 d20Rolled → after 窗口
 * 命中窗口（⑦）和结算（⑧）在调用方（exec.ts 的 attack 节点）。
 */

export type RollSub = 'initiative' | 'deathSave' | 'concentration';

export interface RollRequest {
  roller: Id;
  kind: RollKind;
  sub?: RollSub;
  ability?: Ability;
  skill?: string;
  attack?: AttackInfo;
  /** 攻击目标（对方身上 who=against 的修正会被收进来） */
  target?: Id;
  /** 基础加值（来自 view：攻击加值 / 豁免总值 / 技能总值） */
  bonus: number;
  /** AC / DC；没有就不判定成败 */
  vs?: number;
  critRange?: number;
  label: string;
  cause: number | null;
}

export interface AppliedMod {
  op: RollOp;
  label: string;
  value?: string;
  owner: Id;
  from: string;
  /** 被房规改过的条目：「本团房规」之类（回执上标出来） */
  rule?: string;
}

export interface RollResult {
  index: number;
  roller: Id;
  target: Id | null;
  kind: RollKind;
  sub?: RollSub;
  ability?: Ability;
  skill?: string;
  label: string;
  /** 掷出的 d20（一颗或两颗） */
  d20: number[];
  /** 采用的那颗（取高/取低之后、minD20 之前）—— 判定重击看它 */
  natural: number;
  /** minD20（可靠才能）之后的值 */
  kept: number;
  extra: Array<{ label: string; dice: string; faces: number[]; total: number }>;
  bonus: number;
  flat: number;
  total: number;
  vs: number | null;
  adv: boolean;
  disadv: boolean;
  cancelled: boolean;
  autoFail: boolean;
  autoSucceed: boolean;
  critRange: number;
  outcome: 'hit' | 'miss' | 'success' | 'fail' | null;
  crit: boolean;
  /** 命中后会升级为重击的来源（麻痹 / 昏迷 5 尺内） */
  autoCritOnHit: string[];
  mods: AppliedMod[];
  assumptions: string[];
  overridden?: string;
  seq: number;
}

const arr = <T>(x: T | T[] | undefined): T[] => (x === undefined ? [] : Array.isArray(x) ? x : [x]);

export function filterMatches(f: RollFilter, req: Pick<RollRequest, 'kind' | 'sub' | 'ability' | 'skill' | 'attack'>): boolean {
  const kinds = arr(f.kind);
  const kindOk = kinds.some((k) => (k === 'd20' ? true : k === req.kind || (req.sub !== undefined && k === req.sub)));
  if (!kindOk) return false;
  if (f.ability !== undefined && !(req.ability && arr(f.ability).includes(req.ability))) return false;
  if (f.skill !== undefined && !(req.skill && arr(f.skill).includes(req.skill))) return false;
  if (f.attack) {
    const a = req.attack;
    if (!a) return false;
    for (const [k, v] of Object.entries(f.attack)) if (v !== undefined && (a as unknown as Record<string, boolean>)[k] !== v) return false;
  }
  return true;
}

export const controllerOf = (tx: Tx, id: Id): string => tx.state.combatants[id]?.controller ?? 'dm';

interface Evaluated {
  d: Declared<RollMod>;
  on: boolean | Unknown;
  value?: Dice | number;
}

/**
 * 收集 + 求值。问不出来的问题一次性问完（一个 ask 决定），回答后重新求值。
 * 返回生效的修正，以及按推测走的假设。
 */
export function evaluateMods(
  tx: Tx,
  cands: Array<{ d: Declared<RollMod>; scope: ScopeData }>,
  askTo: Id,
  label: string,
): { active: Evaluated[]; assumptions: string[] } {
  for (let pass = 0; pass < 4; pass++) {
    const assumptions: string[] = [];
    const evaluated: Evaluated[] = [];
    const questions = new Map<string, Question>();
    for (const { d, scope } of cands) {
      const env = makeEnv(tx, scope, assumptions);
      let on: boolean | Unknown = true;
      try {
        if (d.auraGate) on = auraGate(tx, d.auraGate, d.owner);
        if (on !== false && d.item.when !== undefined) {
          const w = runBool(d.item.when, env);
          on = on === true ? w : w === false ? false : Unknown.merge(on, w);
        }
      } catch (e) {
        tx.emit('ruleError', { where: `「${d.item.label}」（${d.from}）的条件`, message: (e as Error).message }, null);
        on = false;
      }
      if (on instanceof Unknown) for (const q of on.questions) questions.set(q.id, q);
      let value: Dice | number | undefined;
      if (on !== false && d.item.value !== undefined) {
        try {
          const v = d.item.op === 'add' || d.item.op === 'addDice' ? runDice(d.item.value, env) : runInt(d.item.value, env);
          value = v instanceof Unknown ? undefined : v;
        } catch (e) {
          tx.emit('ruleError', { where: `「${d.item.label}」（${d.from}）的数值`, message: (e as Error).message }, null);
          on = false;
        }
      }
      evaluated.push({ d, on, value });
    }
    if (!questions.size) {
      // 灵光同组只取最高（两个圣武士的守护灵光不叠加）
      const best = new Map<string, Evaluated>();
      const active: Evaluated[] = [];
      for (const ev of evaluated) {
        if (ev.on !== true) continue;
        const g = ev.d.stackGroup;
        if (!g) { active.push(ev); continue; }
        const prev = best.get(g);
        const num = (x?: Dice | number) => (x instanceof Dice ? x.average : x ?? 0);
        if (!prev || num(ev.value) > num(prev.value)) best.set(g, ev);
      }
      return { active: [...active, ...best.values()], assumptions: [...new Set(assumptions)] };
    }
    const qs = [...questions.values()];
    const ans = tx.decide({
      kind: 'ask',
      to: controllerOf(tx, askTo),
      prompt: `${label}：需要确认 ${qs.length} 件事`,
      options: [],
      questions: qs.map((q) => ({ id: q.id, text: q.text, guess: q.guess, scope: q.scope })),
      default: Object.fromEntries(qs.map((q) => [q.id, q.guess ?? false])),
    }) as Record<string, boolean>;
    for (const q of qs) tx.qAnswers.set(q.id, { value: !!ans[q.id], scope: q.scope });
  }
  throw new Error(`${label}：问了 4 轮仍有未回答的问题`);
}

/** 掷一次 D20 检定（不含命中窗口） */
export function d20Test(tx: Tx, req: RollRequest): RollResult {
  const index = tx.rollIdx++;
  const rollScope: Record<string, Value> = {
    kind: req.kind, sub: req.sub ?? null, ability: req.ability ?? null, skill: req.skill ?? null, roller: req.roller, target: req.target ?? null,
  };

  // ② 收集
  const cands: Array<{ d: Declared<RollMod>; scope: ScopeData }> = [];
  for (const d of rollModsOf(tx, req.roller)) {
    if (d.item.who !== 'bearer' || !filterMatches(d.item.on, req)) continue;
    cands.push({
      d,
      scope: {
        self: req.roller, source: d.source, target: req.target, attacker: req.attack ? req.roller : undefined,
        attack: req.attack, roll: rollScope, effect: d.effect,
      },
    });
  }
  if (req.attack && req.target) {
    for (const d of rollModsOf(tx, req.target)) {
      if (d.item.who !== 'against' || !filterMatches(d.item.on, req)) continue;
      cands.push({
        d,
        scope: { self: req.target, source: d.source, target: req.target, attacker: req.roller, attack: req.attack, roll: rollScope, effect: d.effect },
      });
    }
  }
  const { active, assumptions } = evaluateMods(tx, cands, req.roller, req.label);

  // ③ 合成
  const mods: AppliedMod[] = [];
  let adv = false, disadv = false, autoFail = false, autoSucceed = false;
  let flat = 0;
  let minD20 = 0;
  let targetAdd = 0;
  let critRange = Math.min(20, req.critRange ?? 20);
  const extraDice: Array<{ label: string; dice: Dice }> = [];
  const autoCritOnHit: string[] = [];
  for (const { d, value } of active) {
    const m = d.item;
    const show = value instanceof Dice ? value.toString() : value !== undefined ? String(value) : undefined;
    const ov = tx.rules.overriddenBy(d.from);
    mods.push({ op: m.op, label: m.label, value: show, owner: d.owner, from: d.from, ...(ov ? { rule: tx.rules.scopeLabel(ov) } : {}) });
    switch (m.op) {
      case 'adv': adv = true; break;
      case 'disadv': disadv = true; break;
      case 'autoFail': autoFail = true; break;
      case 'autoSucceed': autoSucceed = true; break;
      case 'add':
      case 'addDice':
        if (value instanceof Dice) {
          flat += value.flat;
          if (!value.isConstant) extraDice.push({ label: m.label, dice: new Dice(value.terms, 0) });
        } else if (typeof value === 'number') flat += value;
        break;
      case 'critRange': if (typeof value === 'number') critRange = Math.min(critRange, value); break;
      case 'minD20': if (typeof value === 'number') minD20 = Math.max(minD20, value); break;
      case 'targetAdd': if (typeof value === 'number') targetAdd += value; break;
      case 'autoCritOnHit': autoCritOnHit.push(m.label); break;
      case 'minDie': break; // 伤害用
    }
  }
  const cancelled = adv && disadv;
  if (cancelled) { adv = false; disadv = false; }
  if (autoFail && autoSucceed) autoSucceed = false;   // 冲突时自动失败优先（回执上两条都会列出来）

  // ④ 掷骰
  const n = adv || disadv ? 2 : 1;
  const user = controllerOf(tx, req.roller);
  const reqs = [{ faces: 20, count: n }, ...extraDice.flatMap((x) => x.dice.terms.map((t) => ({ faces: t.faces, count: t.count })))];
  const faces = tx.roll(reqs, user, `${nameOf(tx, req.roller)} 的${req.label}`, 'd20');
  const d20 = faces[0];
  let natural = n === 1 ? d20[0] : adv ? Math.max(...d20) : Math.min(...d20);
  const extra: RollResult['extra'] = [];
  let fi = 1;
  for (const x of extraDice) {
    let total = 0;
    const all: number[] = [];
    for (const t of x.dice.terms) {
      const fs = faces[fi++];
      all.push(...fs);
      total += t.sign * fs.reduce((a, b) => a + b, 0);
    }
    extra.push({ label: x.label, dice: x.dice.toString(), faces: all, total });
  }

  const result: RollResult = {
    index, roller: req.roller, target: req.target ?? null, kind: req.kind, sub: req.sub, ability: req.ability, skill: req.skill, label: req.label,
    d20, natural, kept: Math.max(natural, minD20), extra, bonus: req.bonus, flat, total: 0,
    vs: req.vs === undefined ? null : req.vs + targetAdd,
    adv, disadv, cancelled, autoFail, autoSucceed, critRange, outcome: null, crit: false, autoCritOnHit,
    mods, assumptions, seq: 0,
  };
  const recompute = () => {
    result.kept = Math.max(result.natural, minD20);
    result.total = result.kept + result.bonus + result.flat + result.extra.reduce((a, x) => a + x.total, 0);
  };
  recompute();

  // ⑤ 重骰窗口：英雄激励、幸运、诗人激励、削弱之语……可以循环
  fireWindow(tx, {
    event: 'd20Rolled', window: 'before', actor: req.roller, target: req.target,
    scope: { roll: rollValue(result), attack: req.attack, attacker: req.attack ? req.roller : undefined, target: req.target },
    cause: req.cause,
    modify: (m, by) => {
      if (m.op === 'reroll') {
        const [[f]] = tx.roll([{ faces: 20, count: 1 }], controllerOf(tx, by.owner), `${nameOf(tx, req.roller)} 重骰`, 'd20');
        result.natural = m.keep === 'higher' ? Math.max(result.natural, f) : m.keep === 'lower' ? Math.min(result.natural, f) : f;
        result.d20 = [...result.d20, f];
        result.mods.push({ op: 'add', label: `${by.label}：重骰 → ${f}`, owner: by.owner, from: by.from });
        recompute();
      } else if (m.op === 'addToRoll') {
        const v = runDice(m.value, makeEnv(tx, { self: by.owner, source: by.source, effect: by.effect, roll: rollValue(result) }));
        if (v instanceof Unknown) return;
        const fs = v.isConstant ? [] : tx.roll(v.terms.map((t) => ({ faces: t.faces, count: t.count })), controllerOf(tx, by.owner), by.label);
        let total = v.flat;
        v.terms.forEach((t, i) => { total += t.sign * fs[i].reduce((a, b) => a + b, 0); });
        result.extra.push({ label: by.label, dice: v.toString(), faces: fs.flat(), total });
        recompute();
      }
    },
    refresh: () => rollValue(result),
  });

  // ⑥ 判定
  judge(tx, req, result);
  const ov = tx.overrideRoll(index);
  if (ov) {
    if (ov.total !== undefined) { result.total = ov.total; judge(tx, req, result); }
    if (ov.outcome) {
      result.outcome = ov.outcome === 'crit' ? 'hit' : ov.outcome;
      result.crit = ov.outcome === 'crit';
    }
    result.overridden = ov.reason ?? 'DM 裁定';
  }
  result.seq = tx.emit('d20Rolled', { ...result } as unknown as Record<string, unknown>, req.cause);
  fireWindow(tx, {
    event: 'd20Rolled', window: 'after', actor: req.roller, target: req.target,
    scope: { roll: rollValue(result), attack: req.attack, attacker: req.attack ? req.roller : undefined, target: req.target },
    cause: result.seq,
  });
  return result;
}

export function judge(tx: Tx, req: Pick<RollRequest, 'kind'>, r: RollResult): void {
  if (r.vs === null) { r.outcome = null; r.crit = false; return; }
  if (req.kind === 'attack') {
    // 2024：天然 20 必定命中并重击；天然 1 必定未命中。扩大的重击范围同样视为重击（必定命中）
    r.crit = r.natural >= r.critRange;
    const hit = r.crit || (r.natural !== 1 && r.total >= r.vs);
    r.outcome = hit ? 'hit' : 'miss';
    if (!hit) r.crit = false;
    return;
  }
  if (r.autoFail) { r.outcome = 'fail'; return; }
  if (r.autoSucceed) { r.outcome = 'success'; return; }
  const critOn = tx.rules.coreParam<string>('critOn');
  if (critOn === 'allD20' && r.natural === 20) { r.outcome = 'success'; return; }
  r.outcome = r.total >= r.vs ? 'success' : 'fail';
}

export function rollValue(r: RollResult): Record<string, Value> {
  return {
    kind: r.kind, sub: r.sub ?? null, ability: r.ability ?? null, skill: r.skill ?? null, natural: r.natural, total: r.total,
    vs: r.vs, adv: r.adv, disadv: r.disadv, roller: r.roller, target: r.target, crit: r.crit,
    failing: isFailing(r),
  };
}

/**
 * 「按现在的结果会失败」—— before 窗口里判定还没做，诗人激励、战术思维这类「检定失败时」的能力看它。
 * 已经判定过（after 窗口）就直接看结果。
 */
function isFailing(r: RollResult): boolean {
  if (r.outcome) return r.outcome === 'miss' || r.outcome === 'fail';
  if (r.vs === null) return false;
  if (r.autoSucceed) return false;
  if (r.autoFail) return true;
  if (r.kind === 'attack') {
    if (r.natural === 1) return true;
    if (r.natural >= r.critRange) return false;
  }
  return r.total < r.vs;
}
