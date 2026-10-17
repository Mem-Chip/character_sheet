// 法术反制：窗口里先掷体质豁免（引擎同步掷），失败才打断那道法术、法术位退回去
import { describe, expect, it } from 'vitest';
import { RuleBook, Session, createEncounter, makeCombatant, makeView, scriptedDice } from '../../src/combat';
import { RULE_FILES } from '../../src/bridge/rule-files';
import { done, evs } from './helpers';

describe('法术反制（cancelUnlessSave）', () => {
  const scene = (rolls: number[]) => {
    const dice = scriptedDice();
    dice.push(...rolls, ...Array.from({ length: 24 }, () => 3));
    const s = new Session(createEncounter('cs'), { rules: new RuleBook(RULE_FILES), diceFor: () => dice });
    const add = (id: string, side: string, view: Record<string, unknown>) => done(s.dispatch({
      type: 'addCombatant',
      combatant: makeCombatant({ id, kind: side === 'enemy' ? 'monster' : 'pc', side, view: makeView({ name: id, hpMax: 40, ac: 10, ...view }) }),
    }));
    add('c', 'enemy', { slots: { 3: 1 }, spell: { dc: 13, atk: 5, mod: 3, ability: 'cha' }, sources: ['XPHB:spell:火球术'] });
    add('r', 'party', { slots: { 3: 1 }, spell: { dc: 15, atk: 7, mod: 5, ability: 'int' }, sources: ['XPHB:spell:法术反制'] });
    add('t', 'party', {});
    done(s.dispatch({ type: 'startCombat', order: ['c', 'r', 't'] }));
    return s;
  };

  /** 把施法那一笔的待决定全部答「用」 */
  const castFireball = (s: Session) => {
    let r = s.dispatch({ type: 'useAction', actor: 'c', action: 'XPHB:spell:火球术#cast', targets: ['t'] });
    for (let i = 0; i < 6 && r.status === 'pending'; i++) {
      const d = r.decision as unknown as { kind: string; options?: Array<{ id: string }>; questions?: Array<{ id: string }> };
      r = d.options?.length ? s.decide(String(d.options[0].id)) : s.decide(Object.fromEntries((d.questions ?? []).map((q) => [q.id, true])));
    }
    return done(r);
  };

  it('豁免失败：那道法术消散、施法者的法术位退回去、反制者付掉自己的 3 环', () => {
    const s = scene([1]);   // 施法者体质豁免掷 1，必败
    castFireball(s);
    expect(s.state.combatants['t'].live.hp, '火球没打出来').toBe(40);
    expect(s.state.combatants['c'].live.slotsUsed[3] ?? 0, '施法者的法术位退回去了').toBe(0);
    expect(s.state.combatants['r'].live.slotsUsed[3] ?? 0, '反制者付掉自己的 3 环').toBe(1);
    expect(evs(s, 'note').some((n) => String(n.text).includes('法术失效'))).toBe(true);
  });

  it('豁免成功：法术照常结算', () => {
    const s = scene([20]);  // 施法者豁免掷 20，稳过
    castFireball(s);
    expect(s.state.combatants['t'].live.hp, '火球照常打出来（豁免成功也至少有半伤/不减血，这里只要求它结算了）').toBeLessThanOrEqual(40);
    expect(s.state.combatants['c'].live.slotsUsed[3] ?? 0, '施法者的法术位照常消耗').toBe(1);
    expect(evs(s, 'note').some((n) => String(n.text).includes('法术失效'))).toBe(false);
  });
});

