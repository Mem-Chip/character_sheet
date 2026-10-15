/**
 * 黄金场景（COMBAT-DESIGN §十二 第 5 条、§15.8）。
 * 骰面全部预先写好：多掷一颗或少掷一颗都会让测试失败 —— 那本身就是规则 bug。
 */
import { describe, expect, it } from 'vitest';
import { Session, createEncounter, gridFeet, gridSpatial, makeView, type Positions } from '../../src/combat';
import { barbarian, cleric, done, effectNames, evs, fighter, goblin, has, last, pending, rogue, setup, wizard } from './helpers';

describe('#1 倒地：5 尺内优势，5 尺外劣势', () => {
  it('近战攻击倒地目标 → 优势（按推测「近战在 5 尺内」走，并在回执里写明假设）', () => {
    const { s, dice } = setup([fighter(), goblin('g')]);
    done(s.dispatch({ type: 'applyEffect', to: 'g', template: 'XPHB:condition:倒地' }));
    dice.push(8, 15, 6);
    done(s.dispatch({ type: 'useAction', actor: 'f', action: 'weapon:ls', targets: ['g'] }));
    const r = last(s, 'd20Rolled');
    expect(r.adv).toBe(true);
    expect(r.d20).toEqual([8, 15]);
    expect(r.total).toBe(20);
    expect(r.mods.map((m: any) => m.label)).toContain('目标倒地（5 尺内）');
    expect(r.assumptions).toHaveLength(1);
    expect(r.assumptions[0]).toMatch(/5 尺以内.*是/);
    expect(last(s, 'damageApplied').total).toBe(9);
    expect(s.state.combatants.g.live.dead).toBe(true);
    expect(dice.left()).toBe(0);
  });

  it('远程攻击倒地目标 → 劣势', () => {
    const { s, dice } = setup([fighter(), goblin('g')]);
    done(s.dispatch({ type: 'applyEffect', to: 'g', template: 'XPHB:condition:倒地' }));
    dice.push(17, 3);
    done(s.dispatch({ type: 'useAction', actor: 'f', action: 'weapon:sb', targets: ['g'] }));
    const r = last(s, 'd20Rolled');
    expect(r.disadv).toBe(true);
    expect(r.total).toBe(7);
    expect(r.outcome).toBe('miss');
    expect(r.mods.map((m: any) => m.label)).toEqual(['目标倒地（5 尺外）']);
    expect(dice.left()).toBe(0);
  });
});

describe('#2 优势与劣势互相抵消', () => {
  it('攻击者中毒 + 目标倒地（5 尺内）→ 普通掷骰，回执列出两项', () => {
    const { s, dice } = setup([fighter(), goblin('g')]);
    done(s.dispatch({ type: 'applyEffect', to: 'f', template: 'XPHB:condition:中毒' }));
    done(s.dispatch({ type: 'applyEffect', to: 'g', template: 'XPHB:condition:倒地' }));
    dice.push(12, 4);
    done(s.dispatch({ type: 'useAction', actor: 'f', action: 'weapon:ls', targets: ['g'] }));
    const r = last(s, 'd20Rolled');
    expect(r.cancelled).toBe(true);
    expect(r.adv).toBe(false);
    expect(r.disadv).toBe(false);
    expect(r.d20).toHaveLength(1);
    expect(r.mods.map((m: any) => m.label).sort()).toEqual(['中毒', '目标倒地（5 尺内）'].sort());
  });
});

describe('#3 祝福 + 力竭', () => {
  it('祝福术施加到目标并链接专注；力竭 2 级：速度 -10、D20 -4；豁免 = d20 + 豁免 - 4 + 1d4', () => {
    const { s, dice } = setup([cleric('c'), fighter()]);
    done(s.dispatch({ type: 'useAction', actor: 'c', action: 'XPHB:spell:祝福术#cast', targets: ['f'], slotLevel: 1 }));
    const bless = Object.values(s.state.effects).find((e) => e.name === '祝福')!;
    const conc = Object.values(s.state.effects).find((e) => e.key === 'concentration')!;
    expect(bless.bearer).toBe('f');
    expect(bless.link?.concentration).toBe(conc.id);
    expect(conc.bearer).toBe('c');
    expect(s.state.combatants.c.live.slotsUsed[1]).toBe(1);

    done(s.dispatch({ type: 'applyEffect', to: 'f', template: 'XPHB:condition:力竭' }));
    done(s.dispatch({ type: 'applyEffect', to: 'f', template: 'XPHB:condition:力竭' }));
    expect(s.view('f').speed).toBe(20);

    dice.push(10, 3);
    done(s.dispatch({ type: 'roll', roller: 'f', kind: 'save', ability: 'con', dc: 10 }));
    const r = last(s, 'd20Rolled');
    expect(r.flat).toBe(-4);
    expect(r.extra).toEqual([{ label: expect.stringMatching(/祝福/), dice: '1d4', faces: [3], total: 3 }]);
    expect(r.total).toBe(10 + 2 - 4 + 3);
    expect(r.outcome).toBe('success');
  });
});

