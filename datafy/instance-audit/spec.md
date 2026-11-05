# 动态层规则数据：写法说明

你要把一条 D&D 2024 规则（职业特性、专长、法术、物品）写成引擎能执行的 JSON。

## 1. 产出什么

一个 JSON 对象，类型是下面的 `Entry`，描述这条规则**在游戏进行中、按时机生效**的部分：
主动使用的动作（actions）、在某个时机触发的能力（triggers）、对检定的修正（rollMods）、灵光（auras）、它施加的效应（effects）。

**不要写静态部分**：属性加值、熟练、授予法术、资源池上限、恒定的 AC / 速度加值，人物卡已经算好了（任务里会列出来）。
条件性的东西才写在这里：「豁免具有优势」「命中时加伤害」「失败时可以重骰」。

只输出这个 JSON 对象本身，不要包在别的结构里，不要解释。

**没有可写的就跳过**：这条规则在战斗 / 游戏进行中没有按时机生效的部分（纯静态加值、熟练、授予法术、只在休息或探索时用的、纯叙事），
输出 `{ "skip": "一句话原因" }`。有一部分能写、一部分引擎做不到 → 写能写的，`automation: "partial"`，在 `text` 里说清楚哪部分要人处理。

**同名特性的高等级版本**（同一个职业里名字相同、等级更高，比如 17 级的「动作如潮」）通常只是加强低等级那条：
不要再写一遍动作或触发器（角色两条都有，会出现两份）。加强能用表达式按等级写进低等级那条的，就在这条写 skip 并说明。

**戏法按角色等级变强**（5、11、17 级各加一颗骰）：骰子个数写 `(1 + floor((self.level + 1) / 6))`，例如 `(1 + floor((self.level + 1) / 6))d10`。

## 2. 类型定义

```ts
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
  /** 生命值上限加值（降到当前生命值以下时，当前生命值跟着降） */
  | { kind: 'hpMax'; bonus: ExprSrc }
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
  /** 不受某些东西影响：difficultTerrain = 困难地形不多花移动力 */
  ignores?: string[];
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
  | {
      kind: 'damage'; dice?: ExprSrc; type?: string; id?: string; ref?: string; scale?: number; to?: NodeTarget;
      /** 这次伤害无视目标的抗性（不减半；易伤也不翻倍） */
      ignoreResist?: boolean;
      /** 这次伤害无视目标的免疫 */
      ignoreImmunity?: boolean;
    }
  | { kind: 'addDamage'; dice: ExprSrc; type: string; ignoreResist?: boolean; ignoreImmunity?: boolean }
  | { kind: 'heal'; amount: ExprSrc; to?: NodeTarget }
  | { kind: 'tempHp'; amount: ExprSrc; to?: NodeTarget }
  | {
      kind: 'applyEffect'; template?: string; inline?: EffectTemplate; name?: string; to?: NodeTarget | 'each';
      duration?: Duration; link?: boolean; potency?: ExprSrc; state?: Record<string, ExprSrc>;
      /** 在区域的 do 里用：离开这个区域（或区域消失）就结束（蛛网术的束缚「直到离开蛛网」） */
      whileInZone?: boolean;
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
   * - on 还能写 `create`（区域放下时已经在里面的；区域挪过来压到人算 enter）、`leave`（离开）、`move`（在里面每移动 5 尺，含走进来那一步）；
   * - `while`：待在里面就有的效果（只放 applyEffect），进来时挂上、离开 / 区域消失时自动摘掉，不受 oncePerTurn 限制；
   * - `difficult`：困难地形（走进这些格子每格多花 5 尺移动力）；
   * - `fully`：棋子占的每一格都在区域里才算在里面（原文「完全位于」），缺省占到一格就算。
   */
  | {
      kind: 'zone'; name?: string; on?: ZoneWhen[]; do?: Node[]; while?: Node[];
      affects?: 'all' | 'enemies' | 'allies'; oncePerTurn?: boolean; rounds?: number; difficult?: boolean; fully?: boolean;
    }
  /**
   * 把自己之前放下的区域挪到这次动作选的范围（月华之光「移动光柱」、炽焰法球、匕首之云）。
   * 缺省挪同一条目（同一道法术）放下的；`key` 指定别的条目。挪过来压到的人算「进入」，挪走后不在里面的算「离开」。
   */
  | { kind: 'moveZone'; key?: string }
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

export type ZoneWhen = 'enter' | 'turnStart' | 'turnEnd' | 'create' | 'leave' | 'move';

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
  /** 待在里面就有的效果（applyEffect，挂上的效应标了 zone，离开就摘） */
  while?: Node[];
  /** 施放时 choose / number 选出来的值（区域里的表达式用 vars.x） */
  vars?: Record<string, number | string>;
  /** 困难地形 */
  difficult?: boolean;
  /** 完全位于才算在里面 */
  fully?: boolean;
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
```

