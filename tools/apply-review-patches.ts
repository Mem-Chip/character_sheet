/**
 * 把审查答案里「能用的 patch」合并进数据，并自动回退审计不过的条目。
 *
 * 流程：读 patch → 形状纠正 → 写回**原文件**（不跨文件搬家）→ 跑审计 → 把审计报错的键回退 → 再审计。
 *
 * 写法约定（和仓库一致）：手写层盖过 AI 层。所以
 *   - 键在 `data/rules-2024.json` / `data/dyn/*.json` → 写回同一个文件；
 *   - 键在 `data/dyn/ai/books.json` 里的状态 / 动作 / 精通 → 写进 `data/rules-2024.json`；
 *   - 其它 AI 键 → 按类型写进 `data/dyn/spells.json` / `items.json` / `features.json`。
 *
 * 用法：
 *   npx tsx tools/apply-review-patches.ts --dry    # 只报告
 *   npx tsx tools/apply-review-patches.ts          # 应用 + 自动回退
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { RuleBook, auditRuleBook } from '../src/combat';
import type { RuleFile } from '../src/combat';
import { RULE_FILES } from '../src/bridge/rule-files';

type Json = Record<string, any>;
const DRY = process.argv.includes('--dry');
const OUT = 'data/dyn/reviewed.json';
const HAND = ['data/rules-2024.json', 'data/dyn/spells.json', 'data/dyn/features.json', 'data/dyn/items.json', OUT];
const AI = readdirSync('data/dyn/ai').filter((f) => f.endsWith('.json')).map((f) => `data/dyn/ai/${f}`);
const FILES = [...HAND, ...AI];

/* ---------- 读现有数据 ---------- */
const books = new Map<string, Json>();
const whereNow = new Map<string, string>();
for (const f of FILES) {
  if (!existsSync(f)) continue;
  const j = JSON.parse(readFileSync(f, 'utf8')) as Json;
  books.set(f, j);
}
for (const f of AI) for (const k of Object.keys(books.get(f)?.entries ?? {})) whereNow.set(k, f);
for (const f of HAND) for (const k of Object.keys(books.get(f)?.entries ?? {})) whereNow.set(k, f);   // 手写层最后写，覆盖
const original = new Map<string, Json | null>();
for (const [k, f] of whereNow) original.set(k, JSON.parse(JSON.stringify(books.get(f)!.entries[k])));
const originalByFile = new Map<string, Json>();
for (const f of HAND) if (books.has(f)) originalByFile.set(f, JSON.parse(JSON.stringify(books.get(f))));

/** patch 一律写进 OUT（reviewed.json，最后加载）；核心的状态/动作/精通这批先跳过，留给人工 */
const targetFor = (key: string): string | null => {
  if (/:(condition|action|mastery):/.test(key)) return null;
  return OUT;
};
const existing = (key: string): Json | null => {
  const f = whereNow.get(key);
  return f ? (books.get(f)!.entries?.[key] ?? null) : null;
};

/* ---------- 形状纠正 ---------- */
const NODE_ARRAYS = ['root', 'do', 'onHit', 'onMiss', 'onFail', 'onSuccess', 'then', 'else'];
const strNode = (x: unknown): boolean => {
  if (typeof x === 'string') return true;
  if (Array.isArray(x)) return x.some(strNode);
  if (!x || typeof x !== 'object') return false;
  const o = x as Json;
  return NODE_ARRAYS.some((k) => strNode(o[k]));
};
const skeleton = (p: Json): boolean =>
  (Array.isArray(p.actions) && p.actions.some((x: Json) => strNode(x?.root)))
  || (Array.isArray(p.triggers) && p.triggers.some((x: Json) => strNode(x?.do)));

