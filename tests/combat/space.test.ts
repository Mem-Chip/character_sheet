// 地图：借机攻击、推离、区域（法术留下的、DM 画的）、「附近的人开始回合时」
import { describe, expect, it } from 'vitest';
import { RuleBook, Session, createEncounter, makeCombatant, makeView, scriptedDice, type Positions, type RuleFile } from '../../src/combat';
import { FILES, done, evs, fighter, goblin, last, pending, wizard, type Who } from './helpers';

const TEST: RuleFile = {
  entries: {
    'T:spell:震波': {
      actions: [{
        id: 'cast', name: '震波', activation: 'action', tags: ['spell'], targeting: { type: 'creature', count: 1 },
        root: [{ kind: 'move', mode: 'push', ft: '10' }],
      }],
    },
    'T:spell:勾索': {
      actions: [{
        id: 'cast', name: '勾索', activation: 'action', tags: ['spell'], targeting: { type: 'creature', count: 1 },
        root: [{ kind: 'move', mode: 'pull', ft: '30' }],
      }],
    },
    // 专注的范围法术：进入或在里面开始回合，受 5 点火焰伤害
    'T:spell:火墙': {
      actions: [{
        id: 'cast', name: '火墙', activation: 'action', tags: ['spell'], targeting: { type: 'area' }, concentration: { minutes: 1 },
        root: [{ kind: 'zone', on: ['enter', 'turnStart'], do: [{ kind: 'damage', dice: '5', type: '火焰' }] }],
      }],
    },
    // 敌人在 10 尺内开始回合：受 2 点伤害
    'T:荆棘光环': {
      triggers: [{ id: 'aura', label: '荆棘光环', on: 'turnStarted', role: 'enemy', when: 'dist(self, target) <= 10', do: [{ kind: 'damage', dice: '2', type: '穿刺' }] }],
    },
  },
} as unknown as RuleFile;

function setupM(cs: Who[], at: Record<string, [number, number]>) {
  const dice = scriptedDice();
  const positions = { current: Object.fromEntries(Object.entries(at).map(([id, [x, y]]) => [id, { x, y, s: 1 }])) as Positions };
  const s = new Session(createEncounter('t'), { rules: new RuleBook([...FILES, TEST], []), diceFor: () => dice, positions: () => positions.current });
  for (const c of cs) done(s.dispatch({ type: 'addCombatant', combatant: makeCombatant({ id: c.id, kind: c.kind, side: c.side, hp: c.hp, view: makeView(c.view) }) }));
  // 服务器做的事：引擎发了 moved 就改地图
  const sync = () => { for (const m of evs(s, 'moved')) positions.current[m.id] = { ...positions.current[m.id], ...m.to }; };
  return { s, dice, positions, sync };
}
const hp = (s: Session, id: string) => s.state.combatants[id].live.hp;
const path = (...xs: Array<[number, number]>) => xs.map(([x, y]) => ({ x, y }));

