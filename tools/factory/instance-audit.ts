/**
 * 「动作实例」需求审查的工作包：把还没完全自动化的规则条目列出来，让审的人（或 Gemini）逐条回答
 * **这条能力要从触发它的那次动作 / 事件里读什么、要对它做什么**，用来定「动作实例」的形状。
 * 说明书在 datafy/instance-audit/README.md。
 *
 *   npx tsx tools/factory/instance-audit.ts           → datafy/instance-audit/parts/ + list.md + spec.md
 *   npx tsx tools/factory/instance-audit.ts merge     → 收 answers/，检查，生成 report.generated.md
 *
 * 和 manual-audit.ts（上一轮，按「缺哪类接口」归类）是两件事：那轮的答案还在 datafy/manual-audit/。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildSpec } from '../../src/factory';

const OUT = 'datafy/instance-audit';
const PER_PART = 40;

// 加载顺序和 src/bridge/rule-files.ts 一致：同键后面的盖前面的，只审最终生效的那一份
const FILES: Array<[string, string]> = [
  ['AI', 'data/dyn/ai/spells.json'],
  ['AI', 'data/dyn/ai/features.json'],
  ['AI', 'data/dyn/ai/books.json'],
  ['AI', 'data/dyn/ai/items.json'],
  ['手写', 'data/rules-2024.json'],
  ['手写', 'data/dyn/spells.json'],
  ['手写', 'data/dyn/features.json'],
  ['审后补', 'data/dyn/reviewed.json'],
];

type Rec = Record<string, unknown>;

function notesOf(n: unknown, out: string[]): void {
  if (Array.isArray(n)) { for (const x of n) notesOf(x, out); return; }
  if (!n || typeof n !== 'object') return;
  const o = n as Rec;
  if (o.kind === 'note' && typeof (o.text ?? o.note) === 'string') out.push(String(o.text ?? o.note));
  for (const v of Object.values(o)) notesOf(v, out);
}

function levelOf(e: Rec, key: string): number | null {
  if (!/:spell:/i.test(key)) return null;
  let lv: number | null = null;
  const look = (n: unknown): void => {
    if (Array.isArray(n)) { n.forEach(look); return; }
    if (!n || typeof n !== 'object') return;
    const slot = (n as Rec).slot as Rec | undefined;
    if (slot && typeof slot.min === 'number') lv = lv === null ? slot.min : Math.min(lv, slot.min);
    for (const v of Object.values(n as Rec)) look(v);
  };
  look(e.actions);
  return lv ?? 0;
}

interface Item { key: string; name: string; by: string; automation: string; level: number | null; text: string; notes: string[]; data: string }

function collect(): Item[] {
  const final = new Map<string, { by: string; e: Rec }>();
  for (const [by, file] of FILES) {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    const E = (j.entries ?? j) as Record<string, Rec>;
    for (const [key, e] of Object.entries(E)) if (e && typeof e === 'object' && key.includes(':')) final.set(key, { by, e });
  }
  const items: Item[] = [];
  for (const [key, { by, e }] of final) {
    const text = String(e.text ?? '');
    const notes: string[] = [];
    notesOf({ actions: e.actions, triggers: e.triggers, effects: e.effects, passives: e.passives }, notes);
    const manualText = /手动|DM|人工|自行|需人|请人/.test(text);
    const auto = String(e.automation ?? 'full');
    if (auto === 'full' && !manualText && !notes.length) continue;
    const level = levelOf(e, key);
    if (level !== null && level >= 6) continue; // 高环法术先不审
    const { text: _t, name: _n, tags: _g, ...rest } = e;
    let data = JSON.stringify(rest);
    if (data.length > 2500) data = data.slice(0, 2500) + '…（截断，全文按键去 data/ 下找）';
    items.push({ key, name: String(e.name ?? key.split(':').pop()), by, automation: auto, level, text, notes: [...new Set(notes)], data });
  }
  return items;
}

/* ---------------- merge：检查答案、汇总 ---------------- */

const SCOPES = ['combat', 'rare', 'manual-ok'];
const OTHER_GAPS = ['zone', 'move', 'vision', 'summon', 'item', 'choice', 'resource', 'condition', 'remember', 'other'];
interface Ans { key: string; scope: string; needsInstance: boolean; on: string | null; reads: string[]; does: string[]; otherGap: string | null; now: boolean; note: string }

