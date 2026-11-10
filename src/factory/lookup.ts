/**
 * 数据化工厂：给模型「按需查资料」用的查询函数（计划书见 AI-LOOKUP.md）。
 *
 * 模型不再一次读完整份说明书和全部例子，而是回一个 `{ "lookup": [ { "tool": "node", "q": "zone" }, … ] }`，
 * 我们用这里的函数查完把结果发回去。查的都是我们自己的东西：说明书（buildSpec 的输出）、types.ts 源码、
 * 表达式作用域、窗口表、手写的规则条目；`check` 用调用方给的检查函数。
 * 纯逻辑，浏览器和 Node 共用。
 */
import { REF_SHAPE, scopeDef, type ScopeKind } from '../combat/scope';
import { fmtSig, fmtTy, WINDOWS } from './spec';

export type LookupTool = 'spec' | 'node' | 'type' | 'window' | 'expr' | 'example' | 'check';
export const LOOKUP_TOOLS: LookupTool[] = ['spec', 'node', 'type', 'window', 'expr', 'example', 'check'];

export interface LookupReq { tool: LookupTool; q?: string; draft?: unknown }

export interface LookupSources {
  /** 说明书全文（buildSpec 的输出） */
  spec: string;
  /** src/combat/types.ts 源码 */
  typesSource: string;
  /** 手写的规则条目（键 → Entry）：example 只在这里面找，不搜 AI 写的 */
  entries: Record<string, unknown>;
}

export interface LookupCtx {
  /** 检查一份草稿（不给就不能用 check） */
  check?: (draft: unknown) => string[] | Promise<string[]>;
  /** 一轮最多几个查询（缺省 6） */
  maxPerRound?: number;
  /** 每个结果最多多少字（缺省 4000） */
  maxChars?: number;
}

interface Block { id: string; title: string; text: string }

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n)}\n…（后面还有 ${s.length - n} 字，截掉了）`);
const norm = (s: string) => s.trim().toLowerCase();

/* ───────────── 说明书切块 ───────────── */

/**
 * 按 `##` / `###` 标题切；再细一点：
 * - 第 5 节「约定」里的编号条目（`23. **…**`）各算一块，id 是 `5.23`；
 * - 第 4 节窗口表后面那些加粗开头的段落（`**地图区域**（…）`）各算一块，id 是 `4.1`、`4.2`…
 */
