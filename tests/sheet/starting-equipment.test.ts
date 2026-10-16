import { beforeAll, describe, expect, it } from 'vitest';
import {
  classStartingEquipment,
  backgroundStartingEquipment,
  getStartingEquipmentOptions,
  applyStartingEquipment,
  blankCharacter,
  type SheetEnv,
  type CharData,
} from '../../src/sheet';
import { createNodeEnv } from '../../src/sheet/node-env';
import { hasLocalData } from '../../src/sheet/node-provider';

describe.skipIf(!hasLocalData())('起始装备 (Starting Equipment)', () => {
  let env: SheetEnv;

  beforeAll(async () => {
    env = await createNodeEnv();
    await env.store.bootstrap();
  });

  it('能正确提取野蛮人、战士、法师的起始装备 A/B/C 选项', async () => {
    const bar = await classStartingEquipment(env, '野蛮人');
    expect(bar).toHaveLength(2);
    expect(bar[0].opt).toBe('A');
    expect(bar[0].gold).toBe(15);
    expect(bar[0].items.some((it) => it.name === '巨斧' && it.equipped)).toBe(true);
    expect(bar[0].items.some((it) => it.name === '手斧' && it.qty === 4)).toBe(true);
    expect(bar[0].items.some((it) => it.name === '探索套组')).toBe(true);
    expect(bar[1].opt).toBe('B');
    expect(bar[1].gold).toBe(75);
    expect(bar[1].items).toHaveLength(0);

    const ftr = await classStartingEquipment(env, '战士');
    expect(ftr).toHaveLength(3); // A, B, C
    expect(ftr[0].opt).toBe('A');
    expect(ftr[0].gold).toBe(4);
    expect(ftr[1].opt).toBe('B');
    expect(ftr[1].gold).toBe(11);
    expect(ftr[2].opt).toBe('C');
    expect(ftr[2].gold).toBe(155);

    const wiz = await classStartingEquipment(env, '法师');
    expect(wiz).toHaveLength(2);
    expect(wiz[0].items.some((it) => it.name === '法术书')).toBe(true);
    expect(wiz[0].gold).toBe(5);
    expect(wiz[1].gold).toBe(55);
  });

  it('牧师的 7 GP 笔误被正确纠正为 7 而非 70', async () => {
    const clr = await classStartingEquipment(env, '牧师');
    expect(clr[0].gold).toBe(7);
    expect(clr[1].gold).toBe(110);
  });

  it('能正确提取全部 16 个背景的起始装备', async () => {
    const bgs = ['侍僧', '工匠', '骗子', '罪犯', '艺人', '农民', '警卫', '向导', '隐士', '商人', '贵族', '智者', '水手', '抄写员', '士兵', '流浪者'];
    for (const bgName of bgs) {
      const pkgs = backgroundStartingEquipment(env, bgName);
      expect(pkgs.length, `背景 ${bgName} 应该有选项`).toBeGreaterThanOrEqual(2);
      expect(pkgs[0].opt).toBe('A');
      expect(pkgs[1].opt).toBe('B');
      expect(pkgs[1].gold).toBe(50);
    }
  });

  it('自动填写起始装备能正确合并到角色的装备和钱包', async () => {
    const char: CharData = {
      ...blankCharacter(),
      equipment: [{ name: '传家宝匕首', qty: 1 }],
      purse: { gp: 10 },
    };

    const bar = await classStartingEquipment(env, '野蛮人');
    const aco = backgroundStartingEquipment(env, '侍僧');

    const res = applyStartingEquipment(
      char,
      bar[0],
      {},
      aco[0],
      {},
      'append'
    );

    // 装备增加
    expect(char.equipment.some((it: any) => it.name === '巨斧')).toBe(true);
    expect(char.equipment.some((it: any) => it.name === '手斧' && it.qty === 4)).toBe(true);
    expect(char.equipment.some((it: any) => it.name === '祈祷书')).toBe(true);
    expect(char.equipment.some((it: any) => it.name === '传家宝匕首')).toBe(true); // 保留原有

    // 金币增加：10 (原本) + 15 (野蛮人A) + 8 (侍僧A) = 33
    expect(char.purse?.gp).toBe(33);
    expect(char.purseLog?.length).toBe(1);
    expect(char.purseLog?.[0].delta.gp).toBe(23);
  });

  it('覆盖模式会清空原有装备，替换为起始装备', async () => {
    const char: CharData = {
      ...blankCharacter(),
      equipment: [{ name: '旧衣服', qty: 1 }],
    };

    const bar = await classStartingEquipment(env, '野蛮人');
    applyStartingEquipment(char, bar[0], {}, null, {}, 'replace');

    expect(char.equipment.some((it: any) => it.name === '旧衣服')).toBe(false);
    expect(char.equipment.some((it: any) => it.name === '巨斧')).toBe(true);
  });
});
