// 动作实例（src/combat/instance.ts）：action.* 在窗口和检定修正里读得到；mark / runBranch / refund 三个节点；
// 豁免结果窗口（saveSucceeded / saveFailed）。用强力戏法、强效塑能、强力施法这几条真数据做场景。
import { describe, expect, it } from 'vitest';
import rulesJson from '../../data/rules-2024.json';
import spellsJson from '../../data/dyn/spells.json';
import featuresJson from '../../data/dyn/features.json';
import aiSpells from '../../data/dyn/ai/spells.json';
import { RuleBook, Session, createEncounter, makeCombatant, makeView, scriptedDice, type RuleFile } from '../../src/combat';
import { done, evs } from './helpers';

const TEST = {
  note: 'T',
  entries: {
    // 记下窗口里读到的 action.*：攻击失手时把动作实例的几个字段写进 note
    'T:探针': {
      name: '探针',
      triggers: [{
        id: 'p', on: 'attackMissed', role: 'actor',
        when: "action.kind == 'spell' && action.spell.school == '塑能' && action.spell.level == 0 && includes(action.spell.lists, '法师') && action.economy == 'action'",
        do: [{ kind: 'note', text: '探针：读到了火焰箭' }],
      }, {
        // 回合开始不在任何动作里：action 是 null，读它的字段是空值，条件为假而不是报错
        id: 'idle', on: 'turnStarted', role: 'any', when: "action.spell.level == 0 || action.kind == 'spell'",
        do: [{ kind: 'note', text: '探针：不该出现' }],
      }],
    },
    // 豁免成功时退还法术位（refund），并在动作上做记号（mark）
    'T:退还': {
      name: '退还',
      triggers: [{
        id: 'r', on: 'saveSucceeded', role: 'actor', when: "action.spell.slot >= 3 && action.marks.done != true",
        do: [{ kind: 'refund', what: 'slot' }, { kind: 'mark', name: 'done' }],
      }],
    },
  },
} as unknown as RuleFile;

const FILES = [rulesJson, aiSpells, spellsJson, featuresJson, TEST] as unknown as RuleFile[];

function scene(sources: string[], foes = 1) {
  const dice = scriptedDice();
  const s = new Session(createEncounter('ai'), { rules: new RuleBook(FILES), diceFor: () => dice });
  const add = (id: string, view: Record<string, unknown>) => done(s.dispatch({
    type: 'addCombatant', combatant: makeCombatant({ id, kind: id === 'w' ? 'pc' : 'monster', view: makeView({ name: id, hpMax: 60, ac: 15, ...view }) }),
  }));
  add('w', {
    level: 10, pb: 4, score: { int: 18, wis: 16 }, spell: { dc: 15, atk: 7, mod: 4, ability: 'int' }, slots: { 1: 4, 2: 3, 3: 3 },
    sources: ['XPHB:spell:火焰箭', 'XPHB:spell:圣火术', 'XPHB:spell:火球术', 'XPHB:spell:灼热射线', ...sources],
  });
  const ids = Array.from({ length: foes }, (_, i) => `g${i + 1}`);
  for (const id of ids) add(id, { score: { dex: 10 } });
  done(s.dispatch({ type: 'startCombat', order: ['w', ...ids] }));
  return { s, dice, hp: (id: string) => s.state.combatants[id].live.hp };
}

describe('动作实例：窗口里读得到触发它的那次动作', () => {
  it('攻击失手窗口里 action.kind / spell.level / school / lists / economy 都对', () => {
    const { s, dice } = scene(['T:探针']);
    dice.push(2);   // 攻击 2 + 7 = 9 < AC 15
    done(s.dispatch({ type: 'useAction', actor: 'w', action: 'XPHB:spell:火焰箭#cast', targets: ['g1'] }));
    expect(evs(s, 'note').map((n) => n.text)).toContain('探针：读到了火焰箭');
  });

  it('动作结束后 action 是 null：回合开始这类不在动作里的地方读它不报错', () => {
    const { s } = scene(['T:探针']);
    done(s.dispatch({ type: 'nextTurn' }));
    expect(s.state.turnIndex).toBe(1);
    expect(evs(s, 'note').map((n) => n.text)).not.toContain('探针：不该出现');
  });
});

