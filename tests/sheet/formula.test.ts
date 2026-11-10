// 卡面上的算式只有一处求值（src/sheet/formula.ts）：旧写法、表达式、两者混着写都算得出来
import { describe, expect, it } from 'vitest';
import { evalFormula, normalizeFormula } from '../../src/sheet/formula';
import { resolveNum } from '../../src/sheet/abilities';
import { Resources } from '../../src/sheet/resources';

const sheet = { level: 8, pb: 3, 'mod:str': 3, 'mod:dex': 2, 'mod:con': 1, 'mod:int': 4, 'mod:wis': -1, 'mod:cha': 0 };
const classes = [{ cls: { name: '战士' }, level: 5 }, { cls: { name: '法师', spellcastingAbility: 'int' }, level: 3 }];
const char = { classes: [{ level: 5 }, { level: 3 }], _resolved: { classes } };
const ev = (v: unknown, cls?: string) => evalFormula(v, { sheet, char, cls });

describe('算式：旧写法先规范化成表达式', () => {
  it('各种旧写法', () => {
    expect(normalizeFormula('mod:wis')).toBe('mod.wis');
    expect(normalizeFormula('spellcasting')).toBe('self.spell.mod');
    expect(normalizeFormula('max(1,智力调整值)')).toBe('max(1,mod.int)');
    expect(normalizeFormula('感知调整值（最少1次）')).toBe('mod.wis');
    expect(normalizeFormula('1 + 职业等级')).toBe('1 + level');
    expect(normalizeFormula('+2')).toBe('2');
    expect(normalizeFormula('优势')).toBeNull();
    expect(normalizeFormula('')).toBeNull();
  });
});

describe('算式：求值', () => {
  it('数字、熟练加值、属性、施法属性', () => {
    expect(ev(5)).toBe(5);
    expect(ev('pb')).toBe(3);
    expect(ev('int')).toBe(4);
    expect(ev('mod:str')).toBe(3);
    expect(ev('魅力调整值')).toBe(0);
    expect(ev('spellcasting')).toBe(4);
    expect(ev('max(1, wis)')).toBe(1);
    expect(ev('2 * pb')).toBe(6);
  });

  it('level：给了职业就是该职业的等级，否则总等级', () => {
    expect(ev('level')).toBe(8);
    expect(ev('level', '法师')).toBe(3);
    expect(ev('level * 5', '战士')).toBe(25);
    expect(ev('cond(level >= 5, 2, 1)', '战士')).toBe(2);
    expect(ev('totalLevel', '法师')).toBe(8);
    expect(ev("levelOf('战士') + 1")).toBe(6);
  });

  it('算不出来的是 null，不是 0：骰子、说明文字、不认识的名字', () => {
    expect(ev('1d4')).toBeNull();
    expect(ev('2d8+牧师等级')).toBeNull();
    expect(ev('优势')).toBeNull();
    expect(ev('foo + 1')).toBeNull();
  });

  it('没有卡面数据时按 1 级、调整值 0 算', () => {
    expect(evalFormula('pb', { sheet: {}, char: null })).toBe(2);
    expect(evalFormula('max(1, cha)', { sheet: null, char: null })).toBe(1);
  });
});

describe('两个老入口都走它', () => {
  it('resolveNum：算不出来当 0；以前只认单个词，现在表达式也行', () => {
    const ctx = { out: sheet, char };
    expect(resolveNum('pb', ctx)).toBe(3);
    expect(resolveNum('max(1, wis)', ctx)).toBe(1);
    expect(resolveNum('2 * pb', ctx)).toBe(6);
    expect(resolveNum('优势', ctx)).toBe(0);
  });

  it('资源上限：table 交给等级表；纯数字照原样；其余向下取整', () => {
    const r = Object.create(Resources.prototype) as Resources;
    expect(r.resolveFormula('table', sheet, char)).toBeNull();
    expect(r.resolveFormula('3', sheet, char)).toBe(3);
    expect(r.resolveFormula('max(1, int)', sheet, char)).toBe(4);
    expect(r.resolveFormula('1 + 职业等级', sheet, char, '法师')).toBe(4);
    expect(r.resolveFormula('level', sheet, char, '法师')).toBe(3);
    expect(r.resolveFormula('mod:con', null, null)).toBeNull();
    expect(r.resolveFormula('瞎写', sheet, char)).toBeNull();
  });
});
