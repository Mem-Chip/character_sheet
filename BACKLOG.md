# 待办与搁置

记「知道要做、但还没做」的东西。做完的删掉；新发现的加进来。细节设计写在设计文档里，这里只管清单。
每条后面的「在哪」是起点，不是全部。来干活先读 [CLAUDE.md](CLAUDE.md)。

## 刚做完、待实战检验（用的时候留意，出问题记下来）

- 战斗中改先攻（`tests/combat/initiative.test.ts`）：DM 在先攻条 / 参与者列表里拖动排序；右键「移出先攻」「改先攻值…」「掷先攻加入」「填先攻加入…」；
  战斗中加的怪物 / 角色自动掷先攻、按数值插队（召唤物照旧跟着主人）。已知：顺序被手动打乱后，按数值插队只看「第一个比它低的人」，位置可能不直观。
- 战争迷雾（地图工具「迷雾」，只有 DM 有）：按格子揭开 / 盖上，玩家那边没揭开的全黑、迷雾里别人的棋子不显示，DM 看到半透明的。
  已知简化：不算光照和视线（全靠 DM 手刷）；迷雾数据和棋子位置照样发给玩家的浏览器（只是不画），懂行的人能从开发者工具里看到；
  先攻条、参与者列表里迷雾中的怪物照样显示（要藏就用原来的「藏起」）。
- 区域 / 困难地形的 AI 数据重做（`datafy/redo-zones/`）合并了 39 条：用上 difficult / while / fully / create / moveZone / `flags.ignores`，没经过人逐条审。
- 地图区域（法术留下的 + DM 画的，自动 / 每次问 DM）、借机攻击（+ 威胁范围框）、推离 / 拉近、「某人开始 / 结束回合时」的触发器。
  已知简化：借机攻击发生时棋子已经在终点（打倒了才退回停下的格子）；
  DM 按住 Shift 拖棋子 = 纯摆位置，不触发借机攻击和区域（「待在里面才有」的效应等那人下次开始 / 结束回合时对账）。
- 区域引擎扩充（`tests/combat/zone-engine.test.ts`）：区域记住施法时的 `vars`；`on` 加了 `create`（出现 / 挪过来时已在里面）、`leave`、`move`（在里面每走 5 尺）；
  `while`（待在里面才有的效应，离开 / 区域消失自动摘）、`applyEffect.whileInZone`；`moveZone` 节点和命令（挪过去压到的人算进入）。
  已改成新写法的数据：月华之光、匕首之云（移动）、蛛网术（离开解除束缚）、沉默术、哈达之欲（待在里面）、荆棘丛生（每 5 尺）。
  区域缺省按「占到任何一格」算在里面，`fully: true` = 每一格都在里面才算（沉默术、哈达之欲的目盲）。
- 困难地形：区域标 `difficult`，走进那些格子每格多扣 5 尺（引擎 `move` 按路径算，地图拖动预览、「本回合 N 尺」同一个算法 `difficultExtra`）；
  被推拉不算；效应 `flags.ignores: ['difficultTerrain']` 不多花。DM 对话框能勾「困难地形」（这个勾选框没在界面上实际点过）。
  已标的数据：蛛网术、荆棘丛生、哈达之欲、艾伐黑触手、冰风暴、雪雨暴、疫病虫群、油腻术；炽焰法球改成「法球周围 5 尺」的区域 + 附赠动作挪动。
- 撤销把棋子放回去（`server/encounters.ts` 的 `undoMoves`）。
- 战役资料库：启用的书、本团内容、遭遇里「更新本团规则」（DATA-HUB.md「已做（第 2 步）」）。
- 自带密钥 AI 工具（DATA-HUB.md「已做（第 3 步）」）：**还没用真模型跑过**，只用本地假接口走过流程。
  要验：DeepSeek / OpenAI / OpenRouter 允不允许浏览器直接调用（跨域）、一条大概多少钱、写出来的质量。
