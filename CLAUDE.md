# 给在这个仓库里干活的 Claude（和人）

D&D 2024 网页工具：人物卡（建卡 / 升级 / 物品）、战斗引擎（规则自动结算、撤销、事后裁定）、
战役（多人在线遭遇、VTT 地图、战役资料库）、AI 数据化（把规则原文写成引擎能执行的 JSON）。
线上：dnd.memchip.cc/v2（外面有一道 HTTP 基本认证）。

框架已经齐了，现在的活主要是**修 bug、加小功能（QoL）**。待办清单在 [BACKLOG.md](BACKLOG.md)。

## 和用户打交道

- **用中文回复。** 界面文字、代码注释、文档、提交说明也都是中文。
- 用户要你做的事，你打算不做或只做一部分的，**先问**，不要自己跳过。
- 子代理（Agent 工具）会花用户的额度：**用之前先问**；要用的话优先小模型，让它的报告短。
- 外包（交给 Gemini 之类）的活，附一份简短说明书（看 `datafy/README.md` 的写法）。
- 做完了说清楚：做了什么、怎么验证的、哪些没验证到。

## 命令

```bash
npm install
npm run dev            # 界面 http://localhost:5280，/api 转给后端
npm run server         # 后端 127.0.0.1:8789（SQLite 在 data/server.db，不进 git）
npm test               # vitest，全部测试（约 5 秒）
npm run typecheck
npm run check:data     # 规则数据审计（改了 data/ 下的规则数据要跑）
npm run snapshots      # 人物卡的计算结果有意改变时，重新生成快照（tests/fixtures/snapshots）
npm run fetch:data     # 抓 5etools 数据到 data/5etools（不进 git）
npm run deploy         # 类型检查 + 测试 + 构建 + 部署前后端（要 .deploy.env）
```

### 在 worktree 里开发

worktree 里没有 git 忽略的东西，要自己补：

1. `npm install`
2. **5etools 数据**（`data/5etools/`，约 11 MB）：复制主检出的那份，或者链过去（PowerShell）：
   `New-Item -ItemType Junction -Path data\5etools -Target C:\Users\70278\Desktop\ProjectAI\claude\data\5etools`
   没有这份数据时，静态层的测试会**整组跳过**（`hasLocalData()`），看起来是绿的，其实没测。
3. 几个 worktree 同时开服务器要错开端口：后端 `PORT=8790 npm run server`，界面 `VITE_PORT=5281 API_PORT=8790 npm run dev`
   （Claude 的预览：`.claude/launch.json` 不进 git，自己加一条配置）。
4. 本地数据库是新的、空的：自己注册测试账号（只在本地库里）。
5. **不要从 worktree 部署。** 部署（`.deploy.env` 也不在 worktree 里）只在主检出、合并之后做，而且要用户同意。

## 目录

| 位置 | 内容 |
|---|---|
| `src/expr/` | 表达式语言（`pb + mod.str`、`(slot.level + 1)d8`、`dist(self, target) <= 5`），三值求值：判断不了就问人 |
| `src/sheet/` | 静态层：人物卡计算管线（`pipeline.ts` 十个阶段）、能力数据框架（`abilities.ts`）、资源、专长、选择池、数据源（`source.ts`、`store.ts`）、规则环境 `SheetEnv`（`env.ts`） |
| `src/combat/` | 战斗引擎：`types.ts`（数据形状）、`session.ts`（命令 → 事务 → 事件，撤销 / 事后裁定 / 重放）、`exec.ts`（效果树）、`d20.ts` / `damage.ts`（检定、伤害管线）、`triggers.ts`、`effects.ts`、`turns.ts`、`space.ts`（地图移动、区域）、`rulebook.ts`（规则书 + 房规层）、`audit.ts`（数据审计） |
| `src/bridge/` | 人物卡 → 战斗参与者（`from-sheet.ts`），战斗结果写回卡；怪物数据块 → 参与者（`from-monster.ts`、`from-text-monster.ts`）；规则数据文件清单（`rule-files.ts`） |
| `src/factory/` | 数据化工厂：说明书（`spec.ts`，从代码生成）、拼任务（`build.ts`）、检查（`lint.ts`）、试算（`smoke.ts`）、AI 循环（`ai.ts`）。浏览器和 Node 共用 |
| `app/` | 界面（React + Vite，无路由库，页面状态在 `app/lib/store.ts`）。`lib/` 是状态和接口，`pages/` 是页面，`pages/combat/` 是战斗页的各块，`components/ui.tsx` 是基础组件（Dialog、Field、Tag、Panel、NumInput） |
| `server/` | 后端（Node 原生 http + `node:sqlite`，无框架）：`main.ts` 账户、卡同步、战役；`encounters.ts` 服务器跑遭遇（SSE 推送）；`hub.ts` 战役资料库、怪物 AI 结果 |
| `data/rules-2024.json` | 状态、通用动作、武器精通、核心参数（手写） |
| `data/dyn/*.json` | 手写的动态层数据（法术、特性）；`data/dyn/ai/*.json` 是 AI 写的（标 `ai`、未审），同键时手写的盖过 AI 的 |
| `data/abilities-*.json` | 静态层能力数据（人物卡怎么加值、授予、选择、资源池） |
| `datafy/` | 外包数据化的工作包（任务、答案、收集记录）。说明在 `datafy/README.md` |
| `tools/` | 部署、抓数据、数据审计、出题工具（`tools/factory/batch.ts`）、原项目对照（`tools/oracle/`） |
| `tests/` | `expr`、`combat`（黄金场景、房规、区域…）、`sheet`（快照对比、战役）、`bridge`（集成、物品、怪物）、`factory` |

