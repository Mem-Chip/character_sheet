# AI 数据化：多轮查资料（计划书）

现在的 AI 数据化（`src/factory/ai.ts` 的 `datafy`）是**一次塞满**：说明书 + 全部例子 + 任务一起发出去，模型直接出 JSON，
检查没过再把问题回给它改（最多两次）。

## 为什么要改

- **太大**：一次请求约 15 万字。说明书 5.2 万字（其中 2.「类型定义」就是整份 `types.ts`，3 万字），例子是 `GOLDEN_FILES` 的全部 139 条（9.6 万字）。
  模型要在这么多东西里自己找到相关的那几段，找不到就编或者写「请手动处理」。
- **错法**：牧人结社那次（见提交 428a73d 的说明）大部分错误不是接口不够，是**现成写法它没找到**：
  `summoned` 窗口会用，却没想到挂效应；子职法术表的写法在 7.2 节，它没看。
- 接口还会继续长，说明书只会越来越长。

## 思路

给模型几个「查资料」的工具。模型先读一份**短的总览**，需要时按名字或关键词查细节；写完先自己跑检查，再交卷。

**不依赖接口的函数调用（tool calling）。** 用户自带的接口五花八门，本地模型、部分中转站不支持 `tools`。
所以用**文字协议**：模型的回复要么是答卷，要么是一个查询请求：

```json
{ "lookup": [ { "tool": "node", "q": "zone" }, { "tool": "example", "q": "summon" } ] }
```

我们查完，把结果作为下一条 user 消息发回去，它接着写。`response_format: json_object` 照样能用。
以后要接原生 tool calling，只是在 `makeChat` 里多一种传法，查询函数本身不变。

## 工具（都是纯函数，浏览器和 Node 共用，放 `src/factory/lookup.ts`）

| tool | q 是什么 | 返回 |
|---|---|---|
| `spec` | 关键词（「召唤」「光环」「借机攻击」）或章节号（`5.23`、`7.2`） | 说明书里命中的段落（按标题 / 约定条目切块，按命中多少排，最多 3 块） |
| `node` | 效果节点的 kind（`zone`、`summon`、`chooseTargets`） | `types.ts` 里那一种的定义，连同上面的注释 |
| `type` | 类型名或 modify 的 op（`Trigger`、`Duration`、`TargetPick`、`adv`） | 同上 |
| `window` | 窗口事件名（`summoned`、`effectApplied`） | 窗口表那一行：发起者 / 承受者、能读的东西、能用的 modify |
| `expr` | 作用域（`trigger`、`node`…）或函数名 / 字段名（`inZone`、`summoner`） | 能用的名字和函数签名（`scopeDef`、`REF_SHAPE`） |
| `example` | 节点 kind、窗口名、键、或中文词（`summon`、`turnEnded`、`精魂`） | 手写条目里**用到它的**几条（键 + 精简后的 JSON），最多 3 条、每条限长 |
| `check` | 一份草稿（`draft` 字段放 JSON） | 跑一遍现有的检查（`checkEntry` / `checkParts`：lint、审计、试算），返回问题列表 |

限额：每轮最多 6 个查询，每个结果截到 4000 字左右；查询轮数单独计数（缺省最多 6 轮），和「检查没过让它改」的轮数分开算。
超了就告诉它「不能再查了，直接交卷」。

## 分几步做

1. **查询函数 + 测试**（`src/factory/lookup.ts`、`tests/factory/lookup.test.ts`）。
   - 说明书切块：按 `##` / `###` 标题，第 5 节的约定按编号（`1.` … `29.`）各算一块。
   - `types.ts` 切块：按 `| { kind: '…'` 的联合成员、按 `export interface / type`，各连同它前面的 `/** */` 注释。
   - 例子索引：遍历条目 JSON，收集它用到的 `kind`、`on`、`op`、键里的中文词。
   - `runLookup(req, ctx)`：分发、限额、把结果拼成一段文字。`check` 要调用方给（ctx 里传检查函数），这样不依赖浏览器。
2. **短总览**：`buildSpec` 加 `mode` 选项 `brief`（或单独 `buildBrief`）。保留 1.「产出什么」、约定的**标题列表**（每条一句话）、
   所有节点 kind 和窗口名的**名字清单**、查询协议怎么用。目标一万字以内。例子只给 3～5 条最典型的（狂暴、偷袭、火球术、一个召唤、一个区域）。
3. **协议进 `datafy`**：回复先 `parseAnswer`，是 `{ lookup: [...] }` 就查、回结果、继续；是答卷就走原来的检查循环。
   `onStep` 报「查了 node: zone、example: summon…」，界面上能看到它在查什么。
   答卷里混了 `lookup` 字段的当答卷处理（忽略 lookup）。
