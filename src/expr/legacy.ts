/**
 * 旧写法 → 表达式。
 *
 * 原项目的 `resolveNum`（core/plugins.js）认这些写法：数字、`'pb'`、`'level'`、
 * 裸属性名 `'wis'`（= 该属性调整值）、`'mod:wis'`、`'spellcasting'` / `'mod:spellcasting'`、
 * 以及中文散文「魅力调整值」「你的魅力调整值」。
 *
 * 新语言**不解析中文散文**（COMBAT-DESIGN §2.7）—— 散文在这里一次性规范化成表达式，
 * 规范化之后的数据才进库。`abilities-2024.json` 里的旧数据就走这条路。
 */

export const ABILS = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const;
export type Ability = (typeof ABILS)[number];

export const ABIL_CN: Record<Ability, string> = { str: '力量', dex: '敏捷', con: '体质', int: '智力', wis: '感知', cha: '魅力' };
export const ABIL_WORD: Record<string, Ability> = { 力量: 'str', 敏捷: 'dex', 体质: 'con', 智力: 'int', 感知: 'wis', 魅力: 'cha' };

export const isAbility = (s: unknown): s is Ability => typeof s === 'string' && (ABILS as readonly string[]).includes(s);

/** 返回等价的表达式源码；认不出来返回 null（调用方应当报错，而不是静默当成 0） */
export function fromLegacy(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s) return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return s;
  if (s === 'pb' || s === 'level') return s;
  if (isAbility(s)) return `mod.${s}`;
  if (s === 'spellcasting' || s === 'mod:spellcasting') return 'self.spell.mod';
  const m = /^mod:(\w+)$/.exec(s);
  if (m && isAbility(m[1])) return `mod.${m[1]}`;
  if (/调整值|调整/.test(s)) {
    for (const [cn, en] of Object.entries(ABIL_WORD)) if (s.includes(cn)) return `mod.${en}`;
  }
  return null;
}
