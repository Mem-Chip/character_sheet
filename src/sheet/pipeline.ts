/**
 * 规则管线（移植自原项目 core/character.js）：十个阶段，每个阶段是一组步骤，步骤往 CalcCtx 里写结果。
 *
 *   abilities → modifiers → proficiency → saves → skills → defense → attacks → spellcasting → features → finalize
 *
 * 插件 / 家规代码可以在任意阶段插步骤（`Pipeline.add` / `insertBefore`）。
 * 卡面文字（acNote / hpNotes …）与原项目逐字一致 —— 对比测试会比这些字符串。
 */
import { ABILS, ABIL_CN, CASTER_CONTRIB, CASTER_FAMILY, DMG_CN, SKILLS, clamp, modOf, parseDiceText, sgn } from './constants';
import { resolveNum, totalLevel } from './abilities';
import type { SheetEnv } from './env';
import type { Json } from './store';

export type Step = ((ctx: CalcCtx, stage: string) => void) & { stepName?: string };

export class Pipeline {
  readonly stages = new Map<string, { label: string; steps: Array<{ fn: Step; name?: string }> }>();
  readonly order: string[] = [];

  define(name: string, label: string): this {
    this.stages.set(name, { label, steps: [] });
    this.order.push(name);
    return this;
  }
  add(stage: string, fn: Step, meta?: { name?: string }): this {
    const st = this.stages.get(stage);
    if (!st) throw new Error('未知阶段: ' + stage);
    st.steps.push({ fn, ...(meta || {}) });
    return this;
  }
  insertBefore(stage: string, beforeName: string, fn: Step): void {
    const steps = this.stages.get(stage)!.steps;
    const i = steps.findIndex((s) => s.name === beforeName);
    steps.splice(i < 0 ? 0 : i, 0, { fn, name: 'plugin:' + (fn.name || 'anon') });
  }
  removeByNamePrefix(prefix: string): number {
    let n = 0;
    for (const st of this.stages.values()) {
      const before = st.steps.length;
      st.steps = st.steps.filter((s) => !String(s.name || '').startsWith(prefix));
      n += before - st.steps.length;
    }
    return n;
  }
  run(ctx: CalcCtx, log: (m: string, l?: number) => void): CalcCtx {
    for (const name of this.order) {
      for (const step of this.stages.get(name)!.steps) {
        try { step.fn(ctx, name); }
        catch (e) { log(`规则步骤失败 [${name}] ${step.name || step.fn.name || ''}: ${(e as Error).message}`, 1); }
      }
    }
    return ctx;
  }
}

/** 计算结果累加器：标量（out）、结构化效果（effects）、审计轨迹（trace）分开存 */
/** 「+1」「-2」→ 数字 */
const num = (v: unknown): number => Number(String(v ?? '').replace(/\s/g, '')) || 0;
/** 生效中的装备：装备着；要同调的同调了 */
function itemsActive(c: Json): Json[] {
  return (c._resolved?.equipment || []).filter((e: Json) => e.equipped && e._ent && (!e._ent.reqAttune || e.attuned));
}

export class CalcCtx {
  readonly out: Record<string, any> = {};
  readonly effects: Json[] = [];
  readonly notes: string[] = [];
  readonly trace: Record<string, Array<{ from?: string; value: unknown; note?: string }>> = {};
  constructor(readonly char: Json, readonly env: SheetEnv) {}

  set(key: string, value: unknown, from?: string, note?: string): unknown {
    this.out[key] = value;
    (this.trace[key] ||= []).push({ from, value, note });
    return value;
  }
  addEffect(eff: Json): Json { this.effects.push(eff); return eff; }
  sumEffects(kind: string, extra?: Record<string, unknown>): number {
    return this.pluck(kind, extra).reduce((a, e) => a + (e.value || 0), 0);
  }
  pluck(kind: string, extra?: Record<string, unknown>): Json[] {
    return this.effects.filter((e) => e.kind === kind && (!extra || Object.entries(extra).every(([k, v]) => e[k] === v)));
  }
}

/** 5etools 的 choose 描述 → 可选集合（声明式选择器） */
export const Chooser = {
  parse(spec: Json, resolver?: (path: string, conds: Array<{ key: string; values: string[] }>) => string[]) {
    const out: Json = { pool: [], count: 1, amount: null, weights: null, raw: spec };
    const c = spec && spec.choose ? spec.choose : spec;
    if (!c) return out;
    if (typeof c === 'string') { out.pool = this.resolveExpression(c, resolver); out.expr = c; return out; }
    if (Array.isArray(c.from)) out.pool = c.from.slice();
    if (c.fromFilter) { out.pool = this.resolveExpression(c.fromFilter, resolver); out.expr = c.fromFilter; }
    if (c.weighted) {
      out.pool = (c.weighted.from || []).slice();
      out.weights = c.weighted.weights || null;
      if (out.weights) out.amount = out.weights.slice().sort((a: number, b: number) => b - a);
    }
    if (c.count != null) out.count = c.count;
    if (c.amount != null) out.amount = c.amount;
    return out;
  },
  resolveExpression(expr: string, resolver?: (path: string, conds: Array<{ key: string; values: string[] }>) => string[]): string[] {
    if (!resolver) return [];
    const [path, query] = String(expr).split('|');
    const conds: Array<{ key: string; values: string[] }> = [];
    for (const g of String(query || '').split('|')) {
      const [k, v] = g.split('=');
      if (k) conds.push({ key: k.trim(), values: String(v || '').split(';').map((s) => s.trim()) });
    }
    return resolver(String(path).trim(), conds);
  },
};

