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
export type RollFilterKind = RollKind | 'd20' | 'damage' | 'heal' | 'initiative' | 'deathSave' | 'concentration';

export interface RollFilter {
  kind: RollFilterKind | RollFilterKind[];
  ability?: Ability | Ability[];
  skill?: string | string[];
  attack?: { melee?: boolean; ranged?: boolean; weapon?: boolean; spell?: boolean };
  /** 伤害 / 治疗骰：只管来自法术的（true）或不是法术的（false） */
  spell?: boolean;
}

export type RollOp =
  | 'adv' | 'disadv' | 'add' | 'addDice' | 'autoFail' | 'autoSucceed'
  | 'critRange' | 'autoCritOnHit' | 'minD20' | 'minDie' | 'targetAdd'
  /** 伤害骰 / 治疗骰全部取最大值（极效治疗、超限导能） */
  | 'maxDice'
  /** 不能获得优势（序列意识、飘忽不定：who: 'against' 时别人打你没有优势） */
  | 'noAdv';

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
  /** 法术豁免 DC 加值（先天术法） */
  | { kind: 'spellDc'; bonus: ExprSrc }
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
  /** 瞬发法术：下一道施法时间为动作的法术改用附赠动作施放（放完这个效应就结束） */
  quicken?: boolean;
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
  /** 充能：用过之后在自己回合开始时掷 d6，达到就恢复。id = 记在 resourcesUsed 里的名字（同一个参与者里唯一） */
  | { recharge: '5-6' | '6'; id?: string }
  | { charges: string; n?: ExprSrc };

export type TriggerWindow = 'before' | 'after';

export interface TriggerSpec {
  on: string | string[];
  role: 'actor' | 'target' | 'any' | 'ally' | 'enemy';
  window?: TriggerWindow;
  deferTo?: string;
  when?: ExprSrc;
  /**
   * 反应动作打谁：缺省是窗口的承受者（至圣斩打被命中的、护盾术护自己）；
   * 'actor' = 窗口的发起者（炼狱叱喝打伤害来源、法术反制打施法者）
   */
  aim?: 'actor' | 'target';
}

export type Modify =
  | { op: 'reroll'; die: 'd20'; keep: 'new' | 'higher' | 'lower' }
  | { op: 'addToRoll'; value: ExprSrc }
  /** value 可以带骰子（1d10 + pb），由能力持有者掷一次 */
  | { op: 'reduceDamage'; value: ExprSrc; types?: string[] }
  | { op: 'halveDamage' }
  /** 伤害翻倍（致命一击） */
  | { op: 'doubleDamage' }
  | { op: 'setHp'; value: ExprSrc }
  /**
   * 抵消 / 打断：
   *   - damageIncoming：这次伤害归零（护盾术免疫魔法飞弹）；
   *   - attackHit（防守段）：这次攻击改为未命中（镜影术、幻影化形、不破威仪）；
   *   - spellCast：打断施法，法术消散、动作浪费；refundSlot 缺省 true（2024 法术反制：返还法术位），false = 法术位照常消耗。
   */
  | { op: 'cancel'; refundSlot?: boolean }
  /**
   * 打断但**先让那个生物掷一次豁免**：`against` 默认是这次施法的施法者（attacker）。
   * 值在窗口里就掷（同步），失败了才真的 cancel —— 法术反制这类「先豁免再决定」用它。
   */
  | { op: 'cancelUnlessSave'; ability: Ability; dc: ExprSrc; against?: 'self' | 'attacker'; refundSlot?: boolean }
  /**
   * 泛化版：**引擎在窗口里先掷一次豁免**，按结果应用一组修改（`onFail` / `onSuccess`）。
   * 「先让施法者过豁免，失败了才改这道法术」这类规则（篡改法术、反制变体）用它；
   * 子修改里的 op 只认能写进 CastPlan 的那几个（cancel / setDc / setAttackBonus / setDamageType）。
   */
  | { op: 'unlessSave'; ability: Ability; dc: ExprSrc; against?: 'self' | 'attacker'; onFail?: Modify[]; onSuccess?: Modify[] }
  /** 改这次施法的豁免 DC（绝对覆盖；写 `self.spell.dc - 3` 这种表达式也行） */
  | { op: 'setDc'; value: ExprSrc }
  /** 改这次施法的攻击加值（绝对覆盖） */
  | { op: 'setAttackBonus'; value: ExprSrc }
  /** 改这次施法的伤害类型（物理或元素，写站点的中文名） */
  | { op: 'setDamageType'; value: string }
  /** 把这次豁免 / 检定 / 攻击改成成功或命中（传奇抗性、现世传说） */
  | { op: 'succeed' }
  /** 反射闪避：「豁免成功只受一半伤害」的效果 —— 成功改为不受伤害，失败改为只受一半（别的伤害不管） */
  | { op: 'evasion' }
  /**
   * 改目标：
   *   - attackHit（防守段）：to = 'self' 把攻击改到自己身上（骑乘战斗）；不写或 'choose' 让人选一个新目标或放弃攻击（庇护术、云雾符文、直觉魅惑、误导），按新目标 AC 重新判定；
   *   - damageIncoming：把整包伤害改由自己承受（保护联结）。
   */
  | { op: 'redirect'; to?: 'self' | 'choose' }
  /**
   * 替承受者吸收伤害（damageIncoming，先按原目标的抗性 / 易伤算出伤害）：
   *   - from 缺省 'tempHp'：用自己的临时生命值吸收，溢出仍归原目标（投射守御）；
   *   - from = 'hp'：不可减免地由自己代替承受全部最终伤害（护卫灵光）。
   */
  | { op: 'absorb'; from?: 'tempHp' | 'hp' }
  /** 消除这次 d20 检定的优势 / 劣势，改用第一颗 d20（归复平衡 which 缺省 'both'，醉汉机运 which: 'disadv'） */
  | { op: 'clearAdv'; which?: 'both' | 'adv' | 'disadv' };

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
  /** 同一个生物可以选好几次（魔法飞弹的飞弹、灼热射线的射线、魔能爆的光束）：选几次就结算几次 */
  repeat?: boolean;
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

