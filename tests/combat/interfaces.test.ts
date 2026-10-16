// 引擎新接口：反应里改正在结算的伤害（modify 节点）、对攻击者生效、反应打窗口的发起者（aim）、
// choose 把选项放进 vars、抗性类型读效应记下的值、反射闪避（evasion）、骰子取最大值（maxDice）
import { describe, expect, it } from 'vitest';
import { RuleBook, Session, createEncounter, makeCombatant, makeView, scriptedDice, type RuleFile } from '../../src/combat';
import { FILES, done, evs, goblin, last, pending, wizard, type Who } from './helpers';

const TEST: RuleFile = {
  entries: {
    // 反冲术式：受到伤害前用反应减伤（环阶 d6 + 施法属性），再对攻击者造成伤害
    'T:spell:反冲': {
      actions: [{
        id: 'cast', name: '反冲', activation: 'reaction', tags: ['spell', 'magical'],
        trigger: { on: 'damageIncoming', role: 'target', window: 'before' },
        cost: [{ slot: { min: 1 } }],
        root: [
          { kind: 'modify', modify: [{ op: 'reduceDamage', value: '(slot.level)d6 + self.spell.mod' }] },
          { kind: 'damage', dice: '1d6', type: '力场', to: 'attacker' },
        ],
      }],
    },
    // 炼狱叱喝式：受到伤害后反击伤害来源
    'T:spell:叱喝': {
      actions: [{
        id: 'cast', name: '叱喝', activation: 'reaction', tags: ['spell', 'magical'],
        trigger: { on: 'damageTaken', role: 'target', aim: 'actor' },
        cost: [{ slot: { min: 1 } }],
        root: [{ kind: 'damage', dice: '1d10', type: '火焰' }],
      }],
    },
    // 选一种伤害类型：记在效应里给抗性用；也能直接当伤害类型
    'T:spell:防护': {
      actions: [{
        id: 'cast', name: '防护', activation: 'action', tags: ['spell', 'magical'], targeting: { type: 'self' },
        root: [
          { kind: 'choose', prompt: '抵抗哪种伤害？', var: 'elem', options: [{ label: '火焰' }, { label: '寒冷' }] },
          { kind: 'applyEffect', to: 'self', inline: { name: '防护', statics: [{ kind: 'resist', values: ['effect.state.type'] }] }, state: { type: 'vars.elem' } },
        ],
      }],
    },
    'T:spell:元素弹': {
      actions: [{
        id: 'cast', name: '元素弹', activation: 'action', tags: ['spell', 'magical'], targeting: { type: 'creature', count: 1 },
        root: [
          { kind: 'choose', prompt: '什么伤害？', var: 'elem', options: [{ label: '火', value: '火焰' }, { label: '冰', value: '寒冷' }] },
          { kind: 'damage', dice: '10', type: 'vars.elem' },
        ],
      }],
    },
    // 豁免成功减半的范围伤害
    'T:spell:爆炸': {
      actions: [{
        id: 'cast', name: '爆炸', activation: 'action', tags: ['spell', 'magical'], targeting: { type: 'creature', count: 4 },
        root: [{
          kind: 'save', ability: 'dex', dc: '15',
          onFail: [{ kind: 'damage', id: 'b', dice: '8', type: '火焰' }],
          onSuccess: [{ kind: 'damage', ref: 'b', scale: 0.5 }],
        }],
      }],
    },
    'T:反射闪避': {
      triggers: [{
        id: 'evasion', label: '反射闪避', on: 'damageIncoming', role: 'target', window: 'before',
        when: "damage.save == 'dex'", modify: [{ op: 'evasion' }],
      }],
    },
    'T:极效治疗': { rollMods: [{ on: { kind: 'heal' }, who: 'bearer', op: 'maxDice', label: '极效治疗' }] },
    'T:超限': { rollMods: [{ on: { kind: 'damage', spell: true }, who: 'bearer', op: 'maxDice', label: '超限导能' }] },
    // 效应：承受者回合开始时做体质豁免，失败受 5 点伤害（窗口里没有目标 → 目标是承受者自己）
    'T:spell:灼烧': {
      actions: [{
        id: 'cast', name: '灼烧', activation: 'action', tags: ['spell'], targeting: { type: 'creature', count: 1 },
        root: [{ kind: 'applyEffect', template: '灼烧', duration: { rounds: 10 } }],
      }],
      effects: { 灼烧: { triggers: [{ id: 'burn', label: '灼烧', on: 'turnStarted', role: 'actor', do: [{ kind: 'save', ability: 'con', dc: '10', onFail: [{ kind: 'damage', dice: '5', type: '火焰' }] }] }] } },
    },
    'T:spell:治疗': {
      actions: [{ id: 'cast', name: '治疗', activation: 'action', tags: ['spell'], targeting: { type: 'creature', count: 1 }, root: [{ kind: 'heal', amount: '2d8' }] }],
    },
  },
} as unknown as RuleFile;