`ExprSrc` = 表达式（字符串；也可以直接写数字或布尔）。`Ability` = `'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha'`。

## 3. 表达式

写在字符串里：`"pb + mod.str"`、`"(1 + slot.level)d8"`、`"target.has('倒地') && roll.failing"`。

- 运算：`+ - * /`、`< <= > >= == !=`、`&& || !`、括号；数值最后向下取整。
- 骰子：`2d6`、`1d8 + 3`、`(slot.level + 1)d8`（个数可以是表达式）。
- 字符串用**单引号**。没有三元运算符：要分支就用 `if` 节点。
- `classTable('列名')`：职业等级表当前行的某一列（骰子格直接是骰子，比如武艺骰）。列名见任务。
- 不确定的事实（距离、视线）引擎会去问人；用 `dist`、`within`、`allyWithin`、`canSee` 写，不要自己假设。

### 3.1 每个字段能用的名字

| 字段 | 能用的名字 |
|---|---|
| Action.requires、targeting.count、targeting.filter | `self`：参与者、`source`：参与者、`pb`：数字、`level`：数字、`mod`{ str, dex, con, int, wis, cha }、`score`{ str, dex, con, int, wis, cha }、`str`：数字、`dex`：数字、`con`：数字、`int`：数字、`wis`：数字、`cha`：数字、`round`：数字、`turn`{ isMine, of }、`core`：对象、`target`：参与者、`slot`{ level } |
| 效果节点里的所有表达式（dice、dc、amount、when、delta、max…） | `self`：参与者、`source`：参与者、`pb`：数字、`level`：数字、`mod`{ str, dex, con, int, wis, cha }、`score`{ str, dex, con, int, wis, cha }、`str`：数字、`dex`：数字、`con`：数字、`int`：数字、`wis`：数字、`cha`：数字、`round`：数字、`turn`{ isMine, of }、`core`：对象、`target`：参与者、`attacker`：参与者、`slot`{ level }、`roll`{ kind, sub, ability, skill, natural, total, vs, adv, disadv, roller, target, crit, failing }、`attack`{ melee, ranged, weapon, spell, unarmed, finesse, reach, ability, damageType, item, mastery }、`damage`{ type, amount, crit, save, saved }、`event`：对象、`effect`：对象、`vars`：对象 |
| Trigger.when、Action.trigger.when、modify 的 value | `self`：参与者、`source`：参与者、`pb`：数字、`level`：数字、`mod`{ str, dex, con, int, wis, cha }、`score`{ str, dex, con, int, wis, cha }、`str`：数字、`dex`：数字、`con`：数字、`int`：数字、`wis`：数字、`cha`：数字、`round`：数字、`turn`{ isMine, of }、`core`：对象、`target`：参与者、`attacker`：参与者、`slot`{ level }、`roll`{ kind, sub, ability, skill, natural, total, vs, adv, disadv, roller, target, crit, failing }、`attack`{ melee, ranged, weapon, spell, unarmed, finesse, reach, ability, damageType, item, mastery }、`damage`{ type, amount, crit, save, saved }、`event`：对象、`effect`：对象、`vars`：对象 |
| RollMod.when、RollMod.value | `self`：参与者、`source`：参与者、`pb`：数字、`level`：数字、`mod`{ str, dex, con, int, wis, cha }、`score`{ str, dex, con, int, wis, cha }、`str`：数字、`dex`：数字、`con`：数字、`int`：数字、`wis`：数字、`cha`：数字、`round`：数字、`turn`{ isMine, of }、`core`：对象、`target`：参与者、`attacker`：参与者、`attack`{ melee, ranged, weapon, spell, unarmed, finesse, reach, ability, damageType, item, mastery }、`roll`{ kind, sub, ability, skill, roller, target }、`effect`：对象 |
| StaticMod 的 bonus | `self`：参与者、`source`：参与者、`pb`：数字、`level`：数字、`mod`{ str, dex, con, int, wis, cha }、`score`{ str, dex, con, int, wis, cha }、`str`：数字、`dex`：数字、`con`：数字、`int`：数字、`wis`：数字、`cha`：数字、`round`：数字、`turn`{ isMine, of }、`core`：对象、`effect`：对象 |
| Duration.endsOn[].when | `self`：参与者、`source`：参与者、`pb`：数字、`level`：数字、`mod`{ str, dex, con, int, wis, cha }、`score`{ str, dex, con, int, wis, cha }、`str`：数字、`dex`：数字、`con`：数字、`int`：数字、`wis`：数字、`cha`：数字、`round`：数字、`turn`{ isMine, of }、`core`：对象、`event`：对象、`effect`：对象 |
| Aura.requires | `self`：参与者、`source`：参与者、`pb`：数字、`level`：数字、`mod`{ str, dex, con, int, wis, cha }、`score`{ str, dex, con, int, wis, cha }、`str`：数字、`dex`：数字、`con`：数字、`int`：数字、`wis`：数字、`cha`：数字、`round`：数字、`turn`{ isMine, of }、`core`：对象、`effect`：对象 |

