// 菜单选择和动作实例剩下的几样：chooseTargets（挑生物）、allocate（分配点数）、retype（改伤害类型）、
// trimDamage（扣骰子）、rerollDamage（重掷伤害骰）、repeatAction（对另一目标再来一次）、
// modifyCast.slotDelta + chooseTargets.addTo（孪生法术：多一个目标、按高一环算）、法术池按学派筛
import { describe, expect, it } from 'vitest';
import { RuleBook, Session, createEncounter, makeCombatant, makeView, scriptedDice, type RuleFile } from '../../src/combat';
import { FILES, done, evs, pending } from './helpers';

const bolt = (dmg = '2d6', extra: Record<string, unknown> = {}) => ({
  id: 'cast', name: '光矢', activation: 'action', tags: ['spell'], targeting: { type: 'creature', count: 1 },
  root: [{ kind: 'attack', attack: { ranged: true, spell: true }, onHit: [{ kind: 'damage', dice: dmg, type: '光耀' }] }], ...extra,
});

const TEST = {
  entries: {
    'T:spell:光矢': { name: '光矢', actions: [bolt()] },
    // 每个目标受 slot.level 点（看有效环阶）；最多 slot.level 个目标
    'T:spell:点名': {
      name: '点名',
      actions: [{
        id: 'cast', name: '点名', activation: 'action', tags: ['spell'], cost: [{ slot: { min: 1 } }],
        targeting: { type: 'creature', count: 'slot.level' }, root: [{ kind: 'damage', dice: 'slot.level', type: '力场', to: 'each' }],
      }],
    },
    'T:spell:冲击': {
      name: '冲击',
      actions: [{ id: 'cast', name: '冲击', activation: 'action', tags: ['spell'], targeting: { type: 'creature', count: 1 }, root: [{ kind: 'damage', dice: '4d6', type: '雷鸣' }] }],
    },
    // 施法后对 10 尺内自选的敌人各造成 3 点（风暴之心那种）
    'T:风暴': {
      name: '风暴',
      triggers: [{ id: 's', on: 'spellCast', role: 'actor', do: [{ kind: 'chooseTargets', prompt: '雷霆打谁', from: 'enemies', within: { ft: 10 }, count: 2, do: [{ kind: 'damage', dice: '3', type: '闪电' }] }] }],
    },
    // 施法后给法术目标之一 5 点临时生命值（巩固法术那种，from: targets）
    'T:巩固': {
      name: '巩固',
      triggers: [{ id: 'b', on: 'spellCast', role: 'actor', do: [{ kind: 'chooseTargets', prompt: '给谁', from: 'targets', min: '1', do: [{ kind: 'tempHp', amount: '5', to: 'target' }] }] }],
    },
    // 分配 10 点治疗，每人最多 6（维持生命那种）
    'T:维持': {
      name: '维持',
      actions: [{ id: 'use', name: '维持', activation: 'action', root: [{ kind: 'allocate', prompt: '分配治疗', from: 'allies', total: '10', maxEach: '6', var: 'n', do: [{ kind: 'heal', amount: 'vars.n', to: 'target' }] }] }],
    },
    // 命中时把伤害改成力场（真力注拳那种）
    'T:改力场': { name: '改力场', triggers: [{ id: 'r', on: 'attackHit', window: 'before', role: 'actor', do: [{ kind: 'retype', value: '力场' }] }] },
    // 命中时加 3d6「偷袭」，再扣掉 1 颗（诡诈打击那种）
    'T:偷袭': { name: '偷袭', triggers: [{ id: 'sa', label: '偷袭', on: 'attackHit', window: 'before', role: 'actor', do: [{ kind: 'addDamage', dice: '3d6', type: '穿刺' }] }] },
    'T:诡诈': { name: '诡诈', triggers: [{ id: 'cs', on: 'attackHit', window: 'before', role: 'actor', do: [{ kind: 'trimDamage', from: '偷袭', dice: '1' }] }] },
    // 重掷最小的 2 颗伤害骰（强效法术那种）
    'T:强效': { name: '强效', triggers: [{ id: 'e', on: 'damageIncoming', window: 'before', role: 'actor', when: "action.kind == 'spell'", modify: [{ op: 'rerollDamage', count: '2' }] }] },
    // 命中后跳到另一个目标再来一次（只跳一次）
    'T:跳跃': {
      name: '跳跃',
      triggers: [{
        id: 'j', on: 'attackHit', role: 'actor', when: 'action.marks.leaped != true',
        do: [{ kind: 'mark', name: 'leaped' }, { kind: 'repeatAction', prompt: '跳到谁身上', from: 'enemies' }],
      }],
    },
    // 孪生：施法前加一个目标、有效环阶 +1
    'T:孪生': {
      name: '孪生',
      triggers: [{
        id: 't', on: 'spellCast', window: 'before', role: 'actor',
        do: [{ kind: 'modifyCast', slotDelta: '1' }, { kind: 'chooseTargets', prompt: '多打谁', from: 'enemies', exclude: ['target'], min: '1', addTo: 'cast' }],
      }],
    },
    // 从自己的塑能法术里挑一道
    'T:挑塑能': {
      name: '挑塑能',
      actions: [{ id: 'use', name: '挑塑能', activation: 'free', root: [{ kind: 'choose', prompt: '哪道', var: 'k', pool: { from: 'ownSpells', school: '塑能' }, options: [] }] }],
    },
  },
} as unknown as RuleFile;

