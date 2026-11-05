# 审「动作实例」：没自动化的能力要从触发它的事件里拿什么

## 为什么做这件事

引擎里很多能力做不了，原因是同一个：**触发器拿不到「触发它的那次动作」的完整信息，也不能对那次动作做事**。

例子：塑能师的「强力戏法」——「戏法攻击失手、或目标豁免成功时，目标仍受一半伤害，不受其他效果」。
现在「攻击失手」窗口只给 `attack`（攻击的性质）和 `roll`（骰点），不知道这是不是戏法，也拿不到这道戏法命中时会掷的伤害骰。

我们打算加一个通用的东西：**动作实例**。一次动作（施一道法术、一次武器攻击、用一项特性）从开始到结算完是一个实例，
它引起的每个事件的窗口都带着它，触发器可以读它的字段、对它做几种通用操作。
**先不写代码，先审**：把现在没自动化的条目逐条看一遍，记下每条要读什么、要做什么。汇总出来就是实例该有的形状。

## 这里有什么

所有命令都在仓库根目录运行（这个文件夹的上一级）。

| 文件 | 内容 |
|---|---|
| `parts/P01.json` … `P26.json` | 要审的条目，每份 40 条。每条有：键、名字、谁写的（AI / 手写 / 审后补）、`automation`、环阶（`null` = 不是法术，0 = 戏法）、`text`（说明，常常写了哪里要手动）、`notes`（执行树里用一句话代替了真效果的地方）、`data`（条目现在的 JSON，长的截断了） |
| `list.md` | 全部条目一览 |
| `spec.md` | 写规则数据的说明书（按现在的代码生成）。**第 4 节「时机（窗口）」那张表**列了每个窗口现在能读到什么、能改什么，判断「现在缺不缺」以它为准 |
| `answers/` | 你的答案，和 parts 同名（`answers/P01.json`） |

条目全文按键在 `data/dyn/ai/*.json`、`data/dyn/*.json`、`data/rules-2024.json` 里找（同键时后面的文件盖前面的）。
想看规则原文，可以查 `data/5etools/`。

## 每条答什么

`answers/P01.json` 是一个数组，parts 里每条对应一个对象，不能多也不能少：

```json
{
  "key": "XPHB:法师:强力戏法:3",
  "scope": "combat",
  "needsInstance": true,
  "on": "attackMissed, saveSucceeded",
  "reads": ["action.spell.level"],
  "does": ["runBranch:onHit:damageOnly:x0.5", "runBranch:onFail:damageOnly:x0.5"],
  "otherGap": null,
  "now": false,
  "note": "戏法失手或豁免成功时，把命中 / 豁免失败那一支的伤害减半结算，不带其他效果"
}
```

| 字段 | 写什么 |
|---|---|
| `scope` | `combat` = 战斗里常用，值得自动化；`rare` = 战斗里有但少见或花活太多；`manual-ok` = 叙事、探索、社交、休息时的，手动正常 |
| `needsInstance` | 做成这条，要不要读**触发它的那次动作 / 事件**的信息，或者对那次动作做事。只是读自己、目标的属性和状态的，写 `false` |
| `on` | 挂在哪个事件上（spec 第 4 节表里的名字，几个用逗号隔开）；要的事件现在没有就写 `NEW:一句话`，比如 `NEW:豁免成功之后`；靠检定修正（`rollMods`）生效的写 `rollMod:<d20 / damage / …>`；不是触发型的写 `null` |
| `reads` | 要读的字段，用下面「字段」表里的名字；表里没有就写 `NEW:路径`，比如 `NEW:action.spell.material.cost`，并在 note 里说明 |
| `does` | 要对那次动作做的事，用下面「操作」表里的写法；没有合适的写 `NEW:名字`；只是读来做条件的写 `[]` |
| `otherGap` | 除了动作实例，还卡在别的地方吗：`zone` 区域、`move` 位移、`vision` 视线 / 光照 / 掩护、`summon` 召唤、`item` 物品、`choice` 菜单、`resource` 资源 / 法术位、`condition` 状态规则、`remember` 效应记住数值、`other`；或 `NEW:短名字`；没有就 `null` |
| `now` | `true` = 按现在的 spec 其实已经能写，是数据没写好（在 note 里写一句该怎么改）；`false` = 确实缺东西 |
| `note` | 一句话：这条具体要什么 |

### 字段（`reads` 用，草案）

`action` 是**触发这个事件的那次动作**的实例。字段是草案，觉得缺什么用 `NEW:` 补，这正是这轮要收集的。