function setupT(cs: Who[]) {
  const dice = scriptedDice();
  const s = new Session(createEncounter('t'), { rules: new RuleBook([...FILES, TEST], []), diceFor: () => dice });
  for (const c of cs) done(s.dispatch({ type: 'addCombatant', combatant: makeCombatant({ id: c.id, kind: c.kind, side: c.side, hp: c.hp, view: makeView(c.view) }) }));
  return { s, dice };
}
const hp = (s: Session, id: string) => s.state.combatants[id].live.hp;

describe('反应动作里改正在结算的伤害', () => {
  it('反冲式：用 1 环位减伤 1d6 + 3，再对攻击者造成 1d6', () => {
    const { s, dice } = setupT([wizard({ sources: ['T:spell:反冲'], slots: { 1: 1 } }), goblin('g')]);
    dice.push(15, 4);   // 地精命中（AC 12），弯刀 1d6+2 = 6
    const d = pending(s.dispatch({ type: 'useAction', actor: 'g', action: 'weapon:sc', targets: ['w'] }));
    expect(d.options[0].label).toContain('反冲');
    dice.push(2, 3);    // 减伤 2 + 3 = 5；反击 3
    done(s.decide(['0']));
    expect(hp(s, 'w')).toBe(20 - 1);
    expect(hp(s, 'g')).toBe(7 - 3);
    expect(s.state.combatants.w.live.slotsUsed[1]).toBe(1);
  });

  it('叱喝式（aim: actor）：受伤之后打的是伤害来源，不是自己', () => {
    const { s, dice } = setupT([wizard({ sources: ['T:spell:叱喝'], slots: { 1: 1 } }), goblin('g', { hpMax: 20 })]);
    dice.push(15, 4);
    pending(s.dispatch({ type: 'useAction', actor: 'g', action: 'weapon:sc', targets: ['w'] }));
    dice.push(7);
    done(s.decide(['0']));
    expect(hp(s, 'w')).toBe(20 - 6);
    expect(hp(s, 'g')).toBe(20 - 7);
  });
});

describe('choose 的选择放进 vars', () => {
  it('选火焰 → 效应记下类型 → 之后火焰伤害减半', () => {
    const { s } = setupT([wizard({ sources: ['T:spell:防护', 'T:spell:元素弹'] }), goblin('g', { sources: ['T:spell:元素弹'] } as never)]);
    const d = pending(s.dispatch({ type: 'useAction', actor: 'w', action: 'T:spell:防护#cast', targets: ['w'] }));
    expect(d.options.map((o) => o.label)).toEqual(['火焰', '寒冷']);
    done(s.decide(['0']));
    expect(s.peek((tx) => tx.state.combatants.w) && s.state.effects[Object.keys(s.state.effects)[0]].state.type).toBe('火焰');
    pending(s.dispatch({ type: 'useAction', actor: 'g', action: 'T:spell:元素弹#cast', targets: ['w'] }));
    done(s.decide(['0']));   // 火
    expect(last(s, 'damageApplied').byType).toEqual({ 火焰: 5 });
    expect(hp(s, 'w')).toBe(15);
  });

  it('伤害类型直接用 vars：选「冰」= 寒冷（value）', () => {
    const { s } = setupT([wizard({ sources: ['T:spell:元素弹'] }), goblin('g', { hpMax: 30 })]);
    pending(s.dispatch({ type: 'useAction', actor: 'w', action: 'T:spell:元素弹#cast', targets: ['g'] }));
    done(s.decide(['1']));
    expect(last(s, 'damageRolled').byType).toEqual({ 寒冷: 10 });
  });
});