/** 起源区：种族、背景、专长（选的 + 授予的） */
export function buildOrigins(char: Json, res: Json): Json {
  const grantedFeats = [...(char._derived?.feats || [])].map((n: string) => ({ name: n, _granted: true }));
  const pickedFeats = (res.feats || []).map((f: Json) => (typeof f === 'string' ? { name: f } : f));
  const seen = new Set<string>();
  const feats = [...pickedFeats, ...grantedFeats].filter((f: Json) => f && f.name && !seen.has(f.name) && seen.add(f.name));
  return { race: res.race, background: res.background, feats, size: res.race ? (char.size || (res.race.size || ['M'])[0]) : null };
}

const SLOT_TABLE: Array<number[] | null> = [null,
  [2, 0, 0, 0, 0, 0, 0, 0, 0], [3, 0, 0, 0, 0, 0, 0, 0, 0], [4, 2, 0, 0, 0, 0, 0, 0, 0],
  [4, 3, 0, 0, 0, 0, 0, 0, 0], [4, 3, 2, 0, 0, 0, 0, 0, 0], [4, 3, 3, 0, 0, 0, 0, 0, 0],
  [4, 3, 3, 1, 0, 0, 0, 0, 0], [4, 3, 3, 2, 0, 0, 0, 0, 0], [4, 3, 3, 3, 1, 0, 0, 0, 0],
  [4, 3, 3, 3, 2, 0, 0, 0, 0], [4, 3, 3, 3, 2, 1, 0, 0, 0], [4, 3, 3, 3, 2, 1, 0, 0, 0],
  [4, 3, 3, 3, 2, 1, 1, 0, 0], [4, 3, 3, 3, 2, 1, 1, 0, 0], [4, 3, 3, 3, 2, 1, 1, 1, 0],
  [4, 3, 3, 3, 2, 1, 1, 1, 0], [4, 3, 3, 3, 2, 1, 1, 1, 1], [4, 3, 3, 3, 3, 1, 1, 1, 1],
  [4, 3, 3, 3, 3, 2, 1, 1, 1], [4, 3, 3, 3, 3, 2, 2, 1, 1],
];
const PACT_TABLE = [[1, 1], [1, 2], [2, 2], [2, 2], [2, 3], [2, 3], [2, 4], [2, 4], [2, 5], [2, 5], [3, 5], [3, 5], [3, 5], [3, 5], [3, 5], [3, 5], [4, 5], [4, 5], [4, 5], [4, 5]];