- 物品第 4 波外包的 277 条（`data/dyn/ai/items.json`，未审）；人物卡新算的物品固定效果（属性定值 / 加值、抗性、免疫、速度）。
- **德鲁伊荒野形态（2024 RAW）**：变身融合野兽属性/体型/速度/AC/攻击/豁免/感官/特质并保留原技能/豁免熟练、月德鲁伊护甲与虚假生命、失能自动解除、原力蛮击/月辉形态、变身期间施法限制（月德法术与 18 级野兽法术除外）、快速换形界面与图鉴过滤。
- **召唤 / 随从 / 魔宠系统**：执行树新增 `summon` 节点与动态数值缩放（Upcast）、入场邻接放置棋子、先攻继承施法者紧随其后行动、专注联动断开即退场、游侠伴侣单例替换与0生命值直接阵亡、9大2024召唤法术/魔宠/游侠原初伴侣数据化与 UI 快捷召唤。
- **方便查看棋子身上的状态**：地图棋子直观显示倒地角标（`倒`）与专注虚线金环/角标（`专`），SVG 状态角标与各面板（右键菜单、先攻栏、底部动作栏、详情抽屉）统一接入 `<Term>` 悬浮提示，法术附带状态（如电爪的「不能借机攻击」）直接指向原法术/特性词条。
- **短休与战斗中花生命骰**：战斗引擎新增 `spendHitDie` 命令与短休资源/契约法术位恢复，详情抽屉支持花生命骰回血、手动点选生命骰与短休/长休，同步写回人物卡 `hitDiceSpent`。
- **日志回放**：日志栏支持开启「回放」模式，通过 `Session.replayTo(n)` 重放到任意历史事务步，支持首步/上一步/下一步单步浏览及点击任意日志跳转，地图棋子与战斗状态同步还原至当时快照。

- **DM 共享音乐**（战役遭遇顶栏「♪ 共享音乐」，WebRTC 点对点，`app/lib/music.ts`、`server/encounters.ts` 的 `/rtc`）：
  只在本机两个账号之间测过（用合成的音代替选标签页）。要实战看：跨国连不连得上、延迟、音质。
  连不上（对称 NAT、某些手机网络）就要在服务器上装 TURN 中转（coturn），把地址加进 `music.ts` 的 `ICE`。

## 小的（一个 worktree 一两天能做完）

- **飞行类物品的速度**：飞翼之靴、飞翼斗篷按 5etools 数据被当成常驻飞行速度，其实要启动。
  在哪：`src/sheet/pipeline.ts` 物品那段的 `modifySpeed`（可以按「要启动」排除，或者只在物品数据没写启动方式时算）。
- **攀爬 / 游泳 / 飞行速度进战斗**：人物卡算了 `moveSpeeds`，战斗参与者只拿了步行速度。先做到「看得到」（详情、悬停），移动规则不动。
  在哪：`src/bridge/from-sheet.ts`（`viewFromSheet`）、`app/pages/combat/Actor.tsx`。
- **战斗视图里的特殊资源**：「详情」抽屉的「资源」表能记术法点、气这类次数池，但底部动作栏里看不到，用起来不方便。待确认要怎么改（先问用户）。
  在哪：`app/pages/combat/Hotbar.tsx`、`app/lib/hotres.ts`。
- **冰刃**：攻击 + 爆开的范围伤害（要范围预览）。在哪：`data/dyn/spells.json`、`app/lib/area.ts`。
- **力竭层数的界面**：引擎已经会叠层（`stack: "level"`、`self.exhaustion`、6 级死亡），但界面上加 / 减一级、看当前几级都不方便；
  `/cond` 指令也该能写 `/cond 力竭 2`、配一个去掉状态的 `/uncond`，状态名也要能用缩写（用户说状态待会再优化）。
  在哪：`app/pages/combat/Actor.tsx`、`TokenMenu.tsx`、`app/lib/commands.ts`、`src/combat/effects.ts`（`exhaustionOf`）。
- **状态细节**：魅惑者对你的社交检定有优势；擒抱者移动时拖着被擒的人；恐慌时地图上禁止靠近恐惧源。
  在哪：`data/rules-2024.json`（状态）、`src/combat/space.ts`（移动）。（审查报告里「状态语义」这一类 18 条）
- **跨轮记住选择 / 数据**：比如「第一次用时选元素，之后每轮沿用」，现在只能每轮重新问一次。先看看 `effect.state` / `vars` 够不够用。
  在哪：`src/combat/types.ts`（`applyEffect` 的 `state`）、`src/combat/exec.ts`、`src/combat/effects.ts`。

