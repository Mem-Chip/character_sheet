# 动态规则层设计稿（战斗引擎 · 第 1–2 步）

> **状态：第 1–2 步的引擎核心已实现（`src/expr`、`src/combat`，98 个测试）。实现时对本稿的修订见 §十六 —— 两处冲突时以 §十六 为准。**
> 基于 `dsh-p/dnd/dnd2024-sheet` 的现有架构（四声明 + `Rules` 管线 + build/live + JSON 导出），
> **只新增**「在游戏和战斗中按时机生效」的那一层。人物卡的静态计算不动。
>
> 本稿范围：表达式语言、运行时对象、声明 schema（actions / triggers / rollMods / auras / effects）、
> 15 个状态的数据化、D20 检定管线、伤害管线、事件模型、解析栈与决定点、与静态层的衔接、校验与测试、
> **人工覆写与房规（§十五）**。§十四记录已经拍板的决定。
>
> **不在本稿**：地图（只定空间查询接口）、服务器与房间同步、怪物数据抽取（只定 `CombatantView` 接口）、
> AI 批量分诊（只定目标形状）。

---

## 〇、背景与边界

### 0.1 缺口有多大（实测）

`abilities-2024.json` 的 581 条 `mods` 里，**522 条（90%）是 `kind:'note'`** —— 写成文字、不参与任何计算。
按关键词粗分：

| 关键词 | 条数 | 说明 |
|---|---|---|
| 当你 / 每当 | 44 | 触发型 |
| 附赠动作 | 34 | 动作 |
| 反应 | 25 | 反应 = 触发 + 代价 |
| 每回合一次 | 13 | 触发的次数限制 |
| 优势 / 劣势 | 12 | 检定修正 |
| 直到 / 专注 | 8 | 持续时间 |

另外 `TEMP_STATES`（狂暴 / 先天术法 / 剑歌…）是手写表，`effects` 里也大量是 `note`。
**例**：「先天术法：术士法术的攻击检定具有优势」现在只是一句话。

### 0.2 静态与动态的判据

| 写成 | 判据 | 例子 |
|---|---|---|
| `mods`（静态，已有） | 「**只要它在**，数值就是 X」，不需要知道"现在是谁的回合、谁在攻击谁" | 抗性、AC +1、速度 +10、豁免熟练 |
| `rollMods`（动态） | 需要知道**这一次掷骰**的上下文 | 倒地（攻击者在不在 5 尺内）、祝福（攻击与豁免 +1d4） |
| `triggers`（动态） | 需要知道**某件事刚发生** | 偷袭（命中时）、护盾术（被命中时）、狂暴（回合结束时检查是否延长） |
| `actions`（动态） | 玩家**主动**做的事 | 进入狂暴、施放火球术、灵巧动作 |

⚠️ **同一个量只能写在一层。** 判断方法：在效应生效期间它是不是**无条件**的。
- 护盾术的 +5 AC 在持续期间是无条件的，写成 `statics`（进静态管线，卡面 AC 直接变）。
- 掩护的 +2 AC 只对**某一次攻击**成立，写成 `rollMods`。

校验脚本检查：同一个效应不能在 `statics` 和 `rollMods` 里声明同一个量（否则会双计，见 §十二）。

### 0.3 不变的东西

- 四声明（`mods/grants/choices/resources`）的语义和 `ModKinds` 注册表不变。
- `Rules` 十阶段管线不变。它仍然是 AC、豁免、技能、攻击行这些数字的唯一来源。
- build/live 拆分不变。新增的 `CHAR.effects` 进 live 半边。
- 角色 JSON 导出照旧，导出时带上身上的效应（法师护甲、力竭、长时间增益）。

---

## 一、总览

```
              数据声明（JSON）                        运行时                         引擎
 ┌──────────────────────────────────┐
 │ mods/grants/choices/resources    │──▶ Rules 管线 ──▶ SHEET ──▶ CombatantView ──┐
 │ （不变）                          │        ▲                                    │
 └──────────────────────────────────┘        │ statics（效应的静态部分）            │
 ┌──────────────────────────────────┐        │                                    ▼
 │ actions / triggers / rollMods /  │   ActiveEffect[] ◀──────── reducer ◀── events ◀── Engine.handle(cmd)
 │ auras / effects                  │──────────────────────────────────────────────▶ （解释执行效果树）
 │ rules-2024.json（状态/通用动作/精通） │                                              │
 └──────────────────────────────────┘        Encounter = reduce(events)  ◀────────────┘
                                              ├ Combatant[]（view + live + economy）
                                              ├ 回合 / 轮 / 先攻顺序
                                              ├ 解析栈（可序列化）
                                              └ 待决定 Decision[]
```

### 1.1 新模块

沿用原项目的「源码碎片 + 命名空间对象」写法。⚠️ 但有一条**硬约束**：
**`src/combat/*` 不许读 `CHAR` / `Store` / `document` / `U.qs`**，所有输入都从参数进来。
由检查脚本 grep 强制执行，这样以后才能原样搬到服务器上跑。

| 文件 | 对象 | 职责 |
|---|---|---|
| `src/combat/expr.js` | `Expr` | 表达式语言：解析、类型检查、三值求值 |
| `src/combat/registry.js` | `NodeKinds` / `RollOps` / `EventTypes` / `Funcs` | 所有可声明的东西的注册表（每项登记消费者） |
| `src/combat/effects.js` | `Effects` | ActiveEffect 生命周期：施加、叠加、持续、过期、专注链接 |
| `src/combat/roll.js` | `D20` / `Damage` | D20 检定管线、伤害管线 |
| `src/combat/engine.js` | `Engine` | 命令处理、效果树解释器、触发器分发、解析栈 |
| `src/combat/events.js` | `Events` | 事件目录、reducer、撤销、快照 |
| `src/combat/view.js` | `View` | `SHEET → CombatantView` 适配（之后加 `statblock → CombatantView`） |
| `src/ui/combat.js` | — | 掷骰回执、效应栏、动作面板、决定弹窗、遭遇列表 |

### 1.2 数据文件

| 文件 | 内容 | 键 |
|---|---|---|
| `abilities-2024.json`（扩展） | 现有条目上增加 `actions/triggers/rollMods/auras/effects` | 不变：`XPHB:职业:名:级`、`XPHB:名` |
| `rules-2024.json`（新） | 15 个状态、18 个通用动作、8 个武器精通、掩护等通用规则 | `XPHB:condition:倒地`、`XPHB:action:疾走`、`XPHB:mastery:削弱` |
| `spells-2024.dyn.json`（新） | 法术的动态层 | `XPHB:spell:火球术` |
| （之后）`monsters-xmm.dyn.json` | 怪物动作 | `XMM:monster:地精` |

⚠️ 法术、状态、动作加了类别前缀，是为了避开和现有特性键撞名（例如专长「防御」与动作、法术重名）。

效应模板的全键是 `<条目键>#<效应名>`，例如 `XPHB:spell:祝福术#祝福`。条目内部引用时只写 `"template": "祝福"`。

---

## 二、表达式语言 `Expr`

### 2.1 为什么要它

现有的 `resolveNum` 是一串 `if`。项目历史上这一类 bug 反复出现：
- `0 + 'wis'` 拼成了字符串 `"0wis"`；
- `Number('魅力调整值')` 变成 NaN，又静默变成 +0；
- 值在错误的阶段解析（调整值还没算出来）。

动态层需要的远不止数字：`(attack.finesse || attack.ranged) && roll.adv`、`(5 + slot.level)d6`。
所以把它正式化成一个**小语法**。每个表达式都能在构建期解析、做类型检查，未知标识符直接报错。

### 2.2 语法

```
expr   := or
or     := and ('||' and)*
and    := not ('&&' not)*
not    := '!' not | cmp
cmp    := add (('=='|'!='|'<'|'<='|'>'|'>=') add)?
add    := mul (('+'|'-') mul)*
mul    := unary (('*'|'/') unary)*
unary  := '-' unary | dice
dice   := atom ('d' atom)?                    // 2d6、(5 + slot.level)d6
atom   := number | string | path | call | '(' expr ')' | '[' list ']' | '{' obj '}'
path   := ident ('.' ident)*                  // self.mod.str、attack.finesse
call   := ident '(' args ')'                  // max(1, source.mod.cha)、classTable('偷袭')
```

- 类型：`num` / `bool` / `dice` / `str` / `ref`（战斗参与者）/ `list`。
- `num + dice` 得到 `dice`（`1d8 + self.mod.str`）。
- 除法是实数除法，**数值上下文的最终结果向下取整**（2024 默认"向下取整"），需要向上取整时显式写 `ceil()`。
- 字符串比较用中文规范名（`'类人生物'`、`'火焰'`），规范化在数据工厂做，**语言本身不解析中文散文**。

### 2.3 标识符

| 标识符 | 类型 | 说明 |
|---|---|---|
| `self` | ref | 声明的持有者：常驻能力 = 角色本人；效应 = 承受者（bearer） |
| `source` | ref | 效应的施加者（祝福术的施法者、灵光的主人） |
| `target` / `attacker` | ref | 当前事件里的目标 / 攻击者 |
| `pb`、`level`、`mod.str`、`str` | num | `self.` 的简写；`str` 兼容旧写法 = `self.mod.str` |
| `ref.mod.X` / `ref.score.X` / `ref.save.X` / `ref.pb` / `ref.level` | num | |
| `ref.hp` / `ref.hpMax` / `ref.ac` / `ref.speed` / `ref.exhaustion` | num | |
| `ref.size` / `ref.type` / `ref.side` | str | 体型、生物类型、阵营方 |
| `ref.spell.dc` / `ref.spell.atk` | num | 施法 DC / 法术攻击加值 |
| `ref.has('倒地')` / `ref.hasEffect('狂暴')` / `ref.effect('狂暴')` | bool / obj | `has` 认状态（含 `implies` 推出来的） |
| `ref.levelOf('游荡者')` / `ref.wearing('HA')` / `ref.isEnemyOf(x)` / `ref.isAllyOf(x)` | | |
| `slot.level` | num | 本次施法用的环阶（只在动作作用域） |
| `roll.kind` / `roll.ability` / `roll.skill` / `roll.natural` / `roll.total` / `roll.vs` | | 当前 D20 检定 |
| `roll.adv` / `roll.disadv` | bool | **合成后**的结果（抵消之后）。偷袭判"具有优势"看的就是它 |
| `attack.melee` / `.ranged` / `.weapon` / `.spell` / `.unarmed` / `.finesse` / `.reach` / `.ability` / `.damageType` / `.item` | | 当前攻击 |
| `damage.type` / `damage.amount` / `damage.crit` | | 当前伤害 |
| `event.*` | | 触发事件的载荷 |
| `turn.isMine` / `turn.of` / `round` | | 回合信息（`isMine` = 现在是 self 的回合） |
| `effect.state.*` | | 效应实例的状态（猎人印记标记的是谁） |

### 2.4 函数

| 函数 | 说明 |
|---|---|
| `min` `max` `floor` `ceil` `abs` | |
| `classTable('偷袭')` | 读 self 的职业等级表那一列的当前值（`'3d6'`、`3`）。复用 `Resources.fromClass` 的读表逻辑 |
| `dist(a, b)` | 距离（尺）。**空间函数**，见 2.5 |
| `within(a, b, ft)` | `dist(a,b) <= ft` |
| `allyWithin(x, ft, {exclude, notCond})` | x 周围 ft 尺内有没有 self 的盟友（排除谁、排除带某状态的） |
| `canSee(a, b)` | a 能否看见 b。**v1 永远走询问或推测** |
| `ask('问题')` | 显式询问，返回 unknown，由人回答 |

### 2.5 三值求值：能判定就判定，判定不了就问

