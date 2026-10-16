import { run, runBool, runInt, Unknown } from '../expr';
import { kill, normType } from './damage';
import { runNodes } from './exec';
import { zonesOfConcentration } from './space';
import { makeEnv } from './scope';
import type { Tx } from './tx';
import type { ActiveEffect, CombatantView, Duration, EffectId, EffectTemplate, GameEvent, Id } from './types';

/**
 * ActiveEffect 的生命周期（COMBAT-DESIGN §3.3 / §3.4）：施加、叠加与压制、隐含状态、专注链接、结束。
 * 持续时间的推进（回合开始/结束）在 turns.ts。
 */

export const CONC_KEY = 'concentration';

export interface ActiveTpl {
  effect: ActiveEffect;
  tpl: EffectTemplate;
  key: string;
  implied: boolean;
}

export const tplName = (key: string, tpl: EffectTemplate): string => tpl.name ?? key.split('#')[1] ?? key;

export function templateOf(tx: Tx, e: ActiveEffect): EffectTemplate | null {
  return e.inline ?? tx.rules.template(e.key);
}

export function effectsOf(tx: Tx, bearer: Id): ActiveEffect[] {
  return Object.values(tx.state.effects).filter((e) => e.bearer === bearer).sort((a, b) => a.appliedSeq - b.appliedSeq);
}

/**
 * 承受者身上**正在生效**的模板：未被压制的效应 + 它们隐含的状态（递归、去重）。
 * 麻痹和震慑都隐含失能 —— 失能只算一次。
 */
export function activeTemplates(tx: Tx, bearer: Id): ActiveTpl[] {
  const out: ActiveTpl[] = [];
  const seen = new Set<string>();
  const visit = (effect: ActiveEffect, key: string, tpl: EffectTemplate, implied: boolean, depth: number) => {
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ effect, tpl, key, implied });
    if (depth > 4) return;
    for (const ik of tpl.implies ?? []) {
      const r = tx.rules.resolveTemplate(ik, key);
      if (r) visit(effect, r.key, r.tpl, true, depth + 1);
    }
  };
  for (const e of effectsOf(tx, bearer)) {
    if (e.suppressed) continue;
    const tpl = templateOf(tx, e);
    if (tpl) visit(e, e.key, tpl, false, 0);
  }
  return out;
}

export function hasCondition(tx: Tx, bearer: Id, name: string): boolean {
  return activeTemplates(tx, bearer).some((a) => (a.tpl.tags ?? []).includes('condition') && tplName(a.key, a.tpl) === name);
}

/** 按名字或键找效应（含被压制的） */
export function findEffect(tx: Tx, bearer: Id, nameOrKey: string): ActiveEffect | undefined {
  return effectsOf(tx, bearer).find(
    (e) =>
      e.name === nameOrKey ||
      e.key === nameOrKey ||
      e.key.split('#')[0] === nameOrKey ||
      e.key.split('#')[1] === nameOrKey,
  );
}

export function exhaustionOf(tx: Tx, bearer: Id): number {
  const e = effectsOf(tx, bearer).find((x) => x.name === '力竭');
  return e ? Number(e.state.level ?? 1) : 0;
}

export const roundsOf = (d?: { rounds?: number; minutes?: number; hours?: number }): number =>
  d ? (d.rounds ?? 0) + (d.minutes ?? 0) * 10 + (d.hours ?? 0) * 600 : 0;

/* ------------------------------ 技能与荒野形态合并 ------------------------------ */

export const SKILL_DEFS: ReadonlyArray<readonly [en: string, cn: string, ability: 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha']> = [
  ['athletics', '运动', 'str'],
  ['acrobatics', '体操', 'dex'],
  ['sleight-of-hand', '巧手', 'dex'],
  ['stealth', '隐匿', 'dex'],
  ['arcana', '奥秘', 'int'],
  ['history', '历史', 'int'],
  ['investigation', '调查', 'int'],
  ['nature', '自然', 'int'],
  ['religion', '宗教', 'int'],
  ['animal-handling', '驯兽', 'wis'],
  ['insight', '洞悉', 'wis'],
  ['medicine', '医药', 'wis'],
  ['perception', '察觉', 'wis'],
  ['survival', '生存', 'wis'],
  ['deception', '欺瞒', 'cha'],
  ['intimidation', '威吓', 'cha'],
  ['performance', '表演', 'cha'],
  ['persuasion', '游说', 'cha'],
];

