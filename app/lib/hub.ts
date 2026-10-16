/**
 * 战役资料库（客户端）：每个战役启用的书 + 本团内容，按战役缓存。
 *
 * - 算卡：卡上的 _campaign（战役 id）→ 这里的资料 → SheetEnv.useCampaign（启用的书、本团家规）。
 * - 战斗：遭遇开局时服务器把本团内容的战斗部分抄进了遭遇（state.rules），不走这里。
 */
import { useSyncExternalStore } from 'react';
import type { CampaignData, CharData, HomeRuleEntry } from '../../src/sheet';
import { api } from './api';
import type { Engine } from './engine';
import { useApp } from './store';

/** 一条本团内容（和 server/hub.ts 的 HubItem 一样） */
export interface HubItem {
  id: string;
  name: string;
  text: string;
  covers?: string;
  pickable?: boolean;
  sheet?: { mods?: unknown[]; grants?: unknown[]; choices?: unknown[]; resources?: unknown[] };
  combat?: { key?: string; entry?: unknown; patch?: Record<string, unknown>; value?: unknown };
  by: string;
  reviewed: boolean;
  rev?: number;
  updated?: number;
}
export interface Hub { sources: string[]; items: HubItem[] }

const cache = new Map<string, Hub | null>();
const jobs = new Map<string, Promise<Hub | null>>();
const listeners = new Set<() => void>();
let version = 0;
const bump = () => { version++; for (const l of listeners) l(); };

/** 取一个战役的资料（缓存；force = 重新取）。不是成员 / 没登录 = null */
export function loadHub(cid: string, force = false): Promise<Hub | null> {
  if (!force && cache.has(cid)) return Promise.resolve(cache.get(cid)!);
  let job = force ? undefined : jobs.get(cid);
  if (!job) {
    job = api<Hub>('GET', `campaigns/${cid}/hub`).then((h) => h, () => null).then((h) => {
      cache.set(cid, h);
      jobs.delete(cid);
      bump();
      return h;
    });
    jobs.set(cid, job);
  }
  return job;
}
export const hubNow = (cid: string | null | undefined): Hub | null => (cid ? cache.get(cid) ?? null : null);

/** 资料变了的版本号（组件据此重算） */
export function useHubVersion(): number {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => version);
}
export function useHub(cid: string | null | undefined): Hub | null {
  useHubVersion();
  if (cid && !cache.has(cid)) void loadHub(cid);
  return hubNow(cid);
}

/* ───── 改（DM） ───── */

export async function setSources(cid: string, sources: string[]): Promise<void> {
  const r = await api<{ sources: string[] }>('PUT', `campaigns/${cid}/hub/sources`, { sources });
  const h = cache.get(cid) ?? { sources: [], items: [] };
  cache.set(cid, { ...h, sources: r.sources });
  bump();
}
/** 存一条；不合格返回问题列表 */
export async function saveItem(cid: string, item: HubItem): Promise<string[]> {
  const r = await api<{ status: string; problems?: string[]; item?: HubItem }>('PUT', `campaigns/${cid}/hub/items/${item.id}`, { item });
  if (r.status !== 'done' || !r.item) return r.problems ?? ['存不上'];
  const h = cache.get(cid) ?? { sources: [], items: [] };
  const items = h.items.some((x) => x.id === item.id) ? h.items.map((x) => (x.id === item.id ? r.item! : x)) : [...h.items, r.item];
  cache.set(cid, { ...h, items });
  bump();
  return [];
}
export async function removeItem(cid: string, id: string): Promise<void> {
  await api('DELETE', `campaigns/${cid}/hub/items/${id}`);
  const h = cache.get(cid);
  if (h) cache.set(cid, { ...h, items: h.items.filter((x) => x.id !== id) });
  bump();
}

/* ───── 接到规则环境上 ───── */

/** 一条内容的卡面部分 → 家规条目（没有卡面部分、也不覆盖什么、也不可选的 = 纯战斗，不进卡面） */
export function homeRuleOf(it: HubItem): HomeRuleEntry | null {
  if (!it.sheet && !it.covers && !it.pickable) return null;
  return {
    id: it.id, name: it.name, text: it.text, covers: it.covers ?? '', pickable: !!it.pickable,
    mods: (it.sheet?.mods ?? []) as HomeRuleEntry['mods'], grants: (it.sheet?.grants ?? []) as HomeRuleEntry['grants'],
    choices: (it.sheet?.choices ?? []) as HomeRuleEntry['choices'], resources: (it.sheet?.resources ?? []) as HomeRuleEntry['resources'],
  };
}
export function campaignData(h: Hub | null): CampaignData | null {
  if (!h) return null;
  return { sources: h.sources, homerules: h.items.map(homeRuleOf).filter((x): x is HomeRuleEntry => !!x) };
}

/** 让规则环境按卡上的 _campaign 找资料 */
export function installHub(engine: Engine): void {
  engine.env.campaignOf = (char: CharData) => campaignData(hubNow((char as { _campaign?: string })._campaign));
}

/** 算卡前：给副本标上战役，并确保资料已经取到 */
export async function tagCampaign(char: CharData, cid: string | null | undefined): Promise<void> {
  if (!cid) return;
  (char as { _campaign?: string })._campaign = cid;
  await loadHub(cid);
}

/** 某张卡所在的战役 id */
export function useCardCampaign(cardId: string | null): string | null {
  const app = useApp();
  return (cardId && app.cards[cardId]?.campaignId) || null;
}

/** 5etools 的书目（books.json），按出版时间 */
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