布尔值取 `true / false / unknown`，按 Kleene 逻辑合成（`false && unknown = false`，`true || unknown = true`）。
空间函数在没有地图时返回 unknown，`ask()` 永远返回 unknown。

求值结果是 `{ value, questions: Question[] }`：

```ts
interface Question {
  id: string;            // hash(text + 涉及的参与者 id)
  text: string;          // 「攻击者是否在 地精#1 的 5 尺内？」
  subjects: Id[];
  guess?: boolean;       // 能从上下文推测时给出（见下表）
  scope: 'roll' | 'turn' | 'round' | 'sticky';   // 回答缓存多久
}
```

引擎的处理：
- **有 `guess`** → 按推测继续，不打断。掷骰回执里列为「假设：近战攻击者在 5 尺内」，错了就撤销重来。
- **没有 `guess`** → 产生一个 `ask` 决定（§九），**一次把这一步的所有问题问完**，不要一个一个弹。
- 回答按 `scope` 缓存在 `Encounter.answers`。例如「我在守护灵光内吗」用 `turn`，「这是社交检定吗」用 `roll`。

推测规则（v1）：

| 问题 | 推测 |
|---|---|
| `dist(attacker, target) <= 5` | 近战且非触及武器 → true；远程 → false |
| `canSee(a, b)` | a 目盲或 b 隐形 → false；否则 true |
| `allyWithin(...)` | 不推测（偷袭最常见的问题，必须问） |

有了地图之后，`Spatial` 提供者直接给出答案，unknown 就不再出现。**规则数据一个字都不用改**，这正是三值求值的意义。

```ts
interface Spatial {               // 地图实现它；v1 = null
  distance(a: Id, b: Id): number | null;
  tokensInArea(area: Area, origin: Point | Id): Id[] | null;
  canSee(a: Id, b: Id): boolean | null;   // 地图 v1 也可以不实现（返回 null）
}
```

### 2.6 冻结值与实时值

| 字段 | 什么时候求值 |
|---|---|
| 效应里的 `dc`、`snap.*`、`damage.dice`（施加时就确定的数） | **施加时冻结**（施法时的 DC，之后施法者属性变了也不变） |
| `saveEnds.dc` | 缺省 = 施加这个效应的那次豁免的 DC（冻结） |
| `rollMods[].when / value`、`triggers[].when` | **每次实时求值** |
| `aura.grant.rollMods[].value` | 实时（灵光主人的魅力变了，加值跟着变） |

### 2.7 兼容与构建期检查

- 旧写法 `'pb'`、`'level'`、`'wis'`、`'mod:wis'`、`'spellcasting'` 编译成等价的 Expr，`resolveNum` 成为 `Expr` 的一个薄包装。
- 中文散文（`'魅力调整值'`）**不进语言**，由数据工厂规范化成 `self.mod.cha`。
- 每个字段声明自己的**作用域**（例如 `roll.*` 只能出现在 rollMods 和挂在掷骰事件上的 triggers 里）。
  构建期编译全部表达式：未知标识符、类型不符、越出作用域，一律报错。

---

## 三、运行时对象

### 3.1 Encounter

```ts
interface Encounter {
  id: string;
  round: number | null;          // null = 战斗外（探索）
  turnIndex: number;
  order: Id[];                   // 先攻顺序
  combatants: Record<Id, Combatant>;
  stack: Frame[];                // 解析栈（§九），可序列化
  pending: Decision[];
  answers: Record<QuestionId, { value: boolean; until: TurnKey }>;
  seq: number;                   // 最后一条事件的序号
  settings: {
    automation: 'auto' | 'assist' | 'manual';   // §9.4，默认 assist
    dice: Record<UserId | '*', DiceSourceId>;   // §6.1，每个人可以不同，默认 engine
    monsterAt0: 'dead' | 'unconscious';         // 默认 dead，DM 可逐个改
    reactionTiming: 'afterResult' | 'raw';      // §9.5，默认 afterResult
  };
  rules: RuleLayerRef[];                        // 生效的房规层（§十五），按优先级
}
type TurnKey = `${number}:${number}`;    // round:turnIndex，「每回合一次」按它记账
```

**没有遭遇时也有一个遭遇**：单卡模式下存在一个隐式的「独角戏遭遇」，只包含这个角色和一个可选的**假目标**（手填 AC 与各项豁免）。
引擎只有一套代码路径，不分"有 VTT / 没 VTT"。

### 3.2 Combatant

```ts
interface Combatant {
  id: Id;
  kind: 'pc' | 'npc' | 'monster';
  ref: string;                    // 角色卡 id / 怪物键
  controller: UserId;
  side: string;                   // 'party' / 'enemy' / …
  view: CombatantView;            // 静态数值快照（§十）
  viewDirty: boolean;             // 有带 statics 的效应变化了 → 下次用之前重算
  live: {                         // PC：映射到 CHAR 的 live 键；怪物：存在遭遇里
    hp: number; tempHp: number;
    deathSaves: { s: number; f: number };
    exhaustion: number;
    resourcesUsed: Record<string, number>;
    slotsUsed: Record<number, number>;
    concentration: EffectId | null;
    heroicInspiration: boolean;
  };
  economy: {
    action: number; bonus: number; reaction: number;
    move: number;                 // 剩余移动（尺）
    object: number;               // 免费物件互动
    attacksLeft: number;          // 「攻击」动作给的攻击次数（额外攻击）
    slotSpellCast: boolean;       // 2024：一回合只能消耗一个法术位施法
    once: Record<string, TurnKey | number>;   // oncePerTurn / oncePerRound 记账
  };
  initiative: number | null;
}
```

- `reaction` 在**自己的回合开始时**恢复，其余经济在自己的回合开始时重置。
- 「每回合一次」按**任何人的回合**记账（`TurnKey`）。2024 的偷袭可以在别人回合里用借机攻击打出来，所以不能按"自己的回合"算。

### 3.3 ActiveEffect

```ts
interface ActiveEffect {
  id: EffectId;
  key: string;                    // 模板全键：'XPHB:condition:倒地' / 'XPHB:spell:祝福术#祝福'
  name: string;
  bearer: Id;
  source: Id | null;
  origin: { kind: 'spell' | 'feature' | 'item' | 'condition' | 'mastery' | 'manual'; ref: string; seq: number };
  appliedAt: { seq: number; round: number | null; turn: TurnKey | null };
  duration: Duration;
  anchor: TurnKey | null;         // until 的起算点（extendEffect 会挪它）
  link?: { concentration: EffectId };   // 链接到施法者的专注效应
  snap: Record<string, unknown>;  // 冻结值：dc、伤害骰、被标记的目标…
  statics?: Mod[];                // 与现有 mods 同形，进静态管线
  rollMods?: RollMod[];
  triggers?: Trigger[];
  aura?: Aura;
  flags?: Flags;                  // 能力限制（§5.2）
  implies?: string[];             // 麻痹 → ['XPHB:condition:失能']
  stackKey: string;               // 缺省 = key
  potency: number;                // 叠加比较用，缺省 0
  suppressed: boolean;            // 被叠加规则压下去的
  state: Record<string, unknown>; // 实例状态
  tags: string[];                 // 'magical' / 'spell' / 'condition' / 'curse'
}
```

**存在哪**：效应**跟着承受者存**。PC 的效应在 `CHAR.effects`（live 半边，随 JSON 导出走）；怪物的效应在遭遇里。
所以法师护甲（8 小时）、力竭、跨战斗的长效增益会自然地留在卡上。

**叠加**（2024：同一法术多次施放的效应不合并，取最强的；一样强取最近的；不同效应相加）：
- 同一承受者身上、同 `stackKey` 的实例里，只有 `potency` 最高的那个生效，平手取 `appliedAt.seq` 最大的。
- 其余标 `suppressed`，**不删除**：持续时间照常走；最强的那个结束时，下一个自动接上。
- 状态（倒地、麻痹…）同理：两个来源都让你麻痹，各自计时，一个结束你仍然麻痹。
- 力竭是例外：`stack: 'level'`，按等级累加（§5.1）。

**`implies` 与独立施加的区别**：
- 麻痹 `implies` 失能：失能随麻痹结束而结束，不单独存实例。
- 昏迷**不能**用 `implies` 表达倒地：原文是「此状态结束时，倒地状态并不会因此结束」。
  所以昏迷在 `onApply` 里**独立施加**一个倒地实例（`duration: manual`）。这是"数据决定语义"的典型例子。

### 3.4 Duration

```ts
interface Duration {
  instant?: true;
  rounds?: number; minutes?: number; hours?: number;      // 1 分钟 = 10 轮
  until?: { at: 'turnStart' | 'turnEnd'; of: 'bearer' | 'source'; nth?: number };
  max?: { rounds?: number; minutes?: number; hours?: number };   // 可延长效应的上限（狂暴 10 分钟）
  saveEnds?: { ability: Ability; dc?: Expr; at: 'turnStart' | 'turnEnd' };
  endsOn?: Array<{ event: EventType; when?: Expr }>;
  concentration?: boolean;
  manual?: true;
}
```

- `nth: n`：从施加（或重新锚定）之后**开始的**第 n 个 `of` 的回合。`nth: 0` = 当前这个回合（只在当前正是 `of` 的回合时合法）。
  - 狂暴（我的回合施加，"持续到你的下一个回合结束"）：`{at:'turnEnd', of:'bearer', nth:1}`
  - 护盾术（别人回合施加，"在你的下一回合开始前"）：`{at:'turnStart', of:'bearer', nth:1}`
  - 两种都按"施加之后开始的第一个回合"算，同一条规则就够了。
- `rounds: n`：在施加时那个先攻位置第 n 轮之后到期（施法者回合开始时检查）。
- 战斗外（`round = null`）时，分钟/小时不自动走，由「推进时间」按钮（+1 分钟 / +10 分钟 / +1 小时 / 长休）驱动。
- 多个结束条件**任一满足即结束**。

**专注**是施法者身上的一个 ActiveEffect（`key: 'concentration'`），被它链接的效应（祝福的三个目标、定身的目标）在它结束时一起结束。
以下情况会结束专注：开始另一个专注、失能、死亡、专注检定失败、带 `cannot: ['concentrate']` 的效应（狂暴）施加时。

---

## 四、声明 schema

条目在现有四声明之外，新增五个可选字段：

```jsonc
{
  "mods": [], "grants": [], "choices": [], "resources": [],      // 不变
  "actions":  [ /* Action */ ],     // 我能主动做的事
  "triggers": [ /* Trigger */ ],    // 常驻触发（持有这条能力就一直在）
  "rollMods": [ /* RollMod */ ],    // 常驻检定修正
  "auras":    [ /* Aura */ ],       // 常驻灵光
  "effects":  { "<名>": EffectTemplate },   // 本条能力会施加的效应模板
  "automation": "full" | "partial" | "manual"   // 覆盖度如实标注；manual = 只显示原文
}
```

`EffectTemplate` = ActiveEffect 里的声明部分：`statics / rollMods / triggers / aura / flags / implies / stackKey / potency / tags / onApply / onEnd / duration`（缺省持续时间）。

### 4.1 Action