`self` = 持有这条能力 / 效应的人；`source` = 效应的来源（谁施加的）；`target` = 当前目标；`attacker` = 攻击者。
`mod.str` 等是调整值；`slot.level` 只在消耗法术位的动作里有。`vars.<名>` 是 `number` 节点选出来的数。

### 3.2 参与者（self / target / source / attacker）

字段：`id`（字符串）、`name`（字符串）、`side`（字符串）、`kind`（字符串）、`hp`（数字）、`tempHp`（数字）、`hpMax`（数字）、`ac`（数字）、`speed`（数字）、`pb`（数字）、`level`（数字）、`initiative`（数字）、`exhaustion`（数字）、`size`（字符串）、`type`（字符串）、`mod`（{ str, dex, con, int, wis, cha }）、`score`（{ str, dex, con, int, wis, cha }）、`save`（{ str, dex, con, int, wis, cha }）、`spell`（{ dc, atk, mod }）、`levels`（对象）、`dead`（布尔）、`concentrating`（布尔）

方法：
- `has(字符串)` → 布尔　是否处于某状态（含隐含的）
- `hasEffect(字符串)` → 布尔　身上是否有某个效应（名字或键）
- `effect(字符串)` → 对象　取效应实例：{id, name, key, state, source}
- `hasSource(字符串)` → 布尔　是否拥有某规则条目（特性、专长、法术）
- `levelOf(字符串)` → 数字　某职业的等级
- `wearing(字符串)` → 布尔　是否着装某类护甲：'LA' 'MA' 'HA' 'S'
- `isEnemyOf(参与者)` → 布尔
- `isAllyOf(参与者)` → 布尔
- `resource(字符串)` → 数字　资源剩余次数

### 3.3 函数

- `min(数字, 数字, 数字?)` → 数字
- `max(数字, 数字, 数字?)` → 数字
- `floor(数字)` → 数字
- `ceil(数字)` → 数字
- `abs(数字)` → 数字
- `cond(布尔, 任意, 任意)` → 任意　按条件二选一：cond(self.levelOf('战士') >= 10, 1d10, 1d8)
- `classTable(字符串)` → 任意　职业等级表当前行的某一列
- `dist(参与者, 参与者)` → 数字　距离（尺）。没有地图时只能和数字比较，变成一个问题
- `within(参与者, 参与者, 数字)` → 布尔
- `allyWithin(参与者, 数字, 对象?)` → 布尔　x 周围 ft 尺内有没有 self 的盟友
- `canSee(参与者, 参与者)` → 布尔
- `ask(字符串)` → 布尔　显式询问
- `abilityMod(字符串)` → 数字　self 某属性的调整值：abilityMod(attack.ability)
- `combatant(字符串)` → 参与者　按 id 取参与者（事件载荷里只有 id）

## 4. 时机（窗口）

触发器（`Trigger`）和带 `trigger` 的动作挂在窗口上。`role` 决定谁能用：
`actor` = 事件的发起者（下表第三列的前者）、`target` = 承受者（后者）、`ally` / `enemy` = 相对承受者的盟友 / 敌人、`any`。
`window` 缺省是 `after`。`modify` 只能用在 before 窗口。

| 事件 | 窗口 | 发起者 / 承受者 | 能读到 | 能 modify |
|---|---|---|---|---|
| d20Rolled | before | 掷骰者 / 攻击检定的目标 | roll（还没判定；roll.failing = 按现在的结果会失败）、attack | reroll、addToRoll、succeed（改成成功 / 命中）、cancel、clearAdv（消掉优势 / 劣势） |
| d20Rolled | after | 同上 | roll（已判定）、attack | — |
| attackHit | before | 攻击者 / 被命中者 | attack、roll。先问防守方，再问进攻方 | 防守方：halveDamage、cancel（改为未命中）、redirect（改攻击目标）；进攻方：doubleDamage，或用 do 里的 addDamage 加伤害 |
| attackHit | after | 同上 | attack、roll、damage（已结算） | — |
| attackMissed | after | 攻击者 / 目标 | attack、roll | — |
| saveForced | after | 迫使豁免的人 / 豁免的人 | — | — |
| damageIncoming | before | 伤害来源 / 承受者 | damage（掷出来的总数）、attack | reduceDamage（值可以带骰子，掷一次）、halveDamage、doubleDamage、cancel、evasion、redirect（整包伤害转给自己）、absorb（用自己的临时生命值或生命值替盟友承伤） |
| damageTaken | after | 来源 / 承受者 | damage | — |
| reducedTo0 | before | 来源 / 承受者 | damage | setHp（「改为降到 1」这类） |
| turnStarted / turnEnded | after | 回合的主人（触发器里 target 也是他） | — | — |
| leftReach | after | 走开的人 / 被离开触及范围的人 | —（借机攻击引擎自己会问，不用写） | — |
| spellCast | before | 施法者（role: 'target' 是被施法的那个） | event.spell、event.key、event.targets；attacker = 施法者，target = 被施法的那个 | cancel（打断施法，缺省退回法术位；要消耗法术位写 refundSlot: false） |
| spellCast | after | 施法者（role: 'target' 是被施法的那个） | event.spell、event.key、event.targets；attacker = 施法者，target = 被施法的那个 | — |
| initiativeRolled | after | 掷先攻的人 | — | — |
| restCompleted | after | 休息的人 | event.kind（short / long） | — |

