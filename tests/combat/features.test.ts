/**
 * 第二批黄金条目：职业特性与专长（回气、战术思维、动作如潮、灵巧动作、稳定瞄准、危机感应、
 * 圣疗、至圣斩、神圣武器、武艺 / 疾风连击 / 震慑拳、诗人激励、幸运、先天术法）。
 */
import { describe, expect, it } from 'vitest';
import type { DispatchResult } from '../../src/combat';
import { GREATAXE, LONGSWORD, RAPIER, autoYes, done, evs, fighter, goblin, has, last, pending, setup as baseSetup, type Who } from './helpers';

const setup = (...a: Parameters<typeof baseSetup>) => {
  const r = baseSetup(...a);
  autoYes(r.s);
  return r;
};

const fighter5 = (over = {}): Who => fighter({
  pb: 3, level: 5, levels: { 战士: 5 }, resources: { 回气: 2, 动作如潮: 1 },
  sources: ['XPHB:战士:回气:1', 'XPHB:战士:战术思维:2', 'XPHB:战士:动作如潮:2'], ...over,
});

const paladin = (over = {}): Who => ({
  id: 'p', kind: 'pc',
  view: {
    name: '圣武士', score: { str: 16, cha: 16 }, pb: 3, level: 5, levels: { 圣武士: 5 }, ac: 18, hpMax: 44, attacks: [LONGSWORD],
    slots: { 1: 4, 2: 2 }, spell: { dc: 14, atk: 6, mod: 3, ability: 'cha' },
    resources: { layOnHands: 25, 'channel-divinity': 2 },
    sources: ['XPHB:圣武士:圣疗:1', 'XPHB:spell:至圣斩', 'XPHB:圣武士:神圣武器:3'], ...over,
  },
});

const monk = (over = {}): Who => ({
  id: 'm', kind: 'pc',
  view: {
    name: '武僧', score: { dex: 16, wis: 14 }, pb: 3, level: 5, levels: { 武僧: 5 }, ac: 16, hpMax: 38,
    resources: { 功力: 5 }, classTable: { 武艺: '1d8' },
    sources: ['XPHB:武僧:武艺:1', 'XPHB:武僧:疾风连击:2', 'XPHB:武僧:震慑拳:5'], ...over,
  },
});

const bard = (over = {}): Who => ({
  id: 'd', kind: 'pc',
  view: {
    name: '诗人', score: { dex: 14, cha: 16 }, pb: 2, level: 4, levels: { 吟游诗人: 4 }, ac: 12, hpMax: 27,
    resources: { 诗人激励: 3, 'luck-points': 2 }, classTable: { 诗人骰: '1d6' },
    sources: ['XPHB:吟游诗人:吟游诗人激励:1', 'XPHB:幸运'], ...over,
  },
});

const rogue = (over = {}): Who => ({
  id: 'r', kind: 'pc',
  view: {
    name: '游荡者', score: { dex: 18 }, pb: 3, level: 5, hpMax: 33, attacks: [RAPIER], skill: { 隐匿: 7 },
    sources: ['XPHB:游荡者:灵巧动作:2', 'XPHB:游荡者:稳定瞄准:3'], ...over,
  },
});

