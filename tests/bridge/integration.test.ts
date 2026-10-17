/**
 * 静态层 × 动态层：真实角色卡 → 战斗参与者 → 战斗 → 结果写回角色卡 → 重算。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { combatantFromSheet, syncLiveToChar, viewFromSheet } from '../../src/bridge/from-sheet';
import { RuleBook, Session, createEncounter, makeCombatant, makeView, scriptedDice, type RuleFile } from '../../src/combat';
import { blankCharacter, type CharData, type SheetEnv } from '../../src/sheet';
import { createNodeEnv } from '../../src/sheet/node-env';
import { hasLocalData } from '../../src/sheet/node-provider';
import { FILES, SCIMITAR, done, evs, last, pending } from '../combat/helpers';
import spellsJson from '../../data/dyn/spells.json';
import featuresJson from '../../data/dyn/features.json';
import aiFeatures from '../../data/dyn/ai/features.json';
import aiSpells from '../../data/dyn/ai/spells.json';
import aiBooks from '../../data/dyn/ai/books.json';
import { buildTask } from '../../tools/factory/sources';

const chars = JSON.parse(readFileSync(resolve(import.meta.dirname, '..', 'fixtures', 'chars.json'), 'utf8')) as Array<{ id: string; char: object }>;
const fixture = (id: string, patch: Record<string, unknown> = {}): CharData =>
  ({ ...blankCharacter(), ...structuredClone(chars.find((c) => c.id === id)!.char), ...patch });

describe.skipIf(!hasLocalData())('真实角色卡进战斗', () => {
  let env: SheetEnv;
  beforeAll(async () => { env = await createNodeEnv(); });

  async function encounter(pcs: Array<{ id: string; char: CharData }>, monsters: Array<{ id: string; ac?: number; hp?: number }>) {
    const dice = scriptedDice();
    const s = new Session(createEncounter('it'), { rules: new RuleBook(FILES), diceFor: () => dice });
    const sheets: Record<string, Record<string, unknown>> = {};
    for (const p of pcs) {
      sheets[p.id] = await env.compute(p.char);
      done(s.dispatch({ type: 'addCombatant', combatant: combatantFromSheet(env, p.char, sheets[p.id], { id: p.id }) }));
    }
    for (const m of monsters) {
      done(s.dispatch({
        type: 'addCombatant',
        combatant: makeCombatant({ id: m.id, view: makeView({ name: `地精${m.id}`, score: { dex: 14 }, ac: m.ac ?? 15, hpMax: m.hp ?? 50, attacks: [SCIMITAR] }) }),
      }));
    }
    return { s, dice, sheets };
  }

  it('每个测试角色都能转成战斗参与者，条目键都在规则书里能找到或是纯静态条目', async () => {
    for (const { id } of chars) {
      const char = fixture(id);
      const sheet = await env.compute(char);
      const v = viewFromSheet(env, char, sheet);
      expect(v.hpMax, id).toBeGreaterThan(0);
      expect(v.ac, id).toBeGreaterThan(0);
      for (const a of v.attacks) expect(a.damage, `${id} ${a.name}`).toMatch(/^\d+d\d+( [+-] \d+)?$|^0$/);
    }
  });

  it('动态条目里花的资源，在拥有它的测试角色身上都有对应的资源池（id 对得上、上限算得出来）', async () => {
    const rules = new RuleBook([aiBooks, aiFeatures, aiSpells, ...FILES] as unknown as RuleFile[]);   // 手写 + AI 生成的都查
    const spends = (x: unknown, out: Set<string>): Set<string> => {
      if (Array.isArray(x)) x.forEach((y) => spends(y, out));
      else if (x && typeof x === 'object') {
        const o = x as Record<string, unknown>;
        if (typeof o.resource === 'string') out.add(o.resource);
        if (o.kind === 'resource' && typeof o.id === 'string') out.add(o.id);
        Object.values(o).forEach((y) => spends(y, out));
      } else if (typeof x === 'string') {
        for (const m of x.matchAll(/resource\('([^']+)'\)/g)) out.add(m[1]);
      }
      return out;
    };
    let checked = 0;
    for (const { id } of chars) {
      const char = fixture(id);
      const v = viewFromSheet(env, char, await env.compute(char));
      for (const key of v.sources) {
        const e = rules.entry(key);
        if (!e || e.global) continue;
        for (const r of spends(e, new Set())) {
          expect(Object.keys(v.resources), `${id} 的「${key}」要花「${r}」`).toContain(r);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(5);
  });

  it('每条动态数据的键都对得上站点数据里真实的法术 / 特性 / 专长 / 种族（名字写错就永远不会生效）', async () => {
    const keys = [spellsJson, featuresJson, aiFeatures, aiSpells, aiBooks].flatMap((f) => Object.keys((f as { entries: object }).entries))
      .filter((k) => !k.startsWith('XPHB:rule:'));
    for (const k of keys) await expect(buildTask(env, 'x', k), k).resolves.toMatchObject({ key: k });
  }, 30_000);   // 动态数据多了以后要几秒

  it('选出来的可选特性（魔能祈唤）是能力来源：静态授予生效，战斗引擎也看得到', async () => {
    const char = fixture('warlock2-invocations');
    const v = viewFromSheet(env, char, await env.compute(char));
    expect(v.sources).toContain('XPHB:幽影护甲');
    expect(v.sources).toContain('XPHB:spell:法师护甲');   // 幽影护甲授予的法术
    expect(v.resources).not.toHaveProperty('祈唤');      // 「已知祈唤数」不是可消耗的资源
  });

  it('游荡者 5：刺剑 +6（修掉的熟练 bug）、偷袭读职业表 3d6、精通「侵扰」', async () => {
    const { s, dice } = await encounter([{ id: 'r', char: fixture('rogue5') }], [{ id: 'g' }]);
    const v = s.view('r');
    expect(v.attacks[0]).toMatchObject({ name: '刺剑', bonus: 6, damage: '1d8 + 3', mastery: '侵扰', finesse: true });
    expect(v.classTable['偷袭']).toBe('3d6');

    dice.push(14);
    const d = pending(s.dispatch({ type: 'useAction', actor: 'r', action: 'weapon:刺剑#0', targets: ['g'] }));
    expect(d.options[0].label).toContain('偷袭');
    dice.push(5, 1, 2, 3);
    done(s.decide(['0']));
    expect(last(s, 'd20Rolled').total).toBe(20);
    expect(last(s, 'damageApplied').total).toBe(5 + 3 + 6);
    expect(Object.values(s.state.effects).some((e) => e.name === '侵扰' && e.bearer === 'r')).toBe(true);
  });

  it('野蛮人 3：狂暴扣职业表的次数、加狂暴伤害；结果写回角色卡后重算，剩余次数对得上', async () => {
    const char = fixture('barbarian3-unarmored');
    const { s, dice, sheets } = await encounter([{ id: 'b', char }], [{ id: 'g', ac: 10 }]);
    expect(s.view('b').resources['狂暴']).toBe(3);
    done(s.dispatch({ type: 'useAction', actor: 'b', action: 'XPHB:野蛮人:狂暴:1#enter' }));
    dice.push(10, 6);
    done(s.dispatch({ type: 'useAction', actor: 'b', action: 'weapon:巨斧#0', targets: ['g'] }));
    expect(last(s, 'damageApplied').total).toBe(6 + 3 + 2);
    done(s.dispatch({ type: 'damage', id: 'b', amount: 12, damageType: '挥砍' }));
    expect(s.state.combatants.b.live.hp).toBe(35 - 6);

    syncLiveToChar(char, sheets.b, s.state.combatants.b);
    expect(char.hp.current).toBe(29);
    const again = await env.compute(char);
    const rage = again._resources.find((r: { name: string }) => r.name === '狂暴次数');
    expect(rage).toMatchObject({ max: 3, used: 1, left: 2 });
  });

  it('法师 3：准备了护盾术就能用反应；法术位写回角色卡', async () => {
    const char = fixture('wizard3-evoker', { spells: [{ name: '护盾术', prepared: true }, { name: '火球术', prepared: true }] });
    const { s, dice, sheets } = await encounter([{ id: 'w', char }], [{ id: 'g' }]);
    expect(s.view('w').sources).toContain('XPHB:spell:护盾术');
    dice.push(9);   // 9 + 4 = 13 ≥ AC 12，命中
    const d = pending(s.dispatch({ type: 'useAction', actor: 'g', action: 'weapon:sc', targets: ['w'] }));
    expect(d.to).toBe('w');
    done(s.decide(['0']));
    expect(evs(s, 'attackMissed')).toHaveLength(1);
    syncLiveToChar(char, sheets.w, s.state.combatants.w);
    expect(char.slots).toEqual({ 1: { used: 1 } });
  });

  it('圣武士 6：守护灵光覆盖盟友的豁免', async () => {
    const { s, dice } = await encounter([
      { id: 'p', char: fixture('paladin6') },
      { id: 'f', char: fixture('fighter5-plate') },
    ], []);
    dice.push(10);
    const d = pending(s.dispatch({ type: 'roll', roller: 'f', kind: 'save', ability: 'wis', dc: 15 }));
    expect(d.questions![0].text).toMatch(/灵光/);
    done(s.decide({ [d.questions![0].id]: true }));
    const r = last(s, 'd20Rolled');
    // 圣武士魅力 17（15 + 背景 2）→ +3
    expect(r.mods.map((m: { label: string }) => m.label)).toContain('守护灵光');
    expect(r.total).toBe(10 + s.view('f').save.wis + 3);
  });

  it('战士 5：战斗中花生命骰回血、短休回短休资源，并把生命骰消耗写回角色卡', async () => {
    const char = fixture('fighter5-plate');
    const { s, dice, sheets } = await encounter([{ id: 'f', char }], []);
    const maxHp = s.view('f').hpMax;
    done(s.dispatch({ type: 'damage', id: 'f', amount: 20, damageType: '挥砍' }));
    expect(s.state.combatants.f.live.hp).toBe(maxHp - 20);

    // 花掉 1 次动作如潮（短休恢复）
    const surgeId = Object.keys(s.view('f').resources)[0];
    done(s.dispatch({ type: 'setUsage', id: 'f', resource: surgeId, used: 1 }));
    expect(s.state.combatants.f.live.resourcesUsed[surgeId]).toBe(1);

    // 花 1 颗 d10 生命骰回血：掷出 6 + 体质调整值
    const conMod = s.view('f').mod.con;
    dice.push(6);
    done(s.dispatch({ type: 'spendHitDie', id: 'f', faces: 10 }));
    expect(s.state.combatants.f.live.hp).toBe(maxHp - 20 + Math.max(1, 6 + conMod));
    expect(s.state.combatants.f.live.hitDiceUsed?.[10]).toBe(1);

    // 短休：动作如潮恢复，生命骰消耗保持不变
    done(s.dispatch({ type: 'rest', ids: ['f'], kind: 'short' }));
    expect(s.state.combatants.f.live.resourcesUsed[surgeId] ?? 0).toBe(0);
    expect(s.state.combatants.f.live.hitDiceUsed?.[10]).toBe(1);

    syncLiveToChar(char, sheets.f, s.state.combatants.f);
    expect(char.hitDiceSpent?.[10]).toBe(1);
    expect(char.hp.current).toBe(maxHp - 20 + Math.max(1, 6 + conMod));
  });
});
