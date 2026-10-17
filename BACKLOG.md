# 待办与搁置

记「知道要做、但还没做」的东西。做完的删掉；新发现的加进来。细节设计写在设计文档里，这里只管清单。
每条后面的「在哪」是起点，不是全部。来干活先读 [CLAUDE.md](CLAUDE.md)。

## 刚做完、待实战检验（用的时候留意，出问题记下来）

- 地图区域（法术留下的 + DM 画的，自动 / 每次问 DM）、借机攻击（+ 威胁范围框）、推离 / 拉近、「某人开始 / 结束回合时」的触发器。
  已知简化：借机攻击发生时棋子已经在终点（打倒了才退回停下的格子）；区域对「施放当下就在里面的生物」不自动生效，要数据另写；
  DM 按住 Shift 拖棋子 = 纯摆位置，不触发借机攻击和区域。
- 撤销把棋子放回去（`server/encounters.ts` 的 `undoMoves`）。
- 战役资料库：启用的书、本团内容、遭遇里「更新本团规则」（DATA-HUB.md「已做（第 2 步）」）。
- 自带密钥 AI 工具（DATA-HUB.md「已做（第 3 步）」）：**还没用真模型跑过**，只用本地假接口走过流程。
  要验：DeepSeek / OpenAI / OpenRouter 允不允许浏览器直接调用（跨域）、一条大概多少钱、写出来的质量。
- 物品第 4 波外包的 277 条（`data/dyn/ai/items.json`，未审）；人物卡新算的物品固定效果（属性定值 / 加值、抗性、免疫、速度）。
- **德鲁伊荒野形态（2024 RAW）**：变身融合野兽属性/体型/速度/AC/攻击/豁免/感官/特质并保留原技能/豁免熟练、月德鲁伊护甲与虚假生命、失能自动解除、原力蛮击/月辉形态、变身期间施法限制（月德法术与 18 级野兽法术除外）、快速换形界面与图鉴过滤。
- **召唤 / 随从 / 魔宠系统**：执行树新增 `summon` 节点与动态数值缩放（Upcast）、入场邻接放置棋子、先攻继承施法者紧随其后行动、专注联动断开即退场、游侠伴侣单例替换与0生命值直接阵亡、9大2024召唤法术/魔宠/游侠原初伴侣数据化与 UI 快捷召唤。

## 小的（一个 worktree 一两天能做完）

- **飞行类物品的速度**：飞翼之靴、飞翼斗篷按 5etools 数据被当成常驻飞行速度，其实要启动。
  在哪：`src/sheet/pipeline.ts` 物品那段的 `modifySpeed`（可以按「要启动」排除，或者只在物品数据没写启动方式时算）。
- **攀爬 / 游泳 / 飞行速度进战斗**：人物卡算了 `moveSpeeds`，战斗参与者只拿了步行速度。先做到「看得到」（详情、悬停），移动规则不动。
  在哪：`src/bridge/from-sheet.ts`（`viewFromSheet`）、`app/pages/combat/Actor.tsx`。
- **战斗视图里的特殊资源**：「详情」抽屉的「资源」表能记术法点、气这类次数池，但底部动作栏里看不到，用起来不方便。待确认要怎么改（先问用户）。
  在哪：`app/pages/combat/Hotbar.tsx`、`app/lib/hotres.ts`。
- **方便查看棋子身上的状态**：地图上一眼看出谁倒地、谁在专注；法术附带的状态（电爪的「不能借机攻击」）悬浮提示直接指向法术原文。
  在哪：`app/pages/combat/MapView.tsx`、`TokenMenu.tsx`、`app/components/Term.tsx`。
- **短休**：在战斗里花生命骰回血（现在只能在人物卡上休息）。
  在哪：`src/sheet/resources.ts`（休息）、战斗命令在 `src/combat/types.ts` / `session.ts`、写回在 `src/bridge/from-sheet.ts` 的 `syncLiveToChar`。
