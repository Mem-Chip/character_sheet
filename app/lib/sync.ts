/**
 * 账户与人物卡同步（SERVER-DESIGN.md 第七节）。
 *
 * - 不登录：和以前一样，卡只在本机。
 * - 登录后：卡 = 本机缓存 + 服务器副本，带修订号。本机改了就标「改过」，过一会儿传上去；
 *   传的时候带上次同步的修订号，服务器上的卡在别处被改过就拒收（409）——这时服务器的版本留在原卡上，
 *   本机的版本另存一张「冲突副本」，两份都不丢，让人自己挑。
 * - 第一次登录：问一次要不要把本机的卡传上去，不自动传。
 * - DM 能看到挂在自己战役里的玩家的卡（卡片库里标「来自 某某」），战斗后可以写回生命值和资源。
 */
import { useSyncExternalStore } from 'react';
import { api, ApiError, type ServerCard, type User } from './api';
import { getApp, newId, setCards, setStoreHooks, type Card } from './store';
import type { CharData } from '../../src/sheet';

export interface SyncState {
  user: User | null;
  /** 还没问过服务器 */
  checking: boolean;
  status: 'idle' | 'syncing' | 'error';
  message: string;
  /** 每次变化 +1 */
  version: number;
}

const DELETES_KEY = 'dnd2024-engine:pending-deletes';
let st: SyncState = { user: null, checking: true, status: 'idle', message: '', version: 0 };
const listeners = new Set<() => void>();

function set(next: Partial<SyncState>): void {
  st = { ...st, ...next, version: st.version + 1 };
  for (const l of listeners) l();
}

export function useSync(): SyncState {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => st);
}
export const getSync = () => st;
/** 订阅账户状态（资料库用它判断登录 / 退出，好清掉缓存） */
export function subscribeSync(l: () => void): () => void { listeners.add(l); return () => listeners.delete(l); }

/* ───── 待删除（离线时删的卡，下次联网再告诉服务器） ───── */

function pendingDeletes(): string[] {
  try { return JSON.parse(localStorage.getItem(DELETES_KEY) || '[]'); } catch { return []; }
}
function savePendingDeletes(ids: string[]): void {
  try { localStorage.setItem(DELETES_KEY, JSON.stringify(ids)); } catch { /* 存不下就算了 */ }
}

/* ───── 哪些卡该传 ───── */

const mine = (c: Card) => !c.owner || c.owner.id === st.user?.id;
const shouldPush = (c: Card) => !!st.user && !!c.dirty && !c.localOnly;

let timer: ReturnType<typeof setTimeout> | undefined;
function schedule(ms = 1200): void {
  if (!st.user) return;
  clearTimeout(timer);
  timer = setTimeout(() => { void push(); }, ms);
}

setStoreHooks({
  changed: () => { if (Object.values(getApp().cards).some(shouldPush)) schedule(); },
  removed: (card) => {
    if (card.rev && mine(card)) {
      savePendingDeletes([...new Set([...pendingDeletes(), card.id])]);
      schedule(300);
    }
  },
});

let pushing = false;
let again = false;

async function push(): Promise<void> {
  if (!st.user) return;
  if (pushing) { again = true; return; }
  pushing = true;
  set({ status: 'syncing' });
  try {
    for (const id of pendingDeletes()) {
      await api('DELETE', `cards/${id}`).catch((e) => { if (!(e instanceof ApiError) || e.status === 0) throw e; });
      savePendingDeletes(pendingDeletes().filter((x) => x !== id));
    }
    for (const card of Object.values(getApp().cards).filter(shouldPush)) {
      const sentAt = card.updatedAt;
      try {
        const r = await api<{ rev: number }>('PUT', `cards/${card.id}`, { char: card.char, baseRev: card.rev ?? 0 });
        const now = getApp();
        const cur = now.cards[card.id];
        if (!cur) continue;
        // 传的过程中又改了：修订号记上，「改过」留着，下一轮再传
        const still = cur.updatedAt !== sentAt;
        setCards({ ...now.cards, [card.id]: { ...cur, rev: r.rev, dirty: still, owner: cur.owner ?? st.user! } }, now.order);
        if (still) again = true;
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
        if (e.status === 409) conflict(card, e.data.card as ServerCard);
        else if (e.status === 410) drop(card.id);
        else if (e.status === 403) markLocal(card.id, e.message);
        else throw e;
      }
    }
    set({ status: 'idle', message: '' });
  } catch (e) {
    set({ status: 'error', message: (e as Error).message });
    schedule(15000);
  } finally {
    pushing = false;
    if (again) { again = false; schedule(200); }
  }
}

/** 服务器上的卡在别处改过：原卡换成服务器的版本，本机的版本另存一张 */
function conflict(local: Card, server: ServerCard): void {
  const now = getApp();
  const copyId = newId();
  const copy: Card = {
    id: copyId, updatedAt: Date.now(), dirty: true,
    char: { ...local.char, name: `${local.char.name || '未命名'}（本机冲突副本）` },
  };
  setCards({
    ...now.cards,
    [local.id]: fromServer(server, now.cards[local.id]),
    [copyId]: copy,
  }, [copyId, ...now.order]);
  set({ message: `「${local.char.name || '未命名'}」在别处改过了：服务器的版本留在原卡上，本机的改动另存成了「冲突副本」` });
}

