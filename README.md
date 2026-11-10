# dnd2024-engine

D&D 2024 网页工具：人物卡、战斗引擎、战役（多人在线遭遇 + VTT 地图 + 战役资料库）、AI 数据化。线上 dnd.memchip.cc。

- 静态规则逻辑（人物卡计算）移植自 `dsh-p/dnd/dnd2024-sheet`（只移植逻辑，界面重写），见 [PORTING.md](PORTING.md)。
- 动态规则层（战斗中按时机生效的规则）是新写的，设计见 [COMBAT-DESIGN.md](COMBAT-DESIGN.md)。
- 账户、战役、服务器跑遭遇见 [SERVER-DESIGN.md](SERVER-DESIGN.md)；战役资料库和自带密钥的 AI 工具见 [DATA-HUB.md](DATA-HUB.md)。
- 数据化工厂（把规则原文写成引擎数据）见 [FACTORY.md](FACTORY.md) 和 [datafy/README.md](datafy/README.md)。
- **来干活的先读 [CLAUDE.md](CLAUDE.md)**（目录、概念、习惯、worktree 怎么配），待办在 [BACKLOG.md](BACKLOG.md)。

## 功能一览

| 部分 | 有什么 |
|---|---|
| 卡片库 | 本机卡 + 登录后同步到服务器；导入导出 |
| 人物卡 | 卡面（悬停看原文）、建卡 / 编辑、升级、物品（钱包、同调、负重、魔法物品加值、消耗品）、「数据」页（每项能力背后的数据、家规覆盖、从规则库添加） |
| 战斗 | 本地遭遇或战役遭遇；先攻、动作栏、目标、自动结算（攻击、豁免、伤害、效应、触发器、反应）、决定弹窗、日志与回执、撤销、DM 事后裁定、3D 骰子；地图（格子、底图、画笔、棋子、范围预览、区域、借机攻击、推拉）；加怪物（图鉴 / 贴文本） |
| 战役 | 建团、邀请码、带卡进团、DM 写回队伍的卡；服务器跑遭遇（SSE 同步，玩家只能动自己的）；资料：启用 5etools 上的书、本团内容（家规 / 补数据） |
| AI | 自带密钥（OpenAI 兼容，密钥只在浏览器）：本团内容、没自动化的能力、怪物特性的单条数据化；贴文本整理怪物数据块 |

## 命令

```bash
npm run dev          # 界面：http://localhost:5280（/api 转给后端）
npm run server       # 后端（账户、卡同步、战役、战役遭遇、资料库），127.0.0.1:8789，数据库 data/server.db
npm test             # 全部测试
npm run typecheck    # 类型检查
npm run check:data   # 规则数据审计（表达式编译、模板引用、事件名、双计）
npm run snapshots    # 人物卡计算结果有意改变后，重新生成快照
npm run fetch:data   # 抓 5etools 数据到 data/5etools/（静态层测试要用；界面没有本地数据时直接从站点取）
npm run deploy       # 测试 + 构建 + 部署前后端（配置在 .deploy.env，见 .deploy.env.example）
npm run build:server # 后端打包成 dist-server/main.js；服务器上第一次先跑 bash tools/setup-server.sh
npm run oracle       # 用原项目重新生成对比夹具（需要原项目在 ../dsh-p/dnd/dnd2024-sheet）
npx tsx tools/factory/batch.ts plan|lint|collect …   # 出题 / 检查答案 / 收集（外包数据化）
```

## 目录

| 目录 | 内容 |
|---|---|
| `src/expr/` | 表达式语言：`pb + mod.str`、`(5 + slot.level)d6`、`dist(attacker, self) <= 5`；三值求值（不知道就问） |
| `src/sheet/` | 静态层：规则管线、能力框架、角色解析与计算、资源、专长、选择池、战役资料（启用的书、本团家规） |
| `src/combat/` | 战斗引擎：效应、D20 / 伤害管线、触发器、效果树、回合、地图移动与区域、会话（事务 / 撤销 / 事后裁定）、房规层、审计 |
| `src/bridge/` | 人物卡 → 战斗参与者、战斗结果写回人物卡；怪物数据块 → 参与者；规则数据文件清单 |
| `src/factory/` | 数据化工厂：说明书、拼任务、检查、试算、AI 循环（浏览器和 Node 共用） |
| `app/` | 界面（React + Vite）：`lib/` 状态与接口，`pages/` 页面（`combat/` 是战斗页的各块），`components/` 公用组件 |
| `server/` | 后端（Node + node:sqlite，无框架）：账户与卡同步、战役、服务器遭遇、战役资料库 |
| `data/rules-2024.json` | 15 个状态、通用动作、武器精通、核心参数 |
| `data/dyn/` | 动态层数据：手写的（`features.json`、`spells.json`）和 AI 写的（`ai/`，未审） |
| `data/abilities-*.json` | 静态层的能力数据 |
| `datafy/` | 外包数据化的工作包与收集记录 |
| `tests/` | 表达式、黄金场景、房规与审计、区域、人物卡快照、战役、集成、物品、怪物、AI 循环 |
| `tools/` | 部署、抓数据、数据审计、出题工具、原项目对照 |

## 用法速览（引擎）

```ts
import { RuleBook, Session, createEncounter, engineDice, makeCombatant, makeView } from './src/combat';

const rules = new RuleBook([rulesJson, spellsJson, featuresJson], /* 房规层 */ []);
const s = new Session(createEncounter(), { rules, diceFor: () => engineDice() });

s.dispatch({ type: 'addCombatant', combatant: makeCombatant({ id: 'w', kind: 'pc', view: makeView({ name: '法师', /* … */ }) }) });
const r = s.dispatch({ type: 'useAction', actor: 'w', action: 'XPHB:spell:火球术#cast', targets: ['g1', 'g2'], slotLevel: 3 });
if (r.status === 'pending') s.decide(/* 回答 r.decision */);
s.undo();                                                   // 撤销
s.override(txIndex, { roll: 0, outcome: 'success' });       // DM 事后改结果
```
