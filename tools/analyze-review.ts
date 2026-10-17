/**
 * 分析审查答案：判定分布、按类型、missing 的高频缺口、patch 质量、可马上补的清单。
 * 用法：npx tsx tools/analyze-review.ts [--top N]
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';

type Json = Record<string, any>;
const dir = 'audit-review/answers';
const index = JSON.parse(readFileSync('audit-review/tasks/index.json', 'utf8')) as { items: Array<{ batch: string; keys: string[] }> };
const taskOf = new Map<string, Json>();
for (const it of index.items) {
  try {
    const t = JSON.parse(readFileSync(`audit-review/tasks/${it.batch}.json`, 'utf8')) as Json;
    for (const e of t.entries) taskOf.set(e.key, e);
  } catch { /* 没这批 */ }
}

const answers: Json[] = [];
for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
  const j = JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')) as Json;
  for (const a of j.answers ?? []) answers.push({ ...a, batch: j.batch ?? f });
}
const byKey = new Map(answers.map((a) => [String(a.key), a]));

/* ---------- 1. 判定分布 ---------- */
const dist: Record<string, number> = {};
const byKind: Record<string, Record<string, number>> = {};
for (const a of answers) {
  const v = String(a.verdict ?? '?');
  dist[v] = (dist[v] ?? 0) + 1;
  const kind = String(taskOf.get(String(a.key))?.kind ?? '?');
  byKind[kind] ??= {};
  byKind[kind][v] = (byKind[kind][v] ?? 0) + 1;
}
console.log(`答案 ${answers.length} 条（覆盖 ${byKey.size} 个键）`);
console.log('判定：' + Object.entries(dist).map(([k, v]) => `${k} ${v}`).join(' ｜ '));
for (const [k, v] of Object.entries(byKind).sort((a, b) => Object.values(b[1]).reduce((x, y) => x + y, 0) - Object.values(a[1]).reduce((x, y) => x + y, 0))) {
  const total = Object.values(v).reduce((x, y) => x + y, 0);
  console.log(`   ${k.padEnd(14)} 共 ${String(total).padStart(4)}｜` + Object.entries(v).map(([kk, vv]) => `${kk}:${vv}`).join(' '));
}

/* ---------- 2. patch 质量 ---------- */
const isObject = (x: unknown) => !!x && typeof x === 'object' && !Array.isArray(x);
const skeleton = (x: unknown): boolean => {
  if (typeof x === 'string') return true;                // 节点写成了字符串（"applyEffect"）
  if (Array.isArray(x)) return x.some(skeleton);
  if (!isObject(x)) return false;
  return Object.values(x as Json).some(skeleton);
};
const withPatch = answers.filter((a) => a.patch);
const realPatches = withPatch.filter((a) => !skeleton(a.patch));
console.log(`\npatch：${withPatch.length} 条 ｜ 其中「骨架」（节点只有名字/字符串）${withPatch.length - realPatches.length} 条 ｜ 像样的 ${realPatches.length} 条`);

