// 同名效应不叠：同一个来源反复施加同一条状态（区域每回合触发、同一道法术再施展），身上只该有一份
import { describe, expect, it } from 'vitest';
import rulesJson from '../../data/rules-2024.json';
import { RuleBook, Session, createEncounter, makeCombatant, makeView, scriptedDice, type RuleFile } from '../../src/combat';
import { done, effectNames } from './helpers';

const TEST = {
  note: 'T',
  entries: {
    // 给目标挂一个「诅咒」效应（带一段持续时间，模拟区域每回合触发 / 反复施展）
    'T:spell:咒': {
      name: '咒',
      actions: [{
        id: 'cast', name: '咒', activation: 'action', tags: ['spell', 'magical'], cost: [{ slot: { min: 1 } }],
        targeting: { type: 'creature', count: 1, range: 30 },
        root: [{ kind: 'applyEffect', inline: { name: '诅咒', tags: ['condition'], effects: [] }, to: 'target', duration: { rounds: 3 } }],
      }],
    },
  },
} as unknown as RuleFile;
const FILES = [rulesJson as unknown as RuleFile, TEST];

function scene() {
  const dice = scriptedDice();
  const s = new Session(createEncounter('e'), { rules: new RuleBook(FILES), diceFor: () => dice });
  const add = (id: string, view: Record<string, unknown>) => done(s.dispatch({
    type: 'addCombatant',
    combatant: makeCombatant({ id, kind: 'pc', view: makeView({ name: id, hpMax: 30, ac: 12, ...view }) }),
  }));
  add('c', { level: 3, score: { int: 16 }, pb: 2, spell: { dc: 13, atk: 5, mod: 3, ability: 'int' }, slots: { 1: 5 }, sources: ['T:spell:咒'] });
  add('g', {});
  done(s.dispatch({ type: 'startCombat', order: ['c', 'g'] }));
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

describe('同名效应不叠', () => {
  it('同一个效应施加两次 → 身上只有一份（刷新而不是叠）', () => {
    const { s } = scene();
    done(s.dispatch({ type: 'useAction', actor: 'c', action: 'T:spell:咒#cast', targets: ['g'], slotLevel: 1 }));
    expect(effectNames(s, 'g')).toEqual(['诅咒']);
    backToC(s);
    done(s.dispatch({ type: 'useAction', actor: 'c', action: 'T:spell:咒#cast', targets: ['g'], slotLevel: 1 }));
    expect(effectNames(s, 'g'), '第二次施加应该是刷新，不是再叠一份').toEqual(['诅咒']);
  });
});
