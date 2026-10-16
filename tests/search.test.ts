// 全库搜索：slug → 条目键的解析（纯函数），以及拿真索引 + 真 5etools 数据把原文取出来
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { createTaskBuilder } from '../src/factory/build';
import type { Json, SheetEnv } from '../src/sheet';
import { createNodeEnv } from '../src/sheet/node-env';
import { DEFAULT_DATA_DIR, hasLocalData } from '../src/sheet/node-provider';
import { hitWhere, loadSearchHits, parseIndex, searchHits, type SearchHit } from '../src/sheet/search';

const DATA = resolve(import.meta.dirname, '..', 'data');
const INDEX_FILE = resolve(DEFAULT_DATA_DIR, 'search', 'index.json');
const hasIndex = () => existsSync(INDEX_FILE);

/** 手写一份和站点同形状的小索引：名字、来源、类目、slug 都照真的来 */
const RAW = {
  m: { s: { XPHB: 11, XGE: 9, FTD: 4, TCE: 7, XDMG: 8, PHB: 58 } },
  x: [
    { id: 0, c: 30, u: encodeURIComponent('圣疗_圣武士_xphb_1_xphb'), p: 7, s: 'EFA', n: 'Lay on Hands', cn: '圣武士 1; 圣疗' },
    { id: 1, c: 30, u: encodeURIComponent('圣疗_圣武士_phb_1_phb'), p: 7, s: 'EFA', n: 'Lay on Hands', cn: '圣武士 1; 圣疗' },
    { id: 2, c: 2, u: encodeURIComponent('火球术_xphb'), p: 264, s: 11, n: 'Fireball', cn: '火球术' },
    { id: 3, c: 2, u: encodeURIComponent('火球术_phb'), p: 241, s: 58, n: 'Fireball', cn: '火球术' },
    { id: 4, c: 7, u: encodeURIComponent('巨武器大师_xphb'), p: 207, s: 11, n: 'Great Weapon Master', cn: '巨武器大师' },
    { id: 5, c: 4, u: encodeURIComponent('治疗药水_xdmg'), p: 136, s: 8, n: 'Potion of Healing', cn: '治疗药水' },
    { id: 6, c: 41, u: encodeURIComponent('炼金师_奇械师_efa_炼金师_efa_3_efa'), p: 12, s: 'EFA', n: 'Alchemist', cn: '炼金师 奇械师 3; 炼金师' },
    { id: 7, c: 40, u: encodeURIComponent('奇械师_tce,state:sub_炼金师_tce=b1'), p: 14, s: 7, n: 'Alchemist', cn: '炼金师 (炼金师)' },
    { id: 8, c: 6, u: encodeURIComponent('中毒_xphb'), p: 372, s: 11, n: 'Poisoned', cn: '中毒' },
    { id: 9, c: 45, u: 'bestiary.html', n: undefined, cn: undefined },
  ],
};

const find = (hits: SearchHit[], q: string, over: Partial<SearchHit> = {}) => {
  const k = Object.keys(over) as Array<keyof SearchHit>;
  return searchHits(hits, q).find((h) => k.every((x) => h[x] === over[x]));
};

