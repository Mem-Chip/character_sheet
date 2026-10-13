/**
 * 动态规则层的数据形状。对应 COMBAT-DESIGN.md §三（运行时对象）与 §四（声明 schema）。
 * 这里只有类型，没有逻辑。
 */
import type { Ability, ExprSrc } from '../expr';

export type Id = string;
export type EffectId = string;
export type UserId = string;
/** `${round}:${turnIndex}` —— 「每回合一次」按它记账（任何人的回合都算一个回合） */
export type TurnKey = string;

/* ============================================================================
 * 声明（数据里写的东西）
 * ========================================================================== */

export type RollKind = 'attack' | 'save' | 'check';
/** RollMod / 触发器筛选用：在三大类之外还能点名几个特殊检定 */
export type RollFilterKind = RollKind | 'd20' | 'damage' | 'initiative' | 'deathSave' | 'concentration';

export interface RollFilter {
  kind: RollFilterKind | RollFilterKind[];
  ability?: Ability | Ability[];
  skill?: string | string[];
  attack?: { melee?: boolean; ranged?: boolean; weapon?: boolean; spell?: boolean };
}

export type RollOp =
  | 'adv' | 'disadv' | 'add' | 'addDice' | 'autoFail' | 'autoSucceed'
  | 'critRange' | 'autoCritOnHit' | 'minD20' | 'minDie' | 'targetAdd';

export interface RollMod {
  on: RollFilter;
  /** bearer = 持有者掷的；against = 别人对持有者发起的攻击 */
  who: 'bearer' | 'against';
  when?: ExprSrc;
  op: RollOp;
  value?: ExprSrc;
  label: string;
}

/** 静态修正（与原项目 mods 同形，只收动态层需要的几种）。值可以是表达式（在承受者作用域里求值） */
export type StaticMod =
  | { kind: 'ac'; bonus: ExprSrc }
  | { kind: 'speed'; bonus: ExprSrc }
  | { kind: 'speedSet'; value: number; lock?: boolean }
  | { kind: 'resist'; values: string[] }
  | { kind: 'resistAll' }
  | { kind: 'immune'; values: string[] }
  | { kind: 'vuln'; values: string[] }
  | { kind: 'conditionImmune'; values: string[] };

export interface Flags {
  /** 对应经济视为 0（失能） */
  blocks?: Array<'action' | 'bonus' | 'reaction'>;
  /** 施加时结束承受者的专注（失能） */
  breaksConcentration?: boolean;
  /** concentrate / castSpells / speak / see / hear / perceive / moveCloser:source … */
  cannot?: string[];
  /** 选目标时排除效应来源（魅惑） */
  forbidTarget?: 'source';
}

export interface Duration {
  instant?: true;
  rounds?: number;
  minutes?: number;
  hours?: number;
  until?: { at: 'turnStart' | 'turnEnd'; of: 'bearer' | 'source'; nth?: number };
  max?: { rounds?: number; minutes?: number; hours?: number };
  saveEnds?: { ability: Ability; dc?: ExprSrc; at: 'turnStart' | 'turnEnd' };
  endsOn?: Array<{ event: string; when?: ExprSrc }>;
  manual?: true;
}

export interface EffectTemplate {
  name?: string;
  duration?: Duration;
  statics?: StaticMod[];
  rollMods?: RollMod[];
  triggers?: Trigger[];
  aura?: Aura;
  flags?: Flags;
  /** 隐含的状态（全键）：随本效应一起存在、一起结束 */
  implies?: string[];
  stackKey?: string;
  /** 'level' = 力竭那种按等级累加 */
  stack?: 'replace' | 'level';
  /** 按等级累加的效应到这一级时死亡（力竭 6 级） */
  deathAtLevel?: number;
  /** 施加时执行（昏迷：独立施加倒地） */
  onApply?: Node[];
  onEnd?: Node[];
  tags?: string[];
  text?: string;
}

export interface Aura {
  id: string;
  radius: number;
  affects: 'allies' | 'enemies' | 'all';
  includeSelf: boolean;
  requires?: ExprSrc;
  grant: Pick<EffectTemplate, 'rollMods' | 'statics' | 'triggers'>;
  stackKey?: string;
}