describe('战士', () => {
  it('回气：附赠动作，恢复 1d10 + 战士等级', () => {
    const { s, dice } = setup([{ ...fighter5(), hp: 10 }, goblin()]);
    done(s.dispatch({ type: 'startCombat', order: ['f', 'g'] }));
    dice.push(7);
    done(s.dispatch({ type: 'useAction', actor: 'f', action: 'XPHB:战士:回气:1#use' }));
    expect(s.state.combatants.f.live.hp).toBe(10 + 7 + 5);
    expect(s.state.combatants.f.live.resourcesUsed.回气).toBe(1);
    expect(s.state.combatants.f.economy.bonus).toBe(0);
  });

  it('战术思维：属性检定失败时花一次回气加 1d10；加完仍失败就不消耗', () => {
    const { s, dice } = setup([fighter5()]);
    dice.push(8);   // 8 + 3 = 11 < 15
    const d = pending(s.dispatch({ type: 'roll', roller: 'f', kind: 'check', ability: 'str', dc: 15 }));
    expect(d.options[0].label).toContain('战术思维');
    dice.push(6);
    done(s.decide(['0']));
    expect(last(s, 'd20Rolled').total).toBe(17);
    expect(last(s, 'd20Rolled').outcome).toBe('success');
    expect(s.state.combatants.f.live.resourcesUsed.回气).toBe(1);

    dice.push(2);
    pending(s.dispatch({ type: 'roll', roller: 'f', kind: 'check', ability: 'str', dc: 15 }));
    dice.push(3);
    done(s.decide(['0']));
    expect(last(s, 'd20Rolled').outcome).toBe('fail');
    expect(s.state.combatants.f.live.resourcesUsed.回气).toBe(1);   // 退回来了

    // 检定成功、没有 DC：都不打扰
    dice.push(18);
    done(s.dispatch({ type: 'roll', roller: 'f', kind: 'check', ability: 'str', dc: 15 }));
    dice.push(3);
    done(s.dispatch({ type: 'roll', roller: 'f', kind: 'check', ability: 'str' }));
  });

  it('动作如潮：自己回合多一个动作，每回合一次', () => {
    const { s } = setup([fighter5({ resources: { 回气: 2, 动作如潮: 2 } }), goblin()]);
    done(s.dispatch({ type: 'startCombat', order: ['f', 'g'] }));
    done(s.dispatch({ type: 'useAction', actor: 'f', action: 'XPHB:战士:动作如潮:2#use' }));
    expect(s.state.combatants.f.economy.action).toBe(2);
    expect(s.dispatch({ type: 'useAction', actor: 'f', action: 'XPHB:战士:动作如潮:2#use' }).status).toBe('rejected');
    done(s.dispatch({ type: 'nextTurn' }));
    expect(s.dispatch({ type: 'useAction', actor: 'f', action: 'XPHB:战士:动作如潮:2#use' }).status).toBe('rejected');   // 不是自己的回合
    done(s.dispatch({ type: 'nextTurn' }));
    done(s.dispatch({ type: 'useAction', actor: 'f', action: 'XPHB:战士:动作如潮:2#use' }));   // 新的回合又能用一次
    expect(s.state.combatants.f.economy.action).toBe(2);
    expect(s.state.combatants.f.live.resourcesUsed.动作如潮).toBe(2);
  });
});

describe('游荡者', () => {
  it('灵巧动作：附赠动作疾走 / 躲藏', () => {
    const { s, dice } = setup([rogue(), goblin()]);
    done(s.dispatch({ type: 'startCombat', order: ['r', 'g'] }));
    done(s.dispatch({ type: 'useAction', actor: 'r', action: 'XPHB:游荡者:灵巧动作:2#dash' }));
    expect(s.state.combatants.r.economy.move).toBe(60);
    expect(s.state.combatants.r.economy.bonus).toBe(0);
    expect(s.dispatch({ type: 'useAction', actor: 'r', action: 'XPHB:游荡者:灵巧动作:2#hide' }).status).toBe('rejected');

    done(s.dispatch({ type: 'nextTurn' }));
    done(s.dispatch({ type: 'nextTurn' }));
    dice.push(9);   // 9 + 7 = 16 ≥ 15
    done(s.dispatch({ type: 'useAction', actor: 'r', action: 'XPHB:游荡者:灵巧动作:2#hide' }));
    expect(has(s, 'r', '隐形')).toBe(true);
  });

  it('稳定瞄准：速度归 0，本回合下一次攻击优势，用完即止', () => {
    const { s, dice } = setup([rogue(), goblin('g', { hpMax: 50 })]);
    done(s.dispatch({ type: 'startCombat', order: ['r', 'g'] }));
    done(s.dispatch({ type: 'useAction', actor: 'r', action: 'XPHB:游荡者:稳定瞄准:3#use' }));
    expect(s.view('r').speed).toBe(0);
    dice.push(3, 16, 5);
    done(s.dispatch({ type: 'useAction', actor: 'r', action: 'weapon:rp', targets: ['g'] }));
    expect(last(s, 'd20Rolled').adv).toBe(true);
    expect(last(s, 'd20Rolled').natural).toBe(16);
    dice.push(12, 5);
    done(s.dispatch({ type: 'useAction', actor: 'r', action: 'weapon:rp', targets: ['g'], force: true }));
    expect(last(s, 'd20Rolled').adv).toBe(false);
    expect(dice.left()).toBe(0);
  });
});