const SKILL_ALIAS: Record<string, readonly [string, string, 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha']> = (() => {
  const m: Record<string, readonly [string, string, 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha']> = {};
  for (const d of SKILL_DEFS) {
    m[d[0]] = d;
    m[d[1]] = d;
  }
  m['特技'] = ['acrobatics', '体操', 'dex'];
  return m;
})();

/** 取技能加值（兼容中英文技能名，缺省回退到对应属性调整值） */
export function skillBonus(v: CombatantView, skill: string, fallbackAbility?: 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha'): number {
  if (v.skill[skill] !== undefined) return v.skill[skill];
  const def = SKILL_ALIAS[skill];
  if (def) {
    if (v.skill[def[0]] !== undefined) return v.skill[def[0]];
    if (v.skill[def[1]] !== undefined) return v.skill[def[1]];
    return v.mod[fallbackAbility ?? def[2]];
  }
  return fallbackAbility ? v.mod[fallbackAbility] : 0;
}

/**
 * 2024 荒野形态属性合并（XPHB p.81）：
 * - 保留德鲁伊的 HP、生命骰、智力/感知/魅力、熟练加值、职业特性与语言
 * - 替换为野兽的体型、速度、力量/敏捷/体质、AC、天生攻击、抗性/免疫/易伤
 * - 豁免与技能：保留德鲁伊原有熟练（用德鲁伊 PB + 合并后属性调整值），同时获得野兽的熟练；若野兽面板加值更高则取野兽加值
 * - 月亮结社（结社形态）：AC = max(野兽 AC, 13 + 感知调整值)
 */
export function mergeWildShape(base: CombatantView, form: CombatantView): CombatantView {
  const score = {
    str: form.score.str,
    dex: form.score.dex,
    con: form.score.con,
    int: base.score.int,
    wis: base.score.wis,
    cha: base.score.cha,
  };
  const mod = {
    str: form.mod.str,
    dex: form.mod.dex,
    con: form.mod.con,
    int: base.mod.int,
    wis: base.mod.wis,
    cha: base.mod.cha,
  };
  const pb = Math.max(base.pb, form.pb);
  const save = { ...base.save };
  for (const a of ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const) {
    const druidExtra = base.save[a] - base.mod[a];
    const formExtra = form.save[a] - form.mod[a];
    const bestExtra = Math.max(druidExtra, formExtra > 0 ? Math.max(formExtra, base.pb) : 0);
    save[a] = Math.max(mod[a] + bestExtra, form.save[a]);
  }
  const skill: Record<string, number> = { ...base.skill, ...form.skill };
  for (const [en, cn, ab] of SKILL_DEFS) {
    const baseRaw = base.skill[en] ?? base.skill[cn];
    const druidExtra = baseRaw !== undefined ? baseRaw - base.mod[ab] : 0;
    const formRaw = form.skill[cn] ?? form.skill[en];
    const formExtra = formRaw !== undefined ? formRaw - form.mod[ab] : 0;
    const bestExtra = Math.max(druidExtra, formRaw !== undefined ? Math.max(formExtra, base.pb) : 0);
    const merged = Math.max(mod[ab] + bestExtra, formRaw ?? -Infinity);
    skill[en] = merged;
    skill[cn] = merged;
  }
  const hasMoonCircle = base.sources.some((s) => s === '结社形态' || s.includes(':结社形态:') || s.endsWith('#结社形态'));
  const ac = hasMoonCircle ? Math.max(form.ac, 13 + mod.wis) : form.ac;
  const entries = (base.entries || form.entries) ? { ...(base.entries ?? {}), ...(form.entries ?? {}) } : undefined;
  const notes = [...(form.notes ?? []), ...(base.notes ?? [])];

  return {
    ...base,
    size: form.size,
    type: form.type || base.type,
    ac,
    speed: form.speed,
    pb,
    score,
    mod,
    save,
    skill,
    resist: [...new Set([...form.resist])],
    immune: [...new Set([...form.immune])],
    vuln: [...new Set([...form.vuln])],
    conditionImmune: [...new Set([...form.conditionImmune])],
    attacks: [...form.attacks],
    attacksPerAction: form.attacksPerAction,
    sources: [...new Set([...form.sources, ...base.sources])],
    ...(entries ? { entries } : {}),
    ...(notes.length ? { notes } : {}),
  };
}

/* ------------------------------ 有效数值 ------------------------------ */

