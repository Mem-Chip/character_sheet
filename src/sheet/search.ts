/**
 * 全库搜索（LIBRARY.md 第六节）：直接用 5etools 站点自己的搜索索引 `/search/index.json`
 * （2.9 MB、约 1.8 万条），不用把整个 5etools 拉下来自己建索引。
 *
 * 索引里的每条是 `{ c 类目, u 站点 slug, p 页码, s 来源序号, n 英文名, cn 中文名 }`，
 * 顶部 `m.s` 是「来源代号 → 序号」。**slug 能还原成引擎的条目键**：
 * ```
 * 火球术_xphb                        → XPHB:spell:火球术
 * 治疗药水_xdmg                      → XDMG:item:治疗药水
 * 警觉_xphb / 龙裔 (宝石)_ftd        → XPHB:警觉 / FTD:龙裔 (宝石)
 * 圣疗_圣武士_xphb_1_xphb            → XPHB:圣武士:圣疗:1        （职业特性，5 段）
 * 炼金师_奇械师_efa_炼金师_efa_3_efa  → 子职特性（7 段，名字_职业_来源_子职_子职来源_等级_职业来源）
 * 奇械师_tce,state:sub_炼金师_tce=b1  → 子职（4 段，但 slug 里混了 state，来源改从 s 取）
 * ```
 * 类目码 → 类别的对照是拿本地数据反查出来的（LIBRARY.md §6.2）。职业特性 / 子职特性的 `s`
 * 在站点索引里没填，所以这两类的来源一律从 slug 里取。
 *
 * 原文不在这里取：`src/factory/build.ts` 的 `buildTask` 已经会按条目键去 5etools 拿原文 +
 * 算上下文（它支持哪几类见 `SUPPORTED`）。不支持的类别照样给键（覆盖官方条目用得上），
 * 只是要人自己写数据。
 */
import type { DataStore } from './store';
import { Source } from './source';

/** 类目码 → 类别（拿本地数据反查出来的） */
export const CAT_KIND: Record<number, string> = {
  1: 'monster', 2: 'spell', 3: 'background', 4: 'item', 6: 'condition',
  7: 'feat', 8: 'optfeature', 10: 'race', 11: 'optfeature', 12: 'optfeature', 14: 'deity',
  21: 'disease', 22: 'optfeature', 23: 'optfeature', 27: 'optfeature', 29: 'optfeature',
  30: 'classFeature', 31: 'item', 32: 'optfeature', 33: 'optfeature', 34: 'optfeature',
  37: 'optfeature', 40: 'subclass', 41: 'subclassFeature', 42: 'action', 43: 'language',
  49: 'variantrule', 50: 'skill', 51: 'sense', 54: 'action', 55: 'location',
};

/** 类别 → 中文（界面上筛选用） */
export const KIND_CN: Record<string, string> = {
  spell: '法术', item: '物品', feat: '专长', optfeature: '可选特性', race: '种族', background: '背景',
  classFeature: '职业特性', subclassFeature: '子职特性', subclass: '子职', monster: '怪物',
  condition: '状态', disease: '疾病', action: '动作', variantrule: '变体规则', language: '语言',
  skill: '技能', sense: '感官', deity: '神祇', location: '地点',
};

/** buildTask 能直接取原文的类别（其余只能给键和出处，数据要自己写） */
export const SUPPORTED: ReadonlySet<string> = new Set(['spell', 'item', 'feat', 'optfeature', 'race', 'classFeature', 'subclassFeature', 'subclass']);

/** 能不能给出一条确定的条目键 */
const KEYED: ReadonlySet<string> = new Set([...SUPPORTED, 'condition', 'action', 'monster', 'disease', 'variantrule']);

export interface SearchHit {
  /** 索引里的序号（列表 key） */
  i: number;
  cat: number;
  kind: string;
  /** 来源代号（大写） */
  source: string;
  /** 中文名（没有就用英文名） */
  name: string;
  en: string;
  /** 站点上的显示名（职业特性带「圣武士 1;」这种前缀） */
  cn: string;
  page: number;
  /** 职业特性 / 子职特性的上下文 */
  cls?: string;
  subclass?: string;
  level?: number;
  classSource?: string;
  /** 引擎条目键（认不出来 = 空） */
  key: string;
  /** 出自 2024 核心书（列表里标「2024」并排前面） */
  core2024: boolean;
  /** 能不能直接取原文（否则只有键和出处） */
  supported: boolean;
}

interface RawIndex { x?: Array<Record<string, unknown>>; m?: { s?: Record<string, number> } }

