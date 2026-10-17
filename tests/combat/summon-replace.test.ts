// 召唤替换的语义：只替换「同一个来源」召唤出来的
// 同一道法术再施展一次 → 换掉旧的；不同来源的独立召唤（坐骑 + 魔宠）应该共存
import { describe, expect, it } from 'vitest';
import { RULE_FILES } from '../../src/bridge/rule-files';
import { RuleBook, Session, createEncounter, makeCombatant, makeView, scriptedDice, type DispatchResult } from '../../src/combat';
import { done, pending } from './helpers';

function scene() {
  const dice = scriptedDice();
  const s = new Session(createEncounter('s'), { rules: new RuleBook(RULE_FILES), diceFor: () => dice });
  done(s.dispatch({
    type: 'addCombatant',
    combatant: makeCombatant({
      id: 'p', kind: 'pc',
      view: makeView({
        name: '圣武士', level: 5, pb: 3, score: { str: 16, cha: 16 }, hpMax: 40,
        spell: { dc: 14, atk: 6, mod: 3, ability: 'cha' },
        slots: { 2: 3 },
        resources: { 'faithful-steed': 1 },
        sources: ['XPHB:spell:寻获坐骑', 'XPHB:圣武士:信实坐骑:5', 'AU:spell:战斗魔宠'],
      }),
    }),
  }));
  done(s.dispatch({ type: 'addCombatant', combatant: makeCombatant({ id: 'g', kind: 'monster', side: 'enemy', view: makeView({ name: '地精', ac: 15, hpMax: 30 }) }) }));
  dice.push(18, 5);
  done(s.dispatch({ type: 'startCombat' }));
  return { s, dice };
}

/** 施展一个会召唤的动作：顺手回答「几环法术位」和「选哪种形态」 */
function cast(s: Session, action: string, slotLevel?: number): void {
  let r: DispatchResult = s.dispatch({ type: 'useAction', actor: 'p', action, targets: [], ...(slotLevel ? { slotLevel } : {}) });
  while (r.status === 'pending') {
    const d = r.decision;
    r = s.decide(d.kind === 'slotLevel' ? String(slotLevel ?? 2) : [d.options?.[0]?.id ?? '']);
  }
  if (r.status !== 'done') throw new Error(`没结算完：${JSON.stringify(r).slice(0, 200)}`);
}
/** 一直转到又轮到自己（召唤物夹在中间，先推进至少一步） */
function nextRound(s: Session): void {
  for (let i = 0; i < 8; i++) {
    let r = s.dispatch({ type: 'nextTurn' });
    while (r.status === 'pending') r = s.decide([r.decision.options?.[0]?.id ?? '']);
    if (i > 0 && s.state.order[s.state.turnIndex] === 'p') return;
  }
  throw new Error('转不回自己的回合');
}
const summons = (s: Session) => Object.values(s.state.combatants).filter((c) => c.summoner === 'p');

describe('召唤替换：真数据', () => {
  it('同一道法术再施展一次 → 换掉旧的坐骑', () => {
    const { s } = scene();
    cast(s, 'XPHB:spell:寻获坐骑#cast', 2);
    expect(summons(s)).toHaveLength(1);
    nextRound(s);
    cast(s, 'XPHB:spell:寻获坐骑#cast', 2);
    expect(summons(s)).toHaveLength(1);
  });

  it('不同来源的独立召唤共存：坐骑 + 战斗魔宠都在', () => {
    const { s } = scene();
    cast(s, 'XPHB:spell:寻获坐骑#cast', 2);
    const steed = summons(s)[0].name;
    nextRound(s);
    cast(s, 'AU:spell:战斗魔宠#cast', 2);
    const names = summons(s).map((c) => c.name);
    expect(names, `召唤了战斗魔宠之后，${steed} 不该被删掉`).toContain(steed);
    expect(summons(s)).toHaveLength(2);
  });

  it('同一个「坐骑」组：信实坐骑换掉寻获坐骑的坐骑（都是同一道法术的效果）', () => {
    const { s } = scene();
    cast(s, 'XPHB:spell:寻获坐骑#cast', 2);
    nextRound(s);
    cast(s, 'XPHB:圣武士:信实坐骑:5#steed');
    expect(summons(s)).toHaveLength(1);
  });
});
