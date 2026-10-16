/**
 * 把规则计算需要的 5etools 数据抓到本地缓存：npm run fetch:data
 *
 * 缓存目录 data/5etools/ 按站点路径存放（data/5etools/data/races.json …），不进 git。
 * 站点有一种失效模式是「任何路径都回 200 + 首页 HTML」—— 收到 HTML 一律当失败，不写盘。
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const BASE = process.env.DND_DATA_BASE ?? 'https://5e.kiwee.top';
const OUT = resolve(import.meta.dirname, '..', 'data', '5etools');
const force = process.argv.includes('--force');

const FILES = [
  '/data/class/index.json',
  '/data/races.json',
  '/data/backgrounds.json',
  '/data/feats.json',
  '/data/items-base.json',
  '/data/items.json',
  '/data/languages.json',
  '/data/conditionsdiseases.json',
  '/data/actions.json',
  '/data/optionalfeatures.json',
  '/data/spells/spells-xphb.json',
  '/data/spells/sources.json',
  '/data/spells/index.json',
  // 其他书的法术（数据化第 3 波用）：BOOKS=XGE,TCE,AU,FRHoF 可以改；文件名按站点的 spells/index.json
  ...(process.env.BOOKS ?? 'XGE,TCE,AU,FRHoF').split(',').map((b) => `/data/spells/spells-${b.trim().toLowerCase()}.json`),
  '/data/bestiary/bestiary-xmm.json',
  // 战役「资料」里选书用的书目；启用的书的法术 / 怪物文件按 spells、bestiary 的 index.json 现取
  '/data/books.json',
  '/data/bestiary/index.json',
];

async function get(path: string): Promise<string> {
  const r = await fetch(BASE + path, { headers: { 'accept-encoding': 'gzip, deflate, br' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const text = await r.text();
  if (/^\s*</.test(text.slice(0, 32))) throw new Error('站点回的是 HTML，不是 JSON');
  JSON.parse(text);
  return text;
}

async function save(path: string): Promise<'cached' | 'ok' | string> {
  const file = resolve(OUT, '.' + path);
  if (!force && existsSync(file)) return 'cached';
  try {
    const text = await get(path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    return 'ok';
  } catch (e) {
    return (e as Error).message;
  }
}

let failed = 0;
for (const p of FILES) {
  const r = await save(p);
  if (r !== 'ok' && r !== 'cached') failed++;
  console.log(`${r === 'ok' ? '↓' : r === 'cached' ? '·' : '✗'} ${p}${r === 'ok' || r === 'cached' ? '' : '：' + r}`);
}
// 职业文件按 index.json 列出来的抓
const idxFile = resolve(OUT, 'data/class/index.json');
if (existsSync(idxFile)) {
  const idx = JSON.parse(readFileSync(idxFile, 'utf8')) as Record<string, string>;
  for (const f of Object.values(idx)) {
    const p = `/data/class/${f}`;
    const r = await save(p);
    if (r !== 'ok' && r !== 'cached') failed++;
    console.log(`${r === 'ok' ? '↓' : r === 'cached' ? '·' : '✗'} ${p}${r === 'ok' || r === 'cached' ? '' : '：' + r}`);
  }
}
if (failed) {
  console.error(`有 ${failed} 个文件没抓到`);
  process.exit(1);
}
console.log(`数据就绪：${OUT}`);