/* ---------- 3. missing 的高频缺口 ---------- */
const missCount = new Map<string, number>();
for (const a of answers) {
  for (const m of Array.isArray(a.missing) ? a.missing : []) {
    const s = String(m).trim();
    if (s) missCount.set(s, (missCount.get(s) ?? 0) + 1);
  }
}
/** 关键词聚类（原文五花八门，按概念归堆） */
const CLUSTERS: Array<[RegExp, string]> = [
  [/移出战场|放逐|离场|返回战场|从先攻条?隐藏/, '把生物移出/返回战场'],
  [/换位|交换位置|互换/, '两个生物换位'],
  [/重选目标|更换目标|随机目标|改为?新目标|目标集合|范围.*目标/, '重选/改目标集合'],
  [/变形|替换整张|改变体型|体型等级|属性面板/, '变形 / 换体型'],
  [/传送|瞬移|位移|移动棋子|落点/, '传送 / 强制位移'],
  [/链式|连锁|跳跃|弹射|辐射/, '链式效应'],
  [/生命骰|骰池|偷袭骰|卓越骰|术法点池/, '骰池（生命骰/偷袭骰）'],
  [/改写另一道|修饰另一道|改.*法术的|施法时间|施法成分|免专注|加专注|持续时间改/, '改写另一道法术（施法时间/成分/专注/持续）'],
  [/升环|降环|环阶动态/, '升环 / 降环'],
  [/视线|光照|掩护|隐蔽|三维|高度|滞空|坠落|困难地形/, '视线 / 三维 / 地形'],
  [/召唤|仆从|控制.*生物/, '召唤 / 控制生物'],
  [/抗性|免疫|易伤/, '动态改抗性/免疫'],
  [/光环|灵光/, '灵光'],
  [/骰子数量|多掷|额外骰/, '额外骰'],
  [/动作经济|额外动作|附赠动作|反应/, '动作经济'],
];
const clusterCount = new Map<string, number>();
for (const [s, n] of missCount) {
  let hit = false;
  for (const [re, label] of CLUSTERS) if (re.test(s)) { clusterCount.set(label, (clusterCount.get(label) ?? 0) + n); hit = true; }
  if (!hit) clusterCount.set('（其他 / 需要新概念）', (clusterCount.get('（其他 / 需要新概念）') ?? 0) + n);
}
console.log('\nmissing 条目总数：' + [...missCount.values()].reduce((a, b) => a + b, 0) + `（去重后 ${missCount.size} 种说法）`);
console.log('按概念归类（Top 14）：');
for (const [k, v] of [...clusterCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14)) console.log(`   ${String(v).padStart(5)}  ${k}`);
console.log('\n出现最多的 12 种原话：');
for (const [k, v] of [...missCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`   ${String(v).padStart(4)}×  ${k.slice(0, 90)}`);

/* ---------- 4. 可马上补的：full 且现在不是 full 的 ---------- */
const fulls = answers.filter((a) => a.verdict === 'full');
console.log(`\n判成 full 的 ${fulls.length} 条（这些是「现有接口就能做到」，但数据还没写）`);
const byKindFull: Record<string, string[]> = {};
for (const a of fulls) {
  const t = taskOf.get(String(a.key));
  const kind = String(t?.kind ?? '?');
  byKindFull[kind] ??= [];
  byKindFull[kind].push(`${a.key}${a.patch ? '（带 patch）' : ''}`);
}
for (const [k, list] of Object.entries(byKindFull)) {
  console.log(`\n— ${k}（${list.length}）`);
  for (const x of list.slice(0, Number(process.argv.includes('--top') ? process.argv[process.argv.indexOf('--top') + 1] : 40))) console.log('   ' + x);
}

/* ---------- 5. 写成 audit-review/FINDINGS.md ---------- */
if (process.argv.includes('--write')) {
  const L: string[] = [];
  L.push('# 覆盖率审查结果（自动生成）', '');
  L.push(`> 由 \`npm run analyze:review -- --write\` 从 \`audit-review/answers/\` 生成。`, '');
  L.push('## 判定分布', '');
  L.push('| 判定 | 条数 |', '|---|---|');
  for (const [k, v] of Object.entries(dist).sort((a, b) => b[1] - a[1])) L.push(`| ${k} | ${v} |`);
  L.push('', '按类型：', '', '| 类型 | 共 | ' + Object.keys(dist).join(' | ') + ' |', '|---' + '|---'.repeat(Object.keys(dist).length + 1) + '|');
  for (const [k, v] of Object.entries(byKind)) {
    const total = Object.values(v).reduce((x, y) => x + y, 0);
    L.push(`| ${k} | ${total} | ` + Object.keys(dist).map((d) => v[d] ?? 0).join(' | ') + ' |');
  }
  L.push('', '## 缺口（missing）按概念归类', '', '| 概念 | 提到次数 |', '|---|---|');
  for (const [k, v] of [...clusterCount.entries()].sort((a, b) => b[1] - a[1])) L.push(`| ${k} | ${v} |`);
  L.push('', '## 判成 full 的（现有接口就能做到，只差写数据）', '');
  for (const [k, list] of Object.entries(byKindFull)) {
    L.push(`### ${k}（${list.length}）`, '');
    for (const x of list) {
      const key = x.replace('（带 patch）', '');
      const a = byKey.get(key);
      L.push(`- \`${key}\`${x.includes('patch') ? '（带可直接用的 patch）' : ''} —— ${String(a?.why ?? '').slice(0, 160)}`);
    }
    L.push('');
  }
  writeFileSync('audit-review/FINDINGS.md', L.join('\n') + '\n');
  console.log('\n✓ 写了 audit-review/FINDINGS.md');
}
