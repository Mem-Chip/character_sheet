/**
 * 能力框架（移植自原项目 core/plugins.js 的 Abilities / ModKinds / resolveNum / 家规层）。
 *
 * 四声明：mods（改数值）/ grants（授予实体）/ choices（要玩家做决定）/ resources（资源池）。
 * 数据三层：内嵌兜底（abilities-builtin.json）→ abilities-2024.json → 家规（全服 → 战役 → 本卡）。
 *
 * 和原项目的区别只有一个：不再读全局（Store / CHAR / Homelib），全部从 SheetEnv 进来。
 * 逻辑与输出逐项对齐原项目（见 tests/sheet/parity.test.ts）。
 */
import { ABILS, ABIL_CN, ABIL_WORD } from './constants';
import type { SheetEnv } from './env';
import { Source } from './source';
import type { Json } from './store';
import { entryText, proseChoiceComplement } from './text';
import type { CalcCtx } from './pipeline';

export const HR_SOURCE = 'HR';

/* ============================================================================
 * 小函数
 * ========================================================================== */

/** 属性加值的方案表 —— 从数据的 amount 推出来，不猜 */
export function abilityPlans(ch: Json): Array<{ count: number; amount: number }> {
  const raw = Array.isArray(ch?.amount) && ch.amount.length ? ch.amount : [1];
  const out: Array<{ count: number; amount: number }> = [];
  const seen = new Set<string>();
  raw.forEach((amt: unknown, i: number) => {
    const p = { count: i + 1, amount: Math.max(1, Number(amt) || 1) };
    const k = p.count + ':' + p.amount;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(p);
  });
  return out.length ? out : [{ count: 1, amount: 1 }];
}

/** 一个决定是否「做完了」（多选要选够数） */
export function decisionComplete(ch: Json, dec: unknown): boolean {
  if (dec === undefined || dec === null) return false;
  if (Array.isArray(dec)) {
    const vals = [...new Set(dec.filter(Boolean))];
    if (!vals.length) return false;
    const need = (ch && (ch.count || (Array.isArray(ch.from) && ch.from.length))) || 1;
    return vals.length >= need;
  }
  if (typeof dec === 'object') return Object.keys(dec as object).length > 0;
  return true;
}

export interface Derived {
  skills: Set<string>;
  expertise: Set<string>;
  saves: Set<string>;
  languages: Set<string>;
  tools: Set<string>;
  feats: Set<string>;
  spells: Set<string>;
  cantrips: Set<string>;
  masteries: Set<string>;
  spellFrom: Record<string, string>;
  ac: Json[];
  resources: Json[];
  entries: Json[];
  hrSeen?: Set<string>;
  pending: Json[];
  grantedCandidates?: Set<string>;
}

/** 选择 → 授予（唯一一份；主循环和末尾的结构性选择都走它） */
export function applyChoiceGrant(c: Json, vals: string[], out: Derived, from?: string): boolean {
  if (c.pool === 'spellList') {
    out.entries.push({ text: `${c.label || c.id}：${vals.join('、')}`, from: from || '', note: true });
    return true;
  }
  const add = (setName: 'skills' | 'expertise' | 'saves' | 'languages' | 'tools' | 'feats' | 'spells' | 'cantrips' | 'masteries') => {
    for (const v of vals) {
      out[setName].add(v);
      if (setName === 'spells' || setName === 'cantrips') (out.spellFrom || (out.spellFrom = {}))[v] = from || '';
    }
  };
  const M: Record<string, () => void> = {
    skill: () => add('skills'),
    expertise: () => add('expertise'),
    save: () => add('saves'),
    language: () => add('languages'),
    tool: () => add('tools'),
    feat: () => add('feats'),
    spell: () => add('spells'),
    cantrip: () => add('cantrips'),
    itemMastery: () => add('masteries'),
    ability: () => {},
    classFeature: () => {},
    optfeature: () => {},
  };
  const fn = M[c.kind];
  if (!fn) return false;
  fn();
  for (const g of c.alsoGrants || []) {
    const gf = M[g.kind];
    if (gf) gf();
  }
  return true;
}

/** 「10 + 敏捷调整值 + 体质调整值」→ { base, abils } */
export function parseAcFormula(text: unknown): { base: number; abils: string[] } | null {
  if (!text) return null;
  const t = String(text).replace(/\s/g, '');
  const base = Number((t.match(/(\d+)/) || [])[1] || 10);
  const abils: string[] = [];
  for (const [cn, en] of Object.entries(ABIL_WORD)) {
    if (t.includes(cn + '调整值') || t.includes(cn + '调整')) abils.push(en);
  }
  return { base, abils };
}

/**
 * 「公式式」的数值引用 → 数字：数字 / 'pb' / 'level' / 裸属性名 / 'mod:dex' / 'spellcasting' / 中文「魅力调整值」。
 * 动态层用表达式语言（src/expr），这里保留原项目的写法以兼容静态数据。
 */