反应类能力想「看到伤害再决定」（直觉闪避）：挂在 `attackHit` before，再写 `deferTo: 'damageIncoming'`。

**某人开始 / 结束回合时**（「敌人在你 10 尺内开始回合时」）：`on: 'turnStarted'`、`role: 'enemy'`（或 ally / any），`when: 'dist(self, target) <= 10'` —— 回合窗口里 `target` 就是回合的主人；
写在效应里、只管承受者自己回合的用 `role: 'actor'`。灵光（aura）授予的触发器也一样。

**借机攻击**引擎自己处理：走的人离开敌人的触及范围（有触及武器 10 尺，否则 5 尺）时，问那个敌人要不要用反应打一下；撤离了的不会被打。
「移动不引发借机攻击」的效应写 `flags: { cannot: ['provoke'] }`；被离开时还要做点什么的（哨兵）挂 `leftReach` 窗口。

**地图区域**（火墙、蛛网、刃之屏障这类持续存在的范围）：动作的 `targeting.type` 是 `area`，root 里写
`{ kind: 'zone', on: ['enter', 'turnStart'], do: [ …对进来的生物做什么… ] }`。区域占的就是施法时选的那些格子；
生物进入（自己走进来、被推进来）、在里面开始 / 结束回合时执行 do（`self` = 施法者，`target` = 那个生物，能用 `slot.level`）。
同一个生物每回合最多受一次（`oncePerTurn`，缺省 true）；只对敌人 / 盟友的写 `affects`。专注法术的区域随专注结束，否则写 `rounds`。
施法时 `choose` / `number` 选出来的值区域会记住（do 里照样用 `vars.x`）。
`on` 的其他时机：`create` = 区域出现时已经在里面的（区域被挪过来压到人算 `enter`）；`leave` = 离开时；`move` = 在里面每移动 5 尺（荆棘丛生、尖刺术，配 `oncePerTurn: false`）。
施放当下就在范围里的生物要受的效果：原文和「进入」是同一套的写 `create`；不一样的（火球那种一次性伤害 + 之后的余烬）照常写在 root 的其他节点里。
**待在里面才有的效果**（沉默术、黑暗术、云雾术的遮蔽、蛛网的困难地形提示）写 `while: [{ kind: 'applyEffect', … }]`：
进来（含区域出现、被挪过来）就挂上，离开或区域消失时自动摘掉，不用写 duration。
**有豁免、离开就解除**的（蛛网术「束缚直到离开蛛网」）：照常写在 do 的 `onFail` 里，`applyEffect` 加 `whileInZone: true`。
**困难地形**：zone 上写 `difficult: true`（走进这些格子每格多花 5 尺移动力，被推拉不算）；只是困难地形、没有别的效果的区域可以不写 on / do。
「困难地形不多花移动力」的效应写 `flags: { ignores: ['difficultTerrain'] }`。
原文是「**完全位于**区域内」的（沉默术、哈达之欲的目盲）写 `fully: true`：棋子占的每一格都在区域里才算，缺省占到一格就算。

**推离 / 拉近**（`move` 节点）在地图上会真的移动目标：沿两者连线的方向走直线，碰到别的棋子停下；拉近到贴身为止。传送还是提示人手动拖。

**带 `trigger` 的反应动作也能改正在结算的东西**：在 `root` 里写 `{ kind: 'modify', modify: [ … ] }`（和触发器的 modify 一样的写法），只能挂在 before 窗口。
值在动作自己的作用域里求，所以能用 `slot.level`：反冲术 = `damageIncoming` before 的反应法术，`root: [{ kind: 'modify', modify: [{ op: 'reduceDamage', value: '(slot.level)d6 + self.spell.mod' }] }, …]`。
反应动作默认打窗口的承受者（至圣斩打被命中的、护盾术护自己）；要打**窗口的发起者**（攻击者、伤害来源、施法者），在 `trigger` 上写 `aim: 'actor'`（炼狱叱喝、法术反制）。