```ts
interface Action {
  id: string;                       // 条目内唯一
  name: string;
  activation: 'action' | 'bonus' | 'reaction' | 'free' | 'none'
            | { legendary: number } | { minutes: number };
  trigger?: TriggerSpec;            // activation = 'reaction' 时必填：什么时候可以用
  cost?: Cost[];                    // activation 对应的经济代价自动加上，不用再写
  requires?: Expr;                  // 可用条件（不满足时按钮灰掉并显示原因）
  targeting?: {
    type: 'self' | 'creature' | 'point' | 'area';
    count?: Expr; range?: number | 'touch' | 'self' | 'reach';
    area?: Area; filter?: Expr;     // filter：定身类人只能选类人生物
  };
  root: Node[];                     // 效果树
  tags?: string[];                  // 'spell' / 'weapon' / 'magical'
}

type Cost =
  | { economy: 'action' | 'bonus' | 'reaction' | 'attack' | 'move'; n?: Expr }
  | { resource: string; n?: Expr }          // 指向现有 resources 的 id
  | { slot: { min: number; max?: number } } // 执行时选环阶 → slot.level
  | { recharge: '5-6' | '6' }
  | { charges: string; n?: Expr };          // 物品充能

type Area =
  | { shape: 'sphere' | 'cylinder'; radius: number; height?: number }
  | { shape: 'cone' | 'cube' | 'emanation'; size: number }
  | { shape: 'line'; length: number; width: number };
```

**武器攻击不手写**：由适配器从 `SHEET.attacks` 每一行生成 Action（`activation: 'none'`，`cost: [{economy:'attack'}]`），
命中加值、伤害骰沿用静态管线算好的数，再挂上该武器的精通模板（`XPHB:mastery:*`，前提是角色掌握了这把武器的精通）。

**「攻击」动作**是通用动作 `XPHB:action:攻击`：消耗 1 个动作，`economy.attacksLeft += attacksPerAction`（额外攻击是静态 mod）。
玩家直接点某把武器时，如果 `attacksLeft = 0` 且动作还在，UI 自动先执行「攻击」动作。

**2024 一回合一个法术位**：消耗法术位的施法在 `slotSpellCast = true` 时被拦下，并给出理由。

**反应 = 触发 + 代价**：`activation: 'reaction'` 的 Action 由引擎注册成 `optional` 的触发器，代价 = 反应 + Action 自身的 `cost`。
动作面板仍然把它列在「反应」一栏，供玩家查阅。

### 4.2 效果树节点（封闭集合）

| kind | 关键字段 | 说明 |
|---|---|---|
| `attack` | `bonus: Expr`、`critRange?`、`onHit` `onMiss` `onCrit?` | 走 D20 管线（§六） |
| `save` | `ability`、`dc: Expr`、`onFail` `onSuccess` | 目标掷；怪物自动掷，PC 由控制者掷 |
| `check` | `ability`、`skill?`、`dc` | 自身检定（逃脱擒抱等） |
| `damage` | `dice: Expr`、`type`、`id?`、`ref?`、`scale?` | 见下方「同一次动作只掷一次」 |
| `addDamage` | `dice`、`type` | **只在 `attackHit` 窗口里合法**：往这次攻击的伤害包里加组件（偷袭、至圣斩） |
| `heal` / `tempHp` | `amount: Expr` | |
| `applyEffect` | `template` 或内联、`to: 'target'|'self'|'each'`、`duration?`、`concentration?` | |
| `removeEffect` / `extendEffect` | `match` / `template` | extend 把 `anchor` 挪到当前回合 |
| `resource` | `id`、`delta` | |
| `economy` | `{ action: +1 }` | 动作如潮 |
| `choose` | `prompt`、`options: [{label, do}]`、`count` | 产生 `choose` 决定 |
| `if` | `when`、`then`、`else` | |
| `forEach` | `in: 'targets' | 'area'`、`do` | |
| `repeat` | `n: Expr`、`do` | 多重攻击、灼热射线 |
| `move` | `mode: 'push'|'pull'|'teleport'`、`ft` | 无地图时只写日志 |
| `note` | `text` | 自动化不了的部分，原样显示 |

**同一次动作只掷一次**：带 `id` 的 `damage` 节点在一次动作执行内只掷一次，同 `ref` 的节点复用那次结果。
火球术"每个生物分别豁免、伤害只掷一次"就靠这一条（§11.6）。

### 4.3 Trigger

```ts
interface Trigger {
  id: string;
  on: EventType | EventType[];
  role: 'actor' | 'target' | 'any' | 'ally' | 'enemy';  // 持有者在这个事件里的身份
  window?: 'before' | 'after';     // 缺省 after。各事件有哪些窗口见 §8.2
  deferTo?: EventType;             // 「看到结果再决定」模式下推迟到哪个窗口（§9.5）
  optional?: boolean;              // true → 问控制者（偷袭"可以"造成额外伤害）
  when?: Expr;
  limit?: 'oncePerTurn' | 'oncePerRound' | { resource: string };
  cost?: Cost[];
  do?: Node[];
  modify?: Modify[];               // 只在 before 窗口合法：改正在结算的东西
}

type Modify =
  | { op: 'reroll'; die: 'd20' | 'damage'; keep: 'new' | 'higher' }   // 英雄激励：必须用新结果
  | { op: 'addToRoll'; value: Expr }                                  // 诗人激励 / 削弱之语（负值）
  | { op: 'reduceDamage'; value: Expr } | { op: 'halveDamage' }       // 直觉闪避
  | { op: 'setHp'; value: Expr }                                      // 神之狂暴：改为野蛮人等级
  | { op: 'cancel' };                                                 // 护盾术免疫魔法飞弹
```

### 4.4 RollMod

```ts
interface RollMod {
  on: {
    kind: RollKind | RollKind[];   // 'attack' | 'save' | 'check' | 'd20'(三者全部) | 'damage'
                                   // | 'initiative' | 'deathSave' | 'concentration'
    ability?: Ability | Ability[];
    skill?: string;
    attack?: { melee?: boolean; ranged?: boolean; weapon?: boolean; spell?: boolean };
  };
  who: 'bearer' | 'against';       // bearer = 持有者掷的；against = 别人对持有者发起的攻击
  when?: Expr;
  op: 'adv' | 'disadv' | 'add' | 'addDice' | 'autoFail' | 'autoSucceed'
    | 'critRange' | 'autoCritOnHit' | 'minD20' | 'minDie' | 'targetAdd';
  value?: Expr;
  label: string;                   // 回执上显示：「倒地（攻击者在 5 尺内）」
}
```

| op | 例子 |
|---|---|
| `adv` / `disadv` | 倒地、隐形、鲁莽攻击 |
| `add` / `addDice` | 祝福 `+1d4`、灾祸 `-1d4`、力竭 `-2×等级`、狂暴伤害（`kind: damage`） |
| `autoFail` / `autoSucceed` | 麻痹：力量与敏捷豁免自动失败 |
| `critRange` | 冠军「精通重击」19 |
| `autoCritOnHit` | 麻痹 / 昏迷：5 尺内命中即重击 |
| `minD20` | 「可靠才能」：d20 的 9 或更低当作 10 |
| `minDie` | 「巨武器战斗」：伤害骰的 1、2 当作 3 |
| `targetAdd` | 掩护：持有者的 AC +2 / +5（`who: against`） |

### 4.5 Aura

```ts
interface Aura {
  id: string;
  radius: number;
  affects: 'allies' | 'enemies' | 'all';
  includeSelf: boolean;
  requires?: Expr;                 // 守护灵光：自己没失能
  grant: Pick<EffectTemplate, 'rollMods' | 'statics' | 'triggers'>;
  stackKey?: string;               // 两个圣武士的守护灵光不叠加，取高
}
```

灵光不把效应写进别人的数据，而是在**收集 rollMods 的时候**动态加入：
对每个灵光问一句 `within(source, self, radius)`。无地图时推测不出来，就问一次，`scope: 'turn'`。
在 grant 里，`self` = 被灵光覆盖的人，`source` = 灵光主人。

---

## 五、状态数据化（`rules-2024.json`）

### 5.1 15 个状态（已对照站点原文）

| 状态 | rollMods | statics | flags / 其他 |
|---|---|---|---|
| 目盲 | 自己攻击 disadv；对你的攻击 adv；需要视觉的检定 autoFail（`ask`） | | `cannot: ['see']` |
| 魅惑 | 魅惑源对你的社交检定 adv（`ask`：是否社交） | | `forbidTarget: 'source'`（不能攻击、不能以伤害效应指定魅惑源） |
| 耳聋 | 依赖听觉的检定 autoFail（`ask`） | | `cannot: ['hear']` |
| 力竭 | `d20` add `-2 * self.exhaustion` | 速度 `-5 * self.exhaustion` | `stack: 'level'`；6 级死亡；长休 -1 |
| 恐慌 | 检定与攻击 disadv，`when: canSee(self, source)` | | `cannot: ['moveCloser:source']`（有地图后生效） |
| 受擒 | 攻击 disadv，`when: target != source` | 速度设为 0 且不能增加 | 结束：擒抱者失能 / 距离超出；逃脱动作（检定对 `snap.escapeDc`） |
| 失能 | 先攻 disadv | | `blocks: ['action','bonus','reaction']`；`breaksConcentration`；`cannot: ['speak']` |
| 隐形 | 先攻 adv；对你的攻击 disadv `when: !canSee(attacker, self)`；你的攻击 adv `when: !canSee(target, self)` | | |
| 麻痹 | 力/敏豁免 autoFail；对你的攻击 adv；`autoCritOnHit when: dist(attacker, self) <= 5` | 速度 0 | `implies: [失能]` |
| 石化 | 力/敏豁免 autoFail；对你的攻击 adv | 速度 0；全部伤害抗性；`conditionImmune: 中毒` | `implies: [失能]` |
| 中毒 | 攻击与检定 disadv | | |
| 倒地 | 自己攻击 disadv；对你的攻击 `dist ≤ 5` → adv，否则 disadv | | 起立消耗一半速度（`XPHB:action:起立`） |
| 束缚 | 对你的攻击 adv；自己攻击 disadv；敏捷豁免 disadv | 速度 0 | |
| 震慑 | 力/敏豁免 autoFail；对你的攻击 adv | | `implies: [失能]`（2024 震慑本身不再归零速度） |
| 昏迷 | 力/敏豁免 autoFail；对你的攻击 adv；`autoCritOnHit` 5 尺内 | 速度 0 | `implies: [失能]`；`onApply`：独立施加倒地、掉落手持物（note）；`cannot: ['perceive']` |

示例：

```jsonc
"XPHB:condition:倒地": {
  "effects": { "倒地": { "tags": ["condition"], "duration": { "manual": true },
    "rollMods": [
      { "on": { "kind": "attack" }, "who": "bearer",  "op": "disadv", "label": "倒地" },
      { "on": { "kind": "attack" }, "who": "against", "when": "dist(attacker, self) <= 5",
        "op": "adv", "label": "目标倒地（5 尺内）" },
      { "on": { "kind": "attack" }, "who": "against", "when": "dist(attacker, self) > 5",
        "op": "disadv", "label": "目标倒地（5 尺外）" }
    ] } }
},
"XPHB:condition:昏迷": {
  "effects": { "昏迷": { "tags": ["condition"], "implies": ["XPHB:condition:失能"],
    "statics": [{ "kind": "speedSet", "value": 0, "lock": true }],
    "rollMods": [
      { "on": { "kind": "save", "ability": ["str", "dex"] }, "who": "bearer", "op": "autoFail", "label": "昏迷" },
      { "on": { "kind": "attack" }, "who": "against", "op": "adv", "label": "目标昏迷" },
      { "on": { "kind": "attack" }, "who": "against", "when": "dist(attacker, self) <= 5",
        "op": "autoCritOnHit", "label": "昏迷：5 尺内自动重击" }
    ],
    "onApply": [{ "kind": "applyEffect", "to": "self", "template": "XPHB:condition:倒地#倒地",
                  "duration": { "manual": true } },
                { "kind": "note", "text": "手上持握的东西全数掉落" }],
    "flags": { "cannot": ["perceive"] } } }
}
```

### 5.2 Flags（能力限制词表）

