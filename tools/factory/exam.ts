/**
 * 数据化工厂的考试：让模型盲写已有的黄金条目，再用**同一套场景测试**给它写的版本打分。
 *
 *   npx tsx tools/factory/exam.ts prepare            出卷：.factory/exam-<时间>/（说明书、例子、任务、上下文）
 *   npx tsx tools/factory/exam.ts lint <卷> <题号>    检查一份答案（考生自己可以跑，只报格式与审计问题，不报测试结果）
 *   npx tsx tools/factory/exam.ts grade <卷> [答案目录] 阅卷：每份答案单独替换进规则数据，跑场景测试，出报告
 *
 * 两组题（A / B）互为对方的例子：考 A 时例子里没有 A 的任何答案，反之亦然。
 * 相关的条目放在同一组（至圣斩和圣武斩、疾风连击和震慑拳），免得从例子里抄到近似答案。
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import rulesJson from '../../data/rules-2024.json';
import spellsJson from '../../data/dyn/spells.json';
import featuresJson from '../../data/dyn/features.json';
import type { Entry, RuleFile } from '../../src/combat';
import { buildSpec, lintEntry, renderTask } from '../../src/factory';
import { createNodeEnv } from '../../src/sheet/node-env';
import { buildTask } from './sources';

const ROOT = resolve(import.meta.dirname, '..', '..');
const FILES = [rulesJson, spellsJson, featuresJson] as unknown as RuleFile[];
const golden = (key: string): Entry | undefined => FILES.find((f) => key in f.entries)?.entries[key];

interface Item {
  key: string;
  fold: 'A' | 'B';
  /** 判分用的场景测试（匹配 vitest 的完整测试名） */
  tests: RegExp;
  /** 别处按名字引用的效应（接口的一部分） */
  effects?: string[];
}