效应的 `duration.endsOn` 可以监听的事件：`turnStarted`、`turnEnded`、`initiativeRolled`、`spellCast`、`d20Rolled`、`attackHit`、`attackMissed`、`saveForced`、`damageIncoming`、`damageTaken`、`reducedTo0`、`restCompleted`、`leftReach`、`actionUsed`、`actionDone`、`saveFailed`、`saveSucceeded`、`damageApplied`、`damageRolled`、`healed`、`tempHpGained`、`effectApplied`、`effectEnded`、`turnEnding`、`roundStarted`、`combatStarted`、`combatEnded`、`died`、`timeAdvanced`、`moved`、`zoneHit`、`entryGranted`、`entryRevoked`。
`endsOn` 的 `when` 里，`event` 是事件内容（d20Rolled 有 `kind`、`roller`、`target`、`total`；effectApplied 有 `bearer`、`name`），`self` 是效应的承受者。

## 5. 约定（照着做）

1. **主动用的能力** → `actions`。动作的 `id` 和 `name` 用任务「接口」里给的。`activation`：动作 action、附赠动作 bonus、反应 reaction、不占动作 free、武器式的一次攻击 none（配 `cost: [{ economy: 'attack' }]`）。
2. **玩家可以选择用不用**的 → `optional: true`（引擎会问）；每回合一次 → `limit: 'oncePerTurn'`。
3. **花资源** → `cost: [{ resource: '<id>' }]`，id 用任务里列出的。这条能力**自己**有次数（「每次长休可以用 X 次」）而列表里没有对应的池 →
   在条目顶层声明：`resources: [{ id: '<新 id>', name: '<中文名>', formula: '<上限>', recovery: 'short' | 'long' }]`，再照常在 cost 里用它（人物卡会据此加上这个池）。
   formula 写法：数字、`'pb'`、`'max(1, wis)'`（属性调整值）、`'level * 5'`（level 是**该职业**等级）、`'cond(level >= 11, 3, 2)'`。不要拿别的池子凑。法术位 → `cost: [{ slot: { min: <环> } }]`，升环效果写在表达式里（`slot.level`）。
4. **由事件触发、还要花附赠动作或反应**的（护盾术、至圣斩）→ 写成 `actions` 里带 `trigger` 的动作；代价按 `activation` 自动算。只能在自己回合用的加 `requires: 'turn.isMine'`。
5. **命中时加伤害**（偷袭类）→ `attackHit` before 窗口、`role: 'actor'`，`do: [{ kind: 'addDamage', … }]`；跟武器同类型就写 `type: 'attack.damageType'`。
6. **「检定失败时」** → `d20Rolled` before 窗口，`when` 里用 `roll.failing`。可选能力只在会改变结果时才提供，别让玩家每次掷骰都被问。
7. **持续时间**：`until.nth: 0` = 本回合，`1` = 下一个回合；`of: 'bearer'`（承受者的回合）或 `'source'`（施加者的回合）。「直到你的下一回合开始」施加在别人身上 → `{ until: { at: 'turnStart', of: 'source', nth: 1 } }`。没有写持续时间的效应要手动移除，一般都该写。
8. **引用效应**：状态用全键 `'XPHB:condition:<名>'`；通用动作的效应 `'XPHB:action:<名>#<效应名>'`；本条目自己的效应写在 `effects` 里、用名字引用。可用的状态：目盲 魅惑 耳聋 力竭 恐慌 受擒 失能 隐形 麻痹 石化 中毒 倒地 束缚 震慑 昏迷。
9. **专注**写在动作的 `concentration` 上（时长）；这个动作施加的效应默认随专注结束。
10. **法术**的动作 `tags: ['spell', 'magical']`，动作 id 一般是 `cast`。
11. **名字**：动作 `name`、触发器 `label`、检定修正 `label` 都以能力的中文名开头（可以加「：说明」）。回执和弹窗上显示的就是它。
12. **让人选**：几个选项选一个 → `choose` 节点（选项可以带 `when`，条件不满足就不列）；选一个数 → `number` 节点，结果在 `vars.<var>`。
    - 选项**可以由引擎现算**：`{ kind: 'choose', pool: { from: 'ownSpells' }, var: 'pick' }` ——
      从参与者自己身上带施法动作的法术里列（`ownCantrips` 只要戏法，`maxLevel` / `minLevel` 可以卡环阶），
      选项的 value 就是法术键，配合 `grantAction.fromVar` 施展（战地施法者那种「用一道法术代替借机攻击」）。
   `choose` 也可以写 `var`：选中项的 `value`（没写就是 `label`）放进 `vars.<var>`，后面的节点能用 —— 伤害类型 `type: 'vars.elem'`；
   要让效应记住（防护能量伤害），`applyEffect` 上写 `state: { type: 'vars.elem' }`，效应里 `statics: [{ kind: 'resist', values: ['effect.state.type'] }]`（抗性 / 免疫 / 易伤的类型可以写成表达式）。
