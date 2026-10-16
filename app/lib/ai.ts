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
import { GOLDEN_FILES, RULE_FILES } from '../../src/bridge/rule-files';
import type { CombatantView, Entry } from '../../src/combat';
import { buildSpec, declaredResources, lintEntry, renderTask, type Task } from '../../src/factory';
import { isSkip, type Chat, type ChatMsg } from '../../src/factory/ai';
import { createTaskBuilder } from '../../src/factory/build';
import { genericOwner, smoke } from '../../src/factory/smoke';
import type { Json } from '../../src/sheet';
import { api } from './api';
import type { Engine } from './engine';
import { newItemId, tagCampaign, type HubItem } from './hub';

/* ───── 设置 ───── */

export interface AiSettings { baseUrl: string; model: string; key: string }
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

let specMemo: string | null = null;
export const aiSpec = () => (specMemo ??= buildSpec({ typesSource }));
let examplesMemo: string | null = null;
export function aiExamples(): string {
  if (examplesMemo) return examplesMemo;
  const all: Record<string, Entry> = {};
  for (const f of GOLDEN_FILES) Object.assign(all, f.entries);
  return (examplesMemo = JSON.stringify(all));
}

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

export interface CheckCtx { key: string; resourceIds?: string[]; classTableColumns?: string[]; owner?: CombatantView | null }

/** 检查一条 Entry：结构、审计、资源、试算（跑一场小遭遇，看运行时会不会出错） */
export function checkEntry(answer: unknown, c: CheckCtx): string[] {
  if (isSkip(answer)) return typeof answer.skip === 'string' && answer.skip.trim() ? [] : ['skip 要写一句原因'];
  const problems = lintEntry(c.key, answer, { files: RULE_FILES, resourceIds: c.resourceIds, classTableColumns: c.classTableColumns });
  if (problems.length) return problems;
  const res: Record<string, string> = Object.fromEntries((c.resourceIds ?? []).map((id) => [id, id]));
  for (const d of declaredResources(answer)) res[d.id] = d.name ?? d.id;
  const owner = c.owner ? { ...c.owner, resources: { ...c.owner.resources, ...Object.fromEntries(Object.keys(res).map((id) => [id, c.owner!.resources[id] ?? 3])) }, resourceNames: { ...c.owner.resourceNames, ...res } } : genericOwner(c.key, res);
  return smoke(c.key, answer as Entry, RULE_FILES, owner).errors.map((e) => `试算出错：${e}`);
}

export const checkCtxOf = (t: Task, owner?: CombatantView | null): CheckCtx => ({
  key: t.key, resourceIds: Object.keys(t.resources ?? {}), classTableColumns: Object.keys(t.classTable ?? {}), owner,
});

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

export interface AiJob { task: string; check: (answer: unknown) => string[] | Promise<string[]> }

/**
 * 一个条目键 → 任务。官方的、启用的书里的能力从站点原文拼（资源、职业表按探针角色）；
 * 拼不出来的（家规、自制内容）用给的名字和文字。houseRule = 本团改过这条，以它为准。
 */
export async function jobForKey(engine: Engine, cid: string | null | undefined, key: string, o: { name: string; text: string; houseRule?: string }): Promise<AiJob> {
  const b = taskBuilder(engine, cid);
  let t: Task;
  let owner: CombatantView | null = null;
  try {
    t = await b.buildTask('AI', key);
    owner = await b.ownerView(key).catch(() => null);
  } catch {
    t = { id: 'AI', key, name: o.name, kind: 'feat', where: '本团内容（家规 / 自制能力）', text: o.text.trim() || o.name, resources: {} };
  }
  if (o.houseRule?.trim()) t = { ...t, extra: [...(t.extra ?? []), `本团家规改过这条，以家规为准：${o.houseRule.trim()}`] };
  return { task: renderTask(t), check: (a) => checkEntry(a, checkCtxOf(t, owner)) };
}

/**
 * 给一张卡上没自动化的能力补战斗数据 → 本团内容。
 * 只写战斗部分（键 = 那条能力）；条目自己声明了次数池的，卡面也得有这个池：
 * 这时改成「覆盖这条能力」，卡面 = 官方卡面数据 + 新的池（只作用在有这项能力的卡上）。
 */
export function hubItemForKey(key: string, name: string, entry: Entry, by: string, card: Json, existing?: HubItem): HubItem {
  const decls = declaredResources(entry);
  const base: HubItem = {
    id: existing?.id ?? newItemId(), name: existing?.name ?? name, text: existing?.text ?? `给「${name}」补的战斗数据`,
    combat: { key, entry: { ...entry, tags: [...new Set([...(entry.tags ?? []), 'ai'])] } }, by, reviewed: false,
  };
  if (!decls.length) return { ...base, ...(existing?.covers ? { covers: existing.covers, sheet: existing.sheet } : {}) };
  const strip = (xs: unknown[] | undefined) => (xs ?? []).map((x) => Object.fromEntries(Object.entries(x as Json).filter(([k]) => !k.startsWith('_'))));
  const res = strip(card?.resources);
  for (const d of decls) if (!res.some((r) => r.id === d.id)) res.push({ id: d.id, name: d.name, formula: d.formula, recovery: d.recovery, by: 'ai' });
  return { ...base, covers: key, sheet: { mods: strip(card?.mods), grants: strip(card?.grants), choices: strip(card?.choices), resources: res } };
}
