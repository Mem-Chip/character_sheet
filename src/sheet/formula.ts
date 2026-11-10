/**
 * 卡面上的算式：**只有这一处求值**（修正的加值、资源池上限都走这里）。
 *
 * 算式用表达式语言（src/expr），和战斗层是同一套语法。能用的名字：
 *   level（给了职业 = 该职业的等级，否则总等级）、totalLevel、pb、mod.str…mod.cha、
 *   裸属性名 str…cha（= 该属性调整值）、self.spell.mod（施法属性调整值）；
 *   函数 max / min / floor / ceil / cond(条件, 是, 否) / levelOf('职业')。
 *
 * 原项目留下的旧写法在求值前先规范化成表达式（`normalizeFormula`），数据不用改：
 *   'mod:wis' → mod.wis、'spellcasting' → self.spell.mod、「感知调整值」→ mod.wis、「职业等级」→ level。
 * 以前这件事有三处各做一遍（resolveNum、资源公式的正则、资源公式的表达式），写法稍微组合一下就算不出来。
 */
import { ABILS, compile, fromLegacy, run, type EvalEnv, type FnImpl } from '../expr';
import type { Json } from './store';

export interface FormulaScope {
  /** 算到一半的卡面结果：`mod:str`…、`pb`、`level` 从这里取 */
  sheet: Json;
  char: Json;
  /** 这条算式属于哪个职业（资源池）：`level` 就是该职业的等级 */
  cls?: string;
}

const ABIL_CN_RE = /(力量|敏捷|体质|智力|感知|魅力)调整值?/g;
const CN_ABIL: Record<string, string> = { 力量: 'str', 敏捷: 'dex', 体质: 'con', 智力: 'int', 感知: 'wis', 魅力: 'cha' };

const parses = (src: string): boolean => {
  try { compile(src); return true; } catch { return false; }
};

const normCache = new Map<string, string | null>();

/**
 * 旧写法 → 表达式源码；认不出来（不是算式）返回 null。
 * 先把夹在算式里的旧词换掉（`max(1,智力调整值)`），整句还解析不了的再按「一句散文里提到哪个属性」处理（「感知调整值（最少1次）」）。
 */
export function normalizeFormula(v: unknown): string | null {
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : null;
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s) return null;
  // 纯数字（'3'、'+2'、'2.5'）：表达式语言没有一元加号，这里直接认
  if (Number.isFinite(Number(s))) return String(Number(s));
  const hit = normCache.get(s);
  if (hit !== undefined) return hit;
  const swapped = s
    .replace(/\bmod:spellcasting\b/g, 'self.spell.mod')
    .replace(/\bmod:(str|dex|con|int|wis|cha)\b/g, 'mod.$1')
    .replace(/^spellcasting$/, 'self.spell.mod')
    .replace(ABIL_CN_RE, (_, cn: string) => `mod.${CN_ABIL[cn]}`)
    .replace(/职业等级/g, 'level')
    .replace(/，/g, ',').replace(/（/g, '(').replace(/）/g, ')');
  const out = parses(swapped) ? swapped : fromLegacy(s);
  normCache.set(s, out);
  return out;
}

const totalLevelOf = (char: Json): number => (char?.classes || []).reduce((a: number, k: Json) => a + (+k.level || 0), 0);

/** 算一条算式。算不出来（不是算式、引用了不认识的名字、结果不是数，比如骰子）返回 null */
export function evalFormula(v: unknown, scope: FormulaScope): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const src = normalizeFormula(v);
  if (src === null) return null;
  const { sheet, char, cls } = scope;
  const classes: Json[] = char?._resolved?.classes || [];
  const total: number = sheet?.level || totalLevelOf(char);
  const levelOf = (name: string): number => classes.find((k) => k.cls?.name === name)?.level ?? 0;
  const mod = Object.fromEntries(ABILS.map((a) => [a, sheet?.['mod:' + a] || 0]));
  const fns: Record<string, FnImpl> = {
    max: (a) => Math.max(...(a as number[])),
    min: (a) => Math.min(...(a as number[])),
    floor: (a) => Math.floor(a[0] as number),
    ceil: (a) => Math.ceil(a[0] as number),
    cond: (a) => (a[0] ? a[1] : a[2]),
    levelOf: (a) => levelOf(String(a[0])),
  };
  const env: EvalEnv = {
    root(name) {
      if (name === 'level') return cls ? levelOf(cls) || total : total;
      if (name === 'totalLevel') return total;
      if (name === 'pb') return sheet?.pb ?? 2 + Math.floor((Math.max(1, total) - 1) / 4);
      if (name === 'mod') return mod;
      if ((ABILS as readonly string[]).includes(name)) return mod[name];
      if (name === 'self') {
        // 施法属性：第一个会施法的职业的那项
        const ab = classes.find((k) => k.cls?.spellcastingAbility)?.cls.spellcastingAbility;
        return { spell: { mod: ab ? mod[ab] ?? 0 : 0 } };
      }
      throw new Error(`算式里不认识「${name}」`);
    },
    fn: (name) => fns[name],
  };
  try {
    const out = run(src, env);
    return typeof out === 'number' && Number.isFinite(out) ? out : null;
  } catch {
    return null;
  }
}
