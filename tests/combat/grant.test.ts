// 临时动作：grantAction 授予一个动作（可以复制别的条目 + 改写代价），同键盖住规则书，直到回合结束/手动收回
import { describe, expect, it } from 'vitest';
import { RuleBook, Session, createEncounter, makeCombatant, makeView, scriptedDice, type RuleFile } from '../../src/combat';
import { RULE_FILES } from '../../src/bridge/rule-files';
import { FILES, done, evs } from './helpers';

/** 一道 3 环、要法术位的法术 + 一个「免位施放」特性 + 一个「覆盖」特性 */
const TEST = {
  note: 'T',
  entries: {
    'T:spell:火球': {
      name: '火球术',
      actions: [{
        id: 'cast', name: '火球术', activation: 'action', tags: ['spell', 'magical'],
        cost: [{ slot: { min: 3 } }],
        targeting: { type: 'creature', count: 1, range: 150 },
        root: [{ kind: 'damage', dice: '3d6', type: '火焰', to: 'target' }],
      }],
    },
    // 免法术位施放：复制火球术的施法动作，代价清空
    'T:免位': {
      name: '免位施放',
      actions: [{
        id: 'use', name: '免位施放', activation: 'free',
        root: [{ kind: 'grantAction', key: 'grant:fireball', from: 'T:spell:火球#cast', cost: [], until: 'turnEnd' }],
      }],
    },
    // 覆盖：同键授予一个「只有 1 点伤害」的版本
    'T:篡改': {
      name: '篡改',
      actions: [{
        id: 'use', name: '篡改', activation: 'free',
        root: [{
          kind: 'grantAction',
          key: 'T:spell:火球',
          action: {
            id: 'cast', name: '火球术（被篡改）', activation: 'action',
            targeting: { type: 'creature', count: 1, range: 150 },
            root: [{ kind: 'damage', dice: '1', type: '冷冻', to: 'target' }],
          },
        }],
      }],
    },
    // 收回
    'T:收回': {
      name: '收回',
      actions: [{ id: 'use', name: '收回', activation: 'free', root: [{ kind: 'removeGrant', key: 'grant:fireball' }] }],
    },
  },
} as unknown as RuleFile;

function scene() {
  const dice = scriptedDice(); dice.push(...Array.from({ length: 24 }, () => 3));
  const s = new Session(createEncounter('g'), { rules: new RuleBook([...FILES, TEST] as RuleFile[]), diceFor: () => dice });
  const add = (id: string, view: Record<string, unknown>) => done(s.dispatch({
    type: 'addCombatant',
    combatant: makeCombatant({ id, kind: 'pc', view: makeView({ name: id, hpMax: 40, ac: 10, slots: { 3: 1 }, ...view }) }),
  }));
  add('w', { sources: ['T:spell:火球', 'T:免位', 'T:篡改', 'T:收回'] });
  add('g', {});
  done(s.dispatch({ type: 'startCombat', order: ['w', 'g'] }));
  const slotsLeft = () => Number(s.state.combatants['w'].live.slotsUsed[3] ?? 0);
  return { s, slotsLeft };
}

