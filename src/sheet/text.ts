/** 5etools 正文的小工具（移植自原项目 core/plugins.js 的 entryText 与 rules/items.js 的正文句式识别） */
import { SKILLS } from './constants';

/* eslint-disable @typescript-eslint/no-explicit-any */

export function entryText(e: any): string {
  if (e == null) return '';
  if (typeof e === 'string') return e;
  if (Array.isArray(e)) return e.map(entryText).join(' ');
  if (e.entries) return (e.name ? e.name + '：' : '') + e.entries.map(entryText).join(' ');
  if (e.items) return (e.name ? e.name + '：' : '') + e.items.map(entryText).join('；');
  return e.name || '';
}

const stripTags = (text: unknown) => String(text || '').replace(/\{@\w+\s+([^}|]+)(?:\|[^}]*)?\}/g, '$1');

/** 正文里按出现顺序提到的技能 */
export function proseSkillMentions(text: unknown): Array<{ key: string; cn: string; at: number }> {
  const out: Array<{ key: string; cn: string; at: number }> = [];
  const src = stripTags(text);
  for (const [key, cn] of SKILLS) {
    const i = src.indexOf(cn);
    if (i >= 0) out.push({ key, cn, at: i });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** 能力数据的选择漏了「并获得所选技能的专精」这半句时，从正文补一个 alsoGrants */
export function proseChoiceComplement(text: unknown, ability: any): Array<{ kind: string }> {
  const out: Array<{ kind: string }> = [];
  const t = stripTags(text);
  if (!ability || !(ability.choices || []).length) return out;
  if ((ability.choices || []).some((c: any) => c.kind === 'expertise')) return out;
  if (/所选[^。]{0,8}(技能)?[^。]{0,6}专精/.test(t) || /获得所选[^。]{0,10}专精/.test(t)) {
    out.push({ kind: 'expertise' });
  }
  return out;
}

/** 「选择两项你熟练的技能，获得专精」这种句式 → 一个专精选择 */
export function proseExpertiseChoice(text: unknown): any {
  const t = stripTags(text);
  if (!/专精/.test(t)) return null;
  const m = t.match(/选择\s*(一|两|二|三|四)\s*项/);
  if (!m) return null;
  const count = ({ 一: 1, 两: 2, 二: 2, 三: 3, 四: 4 } as Record<string, number>)[m[1]] || 1;
  const iSel = m.index!;
  const iProf = t.indexOf('熟练', iSel);
  if (iProf < 0 || iProf - iSel > 20) return null;
  if (t.indexOf('专精', iProf) < 0 && t.indexOf('专精') < iSel) return null;
  const skills = proseSkillMentions(t);
  if (!skills.length) return null;
  return {
    id: 'prose-expertise',
    kind: 'expertise',
    count,
    pool: 'profSkill',
    prose: true,
    mentions: skills.map((s) => s.cn),
    label: `选 ${count} 项已熟练的技能获得专精（${skills.map((s) => s.cn).join('、')}）`,
  };
}
