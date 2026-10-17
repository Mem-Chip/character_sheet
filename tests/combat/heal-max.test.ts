// 治疗骰的「取最大」：能力挂在**被治疗的人**身上也要生效（2024：永生者赠礼这类）
import { describe, expect, it } from 'vitest';
import rulesJson from '../../data/rules-2024.json';
import { RuleBook, Session, createEncounter, makeCombatant, makeView, scriptedDice, type RuleFile } from '../../src/combat';
import { done } from './helpers';

const TEST = {
  note: 'T',
  entries: {
    'T:spell:治疗': {
      name: '治疗',
      actions: [{
        id: 'cast', name: '治疗', activation: 'action', tags: ['spell', 'magical'], cost: [{ slot: { min: 1 } }],
        targeting: { type: 'creature', count: 1, range: 30 },
        root: [{ kind: 'heal', amount: '2d8', to: 'target' }],
      }],
    },
    // 承受者身上的「受到治疗时取最大」
    'T:永生者赠礼': {
      name: '永生者赠礼',
      rollMods: [{ id: 'max', label: '永生者赠礼', who: 'bearer', op: 'maxDice', on: { kind: 'heal' } }],
    },
  },
} as unknown as RuleFile;
const FILES = [rulesJson as unknown as RuleFile, TEST];

function scene(blessed: boolean) {
  const dice = scriptedDice();
  const s = new Session(createEncounter('h'), { rules: new RuleBook(FILES), diceFor: () => dice });
  const add = (id: string, view: Record<string, unknown>, hp?: number) => done(s.dispatch({
    type: 'addCombatant',
    combatant: makeCombatant({ id, kind: 'pc', view: makeView({ name: id, hpMax: 40, ac: 12, ...view }), ...(hp !== undefined ? { hp } : {}) }),
  }));
  add('c', { level: 3, score: { wis: 16 }, pb: 2, spell: { dc: 13, atk: 5, mod: 3, ability: 'wis' }, slots: { 1: 2 }, sources: ['T:spell:治疗'] });
  add('b', { sources: blessed ? ['T:永生者赠礼'] : [] }, 10);
  done(s.dispatch({ type: 'startCombat', order: ['c', 'b'] }));
  return { s, dice };
}

describe('治疗骰取最大', () => {
  it('承受者有「受到治疗时取最大」→ 2d8 直接算 16（骰面 1、1 也没用）', () => {
    const { s, dice } = scene(true);
    dice.push(1, 1);
    done(s.dispatch({ type: 'useAction', actor: 'c', action: 'T:spell:治疗#cast', targets: ['b'], slotLevel: 1 }));
    expect(s.state.combatants.b.live.hp).toBe(10 + 16);
  });

  it('没有这个能力时照常掷骰', () => {
    const { s, dice } = scene(false);
    dice.push(1, 1);
    done(s.dispatch({ type: 'useAction', actor: 'c', action: 'T:spell:治疗#cast', targets: ['b'], slotLevel: 1 }));
    expect(s.state.combatants.b.live.hp).toBe(10 + 2);
  });
});
