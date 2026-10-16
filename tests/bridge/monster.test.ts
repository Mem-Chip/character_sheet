// 怪物图鉴 → 参与者：数值、攻击、多重攻击、吐息（充能）、传奇抗性
import { describe, expect, it } from 'vitest';
import bestiary from '../../data/5etools/data/bestiary/bestiary-xmm.json';
import { parseMonster } from '../../src/bridge/from-monster';
import { makeCombatant, makeView } from '../../src/combat';
import { done, evs, fighter, last, pending, setup } from '../combat/helpers';

const M = (en: string) => (bestiary as { monster: Array<{ ENG_name: string }> }).monster.find((m) => m.ENG_name === en)!;

describe('解析', () => {
  it('地精武者：数值和两种攻击；命中后的附加条件列为手动', () => {
    const p = parseMonster(M('Goblin Warrior'));
    expect(p.view).toMatchObject({ name: '地精武者', size: '小型', type: '精类', ac: 15, hpMax: 10, speed: 30, pb: 2 });
    expect(p.view.skill).toEqual({ 隐匿: 6 });
    expect(p.view.attacks!.map((a) => [a.name, a.bonus, a.damage, a.damageType, a.melee])).toEqual([
      ['弯刀', 4, '1d6 + 2', '挥砍', true], ['短弓', 4, '1d6 + 2', '穿刺', false],
    ]);
    expect(p.view.attacks![1]).toMatchObject({ range: 80, long: 320 });
    expect(p.notes.map((n) => n.name)).toContain('迅捷逃逸');
  });

  it('成年红龙：多重攻击 3 次、撕裂带火焰附加伤害、触及 10 尺；火焰吐息是锥状豁免动作（充能）；传奇抗性 3 次', () => {
    const p = parseMonster(M('Adult Red Dragon'));
    expect(p.view.attacksPerAction).toBe(3);
    expect(p.view.attacks![0]).toMatchObject({ name: '撕裂', bonus: 14, damage: '1d10 + 8', reach: true, extra: [{ dice: '2d4', type: '火焰' }] });
    expect(p.view.immune).toContain('火焰');
    expect(p.view.resources).toMatchObject({ 传奇抗性: 3, 传奇动作: 3 });
    const breath = p.view.entries![p.key].actions!.find((a) => a.name === '火焰吐息')!;
    expect(breath.targeting).toMatchObject({ type: 'area', area: { shape: 'cone', length: 60 } });
    expect(breath.cost).toEqual([{ recharge: '5-6', id: '火焰吐息' }]);
  });
});

describe('在战斗里', () => {
  const dragon = () => {
    const p = parseMonster(M('Adult Red Dragon'));
    return { p, c: makeCombatant({ id: 'd', kind: 'monster', side: 'enemy', view: makeView(p.view) }) };
  };

  it('吐息：豁免失败全伤、成功半伤；用过之后要等充能（回合开始掷 d6，5 以上恢复）', () => {
    const { s, dice } = setup([fighter({ hpMax: 200 }, 'f'), fighter({ hpMax: 200 }, 'g')]);
    const { p, c } = dragon();
    done(s.dispatch({ type: 'addCombatant', combatant: c }));
    done(s.dispatch({ type: 'startCombat', order: ['d', 'f', 'g'] }));
    dice.push(1, ...Array(17).fill(2), 20);   // f 豁免失败，17d6 全是 2；g 成功
    done(s.dispatch({ type: 'useAction', actor: 'd', action: `${p.key}#fire-breath`, targets: ['f', 'g'] }));
    expect(s.state.combatants.f.live.hp).toBe(200 - 34);
    expect(s.state.combatants.g.live.hp).toBe(200 - 17);
    expect(s.dispatch({ type: 'useAction', actor: 'd', action: `${p.key}#fire-breath`, targets: ['f'] }).status).toBe('rejected');
    done(s.dispatch({ type: 'nextTurn' }));
    done(s.dispatch({ type: 'nextTurn' }));
    dice.push(3);   // 龙的回合开始：充能没成
    done(s.dispatch({ type: 'nextTurn' }));
    expect(last(s, 'note').text).toMatch(/还没好/);
    done(s.dispatch({ type: 'nextTurn' }));
    done(s.dispatch({ type: 'nextTurn' }));
    dice.push(6);
    done(s.dispatch({ type: 'nextTurn' }));
    expect(evs(s, 'note').some((n) => /恢复/.test(n.text))).toBe(true);
  });

  it('传奇抗性：豁免失败时问 DM，用了就改成成功、次数减一', () => {
    const { s, dice } = setup([]);
    const { c } = dragon();
    done(s.dispatch({ type: 'addCombatant', combatant: c }));
    dice.push(2);
    const d = pending(s.dispatch({ type: 'roll', roller: 'd', kind: 'save', ability: 'con', dc: 25 }));
    expect(d.options[0].label).toContain('传奇抗性');
    done(s.decide(['0']));
    expect(last(s, 'd20Rolled').outcome).toBe('success');
    expect(s.state.combatants.d.live.resourcesUsed['传奇抗性']).toBe(1);
  });
});

describe('贴文本的自制怪物', () => {
  it('模板：数值、两种攻击、多重攻击取总数 3、吐息（充能）；特性列为手动', async () => {
    const { MONSTER_TEMPLATE, textToMonster } = await import('../../src/bridge/from-text-monster');
    const p = parseMonster(textToMonster(MONSTER_TEMPLATE));
    expect(p.view).toMatchObject({ name: '洞穴巨魔', size: '大型', type: '巨人', ac: 15, hpMax: 84, pb: 3, attacksPerAction: 3 });
    expect(p.view.save).toEqual({ con: 8 });
    expect(p.view.attacks!.map((a) => [a.name, a.bonus, a.damage, a.damageType])).toEqual([['啃咬', 7, '1d6+4', '穿刺'], ['爪击', 7, '2d6+4', '挥砍']]);
    const breath = p.view.entries![p.key].actions![0];
    expect(breath).toMatchObject({ name: '腐臭吐息', cost: [{ recharge: '5-6' }], targeting: { area: { shape: 'cone', length: 15 } } });
    expect(p.notes.map((n) => n.name)).toEqual(['再生']);
  });
});