const viewCache = new WeakMap<Tx, Map<Id, { seq: number; view: CombatantView }>>();
const computing = new Set<string>();

/**
 * 基础 view + 荒野形态变形覆盖 + 生效效应的 statics。
 * ⚠️ statics 里的表达式可能引用 `self.ac` 这种依赖 view 的东西 —— 计算期间再取 view 时返回基础（或变形后基础）view，避免无限递归。
 */
export function effectiveView(tx: Tx, id: Id): CombatantView {
  const c = tx.state.combatants[id];
  if (!c) throw new Error(`没有参与者 ${id}`);
  const formEffect = effectsOf(tx, id).find((e) => !e.suppressed && e.form);
  const startView = formEffect?.form ? mergeWildShape(c.base, formEffect.form) : c.base;
  if (computing.has(id)) return startView;
  let cache = viewCache.get(tx);
  if (!cache) viewCache.set(tx, (cache = new Map()));
  const hit = cache.get(id);
  if (hit && hit.seq === tx.state.seq) return hit.view;

  computing.add(id);
  try {
    const v: CombatantView = {
      ...startView,
      resist: [...startView.resist],
      immune: [...startView.immune],
      vuln: [...startView.vuln],
      conditionImmune: [...startView.conditionImmune],
    };
    let acBonus = 0;
    let dcBonus = 0;
    let speedBonus = 0;
    let speedSet: number | null = null;
    let resistAll = false;
    for (const at of activeTemplates(tx, id)) {
      const num = (e: string | number | boolean) => {
        const r = runInt(e, makeEnv(tx, { self: id, source: at.effect.source, effect: at.effect }));
        return r instanceof Unknown ? 0 : r;
      };
      // 抗性 / 免疫 / 易伤的类型可以写表达式（`effect.state.type`：施加时选的伤害类型），其余是字面类型名
      const types = (vs: string[]) => vs.map((x) => {
        if (!/^[a-z]+\./.test(x)) return x;
        const r = run(x, makeEnv(tx, { self: id, source: at.effect.source, effect: at.effect }));
        return r instanceof Unknown || r == null ? '' : normType(String(r));
      }).filter(Boolean);
      for (const m of at.tpl.statics ?? []) {
        switch (m.kind) {
          case 'ac': acBonus += num(m.bonus); break;
          case 'spellDc': dcBonus += num(m.bonus); break;
          case 'speed': speedBonus += num(m.bonus); break;
          case 'speedSet': speedSet = speedSet === null ? m.value : Math.min(speedSet, m.value); break;
          case 'resist': v.resist.push(...types(m.values)); break;
          case 'resistAll': resistAll = true; break;
          case 'immune': v.immune.push(...types(m.values)); break;
          case 'vuln': v.vuln.push(...types(m.values)); break;
          case 'conditionImmune': v.conditionImmune.push(...m.values); break;
        }
      }
    }
    v.ac += acBonus;
    if (v.spell && dcBonus) v.spell = { ...v.spell, dc: v.spell.dc + dcBonus };
    // 「速度变为 0，且无法被增加」：设定值优先于一切加值
    v.speed = speedSet !== null ? speedSet : Math.max(0, v.speed + speedBonus);
    if (resistAll) v.resist.push('*');
    v.resist = [...new Set(v.resist)];
    v.immune = [...new Set(v.immune)];
    v.vuln = [...new Set(v.vuln)];
    v.conditionImmune = [...new Set(v.conditionImmune)];
    cache.set(id, { seq: tx.state.seq, view: v });
    return v;
  } finally {
    computing.delete(id);
  }
}

/* ------------------------------ 施加 / 结束 ------------------------------ */

export interface ApplyOpts {
  bearer: Id;
  source: Id | null;
  /** 模板引用（见 RuleBook.resolveTemplate）；与 inline 二选一 */
  ref?: string;
  inline?: EffectTemplate;
  /** inline 效应的键（缺省 `inline:<名>`） */
  key?: string;
  name?: string;
  baseKey: string;
  duration?: Duration;
  link?: EffectId | null;
  potency?: number;
  state?: Record<string, unknown>;
  snap?: Record<string, unknown>;
  /** 荒野形态 / 变形覆盖的野兽数据 */
  form?: CombatantView;
  origin: ActiveEffect['origin'];
  cause: number | null;
}