| flag | 引擎行为 |
|---|---|
| `blocks: ['action','bonus','reaction']` | 对应经济视为 0，动作按钮灰掉，反应窗口不再问这个人 |
| `breaksConcentration` | 施加时结束承受者的专注 |
| `cannot: ['concentrate']` | 同上，并拦截新的专注施法（狂暴） |
| `cannot: ['castSpells']` | 拦截一切 `tags` 含 `spell` 的 Action（狂暴） |
| `cannot: ['speak']` | 拦截有言语成分的法术 |
| `forbidTarget: 'source'` | 选目标时排除效应来源（魅惑） |
| `cannot: ['moveCloser:source']` 等空间类 | 有地图后由移动校验执行；之前只显示提示 |

**新增的静态 kind**：`speedSet { value, lock }`（"速度变为 0，且无法被增加"）、`resistAll`、`conditionImmune`（已有）。
它们登记进现有的 `ModKinds`，由 `defense` 阶段消费。

### 5.3 通用动作与武器精通

- 18 个 XPHB 通用动作（攻击、疾走、撤离、回避、协助、躲藏、影响、魔法、预备、搜索、研究、操作、借机攻击、双武器战斗、结束擒抱、终止专注…），外加「起立」，写成 Action。
  其中「回避」= 对自己施加效应（对你的攻击 disadv、敏捷豁免 adv，持续到你的下一回合开始；失能或速度为 0 时失效）。
- 8 个精通（横扫、擦掠、迅击、推离、削弱、缓速、失衡、侵扰）写成挂在武器攻击上的 triggers。
  例如削弱：命中后对目标施加效应「下一次攻击检定 disadv」，`duration: { until: {at:'turnStart', of:'source', nth:1}, endsOn: [{ event: 'd20Rolled', when: "roll.kind == 'attack' && event.roller == self.id" }] }`。
  `endsOn` 表达的就是"**下一次**攻击检定"这种用一次就没的效应。

---

## 六、D20 检定管线

```
① 请求    RollRequest { roller, kind, ability?, skill?, attack?, target?, base: Expr, vs?: Expr }
② 收集    roller 的 rollMods（常驻 + 身上效应 who=bearer + 覆盖到他的灵光）
          + 目标的 rollMods（who=against，仅攻击）+ 场景（掩护）
          逐条求 when → unknown 有推测就用，没推测就产生 ask（一次问完）
③ 合成    优势与劣势：有任一优势且有任一劣势 → 都没有（2024：多个不叠加，互相抵消）
          autoFail / autoSucceed（同时出现时 autoFail 优先，并在回执上标出冲突）
          add / addDice 累加；critRange 取最小；minD20 取最大
④ 掷骰    一颗或两颗 d20 + 加骰。骰面写进事件（物理骰模式：由玩家输入）
⑤ 窗口    d20Rolled/before —— 英雄激励、幸运、诗人激励、削弱之语……
          modify: reroll / addToRoll；可以循环，直到没人再用
⑥ 判定    攻击：天然 20 → 命中且重击；天然 1 → 未命中；否则 total ≥ AC（AC 包括 targetAdd）
          豁免 / 检定：total ≥ DC（2024 中天然 20/1 对豁免和检定没有特殊含义）
⑦ 命中窗口 attackHit/before，按顺序分三段：
          a. 防守方（护盾术……）
          b. 重新判定一次（AC 可能已经变了）；若仍命中，应用 autoCritOnHit
          c. 进攻方（偷袭、至圣斩、猎人印记……）→ addDamage 往伤害包里加组件
⑧ 结算    走 onHit / onMiss / onFail / onSuccess，发结果事件 → after 窗口（武器精通、狂暴延长）
```

- 命中窗口的分段顺序是本稿的**设计决定**：2024「同时效应」规则说由回合持有者决定顺序。
  "先防守后进攻"的理由是：没有人会想对一次已经被护盾挡掉的攻击使用至圣斩。
  必要时 DM 可以手动改顺序（§9.3）。
- **掷骰回执**列出每一项修正和它的来源：
  `d20(7, 15 取高:15) + 5 + 1d4(3)[祝福术] = 23 vs AC 16 · 优势[目标倒地（5 尺内）] · 假设：近战攻击者在 5 尺内`。
  这和原项目给 AC、HP 写算式备注是同一种做法：每个数都能解释。

### 6.1 骰子来源

引擎**只要骰面，不关心骰面从哪来**。所有掷骰都通过一个接口：

```ts
interface DiceSource {
  id: 'engine' | 'physical' | 'physics3d' | string;
  /** 请求一组骰子；返回骰面（可以是异步的：等玩家输入、等 3D 骰子停下） */
  roll(req: { dice: Array<{ faces: number; count: number }>; purpose: string; roller: Id }): Promise<number[]> | number[];
}
```

| 来源 | 行为 |
|---|---|
| `engine` | 引擎 RNG，立即返回 |
| `physical` | 产生一个 `physicalDice` 决定（§9.2），玩家输入实体骰的结果；按面数校验范围 |
| `physics3d`（以后在 VTT 里做） | 客户端的物理模拟算出骰面后回传；房间设置决定是否信任客户端 |

- 来源**按人设置**（`settings.dice`），可以一部分玩家用实体骰、其余用引擎。
- 每次掷骰事件记录 `source` 字段，回执上显示（"实体骰输入"），DM 一眼能看出来。
- 因为骰面写在事件里（§8.1），换哪种来源都不影响重放和撤销。
- 等待骰面就是一个普通的决定点，所以 `physical` / `physics3d` 不需要特殊流程。

---

## 七、伤害管线

```
DamagePacket { source, target, origin, crit, components: [{ dice, flat, type, from }] }

① 掷骰       重击：每个组件的伤害骰掷两次（调整值只加一次）—— 偷袭、至圣斩的骰子也翻倍，
             因为它们是 addDamage 进同一个包的
② 合并       同一类型的组件合计（抗性对每个伤害实例只生效一次）
③ 窗口       damageIncoming/before —— 直觉闪避（halveDamage）、减伤、护盾术免疫魔法飞弹（cancel）
④ 按类型调整  先加减值 → 抗性（减半，向下取整）→ 易伤（加倍）；免疫 → 0
⑤ 扣除       先扣临时生命值，再扣生命值
⑥ 降至 0 前   reducedTo0/before —— 坚韧不屈、神之狂暴（setHp）、击晕生物（近战攻击可改为 1 HP + 昏迷）
⑦ 后果       剩余伤害 ≥ 生命值上限 → 即死（PC）
             降至 0：PC → 昏迷 + 进入死亡豁免；怪物 → 按 settings.monsterAt0
             已在 0 HP 时受伤 → 1 次死亡豁免失败（重击 → 2 次）；伤害 ≥ 上限 → 死亡
             承受者在专注 → 体质豁免，DC = max(10, floor(伤害 / 2))，上限 30（每个伤害来源单独一次）
⑧ 事件       damageApplied{逐类型明细} → damageTaken/after（地狱斥责、专注检定）
```

死亡豁免：回合开始时 HP 为 0 → d20，≥10 成功；天然 20 → 恢复 1 HP；天然 1 → 2 次失败；3 次成功 → 稳定；3 次失败 → 死亡。

---

## 八、事件模型

### 8.1 命令与事件

- **命令**是意图：`useAction`、`decide`、`nextTurn`……可能被拒绝（"反应已经用掉了"）。
- **事件**是事实：已经发生，只追加，不修改。
- 引擎是两个纯函数：
  - `Engine.handle(state, cmd, rng) → Event[]`，读状态、调骰子、产生事件，**不改状态**；
  - `Events.apply(state, event) → state`，reducer，**不掷骰**。
- 所有随机性都写在事件里（骰面），所以重放是确定的，和 RNG 无关。

| 命令 | 说明 |
|---|---|
| `startEncounter` / `addCombatant` / `rollInitiative` / `nextTurn` / `endEncounter` | 流程 |
| `useAction { actor, action, targets, options: { slotLevel?, … } }` | 执行动作 |
| `decide { decisionId, answer }` | 回答决定点 |
| `applyEffect` / `removeEffect` / `adjustHp` / `setResource`（手动） | DM 或玩家手改；手改本身也是事件 |
| `advanceTime { minutes }` / `rest { kind }` | 战斗外 |
| `undo { toSeq }` | 撤销 |

### 8.2 事件目录与窗口

| 事件 | before 窗口 | after 窗口 | 例子 |
|---|---|---|---|
| `turnStarted` | — | ✓ | 死亡豁免、回合开始伤害、反应恢复 |
| `turnEnded` | — | ✓ | 定身重骰（saveEnds）、狂暴到期检查 |
| `initiativeRolled` | — | ✓ | 持久狂暴（重获狂暴次数） |
| `actionDeclared` / `spellCast` | ✓ | ✓ | （以后）反制法术 |
| `d20Rolled` | ✓ | — | 英雄激励、幸运、诗人激励、削弱之语 |
| `attackHit` | ✓（三段，§六⑦） | ✓ | 护盾术 / 偷袭、至圣斩 / 精通 |
| `attackMissed` | — | ✓ | 擦掠 |
| `saveFailed` / `saveSucceeded` / `saveForced` | — | ✓ | 狂暴延长（迫使敌人豁免） |
| `damageIncoming` | ✓ | — | 直觉闪避 |
| `damageTaken` | — | ✓ | 专注检定、地狱斥责 |
| `reducedTo0` | ✓ | ✓ | 坚韧不屈、神之狂暴 |
| `effectApplied` / `effectEnded` | ✓（免疫拦截） | ✓ | 状态免疫、`onApply` / `onEnd` |
| `moved` | ✓ | ✓ | （有地图后）借机攻击：离开触及范围 |
| `restCompleted` | — | ✓ | 资源恢复（现有 `Rest` 逻辑改为监听它） |

另有结算类事件（`costPaid`、`diceRolled`、`damageApplied`、`healed`、`hpChanged`、`deathSave`、`died`、
`concentrationStarted/Broken`、`effectSuppressed/Resumed`、`decisionRequested/Resolved`、`manualOverride`、`rolledBack`），它们没有窗口。

### 8.3 事件信封

```ts
interface Event {
  seq: number;
  at: string;          // 时间戳
  by: UserId;          // 谁的命令导致的
  cause: number | null;// 父事件 seq —— 形成因果树
  type: EventType;
  payload: unknown;
}
```

`cause` 让战斗日志可以按树显示：
`火球术 ▸ 地精#1 敏捷豁免 6 失败 ▸ 28 火焰伤害 ▸ 降至 0`。

### 8.4 撤销与快照

- `undo { toSeq }` 产生 `rolledBack { from: toSeq+1, to: 当前 seq }`。重放时跳过这段，原事件保留（审计用）。
- 每 N 条事件存一次快照，重放从最近的快照开始。
- PC 的 live 键（hp、slotsUsed、resourcesUsed、effects）由 reducer 通过 `LiveSink` 写回 `CHAR`，然后照常走 `Chars.touch()` 自动保存。
  撤销时也一样写回，所以人物卡上的数字永远等于事件折叠的结果。

---

## 九、解析栈与决定点

### 9.1 为什么必须是数据

结算过程会在中途停下来等人：偷袭用不用、护盾术放不放、"盟友在 5 尺内吗"。
如果用 JS 的 async 闭包来等，刷新页面就丢了，以后也没法在服务器和客户端之间传。
所以**解释器的执行状态是显式的栈**，存在 `Encounter.stack` 里，可以序列化。

```ts
interface Frame {
  node: NodePath;          // 指向数据里的哪个节点（条目键 + 路径）
  scope: ScopeRefs;        // self / source / target / roll / attack / damage 的引用（id，不是对象）
  cursor: number;          // 子节点执行到第几个
  locals: Record<string, unknown>;   // 本次动作内已掷的 damage id 等
}
```

### 9.2 Decision

