// 区域和放出它的那道法术关联：区域每次生效都压一个动作实例（action.* 读得到那道法术），
// 区域伤害算法术伤害；「每次施法只一次」的记号跨回合记在区域上（zoneMarked 事件）
import { describe, expect, it } from 'vitest';
import { RuleBook, Session, createEncounter, makeCombatant, makeView, scriptedDice, type Positions, type RuleFile } from '../../src/combat';
import { FILES, done, evs, goblin, wizard, type Who } from './helpers';

const TEST: RuleFile = {
  entries: {
    // 简化的火墙术：出现时和在里面开始回合时受 5 点火焰伤害（不掷骰，好算）
    'XPHB:spell:火墙术': {
      name: '火墙术',
      actions: [{
        id: 'cast', name: '火墙术', activation: 'action', tags: ['spell'], targeting: { type: 'area' }, concentration: { minutes: 1 },
        cost: [{ slot: { min: 4 } }],
        root: [{ kind: 'zone', on: ['create', 'turnStart'], do: [{ kind: 'damage', dice: '5', type: '火焰' }] }],
      }],
    },
    // 区域的 do 里读 action.*：读得到就写一句
    'T:spell:探针区': {
      name: '探针区',
      actions: [{
        id: 'cast', name: '探针区', activation: 'action', tags: ['spell'], targeting: { type: 'area' },
        root: [{ kind: 'zone', on: ['create'], do: [{ kind: 'if', when: "action.kind == 'spell' && action.zone != null && action.by == self", then: [{ kind: 'note', text: '区域里读到了动作实例' }] }] }],
      }],
    },
  },
} as unknown as RuleFile;

function scene(sources: string[]) {
  const dice = scriptedDice();
  const positions = { current: { w: { x: 0, y: 5, s: 1 }, g: { x: 3, y: 1, s: 1 } } as Positions };
  const s = new Session(createEncounter('t'), { rules: new RuleBook([...FILES, TEST], []), diceFor: () => dice, positions: () => positions.current });
  const cs: Who[] = [wizard({ level: 10, slots: { 4: 2 }, sources: ['XPHB:spell:火墙术', 'T:spell:探针区', ...sources] }), goblin('g', {}, 40)];
  for (const c of cs) done(s.dispatch({ type: 'addCombatant', combatant: makeCombatant({ id: c.id, kind: c.kind, side: c.side, hp: c.hp, view: makeView(c.view) }) }));
  done(s.dispatch({ type: 'startCombat', order: ['w', 'g'] }));
  return { s, hp: () => s.state.combatants.g.live.hp };
}
const cells = ['3,0', '3,1', '3,2'];

describe('区域关联到放出它的法术', () => {
  it('区域的 do 里读得到 action（kind、zone、by）', () => {
    const { s } = scene([]);
    done(s.dispatch({ type: 'useAction', actor: 'w', action: 'T:spell:探针区#cast', targets: [], area: { cells } }));
    expect(evs(s, 'note').map((n) => n.text)).toContain('区域里读到了动作实例');
  });

  it('区域伤害是法术伤害：强效塑能加上；同一次施法之后每回合不再加', () => {
    const { s, hp } = scene(['XPHB:法师:强效塑能:10']);
    done(s.dispatch({ type: 'useAction', actor: 'w', action: 'XPHB:spell:火墙术#cast', targets: [], area: { cells }, slotLevel: 4 }));
    expect(hp()).toBe(40 - (5 + 3));   // 出现时：5 + 智力 3
    done(s.dispatch({ type: 'nextTurn' }));   // 地精在火墙里开始回合
    expect(hp()).toBe(40 - 8 - 5);   // 同一次施法：不再加
    expect(Object.values(s.state.zones!)[0].marks).toEqual({ empoweredEvocation: true });
  });

  it('撤销一回合：区域上的记号跟着回到那时候（重放一致）', () => {
    const { s, hp } = scene(['XPHB:法师:强效塑能:10']);
    done(s.dispatch({ type: 'useAction', actor: 'w', action: 'XPHB:spell:火墙术#cast', targets: [], area: { cells }, slotLevel: 4 }));
    done(s.dispatch({ type: 'nextTurn' }));
    s.undo();
    expect(hp()).toBe(40 - 8);
    expect(Object.values(s.state.zones!)[0].marks).toEqual({ empoweredEvocation: true });
    done(s.dispatch({ type: 'nextTurn' }));
    expect(hp()).toBe(40 - 8 - 5);
  });
});
