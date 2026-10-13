# dnd2024-engine

D&D 2024 人物卡 + 战斗引擎。静态规则逻辑移植自 `dsh-p/dnd/dnd2024-sheet`（只移植逻辑，界面重写）；
动态规则层（战斗中按时机生效的规则）是新写的，设计见 [COMBAT-DESIGN.md](COMBAT-DESIGN.md)。

## 命令

```bash
npm test             # 全部测试
npm run typecheck    # 类型检查
npm run check:data   # 规则数据审计（表达式编译、模板引用、事件名、双计）
```

## 目录

| 目录 | 内容 |
|---|---|
| `src/expr/` | 表达式语言：`pb + mod.str`、`(5 + slot.level)d6`、`dist(attacker, self) <= 5`；三值求值（不知道就问） |
| `src/combat/` | 战斗引擎：效应、D20 / 伤害管线、触发器、效果树、回合、会话（事务 / 撤销 / 事后裁定）、房规层、审计 |
| `data/rules-2024.json` | 15 个状态、通用动作、武器精通、核心参数 |
| `data/dyn/` | 法术与特性的动态层（覆盖文件，键与 `abilities-2024.json` 一致） |
| `tests/` | 表达式、黄金场景、房规与审计 |

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
