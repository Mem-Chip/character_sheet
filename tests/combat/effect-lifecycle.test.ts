// 效应被移除时，施法者那边的专注也要一并结束（挣脱、驱散之后不该还挂着专注）
import { describe, expect, it } from 'vitest';
import rulesJson from '../../data/rules-2024.json';
import { RuleBook, Session, createEncounter, makeCombatant, makeView, scriptedDice, type RuleFile } from '../../src/combat';
import { done, effectNames } from './helpers';

const TEST = {
  note: 'T',
  entries: {
    'T:spell:束缚': {
      name: '束缚',
      actions: [{
        id: 'cast', name: '束缚', activation: 'action', tags: ['spell', 'magical'], cost: [{ slot: { min: 1 } }],
        concentration: { minutes: 1 },
        targeting: { type: 'creature', count: 1, range: 30 },
        root: [{ kind: 'applyEffect', inline: { name: '束缚', effects: [{ statics: [{ kind: 'speed', bonus: -10 }] }] }, to: 'target' }],
      }],
    },
    'T:spell:解缚': {
      name: '解缚',
      actions: [{
        id: 'cast', name: '解缚', activation: 'action', tags: ['spell', 'magical'], cost: [{ slot: { min: 1 } }],
        targeting: { type: 'creature', count: 1, range: 30 },
        root: [{ kind: 'removeEffect', from: 'target', match: { name: '束缚' } }, { kind: 'endConcentration' }],
      }],
    },
  },
} as unknown as RuleFile;
const FILES = [rulesJson as unknown as RuleFile, TEST] as RuleFile[];

function scene() {
  const dice = scriptedDice();
  const s = new Session(createEncounter('e'), { rules: new RuleBook(FILES), diceFor: () => dice });
  const add = (id: string, view: Record<string, unknown>) => done(s.dispatch({
    type: 'addCombatant',
    combatant: makeCombatant({ id, kind: 'pc', view: makeView({ name: id, hpMax: 30, ac: 12, ...view }) }),
  }));
  add('c', { level: 5, score: { wis: 16 }, pb: 3, spell: { dc: 13, atk: 5, mod: 3, ability: 'wis' }, slots: { 1: 4 }, sources: ['T:spell:束缚', 'T:spell:解缚'] });
  add('t', {});
  done(s.dispatch({ type: 'startCombat', order: ['c', 't'] }));
  return { s, dice };
}
/** 转到 c 的回合 */
function backToC(s: Session): void {
  for (let i = 0; i < 8; i++) {
    let r = s.dispatch({ type: 'nextTurn' });
    while (r.status === 'pending') r = s.decide([r.decision.options?.[0]?.id ?? '']);
    if (s.state.order[s.state.turnIndex] === 'c') return;
  }
  throw new Error('转不回 c 的回合');
}

/** 某人身上有没有专注（专注效应的 key 是 concentration，名字是法术名） */
const hasConc = (s: Session, id: string) => Object.values(s.state.effects).some((e) => e.key === 'concentration' && e.bearer === id);

describe('效应的生命周期', () => {
  it('专注法术的效应被移除时，专注也一并结束', () => {
    const { s } = scene();
    done(s.dispatch({ type: 'useAction', actor: 'c', action: 'T:spell:束缚#cast', targets: ['t'], slotLevel: 1 }));
    expect(effectNames(s, 't')).toContain('束缚');
    expect(hasConc(s, 'c'), '施法者应该在专注').toBe(true);
    backToC(s);
    done(s.dispatch({ type: 'useAction', actor: 'c', action: 'T:spell:解缚#cast', targets: ['t'], slotLevel: 1 }));
    expect(effectNames(s, 't')).not.toContain('束缚');
    expect(hasConc(s, 'c'), '效应没了，专注也该跟着结束').toBe(false);
  });

  it('endsOn: damageTaken 真的会因为「受到伤害」而结束（damageTaken 以前只开窗口、不发事件）', () => {
    const dice = scriptedDice();
    const TEST2 = {
      note: 'T2',
      entries: {
        'T:尖刺护盾': {
          name: '尖刺护盾',
          actions: [{
            id: 'cast', name: '尖刺护盾', activation: 'action', tags: ['spell', 'magical'], cost: [{ slot: { min: 1 } }],
            targeting: { type: 'self' },
            root: [{
              kind: 'applyEffect',
              inline: { name: '尖刺护盾', effects: [{ statics: [{ kind: 'ac', bonus: 2 }] }] },
              to: 'self',
              duration: { endsOn: [{ event: 'damageTaken' }] },
            }],
          }],
        },
        'T:箭': {
          name: '箭',
          actions: [{
            id: 'cast', name: '箭', activation: 'action', tags: ['spell', 'magical'], cost: [{ slot: { min: 1 } }],
            targeting: { type: 'creature', count: 1, range: 60 },
            root: [{ kind: 'damage', dice: '5', type: '穿刺' }],
          }],
        },
      },
    } as unknown as RuleFile;
    const s = new Session(createEncounter('d'), { rules: new RuleBook([rulesJson as unknown as RuleFile, TEST2] as RuleFile[]), diceFor: () => dice });
    const add = (id: string, view: Record<string, unknown>) => done(s.dispatch({
      type: 'addCombatant',
      combatant: makeCombatant({ id, kind: 'pc', view: makeView({ name: id, hpMax: 30, ac: 12, ...view }) }),
    }));
    add('a', { level: 5, score: { wis: 16 }, pb: 3, spell: { dc: 13, atk: 5, mod: 3, ability: 'wis' }, slots: { 1: 4 }, sources: ['T:尖刺护盾', 'T:箭'] });
    add('b', {});
    done(s.dispatch({ type: 'startCombat', order: ['a', 'b'] }));
    done(s.dispatch({ type: 'useAction', actor: 'a', action: 'T:尖刺护盾#cast', targets: [] }));
    expect(effectNames(s, 'a')).toContain('尖刺护盾');
    // 转到下一轮再打自己（一个回合只有一个动作）
    for (let i = 0; i < 8; i++) {
      let r = s.dispatch({ type: 'nextTurn' });
      while (r.status === 'pending') r = s.decide([r.decision.options?.[0]?.id ?? '']);
      if (i > 0 && s.state.order[s.state.turnIndex] === 'a') break;
    }
    dice.push(5);
    done(s.dispatch({ type: 'useAction', actor: 'a', action: 'T:箭#cast', targets: ['a'], slotLevel: 1 }));
    expect(effectNames(s, 'a'), '受到伤害后效应该结束').not.toContain('尖刺护盾');
  });
});
