// 无视抗性 / 无视免疫：damage 节点上的两个旗标
import { describe, expect, it } from 'vitest';
import { RuleBook, Session, createEncounter, makeCombatant, makeView, scriptedDice, type RuleFile } from '../../src/combat';
import { FILES, done, evs } from './helpers';

const TEST = {
  note: 'T',
  entries: {
    'T:spell:灼': {
      name: '灼烧',
      actions: [{
        id: 'cast', name: '灼烧', activation: 'action', tags: ['spell', 'magical'],
        cost: [{ slot: { min: 1 } }],
        targeting: { type: 'creature', count: 1, range: 60 },
        root: [{ kind: 'damage', dice: '10', type: '火焰', to: 'target' }],
      }],
    },
    'T:spell:穿甲灼': {
      name: '穿甲灼烧',
      actions: [{
        id: 'cast', name: '穿甲灼烧', activation: 'action', tags: ['spell', 'magical'],
        cost: [{ slot: { min: 1 } }],
        targeting: { type: 'creature', count: 1, range: 60 },
        root: [{ kind: 'damage', dice: '10', type: '火焰', to: 'target', ignoreResist: true, ignoreImmunity: true }],
      }],
    },
  },
} as unknown as RuleFile;

/** 一场新战斗：`c` 打 `t`，`t` 的抗性/免疫由参数给 */
const fight = (trait: Record<string, unknown>) => {
  const dice = scriptedDice();
  dice.push(...Array.from({ length: 30 }, () => 3));
  const s = new Session(createEncounter('ir'), { rules: new RuleBook([...FILES, TEST] as RuleFile[]), diceFor: () => dice });
  const add = (id: string, side: string, view: Record<string, unknown>) => done(s.dispatch({
    type: 'addCombatant',
    combatant: makeCombatant({ id, kind: side === 'enemy' ? 'monster' : 'pc', side, view: makeView({ name: id, hpMax: 60, ac: 10, ...view }) }),
  }));
  add('c', 'enemy', { slots: { 1: 2 }, spell: { dc: 13, atk: 5, mod: 3, ability: 'int' }, sources: ['T:spell:灼', 'T:spell:穿甲灼'] });
  add('t', 'party', trait);
  done(s.dispatch({ type: 'startCombat', order: ['c', 't'] }));
  return s;
};
const cast = (s: Session, action: string) => {
  let r = s.dispatch({ type: 'useAction', actor: 'c', action, targets: ['t'] });
  for (let i = 0; i < 4 && r.status === 'pending'; i++) {
    const d = r.decision as unknown as { options?: Array<{ id: string }>; questions?: Array<{ id: string }> };
    r = d.options?.length ? s.decide(String(d.options[0].id)) : s.decide(Object.fromEntries((d.questions ?? []).map((q) => [q.id, true])));
  }
  done(r);
  return 60 - s.state.combatants['t'].live.hp;
};

describe('伤害无视抗性 / 免疫', () => {
  it('普通伤害：抗性减半、免疫归零', () => {
    expect(cast(fight({ resist: ['火焰'] }), 'T:spell:灼#cast'), '抗性：10 点减半成 5').toBe(5);
    expect(cast(fight({ immune: ['火焰'] }), 'T:spell:灼#cast'), '免疫：0 点').toBe(0);
  });

  it('标了 ignoreResist / ignoreImmunity：抗性不生效、免疫也不生效', () => {
    expect(cast(fight({ resist: ['火焰'] }), 'T:spell:穿甲灼#cast'), '无视抗性：吃满 10').toBe(10);
    expect(cast(fight({ immune: ['火焰'] }), 'T:spell:穿甲灼#cast'), '无视免疫：吃满 10').toBe(10);
  });

  it('事件里不再写「抗性减半」的说明', () => {
    const s = fight({ resist: ['火焰'] });
    cast(s, 'T:spell:穿甲灼#cast');
    const notes = evs(s, 'damageApplied').flatMap((e) => (e.notes as string[] | undefined) ?? []);
    expect(notes.some((n) => n.includes('抗性'))).toBe(false);
  });
});
