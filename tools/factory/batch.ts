/**
 * 数据化工厂：批量生产（核心数据）。
 *
 *   npx tsx tools/factory/batch.ts plan <wave>          出任务：wave 1 = 职业 / 子职特性、专长、可选特性、种族；wave 2 = 法术
 *   npx tsx tools/factory/batch.ts lint <目录> <题号>     检查一份答案（子代理自己跑）；{ "skip": "…" } 直接算通过
 *   npx tsx tools/factory/batch.ts collect <目录>        检查 + 战斗试算 → 写进 data/dyn/ai/，没过的列进 failures.json
 *
 * 已经有手写数据的条目不出题；手写数据永远优先（AI 数据单独放，标「ai、未审」）。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import rulesJson from '../../data/rules-2024.json';
import spellsJson from '../../data/dyn/spells.json';
import featuresJson from '../../data/dyn/features.json';
import type { Entry, RuleFile } from '../../src/combat';
import { buildSpec, declaredResources, flattenEntries, lintEntry, renderTask, type ResourceDecl } from '../../src/factory';
import type { Json } from '../../src/sheet';
import { createNodeEnv } from '../../src/sheet/node-env';
import { genericOwner, smoke } from './smoke';
import { buildTask, ownerView } from './sources';

const ROOT = resolve(import.meta.dirname, '..', '..');
const DATA = resolve(ROOT, 'data', '5etools', 'data');
const AI_DIR = resolve(ROOT, 'data', 'dyn', 'ai');
const AI_FILES: Record<string, string> = { 1: 'features.json', 2: 'spells.json' };
const read = (p: string): Json => JSON.parse(readFileSync(p, 'utf8'));
const GOLDEN = [rulesJson, spellsJson, featuresJson] as unknown as RuleFile[];

function aiFile(wave: string): RuleFile {
  const p = resolve(AI_DIR, AI_FILES[wave]);
  return existsSync(p) ? read(p) as RuleFile : { entries: {} } as RuleFile;
}
const allAi = (): RuleFile[] => Object.keys(AI_FILES).map(aiFile);

/** 不出题的职业特性：纯静态、或引擎已经统一处理 */
const SKIP_FEATURE = /^(属性值提升|施法|契约魔法|.+子职|子职特性|武器精通|史诗恩惠|额外攻击.*|专精|法术书|准备法术|仪式施法)$/;

interface Planned { key: string; group: string }

