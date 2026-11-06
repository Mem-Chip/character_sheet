// 结算的东西自己说清楚是什么（从数据里读出来，不另做标记）：
//   roll.against —— 这次检定防的是哪些状态（豁免失败那一支挂的、豁免结束的那个效应带的）；
//   damage.parts / action.damage.parts —— 这包伤害由哪几项组成；伤害修正的 on.part 只管那几项。
import { describe, expect, it } from 'vitest';
import { RuleBook, Session, createEncounter, makeCombatant, makeView, scriptedDice, type RuleFile } from '../../src/combat';
import { FILES, done, evs } from './helpers';

const TEST = {
  entries: {
    // 体质豁免，失败中毒；另一道失败恐慌（经由隐含状态）；第三道只受伤害
    'T:spell:毒雾': {
      name: '毒雾',
      actions: [{
        id: 'cast', name: '毒雾', activation: 'action', tags: ['spell'], targeting: { type: 'creature', count: 1 },
        root: [{ kind: 'save', ability: 'con', dc: '15', onFail: [{ kind: 'applyEffect', template: 'XPHB:condition:中毒', duration: { rounds: 1 } }] }],
      }],
    },
    'T:spell:惊吓': {
      name: '惊吓',
      actions: [{
        id: 'cast', name: '惊吓', activation: 'action', tags: ['spell'], targeting: { type: 'creature', count: 1 },
        root: [{ kind: 'save', ability: 'wis', dc: '15', onFail: [{ kind: 'applyEffect', template: '惊惧', duration: { rounds: 1 } }] }],
      }],
      effects: { 惊惧: { implies: ['XPHB:condition:恐慌'] } },
    },
    'T:spell:冲击': {
      name: '冲击',
      actions: [{ id: 'cast', name: '冲击', activation: 'action', tags: ['spell'], targeting: { type: 'creature', count: 1 },
        root: [{ kind: 'save', ability: 'con', dc: '15', onFail: [{ kind: 'damage', dice: '2d6', type: '雷鸣' }] }] }],
    },
    // 每回合结束时感知豁免摆脱（豁免结束的那个效应带恐慌）
    'T:spell:久惧': {
      name: '久惧',
      actions: [{
        id: 'cast', name: '久惧', activation: 'action', tags: ['spell'], targeting: { type: 'creature', count: 1 },
        root: [{ kind: 'applyEffect', template: '久惧', duration: { rounds: 10, saveEnds: { ability: 'wis', dc: '15', at: 'turnEnd' } } }],
      }],
      effects: { 久惧: { implies: ['XPHB:condition:恐慌'] } },
    },
    // 抗毒剂那种：避免 / 结束中毒的豁免有优势
    'T:抗毒': { name: '抗毒', rollMods: [{ on: { kind: 'save' }, who: 'bearer', when: "includes(roll.against, '中毒')", op: 'adv', label: '抗毒' }] },
    'T:勇气': { name: '勇气', rollMods: [{ on: { kind: 'save' }, who: 'bearer', when: "includes(roll.against, '恐慌')", op: 'adv', label: '勇气' }] },

    'T:spell:光矢': {
      name: '光矢',
      actions: [{
        id: 'cast', name: '光矢', activation: 'action', tags: ['spell'], targeting: { type: 'creature', count: 1 },
        root: [{ kind: 'attack', attack: { ranged: true, spell: true }, onHit: [{ kind: 'damage', dice: '2d6', type: '光耀' }] }],
      }],
    },
    'T:偷袭': { name: '偷袭', triggers: [{ id: 'sa', label: '偷袭', on: 'attackHit', window: 'before', role: 'actor', do: [{ kind: 'addDamage', dice: '2d6', type: '穿刺' }] }] },
    // 恐怖化身那种：只有偷袭骰的 1、2 当 3
    'T:保底': { name: '保底', rollMods: [{ on: { kind: 'damage', part: '偷袭' }, who: 'bearer', op: 'minDie', value: '3', label: '保底' }] },
    // 命中时这次伤害里有偷袭才 +1（看 action.damage.parts）
    'T:看偷袭': {
      name: '看偷袭',
      triggers: [{ id: 'k', label: '看偷袭', on: 'attackHit', window: 'before', role: 'actor', when: "includes(action.damage.parts, '偷袭')", do: [{ kind: 'addDamage', dice: '1', type: '穿刺' }] }],
    },
  },
} as unknown as RuleFile;

