/**
 * 账户资料库（客户端，见 LIBRARY.md）：我自己的内容 + 战役挂上来的内容。
 *
 * - 我的库：整份取一次缓存在内存里，改动即时反映。
 * - 战役：`/api/campaigns/:id/hub` 返回启用的书 + 全部挂载（含待审、关掉的）；生效的那部分才进规则。
 * - 算卡：卡上的 `_campaign` → 这个战役生效的内容 → `SheetEnv.useCampaign`（启用的书、家规）。
 *   自己库那一层在第 2 期接（`homelib.user`）。
 * - 战斗：遭遇开局时服务器把生效的战斗部分抄进遭遇（`meta.rules`），不走这里。
 */
import { useSyncExternalStore } from 'react';
import { RULE_FILES } from '../../src/bridge/rule-files';
import { RuleBook, encounterLayers } from '../../src/combat';
import { coveredKeysOf, hasSheetData, homeRuleOf, homeRulesFor, houseRulesFor, namesOf, ruleKeyOf, sourcesOfItem, usesOwnLibrary, type LibraryItem, type ResPart, type ShareState, type ShareView } from '../../src/library';
import type { CampaignData, CharData, HomeRuleEntry } from '../../src/sheet';
import { api } from './api';
import type { Engine } from './engine';
import { getSync, subscribeSync } from './sync';

export type { LibraryItem, ResPart, ShareState, ShareView };

/* ───────────── 版本号：库或战役资料变了，界面据此重算 ───────────── */

const listeners = new Set<() => void>();
let version = 0;
const bump = () => { version++; for (const l of listeners) l(); };
export function useLibraryVersion(): number {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => version);
}

/* ───────────── 我的库 ───────────── */

let mine: LibraryItem[] | null = null;
let mineJob: Promise<void> | null = null;
/** 上次已知的登录用户：登录 / 退出时把缓存清掉（内容跟着账户走） */
let lastUserId: number | null = null;

/** 取我自己的库（缓存；force = 重新取）。没登录 = 空 */
export function loadLibrary(force = false): Promise<void> {
  if (lastUserId === null) return Promise.resolve();
  if (mine && !force) return Promise.resolve();
  mineJob ??= api<{ items: LibraryItem[] }>('GET', 'library')
    .then((r) => { mine = r.items ?? []; }, () => { mine = mine ?? []; })
    .finally(() => { mineJob = null; bump(); });
  return mineJob;
}

export const libraryNow = (): LibraryItem[] => mine ?? [];

export function useLibrary(): LibraryItem[] {
  useLibraryVersion();
  if (!mine) void loadLibrary();
  return mine ?? [];
}

/** 存一条自己的内容；不合格返回问题列表 */
export async function saveLibraryItem(item: LibraryItem): Promise<string[]> {
  const r = await api<{ status: string; problems?: string[]; item?: LibraryItem }>('PUT', `library/items/${item.id}`, { item });
  if (r.status !== 'done' || !r.item) return r.problems ?? ['存不上'];
  mine = (mine ?? []).some((x) => x.id === item.id) ? (mine ?? []).map((x) => (x.id === item.id ? r.item! : x)) : [r.item, ...(mine ?? [])];
  bump();
  return [];
}

export async function removeLibraryItem(id: string): Promise<void> {
  await api('DELETE', `library/items/${id}`);
  mine = (mine ?? []).filter((x) => x.id !== id);
  for (const [cid, h] of hubs) if (h) hubs.set(cid, { ...h, attached: h.attached.filter((s) => !(s.itemId === id && s.item.id === id)) });
  bump();
}

export const newItemId = () => 'hr-' + Date.now().toString(36).slice(-6) + Math.random().toString(36).slice(2, 6);
export const newPartId = () => 'hr-' + Date.now().toString(36).slice(-6) + Math.random().toString(36).slice(2, 6);

/* ───────────── 战役挂上来的内容 ───────────── */