export interface SummonAttackSpec {
  id?: string;
  name: string;
  /** 缺省 self.spell.atk */
  bonus?: ExprSrc;
  /** 伤害表达式（召唤时求值成骰子文本，如 '1d8 + 4 + slot.level'） */
  damage: ExprSrc;
  damageType: string;
  melee?: boolean;
  ranged?: boolean;
  reach?: boolean;
  range?: number;
  long?: number;
  extra?: Array<{ dice: ExprSrc; type: string }>;
}

export type Node =
  | { kind: 'attack'; bonus?: ExprSrc; attack?: Partial<AttackInfo>; critRange?: ExprSrc; onHit?: Node[]; onMiss?: Node[] }
  /** ability 写成数组 = 由目标选择（引擎替目标选加值高的那个，例如擒抱：力量或敏捷）；to: 'attacker' = 迫使攻击者豁免（庇护术、不破威仪） */
  | { kind: 'save'; to?: NodeTarget; ability: Ability | Ability[]; dc: ExprSrc; onFail?: Node[]; onSuccess?: Node[] }
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
  /** 结束施法者自己的专注（「目标挣脱 → 法术结束」这类；一个目标摆脱就结束的写法，不要靠移除效应自动触发） */
  | { kind: 'endConcentration' }
  /**
   * **临时授予一个动作**（免法术位施放、篡改后的法术副本、临时武器…）：
   * - `from`：从某个条目键复制动作（`XPHB:spell:火球术#cast`），可以再用 `cost` / `activation` 改写；
   * - `action`：直接写动作 JSON（和 `from` 二选一）。
   * 授予的条目挂在 `key` 下（缺省 `grant:<来源键>`）；**同 key 会盖住规则书里的同名条目** —— 这就是「覆盖」。
   * `until: 'turnEnd'` = 当前这回合结束时自动收回。
   */
  | {
      kind: 'grantAction'; key?: string; from?: string; fromVar?: string; action?: Action; name?: string; text?: string;
      cost?: Cost[]; activation?: 'action' | 'bonus' | 'reaction' | 'free' | 'none'; targeting?: Targeting; until?: 'turnEnd';
    }
  /** 收回一条临时授予的条目 */
  | { kind: 'removeGrant'; key: string }
  /**
   * **改正在施展的那道法术**（只能在 `spellCast` 的窗口里用得上）：改的是这次施法的「计划书」（CastPlan），
   * 窗口关掉后引擎照它结算 —— 所以「先掷豁免、失败了才打断 / 才改」这种过程式判断也能写。
   * `dc` / `attackBonus` 是覆盖值（可以写表达式）；`cancel` 等价于窗口里的 `modify: [{ op: 'cancel' }]`。
   */
  | {
      kind: 'modifyCast'; cancel?: boolean; refundSlot?: boolean;
      dc?: ExprSrc; attackBonus?: ExprSrc; damageType?: string; note?: string;
    }
  | { kind: 'resource'; id: string; delta: ExprSrc }
  | { kind: 'economy'; action?: number; bonus?: number; reaction?: number; attacks?: number; move?: ExprSrc }
  /** var：把选中项的 value（没写就是 label）放进 `vars.<var>`，后面的节点可以用（伤害类型 `type: 'vars.elem'`） */
  /**
   * var：把选中项的 value（没写就是 label）放进 `vars.<var>`，后面的节点可以用（伤害类型 `type: 'vars.elem'`）。
   * `pool`：选项不写死，**由引擎按这个池子现算**（现在支持 `ownSpells` = 参与者自己身上带施法动作的法术键，
   * 战地施法者那种「从我的法术里挑一道」用它）；选项的 value 就是法术键，配合 `grantAction.fromVar` / `castFrom` 施展。
   * `castTime` / `singleTarget`：把池子筛到「施法时间是某个动作」和「只打一个生物」的法术
   * （战地施法者要求「施法时间为动作、且只把那个生物当唯一目标」）。
   */
  | {
      kind: 'choose'; prompt: string; options?: Array<{ label: string; do?: Node[]; when?: ExprSrc; value?: string }>;
      pool?: {
        from: 'ownSpells' | 'ownCantrips'; maxLevel?: ExprSrc; minLevel?: ExprSrc;
        castTime?: 'action' | 'bonus' | 'reaction'; singleTarget?: boolean;
      };
      count?: number; var?: string;
    }
  /**
   * **直接施展**前面挑中的那个动作（`fromVar` / `from`），打完不留任何东西 ——
   * 「用一道法术代替借机攻击」这类：反应已经付过了，这里只借那道法术的结算。
   * `to`：这次只对谁生效（默认用当前目标 / 攻击者）。
   */
  | {
      kind: 'castFrom'; fromVar?: string; from?: string; to?: 'target' | 'attacker' | 'self' | 'each';
      cost?: Cost[]; activation?: 'action' | 'bonus' | 'reaction' | 'free' | 'none';
    }
  /** 让人选一个数（圣疗用多少点），结果放进 `vars.<var>` 给后面的节点用 */
  | { kind: 'number'; prompt: string; var: string; min?: ExprSrc; max: ExprSrc; default?: ExprSrc }
  | { kind: 'if'; when: ExprSrc; then?: Node[]; else?: Node[] }
  | { kind: 'forEach'; in: 'targets' | 'area'; do: Node[] }
  | { kind: 'repeat'; n: ExprSrc; do: Node[] }
  /** 推离 / 拉近：有地图就真的移动目标的棋子（直线，碰到别的棋子停下）；传送还是提示人手动拖 */
  | { kind: 'move'; mode: 'push' | 'pull' | 'teleport'; ft: ExprSrc }
  /**
   * 在地图上留下一个持续的区域（法术选的范围那些格子）。生物进入、在里面开始 / 结束回合时，对它执行 do
   * （self = 施法者，target = 那个生物）。随专注结束；没有专注的写 rounds。
   */
  | {
      kind: 'zone'; name?: string; on: ZoneWhen[]; do: Node[];
      affects?: 'all' | 'enemies' | 'allies'; oncePerTurn?: boolean; rounds?: number;
    }
  /**
   * 召唤一个参战生物（召唤术、原初伴侣、魔宠）：与召唤者同控制者、同阵营，先攻紧贴在召唤者后面；
   * link != false 时随本次动作的专注 / 效应结束而消失；
   * link == false（独立存续）时按 `group` 顶替：同组的新召唤会顶掉旧的，缺省是本次动作（同一道法术再施展一次 = 换一只）。
   */
  | {
      kind: 'summon'; name: string; size?: string; type?: string; creatureType?: string;
      ac?: ExprSrc; hp?: ExprSrc; speed?: ExprSrc; pb?: ExprSrc;
      score?: Partial<Record<Ability, ExprSrc>>;
      resist?: string[]; immune?: string[]; conditionImmune?: string[];
      attacksPerAction?: ExprSrc; attacks?: SummonAttackSpec[];
      actions?: Action[]; triggers?: Trigger[]; rollMods?: RollMod[];
      notes?: Array<{ group: string; name: string; text: string } | string>;
      count?: ExprSrc; link?: boolean; group?: string;
    }
  | { kind: 'note'; text: string }
  /** 在窗口里改正在结算的东西（反应动作的 root、触发器的 do 里用）：值在当前作用域里求（能用 slot.level），带骰子的当场掷 */
  | { kind: 'modify'; modify: Modify[] };

