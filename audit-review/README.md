# 覆盖率审查工作包（audit-review）

这个包是给**外部 agent** 的：逐条判断「引擎能不能把这条规则完全自动结算」，不能的话说清缺什么。

## 目录

| 文件 | 内容 |
|---|---|
| `interfaces.md` | **先读这个**：引擎现在能做什么（动作 / 节点 / 触发器 / 旗标 / 明确做不到的清单） |
| `tasks/index.json` | 总共多少条、分成多少批、每批包含哪些键 |
| `tasks/batch-NNN.json` | 每批 20 条：规则原文、现在的数据摘要、旧的审查意见（可能过时） |
| `answers/batch-NNN.json` | **你的产出**，和 tasks 同名 |
| `../tools/check-review.ts` | 自检脚本：`npx tsx tools/check-review.ts` 会校验格式 + 跑一遍数据检查 |

## 一条任务长什么样

```json
{
  "key": "XPHB:spell:某某术",
  "name": "某某术",
  "kind": "spell",
  "automation": "partial",
  "text": "规则原文（可能被截断到 900 字）",
  "data": { "automation": "partial", "actions": [...], "triggers": [...], "effects": [...], "resources": [...] },
  "old_audit": { "gap": "旧审查的归类", "need": "旧审查认为缺什么", "now": false }
}
```

`old_audit` **只是线索，可能过时**（引擎这几个月加了不少接口）。以 `interfaces.md` 和 `data` 为准。

## 你要产出什么（每批一个文件，同名）

```json
{
  "batch": "batch-001",
  "answers": [
    {
      "key": "XPHB:spell:某某术",
      "verdict": "full | partial | manual",
      "why": "一句话：这条规则的哪部分自动了、哪部分没有（引用原文片段）",
      "missing": ["缺少的接口名或能力（用 interfaces.md 里的说法）"],
      "patch": { "…可选：能改成什么样，直接给 data 里的条目 JSON…" }
    }
  ]
}
```

### verdict 怎么判

- **full**：原文里的数值、时机、限制全都能由现有接口自动完成；玩家只需要点一下动作、回答必要的选择。
- **partial**：有自动化，但还有一部分必须人来（写清是哪部分、以及为什么引擎做不了）。
- **manual**：现在只有说明文字，没有任何自动结算。

### 判断纪律

1. **只认原文**。不要按 2014 版或记忆里的规则写；`text` 就是这条的规则原文。
2. **能自动就别说做不到**。先在 `interfaces.md` 里找有没有对应的节点 / op / 旗标；
   找不到再考虑「能不能用别的写法绕」（比如用 `note` + `ask` 让 DM 确认，或拆成两个动作）。
3. `missing` 里不要写「引擎不支持」，要写**具体缺什么**，例如
   「缺少把目标移出战场并从先攻条隐藏的接口」「缺少改另一道正在施展法术的射程」。
4. 已经有数据但不是 full 的，优先判断：**能不能用现有接口把剩下的补上**。能就写 `verdict: "full"` + `patch`。
5. 同一条不要重复评论多遍；一批里每个 key 一条。

## 提示

- 一批 20 条，逐条看完再写，别抽样。
- `patch` 里的 JSON 只要包含你要改的字段就行（引擎是按字段合并的）。
- 拿不准的宁可写 `partial` + 说明，也不要谎报 `full`。