export interface Hub {
  sources: string[];
  /** 我在这个战役里的身份 */
  role?: string;
  /** 全部挂载（含待审、关掉的）——资源管理器用 */
  attached: ShareView[];
  /** 我挂上去的条目 id */
  mine: string[];
}

const hubs = new Map<string, Hub | null>();
const hubJobs = new Map<string, Promise<Hub | null>>();

/** 账户换了（登录 / 退出）：库和战役资料的缓存都作废，重新取 */
subscribeSync(() => {
  const id = getSync().user?.id ?? null;
  if (id === lastUserId) return;
  lastUserId = id;
  mine = null;
  mineJob = null;
  hubs.clear();
  hubJobs.clear();
  bump();
  if (id !== null) void loadLibrary(true);
});

export function loadHub(cid: string, force = false): Promise<Hub | null> {
  if (!force && hubs.has(cid)) return Promise.resolve(hubs.get(cid)!);
  let job = force ? undefined : hubJobs.get(cid);
  if (!job) {
    job = api<Hub>('GET', `campaigns/${cid}/hub`).then((h) => h, () => null).then((h) => {
      hubs.set(cid, h);
      hubJobs.delete(cid);
      bump();
      return h;
    });
    hubJobs.set(cid, job);
  }
  return job;
}
export const hubNow = (cid: string | null | undefined): Hub | null => (cid ? hubs.get(cid) ?? null : null);

export function useHub(cid: string | null | undefined): Hub | null {
  useLibraryVersion();
  if (cid && !hubs.has(cid)) void loadHub(cid);
  return hubNow(cid);
}

export async function setSources(cid: string, sources: string[]): Promise<void> {
  const r = await api<{ sources: string[] }>('PUT', `campaigns/${cid}/hub/sources`, { sources });
  const h = hubs.get(cid) ?? { sources: [], attached: [], mine: [] };
  hubs.set(cid, { ...h, sources: r.sources });
  bump();
}

/** 把我库里的一条挂到这个战役。返回它在战役里的状态（新内容 auto、覆盖官方 pending） */
export async function shareItem(cid: string, itemId: string): Promise<ShareState> {
  const r = await api<{ status: string; state: ShareState }>('POST', `library/items/${itemId}/share`, { campaignId: cid });
  await loadHub(cid, true);
  return r.state;
}
export async function unshareItem(cid: string, itemId: string): Promise<void> {
  await api('POST', `library/items/${itemId}/unshare`, { campaignId: cid });
  await loadHub(cid, true);
}
/** DM 的开关：这条内容在这个战役里生效不生效 */
export async function setShareState(cid: string, ownerId: number, itemId: string, state: 'on' | 'off'): Promise<void> {
  await api('POST', `campaigns/${cid}/library/state`, { ownerId, itemId, state });
  const h = hubs.get(cid);
  if (h) hubs.set(cid, { ...h, attached: h.attached.map((s) => (s.ownerId === ownerId && s.itemId === itemId ? { ...s, state } : s)) });
  bump();
}

/** 战役里生效的内容（新内容 + DM 开着的） */
export const effectiveItems = (h: Hub | null): LibraryItem[] =>
  (h?.attached ?? []).filter((s) => s.state === 'auto' || s.state === 'on').map((s) => s.item);

/** 生效的每一条 part（键 → 哪条内容），界面查「这条能力有没有补数据」用 */
export const effectiveParts = (h: Hub | null): Array<{ part: ResPart; item: LibraryItem }> =>
  effectiveItems(h).flatMap((item) => (item.parts ?? []).map((part) => ({ part, item })));

/** 一条内容挂到了哪些战役（“挂了 2 个团”的标签用） */
export function campaignsOf(itemId: string, cids: string[]): string[] {
  return cids.filter((cid) => (hubNow(cid)?.attached ?? []).some((s) => s.itemId === itemId && s.item.id === itemId));
}

export function campaignData(h: Hub | null): CampaignData | null {
  if (!h) return null;
  const items = effectiveItems(h);
  return {
    sources: h.sources,
    homerules: homeRulesFor(items),
    // 挂着的条目**只放行自己**（不放行整本书）：导入一条 EFA 的种族不该把整本 EFA 都带出来
    covered: [...new Set(items.flatMap(coveredKeysOf))],
    names: namesOf(items),
    brew: items.flatMap((x) => (x.brew ? [x.brew] : [])),
  };
}

