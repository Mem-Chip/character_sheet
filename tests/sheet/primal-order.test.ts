// 德鲁伊「原初职能」：术师 / 卫士 二选一，只有选了的那个生效
// 官方原文：术师 = 额外德鲁伊戏法 + 智力（奥秘**或**自然）检定加感知调整值（最小 +1）
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createNodeEnv } from '../../src/sheet/node-env';
import { hasLocalData } from '../../src/sheet/node-provider';
import type { CharData, Json, SheetEnv } from '../../src/sheet';

const FIX = JSON.parse(readFileSync('tests/fixtures/chars.json', 'utf8')) as Array<{ id: string; char: CharData }>;
const DECISION = 'XPHB:德鲁伊:原初职能:1#featopt-原初职能-0';

describe.skipIf(!hasLocalData())('德鲁伊：原初职能（术师 / 卫士）', () => {
  let env: SheetEnv;
  beforeAll(async () => {
    env = await createNodeEnv();
    await env.store.ensureMany(['races', 'backgrounds', 'feats', 'items', 'itemsBase']);
  });
  const sheetOf = async (pick: string | null) => {
    const c = structuredClone(FIX.find((f) => f.id === 'sample-druid2')!.char);
    const decisions = { ...((c as Json).decisions as Json) };
    if (pick) decisions[DECISION] = [pick];
    else delete decisions[DECISION];
    (c as Json).decisions = decisions;
    return (await env.compute(c)) as Json;
  };
  const bonus = (s: Json, skill: string) => Number(((s.skills as Json)[skill] as Json)?.bonus ?? 0);

  it('选术师：奥秘和自然都加感知调整值（最小 +1），而且只加一次', async () => {
    const s = await sheetOf('术师');
    const wis = Number(s['mod:wis']);
    const want = Math.max(1, wis);
    expect(bonus(s, 'nature'), '自然').toBe(want);
    expect(bonus(s, 'arcana'), '奥秘').toBe(want);
    // 双重计算会变成 2×
    expect(bonus(s, 'nature')).toBeLessThanOrEqual(want);
    // 术师不应当带来卫士的护甲/武器熟练
    expect(s.armorProfs as string[], '术师不该有中甲').not.toContain('中甲');
    expect(s.weaponProfs as string[], '术师不该有军用').not.toContain('军用');
  });

  it('选卫士：中甲 + 军用武器熟练，技能不吃术师那份加值', async () => {
    const s = await sheetOf('卫士');
    expect(s.armorProfs as string[], '应该有中甲熟练').toContain('中甲');
    expect(s.weaponProfs as string[], '应该有军用武器熟练').toContain('军用');
    expect(bonus(s, 'nature'), '卫士不给技能加值').toBe(0);
    expect(bonus(s, 'arcana')).toBe(0);
  });

  it('没选：两个都不生效', async () => {
    const s = await sheetOf(null);
    expect(bonus(s, 'nature')).toBe(0);
    expect(s.armorProfs as string[], '没选就没有中甲').not.toContain('中甲');
  });
});

