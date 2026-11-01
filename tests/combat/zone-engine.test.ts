// 区域引擎：记住施法时的选择、放下 / 离开 / 在里面移动时生效、「待在里面才有」的效应、挪动区域
import { describe, expect, it } from 'vitest';
import { RuleBook, Session, createEncounter, makeCombatant, makeView, scriptedDice, type Positions, type RuleFile } from '../../src/combat';
import { FILES, done, evs, goblin, wizard, type Who } from './helpers';

const area = { type: 'area' } as const;
const spell = (id: string, root: unknown[], extra: Record<string, unknown> = {}) => ({
  actions: [{ id: 'cast', name: id, activation: 'action', tags: ['spell'], targeting: area, concentration: { minutes: 1 }, root, ...extra }],
});
// 用目盲：束缚会让速度变 0、走不出来
const BLIND = { kind: 'applyEffect', template: 'XPHB:condition:目盲' };

const TEST: RuleFile = {
  entries: {
    // 施法时选伤害类型，区域里用 vars.elem
    'T:spell:元素池': spell('元素池', [
      { kind: 'choose', prompt: '什么伤害？', var: 'elem', options: [{ label: '火', value: '火焰' }, { label: '冰', value: '寒冷' }] },
      { kind: 'zone', on: ['enter'], do: [{ kind: 'damage', dice: '10', type: 'vars.elem' }] },
    ]),
    // 出现时在里面的也受
    'T:spell:烈焰地': spell('烈焰地', [{ kind: 'zone', on: ['create', 'enter'], do: [{ kind: 'damage', dice: '5', type: '火焰' }] }]),
    // 待在里面就目盲
    'T:spell:泥沼': spell('泥沼', [{ kind: 'zone', while: [BLIND] }]),
    // 进来就目盲，离开解除（写在 do 里）
    'T:spell:蛛丝': spell('蛛丝', [{ kind: 'zone', on: ['enter'], do: [{ ...BLIND, whileInZone: true }] }]),
    // 离开时受伤
    'T:spell:荆棘圈': spell('荆棘圈', [{ kind: 'zone', on: ['leave'], do: [{ kind: 'damage', dice: '3', type: '穿刺' }] }]),
    // 在里面每走 5 尺受 2 点
    'T:spell:尖刺地': spell('尖刺地', [{ kind: 'zone', on: ['move'], oncePerTurn: false, do: [{ kind: 'damage', dice: '2', type: '穿刺' }] }]),
    // 能挪的光柱：压到谁谁受伤；另一个动作挪它
    'T:spell:光柱': {
      actions: [
        { id: 'cast', name: '光柱', activation: 'action', tags: ['spell'], targeting: area, concentration: { minutes: 1 },
          root: [{ kind: 'zone', on: ['enter'], while: [BLIND], do: [{ kind: 'damage', dice: '4', type: '光耀' }] }] },
        { id: 'move', name: '移动光柱', activation: 'bonus', targeting: area, root: [{ kind: 'moveZone' }] },
      ],
    },
  },
} as unknown as RuleFile;

function setupM(cs: Who[], at: Record<string, [number, number]>) {
  const dice = scriptedDice();
  const positions = { current: Object.fromEntries(Object.entries(at).map(([id, [x, y]]) => [id, { x, y, s: 1 }])) as Positions };
  const s = new Session(createEncounter('t'), { rules: new RuleBook([...FILES, TEST], []), diceFor: () => dice, positions: () => positions.current });
  for (const c of cs) done(s.dispatch({ type: 'addCombatant', combatant: makeCombatant({ id: c.id, kind: c.kind, side: c.side, hp: c.hp, view: makeView(c.view) }) }));
  // 「移动」命令只在战斗里一格一格走
  done(s.dispatch({ type: 'startCombat', order: cs.map((c) => c.id) }));
  const sync = () => { for (const m of evs(s, 'moved')) positions.current[m.id] = { ...positions.current[m.id], ...m.to }; };
  return { s, dice, positions, sync };
}
const hp = (s: Session, id: string) => s.state.combatants[id].live.hp;
const path = (...xs: Array<[number, number]>) => xs.map(([x, y]) => ({ x, y }));
const blind = (s: Session, id: string) => Object.values(s.state.effects).filter((e) => e.bearer === id && e.name === '目盲').length;
const cast = (s: Session, key: string, cells: string[], action = 'cast') =>
  s.dispatch({ type: 'useAction', actor: 'w', action: `${key}#${action}`, targets: [], area: { cells } });
const pool = ['3,0', '3,1', '3,2'];

