import spellMeta from '../../data/spell-meta.json';
import type { Value } from '../expr';
import { refOf } from './scope';
import type { Tx } from './tx';
import type { Action, AttackInfo, Entry, Id, Node } from './types';

/**
 * **动作实例**：一次动作（施一道法术、一次武器攻击、用一项特性）从开始到结算完。
 *
 * executeAction 开始时压进 `tx.actions`，结束时弹出。这期间引擎打开的每个窗口、求值的每个表达式
 * （触发器条件、检定修正、效果节点）都能用 `action.*` 读到它 —— 「这是不是戏法」「什么学派」「本次施法加过没有」。
 * 触发器的 do 里没有新动作，所以读到的就是**触发它的那次动作**；被窗口触发的反应动作（护盾术）会压自己的实例，
 * 它的 `trigger.when` / `requires` 在压之前求值，读到的仍是触发它的那次，进了 root 之后用 `action.parent`。
 *
 * 只活在一次事务里：重放时照样重建，所以撤销、事后裁定不受影响。设计见 COMBAT-DESIGN §十六「动作实例」。
 */

export interface SpellMeta {
  level: number;
  /** 学派中文名（塑能、防护…）；自制法术不知道就是空字符串 */
  school: string;
  /** 在哪些职业的法术列表里（中文职业名） */
  lists: string[];
  concentration: boolean;
  ritual: boolean;
  /** 射程（尺），或 'touch' / 'self' / 'sight' / 'unlimited'；不知道 = null */
  range: number | string | null;
  /** 'VSM' 的子集 */
  components: string;
}

/** 一个攻击 / 豁免节点结算到一半、留给窗口里的能力「改走哪一支」用的现场 */
export interface PendingBranch {
  kind: 'attack' | 'save';
  target: Id;
  /** 节点本身（onHit / onMiss / onFail / onSuccess 都在上面） */
  node: Extract<Node, { kind: 'attack' }> | Extract<Node, { kind: 'save' }>;
  /** 实际跑了哪一支 */
  ran: 'onHit' | 'onMiss' | 'onFail' | 'onSuccess';
  /** 跑分支时用的执行上下文（就是原节点本来会用的那份；类型在 exec.ts，这里不引用以免循环） */
  ctx: unknown;
}

export interface ActionInstance {
  /** = actionUsed 事件的 seq */
  seq: number;
  by: Id;
  name: string;
  key: string;
  kind: 'spell' | 'weapon' | 'item' | 'feature';
  economy: string;
  onMyTurn: boolean;
  /** 法术才有；slot = 实际用的环阶（戏法、免位施放 = 基础环阶） */
  spell: (SpellMeta & { slot: number }) | null;
  /** 最近一次攻击节点的性质（还没攻击 = null） */
  attack: AttackInfo | null;
  targets: Id[];
  /** 实例上的记号（mark 节点、rollMod.mark 写）：「这次施法已经加过强效塑能」 */
  marks: Record<string, Value>;
  /** 记号是哪次共享伤害掷骰做的（hideMarksOfRoll 用） */
  markRoll: Record<string, string>;
  /** 付掉的代价（refund 节点用） */
  paid: { slot?: number; resources: Array<{ id: string; n: number }> };
  /** 外层的那次动作（反应的反应；窗口里用的动作）；没有 = null */
  parent: ActionInstance | null;
  /** 当前停在哪个攻击 / 豁免的结果上（attackMissed / saveSucceeded 窗口里 runBranch 用） */
  pending: PendingBranch | null;
  /** 区域生效时压的实例：是哪块区域（不是区域 = 没有） */
  zone?: string;
}

const META = spellMeta as Record<string, SpellMeta>;

/** 法术元数据：条目自带的（自制法术）优先，否则查 5etools 生成的表；再不行按法术位推环阶 */
export function spellMetaOf(key: string, entry: Entry | undefined, action: Action): SpellMeta {
  const own = (entry as { spell?: Partial<SpellMeta> } | undefined)?.spell;
  const base = META[key] ?? META[key.replace(/^[^:]+:/, 'XPHB:')];
  const slotMin = (action.cost ?? []).flatMap((k) => ('slot' in k ? [k.slot.min] : []))[0];
  return {
    level: own?.level ?? base?.level ?? slotMin ?? 0,
    school: own?.school ?? base?.school ?? '',
    lists: own?.lists ?? base?.lists ?? [],
    concentration: own?.concentration ?? base?.concentration ?? !!action.concentration,
    ritual: own?.ritual ?? base?.ritual ?? false,
    range: own?.range ?? base?.range ?? (typeof action.targeting?.range === 'number' || typeof action.targeting?.range === 'string' ? action.targeting.range : null),
    components: own?.components ?? base?.components ?? '',
  };
}

export const currentAction = (tx: Tx): ActionInstance | null => tx.actions[tx.actions.length - 1] ?? null;

/**
 * 在当前动作上做记号（mark 节点、rollMod.mark）。不在动作里就什么也不做。
 * roll = 做记号的那次**伤害掷骰**（共享掷骰的 id）：同一次掷骰的其他目标看不见这个记号（见 hideMarksOfRoll）。
 */
export function markAction(tx: Tx, name: string, value: Value, roll?: string): void {
  const a = currentAction(tx);
  if (!a) return;
  a.marks[name] = value;
  if (roll) a.markRoll[name] = roll;
  else delete a.markRoll[name];
}

/**
 * 火球术对每个目标用**同一次**伤害掷骰（数据里的共享 id），但每个目标是分开结算的。
 * 「每次施法只有一次伤害掷骰能加」（强效塑能）：第一个目标加上之后做了记号，后面的目标还是同一次掷骰，得照样加 ——
 * 结算这次掷骰的其他目标时，把这次掷骰自己做的记号暂时藏起来。灼热射线的三道射线是三次掷骰，第二道就看得见记号了。
 */
export function hideMarksOfRoll<T>(tx: Tx, roll: string | undefined, fn: () => T): T {
  const a = currentAction(tx);
  if (!a || !roll) return fn();
  const hidden: Array<[string, Value]> = [];
  for (const [m, r] of Object.entries(a.markRoll)) if (r === roll && m in a.marks) { hidden.push([m, a.marks[m]]); delete a.marks[m]; }
  try { return fn(); } finally { for (const [m, v] of hidden) if (!(m in a.marks)) a.marks[m] = v; }
}

/** 表达式里的 `action`：每次现读（marks、attack 在结算中会变） */
export function actionValue(tx: Tx, a: ActionInstance | null): Value {
  if (!a) return null;
  return {
    name: a.name, key: a.key, kind: a.kind, economy: a.economy, onMyTurn: a.onMyTurn,
    by: tx.state.combatants[a.by] ? refOf(tx, a.by) : null,
    spell: a.spell ? { ...a.spell, lists: [...a.spell.lists] } : null,
    attack: a.attack ? ({ ...a.attack } as unknown as Record<string, Value>) : null,
    targets: a.targets.filter((t) => tx.state.combatants[t]).map((t) => refOf(tx, t)),
    targetCount: a.targets.length,
    zone: a.zone ?? null,
    marks: { ...a.marks },
    parent: a.parent ? actionValue(tx, a.parent) : null,
  } as Record<string, Value>;
}