describe('反射闪避（evasion）', () => {
  it('有闪避：成功 0、失败一半；没有闪避的照常', () => {
    const { s, dice } = setupT([
      wizard({ sources: ['T:spell:爆炸'] }),
      goblin('a', { hpMax: 30, sources: ['T:反射闪避'] } as never), goblin('b', { hpMax: 30, sources: ['T:反射闪避'] } as never),
      goblin('c', { hpMax: 30 }), goblin('d', { hpMax: 30 }),
    ]);
    dice.push(20, 1, 20, 1);
    done(s.dispatch({ type: 'useAction', actor: 'w', action: 'T:spell:爆炸#cast', targets: ['a', 'b', 'c', 'd'] }));
    expect([hp(s, 'a'), hp(s, 'b'), hp(s, 'c'), hp(s, 'd')]).toEqual([30, 26, 26, 22]);
  });

  it('不是豁免带来的伤害不管', () => {
    const { s, dice } = setupT([wizard({ sources: ['T:反射闪避'] }), goblin('g')]);
    dice.push(15, 4);
    done(s.dispatch({ type: 'useAction', actor: 'g', action: 'weapon:sc', targets: ['w'] }));
    expect(hp(s, 'w')).toBe(14);
  });
});

describe('骰子取最大值（maxDice）', () => {
  it('极效治疗：2d8 治疗直接 16，不掷骰', () => {
    const { s, dice } = setupT([wizard({ sources: ['T:spell:治疗', 'T:极效治疗'] }), goblin('g', { hpMax: 30 }, 5)]);
    done(s.dispatch({ type: 'useAction', actor: 'w', action: 'T:spell:治疗#cast', targets: ['g'] }));
    expect(hp(s, 'g')).toBe(21);
    expect(dice.left()).toBe(0);
    expect(evs(s, 'd20Rolled')).toHaveLength(0);
  });

  it('超限导能：法术伤害取最大值；武器伤害照常掷', () => {
    const { s, dice } = setupT([wizard({ sources: ['T:spell:元素弹', 'T:超限'], attacks: [{ id: 'd', name: '匕首', bonus: 5, damage: '1d4', damageType: '穿刺', melee: true, ranged: false, finesse: true, ability: 'dex' }] }), goblin('g', { hpMax: 50 })]);
    pending(s.dispatch({ type: 'useAction', actor: 'w', action: 'T:spell:元素弹#cast', targets: ['g'] }));
    done(s.decide(['0']));
    expect(hp(s, 'g')).toBe(40);
    dice.push(18, 1);
    done(s.dispatch({ type: 'useAction', actor: 'w', action: 'weapon:d', targets: ['g'] }));
    expect(hp(s, 'g')).toBe(39);
  });
});

describe('回合开始 / 结束时的效应触发器', () => {
  it('窗口里没有目标：豁免和伤害落在承受者自己身上', () => {
    const { s, dice } = setupT([wizard({ sources: ['T:spell:灼烧'] }), goblin('g', { hpMax: 30 })]);
    done(s.dispatch({ type: 'startCombat', order: ['w', 'g'] }));
    done(s.dispatch({ type: 'useAction', actor: 'w', action: 'T:spell:灼烧#cast', targets: ['g'] }));
    dice.push(2);   // 地精的体质豁免失败
    done(s.dispatch({ type: 'nextTurn' }));
    expect(last(s, 'd20Rolled').roller).toBe('g');
    expect(hp(s, 'g')).toBe(25);
    expect(hp(s, 'w')).toBe(20);
  });
});

describe('瞬发法术', () => {
  it('先声明（不占动作，花 2 术法点），下一道动作法术用附赠动作施放，动作还留着', () => {
    const { s, dice } = setupT([
      wizard({ sources: ['XPHB:spell:火球术', 'XPHB:瞬发法术'], resources: { sorcery_points: 4 }, slots: { 3: 1 } }),
      goblin('g', { hpMax: 60 }),
    ]);
    done(s.dispatch({ type: 'startCombat', order: ['w', 'g'] }));
    done(s.dispatch({ type: 'useAction', actor: 'w', action: 'XPHB:瞬发法术#use', targets: [] }));
    expect(s.state.combatants.w.live.resourcesUsed.sorcery_points).toBe(2);
    dice.push(5, 1, 1, 1, 1, 1, 1, 1, 1);
    done(s.dispatch({ type: 'useAction', actor: 'w', action: 'XPHB:spell:火球术#cast', targets: ['g'], slotLevel: 3 }));
    const e = s.state.combatants.w.economy;
    expect([e.action, e.bonus]).toEqual([1, 0]);
    expect(Object.values(s.state.effects).some((x) => x.name === '瞬发法术')).toBe(false);
  });
});