describe('野蛮人', () => {
  it('危机感应：敏捷豁免优势，失能时没有', () => {
    const { s, dice } = setup([{ id: 'b', kind: 'pc', view: { name: '野蛮人', attacks: [GREATAXE], sources: ['XPHB:野蛮人:危机感应:2'] } }]);
    dice.push(4, 15);
    done(s.dispatch({ type: 'roll', roller: 'b', kind: 'save', ability: 'dex', dc: 12 }));
    expect(last(s, 'd20Rolled').adv).toBe(true);
    done(s.dispatch({ type: 'applyEffect', to: 'b', template: 'XPHB:condition:失能' }));
    dice.push(4);
    done(s.dispatch({ type: 'roll', roller: 'b', kind: 'save', ability: 'dex', dc: 12 }));
    expect(last(s, 'd20Rolled').adv).toBe(false);
  });
});

/** 用一次圣疗：中途问「治疗还是解毒」就按 pick 选（不问也行），返回之后的结果 */
function layOnHands(s: ReturnType<typeof setup>['s'], pick: RegExp): DispatchResult {
  const r = s.dispatch({ type: 'useAction', actor: 'p', action: 'XPHB:圣武士:圣疗:1#use', targets: ['f'] });
  if (r.status !== 'pending' || r.decision.kind !== 'choose') return r;
  const o = r.decision.options.find((x) => pick.test(x.label));
  expect(o, `选项里应该有 ${pick}：${r.decision.options.map((x) => x.label).join(' / ')}`).toBeTruthy();
  return s.decide([o!.id]);
}