const EXAM: Item[] = [
  { key: 'XPHB:spell:祝福术', fold: 'A', tests: /^#3 |^#5 |^#12 |祝福/, effects: ['祝福'] },
  { key: 'XPHB:spell:定身类人', fold: 'A', tests: /^#4 |定身类人/ },
  { key: 'XPHB:spell:护盾术', fold: 'A', tests: /^#6 /, effects: ['护盾'] },
  { key: 'XPHB:spell:火球术', fold: 'A', tests: /^#15 |火球术升环/ },
  { key: 'XPHB:spell:治愈真言', fold: 'A', tests: /^#13 |治愈真言升环/ },
  { key: 'XPHB:游荡者:偷袭:1', fold: 'A', tests: /^#7 |^#8 |偷袭/ },
  { key: 'XPHB:游荡者:直觉闪避:5', fold: 'A', tests: /直觉闪避/ },
  { key: 'XPHB:野蛮人:狂暴:1', fold: 'A', tests: /^#11 /, effects: ['狂暴'] },
  { key: 'XPHB:圣武士:守护灵光:6', fold: 'A', tests: /守护灵光/ },

  { key: 'XPHB:战士:回气:1', fold: 'B', tests: /回气：附赠动作/ },
  { key: 'XPHB:战士:战术思维:2', fold: 'B', tests: /战术思维/ },
  { key: 'XPHB:战士:动作如潮:2', fold: 'B', tests: /动作如潮：/ },
  { key: 'XPHB:游荡者:灵巧动作:2', fold: 'B', tests: /灵巧动作/ },
  { key: 'XPHB:游荡者:稳定瞄准:3', fold: 'B', tests: /稳定瞄准/ },
  { key: 'XPHB:野蛮人:危机感应:2', fold: 'B', tests: /危机感应/ },
  { key: 'XPHB:圣武士:圣疗:1', fold: 'B', tests: /圣疗/ },
  { key: 'XPHB:spell:至圣斩', fold: 'B', tests: /至圣斩/ },
  { key: 'XPHB:圣武士:圣武斩:2', fold: 'B', tests: /圣武斩/ },
  { key: 'XPHB:圣武士:神圣武器:3', fold: 'B', tests: /神圣武器/ },
  { key: 'XPHB:武僧:武艺:1', fold: 'B', tests: /震慑拳豁免成功/ },
  { key: 'XPHB:武僧:疾风连击:2', fold: 'B', tests: /疾风连击/ },
  { key: 'XPHB:武僧:震慑拳:5', fold: 'B', tests: /震慑拳/ },
  { key: 'XPHB:吟游诗人:吟游诗人激励:1', fold: 'B', tests: /诗人激励/ },
  { key: 'XPHB:幸运', fold: 'B', tests: /幸运：/ },
  { key: 'XPHB:术士:先天术法:1', fold: 'B', tests: /先天术法/ },
];

const vitestBin = resolve(ROOT, 'node_modules', 'vitest', 'vitest.mjs');

interface TestResult { fullName: string; status: string; failureMessages?: string[] }

function runTests(overlay: string | null, outFile: string): TestResult[] {
  const r = spawnSync(process.execPath, [vitestBin, 'run', 'tests/combat', '--reporter=json', `--outputFile=${outFile}`], {
    cwd: ROOT, env: { ...process.env, ...(overlay ? { RULES_OVERLAY: overlay } : {}) }, encoding: 'utf8',
  });
  if (!existsSync(outFile)) throw new Error(`vitest 没有产出结果：${r.stderr || r.stdout}`);
  const j = JSON.parse(readFileSync(outFile, 'utf8'));
  return (j.testResults as Array<{ assertionResults: TestResult[] }>).flatMap((f) => f.assertionResults);
}

async function prepare(): Promise<void> {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13).replace('T', '-');
  const dir = resolve(ROOT, '.factory', `exam-${stamp}`);
  mkdirSync(resolve(dir, 'tasks'), { recursive: true });
  mkdirSync(resolve(dir, 'answers'), { recursive: true });

  writeFileSync(resolve(dir, 'spec.md'), buildSpec({ typesSource: readFileSync(resolve(ROOT, 'src', 'combat', 'types.ts'), 'utf8') }));

  // 例子：全部通用规则（状态、通用动作、武器精通）+ 不在这一组里的动态条目
  for (const fold of ['A', 'B'] as const) {
    const exclude = new Set(EXAM.filter((x) => x.fold === fold).map((x) => x.key));
    const examples: Record<string, Entry> = {};
    for (const f of FILES) for (const [k, e] of Object.entries(f.entries)) if (!exclude.has(k)) examples[k] = e;
    writeFileSync(resolve(dir, `examples-${fold}.json`), JSON.stringify(examples, null, 1));
  }

  const env = await createNodeEnv();
  const manifest: Array<{ id: string; key: string; fold: string; name: string }> = [];
  let n = { A: 0, B: 0 };
  for (const item of EXAM) {
    const id = `${item.fold}${String(++n[item.fold]).padStart(2, '0')}`;
    const g = golden(item.key);
    if (!g) throw new Error(`没有黄金条目 ${item.key}`);
    const task = await buildTask(env, id, item.key, {
      actions: (g.actions ?? []).map((a) => ({ id: a.id, name: a.name })),
      effects: item.effects,
    });
    writeFileSync(resolve(dir, 'tasks', `${id}.md`), renderTask(task));
    writeFileSync(resolve(dir, 'tasks', `${id}.ctx.json`), JSON.stringify({
      key: item.key, resourceIds: Object.keys(task.resources ?? {}), classTableColumns: Object.keys(task.classTable ?? {}),
    }, null, 1));
    manifest.push({ id, key: item.key, fold: item.fold, name: task.name });
  }
  writeFileSync(resolve(dir, 'manifest.json'), JSON.stringify(manifest, null, 1));
  const size = (f: string) => readFileSync(resolve(dir, f), 'utf8').length;
  console.log(`出卷：${dir}`);
  console.log(`说明书 ${size('spec.md')} 字；例子 A ${size('examples-A.json')} / B ${size('examples-B.json')} 字；题目 ${manifest.length} 道`);
}

function lintAnswer(dir: string, id: string, log = true, answersDir = 'answers'): string[] {
  const ctx = JSON.parse(readFileSync(resolve(dir, 'tasks', `${id}.ctx.json`), 'utf8'));
  const file = resolve(dir, answersDir, `${id}.json`);
  let problems: string[];
  if (!existsSync(file)) problems = [`没有答案文件 answers/${id}.json`];
  else {
    try {
      const entry: unknown = JSON.parse(readFileSync(file, 'utf8'));
      problems = lintEntry(ctx.key, entry, { files: FILES, resourceIds: ctx.resourceIds, classTableColumns: ctx.classTableColumns });
    } catch (e) {
      problems = [`不是合法的 JSON：${(e as Error).message}`];
    }
  }
  if (log) appendFileSync(resolve(dir, 'lint-log.jsonl'), JSON.stringify({ id, at: Date.now(), ok: !problems.length, n: problems.length }) + '\n');
  return problems;
}

function grade(dir: string, answersDir = 'answers'): void {
  const manifest = JSON.parse(readFileSync(resolve(dir, 'manifest.json'), 'utf8')) as Array<{ id: string; key: string; fold: string; name: string }>;
  const work = resolve(dir, 'grading');
  mkdirSync(work, { recursive: true });

  // 基准：不替换时，判分用的测试都存在而且都通过
  const base = runTests(null, resolve(work, 'baseline.json'));
  for (const m of manifest) {
    const item = EXAM.find((x) => x.key === m.key)!;
    const mine = base.filter((t) => item.tests.test(t.fullName));
    if (!mine.length) throw new Error(`${m.id} ${m.key}：判分规则没有匹配到任何测试`);
    const bad = mine.filter((t) => t.status !== 'passed');
    if (bad.length) throw new Error(`${m.id}：不替换时就有测试没过：${bad.map((t) => t.fullName).join('；')}`);
  }

  const attempts = new Map<string, { first: boolean | null; n: number }>();
  if (existsSync(resolve(dir, 'lint-log.jsonl'))) {
    for (const line of readFileSync(resolve(dir, 'lint-log.jsonl'), 'utf8').split('\n').filter(Boolean)) {
      const r = JSON.parse(line) as { id: string; ok: boolean };
      const a = attempts.get(r.id) ?? { first: null, n: 0 };
      if (a.first === null) a.first = r.ok;
      a.n++;
      attempts.set(r.id, a);
    }
  }

  const rows: string[] = [];
  let lintOk = 0, testOk = 0, answered = 0;
  for (const m of manifest) {
    const item = EXAM.find((x) => x.key === m.key)!;
    const answerFile = resolve(dir, answersDir, `${m.id}.json`);
    const a = attempts.get(m.id);
    if (!existsSync(answerFile)) { rows.push(`| ${m.id} | ${m.name} | 没交卷 | | | |`); continue; }
    answered++;
    const problems = lintAnswer(dir, m.id, false, answersDir);
    if (!problems.length) lintOk++;
    let testCell = '—';
    let detail = problems.slice(0, 2).join('；');
    if (!problems.length) {
      const overlay = resolve(work, `${m.id}.overlay.json`);
      writeFileSync(overlay, JSON.stringify({ entries: { [m.key]: JSON.parse(readFileSync(answerFile, 'utf8')) } }));
      const res = runTests(overlay, resolve(work, `${m.id}.results.json`)).filter((t) => item.tests.test(t.fullName));
      const passed = res.filter((t) => t.status === 'passed');
      testCell = `${passed.length}/${res.length}`;
      if (passed.length === res.length) testOk++;
      else {
        const f = res.find((t) => t.status !== 'passed')!;
        detail = `${f.fullName}：${(f.failureMessages?.[0] ?? '').split('\n')[0].slice(0, 160)}`;
      }
    }
    const lintCell = problems.length ? `✗ ${problems.length} 个问题` : '✓';
    const tries = a ? `${a.first ? '一次过' : '改过'}（检查 ${a.n} 次）` : '没自查';
    rows.push(`| ${m.id} | ${m.name} | ${tries} | ${lintCell} | ${testCell} | ${detail.replace(/\|/g, '/')} |`);
  }
  const report = [
    `# 考试结果：${dir.split(/[\\/]/).pop()}`, '',
    `- 交卷 ${answered} / ${manifest.length}；格式与审计通过 ${lintOk}；场景测试全过 ${testOk}`, '',
    '| 题 | 条目 | 自查 | 格式 / 审计 | 场景测试 | 说明 |', '|---|---|---|---|---|---|', ...rows, '',
  ].join('\n');
  writeFileSync(resolve(dir, 'report.md'), report);
  console.log(report);
}

const [cmd, dir, id] = process.argv.slice(2);
if (cmd === 'prepare') await prepare();
else if (cmd === 'lint' && dir && id) {
  const p = lintAnswer(resolve(dir), id);
  console.log(p.length ? `✗ ${p.length} 个问题：\n${p.map((x) => `- ${x}`).join('\n')}` : '✓ 通过（格式、表达式、引用、资源 id 都没问题）');
  process.exitCode = p.length ? 1 : 0;
} else if (cmd === 'grade' && dir) grade(resolve(dir), process.argv[4]);
else if (cmd === 'list') console.log(readdirSync(resolve(ROOT, '.factory')).join('\n'));
else console.log('用法：exam.ts prepare | lint <卷目录> <题号> | grade <卷目录> [答案目录]');
