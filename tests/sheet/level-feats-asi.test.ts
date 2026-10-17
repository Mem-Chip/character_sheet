import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { pruneCharByLevel, type CharData, type SheetEnv } from '../../src/sheet';
import { createNodeEnv } from '../../src/sheet/node-env';
import { hasLocalData } from '../../src/sheet/node-provider';

const chars = JSON.parse(readFileSync(resolve(import.meta.dirname, '..', 'fixtures', 'chars.json'), 'utf8')) as Array<{ id: string; char: CharData }>;
const fixture = (id: string) => structuredClone(chars.find((c) => c.id === id)!.char);

describe.skipIf(!hasLocalData())('升级专长槽、属性值提升与降级清理', () => {
  let env: SheetEnv;
  beforeAll(async () => { env = await createNodeEnv(); });

  it('4 级职业特性「属性值提升」不与同名专长混淆，不强制授予专长或待决定项', async () => {
    const c = fixture('rogue5');
    const sheet = await env.compute(c);
    expect(sheet._derived.feats).not.toContain('属性值提升');
    expect(sheet._pending.some((p: { key: string }) => p.key.includes('属性值提升'))).toBe(false);
    // 4 级专长槽应为空槽，允许自由选择任意通用专长
    const slots = env.feats.slots(c, c._resolved);
    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({ cls: '游荡者', category: 'G' });
  });

  it('「属性值提升」支持一项 +2 与两项各 +1，且选第一项 +1 时不会提前判定为已完成', async () => {
    const c = fixture('bard4-asi');
    // 只选了一项 +1：尚未完成（还差第二项 +1）
    c.decisions!['XPHB:属性值提升#asi'] = { cha: 1 };
    let sheet = await env.compute(c);
    let asiPending = sheet._pending.find((p: { key: string }) => p.key === 'XPHB:属性值提升#asi');
    expect(asiPending?.decided).toBe(false);
    expect(sheet['score:cha']).toBe(15 + 2 + 1); // 基础 15 + 背景 2 + 临时已选 1

    // 选满两项各 +1：判定完成，且两项属性均 +1
    c.decisions!['XPHB:属性值提升#asi'] = { cha: 1, dex: 1 };
    sheet = await env.compute(c);
    asiPending = sheet._pending.find((p: { key: string }) => p.key === 'XPHB:属性值提升#asi');
    expect(asiPending?.decided).toBe(true);
    expect(sheet['score:cha']).toBe(15 + 2 + 1);
    expect(sheet['score:dex']).toBe(14 + 1 + 1);
  });

  it('多次选择「属性值提升」专长时各自拥有独立决策键并叠加生效', async () => {
    const c = fixture('fighter5-plate');
    c.classes = [{ name: '战士', level: 6, subclass: '勇士' }];
    c.feats = ['健壮', '属性值提升', '属性值提升'];
    c.decisions = {
      ...c.decisions,
      'XPHB:属性值提升#asi': { str: 2 },
      'XPHB:属性值提升:2#asi': { con: 1, dex: 1 },
    };
    const sheet = await env.compute(c);
    expect(sheet['score:str']).toBe(15 + 2 + 2);
    expect(sheet['score:con']).toBe(14 + 1 + 1);
    expect(sheet['score:dex']).toBe(12 + 1);
  });

  it('降低角色等级时，高等级带来的专长、属性加值、可选特性和决策真正移除', async () => {
    const c = fixture('bard4-asi');
    c.decisions!['XPHB:吟游诗人:附赠熟练:3#bonus-skill-prof'] = ['arcana', 'history', 'nature'];
    const sheet4 = await env.compute(c);
    expect(sheet4['score:cha']).toBe(19); // 15 + 背景 2 + 4级ASI 2
    expect(sheet4.skills.arcana.prof).toBe(true);

    // 降到 2 级（失去 3 级子职「逸闻学院」附赠熟练与 4 级专长槽「属性值提升」）
    c.classes = [{ name: '吟游诗人', level: 2, subclass: '逸闻学院' }];
    pruneCharByLevel(env, c);

    expect(c.feats).toEqual(['音乐家']);
    expect(c.decisions?.['XPHB:属性值提升#asi']).toBeUndefined();
    expect(c.decisions?.['XPHB:吟游诗人:附赠熟练:3#bonus-skill-prof']).toBeUndefined();

    const sheet2 = await env.compute(c);
    expect(sheet2['score:cha']).toBe(17); // 4 级 ASI 不再生效
    expect(sheet2.skills.arcana.prof).toBe(false); // 3 级子职附赠熟练不再生效
  });

  it('魔契师降级时，超出新等级上限或前置等级的魔能祈唤不再保留或生效', async () => {
    const c = fixture('warlock5-pact');
    c.decisions = {
      'XPHB:魔契师:魔契师:0#opt-EI': [
        '幽影护甲',
        '苦痛魔爆',
        '魔能借眼',
        '多步移', // 5 级前置
        '汲命饮者', // 9 级前置
      ],
    };
    await env.compute(c);
    c.classes = [{ name: '魔契师', level: 2, subclass: '' }];
    pruneCharByLevel(env, c);

    const picked = c.decisions['XPHB:魔契师:魔契师:0#opt-EI'] as string[];
    // 2 级魔契师祈唤上限为 3，且不能包含 5 级/9 级前置祈唤
    expect(picked).toEqual(['幽影护甲', '苦痛魔爆', '魔能借眼']);
  });
});