describe('圣武士', () => {
  it('圣疗：选点数治疗（不超过能量池和缺的生命值），或花 5 点移除中毒', () => {
    const { s } = setup([paladin(), { ...fighter(), hp: 10 }]);
    const d = pending(layOnHands(s, /生命|治疗/));
    expect(d.kind).toBe('number');
    expect([d.min, d.max]).toEqual([1, 20]);
    done(s.decide(8));
    expect(s.state.combatants.f.live.hp).toBe(18);
    expect(s.state.combatants.p.live.resourcesUsed.layOnHands).toBe(8);

    // 超出范围的回答按上限算
    pending(layOnHands(s, /生命|治疗/));
    done(s.decide(100));
    expect(s.state.combatants.f.live.hp).toBe(30);
    expect(s.state.combatants.p.live.resourcesUsed.layOnHands).toBe(20);

    // 中毒：花 5 点移除
    done(s.dispatch({ type: 'applyEffect', to: 'f', template: 'XPHB:condition:中毒' }));
    done(layOnHands(s, /中毒/));
    expect(has(s, 'f', '中毒')).toBe(false);
    expect(s.state.combatants.p.live.resourcesUsed.layOnHands).toBe(25);
    // 能量池空了
    expect(s.dispatch({ type: 'useAction', actor: 'p', action: 'XPHB:圣武士:圣疗:1#use', targets: ['f'] }).status).toBe('rejected');
  });

  it('圣疗：两个选项都能用时让人选', () => {
    const { s } = setup([paladin(), { ...fighter(), hp: 25 }]);
    done(s.dispatch({ type: 'applyEffect', to: 'f', template: 'XPHB:condition:中毒' }));
    const d = pending(s.dispatch({ type: 'useAction', actor: 'p', action: 'XPHB:圣武士:圣疗:1#use', targets: ['f'] }));
    expect(d.kind).toBe('choose');
    expect(d.options).toHaveLength(2);
    done(s.decide([d.options.find((o) => /中毒/.test(o.label))!.id]));
    expect(has(s, 'f', '中毒')).toBe(false);
    expect(s.state.combatants.f.live.hp).toBe(25);
  });

  it('至圣斩：命中后作为附赠动作施放，问用几环；光耀伤害随环阶增加，重击翻倍', () => {
    const { s, dice } = setup([paladin(), goblin('g', { hpMax: 60 })]);
    done(s.dispatch({ type: 'startCombat', order: ['p', 'g'] }));
    dice.push(15);
    const d = pending(s.dispatch({ type: 'useAction', actor: 'p', action: 'weapon:ls', targets: ['g'] }));
    expect(d.kind).toBe('optionalTrigger');
    expect(d.options[0].label).toContain('至圣斩');
    expect(d.options[0].detail).toMatch(/附赠动作/);
    const lv = pending(s.decide(['0']));
    expect(lv.kind).toBe('slotLevel');
    expect(lv.options.map((o) => o.id)).toEqual(['1', '2']);
    dice.push(4, 1, 2, 3);
    done(s.decide(['2']));
    const parts = last(s, 'damageRolled').parts;
    expect(parts.map((p: any) => [p.dice, p.type])).toEqual([['1d8 + 3', '挥砍'], ['3d8', '光耀']]);
    expect(last(s, 'damageApplied').total).toBe(7 + 6);
    const p = s.state.combatants.p;
    expect(p.live.slotsUsed[2]).toBe(1);
    expect(p.economy.bonus).toBe(0);
    expect(p.economy.slotSpellCast).toBe(true);
    expect(last(s, 'spellCast').spell).toBe('至圣斩');

    // 同一回合第二次命中：附赠动作用掉了，不再问
    dice.push(14, 5);
    done(s.dispatch({ type: 'useAction', actor: 'p', action: 'weapon:ls', targets: ['g'], force: true }));
  });

  it('至圣斩：对不死生物多 1d8；只剩一种环阶时不问；别人的回合（借机攻击）不能用', () => {
    const { s, dice } = setup([paladin({ slots: { 1: 1 } }), goblin('z', { hpMax: 60, type: '不死生物' })]);
    done(s.dispatch({ type: 'startCombat', order: ['p', 'z'] }));
    done(s.dispatch({ type: 'nextTurn' }));
    dice.push(15, 4);
    done(s.dispatch({ type: 'useAction', actor: 'p', action: 'weapon:ls', targets: ['z'], options: { as: 'reaction' } }));

    done(s.dispatch({ type: 'nextTurn' }));
    dice.push(15);
    pending(s.dispatch({ type: 'useAction', actor: 'p', action: 'weapon:ls', targets: ['z'] }));
    dice.push(4, 1, 1, 6);
    done(s.decide(['0']));
    expect(last(s, 'damageRolled').parts.map((x: any) => x.dice)).toEqual(['1d8 + 3', '2d8', '1d8']);
    expect(dice.left()).toBe(0);
  });

  it('至圣斩：本回合已经用法术位施过法就不会再问；圣武斩的免费一次照样可以', () => {
    const { s, dice } = setup([
      paladin({ resources: { layOnHands: 25, 'free-smite': 1 }, sources: ['XPHB:spell:至圣斩', 'XPHB:圣武士:圣武斩:2'] }),
      goblin('g', { hpMax: 60 }),
    ]);
    done(s.dispatch({ type: 'startCombat', order: ['p', 'g'] }));
    done(s.dispatch({ type: 'manualCast', actor: 'p', spell: '虔诚护盾', slotLevel: 1, activation: 'action' }));
    dice.push(15);
    const d = pending(s.dispatch({ type: 'useAction', actor: 'p', action: 'weapon:ls', targets: ['g'], force: true }));
    expect(d.options.map((o) => o.label)).toEqual(['圣武士：至圣斩（不消耗法术位）']);
    dice.push(4, 3, 3);
    done(s.decide(['0']));
    expect(last(s, 'damageApplied').total).toBe(7 + 6);
    expect(s.state.combatants.p.live.resourcesUsed['free-smite']).toBe(1);
    expect(s.state.combatants.p.live.slotsUsed[1]).toBe(1);   // 只有虔诚护盾那一个
  });

  it('神圣武器：花一次引导神力，近战武器攻击加魅力调整值', () => {
    const { s, dice } = setup([paladin(), goblin('g', { hpMax: 60 })]);
    done(s.dispatch({ type: 'startCombat', order: ['p', 'g'] }));
    done(s.dispatch({ type: 'useAction', actor: 'p', action: 'XPHB:圣武士:神圣武器:3#use' }));
    expect(s.state.combatants.p.live.resourcesUsed['channel-divinity']).toBe(1);
    dice.push(5, 4);
    done(s.dispatch({ type: 'useAction', actor: 'p', action: 'weapon:ls', targets: ['g'] }));
    expect(last(s, 'd20Rolled').total).toBe(5 + 5 + 3);
    expect(last(s, 'd20Rolled').mods.some((m: any) => /神圣武器/.test(m.label))).toBe(true);
  });
});

