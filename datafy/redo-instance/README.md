# 重做：用上「动作实例」和「菜单选择」的 462 条

引擎加了两大块新写法（`spec.md` 第 4 节「动作实例」「菜单选择」两段，先完整读一遍）：

- **动作实例** `action.*`：触发器、检定修正、效果节点都能读到**正在结算的那次动作**——是不是法术、几环、什么学派、在哪些职业的法术列表里、每个目标命中 / 豁免 / 受伤的结果、这次的伤害骰……
- **菜单选择**：结算中途让人挑生物、分配点数、几选一、改伤害类型。

以前做不到，所以现有 AI 数据里很多是 `ask('这是不是塑能法术？')`、note「请人工处理」、或者只做了一半。
这一包把审查（`datafy/instance-audit/`）里标出来的条目重做一遍。

## 新写法速查（例子都在 `examples.json` 里，按键找）

| 要做的 | 写法 | 范例 |
|---|---|---|
| 判断「这是不是戏法 / 塑能法术 / 法师法术」，不再问人 | `action.kind == 'spell'`、`action.spell.level == 0`、`action.spell.school == '塑能'`、`includes(action.spell.lists, '法师')` | `XPHB:法师:强效塑能:10`、`XPHB:德鲁伊:强力施法:7` |
| 豁免法术（火球术这类）的伤害也加值 | rollMod 写 `on: { kind: 'damage', spell: true }` | `XPHB:法师:强效塑能:10` |
| 「每次施法只一次」 | rollMod 写 `mark: 'xxx'` + when 里 `action.marks.xxx != true`；触发器的 do 里 `{ kind: 'mark', name: 'xxx' }`。**记号名只能用英文字母和数字** | `XPHB:法师:强效塑能:10`、`XPHB:强效法术` |
| 失手 / 豁免成功时仍受一半伤害 | `saveSucceeded` / `attackMissed` 窗口 + `runBranch` | `XPHB:法师:强力戏法:3` |
| 命中、豁免成功、打倒了没有 | `action.result.hit` / `saved` / `reducedTo0` / `killed`、`action.hitCount`、`savedCount`… | spec 第 4 节 |
| 「用完一个动作之后」 | 挂 `actionDone` 窗口 | spec 第 4 节 |
| 多掷一颗这次的伤害骰 | `addDamage` 的 `dice: 'action.damage.die'`、`type: 'action.damage.type'` | spec 第 4 节 |
| 退还法术位 / 资源 | `{ kind: 'refund', what: 'slot' }` | spec 第 4 节 |
| 挑一个 / 几个生物（「5 尺内另一个生物」「你选择的生物」「法术的目标之一」） | `chooseTargets`（`from`、`within`、`filter`、`exclude`、`min`、`count`、`do`） | `XPHB:横扫攻击`、`XPHB:谨慎法术`、`XPHB:升阶法术` |
| 把点数分给几个生物 | `allocate`（`total`、`maxEach`、`var`、`do`） | `XPHB:牧师:维持生命:3` |
| 改这次伤害的类型 | `choose`（`var`）+ `{ kind: 'retype', value: 'vars.x' }` | `XPHB:转化法术` |
| 施法时多一个目标、按高一环算 | `spellCast` before 窗口：`modifyCast` 的 `slotDelta` + `chooseTargets` 的 `addTo: 'cast'` | `XPHB:孪生法术` |
| 从伤害里扣掉几颗骰子 | `trimDamage`（`from` = 加那项伤害的能力的 label） | `XPHB:游荡者:偷袭:1` |
| 重掷伤害骰 | damageIncoming before 的 `modify: [{ op: 'rerollDamage', count: … }]` | `XPHB:强效法术` |
| 对另一目标再来一次 | `repeatAction`（配记号限制次数） | spec 第 4 节 |
| 把一次攻击换成施法 | 动作 `cost: [{ economy: 'attack' }]`（几次就写 `n`）+ `choose` 的 `pool` + `castFrom` | `XPHB:战士:战争魔法:7`、`XPHB:战士:精通战争魔法:18` |
| 射程翻倍 | 效应 `flags.rangeMult` / `touchRange` | `XPHB:远程法术` |
| 从自己的法术里挑（按学派 / 职业筛） | `choose` 的 `pool: { from: 'ownSpells', school: '预言', list: '牧师' }`；`count` 可以写表达式 | `XPHB:游荡者:偷袭:1`（count） |
| 区域每回合的伤害 | 区域里也读得到 `action.*`，区域伤害算法术伤害；记号跟着区域走 | spec 第 4 节 |