export type Cost =
  | { economy: 'action' | 'bonus' | 'reaction' | 'attack' | 'move'; n?: ExprSrc }
  | { resource: string; n?: ExprSrc }
  | { slot: { min: number; max?: number } }
  | { recharge: '5-6' | '6' }
  | { charges: string; n?: ExprSrc };

export type TriggerWindow = 'before' | 'after';

export interface TriggerSpec {
  on: string | string[];
  role: 'actor' | 'target' | 'any' | 'ally' | 'enemy';
  window?: TriggerWindow;
  deferTo?: string;
  when?: ExprSrc;
}

export type Modify =
  | { op: 'reroll'; die: 'd20'; keep: 'new' | 'higher' }
  | { op: 'addToRoll'; value: ExprSrc }
  | { op: 'reduceDamage'; value: ExprSrc; types?: string[] }
  | { op: 'halveDamage' }
  | { op: 'setHp'; value: ExprSrc }
  | { op: 'cancel' };

export interface Trigger extends TriggerSpec {
  id: string;
  optional?: boolean;
  limit?: 'oncePerTurn' | 'oncePerRound' | { resource: string };
  cost?: Cost[];
  do?: Node[];
  modify?: Modify[];
  label?: string;
}

export type Activation =
  | 'action' | 'bonus' | 'reaction' | 'free' | 'none'
  | { legendary: number }
  | { minutes: number };

export interface Area {
  shape: 'sphere' | 'cylinder' | 'cone' | 'cube' | 'emanation' | 'line';
  radius?: number;
  size?: number;
  length?: number;
  width?: number;
}

export interface Targeting {
  type: 'self' | 'creature' | 'point' | 'area';
  count?: ExprSrc;
  range?: number | 'touch' | 'self' | 'reach';
  area?: Area;
  filter?: ExprSrc;
}

export interface Action {
  id: string;
  name: string;
  activation: Activation;
  trigger?: TriggerSpec;
  cost?: Cost[];
  requires?: ExprSrc;
  targeting?: Targeting;
  /** 专注法术：施放时开启专注（时长），本动作施加的效应默认链接到它 */
  concentration?: Duration;
  root: Node[];
  tags?: string[];
  text?: string;
}

/** 攻击的描述（武器行由适配器生成；法术攻击在数据里写） */
export interface AttackInfo {
  melee: boolean;
  ranged: boolean;
  weapon: boolean;
  spell: boolean;
  unarmed: boolean;
  finesse: boolean;
  reach: boolean;
  ability: Ability | null;
  damageType: string;
  item: string | null;
  mastery: string | null;
}

export type Node =
  | { kind: 'attack'; bonus?: ExprSrc; attack?: Partial<AttackInfo>; critRange?: ExprSrc; onHit?: Node[]; onMiss?: Node[] }
  /** ability 写成数组 = 由目标选择（引擎替目标选加值高的那个，例如擒抱：力量或敏捷） */
  | { kind: 'save'; ability: Ability | Ability[]; dc: ExprSrc; onFail?: Node[]; onSuccess?: Node[] }
  | { kind: 'check'; ability: Ability; skill?: string; dc: ExprSrc; onFail?: Node[]; onSuccess?: Node[] }
  | { kind: 'damage'; dice?: ExprSrc; type?: string; id?: string; ref?: string; scale?: number; to?: NodeTarget }
  | { kind: 'addDamage'; dice: ExprSrc; type: string }
  | { kind: 'heal'; amount: ExprSrc; to?: NodeTarget }
  | { kind: 'tempHp'; amount: ExprSrc; to?: NodeTarget }
  | {
      kind: 'applyEffect'; template?: string; inline?: EffectTemplate; name?: string; to?: NodeTarget | 'each';
      duration?: Duration; link?: boolean; potency?: ExprSrc; state?: Record<string, ExprSrc>;
    }
  | { kind: 'removeEffect'; match: { key?: string; name?: string; tag?: string }; from?: NodeTarget }
  | { kind: 'extendEffect'; template: string }
  | { kind: 'resource'; id: string; delta: ExprSrc }
  | { kind: 'economy'; action?: number; bonus?: number; reaction?: number; attacks?: number; move?: ExprSrc }
  | { kind: 'choose'; prompt: string; options: Array<{ label: string; do: Node[] }>; count?: number }
  | { kind: 'if'; when: ExprSrc; then?: Node[]; else?: Node[] }
  | { kind: 'forEach'; in: 'targets' | 'area'; do: Node[] }
  | { kind: 'repeat'; n: ExprSrc; do: Node[] }
  | { kind: 'move'; mode: 'push' | 'pull' | 'teleport'; ft: ExprSrc }
  | { kind: 'note'; text: string };

