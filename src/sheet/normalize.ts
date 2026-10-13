/**
 * 把一份 SHEET 归一化成可比较、可存盘的纯 JSON。
 *
 * 用途：移植版与原项目（参照实现）逐项对比。两边都过同一个函数，比较结果。
 * - 5etools 实体（职业、种族、物品…）压成 `名字|来源`：实体本身是数据文件里的原文，比它没有意义，
 *   要比的是「解析到的是不是同一条」；
 * - Set → 排序数组；函数、undefined 丢掉；
 * - 特性列表压成 `归属|名字|等级`；
 * - trace（审计轨迹）不比 —— 那是实现细节。
 */

const ENTITY_HINT = ['page', 'srd52', 'entries', 'ENG_name', 'basicRules2024'];

function isEntity(o: Record<string, unknown>): boolean {
  return typeof o.name === 'string' && typeof o.source === 'string' && ENTITY_HINT.some((k) => k in o);
}

export function normalizeValue(v: unknown, depth = 0): unknown {
  if (v === null || v === undefined) return v ?? null;
  if (typeof v === 'function') return undefined;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'object') return v;
  if (depth > 12) return '…';
  if (v instanceof Set) return [...v].map((x) => normalizeValue(x, depth + 1)).sort(cmp);
  if (v instanceof Map) return Object.fromEntries([...v].map(([k, x]) => [String(k), normalizeValue(x, depth + 1)]));
  if (Array.isArray(v)) return v.map((x) => normalizeValue(x, depth + 1)).filter((x) => x !== undefined);
  const o = v as Record<string, unknown>;
  if (isEntity(o)) return `${o.name}|${o.source}`;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(o).sort()) {
    const x = normalizeValue(o[k], depth + 1);
    if (x !== undefined) out[k] = x;
  }
  return out;
}

function cmp(a: unknown, b: unknown): number {
  const sa = typeof a === 'string' ? a : JSON.stringify(a);
  const sb = typeof b === 'string' ? b : JSON.stringify(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

export function normalizeSheet(sheet: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(sheet).sort()) {
    if (k === 'trace') continue;
    const v = sheet[k];
    if (k === 'features' && Array.isArray(v)) {
      out[k] = v.map((f: Record<string, unknown>) => `${f._cls ?? f._origin ?? ''}${f._sub ? '·子职' : ''}|${f.name}|${f.level ?? ''}`);
      continue;
    }
    const x = normalizeValue(v);
    if (x !== undefined) out[k] = x;
  }
  return out;
}