| 字段 | 意思 |
|---|---|
| `action.name` / `action.key` | 动作或法术的名字、条目键 |
| `action.kind` | `spell` / `weapon` / `unarmed` / `feature` / `item` / `monster` |
| `action.by` | 谁用的 |
| `action.economy` | `action` / `bonus` / `reaction` / `free` |
| `action.spell.level` | 法术的基础环阶（戏法 0） |
| `action.spell.slot` | 实际用的法术位环阶（升环时比基础高） |
| `action.spell.school` | 学派（塑能、防护……） |
| `action.spell.list` | 算哪个职业的法术（法师法术、术士法术……） |
| `action.spell.concentration` / `action.spell.ritual` | 专注 / 仪式 |
| `action.spell.range` / `action.spell.components` | 射程 / 成分 |
| `action.attack.*` | 攻击的性质（近战、远程、武器、法术、徒手、灵巧、武器名、精通），和现在的 `attack` 一样 |
| `action.targets` / `action.area` | 全部目标 / 范围（形状、大小） |
| `action.damage.dice` / `action.damage.types` | 这次动作的伤害骰、伤害类型（包括还没掷的那一支） |
| `action.save.ability` / `action.save.dc` / `action.save.half` | 要求的豁免属性、DC、成功是否减半 |
| `action.result.*` | 每个目标的结果：`hit`、`crit`、`saved`、`damage`（造成了多少、什么类型）、`reducedTo0`、`killed` |
| `action.marks.<名字>` | 这次动作上的记号（见操作 `mark`），用来做「每次施法只能一次」 |
| `action.parent` | 引起这次动作的上一层动作（反应的反应、攻击动作里的某一次攻击） |
| `action.onMyTurn` | 是不是在使用者自己的回合 |

### 操作（`does` 用，草案）

| 写法 | 意思 | 例子 |
|---|---|---|
| `set:<字段>` | 结算前改这次动作的字段：`dc`、`atk`、`damageType`、`targets`（加 / 减目标）、`area`、`range`、`economy`、`slot` | 篡改法术改 DC；远距法术改射程；瞬发法术改动作经济 |
| `cancel` | 打断这次动作 | 法术反制 |
| `runBranch:<分支>[:damageOnly][:x<倍数>]` | 执行这次动作的某一支：`onHit` / `onMiss` / `onFail` / `onSuccess`；`damageOnly` = 只取伤害、不带其他效果 | 强力戏法 |
| `addDamage[:sameDice\|sameType]` | 给这次动作加伤害：`sameDice` = 再加一颗它自己的伤害骰，`sameType` = 用它的伤害类型 | 「多掷一颗该法术的伤害骰」 |
| `rerollDamage` | 重掷这次动作的伤害骰 | 强效法术 |
| `repeat` | 对另一个目标再执行一次这次动作 | 孪生法术 |
| `refund:<slot\|resource\|economy>` | 退还这次动作花的东西 | |
| `mark:<名字>` | 在这次动作上做记号（配合 `action.marks.<名字>`） | 强效塑能「其中一次伤害掷骰」 |
| `remember` | 把这次动作的字段抄进一个效应，之后用 | 记住施法时的环阶、伤害类型 |
| `onParent:<操作>` | 对上一层动作做上面的操作 | |

## 例子

**强力戏法**（`XPHB:法师:强力戏法:3`）：就是上面那条 JSON。

**强效塑能**（`XPHB:法师:强效塑能:10`）：现在每次伤害都弹窗问「是不是塑能学派的法师法术」。

```json
{ "key": "XPHB:法师:强效塑能:10", "scope": "combat", "needsInstance": true, "on": "rollMod:damage",
  "reads": ["action.spell.school", "action.spell.list", "action.marks.强效塑能"], "does": ["mark:强效塑能"],
  "otherGap": null, "now": false, "note": "塑能学派的法师法术的第一次伤害掷骰加智力调整值；记号保证一次施法只加一次" }
```

**召唤类**（随从入场、跟着行动）：

```json
{ "key": "…", "scope": "combat", "needsInstance": false, "on": null, "reads": [], "does": [],
  "otherGap": "summon", "now": false, "note": "要把召唤物加进战斗并跟着施法者行动，和动作实例无关" }
```

## 原则

- **只看这一条要什么，不要设计实现。** 表里没有的字段 / 操作就写 `NEW:`，在 note 里说清楚它是什么。
- `needsInstance` 判断要严：读的是**触发它的那次动作**，才算 `true`。读自己、目标的属性 / 状态 / 距离（spec 第 3 节已经有了）不算。
- 一条要好几样就都列上；`reads` 里只列真正要读的字段，不用把「顺便有用」的都写上。
- 「现在就能写」（`now: true`）的要对照 spec 确认过再写，note 里写怎么改。
- 只写 `answers/` 里的文件，不要改仓库里的其他东西。

## 交付

1. 26 份都写完后跑：
   ```bash
   npx tsx tools/factory/instance-audit.ts merge
   ```
   它会检查格式（缺条、多条、字段写错会列出来，改完再跑），通过后生成 `report.generated.md`：按事件、字段、操作统计次数，再逐条列出。
2. 在本文件夹新建 `report.md`，手写一节「建议」：
   - 实例必须有的字段、操作，按用到的条数排，每个举 2～3 条代表；
   - 你写的所有 `NEW:`，合并同义的，说明是什么、几条用到；
   - 表里有、但一条都没用到的（可以先不做）；
   - 动作实例解决不了的，按 `otherGap` 列个数。
3. 汇报：一共多少条，三种 scope 各多少，`needsInstance` 多少，`now: true` 多少，`report.md` 的要点。
