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
3. 几个 worktree 同时开服务器要错开端口：界面 `npx vite --port 5281`、后端 `npx tsx server/main.ts --port 8790`。
   界面端口每 +1，它转发 /api 的后端端口也自动 +1（5281 → 8790、5282 → 8791），任何 shell 都一样写；要单独指定就用环境变量 `API_PORT`。
   Claude 的预览读 `.claude/launch.json`（没进 git，别提交），在 worktree 里自己建一份：
   ```json
   { "version": "0.0.1", "configurations": [
     { "name": "app", "runtimeExecutable": "npx", "runtimeArgs": ["vite", "--port", "5281"], "port": 5281 },
     { "name": "api", "runtimeExecutable": "npx", "runtimeArgs": ["tsx", "server/main.ts", "--port", "8790"], "port": 8790 } ] }
   ```
   后端改了代码要重启（没有热更新）；界面是 Vite 热更新。
4. 本地数据库（`data/server.db`，每个 worktree 各一份，开始是空的）：在界面上注册测试账号（只在本地库里）。
   测战役功能要两个号：一个建团当 DM，另一个用邀请码加入。
5. **不要从 worktree 部署。** 部署（`.deploy.env` 也不在 worktree 里）只在主检出、合并之后做。

## 目录

| 位置 | 内容 |
|---|---|
| `src/expr/` | 表达式语言（`pb + mod.str`、`(slot.level + 1)d8`、`dist(self, target) <= 5`），三值求值：判断不了就问人 |
| `src/sheet/` | 静态层：人物卡计算管线（`pipeline.ts` 十个阶段）、能力数据框架（`abilities.ts`）、资源、专长、选择池、数据源（`source.ts`、`store.ts`）、规则环境 `SheetEnv`（`env.ts`） |
| `src/combat/` | 战斗引擎：`types.ts`（数据形状）、`session.ts`（命令 → 事务 → 事件，撤销 / 事后裁定 / 重放）、`exec.ts`（效果树）、`d20.ts` / `damage.ts`（检定、伤害管线）、`triggers.ts`、`effects.ts`、`turns.ts`、`space.ts`（地图移动、区域）、`rulebook.ts`（规则书 + 房规层）、`audit.ts`（数据审计） |
| `src/bridge/` | 人物卡 → 战斗参与者（`from-sheet.ts`），战斗结果写回卡；怪物数据块 → 参与者（`from-monster.ts`、`from-text-monster.ts`）；规则数据文件清单（`rule-files.ts`） |
| `src/factory/` | 数据化工厂：说明书（`spec.ts`，从代码生成）、拼任务（`build.ts`）、检查（`lint.ts`）、试算（`smoke.ts`）、AI 循环（`ai.ts`）。浏览器和 Node 共用 |
| `src/library/` | 账户资料库（[LIBRARY.md](LIBRARY.md)）：条目形状 `types.ts`、结构检查 `check.ts`、条目 → 卡面 / 战斗两层规则 `rules.ts`。浏览器和服务器共用 |
| `app/` | 界面（React + Vite，无路由库，页面状态在 `app/lib/store.ts`）。`lib/` 是状态和接口，`pages/` 是页面，`pages/combat/` 是战斗页的各块，`components/ui.tsx` 是基础组件（Dialog、Field、Tag、Panel、NumInput） |
| `server/` | 后端（Node 原生 http + `node:sqlite`，无框架）：`main.ts` 账户、卡同步、战役；`encounters.ts` 服务器跑遭遇（SSE 推送）；`library.ts` 账户资料库（条目归账户、挂到战役、DM 开关）；`hub.ts` 战役启用的书、全服怪物 AI 结果 |
| `data/rules-2024.json` | 状态、通用动作、武器精通、核心参数（手写） |
| `data/dyn/*.json` | 手写的动态层数据（法术、特性）；`data/dyn/ai/*.json` 是 AI 写的（标 `ai`、未审），同键时手写的盖过 AI 的 |
| `data/abilities-*.json` | 静态层能力数据（人物卡怎么加值、授予、选择、资源池） |
| `datafy/` | 外包数据化的工作包（任务、答案、收集记录）。说明在 `datafy/README.md` |
| `tools/` | 部署、抓数据、数据审计、出题工具（`tools/factory/batch.ts`）、原项目对照（`tools/oracle/`） |
| `tests/` | `expr`、`combat`（黄金场景、房规、区域…）、`sheet`（快照对比、战役）、`bridge`（集成、物品、怪物）、`factory` |

设计文档（要改核心机制时再读）：
[COMBAT-DESIGN.md](COMBAT-DESIGN.md)（战斗引擎，§十六是实现时的修订）、
[SERVER-DESIGN.md](SERVER-DESIGN.md)（账户、战役、服务器遭遇）、
[LIBRARY.md](LIBRARY.md)（账户资料库 + 数据面板 + AI 双写 + 全 5etools 搜索，取代 DATA-HUB.md 第一～三节）、
[DATA-HUB.md](DATA-HUB.md)（战役资料库、AI 工具的历史设计）、
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

## 常见改动从哪下手

照着已有的同类改动写最稳：`git log --stat` 找一个相近的提交看它动了哪些文件。

