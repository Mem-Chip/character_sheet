/**
 * 列出规则数据里「回退到手动」的地方：automation 是 partial / manual 的、文字里写了「手动」的、
 * 以及执行树里用 note 代替真效果的（比如反冲术把减伤写成一句 note）。
 *
 *   npx tsx tools/factory/manual-audit.ts            → datafy/manual-audit/items.json + list.md + parts/
 *   npx tsx tools/factory/manual-audit.ts merge      → 收 answers/，检查，生成 report.md
 *
 * 每条带上「手动的那几句」，给人（或 Gemini）归类：缺了哪个引擎接口。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const FILES: Array<[string, string]> = [
  ['手写', 'data/rules-2024.json'],
  ['手写', 'data/dyn/spells.json'],
  ['手写', 'data/dyn/features.json'],
  ['AI', 'data/dyn/ai/spells.json'],
  ['AI', 'data/dyn/ai/features.json'],
  ['AI', 'data/dyn/ai/books.json'],
];

type Node = Record<string, unknown>;
interface Item {
  key: string;
  name: string;
  file: string;
  by: string;
  automation: string;
  /** 法术的最低环阶（看 cost 里的 slot.min；戏法 0；不是法术 null） */
  level: number | null;
  /** 说明文字里提到手动 / DM 的句子 */
  manual: string[];
  /** 执行树里的 note（代替了真效果的嫌疑） */
  notes: string[];
  /** 归类提示（关键词粗分，给审的人参考） */
  hints: string[];
}

const HINTS: Array<[string, RegExp]> = [
  ['减伤', /降低|减少.{0,6}伤害|减伤/],
  ['反弹 / 对攻击者造成伤害', /攻击者|反弹|反噬/],
  ['召唤 / 随从', /召唤|随从|精魂|魔宠|坐骑|仆从/],
  ['移动 / 位移 / 传送', /传送|推离|拉近|移动.{0,4}尺|位移|击退/],
  ['地形 / 区域持续', /区域|困难地形|墙|雾|持续.{0,4}区域|进入.{0,6}区域/],
  ['视觉 / 隐形 / 光照', /隐形|目盲|光照|黑暗|看见|视线|掩护/],
  ['吸血 / 按伤害治疗', /一半.{0,6}(生命|治疗)|恢复.{0,8}伤害/],
  ['记住数值（环阶、骰值）', /环阶|骰值|掷出的/],
  ['选择 / 菜单', /选择一|选一|任选/],
  ['法术位 / 资源', /法术位|资源|次数/],
  ['物品 / 装备', /物品|武器变|装备|护甲/],
  ['时间 / 休息 / 叙事', /分钟|小时|休息|仪式|叙事|社交|探索/],
  ['豁免 / 检定修正', /豁免.{0,6}(加值|优势|劣势)|检定.{0,6}(加值|优势)/],
  ['反应 / 时机', /反应|打断|触发/],
];

function walk(n: unknown, out: string[]): void {
  if (Array.isArray(n)) { for (const x of n) walk(x, out); return; }
  if (!n || typeof n !== 'object') return;
  const o = n as Node;
  if (o.kind === 'note' && typeof (o.text ?? o.note) === 'string') out.push(String(o.text ?? o.note));
  for (const v of Object.values(o)) walk(v, out);
}

function levelOf(e: Node, key: string): number | null {
  if (!/:spell:/i.test(key) && !((e.actions as Node[] | undefined)?.some((a) => (a.tags as string[] | undefined)?.includes('spell')))) return null;
  let lv: number | null = null;
  const look = (n: unknown): void => {
    if (Array.isArray(n)) { n.forEach(look); return; }
    if (!n || typeof n !== 'object') return;
    const o = n as Node;
    const slot = o.slot as Node | undefined;
    if (slot && typeof slot === 'object' && typeof slot.min === 'number') lv = lv === null ? slot.min : Math.min(lv, slot.min);
    for (const v of Object.values(o)) look(v);
  };
  look(e.actions);
  return lv ?? 0;
}

const items: Item[] = [];
for (const [by, file] of FILES) {
  const j = JSON.parse(readFileSync(file, 'utf8'));
  const E = (j.entries ?? j) as Record<string, Node>;
  for (const [key, e] of Object.entries(E)) {
    if (!e || typeof e !== 'object') continue;
    const text = String(e.text ?? '');
    const notes: string[] = [];
    walk({ actions: e.actions, triggers: e.triggers, effects: e.effects, passives: e.passives }, notes);
    const manual = text.split(/(?<=[。；;])/).filter((x) => /手动|DM|人工|自行/.test(x)).map((x) => x.trim());
    const auto = String(e.automation ?? 'full');
    if (auto === 'full' && !manual.length && !notes.length) continue;
    const all = [text, ...notes].join(' ');
    items.push({
      key, name: String(e.name ?? key.split(':').pop()), file, by, automation: auto, level: levelOf(e, key),
      manual, notes: [...new Set(notes)], hints: HINTS.filter(([, re]) => re.test(all)).map(([h]) => h),
    });
  }
}

const out = 'datafy/manual-audit';

