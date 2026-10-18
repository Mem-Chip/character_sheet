// 战斗结束要清先攻：顺位清空、每人的先攻值归零、下一场重新掷
// 以及「从遭遇里移除参与者」这条命令真的会把人和先攻位置一起去掉
import { describe, expect, it } from 'vitest';
import { RuleBook, Session, createEncounter, makeCombatant, makeView, scriptedDice } from '../../src/combat';
import { FILES, done } from './helpers';

describe('战斗结束 / 移除参与者', () => {
  const scene = () => {
    const dice = scriptedDice();
    dice.push(...Array.from({ length: 40 }, () => 10));
    const s = new Session(createEncounter('e'), { rules: new RuleBook([...FILES]), diceFor: () => dice });
    for (const [id, side] of [['a', 'party'], ['b', 'enemy'], ['c', 'party']] as const) {
      done(s.dispatch({
        type: 'addCombatant',
        combatant: makeCombatant({ id, kind: side === 'party' ? 'pc' : 'monster', side, view: makeView({ name: id, hpMax: 20, ac: 10 }) }),
      }));
    }
    return s;
  };

  it('结束战斗：order 清空、先攻值归零、round 回到 null', () => {
    const s = scene();
    done(s.dispatch({ type: 'startCombat' }));
    expect(s.state.order.length).toBe(3);
    expect(s.state.order.every((id) => s.state.combatants[id].initiative !== null), '开始后都掷过先攻').toBe(true);

    done(s.dispatch({ type: 'endCombat' }));
    expect(s.state.round).toBe(null);
    expect(s.state.order, '顺位清空').toEqual([]);
    expect(s.state.turnIndex).toBe(0);
    expect(s.state.order.every((id) => s.state.combatants[id].initiative === null), '先攻值归零').toBe(true);
  });

  it('下一场战斗重新掷先攻（不会沿用上一场的顺位）', () => {
    const s = scene();
    done(s.dispatch({ type: 'startCombat' }));
    const first = [...s.state.order];
    done(s.dispatch({ type: 'endCombat' }));
    expect(s.state.combatants[first[0]].initiative, '结束后旧值清掉').toBe(null);

    const before = s.events.filter((e) => e.type === 'initiativeSet').length;
    done(s.dispatch({ type: 'startCombat' }));
    const after = s.events.filter((e) => e.type === 'initiativeSet').length;
    expect(after, '重新掷了先攻').toBeGreaterThan(before);
    expect(s.state.order.length).toBe(3);
  });

  it('移除参与者：人和先攻位置都去掉', () => {
    const s = scene();
    done(s.dispatch({ type: 'startCombat' }));
    expect(s.state.order).toContain('b');

    done(s.dispatch({ type: 'removeCombatant', id: 'b' }));
    expect(s.state.combatants['b']).toBeUndefined();
    expect(s.state.order).not.toContain('b');
    expect(s.state.order.length).toBe(2);
  });
});