/** 施加效应。被状态免疫挡住时返回 null（并发一条事件说明原因，不静默） */
export function applyEffect(tx: Tx, o: ApplyOpts): ActiveEffect | null {
  let key: string;
  let tpl: EffectTemplate;
  if (o.inline) {
    tpl = o.inline;
    key = o.key ?? `inline:${o.name ?? tpl.name ?? '效应'}`;
  } else {
    const r = o.ref ? tx.rules.resolveTemplate(o.ref, o.baseKey) : null;
    if (!r) throw new Error(`找不到效应模板「${o.ref}」（相对于 ${o.baseKey}）`);
    key = r.key;
    tpl = r.tpl;
  }
  const baseName = o.name ?? tplName(key, tpl);
  const name = o.form && !o.name ? `${baseName}（${o.form.name}）` : baseName;
  const bearer = tx.state.combatants[o.bearer];
  if (!bearer) throw new Error(`没有参与者 ${o.bearer}`);

  if ((tpl.tags ?? []).includes('condition') && effectiveView(tx, o.bearer).conditionImmune.includes(baseName)) {
    tx.emit('effectBlocked', { bearer: o.bearer, key, name, reason: `${bearer.name} 免疫「${baseName}」状态` }, o.cause);
    return null;
  }

  // 力竭这种按等级累加的：已有就升一级
  if (tpl.stack === 'level') {
    const prev = effectsOf(tx, o.bearer).find((e) => e.key === key);
    if (prev) {
      const level = Number(prev.state.level ?? 1) + 1;
      tx.emit('effectUpdated', { id: prev.id, patch: { state: { ...prev.state, level } } }, o.cause);
      const seq = tx.emit('effectLevel', { bearer: o.bearer, key, name, level }, o.cause);
      if (tpl.deathAtLevel && level >= tpl.deathAtLevel) kill(tx, o.bearer, `${name}达到 ${level} 级`, seq);
      return tx.state.effects[prev.id];
    }
  }

  // 荒野形态 / 变形效应：再次施展时先结束旧形态，而不是压制共存
  if (o.form || (tpl.tags ?? []).includes('wildshape')) {
    for (const prev of effectsOf(tx, o.bearer)) {
      if (prev.form || (prev.tags ?? []).includes('wildshape') || prev.key === key) {
        endEffect(tx, prev.id, '换入新形态', o.cause);
      }
    }
  }

  const round = tx.state.round;
  const effect: ActiveEffect = {
    id: tx.nextId('e'),
    key,
    name,
    inline: o.inline ? structuredClone(o.inline) : undefined,
    bearer: o.bearer,
    source: o.source,
    origin: o.origin,
    appliedSeq: tx.state.seq + 1,
    duration: structuredClone(o.duration ?? tpl.duration ?? { manual: true }),
    timing: { tickOf: round === null ? null : tx.state.order[tx.state.turnIndex] ?? null, ticks: 0, untilCount: 0 },
    link: o.link ? { concentration: o.link } : null,
    snap: o.snap ?? {},
    stackKey: tpl.stackKey ?? key,
    potency: o.potency ?? 0,
    suppressed: false,
    state: { ...(tpl.stack === 'level' ? { level: 1 } : {}), ...(o.state ?? {}) },
    tags: tpl.tags ?? [],
    form: o.form ? structuredClone(o.form) : undefined,
  };
  if (effect.inline === undefined) delete effect.inline;
  if (effect.form === undefined) delete effect.form;
  const seq = tx.emit('effectApplied', { effect, bearer: o.bearer, key, name, source: o.source }, o.cause);
  restack(tx, o.bearer, seq);

  // 失能（含隐含的）会打断专注；狂暴这类「无法专注」的效应也是
  const chain = activeTemplates(tx, o.bearer).filter((a) => a.effect.id === effect.id);
  if (chain.some((a) => a.tpl.flags?.breaksConcentration || a.tpl.flags?.cannot?.includes('concentrate'))) {
    endConcentration(tx, o.bearer, `陷入「${name}」`, seq);
  }
  if (tpl.onApply?.length) {
    runNodes(tx, tpl.onApply, {
      self: o.bearer, source: o.source, targets: [o.bearer], target: o.bearer,
      entryKey: key, actionName: name, cause: seq, locals: {}, effectId: effect.id,
    });
  }
  return tx.state.effects[effect.id] ?? null;
}

