# dnd2024-engine

D&D 2024 人物卡 + 战斗引擎。静态规则逻辑移植自 `dsh-p/dnd/dnd2024-sheet`（只移植逻辑，界面重写）；
动态规则层（战斗中按时机生效的规则）是新写的，设计见 [COMBAT-DESIGN.md](COMBAT-DESIGN.md)。

## 命令

```bash
npm run dev          # 界面：http://localhost:5280（卡片库 / 人物卡 / 战斗）
npm run deploy       # 测试 + 构建 + 部署到服务器（配置在 .deploy.env，见 .deploy.env.example）；顺带更新后端
npm run server       # 后端（账户、卡同步、战役、战役遭遇），开发时 vite 把 /api 转给它
npm run build:server # 后端打包成 dist-server/main.js（部署用）；服务器上第一次先跑 bash tools/setup-server.sh
npm run fetch:data   # 先抓 5etools 数据到 data/5etools/（静态层测试要用；界面没有本地数据时直接从站点取）
npm test             # 全部测试
npm run typecheck    # 类型检查
npm run check:data   # 规则数据审计（表达式编译、模板引用、事件名、双计）
npm run oracle       # 用原项目重新生成对比夹具（需要原项目在 ../dsh-p/dnd/dnd2024-sheet）
npm run oracle:fuzz  # 随机角色与原项目对比
```

静态层的移植方法与差异记录见 [PORTING.md](PORTING.md)；上线（账户、战役、多人同步）的讨论稿见 [SERVER-DESIGN.md](SERVER-DESIGN.md)。

## 目录

| 目录 | 内容 |
|---|---|
| `src/expr/` | 表达式语言：`pb + mod.str`、`(5 + slot.level)d6`、`dist(attacker, self) <= 5`；三值求值（不知道就问） |
| `src/sheet/` | 静态层（移植自原项目）：规则管线、能力框架、角色解析与计算、资源、专长、职业状态 |
| `src/combat/` | 战斗引擎：效应、D20 / 伤害管线、触发器、效果树、回合、会话（事务 / 撤销 / 事后裁定）、房规层、审计 |
| `src/bridge/` | 静态层 → 战斗引擎：人物卡算出的结果转成战斗参与者，战斗结果写回人物卡 |
| `app/` | 界面（React + Vite）：卡片库、人物卡（卡面 / 建卡）、战斗（参与者、动作、日志与回执、决定弹窗、撤销与事后裁定）；数据存在浏览器 localStorage |
| `data/rules-2024.json` | 15 个状态、通用动作、武器精通、核心参数 |
| `data/dyn/` | 法术与特性的动态层（覆盖文件，键与 `abilities-2024.json` 一致） |
| `data/abilities-*.json` | 静态层的能力数据（移植自原项目） |
| `tests/` | 表达式、黄金场景、房规与审计、静态层对比、集成 |
| `tools/oracle/` | 在 Node 里跑原项目，作为静态层的参照实现 |

## 用法速览

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
