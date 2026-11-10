// 效应的 actionMods（改某一类动作的激活方式 / 射程）：新写法能过检查，旧的专用标志被拦下并说清楚怎么换
import { describe, expect, it } from 'vitest';
import { lintShape } from '../../src/factory/lint';

const entry = (effect: Record<string, unknown>) => ({ name: '测试', effects: { 测试: effect } });

describe('检查：actionMods', () => {
  it('瞬发、远程的新写法能过', () => {
    expect(lintShape(entry({ actionMods: [{ on: { tag: 'spell', activation: 'action' }, activation: 'bonus', once: true }] }))).toEqual([]);
    expect(lintShape(entry({ actionMods: [{ on: { tag: 'spell' }, rangeMult: 2, touchRange: 30 }] }))).toEqual([]);
  });

  it('旧的 flags.quicken / rangeMult 过不了，提示里说了换成什么', () => {
    const p = lintShape(entry({ flags: { quicken: true } })).join('\n');
    expect(p).toContain('actionMods');
    expect(lintShape(entry({ flags: { rangeMult: 2 } })).join('\n')).toContain('actionMods');
  });

  it('拼错字段、什么都没改的会报', () => {
    expect(lintShape(entry({ actionMods: [{ on: { tags: 'spell' }, activation: 'bonus' }] })).length).toBeGreaterThan(0);
    expect(lintShape(entry({ actionMods: [{ on: { tag: 'spell' } }] })).join('\n')).toContain('没说要改什么');
  });
});