function scene(sources: string[], foes = 2) {
  const dice = scriptedDice();
  const s = new Session(createEncounter('m'), { rules: new RuleBook([...FILES, TEST]), diceFor: () => dice });
  const add = (id: string, side: string, view: Record<string, unknown>, hp?: number) => done(s.dispatch({
    type: 'addCombatant', combatant: makeCombatant({ id, kind: side === 'party' ? 'pc' : 'monster', side, ...(hp !== undefined ? { hp } : {}), view: makeView({ name: id, hpMax: 40, ac: 12, ...view }) }),
  }));
  add('w', 'party', { level: 5, pb: 3, score: { int: 16, cha: 16 }, spell: { dc: 14, atk: 6, mod: 3, ability: 'int' }, slots: { 1: 4, 2: 3, 3: 2 },
    sources: ['T:spell:光矢', 'T:spell:点名', 'T:spell:冲击', 'XPHB:spell:火球术', 'XPHB:spell:护盾术', ...sources] });
  add('a', 'party', {}, 20);
  for (let i = 1; i <= foes; i++) add(`g${i}`, 'foe', {});
  done(s.dispatch({ type: 'startCombat', order: ['w', 'a', ...Array.from({ length: foes }, (_, i) => `g${i + 1}`)] }));
  return { s, dice, hp: (id: string) => s.state.combatants[id].live.hp };
}

describe('chooseTargets：挑生物', () => {
  it('施法后从敌人里挑两个，各受 3 点（没地图时不按距离筛，提示里注明）', () => {
    const { s, dice, hp } = scene(['T:风暴'], 3);
    dice.push(5, 5, 5, 5);
    const d = pending(s.dispatch({ type: 'useAction', actor: 'w', action: 'T:spell:冲击#cast', targets: ['g1'] }));
    expect(d.kind).toBe('choose');
    expect(d.options.map((o) => o.id)).toEqual(['g1', 'g2', 'g3']);
    expect(d.prompt).toContain('10 尺内');
    done(s.decide(['g2', 'g3']));
    expect([hp('g1'), hp('g2'), hp('g3')]).toEqual([40 - 20, 40 - 3, 40 - 3]);
  });

  it('from: targets —— 只从这次法术的目标里挑；至少挑一个且只有一个候选时不问', () => {
    const { s, dice, hp } = scene(['T:巩固']);
    dice.push(3, 3, 3, 3);
    done(s.dispatch({ type: 'useAction', actor: 'w', action: 'T:spell:冲击#cast', targets: ['g1'] }));
    // 「施法后」窗口在法术结算之前开（spellCast after）：先拿到 5 点临时生命值，再吃 12 点伤害
    expect(s.state.combatants.g1.live.tempHp).toBe(0);
    expect(hp('g1')).toBe(40 - 7);
  });
});