describe('#4 定身类人 → 麻痹 → 5 尺内命中自动重击 → 回合结束重骰摆脱', () => {
  it('完整流程', () => {
    const { s, dice } = setup([cleric('c'), goblin('g', { hpMax: 40 }), fighter()]);
    done(s.dispatch({ type: 'startCombat', order: ['c', 'g', 'f'] }));

    dice.push(5);
    done(s.dispatch({ type: 'useAction', actor: 'c', action: 'XPHB:spell:定身类人#cast', targets: ['g'], slotLevel: 2 }));
    expect(has(s, 'g', '麻痹')).toBe(true);
    expect(has(s, 'g', '失能')).toBe(true);   // 麻痹隐含失能

    dice.push(3, 11, 4, 5);
    done(s.dispatch({ type: 'useAction', actor: 'f', action: 'weapon:ls', targets: ['g'], options: { as: 'reaction' } }));   // 别人的回合：借机攻击
    expect(last(s, 'd20Rolled').adv).toBe(true);
    expect(evs(s, 'critUpgraded')).toHaveLength(1);
    expect(last(s, 'damageApplied').total).toBe(4 + 5 + 3);   // 2d8 + 3

    dice.push(20);
    done(s.dispatch({ type: 'roll', roller: 'g', kind: 'save', ability: 'str', dc: 5 }));
    expect(last(s, 'd20Rolled').outcome).toBe('fail');          // 力量豁免自动失败，天然 20 也没用

    done(s.dispatch({ type: 'nextTurn' }));                       // c → g
    dice.push(15);
    done(s.dispatch({ type: 'nextTurn' }));                       // g 回合结束：感知豁免 15 ≥ 13
    expect(has(s, 'g', '麻痹')).toBe(false);
    expect(evs(s, 'effectEnded').map((e) => e.reason)).toContain('豁免成功');
    // 施法者仍在专注（法术对这个目标结束，不等于专注结束）
    expect(Object.values(s.state.effects).some((e) => e.key === 'concentration' && e.bearer === 'c')).toBe(true);
    expect(dice.left()).toBe(0);
  });

  it('目标限制：只能对类人生物施放', () => {
    const { s } = setup([cleric('c'), goblin('g', { type: '野兽' })]);
    const r = s.dispatch({ type: 'useAction', actor: 'c', action: 'XPHB:spell:定身类人#cast', targets: ['g'], slotLevel: 2 });
    expect(r.status).toBe('rejected');
  });
});

describe('#5 专注检定失败 → 所有被链接的效应一起结束', () => {
  it('施法者自己也被祝福：专注豁免也加 1d4', () => {
    const { s, dice } = setup([cleric('c'), fighter(), rogue()]);
    done(s.dispatch({ type: 'useAction', actor: 'c', action: 'XPHB:spell:祝福术#cast', targets: ['f', 'r', 'c'], slotLevel: 1 }));
    expect(Object.values(s.state.effects).filter((e) => e.name === '祝福')).toHaveLength(3);

    dice.push(4, 2);
    done(s.dispatch({ type: 'damage', id: 'c', amount: 10, damageType: '火焰' }));
    const r = last(s, 'd20Rolled');
    expect(r.sub).toBe('concentration');
    expect(r.vs).toBe(10);
    expect(r.total).toBe(4 + 0 + 2);
    expect(Object.values(s.state.effects).filter((e) => e.name === '祝福')).toHaveLength(0);
    expect(Object.values(s.state.effects).some((e) => e.key === 'concentration')).toBe(false);
  });

  it('祝福术最多 3 个目标（1 环）', () => {
    const { s } = setup([cleric('c'), fighter(), rogue(), goblin('g'), goblin('h')]);
    const r = s.dispatch({ type: 'useAction', actor: 'c', action: 'XPHB:spell:祝福术#cast', targets: ['f', 'r', 'g', 'h'], slotLevel: 1 });
    expect(r.status).toBe('rejected');
  });
});

