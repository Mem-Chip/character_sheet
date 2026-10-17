// 引擎新接口：反应里改正在结算的伤害（modify 节点）、对攻击者生效、反应打窗口的发起者（aim）、
// choose 把选项放进 vars、抗性类型读效应记下的值、反射闪避（evasion）、骰子取最大值（maxDice）
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RuleBook, Session, createEncounter, makeCombatant, makeView, scriptedDice, type RuleFile } from '../../src/combat';
import { buildSpec, lintEntry } from '../../src/factory';
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
    // 庇护术式：被攻击命中前，攻击者做感知豁免，失败则改选目标或取消本次攻击
    'T:spell:庇护': {
      actions: [{
        id: 'cast', name: '庇护', activation: 'bonus', tags: ['spell', 'magical'], targeting: { type: 'creature', count: 1 },
        root: [{
          kind: 'applyEffect', to: 'target', duration: { minutes: 1 },
          inline: {
            name: '庇护',
            triggers: [{
              id: 'sanctuary', label: '庇护', on: 'attackHit', role: 'target', window: 'before',
              do: [{
                kind: 'save', ability: 'wis', dc: '15', to: 'attacker',
                onFail: [{ kind: 'modify', modify: [{ op: 'redirect', to: 'choose' }] }],
              }],
            }],
          },
        }],
      }],
    },
    // 骑乘战斗式：盟友（坐骑）被命中前可改为打自己
    'T:骑乘援护': {
      triggers: [{
        id: 'mount', label: '骑乘援护', on: 'attackHit', role: 'ally', window: 'before', optional: true,
        modify: [{ op: 'redirect', to: 'self' }],
      }],
    },
    // 幻影闪避式：被命中前直接让攻击落空
    'T:幻影闪避': {
      triggers: [{
        id: 'cancelHit', label: '幻影闪避', on: 'attackHit', role: 'target', window: 'before',
        modify: [{ op: 'cancel' }],
      }],
    },
    // 投射守御式：盟友受伤前，用自己的临时生命值替他吸收伤害
    'T:投射守御': {
      triggers: [{
        id: 'ward', label: '投射守御', on: 'damageIncoming', role: 'ally', window: 'before',
        when: 'self.tempHp > 0', cost: [{ economy: 'reaction' }],
        modify: [{ op: 'absorb', from: 'tempHp' }],
      }],
    },
    // 护卫灵光式：盟友受伤前，用自己的生命值替他承受
    'T:护卫灵光': {
      triggers: [{
        id: 'auraWard', label: '护卫灵光', on: 'damageIncoming', role: 'ally', window: 'before',
        cost: [{ economy: 'reaction' }],
        modify: [{ op: 'absorb', from: 'hp' }],
      }],
    },
    // 保护联结式：盟友受伤前，把整包伤害转给自己（按自己的抗性结算）
    'T:保护联结': {
      triggers: [{
        id: 'bond', label: '保护联结', on: 'damageIncoming', role: 'ally', window: 'before',
        modify: [{ op: 'redirect', to: 'self' }],
      }],
    },
    // 致命一击式：命中时伤害翻倍
    'T:致命一击': {
      triggers: [{
        id: 'deathStrike', label: '致命一击', on: 'attackHit', role: 'actor', window: 'before',
        modify: [{ op: 'doubleDamage' }],
      }],
    },
    // 法术反制式：在施法前迫使施法者做体质豁免，失败则打断施法（缺省退回法术位）
    // 注意：spellCast 窗口里 attacker 才是施法者，target 是被施法的那个（见 tests/combat/window-scope.test.ts）
    'T:spell:反制': {
      actions: [{
        id: 'cast', name: '反制', activation: 'reaction', tags: ['spell', 'magical'],
        trigger: { on: 'spellCast', role: 'any', window: 'before', aim: 'actor', when: 'attacker.side != self.side' },
        cost: [{ slot: { min: 3 } }],
        root: [{
          kind: 'save', ability: 'con', dc: 'self.spell.dc',
          onFail: [{ kind: 'modify', modify: [{ op: 'cancel' }] }],
        }],
      }],
    },
    // 旧版式反制：打断施法且吞掉法术位
    'T:spell:强行反制': {
      actions: [{
        id: 'cast', name: '强行反制', activation: 'reaction', tags: ['spell', 'magical'],
        trigger: { on: 'spellCast', role: 'any', window: 'before', aim: 'actor', when: 'attacker.side != self.side' },
        root: [{ kind: 'modify', modify: [{ op: 'cancel', refundSlot: false }] }],
      }],
    },
    // 现世传说式：攻击检定未命中时可直接改为命中
    'T:现世传说': {
      triggers: [{
        id: 'legend', label: '现世传说', on: 'd20Rolled', role: 'actor', window: 'before',
        when: "roll.kind == 'attack' && roll.failing", optional: true,
        modify: [{ op: 'succeed' }],
      }],
    },
    // 归复平衡 / 醉汉机运式：抹掉本次 d20 的优势 / 劣势
    'T:归复平衡': {
      triggers: [{
        id: 'balance', label: '归复平衡', on: 'd20Rolled', role: 'actor', window: 'before',
        when: 'roll.adv || roll.disadv', modify: [{ op: 'clearAdv', which: 'both' }],
      }],
    },
    'T:醉汉机运': {
      triggers: [{
        id: 'tipsy', label: '醉汉机运', on: 'd20Rolled', role: 'actor', window: 'before',
        when: 'roll.disadv', modify: [{ op: 'clearAdv', which: 'disadv' }],
      }],
    },
    // 飘忽不定 / 序列意识式：针对自己的攻击检定不会有优势
    'T:飘忽不定': {
      rollMods: [{ on: { kind: 'attack' }, who: 'against', op: 'noAdv', label: '飘忽不定' }],
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

describe('改攻击目标 / 让攻击落空（attackHit before 的 cancel 与 redirect）', () => {
  it('cancel：命中被直接改为未命中，不造成伤害', () => {
    const { s, dice } = setupT([wizard({ sources: ['T:幻影闪避'] }), goblin('g')]);
    dice.push(15);   // 地精命中（15+4=19 vs AC 12）
    done(s.dispatch({ type: 'useAction', actor: 'g', action: 'weapon:sc', targets: ['w'] }));
    expect(hp(s, 'w')).toBe(20);
    expect(evs(s, 'attackMissed')).toHaveLength(1);
    expect(evs(s, 'damageApplied')).toHaveLength(0);
  });

  it('redirect (to: self)：骑乘援护把攻击揽到自己身上，并按自己的 AC 重新判定', () => {
    const { s, dice } = setupT([
      { ...wizard({ name: '战马', ac: 11, sources: [] }), id: 'mount' },
      { ...wizard({ name: '骑士', ac: 18, sources: ['T:骑乘援护'] }), id: 'rider' },
      goblin('g'),
    ]);
    // 第一次：掷 10（总 14），打中战马（AC 11），骑士揽过来后对 AC 18 未命中
    dice.push(10);
    const d1 = pending(s.dispatch({ type: 'useAction', actor: 'g', action: 'weapon:sc', targets: ['mount'] }));
    expect(d1.options[0].label).toContain('骑乘援护');
    done(s.decide(['0']));
    expect(hp(s, 'mount')).toBe(20);
    expect(hp(s, 'rider')).toBe(20);
    expect(last(s, 'attackRechecked').target).toBe('rider');

    // 第二次：掷 16（总 20），骑士揽过来后对 AC 18 仍然命中，骑士自己受伤
    dice.push(16, 4);
    pending(s.dispatch({ type: 'useAction', actor: 'g', action: 'weapon:sc', targets: ['mount'] }));
    done(s.decide(['0']));
    expect(hp(s, 'mount')).toBe(20);
    expect(hp(s, 'rider')).toBe(14);
  });

  it('redirect (to: choose) + save.to: attacker：庇护术让攻击者豁免，失败可改选另一目标或取消攻击', () => {
    const { s, dice } = setupT([
      wizard({ name: '法师', sources: ['T:spell:庇护'] }),
      { ...wizard({ name: '同伴', ac: 14, sources: [] }), id: 'ally' },
      goblin('g'),
    ]);
    done(s.dispatch({ type: 'useAction', actor: 'w', action: 'T:spell:庇护#cast', targets: ['w'] }));

    // 地精打法师：命中骰 12（总 16），感知豁免掷 3（失败）→ 弹窗让选新目标或取消
    dice.push(12, 3);
    const d = pending(s.dispatch({ type: 'useAction', actor: 'g', action: 'weapon:sc', targets: ['w'] }));
    expect(d.options.map((o) => o.label)).toEqual(['同伴', '放弃攻击（落空）']);

    // 选转火打「同伴」（16 >= AC 14 命中），弯刀伤害 4+2=6 落在同伴身上
    dice.push(4);
    done(s.decide(['ally']));
    expect(evs(s, 'd20Rolled').at(-1).roller).toBe('g');   // 豁免的人是攻击者地精
    expect(hp(s, 'w')).toBe(20);
    expect(hp(s, 'ally')).toBe(14);

    // 再打一次，这次选放弃攻击 → 未命中
    dice.push(12, 3);
    pending(s.dispatch({ type: 'useAction', actor: 'g', action: 'weapon:sc', targets: ['w'] }));
    done(s.decide(['__miss__']));
    expect(hp(s, 'w')).toBe(20);
    expect(last(s, 'attackMissed').target).toBe('w');
  });
});

describe('替盟友承受伤害与伤害翻倍（absorb / redirect / doubleDamage）', () => {
  it('absorb (from: tempHp)：投射守御在原目标算完抗性后先扣反应者的临时生命值，溢出的再落回原目标', () => {
    const { s } = setupT([
      wizard({ name: '灵能武士', sources: ['T:投射守御'] }),
      { ...wizard({ name: '盟友', sources: ['T:spell:防护'] }), id: 'ally' },
      goblin('g', { sources: ['T:spell:元素弹'] } as never),
    ]);
    s.state.combatants.w.live.tempHp = 3;
    // 盟友开启火焰抗性
    pending(s.dispatch({ type: 'useAction', actor: 'ally', action: 'T:spell:防护#cast', targets: ['ally'] }));
    done(s.decide(['0']));
    // 地精对盟友打 10 点火焰伤害 → 盟友抗性减半成 5 → 灵能武士投射守御吸收 3 点 tempHp → 盟友实受 2 点
    pending(s.dispatch({ type: 'useAction', actor: 'g', action: 'T:spell:元素弹#cast', targets: ['ally'] }));
    done(s.decide(['0']));
    expect(s.state.combatants.w.live.tempHp).toBe(0);
    expect(hp(s, 'w')).toBe(20);
    expect(hp(s, 'ally')).toBe(18);
  });

  it('absorb (from: hp)：护卫灵光用自己的生命值替盟友承伤', () => {
    const { s, dice } = setupT([
      wizard({ name: '圣武士', sources: ['T:护卫灵光'] }),
      { ...wizard({ name: '盟友', sources: [] }), id: 'ally' },
      goblin('g'),
    ]);
    dice.push(15, 4);   // 弯刀 6 点伤害
    done(s.dispatch({ type: 'useAction', actor: 'g', action: 'weapon:sc', targets: ['ally'] }));
    expect(hp(s, 'ally')).toBe(20);
    expect(hp(s, 'w')).toBe(14);
  });

  it('redirect (to: self)：保护联结把整包伤害转给自己（按自己的抗性结算）', () => {
    const { s } = setupT([
      wizard({ name: '牧师', sources: ['T:保护联结', 'T:spell:防护'] }),
      { ...wizard({ name: '盟友', sources: [] }), id: 'ally' },
      goblin('g', { sources: ['T:spell:元素弹'] } as never),
    ]);
    // 牧师自己有火焰抗性，盟友没有
    pending(s.dispatch({ type: 'useAction', actor: 'w', action: 'T:spell:防护#cast', targets: ['w'] }));
    done(s.decide(['0']));
    // 地精打盟友 10 点火焰伤害 → 保护联结转给牧师 → 按牧师的火焰抗性减半受 5 点
    pending(s.dispatch({ type: 'useAction', actor: 'g', action: 'T:spell:元素弹#cast', targets: ['ally'] }));
    done(s.decide(['0']));
    expect(hp(s, 'ally')).toBe(20);
    expect(hp(s, 'w')).toBe(15);
  });

  it('doubleDamage：致命一击让命中伤害翻倍', () => {
    const { s, dice } = setupT([
      wizard({ sources: ['T:致命一击'], attacks: [{ id: 'd', name: '匕首', bonus: 5, damage: '1d4 + 3', damageType: '穿刺', melee: true, ranged: false, finesse: true, ability: 'dex' }] }),
      goblin('g', { hpMax: 30 }),
    ]);
    dice.push(15, 2);   // 命中，伤害 (2+3)*2 = 10
    done(s.dispatch({ type: 'useAction', actor: 'w', action: 'weapon:d', targets: ['g'] }));
    expect(hp(s, 'g')).toBe(20);
  });
});

describe('打断施法（spellCast before 的 cancel）', () => {
  it('2024 法术反制：敌方施法前迫使其体质豁免，失败则打断施法、退回法术位、动作照常消耗', () => {
    const { s, dice } = setupT([
      wizard({ name: '反制法师', sources: ['T:spell:反制'], slots: { 3: 1 } }),
      { ...wizard({ name: '邪法师', sources: ['XPHB:spell:火球术'], slots: { 3: 1 } }), id: 'evil', side: 'monsters' },
    ]);
    done(s.dispatch({ type: 'startCombat', order: ['evil', 'w'] }));
    const d = pending(s.dispatch({ type: 'useAction', actor: 'evil', action: 'XPHB:spell:火球术#cast', targets: ['w'], slotLevel: 3 }));
    expect(d.options[0].label).toContain('反制');
    dice.push(2);   // 邪法师体质豁免失败
    done(s.decide(['0']));
    // 火球术未结算：反制法师满血，邪法师动作已花但 3 环法术位退回
    expect(hp(s, 'w')).toBe(20);
    expect(s.state.combatants.evil.economy.action).toBe(0);
    expect(s.state.combatants.evil.live.slotsUsed[3] ?? 0).toBe(0);
    expect(s.state.combatants.w.live.slotsUsed[3]).toBe(1);
  });

  it('refundSlot: false 时被打断的法术不退回法术位', () => {
    const { s } = setupT([
      wizard({ name: '反制法师', sources: ['T:spell:强行反制'] }),
      { ...wizard({ name: '邪法师', sources: ['XPHB:spell:火球术'], slots: { 3: 1 } }), id: 'evil', side: 'monsters' },
    ]);
    pending(s.dispatch({ type: 'useAction', actor: 'evil', action: 'XPHB:spell:火球术#cast', targets: ['w'], slotLevel: 3 }));
    done(s.decide(['0']));
    expect(hp(s, 'w')).toBe(20);
    expect(s.state.combatants.evil.live.slotsUsed[3]).toBe(1);
  });
});

describe('攻击自动命中（succeed）与抹除优势 / 劣势（clearAdv / noAdv）', () => {
  const DAGGER = { id: 'd', name: '匕首', bonus: 5, damage: '1d4 + 2', damageType: '穿刺', melee: true, ranged: false, finesse: true, ability: 'dex' as const };

  it('succeed 对攻击检定也生效：自然 1 未命中时可改为命中（不会变重击）', () => {
    const { s, dice } = setupT([wizard({ sources: ['T:现世传说'], attacks: [DAGGER] }), goblin('g', { hpMax: 30 })]);
    dice.push(1);   // 自然 1，触发现世传说
    const d = pending(s.dispatch({ type: 'useAction', actor: 'w', action: 'weapon:d', targets: ['g'] }));
    expect(d.options[0].label).toContain('现世传说');
    dice.push(4);   // 1d4+2 = 6
    done(s.decide(['0']));
    expect(last(s, 'd20Rolled').outcome).toBe('hit');
    expect(last(s, 'd20Rolled').crit).toBe(false);
    expect(hp(s, 'g')).toBe(24);
  });

  it('clearAdv：醉汉机运消掉劣势，用第一颗骰子结算', () => {
    const { s, dice } = setupT([
      wizard({ sources: ['T:醉汉机运'], attacks: [DAGGER] }),
      goblin('g', { hpMax: 30 }),
    ]);
    done(s.dispatch({ type: 'applyEffect', to: 'w', template: 'XPHB:condition:倒地' }));
    // 倒地导致攻击有劣势：掷 15 和 2（劣势原本取 2 未命中），醉汉机运消掉劣势后取第一颗 15 命中
    dice.push(15, 2, 3);
    done(s.dispatch({ type: 'useAction', actor: 'w', action: 'weapon:d', targets: ['g'] }));
    expect(last(s, 'd20Rolled').disadv).toBe(false);
    expect(last(s, 'd20Rolled').natural).toBe(15);
    expect(hp(s, 'g')).toBe(25);
  });

  it('noAdv：目标有飘忽不定时，对他的攻击不会获得优势（只掷一颗 d20）', () => {
    const { s, dice } = setupT([
      wizard({ sources: ['T:飘忽不定'] }),
      goblin('g'),
    ]);
    done(s.dispatch({ type: 'applyEffect', to: 'w', template: 'XPHB:condition:倒地' }));
    // 法师倒地原本让地精近战攻击有优势，但飘忽不定禁止优势 → 只掷一颗 d20（8+4=12 命中），弯刀 3+2=5
    dice.push(8, 3);
    done(s.dispatch({ type: 'useAction', actor: 'g', action: 'weapon:sc', targets: ['w'] }));
    expect(last(s, 'd20Rolled').adv).toBe(false);
    expect(last(s, 'd20Rolled').d20).toEqual([8]);
    expect(hp(s, 'w')).toBe(15);
  });

  it('所有新接口写法都通过 lintEntry 校验，且说明书涵盖全部窗口事件', () => {
    for (const [k, entry] of Object.entries(TEST.entries)) {
      expect(lintEntry(k, entry, { files: FILES }), k).toEqual([]);
    }
    const spec = buildSpec({ typesSource: readFileSync('src/combat/types.ts', 'utf8') });
    expect(spec).toContain('redirect');
    expect(spec).toContain('absorb');
    expect(spec).toContain('spellCast | before');
  });
});