/** attacker = 窗口的发起者（攻击者、伤害来源）；each = 这次动作选中的每一个目标（多目标治疗 / 临时生命值） */
export type NodeTarget = 'target' | 'self' | 'attacker' | 'each';

export type ZoneWhen = 'enter' | 'turnStart' | 'turnEnd';

/** 地图上持续存在的区域（法术留下的、DM 画的） */
export interface Zone {
  id: string;
  name: string;
  /** 占的格子 "x,y" */
  cells: string[];
  /** 画图用的形状（地图的像素坐标，引擎不读） */
  tpl?: Record<string, unknown>;
  /** 施法者；DM 画的 = null */
  source: Id | null;
  entryKey: string;
  on: ZoneWhen[];
  do: Node[];
  affects: 'all' | 'enemies' | 'allies';
  /** 同一个生物每回合最多受一次（进入 + 回合开始 / 结束合起来算） */
  oncePerTurn: boolean;
  /** 每次生效前问 DM */
  confirm: boolean;
  /** 随这个专注结束 */
  link: EffectId | null;
  /** 到第几轮开始时消失（null = 一直在，等人删） */
  untilRound: number | null;
  /** 施放时的环阶（区域里的表达式用 slot.level） */
  slot?: number;
  /** 这回合已经受过影响的：参与者 → 回合标记 */
  hits: Record<Id, string>;
}

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
  /**
   * 条目自己声明的次数池（和人物卡那边的写法一样）：带上这条能力的人进战斗时并进他的资源池，
   * `cost: [{ resource: '<id>' }]` 才能花。上限 `formula` 用战斗里的作用域求值（`pb`、`level` 之类）。
   */
  resources?: Array<{ id: string; name?: string; formula: ExprSrc; recovery: 'short' | 'long' }>;
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
  /** 远射程（劣势也能打到的最远距离） */
  long?: number;
  /** 命中时另外的伤害（怪物的「外加 5 (2d4) 火焰伤害」） */
  extra?: Array<{ dice: string; type: string }>;
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
  /** 参与者自带的规则条目（怪物的数据卡解析出来的动作、触发器）：键 → 条目，sources 里照常列这些键 */
  entries?: Record<string, Entry>;
  /** 引擎不处理、要人看着办的能力原文（怪物的特性、施法、附带效果）：只给界面显示 */
  notes?: Array<{ group: string; name: string; text: string }>;
  /** 棋子 / 先攻条立绘头像（dataURL） */
  avatar?: string;
  /** 生命骰池：骰面（6/8/10/12）→ 最大颗数 */
  hitDice?: Record<number, number>;
  /** 短休恢复规则：哪些资源恢复多少（'all' = 全恢复，数字 = 恢复几）、契约法术位环阶与数量 */
  shortRest?: { resources?: Record<string, number | 'all'>; pact?: { level: number; count: number } };
}

