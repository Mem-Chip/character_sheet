/**
 * 条目键：全项目**只在这里**拆和拼。
 *
 * 同一项能力在卡面层和战斗层用同一个键，形状有这几种：
 *
 *   <来源>:<名字>                    专长、种族特性、背景…（`XPHB:警觉`）
 *   <来源>:<职业>:<特性>:<等级>      职业 / 子职特性（`XPHB:野蛮人:狂暴:1`，子职写 `野蛮人·狂战士`）
 *   <来源>:<类别>:<名字>             法术 spell、物品 item、状态 condition、通用动作 action、武器精通 mastery、怪物（`XMM:怪物:地精`）
 *   HR:<id>                          资料库里的新内容（家规）
 *   core.<名>                        核心参数
 *   inline: / weapon: / summon: / grant:   引擎现场生成的，不在规则书里
 *
 * 键后面可以跟 `#<子名>`：条目里的某个动作 / 效应（`XPHB:spell:祝福术#祝福`），或卡面上的某个决策。
 *
 * 来源不一定是 XPHB：别的书、自制书（`HB-<id>`）都一样。**不要在别处写 `startsWith('XPHB:…')`** ——
 * 那样别的书的状态、动作就认不出来了；用这里的 `isConditionKey` / `keyKind`。
 *
 * 这个文件不依赖任何别的模块（浏览器、服务器、引擎、静态层都能用）。
 */

export const HR_PREFIX = 'HR:';
export const CORE_PREFIX = 'core.';

/** 键的第二段是这些词时，它说的是类别（不是职业名） */
const TAGS = {
  spell: 'spell', item: 'item', condition: 'condition', action: 'action', mastery: 'mastery',
  怪物: 'monster', monster: 'monster', disease: 'disease', variantrule: 'variantrule',
} as const;
type Tag = (typeof TAGS)[keyof typeof TAGS];

/** 引擎现场生成的键的前缀（`inline:祝福`、`weapon:长剑`、`summon:c3`、`grant:…`） */
const LOCAL = ['inline', 'weapon', 'summon', 'grant'];

/**
 * - named：`<来源>:<名字>`；classFeature：四段；
 * - homerule：`HR:<id>`；core：`core.<名>`；local：引擎现场生成的；bare：没有冒号（相对名、`concentration`）
 */
export type KeyKind = Tag | 'named' | 'classFeature' | 'homerule' | 'core' | 'local' | 'bare';

export interface ParsedKey {
  /** 去掉 `#…` 之后的条目键 */
  entry: string;
  /** `#` 后面那段 */
  sub?: string;
  kind: KeyKind;
  /** 来源书（HR / core / local / bare 没有） */
  source?: string;
  /** 名字（法术名、特性名、状态名…）；家规是 id，核心参数是参数名 */
  name: string;
  /** 职业特性：职业那一段原样（可能是 `野蛮人·狂战士`） */
  cls?: string;
  /** 职业特性：等级那一段原样 */
  level?: string;
}

/** `条目键#子名` → [条目键, 子名]（只按第一个 # 切） */
export function splitRef(ref: string): [string, string | undefined] {
  const s = String(ref ?? '');
  const i = s.indexOf('#');
  return i < 0 ? [s, undefined] : [s.slice(0, i), s.slice(i + 1)];
}
export const entryKeyOf = (ref: string): string => splitRef(ref)[0];
export const subOf = (ref: string): string | undefined => splitRef(ref)[1];

export function parseKey(ref: string): ParsedKey {
  const [entry, sub] = splitRef(ref);
  const base = sub === undefined ? { entry } : { entry, sub };
  if (entry.startsWith(HR_PREFIX)) return { ...base, kind: 'homerule', name: entry.slice(HR_PREFIX.length) };
  if (entry.startsWith(CORE_PREFIX)) return { ...base, kind: 'core', name: entry.slice(CORE_PREFIX.length) };
  const p = entry.split(':');
  if (p.length === 1) return { ...base, kind: 'bare', name: entry };
  if (LOCAL.includes(p[0])) return { ...base, kind: 'local', name: p.slice(1).join(':') };
  const source = p[0];
  const tag = p.length >= 3 && Object.prototype.hasOwnProperty.call(TAGS, p[1]) ? TAGS[p[1] as keyof typeof TAGS] : undefined;
  // 名字里可以有冒号（「防护系：xxx」），所以类别后面的全算名字
  if (tag) return { ...base, kind: tag, source, name: p.slice(2).join(':') };
  if (p.length === 4) return { ...base, kind: 'classFeature', source, cls: p[1], name: p[2], level: p[3] };
  return { ...base, kind: 'named', source, name: p.slice(1).join(':') };
}

export const keyKind = (ref: string): KeyKind => parseKey(ref).kind;
/** 键里的名字（下拉框、日志里显示用）：`XPHB:condition:倒地` → 倒地，`XPHB:野蛮人:狂暴:1` → 狂暴 */
export const nameOfKey = (ref: string): string => parseKey(ref).name;
/** 键的来源书（大写）；家规、核心参数、现场生成的没有 */
export const sourceOfKey = (ref: string): string | undefined => parseKey(ref).source?.toUpperCase();

