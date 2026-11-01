// 资料库「本版删除」：改版删掉的官方特性 —— 卡面上不显示、加值和资源没了，战斗条目也没了
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { RuleBook, type RuleFile } from '../src/combat';
import { checkItem, homeRulesOf, houseRulesOf, type LibraryItem } from '../src/library';
import { createNodeEnv } from '../src/sheet/node-env';
import { hasLocalData } from '../src/sheet/node-provider';
import type { CharData, Json, SheetEnv } from '../src/sheet';

const WS = 'XPHB:德鲁伊:荒野形态:2';
const item = (): LibraryItem => ({
  id: 'hr-item1234', kind: 'subclass', name: '改版德鲁伊', text: '',
  parts: [{ id: 'hr-abcd1234', key: WS, name: '荒野形态', removed: true }],
  by: 'hand', reviewed: true,
});

describe('本版删除', () => {
  it('检查：只能用在覆盖官方的条目上，不能同时写数据', () => {
    expect(checkItem(item(), 'hr-item1234').problems).toEqual([]);
    const bad = { ...item(), parts: [{ id: 'hr-abcd1234', key: 'HR:hr-abcd1234', removed: true }] };
    expect(checkItem(bad, 'hr-item1234').problems.join()).toContain('只能用在覆盖官方');
    const both = { ...item(), parts: [{ id: 'hr-abcd1234', key: WS, removed: true, sheet: { mods: [] } }] };
    expect(checkItem(both, 'hr-item1234').problems.join()).toContain('不要再写');
  });

  it('战斗：规则书里那条官方条目没了', () => {
    const files = [{ entries: { [WS]: { name: '荒野形态', actions: [] } } }] as unknown as RuleFile[];
    expect(new RuleBook(files).has(WS)).toBe(true);
    const rb = new RuleBook(files, [{ scope: 'camp', name: '测试团', rules: houseRulesOf(item()) }]);
    expect(rb.has(WS)).toBe(false);
    expect(rb.problems).toEqual([]);
  });

  describe.skipIf(!hasLocalData())('卡面', () => {
    let env: SheetEnv;
    beforeAll(async () => { env = await createNodeEnv(); });
    it('荒野形态的特性和次数都不在了', async () => {
      const fix = JSON.parse(readFileSync('tests/fixtures/chars.json', 'utf8')) as Array<{ id: string; char: CharData }>;
      const c = structuredClone(fix.find((f) => f.id === 'sample-druid2')!.char);
      const before = (await env.compute(structuredClone(c))) as Json;
      const feats = (s: Json) => ((s.features ?? []) as Json[]).map((f) => f.name);
      expect(feats(before)).toContain('荒野形态');
      c.homerules = homeRulesOf(item()) as Json[];
      const after = (await env.compute(c)) as Json;
      expect(feats(after)).not.toContain('荒野形态');
      expect(((after._resources ?? []) as Json[]).some((r) => r.name === '荒野形态')).toBe(false);
    });
  });
});
