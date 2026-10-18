// 粘贴文本做怪物：「生命值 2d8 + 2」要换算成 11（以前取第一个数字，变成 2）
import { describe, expect, it } from 'vitest';
import { averageOfHp, textToMonster } from '../../src/bridge/from-text-monster';

describe('从文本做怪物：生命值', () => {
  it('骰子写法换算平均值', () => {
    expect(averageOfHp('2d8 + 2')).toBe(11);
    expect(averageOfHp('3d10+6')).toBe(22);
    expect(averageOfHp('1d4')).toBe(2);
  });

  it('纯数字 / 「平均 N（NdM）」照旧', () => {
    expect(averageOfHp('11')).toBe(11);
    expect(averageOfHp('平均 11（2d8+2）')).toBe(11);
  });

  it('整段文本解析：平均 11、公式保留', () => {
    const m = textToMonster('名字：巨狼\nAC 14　生命值 2d8 + 2　速度 40 尺\n力量 15 敏捷 13 体质 14');
    expect((m.hp as { average: number }).average).toBe(11);
    expect((m.hp as { formula: string }).formula).toBe('2d8 + 2');
  });
});
