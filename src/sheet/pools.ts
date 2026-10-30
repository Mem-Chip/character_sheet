/**
 * 选择池：给「待决定」项列出候选（移植自原项目 ui/search.js 的 resolvePool 与相关小函数）。
 * 原实现读全局 CHAR / SHEET / Store，这里全部改成参数。
 *
 * 返回值里带 `empty` 说明：空池要说清楚是哪一种空（还没选法术列表 / 法术数据没装 / 数据里真没有），
 * 不能让玩家看到一个空下拉框自己猜。
 */
import { ABILS, ABIL_CN, SKILLS } from './constants';
import type { CharData } from './character';
import type { SheetEnv } from './env';
import { Source, subclassCandidates, subclassLabel } from './source';
import type { Json } from './store';

export interface PoolOption {
  value: string;
  label: string;
}

export interface PoolResult {
  options: PoolOption[];
  /** 空池的原因（有候选时为 undefined） */
  empty?: '先选法术列表' | '法术数据还没装载' | '缺少学派' | '没有可选项';
}

const pickFirst = (dec: unknown): string | null => (dec == null ? null : Array.isArray(dec) ? (dec[0] ?? null) : String(dec));

/** 某个决策当前的值（兼容 `expanded:` 前缀的旧键） */
export function decisionValue(char: CharData, key: string): string | null {
  const dec = (char.decisions || {})[key];
  if (dec != null) return pickFirst(dec);
  const m = /^([^:]+):([^#]+)#(.+)$/.exec(key);
  if (m) return pickFirst(char.decisions?.[`expanded:${m[2]}#${m[3]}`]);
  return null;
}

/** 「先选法术列表，再从列表里选法术」：找到同一能力里那条选列表的决策键 */
export function siblingSpellListKey(env: SheetEnv, choice: Json): string | null {
  if (choice._siblingSpellListKey) return choice._siblingSpellListKey;
  const abilKey = choice._abilityKey;
  if (!abilKey) return null;
  const abil = env.abilities.resolve({ source: abilKey.split(':')[0], name: abilKey.slice(abilKey.indexOf(':') + 1), kind: 'feat' });
  const helper = (abil?.choices || []).find((c: Json) => c.pool === 'spellList');
  if (!helper) return null;
  // 决策键前缀与 derive 里生成的一致：<source>:<名字>#<id>
  return `${abilKey}#${helper.id}`;
}

export function spellSourcesReady(env: SheetEnv): boolean { return !!env.store.data.spellsSources?.XPHB; }

/** 法术是否在某职业的法术列表里（spells/sources.json 是权威，条目自带的 class 兜底） */
export function spellInClassList(env: SheetEnv, spell: Json, className: string): boolean {
  // 资料库单独覆盖过这一条：就让它能选（书没启用也算 —— 是玩家自己导进来的）
  if (Source.isCovered(spell)) return true;
  const d = env.store.data;
  const has = (list: Json[] | undefined) => (list || []).some((c) => (typeof c === 'string' ? c : c?.name) === className);
  if (has(d.spellsSources?.XPHB?.[spell.name]?.class)) return true;
  for (const v of Object.values(d.spellsSources || {})) if (has((v as Json)?.[spell.name]?.class)) return true;
  // 别的书加到职业列表里的（classVariant，比如 XGE 给法师加的）：那本书启用了才算
  for (const v of Object.values(d.spellsSources || {})) {
    if (has(((v as Json)?.[spell.name]?.classVariant || []).filter((c: Json) => Source.extra.has(String(c?.definedInSource || '').toUpperCase())))) return true;
  }
  return has(spell.class);
}

/** 某职业法术列表里的法术（可限定环阶） */
export function classSpells(env: SheetEnv, className: string, opts: { level?: number; maxLevel?: number } = {}): Json[] {
  return env.store.spellsAll
    .filter((s: Json) => (opts.level === undefined || s.level === opts.level) && (opts.maxLevel === undefined || s.level <= opts.maxLevel))
    .filter((s: Json) => spellInClassList(env, s, className))
    .sort((a: Json, b: Json) => a.level - b.level || String(a.name).localeCompare(String(b.name), 'zh'));
}

/** 5etools 的 choose 过滤串：`level=0;1;2|class=法师|school=C` */
export function parseChoose(s: string): { levels: number[]; cls?: string; school?: string } {
  const out: { levels: number[]; cls?: string; school?: string } = { levels: [] };
  for (const part of String(s || '').split('|')) {
    const [k, v] = part.split('=');
    if (!k || v === undefined) continue;
    if (k.trim() === 'level') out.levels = v.split(';').map((x) => Number(x)).filter((n) => Number.isFinite(n));
    else if (k.trim() === 'class') out.cls = v.trim();
    else if (k.trim() === 'school') out.school = v.trim();
  }
  return out;
}

/** 一条职业特性给什么（候选后面跟一句摘要，让人看得出两个选项差在哪） */
export function abilitySummary(env: SheetEnv, name: string, k: Json): string {
  const feat = [...(k?.features || []), ...(k?.subFeatures || [])].find((f: Json) => f.name === name);
  const a = env.abilities.resolve({ source: feat?.source || k?.cls?.source, name, kind: 'classFeature', cls: k?.cls?.name, level: feat?.level ?? null })
    || env.abilities.resolve({ source: k?.cls?.source, name, kind: 'subclassFeature', cls: k?.cls?.name, level: feat?.level ?? null });
  if (!a) return '';
  const bits: string[] = [];
  for (const m of a.mods || []) {
    if (m.kind === 'note') continue;
    const label = env.abilities.kinds.get(m.kind)?.describe || m.kind;
    const vals = (m.values || []).join('、');
    bits.push(vals ? `${vals}${label}` : label);
  }
  for (const g of a.grants || []) if (g.kind !== 'note') bits.push((g.values || []).join('、') || g.kind);
  if ((a.choices || []).length && !bits.length) bits.push('需要选一项');
  if ((a.resources || []).length) bits.push((a.resources || []).map((r: Json) => r.name).join('、'));
  return bits.slice(0, 4).join('、');
}

/** 一条待决定项的候选 */
export function choiceOptions(env: SheetEnv, char: CharData, sheet: Json, choice: Json): PoolResult {
  const ok = (options: PoolOption[]): PoolResult => (options.length ? { options } : { options, empty: '没有可选项' });
  const d = env.store.data;

  if (choice.kind === 'ability') {
    return ok((Array.isArray(choice.from) ? choice.from : ABILS).map((a: string) => ({ value: a, label: ABIL_CN[a as keyof typeof ABIL_CN] || a })));
  }
  if (choice.kind === 'optfeature' && choice.pool !== 'inline') {
    return ok(env.optional.options(choice).map((o) => ({ value: o.name, label: o.name })));
  }
  if (choice.pool === 'subclassSpell') {
    // `{ choose: 'level=0;1;2|class=法师|school=C' }`：子职让你从过滤后的法术列表里选
    const f = parseChoose(String(choice.choose ?? ''));
    const lv = f.levels.length ? f.levels : [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    const list = classSpells(env, f.cls ?? '法师', { maxLevel: Math.max(...lv) })
      .filter((s: Json) => lv.includes(s.level) && (!f.school || s.school === f.school));
    return ok(list.map((s: Json) => ({ value: String(s.name), label: `${String(s.name)}（${s.level} 环）` })));
  }
  if (Array.isArray(choice.candidates) && choice.candidates.length) {
    return ok(choice.candidates.map((v: string) => {
      if (choice.pool !== 'classFeature') return { value: v, label: v };
      const k = (char._resolved?.classes || []).find((x: Json) => [...(x.features || []), ...(x.subFeatures || [])].some((f: Json) => f.name === v));
      const sum = k ? abilitySummary(env, v, k) : '';
      return { value: v, label: v + (sum ? `（${sum}）` : '') };
    }));
  }
  if (choice.pool === 'whitelist' && Array.isArray(choice.whitelist)) return ok(choice.whitelist.map((v: string) => ({ value: v, label: v })));

  const skills = () => SKILLS.map(([k, cn]) => ({ value: k, label: cn }));
  const baseItems = (pre: string) => (d.itemsBase?.baseitem || []).filter((x: Json) => String(x.type).startsWith(pre) && Source.is2024(x))
    .map((x: Json) => ({ value: x.name, label: x.name }));
  // 城主指南里标了年代（现代 / 未来）的枪不列；玩家手册本身的手枪、滑膛枪照列
  const masteryWeapons = () => env.store.weapons2024.filter((x) => x.mastery?.length && !x.age).map((x) => ({ value: x.name, label: x.name }));
  switch (choice.pool) {
    case 'skill': return ok(skills());
    case 'originFeat':
      return ok(env.feats.pool()
        .filter((f) => Source.isCore2024(f) && env.feats.catOf(f).includes('O'))
        .sort((a, b) => a.name.localeCompare(b.name, 'zh'))
        .map((f) => ({ value: f.name, label: f.name })));
    case 'skillOrTool': return ok([...skills(), ...baseItems('AT').map((x: PoolOption) => ({ ...x, label: x.label + '（工具）' }))]);
    case 'profSkill':
    case 'anyProfSkill': {
      const set: Set<string> = sheet?.skillProfSet || new Set();
      return ok(skills().filter((s) => set.has(s.value)));
    }
    case 'instrument': return ok(env.tools.items('instrument').map((x) => ({ value: x.name, label: x.name })));
    case 'artisan': return ok(env.tools.items('artisan').map((x) => ({ value: x.name, label: x.name })));
    case 'tool': return ok(env.tools.items('anyTool').map((x) => ({ value: x.name, label: x.name })));
    case 'language': return ok(env.languages.list().map((l) => ({ value: l.name, label: l.name })));
    // 武器精通的选择（数据里写的 pool: weapon）也按精通列表走，不然会列出激光步枪这类枪械
    case 'weapon': return ok(choice.kind === 'itemMastery' ? masteryWeapons() : env.store.weapons2024.map((x) => ({ value: x.name, label: x.name })));
    case 'weaponMastery': return ok(masteryWeapons());
    case 'subclass': {
      const out: PoolOption[] = [];
      for (const k of char._resolved?.classes || []) {
        for (const s of subclassCandidates(k.allSubclasses, k.cls?.source)) out.push({ value: s.name, label: subclassLabel(s) });
      }
      return ok(out);
    }
    case 'classFeature': {
      const out: PoolOption[] = [];
      for (const k of char._resolved?.classes || []) {
        for (const f of [...(k.features || []), ...(k.subFeatures || [])]) {
          const sum = abilitySummary(env, f.name, k);
          out.push({ value: f.name, label: f.name + (sum ? `（${sum}）` : '') });
        }
      }
      return ok(out);
    }
    case 'cleric':
    case 'druid': {
      if (!spellSourcesReady(env)) return { options: [], empty: '法术数据还没装载' };
      return ok(classSpells(env, choice.pool === 'cleric' ? '牧师' : '德鲁伊', { level: 0 }).map((s) => ({ value: s.name, label: s.name })));
    }
    case 'spellList': return ok(['牧师', '德鲁伊', '法师'].map((v) => ({ value: v, label: v })));
    case 'byClass':
    case 'byClassL1': {
      const listKey = siblingSpellListKey(env, choice);
      const listName = listKey ? decisionValue(char, listKey) : null;
      if (!listName) return { options: [], empty: '先选法术列表' };
      if (!spellSourcesReady(env)) return { options: [], empty: '法术数据还没装载' };
      return ok(classSpells(env, listName, { level: choice.pool === 'byClassL1' ? 1 : 0 }).map((s) => ({ value: s.name, label: s.name })));
    }
    case 'spellBySchool': {
      if (!spellSourcesReady(env)) return { options: [], empty: '法术数据还没装载' };
      if (!choice.school) return { options: [], empty: '缺少学派' };
      const cap = choice.cap ?? 2;
      return ok(classSpells(env, choice.cls || '法师', { maxLevel: cap })
        .filter((s) => s.school === choice.school && s.level >= 1)
        .map((s) => ({ value: s.name, label: `${s.name}（${s.level} 环）` })));
    }
    default:
      if (Array.isArray(choice.from)) return ok(choice.from.map((v: string) => ({ value: v, label: ABIL_CN[v as keyof typeof ABIL_CN] || v })));
      return { options: [], empty: '没有可选项' };
  }
}

/* ---------------- 建卡的小规则 ---------------- */

export const STANDARD_ARRAY: Record<string, number> = { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 };

/** 购点花费（2024：27 点，8–15） */
export function pointBuyCost(ab: Record<string, number>): number {
  const TABLE: Record<number, number> = { 8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9 };
  const cost = (v: unknown) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    if (n < 8) return TABLE[8];
    if (n > 15) return TABLE[15];
    return TABLE[Math.floor(n)] ?? 0;
  };
  return ABILS.reduce((a, k) => a + cost(ab[k]), 0);
}

/** 背景可以加值的属性（2024 背景都列了三项） */
export function backgroundBonusFrom(bg: Json): string[] {
  for (const a of bg?.ability || []) {
    const c = a.choose;
    if (c?.weighted?.from) return c.weighted.from;
    if (Array.isArray(c?.from)) return c.from;
  }
  return [...ABILS];
}

/** 背景给的起源专长（`魔法学徒；牧师|xphb` → 名字 + 锁定的法术列表） */
export function backgroundOriginFeat(bg: Json): { name: string; lockList: string | null } | null {
  for (const o of bg?.feats || []) {
    for (const k of Object.keys(o)) {
      const [nm, list] = String(k).split('；');
      return { name: nm.split('|')[0], lockList: list ? list.split('|')[0] : null };
    }
  }
  return null;
}