```ts
interface Decision {
  id: string;
  to: UserId;                                 // 控制者；怪物 → DM
  kind: 'optionalTrigger' | 'reaction' | 'ask' | 'choose' | 'targets' | 'slotLevel' | 'order' | 'physicalDice';
  prompt: string;
  options: Array<{ id: string; label: string; detail?: string }>;
  default: string | null;
  timeoutMs?: number;
}
```

- **不打扰原则**：反应窗口只问「这一刻真的能用」的人（有反应、条件不为 false、资源够）。没人能用就不停顿。
  这是战斗流不卡顿的关键。
- 一个窗口里同一个人的多个可选项合并成一个决定（"偷袭？至圣斩（几环）？"）。
- 超时取 `default`（可选触发默认"不用"）；DM 可以替任何人回答。

### 9.3 同时效应的顺序

2024 规则：同时发生的事由回合持有者决定顺序。v1 的做法：
1. 强制效应先于可选效应；
2. 同类按声明顺序；
3. 只有当同一时机出现 ≥2 个**可选**效应、且顺序会影响结果时，才给回合持有者一个 `order` 决定。

### 9.4 自动化档位

| 档位 | 行为 |
|---|---|
| `auto` | 引擎掷骰并直接落地 |
| `assist` | 引擎掷骰并算好，`damageApplied` / `effectApplied` 先作为**提议**显示，DM 点确认才落地 |
| `manual` | 引擎只掷骰、写日志，不改任何状态 |

条目上的 `automation: 'manual'` 会强制按 manual 处理那一条（显示原文和骰子按钮），不受房间档位影响。

### 9.5 反应的决定时机：默认「看到结果再决定」

桌面上的惯例是：知道了攻击总值、伤害数字之后，才决定要不要用反应。所以默认 `reactionTiming: 'afterResult'`：

| 反应 | RAW 的触发点 | afterResult（默认）时引擎在哪里问 |
|---|---|---|
| 护盾术 | 被命中时 | `attackHit` 窗口，**显示攻击总值**（本来就看得到） |
| 直觉闪避 | 被命中时 | 推迟到 `damageIncoming`，**先掷伤害再问** |
| 削弱之语 / 诗人激励 | 看到掷骰后 | `d20Rolled` 窗口，显示骰面与总值 |
| 地狱斥责 | 受到伤害后 | `damageTaken`，本来就在结果之后 |

实现上，每个反应触发器可以额外声明 `deferTo`（afterResult 模式下推迟到哪个窗口）：

```jsonc
{ "on": "attackHit", "role": "target", "window": "before", "deferTo": "damageIncoming", … }
```

`raw` 模式忽略 `deferTo`。时机是房间设置，房规层（§十五）也可以逐条覆盖某个反应的时机。

---

## 十、与人物卡（静态层）的衔接

### 10.1 CombatantView

```ts
interface CombatantView {
  name: string; size: string; type: string;
  ac: number; hpMax: number; speed: number; moveSpeeds: Record<string, number>;
  pb: number; level: number; levels: Record<string, number>;
  score: Record<Ability, number>; mod: Record<Ability, number>;
  save: Record<Ability, number>; skill: Record<string, number>; initiative: number;
  spell: { dc: number; atk: number; ability: Ability } | null;
  resist: string[]; immune: string[]; vuln: string[]; conditionImmune: string[];
  attacks: AttackRow[];                       // SHEET.attacks
  actions: Action[]; triggers: Trigger[]; rollMods: RollMod[]; auras: Aura[];   // 从全部来源汇总
  resources: Array<{ id: string; max: number }>; slots: Record<number, number>;
}
```

- `View.fromSheet(SHEET, CHAR)`：PC。动作、触发器、检定修正沿用 `Abilities.collectSources(char)` 的来源清单，
  所以「选项型特性没选不生效」「家规覆盖官方」这些已有规则自动成立，不用再写一遍。
- `View.fromStatblock(m)`：怪物（第 3 步实现，本稿只定接口）。

### 10.2 反馈回路

```
effectApplied（带 statics）→ combatant.viewDirty = true
  → 下次用这个 view 之前：Combat.applyStatics(ctx) 注入 → Rules.run → 新 SHEET → 新 view
```

- `Combat.applyStatics(ctx)` 取代并推广现有的 `States.applyEffects(ctx)`：
  把承受者身上**未被压制**的效应的 `statics` 作为 effect 注入，位置和顺序都不变（`applyMods` 之后、`Rules.run` 之前）。
- 卡面 AC、抗性、速度因此直接反映当前效应（狂暴时卡面就显示抗性）。

### 10.3 TEMP_STATES 迁移

`TEMP_STATES` 的五项改写成对应条目下的效应模板，`CHAR.states` / `statesRounds` 改成 `CHAR.effects`。
迁移时顺带修一个现有 bug：

> ⚠️ 狂暴现在写的是 `rounds: 10`（1 分钟）。2024 原文是「持续到你的下一个回合结束」，
> 可以靠攻击敌人、迫使敌人豁免或附赠动作逐轮延长，**至多维持 10 分钟**。
> 新写法见 §11.5：`until` + `max` + 延长触发器。

### 10.4 以后上服务器：静态计算也在服务器跑（同构）

**决定：服务器跑和人物卡完全相同的静态管线**，而不是信任客户端推送的 `CombatantView`。

理由：

1. **玩家会关页面**。DM 给一个离线玩家的角色施加力竭或降咒（带 statics 的效应）时，必须有人重算他的 AC、速度。
   如果只信客户端推送，就要等玩家下次打开卡，期间桌面上的数字是错的。
2. **战役层的房规**（Homelib 的「战役 / 全服」作用域）必须对所有人一致生效。在各自的客户端上算，房规版本可能不一致。
3. 怪物本来就只能在服务器算。
4. 客户端推送的数字可能过时，也可能被改过。

成本比看上去小：
- 原项目已经有 `tools/verify-run.mjs`，在 Node 的 `vm` 里加最小 DOM 桩就能跑**真实的**人物卡脚本。
- 规则碎片本身几乎不碰 DOM：`character.js` / `feats.js` / `items.js` / `card-data.js` 是 0 处，
  主要的 DOM 引用集中在 `ui/*`、`boot.js`、`save.js`、`store.js`（装载与缓存）、`pools.js` 和 `class-state.js` 里的渲染函数。

做法：
- `build-app.mjs` 增加一个 **rules-only 目标**：只拼 `core/util`（去掉 DOM 部分）+ `source` + `character` + `plugins` + `data` + `rules/*` 的规则部分 + `combat/*`，
  数据装载换成服务器侧的提供者（读缓存目录或直接抓站点）。
- 先跑一个探针：在 rules-only 产物上重放现有的 `verify-abilities.mjs` 断言，确认 Node 端与浏览器端结果一致。
  不一致的地方就是要剥离的 DOM 依赖，按需逐个拆，不做全面重构。
- 上线后，人物卡客户端**仍在本地计算**（编辑 build 要即时反馈、要能离线），服务器在 build 变化时重算一次。
  两边跑同一份代码，结果不一致本身就是一个可以报警的 bug。

`src/combat/*` 的纯度约束（§1.1）就是为这一步准备的。v1 只在浏览器里跑，但不会写出搬不走的代码。

### 10.5 人物卡上的新界面（第 1 步就要有）

- **掷骰回执**：所有 D20 检定（技能、豁免、攻击、先攻）都走 §六，回执列出每项修正的来源。
- **效应栏**：身上的效应、剩余时间、来源、被压制的显示为灰色；可以手动移除。
- **动作面板**：按 动作 / 附赠动作 / 反应 / 免费 分组，显示本回合经济剩余；不可用的给出原因。
- **决定弹窗**：§9.2。
- **独角戏遭遇**：一个假目标（AC、豁免手填）+「下一回合」按钮，单卡就能完整测试。

---

## 十一、示例

### 11.1 祝福术

```jsonc
"XPHB:spell:祝福术": {
  "actions": [{
    "id": "cast", "name": "祝福术", "activation": "action",
    "cost": [{ "slot": { "min": 1 } }],
    "targeting": { "type": "creature", "count": "2 + slot.level", "range": 30 },
    "root": [{ "kind": "applyEffect", "to": "each", "template": "祝福",
               "concentration": true, "duration": { "minutes": 1 } }],
    "tags": ["spell", "magical"]
  }],
  "effects": {
    "祝福": {
      "rollMods": [{ "on": { "kind": ["attack", "save"] }, "who": "bearer",
                     "op": "addDice", "value": "1d4", "label": "祝福术" }]
    }
  },
  "automation": "full"
}
```

### 11.2 定身类人

```jsonc
"XPHB:spell:定身类人": {
  "actions": [{
    "id": "cast", "name": "定身类人", "activation": "action",
    "cost": [{ "slot": { "min": 2 } }],
    "targeting": { "type": "creature", "count": "slot.level - 1", "range": 60,
                   "filter": "target.type == '类人生物'" },
    "root": [{ "kind": "save", "ability": "wis", "dc": "self.spell.dc",
      "onFail": [{ "kind": "applyEffect", "template": "定身", "concentration": true,
        "duration": { "minutes": 1, "saveEnds": { "ability": "wis", "at": "turnEnd" } } }] }]
  }],
  "effects": { "定身": { "implies": ["XPHB:condition:麻痹"] } }
}
```

- 用 `implies` 而不是独立施加麻痹：法术结束时麻痹必须随之结束。
- `saveEnds.dc` 缺省取施法时冻结的 DC。

### 11.3 护盾术

```jsonc
"XPHB:spell:护盾术": {
  "actions": [{
    "id": "cast", "name": "护盾术", "activation": "reaction",
    "trigger": { "on": ["attackHit", "targeted"], "role": "target", "window": "before",
                 "when": "event.type == 'attackHit' || event.action == 'XPHB:spell:魔法飞弹'" },
    "cost": [{ "slot": { "min": 1 } }],
    "root": [{ "kind": "applyEffect", "to": "self", "template": "护盾",
               "duration": { "until": { "at": "turnStart", "of": "bearer", "nth": 1 } } }],
    "tags": ["spell", "magical"]
  }],
  "effects": { "护盾": {
    "statics": [{ "kind": "ac", "bonus": 5 }],
    "triggers": [{ "id": "mm", "on": "damageIncoming", "role": "target", "window": "before",
                   "when": "event.origin == 'XPHB:spell:魔法飞弹'", "modify": [{ "op": "cancel" }] }]
  }}
}
```

不需要专门的"重新判定"节点：命中窗口的 b 段（§六⑦）总会重新判定。AC +5 是无条件的，所以写在 `statics`。

### 11.4 偷袭

```jsonc
"XPHB:游荡者:偷袭:1": {
  "mods": [],                                   // 原来那条 note 删掉
  "triggers": [{
    "id": "sneak", "on": "attackHit", "role": "actor", "window": "before",
    "optional": true, "limit": "oncePerTurn",
    "when": "(attack.finesse || attack.ranged) && (roll.adv || (allyWithin(target, 5, { exclude: [self], notCond: '失能' }) && !roll.disadv))",
    "do": [{ "kind": "addDamage", "dice": "classTable('偷袭')", "type": "attack.damageType" }]
  }],
  "automation": "full"
}
```

`roll.adv` / `roll.disadv` 是合成后的结果，所以「目标倒地 + 我中毒」相互抵消之后，自然就不满足"具有优势"。

### 11.5 狂暴

