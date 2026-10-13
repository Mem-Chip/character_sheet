/** 调试用：看原项目对某个测试角色算出来的 SHEET 有哪些键、长什么样 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadOriginal } from './sandbox';

const id = process.argv[2] ?? 'fighter5-plate';
const chars = JSON.parse(readFileSync(resolve(import.meta.dirname, '..', '..', 'tests', 'fixtures', 'chars.json'), 'utf8'));
const fx = chars.find((c: any) => c.id === id);
const o = await loadOriginal();
const char = { ...o.Character.blank(), ...structuredClone(fx.char) };
const s = await o.Character.compute(char);
const brief = (v: any, d = 0): any => {
  if (v instanceof Set) return `Set(${v.size})[${[...v].slice(0, 6).join(',')}]`;
  if (Array.isArray(v)) return d > 1 ? `Array(${v.length})` : v.slice(0, 3).map((x) => brief(x, d + 1));
  if (v && typeof v === 'object') {
    if (d > 1) return `{${Object.keys(v).slice(0, 12).join(',')}}`;
    return Object.fromEntries(Object.entries(v).slice(0, 40).map(([k, x]) => [k, brief(x, d + 1)]));
  }
  return v;
};
for (const [k, v] of Object.entries(s)) console.log(k.padEnd(22), JSON.stringify(brief(v)).slice(0, 300));