/** 建一条标准管线（每个 SheetEnv 一条，插件只影响自己的环境） */
export function createRules(): Pipeline {
  const R = new Pipeline()
    .define('abilities', '属性值')
    .define('modifiers', '属性调整值')
    .define('proficiency', '熟练加值')
    .define('saves', '豁免')
    .define('skills', '技能')
    .define('defense', '防御（AC/HP/先攻/速度）')
    .define('attacks', '攻击')
    .define('spellcasting', '施法')
    .define('features', '特性清单')
    .define('finalize', '汇总');

  /* ---- 属性值（背景 / 专长 / 能力选择 / 效应，属性上限在计算层硬卡） ---- */
  R.add('abilities', (ctx) => {
    const c = ctx.char;
    // 魔法物品的固定加值（装备着；要同调的同调了才算）：AC、豁免、法术攻击 / DC。武器的加值在攻击那里算
    for (const eq of itemsActive(c)) {
      const e = eq._ent, src = e.name;
      const isArmor = !!e.armor || String(e.type).split('|')[0] === 'S';
      const ac = num(e.bonusAc) + (isArmor ? Number(eq.bonus) || 0 : 0);
      if (ac) ctx.addEffect({ kind: 'ac', value: ac, source: src });
      if (num(e.bonusSavingThrow)) ctx.addEffect({ kind: 'saveBonus', value: num(e.bonusSavingThrow), source: src });
      if (num(e.bonusSpellAttack)) ctx.addEffect({ kind: 'spellAtkBonus', value: num(e.bonusSpellAttack), source: src });
      if (num(e.bonusSpellSaveDc)) ctx.addEffect({ kind: 'spellDcBonus', bonus: num(e.bonusSpellSaveDc), source: src });
      // 属性：固定成某值（巨人力量腰带、健康护符）/ 加值（艾恩石）；「自己选一项」的不管
      for (const [k, v] of Object.entries(e.ability || {})) {
        if (k === 'static') for (const [ab, n] of Object.entries(v as Record<string, number>)) ctx.addEffect({ kind: 'abilityStatic', ability: ab, value: num(n), source: src });
        else if ((ABILS as readonly string[]).includes(k) && num(v)) ctx.addEffect({ kind: 'ability', set: { [k]: num(v) }, source: src });
      }
      // 抗性 / 免疫 / 状态免疫（带条件的写法是对象，不算）
      for (const d of e.resist || []) if (typeof d === 'string') ctx.addEffect({ kind: 'resist', damage: d, source: src });
      for (const d of e.immune || []) if (typeof d === 'string') ctx.addEffect({ kind: 'immune', damage: d, source: src });
      for (const d of e.conditionImmune || []) if (typeof d === 'string') ctx.addEffect({ kind: 'conditionImmune', value: d, source: src });
      // 速度：固定值 / 等于步行速度；「翻倍」是要启动的（速度之靴），不算
      for (const [how, v] of Object.entries(e.modifySpeed || {})) {
        for (const [mode, n] of Object.entries(v as Record<string, unknown>)) {
          const m = mode === 'walk' ? 'walk' : mode;
          if (how === 'static') ctx.addEffect(m === 'walk' ? { kind: 'speedMin', value: num(n), source: src } : { kind: 'moveSpeed', mode: m, value: num(n), source: src });
          else if (how === 'equal') ctx.addEffect({ kind: 'moveSpeedEqualWalk', mode: m, source: src });
        }
      }
    }
    const base: Record<string, number> = { ...(c.abilities || {}) };
    const score: Record<string, number> = { ...base };
    const activePendingKeys = new Set((c._derived?.pending || []).map((p: Json) => p.key));
    const activeGrantedFeats: Set<string> = c._derived?.feats || new Set();
    for (const [key, val] of Object.entries(c.decisions || {})) {
      if (!val || typeof val !== 'object' || Array.isArray(val)) continue;
      if (!ctx.env.abilities.isDecisionKeyActive(c, key)) continue;
      if (c._derived) {
        const isExpandedActive = key.startsWith('expanded:') && activeGrantedFeats.has(key.slice(9, key.indexOf('#')));
        if (!activePendingKeys.has(key) && !isExpandedActive) continue;
      }
      const set: Record<string, number> = {};
      for (const [ab, n] of Object.entries(val as Record<string, unknown>)) {
        if ((ABILS as readonly string[]).includes(ab) && typeof n === 'number' && n) set[ab] = n;
      }
      if (Object.keys(set).length) ctx.addEffect({ kind: 'ability', set, source: '能力选择 ' + key });
    }
    const bg = c._resolved?.background;
    if (bg && c.backgroundBonus) {
      for (const [k, v] of Object.entries(c.backgroundBonus)) score[k] = (score[k] || 0) + resolveNum(v, ctx);
    }
    for (const f of c._resolved?.feats || []) {
      for (const a of f.ability || []) {
        for (const ab of ABILS) if (a[ab] != null) score[ab] = (score[ab] || 0) + resolveNum(a[ab], ctx);
      }
    }
    for (const e of ctx.pluck('ability')) for (const [k, v] of Object.entries(e.set || {})) score[k] = (score[k] || 0) + (v as number);
    for (const v of ctx.env.abilities.abilityCaps(c)) ctx.addEffect({ kind: 'abilityCap', value: v });
    const capFor = () => {
      const caps = ctx.pluck('abilityCap').map((e) => e.value).filter((n) => typeof n === 'number');
      return Math.max(20, ...caps);
    };
    for (const ab of ABILS) score[ab] = Math.min(score[ab] || 0, capFor());
    // 物品把属性定成某值：比原来高才用，不受上限
    for (const e of ctx.pluck('abilityStatic')) if (score[e.ability] !== undefined || (ABILS as readonly string[]).includes(e.ability)) score[e.ability] = Math.max(score[e.ability] || 0, e.value || 0);
    for (const ab of ABILS) {
      ctx.set('score:' + ab, score[ab] || 0, 'computed');
      ctx.set('base:' + ab, base[ab] || 0, 'input');
      ctx.set('abilityCap:' + ab, capFor(), 'computed');
    }
    ctx.set('abilityBonus', ctx.char.backgroundBonus || {}, 'background');
  }, { name: 'core:abilities' });

  R.add('modifiers', (ctx) => {
    for (const ab of ABILS) {
      const base = ctx.out['score:' + ab] || 0;
      const extra = ctx.sumEffects('abilityMod', { ability: ab }) + ctx.sumEffects('abilityMod');
      ctx.set('mod:' + ab, modOf(base) + extra, 'computed');
    }
  }, { name: 'core:modifiers' });

  R.add('proficiency', (ctx) => {
    const lvl = totalLevel(ctx.char);
    const pb = 2 + Math.floor((Math.max(1, lvl) - 1) / 4);
    ctx.set('pb', pb, 'computed');
    ctx.set('level', lvl, 'computed');
  }, { name: 'core:pb' });

  R.add('saves', (ctx) => {
    const eff = ctx.pluck('saveProf');
    const classProf = new Set<string>((ctx.char._resolved?.classes || []).flatMap((k: Json) => k.cls.proficiency || []));
    eff.forEach((e) => {
      if (e.ability === '*') ABILS.forEach((a) => classProf.add(a));
      else classProf.add(e.ability);
    });
    const sb = ctx.pluck('saveBonus');
    const bonusOf = (ab: string) => sb.filter((e) => !e.ability || e.ability === ab).reduce((a, e) => a + resolveNum(e.value, ctx), 0);
    const out: Record<string, { prof: boolean; bonus: number; total: number }> = {};
    for (const ab of ABILS) {
      const bonus = bonusOf(ab);
      out[ab] = { prof: classProf.has(ab), bonus, total: (ctx.out['mod:' + ab] || 0) + (classProf.has(ab) ? ctx.out.pb : 0) + bonus };
    }
    ctx.set('saves', out, 'computed');
  }, { name: 'core:saves' });

  R.add('skills', (ctx) => {
    const c = ctx.char;
    const prof = new Set<string>(c.skillProf || []);
    const exp = new Set<string>(c.skillExp || []);
    const fromAbilities = new Set<string>();
    (ctx.char._resolved?.background?.skillProficiencies || []).forEach((o: Json) => Object.keys(o).forEach((k) => { prof.add(k); fromAbilities.add(k); }));
    for (const e of ctx.pluck('skillProf')) { prof.add(e.skill); fromAbilities.add(e.skill); }
    for (const e of ctx.pluck('skillExp')) { exp.add(e.skill); prof.add(e.skill); fromAbilities.add(e.skill); }
    const out: Record<string, Json> = {};
    for (const [key, cn, ab] of SKILLS) {
      const mult = exp.has(key) ? 2 : prof.has(key) ? 1 : 0;
      const extra = ctx.pluck('skillBonus', { skill: key }).reduce((a, e) => a + resolveNum(e.value, ctx), 0);
      out[key] = {
        cn, ability: ab, prof: prof.has(key), exp: exp.has(key), fromAbility: fromAbilities.has(key), bonus: extra,
        total: (ctx.out['mod:' + ab] || 0) + mult * ctx.out.pb + extra,
      };
    }
    ctx.set('skills', out, 'computed');
    ctx.set('skillProfSet', prof, 'computed');
    ctx.set('skillExpSet', exp, 'computed');
    ctx.set('skillFromAbility', fromAbilities, 'computed');
  }, { name: 'core:skills' });

  R.add('defense', (ctx) => {
    const c = ctx.char;
    const lvl = ctx.out.level;
    const mod = (a: string) => ctx.out['mod:' + a] || 0;
    const res = c._resolved || {};

    // ---- AC ----
    let ac = 0;
    let acNote = '';
    const equipped = (res.equipment || []).filter((e: Json) => e.equipped);
    const armor = equipped.map((e: Json) => e._ent).find((x: Json) => x && x.armor);
    const shield = equipped.map((e: Json) => e._ent).find((x: Json) => x && String(x.type).split('|')[0] === 'S');
    if (armor) {
      const type = String(armor.type).split('|')[0];
      const dexCap = type === 'HA' ? 0 : type === 'MA' ? 2 : null;
      const dexPart = dexCap === null ? mod('dex') : Math.min(mod('dex'), dexCap);
      ac = armor.ac + dexPart;
      acNote = `${armor.name} ${armor.ac} ${dexCap === 0 ? '(无敏捷)' : dexCap === 2 ? '+ 敏捷(上限2)' : '+ 敏捷'} = ${ac}`;
    } else {
      const srcLabel = (raw: unknown) => {
        const s = String(raw == null ? '' : raw).trim();
        if (!s) return '';
        const m = s.match(/^([^：:]{1,24})[：:]/);
        if (m) return m[1];
        return s.length <= 12 ? s : '';
      };
      const cands = [{ ac: 10 + mod('dex'), note: `AC = 10 + 敏捷 ${sgn(mod('dex'))}（无甲）` }];
      for (const u of ctx.pluck('unarmoredDefense')) {
        cands.push({ ac: 10 + mod('dex') + mod(u.ability), note: `无甲防御：AC = 10 + 敏捷 + ${ABIL_CN[u.ability as keyof typeof ABIL_CN] || u.ability}` });
      }
      for (const f of ctx.pluck('acFormula')) {
        const abils = (f.abils || []).filter((a: string) => a !== 'dex');
        const tag = srcLabel(f.source);
        cands.push({
          ac: (f.base || 10) + mod('dex') + abils.reduce((a: number, x: string) => a + mod(x), 0),
          note: `AC = ${f.base || 10} + 敏捷${abils.map((a: string) => ' + ' + (ABIL_CN[a as keyof typeof ABIL_CN] || a)).join('')}${tag ? `（${tag}）` : ''}`,
        });
      }
      for (const s of ctx.pluck('acSet')) {
        const tag = srcLabel(s.source);
        cands.push({ ac: (s.value || 10) + mod(s.ability || 'dex'), note: `AC = ${s.value} + ${ABIL_CN[(s.ability || 'dex') as keyof typeof ABIL_CN]}${tag ? `（${tag}）` : ''}` });
      }
      const best = cands.slice().sort((a, b) => b.ac - a.ac)[0];
      ac = best.ac;
      acNote = best.note + (cands.length > 1 ? `\n（候选 ${cands.length} 个，取最高）` : '');
    }
    if (shield) { ac += 2; acNote += '\n+ 盾牌 2'; }
    const acBonus = ctx.sumEffects('ac');
    if (acBonus) { ac += acBonus; acNote += `\n+ 其他 ${acBonus}`; }
    ctx.set('ac', ac, 'computed', acNote);
    ctx.set('acNote', acNote, 'computed');

    // ---- HP：1 级取满（只算起始职业的第 1 级），其余按玩家填的骰子，没填的取平均 ----
    let hp = 0;
    const hpNotes: string[] = [];
    const hpRolls = c.hpRolls && typeof c.hpRolls === 'object' ? c.hpRolls : {};
    const firstCls = String(c.startingClass || (res.classes || [])[0]?.cls?.name || '');
    const conMod = mod('con');
    for (const k of res.classes || []) {
      const hd = k.cls.hd.faces;
      const lv = k.level;
      const avg = Math.floor(hd / 2) + 1;
      const mine = Array.isArray(hpRolls[k.cls.name]) ? hpRolls[k.cls.name] : [];
      let gain = 0;
      let filled = 0;
      const levels: number[] = [];
      for (let i = 0; i < lv; i++) {
        if (i === 0 && k.cls.name === firstCls) { gain += hd; levels.push(hd); continue; }
        const raw = mine[i];
        const has = raw !== undefined && raw !== null && raw !== '' && Number.isFinite(+raw);
        const v = has ? clamp(Math.round(+raw), 1, hd) : avg;
        if (has) filled++;
        gain += v;
        levels.push(v);
      }
      hp += gain + conMod * lv;
      hpNotes.push(filled
        ? `${k.cls.name} d${hd}: ${levels.join(' + ')}（含 ${filled} 项你自己填的）`
        : `${k.cls.name} d${hd}: ${hd + conMod} + ${lv - 1}×${avg + conMod}`);
    }
    const perLevel = ctx.pluck('hpPerLevel').reduce((a, e) => a + (e.value || 0), 0);
    if (perLevel) hp += perLevel * Math.max(1, lvl);
    const hpBonus = ctx.sumEffects('hp');
    hp += hpBonus;
    const hpExtraNote = (perLevel ? ` + 每级 ${perLevel}×${lvl}` : '') + (hpBonus ? ` + 其他 ${hpBonus}` : '');
    ctx.set('hpMax', Math.max(1, hp), 'computed', hpNotes.join('；') + hpExtraNote);
    ctx.set('hpNotes', hpNotes.join('\n') + hpExtraNote);
    ctx.set('hitDice', (res.classes || []).map((k: Json) => ({ cls: k.cls, level: k.level, faces: k.cls.hd.faces, total: k.level })), 'computed');

    // ---- 先攻 / 速度 / 感官 / 移动模式 ----
    ctx.set('initiative', mod('dex') + ctx.pluck('initiative').reduce((a, e) => a + resolveNum(e.value, ctx), 0), 'computed');
    let speed = res.race?.speed ?? 30;
    speed += ctx.sumEffects('speed');
    speed = Math.max(speed, ...ctx.pluck('speedMin').map((e) => e.value || 0));
    ctx.set('speed', speed, 'computed');
    const dv = Math.max(res.race?.darkvision || 0, ...ctx.pluck('darkvision').map((e) => e.value), 0);
    ctx.set('darkvision', dv, 'computed');
    const senses: Record<string, number> = {};
    for (const e of ctx.pluck('sense')) senses[e.sense] = Math.max(senses[e.sense] || 0, e.value || 0);
    ctx.set('senses', senses, 'computed');
    const moves: Record<string, number> = {};
    for (const e of ctx.pluck('moveSpeed')) moves[e.mode] = Math.max(moves[e.mode] || 0, e.value || 0);
    for (const e of ctx.pluck('moveSpeedEqualWalk')) moves[e.mode] = Math.max(moves[e.mode] || 0, speed);
    ctx.set('moveSpeeds', moves, 'computed');

    // ---- 临时生命值（与上限分开；per:'class' 乘声明它的那个职业的等级） ----
    const tmp = ctx.pluck('tempHp');
    if (tmp.length) {
      const lvl1 = ctx.out.level || 1;
      const classLv = (name: string) => {
        const k = (c.classes || []).find((x: Json) => x.name === name);
        return k ? Math.max(1, +k.level || 1) : null;
      };
      const per = (e: Json) => {
        if (!e.perLevel) return 0;
        const l = e.per === 'class' && e.cls ? (classLv(e.cls) ?? lvl1) : lvl1;
        return e.perLevel * l;
      };
      const best = Math.max(...tmp.map((e) => per(e) + (e.bonus || 0)), 0);
      ctx.set('tempHp', best, 'computed');
      ctx.set('tempHpNotes', tmp.map((e) => (e.note || '')
        + (e.perLevel ? `（${e.perLevel} × ${e.per === 'class' && e.cls ? e.cls + '等级' : '等级'}）` : '')).filter(Boolean), 'computed');
    }
    const saveBonus = ctx.pluck('saveBonus');
    if (saveBonus.length) ctx.set('saveBonus', saveBonus.map((e) => e.note || e.value).filter(Boolean), 'computed');
    const cImm = new Set(ctx.pluck('conditionImmune').map((e) => e.value).filter(Boolean));
    ctx.set('conditionImmune', [...cImm], 'computed');
    ctx.set('passivePerception', 10 + (ctx.out.skills.perception?.total || 0), 'computed');
    ctx.set('passiveInsight', 10 + (ctx.out.skills.insight?.total || 0), 'computed');
    ctx.set('passiveInvestigation', 10 + (ctx.out.skills.investigation?.total || 0), 'computed');
    ctx.set('carry', (ctx.out['score:str'] || 0) * 15, 'computed');
    ctx.set('pushDragLift', (ctx.out['score:str'] || 0) * 30, 'computed');
    ctx.set('size', res.race ? (c.size || (res.race.size || ['M'])[0]) : 'M', 'computed');

    // ---- 护甲 / 武器熟练：起始职业用 startingProficiencies，兼职用 multiclassing.proficienciesGained ----
    const ARMOR_CN: Record<string, string> = { light: '轻甲', medium: '中甲', heavy: '重甲', shield: '盾牌' };
    const armorProfs = new Set<string>();
    const weaponProfsList = new Set<string>();
    const weaponProfNotes = new Set<string>();
    const startingClsName = c.startingClass || res.classes?.[0]?.cls?.name || '';
    for (const k of res.classes || []) {
      const isStarting = k.cls.name === startingClsName;
      const mc = (k.cls.multiclassing || {}).proficienciesGained;
      const sp = isStarting || !mc ? (k.cls.startingProficiencies || {}) : mc;
      (sp.armor || []).forEach((a: string) => armorProfs.add(ARMOR_CN[a] || a));
      for (const w of sp.weapons || []) {
        const s = String(w);
        if (/^\{@|具有|或|属性的/.test(s)) { weaponProfNotes.add(s); continue; }
        weaponProfsList.add(s);
      }
    }
    ctx.pluck('armorProf').forEach((e) => armorProfs.add(e.value));
    ctx.pluck('weaponProf').forEach((e) => {
      const v = String(e.value ?? '');
      if (!v) return;
      if (/^\{@|具有|或|属性的/.test(v)) weaponProfNotes.add(v);
      else weaponProfsList.add(v);
    });
    ctx.set('armorProfs', [...armorProfs], 'computed');
    ctx.set('weaponProfs', [...weaponProfsList], 'computed');
    ctx.set('weaponProfNotes', [...weaponProfNotes], 'computed');

    // ---- 武器精通（玩家选的；没选时退回已装备武器自带的） ----
    const chosenMasteries = (c.masteries || []).filter(Boolean);
    const masteries = new Set<string>(chosenMasteries.length ? chosenMasteries : []);
    if (!chosenMasteries.length) {
      for (const eq of (res.equipment || []).filter((e: Json) => e.equipped)) {
        for (const m of eq._ent?.mastery || []) masteries.add(String(m.uid || m).split('|')[0]);
      }
    }
    ctx.set('masteries', [...masteries], 'computed');

    // ---- 抗性 / 语言 / 工具 ----
    const norm = (v: unknown) => (Array.isArray(v) ? v : [v]);
    const res2 = new Set<string>(norm(res.race?.resist || []).filter((x): x is string => typeof x === 'string'));
    ctx.pluck('resist').forEach((e) => {
      const list = Array.isArray(e.damage) ? e.damage : [e.damage];
      for (const dm of list) if (dm) res2.add(dm);
    });
    ctx.set('resist', [...res2], 'computed');
    const imm = [...new Set(ctx.pluck('immune').map((e) => e.damage).filter(Boolean))];
    if (imm.length) ctx.set('immune', imm, 'computed');
    const langs = new Set<string>(c.languages || []);
    const tools = new Set<string>(c.tools || []);
    for (const e of ctx.pluck('language')) langs.add(e.value);
    for (const e of ctx.pluck('tool')) tools.add(e.value);
    for (const t of res.toolsFixed || []) tools.add(t);
    for (const g of res.languagesGranted || []) langs.add(g.name);
    ctx.set('languages', [...langs], 'computed');
    ctx.set('tools', [...tools], 'computed');
    ctx.set('toolsFixed', res.toolsFixed || [], 'computed');
    ctx.set('languagesGranted', res.languagesGranted || [], 'computed');
  }, { name: 'core:defense' });

  R.add('attacks', (ctx) => {
    const c = ctx.char;
    const profWeapons = new Set<string>();
    for (const k of ctx.char._resolved?.classes || []) {
      const sp = k.cls.startingProficiencies || {};
      (sp.weapons || []).forEach((w: string) => profWeapons.add(w));
      (sp.weaponProficiencies || []).forEach((p: Json) => {
        if (p.simple) profWeapons.add('简易');
        if (p.all) profWeapons.add('all:' + p.all.fromFilter);
      });
    }
    /**
     * ⚠️ 移植时修掉的原项目 bug（见 tests/fixtures/divergences.json）：
     * 熟练过滤式是 `type=军用武器|property=轻型;灵巧`（没有路径段），原实现 `.slice(1)` 丢掉了第一段；
     * 而且武器的 property 存的是代码（F / L），原实现拿中文名去比，永远对不上 ——
     * 游荡者的刺剑、武僧的短剑因此都不加熟练加值。
     */
    const propCode: Record<string, string> = { 灵巧: 'F', 轻型: 'L', 重型: 'H', 双手: '2H', 触及: 'R', 投掷: 'T', 多用: 'V', 弹药: 'A', 装填: 'LD', 特殊: 'S' };
    for (const [code, cn] of Object.entries(ctx.env.store.props || {})) propCode[cn] ??= code;
    const isProf = (w: Json) => {
      const cat = w.weaponCategory;
      if (profWeapons.has(cat === 'martial' ? '军用' : '简易')) return true;
      for (const key of profWeapons) {
        if (String(key).startsWith('all:')) {
          const expr = String(key).slice(4);
          const props = (w.property || []).map((p: unknown) => String(p).split('|')[0]);
          const conds = expr.split('|').map((g) => g.split('=')).filter((x) => x.length === 2);
          const ok = conds.every(([k, v]) => {
            if (k === 'type') return v.includes('军用') ? cat === 'martial' : cat === 'simple';
            if (k === 'property') return v.split(';').some((p) => props.includes(propCode[p] ?? p));
            return true;
          });
          if (ok) return true;
        }
      }
      return false;
    };
    const rows: Json[] = [];
    for (const eq of (ctx.char._resolved?.equipment || []).filter((e: Json) => e.equipped)) {
      const w = eq._ent;
      if (!w || !w.weapon) continue;
      const props: string[] = (w.property || []).map((p: unknown) => String(p).split('|')[0]);
      const finesse = props.includes('F');
      const ranged = String(w.type).split('|')[0] === 'R' || props.includes('A');
      let abil = 'str';
      if (ranged) abil = 'dex';
      else if (finesse) abil = (ctx.out['mod:dex'] || 0) >= (ctx.out['mod:str'] || 0) ? 'dex' : 'str';
      const prof = isProf(w);
      // 魔法武器：+N（物品自带的、或者给普通武器标的 +N）；要同调的没同调不算
      const magicOn = !w.reqAttune || eq.attuned;
      const plus = magicOn ? num(w.bonusWeapon) + (Number(eq.bonus) || 0) : 0;
      const atk = (ctx.out['mod:' + abil] || 0) + (prof ? ctx.out.pb : 0) + plus + (magicOn ? num(w.bonusWeaponAttack) : 0);
      const pd = parseDiceText(w.dmg1);
      const dmg = w.dmg1 ? ((pd?.n || 1) + 'd' + (pd?.f || 4)) : '—';
      const bonus = pd?.b || 0;
      const isTwo = props.includes('2H');
      const dmgMod = ctx.out['mod:' + abil] + bonus + plus + (magicOn ? num(w.bonusWeaponDamage) : 0);
      rows.push({
        name: w.name, ent: w, prof, abil, atk, dmg,
        dmgText: `${dmg} ${dmgMod >= 0 ? '+' + dmgMod : dmgMod} ${DMG_CN[w.dmgType] || ''}`.trim(),
        dmgType: DMG_CN[w.dmgType] || w.dmgType,
        dmg2: w.dmg2 ? `${w.dmg2} ${dmgMod >= 0 ? '+' + dmgMod : dmgMod}` : null,
        mastery: (w.mastery || []).map((m: Json) => String(m.uid || m).split('|')[0]),
        props: props.map((p) => c._resolved?.props?.[p] || ctx.env.store.props?.[p] || p),
        range: w.range, twoHanded: isTwo, finesse, ranged,
        note: props.includes('A') ? `弹药：${w.ammoType || '—'}` : '',
      });
    }
    ctx.set('attacks', rows, 'computed');
  }, { name: 'core:attacks' });

  R.add('spellcasting', (ctx) => {
    const c = ctx.char;
    const res = c._resolved || {};
    const casters = (res.classes || []).filter((k: Json) => k.cls.casterProgression);
    const sc: Json = { casters: [], slots: null, pact: null, cantripsKnown: 0, preparedMax: 0, ability: null, dc: null, atk: null, byLevel: {} };
    // 法术位：2024 多职业规则（半施法向上取整）
    let casterLevels = 0;
    const roundNote: string[] = [];
    for (const k of casters) {
      const fam = CASTER_FAMILY(k.cls.casterProgression);
      if (!fam || fam === 'pact') continue;
      const raw = k.level * CASTER_CONTRIB[fam];
      const contrib = fam === 'half' ? Math.ceil(raw) : Math.floor(raw);
      casterLevels += contrib;
      roundNote.push(`${k.cls.name} ${k.level}×${CASTER_CONTRIB[fam]}${fam === 'half' ? '(向上)' : ''}=${contrib}`);
    }
    if (casterLevels > 0) {
      sc.slots = SLOT_TABLE[clamp(Math.floor(casterLevels), 0, 20)];
      sc.casterLevels = casterLevels;
      sc.slotNote = roundNote.join('，') + ` → 施法者等级 ${casterLevels}`;
    }
    const pact = casters.find((k: Json) => CASTER_FAMILY(k.cls.casterProgression) === 'pact');
    if (pact) {
      const row = PACT_TABLE[clamp(pact.level - 1, 0, 19)];
      sc.pact = { count: row[0], level: row[1], cls: pact.cls.name };
    }
    // 职业等级表里的已知戏法 / 准备法术
    const tableVal = (cls: Json, labels: string[]) => {
      for (const g of cls.classTableGroups || []) {
        const idx = (g.colLabels || []).map((l: unknown, i: number) => ({ l: String(l), i }))
          .filter(({ l }: { l: string }) => labels.some((x) => l.includes(x))).map(({ i }: { i: number }) => i);
        const rows = g.rows || g.rowsSpellProgression;
        if (idx.length && rows) return idx.map((i: number) => rows[clamp(ctx.out.level - 1, 0, rows.length - 1)]?.[i]);
      }
      return null;
    };
    for (const k of casters) {
      const cantrips = tableVal(k.cls, ['戏法']);
      const prepared = tableVal(k.cls, ['准备法术', '已知法术']);
      const val = (a: Json) => (Array.isArray(a) ? a.find((x: Json) => typeof x === 'number' || (x && x.type === 'bonus')) : a);
      const num = (x: Json) => (typeof x === 'number' ? x : x && x.type === 'bonus' ? x.value : null);
      const cv = num(val(cantrips));
      const pv = num(val(prepared));
      if (cv != null) sc.cantripsKnown += cv;
      if (pv != null) sc.preparedMax += pv;
      sc.casters.push({ name: k.cls.name, level: k.level, prog: k.cls.casterProgression, ability: k.cls.spellcastingAbility, subclass: k.subclassName, cantrips: cv, prepared: pv });
    }
    const abilSet = [...new Set(casters.map((k: Json) => k.cls.spellcastingAbility).filter(Boolean))] as string[];
    if (abilSet.length) {
      sc.ability = abilSet[0];
      sc.allAbilities = abilSet;
      sc.dc = 8 + ctx.out.pb + (ctx.out['mod:' + sc.ability] || 0);
      sc.atk = ctx.out.pb + (ctx.out['mod:' + sc.ability] || 0) + ctx.sumEffects('spellAtkBonus');
      const dcBonus = ctx.pluck('spellDcBonus').filter((e) => !e.list || e.list === sc.abilityCls || casters.some((k: Json) => k.cls.name === e.list));
      const dcSum = dcBonus.reduce((a, e) => a + (e.bonus || 0), 0);
      if (dcSum) {
        sc.dc += dcSum;
        sc.dcNote = (sc.dcNote ? sc.dcNote + '；' : '') + `临时 +${dcSum}（${[...new Set(dcBonus.map((e) => e.source || '状态'))].join('、')}）`;
      }
    }
    sc.list = (c.spells || []).map((s: Json) => ({ ...s, _ent: s._ent }));
    sc.hasSpellbook = (res.classes || []).some((k: Json) => k.cls.name === '法师');
    const wizK = (res.classes || []).find((k: Json) => k.cls.name === '法师');
    sc.spellbookMax = wizK ? 6 + (wizK.level - 1) * 2 : null;
    sc.casterLevels = casterLevels;
    sc.granted = (ctx.out.grantedSpells || []).filter((g: Json) => g && g.name);
    ctx.set('spell', sc, 'computed');
  }, { name: 'core:spellcasting' });

  R.add('features', (ctx) => {
    const res = ctx.char._resolved || {};
    const list: Json[] = [];
    const opts = ctx.env.abilities.optionFeatureNames(ctx.char);
    const chosen = new Set<string>();
    for (const [k, v] of Object.entries(ctx.char.decisions || {})) {
      if (!ctx.env.abilities.isDecisionKeyActive(ctx.char, k)) continue;
      for (const x of Array.isArray(v) ? v : [v]) if (typeof x === 'string' && x) chosen.add(x);
    }
    const active = (f: Json) => !opts.has(f.name) || chosen.has(f.name);
    for (const k of res.classes || []) {
      for (const f of k.features || []) if (active(f)) list.push({ ...f, _cls: k.cls.name, _sub: false });
      for (const f of k.subFeatures || []) if (active(f)) list.push({ ...f, _cls: k.cls.name, _sub: true });
    }
    for (const f of res.race?.entries || []) list.push({ name: f.name || '种族特质', level: 0, entries: f.entries ? [f] : [f], _origin: 'race' });
    list.sort((a, b) => (a.level || 0) - (b.level || 0) || String(a._cls || '').localeCompare(String(b._cls || '')));
    ctx.set('features', list, 'computed');
    ctx.set('origins', buildOrigins(ctx.char, res), 'computed');
  }, { name: 'core:features' });

  R.add('finalize', (ctx) => {
    const man = ctx.char.manual || {};
    for (const [k, v] of Object.entries(man)) {
      if (v === '' || v == null) continue;
      ctx.set(k, typeof v === 'number' ? v : (isNaN(+(v as string)) ? v : +(v as string)), 'manual');
    }
    ctx.set('trace', ctx.trace, 'finalize');
  }, { name: 'core:manual' });

  return R;
}