/* ───────────── 接到规则环境上 ───────────── */

/** 让规则环境按卡上的 _campaign 找战役资料；我自己的库永远对自己的卡生效 */
export function installLibrary(engine: Engine): void {
  engine.env.campaignOf = (char: CharData) => campaignData(hubNow((char as { _campaign?: string })._campaign));
  // 卡面第 3 层：我的资料库 —— **只对没绑战役的卡生效**。
  // 绑了战役的卡一律按这个战役挂载的内容算（DM 的资源管理器说了算），否则会出现两个问题：
  //   ① 玩家能绕过 DM 在自己卡上用没挂进本团的内容；
  //   ② 同一张卡，玩家自己打开是加了私货的、DM / 别人打开又不是 —— 看到的数不一样。
  // 卡面第 3 层：我的资料库 —— **卡上勾了哪几条才生效**（默认一条都不套）。
  // 以前是「我的库全部自动生效」，等于建一条内容就悄悄改了所有卡；现在改成手动勾选（char.hrPicked）。
  engine.env.homelib.user = (char) => {
    if (!usesOwnLibrary(char as { _campaign?: string })) return [];
    const picked = new Set(((char as { hrPicked?: string[] }).hrPicked ?? []) as string[]);
    // 自制书条目的 part 是按它自己的特性键生效的（只有选了这个子职的卡才有那些特性），不用在卡上勾
    for (const it of libraryNow()) if (it.brew) for (const pt of it.parts ?? []) picked.add(pt.id);
    return pickedRulesOf(libraryNow(), picked);
  };
  // 我库里带的来源书只用来**装数据文件**，不算「启用的书」（否则导入一条就放开整本书）
  engine.env.userSources = () => [...new Set(libraryNow().flatMap(sourcesOfItem))];
  // 我库里的条目只放行它们自己（不在战役里也能选中）
  engine.env.userCovered = () => [...new Set(libraryNow().flatMap(coveredKeysOf))];
  engine.env.userNames = () => namesOf(libraryNow());
  engine.env.userBrew = () => libraryNow().flatMap((x) => (x.brew ? [x.brew] : []));
}

/**
 * 本地遭遇（不在战役里）的规则书：官方 + **我自己的资料库**。
 * 战役遭遇不走这里——它用开遭遇时抄进遭遇的那份快照（含每个参战者各自的资料库）。
 */
export function applyLocalRules(engine: Engine): void {
  const layers = encounterLayers([], [{ name: '我的资料库', rules: houseRulesFor(libraryNow()) }]);
  engine.rules = layers.length ? new RuleBook(RULE_FILES, layers) : engine.base;
}

/** 算卡前：给副本标上战役，并确保资料已经取到 */
export async function tagCampaign(char: CharData, cid: string | null | undefined): Promise<void> {
  if (!cid) return;
  (char as { _campaign?: string })._campaign = cid;
  await loadHub(cid);
}

/** 某张卡所在的战役 id */
export function cardCampaign(card: { campaignId?: string | null } | null | undefined): string | null {
  return card?.campaignId || null;
}

/** 某个键在生效内容里的战斗数据（人物卡「数据」页标「本团」用） */
export function combatPartOf(h: Hub | null, key: string, ownerId?: number): { part: ResPart; item: LibraryItem; share: ShareView } | null {
  for (const s of h?.attached ?? []) {
    if (ownerId !== undefined && s.ownerId !== ownerId) continue;
    if (s.state !== 'auto' && s.state !== 'on') continue;
    for (const part of s.item.parts ?? []) {
      if (part.combat && ruleKeyOf(part) === key) return { part, item: s.item, share: s };
    }
  }
  return null;
}

/** 生效内容里「选了才生效」的条目（人物卡上勾选） */
export function pickablesOf(h: Hub | null): Array<{ part: ResPart; item: LibraryItem }> {
  return effectiveParts(h).filter(({ part }) => part.pickable);
}

