/**
 * **一次施法的计划书**（CastPlan）。
 *
 * 为什么需要它：`spellCast` 窗口里有两类能力——声明式的 `modify`（不掷骰、不提问，窗口打开时就要答案）
 * 和过程式的 `do`（可以掷豁免、弹选择框）。「先掷豁免、失败了才打断这道法术」这类规则正好横在两者之间。
 * 所以引擎把「这次施法」整理成一份**可改的计划书**：窗口里的能力改计划书，窗口关掉之后引擎照计划书结算。
 *
 * 计划书只活在**这一趟事务**里（`Tx.casts`）：
 *   - 事务因为要问人而暂停时会带着回答整段重跑，计划书跟着重建，天然一致；
 *   - 不需要落盘、也不需要额外的事件类型。
 */
import type { Id } from './types';

export interface CastPlan {
  /** 这次施法的身份（= actionUsed 事件的 seq） */
  seq: number;
  caster: Id;
  spell: string;
  key: string;
  /** 法术的基础环阶（戏法 = 0）；升环施法时是实际用掉的环阶 */
  level: number;
  targets: Id[];
  /** 施法者原本的豁免 DC / 法术攻击加值（有人在窗口里改了才会变） */
  dc: number | null;
  attackBonus: number | null;
  /** 改伤害类型（null = 按数据原本的类型） */
  damageType: string | null;
  /** 被打断（法术反制这类）：谁打断的、要不要退回法术位 */
  canceled: { by: string; refundSlot: boolean } | null;
  /** 窗口里做过哪些修改（给日志用） */
  notes: string[];
}

export function newCastPlan(o: {
  seq: number; caster: Id; spell: string; key: string; level: number; targets: Id[];
  dc?: number | null; attackBonus?: number | null;
}): CastPlan {
  return {
    seq: o.seq, caster: o.caster, spell: o.spell, key: o.key, level: o.level, targets: o.targets.slice(),
    dc: o.dc ?? null, attackBonus: o.attackBonus ?? null, damageType: null, canceled: null, notes: [],
  };
}
