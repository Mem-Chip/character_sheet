/**
 * 从 5etools 数据生成 data/spell-meta.json：每道法术的环阶、学派、在哪些职业的法术列表里、专注、仪式、射程、成分。
 * 战斗引擎的「动作实例」（action.spell.*）读它 —— 引擎在浏览器和服务器都跑，所以做成进 git 的小文件，
 * 不依赖运行时有没有 5etools 缓存。
 *
 *   npx tsx tools/build-spell-meta.ts        （要先 npm run fetch:data）
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';

const DIR = 'data/5etools/data/spells';
const SCHOOL: Record<string, string> = { A: '防护', C: '咒法', D: '预言', E: '惑控', V: '塑能', I: '幻术', N: '死灵', T: '变化' };

type Rec = Record<string, any>;
const sources = JSON.parse(readFileSync(`${DIR}/sources.json`, 'utf8')) as Record<string, Record<string, Rec>>;

function rangeOf(r: Rec | undefined): number | string | null {
  if (!r) return null;
  const d = r.distance ?? {};
  if (d.type === 'touch') return 'touch';
  if (d.type === 'self' || r.type === 'radius' || r.type === 'cone' || r.type === 'line' || r.type === 'emanation' || r.type === 'cube' || r.type === 'sphere') return 'self';
  if (d.type === 'feet') return Number(d.amount) || null;
  if (d.type === 'miles') return (Number(d.amount) || 0) * 5280;
  if (d.type === 'sight' || d.type === 'unlimited') return d.type;
  return null;
}

const out: Record<string, Rec> = {};
for (const f of readdirSync(DIR).filter((x) => /^spells-.*\.json$/.test(x)).sort()) {
  for (const s of (JSON.parse(readFileSync(`${DIR}/${f}`, 'utf8')).spell ?? []) as Rec[]) {
    const cls = sources[s.source]?.[s.name]?.class ?? [];
    const lists = [...new Set((cls as Rec[]).map((c) => String(c.name)))];
    const c = s.components ?? {};
    out[`${s.source}:spell:${s.name}`] = {
      level: s.level,
      school: SCHOOL[s.school] ?? s.school ?? '',
      lists,
      concentration: (s.duration ?? []).some((d: Rec) => d.concentration),
      ritual: !!s.meta?.ritual,
      range: rangeOf(s.range),
      components: `${c.v ? 'V' : ''}${c.s ? 'S' : ''}${c.m ? 'M' : ''}`,
    };
  }
}
writeFileSync('data/spell-meta.json', JSON.stringify(out) + '\n');
console.log(`${Object.keys(out).length} 道法术 → data/spell-meta.json`);
