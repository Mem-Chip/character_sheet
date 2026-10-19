// /match 能查怪物图鉴（以前只查法术 / 状态 / 专长 / 物品那些表）
import { beforeAll, describe, expect, it } from 'vitest';
import { createNodeEnv } from '../../src/sheet/node-env';
import { hasLocalData } from '../../src/sheet/node-provider';
import { lookupTerm, searchTerms } from '../../app/lib/terms';
import type { SheetEnv } from '../../src/sheet';

describe.skipIf(!hasLocalData())('/match 查怪物', () => {
  let env: SheetEnv;
  let engine: { env: SheetEnv };
  beforeAll(async () => {
    env = await createNodeEnv();
    await env.store.ensureMany(['bestiaryXmm']);
    engine = { env };
  });

  it('搜「狼」能搜到怪物（排在最前面的就是狼）', async () => {
    const refs = await searchTerms(engine as never, '狼');
    expect(refs.some((r) => r.kind === 'monster' && r.name === '狼')).toBe(true);
    expect(refs[0]).toMatchObject({ kind: 'monster', name: '狼' });
  });

  it('点开看到数据块：体型/类型/CR、AC/HP/速度、属性、特性与动作', async () => {
    const d = await lookupTerm(engine as never, { kind: 'monster', name: '狼' });
    expect(d, '应该查到').toBeTruthy();
    expect(d!.kindLabel).toBe('怪物');
    expect(d!.meta.join('\n')).toContain('野兽');
    expect(d!.meta.join('\n')).toContain('AC 12');
    expect(d!.meta.join('\n')).toContain('2d8 + 2');
    const all = JSON.stringify(d!.entries);
    expect(all, '特性（集群战术）').toContain('集群战术');
    expect(all, '动作（啃咬）').toContain('啃咬');
  });

  it('英文原名也能搜到', async () => {
    const refs = await searchTerms(engine as never, 'wolf');
    expect(refs.some((r) => r.kind === 'monster')).toBe(true);
  });
});
