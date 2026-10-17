// 窗口里的触发器写 cost 要真的扣（leftReach：有人离开我的触及范围时花一个反应）
import { describe, expect, it } from 'vitest';
import rulesJson from '../../data/rules-2024.json';
import {
  RuleBook, Session, createEncounter, makeCombatant, makeView, scriptedDice, type DispatchResult, type Positions, type RuleFile,
} from '../../src/combat';
import { done, evs, pending } from './helpers';

const TEST = {
  note: 'T',
  entries: {
    'T:借机标记': {
      name: '借机标记',
      triggers: [{
        id: 'mark', label: '借机标记', on: 'leftReach', window: 'after', role: 'target',
        cost: [{ economy: 'reaction' }], do: [{ kind: 'note', text: '借机标记：有人离开了我的触及范围' }],
      }],
    },
  },
} as unknown as RuleFile;
const FILES = [rulesJson as unknown as RuleFile, TEST];

function scene() {
  const dice = scriptedDice();
  const positions = { current: { f: { x: 0, y: 0, s: 1 }, g: { x: 1, y: 0, s: 1 }, h: { x: 3, y: 0, s: 1 } } as Positions };
  const s = new Session(createEncounter('c'), { rules: new RuleBook(FILES), diceFor: () => dice, positions: () => positions.current });
  const add = (id: string, view: Record<string, unknown>, kind: 'pc' | 'monster' = 'pc') => done(s.dispatch({
    type: 'addCombatant',
    combatant: makeCombatant({ id, kind, ...(kind === 'monster' ? { side: 'enemy' } : {}), view: makeView({ name: id, hpMax: 30, ac: 12, ...view }) }),
  }));
  add('f', { score: { str: 16 }, sources: ['T:借机标记'], attacks: [{ id: 'ls', name: '长剑', bonus: 5, damage: '1d8 + 3', damageType: '挥砍', melee: true, ranged: false, finesse: false, ability: 'str' }] });
  add('g', {}, 'monster');
  add('h', {}, 'monster');
  done(s.dispatch({ type: 'startCombat', order: ['g', 'h', 'f'] }));
  const sync = () => { for (const m of evs(s, 'moved')) positions.current[m.id] = { ...positions.current[m.id], ...m.to }; };
  return { s, dice, sync };
}
const notes = (s: Session) => evs(s, 'note').map((e) => e.text as string).filter((t) => t.startsWith('借机标记'));

describe('窗口触发器的代价', () => {
  it('leftReach 触发器写 cost: reaction → 反应真的扣掉，扣完就不再触发', () => {
    const { s, sync } = scene();
    expect(s.state.combatants.f.economy.reaction).toBe(1);
    // 地精离开战士的触及范围：引擎会问战士要不要借机攻击 —— 拒绝它，但我的强制触发器照样生效并扣反应
    let r = s.dispatch({ type: 'move', id: 'g', ft: 10, path: [{ x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }] });
    if (r.status === 'pending') {
      const skip = r.decision.options?.find((o) => !o.id.startsWith('oa'));
      if (skip) r = s.decide(skip.id);
    }
    done(r);
    sync();
    expect(notes(s), '强制触发器应该发过日志').toHaveLength(1);
    expect(s.state.combatants.f.economy.reaction, '反应应该被这次触发花掉').toBe(0);
    // 第二个敌人再离开：反应已经用完，不该再触发
    const r2 = s.dispatch({ type: 'move', id: 'h', ft: 5, path: [{ x: 3, y: 0 }, { x: 4, y: 0 }] });
    if (r2.status === 'pending') unknownDecision(r2);
    expect(notes(s)).toHaveLength(1);
  });
});

function unknownDecision(r: DispatchResult & { status: 'pending' }): void {
  pending(r);
}
