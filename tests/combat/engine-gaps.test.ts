// 外包时记下的几处小缺口：数量字段可以带骰子（allocate.total、resource.delta）、
// includes 查文字、伤害窗口里的 damage.isAttack、d20 直接取某个值（setD20）
import { describe, expect, it } from 'vitest';
import { RuleBook, Session, createEncounter, makeCombatant, makeView, scriptedDice, type RuleFile } from '../../src/combat';
import { FILES, done, evs, pending } from './helpers';

const TEST = {
  entries: {
    'T:spell:光矢': {
      name: '光矢',
      actions: [{
        id: 'cast', name: '光矢', activation: 'action', tags: ['spell'], targeting: { type: 'creature', count: 1 },
        root: [{ kind: 'attack', attack: { ranged: true, spell: true }, onHit: [{ kind: 'damage', dice: '2d6', type: '光耀' }] }],
      }],
    },
    'T:spell:冲击': {
      name: '冲击',
      actions: [{ id: 'cast', name: '冲击', activation: 'action', tags: ['spell'], targeting: { type: 'creature', count: 1 }, root: [{ kind: 'damage', dice: '4d6', type: '雷鸣' }] }],
    },
    // 合计 2d4 点治疗分给盟友（鼓舞斩那种）
    'T:鼓舞': {
      name: '鼓舞',
      actions: [{ id: 'use', name: '鼓舞', activation: 'action', root: [{ kind: 'allocate', prompt: '分配治疗', from: 'allies', total: '2d4', var: 'n', do: [{ kind: 'heal', amount: 'vars.n', to: 'target' }] }] }],
    },
    // 花 3 点，再重获 1d4 点
    'T:回能': {
      name: '回能',
      actions: [{ id: 'use', name: '回能', activation: 'free', cost: [{ resource: 'pts', n: 3 }], root: [{ kind: 'resource', id: 'pts', delta: '1d4' }] }],
    },
    // 名字里带「光」的动作命中时 +3
    'T:光之友': {
      name: '光之友',
      triggers: [{ id: 'l', on: 'attackHit', window: 'before', role: 'actor', when: "includes(action.name, '光')", do: [{ kind: 'addDamage', dice: '3', type: '光耀' }] }],
    },
    // 受到攻击造成的伤害时减 5（法术豁免、直接伤害不减）
    'T:格挡': {
      name: '格挡',
      triggers: [{ id: 'p', on: 'damageIncoming', window: 'before', role: 'target', when: 'damage.isAttack', modify: [{ op: 'reduceDamage', value: '5' }] }],
    },
    // 自己的 d20 直接取 20
    'T:天命': {
      name: '天命',
      triggers: [{ id: 'd', on: 'd20Rolled', window: 'before', role: 'actor', modify: [{ op: 'setD20', value: '20' }] }],
    },
  },
} as unknown as RuleFile;

function scene(wSources: string[], gSources: string[] = []) {
  const dice = scriptedDice();
  const s = new Session(createEncounter('g'), { rules: new RuleBook([...FILES, TEST]), diceFor: () => dice });
  const add = (id: string, side: string, view: Record<string, unknown>) => done(s.dispatch({
    type: 'addCombatant', combatant: makeCombatant({ id, kind: side === 'party' ? 'pc' : 'monster', side, view: makeView({ name: id, hpMax: 40, ac: 12, ...view }) }),
  }));
  add('w', 'party', { level: 5, pb: 3, spell: { dc: 14, atk: 6, mod: 3, ability: 'int' }, resources: { pts: 5 }, sources: ['T:spell:光矢', 'T:spell:冲击', ...wSources] });
  add('a', 'party', {});
  add('g1', 'foe', { sources: gSources });
  done(s.dispatch({ type: 'startCombat', order: ['w', 'a', 'g1'] }));
  return { s, dice, hp: (id: string) => s.state.combatants[id].live.hp };
}

describe('数量字段带骰子', () => {
  it('allocate：total 2d4 先掷出 7，再分给盟友', () => {
    const { s, dice, hp } = scene(['T:鼓舞']);
    done(s.dispatch({ type: 'adjustHp', id: 'w', set: 30 }));
    done(s.dispatch({ type: 'adjustHp', id: 'a', set: 30 }));
    dice.push(3, 4);
    let d = pending(s.dispatch({ type: 'useAction', actor: 'w', action: 'T:鼓舞#use', targets: [] }));
    d = pending(s.decide(['w', 'a']));
    expect(d.max).toBe(7);
    d = pending(s.decide(5));
    expect(d.max).toBe(2);
    done(s.decide(2));
    expect([hp('w'), hp('a')]).toEqual([35, 32]);
  });

  it('resource：花 3 点后重获 1d4（掷 2）→ 共用掉 1 点', () => {
    const { s, dice } = scene(['T:回能']);
    dice.push(2);
    done(s.dispatch({ type: 'useAction', actor: 'w', action: 'T:回能#use', targets: [] }));
    expect(s.state.combatants.w.live.resourcesUsed.pts).toBe(1);
  });
});

describe('includes 查文字', () => {
  it('名字里有「光」的光矢命中时 +3', () => {
    const { s, dice, hp } = scene(['T:光之友']);
    dice.push(15, 2, 2);
    done(s.dispatch({ type: 'useAction', actor: 'w', action: 'T:spell:光矢#cast', targets: ['g1'] }));
    expect(hp('g1')).toBe(40 - 7);
  });
});

describe('damage.isAttack', () => {
  it('攻击造成的伤害减 5', () => {
    const { s, dice, hp } = scene([], ['T:格挡']);
    dice.push(15, 6, 6);
    done(s.dispatch({ type: 'useAction', actor: 'w', action: 'T:spell:光矢#cast', targets: ['g1'] }));
    expect(hp('g1')).toBe(40 - 7);
  });

  it('不是攻击的法术伤害不减，也不问人', () => {
    const { s, dice, hp } = scene([], ['T:格挡']);
    dice.push(3, 3, 3, 3);
    done(s.dispatch({ type: 'useAction', actor: 'w', action: 'T:spell:冲击#cast', targets: ['g1'] }));
    expect(hp('g1')).toBe(40 - 12);
  });
});

describe('setD20', () => {
  it('掷出 2 也改成 20：按自然 20 重击', () => {
    const { s, dice } = scene(['T:天命']);
    dice.push(2, 1, 1, 1, 1);
    done(s.dispatch({ type: 'useAction', actor: 'w', action: 'T:spell:光矢#cast', targets: ['g1'] }));
    const r = evs(s, 'd20Rolled').at(-1);
    expect(r?.natural).toBe(20);
    expect(r?.crit).toBe(true);
  });
});