describe('全库搜索：slug → 条目键', () => {
  const hits = parseIndex(RAW);

  it('书页链接这类没用的丢掉，其余都留下', () => {
    expect(hits).toHaveLength(9);
    expect(hits.every((h) => h.kind)).toBe(true);
  });

  it('法术 / 物品 / 专长：名字_来源', () => {
    expect(find(hits, '火球术', { source: 'XPHB' })).toMatchObject({ kind: 'spell', key: 'XPHB:spell:火球术', core2024: true, supported: true });
    expect(find(hits, '火球术', { source: 'PHB' })).toMatchObject({ key: 'PHB:spell:火球术', core2024: false });
    expect(find(hits, '治疗药水')).toMatchObject({ kind: 'item', key: 'XDMG:item:治疗药水' });
    expect(find(hits, '巨武器大师')).toMatchObject({ kind: 'feat', key: 'XPHB:巨武器大师' });
  });

  it('职业特性：名字_职业_来源_等级_职业来源（索引的 s 没填，要从 slug 取）', () => {
    expect(find(hits, '圣疗', { source: 'XPHB' })).toMatchObject({
      kind: 'classFeature', cls: '圣武士', level: 1, classSource: 'XPHB', key: 'XPHB:圣武士:圣疗:1', supported: true,
    });
  });

  it('子职特性：7 段，子职名也解析出来', () => {
    expect(find(hits, 'Alchemist', { cat: 41 })).toMatchObject({
      kind: 'subclassFeature', cls: '奇械师', subclass: '炼金师', level: 3, key: 'EFA:奇械师:炼金师:3', supported: true,
    });
  });

  it('子职（整条）：slug 里混了 state，名字和来源都别从 slug 取；只能给键以外的信息', () => {
    const h = find(hits, 'Alchemist', { cat: 40 });
    expect(h).toMatchObject({ kind: 'subclass', name: '炼金师', source: 'TCE', key: '', supported: false });
  });

  it('状态：有键（能拿它覆盖官方），但 buildTask 取不了原文', () => {
    expect(find(hits, '中毒')).toMatchObject({ kind: 'condition', key: 'XPHB:condition:中毒', supported: false });
  });

  it('搜索：2024 排前面，空串不出结果，能按类别筛', () => {
    expect(searchHits(hits, '火球术')[0].source).toBe('XPHB');
    expect(searchHits(hits, '   ')).toEqual([]);
    expect(searchHits(hits, '圣疗', { kinds: ['spell'] })).toEqual([]);
    expect(searchHits(hits, '圣疗', { kinds: ['classFeature'] })).toHaveLength(2);
  });

  it('列表里那一行怎么写', () => {
    expect(hitWhere(find(hits, '圣疗', { source: 'XPHB' })!)).toContain('职业特性 · XPHB · 圣武士 1 级');
  });
});

describe.skipIf(!hasLocalData() || !hasIndex())('全库搜索：真索引 + 真数据', () => {
  let env: SheetEnv;
  let hits: SearchHit[] = [];
  let tb: ReturnType<typeof createTaskBuilder>;

  beforeAll(async () => {
    env = await createNodeEnv();
    hits = await loadSearchHits(env.store);
    tb = createTaskBuilder({
      env,
      abilities: (JSON.parse(readFileSync(resolve(DATA, 'abilities-2024.json'), 'utf8')) as { entries: Record<string, Json> }).entries,
      load: (rel) => env.store.provider.load('/data/' + rel),
    });
  });

  it('索引装上了（其余类目是遭遇、表格、卡牌、载具这类，我们用不上，按设计丢掉）', () => {
    expect(hits.length).toBeGreaterThan(13_000);
    for (const kind of ['spell', 'item', 'feat', 'optfeature', 'race', 'classFeature', 'subclassFeature']) {
      expect(hits.some((h) => h.kind === kind), kind).toBe(true);
    }
  });

  it('搜「圣疗」→ 2024 那条的键和原文都对得上', async () => {
    const h = find(hits, '圣疗', { source: 'XPHB', kind: 'classFeature' });
    expect(h?.key).toBe('XPHB:圣武士:圣疗:1');
    const t = await tb.buildTask('t', h!.key);
    expect(t.name).toBe('圣疗');
    expect(t.text).toContain('治疗能量');     // 原文正文（正文里不一定重复特性名）
    expect(t.where).toContain('圣武士');
  });

  it('自己搜出来的键，都能让 buildTask 取到原文（挑各类一条）', async () => {
    const cases: Array<[string, string]> = [
      ['火球术', 'XPHB:spell:火球术'],
      ['治疗药水', 'XDMG:item:治疗药水'],
      ['巨武器大师', 'XPHB:巨武器大师'],
      ['警觉', 'XPHB:警觉'],
    ];
    for (const [q, key] of cases) {
      const h = hits.find((x) => x.key === key);
      expect(h, `索引里应该有 ${key}`).toBeTruthy();
      const t = await tb.buildTask('t', key);
      expect(t.text.length, `${key} 的原文`).toBeGreaterThan(0);
    }
  });
});
