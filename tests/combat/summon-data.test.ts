// 真数据里的召唤：寻获坐骑（这一轮重新数据化后用上 summon 节点）
import { describe, expect, it } from 'vitest';
import { RULE_FILES } from '../../src/bridge/rule-files';
import { RuleBook, Session, createEncounter, makeCombatant, makeView, scriptedDice, type RuleFile } from '../../src/combat';
import { done, pending } from './helpers';

const entryOf = (key: string): any => {
  for (const f of RULE_FILES) { const e = (f as RuleFile).entries[key]; if (e) return e; }
  return null;
};
const summonsOf = (entry: unknown): any[] => {
  const out: any[] = [];
  const walk = (x: unknown) => {
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (x && typeof x === 'object') {
      const o = x as Record<string, unknown>;
      if (o.kind === 'summon') out.push(o);
      Object.values(o).forEach(walk);
    }
  };
  walk(entry);
  return out;
};

describe('召唤法术：数据形状（拿真数据）', () => {
  it('寻获坐骑用上了 summon 节点，数值随环阶算', () => {
    const s = summonsOf(entryOf('XPHB:spell:寻获坐骑'));
    expect(s.length).toBeGreaterThanOrEqual(3);              // 天族 / 妖精 / 邪魔三种形态
    for (const one of s) {
      expect(String(one.ac)).toContain('slot.level');
      expect(String(one.hp)).toContain('slot.level');
      expect(one.attacks?.length).toBeGreaterThan(0);
    }
  });

  it('巨虫术（专注召唤）写在 choose 里、有 link 语义（专注结束退场）', () => {
    const e = entryOf('XPHB:spell:巨虫术');
    expect(summonsOf(e).length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(e)).toContain('concentration');     // 专注法术 → 默认随专注退场
  });
});

describe('召唤法术：真的进场（真数据 + 一场小遭遇）', () => {
  function scene(spells: string[]) {
    const dice = scriptedDice();
    const s = new Session(createEncounter('s'), { rules: new RuleBook(RULE_FILES), diceFor: () => dice });
    done(s.dispatch({
      type: 'addCombatant',
      combatant: makeCombatant({
        id: 'w', kind: 'pc',
        view: makeView({
          name: '圣武士', level: 5, score: { str: 16, cha: 16 }, hpMax: 40, pb: 3,
          spell: { dc: 14, atk: 6, mod: 3, ability: 'cha' }, slots: { 2: 1 }, sources: spells,
        }),
      }),
    }));
    done(s.dispatch({
      type: 'addCombatant',
      combatant: makeCombatant({ id: 'g', kind: 'monster', side: 'enemy', view: makeView({ name: '地精', score: { dex: 14 }, ac: 15, hpMax: 30 }) }),
    }));
    return { s, dice };
  }

  it('寻获坐骑：选天族 → 场上多出一个由我控制的坐骑，数值照数据', () => {
    const { s, dice } = scene(['XPHB:spell:寻获坐骑']);
    dice.push(18, 5);                       // 先攻：圣武士 > 地精
    done(s.dispatch({ type: 'startCombat' }));
    const p = pending(s.dispatch({ type: 'useAction', actor: 'w', action: 'XPHB:spell:寻获坐骑#cast', slotLevel: 2 }));
    expect(p.kind).toBe('choose');
    done(s.decide([p.options[0].id]));       // 天族

    const id = Object.keys(s.state.combatants).find((k) => k !== 'w' && k !== 'g');
    expect(id, '场上应该多出一个召唤物').toBeTruthy();
    const steed = s.state.combatants[id!];
    expect(steed.summoner).toBe('w');
    expect(steed.controller).toBe('w');
    expect(steed.base.ac).toBe(12);          // 10 + 2 环
    expect(steed.base.hpMax).toBe(25);       // 5 + 10 * 2 环
    expect(steed.linkEffect).toBeUndefined(); // 寻获坐骑不占专注 → 坐骑留着
    // 先攻紧跟在召唤者后面
    const order = s.state.order;
    expect(order[order.indexOf('w') + 1]).toBe(id);
  });
});