- **人物卡上加显示 / 加一项计算**：算在 `src/sheet/pipeline.ts`（按阶段：属性 → 调整值 → … → 汇总，用 `ctx.addEffect` / `ctx.pluck` 传值，`ctx.set` 出结果），
  显示在 `app/pages/SheetView.tsx`（卡面）/ `SheetItems.tsx`（物品）/ `SheetData.tsx`（数据页）。结果变了要更新快照。
  要进战斗的，`src/bridge/from-sheet.ts` 的 `viewFromSheet` 把它带进参与者。
- **战斗界面的小改动**：战斗页是 `app/pages/Combat.tsx` 拼起来的，各块在 `app/pages/combat/`：
  `Hotbar.tsx`（底部动作栏）、`Actor.tsx`（详情抽屉：动作、资源、手动调整）、`MapView.tsx` / `TokenMenu.tsx`（地图、棋子菜单）、
  `Log.tsx`（日志）、`Dialogs.tsx`（决定弹窗）、`Initiative.tsx`、`Roster.tsx`、`Bestiary.tsx`（加怪物）。
  界面状态和发命令在 `app/lib/combat.ts`（`combat.dispatch(命令)`）。日志的每一行怎么写在 `app/lib/events.ts` 的 `describe`。
- **新的战斗命令**（比如短休）：`src/combat/types.ts` 的 `Command` 加一种 → `src/combat/session.ts` 的 `switch (cmd.type)` 里处理（在事务里 `tx.emit` 事件）→
  事件怎么改状态写在 `src/combat/reducer.ts` → 日志文字在 `app/lib/events.ts`。玩家也能发的命令要加进 `server/encounters.ts` 的 `PLAYER_CMDS`。
  战斗结果要写回人物卡的，改 `from-sheet.ts` 的 `syncLiveToChar`。
- **数据里的新写法**（新的效果节点、新的 modify 操作）：`types.ts` 加形状 → `exec.ts`（节点）或 `triggers.ts` / `d20.ts` / `damage.ts`（窗口里的操作）实现 →
  `src/factory/lint.ts` 的 `NODE_KEYS` / `MODIFY_KEYS` 加上字段 → `src/combat/audit.ts` 审计要认得 → 说明书 `src/factory/spec.ts` 补一句约定（类型部分是从 types.ts 自动生成的）→ `tests/combat/` 写黄金场景。
- **改某条能力、法术的战斗数据**：手写的在 `data/dyn/features.json`、`data/dyn/spells.json`、`data/rules-2024.json`；改完 `npm run check:data`。
  AI 写的在 `data/dyn/ai/`（同键时手写的盖过它，所以「修 AI 的错」= 在手写文件里写一份同键的）。
- **后端接口**：`server/main.ts`（账户、卡、战役）、`server/encounters.ts`（遭遇）、`server/library.ts`（账户资料库）、`server/hub.ts`（启用的书、怪物 AI）。路由就是 `if (method === … && path …)`，
  library / encounters / hub 用 `d.send` / `d.fail` / `d.bodyOf`，main.ts 里直接用 `send` / `bodyOf` / `HttpError`。表在各自的 `CREATE TABLE IF NOT EXISTS` 里；现在还没有迁移机制，给已有的表加列要自己写 `ALTER TABLE`（先查列在不在），线上库是有数据的。
  界面调用走 `app/lib/api.ts` 的 `api(方法, 路径, 内容)`。
- **AI 工具**：浏览器侧 `app/lib/ai.ts`，对话框 `app/components/AiDatafy.tsx`，共享逻辑 `src/factory/ai.ts`。
  没有真密钥时，起一个本地假接口（返回 `{ choices: [{ message: { content: '…' } }] }`、带跨域头）把接口地址填成它，就能走完整个流程。

## 怎么验证

- `npm run typecheck && npm test`；动了规则数据再加 `npm run check:data`。
- 界面改动：起 app + api，登录本地测试账号实际点一遍。战斗相关的，本地遭遇（不用登录）就能测大部分；
  多人同步、DM / 玩家权限要用战役遭遇（两个账号，两个浏览器窗口或一个无痕窗口）。
- 改了引擎：本地遭遇和战役遭遇都试一下（战役遭遇是服务器跑的，后端要重启才用上新代码）。

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
- 做完、验证过的改动**默认直接提交并部署**（主检出 `main` 上 `npm run deploy`），不用再问。worktree 里只提交到自己的分支，不部署。
  会删线上数据、改表结构这类破坏性的改动，部署前先跟用户说清楚。推送（git push）仍然要用户要求。
- 主线是 `main`。worktree 从 `main` 拉分支，做完合并回 `main`（合并前先把 `main` 的新提交合进来，跑一遍测试）。
- 做完 BACKLOG 里的一条就把它删掉，发现新问题就加一条（写清楚「在哪」）。几个 worktree 都改 BACKLOG 时合并会冲突：两边的增删都保留。

## 安全

- 网站的 HTTP 基本认证、`.deploy.env`、SSH 密钥：**不要写进任何文件或提交**。
- 本地测试账号只存在本地数据库里。
- AI 工具的密钥只在用户浏览器里（localStorage），不要往服务器发、不要写进代码。
