// 指令框的斜杠指令解析（缩写）
import { describe, expect, it } from 'vitest';
import { damageType, modTemplate, parseCommand, skill } from '../../app/lib/commands';

describe('指令解析', () => {
  it('伤害类型：单字母、双字母、英文、中文', () => {
    expect(['f', 'fi', 'FIRE', '火焰'].map(damageType)).toEqual(['火焰', '火焰', '火焰', '火焰']);
    expect([damageType('x'), damageType('po'), damageType('t'), damageType('n'), damageType('k')]).toEqual(['毒素', '毒素', '雷鸣', '暗蚀', '力场']);
    expect(damageType('zz')).toBeNull();
  });
  it('/save dex 15 8d6 f h', () => {
    expect(parseCommand('/save dex 15 8d6 f h')).toEqual({ kind: 'save', ability: 'dex', dc: 15, damage: { dice: '8d6', type: '火焰' }, half: true });
    expect(parseCommand('/save 敏 15')).toEqual({ kind: 'save', ability: 'dex', dc: 15, half: false });
    expect(parseCommand('/save dex 15 8d6 zz')?.kind).toBe('error');
    expect(parseCommand('/save dex')?.kind).toBe('error');
  });
  it('/check：属性优先，技能认前缀', () => {
    expect(parseCommand('/check int')).toEqual({ kind: 'check', ability: 'int' });
    expect(parseCommand('/check perc 15')).toEqual({ kind: 'check', ability: 'wis', skill: '察觉', dc: 15 });
    expect(parseCommand('/check 隐匿')).toEqual({ kind: 'check', ability: 'dex', skill: '隐匿' });
    expect(skill('per')).toHaveProperty('error');
  });
  it('/next /undo /h；别的交回去', () => {
    expect(parseCommand('/next')).toEqual({ kind: 'next' });
    expect(parseCommand('/undo 3')).toEqual({ kind: 'undo', n: 3 });
    expect(parseCommand('/h')).toEqual({ kind: 'help' });
    expect(parseCommand('/r 1d20')).toBeNull();
    expect(parseCommand('你好')).toBeNull();
  });
  it('/mod ac -2 · /mod speed 10 · /mod hp 5 · /mod atk 1', () => {
    expect(parseCommand('/mod ac -2')).toEqual({ kind: 'mod', stat: 'ac', n: -2 });
    expect(parseCommand('/mod speed 10')).toEqual({ kind: 'mod', stat: 'speed', n: 10 });
    expect(parseCommand('/mod hp +5')).toEqual({ kind: 'mod', stat: 'hpMax', n: 5 });
    expect(parseCommand('/mod foo 1')?.kind).toBe('error');
    expect(parseCommand('/mod ac 0')?.kind).toBe('error');
    expect(modTemplate('ac', -2)).toMatchObject({ name: '调整：AC −2', statics: [{ kind: 'ac', bonus: -2 }] });
    expect(modTemplate('attack', 1).rollMods?.[0]).toMatchObject({ on: { kind: 'attack' }, op: 'add', value: 1 });
  });
});