describe('allocate：分配点数', () => {
  it('10 点治疗分给盟友：每人最多 6，用完就停', () => {
    const { s } = scene(['T:维持']);
    done(s.dispatch({ type: 'adjustHp', id: 'w', set: 20 }));
    let d = pending(s.dispatch({ type: 'useAction', actor: 'w', action: 'T:维持#use', targets: [] }));
    expect(d.kind).toBe('choose');   // 先挑分给谁
    d = pending(s.decide(['w', 'a']));
    expect(d.kind).toBe('number');
    expect(d.max).toBe(6);
    d = pending(s.decide(6));
    expect(d.max).toBe(4);   // 还剩 4
    done(s.decide(4));
    expect(s.state.combatants.w.live.hp).toBe(26);
    expect(s.state.combatants.a.live.hp).toBe(24);
  });
});

describe('retype / trimDamage / rerollDamage', () => {
  it('retype：命中时把这次伤害改成力场', () => {
    const { s, dice } = scene(['T:改力场']);
    dice.push(15, 3, 3);
    done(s.dispatch({ type: 'useAction', actor: 'w', action: 'T:spell:光矢#cast', targets: ['g1'] }));
    expect(evs(s, 'damageTaken').at(-1)?.type).toBe('力场');
  });

  it('trimDamage：偷袭 3d6 扣掉 1 颗，只掷 2d6', () => {
    const { s, dice, hp } = scene(['T:偷袭', 'T:诡诈']);
    dice.push(15, 1, 1, 6, 6);   // 命中；光矢 2d6 = 2；偷袭剩 2d6 = 12
    done(s.dispatch({ type: 'useAction', actor: 'w', action: 'T:spell:光矢#cast', targets: ['g1'] }));
    expect(hp('g1')).toBe(40 - 14);
  });

  it('rerollDamage：重掷最小的两颗', () => {
    const { s, dice, hp } = scene(['T:强效']);
    dice.push(15, 1, 2, 6, 5);   // 命中；2d6 = 1、2 → 重掷成 6、5
    done(s.dispatch({ type: 'useAction', actor: 'w', action: 'T:spell:光矢#cast', targets: ['g1'] }));
    expect(hp('g1')).toBe(40 - 11);
  });

  it('rerollDamage：火球术共享掷骰，第一个目标重掷后第二个目标照用新骰面（不再重掷）', () => {
    const { s, dice, hp } = scene(['T:强效']);
    dice.push(1, ...Array(8).fill(1), 6, 6, 1);   // g1 豁免失败；8d6 全 1 → 重掷两颗得 6、6；g2 豁免失败
    done(s.dispatch({ type: 'useAction', actor: 'w', action: 'XPHB:spell:火球术#cast', targets: ['g1', 'g2'], slotLevel: 3 }));
    expect(hp('g1')).toBe(40 - 18);
    expect(hp('g2')).toBe(40 - 18);
  });
});

describe('repeatAction：对另一目标再来一次', () => {
  it('命中后跳到另一个敌人，再攻击一次（只跳一次）', () => {
    const { s, dice, hp } = scene(['T:跳跃'], 3);
    dice.push(15, 3, 3);
    const d = pending(s.dispatch({ type: 'useAction', actor: 'w', action: 'T:spell:光矢#cast', targets: ['g1'] }));
    expect(d.options.map((o) => o.id)).not.toContain('g1');
    dice.push(15, 4, 4);
    done(s.decide(['g2']));
    expect([hp('g1'), hp('g2'), hp('g3')]).toEqual([34, 32, 40]);
  });
});

describe('孪生：施法前加一个目标、有效环阶 +1', () => {
  it('1 环「点名」打两个目标，每个受 2 点（按 2 环算），只花 1 环法术位', () => {
    const { s, hp } = scene(['T:孪生']);
    done(s.dispatch({ type: 'useAction', actor: 'w', action: 'T:spell:点名#cast', targets: ['g1'], slotLevel: 1 }));
    // 只有一个可加的目标（g2）→ 不问
    expect([hp('g1'), hp('g2')]).toEqual([38, 38]);
    expect(s.state.combatants.w.live.slotsUsed[1]).toBe(1);
    expect(s.state.combatants.w.live.slotsUsed[2] ?? 0).toBe(0);
  });
});

describe('choose.pool 按学派筛', () => {
  it('只列塑能学派的（火球术），不列防护学派的护盾术', () => {
    const { s } = scene(['T:挑塑能']);
    const r = s.dispatch({ type: 'useAction', actor: 'w', action: 'T:挑塑能#use', targets: [] });
    // 只有一道符合 → 不问，直接选中
    expect(r.status).toBe('done');
    expect(evs(s, 'note').some((n) => String(n.text).includes('没有可选'))).toBe(false);
  });
});