const ARRAY_FIELDS = ['statics', 'rollMods', 'triggers', 'implies', 'actions', 'root', 'do', 'onHit', 'onMiss', 'onFail', 'onSuccess', 'then', 'else', 'values', 'mods', 'grants', 'choices', 'resources'];
/** 没写 `kind` 的节点：按字段猜（LLM 常省略），猜不出就返回 null 让上层丢掉 */
const inferKind = (o: Json): string | null => {
  const has = (k: string) => o[k] !== undefined;
  if (has('template')) return 'applyEffect';
  if (has('dice')) return has('to') && !has('type') ? 'damage' : 'damage';
  if (has('text') && !has('dice') && !has('template')) return 'note';
  if (has('ability') && (has('dc') || has('onFail') || has('onSuccess'))) return 'save';
  if (has('bonus') && (has('onHit') || has('onMiss'))) return 'attack';
  if (has('amount') && has('to')) return 'heal';
  if (has('value') && has('to')) return 'resource';
  if (has('id') && has('to')) return 'resource';
  if (has('skill')) return 'check';
  return null;
};
const fixNode = (n: unknown): unknown => {
  if (Array.isArray(n)) return n.map(fixNode).filter((x) => x !== null);
  if (!n || typeof n !== 'object') return n;
  const o = { ...(n as Json) };
  if (!o.kind) {
    const keys = Object.keys(o);
    if (keys.length === 1 && typeof o[keys[0]] === 'object') return { kind: keys[0], ...(o[keys[0]] as Json) };
    const k = inferKind(o);
    if (!k) return null;                       // 猜不出：这节点丢掉（比按 undefined 写进去强）
    o.kind = k;
  }
  for (const k of NODE_ARRAYS) if (o[k]) o[k] = fixNode(o[k]);
  return o;
};
const dropNonArrays = (x: unknown, path: string, notes: string[]): void => {
  if (Array.isArray(x)) { for (const y of x) dropNonArrays(y, path, notes); return; }
  if (!x || typeof x !== 'object') return;
  const o = x as Json;
  for (const k of Object.keys(o)) {
    if (ARRAY_FIELDS.includes(k) && o[k] !== undefined && !Array.isArray(o[k])) { notes.push(`${path}${k} 不是数组，删掉了`); delete o[k]; continue; }
    dropNonArrays(o[k], `${path}${k}.`, notes);
  }
};
const normalize = (e: Json): string[] => {
  const notes: string[] = [];
  for (const t of Array.isArray(e.triggers) ? e.triggers : []) {
    if (Array.isArray(t.modify)) {
      t.modify = t.modify.map((m: unknown) => {
        if (typeof m === 'string') { notes.push(`modify「${m}」→ {op}`); return { op: m }; }
        return m;
      });
    }
    if (t.do !== undefined) t.do = fixNode(t.do);
    if (t.when !== undefined && typeof t.when !== 'string') { delete t.when; notes.push('when 不是字符串，删了'); }
  }
  for (const a of Array.isArray(e.actions) ? e.actions : []) {
    if (a.root !== undefined) a.root = fixNode(a.root);
    if (Array.isArray(a.cost)) {
      a.cost = a.cost.map((c: unknown) => {
        if (typeof c === 'string') { notes.push(`cost「${c}」→ {economy}`); return { economy: c }; }
        return c;
      });
    }
  }
  if (Array.isArray(e.effects)) {
    const map: Json = {};
    for (const tpl of e.effects) { const nm = String(tpl?.name ?? '').trim(); if (nm) map[nm] = tpl; }
    notes.push('effects 数组 → 对象');
    e.effects = map;
  }
  // statics 里没写 kind 的丢掉（审计会当「未知静态修正」）
  for (const tpl of e.effects && !Array.isArray(e.effects) ? Object.values(e.effects as Json) : []) {
    const tt = tpl as Json;
    if (Array.isArray(tt?.statics)) {
      const before = tt.statics.length;
      tt.statics = tt.statics.filter((s: Json) => s && typeof s === 'object' && s.kind);
      if (tt.statics.length !== before) notes.push(`statics 里丢了 ${before - tt.statics.length} 条没 kind 的`);
    }
  }
  dropNonArrays(e, '', notes);
  return notes;
};

/* ---------- 收集 patch ---------- */
const answers: Array<Json & { batch: string }> = [];
for (const f of readdirSync('audit-review/answers').filter((x) => x.endsWith('.json'))) {
  const j = JSON.parse(readFileSync(`audit-review/answers/${f}`, 'utf8')) as Json;
  for (const a of j.answers ?? []) answers.push({ ...a, batch: j.batch ?? f });
}
const withPatch = answers.filter((a) => a.patch);
const usable = withPatch.filter((a) => !skeleton(a.patch));
const skeletons = withPatch.filter((a) => skeleton(a.patch));

