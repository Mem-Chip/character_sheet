// 家规覆盖了职业里的某个特性时，等级表的资源只丢被覆盖的那一列（以前整张表都丢，德鲁伊的荒野形态次数跟着没了）
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createNodeEnv } from '../../src/sheet/node-env';
import { hasLocalData } from '../../src/sheet/node-provider';
import type { CharData, Json, SheetEnv } from '../../src/sheet';

const FIX = JSON.parse(readFileSync('tests/fixtures/chars.json', 'utf8')) as Array<{ id: string; char: CharData }>;

describe.skipIf(!hasLocalData())('家规覆盖特性 × 职业表资源', () => {
  let env: SheetEnv;
  beforeAll(async () => {
    env = await createNodeEnv();
    await env.store.ensureMany(['races', 'backgrounds', 'feats', 'items', 'itemsBase']);
  });
  const druid = () => structuredClone(FIX.find((f) => f.id === 'sample-druid2')!.char);
  const pools = async (c: CharData) => ((await env.compute(c)) as Json)._resources as Json[];

  it('覆盖别的特性（德鲁伊语），荒野形态还在', async () => {
    const c = druid();
    c.homerules = [{ id: 'hr-abcd1234', name: '改写德鲁伊语', text: '随便', covers: 'XPHB:德鲁伊:德鲁伊语:1' } as Json];
    const ws = (await pools(c)).find((r) => r.name === '荒野形态');
    expect(ws, '荒野形态的次数应该还在').toBeTruthy();
    expect(ws!.max).toBe(2);
  });

  it('覆盖荒野形态本身，等级表那一列让给家规', async () => {
    const c = druid();
    c.homerules = [{ id: 'hr-abcd1234', name: '改写荒野形态', text: '随便', covers: 'XPHB:德鲁伊:荒野形态:2' } as Json];
    expect((await pools(c)).some((r) => r.source === 'levelTable' && r.name === '荒野形态')).toBe(false);
  });
});