```jsonc
"XPHB:野蛮人:狂暴:1": {
  "resources": [{ "id": "狂暴", "name": "狂暴次数", "formula": "table", "recovery": "short" }],
  "actions": [
    { "id": "enter", "name": "进入狂暴", "activation": "bonus",
      "cost": [{ "resource": "狂暴", "n": 1 }],
      "requires": "!self.wearing('HA')",
      "root": [{ "kind": "applyEffect", "to": "self", "template": "狂暴" }] },
    { "id": "extend", "name": "延长狂暴", "activation": "bonus",
      "requires": "self.hasEffect('狂暴') && turn.isMine",
      "root": [{ "kind": "extendEffect", "template": "狂暴" }] }
  ],
  "effects": { "狂暴": {
    "duration": {
      "until": { "at": "turnEnd", "of": "bearer", "nth": 1 }, "max": { "minutes": 10 },
      "endsOn": [{ "event": "effectApplied", "when": "event.key == 'XPHB:condition:失能'" },
                 { "event": "equipped", "when": "event.armorType == 'HA'" }]
    },
    "statics": [{ "kind": "resist", "values": ["钝击", "穿刺", "挥砍"] }],
    "rollMods": [
      { "on": { "kind": ["check", "save"], "ability": "str" }, "who": "bearer", "op": "adv", "label": "狂暴" },
      { "on": { "kind": "damage" }, "who": "bearer", "when": "attack.ability == 'str'",
        "op": "add", "value": "classTable('狂暴伤害')", "label": "狂暴伤害" }
    ],
    "flags": { "cannot": ["concentrate", "castSpells"] },
    "triggers": [
      { "id": "ext-atk",  "on": "d20Rolled", "role": "actor",
        "when": "roll.kind == 'attack' && turn.isMine && target.isEnemyOf(self)",
        "do": [{ "kind": "extendEffect", "template": "狂暴" }] },
      { "id": "ext-save", "on": "saveForced", "role": "actor",
        "when": "turn.isMine && target.isEnemyOf(self)",
        "do": [{ "kind": "extendEffect", "template": "狂暴" }] }
    ]
  }},
  "automation": "full"
}
```

`extendEffect` 把 `anchor` 挪到当前回合，所以同一回合延长多次是幂等的；10 分钟上限由 `max` 兜住。

### 11.6 火球术

```jsonc
"XPHB:spell:火球术": {
  "actions": [{
    "id": "cast", "name": "火球术", "activation": "action",
    "cost": [{ "slot": { "min": 3 } }],
    "targeting": { "type": "area", "range": 150, "area": { "shape": "sphere", "radius": 20 } },
    "root": [{ "kind": "forEach", "in": "area", "do": [
      { "kind": "save", "ability": "dex", "dc": "self.spell.dc",
        "onFail":    [{ "kind": "damage", "id": "fb", "dice": "(5 + slot.level)d6", "type": "火焰" }],
        "onSuccess": [{ "kind": "damage", "ref": "fb", "scale": 0.5 }] }
    ]}],
    "tags": ["spell", "magical"]
  }]
}
```

- 无地图时 `in: 'area'` 退化成「施法者手选目标」；有地图后由 `Spatial.tokensInArea` 给出。
- `id: "fb"` 保证伤害只掷一次、对所有目标通用；`scale: 0.5` 后向下取整。

### 11.7 守护灵光（顺带修一个现有问题）

现在这条写的是 `{kind:'saveBonus', value:'魅力调整值'}`。它只加到圣武士自己的豁免上，盟友完全没有。改成：

```jsonc
"XPHB:圣武士:守护灵光:6": {
  "mods": [],
  "auras": [{ "id": "protection", "radius": 10, "affects": "allies", "includeSelf": true,
    "requires": "!self.has('失能')", "stackKey": "守护灵光",
    "grant": { "rollMods": [{ "on": { "kind": "save" }, "who": "bearer", "op": "add",
                              "value": "max(1, source.mod.cha)", "label": "守护灵光" }] } }],
  "automation": "full"
}
```

---

## 十二、校验与测试

吸取原项目反复出现的「声明了但没有消费者」问题，这次在结构上堵住：

1. **注册表即契约**：`NodeKinds`、`RollOps`、`EventTypes`、`Funcs`、静态 `ModKinds` 的每一项都登记**消费者**（哪个阶段 / 哪个执行器读它）。
   数据里引用了未注册的东西 → 构建失败；注册了但没有消费者 → 构建失败。
2. **表达式全量编译**：`tools/check-combat-data.mjs` 编译全部 Expr，检查标识符、类型、作用域。
3. **双计检查**：同一个效应不能在 `statics` 和 `rollMods` 里改同一个量。
4. **纯度检查**：`src/combat/*` 里出现 `CHAR`、`Store`、`document`、`U.qs` → 失败。
5. **黄金场景**（`tools/verify-combat.mjs`，固定骰面，命令序列 → 断言事件和状态）：

| # | 场景 | 断言 |
|---|---|---|
| 1 | 5 尺内攻击倒地目标 / 30 尺外远程攻击倒地目标 | 优势 / 劣势 |
| 2 | 攻击者中毒 + 目标倒地（5 尺内） | 抵消为普通，回执列出两项 |
| 3 | 祝福 + 力竭 2 级的豁免 | `+1d4 - 4` |
| 4 | 定身类人：豁免失败 → 麻痹 → 5 尺内命中 | 自动重击；回合结束重骰成功后麻痹消失 |
| 5 | 施法者专注检定失败 | 三个祝福目标的效应同时结束 |
| 6 | 护盾术让 17 vs AC 15 的命中变成未命中 | 之后的偷袭窗口不出现 |
| 7 | 同一回合两次命中 | 偷袭只问一次；在别人回合的借机攻击里还能再用 |
| 8 | 重击 + 偷袭 | 武器骰和偷袭骰都翻倍，调整值不翻 |
| 9 | 火焰抗性 + 火焰易伤 + 伤害 -3 | 顺序：-3 → 减半 → 加倍 |
| 10 | 0 HP 时受到重击 | 2 次死亡豁免失败 |
| 11 | 狂暴：一回合没攻击也没延长 | 回合结束时狂暴结束；连续延长不超过 10 分钟 |
| 12 | 两个祝福术施加到同一人 | 只生效一个；生效的那个结束后另一个接上 |
| 13 | 昏迷结束 | 倒地仍在 |
| 14 | 撤销到某个 seq | HP / 法术位 / 效应恢复，`CHAR` 同步 |

6. **覆盖度报告**：每个条目的 `automation` 统计，以及 522 条 note 的分诊进度。

---

## 十三、实施顺序（第 1–2 步内部）

1. `Expr`：解析器 + 类型检查 + 三值求值 + 单元测试。
2. `Events` + `D20` + `Damage` 管线（不含数据）+ 独角戏遭遇 + 假目标。
3. `rules-2024.json`：15 个状态 + 通用动作；人物卡的掷骰全部改走 D20 管线，上掷骰回执。
   **到这里，单张人物卡上的「倒地 / 中毒 / 力竭」就已经真正改变掷骰了。**
4. `Effects`：生命周期、持续时间、叠加、专注链接；迁移 `TEMP_STATES`（修狂暴时长）。
5. actions / triggers / auras 执行器 + 约 30 条手写黄金条目，用来打磨 schema：
   - 通用：借机攻击、双武器战斗、回避、协助、英雄激励
   - 战士 / 野蛮人：动作如潮、回气、额外攻击、精通重击、狂暴、鲁莽攻击
   - 游荡者：偷袭、灵巧动作、直觉闪避
   - 圣武士：至圣斩、守护灵光、圣疗
   - 武僧：疾风连击、震慑拳
   - 施法：祝福术、护盾术、魔法飞弹、火球术、定身类人、猎人印记、治愈真言
   - 其他：诗人激励、幸运、先天术法
   - 武器精通全部 8 种
6. 遭遇界面：先攻列表、回合推进、决定弹窗（仍然只在本地）。

§十五 的内容按依赖插进上面的顺序，不单独排期：
- `core.*` 参数化和 `override` 命令随第 2 步一起做（管线和事件流从第一天起就不写死常数、就支持覆写）；
- 场景效应随第 4 步（它只是承受者不同的 ActiveEffect）；
- 规则包的五种新声明、`patch`、战斗试算随第 5 步（用那 30 条黄金条目当房规的覆盖对象来测）。

完成后才进入第 3 步（AI 批量分诊 522 条 note、怪物确定性解析），那时 schema 应该已经稳定。

---

## 十四、已拍板的决定

| # | 问题 | 决定 | 落在 |
|---|---|---|---|
| 1 | 骰子来源 | 引擎、实体骰输入、（以后）VTT 里的 3D 物理模拟都支持，按人设置，默认引擎 | §6.1 |
| 2 | 怪物降至 0 HP | 默认死亡，DM 可以逐个改 | §3.1 `monsterAt0` |
| 3 | 默认自动化档位 | `assist` | §9.4 |
| 4 | 反应的决定时机 | 默认「看到结果再决定」；房间可切成 RAW；房规可逐条覆盖 | §9.5 |
| 5 | 上服务器后 PC 的静态计算放哪 | 服务器跑同一份静态管线（同构），客户端照常本地算 | §10.4 |
| 6 | 单卡模式下跨角色的专注链接 | v1 接受这个限制，上了房间同步之后解决 | — |
| 7 | DM 裁定与房规 | 引擎的每个结果都可以人工覆写；核心规则参数化；房规沿用规则包三层作用域并扩展到动态层；自定义内容导入走同一条校验 + 试算路径 | §十五 |

---

## 十五、人工覆写与房规

### 15.1 原则

> **自动化是建议，不是裁决。** DND 依赖 DM 的自由裁定和房规，引擎的职责是把规则算对、把过程摆出来，
> 而不是替桌子做决定。

由此得出四条硬约束：

1. **任何结果都能被人改**：命中与否、豁免成败、伤害数字、效应施加与否、持续时间、触发与否。
2. **改动可见**：每一次覆写都是一条事件，日志里标「DM 裁定」和理由（可选）。玩家能看到哪里被人改过，这是信任的来源。
3. **改动可撤销**：覆写走事件流，和其他事件一样可以撤销。
4. **没有硬编码的规则数字**：§六 / §七 里的规则常数（重击方式、专注 DC、死亡豁免阈值…）全部是数据（§15.4），房规可以改。

### 15.2 三种覆写（按生命周期分）

| 生命周期 | 例子 | 机制 |
|---|---|---|
| **一次性裁定**（这一次） | 「这次给你优势」「这一击算命中」「伤害改成 12」「这个豁免算成功」「跳过这次偷袭的询问」「这条效应这次不生效」 | `override` 命令（§15.3） |
| **场景效应**（这场遭遇） | 「这片浓雾里远程攻击都有劣势」「地精#3 在半掩护后」「整场都是困难地形」 | DM 现场写一个 ActiveEffect：承受者可以是某人、某一方或整个场景；有快捷模板（掩护、黑暗、优势/劣势、困难地形） |
| **房规**（持久） | 「重击取最大值再加一次掷骰」「侧翼包抄给优势」「狂暴次数 = 熟练加值」「偷袭我们自己裁定，别自动化」 | 规则包（§15.5） |

场景效应和房规用的是**同一套声明**（rollMods / statics / triggers），只是存放位置和寿命不同。DM 学一次就会写两种。

### 15.3 一次性裁定怎么落地

```ts
// 命令
{ type: 'override', at: Seq | DecisionId | 'pending', patch: OverridePatch, reason?: string }

type OverridePatch =
  | { outcome: 'hit' | 'miss' | 'crit' | 'success' | 'fail' }
  | { total: number }                      // 改检定总值
  | { damage: Record<DamageType, number> } // 改伤害（逐类型）
  | { addRollMod: RollMod }                // 临时加一条修正：「DM 给的优势」
  | { skipEffect: EffectId }               // 这一次忽略某条效应
  | { skipTrigger: string }                // 这一次跳过某个触发
  | { setHp: number } | { setResource: { id: string; used: number } };
```