export function endEffect(tx: Tx, id: EffectId, reason: string, cause: number | null): void {
  const e = tx.state.effects[id];
  if (!e) return;
  const tpl = templateOf(tx, e);
  const seq = tx.emit('effectEnded', { id, key: e.key, name: e.name, bearer: e.bearer, reason }, cause);
  if (e.key === CONC_KEY) {
    for (const linked of Object.values(tx.state.effects).filter((x) => x.link?.concentration === id)) {
      endEffect(tx, linked.id, `专注结束（${e.name}）`, seq);
    }
    zonesOfConcentration(tx, id, seq);
  }
  // 随该效应（如召唤法术专注）存续的召唤物一并退场
  for (const c of Object.values(tx.state.combatants)) {
    if (c.linkEffect === id) {
      tx.emit('note', { text: `${c.name} 随「${e.name}」结束而消失`, owner: e.bearer }, seq);
      tx.emit('combatantRemoved', { id: c.id }, seq);
    }
  }
  restack(tx, e.bearer, seq);
  if (tpl?.onEnd?.length && tx.state.combatants[e.bearer]) {
    runNodes(tx, tpl.onEnd, {
      self: e.bearer, source: e.source, targets: [e.bearer], target: e.bearer,
      entryKey: e.key, actionName: e.name, cause: seq, locals: {},
    });
  }
}

/**
 * 叠加（2024：同一效应不叠加，取最强的；一样强取最近的）。
 * 其余的标记为被压制 —— **不删除**，持续时间照走，强的那个结束后自动接上。
 */
export function restack(tx: Tx, bearer: Id, cause: number | null): void {
  const groups = new Map<string, ActiveEffect[]>();
  for (const e of effectsOf(tx, bearer)) {
    const g = groups.get(e.stackKey) ?? [];
    g.push(e);
    groups.set(e.stackKey, g);
  }
  for (const list of groups.values()) {
    const winner = list.reduce((w, e) => (e.potency > w.potency || (e.potency === w.potency && e.appliedSeq > w.appliedSeq) ? e : w));
    for (const e of list) {
      const want = e !== winner;
      if (e.suppressed !== want) {
        tx.emit('effectUpdated', { id: e.id, patch: { suppressed: want } }, cause);
        tx.emit(want ? 'effectSuppressed' : 'effectResumed', { id: e.id, name: e.name, bearer }, cause);
      }
    }
  }
}

/* ------------------------------ 专注 ------------------------------ */

export function concentrationOf(tx: Tx, id: Id): ActiveEffect | undefined {
  return effectsOf(tx, id).find((e) => e.key === CONC_KEY);
}

export function endConcentration(tx: Tx, id: Id, reason: string, cause: number | null): void {
  const c = concentrationOf(tx, id);
  if (c) endEffect(tx, c.id, reason, cause);
}

export function startConcentration(tx: Tx, caster: Id, name: string, duration: Duration, origin: string, cause: number | null): ActiveEffect {
  endConcentration(tx, caster, `开始专注「${name}」`, cause);
  const e = applyEffect(tx, {
    bearer: caster, source: caster, inline: { name, tags: ['concentration'] }, key: CONC_KEY, name,
    baseKey: origin, duration, origin: { kind: 'spell', ref: origin }, cause,
  });
  if (!e) throw new Error('专注效应施加失败');
  return e;
}

/* ------------------------------ endsOn ------------------------------ */

/** 事件发出后：检查有没有效应因为这件事结束（隐形术：攻击或施法时结束；削弱：下一次攻击检定后结束） */
export function checkEndsOn(tx: Tx, ev: GameEvent): void {
  if (ev.type === 'effectUpdated' || ev.type === 'effectEnded' || ev.type === 'effectSuppressed' || ev.type === 'effectResumed') return;
  for (const e of Object.values(tx.state.effects)) {
    const conds = e.duration.endsOn;
    if (!conds?.length || !tx.state.effects[e.id]) continue;
    for (const c of conds) {
      if (c.event !== ev.type) continue;
      let hit = true;
      if (c.when !== undefined) {
        try {
          const env = makeEnv(tx, { self: e.bearer, source: e.source, event: ev.payload, effect: e });
          const r = runBool(c.when, env);
          hit = r === true;
        } catch (err) {
          tx.emit('ruleError', { where: `效应「${e.name}」的结束条件`, message: (err as Error).message }, ev.seq);
          hit = false;
        }
      }
      if (hit) {
        endEffect(tx, e.id, `结束条件：${c.event}`, ev.seq);
        break;
      }
    }
  }
}

