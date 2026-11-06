// 选择池 + castFrom：从池子里挑一个能执行的东西（自己的武器攻击、规则书里的法术），交给 castFrom 跑；
// castFrom 的 with = 这一次自带的修正。借机攻击就是这样写在规则数据里的（rules-2024「借机攻击」）。
import { describe, expect, it } from 'vitest';
import { RuleBook, Session, createEncounter, makeCombatant, makeView, scriptedDice, type Positions, type RuleFile } from '../../src/combat';
import { FILES, done, evs, fighter, goblin, pending, wizard, type Who } from './helpers';

const OA = 'XPHB:action:借机攻击';

const TEST = {
  entries: {
    // 应答之剑那种：受到伤害后用反应反击，这一下带优势、无视抗性
    'T:应答': {
      name: '应答',
      actions: [{
        id: 'riposte', name: '应答', activation: 'reaction', trigger: { on: 'damageTaken', role: 'target', aim: 'actor' },
        root: [
          { kind: 'choose', prompt: '用哪件武器', var: 'w', pool: { from: 'attacks', melee: true } },
          { kind: 'castFrom', fromVar: 'w', to: 'target', cost: [], with: { rollMods: [{ on: { kind: 'attack' }, who: 'bearer', op: 'adv', label: '应答' }], flags: { ignores: ['resistance'] } } },
        ],
      }],
    },
    // 职业列表按法术名查（spell-meta）：火焰箭在法师列表上，神圣火焰不在
    'T:spell:火焰箭': { name: '火焰箭', actions: [{ id: 'cast', name: '火焰箭', activation: 'action', tags: ['spell'], targeting: { type: 'creature', count: 1 }, root: [] }] },
    'T:spell:神圣火焰': { name: '神圣火焰', actions: [{ id: 'cast', name: '神圣火焰', activation: 'action', tags: ['spell'], targeting: { type: 'creature', count: 1 }, root: [] }] },
    // 巫术帽那种：从法师法术列表里挑一道戏法
    'T:巫术帽': {
      name: '巫术帽',
      actions: [{ id: 'use', name: '巫术帽', activation: 'free', root: [{ kind: 'choose', prompt: '挑一道法师戏法', var: 'k', pool: { from: 'spells', list: '法师', maxLevel: '0' } }] }],
    },
    // 梦幻舞步那种：本回合不能对来源借机攻击
    'T:舞步': {
      name: '舞步',
      effects: { 舞步: { flags: { cannot: ['opportunityAttack:source'] } } },
      actions: [{ id: 'use', name: '舞步', activation: 'free', targeting: { type: 'creature', count: 1 }, root: [{ kind: 'applyEffect', template: '舞步', duration: { rounds: 1 } }] }],
    },
    // 哨兵·阻拦那种：借机攻击命中时多 1 点（这次攻击是借机攻击 = 外层动作是规则里的借机攻击）
    'T:阻拦': {
      name: '阻拦',
      triggers: [{ id: 'h', label: '阻拦', on: 'attackHit', role: 'actor', when: `action.parent.key == '${OA}'`, do: [{ kind: 'damage', dice: '1', type: '力场' }] }],
    },
    // 哨兵·守护者那种：撤离了也能打 —— 直接借用规则里的借机攻击
    'T:守护': {
      name: '守护',
      actions: [{
        id: 'guard', name: '守护', activation: 'reaction', trigger: { on: 'leftReach', role: 'target', aim: 'actor', when: '!event.provokes' },
        root: [{ kind: 'castFrom', from: `${OA}#opportunityAttack`, to: 'target', cost: [] }],
      }],
    },
  },
} as unknown as RuleFile;

function setup(cs: Who[], at?: Record<string, [number, number]>) {
  const dice = scriptedDice();
  const positions = at ? { current: Object.fromEntries(Object.entries(at).map(([id, [x, y]]) => [id, { x, y, s: 1 }])) as Positions } : null;
  const s = new Session(createEncounter('p'), { rules: new RuleBook([...FILES, TEST]), diceFor: () => dice, positions: positions ? () => positions.current : undefined });
  for (const c of cs) done(s.dispatch({ type: 'addCombatant', combatant: makeCombatant({ id: c.id, kind: c.kind, side: c.side, hp: c.hp, view: makeView(c.view) }) }));
  return { s, dice, hp: (id: string) => s.state.combatants[id].live.hp };
}
const path = (...xs: Array<[number, number]>) => xs.map(([x, y]) => ({ x, y }));
const pick = (d: { options: Array<{ id: string; label: string }> }, label: string) => [d.options.find((o) => o.label === label)!.id];

