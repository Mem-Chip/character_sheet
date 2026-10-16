// 物品：魔法物品的加值进人物卡；消耗品进战斗、用掉写回
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { combatantFromSheet, syncLiveToChar } from '../../src/bridge/from-sheet';
import { RuleBook, Session, createEncounter, scriptedDice } from '../../src/combat';
import type { CharData, SheetEnv } from '../../src/sheet';
import { createNodeEnv } from '../../src/sheet/node-env';
import { hasLocalData } from '../../src/sheet/node-provider';
import { FILES, done } from '../combat/helpers';

const chars = JSON.parse(readFileSync(resolve(import.meta.dirname, '..', 'fixtures', 'chars.json'), 'utf8')) as Array<{ id: string; char: CharData }>;
const fighter = () => structuredClone(chars.find((c) => c.id === 'fighter5-plate')!.char);

describe.skipIf(!hasLocalData())('物品', () => {
  let env: SheetEnv;
  beforeAll(async () => { env = await createNodeEnv(); });

  it('防护斗篷：装备 + 同调才算（AC +1、豁免 +1）；长剑标 +1：命中和伤害各 +1', async () => {
    const base = await env.compute(fighter());
    const c = fighter();
    c.equipment.push({ name: '防护斗篷', qty: 1, equipped: true });
    const notAttuned = await env.compute(c);
    expect(notAttuned.ac).toBe(base.ac);
    c.equipment[c.equipment.length - 1].attuned = true;
    c.equipment.find((e: { name: string }) => e.name === '长剑').bonus = 1;
    const s = await env.compute(c);
    expect(s.ac).toBe(base.ac + 1);
    expect(s.saves.str.total).toBe(base.saves.str.total + 1);
    const ls = (s.attacks as Array<{ name: string; atk: number; dmgText: string }>).find((a) => a.name === '长剑')!;
    const ls0 = (base.attacks as Array<{ name: string; atk: number; dmgText: string }>).find((a) => a.name === '长剑')!;
    expect(ls.atk).toBe(ls0.atk + 1);
    expect(ls.dmgText).not.toBe(ls0.dmgText);
  });

  it('命名魔法武器接底材：「黑刃」= 巨剑 +3', async () => {
    const c = fighter();
    c.equipment.push({ name: '黑刃', qty: 1, equipped: true, attuned: true });
    const s = await env.compute(c);
    const row = (s.attacks as Array<{ name: string; dmg: string }>).find((a) => a.name === '黑刃');
    expect(row?.dmg).toBe('2d6');
  });

  it('治疗药水：战斗里是附赠动作，用掉扣数量；写回人物卡', async () => {
    const c = fighter();
    c.equipment.push({ name: '治疗药水', qty: 2, equipped: false });
    c.hp = { current: 10 };
    const sheet = await env.compute(c);
    const pc = combatantFromSheet(env, c, sheet, { id: 'f' });
    expect(pc.base.resources['物品:治疗药水']).toBe(2);
    const dice = scriptedDice();
    const s = new Session(createEncounter('t'), { rules: new RuleBook(FILES, []), diceFor: () => dice });
    done(s.dispatch({ type: 'addCombatant', combatant: pc }));
    dice.push(3, 4);
    done(s.dispatch({ type: 'useAction', actor: 'f', action: 'ITEM:治疗药水#use', targets: ['f'] }));
    expect(s.state.combatants.f.live.hp).toBe(10 + 9);
    syncLiveToChar(c, sheet, s.state.combatants.f);
    expect(c.equipment.find((e: { name: string }) => e.name === '治疗药水').qty).toBe(1);
    syncLiveToChar(c, sheet, s.state.combatants.f);   // 再写一次不会再扣
    expect(c.equipment.find((e: { name: string }) => e.name === '治疗药水').qty).toBe(1);
  });
});
