// 我的资料库（账户级家规）：卡面的第 3 层，不在战役里也生效；它带的来源书也放行
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { classSpells, type CharData, type HomeRuleEntry, type Json, type SheetEnv } from '../../src/sheet';
import { createNodeEnv } from '../../src/sheet/node-env';
import { hasLocalData } from '../../src/sheet/node-provider';
import { homeRuleOf, type LibraryItem } from '../../src/library';
import { viewFromSheet } from '../../src/bridge/from-sheet';

const chars = JSON.parse(readFileSync(resolve(import.meta.dirname, '..', 'fixtures', 'chars.json'), 'utf8')) as Array<{ id: string; char: CharData }>;
const fighter = () => structuredClone(chars.find((c) => c.id === 'fighter5-plate')!.char);
const hr = (id: string, over: Partial<HomeRuleEntry> = {}): HomeRuleEntry => ({ id, name: id, text: '', mods: [], ...over });

describe.skipIf(!hasLocalData())('我的资料库接进卡面', () => {
  let env: SheetEnv;
  beforeAll(async () => { env = await createNodeEnv(); await env.store.ensureMany(['spellsXphb', 'spellsSources']); });
  afterEach(() => {
    env.homelib.user = () => [];
    env.userSources = () => [];
    env.campaignOf = () => null;
  });

  it('不在战役里也生效，而且真的算进卡里（AC +1）', async () => {
    const before = await env.compute(fighter());
    env.homelib.user = () => [hr('hr-u00001', { mods: [{ kind: 'ac', bonus: 1 }] })];
    const after = await env.compute(fighter());
    expect(after.ac).toBe(before.ac + 1);
  });

  it('「选了才生效」的条目要卡上勾了才算', async () => {
    const c = fighter();
    env.homelib.user = () => [hr('hr-u00002', { pickable: true })];
    await env.compute(c);
    expect(env.abilities.collectSources(c).map((s) => s.name)).not.toContain('hr-u00002');
    c.hrPicked = ['hr-u00002'];
    await env.compute(c);
    expect(env.abilities.collectSources(c).map((s) => s.name)).toContain('hr-u00002');
  });

  it('层序：全服 → 本团 → 我的库 → 本卡，同 id 靠后的赢', async () => {
    const c = fighter();
    env.campaignOf = () => ({ sources: [], homerules: [hr('hr-u00003', { name: '团的版本' })] });
    env.homelib.user = () => [hr('hr-u00003', { name: '我的版本' })];
    await env.compute(c);
    let list = env.abilities.homelibAll(c);
    expect(list.map((x) => x._scope)).toEqual(['user']);
    expect(list[0].name).toBe('我的版本');

    c.homerules = [hr('hr-u00003', { name: '卡上的版本' })];
    await env.compute(c);
    list = env.abilities.homelibAll(c);
    expect(list.map((x) => x._scope)).toEqual(['card']);
    expect(list[0].name).toBe('卡上的版本');
  });

  it('我库里覆盖的那一条法术能用（但不会因此放开整本书）', async () => {
    const xge: Json[] = ((await env.store.provider.load('/data/spells/spells-xge.json')) as Json).spell;
    const only = xge.filter((s) => !(s.reprintedAs || []).length).map((s) => s.name);
    const names = () => new Set(classSpells(env, '法师').map((s) => s.name));

    await env.useCampaign(null);
    expect(only.some((n) => names().has(n))).toBe(false);

    // 只放行我库里那一条（法术文件名仍然要装，但书不算「启用」）
    env.userSources = () => ['XGE'];
    env.userCovered = () => [`XGE:spell:${only[0]}`];
    await env.useCampaign(null);
    expect(names(), '覆盖的那一条能选').toContain(only[0]);
    expect(only.filter((n) => names().has(n)).length, '同书的其它法术不该跟着放出来').toBe(1);
  });
  it('只写了战斗数据的新内容：勾上就上卡，战斗数据里的次数池进人物卡、也进战斗', async () => {
    const part = {
      id: 'hr-cb0001', key: 'HR:hr-cb0001', name: '怒焰一击',
      combat: { entry: {
        resources: [{ id: '怒焰', formula: 'pb', recovery: 'long' }],
        actions: [{ id: 'hit', name: '怒焰一击', cost: [{ economy: 'bonus' }, { resource: '怒焰' }], root: [] }],
      } },
    };
    const item: LibraryItem = { id: 'it-cb0001', kind: 'feat', name: '怒焰一击', text: '', parts: [part], by: 'test', reviewed: false };
    const entry = homeRuleOf(part, item);
    expect(entry, '没有卡面数据也要出一条').not.toBeNull();
    expect(entry!.pickable, '按「选了才生效」处理').toBe(true);

    const c = fighter();
    env.homelib.user = () => [entry!];
    c.hrPicked = ['hr-cb0001'];
    const sheet = await env.compute(c);
    const pool = (sheet._resources as Json[]).find((r) => r.name === '怒焰');
    expect(pool?.max, '人物卡上有这个次数池（熟练加值 3）').toBe(3);
    const v = viewFromSheet(env, c, sheet);
    expect(v.sources).toContain('HR:hr-cb0001');
    expect(v.resources['怒焰']).toBe(3);
  });

  it('覆盖官方的、只写了战斗数据的一条仍然不进卡面（不顶掉官方卡面数据）', () => {
    const part = { id: 'hr-cb0002', key: 'XPHB:野蛮人:狂暴:1', combat: { entry: { resources: [{ id: '狂暴', formula: '9', recovery: 'long' }] } } };
    expect(homeRuleOf(part, { id: 'it-cb0002', kind: 'classFeature', name: '狂暴', text: '', parts: [part], by: 'test', reviewed: false })).toBeNull();
  });
});