export const isHomeruleKey = (key: string): boolean => String(key ?? '').startsWith(HR_PREFIX);
export const isCoreKey = (key: string): boolean => String(key ?? '').startsWith(CORE_PREFIX);
export const isSpellKey = (ref: string): boolean => keyKind(ref) === 'spell';
export const isConditionKey = (ref: string): boolean => keyKind(ref) === 'condition';
export const isActionKey = (ref: string): boolean => keyKind(ref) === 'action';

/** 是不是「某个状态」的键，哪本书的都算：`isCondition(e.key, '倒地')` */
export function isCondition(ref: string | undefined | null, name: string): boolean {
  if (!ref) return false;
  const k = parseKey(ref);
  return k.kind === 'condition' && k.name === name;
}

/** 家规键 */
export const homeruleKey = (id: string): string => HR_PREFIX + id;

/**
 * 类别 + 来源 + 名字 → 条目键（和 `sourceKeyOf` 一致）。
 * 职业特性缺职业或等级时拼不出来，返回空串。
 */
export function makeKey(kind: string, source: string, name: string, cls?: string, level?: number | string): string {
  if (!source) return '';
  switch (kind) {
    case 'classFeature':
    case 'subclassFeature': return cls && level !== undefined ? `${source}:${cls}:${name}:${level}` : '';
    case 'monster': return `${source}:怪物:${name}`;
    case 'spell': case 'item': case 'condition': case 'action': case 'mastery': case 'disease': case 'variantrule':
      return `${source}:${kind}:${name}`;
    default: return `${source}:${name}`;
  }
}

/** 只知道来源和名字、不知道类别时，它可能对应的几种键（查「这个条目被覆盖过没有」） */
export const candidateKeys = (source: string, name: string): string[] =>
  ['named', 'spell', 'item', 'monster'].map((k) => makeKey(k, source, name));

/** 同一条换一本书：`HB-x:spell:火球术` → `XPHB:spell:火球术`（没有来源的键原样返回） */
export function withSource(ref: string, source: string): string {
  const k = parseKey(ref);
  return k.source === undefined ? ref : source + ref.slice(k.source.length);
}

/**
 * 规则书里某个类别的全部键里，找名字对得上的那条：官方（XPHB）的优先，没有再用别的书的。
 * 界面上「按名字挂状态」用它 —— 自制书里的状态也挂得上。找不到就退回 XPHB 的写法。
 */
export function keyByName(keys: Iterable<string>, kind: Tag, name: string): string {
  let found: string | undefined;
  for (const key of keys) {
    const k = parseKey(key);
    if (k.kind !== kind || k.name !== name) continue;
    if (k.source === 'XPHB') return key;
    found ??= key;
  }
  return found ?? makeKey(kind, 'XPHB', name);
}

/* ============================================================================
 * 卡面上的决策键（`char.decisions` 的键）：`<能力键>#<决策 id>`
 * ========================================================================== */

/** 职业特性的决策属于哪个职业 / 子职 / 等级（不是职业特性的返回 null） */
export function decisionOwner(decisionKey: string): { cls: string; sub: string | null; level: number } | null {
  const p = entryKeyOf(String(decisionKey ?? '')).split(':');
  if (p.length < 4) return null;
  const [cls, sub] = p[1].split('·');
  return { cls, sub: sub ?? null, level: Number(p[3]) };
}

/**
 * 这条决策是不是某个专长带来的。专长的决策键有三种写法：
 * `XPHB:<专长>#…`、`expanded:<专长>#…`（别的能力送的专长）、`XPHB:<专长>:<第几次>#…`（可以重复选的专长）。
 * 是的话返回 `{ nth }`（只有第三种有 nth，从 1 数）；不是返回 null。
 */
export function featDecision(decisionKey: string, feat: string): { nth?: number } | null {
  const k = String(decisionKey ?? '');
  if (k.startsWith(`XPHB:${feat}#`) || k.startsWith(`expanded:${feat}#`)) return {};
  const head = `XPHB:${feat}:`;
  if (!k.startsWith(head)) return null;
  const m = /^(\d+)#/.exec(k.slice(head.length));
  return m ? { nth: Number(m[1]) } : {};
}

/**
 * 专长列表变了之后，哪些决策该删：这个专长一次都不剩 → 它的决策全删；还剩 remain 次 → 删掉第 remain 次之后的。
 * 人物卡整理、建卡页、选择面板三处共用。
 */
export function staleFeatDecisions(decisionKeys: Iterable<string>, feat: string, remain: number): string[] {
  const out: string[] = [];
  for (const k of decisionKeys) {
    const d = featDecision(k, feat);
    if (!d) continue;
    if (remain === 0 || (d.nth !== undefined && d.nth > remain)) out.push(k);
  }
  return out;
}
