// 资料库覆盖单个条目：只放行那一条（不把整本书放出来），选择面板显示覆盖后的名字
import { beforeAll, afterEach, describe, expect, it } from 'vitest';
import { Source, type Json, type SheetEnv } from '../../src/sheet';
import { createNodeEnv } from '../../src/sheet/node-env';
import { hasLocalData } from '../../src/sheet/node-provider';

describe.skipIf(!hasLocalData())('资料库覆盖条目', () => {
  let env: SheetEnv;
  beforeAll(async () => { env = await createNodeEnv(); await env.store.ensureMany(['races', 'backgrounds', 'feats']); });
  afterEach(async () => { env.userSources = () => []; env.userCovered = () => []; env.userNames = () => ({}); await env.useCampaign(null); });

  const races = () => (env.store.races2024 as Json[]).map((r) => String(r.name));

  it('覆盖 EFA 的「科拉瓦」：只多出这一个种族，同书的战俑不出现', async () => {
    expect(races()).not.toContain('科拉瓦');
    await env.useCampaign({ sources: [], homerules: [], covered: ['EFA:科拉瓦'], names: { 'EFA:科拉瓦': '半精灵' } });
    // 值还是原始名字（键不变，规则照旧对得上），显示名换成覆盖后的
    expect(races()).toContain('科拉瓦');
    expect(races(), '导入一条 EFA 的种族不该把整本书放出来').not.toContain('战俑');
    expect(env.store.labelOfName('科拉瓦')).toBe('半精灵');
    // 关掉覆盖就回到原样
    await env.useCampaign(null);
    expect(races()).not.toContain('科拉瓦');
    expect(env.store.labelOfName('科拉瓦')).toBe('科拉瓦');
  });

  it('资料库条目所在的书只用来装数据文件，不算「启用的书」', async () => {
    env.userSources = () => ['EFA'];              // 导入的条目带这本书
    await env.useCampaign({ sources: [], homerules: [] });
    expect(Source.extra.has('EFA'), '不能因为导入条目就放行整本书').toBe(false);
    expect(races()).not.toContain('战俑');
  });

  it('战役真的勾了那本书，才整本放出来', async () => {
    await env.useCampaign({ sources: ['EFA'], homerules: [] });
    expect(races()).toContain('战俑');
  });

  it('显示名按 part 自己的名字优先（一条内容带多个 part 时不会全叫一个名字）', async () => {
    await env.useCampaign({
      sources: [],
      homerules: [],
      covered: ['EFA:科拉瓦', 'EFA:战俑'],
      names: { 'EFA:科拉瓦': '半精灵', 'EFA:战俑': '机关人' },
    });
    expect(env.store.labelOfName('科拉瓦')).toBe('半精灵');
    expect(env.store.labelOfName('战俑')).toBe('机关人');
    expect(env.store.labelOfName('幻身灵')).toBe('幻身灵');   // 没覆盖的保持原名
  });
});

// 不需要 5etools 数据的部分：纯函数
describe('Source 的覆盖集合', () => {
  it('keysOf 认得出种族 / 法术 / 物品几种键', () => {
    expect(Source.keysOf({ source: 'efa', name: '科拉瓦' })).toContain('EFA:科拉瓦');
    expect(Source.keysOf({ source: 'XGE', name: '法术甲' })).toContain('XGE:spell:法术甲');
    expect(Source.keysOf({ source: 'XGE', name: '物品甲' })).toContain('XGE:item:物品甲');
    expect(Source.keysOf(null)).toEqual([]);
  });

  it('covered 里的条目算 2024；不在里面的仍然不算', () => {
    Source.covered.clear();
    Source.covered.add('EFA:科拉瓦');
    expect(Source.isCore2024({ source: 'EFA', name: '科拉瓦' })).toBe(true);
    expect(Source.isCore2024({ source: 'EFA', name: '战俑' })).toBe(false);
    Source.covered.clear();
  });
});