/* ---------------- 真数据：照新写法重写的条目 ---------------- */
import { cleric, goblin, rogue, setup } from './helpers';

describe('真数据：偷袭 + 诡诈打击', () => {
  it('5 级游荡者：偷袭 3d6 选「摔绊」→ 只掷 2d6，目标敏捷豁免失败倒地', () => {
    const { s, dice } = setup([rogue({ levels: { 游荡者: 5 } }), goblin('g', { hpMax: 40 })]);
    done(s.dispatch({ type: 'startCombat', order: ['r', 'g'] }));
    done(s.dispatch({ type: 'applyEffect', to: 'g', template: 'XPHB:condition:目盲' }));   // 打目盲的目标有优势
    dice.push(18, 18);   // 优势：两颗 d20
    let d = pending(s.dispatch({ type: 'useAction', actor: 'r', action: 'weapon:rp', targets: ['g'] }));
    expect(d.kind).toBe('optionalTrigger');   // 用不用偷袭
    d = pending(s.decide(d.options.map((o) => o.id)));
    expect(d.kind).toBe('choose');   // 诡诈打击选哪个
    expect(d.options.map((o) => o.label).join('|')).toContain('摔绊');
    expect(d.options.map((o) => o.label).join('|')).not.toContain('击昏');   // 14 级才有
    const trip = d.options.find((o) => o.label.startsWith('摔绊'))!;
    dice.push(2);           // 地精敏捷豁免 2，失败
    dice.push(4, 3, 3);     // 刺剑 1d8 = 4；偷袭只剩 2d6 = 3 + 3
    done(s.decide([trip.id]));
    expect(s.state.combatants.g.live.hp).toBe(40 - (4 + 4 + 6));
    expect(Object.values(s.state.effects).some((e) => e.bearer === 'g' && e.name === '倒地')).toBe(true);
  });
});

describe('真数据：维持生命（分配治疗池）', () => {
  it('3 级牧师 15 点：两个浴血的盟友各分一些，每人最多治到上限一半', () => {
    const { s } = setup([cleric('c', { levels: { 牧师: 3 }, sources: ['XPHB:牧师:维持生命:3'], resources: { 引导神力: 2 } }),
      { id: 'a', kind: 'pc', hp: 4, view: { name: '甲', hpMax: 30 } }, { id: 'b', kind: 'pc', hp: 10, view: { name: '乙', hpMax: 30 } }]);
    let d = pending(s.dispatch({ type: 'useAction', actor: 'c', action: 'XPHB:牧师:维持生命:3#use', targets: [] }));
    expect(d.kind).toBe('choose');
    expect(d.options.map((o) => o.id).sort()).toEqual(['a', 'b']);   // 牧师自己没受伤，不在候选里
    d = pending(s.decide(['a', 'b']));
    expect(d.max).toBe(11);   // 甲：4 → 最多到 15
    d = pending(s.decide(11));
    expect(d.max).toBe(4);    // 乙：还剩 4 点；本来最多 5
    done(s.decide(4));
    expect(s.state.combatants.a.live.hp).toBe(15);
    expect(s.state.combatants.b.live.hp).toBe(14);
  });
});

describe('手写的盖过 AI 的：同键逐字段合并，要显式清空', () => {
  it('诡诈打击的几个选项条目（AI 写的、要人自己扣骰）被清空，只剩偷袭里那一处', async () => {
    const ai = (await import('../../data/dyn/ai/features.json')).default as unknown as RuleFile;
    const rules = new RuleBook([...FILES.slice(0, 1), ai, ...FILES.slice(1)]);
    for (const k of ['XPHB:游荡者:投毒（花费：1d6）:5', 'XPHB:游荡者:摔绊（花费：1d6）:5', 'XPHB:游荡者:撤步（花费：1d6）:5', 'XPHB:游荡者:恍惚（花费：2d6）:14', 'XPHB:游荡者:击昏（花费：6d6）:14']) {
      expect(rules.entry(k)?.triggers ?? [], k).toEqual([]);
    }
    expect(JSON.stringify(rules.entry('XPHB:游荡者:偷袭:1'))).toContain('trimDamage');
  });
});
