/**
 * 在 Node 的 vm 里跑**原项目**的构建产物（人物卡.html 里的应用脚本），把它当「参照实现」。
 *
 * 只用于生成对比夹具（tests/fixtures/oracle/），移植版的测试本身不依赖原项目。
 * 数据从本地缓存 data/5etools/ 读（npm run fetch:data），能力数据读 data/abilities-2024.json。
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import vm from 'node:vm';

const ROOT = resolve(import.meta.dirname, '..', '..');
export const ORIGINAL_HTML = process.env.DND_ORIGINAL_HTML
  ?? resolve(ROOT, '..', 'dsh-p', 'dnd', 'dnd2024-sheet', '人物卡.html');

/* ---------------- 最小 DOM 桩：只够原脚本启动 ---------------- */
class El {
  tagName: string;
  children: unknown[] = [];
  attrs: Record<string, unknown> = {};
  style: Record<string, unknown> = {};
  dataset: Record<string, unknown> = {};
  className = '';
  textContent = '';
  innerHTML = '';
  value = '';
  nodeType = 1;
  scrollTop = 0;
  scrollHeight = 0;
  classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
  constructor(tag: string) { this.tagName = String(tag).toUpperCase(); }
  setAttribute(k: string, v: unknown) { this.attrs[k] = v; }
  getAttribute(k: string) { return this.attrs[k]; }
  removeAttribute(k: string) { delete this.attrs[k]; }
  append(...kids: unknown[]) { for (const k of kids) if (k != null) this.children.push(k); }
  prepend(...kids: unknown[]) { this.children.unshift(...kids.filter((k) => k != null)); }
  appendChild(k: unknown) { this.children.push(k); return k; }
  replaceChildren(...kids: unknown[]) { this.children = kids; }
  remove() {}
  addEventListener() {}
  removeEventListener() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
  closest() { return null; }
  focus() {}
  blur() {}
  click() {}
  scrollIntoView() {}
  getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0 }; }
}

export interface Oracle {
  /** 取原脚本里的任意顶层名字（const 声明不在全局对象上，要在同一个上下文里求值） */
  get(name: string): any;
  Character: any;
  Store: any;
  Abilities: any;
  Resources: any;
  FeatRules: any;
  window: any;
}

export async function loadOriginal(): Promise<Oracle> {
  if (!existsSync(ORIGINAL_HTML)) throw new Error(`找不到原项目构建产物：${ORIGINAL_HTML}（可用环境变量 DND_ORIGINAL_HTML 指定）`);
  const html = readFileSync(ORIGINAL_HTML, 'utf8');
  // 按页面顺序跑全部脚本（第一个是主题，第二个是应用；浏览器就是这样）
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  if (!scripts.some((x) => x.includes('const BASE_URL'))) throw new Error('原项目构建产物里找不到应用脚本');

  const ids = new Map<string, El>();
  const document = {
    createElement: (t: string) => new El(t),
    createTextNode: (t: string) => String(t),
    createDocumentFragment: () => new El('fragment'),
    head: new El('head'),
    body: new El('body'),
    documentElement: new El('html'),
    activeElement: null,
    getElementById: (id: string) => ids.get(id) ?? (ids.set(id, new El('div')), ids.get(id)!),
    querySelector: (sel: string) => (sel.startsWith('#') ? document.getElementById(sel.slice(1)) : null),
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
  };
  const store = new Map<string, string>();
  const localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
  };
  // IndexedDB 故意永不回调：原脚本对它有超时降级
  const indexedDB = { open() { return {}; } };

  const DATA = resolve(ROOT, 'data', '5etools');
  const fetchStub = async (url: string) => {
    const s = String(url);
    let file: string | null = null;
    if (/abilities-2024\.json/.test(s)) file = resolve(ROOT, 'data', 'abilities-2024.json');
    else {
      try {
        const p = new URL(s).pathname;
        file = resolve(DATA, '.' + decodeURIComponent(p));
      } catch {
        file = resolve(DATA, 'data', basename(s));
      }
    }
    if (!file || !existsSync(file)) {
      return { ok: false, status: 404, headers: { get: () => null }, text: async () => '', json: async () => { throw new Error('404'); } };
    }
    const text = readFileSync(file, 'utf8');
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => text, json: async () => JSON.parse(text) };
  };

  const quiet = { log() {}, error() {}, warn() {}, info() {}, debug() {} };
  const sandbox: Record<string, unknown> = {
    document, localStorage, sessionStorage: localStorage, indexedDB, fetch: fetchStub, performance, URL, URLSearchParams,
    console: quiet, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, queueMicrotask,
    requestAnimationFrame: (f: () => void) => setTimeout(f, 0),
    navigator: { userAgent: 'node', clipboard: { writeText: async () => {} } },
    location: { href: 'http://localhost/', origin: 'http://localhost', protocol: 'http:', search: '', hash: '' },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    getComputedStyle: () => ({}),
    Date, Math, JSON, Promise, isNaN, parseInt, parseFloat, Number, String, Boolean, Array, Object, Set, Map, WeakMap,
    Error, TypeError, RegExp, Symbol, Intl, structuredClone, encodeURIComponent, decodeURIComponent, AbortController,
    TextEncoder, TextDecoder, Blob: class {}, atob, btoa,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  scripts.forEach((code, i) => vm.runInContext(code, sandbox, { filename: `原项目/人物卡.html#script${i}` }));

  const w = sandbox as any;
  const NEED = ['races', 'backgrounds', 'feats', 'itemsBase', 'classIndex', 'languages'];
  for (let i = 0; i < 600; i++) {
    await new Promise((r) => setTimeout(r, 25));
    if (w.DEBUG?.Store?.data && NEED.every((k) => w.DEBUG.Store.data[k]) && w.Abilities?.data) break;
  }
  if (!w.DEBUG?.Store?.data?.races) throw new Error('原脚本没能装载数据');
  // 规则计算还要这几份（原项目在 boot 里异步装，这里确保装好）
  await w.Store.ensureMany(['items', 'optionalfeatures']);
  return { get: (name: string) => vm.runInContext(name, sandbox), Character: w.Character, Store: w.Store, Abilities: w.Abilities, Resources: w.Resources, FeatRules: w.FeatRules, window: w };
}