function scene(wSources: string[], gSources: string[] = []) {
  const dice = scriptedDice();
  const s = new Session(createEncounter('d'), { rules: new RuleBook([...FILES, TEST]), diceFor: () => dice });
  const add = (id: string, side: string, view: Record<string, unknown>) => done(s.dispatch({
    type: 'addCombatant', combatant: makeCombatant({ id, kind: side === 'party' ? 'pc' : 'monster', side, view: makeView({ name: id, hpMax: 40, ac: 12, ...view }) }),
  }));
  add('w', 'party', {
    level: 5, pb: 3, spell: { dc: 15, atk: 6, mod: 3, ability: 'int' },
    sources: ['T:spell:毒雾', 'T:spell:惊吓', 'T:spell:冲击', 'T:spell:久惧', 'T:spell:光矢', ...wSources],
  });
  add('g1', 'foe', { sources: gSources });
  done(s.dispatch({ type: 'startCombat', order: ['w', 'g1'] }));
  return { s, dice, hp: (id: string) => s.state.combatants[id].live.hp };
}

const lastRoll = (s: Session) => evs(s, 'd20Rolled').at(-1)!;

describe('roll.against：这次检定防的是什么', () => {
  it('失败会中毒的豁免：against = [中毒]，抗毒给优势', () => {
    const { s, dice } = scene([], ['T:抗毒']);
    dice.push(3, 18);
    done(s.dispatch({ type: 'useAction', actor: 'w', action: 'T:spell:毒雾#cast', targets: ['g1'] }));
    const r = lastRoll(s);
    expect(r.against).toEqual(['中毒']);
    expect(r.adv).toBe(true);
    expect(r.natural).toBe(18);
  });

  it('隐含的状态也算（惊惧 → 恐慌）；不相干的抗毒不给优势', () => {
    const { s, dice } = scene([], ['T:抗毒', 'T:勇气']);
    dice.push(3, 18);
    done(s.dispatch({ type: 'useAction', actor: 'w', action: 'T:spell:惊吓#cast', targets: ['g1'] }));
    const r = lastRoll(s);
    expect(r.against).toEqual(['恐慌']);
    expect(r.mods.map((m: { label: string }) => m.label)).toContain('勇气');
    expect(r.mods.map((m: { label: string }) => m.label)).not.toContain('抗毒');
  });

  it('只受伤害的豁免：against 为空', () => {
    const { s, dice } = scene([], ['T:抗毒']);
    dice.push(3, 1, 1);
    done(s.dispatch({ type: 'useAction', actor: 'w', action: 'T:spell:冲击#cast', targets: ['g1'] }));
    expect(lastRoll(s).against).toEqual([]);
    expect(lastRoll(s).adv).toBe(false);
  });

  it('回合末豁免结束：against = 那个效应带的状态', () => {
    const { s, dice } = scene([], ['T:勇气']);
    done(s.dispatch({ type: 'useAction', actor: 'w', action: 'T:spell:久惧#cast', targets: ['g1'] }));
    dice.push(2, 19);
    done(s.dispatch({ type: 'nextTurn' }));
    done(s.dispatch({ type: 'nextTurn' }));
    const r = evs(s, 'd20Rolled').find((e) => e.kind === 'save')!;
    expect(r.against).toEqual(['恐慌']);
    expect(r.adv).toBe(true);
  });
});

describe('damage.parts：伤害由哪几项组成', () => {
  it('on.part：保底只改偷袭的骰子，光矢自己的 1 不动', () => {
    const { s, dice, hp } = scene(['T:偷袭', 'T:保底']);
    dice.push(15, 1, 1, 1, 2);   // 命中；光矢 1+1；偷袭 1、2 → 3、3
    done(s.dispatch({ type: 'useAction', actor: 'w', action: 'T:spell:光矢#cast', targets: ['g1'] }));
    expect(hp('g1')).toBe(40 - 2 - 6);
  });

  it('on.part：这次没有偷袭就不生效', () => {
    const { s, dice, hp } = scene(['T:保底']);
    dice.push(15, 1, 1);
    done(s.dispatch({ type: 'useAction', actor: 'w', action: 'T:spell:光矢#cast', targets: ['g1'] }));
    expect(hp('g1')).toBe(40 - 2);
  });

  it('命中窗口里 action.damage.parts 读得到刚加的偷袭', () => {
    const { s, dice, hp } = scene(['T:偷袭', 'T:看偷袭']);
    dice.push(15, 1, 1, 1, 1);
    done(s.dispatch({ type: 'useAction', actor: 'w', action: 'T:spell:光矢#cast', targets: ['g1'] }));
    expect(hp('g1')).toBe(40 - 5);
  });

  it('伤害窗口里 damage.parts 列出各项', () => {
    const { s, dice } = scene(['T:偷袭']);
    dice.push(15, 1, 1, 1, 1);
    done(s.dispatch({ type: 'useAction', actor: 'w', action: 'T:spell:光矢#cast', targets: ['g1'] }));
    expect(evs(s, 'damageRolled').at(-1)?.parts.map((p: { from: string }) => p.from)).toEqual(['光矢', '偷袭']);
  });
});
