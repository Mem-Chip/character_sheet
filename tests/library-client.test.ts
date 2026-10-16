// 客户端资料库的接线：登录 → 取我的库 → 接成规则环境的第 3 层家规 + 来源书放行
// （这条链路在源码级测试里碰不到：它跨 sync.ts / api.ts / library.ts）
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RULE_FILES } from '../src/bridge/rule-files';
import { RuleBook } from '../src/combat';
import type { LibraryItem } from '../src/library';
import type { CampaignData, CharData, HomeRuleEntry } from '../src/sheet';

const ITEM: LibraryItem = {
  id: 'hr-c00001', kind: 'classFeature', name: '家规：护甲加一', text: '',
  parts: [
    { id: 'hr-c00001', key: 'XPHB:野蛮人:无甲防御:1', sheet: { mods: [{ kind: 'ac', bonus: 1 }] }, combat: { entry: { name: '无甲防御' } } },
    { id: 'hr-c00002', key: 'XGE:spell:火焰刀', combat: { entry: { name: '火焰刀' } } },
  ],
  by: 'hand', reviewed: true,
};

/** 只回三样东西的假接口：我是谁、我的卡、我的库 */
function stubApi(items: LibraryItem[]): string[] {
  const seen: string[] = [];
  globalThis.fetch = (async (url: string) => {
    seen.push(String(url));
    const body = String(url).includes('/library') ? { items }
      : String(url).includes('/cards') ? { cards: [] }
        : { user: { id: 7, name: '测试员' } };
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  }) as unknown as typeof fetch;
  return seen;
}

/** 一个够用的「引擎」：只用到这几个字段 */
function fakeEngine() {
  const env = {
    campaignOf: (_c: CharData): CampaignData | null => null,
    homelib: { server: [], user: (_c: CharData): HomeRuleEntry[] => [], camp: (_c: CharData): HomeRuleEntry[] => [] },
    userSources: (): string[] => [],
  };
  return { env };
}

beforeEach(() => {
  vi.resetModules();
  // store.ts 在模块加载时会碰 document.documentElement.dataset / matchMedia / localStorage
  globalThis.document = { baseURI: 'http://localhost/', documentElement: { dataset: {} } } as unknown as Document;
  globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} } as unknown as Storage;
  globalThis.window = { addEventListener: () => {} } as unknown as Window & typeof globalThis;
  globalThis.matchMedia = (() => ({ matches: false })) as unknown as typeof matchMedia;
});

describe('客户端资料库接进规则环境', () => {
  it('登录后取到我的库，接成第 3 层家规；条目带的来源书一起放行', async () => {
    stubApi([ITEM]);
    const { init } = await import('../app/lib/sync');
    const lib = await import('../app/lib/library');
    await init();                       // 登录（假接口回的是 user 7）
    await lib.loadLibrary();            // useComputed 里算卡前会等这一步
    expect(lib.libraryNow().map((x) => x.id)).toEqual(['hr-c00001']);

    const engine = fakeEngine();
    lib.installLibrary(engine as never);

    const rules = engine.env.homelib.user({} as CharData);
    // 只带战斗数据的那条（hr-c00002）不进卡面；带卡面数据的那条进
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ id: 'hr-c00001', covers: 'XPHB:野蛮人:无甲防御:1', mods: [{ kind: 'ac', bonus: 1 }] });
    // 来源书：两条的键都认（XPHB 与 XGE），新内容 HR: 的不算
    expect(new Set(engine.env.userSources())).toEqual(new Set(['XPHB', 'XGE']));
  });

  it('没登录时不去要库，装出来的也是空的一层', async () => {
    const seen = stubApi([ITEM]);
    const { getSync, init } = await import('../app/lib/sync');
    globalThis.fetch = (async (url: string) => {
      seen.push(String(url));
      return { ok: true, status: 200, json: async () => ({ user: null }) } as unknown as Response;
    }) as unknown as typeof fetch;
    await init();
    expect(getSync().user).toBeNull();
    const lib = await import('../app/lib/library');
    await lib.loadLibrary();
    expect(lib.libraryNow()).toEqual([]);
    expect(seen.some((u) => u.includes('/library'))).toBe(false);
  });
});

describe('本地遭遇用我的库（不在战役里也能用自定义战斗数据）', () => {
  const loadWith = async (items: LibraryItem[]) => {
    stubApi(items);
    const { init } = await import('../app/lib/sync');
    const lib = await import('../app/lib/library');
    await init();
    await lib.loadLibrary();
    return lib;
  };
  const engineOf = () => {
    const base = new RuleBook(RULE_FILES);
    return { env: fakeEngine().env, rules: base, base };
  };

  it('我的库里的战斗数据会叠到本地遭遇的规则书上', async () => {
    const lib = await loadWith([ITEM]);
    const engine = engineOf();
    lib.applyLocalRules(engine as never);
    expect(engine.rules).not.toBe(engine.base);
    // ITEM 里 hr-c00001 覆盖官方那条（官方没有战斗数据，fill 补上）
    expect(engine.rules.entry('XPHB:野蛮人:无甲防御:1')).toBeTruthy();
    expect(engine.rules.overriddenBy('XPHB:野蛮人:无甲防御:1')?.scope).toBe('card');
  });

  it('库里没有战斗数据时，还是用官方那本', async () => {
    const lib = await loadWith([]);
    const engine = engineOf();
    lib.applyLocalRules(engine as never);
    expect(engine.rules).toBe(engine.base);
  });
});