function merge(dir: string): void {
  const errs: string[] = [];
  const all: Array<Ans & { name: string }> = [];
  for (const f of readdirSync(join(OUT, 'parts')).filter((x) => x.endsWith('.json')).sort()) {
    const part = JSON.parse(readFileSync(join(OUT, 'parts', f), 'utf8')) as Item[];
    const p = join(dir, f);
    if (!existsSync(p)) { errs.push(`${f}：没交`); continue; }
    let ans: Ans[];
    try { ans = JSON.parse(readFileSync(p, 'utf8')); } catch (e) { errs.push(`${f}：不是合法 JSON（${(e as Error).message}）`); continue; }
    const byKey = new Map(ans.map((a) => [a.key, a]));
    for (const it of part) {
      const a = byKey.get(it.key);
      const at = `${f} ${it.key}`;
      if (!a) { errs.push(`${f}：缺 ${it.key}`); continue; }
      if (!SCOPES.includes(a.scope)) errs.push(`${at}：scope 不认识「${a.scope}」`);
      if (typeof a.needsInstance !== 'boolean') errs.push(`${at}：needsInstance 要是 true / false`);
      if (typeof a.now !== 'boolean') errs.push(`${at}：now 要是 true / false`);
      if (!Array.isArray(a.reads) || !Array.isArray(a.does)) errs.push(`${at}：reads / does 要是数组（没有就写 []）`);
      if (a.needsInstance && !(a.reads?.length || a.does?.length)) errs.push(`${at}：needsInstance 是 true，但 reads 和 does 都是空的`);
      if (a.otherGap !== null && !OTHER_GAPS.includes(String(a.otherGap)) && !/^NEW:\S/.test(String(a.otherGap))) errs.push(`${at}：otherGap 不认识「${a.otherGap}」`);
      if (!a.note) errs.push(`${at}：note 空的`);
      all.push({ ...a, name: it.name });
    }
    for (const a of ans) if (!part.some((x) => x.key === a.key)) errs.push(`${f}：多出来的 ${a.key}`);
  }
  if (errs.length) { console.log(errs.join('\n')); process.exit(1); }

  const live = all.filter((a) => a.scope !== 'manual-ok');
  const inst = live.filter((a) => a.needsInstance);
  const tally = (pick: (a: Ans) => string[]) => {
    const m = new Map<string, string[]>();
    for (const a of inst) for (const k of new Set(pick(a))) m.set(k, [...(m.get(k) ?? []), a.name]);
    return [...m].sort((x, y) => y[1].length - x[1].length);
  };
  const block = (title: string, rows: Array<[string, string[]]>) => [
    `## ${title}`, '',
    ...rows.map(([k, names]) => `- \`${k}\`：${names.length}（${names.slice(0, 6).join('、')}${names.length > 6 ? '…' : ''}）`), '',
  ];
  const L = [
    '# 动作实例需求汇总（自动生成）', '',
    `共 ${all.length} 条：combat ${all.filter((a) => a.scope === 'combat').length}、rare ${all.filter((a) => a.scope === 'rare').length}、manual-ok ${all.filter((a) => a.scope === 'manual-ok').length}。`,
    `不含 manual-ok 的 ${live.length} 条里，需要动作实例的 ${inst.length} 条；现在就能写（now）的 ${all.filter((a) => a.now).length} 条。`, '',
    ...block('挂在哪个事件上（on）', tally((a) => (a.on ? String(a.on).split(/[,，、]\s*/).filter(Boolean) : ['（不是触发的）']))),
    ...block('要读的字段（reads）', tally((a) => a.reads)),
    ...block('要做的操作（does）', tally((a) => a.does)),
    ...block('还卡在别的接口上（otherGap）', tally((a) => (a.otherGap ? [a.otherGap] : []))),
    '## 逐条（需要动作实例的）', '',
    ...inst.map((a) => `- ${a.name}（\`${a.key}\`）· ${a.on ?? '—'} · 读 ${a.reads.join(' ') || '—'} · 做 ${a.does.join(' ') || '—'}：${a.note}`), '',
    '## 现在就能写的（数据要改）', '',
    ...all.filter((a) => a.now).map((a) => `- ${a.name}（\`${a.key}\`）：${a.note}`), '',
  ];
  writeFileSync(join(OUT, 'report.generated.md'), L.join('\n'));
  console.log(`${all.length} 条 → ${OUT}/report.generated.md`);
}

/* ---------------- 出题 ---------------- */

if (process.argv[2] === 'merge') {
  merge(process.argv[3] ?? join(OUT, 'answers'));
} else {
  const items = collect();
  mkdirSync(join(OUT, 'parts'), { recursive: true });
  mkdirSync(join(OUT, 'answers'), { recursive: true });
  writeFileSync(join(OUT, 'spec.md'), buildSpec({ typesSource: readFileSync(resolve('src/combat/types.ts'), 'utf8') }));
  const n = Math.ceil(items.length / PER_PART);
  for (let k = 0; k < n; k++) {
    const id = `P${String(k + 1).padStart(2, '0')}`;
    writeFileSync(join(OUT, 'parts', `${id}.json`), JSON.stringify(items.slice(k * PER_PART, (k + 1) * PER_PART), null, 1));
  }
  const lv = (i: Item) => (i.level === null ? '' : i.level === 0 ? ' · 戏法' : ` · ${i.level} 环`);
  const list = [
    '# 要审的条目', '',
    `共 ${items.length} 条（partial ${items.filter((i) => i.automation === 'partial').length}、manual ${items.filter((i) => i.automation === 'manual').length}、标 full 但有 note 或写了手动的 ${items.filter((i) => i.automation === 'full').length}），分 ${n} 份。6 环及以上法术不在里面。`, '',
    ...items.map((i, x) => `- P${String(Math.floor(x / PER_PART) + 1).padStart(2, '0')} · ${i.name}（\`${i.key}\`）· ${i.by} · ${i.automation}${lv(i)}`), '',
  ];
  writeFileSync(join(OUT, 'list.md'), list.join('\n'));
  console.log(`${items.length} 条 → ${OUT}/parts/（${n} 份）、list.md、spec.md`);
}