## 中的

- **动作实例**（引擎）：一次动作 / 施法从开始到结算完是一个实例，它引起的每个窗口都带着它；触发器能读它的字段（法术环阶、学派、伤害骰、每个目标的结果…），
  能对它做几种通用操作（改字段、跑它的某一支并只取伤害 / 乘倍数、加骰、做记号）。现在每种窗口只挑几样放进作用域，`CastPlan` 也只有 DC / 攻击加值 / 伤害类型 / 打断，
  所以强力戏法（失手 / 豁免成功仍受一半伤害）、强效塑能（要问人是不是塑能法术）这类做不了。**先审再定形状**：外包包在 `datafy/instance-audit/`（1010 条，26 份），
  答案收回来跑 `npx tsx tools/factory/instance-audit.ts merge`。在哪：`src/combat/castplan.ts`、`src/combat/triggers.ts`（`WindowSpec.scope`）、`src/combat/exec.ts`（`runAttack` / `runSave`）。
- **批量 AI 数据化**：从启用的书里勾一批条目，排队跑单条的 AI 循环，失败的列出来、可以重试；结果进账户资料库（或某个战役）。
  在哪：`app/lib/ai.ts`（`partsJobForKey`、`checkParts`）、`src/factory/ai.ts`、`app/pages/CampaignHub.tsx`（战役页「资料」）。
- **临时武器和武器附魔**（神圣武器、魔石术、幽影刃，改用施法属性攻击）：物品栏有了，规则还没接。
  在哪：`src/bridge/from-sheet.ts`（攻击行）、相关法术的动态数据。
- **复杂代价**：一次同时花法术位和术法点（超魔）、两种代价二选一。在哪：`src/combat/types.ts`（Cost）、`src/combat/tx.ts`（能不能付、怎么付）。
- **物件当目标**（门、箱子，有 AC 和生命值）。在哪：`makeView`（`src/combat/view.ts`）、目标选择。
- **困难地形还缺的**：底图本身（不是法术区域）的困难地形只能靠 DM 画一块「困难地形」区域。
- **打断施法 / 让正在施展的法术失效**（法术反制这类，审查报告 6 条）：先确认 `modify.cancel`（带 `refundSlot`）够不够 ——
  它现在主要用于伤害包；施法窗口只有 after、没有 before，得先加一个施法前的拦截窗口。
  在哪：`src/combat/audit.ts`（窗口表）、`src/combat/exec.ts`（施法流程）、`src/factory/spec.ts`（补说明书）。
- **按手动审查报告重新数据化**：`datafy/manual-audit/` 那次审查（830 条：21 条当年就能写、50 条本来就不用自动化、760 条卡在接口上）已经过时 —— 之后引擎补了 `summon`、`zone`、`leftReach`、反应里的 `modify`、`evasion` / `halveDamage` / `cancel`、`redirect` / `absorb`、`maxDice` 等，那批里约 250 条现在能写了。
  - **这一大类已经收口**（[round2](datafy/manual-audit/round2/README.md) 53 条、[round3](datafy/manual-audit/round3/README.md) 40 条、[round4](datafy/manual-audit/round4/README.md) 26 + 9 条，共 **128 条**）：
    流程是「子代理写 → 每个自检（结构 + 审计 + 小遭遇试算）→ 另派代理独立复核（拿 5etools 原文逐条比）→ 只合并复核通过的 → 剩下的带证据修完」。
    复核挑出的问题数：38 → 34 → 5 → 4，说明在收敛。
  - **下一个大类「重骰 / 加骰 / 改判定」也做了一轮**（[round5/README.md](datafy/manual-audit/round5/README.md)）：52 条里合并 34 条（7 条升到 full），
    顺手修了两个引擎问题（「黯蚀 / 暗蚀」两种写法归一、`minD20` 也抬自然值）；还缓着 16 条（8 条有证据在 [round5/suspects.md](datafy/manual-audit/round5/suspects.md) + `r5-02` 整批 8 条没复核）。
  - **接着做剩下的类别**：反应里改结算（20）、免伤（15）、物品消耗（12）、次数池（12）、改目标 / 替盟友挨打（9）、推拉（7）、骰子取最大（6）。
    逐条的 `key` / `gap` / `need` 在 `datafy/manual-audit/answers/*.json`。
  - 测试：`tests/combat/zone-data.test.ts`、`tests/combat/summon-data.test.ts`（真数据跑遭遇）。
  - **剩下几个大类也做了一轮**（[round6/README.md](datafy/manual-audit/round6/README.md)）：92 条**全部处理完**（55 条一次通过 + 35 条复核意见逐条修 + 2 条在手写文件里单独同步），10 条从 partial 升到 full；
    顺手修了「`damageTaken` 只开窗口不发事件」——效应的 `endsOn: [{ event: 'damageTaken' }]` 以前从来没生效过（数据里约 26 处）。
  - 检查器已经补上：`reach` / `melee` / `ranged` / `finesse` 写数字会报、`attack != null` 会报（改用 `ask('这次伤害来自一次攻击吗？')`）。
  - **还剩下的**：审查报告里还有 **约 433 条**没铺到（都在**别的**类别里：condition 63、timing 61、resource 56、other 49、reactModify 44、move 40、choice 29、item 26…），
    另有 80 条属于「暂时不做」（视线 / 传送 / 三维 / 困难地形）。这 433 条里很多要新引擎概念（移出战场、改变体型、链式跳跃、阻挡弹道、生命骰池…），一次做不完，按类别一轮一轮来。