13. **引擎做不到的**（传送、视线、光照）→ `move` / `note` 节点，或在 `when` 里用 `ask('…')` 问人。**没把握就整条写成 `{ "automation": "manual", "text": "…" }`**：不自动化，比写错强。
14. 伤害类型用中文：钝击 穿刺 挥砍 火焰 寒冷 闪电 雷鸣 强酸 毒素 黯蚀 光耀 心灵 力场。技能用中文：运动 体操 巧手 隐匿 奥秘 历史 调查 自然 宗教 驯兽 洞悉 医药 察觉 求生 欺瞒 威吓 表演 游说。
15. 恒定的数值（AC +1、速度 +10、熟练）不写；只有带条件的写成 `rollMods` / `statics`（在效应里）。
16. **对攻击者 / 伤害来源生效**（黯冰狱铠的反噬、火焰护盾、庇护术让攻击者做豁免）：节点上写 `to: 'attacker'`（damage、heal、tempHp、applyEffect、save 都行）。在命中、受伤这些窗口的触发器和反应里用。
17. **反射闪避**这类（「豁免成功只受一半的效果：成功改为不受伤害，失败改为一半」）：`damageIncoming` before 的触发器，`when: "damage.save == 'dex'"`，`modify: [{ op: 'evasion' }]`。
   `damage.save` 是这次伤害来自哪项豁免（不是豁免带来的就是空字符串），`damage.saved` 是成功了没有。evasion 只对「成功分支里写了 `scale: 0.5`」的伤害起作用。
18. **骰子取最大值**（极效治疗、超限导能）：`rollMods` 里 `op: 'maxDice'`，`on: { kind: 'heal' }` 或 `{ kind: 'damage' }`；只管法术的加 `spell: true`（`on: { kind: 'damage', spell: true }`）。
19. **改攻击目标 / 让攻击落空**：在 `attackHit` before 窗口，`{ op: 'redirect', to: 'self' }` 把攻击改打自己（骑乘战斗、迎矢）；`{ op: 'redirect', to: 'choose' }` 让攻击者改选另一目标或取消这次攻击（庇护术：配 `save` 的 `to: 'attacker'`，在 `onFail` 里写 `{ kind: 'modify', modify: [{ op: 'redirect', to: 'choose' }] }`）。转火后会按新目标的 AC 重新判定。直接让攻击未命中用 `{ op: 'cancel' }`。
20. **替盟友承受伤害**：在 `damageIncoming` before 窗口（`role: 'ally'`），用自己的临时生命值或生命值吸收伤害（原目标抗性算完之后先扣你的，扣不完再落回原目标）：写 `{ op: 'absorb', from: 'tempHp' }`（投射守御，配 `when: 'self.tempHp > 0'`）或 `{ op: 'absorb', from: 'hp' }`（护卫灵光）。整包伤害直接转给自己承受（按自己的抗性算）：写 `{ op: 'redirect', to: 'self' }`（保护联结）。
21. **打断施法**（法术反制）：挂在 `spellCast` before 窗口（`role: 'any'`、`aim: 'actor'`），在豁免失败分支里写 `{ kind: 'modify', modify: [{ op: 'cancel' }] }`（2024 版不消耗对方体内的法术位，缺省 `refundSlot: true`）。
22. **抹掉优势 / 劣势**：常驻「攻击检定不会对你有优势」（飘忽不定、序列意识）在 `rollMods` 里写 `op: 'noAdv'`；触发时消掉本次掷骰的优势 / 劣势（归复平衡、醉汉机运）在 `d20Rolled` before 写 `modify: [{ op: 'clearAdv', which: 'both' | 'adv' | 'disadv' }]`。
23. **召唤生物**（野兽召唤术、原初伴侣、寻获魔宠、荒野伙伴）：用 `{ kind: 'summon', name: '…', size: 'S' | 'M' | 'L', creatureType: '…', ac: '11 + slot.level', hp: '30 + 5 * (slot.level - 2)', speed: 30, attacksPerAction: 'floor(slot.level / 2)', attacks: [{ name: '…', damage: '1d8 + 4 + slot.level', damageType: '穿刺' }] }`。有多种形态（陆生 / 空生 / 水生）的套在 `choose` 节点里。专注法术召唤出的生物默认随专注结束退场；非专注或独立存续的写 `link: false`。
    独立存续（`link: false`）的召唤物**按组顶替**：同一道法术再施展一次会换掉旧的（缺省按这次动作分组），不同来源（坐骑 + 魔宠）各留各的；同一效果被拆成两个条目时（寻获坐骑 / 圣武士的「信实坐骑」）在两条里写相同的 `group: 'steed'` 才会互相顶替。
