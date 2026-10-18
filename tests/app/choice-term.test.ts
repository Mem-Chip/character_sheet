// 选择框选项 → 术语类别：可选特性的池子 `optionalfeature` 不能当成专长（曾经因为 includes('feat') 查不到原文）
import { describe, expect, it } from 'vitest';
import { choiceTerm } from '../../app/lib/terms';

describe('choiceTerm', () => {
  it('超魔法 / 魔能祈唤这类可选特性 → optfeature', () => {
    expect(choiceTerm({ kind: 'optfeature', pool: 'optionalfeature', value: '瞬发法术' })).toEqual({ kind: 'optfeature', name: '瞬发法术' });
    // 只给 pool 也认（有些地方 kind 是空的）
    expect(choiceTerm({ pool: 'optionalfeature', value: '强效法术' })).toEqual({ kind: 'optfeature', name: '强效法术' });
  });

  it('专长仍然是专长', () => {
    expect(choiceTerm({ kind: 'feat', pool: 'originFeat', value: '警觉' })).toEqual({ kind: 'feat', name: '警觉' });
    expect(choiceTerm({ pool: 'feat', value: '幸运' })).toEqual({ kind: 'feat', name: '幸运' });
  });

  it('技能用 label（中文名），其余用 value', () => {
    expect(choiceTerm({ kind: 'skill', value: 'athletics', label: '运动' })).toEqual({ kind: 'skill', name: '运动' });
    expect(choiceTerm({ kind: 'cantrip', pool: 'druid', value: '德鲁伊伎俩' })).toEqual({ kind: 'spell', name: '德鲁伊伎俩' });
    expect(choiceTerm({ kind: 'itemMastery', pool: 'mastery', value: '横扫' })).toEqual({ kind: 'itemMastery', name: '横扫' });
  });

  it('认不出来的类别退回 auto', () => {
    expect(choiceTerm({ pool: 'zzz', value: '某某' })).toEqual({ kind: 'auto', name: '某某' });
    expect(choiceTerm({ value: '' })).toBe(null);
  });
});
