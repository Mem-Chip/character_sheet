/**
 * 起始装备（2024 XPHB 规则）：
 * - 职业起始装备（选项 A 套装 / 选项 B 金币，战士有选项 C）
 * - 背景/起源起始装备（选项 A 套装 / 选项 B 50 GP）
 * 解析 5etools 里的 startingEquipment 数据并提供自动填写到人物卡（char.equipment、char.purse）的能力。
 */
import type { CharData } from './character';
import { classSlug } from './source';
import type { SheetEnv } from './env';
import type { Json } from './store';

export interface StartingItemSpec {
  name: string;
  qty: number;
  equipped?: boolean;
  placeholder?: 'instrument' | 'artisan' | 'gaming';
  options?: string[];
}

export interface StartingEquipmentPackage {
  opt: string; // 'A' | 'B' | 'C'
  label: string; // '选项 A' | '选项 B' | '选项 C'
  entries: string;
  gold: number; // GP
  items: StartingItemSpec[];
}

export interface StartingEquipmentResult {
  className?: string;
  classPackages: StartingEquipmentPackage[];
  backgroundName?: string;
  backgroundPackages: StartingEquipmentPackage[];
}

export const INSTRUMENT_OPTIONS = ['鲁特琴', '短笛', '长笛', '角笛', '小提琴', '鼓', '排箫', '风笛', '诗琴', '扬琴'];
export const ARTISAN_OPTIONS = [
  '锻工工具', '木匠工具', '皮革工具', '炼金工具', '烹饪用具', '制图工具', '修补工具',
  '织工工具', '陶工工具', '珠宝工具', '石匠工具', '书法工具', '画师用具', '玻璃工工具', '酿造工具',
];
export const GAMING_OPTIONS = ['骰子组', '牌具', '三龙牌', '龙棋'];

const EQUIPPED_ITEMS = new Set([
  // 护甲与盾牌
  '皮甲', '镶钉皮甲', '链甲衫', '鳞甲', '胸甲', '半身板甲', '环甲', '链甲', '板条甲', '板甲', '法袍', '盾牌',
  // 主要武器
  '巨斧', '手斧', '战斧', '长剑', '短剑', '大剑', '巨剑', '弯刀', '细剑', '长戟', '巨槌', '长枪', '矛', '三叉戟',
  '战锤', '链枷', '硬头锤', '短棒', '巨棒', '短弓', '长弓', '轻弩', '重弩', '手弩', '标枪', '飞镖', '投石索', '镰刀',
  // 服装
  '旅行服装', '高档服装', '戏服',
]);

/** 清除 5etools 标签语法：{@item 巨斧|XPHB} → 巨斧 */
export function clean5eTags(text: string): string {
  return String(text || '')
    .replace(/\{@item ([^}|]+)[^}]*\}/g, '$1')
    .replace(/\{@filter ([^}|]+)[^}]*\}/g, '$1')
    .replace(/\{@dice ([^}|]+)[^}]*\}/g, '$1')
    .replace(/\{@variantrule ([^}|]+)[^}]*\}/g, '$1')
    .replace(/\{@\w+ ([^}|]+)[^}]*\}/g, '$1');
}

/** 解析单个 defaultData 条目数组 */
function parseOptionItems(list: Json[], className?: string, optKey?: string): { items: StartingItemSpec[]; gold: number } {
  const items: StartingItemSpec[] = [];
  let gold = 0;

  for (const it of list || []) {
    if (typeof it === 'string') {
      const nm = it.split('|')[0].trim();
      items.push({ name: nm, qty: 1, equipped: EQUIPPED_ITEMS.has(nm) });
      continue;
    }
    if (it.value != null) {
      // 5etools 货币是以 CP 为单位
      let cp = Number(it.value) || 0;
      // 修正 5etools 牧师选项 A 的笔误（7000 CP 改为 700 CP = 7 GP）
      if (className === '牧师' && optKey === 'A' && cp === 7000) {
        cp = 700;
      }
      gold += Math.floor(cp / 100);
      continue;
    }
    if (it.displayName) {
      const nm = String(it.displayName).trim();
      items.push({ name: nm, qty: Number(it.quantity) || 1, equipped: EQUIPPED_ITEMS.has(nm) });
      continue;
    }
    if (it.item) {
      const nm = String(it.item).split('|')[0].trim();
      const qty = Number(it.quantity) || 1;
      items.push({ name: nm, qty, equipped: EQUIPPED_ITEMS.has(nm) });
      continue;
    }
    if (it.special === '法术书' || it.special) {
      const nm = String(it.special).trim();
      items.push({ name: nm, qty: 1, equipped: false });
      continue;
    }
    // 占位工具项
    if (it.equipmentType === 'instrumentMusical') {
      items.push({ name: '自选乐器', qty: 1, placeholder: 'instrument', options: INSTRUMENT_OPTIONS });
      continue;
    }
    if (it.equipmentType === 'toolArtisan') {
      items.push({ name: '自选工匠工具', qty: 1, placeholder: 'artisan', options: ARTISAN_OPTIONS });
      continue;
    }
    if (it.equipmentType === 'setGaming') {
      items.push({ name: '自选赌具', qty: 1, placeholder: 'gaming', options: GAMING_OPTIONS });
      continue;
    }
    if (Array.isArray(it.equipmentTypes)) {
      // 如武僧：乐器或工匠工具
      const combined = [...INSTRUMENT_OPTIONS, ...ARTISAN_OPTIONS];
      items.push({ name: '自选工具或乐器', qty: 1, placeholder: 'artisan', options: combined });
      continue;
    }
  }

  return { items, gold };
}

