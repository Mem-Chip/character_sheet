/**
 * 自带密钥的 AI 工具（浏览器侧）：接口设置、调用、说明书和例子、检查、怪物 AI 结果。
 *
 * 密钥只存在这个浏览器里（localStorage），浏览器直接调用你填的接口，不经过我们的服务器。
 * 接口是 OpenAI 兼容的 /chat/completions（OpenAI、DeepSeek、OpenRouter、本地的 Ollama / LM Studio 都行）。
 */
import { useSyncExternalStore } from 'react';
import abilities2024 from '../../data/abilities-2024.json';
import typesSource from '../../src/combat/types.ts?raw';
import type { ParsedMonster } from '../../src/bridge/from-monster';
import { GOLDEN_FILES } from '../../src/bridge/rule-files';
import type { CombatantView, Entry } from '../../src/combat';
import { buildBrief, buildSpec, declaredResources, lintSheet, renderTask, sheetHasContent, type Task } from '../../src/factory';
import { createLookup, type Lookup } from '../../src/factory';
import { isSkip, type Chat, type ChatMsg } from '../../src/factory/ai';
import { createTaskBuilder } from '../../src/factory/build';
import type { Json } from '../../src/sheet';
import { BREW_CLASSES, checkBrew, kindOfKey, type Brew, type LibraryItem, type ResPart } from '../../src/library';
import { api } from './api';
import type { Engine } from './engine';
import { newItemId, newPartId, tagCampaign } from './library';
import { isHomeruleKey } from '../../src/keys';

/* ───── 设置 ───── */

export interface AiSettings {
  baseUrl: string;
  model: string;
  key: string;
  /** 让 AI 按需查资料（速览 + 查询协议）。缺省开；关掉 = 一次把说明书和全部例子给全 */
  lookup?: boolean;
}
const LS = 'dnd.ai.v1';
const listeners = new Set<() => void>();
let cached: AiSettings | null | undefined;

export function aiSettings(): AiSettings | null {
  if (cached !== undefined) return cached;
  try {
    const s = JSON.parse(localStorage.getItem(LS) || 'null') as AiSettings | null;
    cached = s && s.baseUrl && s.model ? s : null;
  } catch { cached = null; }
  return cached;
}
export function setAiSettings(s: AiSettings | null): void {
  try { if (s) localStorage.setItem(LS, JSON.stringify(s)); else localStorage.removeItem(LS); } catch { /* 存不了就只在这次有效 */ }
  cached = s;
  for (const l of listeners) l();
}
export function useAiSettings(): AiSettings | null {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, aiSettings);
}