- **日志回放**：日志上点「回放」进回放视图，可以跳到某一条日志（从头一笔一笔重放到那里），再一步一步往下看（地图上的棋子也跟着回到当时的位置）。不急。
  在哪：`app/pages/combat/Log.tsx`；重放用 `Session` 的事务列表（`src/combat/session.ts`），棋子位置在遭遇的 meta 里（`server/encounters.ts`）。
- **冰刃**：攻击 + 爆开的范围伤害（要范围预览）。在哪：`data/dyn/spells.json`、`app/lib/area.ts`。
- **状态细节**：魅惑者对你的社交检定有优势；擒抱者移动时拖着被擒的人；恐慌时地图上禁止靠近恐惧源。
  在哪：`data/rules-2024.json`（状态）、`src/combat/space.ts`（移动）。（审查报告里「状态语义」这一类 18 条）
- **跨轮记住选择 / 数据**：比如「第一次用时选元素，之后每轮沿用」，现在只能每轮重新问一次。先看看 `effect.state` / `vars` 够不够用。
  在哪：`src/combat/types.ts`（`applyEffect` 的 `state`）、`src/combat/exec.ts`、`src/combat/effects.ts`。

## 中的

- **批量 AI 数据化**：从启用的书里勾一批条目，排队跑单条的 AI 循环，失败的列出来、可以重试；结果进账户资料库（或某个战役）。
  在哪：`app/lib/ai.ts`（`partsJobForKey`、`checkParts`）、`src/factory/ai.ts`、`app/pages/CampaignHub.tsx`（战役页「资料」）。
- **临时武器和武器附魔**（神圣武器、魔石术、幽影刃，改用施法属性攻击）：物品栏有了，规则还没接。
  在哪：`src/bridge/from-sheet.ts`（攻击行）、相关法术的动态数据。
- **复杂代价**：一次同时花法术位和术法点（超魔）、两种代价二选一。在哪：`src/combat/types.ts`（Cost）、`src/combat/tx.ts`（能不能付、怎么付）。
- **物件当目标**（门、箱子，有 AC 和生命值）。在哪：`makeView`（`src/combat/view.ts`）、目标选择。
- **困难地形 / 移动力扣除**：地图和区域都不知道哪格是困难地形，走进去不扣额外移动力（审查报告里 23 条卡在这）。
  在哪：`src/combat/space.ts`（走格子的代价）、`server/encounters.ts` 的 map（底图上标困难地形）、`app/pages/combat/MapView.tsx`。
- **打断施法 / 让正在施展的法术失效**（法术反制这类，审查报告 6 条）：先确认 `modify.cancel`（带 `refundSlot`）够不够 ——
  它现在主要用于伤害包；施法窗口只有 after、没有 before，得先加一个施法前的拦截窗口。
  在哪：`src/combat/audit.ts`（窗口表）、`src/combat/exec.ts`（施法流程）、`src/factory/spec.ts`（补说明书）。
- **按手动审查报告重新数据化**：`datafy/manual-audit/` 那次审查（830 条：21 条当年就能写、50 条本来就不用自动化、760 条卡在接口上）已经过时 —— 之后引擎补了 `summon`、`zone`、`leftReach`、反应里的 `modify`、`evasion` / `halveDamage` / `cancel`、`redirect` / `absorb`、`maxDice` 等，那批里约 250 条现在能写了。
  - **区域 + 借机攻击已经做了一轮**（见 [datafy/manual-audit/round2/README.md](datafy/manual-audit/round2/README.md)）：9 个子代理写草稿、另 9 个逐条复核，**合并了 53 条**进 `data/dyn/ai/*.json`（复核通过 44 + 我修掉 9 条确定性错误）；新增 [tests/combat/zone-data.test.ts](tests/combat/zone-data.test.ts)（拿真数据跑一场遭遇：匕首之云走进区域 4d4、臭云术回合开始豁免中毒）。
  - **下一轮先收拾 36 条**：[round2/suspects.md](datafy/manual-audit/round2/suspects.md) 里 27 条有复核证据（多数一行就能改：骰子公式、`on` 时机写多/写错、`oncePerTurn` 用错、`within(self,…)` 在区域里语义不对），草稿在 `round2/drafts/`；另有 `oa-02` 那 9 条整批重做。
  - 之后做**召唤**（56 条；agy 已把 9 个 2024 召唤法术做完，剩下的多卡在「指挥随从花反应 / 动态改写召唤物数值 / 复活」上），逐条的 `key` / `gap` / `need` 在 `datafy/manual-audit/answers/*.json`。