- **灵光（aura）的两个引擎缺口**（第二轮复核实测出来的）：① aura 授予的触发器**不检查半径**（`src/combat/triggers.ts` 没走 auraGate）—— 至圣光轮 30 尺、迅捷灵光 10 尺，实测 60 尺 / 20 尺外照样生效；数据侧暂时可以补 `when: 'dist(source, self) <= N'` 兜。
  ② `aura.grant.statics` **根本没被读取**（`effectiveView` 只看 rollMods / triggers）—— 勇气灵光授予的「免疫恐慌」、净化灵光的毒素抗性是死数据（第五轮又实测了一次）。在哪：`src/combat/triggers.ts`、`src/combat/effects.ts`（要把 `aurasCovering` 挪出来或抽成独立模块才能给 `effectiveView` 用）。
- **触发窗口里正规地花反应**：`leftReach` 这类窗口里数据写 `cost: [{ economy: 'reaction' }]` 不扣反应（实测反应 0 也能用、还能反复花）；另外 `flags.cannot: ['provoke']` 的效应活到**回合结束**而不是「这次移动结束」，数据要配 `endsOn: moved` 才对（散兵战术踩过）。在哪：`src/combat/tx.ts`（payCosts / canPay）、`src/combat/effects.ts`（disengaged）、`triggers.ts`。
- **区域的界面操作**：引擎已经有 `moveZone` 命令（玩家能挪 / 撤自己放下的，服务器查过），地图上还不能拖区域、不能编辑区域、DM 对话框没有 `while` / 预设。在哪：`app/pages/combat/MapView.tsx`、`ZoneDialog.tsx`。
- **还没改成新区域写法的数据**：炽焰法球「撞进生物空间」那次豁免还是手动动作（区域挪过去压到周围 5 尺的人不算）、自然庇护、黑暗术 / 云雾术（遮蔽要视线机制）、埋骨墓地、扩散孢子等；`data/dyn/ai/` 里写着「区域不能移动 / 请手动拖」的条目按 `src/factory/spec.ts` 第 32 条重写。
- **检查器补两条**：① `target.size` 的字面量：数据写 `target.size == 'S'`（引擎里是「小型」，见 `src/sheet/constants.ts` 的 `SIZE_CN`）恒假，`npm run check:data` 不报；
  ② `heal` / `tempHp` 的 `to` 不接受 `'each'`（只有 `applyEffect` 允许），现在写了也能跑（`exec.ts` 的 `recipients` 恰好认），lint / audit 查不出来（灵感织衣踩到）。在哪：`src/combat/audit.ts`、`src/factory/lint.ts`。
