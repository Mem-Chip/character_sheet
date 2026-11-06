// 移动和召唤也有窗口：
//   moved before（cancel 拦下这次移动）/ moved after（走完了，event.ft 实际几尺）、
//   enteredReach（每走一步算一次触及关系的变化，和 leftReach 成对）、summoned（召唤出来之后，target = 召唤物）
import { describe, expect, it } from 'vitest';
import { RuleBook, Session, createEncounter, makeCombatant, makeView, scriptedDice, type Positions, type RuleFile } from '../../src/combat';
import { FILES, done, evs, fighter, goblin, pending, type Who } from './helpers';

const TEST = {
  entries: {
    'T:spell:震波': {
      name: '震波',
      actions: [{ id: 'cast', name: '震波', activation: 'action', tags: ['spell'], targeting: { type: 'creature', count: 1 }, root: [{ kind: 'move', mode: 'push', ft: '10' }] }],
    },
    // 新锻臂铠那种：用反应拦下 5 尺内盟友被推离 / 拉近
    'T:比肩': {
      name: '比肩',
      triggers: [{
        id: 'hold', label: '比肩而立', on: 'moved', window: 'before', role: 'ally', optional: true, cost: [{ economy: 'reaction' }],
        when: 'event.forced && within(self, target, 5)', modify: [{ op: 'cancel' }],
      }],
    },
    // 轰雷剑那种：被标记的生物自愿移动 5 尺以上就受伤，然后标记消失
    'T:轰雷': {
      name: '轰雷',
      effects: {
        轰雷: {
          duration: { rounds: 1 },
          triggers: [{ id: 'boom', label: '轰雷', on: 'moved', role: 'target', when: '!event.forced && event.ft >= 5', do: [{ kind: 'damage', dice: '7', type: '雷鸣' }, { kind: 'removeEffect', from: 'target', match: { name: '轰雷' } }] }],
        },
      },
      actions: [{ id: 'use', name: '轰雷', activation: 'free', targeting: { type: 'creature', count: 1 }, root: [{ kind: 'applyEffect', template: '轰雷' }] }],
    },
    // 长柄武器大师那种：敌人进入触及范围时用反应打它
    'T:长柄': {
      name: '长柄',
      actions: [{
        id: 'brace', name: '长柄', activation: 'reaction', trigger: { on: 'enteredReach', role: 'target', aim: 'actor' },
        root: [{ kind: 'choose', prompt: '用哪件武器', var: 'w', pool: { from: 'attacks', melee: true } }, { kind: 'castFrom', fromVar: 'w', to: 'target', cost: [] }],
      }],
    },
    'T:spell:唤狼': {
      name: '唤狼',
      actions: [{ id: 'cast', name: '唤狼', activation: 'action', tags: ['spell'], root: [{ kind: 'summon', name: '灵狼', hp: '10' }] }],
    },
    // 强韧召唤那种：召唤法术召出来的生物拿 5 点临时生命值
    'T:强韧': {
      name: '强韧',
      triggers: [{ id: 'mighty', label: '强韧召唤', on: 'summoned', role: 'actor', when: "action.kind == 'spell'", do: [{ kind: 'tempHp', amount: '5', to: 'target' }] }],
    },
  },
} as unknown as RuleFile;

function setup(cs: Who[], at: Record<string, [number, number]>) {
  const dice = scriptedDice();
  const positions = { current: Object.fromEntries(Object.entries(at).map(([id, [x, y]]) => [id, { x, y, s: 1 }])) as Positions };
  const s = new Session(createEncounter('m'), { rules: new RuleBook([...FILES, TEST]), diceFor: () => dice, positions: () => positions.current });
  for (const c of cs) done(s.dispatch({ type: 'addCombatant', combatant: makeCombatant({ id: c.id, kind: c.kind, side: c.side, hp: c.hp, view: makeView(c.view) }) }));
  return { s, dice, hp: (id: string) => s.state.combatants[id].live.hp };
}
const path = (...xs: Array<[number, number]>) => xs.map(([x, y]) => ({ x, y }));
const pick = (d: { options: Array<{ id: string; label: string }> }, label: string) => [d.options.find((o) => o.label === label)!.id];
const caster = (id: string, sources: string[]): Who => ({ id, kind: 'monster', view: { name: id, hpMax: 20, ac: 10, spell: { dc: 13, atk: 5, mod: 3, ability: 'int' }, sources } });