describe('#6 护盾术把命中变成未命中', () => {
  it('看到攻击总值后决定；AC +5 后重新判定为未命中；之后不会再问偷袭', () => {
    const { s, dice } = setup([rogue(), wizard()]);
    dice.push(9);
    const d = pending(s.dispatch({ type: 'useAction', actor: 'r', action: 'weapon:rp', targets: ['w'] }));
    expect(d.kind).toBe('optionalTrigger');
    expect(d.to).toBe('w');
    expect(d.options[0].label).toContain('护盾术');
    // 预览里已经有攻击结果（看到结果再决定）
    expect(s.pending!.preview.find((e) => e.type === 'd20Rolled')!.payload.total).toBe(16);

    done(s.decide(['0']));
    expect(evs(s, 'attackRechecked')).toHaveLength(1);
    expect(last(s, 'attackMissed').why).toMatch(/AC 变为 17/);
    expect(s.state.combatants.w.live.slotsUsed[1]).toBe(1);
    expect(effectNames(s, 'w')).toContain('护盾');
    expect(s.view('w').ac).toBe(17);
    expect(evs(s, 'damageApplied')).toHaveLength(0);
  });

  it('护盾术持续到施法者的下一回合开始', () => {
    const { s, dice } = setup([rogue(), wizard()]);
    done(s.dispatch({ type: 'startCombat', order: ['r', 'w'] }));
    dice.push(9);
    pending(s.dispatch({ type: 'useAction', actor: 'r', action: 'weapon:rp', targets: ['w'] }));
    done(s.decide(['0']));
    expect(s.state.combatants.w.economy.reaction).toBe(0);
    done(s.dispatch({ type: 'nextTurn' }));   // w 的回合开始
    expect(effectNames(s, 'w')).not.toContain('护盾');
    expect(s.state.combatants.w.economy.reaction).toBe(1);
  });
});

describe('#7 偷袭每回合一次；在别人的回合里可以再用（借机攻击）', () => {
  it('完整流程', () => {
    const { s, dice } = setup([rogue({ attacksPerAction: 2 }), goblin('g', { ac: 12, hpMax: 100 }), fighter()]);
    done(s.dispatch({ type: 'startCombat', order: ['r', 'g', 'f'] }));

    dice.push(15);
    const d1 = pending(s.dispatch({ type: 'useAction', actor: 'r', action: 'weapon:rp', targets: ['g'] }));
    expect(d1.options[0].label).toContain('偷袭');
    expect(d1.options[0].detail).toMatch(/前提：.*周围 5 尺内是否有 游荡者 的盟友/);
    dice.push(5, 1, 2, 3);
    done(s.decide(['0']));
    expect(last(s, 'damageApplied').total).toBe(5 + 4 + 6);

    dice.push(14, 3);
    done(s.dispatch({ type: 'useAction', actor: 'r', action: 'weapon:rp', targets: ['g'] }));   // 同一回合第二击：不问
    expect(last(s, 'damageApplied').total).toBe(3 + 4);

    done(s.dispatch({ type: 'nextTurn' }));   // 地精的回合
    dice.push(16);
    pending(s.dispatch({ type: 'useAction', actor: 'r', action: 'weapon:rp', targets: ['g'], options: { as: 'reaction' } }));
    dice.push(2, 6, 6, 6);
    done(s.decide(['0']));
    expect(last(s, 'damageApplied').total).toBe(2 + 4 + 18);
    expect(s.state.combatants.r.economy.reaction).toBe(0);
    expect(dice.left()).toBe(0);
  });
});

