# 动态层规则数据：写法说明

你要把一条 D&D 2024 规则（职业特性、专长、法术）写成引擎能执行的 JSON。

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
  | { op: 'reroll'; die: 'd20'; keep: 'new' | 'higher' | 'lower' }
  | { op: 'addToRoll'; value: ExprSrc }
  /** value 可以带骰子（1d10 + pb），由能力持有者掷一次 */
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
  | { kind: 'choose'; prompt: string; options: Array<{ label: string; do: Node[]; when?: ExprSrc }>; count?: number }
  /** 让人选一个数（圣疗用多少点），结果放进 `vars.<var>` 给后面的节点用 */
  | { kind: 'number'; prompt: string; var: string; min?: ExprSrc; max: ExprSrc; default?: ExprSrc }
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
| 效果节点里的所有表达式（dice、dc、amount、when、delta、max…） | `self`：参与者、`source`：参与者、`pb`：数字、`level`：数字、`mod`{ str, dex, con, int, wis, cha }、`score`{ str, dex, con, int, wis, cha }、`str`：数字、`dex`：数字、`con`：数字、`int`：数字、`wis`：数字、`cha`：数字、`round`：数字、`turn`{ isMine, of }、`core`：对象、`target`：参与者、`attacker`：参与者、`slot`{ level }、`roll`{ kind, sub, ability, skill, natural, total, vs, adv, disadv, roller, target, crit, failing }、`attack`{ melee, ranged, weapon, spell, unarmed, finesse, reach, ability, damageType, item, mastery }、`damage`{ type, amount, crit }、`event`：对象、`effect`：对象、`vars`：对象 |
| Trigger.when、Action.trigger.when、modify 的 value | `self`：参与者、`source`：参与者、`pb`：数字、`level`：数字、`mod`{ str, dex, con, int, wis, cha }、`score`{ str, dex, con, int, wis, cha }、`str`：数字、`dex`：数字、`con`：数字、`int`：数字、`wis`：数字、`cha`：数字、`round`：数字、`turn`{ isMine, of }、`core`：对象、`target`：参与者、`attacker`：参与者、`slot`{ level }、`roll`{ kind, sub, ability, skill, natural, total, vs, adv, disadv, roller, target, crit, failing }、`attack`{ melee, ranged, weapon, spell, unarmed, finesse, reach, ability, damageType, item, mastery }、`damage`{ type, amount, crit }、`event`：对象、`effect`：对象、`vars`：对象 |
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
| d20Rolled | before | 掷骰者 / 攻击检定的目标 | roll（还没判定；roll.failing = 按现在的结果会失败）、attack | reroll、addToRoll |
| d20Rolled | after | 同上 | roll（已判定）、attack | — |
| attackHit | before | 攻击者 / 被命中者 | attack、roll。先问防守方，再问进攻方 | 防守方：halveDamage、cancel；进攻方用 do 里的 addDamage 加伤害 |
| attackHit | after | 同上 | attack、roll、damage（已结算） | — |
| attackMissed | after | 攻击者 / 目标 | attack、roll | — |
| saveForced | after | 迫使豁免的人 / 豁免的人 | — | — |
| damageIncoming | before | 伤害来源 / 承受者 | damage（掷出来的总数）、attack | reduceDamage（值可以带骰子，掷一次）、halveDamage、cancel |
| damageTaken | after | 来源 / 承受者 | damage | — |
| reducedTo0 | before | 来源 / 承受者 | damage | setHp（「改为降到 1」这类） |
| turnStarted / turnEnded | after | 回合的主人 | — | — |
| spellCast | after | 施法者 | event.spell、event.key | — |
| initiativeRolled | after | 掷先攻的人 | — | — |
| restCompleted | after | 休息的人 | event.kind（short / long） | — |

反应类能力想「看到伤害再决定」（直觉闪避）：挂在 `attackHit` before，再写 `deferTo: 'damageIncoming'`。

效应的 `duration.endsOn` 可以监听的事件：`turnStarted`、`turnEnded`、`initiativeRolled`、`spellCast`、`d20Rolled`、`attackHit`、`attackMissed`、`saveForced`、`damageIncoming`、`damageTaken`、`reducedTo0`、`restCompleted`、`actionUsed`、`actionDone`、`saveFailed`、`saveSucceeded`、`damageApplied`、`damageRolled`、`healed`、`tempHpGained`、`effectApplied`、`effectEnded`、`turnEnding`、`roundStarted`、`combatStarted`、`combatEnded`、`died`、`timeAdvanced`。
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
13. **引擎做不到的**（移动、视线、地形）→ `move` / `note` 节点，或在 `when` 里用 `ask('…')` 问人。**没把握就整条写成 `{ "automation": "manual", "text": "…" }`**：不自动化，比写错强。
14. 伤害类型用中文：钝击 穿刺 挥砍 火焰 寒冷 闪电 雷鸣 强酸 毒素 黯蚀 光耀 心灵 力场。技能用中文：运动 体操 巧手 隐匿 奥秘 历史 调查 自然 宗教 驯兽 洞悉 医药 察觉 求生 欺瞒 威吓 表演 游说。
15. 恒定的数值（AC +1、速度 +10、熟练）不写；只有带条件的写成 `rollMods` / `statics`（在效应里）。

## 6. 引擎怎么执行（容易想错的地方）

1. **攻击节点的 `bonus` 缺省是 `self.spell.atk`（法术攻击）。** 武器攻击、徒手打击一定要自己写命中加值（`self.pb + max(self.mod.str, self.mod.dex)` 这类）；伤害骰里也要自己写属性调整值，引擎不会替你加。
2. **`damage` 节点会立刻造成伤害**，不只是掷骰。一个分支里的 damage 节点先合成一个伤害包结算，再执行同一分支的其他节点。
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

## 7. 例子

例子文件里是一批写好的条目（键 → Entry），照着它们的风格和粒度写。
