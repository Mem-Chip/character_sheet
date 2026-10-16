/**
 * 账户资料库：条目到两个规则层的映射（卡面 HomeRuleEntry、战斗 HouseRule）。
 *
 * 两种 part：
 * - 覆盖官方：key 就是官方条目键。卡面的 covers、战斗的房规键都用它。
 * - 新内容：key 写 `HR:<part.id>`。卡上这条能力的键（sourceKeyOf）也是 `HR:<id>`，两边天然对上。
 *
 * 纯逻辑，浏览器和 Node 共用。
 */
import type { HouseRule } from '../combat';
import type { HomeRuleEntry } from '../sheet';
import type { LibraryItem, ResPart } from './types';

/** key 是不是在覆盖官方（`HR:` 开头的是新内容） */
export const isOverrideKey = (key: string): boolean => !String(key).startsWith('HR:');

/** 这条 part 在引擎里的条目键 */
export const ruleKeyOf = (p: ResPart): string => (isOverrideKey(p.key) ? p.key : `HR:${p.id}`);

/** 这条 part 覆盖了哪条官方条目（新内容 = 空） */
export const coversOf = (p: ResPart): string => (isOverrideKey(p.key) ? p.key : '');

const arr = <T>(x: unknown): T[] => (Array.isArray(x) ? (x as T[]) : []);

/** 这条 part 有没有卡面数据（四个数组里有东西才算） */
export const hasSheetData = (p: ResPart): boolean =>
  !!p.sheet && (['mods', 'grants', 'choices', 'resources'] as const).some((k) => arr(p.sheet?.[k]).length > 0);

/**
 * part → 卡面家规条目；不进卡面的返回 null。
 *
 * **只写战斗数据的一条不进卡面**：它的键虽然是官方键（covers 非空），但一条空的卡面家规会把官方
 * 卡面数据顶掉。所以只有在真的带了卡面数据、或者「选了才生效」时才出条目。
 * 「选了才生效」只对新内容有意义（覆盖官方是按能力键生效的），所以覆盖官方的那种不设 pickable。
 */
export function homeRuleOf(p: ResPart, item: LibraryItem): HomeRuleEntry | null {
  const covers = coversOf(p);
  const pickable = !!p.pickable && !covers;
  if (!hasSheetData(p) && !pickable) return null;
  return {
    id: p.id,
    name: p.name || item.name,
    text: p.text ?? item.text,
    covers,
    pickable,
    mods: arr(p.sheet?.mods),
    grants: arr(p.sheet?.grants),
    choices: arr(p.sheet?.choices),
    resources: arr(p.sheet?.resources),
  };
}

export function homeRulesOf(item: LibraryItem): HomeRuleEntry[] {
  return (item.parts ?? []).map((p) => homeRuleOf(p, item)).filter((x): x is HomeRuleEntry => !!x);
}

/** part → 战斗房规；没有战斗部分返回 null */
export function houseRuleOf(p: ResPart, item: LibraryItem): HouseRule | null {
  const c = p.combat;
  if (!c) return null;
  const key = ruleKeyOf(p);
  return {
    id: p.id,
    key,
    text: String(p.text ?? item.text ?? '').trim() || p.name || item.name,
    ...(c.entry !== undefined ? { entry: c.entry as HouseRule['entry'], ...(key.startsWith('HR:') ? {} : { fill: true }) } : {}),
    ...(c.patch !== undefined ? { patch: c.patch } : {}),
    ...(c.value !== undefined ? { value: c.value } : {}),
  };
}

export function houseRulesOf(item: LibraryItem): HouseRule[] {
  return (item.parts ?? []).map((p) => houseRuleOf(p, item)).filter((x): x is HouseRule => !!x);
}

export const homeRulesFor = (items: LibraryItem[]): HomeRuleEntry[] => items.flatMap(homeRulesOf);
export const houseRulesFor = (items: LibraryItem[]): HouseRule[] => items.flatMap(houseRulesOf);

/** 从条目键猜类别（新写一条内容时要知道自己是什么；猜不出就算家规） */
export function kindOfKey(key: string): string {
  const parts = String(key).split(':');
  if (parts[1] === 'spell') return 'spell';
  if (parts[1] === 'item') return 'item';
  if (parts[1] === 'monster') return 'monster';
  if (parts[1] === 'condition' || parts[1] === 'action') return 'homerule';
  if (parts.length === 4) return 'classFeature';
  if (String(key).startsWith('HR:') || String(key).startsWith('core.')) return 'homerule';
  return 'feat';
}

/**
 * 这条内容带的来源书（条目键的前缀，比如 `XGE:spell:…` → XGE）。
 * 用在算卡上：自己的卡即使不在战役里，也要能选到这些书里的内容。
 */
export function sourcesOfItem(item: LibraryItem): string[] {
  const out = new Set<string>();
  if (item.source) out.add(String(item.source).toUpperCase());
  for (const p of item.parts ?? []) {
    const key = String(p.key ?? '');
    if (!key || key.startsWith('HR:') || key.startsWith('core.')) continue;
    const src = key.split(':')[0].toUpperCase();
    if (/^[A-Z0-9-]{1,24}$/.test(src)) out.add(src);
  }
  return [...out];
}