- **灵光（aura）的两个引擎缺口**（第二轮复核实测出来的）：① aura 授予的触发器**不检查半径**（`src/combat/triggers.ts` 没走 auraGate）—— 至圣光轮 30 尺、迅捷灵光 10 尺，实测 60 尺 / 20 尺外照样生效；数据侧暂时可以补 `when: 'dist(source, self) <= N'` 兜。
  ② `aura.grant.statics` **根本没被读取**（`effectiveView` 只看 rollMods / triggers）—— 勇气灵光授予的「免疫恐慌」是死数据，实测照样被恐慌。在哪：`src/combat/triggers.ts`、`src/combat/effects.ts`。
- **区域（zone）拿不到 `vars`**：`src/combat/space.ts` 传给区域的是 `vars: {}`，施法时 `choose` 选出来的东西（伤害类型等）在区域里丢了（哈达之欲的升环加骰永远落在强酸上）。在哪：`space.ts` 的 `runZone` / `Zone`（把创建时的 vars 存进 zone）。
- **触发窗口里正规地花反应**：`leftReach` 这类窗口里数据写 `cost: [{ economy: 'reaction' }]` 不扣反应（实测反应 0 也能用、还能反复花）；另外 `flags.cannot: ['provoke']` 的效应活到**回合结束**而不是「这次移动结束」，数据要配 `endsOn: moved` 才对（散兵战术踩过）。在哪：`src/combat/tx.ts`（payCosts / canPay）、`src/combat/effects.ts`（disengaged）、`triggers.ts`。
- **移动已经放下的区域**：zone 只有创建 / 删除，没有「把区域挪到别处」，原文里的「区域移入生物空间」触发也没实现（月华之光、炽焰法球、自然庇护卡这条）。在哪：`src/combat/session.ts`（`createZone`）、`space.ts`、`app/pages/combat/MapView.tsx`（拖动）。
- **检查器补一条：`target.size` 的字面量**：数据写 `target.size == 'S'`（引擎里是「小型」，见 `src/sheet/constants.ts` 的 `SIZE_CN`）恒假，`npm run check:data` 不报。在哪：`src/combat/audit.ts`、`src/factory/lint.ts`。
- **自定义整个职业 / 自定义种族「建卡时能选到」**：账户资料库（[LIBRARY.md](LIBRARY.md)）现在支持特性、法术、物品、专长、可选特性、子职的数据化；整个职业（等级表、特性表、施法进度）和自定义种族要接静态层的职业表 / 种族候选，工程量大，先搁着。
  在哪：`src/sheet/`（`class-state.ts` 的职业表、`source.ts` 的候选过滤）、`app/lib/library.ts` 的 `pickable`。
- **易伤（vulnerability）在卡面数据里表达不出来**：`mods` 里只有 `resist` 和 `immune`（`immune` 是这轮补的），
  伤害易伤只有战斗侧的 statics 支持，人物卡不算它。在哪：`src/sheet/abilities.ts`（注册 mod kind）、`src/sheet/pipeline.ts`（把 `vuln` 也 pluck 出来写进 sheet）。

## 大块，暂时不做

- **光照与视线**：躲藏、隐形、黑暗术、掩护（半掩护 / 四分之三掩护）的自动判断。要光照和障碍物。（审查报告里 44 条卡在这）
- **传送**：要在地图上点目的地（新的决定类型）。现在传送只在日志里提示，手动拖棋子。（审查报告里 41 条）
- **三维**：飞行、悬浮、攀爬、游泳速度，高度，坠落伤害。决定不做。（审查报告里「飞行 / 悬浮 / 游泳 / 攀爬速度」34 条 +「三维高度」5 条）