describe('#8 重击 + 偷袭：武器骰和偷袭骰都翻倍，调整值不翻', () => {
  it('天然 20', () => {
    const { s, dice } = setup([rogue(), goblin('g', { hpMax: 100 })]);
    dice.push(20);
    pending(s.dispatch({ type: 'useAction', actor: 'r', action: 'weapon:rp', targets: ['g'] }));
    dice.push(1, 2, 1, 1, 1, 1, 1, 1);
    done(s.decide(['0']));
    const parts = last(s, 'damageRolled').parts;
    expect(parts.map((p: any) => p.dice)).toEqual(['2d8 + 4', '6d6']);
    expect(last(s, 'damageApplied').total).toBe(3 + 4 + 6);
  });
});

describe('#9 伤害调整顺序：加减值 → 抗性 → 易伤', () => {
  it('15 火焰，减伤 3、火焰抗性、火焰易伤 → (15-3)/2*2 = 12', () => {
    const { s } = setup([goblin('x', { hpMax: 50, resist: ['火焰'], vuln: ['火焰'] })]);
    done(s.dispatch({
      type: 'applyEffect', to: 'x', name: '减伤',
      inline: { triggers: [{ id: 'r', label: '减伤 3', on: 'damageIncoming', role: 'target', window: 'before', modify: [{ op: 'reduceDamage', value: 3 }] }] },
    }));
    done(s.dispatch({ type: 'damage', id: 'x', amount: 15, damageType: '火焰' }));
    const a = last(s, 'damageApplied');
    expect(a.byType).toEqual({ 火焰: 12 });
    expect(a.notes.join('；')).toMatch(/抗性.*易伤/);
  });

  it('减伤可以带骰子（拦截 1d10 + 2）：掷一次', () => {
    const { s, dice } = setup([goblin('x', { hpMax: 50 })]);
    done(s.dispatch({
      type: 'applyEffect', to: 'x', name: '拦截',
      inline: { triggers: [{ id: 'r', label: '拦截', on: 'damageIncoming', role: 'target', window: 'before', modify: [{ op: 'reduceDamage', value: '1d10 + 2' }] }] },
    }));
    dice.push(5);
    done(s.dispatch({ type: 'damage', id: 'x', amount: 15, damageType: '挥砍' }));
    expect(last(s, 'damageApplied').total).toBe(15 - 7);
  });
});

describe('#10 0 生命值时受到重击 → 2 次死亡豁免失败', () => {
  it('昏迷 + 倒地：近战优势且自动重击', () => {
    const { s, dice } = setup([fighter(), goblin('g')]);
    done(s.dispatch({ type: 'damage', id: 'f', amount: 30, damageType: '钝击' }));
    expect(has(s, 'f', '昏迷')).toBe(true);
    expect(has(s, 'f', '倒地')).toBe(true);
    expect(s.state.combatants.f.live.dead).toBe(false);   // 溢出 0 < 上限，不是即死

    dice.push(5, 12, 1, 1);
    done(s.dispatch({ type: 'useAction', actor: 'g', action: 'weapon:sc', targets: ['f'] }));
    expect(last(s, 'd20Rolled').adv).toBe(true);
    expect(evs(s, 'critUpgraded')).toHaveLength(1);
    expect(s.state.combatants.f.live.deathSaves.f).toBe(2);
  });

  it('即死：溢出伤害 ≥ 生命值上限', () => {
    const { s } = setup([fighter()]);
    done(s.dispatch({ type: 'damage', id: 'f', amount: 60, damageType: '钝击' }));
    expect(s.state.combatants.f.live.dead).toBe(true);
  });
});

