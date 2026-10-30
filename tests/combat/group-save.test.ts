// 群体豁免（指令框 /save）：每人各掷豁免，伤害只掷一次；没过全额，过了减半 / 不受伤害
import { describe, expect, it } from 'vitest';
import rulesJson from '../../data/rules-2024.json';
import { RuleBook, Session, createEncounter, makeCombatant, makeView, scriptedDice, type RuleFile } from '../../src/combat';
import { done } from './helpers';

function scene() {
  const dice = scriptedDice();
  const s = new Session(createEncounter('gs'), { rules: new RuleBook([rulesJson as unknown as RuleFile]), diceFor: () => dice });
  for (const id of ['a', 'b']) {
    done(s.dispatch({ type: 'addCombatant', combatant: makeCombatant({ id, kind: 'npc', view: makeView({ name: id, hpMax: 40, ac: 12, score: { dex: 10 } }) }) }));
  }
  return { s, dice };
}
const hp = (s: Session, id: string) => s.state.combatants[id].live.hp;

describe('群体豁免', () => {
  it('h：伤害掷一次，过了的减半、没过的全额', () => {
    const { s, dice } = scene();
    dice.push(3, 4, 20, 2); // 2d6 = 7；a 过、b 没过
    done(s.dispatch({ type: 'groupRoll', kind: 'save', ids: ['a', 'b'], ability: 'dex', dc: 15, damage: { dice: '2d6', type: '火焰' }, half: true }));
    expect(hp(s, 'a')).toBe(40 - 3);
    expect(hp(s, 'b')).toBe(40 - 7);
    expect(dice.left()).toBe(0);
  });
  it('不写 h：过了的不受伤害', () => {
    const { s, dice } = scene();
    dice.push(3, 4, 20, 2);
    done(s.dispatch({ type: 'groupRoll', kind: 'save', ids: ['a', 'b'], ability: 'dex', dc: 15, damage: { dice: '2d6', type: '火焰' } }));
    expect(hp(s, 'a')).toBe(40);
    expect(hp(s, 'b')).toBe(33);
  });
  it('不带伤害：只掷豁免', () => {
    const { s, dice } = scene();
    dice.push(20, 2);
    done(s.dispatch({ type: 'groupRoll', kind: 'save', ids: ['a', 'b'], ability: 'dex', dc: 15 }));
    const outs = s.events.filter((e) => e.type === 'saveSucceeded' || e.type === 'saveFailed').map((e) => e.type);
    expect(outs).toEqual(['saveSucceeded', 'saveFailed']);
    expect(hp(s, 'a')).toBe(40);
  });
  it('检定：技能加值、不带 DC 也行', () => {
    const { s, dice } = scene();
    dice.push(10, 10);
    done(s.dispatch({ type: 'groupRoll', kind: 'check', ids: ['a', 'b'], ability: 'wis', skill: '察觉' }));
    const rolls = s.events.filter((e) => e.type === 'd20Rolled').map((e) => (e.payload as { kind: string; vs: unknown }));
    expect(rolls.map((r) => r.kind)).toEqual(['check', 'check']);
    expect(dice.left()).toBe(0);
  });
  it('一笔事务：撤销一次全回去', () => {
    const { s, dice } = scene();
    dice.push(3, 4, 20, 2);
    done(s.dispatch({ type: 'groupRoll', kind: 'save', ids: ['a', 'b'], ability: 'dex', dc: 15, damage: { dice: '2d6', type: 'fire' }, half: true }));
    s.undo(1);
    expect([hp(s, 'a'), hp(s, 'b')]).toEqual([40, 40]);
  });
});