/** 常见的接口地址（填进设置里当提示） */
export const AI_PRESETS: Array<{ label: string; baseUrl: string; model: string }> = [
  { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1' },
  { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-sonnet-4.5' },
  { label: '本地 Ollama', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:32b' },
];

/* ───── 调用 ───── */

export const aiBy = (s: AiSettings | null) => `byok:${s?.model ?? '?'}`;

export function makeChat(s: AiSettings, opts: { json?: boolean } = {}): Chat {
  let useJson = opts.json !== false;
  return async (messages: ChatMsg[], signal?: AbortSignal) => {
    const url = s.baseUrl.replace(/\/+$/, '') + '/chat/completions';
    for (let attempt = 0; attempt < 2; attempt++) {
      let r: Response;
      try {
        r = await fetch(url, {
          method: 'POST', signal,
          headers: { 'content-type': 'application/json', ...(s.key ? { authorization: `Bearer ${s.key}` } : {}) },
          body: JSON.stringify({ model: s.model, messages, temperature: 0.2, ...(useJson ? { response_format: { type: 'json_object' } } : {}) }),
        });
      } catch (e) {
        if ((e as Error).name === 'AbortError') throw e;
        throw new Error(`连不上 ${url}（地址不对，或者这个接口不允许浏览器直接调用）`);
      }
      const text = await r.text();
      if (!r.ok) {
        // 有的接口不认 response_format：去掉再试一次
        if (useJson && r.status === 400 && /response_format|json_object/i.test(text)) { useJson = false; continue; }
        throw new Error(`接口返回 ${r.status}：${text.slice(0, 300)}`);
      }
      let data: Json;
      try { data = JSON.parse(text); } catch { throw new Error(`接口返回的不是 JSON：${text.slice(0, 200)}`); }
      const out = data?.choices?.[0]?.message?.content;
      if (typeof out !== 'string' || !out.trim()) throw new Error(`接口没给出内容：${text.slice(0, 200)}`);
      return out;
    }
    throw new Error('接口调用失败');
  };
}

/* ───── 说明书、例子、任务 ───── */

let specMemo = new Map<string, string>();
/** 说明书：`combat` = 只讲动态层（怪物那种）；`both` = 卡面 + 战斗（资料库那种） */
export const aiSpec = (mode: 'combat' | 'both' = 'combat') => {
  let s = specMemo.get(mode);
  if (!s) specMemo.set(mode, (s = buildSpec({ typesSource, mode })));
  return s;
};
let briefMemo = new Map<string, string>();
/** 速览版说明书：只给框架和名字清单，细节让模型用 `{ "lookup": [...] }` 现查（AI-LOOKUP.md） */
export const aiBrief = (mode: 'combat' | 'both' = 'combat') => {
  let s = briefMemo.get(mode);
  if (!s) briefMemo.set(mode, (s = buildBrief({ typesSource, mode })));
  return s;
};
/** 手写条目：例子和 `example` 查询都只用这些（AI 写的错写法不当范例） */
let goldenMemo: Record<string, Entry> | null = null;
export const aiGoldenEntries = (): Record<string, Entry> =>
  (goldenMemo ??= Object.fromEntries(GOLDEN_FILES.flatMap((f) => Object.entries(f.entries))));

let examplesMemo = new Map<string, string>();
/** 例子：`combat` = 全部手写条目；`both` = 再拼上卡面那一侧的真实数据 */
export function aiExamples(mode: 'combat' | 'both' = 'combat'): string {
  const hit = examplesMemo.get(mode);
  if (hit !== undefined) return hit;
  const s = JSON.stringify(aiGoldenEntries()) + (mode === 'both'
    ? `\n\n## 卡面数据的例子（真实数据，照这个粒度写）\n\n${aiSheetExamplesText()}`
    : '');
  examplesMemo.set(mode, s);
  return s;
}

/** 速览版只附最典型的几条，省得模型在 139 条里自己找 */
const BRIEF_EXAMPLE_KEYS = ['XPHB:野蛮人:狂暴:1', 'XPHB:游荡者:偷袭:1', 'XPHB:spell:火球术', 'XPHB:spell:野兽召唤术', 'XPHB:spell:匕首之云'];
let briefExamplesMemo = new Map<string, string>();
export function aiBriefExamples(mode: 'combat' | 'both' = 'combat'): string {
  const hit = briefExamplesMemo.get(mode);
  if (hit !== undefined) return hit;
  const all = aiGoldenEntries();
  const picked = Object.fromEntries(BRIEF_EXAMPLE_KEYS.flatMap((k) => (all[k] ? [[k, all[k]]] : [])));
  const s = JSON.stringify(picked) + (mode === 'both'
    ? `\n\n## 卡面数据的例子（真实数据，照这个粒度写）\n\n${aiSheetExamplesText()}`
    : '');
  briefExamplesMemo.set(mode, s);
  return s;
}

/** 按需查资料的工具：说明书全文、types.ts 源码、手写条目，检查交给调用方（datafy 会给） */
export function aiLookup(mode: 'combat' | 'both' = 'combat'): Lookup {
  return createLookup({ spec: aiSpec(mode), typesSource, entries: aiGoldenEntries() });
}

/**
 * 这一次要发什么：速览 + 查询工具（按需查资料），还是整份说明书 + 全部例子（老办法）。
 * 界面和测试共用这一处判断：自己给了说明书（整理自制书那种流程）就没有可查的全文，退回老办法。
 */
export function aiRunInput(o: { mode?: 'combat' | 'both'; spec?: string; examples?: string; lookup?: boolean } = {}) {
  const mode = o.mode ?? 'combat';
  const brief = !o.spec && o.lookup !== false;
  return {
    brief,
    spec: brief ? aiBrief(mode) : o.spec ?? aiSpec(mode),
    examples: brief ? aiBriefExamples(mode) : o.examples ?? aiExamples(mode),
    lookup: brief ? aiLookup(mode) : undefined,
  };
}

/** 卡面数据的例子：直接从 data/abilities-2024.json 里挑几条真实数据，不手抄 */
const SHEET_EXAMPLE_KEYS = ['XPHB:野蛮人:狂暴:1', 'XPHB:野蛮人:无甲防御:1', 'XPHB:战士:动作如潮:2', 'XPHB:游荡者:偷袭:1'];
export function aiSheetExamples(abilities: Record<string, Json>): string {
  const out: Record<string, unknown> = {};
  for (const k of SHEET_EXAMPLE_KEYS) {
    const a = abilities[k];
    if (!a) continue;
    const e: Record<string, unknown> = {};
    for (const f of ['mods', 'grants', 'choices', 'resources']) if (Array.isArray(a[f]) && a[f].length) e[f] = a[f];
    if (Object.keys(e).length) out[k] = e;
  }
  return JSON.stringify(out, null, 1);
}
let sheetExamplesMemo: string | null = null;
/** 卡面例子的现成一份（用 data/abilities-2024.json 里的真实数据） */
export const aiSheetExamplesText = () =>
  (sheetExamplesMemo ??= aiSheetExamples((abilities2024 as { entries: Record<string, Json> }).entries));

const builders = new Map<string, ReturnType<typeof createTaskBuilder>>();
/** 拼任务（战役里的：探针角色按战役的书算，启用的书里的子职才找得到） */
export function taskBuilder(engine: Engine, cid?: string | null) {
  const k = cid ?? '';
  let b = builders.get(k);
  if (!b) {
    builders.set(k, (b = createTaskBuilder({
      env: engine.env,
      abilities: (abilities2024 as { entries: Record<string, Json> }).entries,
      load: (rel) => engine.env.store.provider.load('/data/' + rel),
      tag: cid ? (c) => tagCampaign(c, cid) : undefined,
    })));
  }
  return b;
}

/* ───── 检查 ───── */

import { checkEntry, type CheckCtx } from '../../src/factory/check';

export { checkEntry };
export type { CheckCtx };

export const checkCtxOf = (t: Task, owner?: CombatantView | null): CheckCtx => ({
  key: t.key, resourceIds: Object.keys(t.resources ?? {}), classTableColumns: Object.keys(t.classTable ?? {}), owner,
});

/* ───── 双写：卡面 + 战斗（LIBRARY.md 第五节） ───── */

/** 试算卡面公式用的假数值（和家规编辑器里那份一致） */
const PROBE_SHEET = { level: 20, pb: 6, 'mod:str': 3, 'mod:dex': 3, 'mod:con': 3, 'mod:int': 3, 'mod:wis': 3, 'mod:cha': 3 };

export interface PartsCheckCtx extends CheckCtx {
  /** 资源上限算不算得出数（浏览器传 `env.resources.resolveFormula`） */
  resolveFormula?: (formula: unknown, cls?: string) => number | null;
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

/**
 * 检查一份双写答卷 `{ parts: [...] }`：卡面走 `lintSheet`，战斗走 `lintEntry` + 试算小遭遇。
 *
 * 两边是**互通**的：卡面 `sheet.resources` 里声明的次数池，战斗那边 `cost: [{ resource: … }]`
 * 花得掉才算对（不然战斗会报「没有这个资源」）。所以池子写在卡面、cost 写在战斗。
 */
export function checkParts(answer: unknown, c: PartsCheckCtx): string[] {
  if (isSkip(answer)) return [];
  if (!isObj(answer)) return ['应该是一个对象：{ "parts": [ … ] }'];
  if (!Array.isArray(answer.parts)) return ['缺 parts 数组（只有一条也要包在 parts 里）'];
  if (!answer.parts.length) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  answer.parts.forEach((raw, i) => {
    const at = `第 ${i + 1} 条`;
    if (!isObj(raw)) { out.push(`${at}：应该是对象`); return; }
    const key = String(raw.key ?? '').trim() || c.key;
    if (seen.has(key)) out.push(`${at}：条目键「${key}」和前面重复了`);
    seen.add(key);
    const sheet = raw.sheet;
    const combat = raw.combat;
    if (raw.removed === true) {
      if (isHomeruleKey(key) || !key.includes(':')) out.push(`${at}：removed 只能用在覆盖官方的条目上（key 写官方键）`);
      if (sheet !== undefined || combat !== undefined) out.push(`${at}：标了 removed 就不要再写 sheet / combat`);
      return;
    }
    if (sheet === undefined && combat === undefined) { out.push(`${at}：sheet 和 combat 至少要写一个`); return; }
    const pools = isObj(sheet) && Array.isArray(sheet.resources)
      ? sheet.resources.map((r) => (isObj(r) ? String(r.id ?? '') : '')).filter(Boolean) : [];
    if (sheet !== undefined) out.push(...lintSheet(sheet, { resolveFormula: c.resolveFormula }).map((m) => `${at} 卡面：${m}`));
    // combat 要么直接是 Entry，要么是 { entry } / { patch } / { value } 的包装
    const entry = !isObj(combat) ? null
      : 'entry' in combat ? combat.entry
        : ('patch' in combat || 'value' in combat) ? null : combat;
    if (entry) out.push(...checkEntry(entry, { ...c, resourceIds: [...(c.resourceIds ?? []), ...pools] }).map((m) => `${at} 战斗：${m}`));
  });
  return out;
}

const withAiTag = (entry: unknown): unknown =>
  (isObj(entry) ? { ...entry, tags: [...new Set([...((entry.tags as string[] | undefined) ?? []), 'ai'])] } : entry);

/** 试算只看这些字段：数值、资源池、熟练、抗免 —— 「加了效果但什么都没变」才看得出来 */
const pickSheet = (s: Json): Json => ({
  ac: s.ac, hpMax: s.hpMax, speed: s.speed, initiative: s.initiative, pb: s.pb,
  resources: (s.resources || []).map((r: Json) => `${r.name ?? r.id}:${r.max ?? ''}`),
  skills: Object.entries(s.skills || {}).filter(([, v]) => v).map(([k]) => k),
  saves: s.saves, senses: s.senses, resist: s.resist, immune: s.immune,
  armorProf: s.armorProf, weaponProf: s.weaponProf, spellDC: s.spellDC, spellAtk: s.spellAtk,
});

/**
 * 卡面试算：把这条卡面数据临时挂到这张卡上算一遍，比一比关键数值。
 * 只报两种问题：**算的时候报错**、**声称有内容但关键数值一点没变**（多半 kind / 字段写对了却不起作用）。
 * 「只有 note」的那种不算错（它本来就不改数值）。
 */
export async function smokeSheet(engine: Engine, char: Json, sheet: unknown): Promise<string[]> {
  if (!isObj(sheet) || !sheetHasContent(sheet)) return [];
  const mods = Array.isArray(sheet.mods) ? sheet.mods : [];
  const meaningful = mods.some((m) => isObj(m) && m.kind !== 'note')
    || (Array.isArray(sheet.grants) && sheet.grants.length > 0)
    || (Array.isArray(sheet.choices) && sheet.choices.length > 0)
    || (Array.isArray(sheet.resources) && sheet.resources.length > 0);
  if (!meaningful) return [];

  const env = engine.env;
  const orig = env.homelib.user;
  let before: Json | null = null;
  try {
    env.homelib.user = () => [];
    before = await env.compute(structuredClone(char));
  } catch { before = null; }
  let after: Json | null;
  try {
    env.homelib.user = () => [{ id: 'hr-smoke01', name: '试算', text: '', ...(sheet as Record<string, unknown>) }];
    after = await env.compute(structuredClone(char));
  } catch (e) {
    return [`试算时报错：${(e as Error).message}`];
  } finally {
    env.homelib.user = orig;
  }
  if (before && JSON.stringify(pickSheet(before)) === JSON.stringify(pickSheet(after))) {
    return ['试算：这条卡面数据没有让这张卡的数值 / 资源 / 熟练发生任何变化（kind 和字段是对的，但看起来没起作用）'];
  }
  return [];
}

/**
 * 双写答卷 → parts。id 尽量沿用已有的（卡上「选了才生效」勾的是 id，重写一次不能把勾选弄丢）。
 * `combat` 直接是 Entry；写 `{ entry }` / `{ patch }` / `{ value }` 的包装也认。
 */
export function partsFromAnswer(answer: unknown, o: { key: string; existing?: LibraryItem }): ResPart[] {
  const list = isObj(answer) && Array.isArray(answer.parts) ? answer.parts : [];
  const out: ResPart[] = [];
  for (const raw of list) {
    if (!isObj(raw)) continue;
    const key = String(raw.key ?? '').trim() || o.key;
    const id = o.existing?.parts?.find((p) => p.key === key)?.id ?? newPartId();
    const combat = raw.combat;
    const c: ResPart['combat'] | undefined = !isObj(combat) ? undefined
      : ('entry' in combat || 'patch' in combat || 'value' in combat) ? (combat as ResPart['combat'])
        : { entry: combat };
    out.push({
      id, key,
      ...(typeof raw.name === 'string' && raw.name.trim() ? { name: raw.name.trim() } : {}),
      ...(typeof raw.text === 'string' && raw.text.trim() ? { text: raw.text } : {}),
      ...(raw.removed === true ? { removed: true } : {}),
      ...(isObj(raw.sheet) && sheetHasContent(raw.sheet) ? { sheet: raw.sheet as ResPart['sheet'] } : {}),
      ...(c ? { combat: { ...c, ...(c.entry !== undefined ? { entry: withAiTag(c.entry) } : {}) } } : {}),
    });
  }
  return out;
}

/* ───── 怪物 AI 结果（全服共享） ───── */

export interface MonsterAi { entries: Record<string, Entry>; drop: string[]; by: string; reviewed: boolean; rev?: number; updated?: number }

let monsterAi: Record<string, MonsterAi> | null = null;
let monsterJob: Promise<void> | null = null;
const mListeners = new Set<() => void>();
const mBump = () => { for (const l of mListeners) l(); };
let mVersion = 0;

export function loadMonsterAi(force = false): Promise<void> {
  if (monsterAi && !force) return Promise.resolve();
  monsterJob ??= api<{ monsters: Record<string, MonsterAi> }>('GET', 'monster-ai')
    .then((r) => { monsterAi = r.monsters ?? {}; }, () => { monsterAi = monsterAi ?? {}; })
    .finally(() => { monsterJob = null; mVersion++; mBump(); });
  return monsterJob;
}
export function useMonsterAi(): Record<string, MonsterAi> {
  useSyncExternalStore((l) => { mListeners.add(l); return () => mListeners.delete(l); }, () => mVersion);
  if (!monsterAi) void loadMonsterAi();
  return monsterAi ?? {};
}
export async function saveMonsterAi(key: string, data: MonsterAi): Promise<string[]> {
  const r = await api<{ status: string; problems?: string[] }>('PUT', `monster-ai/${encodeURIComponent(key)}`, { data });
  if (r.status !== 'done') return r.problems ?? ['存不上'];
  monsterAi = { ...(monsterAi ?? {}), [key]: { ...data, rev: (monsterAi?.[key]?.rev ?? 0) + 1, updated: Date.now() } };
  mVersion++; mBump();
  return [];
}
export async function removeMonsterAi(key: string): Promise<void> {
  await api('DELETE', `monster-ai/${encodeURIComponent(key)}`);
  if (monsterAi) { const { [key]: _, ...rest } = monsterAi; monsterAi = rest; }
  mVersion++; mBump();
}

/** 怪物每条手动能力的条目键 */
export const monsterNoteKey = (monsterKey: string, note: string) => `${monsterKey}/${note}`;

/** 把 AI 结果补到解析结果上：条目进参与者、对应的「要手动处理」拿掉、声明的次数进资源 */
export function withMonsterAi(p: ParsedMonster, ai: MonsterAi | undefined): ParsedMonster {
  if (!ai) return p;
  const v = { ...p.view };
  const entries = { ...(v.entries ?? {}) };
  const sources = [...(v.sources ?? [])];
  const resources = { ...(v.resources ?? {}) };
  const names = { ...(v.resourceNames ?? {}) };
  const auto = [...p.auto];
  for (const [k, e] of Object.entries(ai.entries)) {
    entries[k] = e;
    if (!sources.includes(k)) sources.push(k);
    for (const d of declaredResources(e)) {
      const n = Number(d.formula);
      if (Number.isFinite(n) && n > 0 && resources[d.id] === undefined) { resources[d.id] = n; names[d.id] = d.name ?? d.id; }
    }
    auto.push(`${e.name ?? k.split('/').pop()}（AI${ai.reviewed ? '' : '，未审'}${e.automation === 'manual' ? '，手动' : e.automation === 'partial' ? '，部分' : ''}）`);
  }
  const notes = p.notes.filter((n) => !ai.drop.includes(n.name));
  Object.assign(v, { entries, sources, resources, resourceNames: names, notes: notes.length ? notes : undefined });
  return { ...p, view: v, auto, notes };
}

/** 怪物答卷（名字 → Entry | skip）的检查 */
export function checkMonster(answer: unknown, p: ParsedMonster, owner: CombatantView): string[] {
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return ['应该是一个对象：键是能力名，值是 Entry 或 { skip }'];
  const out: string[] = [];
  const known = new Set(p.notes.map((n) => n.name));
  for (const [name, e] of Object.entries(answer as Record<string, unknown>)) {
    if (!known.has(name)) { out.push(`「${name}」不是要写的能力（要写的：${[...known].join('、')}）`); continue; }
    const probs = checkEntry(e, { key: monsterNoteKey(p.key, name), resourceIds: Object.keys(owner.resources ?? {}), owner });
    out.push(...probs.map((m) => `「${name}」：${m}`));
  }
  return out;
}

/** 怪物答卷 → 存进全服的结构（skip 的不存，也不从「要手动处理」里拿掉） */
export function monsterAiOf(answer: Record<string, unknown>, p: ParsedMonster, by: string): MonsterAi {
  const entries: Record<string, Entry> = {};
  const drop: string[] = [];
  for (const [name, e] of Object.entries(answer)) {
    if (isSkip(e) || !e || typeof e !== 'object') continue;
    const entry = { name, ...(e as Entry), tags: [...new Set([...((e as Entry).tags ?? []), 'ai'])] };
    entries[monsterNoteKey(p.key, name)] = entry;
    if (entry.automation !== 'manual') drop.push(name);
  }
  return { entries, drop, by, reviewed: false };
}

/* ───── 贴文本建怪物：AI 整理成模板格式 ───── */

export async function tidyMonsterText(s: AiSettings, template: string, hint: string, text: string, signal?: AbortSignal): Promise<string> {
  const chat = makeChat(s, { json: false });
  const out = await chat([
    { role: 'system', content: `你把 D&D 怪物数据块（任何语言、任何格式）改写成下面这个固定格式的中文纯文本，给程序解析。\n\n格式范例：\n\n${template}\n\n要求：\n- ${hint}\n- 段落标题（特性、动作、附赠动作、反应、传奇动作）单独一行；每个能力一行，以「名字。」开头。\n- 数值照抄原文，不要编；原文没有的项留空。术语用 D&D 2024 中文译名。\n- 只输出改写后的文本，不要解释，不要代码围栏。` },
    { role: 'user', content: text },
  ], signal);
  return out.replace(/^\s*```\w*\s*/, '').replace(/\s*```\s*$/, '').trim() + '\n';
}

/* ───── 拼任务的几种来源 ───── */

export interface AiJob {
  task: string;
  check: (answer: unknown) => string[] | Promise<string[]>;
  /** 检查用的上下文（双写流程要拿它接卡面检查） */
  ctx?: CheckCtx;
  /** 要拆成几条（整个子职 = 每级特性一条） */
  split?: Array<{ key: string; name: string }>;
}

/**
 * 一个条目键 → 任务。官方的、启用的书里的能力从站点原文拼（资源、职业表按探针角色）；
 * 拼不出来的（家规、自制内容）用给的名字和文字。houseRule = 本团改过这条，以它为准。
 */
export async function jobForKey(engine: Engine, cid: string | null | undefined, key: string, o: { name: string; text: string; houseRule?: string; cls?: string | null; brew?: Brew }): Promise<AiJob> {
  const b = taskBuilder(engine, cid);
  let t: Task;
  let owner: CombatantView | null = null;
  try {
    // 自制书：任务从它的数据拼（键、原文都从那份来），不走站点原文
    if (o.brew) {
      const bt = await b.brewTask('AI', o.brew);
      const ctx = checkCtxOf(bt, null);
      return { task: renderTask(bt), check: (a) => checkEntry(a, ctx), ctx, split: bt.split };
    }
    t = await b.buildTask('AI', key);
    owner = await b.ownerView(key).catch(() => null);
  } catch {
    // 站点上没有（自制内容）：按原文猜职业，带上那个职业的资源和职业表
    t = await b.homebrewTask('AI', key, o.name, o.text, o.cls);
  }
  // 资料库里的文字和官方原文不一样（改过的版本）：以资料库的为准
  const norm = (s: string) => s.replace(/\s+/g, '');
  if (o.text.trim() && norm(o.text) !== norm(t.text) && t.where.indexOf('本团内容') !== 0) {
    t = { ...t, text: o.text.trim(), extra: [...(t.extra ?? []), '上面的原文是资料库里这条的文字（可能改过官方版本），以它为准；和官方不一样的地方照它写。'] };
  }
  if (o.houseRule?.trim()) t = { ...t, extra: [...(t.extra ?? []), `本团家规改过这条，以家规为准：${o.houseRule.trim()}`] };
  const ctx = checkCtxOf(t, owner);
  return { task: renderTask(t), check: (a) => checkEntry(a, ctx), ctx, split: t.split };
}

/**
 * 双写任务：同一份原文和上下文，但要求输出 `{ parts: [...] }`（卡面 + 战斗）。
 * `keys` 是「这份资源要拆成几条」时用的（一个子职 = 每级特性一条）。
 */
export interface PartsTaskOpts {
  key: string;
  name: string;
  text: string;
  houseRule?: string;
  /** 要拆成几条（键 + 名字）；不给 = 就写这一条 */
  keys?: Array<{ key: string; name: string }>;
  /** 自制书：按它的特性键写（每条特性一个 part） */
  brew?: Brew;
  /** 资料库条目记着的职业（自制内容不在站点上时，用它取职业资源；不给就按原文猜） */
  cls?: string | null;
  /** 有真角色就传进来：卡面部分会拿它试算一遍（看数值有没有变） */
  smokeChar?: Json | null;
}

export async function partsJobForKey(engine: Engine, cid: string | null | undefined, o: PartsTaskOpts): Promise<AiJob> {
  const job = await jobForKey(engine, cid, o.key, { name: o.name, text: o.text, houseRule: o.houseRule, cls: o.cls, brew: o.brew });
  const keys = o.keys?.length ? o.keys : job.split;
  const ctx: PartsCheckCtx = {
    ...(job.ctx ?? { key: o.key }),
    resolveFormula: (f, cls) => engine.env.resources.resolveFormula(f, PROBE_SHEET, null, cls),
  };
  const lines = [
    '', '## 输出格式（以这里为准，和上面第 1 节一样）', '',
    '一个 JSON 对象：`{ "parts": [ … ] }`，每个 part 是 `{ key, name, text, sheet, combat }`。',
    keys?.length
      ? `- 下面每一条各写一个 part，\`key\` 原样照抄：\n${keys.map((p) => `  - \`${p.key}\`（${p.name}）`).join('\n')}`
        + '\n- 原文里有、上面却没有对应键的特性（改版新加的）：并进同等级（没有就更低一级）的那条里写。**不要**另起不带 key 的 part：不带 key 的新内容对团里每张卡都生效，不管是不是这个子职。'
        + '\n- 上面有、原文里却没有的（改版删掉的）：写 `{ "key": "<那个键>", "name": "…", "removed": true }`，官方那条就从卡面和战斗里拿掉了。'
      :`- 这一条写一个 part；覆盖官方就写 \`key: "${o.key}"\`，新内容就**不写 key**。`,
    '- `sheet` 写卡面（第 7 节：mods / grants / choices / resources），`combat` 写战斗（第 2～6 节的 Entry，**直接写**，不要包成 `{ "entry": … }`）。',
    '- **两边互通**：次数池声明在 `sheet.resources` 里，战斗里用 `cost: [{ resource: \'<id>\' }]` 花它；',
    '  「带条件才生效」的写 `combat`，「恒定的加值 / 授予 / 池子上限」写 `sheet`。',
    '- 哪一边确实没有内容就不写那一边；两边都没有就别写这个 part。',
  ];
  return {
    task: job.task + lines.join('\n'),
    check: async (a) => {
      const problems = checkParts(a, ctx);
      if (problems.length || !o.smokeChar) return problems;
      // 结构没问题再试算：拿真角色算一遍，看关键数值有没有变
      const out: string[] = [];
      for (const [i, p] of partsOfAnswer(a).entries()) {
        if (!isObj(p) || !isObj(p.sheet)) continue;
        out.push(...(await smokeSheet(engine, o.smokeChar, p.sheet)).map((m) => `第 ${i + 1} 条 ${m}`));
      }
      return out;
    },
    ctx,
  };
}

/** 答卷里的 parts 数组（不是数组就给空的；checkParts 已经报过这个问题） */
function partsOfAnswer(a: unknown): unknown[] {
  return isObj(a) && Array.isArray(a.parts) ? a.parts : [];
}

/* ───── 自制书第一步：原文 → 5etools 格式的子职 ───── */

/** 给 AI 的说明：只要名字、职业、等级、原文（来源这些字段程序补） */
export const brewSpec = () => `你把 D&D 子职的原文（任何语言、任何排版）整理成 5etools 格式的 JSON，给程序加载成一个子职。

输出一个 JSON 对象（不要解释，不要代码围栏）：

{
  "subclass": [{
    "name": "子职名（和官方同名的话加「（自制）」）",
    "className": "职业中文名，只能是：${BREW_CLASSES.join('、')}",
    "additionalSpells": [{ "prepared": { "3": ["命令术", "野兽召唤术"], "5": ["…"] } }]
  }],
  "subclassFeature": [
    { "name": "特性名", "level": 3, "entries": ["第一段原文", { "type": "list", "items": ["列表项"] }, { "type": "entries", "name": "小标题", "entries": ["…"] }] }
  ]
}

要求：
- 每个「N 级：特性名」各写一条 subclassFeature，level 写那个数字。同一级有几个特性就写几条。
- entries 照抄原文，分段写成字符串；原文里的列表用 {"type":"list","items":[…]}，带小标题的段落（「熊之精魂：…」这种）用 {"type":"entries","name":"熊之精魂","entries":["…"]}，表格用 {"type":"table","colLabels":[…],"rows":[[…]]}。
- **建卡 / 升级时就要定下来**的选择（「选择以下一项获得」「习得两种……」）写成 {"type":"options","count":1,"entries":[{"type":"entries","name":"选项名","entries":["…"]}, …]}；**每次使用时才选**的（「召唤图腾时从以下精魂中选择一种」）**不要**用 options，写成普通的带小标题段落。
- 「始终准备的法术」表写进 subclass 的 additionalSpells.prepared（键是职业等级，值是法术中文名，用 2024 版译名）；那一条特性本身照样写一条，原文里保留表格。
- 名字里不要有「:」「#」。不要编原文里没有的东西。
- source、shortName、classSource 这些字段不用写，程序会补。`;

/** 第一步的任务：原文 → 自制书 */
export function brewJob(o: { name: string; text: string }): AiJob {
  const task = [
    `# 整理子职「${o.name || '（没写名字）'}」`, '',
    '## 原文', '', o.text.trim() || '（没有原文）', '',
    '## 输出', '', '照说明书写成 { "subclass": [ … ], "subclassFeature": [ … ] }。',
  ].join('\n');
  return { task, check: (a) => checkBrew(a) };
}