## 每条要做的

1. 读 `tasks/R0xx.md`：原文、「这次为什么重做」（审查时记下的要读什么、要做什么）、**现在的数据**。
2. 在现在的数据上改，把**整条**写进 `answers/R0xx.json`，键和格式照旧。
   - 动作 id、效应名不要改（任务里「接口」一节列出来了，别处按名字引用）。
   - 把 `ask('这是不是…')`、note「请人工处理」这些换成新写法；`text` 里对应的「需人工」说明删掉或改掉。全都能自动了，`automation` 改成 `"full"`。
   - 审查里的提示只是参考：它写的 `NEW:xxx` 和中文记号名都不是现成写法，以 spec 为准。
   - **不用改**的（现在的写法已经对了、或者新写法也做不到）写 `{ "skip": "不用改：一句原因" }`，现有数据原样保留。
   - 新写法也只能做一部分的：能做的做，剩下的照旧写进 `text`，`automation: "partial"`。
3. 检查：`npx tsx tools/factory/batch.ts lint datafy/redo-instance R0xx`。✗ 的照着问题改，最多改 4 轮。

按 `batches.json` 一批一批做（60 批，每批 8 条，同一批是同一类：XPHB 特性、其他书的特性、XPHB 法术、其他书的法术、物品）。

## 注意

- **宁可不改，也不要改错**。拿不准原文意思的，保持原样写 skip。
- 有地图时 `within` 才按距离筛，没有地图时会让人自己把握 —— 照原文写距离就行，不用另外问。
- 引擎**还不管**的：视线、遮蔽、光照、掩护、墙、召唤物的行动、物品的变化、随机效果表（狂野魔法浪涌）。这些照旧写进 `text`。
- 只写 `answers/` 里的文件。觉得引擎还缺什么，记到 `datafy/notes.md`，写清楚哪一条、缺什么。

## 不在这包里的（手写数据，由人改）

审查里也标了、但已经有手写数据的 35 条，出题工具不出：
`FRHoF:法师:额外攻击:6`、`XPHB:spell:沉默术`、`XPHB:spell:猎人印记`、`XPHB:spell:油腻术`、`XPHB:术士:龙伴:18`、`XPHB:吟游诗人:威仪作锦:6`、
`XPHB:游侠:精宸所与:11`、`XPHB:战地施法者`、`XPHB:action:躲藏`、`XPHB:action:魔法`、`XPHB:action:协助`、`XPHB:action:预备`、
`XPHB:condition:魅惑`、`XPHB:mastery:横扫`、`XPHB:mastery:迅击`；其余 20 条是这次已经用新写法重写过的（强力戏法、偷袭、维持生命、超魔法几条……）。

## 收尾

全部做完后跑：

```bash
npx tsx tools/factory/batch.ts collect datafy/redo-instance
```

它会再检查一遍、在一场模拟战斗里试算，通过的写回条目原来所在的 AI 文件；**原来在 `data/dyn/reviewed.json` 里的那份会被删掉**（不然它会盖住新答案）。
没过的列在 `failures.json`，照着改完再 collect。最后跑 `npm run check:data` 和 `npm test`（只有快照差了新资源池的话，`npm run snapshots` 更新）。
汇报：改了多少、skip 多少、没过多少，`notes.md` 里记了什么。