describe('moved：移动的前后两个窗口', () => {
  it('before：5 尺内的盟友用反应拦下强制位移', () => {
    const { s } = setup([caster('c', ['T:spell:震波']), fighter(), fighter({ name: '护卫', sources: ['T:比肩'] }, 'p')], { c: [0, 0], f: [1, 0], p: [1, 1] });
    done(s.dispatch({ type: 'startCombat', order: ['c', 'f', 'p'] }));
    const d = pending(s.dispatch({ type: 'useAction', actor: 'c', action: 'T:spell:震波#cast', targets: ['f'] }));
    expect(d.prompt).toContain('将要被移动');
    done(s.decide(pick(d, '护卫：比肩而立')));
    expect(evs(s, 'moved')).toHaveLength(0);
    expect(s.state.combatants.p.economy.reaction).toBe(0);
  });

  it('after：自己走 10 尺受伤，被推走的不算', () => {
    const a = setup([fighter({ sources: ['T:轰雷'] }), goblin('g', {}, 30)], { f: [0, 0], g: [5, 5] });
    done(a.s.dispatch({ type: 'startCombat', order: ['f', 'g'] }));
    done(a.s.dispatch({ type: 'useAction', actor: 'f', action: 'T:轰雷#use', targets: ['g'] }));
    done(a.s.dispatch({ type: 'nextTurn' }));
    done(a.s.dispatch({ type: 'move', id: 'g', ft: 10, path: path([5, 5], [6, 5], [7, 5]) }));
    expect(a.hp('g')).toBe(30 - 7);
    expect(Object.values(a.s.state.effects).some((e) => e.name === '轰雷')).toBe(false);

    const b = setup([caster('c', ['T:spell:震波', 'T:轰雷']), goblin('g', {}, 30)], { c: [0, 0], g: [1, 0] });
    done(b.s.dispatch({ type: 'startCombat', order: ['c', 'g'] }));
    done(b.s.dispatch({ type: 'useAction', actor: 'c', action: 'T:轰雷#use', targets: ['g'] }));
    done(b.s.dispatch({ type: 'useAction', actor: 'c', action: 'T:spell:震波#cast', targets: ['g'] }));
    expect(evs(b.s, 'moved')).toHaveLength(1);
    expect(b.hp('g')).toBe(30);
  });
});

describe('enteredReach', () => {
  it('敌人走进触及范围：问要不要用反应打它（自己的近战武器只有一件就不问用哪件）', () => {
    const { s, dice, hp } = setup([fighter({ sources: ['T:长柄'] }), goblin('g', {}, 30)], { f: [0, 0], g: [3, 0] });
    done(s.dispatch({ type: 'startCombat', order: ['g', 'f'] }));
    const d = pending(s.dispatch({ type: 'move', id: 'g', ft: 10, path: path([3, 0], [2, 0], [1, 0]) }));
    expect(d.prompt).toContain('进入了');
    dice.push(15, 4);
    done(s.decide(pick(d, '战士：长柄')));
    expect(hp('g')).toBe(30 - 7);
    expect(evs(s, 'enteredReach').map((e) => e.of)).toEqual(['f']);
  });
});

describe('summoned', () => {
  it('召唤法术召出来的生物：召唤者的能力给它 5 点临时生命值', () => {
    const { s } = setup([caster('c', ['T:spell:唤狼', 'T:强韧'])], { c: [0, 0] });
    done(s.dispatch({ type: 'startCombat', order: ['c'] }));
    done(s.dispatch({ type: 'useAction', actor: 'c', action: 'T:spell:唤狼#cast', targets: [] }));
    const wolf = Object.values(s.state.combatants).find((c) => c.name === '灵狼')!;
    expect(wolf.live.tempHp).toBe(5);
  });
});