describe('#11 狂暴', () => {
  it('抗性、力量攻击加伤；攻击敌人会延长；一整回合既没攻击也没延长 → 回合结束时结束', () => {
    const { s, dice } = setup([barbarian(), goblin('g', { ac: 10, hpMax: 100 })]);
    done(s.dispatch({ type: 'startCombat', order: ['b', 'g'] }));
    done(s.dispatch({ type: 'useAction', actor: 'b', action: 'XPHB:野蛮人:狂暴:1#enter' }));
    expect(s.state.combatants.b.live.resourcesUsed['狂暴']).toBe(1);
    expect(s.state.combatants.b.economy.bonus).toBe(0);
    expect(s.view('b').resist).toEqual(expect.arrayContaining(['钝击', '穿刺', '挥砍']));

    dice.push(10, 6);
    done(s.dispatch({ type: 'useAction', actor: 'b', action: 'weapon:ga', targets: ['g'] }));
    expect(last(s, 'damageRolled').parts.map((p: any) => p.from)).toEqual(['巨斧', expect.stringMatching(/狂暴/)]);
    expect(last(s, 'damageApplied').total).toBe(6 + 3 + 2);
    expect(evs(s, 'effectExtended')).toHaveLength(1);

    done(s.dispatch({ type: 'damage', id: 'b', amount: 10, damageType: '挥砍' }));
    expect(last(s, 'damageApplied').total).toBe(5);

    done(s.dispatch({ type: 'nextTurn' }));   // b 回合结束：狂暴还在
    expect(effectNames(s, 'b')).toContain('狂暴');
    done(s.dispatch({ type: 'nextTurn' }));   // 第 2 轮 b 的回合
    expect(effectNames(s, 'b')).toContain('狂暴');
    done(s.dispatch({ type: 'nextTurn' }));   // b 什么都没做就结束回合
    expect(effectNames(s, 'b')).not.toContain('狂暴');
    expect(evs(s, 'effectEnded').find((e) => e.name === '狂暴')!.reason).toBe('持续时间到');
  });

  it('狂暴时不能施法、不能专注；陷入失能时狂暴结束', () => {
    const { s } = setup([barbarian({ sources: ['XPHB:野蛮人:狂暴:1', 'XPHB:spell:祝福术'], slots: { 1: 1 }, spell: { dc: 10, atk: 2, mod: 0, ability: 'wis' } }), fighter()]);
    done(s.dispatch({ type: 'useAction', actor: 'b', action: 'XPHB:野蛮人:狂暴:1#enter' }));
    const r = s.dispatch({ type: 'useAction', actor: 'b', action: 'XPHB:spell:祝福术#cast', targets: ['f'], slotLevel: 1 });
    expect(r.status === 'rejected' && r.reason).toMatch(/不能施法/);
    done(s.dispatch({ type: 'applyEffect', to: 'b', template: 'XPHB:condition:震慑' }));
    expect(effectNames(s, 'b')).not.toContain('狂暴');
  });
});

describe('#12 同一法术不叠加：取最近的；生效的那个结束后另一个接上', () => {
  it('两个牧师对同一人施放祝福术', () => {
    const { s, dice } = setup([cleric('c1'), cleric('c2'), fighter()]);
    done(s.dispatch({ type: 'useAction', actor: 'c1', action: 'XPHB:spell:祝福术#cast', targets: ['f'], slotLevel: 1 }));
    done(s.dispatch({ type: 'useAction', actor: 'c2', action: 'XPHB:spell:祝福术#cast', targets: ['f'], slotLevel: 1 }));
    const blesses = Object.values(s.state.effects).filter((e) => e.name === '祝福');
    expect(blesses).toHaveLength(2);
    expect(blesses.find((e) => e.source === 'c1')!.suppressed).toBe(true);
    expect(blesses.find((e) => e.source === 'c2')!.suppressed).toBe(false);

    dice.push(10, 2);
    done(s.dispatch({ type: 'roll', roller: 'f', kind: 'save', ability: 'con', dc: 1 }));
    expect(last(s, 'd20Rolled').extra).toHaveLength(1);

    done(s.dispatch({ type: 'endConcentration', id: 'c2' }));
    expect(evs(s, 'effectResumed')).toHaveLength(1);
    const left = Object.values(s.state.effects).filter((e) => e.name === '祝福');
    expect(left).toHaveLength(1);
    expect(left[0].source).toBe('c1');
    expect(left[0].suppressed).toBe(false);
  });
});

describe('#13 昏迷结束时倒地仍在', () => {
  it('治愈真言把 0 生命值的战士救起来', () => {
    const { s, dice } = setup([fighter(), cleric('c')]);
    done(s.dispatch({ type: 'damage', id: 'f', amount: 30, damageType: '钝击' }));
    dice.push(2, 3);
    done(s.dispatch({ type: 'useAction', actor: 'c', action: 'XPHB:spell:治愈真言#cast', targets: ['f'], slotLevel: 1 }));
    expect(s.state.combatants.f.live.hp).toBe(2 + 3 + 3);
    expect(has(s, 'f', '昏迷')).toBe(false);
    expect(has(s, 'f', '倒地')).toBe(true);
  });
});

