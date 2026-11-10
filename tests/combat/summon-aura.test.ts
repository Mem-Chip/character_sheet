// 召唤物 + 不靠专注的光环（牧人结社那一类）用到的几样接口：
//   target.summoner（认出「由你召唤的生物」）、inZone（在不在某人放下的区域里）、
//   zone.withEffect（区域随施放者身上的效应结束）、effectApplied 窗口（「陷入失能时」）、
//   d20Rolled before 的 adv / disadv（掷完再给优势）
import { describe, expect, it } from 'vitest';
import { RuleBook, Session, createEncounter, makeCombatant, makeView, scriptedDice, type Positions, type RuleFile } from '../../src/combat';
import { FILES, done, evs, goblin, pending, type Who } from './helpers';

const TEST = {
  entries: {
    'T:图腾': {
      name: '图腾',
      effects: {
        图腾: { duration: { minutes: 1, endsOn: [{ event: 'effectApplied', when: "event.bearer == self.id && self.has('失能')" }] } },
        环内: { text: '在图腾光环里' },
      },
      actions: [{
        id: 'use', name: '图腾', activation: 'bonus', targeting: { type: 'area' },
        root: [
          { kind: 'applyEffect', to: 'self', template: '图腾' },
          { kind: 'zone', name: '图腾光环', withEffect: '图腾', affects: 'all', while: [{ kind: 'applyEffect', template: '环内' }] },
        ],
      }],
      triggers: [
        // 召唤物在光环里结束回合：回 3 点
        { id: 'soothe', label: '图腾：抚慰', on: 'turnEnded', role: 'ally', when: "target.summoner == self.id && inZone(target, self, '图腾光环')", do: [{ kind: 'heal', to: 'target', amount: '3' }] },
      ],
    },
    'T:spell:唤狼': {
      name: '唤狼',
      actions: [{ id: 'cast', name: '唤狼', activation: 'action', tags: ['spell'], root: [{ kind: 'summon', name: '灵狼', hp: '10', link: false }] }],
    },
    // 掷完再给优势
    'T:鹰眼': {
      name: '鹰眼',
      triggers: [{ id: 'adv', label: '鹰眼', on: 'd20Rolled', window: 'before', role: 'any', when: "roll.kind == 'attack'", modify: [{ op: 'adv' }] }],
    },
    // 陷入失能时
    'T:护主': {
      name: '护主',
      triggers: [{ id: 'aid', label: '护主', on: 'effectApplied', role: 'target', when: "includes(event.conditions, '失能')", do: [{ kind: 'note', text: '护主触发' }] }],
    },
    'T:击晕': {
      name: '击晕',
      actions: [{ id: 'use', name: '击晕', activation: 'action', targeting: { type: 'creature', count: 1 }, root: [{ kind: 'applyEffect', template: 'XPHB:condition:震慑' }] }],
    },
  },
} as unknown as RuleFile;

const druid = (sources: string[]): Who => ({ id: 'd', kind: 'pc', view: { name: '德鲁伊', hpMax: 30, ac: 12, spell: { dc: 13, atk: 5, mod: 3, ability: 'wis' }, sources } });

function setup(cs: Who[], at?: Record<string, [number, number]>) {
  const dice = scriptedDice();
  const positions = at ? { current: Object.fromEntries(Object.entries(at).map(([id, [x, y]]) => [id, { x, y, s: 1 }])) as Positions } : null;
  const s = new Session(createEncounter('t'), { rules: new RuleBook([...FILES, TEST]), diceFor: () => dice, positions: positions ? () => positions.current : undefined });
  for (const c of cs) done(s.dispatch({ type: 'addCombatant', combatant: makeCombatant({ id: c.id, kind: c.kind, side: c.side, hp: c.hp, view: makeView(c.view) }) }));
  return { s, dice, positions };
}
const zones = (s: Session) => Object.values(s.state.zones ?? {});
const wolf = (s: Session) => Object.values(s.state.combatants).find((c) => c.name === '灵狼')!;