三种时机：

| 时机 | 做法 |
|---|---|
| 掷骰前（`pending`） | 修改正在组装的 RollRequest（加一条 rollMod 等），回执里显示「DM：优势」 |
| `assist` 档的提议阶段 | 直接改提议再确认，最常用 |
| **已经落地之后** | 回退到被改的那条事件之前，带着 patch **重放后续**。之前记录的骰面按顺序复用（骰面带），只有新需要的骰子才重新掷；之前回答过的决定按路径复用，路径变了才重新问 |

已落地后再改，产生两条事件：`manualOverride { at, patch, by, reason }`，以及一段 `rolledBack` + 重放出来的新事件。
日志里显示成：`[DM 裁定] 地精#1 的豁免改为成功 ▸ 伤害 28 → 14`。

### 15.4 核心规则也是数据（`rules-2024.json#core`）

§六 / §七 里所有规则常数都从这里读。引擎代码里出现这些数字视为 bug（由检查脚本盯着）：

| 键 | 默认（2024 RAW） | 常见房规 |
|---|---|---|
| `core.critDamage` | `'doubleDice'`（伤害骰掷两次） | `'maxPlusRoll'`（一份取最大值 + 一份掷骰） |
| `core.critOn` | 攻击检定天然 20 | 天然 20 时豁免和检定也自动成功 |
| `core.concentrationDc` | `min(30, max(10, floor(damage.amount / 2)))` | |
| `core.deathSave` | `{ dc: 10, nat20: 'heal1', nat1: 2 }` | |
| `core.massiveDamage` | `true` | `false` |
| `core.flanking` | `false`（DMG 可选规则） | `true`：两名盟友夹击时近战攻击具有优势 |
| `core.diagonal` | `'5'`（每格 5 尺） | `'5-10-5'` |
| `core.initiative` | `'individual'` | `'side'`（按阵营一起行动） |
| `core.rest` | `{ short: 60, long: 480 }`（分钟） | 长休 4 小时 |

- 值都是 Expr 或枚举，可以在表达式里通过 `core.*` 读到。
- 侧翼包抄这种「开关型」房规本身就是一条 rollMod：`core.flanking = true` 时，`rules-2024.json` 里预置的那条 rollMod 才生效。
  这样新增房规不需要改引擎代码。

### 15.5 规则包扩展到动态层

沿用原项目的 Rulepack（`ABILITIES.md` §3.40）：三层作用域（全服 → 战役 → 本卡，**靠后的覆盖靠前的**）、
**覆盖官方必须显式**、`text` 必填、试算后才保存。本稿只做三处扩展：

**① 条目可以带五种新声明。** 规则包条目和官方条目同形，所以 `actions / triggers / rollMods / auras / effects` 照写即可。

**② 新增可覆盖的键。** 状态（`XPHB:condition:*`）、通用动作（`XPHB:action:*`）、武器精通（`XPHB:mastery:*`）、
法术（`XPHB:spell:*`）、核心参数（`core.*`）都是普通的键，用同一套 `covers` 机制覆盖。
例如「倒地时远程攻击不受劣势」就是覆盖 `XPHB:condition:倒地`。

**③ 字段级覆盖（`patch`）。** 原机制是整条替换，对动态条目来说太粗：DM 往往只想改狂暴的时长，不想重写整条狂暴。

```jsonc
{
  "id": "hr-9d2e", "key": "XPHB:野蛮人:狂暴:1",
  "text": "本团狂暴固定持续 1 分钟，不需要延长。",
  "patch": {
    "effects.狂暴.duration": { "minutes": 1 },
    "effects.狂暴.triggers": []
  }
}
```

- `patch` 的路径必须在被覆盖的条目里**存在**，否则校验报错。原条目改版、路径对不上时，房规作者会被明确告知，不会静默失效。
- 一条房规要么整条替换，要么 `patch`，不能混用。
- 界面上 diff 显示「官方 → 本团」。

**常用的一键房规**（预置成模板，DM 勾选即可）：
- 「这条我们自己裁定」：`patch: { automation: 'manual' }`。引擎对这一条只显示原文和骰子按钮，不再自动化。
  **这是 DM 对引擎最重要的一个开关**，任何一条都可以退回手动。
- 「这个反应按 RAW 时机问」：用 `patch` 整个替换那条触发器（路径必须存在，见 §16.6）。

### 15.6 自定义内容导入

自制内容和房规走**同一条路径**，区别只是自制内容用新键（`HR:*`），房规覆盖已有的键。

```
来源                              结构化                校验                 试算                 保存
5etools 格式的自制 JSON ─┐
粘贴文本 / 截图 ─────────┼─▶ 确定性解析 + AI 补全 ─▶ schema + Expr 编译 ─▶ 战斗试算（沙盒遭遇）─▶ 选作用域（卡/战役/全服）
表单编辑器 ─────────────┤      （同数据工厂）         + 双计检查            对比前后差异            text 必填
别人分享的规则包 ────────┘
```

- **AI 的产出永远不自动生效**。和官方数据工厂一样带 `confidence`，必须经过人看过试算再保存。
- **战斗试算**扩展原项目的试算（§3.40.7）：在一个沙盒遭遇里，用固定骰面对假目标跑一组典型事件
  （命中、被命中、受到伤害、回合开始/结束、施法），列出这条内容在每个时机**做了什么**。
  什么都没做的时机也要说出来（「这条声明了 3 个触发，在试算的 6 个事件里一次都没触发」），
  这是原项目「声明了却没反应」那类问题在动态层的对应检查。
- 自制怪物走同一条路径，产出 statblock + 动作（第 3 步实现）。

### 15.7 权限

| 操作 | 玩家 | DM |
|---|---|---|
| 实体骰输入 | 自己的掷骰 | 任何人 |
| 一次性裁定 | 只能对**自己的掷骰**提出申请，DM 批准后生效 | 直接生效 |
| 场景效应 | — | ✓ |
| 本卡层房规 / 自制内容 | ✓（进入战役时列给 DM 审核） | ✓ |
| 战役层 / 全服层 | — | ✓ |
| 切换某条的自动化（`automation: manual`） | 本卡层 | 任何层 |

单卡模式下没有 DM，玩家拥有全部权限。

### 15.8 补充的黄金场景

| # | 场景 | 断言 |
|---|---|---|
| 15 | 火球术落地后，DM 把地精#1 的豁免改为成功 | 回退重放；伤害减半；其他目标的骰面不变；日志标「DM 裁定」 |
| 16 | 房规 `core.critDamage = 'maxPlusRoll'` 下的重击偷袭 | 武器骰和偷袭骰都按「最大值 + 掷骰」计算 |
| 17 | 房规覆盖 `XPHB:condition:倒地`，去掉远程劣势 | 30 尺外远程攻击倒地目标：普通掷骰，回执显示「本团房规」 |
| 18 | `patch` 路径在官方条目里不存在 | 校验失败，指出是哪条房规、哪个路径 |
| 19 | 偷袭被设为 `automation: manual` | 命中后不再询问偷袭；动作面板显示原文和骰子按钮 |

---

## 十六、实现记录（第一轮）

> 第 1–2 步的引擎核心写完之后，回头对本稿做的修订。**两处冲突时以这里为准**；
> 数据示例以 `data/` 下的文件为准（§十一的示例是设计时写的，个别字段已经变了）。

### 16.1 代码位置

| 目录 | 内容 |
|---|---|
| `src/expr/` | 表达式语言：词法、语法、类型检查、三值求值、骰子值、旧写法转换 |
| `src/combat/` | 引擎：规则书（含房规层）、效应、D20 / 伤害管线、触发器、效果树解释器、回合、会话、审计 |
| `data/rules-2024.json` | 15 个状态、通用动作、8 个武器精通、核心参数 |
| `data/dyn/*.json` | 法术与特性的动态层（黄金条目）。**覆盖文件**：键与 `abilities-2024.json` 相同，合并时只补动态字段 |
| `tests/` | 表达式 50 项 + 黄金场景 21 项 + 规则/房规/审计 27 项 |
| `tools/check-data.ts` | `npm run check:data`：数据审计 |

### 16.2 暂停与恢复：重跑事务，不保存解释器的栈（改 §9.1）

§9.1 原计划把解释器的执行状态做成显式栈。实现改成了更简单的做法：

- 一笔**事务** = 一条命令的完整结算。结算中途需要人做决定时，事务作废；
  拿到回答后，**从同一个起点、带着已掷出的骰面（磁带）和已得到的回答**把整条命令再跑一遍。
- 结算是确定的（同样的状态 + 骰面 + 回答 → 同样的结果），所以会走到同一个决定点、拿到回答、继续。
- 要存的只有「命令 + 磁带 + 回答 + 裁定」，天然可序列化。
- 同一个机制同时解决了：实体骰输入（回答就是骰面）、撤销（丢掉事务、从起点重跑）、
  DM 事后裁定（§15.3，给事务加一条裁定、从那里往后重跑）。
- 磁带按位置复用，并核对规格；一旦有一格对不上（裁定改变了结算路径），从那里往后全部重新掷。

### 16.3 专注写在动作上，不写在 applyEffect 上（改 §4.1 / §11）

专注是法术的属性，不是某个效应的属性：定身类人的目标豁免成功，施法者仍然在专注。所以：

- `Action.concentration: Duration`：施放时结束旧专注、开启新专注；
- 本动作施加的效应**默认链接**到这个专注，时长默认取专注时长（`link: false` 可以不链接）。

### 16.4 效果树的两条执行约定（补 §4.2）

1. 动作的 `root` 只执行一次。需要目标的节点（attack / save / 指向 target 的节点）在没有「当前目标」、
   而有多个目标时，**隐式地对每个目标各执行一次**（共享 locals：同 id 的伤害只掷一次）。
2. 一个分支里的 `damage` 节点合成**一个伤害包先结算**，然后再执行其余节点（「命中：X 伤害，并且目标须豁免」）。
3. 带 `id` 的伤害只掷一次；`ref` 指向的那次还没掷过时（第一个目标就豁免成功），按定义补掷。

### 16.5 小的 schema 调整

| 项 | 调整 |
|---|---|
| `save.ability` | 可以写数组 = 由目标选择，引擎替目标选加值高的（擒抱、推撞） |
| 新函数 | `abilityMod(name)`（擦掠、失衡用）、`combatant(id)`（事件载荷里只有 id） |
| `roll` 作用域 | 增加 `sub`（initiative / deathSave / concentration）和 `target` |
| 效应模板 | 增加 `deathAtLevel`（力竭 6 级死亡） |
| 英雄激励 | 建模成资源 `英雄激励`（上限 1）+ 全局触发器，不单独加字段 |
| `reactionTiming` / `monsterAt0` | 是**房间设置**（`settings`），不是核心参数；已从 §15.4 的表里删除 |
| 伤害类型 | 统一用站点 2024 译名（「挥砍」不是「斩击」），英文与 5etools 代码都会被规范化 |

### 16.6 房规 patch 的路径必须完整存在

为了不让拼错的字段静默失效，`patch` 的**整条路径**（包括最后一段）都必须在被覆盖的条目里存在。
想加一个原来没有的字段，就替换它的上一级对象。数组段可以写下标，也可以写元素的 `id`（`actions.cast`）。

### 16.7 数据审计（`src/combat/audit.ts`）

比 §十二 计划的多查了几类：触发器挂在引擎不发出的事件上、`modify` 写在 after 窗口、
触发器什么都不做、反应型动作没写触发条件、检定修正缺 `label`。
测试里有一份故意写坏的数据，确认每一类都能被抓出来。

### 16.8 还没做的（按依赖顺序）