export type NodeTarget = 'target' | 'self';

/** 一个规则条目（官方条目的动态层 / 状态 / 通用动作 / 精通 / 房规） */
export interface Entry {
  name?: string;
  text?: string;
  /** 全局条目：对所有参与者生效（武器精通、核心规则里的可选规则） */
  global?: boolean;
  actions?: Action[];
  triggers?: Trigger[];
  rollMods?: RollMod[];
  auras?: Aura[];
  effects?: Record<string, EffectTemplate>;
  automation?: 'full' | 'partial' | 'manual';
  tags?: string[];
}

/* ============================================================================
 * 运行时对象
 * ========================================================================== */

export interface AttackRow {
  id: string;
  name: string;
  bonus: number;
  damage: string;
  damageType: string;
  melee: boolean;
  ranged: boolean;
  finesse: boolean;
  reach?: boolean;
  ability: Ability;
  mastery?: string | null;
  range?: number;
}

/** 静态数值快照（PC 来自人物卡管线，怪物来自数据卡，测试里手搓） */
export interface CombatantView {
  name: string;
  size: string;
  type: string;
  ac: number;
  hpMax: number;
  speed: number;
  pb: number;
  level: number;
  levels: Record<string, number>;
  score: Record<Ability, number>;
  mod: Record<Ability, number>;
  save: Record<Ability, number>;
  skill: Record<string, number>;
  initiative: number;
  spell: { dc: number; atk: number; mod: number; ability: Ability } | null;
  resist: string[];
  immune: string[];
  vuln: string[];
  conditionImmune: string[];
  attacks: AttackRow[];
  attacksPerAction: number;
  /** 这个参与者拥有的规则条目键（特性、专长、种族、已准备法术…） */
  sources: string[];
  resources: Record<string, number>;
  /** 资源 id → 显示名（界面用；引擎只认 id） */
  resourceNames: Record<string, string>;
  slots: Record<number, number>;
  /** 职业等级表当前行（`classTable('偷袭')` → '3d6'） */
  classTable: Record<string, string | number>;
  wearing: string[];
}

export interface LiveState {
  hp: number;
  tempHp: number;
  deathSaves: { s: number; f: number };
  resourcesUsed: Record<string, number>;
  slotsUsed: Record<number, number>;
  heroicInspiration: boolean;
  stable: boolean;
  dead: boolean;
}

export interface Economy {
  action: number;
  bonus: number;
  reaction: number;
  move: number;
  attacksLeft: number;
  slotSpellCast: boolean;
  /** 次数限制记账：key → 用掉时的 TurnKey / 轮 */
  once: Record<string, string>;
}

export interface Combatant {
  id: Id;
  kind: 'pc' | 'npc' | 'monster';
  name: string;
  controller: UserId;
  side: string;
  base: CombatantView;
  live: LiveState;
  economy: Economy;
  initiative: number | null;
}

export interface ActiveEffect {
  id: EffectId;
  key: string;
  name: string;
  /** 现场写的效应（场景效应 / DM 手动）没有规则条目，模板就存在实例上 */
  inline?: EffectTemplate;
  bearer: Id;
  source: Id | null;
  origin: { kind: 'spell' | 'feature' | 'item' | 'condition' | 'mastery' | 'manual' | 'rule'; ref: string };
  appliedSeq: number;
  duration: Duration;
  timing: {
    /** 施加时轮到谁（rounds / max 按这个人的回合开始计数）；战斗外为 null */
    tickOf: Id | null;
    ticks: number;
    /** until.of 那个人在锚点之后开始了几个回合 */
    untilCount: number;
  };
  link: { concentration: EffectId } | null;
  snap: Record<string, unknown>;
  stackKey: string;
  potency: number;
  suppressed: boolean;
  state: Record<string, unknown>;
  tags: string[];
}

