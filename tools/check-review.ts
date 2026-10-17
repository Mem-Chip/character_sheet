/**
 * 自检脚本（给审查工作包用）：校验 audit-review/answers/ 的格式，并把答案里的 patch 跑一遍数据检查。
 *
 *   npx tsx tools/check-review.ts            # 校验已交的答案
 *   npx tsx tools/check-review.ts --all      # 另外列出还没交的批
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { RuleBook, auditRuleBook } from '../src/combat';
import type { RuleFile } from '../src/combat';
import { lintEntry } from '../src/factory/lint';
import { RULE_FILES } from '../src/bridge/rule-files';

type Json = Record<string, any>;

const DIR = 'audit-review';
const index = JSON.parse(readFileSync(`${DIR}/tasks/index.json`, 'utf8')) as {
  total: number; batches: number; items: Array<{ batch: string; file: string; count: number; keys: string[] }>;
};
const VERDICTS = new Set(['full', 'partial', 'manual']);
const problems: string[] = [];
let answered = 0;
let entriesAnswered = 0;
const dist: Record<string, number> = { full: 0, partial: 0, manual: 0 };
const patches: Json[] = [];
const notYet: string[] = [];
const skeletons: Array<{ key: string; batch: string }> = [];
/** 节点数组里有没有写字符串（`"root": ["applyEffect"]` 这种骨架：只有节点名、没有内容） */
const NODE_ARRAYS = ['root', 'do', 'onHit', 'onMiss', 'onFail', 'onSuccess', 'then', 'else'];
const strNode = (x: unknown): boolean => {
  if (typeof x === 'string') return true;
  if (Array.isArray(x)) return x.some(strNode);
  if (!x || typeof x !== 'object') return false;
  const o = x as Json;
  return NODE_ARRAYS.some((k) => strNode(o[k]));
};
const hasSkeleton = (p: Json): boolean =>
  (Array.isArray(p.actions) && p.actions.some((x: Json) => strNode(x?.root)))
  || (Array.isArray(p.triggers) && p.triggers.some((x: Json) => strNode(x?.do)));

for (const item of index.items) {
  const p = `${DIR}/answers/${item.batch}.json`;
  if (!existsSync(p)) { notYet.push(item.batch); continue; }
  let j: Json;
  try {
    j = JSON.parse(readFileSync(p, 'utf8')) as Json;
  } catch (e) {
    problems.push(`✗ ${item.batch}：不是合法 JSON（${(e as Error).message}）`);
    continue;
  }
  answered++;
  if (j.batch !== item.batch) problems.push(`✗ ${item.batch}：文件里写的 batch 是「${j.batch}」`);
  const list = (j.answers ?? []) as Json[];
  const seen = new Map<string, Json>();
  for (const a of list) {
    const key = String(a.key ?? '');
    if (!key) { problems.push(`✗ ${item.batch}：有条答案没有 key`); continue; }
    if (!item.keys.includes(key)) problems.push(`✗ ${item.batch}：「${key}」不在这批里`);
    if (seen.has(key)) problems.push(`✗ ${item.batch}：「${key}」答了两次`);
    seen.set(key, a);
    if (!VERDICTS.has(String(a.verdict))) problems.push(`✗ ${item.batch}「${key}」：verdict 只能是 full / partial / manual`);
    if (!String(a.why ?? '').trim()) problems.push(`✗ ${item.batch}「${key}」：why 不能空`);
    if (a.missing != null && !Array.isArray(a.missing)) problems.push(`✗ ${item.batch}「${key}」：missing 要是数组`);
    if (a.verdict === 'manual' && Array.isArray(a.missing) && a.missing.length) problems.push(`（提示）${item.batch}「${key}」：manual 还写了 missing，确认一下是不是 partial`);
    if (a.patch) {
      if (hasSkeleton(a.patch)) skeletons.push({ key, batch: item.batch });
      else patches.push({ key, batch: item.batch, patch: a.patch });
    }
    dist[String(a.verdict)] = (dist[String(a.verdict)] ?? 0) + 1;
  }
  entriesAnswered += seen.size;
  for (const k of item.keys) if (!seen.has(k)) problems.push(`✗ ${item.batch}：漏了「${k}」`);
}

/* patch 过一遍数据检查：形状 lint + 规则书审计（都包 try/catch —— 形状错到让检查器自己崩，也要报出来而不是整个挂掉） */
if (patches.length) {
  const bad: string[] = [];
  const files = new Map<string, Json>();
  for (const { key, patch, batch } of patches) {
    const e = { name: patch.name ?? key.split(':').pop(), ...patch };
    const ctx = { files: RULE_FILES };
    try {
      for (const msg of lintEntry(key, e, ctx)) bad.push(`${batch}「${key}」lint：${msg}`);
    } catch (err) {
      bad.push(`${batch}「${key}」lint 崩了（形状不对）：${(err as Error).message}`);
    }
    files.set(key, e);
  }
  if (files.size) {
    // 带上核心规则文件：patch 里会引用 core.* 参数
    const rule = new RuleBook([...RULE_FILES, { note: 'review', entries: Object.fromEntries(files) } as unknown as RuleFile]);
    try {
      for (const msg of auditRuleBook(rule)) bad.push(`审计：${msg}`);
    } catch (err) {
      bad.push(`审计崩了（有 patch 的形状不对）：${(err as Error).message}`);
    }
  }
  problems.push(...bad.slice(0, 40).map((x) => `✗ ${x}`));
  if (bad.length > 40) problems.push(`…还有 ${bad.length - 40} 条 patch 问题`);
}

const hard = problems.filter((x) => x.startsWith('✗'));
const soft = problems.filter((x) => !x.startsWith('✗'));
console.log(`答案：${answered}/${index.batches} 批，覆盖 ${entriesAnswered}/${index.total} 条${notYet.length ? `（还没交 ${notYet.length} 批）` : ''}`);
console.log(`判定分布：full ${dist.full} ｜ partial ${dist.partial} ｜ manual ${dist.manual}`);
console.log(`patch：能用的 ${patches.length} 条 ｜ 骨架（节点只写了名字，不能直接用）${skeletons.length} 条`);
if (hard.length) {
  console.log(`\n硬问题 ${hard.length} 条：`);
  for (const x of hard.slice(0, 40)) console.log('  ' + x);
} else {
  console.log('\n✓ 没有格式问题');
}
if (soft.length) {
  console.log(`\n提示 ${soft.length} 条：`);
  for (const x of soft.slice(0, 12)) console.log('  ' + x);
}
if (process.argv.includes('--all')) {
  const missing = index.items.filter((i) => !existsSync(`${DIR}/answers/${i.batch}.json`)).map((i) => i.batch);
  if (missing.length) console.log(`\n还没交：${missing.join('、')}`);
}
process.exit(hard.length ? 1 : 0);




