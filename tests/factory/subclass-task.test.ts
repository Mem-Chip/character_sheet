// AI 任务的上下文：整个子职（`<来源>:<子职名>`）拆成每级特性、带上职业资源；站点上没有的自制内容按原文猜职业
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createTaskBuilder, guessClass } from '../../src/factory/build';
import { renderTask } from '../../src/factory/task';
import { normalizeBrew } from '../../src/library';
import { createNodeEnv } from '../../src/sheet/node-env';
import { hasLocalData } from '../../src/sheet/node-provider';
import type { Json, SheetEnv } from '../../src/sheet';

const DATA = resolve('data', '5etools', 'data');
const read = (p: string): Json => JSON.parse(readFileSync(resolve(DATA, p), 'utf8'));
const abilities = (JSON.parse(readFileSync('data/abilities-2024.json', 'utf8')) as Json).entries;

it('按原文猜职业：提得最多的那个', () => {
  expect(guessClass('当你达到特定的德鲁伊等级时……消耗一次荒野形态……你的德鲁伊等级')).toBe('德鲁伊');
  expect(guessClass('与职业无关的家规')).toBeNull();
});

describe.skipIf(!hasLocalData())('子职 / 自制内容的任务', () => {
  let env: SheetEnv;
  let b: ReturnType<typeof createTaskBuilder>;
  beforeAll(async () => {
    env = await createNodeEnv();
    // 浏览器里探针角色会标上战役（启用 XGE）；这里直接让环境按「启用了 XGE」算
    const camp = { sources: ['XGE'], homerules: [] } as Json;
    env.campaignOf = () => camp;
    b = createTaskBuilder({ env, abilities, load: async (p) => read(p), tag: (c) => { (c as Json)._campaign = 'test'; } });
  });

  it('整个子职：拆成卡上实际用的每级特性键，带德鲁伊的资源（荒野形态）', async () => {
    const t = await b.buildTask('AI', 'XGE:牧人结社');
    expect(t.kind).toBe('subclass');
    expect(t.split?.map((x) => x.key)).toEqual(expect.arrayContaining(['XGE:德鲁伊:精魂图腾:2', 'XGE:德鲁伊:忠诚牧畜:14']));
    expect(Object.values(t.resources ?? {})).toContain('荒野形态');
    const md = renderTask(t);
    expect(md).toContain("self.levelOf('德鲁伊')");
    expect(md).toContain('【2 级：精魂图腾】');
  });

  it('自制书：每条特性一个 part，键用自制书的；带德鲁伊的资源；法术表不要重复授予', async () => {
    const brew = normalizeBrew({
      subclass: [{ name: '牧人结社（自制）', className: '德鲁伊', additionalSpells: [{ prepared: { 3: ['命令术'] } }] }],
      subclassFeature: [{ name: '精魂图腾', level: 3, entries: ['以一个附赠动作召唤精魂图腾。'] }],
    } as Json, 'HB-TEST');
    const t = await b.brewTask('AI', brew);
    expect(t.split?.map((x) => x.key)).toEqual(['HB-TEST:德鲁伊:精魂图腾:3']);
    expect(Object.values(t.resources ?? {})).toContain('荒野形态');
    const md = renderTask(t);
    expect(md).toContain('【3 级：精魂图腾】');
    expect(md).toContain('不要**再在 grants 里授予');
  });

  it('站点上没有的自制内容：按原文猜出德鲁伊，给上荒野形态', async () => {
    const t = await b.homebrewTask('AI', 'HR:hr-abcd1234', '自制结社', '你可以消耗一次荒野形态的使用次数；回复等同于你的德鲁伊等级的生命值。');
    expect(t.where).toContain('德鲁伊');
    expect(Object.values(t.resources ?? {})).toContain('荒野形态');
  });
});