1. ~~**静态层移植**~~ —— 已完成，见 [PORTING.md](PORTING.md)；桥接在 `src/bridge/from-sheet.ts`。
2. ~~遭遇界面与人物卡界面~~ —— 第一版已完成（`app/`），见 §16.9。
3. ~~第二批黄金条目~~ —— 职业特性与专长已完成，见 §16.10。还差：魔法飞弹、双武器战斗（轻型武器的附赠攻击）、
   借机攻击的自动提示（要地图）、战技 / 超魔法 / 魔能祈唤的动态数据（来源已经接通，缺数据）、诡诈打击与各子职特性、
   遭遇里的短休（引擎还不知道每种资源怎么恢复，现在在人物卡上休息）。
4. 第 3 步：AI 分诊 522 条 note、怪物确定性解析。
5. 先记着、暂时不做：没有方便看棋子身上状态（效应）的地方；法术附带的状态（电爪的「不能借机攻击」）
   效应名就叫法术名，悬浮提示直接指向法术原文。给每种这类状态单独写条目太累，先这样。

### 16.9 界面接入时补的东西

| 项 | 内容 |
|---|---|
| 存档 / 读档 | `Session.save()` 给出起点 + 每笔事务的输入 + 等待中的那笔；`Session.restore()` 重跑一遍。磁带里有骰面，读档不重掷；等待中的实体骰决定也接得上 |
| 新命令 `heal` / `tempHp` | 手动治疗和法术治疗走同一条路：0 生命值时的昏迷随之结束；临时生命值取高 |
| 新命令 `manualCast` | 没有动态数据的法术：照样付法术位与动作、遵守「一回合一个法术位」、开专注、发 `spellCast`（隐形术之类的 endsOn 照常生效），效果由人处理。动态数据补齐之前，绝大多数法术走这条路 |
| 新命令 `setUsage` | 手动改资源 / 某环法术位的已用次数（记进日志，可撤销） |
| `CombatantView.resourceNames` | 资源 id → 显示名，只给界面用 |
| 骰子来源 | 按控制者设置，放在界面状态里由 `diceFor` 读取；`settings.dice` 引擎不读。只影响新掷的骰子，重放与裁定复用磁带 |
| 付不起代价的动作 | 界面上仍然可以点：确认后带 `force` 执行（DM 强制），不检查代价与次数 |

### 16.10 第二批黄金条目：职业特性与专长

**条目**（`data/dyn/features.json`、`spells.json`、`rules-2024.json`；测试 `tests/combat/features.test.ts`）：
回气、战术思维、动作如潮、灵巧动作、稳定瞄准、危机感应、圣疗、至圣斩（法术）、圣武斩（免法术位一次）、神圣武器、
武艺（徒手打击 / 附赠徒手打击）、疾风连击、震慑拳、诗人激励、幸运、先天术法；通用动作「躲藏」从手动改成自动（原文写成了感知，应为敏捷）。

**引擎补的东西**

| 项 | 内容 |
|---|---|
| 窗口触发的动作不限于反应 | `Action` 写了 `trigger` 就由窗口触发，代价按 activation 算（至圣斩是「命中后的附赠动作」）。`requires`、「一回合一个法术位」、不能施法这些在**收集候选时**就过滤掉 —— 不能等到执行时才拒绝，那会让整笔事务失败。执行时带上窗口的上下文（伤害包、攻击、检定），所以至圣斩能 `addDamage` |
| 问环阶 | 没指定环阶、效果里用到 `slot.level`、又有不止一种环阶可用时，发 `slotLevel` 决定 |
| `number` 节点 | 让人选一个数，放进 `vars.<名>` 给后面的节点用（圣疗用多少点） |
| `choose` 选项可以带 `when` | 条件明确不满足的选项不列出来；只剩一个就不问 |
| `reroll` 可以 `keep: 'lower'` | 幸运的「施加劣势」 |
| 静态修正 `spellDc` | 先天术法 |
| `roll.failing` | before 窗口里「按现在的结果会失败」。诗人激励、战术思维、幸运都只在**会改变结果**时才打扰人 |
| `classTable` 的骰子格返回骰子值 | `classTable('武艺') + max(self.mod.str, self.mod.dex)` 能直接写；效应 `state` 里的骰子存成文本（存档要能序列化） |
| 代价说明用资源的显示名 | 「引导神力 1 次」而不是「channel-divinity ×1」 |

**人物卡那边顺带修的**（都是「战斗里根本没有这个资源」的根因）

| 项 | 内容 |
|---|---|
| 资源上限公式支持表达式 | `level * 5`、`cond(level >= 17, 2, 1)`，其中 `level` 是**该职业**的等级（多职业圣武士 2 / 法师 3 的圣疗是 10 点，不是 25）。以前圣疗能量池、动作如潮算不出上限，桥接时被丢掉 |
| 2024 的「短休回一次」 | 狂暴、引导神力、荒野形态、回气：长休全回、短休回 1（以前当成短休全回） |
| 数据修正 | 诗人激励（魅力调整值次，5 级起短休恢复）、先天术法（2 次）、圣武士的引导神力和职业表的池合并（以前重复成两个池）、圣武斩授予至圣斩 |
| 计数不是资源 | 「祈唤」这类已知数量不进战斗的资源表 |
| 选出来的可选特性是能力来源 | 魔能祈唤、战技、超魔法……以前只在卡面上写一行字。现在和专长一样进入 `collectSources`：静态授予生效（幽影护甲 → 法师护甲），战斗引擎按 `XPHB:<名字>` 认。同名的 2014 / 2024 两版优先 2024 |
| 资源 id 对账测试 | 每个测试角色：它的动态条目要花的资源，在它身上都必须有（这条测试能抓到上面那几类问题） |

**「要玩家做选择」的东西在哪一层**

| 时机 | 例子 | 机制 |
|---|---|---|
| 建卡时选一次，一直有效 | 技能、专长、战斗风格、魔能祈唤、战技、超魔法、法术 | 能力数据的 `choices` / 职业的可选特性 → 待决定列表 → 选的结果存在 `char.decisions[键]` → 变成授予（技能、法术…）或**能力来源**（专长、可选特性） |
| 资源池 | 狂暴次数、功力、圣疗能量池、诗人激励 | 职业表的列 + 能力数据的 `resources` 声明，同名合并；已用次数存在 `char.resources[键].used`；进战斗时按 id 映射成 `view.resources`，结束时写回 |
| 战斗中每次用的时候选 | 用不用偷袭、至圣斩用几环、圣疗用多少点、治疗还是解毒 | 引擎的决定：`optionalTrigger` / `slotLevel` / `number` / `choose` / `ask`，结算停下来等回答，回答写进事务（可撤销、可重放） |


### 16.11 动作实例（第一期）

起因：触发器只能读到窗口挑着放进作用域的几样东西（`attack`、`roll`…），读不到「触发它的那次动作」是什么、也不能对它做事，
所以强力戏法（戏法失手 / 豁免成功仍受一半伤害）、强效塑能（要问人「这是不是塑能法术」）这类做不了。
先审再定形状：`datafy/instance-audit/` 审了 1010 条没完全自动化的条目，统计每条要读什么、做什么（`report.md`、`report.generated.md`）。

| 项 | 内容 |
|---|---|
| 实例 | `src/combat/instance.ts`。`executeAction` 压进 `tx.actions`（栈），结束弹出。只活在一次事务里，重放时重建，不进状态、不进事件 |
| 读 | 所有作用域都有 `action`（不在动作里 = null，读字段得空值）：`kind`、`name`、`key`、`by`、`economy`、`onMyTurn`、`spell.{level, slot, school, lists, concentration, ritual, range, components}`、`attack`、`targets`、`targetCount`、`marks`、`parent`。触发器的 do 不压新实例，读到的就是触发它的那次；反应动作进 root 后读自己，触发它的在 `parent` |
| 法术元数据 | `data/spell-meta.json`（`tools/build-spell-meta.ts` 从 5etools 生成，进 git：引擎在浏览器和服务器都跑）。查不到的（自制法术）环阶按法术位推，学派为空 |
| 新窗口 | `saveSucceeded` / `saveFailed`（after，豁免节点的分支跑完之后） |
| 新节点 | `mark`（在实例上做记号）、`runBranch`（attackMissed / 豁免结果窗口里改跑那个节点的另一支，可只取伤害、乘倍数、`ifNoDamage`）、`refund`（退还实例花的法术位 / 资源） |
| `rollMod.mark` | 修正生效时做记号；配 `when` 里 `action.marks.x != true` 做「每次施法只一次」。**共享掷骰**（伤害节点的 id / ref）算一次伤害掷骰：同一次掷骰的其他目标看不见这次掷骰自己做的记号（`hideMarksOfRoll`），所以火球术每个目标都加、灼热射线三道只加一次 |
| 非攻击伤害的修正 | 以前伤害的 rollMod 只对攻击造成的伤害生效。现在写了 `on.spell` 的也对豁免法术的伤害生效（这时 `attack.*` 全 false）；没写 `on.spell` 的照旧只管攻击，免得「近战伤害 +2」这类跑到法术上 |
| 区域 | 区域每次生效都压一个实例：从区域记着的条目键、施法者、环阶现搭（`space.ts` 的 `withZoneInstance`），所以区域伤害也算法术伤害、do 里能读 `action.*`（`action.zone` = 哪块区域）。区域是同一次施法的延续：实例上的记号记回区域（`zoneMarked` 事件，`Zone.marks`），强效塑能这类「每次施法只一次」不会每回合再来 |
| 结果与伤害骰（第二期的一部分） | 实例记每个目标的结果（`results`：命中、重击、豁免成功、造成的伤害、降到 0、击杀；`last` = 正在结算的目标），表达式读 `action.result` / 计数；记最近一次伤害骰（命中窗口里伤害还没掷就先记要掷的），`action.damage.die` = 其中一颗。新窗口 `actionDone`（after，只开给最外层的动作：反应、窗口里用的动作不再触发一轮） |
| 用上的数据 | 手写，`data/dyn/features.json`，不再问人：强力戏法、强效塑能、德鲁伊 / 牧师强力施法；菜单这批：偷袭 + 诡诈打击（合进偷袭，AI 那几条选项清空）、维持生命、横扫攻击、强效 / 转化 / 孪生 / 谨慎 / 升阶法术 |

**菜单选择和剩下的几样**（`tests/combat/menus.test.ts`）：

| 项 | 内容 |
|---|---|
| `chooseTargets` | 结算中途挑生物：候选按 from（all / enemies / allies / targets）、within（离自己或当前目标几尺，有地图才筛）、filter、exclude 筛，挑 min～count 个，对每个执行 do。`addTo: 'cast'` 在施法窗口里把挑中的加进这次施法的目标 |
| `allocate` | 分配点数：先挑给谁，再逐个问给多少（每个最多 maxEach，剩下的用完就停），复用现有的「选一个数」弹窗 |
| `retype` / `trimDamage` | 改正在结算的伤害包的类型（或施法计划书的）；从某一项去掉几颗骰（诡诈打击扣偷袭骰） |
| `rerollDamage`（modify） | damageIncoming before 里重掷最小的几颗；共享掷骰重掷一次，记在实例上，其他目标照用 |
| `repeatAction` | 对挑中的目标再执行一次这次动作的 root（不付代价，一次动作最多 10 次） |
| `modifyCast.slotDelta` | 有效环阶加几，不多花法术位（孪生法术）；施法窗口之后按计划书的目标、有效环阶结算 |
| `choose` | count 可以是表达式；pool 可以按学派 / 职业列表筛 |
| 合并规则 | 手写条目盖 AI 条目是逐字段合并：要去掉 AI 那份的触发器，手写那份得显式写 `triggers: []` |

还没做：改射程（射程检查在界面选目标那一步）、把攻击动作里的一次攻击换成施法。
