// 窗口里的 self / target / actor / attacker 到底是谁（写反应类数据最常踩的坑，用测试钉住语义）
import { describe, expect, it } from 'vitest';
import rulesJson from '../../data/rules-2024.json';
import { RuleBook, Session, createEncounter, makeCombatant, makeView, scriptedDice, type RuleFile } from '../../src/combat';
import { done, evs, last } from './helpers';

/** 一张最小的测试规则：一条单体法术 + 几条「被施法时 / 降到 0 时」的触发器 */
const TEST = {
  note: 'T',
  entries: {
    'T:spell:射线': {
      name: '射线',
      actions: [{
        id: 'cast', name: '射线', activation: 'action', tags: ['spell'], cost: [{ slot: { min: 1 } }],
        targeting: { type: 'creature', count: 1, range: 60 },
        root: [{ kind: 'damage', dice: '1d6', type: '火焰' }],
      }],
    },
    // 被这次施法选为目标的人（role: 'target'）会看到窗口，target 就是他自己
    'T:护身符': {
      name: '护身符',
      triggers: [{
        id: 'ward', label: '被施法时', on: 'spellCast', window: 'before', role: 'target',
        when: 'target.id == self.id', do: [{ kind: 'note', text: '护身符：有人对我施法' }],
      }],
    },
    // 施法者自己（role: 'actor'）看到窗口：attacker 是施法者，target 是被打的那个
    'T:施法者标记': {
      name: '施法者标记',
      triggers: [{
        id: 'mark', label: '我施法时', on: 'spellCast', window: 'after', role: 'actor',
        when: 'attacker.id == self.id && target.id != self.id', do: [{ kind: 'note', text: '施法者标记：我打的是别人' }],
      }],
    },
    // 有人降到 0 时：self = 能力拥有者（挂这条的人），target = 倒下的那个
    'T:看护者': {
      name: '看护者',
      triggers: [{
        id: 'watch', label: '有人倒下时', on: 'reducedTo0', window: 'before', role: 'any',
        when: 'target.id != self.id', do: [{ kind: 'note', text: '看护者：别人倒下了' }],
      }],
    },
  },
} as unknown as RuleFile;

const FILES = [rulesJson as unknown as RuleFile, TEST];

function scene(hpB = 30) {
  const dice = scriptedDice();
  const s = new Session(createEncounter('w'), { rules: new RuleBook(FILES), diceFor: () => dice });
  const add = (id: string, view: Record<string, unknown>) => done(s.dispatch({
    type: 'addCombatant',
    combatant: makeCombatant({ id, kind: 'pc', view: makeView({ name: id, hpMax: 30, ac: 12, ...view }) }),
  }));
  add('a', { level: 3, score: { int: 16 }, pb: 2, spell: { dc: 13, atk: 5, mod: 3, ability: 'int' }, slots: { 1: 3 }, sources: ['T:spell:射线', 'T:施法者标记'] });
  add('b', { hpMax: hpB, sources: ['T:护身符'] });
  add('c', { sources: ['T:看护者'] });
  done(s.dispatch({ type: 'startCombat', order: ['a', 'b', 'c'] }));
  return { s, dice };
}

describe('窗口里的身份语义', () => {
  it('spellCast：target 是被施法的那个、attacker 是施法者（role: target / actor 都问得到）', () => {
    const { s, dice } = scene();
    dice.push(3);                              // 射线的 1d6
    done(s.dispatch({ type: 'useAction', actor: 'a', action: 'T:spell:射线#cast', targets: ['b'], slotLevel: 1 }));
    const fired = evs(s, 'triggerFired').map((e) => e.label);
    expect(fired).toContain('被施法时');       // b：target == self
    expect(fired).toContain('我施法时');       // a：attacker == self 且 target 是别人
    expect(last(s, 'triggerFired').event).toBe('spellCast');
  });

  it('reducedTo0：self 是挂能力的人、target 是倒下的那个', () => {
    const { s, dice } = scene(6);              // 6 点生命，一发满伤害就打倒
    dice.push(6);
    done(s.dispatch({ type: 'useAction', actor: 'a', action: 'T:spell:射线#cast', targets: ['b'], slotLevel: 1 }));
    expect(s.state.combatants.b.live.hp).toBe(0);
    expect(evs(s, 'triggerFired').map((e) => e.label)).toContain('有人倒下时');
  });
});