export interface LiveState {
  hp: number;
  tempHp: number;
  deathSaves: { s: number; f: number };
  resourcesUsed: Record<string, number>;
  slotsUsed: Record<number, number>;
  /** 已用生命骰：骰面 → 已用颗数 */
  hitDiceUsed?: Record<number, number>;
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
  /** 召唤者 / 主人（召唤物、原初伴侣、魔宠）：先攻紧贴在召唤者后面，0 HP 时直接消失 */
  summoner?: Id;
  /** 链接的效应（专注法术之类）：该效应结束时本召唤物随之消失 */
  linkEffect?: EffectId;
  /**
   * 独立存续（link: false）的召唤物属于哪一组：**同组的新召唤会顶掉旧的**，不同组各留各的。
   * 缺省是召唤它的那个动作（`条目键#动作名`），所以「同一道法术再施展一次 = 换一只」；
   * 同一效果拆成两个条目时（寻获坐骑 / 信实坐骑）在数据里写相同的 `group`。
   */
  summonGroup?: string;
}

export interface ActiveEffect {
  id: EffectId;
  key: string;
  name: string;
  /** 现场写的效应（场景效应 / DM 手动）没有规则条目，模板就存在实例上 */
  inline?: EffectTemplate;
  /** 变形类效应（荒野形态）附带的野兽数据卡快照：生效期间由 effectiveView 按 2024 荒野形态规则与 base 合成 */
  form?: CombatantView;
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
  /** 地图上的区域（旧存档没有） */
  zones?: Record<string, Zone>;
  /**
   * **临时授予的条目**（临时动作）：`参与者 → 键 → 条目`。
   * 授予的条目会并进 `effectiveView` 的 `entries` 和 `sources`，所以动作栏、`findAction` 都直接能用；
   * **同键的授予盖住规则书里的同名条目**（这就是「用一个改过的副本覆盖原动作」）。
   */
  grants?: Record<Id, Record<string, GrantedEntry>>;
}