function drop(id: string): void {
  const now = getApp();
  const cards = { ...now.cards };
  delete cards[id];
  setCards(cards, now.order.filter((x) => x !== id));
}

function markLocal(id: string, why: string): void {
  const now = getApp();
  const cur = now.cards[id];
  if (cur) setCards({ ...now.cards, [id]: { ...cur, localOnly: true, dirty: false } }, now.order);
  set({ message: why });
}

function fromServer(s: ServerCard, prev?: Card): Card {
  return {
    id: s.id, rev: s.rev, dirty: false, owner: s.owner, campaignId: s.campaignId,
    updatedAt: s.updated, char: (s.char ?? {}) as CharData,
    ...(prev && prev.updatedAt > s.updated ? { updatedAt: prev.updatedAt } : {}),
  };
}

/** 从服务器取：新的加进来，没改过的本机卡换成新版本，删掉的删掉；本机改过的留到传的时候处理冲突 */
export async function pull(): Promise<void> {
  if (!st.user) return;
  set({ status: 'syncing' });
  try {
    const { cards: remote } = await api<{ cards: ServerCard[] }>('GET', 'cards');
    const now = getApp();
    const cards = { ...now.cards };
    let order = [...now.order];
    const seen = new Set<string>();
    for (const s of remote) {
      seen.add(s.id);
      const local = cards[s.id];
      if (s.deleted) {
        if (local && !local.dirty) { delete cards[s.id]; order = order.filter((x) => x !== s.id); }
        continue;
      }
      if (!local) { cards[s.id] = fromServer(s); order.push(s.id); continue; }
      if (local.dirty) { cards[s.id] = { ...local, owner: s.owner, campaignId: s.campaignId }; continue; }
      cards[s.id] = s.rev > (local.rev ?? 0) ? fromServer(s, local) : { ...local, rev: s.rev, owner: s.owner, campaignId: s.campaignId };
    }
    // 服务器上看不到了的服务器卡（比如玩家把卡移出了你的战役）：从本机拿掉
    for (const [id, c] of Object.entries(cards)) {
      if (c.rev && !seen.has(id) && !c.dirty) { delete cards[id]; order = order.filter((x) => x !== id); }
    }
    setCards(cards, order);
    set({ status: 'idle' });
    void push();
  } catch (e) {
    set({ status: 'error', message: (e as Error).message });
  }
}

/* ───── 登录、注册、退出 ───── */

export async function init(): Promise<void> {
  try {
    const { user } = await api<{ user: User | null }>('GET', 'me');
    set({ user, checking: false });
    if (user) await pull();
  } catch {
    // 没有后端（本地只开了前端）：当作没登录
    set({ checking: false });
  }
  window.addEventListener('focus', () => {
    if (st.user && Date.now() - lastPull > 30_000) { lastPull = Date.now(); void pull(); }
  });
}
let lastPull = 0;

/** 登录后：本机还没上传的卡要不要传（返回这些卡的数量，界面上问） */
export function unsyncedLocalCards(): Card[] {
  return Object.values(getApp().cards).filter((c) => !c.rev && !c.owner && !c.localOnly);
}

export function uploadLocal(ids: string[], yes: boolean): void {
  const now = getApp();
  const cards = { ...now.cards };
  for (const id of ids) if (cards[id]) cards[id] = { ...cards[id], dirty: yes, localOnly: !yes };
  setCards(cards, now.order);
  if (yes) schedule(100);
}

/** 单张本机卡：传上去 */
export function uploadOne(id: string): void { uploadLocal([id], true); }

export async function login(name: string, password: string, register: boolean): Promise<void> {
  const { user } = await api<{ user: User }>('POST', register ? 'register' : 'login', { name, password });
  set({ user, message: '' });
  // 新卡在登录前建的、标着「改过」：先别传，等界面问过再说
  const now = getApp();
  const cards = { ...now.cards };
  for (const c of Object.values(cards)) if (!c.rev && !c.owner && !c.localOnly && c.dirty) cards[c.id] = { ...c, dirty: false };
  setCards(cards, now.order);
  await pull();
}

/** 退出：服务器来的卡从本机拿掉（还在服务器上，下次登录回来），只在本机的卡留着 */
export async function logout(): Promise<void> {
  await push().catch(() => {});
  await api('POST', 'logout').catch(() => {});
  const now = getApp();
  const keep = Object.fromEntries(Object.entries(now.cards).filter(([, c]) => !c.rev));
  setCards(keep, now.order.filter((id) => keep[id]));
  savePendingDeletes([]);
  set({ user: null, status: 'idle', message: '' });
}

export async function changePassword(old: string, password: string): Promise<void> {
  await api('POST', 'password', { old, password });
}

export { push as syncNow };