describe('临时动作（grantAction）', () => {
  it('复制法术动作 + 清空代价 = 免法术位施放，法术位不动', () => {
    const { s, slotsLeft } = scene();
    done(s.dispatch({ type: 'useAction', actor: 'w', action: 'T:免位#use' }));
    // 授予的动作在动作栏里（sources 里有了），而且用它是免费的
    expect(s.view('w').sources).toContain('grant:fireball');
    expect(slotsLeft()).toBe(0);
    done(s.dispatch({ type: 'useAction', actor: 'w', action: 'grant:fireball#cast', targets: ['g'] }));
    expect(slotsLeft(), '免位施放不该扣法术位').toBe(0);
    expect(evs(s, 'damageApplied').length, '伤害照常结算').toBeGreaterThan(0);
    expect(s.state.combatants['g'].live.hp).toBeLessThan(40);
  });

  it('同键授予 = 覆盖：用的是授予的那个版本', () => {
    const { s } = scene();
    done(s.dispatch({ type: 'useAction', actor: 'w', action: 'T:篡改#use' }));
    done(s.dispatch({ type: 'useAction', actor: 'w', action: 'T:spell:火球#cast', targets: ['g'] }));
    // 篡改版只有 1 点冷冻伤害
    expect(40 - s.state.combatants['g'].live.hp).toBe(1);
    expect(Object.keys(evs(s, 'damageApplied').at(-1)?.byType ?? {})).toEqual(['冷冻']);
  });

  it('until: turnEnd —— 回合结束就收回', () => {
    const { s } = scene();
    done(s.dispatch({ type: 'useAction', actor: 'w', action: 'T:免位#use' }));
    expect(s.view('w').sources).toContain('grant:fireball');
    done(s.dispatch({ type: 'nextTurn' }));   // w 的回合结束
    expect(s.view('w').sources, '回合结束该收回').not.toContain('grant:fireball');
    const r = s.dispatch({ type: 'useAction', actor: 'w', action: 'grant:fireball#cast', targets: ['g'] });
    expect(r.status).toBe('rejected');
  });

  it('removeGrant 立刻收回', () => {
    const { s } = scene();
    done(s.dispatch({ type: 'useAction', actor: 'w', action: 'T:免位#use' }));
    done(s.dispatch({ type: 'useAction', actor: 'w', action: 'T:收回#use' }));
    expect(s.view('w').sources).not.toContain('grant:fireball');
  });
});

describe('真实数据：免法术位施放（用 grantAction 复制法术动作）', () => {
  const scene2 = (sources: string[], extra: Record<string, unknown> = {}) => {
    const dice = scriptedDice(); dice.push(...Array.from({ length: 30 }, () => 3));
    const s = new Session(createEncounter('r'), { rules: new RuleBook(RULE_FILES), diceFor: () => dice });
    done(s.dispatch({ type: 'addCombatant', combatant: makeCombatant({ id: 'w', kind: 'pc', view: makeView({ name: 'w', hpMax: 20, ac: 10, slots: {}, sources, ...extra }) }) }));
    done(s.dispatch({ type: 'addCombatant', combatant: makeCombatant({ id: 'g', kind: 'npc', view: makeView({ name: 'g', hpMax: 20, ac: 10 }) }) }));
    done(s.dispatch({ type: 'startCombat', order: ['w', 'g'] }));
    return s;
  };

  it('幽影护甲：一个法术位都没有也能放法师护甲，AC 加上去、法术位不动', () => {
    const s = scene2(['XPHB:幽影护甲'], { spell: { dc: 13, atk: 5, mod: 3, ability: 'int' } });
    const ac0 = s.view('w').ac;
    done(s.dispatch({ type: 'useAction', actor: 'w', action: 'XPHB:幽影护甲#cast' }));
    expect(s.view('w').sources).toContain('grant:XPHB:幽影护甲');
    done(s.dispatch({ type: 'useAction', actor: 'w', action: 'grant:XPHB:幽影护甲#cast' }));
    expect(s.view('w').ac).toBeGreaterThan(ac0);
    expect(s.state.combatants['w'].live.slotsUsed, '免位施放不该扣法术位').toEqual({});
  });

  it('威仪作锦：命令术走附赠动作、不吃动作', () => {
    const s = scene2(['XPHB:吟游诗人:威仪作锦:6'], { resources: { majesty: 1 }, spell: { dc: 13, atk: 5, mod: 3, ability: 'cha' } });
    const eco = () => s.state.combatants['w'].economy;
    done(s.dispatch({ type: 'useAction', actor: 'w', action: 'XPHB:吟游诗人:威仪作锦:6#cast' }));
    expect(eco().action, '包装动作用了附赠动作，动作还在').toBe(1);
    expect(eco().bonus).toBe(0);
    // 授予的那个命令术本身不花动作经济（命令术会先问选哪条指令，答第一条）
    const r = s.dispatch({ type: 'useAction', actor: 'w', action: 'grant:XPHB:吟游诗人:威仪作锦:6#cast', targets: ['g'] });
    if (r.status === 'pending') {
      const d = r.decision as unknown as { options?: Array<{ id: string }> };
      done(s.decide(String(d.options?.[0]?.id ?? '')));
    } else done(r);
    expect(eco().action).toBe(1);
  });
});






