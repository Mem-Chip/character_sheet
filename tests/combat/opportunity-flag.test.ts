// 「不能进行借机攻击」：flags.cannot 里写动作 id 就不能用那个动作 —— 借机攻击是规则数据里 id 为 opportunityAttack 的反应（电爪就是这样写的）
import { describe, expect, it } from 'vitest';
import { RuleBook, Session, createEncounter, makeCombatant, makeView, scriptedDice, type Positions, type RuleFile } from '../../src/combat';
import { FILES, done, pending } from './helpers';

const TEST = {
  note: 'T',
  entries: {
    // 给目标挂一个「不能借机攻击」的效应（和电爪数据里那份一样）
    'T:电爪式': {
      name: '电爪式',
      effects: { '不能借机攻击': { flags: { cannot: ['opportunityAttack'] } } },
      actions: [{
        id: 'cast', name: '电爪式', activation: 'action', tags: ['spell', 'magical'],
        targeting: { type: 'creature', count: 1, range: 5 },
        root: [{ kind: 'applyEffect', template: '不能借机攻击', duration: { until: { at: 'turnStart', of: 'bearer', nth: 1 } } }],
      }],
    },
  },
} as unknown as RuleFile;

/**
 * 站位：敌人 z（0,0）｜玩家 a（1,0，有近战武器、会吃借机攻击）｜敌人 b（2,0，要走开）
 * 谁走开：b 离开 a 的触及范围 → 正常会问 a「借机攻击吗」。给 a 挂上电爪的效应之后就不该问。
 */
function scene() {
  const dice = scriptedDice();
  const positions = { current: { z: { x: 0, y: 0, s: 1 }, a: { x: 1, y: 0, s: 1 }, b: { x: 2, y: 0, s: 1 } } as Positions };
  const s = new Session(createEncounter('o'), { rules: new RuleBook([...FILES, TEST] as RuleFile[]), diceFor: () => dice, positions: () => positions.current });
  const add = (id: string, view: Record<string, unknown>, kind: 'pc' | 'monster' = 'pc') => done(s.dispatch({
    type: 'addCombatant',
    combatant: makeCombatant({ id, kind, ...(kind === 'monster' ? { side: 'enemy' } : {}), view: makeView({ name: id, hpMax: 30, ac: 12, ...view }) }),
  }));
  const attack = { id: 'atk-1', name: '爪', bonus: 5, damage: '1d6 + 2', damageType: '挥砍', melee: true, ranged: false, finesse: false, ability: 'str' };
  add('z', { sources: ['T:电爪式'], slots: { 1: 1 }, spell: { dc: 13, atk: 5, mod: 3, ability: 'int' } }, 'monster');
  add('a', { attacks: [attack] });
  add('b', { attacks: [attack] }, 'monster');
  done(s.dispatch({ type: 'startCombat', order: ['z', 'b', 'a'] }));
  const sync = () => { for (const m of s.events.filter((e) => e.type === 'moved').map((e) => e.payload as { id: string; to: { x: number; y: number } })) positions.current[m.id] = { ...positions.current[m.id], ...m.to }; };
  return { s, dice, sync };
}
const holder = (s: Session) => s.state.order[s.state.turnIndex];
/** 走到 b 的回合 */
function toB(s: Session): void { for (let i = 0; i < 6 && holder(s) !== 'b'; i++) done(s.dispatch({ type: 'nextTurn' })); }
/** b 从 a 的触及范围走开 */
const walkAway = (s: Session) => s.dispatch({ type: 'move', id: 'b', ft: 5, path: [{ x: 2, y: 0 }, { x: 3, y: 0 }] });

describe('不能进行借机攻击（flags.cannot = opportunityAttack）', () => {
  it('挂了电爪效应的生物，别人走开时不会被告知「借机攻击吗」', () => {
    const { s, sync } = scene();
    // z 在它自己的回合给 a 挂上
    done(s.dispatch({ type: 'useAction', actor: 'z', action: 'T:电爪式#cast', targets: ['a'] }));
    expect(Object.values(s.state.effects).some((e) => e.bearer === 'a' && e.name === '不能借机攻击')).toBe(true);
    toB(s);
    const r = walkAway(s);
    expect(r.status, '不能借机攻击的人不该被问').toBe('done');
    sync();
  });

  it('没挂效应时照常问（对照）', () => {
    const { s } = scene();
    toB(s);
    const r = walkAway(s);
    expect(r.status).toBe('pending');
    expect(pending(r).to, '该问的是 a（被离开触及范围的那个）').toBe('a');
  });
});
