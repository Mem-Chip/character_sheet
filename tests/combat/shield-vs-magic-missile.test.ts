// 护盾术：被魔法飞弹指定时也能反应施放（2024 规则），施放后力场飞弹对你无效
import { describe, expect, it } from 'vitest';
import { RuleBook, Session, createEncounter, makeCombatant, makeView, scriptedDice } from '../../src/combat';
import { RULE_FILES } from '../../src/bridge/rule-files';
import { done } from './helpers';

describe('护盾术 vs 魔法飞弹', () => {
  const scene = (withShield: boolean) => {
    const dice = scriptedDice();
    dice.push(...Array.from({ length: 40 }, () => 3));
    const s = new Session(createEncounter('shield-mm'), { rules: new RuleBook(RULE_FILES), diceFor: () => dice });
    const add = (id: string, side: string, view: Record<string, unknown>) => done(s.dispatch({
      type: 'addCombatant',
      combatant: makeCombatant({ id, kind: side === 'enemy' ? 'monster' : 'pc', side, view: makeView({ name: id, hpMax: 40, ac: 10, ...view }) }),
    }));
    add('c', 'enemy', { slots: { 1: 2 }, spell: { dc: 13, atk: 5, mod: 3, ability: 'cha' }, sources: ['XPHB:spell:魔法飞弹'] });
    add('t', 'party', {
      slots: { 1: 2 }, spell: { dc: 15, atk: 7, mod: 5, ability: 'int' },
      sources: withShield ? ['XPHB:spell:护盾术'] : [],
    });
    done(s.dispatch({ type: 'startCombat', order: ['c', 't'] }));
    return s;
  };

  /** 施放魔法飞弹；遇到待决定就按 wantReaction 决定要不要反应 */
  const castMM = (s: Session, wantReaction: boolean) => {
    let r = s.dispatch({ type: 'useAction', actor: 'c', action: 'XPHB:spell:魔法飞弹#cast', targets: ['t'] });
    let offered = false;
    for (let i = 0; i < 8 && r.status === 'pending'; i++) {
      const d = r.decision as unknown as { kind: string; options?: Array<{ id: string; label?: string }> };
      if (d.kind === 'optionalTrigger' && d.options?.some((o) => String(o.label).includes('护盾术'))) {
        offered = true;
        r = wantReaction ? s.decide([d.options.find((o) => String(o.label).includes('护盾术'))!.id]) : s.decide([]);
        continue;
      }
      r = d.options?.length ? s.decide([d.options[0].id]) : s.decide({});
    }
    done(r);
    return offered;
  };

  it('会给出「护盾术（对魔法飞弹）」的反应机会', () => {
    const s = scene(true);
    expect(castMM(s, true), '应该弹「用不用护盾术」').toBe(true);
  });

  it('用了护盾术：魔法飞弹的伤害被取消，AC 拿到 +5', () => {
    const s = scene(true);
    castMM(s, true);
    expect(s.state.combatants['t'].live.hp, '飞弹应该被护盾挡掉').toBe(40);
    expect(s.state.combatants['t'].economy.reaction, '花掉了反应').toBe(0);
    expect(s.state.combatants['t'].live.slotsUsed[1] ?? 0, '付掉一个 1 环').toBe(1);
    // 护盾效应挂在身上（AC +5 靠它）
    const effs = Object.values(s.state.effects ?? {}).filter((e) => (e as { source?: string }).source === 't');
    expect(JSON.stringify(effs)).toContain('护盾');
  });

  it('没选护盾术就照常吃伤害', () => {
    const s = scene(true);
    castMM(s, false);
    expect(s.state.combatants['t'].live.hp, '没用护盾，应该掉血').toBeLessThan(40);
  });

  it('没学护盾术：不会给反应机会', () => {
    const s = scene(false);
    expect(castMM(s, false)).toBe(false);
    expect(s.state.combatants['t'].live.hp).toBeLessThan(40);
  });

  it('关掉「时机到了问我」：不再弹护盾术，照常吃伤害；再打开又会问', () => {
    const s = scene(true);
    for (const k of ['XPHB:spell:护盾术#cast', 'XPHB:spell:护盾术#castMM']) done(s.dispatch({ type: 'setTriggerOff', id: 't', key: k, off: true }));
    expect(s.state.combatants['t'].triggerOff).toHaveLength(2);
    expect(castMM(s, true), '关掉了就不该问').toBe(false);
    expect(s.state.combatants['t'].live.hp).toBeLessThan(40);
    done(s.dispatch({ type: 'setTriggerOff', id: 't', key: 'XPHB:spell:护盾术#castMM', off: false }));
    done(s.dispatch({ type: 'nextTurn' }));
    done(s.dispatch({ type: 'nextTurn' }));
    expect(castMM(s, false), '打开以后又会问').toBe(true);
  });
});

