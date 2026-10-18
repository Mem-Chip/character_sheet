// 家规能力加到人物卡上：有效 id 会生效；id 不合法的会被丢掉，并且现在会在卡面 warnings 里说出来
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createNodeEnv } from '../../src/sheet/node-env';
import { hasLocalData } from '../../src/sheet/node-provider';
import type { CharData, Json, SheetEnv } from '../../src/sheet';

const FIX = JSON.parse(readFileSync('tests/fixtures/chars.json', 'utf8')) as Array<{ id: string; char: CharData }>;

describe.skipIf(!hasLocalData())('家规能力加到人物卡', () => {
  let env: SheetEnv;
  beforeAll(async () => {
    env = await createNodeEnv();
    await env.store.ensureMany(['races', 'backgrounds', 'feats', 'items', 'itemsBase']);
  });
  const hero = () => structuredClone(FIX.find((f) => f.id === 'fighter5-plate')!.char);

  it('本卡家规的加值会算进卡里（速度 +10）', async () => {
    const base = (await env.compute(hero())) as Json;
    const walk = (s: Json) => (typeof s.speed === 'number' ? s.speed : s.speed?.walk);
    expect(walk(base)).toBe(30);

    const c = hero();
    c.homerules = [{ id: 'hr-abcd1234', name: '测试家规', text: '速度 +10', mods: [{ kind: 'speed', bonus: 10 }] } as Json];
    const sheet = (await env.compute(c)) as Json;
    expect(walk(sheet), '速度应该 30 + 10').toBe(40);
  });

  it('id 不合法的家规会被丢掉，并且卡面能看到这条警告', async () => {
    const c = hero();
    c.homerules = [{ id: 'hr-1', name: '坏 id', text: '速度 +10', mods: [{ kind: 'speed', bonus: 10 }] } as Json];
    const sheet = (await env.compute(c)) as Json;
    const warns = ((sheet._warnings ?? sheet.warnings ?? []) as string[]);
    expect(warns.some((w) => String(w).includes('家规条目 id 不合法')), '应该提示 id 不合法').toBe(true);
    const walk = (typeof sheet.speed === 'number' ? sheet.speed : sheet.speed?.walk) as number;
    expect(walk, '不生效').toBe(30);
  });
});

