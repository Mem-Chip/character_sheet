// mod kind 表只该有一份：说明书写它、卡面检查用它、注册也从它来 —— 三边不能漂移
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MOD_KIND_DOC, type CharData } from '../../src/sheet';
import { createNodeEnv } from '../../src/sheet/node-env';
import { hasLocalData } from '../../src/sheet/node-provider';

const chars = JSON.parse(readFileSync(resolve(import.meta.dirname, '..', 'fixtures', 'chars.json'), 'utf8')) as Array<{ id: string; char: CharData }>;
const fighter = () => structuredClone(chars.find((c) => c.id === 'fighter5-plate')!.char);

describe.skipIf(!hasLocalData())('mod kind 表与注册表', () => {
  it('文档里列的和真正注册的是同一批', async () => {
    const env = await createNodeEnv();
    expect([...env.abilities.kinds.keys()].sort()).toEqual(Object.keys(MOD_KIND_DOC).sort());
  });

  it('每个 kind 都写了说明和字段名（检查拼错字段靠它）', () => {
    for (const [k, d] of Object.entries(MOD_KIND_DOC)) {
      expect(d.doc.length, k).toBeGreaterThan(0);
      expect(d.keys.length, k).toBeGreaterThan(0);
    }
  });

  it('伤害免疫（这轮新加的 kind）真的进卡：免疫列表里有它', async () => {
    const env = await createNodeEnv();
    env.homelib.user = () => [{ id: 'hr-imm001', name: '毒免', text: '', mods: [{ kind: 'immune', values: ['毒素'] }] }];
    const sheet = await env.compute(fighter());
    env.homelib.user = () => [];
    expect(sheet.immune).toContain('毒素');
  });
});