/** 获取职业起始装备包列表 */
export async function classStartingEquipment(env: SheetEnv, className: string): Promise<StartingEquipmentPackage[]> {
  const slug = classSlug(className);
  if (!slug) return [];
  const raw = await env.store.classData(slug).catch(() => null);
  if (!raw?.class) return [];
  const cls = (raw.class as Json[]).find((c) => c.name === className && c.source === 'XPHB')
    || (raw.class as Json[]).find((c) => c.name === className);
  const eq = cls?.startingEquipment;
  if (!eq?.defaultData?.[0]) return [];

  const def = eq.defaultData[0] as Record<string, Json[]>;
  const desc = clean5eTags((eq.entries || []).join(' '));
  const out: StartingEquipmentPackage[] = [];

  for (const [opt, list] of Object.entries(def)) {
    const { items, gold } = parseOptionItems(list, className, opt);
    out.push({
      opt,
      label: `选项 ${opt}`,
      entries: desc,
      gold,
      items,
    });
  }

  return out;
}

/** 获取背景起始装备包列表 */
export function backgroundStartingEquipment(env: SheetEnv, backgroundName: string): StartingEquipmentPackage[] {
  const bgs = env.store.data.backgrounds?.background as Json[] || [];
  const bg = bgs.find((b) => b.name === backgroundName && b.source === 'XPHB')
    || bgs.find((b) => b.name === backgroundName);
  const eq = bg?.startingEquipment?.[0] as Record<string, Json[]> | undefined;
  if (!eq) return [];

  const desc = clean5eTags((bg?.entries || []).map((e: Json) => typeof e === 'string' ? e : e.entries ? (e.entries as string[]).join(' ') : '').join(' '));
  const out: StartingEquipmentPackage[] = [];

  for (const [opt, list] of Object.entries(eq)) {
    const { items, gold } = parseOptionItems(list, backgroundName, opt);
    out.push({
      opt,
      label: `选项 ${opt}`,
      entries: desc,
      gold,
      items,
    });
  }

  return out;
}

/** 获取指定职业与背景的全部起始装备包 */
export async function getStartingEquipmentOptions(
  env: SheetEnv,
  className?: string,
  backgroundName?: string
): Promise<StartingEquipmentResult> {
  const [classPackages, backgroundPackages] = await Promise.all([
    className ? classStartingEquipment(env, className) : Promise.resolve([]),
    backgroundName ? Promise.resolve(backgroundStartingEquipment(env, backgroundName)) : Promise.resolve([]),
  ]);
  return {
    className,
    classPackages,
    backgroundName,
    backgroundPackages,
  };
}

/** 将选好的起始装备填入角色卡 */
export function applyStartingEquipment(
  char: CharData,
  classPackage: StartingEquipmentPackage | null,
  classPlaceholders: Record<number, string>,
  bgPackage: StartingEquipmentPackage | null,
  bgPlaceholders: Record<number, string>,
  mode: 'append' | 'replace'
): { addedItems: Array<{ name: string; qty: number; equipped?: boolean }>; totalGold: number; note: string } {
  const toAdd: Array<{ name: string; qty: number; equipped?: boolean }> = [];

  const resolvePkg = (pkg: StartingEquipmentPackage | null, picks: Record<number, string>) => {
    if (!pkg) return;
    pkg.items.forEach((item, idx) => {
      const finalName = (item.placeholder && picks[idx]) ? picks[idx] : item.name;
      toAdd.push({
        name: finalName,
        qty: item.qty || 1,
        equipped: item.equipped,
      });
    });
  };

  resolvePkg(classPackage, classPlaceholders);
  resolvePkg(bgPackage, bgPlaceholders);

  // 合并到 char.equipment
  const existing = mode === 'replace' ? [] : structuredClone(char.equipment || []);
  for (const item of toAdd) {
    const has = existing.find((x: Json) => x.name === item.name && !x.custom && !x.bonus);
    if (has) {
      has.qty = (has.qty || 1) + item.qty;
    } else {
      existing.push({
        name: item.name,
        qty: item.qty,
        equipped: !!item.equipped,
      });
    }
  }
  char.equipment = existing;

  // 金币计算
  const totalGold = (classPackage?.gold || 0) + (bgPackage?.gold || 0);
  if (totalGold > 0) {
    char.purse = { ...(char.purse || {}) };
    char.purse.gp = (Number(char.purse.gp) || 0) + totalGold;

    const parts = [
      classPackage ? `职业${classPackage.label}` : '',
      bgPackage ? `背景${bgPackage.label}` : '',
    ].filter(Boolean);
    const note = `起始装备（${parts.join(' + ')}）`;

    char.purseLog = [
      { at: Date.now(), delta: { gp: totalGold }, note },
      ...(char.purseLog || []),
    ].slice(0, 50);
  }

  const parts = [
    classPackage ? `职业${classPackage.label}` : '',
    bgPackage ? `背景${bgPackage.label}` : '',
  ].filter(Boolean);

  return {
    addedItems: toAdd,
    totalGold,
    note: `已填入起始装备（${parts.join(' + ')}）：+${toAdd.length} 样物品，+${totalGold} 金币`,
  };
}
