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
        view: makeView({ name: '法师', score: { int: 16 }, hpMax: 20, spell: { dc: 15, atk: 7, mod: 3, ability: 'int' }, slots: { 1: 2, 2: 2, 3: 2 }, sources: spells }),
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

  const cast = (s: Session, key: string, cells: string[]) => {
    // 有升环效果的才问用几环；不问就直接用最低环
    const r = s.dispatch({ type: 'useAction', actor: 'w', action: `${key}#cast`, targets: [], area: { cells } });
    if (r.status === 'pending') done(s.decide('2'));
    else done(r);
  };
  const has = (s: Session, id: string, name: string) => Object.values(s.state.effects).some((e) => e.bearer === id && e.key.endsWith(`#${name}`));
  const zoneId = (s: Session) => Object.keys(s.state.zones ?? {})[0];

  it('匕首之云：下个回合「移动立方」挪到地精身上 → 地精受伤', () => {
    const { s, dice } = scene(['XPHB:spell:匕首之云']);
    cast(s, 'XPHB:spell:匕首之云', ['8,0']);
    done(s.dispatch({ type: 'nextTurn' }));
    done(s.dispatch({ type: 'nextTurn' }));
    dice.push(1, 2, 3, 4);
    done(s.dispatch({ type: 'useAction', actor: 'w', action: 'XPHB:spell:匕首之云#moveCloud', targets: [], area: { cells: ['5,0'] } }));
    expect(s.state.zones![zoneId(s)].cells).toEqual(['5,0']);
    expect(hp(s, 'g')).toBe(60 - 10);
  });

  it('蛛网术：走进去豁免失败被束缚；蛛网挪走（离开蛛网）束缚自动解除', () => {
    const { s, dice, sync } = scene(['XPHB:spell:蛛网术']);
    cast(s, 'XPHB:spell:蛛网术', ['6,0', '7,0']);
    done(s.dispatch({ type: 'nextTurn' }));
    dice.push(2);   // 敏捷豁免 2 + 2 < 15
    done(s.dispatch({ type: 'move', id: 'g', ft: 5, path: [{ x: 5, y: 0 }, { x: 6, y: 0 }] }));
    sync();
    expect(has(s, 'g', '蛛网束缚')).toBe(true);
    done(s.dispatch({ type: 'moveZone', id: zoneId(s), cells: ['0,9'] }));
    expect(has(s, 'g', '蛛网束缚')).toBe(false);
  });

  it('沉默术：在里面就耳聋；区域挪走就摘掉', () => {
    const { s } = scene(['XPHB:spell:沉默术']);
    cast(s, 'XPHB:spell:沉默术', ['4,0', '5,0', '6,0']);
    expect(has(s, 'g', '沉默术')).toBe(true);
    expect(has(s, 'w', '沉默术')).toBe(false);
    done(s.dispatch({ type: 'moveZone', id: zoneId(s), cells: ['0,0'] }));
    expect(has(s, 'g', '沉默术')).toBe(false);
    expect(has(s, 'w', '沉默术')).toBe(true);
  });

  it('荆棘丛生：在里面每走 5 尺受 2d4，而且是困难地形', () => {
    const { s, dice, sync } = scene(['XPHB:spell:荆棘丛生']);
    cast(s, 'XPHB:spell:荆棘丛生', ['6,0', '7,0', '8,0']);
    done(s.dispatch({ type: 'nextTurn' }));
    dice.push(1, 1, 1, 1);
    done(s.dispatch({ type: 'move', id: 'g', ft: 10, path: [{ x: 5, y: 0 }, { x: 6, y: 0 }, { x: 7, y: 0 }] }));
    sync();
    expect(hp(s, 'g')).toBe(60 - 4);
    expect(s.state.combatants.g.economy.move).toBe(30 - 20);
  });

  it('炽焰法球：在法球周围 5 尺内结束回合 → 敏捷豁免；附赠动作挪法球', () => {
    const { s, dice, sync } = scene(['XPHB:spell:炽焰法球']);
    // 法球在 (9,1)，周围 5 尺 = (8..10, 0..2)
    const around = (x: number, y: number) => [-1, 0, 1].flatMap((dx) => [-1, 0, 1].map((dy) => `${x + dx},${y + dy}`));
    cast(s, 'XPHB:spell:炽焰法球', around(9, 1));
    done(s.dispatch({ type: 'nextTurn' }));
    done(s.dispatch({ type: 'move', id: 'g', ft: 15, path: [{ x: 5, y: 0 }, { x: 6, y: 0 }, { x: 7, y: 0 }, { x: 8, y: 0 }] }));
    sync();
    dice.push(2, 3, 3);   // 豁免 2 + 2 < 15，2d6 = 6
    done(s.dispatch({ type: 'nextTurn' }));
    expect(hp(s, 'g')).toBe(60 - 6);
    // 法师的回合：附赠动作把法球挪到 (2,5)，地精不在新范围里了
    done(s.dispatch({ type: 'useAction', actor: 'w', action: 'XPHB:spell:炽焰法球#move', targets: [], area: { cells: around(2, 5) } }));
    expect(s.state.zones![zoneId(s)].cells).toContain('2,5');
  });

  it('油腻术：困难地形，走过去多花移动力', () => {
    const { s, dice, sync } = scene(['XPHB:spell:油腻术']);
    cast(s, 'XPHB:spell:油腻术', ['6,0', '6,1']);
    done(s.dispatch({ type: 'nextTurn' }));
    dice.push(20);   // 进油里的敏捷豁免：过
    done(s.dispatch({ type: 'move', id: 'g', ft: 10, path: [{ x: 5, y: 0 }, { x: 6, y: 0 }, { x: 7, y: 0 }] }));
    sync();
    expect(s.state.combatants.g.economy.move).toBe(30 - 15);
  });
});
