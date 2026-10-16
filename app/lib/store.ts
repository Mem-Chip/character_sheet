/**
 * 页面状态：角色卡库、当前页、主题。存 localStorage。
 * 角色只存「玩家填的东西」（不带 `_` 开头的派生物）；派生结果每次现算。
 */
import { useSyncExternalStore } from 'react';
import { blankCharacter, type CharData } from '../../src/sheet';

export type Page = 'library' | 'sheet' | 'combat' | 'campaigns';
export type Theme = 'light' | 'dark';

export interface Card {
  id: string;
  char: CharData;
  updatedAt: number;
  /** 服务器上的修订号（没有 = 只在本机） */
  rev?: number;
  /** 本机改过、还没传上去 */
  dirty?: boolean;
  /** 卡主（登录后从服务器来；没有 = 自己的本机卡） */
  owner?: { id: number; name: string };
  campaignId?: string | null;
  /** 登录时选了「不上传」的本机卡 */
  localOnly?: boolean;
}

/** 同步层（sync.ts）挂进来的回调：卡变了 / 删了 */
const hooks = { changed: () => {}, removed: (_card: Card) => {} };
export function setStoreHooks(h: Partial<typeof hooks>): void { Object.assign(hooks, h); }

export interface AppState {
  cards: Record<string, Card>;
  order: string[];
  currentId: string | null;
  page: Page;
  theme: Theme;
  palette: Palette;
  width: PageWidth;
  termDelay: number;
}

/** 页面最大宽度（人物卡、卡片库这些页；地图视图总是铺满） */
export type PageWidth = 'narrow' | 'medium' | 'wide';
export const WIDTHS: Array<[PageWidth, string]> = [['narrow', '窄'], ['medium', '中'], ['wide', '宽']];

/** 配色（和浅色 / 深色独立）：灰蓝、灰绿、典籍（米纸 + 陶赭）、极简（纯黑灰阶） */
export type Palette = 'slate' | 'sage' | 'codex' | 'minimal';
export const PALETTES: Array<[Palette, string]> = [['slate', '灰蓝'], ['sage', '灰绿'], ['codex', '典籍'], ['minimal', '极简']];

/** 词条悬浮提示延迟（毫秒）：-1 为关闭悬停，0 为即时，>0 为延迟毫秒数 */
export const TERM_DELAYS: Array<[number, string]> = [
  [-1, '关闭'],
  [0, '即时 (0ms)'],
  [200, '快速 (200ms)'],
  [400, '中速 (400ms)'],
  [700, '稍慢 (700ms)'],
  [1200, '慢速 (1.2s)'],
];

const KEY = 'dnd2024-engine:v1';
const THEME_KEY = 'dnd2024-engine:theme';
const PALETTE_KEY = 'dnd2024-engine:palette';
const WIDTH_KEY = 'dnd2024-engine:width';
const TERM_DELAY_KEY = 'dnd2024-engine:term-delay';

export const stripDerived = (c: CharData): CharData =>
  Object.fromEntries(Object.entries(c).filter(([k]) => !k.startsWith('_'))) as CharData;

function load(): AppState {
  let theme: Theme = 'light';
  let palette: Palette = 'slate';
  let width: PageWidth = 'medium';
  let termDelay = 300;
  try {
    const td = localStorage.getItem(TERM_DELAY_KEY);
    if (td != null && !isNaN(Number(td))) termDelay = Number(td);
    const w = localStorage.getItem(WIDTH_KEY);
    if (WIDTHS.some(([k]) => k === w)) width = w as PageWidth;
    const p = localStorage.getItem(PALETTE_KEY);
    if (PALETTES.some(([k]) => k === p)) palette = p as Palette;
    const t = localStorage.getItem(THEME_KEY);
    if (t === 'dark' || t === 'light') theme = t;
    else if (matchMedia('(prefers-color-scheme: dark)').matches) theme = 'dark';
  } catch { /* 隐私模式：用默认 */ }
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw) as Partial<AppState>;
      return { cards: s.cards ?? {}, order: s.order ?? [], currentId: s.currentId ?? null, page: s.page ?? 'library', theme, palette, width, termDelay };
    }
  } catch { /* 坏了就从空的开始 */ }
  return { cards: {}, order: [], currentId: null, page: 'library', theme, palette, width, termDelay };
}

let state: AppState = load();
const listeners = new Set<() => void>();

function persist(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ cards: state.cards, order: state.order, currentId: state.currentId, page: state.page }));
    localStorage.setItem(THEME_KEY, state.theme);
    localStorage.setItem(PALETTE_KEY, state.palette);
    localStorage.setItem(WIDTH_KEY, state.width);
    localStorage.setItem(TERM_DELAY_KEY, String(state.termDelay));
  } catch { /* 存不下（配额）：这次会话照常用 */ }
}

function set(next: Partial<AppState>): void {
  state = { ...state, ...next };
  persist();
  for (const l of listeners) l();
  if (next.cards) hooks.changed();
}

/** 同步层用：直接换掉卡（不标「改过」） */
export function setCards(cards: Record<string, Card>, order: string[]): void {
  set({ cards, order, currentId: state.currentId && cards[state.currentId] ? state.currentId : null });
}

export function useApp(): AppState {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => state);
}
export const getApp = () => state;

export const newId = () => 'c-' + crypto.randomUUID();

export const actions = {
  go(page: Page) { set({ page }); },
  setTheme(theme: Theme) {
    document.documentElement.dataset.theme = theme;
    set({ theme });
  },
  setPalette(palette: Palette) {
    document.documentElement.dataset.palette = palette;
    set({ palette });
  },
  setWidth(width: PageWidth) {
    document.documentElement.dataset.width = width;
    set({ width });
  },
  setTermDelay(termDelay: number) {
    set({ termDelay });
  },
  open(id: string) { set({ currentId: id, page: 'sheet' }); },

  create(seed: Partial<CharData> = {}): string {
    const id = newId();
    const char = { ...blankCharacter(), name: '新角色', ...seed };
    set({ cards: { ...state.cards, [id]: { id, char, updatedAt: Date.now(), dirty: true } }, order: [id, ...state.order], currentId: id, page: 'sheet' });
    return id;
  },

  /** 改一张卡：在副本上改，改完整体替换（React 能看出变化） */
  update(id: string, fn: (c: CharData) => void): void {
    const card = state.cards[id];
    if (!card) return;
    const char = structuredClone(stripDerived(card.char));
    fn(char);
    set({ cards: { ...state.cards, [id]: { ...card, char, updatedAt: Date.now(), dirty: true } } });
  },

  replace(id: string, char: CharData): void {
    const card = state.cards[id];
    if (!card) return;
    set({ cards: { ...state.cards, [id]: { ...card, char: stripDerived(char), updatedAt: Date.now(), dirty: true } } });
  },

  remove(id: string): void {
    const cards = { ...state.cards };
    const gone = cards[id];
    delete cards[id];
    if (gone) hooks.removed(gone);
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

if (typeof document !== 'undefined') {
  document.documentElement.dataset.theme = state.theme;
  document.documentElement.dataset.palette = state.palette;
  document.documentElement.dataset.width = state.width;
}