describe('pool: attacks + castFrom with', () => {
  it('受到伤害后反击：只有一件近战武器不问；带优势、无视抗性；用完摘掉', () => {
    const { s, dice, hp } = setup([fighter({ sources: ['T:应答'] }), goblin('g', { resist: ['挥砍'] }, 30)]);
    done(s.dispatch({ type: 'startCombat', order: ['g', 'f'] }));
    dice.push(18, 3);   // 地精命中战士
    const d = pending(s.dispatch({ type: 'useAction', actor: 'g', action: 'weapon:sc', targets: ['f'] }));
    expect(d.options.map((o) => o.label)).toContain('战士：应答');
    dice.push(2, 17, 4);   // 优势：2、17 取 17；长剑 1d8 = 4（+3）→ 7，不因抗性减半
    done(s.decide(pick(d, '战士：应答')));
    const atk = evs(s, 'd20Rolled').at(-1)!;
    expect(atk.adv).toBe(true);
    expect(hp('g')).toBe(30 - 7);
    expect(Object.values(s.state.effects).filter((e) => e.bearer === 'f')).toHaveLength(0);
  });
});

describe('pool: spells', () => {
  it('从法师法术列表里挑：列出没学过的法师戏法，不列别的职业的', () => {
    const { s } = setup([wizard({ sources: ['T:巫术帽'] })]);
    const d = pending(s.dispatch({ type: 'useAction', actor: 'w', action: 'T:巫术帽#use', targets: [] }));
    const labels = d.options.map((o) => o.label);
    expect(labels).toContain('电爪');
    expect(labels).not.toContain('点点星芒');
  });
});

describe('借机攻击是规则数据', () => {
  it('不能对来源借机攻击（opportunityAttack:source）：来源走开时不问', () => {
    const { s } = setup([fighter(), goblin('g', { sources: ['T:舞步'] }, 30)], { f: [0, 0], g: [1, 0] });
    done(s.dispatch({ type: 'startCombat', order: ['g', 'f'] }));
    done(s.dispatch({ type: 'useAction', actor: 'g', action: 'T:舞步#use', targets: ['f'] }));
    done(s.dispatch({ type: 'move', id: 'g', ft: 10, path: path([1, 0], [2, 0], [3, 0]) }));
  });

  it('借机攻击命中：action.parent 是规则里的借机攻击（自己回合的普通攻击不算）', () => {
    const { s, dice, hp } = setup([fighter({ sources: ['T:阻拦'] }), goblin('g', {}, 30)], { f: [0, 0], g: [1, 0] });
    done(s.dispatch({ type: 'startCombat', order: ['g', 'f'] }));
    const d = pending(s.dispatch({ type: 'move', id: 'g', ft: 10, path: path([1, 0], [2, 0], [3, 0]) }));
    dice.push(15, 4);
    done(s.decide(pick(d, '战士：借机攻击')));
    expect(hp('g')).toBe(30 - 7 - 1);
  });

  it('界面上「用反应攻击」发起的武器攻击也走借机攻击（阻拦认得出来；花反应，不问用哪件武器）', () => {
    const { s, dice, hp } = setup([fighter({ sources: ['T:阻拦'] }), goblin('g', {}, 30)]);
    done(s.dispatch({ type: 'startCombat', order: ['g', 'f'] }));
    dice.push(15, 4);
    done(s.dispatch({ type: 'useAction', actor: 'f', action: 'weapon:ls', targets: ['g'], options: { as: 'reaction' } }));
    expect(hp('g')).toBe(30 - 7 - 1);
    expect(s.state.combatants.f.economy.reaction).toBe(0);
  });

  it('撤离了：借机攻击不出现，「守护」借用借机攻击打它（阻拦照样认得是借机攻击）', () => {
    const { s, dice, hp } = setup([fighter({ sources: ['T:守护', 'T:阻拦'] }), goblin('g', {}, 30)], { f: [0, 0], g: [1, 0] });
    done(s.dispatch({ type: 'startCombat', order: ['g', 'f'] }));
    done(s.dispatch({ type: 'useAction', actor: 'g', action: 'XPHB:action:撤离#use', targets: [] }));
    const d = pending(s.dispatch({ type: 'move', id: 'g', ft: 10, path: path([1, 0], [2, 0], [3, 0]) }));
    expect(d.options.map((o) => o.label)).toEqual(['战士：守护']);
    dice.push(15, 4);
    done(s.decide(pick(d, '战士：守护')));
    expect(hp('g')).toBe(30 - 7 - 1);
    expect(s.state.combatants.f.economy.reaction).toBe(0);
  });
});