describe('武僧', () => {
  it('疾风连击 + 震慑拳：两下徒手打击；第一下命中后震慑，第二下因震慑有优势；震慑拳每回合一次', () => {
    const { s, dice } = setup([monk(), goblin('g', { hpMax: 100, ac: 13 })]);
    done(s.dispatch({ type: 'startCombat', order: ['m', 'g'] }));
    dice.push(15, 5);
    const d = pending(s.dispatch({ type: 'useAction', actor: 'm', action: 'XPHB:武僧:疾风连击:2#use', targets: ['g'] }));
    expect(d.options[0].label).toContain('震慑拳');
    dice.push(4, 3, 12, 2);   // 体质豁免 4 < 13；第二下优势 [3, 12]；伤害 2
    done(s.decide(['0']));
    expect(has(s, 'g', '震慑')).toBe(true);
    expect(evs(s, 'd20Rolled').filter((r) => r.kind === 'attack').map((r) => r.adv)).toEqual([false, true]);
    expect(s.state.combatants.g.live.hp).toBe(100 - (5 + 3) - (2 + 3));
    expect(s.state.combatants.m.live.resourcesUsed.功力).toBe(2);
    expect(s.state.combatants.m.economy.bonus).toBe(0);

    done(s.dispatch({ type: 'nextTurn' }));
    expect(has(s, 'g', '震慑')).toBe(true);   // 直到武僧的下一回合开始
    done(s.dispatch({ type: 'nextTurn' }));
    expect(has(s, 'g', '震慑')).toBe(false);
    expect(dice.left()).toBe(0);
  });

  it('震慑拳豁免成功：速度减半，下一次对它的攻击有优势（用掉就没了）', () => {
    const { s, dice } = setup([monk(), goblin('g', { hpMax: 100, ac: 13 }), fighter()]);
    done(s.dispatch({ type: 'startCombat', order: ['m', 'g', 'f'] }));
    dice.push(15, 5);
    pending(s.dispatch({ type: 'useAction', actor: 'm', action: 'XPHB:武僧:武艺:1#unarmed', targets: ['g'] }));
    dice.push(18);
    done(s.decide(['0']));
    expect(has(s, 'g', '震慑')).toBe(false);
    expect(s.view('g').speed).toBe(15);
    dice.push(2, 17, 4);
    done(s.dispatch({ type: 'useAction', actor: 'f', action: 'weapon:ls', targets: ['g'], force: true }));
    expect(last(s, 'd20Rolled').adv).toBe(true);
    dice.push(12, 4);
    done(s.dispatch({ type: 'useAction', actor: 'f', action: 'weapon:ls', targets: ['g'], force: true }));
    expect(last(s, 'd20Rolled').adv).toBe(false);   // 优势只给下一次
    expect(s.view('g').speed).toBe(15);              // 减速还在
    expect(dice.left()).toBe(0);
  });
});

