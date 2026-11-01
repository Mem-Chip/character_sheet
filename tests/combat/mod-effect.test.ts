// 指令框 /mod：挂一个手动结束的现场效应改 AC / 速度 / 生命值上限 / 攻击加值；去掉就恢复
import { describe, expect, it } from 'vitest';
import rulesJson from '../../data/rules-2024.json';
import { RuleBook, Session, createEncounter, makeCombatant, makeView, scriptedDice, type RuleFile } from '../../src/combat';
import { modTemplate } from '../../app/lib/commands';
import { done } from './helpers';

function scene() {
  const dice = scriptedDice();
  const s = new Session(createEncounter('mod'), { rules: new RuleBook([rulesJson as unknown as RuleFile]), diceFor: () => dice });
  done(s.dispatch({ type: 'addCombatant', combatant: makeCombatant({ id: 'a', kind: 'npc', view: makeView({ name: 'a', hpMax: 30, ac: 12, speed: 30 }) }) }));
  return { s, dice };
}
const mod = (s: Session, stat: Parameters<typeof modTemplate>[0], n: number) => {
  const tpl = modTemplate(stat, n);
  done(s.dispatch({ type: 'applyEffect', to: 'a', inline: tpl as never, name: tpl.name }));
};

describe('/mod 现场效应', () => {
  it('AC −2、速度 +10，移除后恢复', () => {
    const { s } = scene();
    mod(s, 'ac', -2);
    mod(s, 'speed', 10);
    expect(s.view('a').ac).toBe(10);
    expect(s.view('a').speed).toBe(40);
    const effs = Object.values(s.state.effects);
    expect(effs.map((e) => e.name)).toEqual(['调整：AC −2', '调整：速度 +10 尺']);
    for (const e of effs) done(s.dispatch({ type: 'removeEffect', id: e.id }));
    expect(s.view('a').ac).toBe(12);
    expect(s.view('a').speed).toBe(30);
  });

  it('生命值上限：加了不回血；降到当前生命值以下时，当前生命值跟着降', () => {
    const { s } = scene();
    mod(s, 'hpMax', 5);
    expect(s.view('a').hpMax).toBe(35);
    expect(s.state.combatants['a'].live.hp).toBe(30);
    mod(s, 'hpMax', -15);
    expect(s.view('a').hpMax).toBe(20);
    expect(s.state.combatants['a'].live.hp).toBe(20);
  });

  it('d20 +3 加进检定总值', () => {
    const { s, dice } = scene();
    mod(s, 'd20', 3);
    dice.push(10);
    done(s.dispatch({ type: 'roll', roller: 'a', kind: 'check', ability: 'str' }));
    const ev = s.transactions.at(-1)!.events.find((e) => e.type === 'd20Rolled')!;
    expect((ev.payload as { total: number }).total).toBe(13);
  });
});
