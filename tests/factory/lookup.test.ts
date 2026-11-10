// 给模型按需查资料的查询函数：说明书切块、types.ts 按节点 / 类型取定义（带注释）、窗口、表达式、手写例子、草稿检查
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GOLDEN_FILES } from '../../src/bridge/rule-files';
import { buildSpec } from '../../src/factory';
import { createLookup, isLookupReq, splitSpec, splitTypes } from '../../src/factory/lookup';

const typesSource = readFileSync('src/combat/types.ts', 'utf8');
const spec = buildSpec({ typesSource, mode: 'both' });
const entries: Record<string, unknown> = {};
for (const f of GOLDEN_FILES) Object.assign(entries, f.entries);
const lk = createLookup({ spec, typesSource, entries });

describe('查询函数', () => {
  it('说明书按标题和约定编号切块', () => {
    const b = splitSpec(spec);
    expect(b.some((x) => x.id === '5.23' && x.text.includes('召唤生物'))).toBe(true);
    expect(b.some((x) => x.id === '7.2')).toBe(true);
  });

  it('spec：章节号直接取，关键词按命中排', async () => {
    expect(await lk.one({ tool: 'spec', q: '5.23' })).toContain('summoner');
    expect(await lk.one({ tool: 'spec', q: 'withEffect' })).toContain('不靠专注的光环');
    expect(await lk.one({ tool: 'spec', q: '没有这个词xyz' })).toContain('没有');
  });

  it('node / type：取 types.ts 里的定义，连同前面的注释', async () => {
    const { members, decls } = splitTypes(typesSource);
    expect(members.has('zone')).toBe(true);
    expect(members.has('adv')).toBe(true);
    expect(decls.has('Trigger')).toBe(true);
    const zone = await lk.one({ tool: 'node', q: 'zone' });
    expect(zone).toContain('withEffect');
    expect(zone).toContain('在地图上留下一个持续的区域');
    expect(await lk.one({ tool: 'type', q: 'TargetPick' })).toContain('within');
    expect(await lk.one({ tool: 'node', q: 'nope' })).toContain('可以查的');
  });

  it('window / expr', async () => {
    expect(await lk.one({ tool: 'window', q: 'effectApplied' })).toContain('event.conditions');
    expect(await lk.one({ tool: 'window', q: 'turnEnded' })).toContain('回合的主人');
    expect(await lk.one({ tool: 'expr', q: 'inZone' })).toContain('inZone(');
    expect(await lk.one({ tool: 'expr', q: 'summoner' })).toContain('x.summoner');
    expect(await lk.one({ tool: 'expr', q: 'trigger' })).toContain('`roll`');
  });

  it('example：按用到的写法找，短的先给', async () => {
    const r = await lk.one({ tool: 'example', q: 'summon' });
    expect(r).toMatch(/共 \d+ 条用到「summon」/);
    expect(await lk.one({ tool: 'example', q: 'XPHB:spell:火球术' })).toContain('### XPHB:spell:火球术');
  });

  it('check：用调用方给的检查；run 一轮多个、超限截断', async () => {
    const check = (d: unknown) => ((d as { ok?: boolean }).ok ? [] : ['不对']);
    expect(await lk.one({ tool: 'check', draft: { ok: true } }, { check })).toBe('检查通过');
    expect(await lk.one({ tool: 'check', draft: {} }, { check })).toContain('- 不对');
    const many = Array.from({ length: 8 }, () => ({ tool: 'window', q: 'summoned' }));
    const out = await lk.run(many, { maxPerRound: 3 });
    expect(out.match(/## 查询/g)).toHaveLength(3);
    expect(out).toContain('后面 5 个没查');
  });

  it('isLookupReq：只有 lookup 一个字段才算查询', () => {
    expect(isLookupReq({ lookup: [] })).toBe(true);
    expect(isLookupReq({ lookup: [], parts: [] })).toBe(false);
    expect(isLookupReq({ parts: [] })).toBe(false);
  });
});
