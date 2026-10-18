// 粘贴文本做怪物：动作要能变成攻击行（以前只有 5etools 结构化写法才认，纯文本的攻击只能当说明看）
import { describe, expect, it } from 'vitest';
import { textToMonster } from '../../src/bridge/from-text-monster';
import { parseMonster } from '../../src/bridge/from-monster';

describe('从文本做怪物：攻击行', () => {
  it('「近战攻击：+4 … 命中：5（1d6 + 2）穿刺」→ 一条攻击行 + 附带效果说明', () => {
    const m = textToMonster([
      '名字：巨狼',
      'AC 14　生命值 2d8 + 2　速度 40 尺',
      '力量 15 敏捷 13 体质 14 智力 3 感知 12 魅力 6',
      '动作',
      '啃咬。近战攻击：+4，触及 5 尺，一个目标。命中：5（1d6 + 2）穿刺伤害，目标若为中型或更小则倒地。',
    ].join('\n'));
    const p = parseMonster(m);
    expect(p.view.attacks?.length, '应该解析出一条攻击').toBe(1);
    const a = p.view.attacks![0];
    expect(a.name).toBe('啃咬');
    expect(a.bonus).toBe(4);
    expect(a.damage.replace(/\s/g, '')).toBe('1d6+2');
    expect(a.damageType).toBe('穿刺');
    expect(a.melee).toBe(true);
    expect((p.view.notes ?? []).some((n) => /倒地/.test(n.text)), '命中后的附带效果要留成说明').toBe(true);
  });

  it('远程攻击带射程', () => {
    const m = textToMonster([
      '名字：弓手',
      'AC 13　生命值 11　速度 30 尺',
      '动作',
      '长弓。远程攻击：+5，射程 150/600 尺，一个目标。命中：7（1d8 + 3）穿刺伤害。',
    ].join('\n'));
    const a = parseMonster(m).view.attacks![0];
    expect(a.bonus).toBe(5);
    expect(a.ranged).toBe(true);
    expect(a.range).toBe(150);
    expect(a.long).toBe(600);
  });
});
