/**
 * 数据化工厂：卡面数据（mods / grants / choices / resources）的检查。
 *
 * 卡面数据最容易出的错是**字段名拼错**：引擎按字段有就读、没有就跳过，所以 `bonu: 2`
 * 不会报错，只会静默不生效。这里用和 `AbilityBook.audit()` 同一套 kind 表（`MOD_KIND_DOC` /
 * `GRANT_KINDS` / `CHOICE_POOLS`）把这个洞堵上。
 *
 * 纯逻辑：资源上限算不算得出数由调用方给 `resolveFormula`（浏览器传 `env.resources.resolveFormula`）。
 */
import { CHOICE_POOLS, GRANT_KINDS, MOD_KIND_DOC } from '../sheet';

export interface SheetLintCtx {
  /** 资源上限算得出来吗（返回 null = 算不出）。不给就不查公式 */
  resolveFormula?: (formula: unknown, cls?: string) => number | null;
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

const SHEET_KEYS = ['mods', 'grants', 'choices', 'resources'];
const RESOURCE_KEYS = ['id', 'name', 'formula', 'recovery', 'cls', 'by', 'note', 'from', 'regain', 'mode'];

/** 卡面数据的结构检查；返回问题（空 = 通过） */
export function lintSheet(sheet: unknown, ctx: SheetLintCtx = {}): string[] {
  const out: string[] = [];
  if (!isObj(sheet)) return ['卡面数据要是对象（mods / grants / choices / resources）'];
  for (const k of Object.keys(sheet)) if (!SHEET_KEYS.includes(k)) out.push(`卡面数据里不认识的字段「${k}」（可用：${SHEET_KEYS.join(' ')}）`);

  const list = (k: string): unknown[] | null => {
    const v = sheet[k];
    if (v === undefined) return null;
    if (!Array.isArray(v)) { out.push(`${k} 要是数组`); return null; }
    return v;
  };

  for (const [i, m] of (list('mods') ?? []).entries()) {
    const at = `mods[${i}]`;
    if (!isObj(m)) { out.push(`${at} 要是对象`); continue; }
    const kind = String(m.kind ?? '');
    if (!kind) { out.push(`${at} 缺 kind`); continue; }
    const doc = MOD_KIND_DOC[kind];
    if (!doc) { out.push(`${at} 不认识的 kind「${kind}」（可用：${Object.keys(MOD_KIND_DOC).join(' ')}）`); continue; }
    const allowed = ['kind', 'note', ...doc.keys];
    for (const k of Object.keys(m)) if (!allowed.includes(k)) out.push(`${at}（${kind}）不认识的字段「${k}」（可用：${allowed.join(' ')}）`);
    if (!doc.keys.some((x) => m[x] !== undefined)) out.push(`${at}（${kind}）什么都没写（要写：${doc.keys.join(' / ')}）`);
  }

  for (const [i, g] of (list('grants') ?? []).entries()) {
    const at = `grants[${i}]`;
    if (!isObj(g)) { out.push(`${at} 要是对象`); continue; }
    const kind = String(g.kind ?? '');
    const spec = GRANT_KINDS[kind];
    if (!kind) { out.push(`${at} 缺 kind`); continue; }
    if (!spec) { out.push(`${at} 不认识的 kind「${kind}」（可用：${Object.keys(GRANT_KINDS).join(' ')}）`); continue; }
    if (spec.needs === 'values' && (!Array.isArray(g.values) || !g.values.length)) out.push(`${at}（${kind}）缺 values`);
    if (spec.needs === 'formula' && !g.formula) out.push(`${at}（${kind}）缺 formula`);
    if (spec.needs === 'text' && !g.text) out.push(`${at}（${kind}）缺 text`);
    if (g.level !== undefined && !(Number.isInteger(g.level) && Number(g.level) >= 1 && Number(g.level) <= 20)) out.push(`${at}（${kind}）的 level 要是 1～20 的整数`);
  }

  for (const [i, c] of (list('choices') ?? []).entries()) {
    const at = `choices[${i}]`;
    if (!isObj(c)) { out.push(`${at} 要是对象`); continue; }
    if (!c.id) out.push(`${at} 缺 id`);
    if (!c.kind) out.push(`${at} 缺 kind`);
    const ok = Array.isArray(c.from) || CHOICE_POOLS.has(String(c.pool)) || c.kind === 'ability';
    if (!ok) out.push(`${at} 的 pool「${String(c.pool ?? '')}」不认识（不在已知池里，也不是 from 数组）：${[...CHOICE_POOLS].join(' ')}`);
  }

  for (const [i, r] of (list('resources') ?? []).entries()) {
    const at = `resources[${i}]`;
    if (!isObj(r)) { out.push(`${at} 要是对象`); continue; }
    for (const k of Object.keys(r)) if (!RESOURCE_KEYS.includes(k)) out.push(`${at} 不认识的字段「${k}」（可用：${RESOURCE_KEYS.join(' ')}）`);
    if (!r.id) out.push(`${at} 缺 id`);
    if (!r.name) out.push(`${at} 缺 name`);
    if (r.formula === undefined || r.formula === null || r.formula === '') out.push(`${at} 缺 formula（上限：数字、'pb'、'max(1, wis)'、'level * 5'…）`);
    if (r.recovery !== 'short' && r.recovery !== 'long') out.push(`${at} 的 recovery 只能是 'short' 或 'long'`);
    if (ctx.resolveFormula && r.formula) {
      const v = ctx.resolveFormula(r.formula, typeof r.cls === 'string' ? r.cls : undefined);
      if (v == null) out.push(`${at}「${r.name}」的上限「${String(r.formula)}」算不出数`);
    }
  }
  return out;
}

/** 这份卡面数据有没有实际内容（全是空数组 = 没有） */
export function sheetHasContent(sheet: unknown): boolean {
  if (!isObj(sheet)) return false;
  return SHEET_KEYS.some((k) => Array.isArray(sheet[k]) && (sheet[k] as unknown[]).length > 0);
}