/** 解析站点索引（纯函数，测试直接用） */
export function parseIndex(raw: unknown): SearchHit[] {
  const j = (raw ?? {}) as RawIndex;
  const xs = Array.isArray(j.x) ? j.x : [];
  const nameOfSrc = new Map<number, string>();
  for (const [code, n] of Object.entries(j.m?.s ?? {})) nameOfSrc.set(Number(n), String(code).toUpperCase());

  const out: SearchHit[] = [];
  for (const [i, e] of xs.entries()) {
    const cat = Number(e.c);
    const kind = CAT_KIND[cat];
    if (!kind) continue;                                  // 书页链接、随机表这类不要
    const cn = String(e.cn ?? '');
    const en = String(e.n ?? '');
    const slug = decodeURIComponent(String(e.u ?? ''));
    const segs = slug.split('_');
    const n = segs.length;
    const idxSrc = nameOfSrc.get(Number(e.s)) ?? '';

    let source = idxSrc;
    let name = cn || en;
    let cls: string | undefined;
    let subclass: string | undefined;
    let level: number | undefined;
    let classSource: string | undefined;

    if (kind === 'classFeature' || kind === 'subclassFeature') {
      const need = kind === 'subclassFeature' ? 7 : 5;
      if (n < need) continue;
      classSource = segs[n - 1].toUpperCase();
      level = Number(segs[n - 2]);
      source = segs[n - (kind === 'subclassFeature' ? 5 : 3)].toUpperCase();
      cls = segs[n - (kind === 'subclassFeature' ? 6 : 4)];
      if (kind === 'subclassFeature') subclass = segs[n - 4];
      name = segs.slice(0, n - (need - 1)).join('_');
      if (!name || !cls || !Number.isFinite(level)) continue;
      if (!/^[A-Z0-9-]{1,24}$/.test(source)) source = idxSrc;
    } else if (kind === 'subclass') {
      // 子职的 slug 是「职业_来源,state:...」（混了状态后缀）：名字和来源都别从 slug 取
      name = (cn || en).split(' (')[0] || (cn || en);
      source = idxSrc;
    } else if (n >= 2) {
      const tail = segs[n - 1].toUpperCase();
      if (/^[A-Z0-9-]{1,24}$/.test(tail)) {
        source = tail;
        name = segs.slice(0, n - 1).join('_') || cn || en;
      }
    }
    if (!name) continue;

    const key = KEYED.has(kind) ? keyOf(kind, source, name, cls, level) : '';
    out.push({
      i, cat, kind, source, name, en, cn, page: Number(e.p) || 0,
      ...(cls ? { cls } : {}), ...(subclass ? { subclass } : {}),
      ...(level !== undefined ? { level } : {}), ...(classSource ? { classSource } : {}),
      key,
      core2024: Source.OFFICIAL_2024.has(source) || source === 'EFA',
      supported: SUPPORTED.has(kind) && !!key,
    });
  }
  return out;
}

/** 类别 + 来源 + 名字 → 引擎条目键（和 src/sheet/abilities.ts 的 sourceKeyOf 一致） */
function keyOf(kind: string, source: string, name: string, cls?: string, level?: number): string {
  if (!source) return '';
  switch (kind) {
    case 'spell': return `${source}:spell:${name}`;
    case 'item': return `${source}:item:${name}`;
    case 'classFeature':
    case 'subclassFeature': return cls && level !== undefined ? `${source}:${cls}:${name}:${level}` : '';
    case 'condition': return `${source}:condition:${name}`;
    case 'action': return `${source}:action:${name}`;
    case 'monster': return `${source}:怪物:${name}`;
    case 'disease': return `${source}:disease:${name}`;
    case 'variantrule': return `${source}:variantrule:${name}`;
    default: return `${source}:${name}`;
  }
}

/* ───────────── 装载与查询 ───────────── */

let memo: SearchHit[] | null = null;
/** 装载搜索索引（第一次调用去取，之后用缓存） */
export async function loadSearchHits(store: DataStore): Promise<SearchHit[]> {
  if (memo) return memo;
  const raw = await store.ensure('searchIndex');
  return (memo = parseIndex(raw));
}
/** 测试 / 换数据用：丢掉缓存 */
export const resetSearchCache = (): void => { memo = null; };

export interface SearchOptions {
  /** 只找这些类别（不写 = 全部） */
  kinds?: string[];
  limit?: number;
}

/**
 * 搜一条：中文名 / 英文名 / 职业名都能命中；同名的按
 * 「完全一样 → 名字短 → 2024 核心 → 拼音序」排。
 */
export function searchHits(hits: SearchHit[], q: string, o: SearchOptions = {}): SearchHit[] {
  const want = q.trim().toLowerCase();
  if (!want) return [];
  const kinds = o.kinds?.length ? new Set(o.kinds) : null;
  const out: SearchHit[] = [];
  for (const h of hits) {
    if (kinds && !kinds.has(h.kind)) continue;
    if (!(h.name.toLowerCase().includes(want) || h.en.toLowerCase().includes(want)
      || h.cn.toLowerCase().includes(want) || (h.cls ?? '').toLowerCase().includes(want))) continue;
    out.push(h);
  }
  const exact = (h: SearchHit) => (h.name.toLowerCase() === want ? 0 : 1);
  return out.sort((a, b) => exact(a) - exact(b)
    || Number(b.core2024) - Number(a.core2024)
    || a.name.length - b.name.length
    || a.name.localeCompare(b.name, 'zh'))
    .slice(0, o.limit ?? 80);
}

/** 列表里那一行怎么写：「圣疗 · 职业特性 · XPHB · 圣武士 1 级」 */
export function hitWhere(h: SearchHit): string {
  const bits = [KIND_CN[h.kind] ?? h.kind, h.source];
  if (h.kind === 'classFeature') bits.push(`${h.cls} ${h.level} 级`);
  else if (h.kind === 'subclassFeature') bits.push(`${h.cls}·${h.subclass} ${h.level} 级`);
  else if (h.kind === 'spell') bits.push('法术');
  if (h.page) bits.push(`p${h.page}`);
  return bits.filter(Boolean).join(' · ');
}
