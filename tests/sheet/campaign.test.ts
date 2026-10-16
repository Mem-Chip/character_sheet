// 战役资料：启用的书（法术、子职能选）、本团家规（可选的要卡上勾了才算）
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { sourceKeys } from '../../src/bridge/from-sheet';
import { classSpells, subclassCandidates, type CharData, type Json, type SheetEnv } from '../../src/sheet';
import { createNodeEnv } from '../../src/sheet/node-env';
import { hasLocalData } from '../../src/sheet/node-provider';

const chars = JSON.parse(readFileSync(resolve(import.meta.dirname, '..', 'fixtures', 'chars.json'), 'utf8')) as Array<{ id: string; char: CharData }>;
const fighter = () => structuredClone(chars.find((c) => c.id === 'fighter5-plate')!.char);

describe.skipIf(!hasLocalData())('战役资料', () => {
  let env: SheetEnv;
  beforeAll(async () => { env = await createNodeEnv(); await env.store.ensureMany(['spellsXphb', 'spellsSources']); });
  afterEach(async () => { env.campaignOf = () => null; await env.useCampaign(null); });

  it('启用 XGE：法师能选 XGE 没被重印的法术和「战争魔法」子职；不启用就没有', async () => {
    const xge: Json[] = ((await env.store.provider.load('/data/spells/spells-xge.json')) as Json).spell;
    const only = xge.filter((s) => !(s.reprintedAs || []).length).map((s) => s.name);
    const names = () => new Set(classSpells(env, '法师').map((s) => s.name));
    expect(only.some((n) => names().has(n))).toBe(false);
    const wiz = await env.store.classData('wizard');
    const subs = () => subclassCandidates(wiz.subclass, 'XPHB').map((s: Json) => s.name);
    expect(subs()).not.toContain('战争魔法');

    await env.useCampaign({ sources: ['XGE'], homerules: [] });
    expect(only.some((n) => names().has(n))).toBe(true);
    expect(subs()).toContain('战争魔法');
    // 被 2024 重印过的那些仍然不出现（用 2024 版）
    const reprinted = xge.filter((s) => (s.reprintedAs || []).length).map((s) => s.name);
    const xphb = new Set(((env.store.data.spellsXphb?.spell || []) as Json[]).map((s) => s.name));
    expect(env.store.spellsAll.filter((s: Json) => s.source === 'XGE' && reprinted.includes(s.name) && !xphb.has(s.name))).toHaveLength(0);
  });

  it('本团家规：人人都有的直接生效；「选了才生效」的要卡上勾了；法术的条目键用那本书的来源', async () => {
    const hr = [
      { id: 'hr-all1', name: '团规：耐苦', text: '', mods: [{ kind: 'note', note: 'x' }] },
      { id: 'hr-pick1', name: '团规：可选', text: '', pickable: true, mods: [] },
    ];
    env.campaignOf = () => ({ sources: ['XGE'], homerules: hr });
    const c = fighter();
    await env.compute(c);
    let names = env.abilities.collectSources(c).map((s) => s.name);
    expect(names).toContain('hr-all1');
    expect(names).not.toContain('hr-pick1');
    c.hrPicked = ['hr-pick1'];
    await env.compute(c);
    names = env.abilities.collectSources(c).map((s) => s.name);
    expect(names).toContain('hr-pick1');

    const xge: Json[] = ((await env.store.provider.load('/data/spells/spells-xge.json')) as Json).spell;
    const sp = xge.find((s) => !(s.reprintedAs || []).length)!;
    c.spells = [{ name: sp.name, prepared: true }];
    await env.compute(c);
    expect(sourceKeys(env, c)).toContain(`XGE:spell:${sp.name}`);
  });
});