4. **界面**：`app/components/AiDatafy.tsx` 的进度里显示查询；AI 设置里加一个开关「让 AI 按需查资料（推荐；关掉 = 老办法，一次给全）」，缺省开。
   老办法保留：小模型可能不会用协议，一直在查不交卷。连续两轮查询都没有新东西（查的全是查过的）就提示它交卷。
5. **对比考试**：`tools/factory/` 里现成的出题、打分（`exam.ts`）拿来跑同一批题，新旧两种各跑一遍，比通过率、`ask` / 「手动处理」的数量、花的 token。
   题目里放牧人结社这种召唤物 + 光环的、一个带区域的法术、一个反应类专长。
6. （以后）原生 tool calling：`makeChat` 发现接口支持就用 `tools` 传，不支持就退回文字协议。

## 要注意的

- 说明书里有不少地方写「见第 N 节」「照例子」，切成短总览后这些引用要改成「查 `spec` N」。
- `types.ts` 的注释是给人看的，也有给 AI 看的约定；切块时注释必须跟着它的成员走，否则查出来没上下文。
- 查询结果是我们自己的数据，不含用户输入，不用担心注入；但 `example` 也会搜到 AI 写的条目（`data/dyn/ai/`）—— **只搜手写的**，免得错的写法被当成范例。
- 每一轮都要把之前的对话全带上，轮数多了反而可能比一次塞满还贵。考试时要量总 token，不只看通过率。

## 现在做到哪了

- [x] 1. 查询函数 + 测试（`src/factory/lookup.ts`：`createLookup({ spec, typesSource, entries })` → `run(请求数组, { check })` / `one(请求)`；`isLookupReq`。
  说明书第 4 节按加粗段落切成 `4.1`…，第 5 节按编号切成 `5.1`…；关键词搜索跳过第 2 节（整份 types.ts）。`tests/factory/lookup.test.ts`）
- [x] 2. 短总览（`src/factory/spec.ts` 的 `buildBrief`：两种模式 7～8 千字，全文是 5.2 万字）。
  节点 kind / 修改 op 从 types.ts 的联合成员里取，窗口名从 `WINDOWS` 取；第 5 节 32 条、第 6 节 10 条各压成一句（`CONVENTIONS` / `PITFALLS`），
  编号必须和全文一一对上 —— `tests/factory/brief.test.ts` 拿全文的编号逐条比对，加了一条忘了写速览会挂。
  例子里只附 5 条最典型的（狂暴、偷袭、火球术、野兽召唤术、匕首之云），其余现查。
- [x] 3. 协议进 `datafy`（`src/factory/ai.ts`）：`DatafyInput.lookup`（给 `createLookup` 的产物，只用 `run`）→
  回复是 `{ "lookup": [...] }` 就先查、把结果作为下一条 user 消息发回去；答卷照旧走检查 / 改稿循环。
  **查询轮（缺省 6）和改稿轮（缺省 2）分开计数**；连续两轮查的全是查过的就催它交卷；轮数用完之后还查就当答卷处理（带一句「这是查询请求，不是答卷」）。
  答卷里混了 `lookup` 字段的是答卷（`isLookupReq` 只认单个键）。`tests/factory/datafy-lookup.test.ts`）
- [x] 4. 界面（`app/components/AiDatafy.tsx`）：AI 设置里一个「让 AI 按需查资料（推荐）」开关，缺省开（`AiSettings.lookup`）；
  关掉就是老办法。对话框的 `mode`（`combat` / `both`）代替原来的 `spec` + `examples` 属性；
  自己给说明书（整理自制书那种）时不走查询。进度里显示「查资料（第 N 轮）：node zone、example summon」。
  `app/lib/ai.ts` 的 `aiBrief` / `aiBriefExamples` / `aiLookup` 是浏览器侧的那一份，`tests/app/ai-lookup.test.ts` 查它接的数据源对不对。
- [x] 5. 对比考试（`tools/factory/exam-run.ts`）：同一张卷子跑两遍，`--mode brief` 用速览 + 查询、`--mode full` 用出卷时的整份说明书和例子；
  答案分别写进 `answers-brief/` / `answers-full/`，`exam.ts grade <卷> <答案目录>` 能指定阅卷目录。
  接口用 `OPENAI_BASE_URL` / `OPENAI_API_KEY` / `OPENAI_MODEL`。**只拿假接口验证过流程**（一题：brief 发了 3.4 万字、full 发了 57.3 万字），
  真实的通过率对比要填密钥自己跑。
- [ ] 6. 以后：原生 tool calling（`makeChat` 发现接口支持就用 `tools` 传，查询函数不变）。

