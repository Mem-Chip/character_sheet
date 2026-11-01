// 自制书：资料库里 5etools 格式的子职合进职业数据，卡上像官方子职一样选；特性按它自己的等级出现，
// part 按它的特性键写的卡面数据只对选了这个子职的卡生效；法术表（additionalSpells）按等级给
import { beforeAll, describe, expect, it } from 'vitest';
import { brewFeatureKeys, checkBrew, checkItem, homeRulesOf, normalizeBrew, type LibraryItem } from '../../src/library';
import { blankCharacter, sourceKeyOf, type CharData, type Json, type SheetEnv } from '../../src/sheet';
import { createNodeEnv } from '../../src/sheet/node-env';
import { hasLocalData } from '../../src/sheet/node-provider';

const RAW = {
  subclass: [{ name: '牧人结社（自制）', className: '德鲁伊', additionalSpells: [{ prepared: { 3: ['命令术'], 5: ['飞行术'] } }] }],
  subclassFeature: [
    { name: '林地之语', level: 3, entries: ['你通晓自然生灵的语言。'] },
    {
      name: '精魂图腾', level: 3, entries: [
        '以一个附赠动作召唤精魂图腾。', '召唤图腾时，从以下精魂中选择一种生效：',
        { type: 'entries', name: '熊之精魂', entries: ['临时生命值。'] },
        { type: 'entries', name: '鹰之精魂', entries: ['优势。'] },
        { type: 'entries', name: '独角兽之精魂', entries: ['移动速度。'] },
      ],
    },
    { name: '全能牧者', level: 6, entries: ['召唤物更坚韧。'] },
  ],
};

describe('自制书的结构', () => {
  it('检查：子职、职业名、等级、原文', () => {
    expect(checkBrew(RAW)).toEqual([]);
    expect(checkBrew({ subclass: [{ name: 'x', className: '猎人' }], subclassFeature: [] }).join()).toContain('className');
    expect(checkBrew({ ...RAW, subclassFeature: [{ name: 'a:b', level: 30, entries: [] }] }).length).toBeGreaterThan(1);
  });
  it('补齐来源字段；键是「来源:职业:特性:等级」', () => {
    const b = normalizeBrew(RAW as Json, 'HB-TEST');
    expect(b.subclass[0]).toMatchObject({ source: 'HB-TEST', classSource: 'XPHB', edition: 'one', shortName: '牧人结社（自制）' });
    expect(brewFeatureKeys(b).map((k) => k.key)).toEqual(['HB-TEST:德鲁伊:林地之语:3', 'HB-TEST:德鲁伊:精魂图腾:3', 'HB-TEST:德鲁伊:全能牧者:6']);
  });
  it('资料库条目带自制书：服务器检查时补齐，可以先没有 part', () => {
    const { item, problems } = checkItem({ id: 'hr-brew1234', kind: 'subclass', name: '牧人结社（自制）', text: '', parts: [], brew: RAW, by: 'hand' }, 'hr-brew1234');
    expect(problems).toEqual([]);
    expect(item?.brew?.subclass[0].source).toBe('HB-BREW1234');
  });
});

describe.skipIf(!hasLocalData())('自制子职算卡', () => {
  let env: SheetEnv;
  const brew = normalizeBrew(RAW as Json, 'HB-TEST');
  beforeAll(async () => {
    env = await createNodeEnv();
    env.userBrew = () => [brew];
  });
  const druid = (level: number): CharData => ({
    ...blankCharacter(), abilities: { str: 10, dex: 14, con: 14, int: 10, wis: 16, cha: 10 },
    classes: [{ name: '德鲁伊', level, subclass: '牧人结社（自制）' }],
  });

  it('3 级：有 3 级的两条特性，没有 6 级的；特性文字是自制的', async () => {
    const c = druid(3);
    const sheet = (await env.compute(c)) as Json;
    const feats = ((sheet.features ?? []) as Json[]).filter((f) => f._sub);
    expect(feats.map((f) => f.name)).toEqual(['林地之语', '精魂图腾']);
    expect(JSON.stringify(feats[1].entries)).toContain('召唤精魂图腾');
    const keys = env.abilities.collectSources(c).map(sourceKeyOf);
    expect(keys).toContain('HB-TEST:德鲁伊:精魂图腾:3');
    // 「召唤时从以下精魂中选择一种」不是建卡时的选择：不该冒出待决定
    const pending = ((c as Json)._derived?.pending ?? []) as Json[];
    expect(pending.filter((x) => JSON.stringify(x).includes('精魂')), JSON.stringify(pending.map((x) => x.label))).toEqual([]);
  });

  it('法术表按等级给：3 级有命令术，5 级才有飞行术', async () => {
    const granted = async (lv: number) => (((await env.compute(druid(lv))) as Json).spell?.granted ?? []).map((g: Json) => g.name);
    expect(await granted(3)).toContain('命令术');
    expect(await granted(3)).not.toContain('飞行术');
    expect(await granted(5)).toContain('飞行术');
  });

  it('按特性键写的卡面数据：选了这个子职的卡才生效', async () => {
    const item: LibraryItem = {
      id: 'hr-brew1234', kind: 'subclass', name: '牧人结社（自制）', text: '', by: 'hand', reviewed: true, brew,
      parts: [{ id: 'hr-part1234', key: 'HB-TEST:德鲁伊:林地之语:3', name: '林地之语', sheet: { grants: [{ kind: 'language', values: ['木族语'] }] } }],
    };
    // 走「我的资料库」那一层（本卡家规那层是自己加的，不管有没有这项能力都照加）
    env.homelib.user = () => homeRulesOf(item);
    const langs = async (c: CharData) => JSON.stringify(((await env.compute(c)) as Json).languages ?? '');
    expect(await langs(druid(3))).toContain('木族语');
    const plain: CharData = { ...druid(3), classes: [{ name: '德鲁伊', level: 3, subclass: '月亮结社' }] };
    expect(await langs(plain)).not.toContain('木族语');
  });
});
