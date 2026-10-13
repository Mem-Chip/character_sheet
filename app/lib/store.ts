/**
 * 页面状态：角色卡库、当前页、主题。存 localStorage。
 * 角色只存「玩家填的东西」（不带 `_` 开头的派生物）；派生结果每次现算。
 */
import { useSyncExternalStore } from 'react';
import { blankCharacter, type CharData } from '../../src/sheet';

export type Page = 'library' | 'sheet' | 'combat';
export type Theme = 'light' | 'dark';

export interface Card {
  id: string;
  char: CharData;
  updatedAt: number;
}

export interface AppState {
  cards: Record<string, Card>;
  order: string[];
  currentId: string | null;
  page: Page;
  theme: Theme;
}

const KEY = 'dnd2024-engine:v1';
const THEME_KEY = 'dnd2024-engine:theme';

export const stripDerived = (c: CharData): CharData =>
  Object.fromEntries(Object.entries(c).filter(([k]) => !k.startsWith('_'))) as CharData;

function load(): AppState {
  let theme: Theme = 'light';
  try {
    const t = localStorage.getItem(THEME_KEY);
    if (t === 'dark' || t === 'light') theme = t;
    else if (matchMedia('(prefers-color-scheme: dark)').matches) theme = 'dark';
  } catch { /* 隐私模式：用默认 */ }
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw) as Partial<AppState>;
      return { cards: s.cards ?? {}, order: s.order ?? [], currentId: s.currentId ?? null, page: s.page ?? 'library', theme };
    }
  } catch { /* 坏了就从空的开始 */ }
  return { cards: {}, order: [], currentId: null, page: 'library', theme };
}

let state: AppState = load();
const listeners = new Set<() => void>();

function persist(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ cards: state.cards, order: state.order, currentId: state.currentId, page: state.page }));
    localStorage.setItem(THEME_KEY, state.theme);
  } catch { /* 存不下（配额）：这次会话照常用 */ }
}

function set(next: Partial<AppState>): void {
  state = { ...state, ...next };
  persist();
  for (const l of listeners) l();
}

export function useApp(): AppState {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => state);
}
export const getApp = () => state;

const newId = () => 'c-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

export const actions = {
  go(page: Page) { set({ page }); },
  setTheme(theme: Theme) {
    document.documentElement.dataset.theme = theme;
    set({ theme });
  },
  open(id: string) { set({ currentId: id, page: 'sheet' }); },

  create(seed: Partial<CharData> = {}): string {
    const id = newId();
    const char = { ...blankCharacter(), name: '新角色', ...seed };
    set({ cards: { ...state.cards, [id]: { id, char, updatedAt: Date.now() } }, order: [id, ...state.order], currentId: id, page: 'sheet' });
    return id;
  },

  /** 改一张卡：在副本上改，改完整体替换（React 能看出变化） */
  update(id: string, fn: (c: CharData) => void): void {
    const card = state.cards[id];
    if (!card) return;
    const char = structuredClone(stripDerived(card.char));
    fn(char);
    set({ cards: { ...state.cards, [id]: { ...card, char, updatedAt: Date.now() } } });
  },

  replace(id: string, char: CharData): void {
    const card = state.cards[id];
    if (!card) return;
    set({ cards: { ...state.cards, [id]: { ...card, char: stripDerived(char), updatedAt: Date.now() } } });
  },

  remove(id: string): void {
    const cards = { ...state.cards };
    delete cards[id];
    set({ cards, order: state.order.filter((x) => x !== id), currentId: state.currentId === id ? null : state.currentId });
  },

  duplicate(id: string): void {
    const card = state.cards[id];
    if (!card) return;
    actions.create({ ...structuredClone(card.char), name: `${card.char.name || '未命名'}（副本）` });
  },

  /** 导入：本项目的导出、原项目的导出（{ char }）、或者裸角色对象都认 */
  importJson(text: string): string {
    const j = JSON.parse(text);
    const char = j?.char && typeof j.char === 'object' ? j.char : j;
    if (!char || typeof char !== 'object' || !('abilities' in char || 'classes' in char)) throw new Error('这不像一张人物卡');
    return actions.create(stripDerived({ ...blankCharacter(), ...char }));
  },

  exportJson(id: string): string {
    const card = state.cards[id];
    return JSON.stringify({ app: 'dnd2024-engine', exportedAt: new Date().toISOString(), char: stripDerived(card.char) }, null, 1);
  },
};

if (typeof document !== 'undefined') document.documentElement.dataset.theme = state.theme;