24. **目标挣脱 / 效应被移除之后法术是否结束**：引擎**不会**因为「效应被移除」就自动结束专注 —— 多目标法术里一个目标摆脱了，法术对别人还在（golden #4 定身类人就是这么设计的）。
    原文说「成功则法术结束」的（诱捕打击这类），在 root 里显式写 `{ kind: 'endConcentration' }`：结束施法者自己的专注，链接的效应、区域、召唤物会一并退场。
25. **灵光授予的静态修正**（`aura.grant.statics`：抗性、免疫、AC 加值…）会并进范围内生物的 view —— 不用再拿「受伤前减半」之类的写法绕。
26. **临时给一个动作**（免法术位施放、篡改后的法术副本、临时武器）：`{ kind: 'grantAction', key: 'grant:fireball', from: 'XPHB:spell:火球术#cast', cost: [] }`。
    - `from` 复制某个条目键里的动作（可以再用 `cost` / `activation` 改写），或者用 `action` 直接写动作 JSON；
    - 授予的条目挂在 `key` 下，**动作栏里直接能用**（不用额外做什么）；**同 key 会盖住规则书里的同名条目** —— 这就是「用一个改过的副本覆盖原动作」；
    - `until: 'turnEnd'` = 当前这回合结束时自动收回；要立刻收回写 `{ kind: 'removeGrant', key }`；
    - 还能改写 `targeting`（`{ type: 'self' }` = 只能对自己，免位施放护盾类要靠它）；
    - **免法术位施放的标准写法**：外层动作 `activation: 'action'`（付掉动作 / 附赠动作），root 写
      `{ kind: 'grantAction', from: 'XPHB:spell:<法术>#cast', cost: [], activation: 'free', until: 'turnEnd' }` ——
      授予的那个法术动作不再花动作经济，也不扣法术位；复制时会自动把「相对模板名」换成绝对键、`slot.level` 按基础环阶定下来；
    - 注意它只换**动作**，不改「引擎内部行为」（借机攻击、能不能用反应、专注）—— 那些用 `flags`（`cannot` / `blocks` / `forbidTarget`）。
28. **无视抗性 / 无视免疫**：`damage` 节点加 `ignoreResist: true` / `ignoreImmunity: true`（`addDamage` 也有）——
    这一笔伤害就不减半、也不被免疫挡掉（原文有「无视抗性」的伤害写这个，不要靠假伤害类型绕）。
27. **改正在施展的那道法术**（只能在 `spellCast` 的 before 窗口里用）：窗口的 `modify` 是**同步求值**的，
    所以「先掷豁免、失败了才改」要写成**引擎替你掷**的 op，而不是先 `do` 里掷再改（`do` 的执行时机不保证在结算之前）：
    - `{ op: 'unlessSave', ability: 'wis', dc: 13, onFail: [...], onSuccess: [...] }` —— 引擎在窗口里先让**施法者**掷豁免，
      按结果应用子修改（`against: 'self'` 改成让施法者自己掷）；
    - 子修改认这几个：`setDc`（改这次施法的豁免 DC）、`setAttackBonus`（改攻击加值）、`setDamageType`（改伤害类型，写中文名）、`cancel`（打断，可带 `refundSlot`）；
    - 简写：`{ op: 'cancelUnlessSave', ability: 'con', dc: 'self.spell.dc', refundSlot: true }` = 豁免失败就打断（法术反制就这么写）；
    - 无条件改的话用 `modifyCast` 节点（同样只在窗口里生效）。

29. **借一道动作当场结算**（战地施法者、咒剑、借机法术）：`{ kind: 'castFrom', from: 'XPHB:spell:<法术>#cast', to: 'attacker' }`。
    - `from` 写条目键；或者 `fromVar` —— 用前面 `choose` 挑中的那一项（`value` 就是法术键）；
    - `to`：`target`（当前目标，默认）/ `attacker`（发起这次窗口的进攻者，战地施法者就是这个）/ `self` / `each`（全部目标）；
    - 代价默认**沿用那道动作自己的**（法术位照付）；反应已经在外层付过的（战地施法者），`activation` 留空就是 `free`，不会再扣一次动作经济；
    - 和 `grantAction` 的区别：`grantAction` 是**给他挂一个能用一阵子的动作**，`castFrom` 是**当场结算完什么都不留** ——
      「用反应代替一个动作」「借别人一次攻击顺手打一发」这种选 `castFrom`。