- **第三轮复核又挖出的引擎语义缺口**（写召唤数据时踩到的）：
  1. ✅ **已修**：独立存续的召唤物原来「按召唤者」互相顶替，第二次召唤任何独立召唤物都会误删前一只（坐骑 + 魔宠不能共存）。
     现在按**组**顶替：缺省是这次动作（同一道法术再施展一次 = 换一只），跨条目同一效果的写 `group: 'steed'`（寻获坐骑 / 信实坐骑）。见 `tests/combat/summon-replace.test.ts`。
  2. ✅ **已修**：`spellCast` 窗口原来拿不到目标（`target` 落在施法者身上）。现在 `target` = 被施法的那个、`attacker` = 施法者，
     `event.targets` 是全部目标；`role: 'target'` 因此可用（「当有人对你施法时」写得出来了）。见 `tests/combat/window-scope.test.ts`。
     注意：原来靠旧语义写 `when: 'target.side != self.side'` 的数据要改成 `attacker.side`（现有数据里没人这么写，只有测试里有）。
  3. ❌ **待确认**：`modify.maxDice` 挂在掷骰者身上 —— 治疗骰的场景里施法者与承受者不是同一个，`maximize` 取不到那包骰子（永生者赠礼这类写不出来）。
  4. ℹ️ **不是 bug，是约定**：`reducedTo0` 里 `self` = 挂这条能力的人、`target` = 倒下的那个（和别的窗口一致）；
     数据写 `self.hp` 读到的是能力拥有者。已用 `tests/combat/window-scope.test.ts` 把语义钉住，写数据时照它来。
  5. ✅ **已修**：区域里的 `applyEffect` 每个触发点挂一份 —— 现在**状态（condition）刷新而不是叠**（区域每回合触发、同一道法术再施加都只有一份）；
     非状态的效应照旧可以共存（祝福术两份：取最近的，golden #12 就是这么设计的）。见 `tests/combat/effect-stack.test.ts`。
  6. ✅ **已修**：条目顶层 `resources` 声明的池子不进战斗（`Entry` 类型里压根没这个字段，引擎也从不读）。
     现在 `effectiveView` 会把条目声明的池子并进参与者的资源池（上限按 `formula` 在战斗作用域里求值），`cost: [{ resource }]` 可以花了。见 `tests/combat/entry-resources.test.ts`。
  7. ✅ **复核那条是误报**：`leftReach` 这类窗口里数据写 `cost: [{ economy: 'reaction' }]` **是会扣的**（`fire()` 走 `payCosts`），扣完就不再触发。
     已加 `tests/combat/window-cost.test.ts` 钉住；如果数据里没扣，多半是写成了 `activation: 'none'` 的动作而不是触发器。
  在哪：`src/combat/exec.ts`（summon / applyEffect）、`src/combat/effects.ts`（`effectiveView` / 状态刷新）、`src/combat/damage.ts`（`maxDiceFor`）、`src/combat/types.ts`（`Entry.resources`、`summonGroup`）、`src/combat/triggers.ts`。
- **自定义整个职业 / 自定义种族「建卡时能选到」**：账户资料库（[LIBRARY.md](LIBRARY.md)）现在支持特性、法术、物品、专长、可选特性、子职的数据化；整个职业（等级表、特性表、施法进度）和自定义种族要接静态层的职业表 / 种族候选，工程量大，先搁着。
  在哪：`src/sheet/`（`class-state.ts` 的职业表、`source.ts` 的候选过滤）、`app/lib/library.ts` 的 `pickable`。
- **易伤（vulnerability）在卡面数据里表达不出来**：`mods` 里只有 `resist` 和 `immune`（`immune` 是这轮补的），
  伤害易伤只有战斗侧的 statics 支持，人物卡不算它。在哪：`src/sheet/abilities.ts`（注册 mod kind）、`src/sheet/pipeline.ts`（把 `vuln` 也 pluck 出来写进 sheet）。

## 大块，暂时不做

- **光照与视线**：躲藏、隐形、黑暗术、掩护（半掩护 / 四分之三掩护）的自动判断。要光照和障碍物。（审查报告里 44 条卡在这）
- **传送**：要在地图上点目的地（新的决定类型）。现在传送只在日志里提示，手动拖棋子。（审查报告里 41 条）
- **三维**：飞行、悬浮、攀爬、游泳速度，高度，坠落伤害。决定不做。（审查报告里「飞行 / 悬浮 / 游泳 / 攀爬速度」34 条 +「三维高度」5 条）
