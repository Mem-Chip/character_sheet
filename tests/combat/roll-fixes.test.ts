// 伤害类型的两种写法要归一（「黯蚀」/「暗蚀」），以及 minD20 要把自然值也抬上去
import { describe, expect, it } from 'vitest';
import rulesJson from '../../data/rules-2024.json';
import { RuleBook, Session, createEncounter, makeCombatant, makeView, normType, scriptedDice, type RuleFile } from '../../src/combat';
import { done, evs } from './helpers';

const TEST = {
  note: 'T',
  entries: {
    'T:spell:黯蚀射线': {
      name: '黯蚀射线',
      actions: [{
        id: 'cast', name: '黯蚀射线', activation: 'action', tags: ['spell', 'magical'], cost: [{ slot: { min: 1 } }],
        targeting: { type: 'creature', count: 1, range: 60 },
        root: [{ kind: 'damage', dice: '10', type: '黯蚀' }],
      }],
    },
    // 掷出 9 或以下视为 10（攻击检定）
    'T:可靠': { name: '可靠', rollMods: [{ id: 'min', label: '可靠', who: 'bearer', op: 'minD20', on: { kind: 'attack' }, value: 10 }] },
  },
} as unknown as RuleFile;

describe('伤害类型写法归一', () => {
  it('「黯蚀」和「暗蚀」是同一种伤害（抗性匹配得上）', () => {
    expect(normType('黯蚀')).toBe('暗蚀');
    expect(normType('暗蚀')).toBe('暗蚀');
    expect(normType('necrotic')).toBe('暗蚀');
  });

  it('写「黯蚀」的伤害，对写「暗蚀」抗性的目标要减半', () => {
    const dice = scriptedDice();
    const s = new Session(createEncounter('n'), { rules: new RuleBook([rulesJson as unknown as RuleFile, TEST] as RuleFile[]), diceFor: () => dice });
    const add = (id: string, view: Record<string, unknown>) => done(s.dispatch({
      type: 'addCombatant',
      combatant: makeCombatant({ id, kind: 'pc', view: makeView({ name: id, hpMax: 60, ac: 12, ...view }) }),
    }));
    add('c', { level: 3, score: { int: 16 }, pb: 2, spell: { dc: 13, atk: 5, mod: 3, ability: 'int' }, slots: { 1: 2 }, sources: ['T:spell:黯蚀射线'] });
    add('t', { resist: ['暗蚀'] });
    done(s.dispatch({ type: 'startCombat', order: ['c', 't'] }));
    dice.push(10);                            // 伤害骰（这里写成固定 10，实际不消耗骰面也行）
    done(s.dispatch({ type: 'useAction', actor: 'c', action: 'T:spell:黯蚀射线#cast', targets: ['t'], slotLevel: 1 }));
    const applied = evs(s, 'damageApplied').at(-1);
    expect(applied.total ?? applied.amount).toBe(5);   // 10 点黯蚀 → 抗「暗蚀」减半
  });
});

describe('minD20', () => {
  it('掷出自然 1 时按 10 算：+5 打 AC 15 应该命中（不是自然 1 的失手）', () => {
    const dice = scriptedDice();
    const s = new Session(createEncounter('m'), { rules: new RuleBook([rulesJson as unknown as RuleFile, TEST] as RuleFile[]), diceFor: () => dice });
    const add = (id: string, view: Record<string, unknown>) => done(s.dispatch({
      type: 'addCombatant',
      combatant: makeCombatant({ id, kind: 'pc', view: makeView({ name: id, hpMax: 30, ac: 12, ...view }) }),
    }));
    add('a', {
      level: 5, pb: 3, score: { str: 16 }, sources: ['T:可靠'],
      attacks: [{ id: 'atk-1', name: '长剑', bonus: 5, damage: '1d8 + 3', damageType: '挥砍', melee: true, ranged: false, finesse: false, ability: 'str' }],
    });
    add('d', { ac: 15, hpMax: 30 });
    done(s.dispatch({ type: 'startCombat', order: ['a', 'd'] }));
    dice.push(1, 4);                          // d20 掷出 1（被视为 10），伤害 1d8 = 4
    done(s.dispatch({ type: 'useAction', actor: 'a', action: 'weapon:atk-1', targets: ['d'] }));
    expect(s.state.combatants.d.live.hp, '自然 1 被抬到 10 之后 15 ≥ AC 15，应该命中').toBe(30 - 7);
  });
});
