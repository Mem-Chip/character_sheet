/**
 * 角色快照：一个角色算出来的全部结果（SHEET + 专长槽等附加结果 + 计算后的角色数据），归一化成纯 JSON。
 * 快照测试与 `npm run snapshots` 共用它。
 */
import { blankCharacter, featNames, type CharData } from './character';
import type { SheetEnv } from './env';
import { normalizeSheet, normalizeValue } from './normalize';

export async function snapshotOf(env: SheetEnv, input: object): Promise<{ sheet: unknown; extras: unknown; char: unknown }> {
  const char: CharData = { ...blankCharacter(), ...structuredClone(input) };
  const sheet = await env.compute(char);
  const slots = env.feats.slots(char, char._resolved);
  const extras = {
    featSlots: slots,
    featAssign: env.feats.assign(featNames(char), slots),
    featCandidates: Object.fromEntries(['O', 'G', 'FS', 'EB'].map((cat) => [
      cat,
      env.feats.candidates(cat, sheet, char).map((x) => `${x.feat.name}:${x.ok ? 'ok' : x.reasons.join('/')}`),
    ])),
    masteryAllowance: env.mastery.allowance(char),
    skillBudget: env.classSkillBudget(char),
    wildShape: env.wildShape.limits(char),
    unlocks: env.unlocks.all(char),
  };
  return {
    sheet: normalizeSheet(sheet),
    extras: normalizeValue(extras),
    char: normalizeValue(Object.fromEntries(Object.entries(char).filter(([k]) => !k.startsWith('_')))),
  };
}

/** 列出两份 JSON 不一样的路径（比一个大 toEqual 好读） */
export function diffPaths(a: unknown, b: unknown, path = '', out: string[] = [], limit = 30): string[] {
  if (out.length >= limit) return out;
  if (JSON.stringify(a) === JSON.stringify(b)) return out;
  if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
    const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
    for (const k of keys) diffPaths((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], path ? `${path}.${k}` : k, out, limit);
    return out;
  }
  out.push(`${path || '(根)'}：现在 ${JSON.stringify(a)?.slice(0, 160)} ≠ 快照 ${JSON.stringify(b)?.slice(0, 160)}`);
  return out;
}