describe('#14 撤销', () => {
  it('撤销施法：法术位、效应、专注全部恢复', () => {
    const { s } = setup([cleric('c'), fighter()]);
    done(s.dispatch({ type: 'useAction', actor: 'c', action: 'XPHB:spell:祝福术#cast', targets: ['f'], slotLevel: 1 }));
    expect(Object.keys(s.state.effects)).toHaveLength(2);
    s.undo();
    expect(Object.keys(s.state.effects)).toHaveLength(0);
    expect(s.state.combatants.c.live.slotsUsed[1] ?? 0).toBe(0);
  });
});

describe('#15 DM 事后裁定：火球术里改一个目标的豁免', () => {
  it('回退重放：骰面复用，伤害减半，另一个目标不受影响', () => {
    const { s, dice } = setup([wizard(), goblin('g1', { hpMax: 50 }), goblin('g2', { hpMax: 50 })]);
    dice.push(5, 3, 3, 3, 3, 3, 3, 3, 3, 6);
    done(s.dispatch({ type: 'useAction', actor: 'w', action: 'XPHB:spell:火球术#cast', targets: ['g1', 'g2'], slotLevel: 3 }));
    expect(s.state.combatants.g1.live.hp).toBe(26);
    expect(s.state.combatants.g2.live.hp).toBe(26);

    const txIndex = s.transactions.length - 1;
    done(s.override(txIndex, { roll: 0, outcome: 'success', reason: '躲到了掩体后' }));
    expect(s.state.combatants.g1.live.hp).toBe(50 - 12);
    expect(s.state.combatants.g2.live.hp).toBe(26);
    expect(evs(s, 'd20Rolled')[0].overridden).toBe('躲到了掩体后');
    expect(dice.left()).toBe(0);   // 没有掷新骰子
  });
});

describe('#16 存档与读档', () => {
  it('读档重跑出同样的状态；等待中的实体骰决定也接得上', () => {
    const { s, dice } = setup([fighter(), goblin('g', { hpMax: 30 })], { physical: ['f'] });
    dice.push(14, 4);
    done(s.dispatch({ type: 'useAction', actor: 'g', action: 'weapon:sc', targets: ['f'] }));
    const d = pending(s.dispatch({ type: 'useAction', actor: 'f', action: 'weapon:ls', targets: ['g'] }));
    expect(d.kind).toBe('physicalDice');

    const saved = JSON.parse(JSON.stringify(s.save()));
    const r = Session.restore(saved, s.ctx);
    expect(r.state).toEqual(s.state);
    expect(r.pending?.decision).toEqual(d);
    expect(dice.left()).toBe(0);   // 读档没有重掷

    pending(r.decide([[15]]));
    done(r.decide([[6]]));
    expect(r.state.combatants.g.live.hp).toBe(30 - (6 + 3));
    expect(r.state.combatants.f.live.hp).toBe(30 - (4 + 2));
  });
});

describe('#17 手动治疗', () => {
  it('和法术治疗一样把 0 生命值的角色救起来；临时生命值取高', () => {
    const { s } = setup([fighter()]);
    done(s.dispatch({ type: 'damage', id: 'f', amount: 30, damageType: '钝击' }));
    expect(has(s, 'f', '昏迷')).toBe(true);
    done(s.dispatch({ type: 'heal', id: 'f', amount: 5 }));
    expect(s.state.combatants.f.live.hp).toBe(5);
    expect(has(s, 'f', '昏迷')).toBe(false);
    done(s.dispatch({ type: 'tempHp', id: 'f', amount: 4 }));
    done(s.dispatch({ type: 'tempHp', id: 'f', amount: 2 }));
    expect(s.state.combatants.f.live.tempHp).toBe(4);
  });
});

