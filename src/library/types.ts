/**
 * 账户资料库的数据形状（服务器、浏览器、测试共用，见 LIBRARY.md 第二节）。
 *
 * 一条 = 一份资源（一个专长、一条法术、一个子职…）。一份资源可以拆成多条「条目」（parts）：
 * 一个子职 = 每级特性一条，各条自己的键。卡面数据（sheet）和战斗数据（combat）都挂在 part 上。
 *
 * 键的约定（和引擎一致）：
 * - part.key 写官方键（`XPHB:野蛮人:狂暴:1`）= **覆盖**官方那条；
 * - 写 `HR:<part.id>` = **新内容**（卡上的家规键、房规键都是它）；
 * - 写 `core.<名>` = 改核心参数。
 */
import type { Json } from '../sheet';

/** 一份资源拆出来的一条 */
export interface ResPart {
  /** 这条自己的 id（`hr-xxxx`）：卡上勾选、房规引用、日志都用它 */
  id: string;
  /** 条目键：官方键 = 覆盖；`HR:<id>` = 新内容；`core.<名>` = 核心参数 */
  key: string;
  name?: string;
  /** 这条的原文 / 说明（给人看，AI 也照着写） */
  text?: string;
  /** 卡面：不勾 = 团里每张卡都算；勾了 = 卡上选了才生效（char.hrPicked 记 id） */
  pickable?: boolean;
  /** 卡面数据（写法同 data/abilities-*.json） */
  sheet?: { mods?: Json[]; grants?: Json[]; choices?: Json[]; resources?: Json[] };
  /** 战斗数据：整条替换 entry / 改字段 patch / 改核心参数 value */
  combat?: { entry?: unknown; patch?: Record<string, unknown>; value?: unknown; fill?: boolean };
}

/** 库里的一条：一份资源 */
export interface LibraryItem {
  id: string;
  /** 类别：feat / spell / item / subclass / classFeature / race / optfeature / homerule / monster… */
  kind: string;
  name: string;
  /** 总说明（原文摘要 / 家规正文） */
  text: string;
  /** 5etools 来源代号（搜来的条目有） */
  source?: string;
  /** 出处：用来重新取原文、显示「覆盖了哪条」 */
  ref?: { kind: string; source: string; name: string; cls?: string; level?: number };
  parts: ResPart[];
  /** 谁写的：手写 / AI（byok:<模型名>） */
  by: string;
  reviewed: boolean;
  rev?: number;
  updated?: number;
}

/** 挂到战役的状态：auto = 新内容挂着就生效；pending = 覆盖官方待 DM 点头；on / off = DM 开关的结果 */
export type ShareState = 'auto' | 'pending' | 'on' | 'off';

/** 一条挂载（战役「资源管理器」用） */
export interface ShareView {
  ownerId: number;
  ownerName: string;
  itemId: string;
  item: LibraryItem;
  state: ShareState;
  updated: number;
}
