// 真实数据里的持续区域法术（重新数据化用上 zone 节点之后）：
// ① 数据形状对（时机、骰子、每回合一次）；② 引擎真的会在进入 / 回合结束时结算
import { describe, expect, it } from 'vitest';
import { RULE_FILES } from '../../src/bridge/rule-files';
import {
  RuleBook, Session, createEncounter, makeCombatant, makeView, scriptedDice, type Positions, type RuleFile,
} from '../../src/combat';
import { done, evs, pending } from './helpers';

const entryOf = (key: string): any => {
  for (const f of RULE_FILES) { const e = (f as RuleFile).entries[key]; if (e) return e; }
  return null;
};
/** 一条条目里所有 zone 节点（含嵌在 if / forEach 里的） */
const zonesOf = (entry: unknown): any[] => {
  const out: any[] = [];
  const walk = (x: unknown) => {
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (x && typeof x === 'object') {
      const o = x as Record<string, unknown>;
      if (o.kind === 'zone') out.push(o);
      Object.values(o).forEach(walk);
    }
  };
  walk(entry);
  return out;
};

describe('区域法术：数据形状（拿真数据）', () => {
  const cases: Array<[string, string[]]> = [
    ['XPHB:spell:匕首之云', ['enter', 'turnEnd']],
    ['XPHB:spell:臭云术', ['turnStart']],
  ];
  it.each(cases)('%s 用上了 zone 节点，时机是 %j', (key, on) => {
    const e = entryOf(key);
    expect(e, `${key} 应该在动态层数据里`).toBeTruthy();
    const zones = zonesOf(e);
    expect(zones, `${key} 应该有 zone 节点`).toHaveLength(1);
    expect([...zones[0].on].sort()).toEqual([...on].sort());
    expect(zones[0].do?.length).toBeGreaterThan(0);
  });

  it('匕首之云：升环骰子按 (2 * slot.level)d4 写在 zone 里，每回合一次', () => {
    const z = zonesOf(entryOf('XPHB:spell:匕首之云'))[0];
    expect(JSON.stringify(z.do)).toContain('(2 * slot.level)d4');
    expect(z.oncePerTurn === undefined || z.oncePerTurn === true).toBe(true); // 缺省就是每回合一次
  });

  it('臭云术：在云里开始回合 → 体质豁免 → 失败挂上云团中毒（到本回合结束）', () => {
    const e = entryOf('XPHB:spell:臭云术');
    const z = zonesOf(e)[0];
    const save = z.do.find((n: any) => n.kind === 'save');
    expect(save).toBeTruthy();
    expect(save.ability).toBe('con');
    const eff = (save.onFail ?? []).find((n: any) => n.kind === 'applyEffect');
    expect(String(eff?.template)).toMatch(/中毒|恶心/);          // 云团中毒：不能执行动作 / 附赠动作
    expect(eff?.duration?.until).toMatchObject({ at: 'turnEnd', of: 'bearer', nth: 0 });
    // 模板要么是官方状态，要么在这条自己的 effects 里定义（不能挂个不存在的名字）
    const tpl = String(eff?.template ?? '');
    if (!tpl.includes(':')) expect(e.effects?.[tpl], `effects 里应该有「${tpl}」`).toBeTruthy();
  });
});

describe('区域法术：真的结算（真数据 + 一场小遭遇）', () => {
  function scene(spells: string[]) {
    const dice = scriptedDice();
    const positions = { current: { w: { x: 0, y: 0, s: 1 }, g: { x: 5, y: 0, s: 1 } } as Positions };
    const s = new Session(createEncounter('z'), { rules: new RuleBook(RULE_FILES), diceFor: () => dice, positions: () => positions.current });
    done(s.dispatch({
      type: 'addCombatant',
      combatant: makeCombatant({
        id: 'w', kind: 'pc',
        view: makeView({ name: '法师', score: { int: 16 }, hpMax: 20, spell: { dc: 15, atk: 7, mod: 3, ability: 'int' }, slots: { 2: 2, 3: 2 }, sources: spells }),
      }),
    }));
    done(s.dispatch({
      type: 'addCombatant',
      combatant: makeCombatant({ id: 'g', kind: 'monster', side: 'enemy', view: makeView({ name: '地精', score: { str: 8, dex: 14 }, ac: 15, hpMax: 60 }) }),
    }));
    done(s.dispatch({ type: 'startCombat', order: ['w', 'g'] }));
    // 服务器做的事：引擎发了 moved 就改地图
    const sync = () => { for (const m of evs(s, 'moved')) positions.current[m.id] = { ...positions.current[m.id], ...m.to }; };
    return { s, dice, sync, positions };
  }
  const hp = (s: Session, id: string) => s.state.combatants[id].live.hp;

  it('匕首之云：地精走进区域时受伤（4d4，2 环）', () => {
    const { s, dice, sync } = scene(['XPHB:spell:匕首之云']);
    // 施法：区域选 (8,0) 那一格（地精在 (5,0)，还没进去）；引擎会问用几环法术位
    const d = pending(s.dispatch({ type: 'useAction', actor: 'w', action: 'XPHB:spell:匕首之云#cast', targets: [], area: { cells: ['8,0'] } }));
    expect(d.prompt).toContain('几环法术位');
    done(s.decide('2'));
    expect(Object.values(s.state.zones ?? {})).toHaveLength(1);
    // 走进区域 → 4d4 挥砍（2 环：(2 * slot.level)d4）
    dice.push(4, 4, 4, 4);
    done(s.dispatch({ type: 'move', id: 'g', ft: 15, path: [{ x: 6, y: 0 }, { x: 7, y: 0 }, { x: 8, y: 0 }] }));
    sync();
    expect(hp(s, 'g')).toBe(60 - 16);
  });
});