describe('借机攻击', () => {
  it('离开战士的触及范围：问战士要不要打；打了用掉反应', () => {
    const { s, dice } = setupM([fighter(), goblin('g', { speed: 30 }, 30)], { f: [0, 0], g: [1, 0] });
    done(s.dispatch({ type: 'startCombat', order: ['g', 'f'] }));
    const d = pending(s.dispatch({ type: 'move', id: 'g', ft: 10, path: path([1, 0], [2, 0], [3, 0]) }));
    expect(d.to).toBe('f');
    // 借机攻击是规则数据里的反应：和别的「离开触及范围时」能力在同一个决定里问；只有一件近战武器就不再问用哪件
    expect(d.prompt).toContain('离开了');
    expect(d.options.map((o) => o.label)).toContain('战士：借机攻击');
    dice.push(15, 4);
    done(s.decide([d.options.find((o) => o.label === '战士：借机攻击')!.id]));
    expect(hp(s, 'g')).toBe(30 - 7);
    expect(s.state.combatants.f.economy.reaction).toBe(0);
    expect(last(s, 'moved').to).toEqual({ x: 3, y: 0 });
  });

  it('打倒了就停在原地；撤离了不会被打', () => {
    const a = setupM([fighter(), goblin('g', {}, 5)], { f: [0, 0], g: [1, 0] });
    done(a.s.dispatch({ type: 'startCombat', order: ['g', 'f'] }));
    const d = pending(a.s.dispatch({ type: 'move', id: 'g', ft: 10, path: path([1, 0], [2, 0], [3, 0]) }));
    a.dice.push(15, 4);
    done(a.s.decide([d.options.find((o) => o.label === '战士：借机攻击')!.id]));
    expect(hp(a.s, 'g')).toBe(0);
    expect(evs(a.s, 'moved')).toHaveLength(0);

    const b = setupM([fighter(), goblin('g', {}, 30)], { f: [0, 0], g: [1, 0] });
    done(b.s.dispatch({ type: 'startCombat', order: ['g', 'f'] }));
    done(b.s.dispatch({ type: 'useAction', actor: 'g', action: 'XPHB:action:撤离#use', targets: [] }));
    done(b.s.dispatch({ type: 'move', id: 'g', ft: 10, path: path([1, 0], [2, 0], [3, 0]) }));
    expect(last(b.s, 'moved').to).toEqual({ x: 3, y: 0 });
  });

  it('在触及范围里走动不算离开', () => {
    const { s } = setupM([fighter(), goblin('g', {}, 30)], { f: [1, 1], g: [0, 0] });
    done(s.dispatch({ type: 'startCombat', order: ['g', 'f'] }));
    done(s.dispatch({ type: 'move', id: 'g', ft: 5, path: path([0, 0], [1, 0]) }));
  });

  it('电爪命中后：目标直到自己下回合开始不能借机攻击', () => {
    const { s, dice } = setupM([wizard({ sources: ['XPHB:spell:电爪'] }), fighter()], { w: [0, 0], f: [1, 0] });
    done(s.dispatch({ type: 'startCombat', order: ['w', 'f'] }));
    dice.push(15, 5); // 命中战士，造成闪电伤害并贴上「电爪：不能借机攻击」
    done(s.dispatch({ type: 'useAction', actor: 'w', action: 'XPHB:spell:电爪#cast', targets: ['f'] }));
    expect(Object.values(s.state.effects).filter((e) => e.bearer === 'f').map((e) => e.name)).toContain('电爪：不能借机攻击');
    // 法师离开战士触及范围：战士不能借机攻击，直接完成移动
    done(s.dispatch({ type: 'move', id: 'w', ft: 10, path: path([0, 0], [0, 1], [0, 2]) }));
    expect(last(s, 'moved').to).toEqual({ x: 0, y: 2 });
  });
});

describe('日志回放 replayTo', () => {
  it('重放到任意历史事务步，还原当时的生命值和回合状态', () => {
    const { s, dice } = setupM([fighter(), goblin('g', {}, 30)], { f: [0, 0], g: [1, 0] });
    done(s.dispatch({ type: 'startCombat', order: ['f', 'g'] }));
    const nStart = s.transactions.length;
    dice.push(15, 6);
    done(s.dispatch({ type: 'useAction', actor: 'f', action: 'weapon:ls', targets: ['g'] })); // 6+3=9 伤害
    const nHit = s.transactions.length;
    done(s.dispatch({ type: 'nextTurn' }));
    expect(hp(s, 'g')).toBe(21);
    expect(s.state.order[s.state.turnIndex]).toBe('g');

    const atStart = s.replayTo(nStart);
    expect(hp(atStart, 'g')).toBe(30);
    expect(atStart.state.order[atStart.state.turnIndex]).toBe('f');

    const afterHit = s.replayTo(nHit);
    expect(hp(afterHit, 'g')).toBe(21);
    expect(afterHit.state.order[afterHit.state.turnIndex]).toBe('f');
  });
});

describe('推离 / 拉近', () => {
  it('推离 10 尺：沿连线走两格；被别的棋子挡住就停', () => {
    const a = setupM([wizard({ sources: ['T:spell:震波'] }), goblin('g', {}, 30)], { w: [0, 0], g: [1, 0] });
    done(a.s.dispatch({ type: 'useAction', actor: 'w', action: 'T:spell:震波#cast', targets: ['g'] }));
    expect(last(a.s, 'moved')).toMatchObject({ id: 'g', to: { x: 3, y: 0 }, forced: true });

    const b = setupM([wizard({ sources: ['T:spell:震波'] }), goblin('g', {}, 30), goblin('h')], { w: [0, 0], g: [1, 1], h: [3, 3] });
    done(b.s.dispatch({ type: 'useAction', actor: 'w', action: 'T:spell:震波#cast', targets: ['g'] }));
    expect(last(b.s, 'moved').to).toEqual({ x: 2, y: 2 });
  });

  it('拉近：拉到贴身为止', () => {
    const { s } = setupM([wizard({ sources: ['T:spell:勾索'] }), goblin('g', {}, 30)], { w: [0, 0], g: [5, 0] });
    done(s.dispatch({ type: 'useAction', actor: 'w', action: 'T:spell:勾索#cast', targets: ['g'] }));
    expect(last(s, 'moved').to).toEqual({ x: 1, y: 0 });
  });

  it('不在地图上：还是提示手动', () => {
    const { s } = setupM([wizard({ sources: ['T:spell:震波'] }), goblin('g')], { w: [0, 0] });
    done(s.dispatch({ type: 'useAction', actor: 'w', action: 'T:spell:震波#cast', targets: ['g'] }));
    expect(last(s, 'note').text).toMatch(/请在地图上移动/);
  });
});

