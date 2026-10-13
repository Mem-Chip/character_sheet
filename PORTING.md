# 静态层移植记录

> 原项目：`../dsh-p/dnd/dnd2024-sheet`（单 HTML、全局单例、浏览器内运行）。
> 移植目标：**只搬规则逻辑**（界面重写），输出与原项目逐项一致；原项目的已知 bug 修掉并逐条登记。
>
> **状态：移植验证已完成。** 之后不再追求和原项目一致，也不考虑旧卡兼容 ——
> 测试改为我们自己的快照（`tests/fixtures/snapshots/`，`npm run snapshots` 重新生成），
> 原项目的参照运行器留作手动对照（`npm run oracle` 写到 `.oracle/`，`npm run oracle:fuzz`）。

## 一、怎么保证「移植得对」

不靠读代码对照，靠**参照实现**：

1. `npm run fetch:data` —— 把 5etools 数据抓到 `data/5etools/`（不进 git）。
2. `npm run oracle` —— 在 Node 的 `vm` 里跑原项目的构建产物 `人物卡.html`，
   把 `tests/fixtures/chars.json` 里的每个角色算一遍，归一化后存进 `tests/fixtures/oracle/`（进 git）。
3. `tests/sheet/parity.test.ts` —— 移植版算同样的角色，与参照输出**逐项**比较：
   SHEET 的 68 项，加上专长槽、专长候选与前置判定、武器精通容量、职业技能预算、荒野形态、法术表解锁，
   以及计算之后角色数据本身（子职摘除 / 恢复会改角色）。
4. `npm run oracle:fuzz -- 500 7` —— 随机生成角色两边对比（不进测试，手动跑）。

验证结果：21 个固定角色全部一致；随机 800 个角色（两个种子）除登记过的修复外全部一致。
验证完成后，当时的对比夹具连同差异清单一起转成了现在的快照。
测试里做过变异检查（改坏熟练加值公式、改 AC 文案），对比都能抓到。

归一化（`src/sheet/normalize.ts`）：5etools 实体压成 `名字|来源`（要比的是「解析到的是不是同一条」），
Set 转排序数组，特性列表压成 `归属|名字|等级`，审计轨迹 `trace` 不比。

## 二、文件对照

| 原项目 | 移植到 | 说明 |
|---|---|---|
| `core/util.js` 常量与 `U.*` 小工具 | `src/sheet/constants.ts` | DOM 构造器不搬 |
| `core/source.js` | `src/sheet/source.ts` | |
| `core/store.js` 的 `Store` | `src/sheet/store.ts` | 取数抽成 `DataProvider`；浏览器缓存（ETag / IndexedDB / 整包暖启动）随界面重写 |
| `core/fetch.js` | `src/sheet/node-provider.ts`（Node 版） | 浏览器版待写 |
| `core/data.js` 的 `Character` | `src/sheet/character.ts` | `resolve` / `compute` / `featNames` / 起源专长默认值 |
| `core/data.js` 的 `Search.classData` | `DataStore.classData` | omnidex 检索随检索页重写 |
| `core/character.js` | `src/sheet/pipeline.ts` | 十阶段管线、CalcCtx、Chooser、buildOrigins |
| `core/plugins.js` 的 `Abilities` / `ModKinds` / `resolveNum` / `Homelib` | `src/sheet/abilities.ts` | 家规三层：全服、战役两层由 `SheetEnv` 注入 |
| `core/plugins.js` 的 `BUILTIN_ABILITIES` | `data/abilities-builtin.json` | 用脚本从源码提取，不手抄 |
| `rules/items.js` | `src/sheet/items.ts` | 起始装备包 `PackRules` 随建卡页移植 |
| `rules/feats.js` | `src/sheet/feats.ts` | |
| `rules/pools.js` | `src/sheet/resources.ts` | `Rest` 不再读全局 `SHEET`，改成参数 |
| `rules/class-state.js` | `src/sheet/class-state.ts` + `states.ts` | 折叠面板等界面代码不搬；`TEMP_STATES` 只作旧卡兼容 |
| 全局单例 | `src/sheet/env.ts`（`SheetEnv`） | 一个环境 = 一套数据 + 能力表 + 管线 + 家规层 |

## 三、有意的差异（修掉的原项目 bug）

验证期间逐条登记、由对比测试放行；转成快照后，这些修复就是快照本身的一部分。

| bug | 影响 | 修法 |
|---|---|---|
| 武器熟练过滤式 `type=军用武器\|property=轻型;灵巧`：原实现 `.slice(1)` 丢掉第一段，又拿中文属性名去比代码（F / L） | 游荡者的刺剑 / 短剑 / 弯刀…、武僧的短剑等**不加熟练加值**（命中少 2～6） | 不丢段；属性名经 `store.props` 反查代码 |

## 四、验证完成后有意改掉的地方（不考虑旧卡兼容）

| 改动 | 原来 |
|---|---|
| 祈唤 / 超魔法 / 战技的决策键带上职业名：`XPHB:魔契师:魔契师:0#opt-EI` | 字面 `undefined`（`XPHB:undefined:…`），生成键时没带职业 |
| 去掉旧版临时状态层（`TEMP_STATES` / `char.states` / `char.round`），角色上改存 `effects`（战斗引擎的 ActiveEffect） | 狂暴、先天术法等写死在一张手写表里，狂暴时长还是错的（1 分钟，应为至多 10 分钟逐轮延长） |
| 临时效应不进人物卡管线，由战斗引擎叠在人物卡算出的数值上（`effectiveView`） | 两边各算一份会双计 |
| `sourceShort` 认得 `FRHoF` | 大小写比较写错，永远认不出 |

## 五、还没移植的（随界面一起做）

建卡流程（`PackRules` 起始装备、点数购买、建卡页的各种选择池）、检索与悬停（omnidex、`Renderer`、`Hover`、`FilterRunner`）、
卡片库与存储（`Chars` / `Library` / `Api` / `CharKeys` 的 build / live 拆分）、导入导出与诊断包（`Save`）、
按卡推导要装哪些数据（`CardData`）、能力编辑器与家规编辑器的界面、AI 设置、示例插件。

## 六、静态层 → 动态层

`src/bridge/from-sheet.ts`：

- `viewFromSheet`：SHEET → `CombatantView`。条目键与动态层数据的键格式一致（`XPHB:游荡者:偷袭:1`），
  准备了的法术进 `XPHB:spell:<名>`；职业表当前行进 `classTable`（偷袭 `3d6`、狂暴伤害 `2`）；
  资源池挂回能力数据声明的 id（「狂暴」），契约法术位并进同环法术位；额外攻击读特性名。
- `combatantFromSheet`：再带上角色的实时记账（HP、临时生命值、法术位、资源、死亡豁免）。
- `syncLiveToChar`：战斗结果写回角色的记账字段，build 半边一概不碰。

集成测试（`tests/bridge/integration.test.ts`）：真实角色卡进战斗 → 写回 → 重算，资源剩余次数对得上。
