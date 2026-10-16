import { Source } from './source';

/**
 * 数据仓库（移植自原项目 core/store.js 的 Store 部分 + core/data.js 的 Search.classData）。
 *
 * 原项目的取数（ETag 协商缓存、IndexedDB、整包暖启动）是浏览器的事，这里抽成一个提供者接口：
 * 浏览器里用 fetch + 缓存实现，Node / 测试里从本地目录读（node-provider.ts）。
 */
export interface DataProvider {
  /** 按站点路径取 JSON（`/data/races.json`）。取不到就抛错 */
  load(path: string): Promise<unknown>;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Json = any;

export class DataStore {
  /** 已装载的数据，键见 Source.FILES */
  readonly data: Record<string, Json> = {};
  /** 物品属性缩写 → 中文（`2H` → 双手） */
  props: Record<string, string> = {};
  /** 武器精通：名字 → 条目 */
  masteries: Record<string, Json> = {};
  private readonly classFiles = new Map<string, Promise<Json>>();
  /** 战役启用的书的法术（来源 → 法术列表；spells/index.json 里没有这本书 = 空） */
  readonly bookSpells = new Map<string, Json[]>();
  private readonly pending = new Map<string, Promise<Json>>();

  static readonly CORE = ['classIndex', 'races', 'backgrounds', 'feats', 'itemsBase', 'languages', 'conditions', 'actions'];

  constructor(readonly provider: DataProvider, readonly log: (msg: string, level?: number) => void = () => {}) {}

  async ensure(key: string): Promise<Json> {
    const p = Source.FILES[key];
    if (!p) throw new Error('未知数据键 ' + key);
    if (this.data[key] !== undefined) return this.data[key];
    let job = this.pending.get(key);
    if (!job) {
      job = this.provider.load(p).then((j) => { this.data[key] = j; return j; });
      this.pending.set(key, job);
      job.catch(() => this.pending.delete(key));
    }
    return job;
  }

  /** 并行装载；返回没装上的键（失败不抛，记日志） */
  async ensureMany(keys: string[]): Promise<string[]> {
    const res = await Promise.allSettled(keys.map((k) => this.ensure(k)));
    const bad: string[] = [];
    res.forEach((r, i) => {
      if (r.status === 'rejected') {
        bad.push(keys[i]);
        this.log('装载失败 ' + keys[i] + ': ' + ((r.reason as Error)?.message || r.reason), 1);
      }
    });
    return bad;
  }

  /** 建卡骨架 + 规则计算要的几份（工具/语言规则要 items.json，可选项要 optionalfeatures） */
  async bootstrap(extra: string[] = ['items', 'optionalfeatures']): Promise<string[]> {
    const bad = await this.ensureMany([...DataStore.CORE, ...extra]);
    const ib = this.data.itemsBase;
    const PROP_CN_FIX: Record<string, string> = { L: '轻型', S: '特殊' };
    this.props = {};
    for (const p of ib?.itemProperty || []) {
      const code = String(p.abbreviation).split('|')[0];
      const nm = PROP_CN_FIX[code] || (p.entries ? (p.entries[0]?.name || code) : code);
      if (!this.props[code] || p.source === 'XPHB') this.props[code] = nm;
    }
    this.masteries = {};
    for (const m of ib?.itemMastery || []) this.masteries[m.name] = m;
    return bad;
  }

  /** 职业文件（按 class/index.json 映射，结果缓存） */
  async classData(slug: string): Promise<Json> {
    const idx = await this.ensure('classIndex');
    const file = idx?.[slug];
    if (!file) throw new Error('class/index.json 里没有该职业：' + slug);
    let job = this.classFiles.get(file);
    if (!job) {
      job = this.provider.load('/data/class/' + file);
      this.classFiles.set(file, job);
      job.catch(() => this.classFiles.delete(file));
    }
    return job;
  }

  /** 装上这些书的法术文件（已经装过的跳过）；返回没装上的书 */
  async loadBookSpells(sources: string[]): Promise<string[]> {
    const todo = sources.filter((s) => !this.bookSpells.has(s) && s !== 'XPHB');
    if (!todo.length) return [];
    const idx: Record<string, string> = (await this.ensure('spellsIndex').catch(() => null)) || {};
    const byUpper = new Map(Object.entries(idx).map(([k, f]) => [k.toUpperCase(), f]));
    const bad: string[] = [];
    await Promise.all(todo.map(async (src) => {
      const file = byUpper.get(src);
      if (!file) { this.bookSpells.set(src, []); return; }
      try { this.bookSpells.set(src, ((await this.provider.load('/data/spells/' + file)) as Json)?.spell || []); } catch { bad.push(src); }
    }));
    return bad;
  }

  /** 能选的法术：2024 玩家手册 + 战役启用的书（被 2024 重印的不算） */
  get spellsAll(): Json[] {
    const out: Json[] = [...(this.data.spellsXphb?.spell || [])];
    for (const [src, list] of this.bookSpells) if (Source.extra.has(src)) for (const s of list) if (!Source.isReprinted(s)) out.push(s);
    return out;
  }

  /** 按名字找法术（能选的里面先找，再找所有装过的书） */
  spellByName(name: string): Json | null {
    return this.spellsAll.find((s) => s.name === name)
      || [...this.bookSpells.values()].flat().find((s) => s.name === name) || null;
  }

  get races2024(): Json[] { return (this.data.races?.race || []).filter((r: Json) => Source.isCore2024(r)); }
  get backgrounds2024(): Json[] { return (this.data.backgrounds?.background || []).filter((b: Json) => Source.isCore2024(b)); }
  get feats2024(): Json[] { return (this.data.feats?.feat || []).filter((f: Json) => Source.isCore2024(f)); }
  get racesAll(): Json[] { return this.data.races?.race || []; }
  get backgroundsAll(): Json[] { return this.data.backgrounds?.background || []; }
  get featsAll(): Json[] { return this.data.feats?.feat || []; }
  get weapons2024(): Json[] {
    return (this.data.itemsBase?.baseitem || []).filter((x: Json) => x.weapon && (Source.OFFICIAL_2024.has(x.source) || x.edition === 'one'));
  }
  get armors2024(): Json[] {
    return (this.data.itemsBase?.baseitem || []).filter((x: Json) => x.armor && (Source.OFFICIAL_2024.has(x.source) || x.edition === 'one'));
  }
  get gear2024(): Json[] {
    return (this.data.itemsBase?.baseitem || []).filter((x: Json) => !x.weapon && !x.armor && (Source.OFFICIAL_2024.has(x.source) || x.edition === 'one'));
  }
}
