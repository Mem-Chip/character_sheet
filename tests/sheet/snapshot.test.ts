/**
 * 角色快照测试：21 个测试角色算出来的全部结果与 tests/fixtures/snapshots/ 逐项一致。
 *
 * 快照最初来自原项目（参照实现）的逐项对比，移植验证完成后转成我们自己的快照（见 PORTING.md）。
 * 有意改了规则 → `npm run snapshots` 重新生成 → 在 git diff 里检查变化。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { SheetEnv } from '../../src/sheet';
import { createNodeEnv } from '../../src/sheet/node-env';
import { hasLocalData } from '../../src/sheet/node-provider';
import { diffPaths, snapshotOf } from '../../src/sheet/snapshot';

const FIX = resolve(import.meta.dirname, '..', 'fixtures');
const chars = JSON.parse(readFileSync(resolve(FIX, 'chars.json'), 'utf8')) as Array<{ id: string; note: string; char: object }>;

describe.skipIf(!hasLocalData())('角色快照', () => {
  let env: SheetEnv;
  beforeAll(async () => { env = await createNodeEnv(); });
  for (const fx of chars) {
    it(`${fx.id}：${fx.note}`, async () => {
      const want = JSON.parse(readFileSync(resolve(FIX, 'snapshots', `${fx.id}.json`), 'utf8'));
      const got = await snapshotOf(env, fx.char);
      const diffs = diffPaths(got, { sheet: want.sheet, extras: want.extras, char: want.char });
      expect(diffs, diffs.join('\n')).toEqual([]);
    });
  }
});
