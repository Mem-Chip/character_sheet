// 资源框的名字要带上来源：王车易位（AU 的咒法师）不能查到 PHB 的同名旧特性
import { describe, expect, it } from 'vitest';
import { termOfResource } from '../../app/lib/terms';

describe('termOfResource', () => {
  it('有 _src 时带上来源 / 职业 / 等级（王车易位 → AU 的咒法师 3 级）', () => {
    const r = termOfResource({
      name: '王车易位', from: '王车易位', key: 'ability:王车易位:benign-transposition',
      _src: { source: 'AU', name: '王车易位', kind: 'subclassFeature', cls: '法师', level: 3 },
    });
    expect(r).toEqual({ kind: 'subclassFeature', name: '王车易位', source: 'AU', cls: '法师', level: 3 });
  });

  it('没有 _src 时退回按名字查（auto）', () => {
    expect(termOfResource({ name: '回气', from: '回气' })).toEqual({ kind: 'auto', name: '回气' });
  });

  it('职业表的资源仍然按职业特性查', () => {
    expect(termOfResource({ name: '狂暴', key: 'table:XPHB:野蛮人:狂暴' })).toEqual({ kind: 'classFeature', cls: '野蛮人', name: '狂暴' });
  });

  it('空对象不炸', () => {
    expect(termOfResource({})).toBe(null);
  });
});
