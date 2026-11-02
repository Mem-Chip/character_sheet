# 重做：区域 / 困难地形相关的 74 条

引擎的区域功能扩充了。下面这些新写法以前没有，所以现有的 AI 数据只能写 note「请人工处理」，或者干脆写错。这一包把受影响的条目重做一遍：

| 新写法 | 干什么 | 手写的范例（`examples.json` 里按键找） |
|---|---|---|
| `zone.while: [applyEffect…]` | 待在区域里就有的效应：进来挂上，离开、区域挪走或消失时自动摘掉 | `XPHB:spell:沉默术`、`XPHB:spell:哈达之欲` |
| `applyEffect.whileInZone: true` | 区域里豁免失败挂上的效应，离开区域就解除 | `XPHB:spell:蛛网术` |
| `zone.on` 新增 `leave` / `move` / `create` | 离开时、在里面每走 5 尺、区域出现时就在里面的 | `XPHB:spell:荆棘丛生`（move）；leave / create 还没有范例，写法和 enter 一样 |
| `zone.difficult: true` | 困难地形：走进去每格多扣 5 尺移动力（被推拉不算） | `XPHB:spell:油腻术`、`XPHB:spell:冰风暴` |
| `zone.fully: true` | 原文「完全位于」：棋子占的每一格都在区域里才算 | `XPHB:spell:沉默术` |
| `{ kind: 'moveZone' }` | 附赠动作挪区域：动作写 `targeting: { type: 'area', … }` 选新位置 | `XPHB:spell:月华之光`、`XPHB:spell:炽焰法球` |
| 效应 `flags: { ignores: ['difficultTerrain'] }` | 困难地形不多扣移动力 | （还没有手写范例） |
| 区域记住施法时的数 | 区域里的 `do` 能用施放时的 `slot.level` 这些 | `XPHB:spell:匕首之云`、`XPHB:spell:冰风暴` |

完整的说明在 `spec.md`：先读「区域」那一节（搜 `while`、`moveZone`），再看上面的范例。

## 每条要做的

1. 读 `tasks/R0xx.md`。里面有原文、「这次为什么重做」（挑出这条的原因），还有**现在的数据**。
2. 在现在的数据上改，把**整条**写进 `answers/R0xx.json`，键和格式照旧。
   - 动作 id、效应名不要改，任务里「接口」一节列出来了，别的地方在按名字引用。
   - 用上新写法以后，把对应的 note 和 `text` 里「需人工处理」的话删掉或改掉。全部都能自动了，`automation` 就改成 `"full"`。
   - **不用改**的（只是顺带提到困难地形，或者现在的写法还做不到）写 `{ "skip": "不用改：一句原因" }`，现有数据会原样保留。
3. 检查：`npx tsx tools/factory/batch.ts lint datafy/redo-zones R0xx`。✗ 的照着问题改，最多改 4 轮。

按 `batches.json` 一批一批做：同一批是同一类（XPHB 法术、其他书的法术、特性、物品）。

## 注意

- **宁可不改，也不要改错**。拿不准原文意思的，保持原样并写 skip。
- 区域是**施法时选的那片格子**。不跟着施法者走的光环（以施法者为中心、跟着动的）不是区域，那种继续用 `aura`。
- 引擎**还不管**的：视线、遮蔽、光照、墙挡路、区域的高度、移动距离上限。这些照旧写进 note / `text`。
- 只写 `answers/` 里的文件。觉得引擎还缺什么，记到 `datafy/notes.md`，写清楚是哪一条、缺什么。

## 收尾

全部做完后跑：

```bash
npx tsx tools/factory/batch.ts collect datafy/redo-zones
```

它会再检查一遍，再在一场模拟战斗里试算。通过的写回条目原来所在的 AI 文件（`data/dyn/ai/spells.json`、`books.json`、`features.json`、`items.json`）。没过的列在 `failures.json` 里，照着改完再 collect。最后跑 `npm run check:data` 和 `npm test`。
