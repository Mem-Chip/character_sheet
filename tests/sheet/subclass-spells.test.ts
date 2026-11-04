// 法师学派子职的「选两道学派法术进法术书」：只应有一个选择框，且选完进 granted
// （咒法师 AU 的 additionalSpells.known 里也有同样的 choose —— 那条不能再生一份「始终准备」）
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createNodeEnv } from '../../src/sheet/node-env';
import { hasLocalData } from '../../src/sheet/node-provider';
import { choiceOptions } from '../../src/sheet/pools';
import type { CharData, Json, SheetEnv } from '../../src/sheet';

const FIXTURES = JSON.parse(readFileSync('tests/fixtures/chars.json', 'utf8')) as Array<{ id: string; char: CharData }>;

describe.skipIf(!hasLocalData())('学派法术进法术书', () => {
  let env: SheetEnv;
  beforeAll(async () => {
    env = await createNodeEnv();
    await env.store.ensureMany(['races', 'backgrounds', 'feats', 'spellsXphb', 'spellsSources', 'classIndex', 'optionalfeatures']);
  });

  const mage = (decisions: Json = {}): CharData => {
    const c = structuredClone(FIXTURES.find((f) => f.id === 'wizard3-evoker')!.char);
    c.classes = [{ name: '法师', level: 3, subclass: '咒法师' } as Json];
    c.decisions = { ...(c.decisions || {}), ...decisions };
    return c;
  };

  it('只有一个「选两道咒法学派法术」的选择框，候选都是 ≤2 环的咒法系法师法术', async () => {
    const c = mage();
    const sheet = (await env.compute(c)) as Json;
    const pend = (sheet._pending as Json[]) ?? [];
    const school = pend.filter((p) => p.pool === 'spellBySchool');
    expect(school.length, '咒法学者只该有一个选择框').toBe(1);
    expect(String(school[0].label)).toContain('咒法学派');
    // 旧实现会把 additionalSpells.known 里的 choose 也翻成「始终准备」的待决定项 —— 那是重复
    expect(pend.filter((p) => p.pool === 'subclassSpell').length, '不该再有重复的「始终准备」选择').toBe(0);
    const res = choiceOptions(env, c, sheet, school[0]);
    expect(res.options.length, '候选不该是占位文字').toBeGreaterThan(5);
    for (const o of res.options) {
      const sp = env.store.spellsAll.find((s: Json) => s.name === o.value) as Json | undefined;
      expect(sp, `${o.value} 应该是法术`).toBeTruthy();
      expect(Number(sp!.level)).toBeLessThanOrEqual(2);
      expect(String(sp!.school)).toBe('C');
    }
  });

  it('选完的两道进「法术书」（spellbookAdds），不算常备（granted）', async () => {
    const c0 = mage();
    const sheet0 = (await env.compute(c0)) as Json;
    const ch = ((sheet0._pending as Json[]) ?? []).find((p) => p.pool === 'spellBySchool')!;
    const opts = choiceOptions(env, c0, sheet0, ch).options;
    const a = String(opts[0].value);
    const b = String(opts[1].value);
    const c = mage({ [String(ch.key)]: [a, b] });
    const sheet = (await env.compute(c)) as Json;
    const adds = (((sheet.spell as Json)?.spellbookAdds ?? []) as Json[]).map((g) => String(g.name));
    expect(adds).toContain(a);
    expect(adds).toContain(b);
    // 不能算「始终准备」（法师要先准备）
    const granted = (((sheet.spell as Json)?.granted ?? []) as Json[]).map((g) => String(g.name));
    expect(granted).not.toContain(a);
    expect(adds.some((n) => n.includes('object')), '不该出现 [object Object]').toBe(false);
  });

  // 塑能 / 死灵两条数据曾经漏了 pool，选择框里只有一句说明文字，选了也没用
  it.each([['塑能师', 'V'], ['死灵师', 'N'], ['防护师', 'A'], ['预言师', 'D'], ['幻术师', 'I']])(
    '%s：选择框列的是真法术（学派 %s），选完进法术书',
    async (sub, school) => {
      const c0 = mage();
      c0.classes = [{ name: '法师', level: 3, subclass: sub } as Json];
      const sheet0 = (await env.compute(c0)) as Json;
      const ch = ((sheet0._pending as Json[]) ?? []).find((p) => p.pool === 'spellBySchool');
      expect(ch, `${sub} 应有按学派选法术的选择框`).toBeTruthy();
      const opts = choiceOptions(env, c0, sheet0, ch!).options;
      expect(opts.length).toBeGreaterThan(3);
      for (const o of opts) expect(String((env.store.spellsAll.find((s: Json) => s.name === o.value) as Json)?.school)).toBe(school);
      const c = structuredClone(c0);
      c.decisions = { ...(c.decisions || {}), [String(ch!.key)]: [String(opts[0].value), String(opts[1].value)] };
      const sheet = (await env.compute(c)) as Json;
      const adds = (((sheet.spell as Json)?.spellbookAdds ?? []) as Json[]).map((g) => String(g.name));
      expect(adds).toEqual(expect.arrayContaining([String(opts[0].value), String(opts[1].value)]));
    },
  );
});

