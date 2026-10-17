// 灵光授予的静态修正要生效（净化灵光的毒素抗性、勇气灵光的免疫恐慌）—— 以前是死数据
import { describe, expect, it } from 'vitest';
import rulesJson from '../../data/rules-2024.json';
import {
  RuleBook, Session, createEncounter, effectiveView, makeCombatant, makeView, scriptedDice, type Positions, type RuleFile,
} from '../../src/combat';
import { done, evs } from './helpers';

const TEST = {
  note: 'T',
  entries: {
    'T:防护灵光': {
      name: '防护灵光',
      auras: [{
        id: 'ward', name: '防护灵光', radius: 30, affects: 'allies', includeSelf: true,
        grant: { statics: [{ kind: 'resist', values: ['毒素'] }, { kind: 'conditionImmune', values: ['恐慌'] }] },
      }],
    },
    'T:毒针': {
      name: '毒针',
      actions: [{
        id: 'cast', name: '毒针', activation: 'action', tags: ['spell', 'magical'], cost: [{ slot: { min: 1 } }],
        targeting: { type: 'creature', count: 1, range: 60 },
        root: [{ kind: 'damage', dice: '10', type: '毒素' }],
      }],
    },
  },
} as unknown as RuleFile;

function scene(dist: number) {
  const dice = scriptedDice();
  const positions = { current: { p: { x: 0, y: 0, s: 1 }, a: { x: dist, y: 0, s: 1 } } as Positions };
  const s = new Session(createEncounter('a'), {
    rules: new RuleBook([rulesJson as unknown as RuleFile, TEST] as RuleFile[]),
    diceFor: () => dice, positions: () => positions.current,
  });
  const add = (id: string, view: Record<string, unknown>) => done(s.dispatch({
    type: 'addCombatant',
    combatant: makeCombatant({ id, kind: 'pc', view: makeView({ name: id, hpMax: 60, ac: 12, ...view }) }),
  }));
  add('p', { level: 5, score: { wis: 16 }, pb: 3, spell: { dc: 13, atk: 5, mod: 3, ability: 'wis' }, slots: { 1: 2 }, sources: ['T:防护灵光', 'T:毒针'] });
  add('a', { level: 1 });
  done(s.dispatch({ type: 'startCombat', order: ['p', 'a'] }));
  return { s, dice };
}

const resist = (s: Session, id: string) => s.peek((tx) => effectiveView(tx, id).resist);

describe('灵光授予的静态修正', () => {
  it('范围内的盟友吃到了灵光的抗性与状态免疫', () => {
    const { s } = scene(3);                       // 15 尺，在 30 尺灵光内
    expect(resist(s, 'a')).toContain('毒素');
    expect(s.peek((tx) => effectiveView(tx, 'a').conditionImmune)).toContain('恐慌');
    expect(resist(s, 'p'), '自身也在灵光里（includeSelf）').toContain('毒素');
  });

  it('真的减半：10 点毒素打到灵光内的盟友只掉 5', () => {
    const { s, dice } = scene(3);
    dice.push(10);
    done(s.dispatch({ type: 'useAction', actor: 'p', action: 'T:毒针#cast', targets: ['a'], slotLevel: 1 }));
    const applied = evs(s, 'damageApplied').at(-1);
    expect(applied.total ?? applied.amount).toBe(5);
  });

  it('范围外的盟友不减免：10 点毒素照常掉 10', () => {
    const { s, dice } = scene(10);                // 50 尺，超出 30 尺
    dice.push(10);
    done(s.dispatch({ type: 'useAction', actor: 'p', action: 'T:毒针#cast', targets: ['a'], slotLevel: 1 }));
    const applied = evs(s, 'damageApplied').at(-1);
    expect(applied.total ?? applied.amount).toBe(10);
  });
});
