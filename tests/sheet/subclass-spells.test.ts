// 子职「选法术」（咒法师 AU 的咒法系法术）：待决定项 + 选完进「始终准备」
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createNodeEnv } from '../../src/sheet/node-env';
import { hasLocalData } from '../../src/sheet/node-provider';
import { choiceOptions } from '../../src/sheet/pools';
import type { CharData, Json, SheetEnv } from '../../src/sheet';

const FIXTURES = JSON.parse(readFileSync('tests/fixtures/chars.json', 'utf8')) as Array<{ id: string; char: CharData }>;

describe.skipIf(!hasLocalData())('子职选法术（咒法师 AU）', () => {
  let env: SheetEnv;
  beforeAll(async () => {
    env = await createNodeEnv();
    await env.store.ensureMany(['races', 'backgrounds', 'feats', 'spellsXphb', 'spellsSources', 'classIndex', 'optionalfeatures']);
  });

  /** 法师 3 级、子职换成咒法师（AU）；别的照抄一张真卡 */
  const mage = (decisions: Json = {}): CharData => {
    const c = structuredClone(FIXTURES.find((f) => f.id === 'wizard3-evoker')!.char);
    c.classes = [{ name: '法师', level: 3, subclass: '咒法师' } as Json];
    c.decisions = { ...(c.decisions || {}), ...decisions };
    return c;
  };

  it('给出两条「选一道环阶 0–2 的咒法系法师法术」，候选都合法', async () => {
    const c = mage();
    const sheet = (await env.compute(c)) as Json;
    const pend = (sheet._pending as Json[]).filter((p) => p.pool === 'subclassSpell');
    expect(pend.length, '咒法师的咒法系法术是两处 choose').toBe(2);
    expect(String(pend[0].label)).toContain('咒法系');
    const res = choiceOptions(env, c, sheet, pend[0]);
    expect(res.options.length).toBeGreaterThan(0);
    for (const o of res.options) {
      const sp = env.store.spellsAll.find((s: Json) => s.name === o.value) as Json | undefined;
      expect(sp, `${o.value} 应该是法术`).toBeTruthy();
      expect(Number(sp!.level), `${o.value} 的环阶`).toBeLessThanOrEqual(2);
      expect(String(sp!.school), `${o.value} 的学派`).toBe('C');
    }
  });

  it('选完之后进「始终准备」（sheet.spell.granted），不再出现 [object Object]', async () => {
    const c0 = mage();
    const sheet0 = (await env.compute(c0)) as Json;
    const ch = (sheet0._pending as Json[]).find((p) => p.pool === 'subclassSpell')!;
    const opts = choiceOptions(env, c0, sheet0, ch).options;
    const a = String(opts[0].value);
    const b = String(opts[1].value);
    const c = mage({ 'AU:法师:咒法师:3#spell-0': [a], 'AU:法师:咒法师:3#spell-1': [b] });
    const sheet = (await env.compute(c)) as Json;
    const names = (((sheet.spell as Json)?.granted ?? []) as Json[]).map((g) => String(g.name));
    expect(names).toContain(a);
    expect(names).toContain(b);
    expect(names.some((n) => n.includes('object'))).toBe(false);
  });
});
