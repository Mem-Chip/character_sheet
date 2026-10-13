/**
 * 移植版 vs 原项目（参照实现）逐项对比。
 * 夹具由 `npm run oracle` 生成（tests/fixtures/oracle/*.json）；数据要先 `npm run fetch:data`。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { blankCharacter, normalizeSheet, normalizeValue, type SheetEnv } from '../../src/sheet';
import { createNodeEnv } from '../../src/sheet/node-env';
import { hasLocalData } from '../../src/sheet/node-provider';

const FIX = resolve(import.meta.dirname, '..', 'fixtures');
const chars = JSON.parse(readFileSync(resolve(FIX, 'chars.json'), 'utf8')) as Array<{ id: string; note: string; char: object }>;
const oracle = (id: string) => JSON.parse(readFileSync(resolve(FIX, 'oracle', `${id}.json`), 'utf8'));

/** 列出两边不一样的路径（比一个大 toEqual 好读得多） */
export function diffPaths(a: unknown, b: unknown, path = '', out: string[] = [], limit = 30): string[] {
  if (out.length >= limit) return out;
  if (JSON.stringify(a) === JSON.stringify(b)) return out;
  if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
    const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
    for (const k of keys) diffPaths((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], path ? `${path}.${k}` : k, out, limit);
    return out;
  }
  out.push(`${path || '(根)'}：移植版 ${JSON.stringify(a)?.slice(0, 160)} ≠ 原项目 ${JSON.stringify(b)?.slice(0, 160)}`);
  return out;
}

describe.skipIf(!hasLocalData())('静态层与原项目逐项一致', () => {
  let env: SheetEnv;
  beforeAll(async () => { env = await createNodeEnv(); });

  for (const fx of chars) {
    it(`${fx.id}：${fx.note}`, async () => {
      const char = { ...blankCharacter(), ...structuredClone(fx.char) };
      const sheet = await env.compute(char);
      const want = oracle(fx.id);
      const slots = env.feats.slots(char, char._resolved);
      const extras = {
        featSlots: slots,
        featAssign: env.feats.assign((await import('../../src/sheet')).featNames(char), slots),
        featCandidates: Object.fromEntries(['O', 'G', 'FS', 'EB'].map((cat) => [
          cat,
          env.feats.candidates(cat, sheet, char).map((x) => `${x.feat.name}:${x.ok ? 'ok' : x.reasons.join('/')}`),
        ])),
        masteryAllowance: env.mastery.allowance(char),
        skillBudget: env.classSkillBudget(char),
        wildShape: env.wildShape.limits(char),
        unlocks: env.unlocks.all(char),
      };
      const got = {
        sheet: normalizeSheet(sheet),
        extras: normalizeValue(extras),
        char: normalizeValue(Object.fromEntries(Object.entries(char).filter(([k]) => !k.startsWith('_')))),
      };
      const diffs = diffPaths(got, { sheet: want.sheet, extras: want.extras, char: want.char });
      expect(diffs, diffs.join('\n')).toEqual([]);
    });
  }
});