30. **`choose` 的现算池还能过滤**（战地施法者要求「施法时间是动作 + 只以那个生物为唯一目标」）：
    `{ kind: 'choose', pool: { from: 'ownSpells', castTime: 'action', singleTarget: true }, var: 'pick' }`
    - `from`：`ownSpells`（自己身上带施法动作的法术）/ `ownCantrips`（只要戏法）；
    - `castTime: 'action'` 只列施法时间为动作的；`singleTarget: true` 只列单体目标的；`maxLevel` / `minLevel` 卡环阶。
31. **移动 / 传送**：`{ kind: 'move', mode: 'teleport', maxFt: '30' }` —— 引擎会提示玩家**在地图上点落点**（超出 `maxFt` 会被拒）；
    `mode: 'push' | 'pull'` 是强制位移（`ft`，`origin: 'source'`），会自己算方向和距离，不用写坐标。
32. **移动区域**（月华之光「移动光柱」、炽焰法球、匕首之云）：同一条目里另给一个动作（附赠动作 / 动作），
    `targeting` 和施法时一样写 `type: 'area'` + 形状，root 写 `{ kind: 'moveZone' }` —— 把这道法术放下的区域挪到新选的范围。
    挪过去压到的人算「进入」（区域移入生物的空间），挪走后不在里面的算「离开」。挪别的条目放下的区域写 `key`。
    移动距离上限（「至多 60 尺」）引擎不查，写进动作说明里。

## 6. 引擎怎么执行（容易想错的地方）

1. **攻击节点的 `bonus` 缺省是 `self.spell.atk`（法术攻击）。** 武器攻击、徒手打击一定要自己写命中加值（`self.pb + max(self.mod.str, self.mod.dex)` 这类）；伤害骰里也要自己写属性调整值，引擎不会替你加。
2. **`damage` 节点会立刻造成伤害**，不只是掷骰。一个分支里的 damage 节点先合成一个伤害包结算，再执行同一分支的其他节点
   （例外：写在第一个 damage 前面的 `choose`、`number`、`modify` 先做，好让伤害用上选出来的值）。
   几个目标共用同一次掷骰（火球术）：在**第一次用到的分支里**写 `id`，其他分支用 `ref` 引用（可以加 `scale: 0.5` 减半）。不要在根上单独掷一次 —— 那会直接对目标造成一次伤害。
3. **需要目标的节点**（attack、save、写给 target 的节点）有多个目标时，会自动对每个目标各执行一次，不用自己包 `forEach`。`targeting.count` 是最多能选几个（玩家可以少选）。同一个生物能被选好几次、每次都结算一遍的（魔法飞弹的飞弹、灼热射线的射线、魔能爆的光束），写 `targeting.repeat: true`。
4. **触发器的执行顺序**：先付代价（cost），再应用 modify，最后执行 do。do 里读到的 `roll` 已经是 modify 之后的结果 ——
   所以「加完仍然失败就不消耗」可以写成：do 里 `if roll.failing` → `{ kind: 'resource', id: …, delta: 1 }` 把代价退回去。
5. **效应模板里的表达式**（效应的 rollMods、triggers、statics），`self` 是**承受这个效应的人**，`source` 是施加者。
   要用施加者那边的数值（施加者职业表里的骰子、施加时的环阶），在 `applyEffect` 上用 `state` 记下来：
   `state: { die: "classTable('…')" }` 在施加者的作用域里求值，之后在效应里用 `effect.state.die` 读。
6. **防御性的反应改 AC**（护盾术这类）：挂在 `attackHit` 的 before 窗口（防守方先问），施加一个加 AC 的效应即可。
   防守方处理完之后，引擎会**按新的 AC 重新判定**，不够就变成未命中。不要挂在 `d20Rolled` 上：那时这次攻击要对比的 AC 已经定了。
7. **升环公式**按原文逐环累加：「2 环 4d6，每高一环多 1d6」= `(2 + slot.level)d6`；「1 环 3d4，每高一环多 1d4」= `(2 + slot.level)d4`。代进最低环验算一遍。
8. **生物类型**（`target.type`）只有这些写法：类人生物、野兽、精类、邪魔、天界生物、构装生物、龙类、元素生物、巨人、怪兽、泥怪、植物、不死生物、异怪。
9. `allyWithin(x, 尺, { exclude: [self], notCond: '失能' })`：第三个参数可选，`exclude` 不算哪些人，`notCond` 要求那个盟友不处于某个状态。
10. 原文说「另一名生物」→ `targeting.filter: 'target.id != self.id'`。

## 8. 例子

例子文件里是一批写好的条目（键 → Entry），照着它们的风格和粒度写。