/* ---------- 应用 ---------- */
type Rec = { key: string; file: string; verdict: string; fixes: string[]; setFull: boolean };
const applied: Rec[] = [];
const skippedCore: string[] = [];
for (const a of usable) {
  const key = String(a.key);
  const target = targetFor(key);
  if (!target) { skippedCore.push(key); continue; }
  if (!books.has(target)) books.set(target, { version: 1, note: '覆盖率审查后手写的补丁（tools/apply-review-patches.ts）', entries: {} });
  const book = books.get(target)!;
  book.entries ??= {};
  const prev = existing(key) ?? {};
  const merged: Json = { ...prev, ...a.patch };
  const fixes = normalize(merged);
  const setFull = String(a.verdict) === 'full' && Boolean(merged.actions?.length || merged.triggers?.length);
  if (setFull) merged.automation = 'full';
  else if (!merged.automation) merged.automation = prev.automation ?? 'partial';
  book.entries[key] = merged;
  whereNow.set(key, target);
  applied.push({ key, file: target, verdict: String(a.verdict), fixes, setFull });
}

/* ---------- 审计 + 自动回退（最多 6 轮） ---------- */
const handOverride = (): RuleFile[] => HAND.filter((f) => books.has(f)).map((f) => books.get(f) as unknown as RuleFile);
const auditOnce = (): Map<string, string[]> => {
  const rest = (RULE_FILES as unknown as Array<{ note?: string }>).filter((f) => !HAND.some((h) => (f as Json).note === books.get(h)?.note));
  let msgs: string[] = [];
  try { msgs = auditRuleBook(new RuleBook([...rest, ...handOverride()] as RuleFile[])); }
  catch (e) { return new Map([['__crash__', [(e as Error).message]]]); }
  const byKey = new Map<string, string[]>();
  for (const m of msgs) {
    const key = m.split(/[\s：]/)[0];
    byKey.set(key, [...(byKey.get(key) ?? []), m]);
  }
  return byKey;
};

const pruned: Array<{ key: string; why: string[] }> = [];
let crash: string | null = null;
for (let round = 0; round < 6; round++) {
  const bad = auditOnce();
  if (bad.has('__crash__')) {
    crash = bad.get('__crash__')![0];
    // 崩了：这一轮先全部回退（脚本宁可少应用，也不写坏数据）
    for (const a of applied) {
      const f = whereNow.get(a.key)!;
      delete books.get(f)!.entries[a.key];
      pruned.push({ key: a.key, why: [`审计崩了：${crash}`] });
    }
    applied.length = 0;
    break;
  }
  const mine = [...bad.entries()].filter(([k]) => applied.some((a) => a.key === k));
  if (!mine.length) break;
  for (const [key, why] of mine) {
    const f = whereNow.get(key)!;
    delete books.get(f)!.entries[key];
    pruned.push({ key, why });
  }
}

/* ---------- 写盘 ---------- */
const kept = applied.filter((a) => !pruned.some((p) => p.key === a.key));
if (!DRY) {
  const touched = new Set([OUT]);
  for (const f of touched) {
    if (!books.has(f)) continue;
    writeFileSync(f, JSON.stringify(books.get(f), null, 1) + '\n');
  }
}

/* ---------- 报告 ---------- */
const byFile = new Map<string, number>();
for (const x of kept) byFile.set(x.file, (byFile.get(x.file) ?? 0) + 1);
console.log(`${DRY ? '（干跑）' : ''}patch ${withPatch.length} 条：可用 ${usable.length}、骨架 ${skeletons.length}`);
console.log(`保留 ${kept.length} 条：`);
for (const [f, n] of byFile) console.log(`   ${f}：${n}`);
console.log(`   标成 automation=full：${kept.filter((x) => x.setFull).length}`);
console.log(`审计不过、回退 ${pruned.length} 条`);
const whyCnt = new Map<string, number>();
for (const p of pruned) for (const w of p.why) {
  const short = w.replace(/^\S+\s*/, '').slice(0, 56);
  whyCnt.set(short, (whyCnt.get(short) ?? 0) + 1);
}
for (const [w, n] of [...whyCnt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`   ${String(n).padStart(3)}× ${w}`);
if (pruned.length && !DRY) writeFileSync('audit-review/pruned.json', JSON.stringify(pruned.map((p) => ({ key: p.key, why: p.why.slice(0, 4) })), null, 1) + '\n');