export function splitSpec(spec: string): Block[] {
  const out: Block[] = [];
  let cur: Block | null = null;
  let section = '';
  let para = 0;
  const push = () => { if (cur && cur.text.trim()) out.push({ ...cur, text: cur.text.trim() }); };
  for (const line of spec.split('\n')) {
    const h = /^(#{2,3})\s+(.*)$/.exec(line);
    const num = section === '5' ? /^(\d+)\.\s+(.+)$/.exec(line) : null;
    const bold = section === '4' ? /^\*\*(.+?)\*\*/.exec(line) : null;
    if (bold) {
      push();
      cur = { id: `4.${++para}`, title: bold[1], text: `${line}\n` };
    } else if (h) {
      push();
      const idm = /^(\d+(?:\.\d+)?)\.?\s/.exec(h[2]);
      if (h[1] === '##') section = idm ? idm[1].split('.')[0] : '';
      cur = { id: idm ? idm[1] : h[2], title: h[2], text: `${line}\n` };
    } else if (num) {
      push();
      cur = { id: `5.${num[1]}`, title: /\*\*(.+?)\*\*/.exec(num[2])?.[1] ?? num[2].slice(0, 30), text: `${line}\n` };
    } else if (cur) {
      cur.text += `${line}\n`;
    } else {
      cur = { id: '0', title: '开头', text: `${line}\n` };
    }
  }
  push();
  return out;
}

/** 关键词查说明书：章节号直接取；否则按命中次数排，标题里命中的加分 */
function searchSpec(blocks: Block[], q: string): Block[] {
  const exact = blocks.find((b) => b.id === q.trim());
  if (exact) return [exact];
  const words = q.split(/[\s,，、]+/).map(norm).filter(Boolean);
  if (!words.length) return [];
  // 第 2 节是整份 types.ts：关键词全会命中它，类型定义改用 node / type 查
  return blocks
    .filter((b) => b.id !== '2')
    .map((b) => {
      const t = b.text.toLowerCase();
      let score = 0;
      for (const w of words) {
        const n = t.split(w).length - 1;
        if (!n) return { b, score: 0 };
        score += n + (b.title.toLowerCase().includes(w) ? 5 : 0);
      }
      return { b, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((x) => x.b);
}

/* ───────────── types.ts 切块 ───────────── */

/**
 * 两种块：顶层声明（`export interface X` / `export type X`）、联合里的成员（`| { kind: 'zone' …` / `| { op: 'adv' …`）。
 * 每块都带上紧挨在它前面的 `/** … *\/` 注释 —— 很多约定写在注释里，没有注释查出来就没上下文。
 */
export function splitTypes(src: string): { decls: Map<string, string>; members: Map<string, string[]> } {
  const lines = src.split('\n');
  const decls = new Map<string, string>();
  const members = new Map<string, string[]>();
  /** 第 i 行往上，连着的注释从哪一行开始 */
  const commentStart = (i: number): number => {
    let j = i;
    while (j > 0 && /^\s*(\/\*\*|\*|\*\/|\/\/)/.test(lines[j - 1])) j--;
    return j;
  };
  const isMemberStart = (i: number) => /^\s*\|\s*\(?\{/.test(lines[i]);
  const memberName = (i: number): string | null => {
    for (let k = i; k < Math.min(lines.length, i + 3); k++) {
      const m = /\b(kind|op):\s*'([A-Za-z0-9]+)'/.exec(lines[k]);
      if (m) return m[2];
    }
    return null;
  };

  for (let i = 0; i < lines.length; i++) {
    const d = /^export (?:interface|type) (\w+)/.exec(lines[i]);
    if (d) {
      const from = commentStart(i);
      let to = i + 1;
      // 到下一个顶层声明（或它的注释）为止
      while (to < lines.length && !/^export /.test(lines[to]) && !/^\/\*/.test(lines[to])) to++;
      while (to > i + 1 && /^\s*(\/\*\*|\*|\*\/|\/\/)/.test(lines[to - 1])) to--;
      decls.set(d[1], lines.slice(from, to).join('\n').trimEnd());
    }
    if (isMemberStart(i)) {
      const name = memberName(i);
      if (!name) continue;
      const from = commentStart(i);
      let to = i + 1;
      while (to < lines.length && !isMemberStart(to) && !/^\s*\/\*\*/.test(lines[to]) && /^\s/.test(lines[to]) && lines[to].trim()) to++;
      // 最后一个成员的 `;` 留着，没关系
      const text = lines.slice(from, to).join('\n').trimEnd();
      members.set(name, [...(members.get(name) ?? []), text]);
    }
  }
  return { decls, members };
}

/* ───────────── 例子索引 ───────────── */

/** 一条条目里用到了哪些写法：节点 kind、窗口 on、modify op、引用的模板 */
function tokensOf(x: unknown, out: Set<string>): Set<string> {
  if (Array.isArray(x)) for (const v of x) tokensOf(v, out);
  else if (x && typeof x === 'object') {
    for (const [k, v] of Object.entries(x)) {
      if ((k === 'kind' || k === 'op' || k === 'event') && typeof v === 'string') out.add(v);
      if (k === 'on') for (const e of [v].flat()) if (typeof e === 'string') out.add(e);
      if (k !== 'text') tokensOf(v, out);
    }
  }
  return out;
}

function searchExamples(entries: Record<string, unknown>, index: Map<string, Set<string>>, q: string, maxChars: number): string {
  const want = q.trim();
  if (!want) return '要给 q：节点 kind、窗口名、条目键或中文词';
  if (entries[want]) return `### ${want}\n${clip(JSON.stringify(entries[want]), maxChars)}`;
  // 先按「用到了这种写法」找；找不到再按键 / 全文里的字找
  let hits = Object.keys(entries).filter((k) => index.get(k)?.has(want));
  if (!hits.length) hits = Object.keys(entries).filter((k) => k.includes(want) || JSON.stringify(entries[k]).includes(want));
  if (!hits.length) return `手写条目里没有用到「${want}」的`;
  // 短的先给：更容易看出写法
  const picked = hits.map((k) => ({ k, s: JSON.stringify(entries[k]) })).sort((a, b) => a.s.length - b.s.length).slice(0, 3);
  const each = Math.floor(maxChars / picked.length);
  return [`共 ${hits.length} 条用到「${want}」，给最短的 ${picked.length} 条：`, ...picked.map(({ k, s }) => `### ${k}\n${clip(s, each)}`)].join('\n\n');
}

/* ───────────── 表达式 ───────────── */

const SCOPES: ScopeKind[] = ['action', 'node', 'rollMod', 'trigger', 'static', 'endsOn', 'aura'];

function searchExpr(q: string): string {
  const w = q.trim();
  if ((SCOPES as string[]).includes(w)) {
    const d = scopeDef(w as ScopeKind);
    const roots = Object.entries(d.roots).map(([n, t]) => `- \`${n}\`：${fmtTy(t)}`).join('\n');
    return `「${d.name}」里能用的名字：\n${roots}\n\n函数：\n${Object.entries(d.funcs).map(([n, f]) => `- ${fmtSig(n, f)}`).join('\n')}`;
  }
  const out: string[] = [];
  const funcs = scopeDef('node').funcs;
  if (funcs[w]) out.push(`函数 ${fmtSig(w, funcs[w])}`);
  if (REF_SHAPE.fields[w]) out.push(`参与者字段 \`x.${w}\`：${fmtTy(REF_SHAPE.fields[w])}`);
  if (REF_SHAPE.methods[w]) out.push(`参与者方法 ${fmtSig(`x.${w}`, REF_SHAPE.methods[w])}`);
  for (const s of SCOPES) {
    const t = scopeDef(s).roots[w];
    if (t) out.push(`「${scopeDef(s).name}」里的 \`${w}\`：${fmtTy(t)}`);
  }
  if (out.length) return out.join('\n');
  return `没有叫「${w}」的。作用域：${SCOPES.join(' ')}；函数：${Object.keys(funcs).join(' ')}；参与者字段：${Object.keys(REF_SHAPE.fields).join(' ')}；方法：${Object.keys(REF_SHAPE.methods).join(' ')}`;
}

/* ───────────── 分发 ───────────── */

export interface Lookup {
  /** 跑一轮查询，返回发回给模型的文字 */
  run(reqs: unknown, ctx?: LookupCtx): Promise<string>;
  /** 单个查询（测试、调试用） */
  one(req: LookupReq, ctx?: LookupCtx): Promise<string>;
}

export function createLookup(src: LookupSources): Lookup {
  // 索引懒建：大多数任务只查几样
  let blocks: Block[] | null = null;
  let types: ReturnType<typeof splitTypes> | null = null;
  let exIndex: Map<string, Set<string>> | null = null;
  const specBlocks = () => (blocks ??= splitSpec(src.spec));
  const typeBlocks = () => (types ??= splitTypes(src.typesSource));
  const examples = () => (exIndex ??= new Map(Object.entries(src.entries).map(([k, e]) => [k, tokensOf(e, new Set())])));

  async function one(req: LookupReq, ctx: LookupCtx = {}): Promise<string> {
    const max = ctx.maxChars ?? 4000;
    const q = String(req.q ?? '').trim();
    switch (req.tool) {
      case 'spec': {
        const hits = searchSpec(specBlocks(), q);
        if (!hits.length) return `说明书里没有「${q}」。章节：${specBlocks().map((b) => b.id).filter((id) => /^\d/.test(id)).join(' ')}`;
        return clip(hits.map((b) => b.text).join('\n\n---\n\n'), max);
      }
      case 'node':
      case 'type': {
        const t = typeBlocks();
        const found = [...(t.members.get(q) ?? []), ...(t.decls.has(q) ? [t.decls.get(q)!] : [])];
        if (!found.length) {
          const names = req.tool === 'node' ? [...t.members.keys()] : [...t.decls.keys()];
          return `没有「${q}」。可以查的：${names.join(' ')}`;
        }
        return clip(found.join('\n\n'), max);
      }
      case 'window': {
        const rows = WINDOWS.filter(([w]) => w.split(' / ').includes(q));
        if (!rows.length) return `没有窗口「${q}」。有：${[...new Set(WINDOWS.flatMap(([w]) => w.split(' / ')))].join(' ')}`;
        return rows.map(([w, win, who, reads, mods]) => `${w}（${win}）\n- 发起者 / 承受者：${who}\n- 能读：${reads}\n- 能用的修改：${mods}`).join('\n\n');
      }
      case 'expr': return clip(searchExpr(q), max);
      case 'example': return searchExamples(src.entries, examples(), q, max);
      case 'check': {
        if (!ctx.check) return '这次不能用 check';
        if (req.draft === undefined) return 'check 要把草稿放在 draft 字段里';
        try {
          const p = await ctx.check(req.draft);
          return p.length ? `检查没过：\n${p.map((x) => `- ${x}`).join('\n')}` : '检查通过';
        } catch (e) {
          return `检查出错：${(e as Error).message}`;
        }
      }
      default: return `不认识的工具「${String((req as { tool?: unknown }).tool)}」。有：${LOOKUP_TOOLS.join(' ')}`;
    }
  }

  async function run(reqs: unknown, ctx: LookupCtx = {}): Promise<string> {
    const list = Array.isArray(reqs) ? reqs : [reqs];
    const n = ctx.maxPerRound ?? 6;
    const parts: string[] = [];
    for (const [i, r] of list.slice(0, n).entries()) {
      const req = (r && typeof r === 'object' ? r : {}) as LookupReq;
      const head = `## 查询 ${i + 1}：${req.tool ?? '?'}${req.q ? ` ${req.q}` : ''}`;
      parts.push(`${head}\n\n${await one(req, ctx)}`);
    }
    if (list.length > n) parts.push(`（一次最多查 ${n} 个，后面 ${list.length - n} 个没查）`);
    return parts.join('\n\n');
  }

  return { run, one };
}

/** 模型这一轮回的是查询请求（而不是答卷） */
export function isLookupReq(a: unknown): a is { lookup: unknown[] } {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return false;
  const keys = Object.keys(a);
  return keys.length === 1 && keys[0] === 'lookup' && Array.isArray((a as { lookup: unknown }).lookup);
}