describe('强力戏法（runBranch）', () => {
  it('火焰箭失手：目标仍受命中那一支一半的伤害', () => {
    const { s, dice, hp } = scene(['XPHB:法师:强力戏法:3']);
    dice.push(2, 7, 5);   // 失手；10 级火焰箭 2d10 = 7 + 5 = 12 → 一半 6
    done(s.dispatch({ type: 'useAction', actor: 'w', action: 'XPHB:spell:火焰箭#cast', targets: ['g1'] }));
    expect(hp('g1')).toBe(60 - 6);
  });

  it('没有强力戏法时失手不受伤害', () => {
    const { s, dice, hp } = scene([]);
    dice.push(2);
    done(s.dispatch({ type: 'useAction', actor: 'w', action: 'XPHB:spell:火焰箭#cast', targets: ['g1'] }));
    expect(hp('g1')).toBe(60);
  });

  it('圣火术豁免成功：仍受失败那一支一半的伤害', () => {
    const { s, dice, hp } = scene(['XPHB:法师:强力戏法:3']);
    dice.push(20, 6, 4);   // 敏捷豁免 20 成功；2d8 = 10 → 5
    done(s.dispatch({ type: 'useAction', actor: 'w', action: 'XPHB:spell:圣火术#cast', targets: ['g1'] }));
    expect(hp('g1')).toBe(60 - 5);
  });

  it('不是戏法（火球术）不受影响：豁免成功照常只受一半，不会再叠一半', () => {
    const { s, dice, hp } = scene(['XPHB:法师:强力戏法:3']);
    dice.push(20);   // 豁免成功
    dice.push(...Array(8).fill(3));   // 8d6 = 24 → 一半 12
    done(s.dispatch({ type: 'useAction', actor: 'w', action: 'XPHB:spell:火球术#cast', targets: ['g1'], slotLevel: 3 }));
    expect(hp('g1')).toBe(60 - 12);
  });
});

describe('强效塑能（rollMod.mark + 非攻击伤害的修正）', () => {
  it('火球术：每个目标都是同一次伤害掷骰，都加智力调整值', () => {
    const { s, dice, hp } = scene(['XPHB:法师:强效塑能:10'], 2);
    // 第一个目标豁免失败时掷 8d6 = 24（两个目标共用这次掷骰），然后第二个目标豁免
    dice.push(1, ...Array(8).fill(3), 1);
    done(s.dispatch({ type: 'useAction', actor: 'w', action: 'XPHB:spell:火球术#cast', targets: ['g1', 'g2'], slotLevel: 3 }));
    expect(hp('g1')).toBe(60 - 28);
    expect(hp('g2')).toBe(60 - 28);
  });

  it('灼热射线：三道射线是三次伤害掷骰，只有第一次加', () => {
    const { s, dice, hp } = scene(['XPHB:法师:强效塑能:10']);
    // 三次攻击都命中，每次 2d6 = 2
    for (let i = 0; i < 3; i++) dice.push(15, 1, 1);
    done(s.dispatch({ type: 'useAction', actor: 'w', action: 'XPHB:spell:灼热射线#cast', targets: ['g1', 'g1', 'g1'], slotLevel: 2 }));
    expect(hp('g1')).toBe(60 - (2 + 4) - 2 - 2);
  });

  it('不是塑能学派的不加；也不再弹窗问人', () => {
    const { s, dice, hp } = scene(['XPHB:法师:强效塑能:10', 'XPHB:法师:强力戏法:3']);
    dice.push(20, 6, 4);   // 圣火术也是塑能，但它在牧师列表、不在法师列表 → 强效塑能不加；强力戏法照常减半
    const r = done(s.dispatch({ type: 'useAction', actor: 'w', action: 'XPHB:spell:圣火术#cast', targets: ['g1'] }));
    expect(r.status).toBe('done');
    expect(hp('g1')).toBe(60 - 5);
  });
});

describe('强力施法（戏法判定不再问人）', () => {
  it('牧师的圣火术加感知调整值；法师的火焰箭不加', () => {
    const { s, dice, hp } = scene(['XPHB:牧师:强力施法:7']);
    dice.push(1, 6, 4);   // 豁免失败，2d8 = 10，+3
    done(s.dispatch({ type: 'useAction', actor: 'w', action: 'XPHB:spell:圣火术#cast', targets: ['g1'] }));
    expect(hp('g1')).toBe(60 - 13);
    const b = scene(['XPHB:牧师:强力施法:7']);
    b.dice.push(18, 5, 5);  // 火焰箭命中，2d10 = 10，不加（不在牧师法术列表里）
    done(b.s.dispatch({ type: 'useAction', actor: 'w', action: 'XPHB:spell:火焰箭#cast', targets: ['g1'] }));
    expect(b.hp('g1')).toBe(60 - 10);
  });
});

describe('refund / mark：退还触发窗口的那次动作的法术位，记号让它只发生一次', () => {
  it('火球术有目标豁免成功 → 退还 3 环法术位，两个目标成功也只退一次', () => {
    const { s, dice } = scene(['T:退还'], 2);
    // 第一个目标豁免成功时按共享掷骰补掷 8d6，然后第二个目标豁免
    dice.push(20, ...Array(8).fill(3), 20);
    done(s.dispatch({ type: 'useAction', actor: 'w', action: 'XPHB:spell:火球术#cast', targets: ['g1', 'g2'], slotLevel: 3 }));
    expect(s.state.combatants.w.live.slotsUsed[3] ?? 0).toBe(0);
    expect(evs(s, 'note').filter((n) => String(n.text).includes('退还')).length).toBe(1);
  });
});
