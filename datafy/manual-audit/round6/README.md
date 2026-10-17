# 第六轮：剩下几个大类（反应里改结算 / 免伤 / 物品消耗 / 次数池 / 改目标 / 推拉 / 取最大）

审查报告里除了「区域 / 借机 / 召唤」和「重骰 / 加骰 / 改判定」之外剩下的类别，一共 92 条。

## 结果

| | 条数 |
|---|---|
| 写出来、机器检查通过 | 92 |
| **已合并** | **55**（10 条从 partial 升到 full） |
| 复核挑出问题 → 缓着 | 35（[suspects.md](suspects.md)） |
| 落在手写文件里、单独同步的 | 2（`XPHB:spell:猎人印记` 已同步进 `data/dyn/spells.json`；`XPHB:condition:昏迷` 内容未变） |

## 顺手修的一个引擎缺口

**`damageTaken` 以前只开窗口、不发事件** —— 效应的 `endsOn: [{ event: 'damageTaken' }]` 是靠 `checkEndsOn` 匹配事件的，
所以数据里约 26 处「受到伤害后结束」的写法**从来没有生效过**。现在伤害结算完会真的发一条 `damageTaken` 事件
（带 amount / type / crit / downed），`tests/combat/effect-lifecycle.test.ts` 里有回归测试。

## 这一轮代理们实测出来的引擎事实（记进 BACKLOG 了）

- `aura.grant.triggers` 不像 `rollMods` 那样过 `auraGate` → 灵光授予的触发器要自己写 `within(source, self, 半径)`
- `before` 窗口在触发器里重新施加同效果后会重新收集候选（最多 5 轮）→ 用「重新施加效应记剩余次数」时要加短命标记，否则同一笔伤害会算两次
- 引擎读不到「手上用的什么武器 / 伤害骰」这件事反复出现（双持客、战斗魔法、魔化武器、粉碎者…都靠弹窗选）

## 下一轮

照 `suspects.md` 把那 35 条改完（多数是 `when` 少一个条件、DC 属性写错、把做不到的写成 manual 这些一行级的活）。