describe('吟游诗人与专长', () => {
  it('诗人激励：给别人一颗骰子；对方检定失败时可以加上，用掉就没了；成功时不打扰', () => {
    const { s, dice } = setup([bard(), fighter()]);
    done(s.dispatch({ type: 'useAction', actor: 'd', action: 'XPHB:吟游诗人:吟游诗人激励:1#give', targets: ['f'] }));
    const onF = () => Object.values(s.state.effects).filter((e) => e.bearer === 'f').length;
    expect(onF()).toBe(1);
    expect(s.state.combatants.d.live.resourcesUsed.诗人激励).toBe(1);
    expect(s.dispatch({ type: 'useAction', actor: 'd', action: 'XPHB:吟游诗人:吟游诗人激励:1#give', targets: ['d'] }).status).toBe('rejected');

    dice.push(18);
    done(s.dispatch({ type: 'roll', roller: 'f', kind: 'save', ability: 'dex', dc: 15 }));
    dice.push(10);   // 10 + 2 = 12 < 15
    const d = pending(s.dispatch({ type: 'roll', roller: 'f', kind: 'save', ability: 'dex', dc: 15 }));
    expect(d.to).toBe('f');
    dice.push(4);
    done(s.decide(['0']));
    expect(last(s, 'd20Rolled').total).toBe(16);
    expect(last(s, 'd20Rolled').outcome).toBe('success');
    expect(onF()).toBe(0);
    dice.push(10);
    done(s.dispatch({ type: 'roll', roller: 'f', kind: 'save', ability: 'dex', dc: 15 }));   // 用掉了，不再问
    expect(dice.left()).toBe(0);
  });

  it('幸运：自己要失败时给自己优势；被攻击要命中时施加劣势', () => {
    const { s, dice } = setup([bard(), goblin()]);
    dice.push(5);
    pending(s.dispatch({ type: 'roll', roller: 'd', kind: 'check', ability: 'cha', dc: 15 }));
    dice.push(17);
    done(s.decide(['0']));
    expect(last(s, 'd20Rolled').natural).toBe(17);
    expect(last(s, 'd20Rolled').outcome).toBe('success');

    dice.push(14);   // 14 + 4 = 18 ≥ 12
    const d = pending(s.dispatch({ type: 'useAction', actor: 'g', action: 'weapon:sc', targets: ['d'] }));
    expect(d.to).toBe('d');
    expect(d.options[0].label).toContain('幸运');
    dice.push(3);
    done(s.decide(['0']));
    expect(last(s, 'd20Rolled').natural).toBe(3);
    expect(last(s, 'attackMissed')).toBeTruthy();
    expect(s.state.combatants.d.live.resourcesUsed['luck-points']).toBe(2);
  });

  it('先天术法：1 分钟内法术豁免 DC +1', () => {
    const { s } = setup([{
      id: 's', kind: 'pc',
      view: { name: '术士', spell: { dc: 14, atk: 6, mod: 3, ability: 'cha' }, resources: { 先天术法: 2 }, sources: ['XPHB:术士:先天术法:1'] },
    }]);
    done(s.dispatch({ type: 'useAction', actor: 's', action: 'XPHB:术士:先天术法:1#use' }));
    expect(s.view('s').spell?.dc).toBe(15);
    done(s.dispatch({ type: 'advanceTime', minutes: 1 }));
    expect(s.view('s').spell?.dc).toBe(14);
  });
});