describe('区域引擎', () => {
  it('记住施法时选的伤害类型（vars）', () => {
    const { s, sync } = setupM([wizard({ sources: ['T:spell:元素池'] }), goblin('g', { speed: 30, resist: ['寒冷'] }, 30)], { w: [0, 5], g: [2, 1] });
    cast(s, 'T:spell:元素池', pool);
    done(s.decide(['1']));   // 冰
    expect(s.state.zones![Object.keys(s.state.zones!)[0]].vars).toEqual({ elem: '寒冷' });
    done(s.dispatch({ type: 'move', id: 'g', ft: 5, path: path([2, 1], [3, 1]), force: true }));
    sync();
    expect(hp(s, 'g')).toBe(25);   // 寒冷抗性：10 → 5
  });

  it('create：区域出现时已经在里面的也生效', () => {
    const { s, sync } = setupM([wizard({ sources: ['T:spell:烈焰地'] }), goblin('g', {}, 30), goblin('h', {}, 30)], { w: [0, 5], g: [3, 1], h: [6, 6] });
    done(cast(s, 'T:spell:烈焰地', pool));
    expect(hp(s, 'g')).toBe(25);
    expect(hp(s, 'h')).toBe(30);
  });

  it('while：在里面就有，走出去摘掉，走回来再挂；专注结束也摘', () => {
    const { s, sync } = setupM([wizard({ sources: ['T:spell:泥沼'] }), goblin('g', { speed: 30 }, 30)], { w: [0, 5], g: [3, 1] });
    done(cast(s, 'T:spell:泥沼', pool));
    expect(blind(s, 'g')).toBe(1);
    done(s.dispatch({ type: 'move', id: 'g', ft: 5, path: path([3, 1], [4, 1]), force: true }));
    sync();
    expect(blind(s, 'g')).toBe(0);
    done(s.dispatch({ type: 'move', id: 'g', ft: 5, path: path([4, 1], [3, 1]), force: true }));
    sync();
    expect(blind(s, 'g')).toBe(1);
    done(s.dispatch({ type: 'endConcentration', id: 'w' }));
    expect(blind(s, 'g')).toBe(0);
  });

  it('whileInZone：do 里挂的效应离开就结束', () => {
    const { s, sync } = setupM([wizard({ sources: ['T:spell:蛛丝'] }), goblin('g', { speed: 30 }, 30)], { w: [0, 5], g: [2, 1] });
    done(cast(s, 'T:spell:蛛丝', pool));
    expect(blind(s, 'g')).toBe(0);   // 施法时不在里面
    done(s.dispatch({ type: 'move', id: 'g', ft: 5, path: path([2, 1], [3, 1]), force: true }));
    sync();
    expect(blind(s, 'g')).toBe(1);
    done(s.dispatch({ type: 'move', id: 'g', ft: 5, path: path([3, 1], [4, 1]), force: true }));
    sync();
    expect(blind(s, 'g')).toBe(0);
  });

  it('leave：离开时生效', () => {
    const { s, sync } = setupM([wizard({ sources: ['T:spell:荆棘圈'] }), goblin('g', { speed: 30 }, 30)], { w: [0, 5], g: [3, 1] });
    done(cast(s, 'T:spell:荆棘圈', pool));
    done(s.dispatch({ type: 'move', id: 'g', ft: 5, path: path([3, 1], [3, 2]), force: true }));
    sync();
    expect(hp(s, 'g')).toBe(30);   // 还在里面
    done(s.dispatch({ type: 'move', id: 'g', ft: 5, path: path([3, 2], [4, 2]), force: true }));
    sync();
    expect(hp(s, 'g')).toBe(27);
  });

  it('move：在里面每走 5 尺生效一次（走进来那步也算）', () => {
    const { s, sync } = setupM([wizard({ sources: ['T:spell:尖刺地'] }), goblin('g', { speed: 30 }, 30)], { w: [0, 5], g: [2, 0] });
    done(cast(s, 'T:spell:尖刺地', pool));
    done(s.dispatch({ type: 'move', id: 'g', ft: 20, path: path([2, 0], [3, 0], [3, 1], [3, 2], [4, 3]), force: true }));
    sync();
    expect(hp(s, 'g')).toBe(30 - 6);
  });

  it('moveZone 节点：挪过去压到的人算进入，挪走后原来里面的人离开（摘掉随区域的效应）', () => {
    const { s, sync } = setupM([wizard({ sources: ['T:spell:光柱'] }), goblin('g', {}, 30), goblin('h', {}, 30)], { w: [0, 5], g: [3, 1], h: [8, 1] });
    done(cast(s, 'T:spell:光柱', pool));
    expect(blind(s, 'g')).toBe(1);   // while 在区域出现时就挂上
    expect(hp(s, 'g')).toBe(30);     // on 里没有 create：出现时不受伤
    done(cast(s, 'T:spell:光柱', ['8,0', '8,1', '8,2'], 'move'));
    expect(blind(s, 'g')).toBe(0);
    expect(blind(s, 'h')).toBe(1);
    expect(hp(s, 'h')).toBe(26);
    const z = Object.values(s.state.zones!)[0];
    expect(z.cells).toEqual(['8,0', '8,1', '8,2']);
  });

  it('DM 挪区域、删区域；撤销挪动后回到原处', () => {
    const { s, sync } = setupM([wizard({ sources: ['T:spell:泥沼'] }), goblin('g', {}, 30)], { w: [0, 5], g: [3, 1] });
    done(cast(s, 'T:spell:泥沼', pool));
    const id = Object.keys(s.state.zones!)[0];
    done(s.dispatch({ type: 'moveZone', id, cells: ['5,5'] }));
    expect(blind(s, 'g')).toBe(0);
    s.undo();
    expect(s.state.zones![id].cells).toEqual(pool);
    expect(blind(s, 'g')).toBe(1);
    done(s.dispatch({ type: 'removeZone', id }));
    expect(blind(s, 'g')).toBe(0);
  });

  it('不经过引擎的移动（DM 摆位置）：回合开始时对账，摘掉已经不在里面的', () => {
    const { s, positions } = setupM([wizard({ sources: ['T:spell:泥沼'] }), goblin('g', {}, 30)], { w: [0, 5], g: [3, 1] });
    done(cast(s, 'T:spell:泥沼', pool));
    expect(blind(s, 'g')).toBe(1);
    positions.current.g = { x: 7, y: 7, s: 1 };
    done(s.dispatch({ type: 'nextTurn' }));
    expect(blind(s, 'g')).toBe(0);
  });
});