function planWave1(): Planned[] {
  const out: Planned[] = [];
  for (const f of readdirSync(resolve(DATA, 'class')).filter((x) => x.startsWith('class-'))) {
    const j = read(resolve(DATA, 'class', f));
    const cls = (j.class || []).find((c: Json) => c.source === 'XPHB');
    if (!cls) continue;
    const seen = new Set<string>();
    for (const cf of (j.classFeature || []).filter((x: Json) => x.source === 'XPHB')) {
      const key = `XPHB:${cf.className}:${cf.name}:${cf.level}`;
      if (SKIP_FEATURE.test(cf.name) || seen.has(key)) continue;
      seen.add(key);
      out.push({ key, group: `${cf.className}` });
    }
    for (const sub of (j.subclass || []).filter((s: Json) => s.source === 'XPHB')) {
      for (const sf of (j.subclassFeature || []).filter((x: Json) => x.source === 'XPHB' && x.subclassShortName === sub.shortName && x.className === sub.className)) {
        // 子职的开头那条只是介绍 + 引用后面的特性
        if (sf.name === sub.name || sf.name === sub.shortName) continue;
        const key = `XPHB:${sf.className}:${sf.name}:${sf.level}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ key, group: `${sub.className}·${sub.name}` });
      }
    }
  }
  for (const ft of (read(resolve(DATA, 'feats.json')).feat as Json[]).filter((x) => x.source === 'XPHB')) {
    out.push({ key: `XPHB:${ft.name}`, group: `专长·${ft.category}` });
  }
  for (const of of (read(resolve(DATA, 'optionalfeatures.json')).optionalfeature as Json[]).filter((x) => x.source === 'XPHB')) {
    out.push({ key: `XPHB:${of.name}`, group: `可选特性·${(of.featureType || [])[0]}` });
  }
  for (const r of ((read(resolve(DATA, 'races.json')).race || []) as Json[]).filter((x) => x.source === 'XPHB')) {
    out.push({ key: `XPHB:${r.name}`, group: '种族' });
  }
  return out;
}

function planWave2(): Planned[] {
  return (read(resolve(DATA, 'spells', 'spells-xphb.json')).spell as Json[])
    .sort((a, b) => a.level - b.level || String(a.name).localeCompare(String(b.name), 'zh'))
    .map((s) => ({ key: `XPHB:spell:${s.name}`, group: s.level ? `${s.level} 环法术` : '戏法' }));
}

/** 按组切批：同一组（同一个职业 / 子职）尽量放在一个子代理里，好让写法和资源一致 */
function chunk(items: Planned[], size: number): Array<{ group: string; keys: string[] }> {
  const byGroup = new Map<string, string[]>();
  for (const it of items) byGroup.set(it.group, [...(byGroup.get(it.group) ?? []), it.key]);
  const out: Array<{ group: string; keys: string[] }> = [];
  let cur: { group: string; keys: string[] } | null = null;
  for (const [group, keys] of byGroup) {
    for (let i = 0; i < keys.length; i += size) {
      const part = keys.slice(i, i + size);
      if (cur && cur.keys.length + part.length <= size && part.length < size) {
        cur.keys.push(...part);
        cur.group += ` + ${group}`;
      } else {
        cur = { group, keys: part };
        out.push(cur);
      }
    }
  }
  return out;
}

async function plan(wave: string): Promise<void> {
  const done = new Set([...GOLDEN, ...allAi()].flatMap((f) => Object.keys(f.entries)));
  const items = (wave === '1' ? planWave1() : planWave2()).filter((x) => !done.has(x.key));
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13).replace('T', '-');
  const dir = resolve(ROOT, '.factory', `batch-w${wave}-${stamp}`);
  mkdirSync(resolve(dir, 'tasks'), { recursive: true });
  mkdirSync(resolve(dir, 'answers'), { recursive: true });
  writeFileSync(resolve(dir, 'spec.md'), buildSpec({ typesSource: readFileSync(resolve(ROOT, 'src', 'combat', 'types.ts'), 'utf8') }));
  const examples: Record<string, Entry> = {};
  for (const f of GOLDEN) Object.assign(examples, f.entries);
  writeFileSync(resolve(dir, 'examples.json'), JSON.stringify(examples, null, 1));

  const env = await createNodeEnv();
  const prefix = wave === '1' ? 'F' : 'S';
  const manifest: Array<{ id: string; key: string; group: string; name: string }> = [];
  const failed: string[] = [];
  let n = 0;
  for (const it of items) {
    const id = `${prefix}${String(++n).padStart(3, '0')}`;
    try {
      const task = await buildTask(env, id, it.key);
      writeFileSync(resolve(dir, 'tasks', `${id}.md`), renderTask(task));
      writeFileSync(resolve(dir, 'tasks', `${id}.ctx.json`), JSON.stringify({
        key: it.key, resourceIds: Object.keys(task.resources ?? {}), classTableColumns: Object.keys(task.classTable ?? {}),
      }));
      manifest.push({ id, key: it.key, group: it.group, name: task.name });
    } catch (e) {
      failed.push(`${it.key}：${(e as Error).message}`);
    }
  }
  const batches = chunk(manifest.map((m) => ({ key: m.id, group: m.group })), wave === '1' ? 12 : 10)
    .map((b, i) => ({ batch: `W${wave}-${String(i + 1).padStart(2, '0')}`, group: b.group, ids: b.keys }));
  writeFileSync(resolve(dir, 'manifest.json'), JSON.stringify(manifest, null, 1));
  writeFileSync(resolve(dir, 'batches.json'), JSON.stringify(batches, null, 1));
  console.log(`出题：${dir}`);
  console.log(`任务 ${manifest.length} 个，分 ${batches.length} 批；找不到原文的 ${failed.length} 个${failed.length ? `：\n${failed.join('\n')}` : ''}`);
}

type Answer = { skip: string } | Entry;
const isSkip = (a: unknown): a is { skip: string } => !!a && typeof a === 'object' && 'skip' in (a as object) && Object.keys(a as object).length === 1;

function lintOne(dir: string, id: string): { problems: string[]; answer?: Answer } {
  const ctx = read(resolve(dir, 'tasks', `${id}.ctx.json`));
  const file = resolve(dir, 'answers', `${id}.json`);
  if (!existsSync(file)) return { problems: [`没有答案文件 answers/${id}.json`] };
  let answer: Answer;
  try { answer = read(file) as Answer; } catch (e) { return { problems: [`不是合法的 JSON：${(e as Error).message}`] }; }
  if (isSkip(answer)) return { problems: typeof answer.skip === 'string' && answer.skip.trim() ? [] : ['skip 要写一句原因'], answer };
  const resourceIds = [...new Set([...ctx.resourceIds, ...siblingPools(dir, ctx.key)])];
  const problems = lintEntry(ctx.key, answer, { files: [...GOLDEN, ...allAi()], resourceIds, classTableColumns: ctx.classTableColumns });
  return { problems, answer };
}

/**
 * 同一职业的其他条目声明的资源池（出题之后才有的）：守御闪光由 6 级的条目声明，
 * 精通守御之光要花它。人物卡数据里已经合并的、别的答卷里刚声明的都算。
 */
function siblingPools(dir: string, key: string): string[] {
  const parts = key.split(':');
  if (parts.length !== 4) return [];
  const prefix = `${parts[0]}:${parts[1]}:`;
  const out: string[] = [];
  const abilities = read(ABILITIES_FILE) as { entries: Record<string, Json> };
  for (const [k, e] of Object.entries(abilities.entries)) {
    if (k.startsWith(prefix)) for (const r of e.resources ?? []) if (r.id) out.push(r.id);
  }
  for (const f of readdirSync(resolve(dir, 'answers'))) {
    const id = f.replace(/\.json$/, '');
    const ctxFile = resolve(dir, 'tasks', `${id}.ctx.json`);
    if (!existsSync(ctxFile) || !(read(ctxFile).key as string).startsWith(prefix)) continue;
    try { out.push(...declaredResources(read(resolve(dir, 'answers', f))).map((d) => d.id)); } catch { /* 坏答卷由它自己的检查报 */ }
  }
  return out;
}

const ABILITIES_FILE = resolve(ROOT, 'data', 'abilities-2024.json');

/** 声明的资源池上限公式，在一个 20 级、各属性 +3 的角色上能不能算出数 */
function formulaValue(env: Awaited<ReturnType<typeof createNodeEnv>>, key: string, formula: string | number): number | null {
  const parts = key.split(':');
  const cls = parts.length === 4 ? parts[1] : undefined;
  const sheet: Json = { level: 20, pb: 6, ...Object.fromEntries(['str', 'dex', 'con', 'int', 'wis', 'cha'].map((a) => [`mod:${a}`, 3])) };
  const char = { _resolved: { classes: cls ? [{ cls: { name: cls }, level: 20 }] : [] } } as Json;
  return env.resources.resolveFormula(formula, sheet, char, cls);
}

/** 把条目声明的资源池写进静态层的能力数据（人物卡据此生成这个池），标 by: 'ai' */
function mergeDeclaredResources(decls: Array<{ key: string; resources: ResourceDecl[] }>): number {
  if (!decls.length) return 0;
  const raw = readFileSync(ABILITIES_FILE, 'utf8');
  const data = JSON.parse(raw) as { entries: Record<string, Json> };
  let n = 0;
  for (const { key, resources } of decls) {
    const a = (data.entries[key] ??= { mods: [], grants: [], choices: [], resources: [], confidence: 'ai' });
    a.resources ??= [];
    for (const r of resources) {
      if (a.resources.some((x: Json) => x.id === r.id)) continue;
      a.resources.push({ id: r.id, name: r.name, formula: r.formula, recovery: r.recovery, by: 'ai' });
      n++;
    }
  }
  writeFileSync(ABILITIES_FILE, JSON.stringify(data) + (raw.endsWith('\n') ? '\n' : ''));
  return n;
}

async function collect(dir: string): Promise<void> {
  const manifest = read(resolve(dir, 'manifest.json')) as Array<{ id: string; key: string; group: string; name: string }>;
  const wave = dir.match(/batch-w(\d)/)?.[1] ?? '1';
  const env = await createNodeEnv();
  const declaredAll: Array<{ key: string; resources: ResourceDecl[] }> = [];
  const out = aiFile(wave);
  const files = [...GOLDEN, ...allAi()];
  const rows: string[] = [];
  const failures: Array<{ id: string; key: string; problems: string[] }> = [];
  const skipped: Array<{ id: string; name: string; why: string }> = [];
  let written = 0, missing = 0;
  for (const m of manifest) {
    const { problems, answer } = lintOne(dir, m.id);
    if (!answer) { missing++; continue; }
    if (problems.length) { failures.push({ id: m.id, key: m.key, problems }); continue; }
    if (isSkip(answer)) { skipped.push({ id: m.id, name: m.name, why: answer.skip }); continue; }
    // 声明的资源池：公式要算得出数
    const decls = declaredResources(answer);
    const badFormula = decls.filter((d) => formulaValue(env, m.key, d.formula) === null);
    if (badFormula.length) {
      failures.push({ id: m.id, key: m.key, problems: badFormula.map((d) => `资源池「${d.name}」的上限公式「${d.formula}」算不出数`) });
      continue;
    }
    const base = (await ownerView(env, m.key)) ?? genericOwner(m.key, Object.fromEntries(
      (read(resolve(dir, 'tasks', `${m.id}.ctx.json`)).resourceIds as string[]).map((r) => [r, r])));
    const owner = {
      ...base,
      resources: { ...base.resources, ...Object.fromEntries(decls.map((d) => [d.id, Math.max(1, formulaValue(env, m.key, d.formula) ?? 1)])) },
      resourceNames: { ...base.resourceNames, ...Object.fromEntries(decls.map((d) => [d.id, d.name])) },
    };
    const { resources: _declared, ...entry } = answer as Entry & { resources?: unknown };
    const r = smoke(m.key, entry, files, owner);
    if (r.errors.length) { failures.push({ id: m.id, key: m.key, problems: r.errors.map((e) => `试算：${e}`) }); continue; }
    out.entries[m.key] = { ...entry, tags: [...new Set([...(entry.tags ?? []), 'ai', '未审'])] };
    if (decls.length) declaredAll.push({ key: m.key, resources: decls });
    written++;
  }
  mkdirSync(AI_DIR, { recursive: true });
  const sorted = Object.fromEntries(Object.entries(out.entries).sort(([a], [b]) => a.localeCompare(b, 'zh')));
  writeFileSync(resolve(AI_DIR, AI_FILES[wave]), JSON.stringify({
    version: 1,
    note: '数据化工厂生成（Claude 子代理），经过检查和战斗试算，但**没有人审过**。键不与手写数据重复；手写数据优先。',
    entries: sorted,
  }, null, 1) + '\n');
  const newPools = mergeDeclaredResources(declaredAll);
  writeFileSync(resolve(dir, 'failures.json'), JSON.stringify(failures, null, 1));
  rows.push(`# 收集：${dir.split(/[\\/]/).pop()}`, '',
    `- 任务 ${manifest.length}；写进 AI 数据 ${written}；跳过 ${skipped.length}；没过 ${failures.length}；没交 ${missing}`,
    `- AI 数据文件现在共 ${Object.keys(sorted).length} 条：data/dyn/ai/${AI_FILES[wave]}`,
    `- 新声明的资源池写进人物卡数据：${newPools} 个（data/abilities-2024.json，标 by: 'ai'）`, '');
  if (failures.length) rows.push('## 没过（重做时把这些问题给模型）', '', ...failures.map((f) => `- ${f.id} ${f.key}：${f.problems.slice(0, 2).join('；')}`), '');
  rows.push('## 跳过', '', ...skipped.map((x) => `- ${x.id} ${x.name}：${x.why}`), '');
  writeFileSync(resolve(dir, 'collect.md'), rows.join('\n'));
  console.log(rows.slice(0, 5).join('\n'));
  if (failures.length) console.log(`没过的：${failures.map((f) => f.id).join(' ')}`);
}

const [cmd, a, b] = process.argv.slice(2);
if (cmd === 'plan' && (a === '1' || a === '2')) await plan(a);
else if (cmd === 'lint' && a && b) {
  const { problems, answer } = lintOne(resolve(a), b);
  appendFileSync(resolve(a, 'lint-log.jsonl'), JSON.stringify({ id: b, at: Date.now(), ok: !problems.length }) + '\n');
  console.log(problems.length ? `✗ ${problems.length} 个问题：\n${problems.map((x) => `- ${x}`).join('\n')}` : isSkip(answer) ? '✓ 跳过' : '✓ 通过（格式、表达式、引用、资源 id 都没问题）');
  process.exitCode = problems.length ? 1 : 0;
} else if (cmd === 'collect' && a) await collect(resolve(a));
else if (cmd === 'text' && a) console.log(flattenEntries(JSON.parse(a)));
else console.log('用法：batch.ts plan <1|2> | lint <目录> <题号> | collect <目录>');
