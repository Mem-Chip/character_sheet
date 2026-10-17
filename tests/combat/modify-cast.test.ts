// 改法术的旋钮：unlessSave（引擎先掷豁免）+ 子修改 setDc / setDamageType
import { describe, expect, it } from 'vitest';
import { RuleBook, Session, createEncounter, makeCombatant, makeView, scriptedDice, type RuleFile } from '../../src/combat';
import { FILES, done, evs } from './helpers';

const TEST = {
  note: 'T',
  entries: {
    // 一道带豁免的火焰法术：DC = 施法者法术 DC，失败吃 2d6 火焰
    'T:spell:灼': {
      name: '灼烧',
      actions: [{
        id: 'cast', name: '灼烧', activation: 'action', tags: ['spell', 'magical'],
        cost: [{ slot: { min: 1 } }],
        targeting: { type: 'creature', count: 1, range: 60 },
        root: [{ kind: 'save', ability: 'dex', to: 'target', dc: 'self.spell.dc', onFail: [{ kind: 'damage', dice: '2d6', type: '火焰', to: 'target' }] }],
      }],
    },
    // 篡改：别人施法时，让他做感知豁免，失败就把这道法术的 DC 降到 8、伤害类型改成冷冻
    'T:篡改': {
      name: '篡改',
      triggers: [{
        id: 'tamper', label: '篡改', on: 'spellCast', role: 'any', window: 'before',
        when: "attacker != null && attacker.id != self.id",
        cost: [{ economy: 'reaction' }],
        modify: [{
          op: 'unlessSave', ability: 'wis', dc: 13,
          onFail: [{ op: 'setDc', value: '8' }, { op: 'setDamageType', value: '冷冻' }],
        }],
      }],
    },
  },
} as unknown as RuleFile;

const scene = (rolls: number[]) => {
  const dice = scriptedDice();
  dice.push(...rolls, ...Array.from({ length: 24 }, () => 3));
  const s = new Session(createEncounter('mc'), { rules: new RuleBook([...FILES, TEST] as RuleFile[]), diceFor: () => dice });
  const add = (id: string, side: string, view: Record<string, unknown>) => done(s.dispatch({
    type: 'addCombatant',
    combatant: makeCombatant({ id, kind: side === 'enemy' ? 'monster' : 'pc', side, view: makeView({ name: id, hpMax: 40, ac: 10, ...view }) }),
  }));
  add('c', 'enemy', { slots: { 1: 1 }, spell: { dc: 13, atk: 5, mod: 3, ability: 'int' }, sources: ['T:spell:灼'] });
  add('r', 'party', { spell: { dc: 13, atk: 5, mod: 3, ability: 'wis' }, sources: ['T:篡改'] });
  add('t', 'party', {});
  done(s.dispatch({ type: 'startCombat', order: ['c', 'r', 't'] }));
  return s;
};
const cast = (s: Session) => {
  let r = s.dispatch({ type: 'useAction', actor: 'c', action: 'T:spell:灼#cast', targets: ['t'] });
  for (let i = 0; i < 6 && r.status === 'pending'; i++) {
    const d = r.decision as unknown as { options?: Array<{ id: string }>; questions?: Array<{ id: string }> };
    r = d.options?.length ? s.decide(String(d.options[0].id)) : s.decide(Object.fromEntries((d.questions ?? []).map((q) => [q.id, true])));
  }
  return done(r);
};

describe('改法术（unlessSave + setDc / setDamageType）', () => {
  it('施法者没通过感知豁免：这道法术的 DC 被降、伤害类型被改', () => {
    const s = scene([1]);      // 施法者的感知豁免掷 1（必败）
    cast(s);
    const dmg = evs(s, 'damageApplied').at(-1) as { byType?: Record<string, number> } | undefined;
    expect(Object.keys(dmg?.byType ?? {}), '伤害类型被改成冷冻了').toEqual(['冷冻']);
    const fail = evs(s, 'saveFailed').find((x) => String(x.label ?? '').includes('灼烧'));
    expect(fail?.dc, '这道法术的豁免 DC 被降到 8').toBe(8);
  });

  it('施法者通过了感知豁免：法术原样结算', () => {
    const s = scene([20]);     // 感知豁免掷 20（必过）
    cast(s);
    const dmg = evs(s, 'damageApplied').at(-1) as { byType?: Record<string, number> } | undefined;
    expect(Object.keys(dmg?.byType ?? {}), '还是火焰').toEqual(['火焰']);
    const fail = evs(s, 'saveFailed').find((x) => String(x.label ?? '').includes('灼烧'));
    expect(fail?.dc, 'DC 还是原来的 13').toBe(13);
  });
});
