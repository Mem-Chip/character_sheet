// 战斗中改先攻：拖动排序 / 移出先攻（setOrder）、中途加入并按数值插队（joinInitiative、addCombatant.joinInitiative）
import { describe, expect, it } from 'vitest';
import { RuleBook, Session, createEncounter, makeCombatant, makeView, scriptedDice } from '../../src/combat';
import { FILES, done } from './helpers';

describe('战斗中改先攻', () => {
  // a 20、b 15、c 10（先攻加值都是 0）
  const scene = () => {
    const dice = scriptedDice();
    dice.push(20, 15, 10);
    const s = new Session(createEncounter('e'), { rules: new RuleBook([...FILES]), diceFor: () => dice });
    for (const [id, side] of [['a', 'party'], ['b', 'enemy'], ['c', 'party']] as const) {
      done(s.dispatch({
        type: 'addCombatant',
        combatant: makeCombatant({ id, kind: side === 'party' ? 'pc' : 'monster', side, view: makeView({ name: id, hpMax: 20, ac: 10 }) }),
      }));
    }
    done(s.dispatch({ type: 'startCombat' }));
    return { s, dice };
  };
  const monster = (id: string) => makeCombatant({ id, kind: 'monster', side: 'enemy', view: makeView({ name: id, hpMax: 7, ac: 12 }) });

  it('开局顺序 a b c，轮到 a', () => {
    const { s } = scene();
    expect(s.state.order).toEqual(['a', 'b', 'c']);
    expect(s.state.order[s.state.turnIndex]).toBe('a');
  });

  it('拖动改顺序：轮到的人不变', () => {
    const { s } = scene();
    done(s.dispatch({ type: 'nextTurn' }));
    expect(s.state.order[s.state.turnIndex]).toBe('b');
    done(s.dispatch({ type: 'setOrder', order: ['c', 'a', 'b'] }));
    expect(s.state.order).toEqual(['c', 'a', 'b']);
    expect(s.state.order[s.state.turnIndex], '还是 b 的回合').toBe('b');
    done(s.dispatch({ type: 'nextTurn' }));
    expect(s.state.order[s.state.turnIndex], 'b 之后转回队首 c').toBe('c');
  });

  it('移出先攻：人还在遭遇里，之后轮不到他；正在行动的人不能移出', () => {
    const { s } = scene();
    done(s.dispatch({ type: 'setOrder', order: ['a', 'c'] }));
    expect(s.state.combatants.b, '人还在').toBeTruthy();
    done(s.dispatch({ type: 'nextTurn' }));
    expect(s.state.order[s.state.turnIndex]).toBe('c');
    const r = s.dispatch({ type: 'setOrder', order: ['a'] });
    expect(r.status).toBe('rejected');
  });

  it('中途加入：掷先攻，按数值插队；插在当前行动者前面时 turnIndex 跟着挪', () => {
    const { s, dice } = scene();
    done(s.dispatch({ type: 'nextTurn' }));             // 轮到 b（15）
    dice.push(18);
    done(s.dispatch({ type: 'addCombatant', combatant: monster('m'), joinInitiative: true }));
    expect(s.state.combatants.m.initiative).toBe(18);
    expect(s.state.order).toEqual(['a', 'm', 'b', 'c']);
    expect(s.state.order[s.state.turnIndex], '还是 b 的回合').toBe('b');
  });

  it('中途加入、不带 joinInitiative（旧存档）：照旧排到队尾，不掷骰', () => {
    const { s } = scene();
    done(s.dispatch({ type: 'addCombatant', combatant: monster('m') }));
    expect(s.state.order).toEqual(['a', 'b', 'c', 'm']);
    expect(s.state.combatants.m.initiative).toBe(null);
  });

  it('手填先攻：同值排在后面；召唤物跟着主人挪', () => {
    const { s } = scene();
    done(s.dispatch({ type: 'addCombatant', combatant: makeCombatant({ id: 's1', kind: 'monster', side: 'party', summoner: 'c', initiative: 10, view: makeView({ name: '狼', hpMax: 5, ac: 10 }) }) }));
    expect(s.state.order).toEqual(['a', 'b', 'c', 's1']);
    done(s.dispatch({ type: 'joinInitiative', id: 'c', value: 15 }));
    expect(s.state.order).toEqual(['a', 'b', 'c', 's1']);   // 15 和 b 同值：排在 b 后面
    done(s.dispatch({ type: 'joinInitiative', id: 'c', value: 16 }));
    expect(s.state.order).toEqual(['a', 'c', 's1', 'b']);
    expect(s.state.combatants.s1.initiative).toBe(16);
    expect(s.state.combatants.c.initiative).toBe(16);
  });

  it('正在行动的人不能重排；撤销能退回去', () => {
    const { s } = scene();
    expect(s.dispatch({ type: 'joinInitiative', id: 'a', value: 1 }).status).toBe('rejected');
    done(s.dispatch({ type: 'setOrder', order: ['a', 'c', 'b'] }));
    s.undo();
    expect(s.state.order).toEqual(['a', 'b', 'c']);
  });
});
