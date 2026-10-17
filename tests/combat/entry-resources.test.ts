// 条目自己声明的次数池要进战斗：`resources: [{ id, name, formula, recovery }]` + `cost: [{ resource }]`
import { describe, expect, it } from 'vitest';
import rulesJson from '../../data/rules-2024.json';
import { RuleBook, Session, createEncounter, makeCombatant, makeView, scriptedDice, type RuleFile } from '../../src/combat';
import { done } from './helpers';

const TEST = {
  note: 'T',
  entries: {
    // 条目自己声明一个「气」池（上限 = 熟练加值），动作花它
    'T:武艺': {
      name: '武艺',
      resources: [{ id: 'ki', name: '气', formula: 'pb', recovery: 'short' }],
      actions: [{
        id: 'strike', name: '气击', activation: 'bonus', tags: ['feature'], targeting: { type: 'creature', count: 1, range: 5 },
        cost: [{ resource: 'ki' }],
        root: [{ kind: 'damage', dice: '1d6', type: '钝击' }],
      }],
    },
  },
} as unknown as RuleFile;
const FILES = [rulesJson as unknown as RuleFile, TEST];

function scene() {
  const dice = scriptedDice();
  const s = new Session(createEncounter('r'), { rules: new RuleBook(FILES), diceFor: () => dice });
  const add = (id: string, view: Record<string, unknown>) => done(s.dispatch({
    type: 'addCombatant',
    combatant: makeCombatant({ id, kind: 'pc', view: makeView({ name: id, hpMax: 30, ac: 12, ...view }) }),
  }));
  add('m', { level: 5, pb: 3, score: { dex: 16 }, sources: ['T:武艺'] });
  add('g', {});
  done(s.dispatch({ type: 'startCombat', order: ['m', 'g'] }));
  return { s, dice };
}

describe('条目声明的资源池', () => {
  it('声明了 `resources` 就能花：上限按 formula 算（气 = 熟练加值 3）', () => {
    const { s, dice } = scene();
    dice.push(4);
    done(s.dispatch({ type: 'useAction', actor: 'm', action: 'T:武艺#strike', targets: ['g'] }));
    expect(s.state.combatants.m.live.resourcesUsed.ki).toBe(1);
    const names = s.peek((tx) => tx.rules.entry('T:武艺')?.resources?.[0]?.name);
    expect(names).toBe('气');
    // 用三次就该用完了（上限 3）：每次先转到新的一回合（附赠动作每回合只有一次）
    for (let i = 0; i < 2; i++) {
      for (let k = 0; k < 8; k++) {
        let r = s.dispatch({ type: 'nextTurn' });
        while (r.status === 'pending') r = s.decide([r.decision.options?.[0]?.id ?? '']);
        if (k > 0 && s.state.order[s.state.turnIndex] === 'm') break;
      }
      dice.push(4);
      done(s.dispatch({ type: 'useAction', actor: 'm', action: 'T:武艺#strike', targets: ['g'] }));
    }
    expect(s.state.combatants.m.live.resourcesUsed.ki).toBe(3);
  });
});
