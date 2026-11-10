# 重做：瞬发 / 远程法术那几个专用标志换成了 `actionMods`

引擎里效应的 `flags.quicken`、`flags.rangeMult`、`flags.touchRange` **已经删掉**，换成效应上通用的 `actionMods`（改持有者某一类动作的激活方式 / 射程）。
旧写法现在过不了检查（lint 会直接说该怎么换），引擎也不再认。

## 怎么换

| 旧写法（效应的 `flags` 里） | 新写法（效应上，和 `flags` 同级） |
|---|---|
| `"quicken": true` | `"actionMods": [{ "on": { "tag": "spell", "activation": "action" }, "activation": "bonus", "once": true }]` |
| `"rangeMult": 2, "touchRange": 30` | `"actionMods": [{ "on": { "tag": "spell" }, "rangeMult": 2, "touchRange": 30 }]` |

- `on`：管哪些动作。`tag` = 动作带这个标签（`spell` / `weapon` / `item`），`activation` = 原本是这种激活方式的。不写 `on` = 所有动作。
- `activation`：改成这种激活方式。`once: true` = 用上一次这个效应就结束（旧的 `quicken` 一直是这样）。
- `rangeMult` / `touchRange`：射程乘几 / 触碰改成几尺。效应自己写 `endsOn` 决定什么时候散。
- 手写范例：`data/dyn/features.json` 的 `XPHB:瞬发法术`、`XPHB:远程法术`。完整说明在说明书里搜 `actionMods`。

## 受影响的数据

### 1. 正在用的数据（已经机械地换成等价的新写法，行为和以前一样；**内容还要人看一遍**）

| 键 | 文件 | 要看什么 |
|---|---|---|
| `TCE:牧师:律法化身:6` | `data/dyn/ai/books.json` | 原文只管**惑控学派**、而且是**花 1 环以上法术位**施展的法术，现在的数据对所有法术都生效（旧写法就是这样，不是这次改坏的）。`on` 目前筛不了学派和环阶 —— 要么改成 `automation: "partial"` 并在 `text` 里说明要人把关，要么提出来让引擎给 `on` 加学派 / 环阶 |

### 2. 外包答案的存档（没动；再收集一次会把旧写法带回来，lint 会拦住）

| 文件 | 键 | 用了什么 |
|---|---|---|
| `datafy/batch-w1-features/answers/F235.json` | `XPHB:圣武士:上古斗士:20` | `quicken` |
| `datafy/redo-instance/answers/R374.json` | `XPHB:圣武士:上古斗士:20` | `quicken` |
| `datafy/redo-instance/answers/R124.json` | `TCE:牧师:律法化身:6` | `quicken` |

上古斗士现在线上用的那份数据里没有这个标志，所以只有存档受影响。原文是「圣武士法术」改用附赠动作，同样筛不了「哪个职业的法术」。

### 3. 生成出来的范例和说明书（过期了，重新生成就行，不用手改）

`datafy/batch-w4-items`、`datafy/redo-instance`、`datafy/redo-zones` 的 `examples.json` 里还是旧的 `XPHB:瞬发法术` / `XPHB:远程法术`，各目录的 `spec.md` 也是旧的。要再用这些包之前跑：

```bash
npx tsx tools/factory/batch.ts refresh datafy/redo-instance
```

（另外两个目录同理。）

### 4. 线上资料库里的自制内容（仓库里看不到）

账户资料库存在服务器的 `library` 表里，`data` 列是 JSON 文本。在服务器的库上查：

```sql
SELECT owner_id, id FROM library WHERE data LIKE '%"quicken"%' OR data LIKE '%"rangeMult"%' OR data LIKE '%"touchRange"%';
```

查到的条目照上面的表换。没换之前这些条目的瞬发 / 远程效果不生效，下次在编辑器里保存时检查会提示。

## 换完怎么检查

```bash
npm run check:data
npm test
```