export interface Settings {
  automation: 'auto' | 'assist' | 'manual';
  dice: Record<string, 'engine' | 'physical' | string>;
  monsterAt0: 'dead' | 'unconscious';
  reactionTiming: 'afterResult' | 'raw';
  /** 有推测的问题是否直接按推测走（false = 一律问人） */
  useGuesses: boolean;
}

export interface RememberedAnswer {
  value: boolean;
  scope: 'turn' | 'round' | 'sticky';
  at: TurnKey;
}

export interface EncounterState {
  id: string;
  round: number | null;
  turnIndex: number;
  order: Id[];
  combatants: Record<Id, Combatant>;
  effects: Record<EffectId, ActiveEffect>;
  answers: Record<string, RememberedAnswer>;
  settings: Settings;
  seq: number;
  nextId: number;
}

/* ============================================================================
 * 事件与命令
 * ========================================================================== */

export interface GameEvent {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  cause: number | null;
}

export type Command =
  | { type: 'addCombatant'; combatant: Combatant }
  | { type: 'removeCombatant'; id: Id }
  | { type: 'startCombat'; order?: Id[] }
  | { type: 'nextTurn' }
  | { type: 'endCombat' }
  | { type: 'useAction'; actor: Id; action: string; targets?: Id[]; slotLevel?: number; options?: Record<string, unknown>; force?: boolean }
  | { type: 'roll'; roller: Id; kind: RollKind; ability?: Ability; skill?: string; dc?: number; label?: string }
  | { type: 'applyEffect'; to: Id; template?: string; inline?: EffectTemplate; name?: string; duration?: Duration; source?: Id | null }
  | { type: 'removeEffect'; id: EffectId }
  | { type: 'adjustHp'; id: Id; delta?: number; set?: number; temp?: number }
  | { type: 'damage'; id: Id; amount: number; damageType: string; source?: Id | null }
  /** 手动治疗：与法术治疗走同一条路（0 生命值时的昏迷随之结束） */
  | { type: 'heal'; id: Id; amount: number }
  | { type: 'tempHp'; id: Id; amount: number }
  /** 没有动态数据的法术：照样付代价（法术位、动作）、开专注、发 spellCast，效果由人处理 */
  | {
      type: 'manualCast'; actor: Id; spell: string; slotLevel?: number;
      activation?: 'action' | 'bonus' | 'reaction' | 'none'; concentration?: boolean; targets?: Id[]; force?: boolean;
    }
  /** 手动改次数：资源或某一环法术位「已用」多少 */
  | { type: 'setUsage'; id: Id; resource?: string; slot?: number; used: number }
  | { type: 'endConcentration'; id: Id }
  | { type: 'advanceTime'; minutes: number }
  | { type: 'rest'; kind: 'short' | 'long'; ids?: Id[] }
  | { type: 'setSettings'; settings: Partial<Settings> };

export type DecisionKind = 'optionalTrigger' | 'ask' | 'choose' | 'slotLevel' | 'physicalDice' | 'targets';

export interface DecisionOption {
  id: string;
  label: string;
  detail?: string;
}

export interface Decision {
  id: string;
  kind: DecisionKind;
  to: UserId;
  prompt: string;
  options: DecisionOption[];
  /** ask：要回答的问题 */
  questions?: Array<{ id: string; text: string; guess?: boolean; scope: string }>;
  /** physicalDice：要输入几颗几面骰 */
  dice?: Array<{ faces: number; count: number }>;
  multi?: boolean;
  default: unknown;
}

/** 一次性裁定（§15.3）：按「这笔事务里的第几次掷骰 / 第几次伤害」定位，重放时依旧能对上 */
export type OverridePatch =
  | { roll: number; outcome?: 'hit' | 'miss' | 'crit' | 'success' | 'fail'; total?: number; reason?: string }
  | { damage: number; amounts: Record<string, number>; reason?: string };