/** 一条临时授予的条目（`untilTurn` 不为空 = 到那个回合结束就收回） */
export interface GrantedEntry {
  entry: Entry;
  untilTurn: string | null;
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
  /** 人物卡改了（升级、换装备）：换掉参与者的数值，当前生命值和已用次数留着 */
  | { type: 'refreshCombatant'; id: Id; view: CombatantView }
  | { type: 'startCombat'; order?: Id[] }
  | { type: 'nextTurn' }
  | { type: 'endCombat' }
  /** area：范围法术选的那些格子（"x,y"）和画图用的形状 —— 留下区域的法术（zone 节点）用 */
  | { type: 'useAction'; actor: Id; action: string; targets?: Id[]; slotLevel?: number; options?: Record<string, unknown>; force?: boolean; area?: { cells: string[]; tpl?: Record<string, unknown> } }
  | { type: 'roll'; roller: Id; kind: RollKind; ability?: Ability; skill?: string; dc?: number; label?: string }
  | { type: 'applyEffect'; to: Id; template?: string; inline?: EffectTemplate; name?: string; duration?: Duration; source?: Id | null; form?: CombatantView }
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
  /** 手动改次数：资源、某一环法术位或某一种生命骰「已用」多少 */
  | { type: 'setUsage'; id: Id; resource?: string; slot?: number; hitDie?: number; used: number }
  /** 花生命骰回血（1d<faces> + 体质调整值，至少 1 点） */
  | { type: 'spendHitDie'; id: Id; faces: number; count?: number }
  /** 手动改动作经济（DM 裁定、规则没覆盖到的额外动作）：给的那几项改成这个数 */
  | { type: 'setEconomy'; id: Id; patch: { action?: number; bonus?: number; reaction?: number; move?: number } }
  | { type: 'endConcentration'; id: Id }
  /**
   * 在地图上走了 ft 尺：回合中扣移动力，不够就拒绝（force = DM 不管够不够，扣到 0 为止）。
   * path：一格一格走过的格子（含起点、终点，棋子左上角）—— 有它才检查借机攻击和进入区域
   */
  | { type: 'move'; id: Id; ft: number; force?: boolean; path?: Array<{ x: number; y: number }> }
  /** DM 在地图上画的区域（伤害 / 效果） */
  | { type: 'createZone'; zone: Pick<Zone, 'name' | 'cells' | 'tpl' | 'on' | 'do' | 'affects' | 'oncePerTurn' | 'confirm'> & { rounds?: number } }
  | { type: 'removeZone'; id: string }
  | { type: 'advanceTime'; minutes: number }
  | { type: 'rest'; kind: 'short' | 'long'; ids?: Id[] }
  | { type: 'setSettings'; settings: Partial<Settings> };

export type DecisionKind = 'optionalTrigger' | 'ask' | 'choose' | 'slotLevel' | 'physicalDice' | 'targets' | 'number';

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
  /** number：可选范围 */
  min?: number;
  max?: number;
  /** physicalDice：要输入几颗几面骰 */
  dice?: Array<{ faces: number; count: number }>;
  /** physicalDice：是「点一下掷」的确认（true），还是实体骰（填骰面）。两种都能回答 'roll' 让引擎掷 */
  confirm?: boolean;
  multi?: boolean;
  default: unknown;
}

/** 一次性裁定（§15.3）：按「这笔事务里的第几次掷骰 / 第几次伤害」定位，重放时依旧能对上 */
export type OverridePatch =
  | { roll: number; outcome?: 'hit' | 'miss' | 'crit' | 'success' | 'fail'; total?: number; reason?: string }
  | { damage: number; amounts: Record<string, number>; reason?: string };