describe('召唤物与光环', () => {
  it('summoner + inZone：只给在光环里的、自己召唤的生物回血', () => {
    const { s, positions } = setup([druid(['T:图腾', 'T:spell:唤狼']), goblin('g', {}, 30)], { d: [0, 0], g: [9, 9] });
    done(s.dispatch({ type: 'useAction', actor: 'd', action: 'T:spell:唤狼#cast', targets: [] }));
    const w = wolf(s);
    expect(w.summoner).toBe('d');
    // 光环盖住狼所在的格子（狼放在德鲁伊旁边）
    for (const m of evs(s, 'moved')) positions!.current[m.id] = { ...positions!.current[m.id], ...m.to, s: 1 };
    const wp = positions!.current[w.id];
    done(s.dispatch({ type: 'useAction', actor: 'd', action: 'T:图腾#use', targets: [], area: { cells: [`${wp.x},${wp.y}`] } }));
    done(s.dispatch({ type: 'adjustHp', id: w.id, delta: -5 }));
    done(s.dispatch({ type: 'startCombat', order: [w.id, 'g', 'd'] }));
    done(s.dispatch({ type: 'nextTurn' }));
    expect(s.state.combatants[w.id].live.hp).toBe(8);
    // 地精不是召唤物、也不在环里：不回
    done(s.dispatch({ type: 'nextTurn' }));
    expect(s.state.combatants.g.live.hp).toBe(30);
  });

  it('withEffect：失能时效应结束，区域和环内的效应一起消失', () => {
    const { s } = setup([druid(['T:图腾']), goblin('g', { sources: ['T:击晕'] }, 30)], { d: [0, 0], g: [1, 0] });
    done(s.dispatch({ type: 'useAction', actor: 'd', action: 'T:图腾#use', targets: [], area: { cells: ['0,0', '1,0'] } }));
    expect(zones(s)).toHaveLength(1);
    expect(Object.values(s.state.effects).filter((e) => e.name === '环内')).toHaveLength(2);
    done(s.dispatch({ type: 'useAction', actor: 'g', action: 'T:击晕#use', targets: ['d'] }));
    expect(zones(s)).toHaveLength(0);
    expect(Object.values(s.state.effects).some((e) => e.name === '图腾' || e.name === '环内')).toBe(false);
  });

  it('effectApplied 窗口：陷入带失能的状态时触发（隐含的也算）', () => {
    const { s } = setup([druid(['T:护主']), goblin('g', { sources: ['T:击晕'] }, 30)]);
    done(s.dispatch({ type: 'useAction', actor: 'g', action: 'T:击晕#use', targets: ['d'] }));
    expect(evs(s, 'note').some((n) => n.text === '护主触发')).toBe(true);
  });

  it('adv：掷完再给优势 = 补掷一颗取高；已有劣势 = 抵消', () => {
    const a = setup([druid(['T:鹰眼']), goblin('g', {}, 30)]);
    a.dice.push(5, 17, 1);
    a.s.dispatch({ type: 'useAction', actor: 'g', action: 'weapon:sc', targets: ['d'] });
    const r = evs(a.s, 'd20Rolled')[0];
    expect(r.d20).toEqual([5, 17]);
    expect(r.natural).toBe(17);
    expect(r.adv).toBe(true);
  });

  it('没有地图时 inZone 问人', () => {
    const { s } = setup([druid(['T:图腾', 'T:spell:唤狼']), goblin('g', {}, 30)]);
    done(s.dispatch({ type: 'useAction', actor: 'd', action: 'T:spell:唤狼#cast', targets: [] }));
    const w = wolf(s);
    done(s.dispatch({ type: 'startCombat', order: [w.id, 'd'] }));
    const d = pending(s.dispatch({ type: 'nextTurn' }));
    expect(JSON.stringify(d)).toContain('图腾光环');
  });
});