/** 卡上勾了的那几条 part → 卡面家规（没勾的一条都不给） */
export function pickedRulesOf(items: LibraryItem[], picked: Set<string>): HomeRuleEntry[] {
  const out: HomeRuleEntry[] = [];
  for (const item of items) {
    for (const part of item.parts ?? []) {
      if (!picked.has(part.id)) continue;
      const hr = homeRuleOf(part, item);
      if (hr) out.push(hr);
    }
  }
  return out;
}

/** 资料库里「能套到卡上」的那些 part（有卡面数据、能覆盖官方、或者带战斗数据） */
export const attachableOfItems = (items: LibraryItem[]): Array<{ part: ResPart; item: LibraryItem }> =>
  items.flatMap((item) => (item.parts ?? []).filter((p) => hasSheetData(p) || p.combat || (p.key && !p.key.startsWith('HR:'))).map((part) => ({ part, item })));

/** 一堆条目里「选了才生效」的那些（人物卡把你的库和本团并起来列） */
export const pickablesOfItems = (items: LibraryItem[]): Array<{ part: ResPart; item: LibraryItem }> =>
  items.flatMap((item) => (item.parts ?? []).filter((p) => p.pickable).map((part) => ({ part, item })));

/**
 * 某个条目键的战斗数据在哪：先看我自己的库（层更高），再看本团挂着的。
 * 人物卡「数据」页据此标「我的库 / 本团」。
 */
export function combatFor(key: string, h: Hub | null): { part: ResPart; item: LibraryItem; from: 'mine' | 'camp' } | null {
  for (const item of libraryNow()) {
    for (const part of item.parts ?? []) if (part.combat && ruleKeyOf(part) === key) return { part, item, from: 'mine' };
  }
  const c = combatPartOf(h, key);
  return c ? { part: c.part, item: c.item, from: 'camp' } : null;
}

/* ───────────── 5etools 书目、怪物图鉴 ───────────── */

export interface Book { id: string; name: string; enName: string; group: string; published: string }
let books: Promise<Book[]> | null = null;
export function loadBooks(engine: Engine): Promise<Book[]> {
  books ??= engine.env.store.ensure('books').then((d) => ((d?.book || []) as Array<Record<string, string>>).map((b) => ({
    id: String(b.id).toUpperCase(), name: b.name, enName: b.ENG_name ?? '', group: b.group ?? '', published: b.published ?? '',
  })));
  books.catch(() => { books = null; });
  return books;
}

/** 加怪物用的图鉴：2025 怪物图鉴 + 战役启用的书里的怪物（被重印的不算） */
export async function loadMonsters(engine: Engine, cid: string | null | undefined): Promise<Array<Record<string, unknown>>> {
  const store = engine.env.store;
  const out: Array<Record<string, unknown>> = [...((await store.ensure('bestiaryXmm'))?.monster ?? [])];
  const h = cid ? await loadHub(cid) : null;
  const want = (h?.sources ?? []).filter((s) => s !== 'XMM');
  if (!want.length) return out;
  const idx: Record<string, string> = (await store.ensure('bestiaryIndex').catch(() => null)) ?? {};
  const byUpper = new Map(Object.entries(idx).map(([k, f]) => [k.toUpperCase(), f]));
  const lists = await Promise.all(want.map((s) => {
    const f = byUpper.get(s);
    return f ? store.provider.load('/data/bestiary/' + f).then((d) => ((d as { monster?: Array<Record<string, unknown>> })?.monster ?? []), () => []) : Promise.resolve([]);
  }));
  for (const m of lists.flat()) if (!(Array.isArray(m.reprintedAs) && m.reprintedAs.length) && !m._copy) out.push(m);
  return out;
}

/** 库条目 → 卡面家规（给 SheetEnv 的战役层用；第 2 期会多一层「我的库」） */
export const homeRulesOfItem = (item: LibraryItem): HomeRuleEntry[] => homeRulesFor([item]);