设计文档（要改核心机制时再读）：
[COMBAT-DESIGN.md](COMBAT-DESIGN.md)（战斗引擎，§十六是实现时的修订）、
[SERVER-DESIGN.md](SERVER-DESIGN.md)（账户、战役、服务器遭遇）、
[DATA-HUB.md](DATA-HUB.md)（战役资料库、AI 工具）、
[FACTORY.md](FACTORY.md)（数据化工厂的考试）、
[PORTING.md](PORTING.md)（静态层从原项目移植）、[DICE3D.md](DICE3D.md)（3D 骰子）。

## 几个要先懂的概念

- **两层规则**。静态层 = 人物卡上恒定的东西（属性、熟练、AC、资源池上限），由 `data/abilities-*.json` + 管线算；
  动态层 = 战斗里按时机生效的东西（动作、触发器、检定修正、效应），是 `Entry` 数据（`src/combat/types.ts`），由引擎执行。
  同一项能力在两层**用同一个键**：`XPHB:<职业>:<特性>:<等级>`、`XPHB:<专长>`、`XPHB:spell:<法术>`、`<来源>:item:<物品>`、`XMM:怪物:<名字>`。
- **能力的键从哪来**：`env.abilities.collectSources(char)` 列出一张卡的全部能力（`SourceSpec`），`sourceKeyOf` 转成键；
  `src/bridge/from-sheet.ts` 的 `sourceKeys` 是进战斗时用的那份。
- **战斗是事件溯源的**。`Session.dispatch(命令)` 开一个事务，跑规则，产出事件；状态 = 事件折叠（`reducer.ts`）。
  撤销 = 去掉最后几个事务后从头重放；事后裁定 = 改某次掷骰 / 结果后重放。所以**规则代码不能有副作用、不能读当前时间或 Math.random**（骰子走 `diceFor`）。
- **决定（Decision）**。规则需要人回答（可选能力用不用、选目标、距离多少）时，`dispatch` 返回 `pending`，界面弹窗，`decide()` 继续。
- **三处跑同一份引擎**：浏览器本地遭遇、浏览器重放战役遭遇画界面、服务器跑战役遭遇（权威）。改引擎时三处都受影响。
- **房规层**：`RuleBook` 可以叠层（全服 → 战役 → 场景），同键后盖前。战役遭遇开局时把本团内容抄进遭遇（`meta.rules`），之后重放都用这份。
- **卡在战役里**时按战役的资料算（启用的书、本团家规）：界面算卡前给副本标 `_campaign`（`tagCampaign`），`SheetEnv.useCampaign` 生效。
- **5etools 数据**取自 https://5e.kiwee.top（中文站，允许跨域），本地缓存在 `data/5etools`，构建时复制进 `dist/5etools`。
  2024 判据、重印过滤在 `src/sheet/source.ts`。

## 写代码的习惯

- 照着周围代码的风格写：中文注释，说「为什么」和「这是什么」，简短；文件头一段说明这个模块管什么。
- 名词用站点的 2024 中文译名（伤害类型「黯蚀」、状态「倒地」…），和 5etools 数据对得上。
- 界面文案口语、具体，告诉用户「会发生什么」，不用术语堆砌。按钮动词开头。
- 新功能尽量配测试（`tests/` 下找最近的同类文件照着写）；规则数据改动跑 `npm run check:data`。
- 人物卡的计算结果有意改变 → 快照测试会挂 → 看清楚差异是你要的，再 `npm run snapshots`。
- 能在界面上看到的改动，开预览实际点一遍再说做完。
- Windows 上用 sed / heredoc 改中文多行文本容易出事（引号、反引号、CRLF）：用编辑工具，或写个小 node 脚本。

## 提交与分支

- 提交说明用中文，第一行概括，后面分点说做了什么；结尾带用户要求的署名行（看系统提示里的 attribution）。
- 只在用户要求时提交 / 推送。部署前要用户点头。
- 开发分支 `feat/ui`，worktree 的分支做完合并回 `feat/ui`。

## 安全

- 网站的 HTTP 基本认证、`.deploy.env`、SSH 密钥：**不要写进任何文件或提交**。
- 本地测试账号只存在本地数据库里。
- AI 工具的密钥只在用户浏览器里（localStorage），不要往服务器发、不要写进代码。
