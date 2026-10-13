/**
 * 随机对比：用固定种子随机生成角色，同时交给原项目（参照实现）和移植版计算，逐项比较。
 *   npm run oracle:fuzz -- [数量=200] [种子=1]
 * 修掉的原项目 bug（tests/fixtures/divergences.json 那一类）会出现在报告里，按类归并显示。
 */
import { blankCharacter, normalizeSheet, subclassCandidates, type Json } from '../../src/sheet';
import { createNodeEnv } from '../../src/sheet/node-env';
import { seededRng } from '../../src/combat/dice';
import { loadOriginal } from './sandbox';

const N = Number(process.argv[2] ?? 200);
const rng = seededRng(Number(process.argv[3] ?? 1));
const pick = <T>(a: T[]): T => a[Math.floor(rng() * a.length)];
const int = (a: number, b: number) => a + Math.floor(rng() * (b - a + 1));

const o = await loadOriginal();
const env = await createNodeEnv();
const d = env.store.data;
const CLASSES: Record<string, string> = { 野蛮人: 'barbarian', 吟游诗人: 'bard', 牧师: 'cleric', 德鲁伊: 'druid', 战士: 'fighter', 武僧: 'monk', 圣武士: 'paladin', 游侠: 'ranger', 游荡者: 'rogue', 术士: 'sorcerer', 魔契师: 'warlock', 法师: 'wizard' };
const subs: Record<string, string[]> = {};
for (const [cls, slug] of Object.entries(CLASSES)) {
  const cd = await env.store.classData(slug);
  subs[cls] = subclassCandidates(cd.subclass.filter((s: Json) => s.className === cls), 'XPHB').map((s: Json) => s.name);
}
const races = env.store.races2024.map((r: Json) => r.name);
const bgs = env.store.backgrounds2024.map((b: Json) => b.name);
const feats = env.store.feats2024.map((f: Json) => f.name);
const armors = env.store.armors2024.filter((a: Json) => a.source === 'XPHB').map((a: Json) => a.name);
const weapons = env.store.weapons2024.filter((w: Json) => w.source === 'XPHB').map((w: Json) => w.name);
const ABILS = ['str', 'dex', 'con', 'int', 'wis', 'cha'];

function randomChar(): Json {
  const nClasses = rng() < 0.2 ? 2 : 1;
  const classes: Json[] = [];
  const names = Object.keys(CLASSES);
  for (let i = 0; i < nClasses; i++) {
    const name = pick(names.filter((n) => !classes.some((c) => c.name === n)));
    const level = nClasses === 1 ? int(1, 20) : int(1, 10);
    classes.push({ name, level, subclass: level >= 3 && rng() < 0.85 ? pick(subs[name]) : (rng() < 0.1 ? pick(subs[name]) : '') });
  }
  const abilities = Object.fromEntries(ABILS.map((a) => [a, int(8, 16)]));
  const b1 = pick(ABILS);
  const b2 = pick(ABILS.filter((a) => a !== b1));
  return {
    name: 'fuzz', race: pick(races), background: pick(bgs), abilities,
    backgroundBonus: { [b1]: 2, [b2]: 1 },
    classes, startingClass: classes[0].name,
    feats: Array.from({ length: int(0, 3) }, () => pick(feats)),
    skillProf: Array.from({ length: int(0, 4) }, () => pick(['athletics', 'stealth', 'perception', 'arcana', 'insight', 'history', 'survival'])),
    skillExp: rng() < 0.3 ? ['stealth'] : [],
    equipment: [
      ...(rng() < 0.7 ? [{ name: pick(armors), qty: 1, equipped: true }] : []),
      ...Array.from({ length: int(0, 3) }, () => ({ name: pick(weapons), qty: 1, equipped: true })),
    ],
    masteries: rng() < 0.5 ? Array.from({ length: int(1, 3) }, () => pick(weapons)) : [],
    hpRolls: rng() < 0.3 ? { [classes[0].name]: [null, int(1, 6), int(1, 6)] } : {},
  };
}

function diffs(a: unknown, b: unknown, path = '', out: string[] = []): string[] {
  if (out.length > 20) return out;
  if (JSON.stringify(a) === JSON.stringify(b)) return out;
  if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diffs((a as Json)[k], (b as Json)[k], path ? `${path}.${k}` : k, out);
    return out;
  }
  out.push(`${path}：移植版 ${JSON.stringify(a)?.slice(0, 80)} / 原项目 ${JSON.stringify(b)?.slice(0, 80)}`);
  return out;
}

const byKind = new Map<string, { n: number; example: string }>();
let bad = 0;
for (let i = 0; i < N; i++) {
  const fx = randomChar();
  const c1 = { ...o.Character.blank(), ...structuredClone(fx) };
  const c2 = { ...blankCharacter(), ...structuredClone(fx) };
  const s1 = normalizeSheet(await o.Character.compute(c1));
  const s2 = normalizeSheet(await env.compute(c2));
  const ds = diffs(s2, s1);
  if (!ds.length) continue;
  bad++;
  for (const line of ds) {
    const kind = line.split('：')[0].replace(/\.\d+\./g, '.N.').replace(/\.\d+$/, '.N');
    const prev = byKind.get(kind);
    byKind.set(kind, { n: (prev?.n ?? 0) + 1, example: prev?.example ?? `${JSON.stringify(fx.classes)} ${line}` });
  }
}
console.log(`随机角色 ${N} 个：${N - bad} 个逐项一致，${bad} 个有差异`);
for (const [k, v] of [...byKind].sort((a, b) => b[1].n - a[1].n)) console.log(`  ${String(v.n).padStart(4)} × ${k}\n         例：${v.example}`);
process.exit(0);
