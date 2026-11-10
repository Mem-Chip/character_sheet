// 浏览器侧的按需查资料：速览、例子、查询工具真的接到说明书 / types.ts / 手写条目上了
import { describe, expect, it } from 'vitest';
import { aiBrief, aiBriefExamples, aiExamples, aiGoldenEntries, aiLookup, aiRunInput, aiSpec } from '../../app/lib/ai';

describe('浏览器侧的查询资料源', () => {
  it('这一次发什么：缺省速览 + 查询工具；关掉开关或自己给说明书的走老办法', () => {
    const auto = aiRunInput();
    expect(auto.brief).toBe(true);
    expect(auto.spec).toBe(aiBrief('combat'));
    expect(auto.examples).toBe(aiBriefExamples('combat'));
    expect(auto.lookup).toBeDefined();

    const both = aiRunInput({ mode: 'both' });
    expect(both.spec).toContain('## 7. 卡面数据');
    expect(both.examples).toContain('卡面数据的例子');

    const old = aiRunInput({ lookup: false });
    expect(old.brief).toBe(false);
    expect(old.spec).toBe(aiSpec('combat'));
    expect(old.examples).toBe(aiExamples('combat'));
    expect(old.lookup).toBeUndefined();

    const custom = aiRunInput({ spec: '自制书的说明书', examples: '' });
    expect(custom.brief).toBe(false);
    expect(custom.spec).toBe('自制书的说明书');
    expect(custom.examples).toBe('');
    expect(custom.lookup).toBeUndefined();
  });

  it('速览版比全文短得多，例子只给几条', () => {
    const brief = aiBrief('both');
    expect(brief.length).toBeLessThan(aiSpec('both').length / 4);
    expect(brief).toContain('{"tool":"spec","q":"7.1"}');
    const ex = aiBriefExamples('both');
    expect(ex).toContain('XPHB:spell:匕首之云');
    expect(ex).toContain('卡面数据的例子');
    expect(ex.length).toBeLessThan(aiExamples('both').length);
  });

  it('查询工具能拿到节点定义、说明书段落、手写例子和自查', async () => {
    const lk = aiLookup('both');
    expect(await lk.one({ tool: 'node', q: 'zone' })).toContain('withEffect');
    expect(await lk.one({ tool: 'spec', q: '5.23' })).toContain('summon');
    expect(await lk.one({ tool: 'window', q: 'damageIncoming' })).toContain('reduceDamage');
    expect(await lk.one({ tool: 'expr', q: 'inZone' })).toContain('inZone(');
    expect(await lk.one({ tool: 'example', q: 'summon' })).toContain('XPHB:spell:');
    expect(await lk.one({ tool: 'check', draft: {} }, { check: () => ['不对'] })).toContain('不对');
    // 只搜手写的：AI 写的条目不在里面
    expect(Object.keys(aiGoldenEntries()).length).toBeGreaterThan(100);
    expect(await lk.one({ tool: 'example', q: '不存在的写法xyz' })).toContain('没有');
  });
});
