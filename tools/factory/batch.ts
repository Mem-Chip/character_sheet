/**
 * 数据化工厂：批量生产（核心数据）。
 *
 *   npx tsx tools/factory/batch.ts plan <wave> [目录]   出任务：wave 1 = 职业 / 子职特性、专长、可选特性、种族；wave 2 = 法术；
 *                                                       wave 3 = 其他书（BOOKS=XGE,TCE,AU,FRHoF）的子职、专长、可选特性、种族、法术
 *                                                       wave 4 = 物品：2024 的魔法物品（XDMG）+ 玩家手册的冒险装备、药水（XPHB）
 *                                                       目录名里要有 batch-w<wave>（collect 靠它认是哪一波），缺省放在 .factory/ 下
 *   npx tsx tools/factory/batch.ts redo <目录> <列表.json>  重做已有 AI 数据的条目（引擎加了新写法）：列表是 [{ key, why: ['…'] }]，
 *                                                       任务附上现在的数据；collect 写回条目原来所在的 AI 文件
 *   npx tsx tools/factory/batch.ts refresh <目录>        按现在的代码重写这个目录的 spec.md 和 examples.json（引擎改过之后用）
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
import { genericOwner, smoke } from '../../src/factory/smoke';
import { buildTask, ownerView, spellsOf } from './sources';

const ROOT = resolve(import.meta.dirname, '..', '..');
const DATA = resolve(ROOT, 'data', '5etools', 'data');
const AI_DIR = resolve(ROOT, 'data', 'dyn', 'ai');
const AI_FILES: Record<string, string> = { 1: 'features.json', 2: 'spells.json', 3: 'books.json', 4: 'items.json' };
const read = (p: string): Json => JSON.parse(readFileSync(p, 'utf8'));
const GOLDEN = [rulesJson, spellsJson, featuresJson] as unknown as RuleFile[];

const aiFile = (wave: string): RuleFile => aiFileByName(AI_FILES[wave]);
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

/**
 * 第 3 波：XPHB 以外的书（缺省 XGE、TCE、AU、FRHoF；环境变量 BOOKS=XGE,TCE 可以改）。
 * - 被重印过的（5etools 标了 reprintedAs，比如塔莎的星辰结社重印进了 2024 玩家手册）不出题；
 * - 老书的子职在站点上有两份：给 2014 职业的（classSource = PHB）和改给 2024 职业的（classSource = XPHB），只要后者；
 * - 法术在 spells-<书>.json 里（npm run fetch:data 会按 BOOKS 抓）。
 */
export const BOOKS = (process.env.BOOKS ?? 'XGE,TCE,AU,FRHoF').split(',').map((x) => x.trim()).filter(Boolean);