// merge：收 Gemini 的答案，检查，按 gap 汇总成 report.md
if (process.argv[2] === 'merge') {
  const GAPS = ['reactModify', 'source', 'remember', 'healByDamage', 'summon', 'zone', 'move', 'vision', 'item', 'choice', 'resource', 'condition', 'timing', 'other'];
  const SCOPES = ['combat', 'manual-ok', 'rare'];
  interface Ans { key: string; scope: string; gap: string; need: string; now: boolean; fix?: string }
  const errs: string[] = [];
  const all: Array<Ans & { name: string }> = [];
  for (const f of readdirSync(join(out, 'parts')).filter((x) => x.endsWith('.json')).sort()) {
    const part = JSON.parse(readFileSync(join(out, 'parts', f), 'utf8')) as Array<{ key: string; name: string }>;
    const p = join(process.argv[3] ?? join(out, 'answers'), f);
    if (!existsSync(p)) { errs.push(`${f}：没交`); continue; }
    let ans: Ans[];
    try { ans = JSON.parse(readFileSync(p, 'utf8')); } catch (e) { errs.push(`${f}：不是合法 JSON（${(e as Error).message}）`); continue; }
    const byKey = new Map(ans.map((a) => [a.key, a]));
    for (const it of part) {
      const a = byKey.get(it.key);
      if (!a) { errs.push(`${f}：缺 ${it.key}`); continue; }
      if (!SCOPES.includes(a.scope)) errs.push(`${f} ${it.key}：scope 不认识「${a.scope}」`);
      if (!GAPS.includes(a.gap) && !/^NEW:\S/.test(String(a.gap))) errs.push(`${f} ${it.key}：gap 不认识「${a.gap}」`);
      if (!a.need) errs.push(`${f} ${it.key}：need 空的`);
      if (typeof a.now !== 'boolean') errs.push(`${f} ${it.key}：now 要是 true / false`);
      all.push({ ...a, name: it.name });
    }
    for (const a of ans) if (!part.some((x) => x.key === a.key)) errs.push(`${f}：多出来的 ${a.key}`);
  }
  if (errs.length) { console.log(errs.join('\n')); process.exit(1); }
  const combat = all.filter((a) => a.scope !== 'manual-ok');
  const groups = new Map<string, typeof all>();
  for (const a of combat) groups.set(a.gap, [...(groups.get(a.gap) ?? []), a]);
  const L = [
    '# 手动回退审查汇总', '',
    `共 ${all.length} 条：combat ${all.filter((a) => a.scope === 'combat').length}、rare ${all.filter((a) => a.scope === 'rare').length}、manual-ok ${all.filter((a) => a.scope === 'manual-ok').length}；其中现在就能写（now）的 ${all.filter((a) => a.now).length}。`, '',
    '## 按缺的接口（不含 manual-ok；括号里是 combat / rare）', '',
  ];
  for (const [g, list] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
    L.push(`### ${g}：${list.length}（${list.filter((a) => a.scope === 'combat').length} / ${list.filter((a) => a.scope === 'rare').length}）`, '');
    for (const a of list.filter((x) => !x.now)) L.push(`- ${a.name}（\`${a.key}\`${a.scope === 'rare' ? '，rare' : ''}）：${a.need}`);
    L.push('');
  }
  L.push('## 现在就能写的（答案要改）', '', ...all.filter((a) => a.now).map((a) => `- ${a.name}（\`${a.key}\`）：${a.fix ?? a.need}`), '');
  writeFileSync(join(out, 'report.md'), L.join('\n'));
  console.log(`${all.length} 条 → ${out}/report.md`);
  process.exit(0);
}
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'items.json'), JSON.stringify(items, null, 1));

const high = (i: Item) => i.level !== null && i.level >= 6;
const count = (f: (i: Item) => boolean) => items.filter(f).length;
const hintCount = new Map<string, number>();
for (const i of items) for (const h of i.hints.length ? i.hints : ['（没归上类）']) hintCount.set(h, (hintCount.get(h) ?? 0) + 1);
const lines = [
  '# 回退到手动的规则条目',
  '',
  `共 ${items.length} 条（partial ${count((i) => i.automation === 'partial')}、manual ${count((i) => i.automation === 'manual')}、标 full 但有 note 或写了手动的 ${count((i) => i.automation === 'full')}）。`,
  `其中 6 环及以上法术 ${count(high)} 条（列在最后，可以先不管）。`,
  '',
  '## 关键词粗分（一条可以落在好几类；只是参考）',
  '',
  ...[...hintCount].sort((a, b) => b[1] - a[1]).map(([h, n]) => `- ${h}：${n}`),
  '',
];
const row = (i: Item) => {
  const lv = i.level === null ? '' : i.level === 0 ? ' · 戏法' : ` · ${i.level} 环`;
  const parts = [`### ${i.name}　\`${i.key}\``, `${i.by} · ${i.automation}${lv}${i.hints.length ? ` · ${i.hints.join('、')}` : ''}`];
  for (const m of i.manual) parts.push(`- 说明：${m}`);
  for (const n of i.notes) parts.push(`- note：${n}`);
  return parts.join('\n') + '\n';
};
lines.push('## 条目', '', ...items.filter((i) => !high(i)).map(row), '', '## 6 环及以上法术', '', ...items.filter(high).map(row), '');
writeFileSync(join(out, 'list.md'), lines.join('\n').replace(/\n{3,}/g, '\n\n'));
console.log(`${items.length} 条 → ${out}/list.md, items.json`);

// 分成每份 50 条给 Gemini 审（6 环及以上的不进）
const todo = items.filter((i) => !high(i));
mkdirSync(join(out, 'parts'), { recursive: true });
for (let k = 0; k * 50 < todo.length; k++) {
  const id = `P${String(k + 1).padStart(2, '0')}`;
  writeFileSync(join(out, 'parts', `${id}.json`), JSON.stringify(todo.slice(k * 50, k * 50 + 50).map(({ key, name, automation, level, manual, notes }) => ({ key, name, automation, level, manual, notes })), null, 1));
}
console.log(`${Math.ceil(todo.length / 50)} 份 → ${out}/parts/`);
