/**
 * 数据源适配器（移植自原项目 core/source.js）：2024 判据、文件清单、子职候选。换站只改这里。
 * 判据背后的踩坑记录见原项目 source.js 的注释，这里只留结论。
 */

export const BASE_URL = 'https://5e.kiwee.top';

type Ent = { source?: unknown; reprintedAs?: unknown; edition?: unknown; classSource?: unknown; name?: unknown };

export const Source = {
  baseUrl: BASE_URL,
  OFFICIAL_2024: new Set(['XPHB', 'XDMG', 'XMM']),
  /**
   * 战役启用的其他书（5etools 来源代号，大写）：这些书里没有被 2024 重印的内容也能选。
   * 算一张卡之前按它所在的战役设置（SheetEnv.useCampaign）；不在战役里 = 空。
   */
  extra: new Set<string>(),
  /**
   * 资料库覆盖到的**单个条目**的键（`<来源>:<名字>`、`<来源>:spell:<名字>` 等）。
   * 这些条目即使所在的书没启用也能选，但**不会**因此把整本书放出来
   * （以前的写法是把条目带的书塞进 extra，结果导入一条 EFA 的种族就把战俑、龙纹家族全带出来了）。
   */
  covered: new Set<string>(),
  /** 覆盖后的显示名（条目键 → 名字）：选择面板显示它，但**值仍然是原始名字**，键不变、规则照旧对得上 */
  names: new Map<string, string>(),
  /** 这个条目可能对应的几种键（种族 / 专长是 `来源:名字`，法术物品多一段） */
  keysOf(ent: Ent | null | undefined): string[] {
    if (!ent) return [];
    const s = String(ent.source || '').toUpperCase();
    const n = String(ent.name || '');
    if (!s || !n) return [];
    return [`${s}:${n}`, `${s}:spell:${n}`, `${s}:item:${n}`, `${s}:怪物:${n}`];
  },
  /** 这个条目是不是资料库覆盖过的 */
  isCovered(ent: Ent | null | undefined): boolean {
    return this.keysOf(ent).some((k) => this.covered.has(k));
  },
  /** 显示名：资料库覆盖过就用覆盖后的名字，否则用原名 */
  labelOf(ent: Ent | null | undefined): string {
    if (!ent) return '';
    for (const k of this.keysOf(ent)) {
      const n = this.names.get(k);
      if (n) return n;
    }
    return String(ent.name || '');
  },
  /** 来源是不是战役启用的书 */
  isExtra(ent: Ent | null | undefined): boolean {
    return !!ent && this.extra.size > 0 && this.extra.has(String(ent.source || '').toUpperCase()) && !this.isReprinted(ent);
  },
  CLASS_SRC_2024: 'XPHB',
  /** 带 reprintedAs 的条目有更新的版本 → 一律不算 2024 */
  isReprinted(ent: Ent | null | undefined): boolean {
    return !!(ent && Array.isArray(ent.reprintedAs) && ent.reprintedAs.length);
  },
  /** 2024 规则内容：来源白名单 ∧ 没有重印标记（EFA = 2024 奇械师）；资料库单独放行的条目也算 */
  is2024(ent: Ent | null | undefined): boolean {
    if (!ent) return false;
    if (this.isReprinted(ent)) return false;
    const s = String(ent.source || '').toUpperCase();
    if (this.OFFICIAL_2024.has(s)) return true;
    return s === 'EFA' || this.isExtra(ent) || this.isCovered(ent);
  },
  /** 只认 2024 三本核心书（大小写不敏感：背景数据里的来源是小写）；资料库单独放行的条目也算 */
  isCore2024(ent: Ent | null | undefined): boolean {
    if (!ent) return false;
    if (this.isReprinted(ent)) return false;
    return this.OFFICIAL_2024.has(String(ent.source || '').toUpperCase()) || this.isExtra(ent) || this.isCovered(ent);
  },
  isClass2024(c: Ent | null | undefined): boolean { return this.is2024(c); },
  /** 子职是不是按 2024 规则写的那一版：看条目自带的 edition === 'one'，再对齐 classSource */
  isSubclass2024(s: Ent | null | undefined, classSource?: string): boolean {
    if (!s) return false;
    if (this.isReprinted(s)) return false;
    if (classSource && s.classSource !== classSource) return false;
    const ed = String(s.edition || '').toLowerCase();
    // 启用的书里的子职：站点给 2024 职业挂了一份（classSource = XPHB、没有 edition），旧版那份是 classic
    return ed === 'one' || (ed !== 'classic' && this.isExtra(s));
  },
  FILES: {
    classIndex: '/data/class/index.json',
    races: '/data/races.json',
    backgrounds: '/data/backgrounds.json',
    feats: '/data/feats.json',
    itemsBase: '/data/items-base.json',
    languages: '/data/languages.json',
    conditions: '/data/conditionsdiseases.json',
    actions: '/data/actions.json',
    optionalfeatures: '/data/optionalfeatures.json',
    spellsXphb: '/data/spells/spells-xphb.json',
    spellsSources: '/data/spells/sources.json',
    spellsIndex: '/data/spells/index.json',
    books: '/data/books.json',
    variantrules: '/data/variantrules.json',
    items: '/data/items.json',
    skills: '/data/skills.json',
    senses: '/data/senses.json',
    searchIndex: '/search/index.json',
    bestiaryIndex: '/data/bestiary/index.json',
    bestiaryXmm: '/data/bestiary/bestiary-xmm.json',
    deities: '/data/deities.json',
  } as Record<string, string>,
};

/** 子职显示名：非核心来源标出书名（不是「旧版」—— 旧版在加载阶段就被排除了） */
export function subclassLabel(s: { name: string; source?: unknown } | null | undefined): string {
  if (!s) return '';
  return s.name + (Source.isCore2024(s) ? '' : `（${String(s.source)}）`);
}

/** 子职候选表的统一过滤 + 排序（建卡页 / 能力选择页 / 升级预览都用它） */
export function subclassCandidates<T extends Ent & { name: string }>(list: T[] | null | undefined, classSource?: string): T[] {
  return (list || [])
    .filter((s) => Source.isSubclass2024(s, classSource))
    .sort((a, b) => (Source.isCore2024(a) ? 0 : 1) - (Source.isCore2024(b) ? 0 : 1)
      || String(a.name).localeCompare(String(b.name), 'zh'));
}

export const CLASS_SLUG_BY_NAME: Record<string, string> = {
  野蛮人: 'barbarian', 吟游诗人: 'bard', 牧师: 'cleric', 德鲁伊: 'druid', 战士: 'fighter',
  武僧: 'monk', 圣武士: 'paladin', 游侠: 'ranger', 游荡者: 'rogue', 术士: 'sorcerer',
  魔契师: 'warlock', 法师: 'wizard', 奇械师: 'artificer',
  心灵术士: 'mystic', 随从: 'sidekick',
};
export function classSlug(cnName: string): string {
  return CLASS_SLUG_BY_NAME[cnName] || String(cnName).toLowerCase();
}