describe('区域', () => {
  const wall = ['3,0', '3,1', '3,2'];

  it('法术留下的区域：走进去受伤害；同一回合再进不重复；下回合在里面开始又受一次；专注结束就消失', () => {
    const { s, sync } = setupM([wizard({ sources: ['T:spell:火墙'] }), goblin('g', { speed: 30 }, 30)], { w: [0, 5], g: [1, 1] });
    done(s.dispatch({ type: 'startCombat', order: ['w', 'g'] }));
    done(s.dispatch({ type: 'useAction', actor: 'w', action: 'T:spell:火墙#cast', targets: [], area: { cells: wall } }));
    expect(Object.values(s.state.zones!)).toHaveLength(1);
    done(s.dispatch({ type: 'nextTurn' }));
    done(s.dispatch({ type: 'move', id: 'g', ft: 15, path: path([1, 1], [2, 1], [3, 1], [4, 1]) }));
    sync();
    expect(hp(s, 'g')).toBe(25);
    done(s.dispatch({ type: 'move', id: 'g', ft: 5, path: path([4, 1], [3, 1]) }));
    sync();
    expect(hp(s, 'g')).toBe(25);
    done(s.dispatch({ type: 'nextTurn' }));
    done(s.dispatch({ type: 'nextTurn' }));   // 地精在火墙里开始回合
    expect(hp(s, 'g')).toBe(20);
    done(s.dispatch({ type: 'endConcentration', id: 'w' }));
    expect(Object.values(s.state.zones!)).toHaveLength(0);
  });

  it('被推进区域也算进入', () => {
    const { s } = setupM([wizard({ sources: ['T:spell:火墙', 'T:spell:震波'] }), goblin('g', {}, 30)], { w: [1, 1], g: [2, 1] });
    done(s.dispatch({ type: 'useAction', actor: 'w', action: 'T:spell:火墙#cast', targets: [], area: { cells: wall } }));
    done(s.dispatch({ type: 'useAction', actor: 'w', action: 'T:spell:震波#cast', targets: ['g'] }));
    expect(hp(s, 'g')).toBe(25);
  });

  it('DM 画的区域：每次生效前问 DM；说不就不生效；可以删', () => {
    const { s } = setupM([goblin('g', { speed: 30 }, 30)], { g: [0, 0] });
    done(s.dispatch({ type: 'startCombat', order: ['g'] }));
    done(s.dispatch({
      type: 'createZone',
      zone: { name: '酸池', cells: ['1,0'], on: ['enter'], do: [{ kind: 'damage', dice: '4', type: '强酸' }], affects: 'all', oncePerTurn: false, confirm: true },
    }));
    const d = pending(s.dispatch({ type: 'move', id: 'g', ft: 5, path: path([0, 0], [1, 0]) }));
    expect(d.to).toBe('dm');
    done(s.decide({ zone: false }));
    expect(hp(s, 'g')).toBe(30);
    pending(s.dispatch({ type: 'move', id: 'g', ft: 5, path: path([0, 0], [1, 0]) }));
    done(s.decide({ zone: true }));
    expect(hp(s, 'g')).toBe(26);
    done(s.dispatch({ type: 'removeZone', id: Object.keys(s.state.zones!)[0] }));
    expect(s.state.zones).toEqual({});
  });
});

describe('别人开始回合时', () => {
  it('敌人在 10 尺内开始回合：触发；远了不触发', () => {
    const { s, positions } = setupM([fighter({ sources: ['T:荆棘光环'] }), goblin('g', {}, 30), goblin('h', {}, 30)], { f: [0, 0], g: [2, 0], h: [5, 0] });
    done(s.dispatch({ type: 'startCombat', order: ['f', 'g', 'h'] }));
    done(s.dispatch({ type: 'nextTurn' }));
    done(s.dispatch({ type: 'nextTurn' }));
    expect(hp(s, 'g')).toBe(28);
    expect(hp(s, 'h')).toBe(30);
    expect(positions.current.f).toEqual({ x: 0, y: 0, s: 1 });
  });
});