describe('#18 没有动态数据的法术：手动施放', () => {
  it('照样付法术位和动作、开专注、一回合一个法术位；次数可以手动改', () => {
    const { s } = setup([wizard({ slots: { 1: 2, 2: 2 } }), goblin('g')]);
    done(s.dispatch({ type: 'startCombat', order: ['w', 'g'] }));
    done(s.dispatch({ type: 'manualCast', actor: 'w', spell: '朦胧步', slotLevel: 2, activation: 'bonus' }));
    const w = s.state.combatants.w;
    expect(w.live.slotsUsed[2]).toBe(1);
    expect(w.economy.bonus).toBe(0);
    expect(last(s, 'spellCast').spell).toBe('朦胧步');
    // 2024：同一回合不能再用法术位施法
    expect(s.dispatch({ type: 'manualCast', actor: 'w', spell: '魔法飞弹', slotLevel: 1, activation: 'action' }).status).toBe('rejected');

    done(s.dispatch({ type: 'nextTurn' }));
    done(s.dispatch({ type: 'nextTurn' }));
    done(s.dispatch({ type: 'manualCast', actor: 'w', spell: '虚弱射线', slotLevel: 2, activation: 'action', concentration: true, targets: ['g'] }));
    expect(effectNames(s, 'w')).toEqual(['虚弱射线']);

    done(s.dispatch({ type: 'setUsage', id: 'w', slot: 2, used: 0 }));
    expect(s.state.combatants.w.live.slotsUsed[2]).toBe(0);
  });
});

describe('地图：按棋子位置自动判断距离', () => {
  it('倒地目标在 10 尺外 → 近战劣势，不再按推测；之后挪棋子、重放，结果不变', () => {
    const pos = { current: { f: { x: 0, y: 0, s: 1 }, g: { x: 2, y: 1, s: 1 } } as Positions | null };
    const { s, dice, rules } = setup([fighter(), goblin('g')], { positions: pos });
    done(s.dispatch({ type: 'applyEffect', to: 'g', template: 'XPHB:condition:倒地' }));
    dice.push(15, 8, 6);
    done(s.dispatch({ type: 'useAction', actor: 'f', action: 'weapon:ls', targets: ['g'] }));
    const r = last(s, 'd20Rolled');
    expect(r.disadv).toBe(true);
    expect(r.assumptions).toHaveLength(0);
    // 棋子挪到贴身，再读档重放：用的是当时记下的位置
    pos.current = { f: { x: 0, y: 0, s: 1 }, g: { x: 1, y: 1, s: 1 } };
    const again = Session.restore(s.save(), { rules, diceFor: () => dice, positions: () => pos.current });
    expect(last(again, 'd20Rolled').disadv).toBe(true);
  });

  it('大型生物占 2×2：斜对角贴着也是 5 尺', () => {
    const sp = gridSpatial({ a: { x: 0, y: 0, s: 2 }, b: { x: 2, y: 2, s: 1 }, c: { x: 4, y: 0, s: 1 } }, createEncounter('x'));
    expect(sp.distance('a', 'b')).toBe(5);
    expect(sp.distance('a', 'c')).toBe(15);
    expect(sp.distance('a', 'zz')).toBeNull();
  });

  it('斜走 5-10-5：斜 3 格 = 20 尺，斜 2 横 1 = 20 尺', () => {
    expect(gridFeet(3, 3)).toBe(15);
    expect(gridFeet(3, 3, '5-10-5')).toBe(20);
    expect(gridFeet(-2, 3, '5-10-5')).toBe(20);
    expect(gridFeet(1, 1, '5-10-5')).toBe(5);
  });
});

describe('从人物卡刷新', () => {
  it('换掉数值、留着当前生命值；撤销能回到旧数值', () => {
    const { s } = setup([fighter()]);
    done(s.dispatch({ type: 'adjustHp', id: 'f', set: 20 }));
    const before = s.state.combatants.f.base;
    done(s.dispatch({ type: 'refreshCombatant', id: 'f', view: makeView({ ...before, name: '战士（升级）', hpMax: 60, ac: 19 }) }));
    const c = s.state.combatants.f;
    expect(c.base.ac).toBe(19);
    expect(c.name).toBe('战士（升级）');
    expect(c.live.hp).toBe(20);
    done(s.dispatch({ type: 'refreshCombatant', id: 'f', view: makeView({ ...before, hpMax: 10 }) }));
    expect(s.state.combatants.f.live.hp).toBe(10);
    s.undo(2);
    expect(s.state.combatants.f.base.ac).toBe(before.ac);
  });
});

describe('选目标：重复选同一个', () => {
  it('没写 repeat 的动作不能重复选同一个目标', () => {
    const { s } = setup([fighter(), goblin('g')]);
    const r = s.dispatch({ type: 'useAction', actor: 'f', action: 'weapon:ls', targets: ['g', 'g'] });
    expect(r.status).toBe('rejected');
  });
});