function planWave3(): Planned[] {
  const out: Planned[] = [];
  const books = new Set(BOOKS);
  const fresh = (x: Json) => books.has(x.source) && !x.reprintedAs;
  for (const f of readdirSync(resolve(DATA, 'class')).filter((x) => x.startsWith('class-'))) {
    const j = read(resolve(DATA, 'class', f));
    for (const sub of (j.subclass || []).filter((x: Json) => fresh(x) && x.classSource === 'XPHB')) {
      const seen = new Set<string>();
      // 改给 2024 职业的那份只重写了少数几条（开头那条、等级变了的），其余沿用老版的特性（classSource = PHB）：
      // 同名的取 XPHB 那份，没有才用老版
      const all = (j.subclassFeature || []).filter((x: Json) => x.subclassShortName === sub.shortName && x.subclassSource === sub.source && x.className === sub.className);
      const newer = new Set(all.filter((x: Json) => x.classSource === 'XPHB').map((x: Json) => x.name));
      for (const sf of all.filter((x: Json) => x.classSource === 'XPHB' || !newer.has(x.name))) {
        if (sf.name === sub.name || sf.name === sub.shortName) continue;
        const key = `${sf.source}:${sf.className}:${sf.name}:${sf.level}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ key, group: `${sub.className}·${sub.name}（${sub.source}）` });
      }
    }
  }
  for (const ft of (read(resolve(DATA, 'feats.json')).feat as Json[]).filter(fresh)) out.push({ key: `${ft.source}:${ft.name}`, group: `专长·${ft.source}` });
  for (const of of (read(resolve(DATA, 'optionalfeatures.json')).optionalfeature as Json[]).filter(fresh)) {
    out.push({ key: `${of.source}:${of.name}`, group: `可选特性·${(of.featureType || [])[0]}·${of.source}` });
  }
  for (const r of ((read(resolve(DATA, 'races.json')).race || []) as Json[]).filter(fresh)) out.push({ key: `${r.source}:${r.name}`, group: `种族·${r.source}` });
  for (const b of BOOKS) {
    let spells: Json[] = [];
    try { spells = spellsOf(b); } catch { console.warn(`没有 ${b} 的法术文件（先 npm run fetch:data）`); }
    for (const sp of spells.filter(fresh).sort((x, y) => x.level - y.level)) out.push({ key: `${b}:spell:${sp.name}`, group: `法术·${b}·${sp.level ? `${sp.level} 环` : '戏法'}` });
  }
  return out;
}

/** 第 4 波：物品。魔法物品按稀有度分组；冒险装备一组。纯静态的（+1 武器、+1 护甲）答案里跳过即可 */
function planWave4(): Planned[] {
  const out: Planned[] = [];
  const seen = new Set<string>();
  const RAR: Record<string, string> = { common: '普通', uncommon: '非普通', rare: '珍稀', 'very rare': '非常珍稀', legendary: '传说', artifact: '神器', varies: '不定' };
  const NOT_GEAR = ['S', 'M', 'R', 'LA', 'MA', 'HA', 'AT', 'INS', 'GS', 'T', 'TAH', 'MNT', 'VEH', 'SHP', 'FD', 'TG', '$C', '$G', '$A'];
  const items = read(resolve(DATA, 'items.json')).item as Json[];
  const base = read(resolve(DATA, 'items-base.json')).baseitem as Json[];
  for (const it of [...items, ...base]) {
    const key = `${it.source}:item:${it.name}`;
    if (seen.has(key)) continue;
    const magic = it.rarity && it.rarity !== 'none';
    if (magic && it.source !== 'XDMG') continue;
    if (!magic && it.source !== 'XPHB') continue;
    if (!magic && (it.weapon || it.armor || NOT_GEAR.includes(String(it.type).split('|')[0]))) continue;
    if (!it.entries?.length) continue;
    seen.add(key);
    out.push({ key, group: magic ? `魔法物品·${RAR[it.rarity] ?? it.rarity}` : '冒险装备' });
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

/** 写法说明和范例：从代码和手写数据现生成 */
function writeSpec(dir: string): void {
  writeFileSync(resolve(dir, 'spec.md'), buildSpec({ typesSource: readFileSync(resolve(ROOT, 'src', 'combat', 'types.ts'), 'utf8') }));
  const examples: Record<string, Entry> = {};
  for (const f of GOLDEN) Object.assign(examples, f.entries);
  writeFileSync(resolve(dir, 'examples.json'), JSON.stringify(examples, null, 1));
}

async function plan(wave: string, outDir?: string): Promise<void> {
  const done = new Set([...GOLDEN, ...allAi()].flatMap((f) => Object.keys(f.entries)));
  const items = (wave === '1' ? planWave1() : wave === '2' ? planWave2() : wave === '3' ? planWave3() : planWave4()).filter((x) => !done.has(x.key));
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13).replace('T', '-');
  const dir = outDir ? resolve(outDir) : resolve(ROOT, '.factory', `batch-w${wave}-${stamp}`);
  if (!/batch-w\d/.test(dir)) throw new Error(`目录名里要有 batch-w${wave}：${dir}`);
  mkdirSync(resolve(dir, 'tasks'), { recursive: true });
  mkdirSync(resolve(dir, 'answers'), { recursive: true });
  writeSpec(dir);

  const env = await createNodeEnv();
  const prefix = wave === '1' ? 'F' : wave === '2' ? 'S' : wave === '3' ? 'B' : 'I';
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

/**
 * 重做：已经有 AI 数据的条目（引擎加了新写法之后）再出一遍题。任务里附上现在的数据和这次要看的地方；
 * 动作 id、效应名照现在的保留（别处可能在引用）。collect 时写回条目原来所在的 AI 文件。
 * 列表文件：[{ key, why: ['…'] }]
 */
async function redo(outDir: string, listFile: string): Promise<void> {
  const list = read(resolve(listFile)) as Array<{ key: string; why: string[]; group?: string }>;
  const hand = new Set(GOLDEN.flatMap((f) => Object.keys(f.entries)));
  const dir = resolve(outDir);
  mkdirSync(resolve(dir, 'tasks'), { recursive: true });
  mkdirSync(resolve(dir, 'answers'), { recursive: true });
  writeSpec(dir);
  const env = await createNodeEnv();
  const manifest: Array<{ id: string; key: string; group: string; name: string; file: string }> = [];
  const failed: string[] = [];
  let n = 0;
  for (const it of list) {
    if (hand.has(it.key)) { failed.push(`${it.key}：已经有手写数据，不出题`); continue; }
    const file = Object.values(AI_FILES).find((f) => aiFileByName(f).entries[it.key]);
    if (!file) { failed.push(`${it.key}：AI 数据里没有`); continue; }
    const cur = aiFileByName(file).entries[it.key];
    const id = `R${String(++n).padStart(3, '0')}`;
    try {
      const iface = { actions: (cur.actions ?? []).map((a) => ({ id: a.id, name: a.name })), effects: Object.keys(cur.effects ?? {}) };
      const task = await buildTask(env, id, it.key, iface);
      const { tags: _t, ...shown } = cur as Entry & { tags?: string[] };
      const body = renderTask(task) + [
        '', '## 这次为什么重做', '', ...it.why.map((w) => `- ${w}`),
        '', '## 现在的数据（AI 写的、没人审过；在它的基础上改，改完整条写进答案。原样就好的写 `{ "skip": "不用改：原因" }`）', '',
        '```json', JSON.stringify(shown, null, 1), '```', '',
      ].join('\n');
      writeFileSync(resolve(dir, 'tasks', `${id}.md`), body);
      writeFileSync(resolve(dir, 'tasks', `${id}.ctx.json`), JSON.stringify({
        key: it.key, file, resourceIds: Object.keys(task.resources ?? {}), classTableColumns: Object.keys(task.classTable ?? {}),
      }));
      manifest.push({ id, key: it.key, group: it.group ?? file, name: task.name, file });
    } catch (e) {
      failed.push(`${it.key}：${(e as Error).message}`);
    }
  }
  const batches = chunk(manifest.map((m) => ({ key: m.id, group: m.group })), 8)
    .map((b, i) => ({ batch: `R-${String(i + 1).padStart(2, '0')}`, group: b.group, ids: b.keys }));
  writeFileSync(resolve(dir, 'manifest.json'), JSON.stringify(manifest, null, 1));
  writeFileSync(resolve(dir, 'batches.json'), JSON.stringify(batches, null, 1));
  console.log(`出题：${dir}`);
  console.log(`任务 ${manifest.length} 个，分 ${batches.length} 批；没出题的 ${failed.length} 个${failed.length ? `：\n${failed.join('\n')}` : ''}`);
}
function aiFileByName(name: string): RuleFile {
  const p = resolve(AI_DIR, name);
  return existsSync(p) ? read(p) as RuleFile : { entries: {} } as RuleFile;
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
  // file：重做的题写回条目原来所在的 AI 文件；其余按目录名认是哪一波
  const manifest = read(resolve(dir, 'manifest.json')) as Array<{ id: string; key: string; group: string; name: string; file?: string }>;
  const wave = dir.match(/batch-w(\d)/)?.[1] ?? '1';
  const env = await createNodeEnv();
  const declaredAll: Array<{ key: string; resources: ResourceDecl[] }> = [];
  const outs = new Map<string, RuleFile>();
  const outOf = (name: string) => { if (!outs.has(name)) outs.set(name, aiFileByName(name)); return outs.get(name)!; };
  const files = [...GOLDEN, ...allAi()];
  const rows: string[] = [];
  const failures: Array<{ id: string; key: string; problems: string[] }> = [];
  const skipped: Array<{ id: string; name: string; why: string }> = [];
  let written = 0, missing = 0;
  for (const m of manifest) {
    const target = m.file ?? AI_FILES[wave];
    const isItem = target === 'items.json';
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
    outOf(target).entries[m.key] = { ...(isItem && decls.length ? { resources: decls } : {}), ...entry, tags: [...new Set([...(entry.tags ?? []), 'ai', '未审'])] } as Entry;
    // 物品的次数池不进人物卡数据（物品不是人物卡的能力来源），进战斗时从条目里读
    if (decls.length && !isItem) declaredAll.push({ key: m.key, resources: decls });
    written++;
  }
  mkdirSync(AI_DIR, { recursive: true });
  const totals: string[] = [];
  for (const [name, out] of outs) {
    const sorted = Object.fromEntries(Object.entries(out.entries).sort(([a], [b]) => a.localeCompare(b, 'zh')));
    writeFileSync(resolve(AI_DIR, name), JSON.stringify({
      version: 1,
      note: '数据化工厂生成（Claude 子代理），经过检查和战斗试算，但**没有人审过**。键不与手写数据重复；手写数据优先。',
      entries: sorted,
    }, null, 1) + '\n');
    totals.push(`data/dyn/ai/${name} ${Object.keys(sorted).length} 条`);
  }
  const newPools = mergeDeclaredResources(declaredAll);
  writeFileSync(resolve(dir, 'failures.json'), JSON.stringify(failures, null, 1));
  rows.push(`# 收集：${dir.split(/[\\/]/).pop()}`, '',
    `- 任务 ${manifest.length}；写进 AI 数据 ${written}；跳过 ${skipped.length}；没过 ${failures.length}；没交 ${missing}`,
    `- AI 数据文件现在：${totals.join('，') || '没有写'}`,
    `- 新声明的资源池写进人物卡数据：${newPools} 个（data/abilities-2024.json，标 by: 'ai'）`, '');
  if (failures.length) rows.push('## 没过（重做时把这些问题给模型）', '', ...failures.map((f) => `- ${f.id} ${f.key}：${f.problems.slice(0, 2).join('；')}`), '');
  rows.push('## 跳过', '', ...skipped.map((x) => `- ${x.id} ${x.name}：${x.why}`), '');
  writeFileSync(resolve(dir, 'collect.md'), rows.join('\n'));
  console.log(rows.slice(0, 5).join('\n'));
  if (failures.length) console.log(`没过的：${failures.map((f) => f.id).join(' ')}`);
}

const [cmd, a, b] = process.argv.slice(2);
if (cmd === 'plan' && ['1', '2', '3', '4'].includes(a)) await plan(a, b);
else if (cmd === 'redo' && a && b) await redo(a, b);
else if (cmd === 'refresh' && a) { writeSpec(resolve(a)); console.log(`已重写 ${a}/spec.md 和 examples.json`); }
else if (cmd === 'lint' && a && b) {
  const { problems, answer } = lintOne(resolve(a), b);
  appendFileSync(resolve(a, 'lint-log.jsonl'), JSON.stringify({ id: b, at: Date.now(), ok: !problems.length }) + '\n');
  console.log(problems.length ? `✗ ${problems.length} 个问题：\n${problems.map((x) => `- ${x}`).join('\n')}` : isSkip(answer) ? '✓ 跳过' : '✓ 通过（格式、表达式、引用、资源 id 都没问题）');
  process.exitCode = problems.length ? 1 : 0;
} else if (cmd === 'collect' && a) await collect(resolve(a));
else if (cmd === 'text' && a) console.log(flattenEntries(JSON.parse(a)));
else console.log('用法：batch.ts plan <1|2|3|4> [目录] | refresh <目录> | lint <目录> <题号> | collect <目录>');
