// 战斗结束要把专注一起结束：匕首之云这类「专注 + 区域」的法术不能留在场上，
// 否则区域还能挪、专注还占着，下一次施放会被「已经在专注」挡住
import { describe, expect, it } from 'vitest';
import { RuleBook, Session, createEncounter, makeCombatant, makeView, scriptedDice, type RuleFile } from '../../src/combat';
import { FILES, done } from './helpers';

const TEST = {
  note: 'T',
  entries: {
    'T:spell:刀云': {
      name: '刀云',
      actions: [{
        id: 'cast', name: '刀云', activation: 'action', tags: ['spell', 'magical'],
        cost: [{ slot: { min: 2 } }], concentration: { minutes: 1 },
        targeting: { type: 'area', range: 60, area: { shape: 'cube', size: 5 } },
        root: [
          { kind: 'zone', name: '刀云', on: ['enter', 'turnEnd'], affects: 'all', do: [{ kind: 'damage', dice: '2d4', type: '挥砍' }] },
        ],
      }],
    },
  },
} as unknown as RuleFile;

const scene = () => {
  const dice = scriptedDice();
  dice.push(...Array.from({ length: 40 }, () => 3));
  const s = new Session(createEncounter('z'), { rules: new RuleBook([...FILES, TEST] as RuleFile[]), diceFor: () => dice });
  done(s.dispatch({
    type: 'addCombatant',
    combatant: makeCombatant({ id: 'c', kind: 'pc', side: 'party', view: makeView({ name: '施法者', hpMax: 30, ac: 10, slots: { 2: 2 }, spell: { dc: 13, atk: 5, mod: 3, ability: 'int' } }) }),
  }));
  done(s.dispatch({
    type: 'addCombatant',
    combatant: makeCombatant({ id: 't', kind: 'monster', side: 'enemy', view: makeView({ name: '目标', hpMax: 30, ac: 10 }) }),
  }));
  done(s.dispatch({ type: 'startCombat', order: ['c', 't'] }));
  return s;
};

describe('结束战斗时清掉专注与它链接的区域', () => {
  it('施法后有专注和区域；结束战斗后都没了', () => {
    const s = scene();
    // 先在地图上放一块区域，法术才有落点
    let r = s.dispatch({ type: 'useAction', actor: 'c', action: 'T:spell:刀云#cast', targets: ['t'], area: { cells: ['3,3'] } });
    for (let i = 0; i < 4 && r.status === 'pending'; i++) {
      const d = r.decision as unknown as { options?: Array<{ id: string }>; questions?: Array<{ id: string }> };
      r = d.options?.length ? s.decide(String(d.options[0].id)) : s.decide(Object.fromEntries((d.questions ?? []).map((q) => [q.id, true])));
    }
    done(r);
    const concBefore = Object.values(s.state.effects ?? {}).filter((e) => e.key === 'concentration').length;
    const zonesBefore = Object.keys(s.state.zones ?? {}).length;
    expect(concBefore, '施法后应该有专注').toBe(1);
    expect(zonesBefore, '施法后应该有一块区域').toBe(1);

    done(s.dispatch({ type: 'endCombat' }));
    const concAfter = Object.values(s.state.effects ?? {}).filter((e) => e.key === 'concentration').length;
    const zonesAfter = Object.keys(s.state.zones ?? {}).length;
    expect(concAfter, '战斗结束后不该还有专注').toBe(0);
    expect(zonesAfter, '专注结束，区域也要一起清掉').toBe(0);
  });
});