export function resolveNum(v: unknown, ctx: { out: Record<string, any>; char: Json }): number {
  if (typeof v === 'number') return v;
  if (v === 'pb') return ctx.out.pb ?? (2 + Math.floor((Math.max(1, ctx.out.level || totalLevel(ctx.char)) - 1) / 4));
  if (v === 'level') return ctx.out.level ?? totalLevel(ctx.char);
  if (typeof v === 'string' && (ABILS as readonly string[]).includes(v.trim())) return ctx.out['mod:' + v.trim()] || 0;
  if (typeof v === 'string' && /调整值|调整/.test(v)) {
    for (const [cn, en] of Object.entries(ABIL_WORD)) if (v.includes(cn)) return ctx.out['mod:' + en] || 0;
  }
  if (v === 'spellcasting') {
    const casters = (ctx.char?._resolved?.classes || []).filter((k: Json) => k.cls.spellcastingAbility);
    const ab = casters.length ? casters[0].cls.spellcastingAbility : null;
    return ab ? (ctx.out['mod:' + ab] || 0) : 0;
  }
  if (typeof v === 'string' && v.startsWith('mod:')) {
    const ab = v.slice(4);
    if (ab === 'spellcasting') return resolveNum('spellcasting', ctx);
    return ctx.out['mod:' + ab] || 0;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function totalLevel(c: Json): number {
  return (c?.classes || []).reduce((a: number, k: Json) => a + (+k.level || 0), 0);
}

let idCounter = 0;
/** 卡片 / 家规 id：时间 + 随机，够用且不依赖 crypto */
export function newCardId(prefix = 'c'): string {
  idCounter = (idCounter + 1) % 1296;
  const t = Date.now().toString(36).slice(-6);
  const r = Math.floor(Math.random() * 36 ** 4).toString(36).padStart(4, '0');
  return `${prefix}-${t}${r}${idCounter.toString(36).padStart(2, '0')}`.slice(0, prefix.length + 1 + 16);
}

/* ============================================================================
 * 修正类型注册表（ModKinds）
 * ========================================================================== */

export type ModFn = (ctx: CalcCtx, m: Json, a: Json, s: SourceSpec) => unknown;
export interface SourceSpec {
  source: string;
  name: string;
  kind: string;
  cls?: string;
  level?: number;
  displayName?: string;
  covers?: string;
}

function registerDefaultKinds(book: AbilityBook): void {
  const reg = (k: string, fn: ModFn, describe: string) => book.registerKind(k, fn, describe);
  reg('ability', (ctx, m) => {
    const set = m.set || {};
    if (Object.keys(set).length) ctx.addEffect({ kind: 'ability', set, source: m.note });
  }, '给属性值加成');
  reg('ac', (ctx, m) => {
    if (m.formula || m.ability) {
      const parsed = parseAcFormula(m.formula) || { base: 10, abils: m.ability ? [m.ability] : [] };
      ctx.addEffect({ kind: 'acFormula', base: parsed.base, abils: parsed.abils.length ? parsed.abils : (m.ability ? [m.ability] : []), source: m.note });
    }
    if (m.set) ctx.addEffect({ kind: 'acSet', value: m.set, ability: m.ability2 || 'dex', source: m.note });
    if (m.bonus) ctx.addEffect({ kind: 'ac', value: m.bonus, source: m.note });
  }, 'AC：算式（+ 敏捷 + 某属性）或固定加值');
  reg('speed', (ctx, m) => { ctx.addEffect({ kind: 'speed', value: m.bonus ?? m.set ?? 0, source: m.note }); }, '速度加成');
  reg('initiative', (ctx, m) => { ctx.addEffect({ kind: 'initiative', value: m.bonus, source: m.note }); }, '先攻加成（bonus 可为数字、"pb" 或属性名）');
  reg('hp', (ctx, m) => {
    if (m.perLevel) ctx.addEffect({ kind: 'hpPerLevel', value: m.perLevel, source: m.note });
    if (m.bonus) ctx.addEffect({ kind: 'hp', value: m.bonus, source: m.note });
  }, '生命值加成（含每级）');
  reg('resist', (ctx, m) => { for (const d of m.values || []) ctx.addEffect({ kind: 'resist', damage: d, source: m.note }); }, '伤害抗性/免疫/易伤');
  reg('darkvision', (ctx, m) => { ctx.addEffect({ kind: 'darkvision', value: m.value ?? 60, source: m.note }); }, '黑暗视觉');
  reg('saveProf', (ctx, m) => { for (const a of m.values || []) ctx.addEffect({ kind: 'saveProf', ability: a, source: m.note }); }, '豁免熟练');
  reg('skillBonus', (ctx, m) => { ctx.addEffect({ kind: 'skillBonus', skill: m.skill, value: m.bonus, source: m.note }); }, '特定技能加值');
  reg('note', () => {}, '只作展示，不改数值（但会出现在「能力一览」里）');
  reg('armorProf', (ctx, m) => { for (const a of m.values || []) ctx.addEffect({ kind: 'armorProf', value: a, source: m.note }); }, '护甲熟练');
  reg('weaponProf', (ctx, m) => { for (const w of m.values || []) ctx.addEffect({ kind: 'weaponProf', value: w, source: m.note }); }, '武器熟练');
  reg('sense', (ctx, m) => { ctx.addEffect({ kind: 'sense', sense: m.sense, value: m.value ?? 0, source: m.note }); }, '特殊感官（盲视/震颤感知/真实视觉）');
  reg('moveSpeed', (ctx, m) => { ctx.addEffect({ kind: 'moveSpeed', mode: m.mode, value: m.value ?? 0, source: m.note }); }, '移动模式速度（fly/swim/climb）');
  reg('tempHp', (ctx, m, _a, s) => {
    ctx.addEffect({ kind: 'tempHp', perLevel: m.perLevel ?? null, bonus: m.bonus ?? null, per: m.per ?? null, cls: s?.cls || null, note: m.note });
  }, '临时生命值（与最大生命值分开）');
  reg('saveBonus', (ctx, m) => { ctx.addEffect({ kind: 'saveBonus', value: m.value, ability: m.ability, note: m.note }); }, '豁免加值');
  reg('conditionImmune', (ctx, m) => { ctx.addEffect({ kind: 'conditionImmune', value: m.value, note: m.note }); }, '状态免疫');
  reg('resource', (ctx, m) => { ctx.addEffect({ kind: 'abilityResource', id: m.id, note: m.note }); }, '资源池（由 resources 声明，这里只做标注）');
}

/* ============================================================================
 * 家规（Homelib：全服 → 战役 → 本卡，靠后的覆盖靠前的）
 * ========================================================================== */

export interface HomeRuleEntry {
  id: string;
  name?: string;
  text?: string;
  covers?: string;
  pickable?: boolean;
  mods?: Json[];
  grants?: Json[];
  choices?: Json[];
  resources?: Json[];
  /** 从规则库导入的：5etools 原文和出处（只用来显示） */
  entries?: Json[];
  ref?: { kind: string; source: string; name: string };
  _scope?: string;
  _shadowedBy?: string;
}

export const hrKeyOf = (e: { id?: string } | null | undefined) => HR_SOURCE + ':' + (e && e.id);

/** 能力来源的条目键：职业特性 `<来源>:<职业>:<名字>:<等级>`，其余 `<来源>:<名字>`（家规的 covers 也写这个） */
export function sourceKeyOf(s: SourceSpec): string {
  return s.kind === 'classFeature' || s.kind === 'subclassFeature' ? `${s.source}:${s.cls}:${s.name}:${s.level}` : `${s.source}:${s.name}`;
}

/* ============================================================================
 * AbilityBook
 * ========================================================================== */

export class AbilityBook {
  readonly kinds = new Map<string, { fn: ModFn; describe: string }>();
  data: { version: number; entries: Record<string, Json> };
  origin: string;
  stats: Json = null;
  private hrTable: Record<string, Json> = Object.create(null);
  private hrKeys: string[] = [];

  constructor(
    private readonly env: SheetEnv,
    builtin: Record<string, Json>,
    ext: Record<string, Json> | null,
    extName = 'abilities-2024.json',
  ) {
    registerDefaultKinds(this);
    const b = structuredClone(builtin);
    if (ext) {
      this.data = { version: 1, entries: { ...b, ...structuredClone(ext) } };
      this.origin = `内嵌 ${Object.keys(b).length} 条 + ${extName} ${Object.keys(ext).length} 条 → 合并后 ${Object.keys(this.data.entries).length} 条`;
    } else {
      this.data = { version: 1, entries: b };
      this.origin = `内嵌 ${Object.keys(b).length} 条（外部文件未装载）`;
    }
  }

  registerKind(kind: string, fn: ModFn, describe = ''): void {
    this.kinds.set(kind, { fn, describe });
  }

  /** 从 feats.json 补抽取漏掉的专长内选择（幂等）。数据骨架到位之后调用 */
  augmentFromFeatData(): number {
    const feats = this.env.store.data.feats?.feat || [];
    if (!feats.length) return 0;
    let added = 0;
    for (const [key, a] of Object.entries(this.data.entries)) {
      const cn = key.slice(key.indexOf(':') + 1);
      const feat = feats.find((f: Json) => f.name === cn && Source.is2024(f));
      const groups = feat?.additionalSpells;
      if (!groups?.length) continue;
      const lists = groups.map((g: Json) => String(g.name || '').replace(/法术$/, '')).filter(Boolean);
      if (!lists.length) continue;
      a.choices ||= [];
      const hasL1 = groups.some((g: Json) => (g.innate?._?.daily?.['1'] || []).length);
      if (hasL1 && !a.choices.some((c: Json) => c.pool === 'byClassL1')) {
        a.choices.push({ id: 'spell1', kind: 'spell', count: 1, pool: 'byClassL1', label: '从该列表选 1 个 1 环法术（可免费施展 1 次，长休后恢复）' });
        added++;
      }
      const abilChoose = groups.map((g: Json) => g.ability?.choose).find(Array.isArray);
      if (abilChoose && !a.choices.some((c: Json) => c.id === 'spellAbility')) {
        a.choices.push({
          id: 'spellAbility', kind: 'ability', pick: true, from: abilChoose,
          label: `这两个法术用哪个属性施法？（${abilChoose.map((x: string) => ABIL_CN[x as keyof typeof ABIL_CN] || x).join(' / ')}）`,
        });
        added++;
      }
    }
    let nAbility = 0;
    let nFixedRemoved = 0;
    for (const [key, a] of Object.entries(this.data.entries)) {
      const cn = key.slice(key.indexOf(':') + 1);
      const feat = this.featByName(cn);
      const ab = feat?.ability;
      if (!ab) continue;
      const parsed = this.parseFeatAbility(ab);
      if (!parsed) continue;
      a.choices ||= [];
      const existing = a.choices.findIndex((c: Json) => c.kind === 'ability' && !c.pick);
      if (parsed.fixed) {
        if (existing >= 0) { a.choices.splice(existing, 1); nFixedRemoved++; }
        continue;
      }
      const choice = {
        id: 'asi', kind: 'ability', amount: parsed.amount, cap: parsed.cap, from: parsed.from,
        label: parsed.amount.length > 1
          ? `一项 +${parsed.amount[0]}，或两项各 +${parsed.amount[1]}`
          : `${parsed.from.map((x) => ABIL_CN[x as keyof typeof ABIL_CN] || x).join(' / ')} +${parsed.amount[0]}`,
      };
      if (existing >= 0) a.choices[existing] = { ...a.choices[existing], ...choice };
      else a.choices.push(choice);
      nAbility++;
    }
    added += nAbility;
    if (nFixedRemoved) this.env.log(`删掉 ${nFixedRemoved} 条「固定型」专长的多余属性选择`);
    return added;
  }

  private featByName(name: string): Json {
    const same = (this.env.store.data.feats?.feat || []).filter((f: Json) => f.name === name);
    return same.find((f: Json) => Source.isCore2024(f)) || same[0] || null;
  }

  parseFeatAbility(ab: Json): { from: string[]; amount: number[]; cap: number; fixed: boolean } | null {
    const groups = Array.isArray(ab) ? ab : [ab];
    const from: string[] = [];
    const byCount = new Map<number, number>();
    let cap: number | null = null;
    let fixed = false;
    for (const g of groups) {
      if (!g || typeof g !== 'object') continue;
      const ch = g.choose || g;
      if (typeof ch.max === 'number') cap = Math.max(cap || 0, ch.max);
      if (typeof g.max === 'number') cap = Math.max(cap || 0, g.max);
      if (Array.isArray(ch.from)) {
        from.push(...ch.from.filter((x: string) => (ABILS as readonly string[]).includes(x)));
        const n = Math.max(1, Number(ch.count) || 1);
        const pts = Math.max(1, Number(ch.amount) || 1);
        if (!byCount.has(n)) byCount.set(n, pts);
        continue;
      }
      for (const [k, v] of Object.entries(ch)) {
        if ((ABILS as readonly string[]).includes(k) && typeof v === 'number') {
          from.push(k);
          if (!byCount.has(1)) byCount.set(1, v);
          fixed = true;
        }
      }
    }
    const uniq = [...new Set(from)];
    if (!uniq.length) return null;
    const maxCount = Math.max(...byCount.keys());
    const amount: number[] = [];
    for (let n = 1; n <= maxCount; n++) amount.push(byCount.get(n) ?? byCount.get(1) ?? 1);
    return { from: uniq, amount, cap: cap || 20, fixed };
  }

  /** 结构审计：键格式、缺字段、未注册的 mod 类型、不认识的选择池 */
  audit(): Json {
    const problems: string[] = [];
    const unknownKinds = new Map<string, number>();
    const POOLS = new Set(['skill', 'skillOrTool', 'profSkill', 'anyProfSkill', 'instrument', 'artisan',
      'weapon', 'weaponMastery', 'cleric', 'druid', 'spellList', 'byClass', 'byClassL1', 'spellBySchool',
      'language', 'tool', 'ability', 'subclass', 'classFeature', 'originFeat']);
    let nMods = 0, nGrants = 0, nChoices = 0, nRes = 0;
    for (const [key, a] of Object.entries(this.data.entries)) {
      if (!key.includes(':')) problems.push(`${key}: 键格式应为 "<source>:<name>"`);
      if (!a || typeof a !== 'object') { problems.push(`${key}: 值不是对象`); continue; }
      for (const m of a.mods || []) {
        nMods++;
        if (!m.kind) problems.push(`${key}: mod 缺 kind`);
        else if (!this.kinds.has(m.kind)) unknownKinds.set(m.kind, (unknownKinds.get(m.kind) || 0) + 1);
      }
      for (const g of a.grants || []) {
        nGrants++;
        if (!g.kind) { problems.push(`${key}: grant 缺 kind`); continue; }
        if (g.kind === 'note') { if (!g.text) problems.push(`${key}: grant(note) 缺 text`); continue; }
        if (!['acFormula', 'custom'].includes(g.kind) && (!Array.isArray(g.values) || !g.values.length)) problems.push(`${key}: grant(${g.kind}) 缺 values`);
      }
      for (const c of a.choices || []) {
        nChoices++;
        if (!c.id) problems.push(`${key}: choice 缺 id`);
        if (!c.kind) problems.push(`${key}: choice 缺 kind`);
        const ok = Array.isArray(c.from) || POOLS.has(c.pool) || c.kind === 'ability';
        if (!ok) problems.push(`${key}: choice(${c.id}) 的 pool "${c.pool}" 无法解析（不在已知池里，也不是 from 数组）`);
      }
      for (const r of a.resources || []) { nRes++; if (!r.id) problems.push(`${key}: resource 缺 id`); }
    }
    this.stats = {
      abilities: Object.keys(this.data.entries).length, mods: nMods, grants: nGrants, choices: nChoices, resources: nRes,
      problems, unknownKinds: [...unknownKinds.entries()], kindsRegistered: [...this.kinds.keys()], poolsKnown: [...POOLS],
    };
    return this.stats;
  }

  /* ---------------- 家规 ---------------- */

  hrEntries(char: Json): HomeRuleEntry[] { return char && Array.isArray(char.homerules) ? char.homerules : []; }
  hrSpec(e: HomeRuleEntry): SourceSpec {
    return { source: HR_SOURCE, name: e.id, kind: 'homerule', displayName: e.name || e.id, covers: e.covers || '' };
  }
  hrIdOK(id: unknown): boolean { return /^hr-[0-9a-z]{4,16}$/.test(String(id || '')); }
  newHrId(): string { return newCardId('hr'); }
  hrBlank(): HomeRuleEntry {
    return { id: this.newHrId(), name: '', text: '', covers: '', pickable: false, mods: [], grants: [], choices: [], resources: [] };
  }

  /** 三层合成：同 key 靠后的赢，被盖住的那条标 _shadowedBy */
  homelibAll(char: Json): HomeRuleEntry[] {
    const layers = [
      { scope: 'server', rules: this.env.homelib.server },
      { scope: 'camp', rules: this.env.homelib.camp(char) },
      { scope: 'card', rules: this.hrEntries(char) },
    ].filter((l) => l.rules && l.rules.length);
    const out: HomeRuleEntry[] = [];
    const seen = new Map<string, number>();
    for (const layer of layers) {
      for (const e of layer.rules) {
        if (!e || !e.id) continue;
        const key = hrKeyOf(e);
        const prev = seen.get(key);
        if (prev !== undefined) {
          out[prev]._shadowedBy = layer.scope;
          out.splice(prev, 1);
          seen.clear();
          out.forEach((x, i) => seen.set(hrKeyOf(x), i));
        }
        out.push({ ...e, _scope: layer.scope });
        seen.set(key, out.length - 1);
      }
    }
    return out;
  }

  /** 把家规条目合进可查表（每次计算前调用；表很小，直接重建） */
  ensureHomerules(char: Json): string[] {
    this.hrTable = Object.create(null);
    this.hrKeys = [];
    const bad: string[] = [];
    for (const e of this.homelibAll(char)) {
      if (!e || !this.hrIdOK(e.id)) { bad.push(`家规条目 id 不合法：${JSON.stringify(e && e.id)}`); continue; }
      const cover = String(e.covers || '').trim();
      const official = cover.includes(':') ? this.get(cover.split(':')[0], cover.slice(cover.indexOf(':') + 1)) : null;
      const key = HR_SOURCE + ':' + e.id;
      this.hrTable[key] = {
        mods: e.mods || [], grants: e.grants || [], choices: e.choices || [], resources: e.resources || [],
        displayName: e.name || (official && official.displayName) || e.id,
        text: e.text || '',
        note: cover ? `家规（覆盖 ${cover}）` : '家规',
        _homerule: true,
        _hrId: e.id,
        _hrPickable: !!e.pickable,
        _hrCovers: cover,
        _hrOffKey: cover.includes(':') ? cover : '',
      };
      this.hrKeys.push(key);
    }
    if (bad.length) this.env.log('家规：' + bad.join('；'), 1);
    return bad;
  }

  hrCoverKeys(char: Json): string[] {
    return this.homelibAll(char).map((e) => String(e.covers || '').trim()).filter((k) => k.includes(':'));
  }

  hrFindByName(name: string, char: Json): Json {
    const nm = String(name || '');
    if (!nm) return null;
    for (const e of this.homelibAll(char)) if (e && e.name === nm) return { displayName: e.name, text: e.text || '', id: e.id };
    for (const k of this.hrKeys) {
      const a = this.hrTable[k];
      if (a && a.displayName === nm) return a;
    }
    return null;
  }

  hrEntryRow(a: Json): Json {
    if (!a || !a._homerule) return null;
    return { text: `${a.displayName || a._hrId}：${a.text || '（这条家规没写说明）'}`, name: a.displayName, from: a.displayName, homerule: true };
  }

  /* ---------------- 查表 ---------------- */

  /** 精确键：`<source>:<职业>:<名字>:<等级>` → `<source>:<职业>:<名字>` → `<source>:<名字>`；家规表优先 */
  get(source: string, name: string, className?: string, level?: number | null): Json {
    const hr = this.hrTable[`${source}:${name}`];
    if (hr) return hr;
    const E = this.data.entries;
    if (className && level != null) {
      const k = `${source}:${className}:${name}:${level}`;
      if (E[k]) return E[k];
    }
    if (className) {
      const k = `${source}:${className}:${name}`;
      if (E[k]) return E[k];
    }
    return E[`${source}:${name}`] || null;
  }

  /** 兜底：按名字尾巴找（来源不一致时） */
  getAny(name: string, className?: string, level?: number | null): Json {
    for (const k of this.hrKeys) {
      const a = this.hrTable[k];
      if (a && (a.displayName === name || a._hrId === name)) return a;
    }
    const E = this.data.entries;
    for (const k of Object.keys(E)) {
      const tail = k.slice(k.indexOf(':') + 1);
      if (tail === name) return E[k];
      if (className && tail === `${className}:${name}`) return E[k];
      if (className && level != null && tail === `${className}:${name}:${level}`) return E[k];
    }
    return null;
  }

  resolve(s: SourceSpec): Json {
    return this.get(s.source, s.name, s.cls, s.level) || this.getAny(s.name, s.cls, s.level);
  }

  /** 正文里「选所选技能专精」被抽取漏掉时补上 */
  applyProseComplement(ability: Json, feature: Json): Json {
    if (!feature) return ability;
    const text = (feature.entries || []).map((e: Json) => (typeof e === 'string' ? e : entryText(e))).join('\n');
    const extra = proseChoiceComplement(text, ability);
    if (!extra.length) return ability;
    return { ...ability, choices: (ability.choices || []).map((c: Json) => ({ ...c, alsoGrants: [...(c.alsoGrants || []), ...extra] })) };
  }

  findFeatureEntity(name: string, char: Json): Json {
    const d = this.env.store.data;
    const pools: Array<[Json[], string]> = [];
    for (const k of char?._resolved?.classes || []) pools.push([k.features || [], 'classFeature'], [k.subFeatures || [], 'subclassFeature']);
    pools.push([d.feats?.feat || [], 'feat'], [d.optionalfeatures?.optionalfeature || [], 'optfeature']);
    for (const [arr, kind] of pools) {
      const hit = arr.find((x) => x.name === name);
      if (hit) return { ...hit, _kind: kind };
    }
    return null;
  }

  featureEntry(name: string, from: string, char: Json): Json {
    const hr = this.hrFindByName(name, char);
    if (hr) {
      const txt = hr.text || '（这条家规没写说明）';
      return { text: `${hr.displayName}：${txt}`, name: hr.displayName, from, homerule: true, ref: null };
    }
    const ent = this.findFeatureEntity(name, char);
    if (!ent) return { text: `获得特性：${name}`, from, missing: true };
    const body = (ent.entries || []).filter((e: Json) => typeof e === 'string' || e?.type === 'entries' || e?.entries);
    const children: Json[] = [];
    for (const e of ent.entries || []) {
      if (e && typeof e === 'object' && e.name) children.push({ name: e.name, text: (e.entries || []).map(entryText).join(' ') });
    }
    return {
      text: `${name}：${body.map(entryText).join(' ').slice(0, 400)}`,
      name, from, children,
      ref: { kind: ent._kind || 'classFeature', target: name, src: ent.source },
    };
  }

  /** 授予的专长若自带选择（例如由种族多用给的「熟习」），把它的选择展开成待决定项 */
  expandGrantChain(char: Json, derived: Derived, depth = 0): void {
    if (depth > 0 || !derived.pending) return;
    const extra: Json[] = [];
    const asSource = new Set((char._resolved?.feats || []).map((f: Json) => f.name));
    for (const g of derived.feats) {
      if (asSource.has(g)) continue;
      const tgt = this.get('XPHB', g) || this.getAny(g);
      if (!tgt || !tgt.choices?.length) continue;
      const helper = (tgt.choices || []).find((c: Json) => c.pool === 'spellList');
      for (const c of tgt.choices) {
        const key = `expanded:${g}#${c.id}`;
        const dec = (char.decisions || {})[key];
        if (dec !== undefined && dec !== null && !(Array.isArray(dec) && !dec.length)) {
          const vals = Array.isArray(dec) ? dec : [dec];
          if (c.kind === 'skill') vals.forEach((v: string) => derived.skills.add(v));
          else if (c.kind === 'expertise') vals.forEach((v: string) => derived.expertise.add(v));
          else if (c.kind === 'language') vals.forEach((v: string) => derived.languages.add(v));
          else if (c.kind === 'tool') vals.forEach((v: string) => derived.tools.add(v));
          else if (c.kind === 'spell') vals.forEach((v: string) => derived.spells.add(v));
          else if (c.kind === 'cantrip') vals.forEach((v: string) => derived.cantrips.add(v));
        } else {
          extra.push({
            key, ability: g, from: g, expanded: true, ...c,
            ...(helper && helper.id !== c.id ? { _siblingSpellListKey: `expanded:${g}#${helper.id}` } : {}),
            label: `（由「${g}」引出）${c.label || ''}`,
          });
        }
      }
    }
    if (extra.length) derived.pending = derived.pending.concat(extra);
  }

  /** 「选了才有」的选项型特性（术师 / 卫士…）的名字 */
  optionFeatureNames(char: Json): Set<string> {
    const names = new Set<string>();
    for (const k of char._resolved?.classes || []) {
      for (const f of [...(k.features || []), ...(k.subFeatures || [])]) {
        for (const g of this.env.options.extract(f)) for (const n of g.classFeatures || []) names.add(String(n));
        const a = this.resolve({ source: f.source, name: f.name, kind: 'classFeature', cls: k.cls.name, level: f.level })
          || this.resolve({ source: f.source, name: f.name, kind: 'subclassFeature', cls: k.cls.name, level: f.level });
        for (const c of a?.choices || []) {
          if (c.pool !== 'classFeature') continue;
          for (const v of c.candidates || c.from || []) names.add(String(v));
        }
      }
    }
    return names;
  }

  /** 角色身上所有已生效能力的来源（种族、背景、专长、职业/子职特性、家规） */
  collectSources(char: Json): SourceSpec[] {
    const out: SourceSpec[] = [];
    const res = char._resolved || {};
    if (res.race) out.push({ source: res.race.source, name: res.race.name, kind: 'race' });
    if (res.background) out.push({ source: res.background.source, name: res.background.name, kind: 'background' });
    for (const f of res.feats || []) out.push({ source: f.source, name: f.name, kind: 'feat' });
    const opts = this.optionFeatureNames(char);
    const chosen = new Set<string>();
    for (const v of Object.values(char.decisions || {})) {
      for (const x of Array.isArray(v) ? v : [v]) if (typeof x === 'string' && x) chosen.add(x);
    }
    for (const k of res.classes || []) {
      for (const f of k.features || []) {
        if (opts.has(f.name) && !chosen.has(f.name)) continue;
        out.push({ source: f.source, name: f.name, kind: 'classFeature', cls: k.cls.name, level: f.level });
      }
      for (const f of k.subFeatures || []) {
        if (opts.has(f.name) && !chosen.has(f.name)) continue;
        out.push({ source: f.source, name: f.name, kind: 'subclassFeature', cls: k.cls.name, level: f.level });
      }
    }
    // 选出来的可选特性（魔能祈唤、战技、超魔法…）和专长一样是能力来源：静态 mods / 授予生效，战斗引擎也认得
    const optData: Json[] = this.env.store.data.optionalfeatures?.optionalfeature || [];
    for (const k of res.classes || []) {
      for (const c of [...this.env.options.forClass(k), ...this.env.options.forSubclass(k)]) {
        if (c.kind !== 'optfeature') continue;
        const v = (char.decisions || {})[this.env.options.optionKey(char, c)];
        for (const name of Array.isArray(v) ? v : v ? [v] : []) {
          if (typeof name !== 'string' || !name || out.some((x) => x.name === name)) continue;
          // 同名的 2014 / 2024 两版都在数据里：选项值只有名字，优先 2024 版
          const src = (optData.find((o) => o.name === name && o.source === 'XPHB') ?? optData.find((o) => o.name === name))?.source || 'XPHB';
          out.push({ source: src, name, kind: 'optfeature' });
        }
      }
    }
    this.ensureHomerules(char);
    // 可选的（pickable）家规：卡上选了才算（char.hrPicked 记 id）
    const picked = new Set<string>(Array.isArray(char.hrPicked) ? char.hrPicked : []);
    const hrList = this.homelibAll(char).filter((e) => e && (!e.pickable || picked.has(e.id)) && this.hrIdOK(e.id));
    const applied = new Set<string>();
    for (const e of hrList) {
      const a = this.hrTable[HR_SOURCE + ':' + e.id];
      const off = a && a._hrOffKey;
      if (off) {
        const i = out.findIndex((x) => sourceKeyOf(x) === off || `${x.source}:${x.name}` === off);
        if (i >= 0) out.splice(i, 1);
        // 战役 / 全服的覆盖只改有这项能力的卡（本卡的家规是自己加的，照加）
        else if (e._scope !== 'card') continue;
      }
      if (!out.some((x) => x.source === HR_SOURCE && x.name === e.id)) out.push(this.hrSpec(e));
      applied.add(e.id);
    }
    for (let i = out.length - 1; i >= 0; i--) if (out[i].source === HR_SOURCE && !applied.has(out[i].name)) out.splice(i, 1);
    return out;
  }

  /** ① 把 mods 送进计算上下文（必须在管线之前）；② 把派生的授予变成 effect */
  applyMods(ctx: CalcCtx): Json[] {
    const char = ctx.char;
    const applied: Json[] = [];
    for (const s of this.collectSources(char)) {
      const a = this.resolve(s);
      if (!a || !a.mods?.length) continue;
      for (const m of a.mods) {
        const h = this.kinds.get(m.kind);
        if (!h) continue;
        try { if (h.fn(ctx, m, a, s) !== false) applied.push({ ...s, kind: m.kind }); }
        catch (e) { this.env.log(`效果执行失败 ${s.name}/${m.kind}: ${(e as Error).message}`, 1); }
      }
    }
    ctx.set('_abilityMods', applied, 'abilities');
    const d: Derived | undefined = char._derived;
    if (d) {
      for (const s of d.skills) ctx.addEffect({ kind: 'skillProf', skill: s, source: 'ability-grant' });
      for (const s of d.expertise) ctx.addEffect({ kind: 'skillExp', skill: s, source: 'ability-grant' });
      for (const s of d.saves) ctx.addEffect({ kind: 'saveProf', ability: s, source: 'ability-grant' });
      for (const l of d.languages) ctx.addEffect({ kind: 'language', value: l, source: 'ability-grant' });
      for (const t of d.tools) ctx.addEffect({ kind: 'tool', value: t, source: 'ability-grant' });
      for (const m of d.masteries) ctx.addEffect({ kind: 'itemMastery', value: m, source: 'ability-grant' });
      for (const s of d.spells) ctx.addEffect({ kind: 'grantedSpell', value: s, source: 'ability-grant' });
      for (const s of d.cantrips) ctx.addEffect({ kind: 'grantedCantrip', value: s, source: 'ability-grant' });
      ctx.set('grantedSpells', [...new Set([
        ...ctx.pluck('grantedSpell').map((e) => e.value),
        ...ctx.pluck('grantedCantrip').map((e) => e.value),
      ])].map((n) => ({ name: n, from: (char._derived?.spellFrom || {})[n] || '' })), 'abilities');
      for (const f of d.feats) ctx.addEffect({ kind: 'grantedFeat', value: f, source: 'ability-grant' });
    }
    return applied;
  }

  /** 角色拥有的技能熟练 / 专精：自己选的 + 能力授予的 */
  effectiveSkills(c: Json) {
    const fromArray = (arr: unknown) => (Array.isArray(arr) ? arr.filter(Boolean) : []);
    const granted = (c && c._derived) || {};
    const own = [...new Set(fromArray(c && c.skillProf))];
    const ownExp = [...new Set(fromArray(c && c.skillExp))];
    const gProf = [...new Set(Array.from(granted.skills || []))];
    const gExp = [...new Set(Array.from(granted.expertise || []))];
    return {
      own, ownExp, granted: gProf, grantedExp: gExp,
      prof: [...new Set([...own, ...gProf])],
      exp: [...new Set([...ownExp, ...gExp])],
    };
  }

  /** 属性上限的来源（史诗恩惠等可到 30） */
  abilityCaps(c: Json): number[] {
    const out = new Set<number>();
    for (const s of this.collectSources(c)) {
      const a = this.resolve(s);
      for (const ch of a?.choices || []) {
        if (ch.kind !== 'ability' || ch.pick || !ch.cap) continue;
        out.add(Math.max(20, +ch.cap || 20));
      }
    }
    return [...out];
  }

  /** ② 从能力里推导出「应当获得的实体」与「需要做的决定」 */
  derive(char: Json): Derived {
    const out: Derived = {
      skills: new Set(), expertise: new Set(), saves: new Set(),
      languages: new Set(), tools: new Set(), feats: new Set(),
      spells: new Set(), cantrips: new Set(), masteries: new Set(),
      spellFrom: {},
      ac: [], resources: [], entries: [], pending: [],
    };
    const pending: Json[] = [];
    const decisions = char.decisions || {};
    for (const s of this.collectSources(char)) {
      let a = this.resolve(s);
      if (!a) continue;
      a = this.applyProseComplement(a, this.findFeatureEntity(s.name, char));
      const label = a.displayName || s.name;
      const srcName = s.name;
      const hrSeen = (out.hrSeen ||= new Set());
      const markHr = () => { if (s.source === HR_SOURCE) hrSeen.add(s.name); };
      for (const g of a.grants || []) {
        const vals = (g.values || []).filter((v: string) => v !== '*');
        if (g.values?.includes('*')) continue;
        const G: Record<string, () => void> = {
          skill: () => vals.forEach((v: string) => out.skills.add(v)),
          expertise: () => vals.forEach((v: string) => out.expertise.add(v)),
          save: () => vals.forEach((v: string) => out.saves.add(v)),
          language: () => vals.forEach((v: string) => out.languages.add(v)),
          tool: () => vals.forEach((v: string) => out.tools.add(v)),
          feat: () => vals.forEach((v: string) => out.feats.add(v)),
          spell: () => vals.forEach((v: string) => { out.spells.add(v); out.spellFrom[v] = label; }),
          cantrip: () => vals.forEach((v: string) => { out.cantrips.add(v); out.spellFrom[v] = label; }),
          itemMastery: () => vals.forEach((v: string) => out.masteries.add(v)),
          acFormula: () => out.ac.push({ ...(parseAcFormula(g.formula) || { base: 10, abils: [] }), raw: g.formula, ability: g.ability, from: label }),
          classFeature: () => vals.forEach((n: string) => out.entries.push(this.featureEntry(n, label, char))),
          subclass: () => out.entries.push({ text: `获得子职：${vals.join('、')}`, from: label }),
          custom: () => out.entries.push({ text: g.text, from: label }),
          note: () => out.entries.push({ text: g.text || '', from: label, note: true }),
        };
        (G[g.kind] || (() => out.entries.push({ text: `（未支持的能力授予类型：${g.kind}）`, from: label })))();
        if (['skill', 'expertise', 'save', 'language', 'tool', 'feat', 'spell', 'cantrip', 'itemMastery', 'classFeature', 'subclass', 'custom', 'note'].includes(g.kind)) markHr();
      }
      for (const r of a.resources || []) out.resources.push({ ...r, from: srcName, cls: s.cls });
      for (const c of a.choices || []) {
        const owner = [s.source, s.cls, s.name, (s.level ?? '')].filter((x) => x !== undefined && x !== null && x !== '').join(':');
        const key = `${owner}#${c.id}`;
        const dec = decisions[key];
        const undecided = !decisionComplete(c, dec);
        pending.push({ key, ability: s.name, _abilityKey: `${s.source}:${s.name}`, from: label, ...c, decided: !undecided });
        if (!undecided) {
          const vals = Array.isArray(dec) ? dec : [dec];
          if (!applyChoiceGrant(c, vals, out, label)) {
            out.entries.push({ text: `${c.label || c.id}：${vals.join('、')}`, from: label, unresolved: c.kind });
          }
        }
      }
    }
    // 种族正文里「再给一个起源专长」的句式（人类「多用」）
    {
      const res2 = char._resolved || {};
      const raceFeatTexts: Array<{ name: string; text: string }> = [];
      for (const e of res2.race?.entries || []) {
        if (e && e.name && e.entries) raceFeatTexts.push({ name: e.name, text: JSON.stringify(e.entries) });
      }
      for (const rf of raceFeatTexts) {
        if (!/起源专长/.test(rf.text)) continue;
        if (!/(获得|选择)一项[^。"]{0,10}(自选|你选择)的?[^。"]{0,6}起源专长/.test(rf.text) && !/自选的[^。"]{0,10}起源专长/.test(rf.text)) continue;
        const key = `${res2.race.source}:${res2.race.name}#race-${rf.name}-originFeat`;
        const dec = (char.decisions || {})[key];
        const undecided = !decisionComplete({ count: 1 }, dec);
        pending.push({
          key, ability: res2.race.name, kind: 'feat', count: 1, pool: 'originFeat',
          from: `${res2.race.name}「${rf.name}」`,
          label: `${rf.name}：再选一项起源专长`, decided: !undecided, expanded: true, raceExtra: true,
        });
        if (!undecided) {
          const vals = Array.isArray(dec) ? dec : [dec];
          vals.forEach((v: string) => out.feats.add(v));
        }
      }
    }
    out.pending = pending;
    {
      const seen = out.hrSeen || new Set<string>();
      for (const s of this.collectSources(char)) {
        if (s.source !== HR_SOURCE || seen.has(s.name)) continue;
        const row = this.hrEntryRow(this.resolve(s));
        if (row) out.entries.push(row);
      }
    }
    this.expandGrantChain(char, out);
    for (const k of char._resolved?.classes || []) {
      for (const c of this.env.options.forClass(k)) out.pending.push({ ...c, expanded: true, _src: 'featureOptions', key: this.env.options.optionKey(char, c) });
      for (const c of this.env.options.forSubclass(k)) out.pending.push({ ...c, expanded: true, _src: 'featureOptions', key: this.env.options.optionKey(char, c) });
      for (const c of this.env.options.proseForClass(k)) out.pending.push({ ...c, expanded: true, _src: 'prose', key: this.env.options.optionKey(char, c) });
      for (const c of this.env.options.proseForSubclass(k)) out.pending.push({ ...c, expanded: true, _src: 'prose', key: this.env.options.optionKey(char, c) });
    }
    {
      const dec = char.decisions || {};
      for (const p of out.pending) {
        if (p.key === undefined) continue;
        const v = dec[p.key];
        const undecided = !decisionComplete(p, v);
        p.decided = !undecided;
        if (undecided) continue;
        const vals = Array.isArray(v) ? v : [v];
        applyChoiceGrant(p, vals, out, p.from || p.ability || '');
        if (p.kind === 'classFeature' || p.kind === 'optfeature') {
          for (const nm of vals) out.entries.push(this.featureEntry(nm, p.from, char));
        } else {
          for (const nm of vals) out.entries.push({ text: `${p.label || p.id}：${nm}`, from: p.from, note: true });
        }
      }
    }
    out.grantedCandidates = this.env.options.grantedCandidates(char._resolved);
    return out;
  }
}
