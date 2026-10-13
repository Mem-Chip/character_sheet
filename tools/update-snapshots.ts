/**
 * 重新生成角色快照：npm run snapshots [角色 id]
 * 有意改了规则计算之后跑它，然后在 git diff 里逐项检查快照的变化是不是你要的。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createNodeEnv } from '../src/sheet/node-env';
import { snapshotOf } from '../src/sheet/snapshot';

const FIX = resolve(import.meta.dirname, '..', 'tests', 'fixtures');
const OUT = resolve(FIX, 'snapshots');
const chars = JSON.parse(readFileSync(resolve(FIX, 'chars.json'), 'utf8')) as Array<{ id: string; note: string; char: object }>;
const only = process.argv[2];
const env = await createNodeEnv();
mkdirSync(OUT, { recursive: true });
for (const fx of chars) {
  if (only && fx.id !== only) continue;
  const snap = await snapshotOf(env, fx.char);
  writeFileSync(resolve(OUT, `${fx.id}.json`), JSON.stringify({ id: fx.id, note: fx.note, ...snap }, null, 1) + '\n');
  console.log(`✓ ${fx.id}`);
}
