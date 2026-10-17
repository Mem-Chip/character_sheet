# 账户资料库 + 数据面板（设计）

> 取代 [DATA-HUB.md](DATA-HUB.md) 第一～三节的「战役绑定的本团内容」：数据改成**账户所有**，
> 一份内容可以挂到自己所在的战役（玩家也能挂），也永远对自己的卡生效。
> AI 数据化从「只写战斗」扩到**同时写卡面 + 战斗**；一条资源可以拆成多条条目（一个子职 = 每级特性一条）。
> 再加一个**全 5etools 搜索**入口：搜到名字就自动带出条目键和原文，喂给 AI。
>
> 站点还没正式投入使用，所以这次的改动是**破坏性**的：`content` 表直接换掉，不做数据迁移。
> DATA-HUB.md 里关于引擎分层、遭遇快照、外包工厂的部分仍然有效。

## 一、结论与现状

要动的三件事，和现有代码的关系：

| 要做的 | 现状 | 改动性质 |
|---|---|---|
| 内容归账户，可挂到战役 | `content` 表按 `(campaign_id, id)`，只有 DM 能写（[server/hub.ts](server/hub.ts):95、:128） | 换表 + 接口，**条目形状基本不变** |
| AI 同时写卡面 + 战斗 | 说明书只讲战斗 `Entry`（[src/factory/spec.ts](src/factory/spec.ts):88）；界面写着「卡面数据还是手写」（[app/pages/CampaignHub.tsx](app/pages/CampaignHub.tsx):196） | 说明书拆节 + 输出改成 parts + 新写卡面检查 |
| 全 5etools 搜索导入 | 没有 | 纯新增（索引已验证可用） |

顺带修掉的老问题：**不在战役里的本地遭遇完全用不了自定义战斗数据**——[app/lib/combat.ts](app/lib/combat.ts):244 本地遭遇直接 `engine.rules = engine.base`。
账户库接上之后，本地遭遇也能用上自己库里的战斗数据。

已经确认可用的东西（不用重做）：

- 规则引擎本来就分层 `全服 → 本团 → 本卡 → 场景`（[src/combat/rulebook.ts](src/combat/rulebook.ts):6），同键后面的盖前面的，被盖住的会在 `problems` 里报出来。
- 卡面家规已经是三层 `server → camp → card`（[src/sheet/abilities.ts](src/sheet/abilities.ts):417），插一层「我的库」就行。
- 遭遇开局把房规抄进 `meta.rules`（[server/encounters.ts](server/encounters.ts):391、:399），客户端按快照建规则书（[app/lib/combat.ts](app/lib/combat.ts):240）；`addCombatant` 已经记了 `cardId`（[server/encounters.ts](server/encounters.ts):468），服务器查得到卡主。
- 取条目运行时先查规则书、再查参与者自己（[src/combat/collect.ts](src/combat/collect.ts):29），所以只要进规则书就能生效。
- AI 循环（说明书 + 例子 + 检查 + 自动重试，[src/factory/ai.ts](src/factory/ai.ts):54）、任务拼装（[src/factory/build.ts](src/factory/build.ts):148）、结构审计与试算（[src/factory/lint.ts](src/factory/lint.ts):227）都能直接复用。

## 二、数据模型

### 2.1 表（替换 `content`，`campaign_books` / `monster_ai` 不动）

```sql
-- 账户资料库：一条 = 一份资源（可以拆成多条条目，见 2.2）
CREATE TABLE IF NOT EXISTS library (
  id TEXT NOT NULL,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  data TEXT NOT NULL,            -- LibraryItem 的 JSON
  by_user INTEGER NOT NULL, rev INTEGER NOT NULL, updated INTEGER NOT NULL,
  PRIMARY KEY (owner_id, id)
);
CREATE INDEX IF NOT EXISTS library_owner ON library(owner_id);

-- 挂到战役：新内容挂上就生效；覆盖官方的要 DM 开关
CREATE TABLE IF NOT EXISTS library_share (
  owner_id INTEGER NOT NULL,
  item_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('auto', 'pending', 'on', 'off')),
  by_user INTEGER NOT NULL, updated INTEGER NOT NULL,
  PRIMARY KEY (owner_id, item_id, campaign_id),
  FOREIGN KEY (owner_id, item_id) REFERENCES library(owner_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS library_share_camp ON library_share(campaign_id);
```

- `state`：`auto` = 新内容（不覆盖官方键），挂着就生效；`pending` = 覆盖了官方键、等 DM 点头；`on` / `off` = DM 开关的结果。
- 上线时 `DROP TABLE IF EXISTS content`（站点没在用，不迁移）。
- 挂载的 `owner_id + item_id` 指向 `library`，作者删条目时挂载跟着没（外键级联）。
- 成员退团 / 被请出：删掉他在这个战役里的挂载（内容还在他库里）。

### 2.2 条目形状：一条资源 = 多条「条目」（parts）

一个子职、一个职业、一个种族，数据化出来是**好几条**（每级特性一条、每个键一条）。所以库条目带 `parts` 数组：

```ts
/** 一份资源拆出来的一条 */
export interface ResPart {
  /** 条目键：写官方键（`XPHB:野蛮人:狂暴:1`）= 覆盖；否则是新增 */
  key: string;
  /** 自己那条家规 / 房规的 id，`hr-xxxx`，界面上勾选、日志里引用都用它 */
  id: string;
  name?: string;
  /** 这条的原文 / 说明 */
  text?: string;
  /** 卡面：不勾「选了才生效」的团里每张卡都算 */
  pickable?: boolean;
  /** 卡面数据（写法同 abilities-*.json） */
  sheet?: { mods?: Json[]; grants?: Json[]; choices?: Json[]; resources?: Json[] };
  /** 战斗数据：整条替换 entry / 改字段 patch / 改核心参数 value（key = core.<名>） */
  combat?: { entry?: unknown; patch?: Record<string, unknown>; value?: unknown; fill?: boolean };
}

export interface LibraryItem {
  id: string;                       // hr-xxxx（和第一条 part 同 id 也行）
  kind: string;                     // feat / spell / item / subclass / classFeature / race / optfeature / homerule …
  name: string;
  text: string;                     // 总说明（给人看）
  source?: string;                  // 5etools 来源代号（搜来的）
  /** 搜来的出处，用来重新取原文、显示「覆盖了哪条」 */
  ref?: { kind: string; source: string; name: string; cls?: string; level?: number };
  parts: ResPart[];
  by: string;                       // 'hand' | 'byok:<模型名>'
  reviewed: boolean;
  rev?: number; updated?: number;
}
```

- **单条资源就是 `parts.length === 1`**：界面默认给「单条模式」（一个键 + 两个 JSON 框），高级里能加第二条。
- 条目键与 `id` 的约束沿用现有的：`/^hr-[0-9a-z]{4,16}$/`（[server/hub.ts](server/hub.ts):37、[src/sheet/abilities.ts](src/sheet/abilities.ts):410），
  所以 **part 各自有自己的 `hr-` id**（`char.hrPicked` 记的是 part id）。
- 大小上限从 200 KB 提到 **600 KB**（一个子职的原文 + 数据不小）；服务器 `MAX_BODY` 8 MB 不用动。

### 2.3 从条目到两个规则层

| 目标 | 现有函数 | 改成 |
|---|---|---|
| 卡面（静态层） | `homeRuleOf(it) → HomeRuleEntry \| null`（[app/lib/hub.ts](app/lib/hub.ts):92） | `homeRulesOf(it) → HomeRuleEntry[]`（每个 part 一条，`covers = part.key`、`id = part.id`） |
| 战斗（动态层） | `houseRuleOf(it) → HouseRule \| null`（[server/hub.ts](server/hub.ts):75） | `houseRulesOf(it) → HouseRule[]`（每个 part 一条；`key = part.key`） |

`HomeRuleEntry` / `HouseRule` 的形状都不改，只是从「一条 item 出一条」变成「一个 part 出一条」。

## 三、层与合并

### 3.1 卡面（静态层）

```
全服(server) → 本团(camp) → 我的库(user) → 本卡(card) → 场景
```

- 在 [src/sheet/abilities.ts](src/sheet/abilities.ts):418 的 layers 里插 `{ scope: 'user', rules: env.homelib.user(char) }`。
- `SheetEnv.homelib` 加 `user?: (char) => HomeRuleEntry[]`（[src/sheet/env.ts](src/sheet/env.ts):28）。
- **本团** = 这个战役挂着的、并且 DM 开着（`on` / `auto`）的条目。
- **我的库** = 我自己的全部条目（不管挂没挂）。**DM 的开关管的是「对别人生效」，管不到你自己的卡**——这样你看到的卡和服务器跑的战斗不会打架（见 3.2）。
- 书白名单 `Source.extra` 是全局可变的一个 Set（[src/sheet/env.ts](src/sheet/env.ts)），现在**只由战役启用的书**填。
  ~~以前是「战役启用的书 ∪ 我的库条目带的来源书」，那样导入一条 EFA 的种族就把战俑、龙纹家族全带出来了（2026-10 修掉）。~~
  现在分两格：`Source.extra` = 启用的书；**`Source.covered` = 资料库覆盖到的单个条目键**（`EFA:科拉瓦` 这种），
  只放行那一条，不放行整本书；`Source.names` 是覆盖后的显示名（选择面板显示它，**值仍然是原始名字** —— 键不变，规则照旧对得上）。
  条目所在的书仍然会去**装数据文件**（`userSources` → `loadBookSpells`），但只装不放行。

### 3.2 战斗（动态层）

```
官方文件 → 全服 → 战役（挂载且开着的） → 每个参战者自己的库（按加入顺序） → 场景
```

- 开遭遇时：战役那部分照旧（[server/encounters.ts](server/encounters.ts):391）。
- 加 PC 时：`addCombatant` 带了 `cardId`，服务器查 `cards.owner_id` 拿到卡主，把**那个人的库**的战斗部分补进 `e.rules`，然后 `Session.restore` 重放一遍。
  层名用「卡主名」，`scope: 'card'`。
- **同一个官方键被两个人覆盖**：规则书按层序取最后一个（`RuleBook.problems` 会报「谁盖了谁」，界面上列出来）。
  因为条目是按能力键取的（[src/combat/collect.ts](src/combat/collect.ts):29），只有拥有那项能力的人会读到，冲突面比看上去小。
- 本地遭遇（不在战役里）：`engine.rules` 从「只有官方」改成「官方 + 我的库」。
- 「更新本团规则」按钮（[app/pages/Combat.tsx](app/pages/Combat.tsx):171）顺带把参与者各自的库一起更新。

## 四、权限与 DM 的「资源管理器」

| 情况 | 谁说了算 |
|---|---|
| 新内容（键是新的，没覆盖官方） | 玩家挂上**立即生效**（`auto`）；本来就和别人无关 |
| 覆盖官方键 | 挂上是 `pending`，**对别人不生效**；DM 在战役页点开/关（`on` / `off`） |
| 自己用自己的库 | 永远生效，不需要谁批 |
| DM 自己挂的覆盖 | 默认 `on` |
| 全服怪物 AI 结果 | 保持现状（`monster_ai` 全服共享）——它是「补全解析结果」，不是「覆盖资源」，这次不动 |

**资源管理器**（战役页新开一块，DM 可见可操作，玩家只读）：

- 列出这个战役里所有挂上来的条目：名字、作者、类别、覆盖了哪条官方键、状态（自动 / 待审 / 开着 / 关掉）。
- 一行一个开关；**同一个官方键被多条覆盖时，把冲突的几条并到一组**，标出「现在生效的是哪条」（层序最后一条开着的），一键关掉其余的。
- DM 自己也能在这里直接挂自己的库、新建、编辑。
- 面板顶部一句话解释清楚：「新内容挂上就生效；覆盖官方规则的要你点头」。

## 五、AI 数据化：同时写卡面 + 战斗

### 5.1 输出

模型输出直接就是 `parts` 数组：

```json
{ "parts": [
  { "key": "XPHB:野蛮人:狂暴:1", "name": "狂暴", "text": "…原文摘要…",
    "sheet": { "resources": [{ "id": "rage", "name": "狂暴", "formula": "…", "recovery": "long" }] },
    "combat": { "entry": { "name": "狂暴", "actions": [ … ] } } },
  { "key": "XPHB:野蛮人:无甲防御:1", "name": "无甲防御", "sheet": { "mods": [ … ] } }
] }
```

- 一条资源 → 一条 part（绝大多数情况）；一个子职 / 职业 / 种族 → 多条 part。
- 任务里由 [src/factory/build.ts](src/factory/build.ts) 的 `buildTask` **逐个键**给出原文和上下文（一个子职就把每级特性列出来），要求输出 parts 数组。

### 5.2 说明书拆节

`buildSpec` 拆成两节，按需拼：

- `combat`：现在这份（`Entry` 的写法），原文不动。
- `sheet`：**新增**。内容从代码生成，不能手抄：
  - `mods` 的 kind 列表和说明：`AbilityBook.kinds`（[src/sheet/abilities.ts](src/sheet/abilities.ts):266 注册的那批 `describe`）。
  - `grants` 的 kind、`choices` 的 pool 白名单：`audit()` 里那份 `POOLS`（[src/sheet/abilities.ts](src/sheet/abilities.ts):370）。
  - `resources` 的 formula 写法：`Resources.resolveFormula` 支持的名字（`pb`、属性调整值、`level`、`cond(...)`…）。
  - 一句话原则：**恒定的加值写卡面，带条件的写战斗**（这条现在只在战斗说明书里，要搬到两边的分界上）。
- 默认 `both`：两节都给。只改一条战斗数据的入口（比如战斗里补怪）仍可只给 `combat`，省 token（现在一条任务约 3 万 token，两节全给会更大）。

### 5.3 检查（这是本次最实的工作量）

- **战斗部分**：完全复用 `lintEntry` + `smoke`（[src/factory/lint.ts](src/factory/lint.ts):227）。
- **卡面部分**：**新写 `lintSheet`**。卡面数据现在**没有任何检查**，字段拼错会被静默忽略——这正是「写了却不生效」的来源。
  参照 `AbilityBook.audit()`（[src/sheet/abilities.ts](src/sheet/abilities.ts):366）：
  - `mod.kind` 必须在已注册的 kind 里（不认识的 kind 报出来）；
  - `grant` 缺 `values`、`grant(kind: 'note')` 缺 `text`；
  - `choice.pool` 不在已知池里、也没有 `from` 数组；
  - `resource.id` 缺、`formula` 用 `Resources.resolveFormula` 在探针数值上算不出数；
  - `covers` 的键格式（`<来源>:<名字>` 或 4 段的职业特性键）。
- **试算升级**：现在只跑小遭遇（`smoke`）。加 `smokeSheet`：拿探针角色（和任务里同一个，20 级同职业）算一遍卡，报「算不出来 / 报错 / 数值明显没变」。
- **package 级检查**：同一 item 里 part 的 `key` 不重复；part id 合法且不重复。

## 六、全 5etools 搜索导入

### 6.1 索引（已实测）

- 站点有 **`/search/index.json`（2.9 MB，18308 条）**：`{ x: [...], m: { s: { 来源代号 → 序号 } } }`，
  每条 `{ c 类目, u slug, p 页码, s 来源序号, n 英文名, cn 中文名 }`。
- 加进 [tools/fetch-data.ts](tools/fetch-data.ts) 和 `Source.FILES`（缓存到 `data/5etools/search/index.json`，开发时 vite 中间件会挂出来，部署时复制进 `dist/5etools`）。

### 6.2 类目码 → 引擎类型（拿本地数据反查过的）

| c | 类型 | c | 类型 |
|---|---|---|---|
| 1 | 怪物 | 22 | 可选特性（超魔法） |
| 2 | 法术 | 23 | 可选特性（战技） |
| 3 | 背景 | 27 | 可选特性（箭） |
| 4 | 物品 | 29 | 可选特性 |
| 5 | 职业 | 30 | 职业特性 |
| 6 | 状态 | 32 | 可选特性（魔能祈愿） |
| 7 | 专长 | 33 | 可选特性 |
| 8 | 可选特性 | 34 | 可选特性（奇械师） |
| 10 | 种族 | 37 | 可选特性（符文） |
| 21 | 疾病 | 40 | 子职 |
| | | 41 | 子职特性 |

（其余多是别的书的怪物、遭遇、表格、餐谱这类我们用不上的；本地缓存只覆盖索引的 1/4，因为只抓了核心那几份。）

### 6.3 slug → 条目键

slug 是「名字_来源」或「名字_职业_来源_等级_职业来源」，能直接拼出引擎键：

| slug | 键 |
|---|---|
| `火球术_xphb` | `XPHB:spell:火球术` |
| `治疗药水_xdmg` | `XDMG:item:治疗药水` |
| `警觉_xphb` | `XPHB:警觉` |
| `圣疗_圣武士_xphb_1_xphb` | `XPHB:圣武士:圣疗:1` |
| `炼金师_奇械师_efa_炼金师_efa_3_efa` | 子职特性（`<来源>:<职业>:<特性>:<等级>`，解析时按段数判断） |

同一内容常有旧版（PHB）和 2024 版（XPHB）两份：列表里两份都列，用现成的 `Source.is2024` 标「2024」，2024 版排前面。

### 6.4 导入后取原文

拿到键之后**不用新写取数逻辑**：`buildTask` 已经支持法术 / 物品 / 专长 / 可选特性 / 种族 / 职业特性 / 子职特性。
不支持的（整个子职、整个职业、背景）**降级**：只带原文（`flattenEntries`）+ 出处，让 AI 自己写，键由用户填或自动拟。

按需加载那本书的文件：法术走 `spells/index.json`、怪物走 `bestiary/index.json`（[src/sheet/store.ts](src/sheet/store.ts):90、[app/lib/hub.ts](app/lib/hub.ts):135 已有机制），
其他类型是全局文件（feats / items / races / backgrounds / optionalfeatures），已经在缓存里。

### 6.5 界面

一个通用的 `SearchPicker`（数据面板、战役资料、人物卡数据页共用）：

```
[ 搜 5etools：圣疗                                    ]  [ 只列 2024 ]
 圣疗        职业特性 · XPHB · 圣武士 1 级 · 2024      [导入]
 圣疗        职业特性 · PHB  · 圣武士 1 级             [导入]
 守护圣疗    法术     · XGE  · 3 环                    [导入]
```

选中 → 自动填 `ref` + `covers` 键 + 原文 → 直接进 AI 对话框（或手写）。

## 七、界面

| 位置 | 内容 |
|---|---|
| 顶部导航 | 新增「资料库」（[app/App.tsx](app/App.tsx):10 的 `NAV`），页面：搜索框、我的条目列表、编辑、挂到战役 |
| 战役页「资料」 | 变成**资源管理器**（第四节）：启用的书 + 挂上来的内容 + 开关 + 冲突提示（DM 可改，玩家只读） |
| 人物卡「数据」页 | 现有的入口保留，目标从「本团资料」改成「我的资料库」；「AI 补战斗数据」→「AI 写数据（卡面 + 战斗）」 |
| 战斗页 | 「需手动处理的能力」旁边补数据 → 写进自己的库（不再要求卡在战役里） |

## 八、分期

每期都能单独 `npm run typecheck && npm test` 后合并回 `main`。

| 期 | 内容 | 验收 |
|---|---|---|
| 0 | 表 + 接口：`library` / `library_share`，`/api/library` CRUD、挂载/开关、`/api/campaigns/:id/hub` 汇总；`drop content` | 接口级测试（server 层）；`npm test` 绿 |
| 1 | 「资料库」页 + 战役「资源管理器」；AI 入口改指向自己的库 | 起 app + api 实际点一遍：建条目、挂战役、DM 开关、玩家挂覆盖看到「待审」 |
| 2 | 卡面接入：`homelib.user` 层、`Source.extra` 合并、`homeRulesOf` | 人物卡快照测试 + 一条覆盖官方能力的库条目实际生效 |
| 3 | 全 5etools 搜索导入（索引、类目映射、slug→键、原文） | 搜「圣疗」能出两条、导入后键和原文对得上（写单测） |
| 4 | AI 双写：parts 输出、说明书拆节、`lintSheet`、`smokeSheet` | `tests/factory` 加用例：假接口喂一份双写答卷，检查能过；卡面写错能被挑出来 |
| 5 | 战斗接入：本地遭遇用我的库；战役遭遇按参战者合并快照 | 本地遭遇里自定义战斗数据生效；战役遭遇两个账号，各自的库都生效，冲突有提示 |

建议顺序就是 0 → 1 → 2 → 3 → 4 → 5（3 和 4 可以换）。第 5 期依赖 2 的层定义，所以放最后。

## 九、明确不做 / 待定

- **不做**：自定义整个职业、自定义种族的「建卡时能选到」（静态层的职业表 / 种族候选要另接，工程量大）；「提升到全服」；版本历史（只记 `rev`）。
- **待定**：怪物 AI 结果要不要也并进账户库（现在全服共享，够用）；批量数据化（原 DATA-HUB §五第 4 步）等这个做完再说。

## 已做（第 0 期，表 + 接口）

- 表：`library`（账户库）、`library_share`（挂载 + DM 开关）；`content` 表**已删**（DROP，站点没在用，不迁移）。
- 接口：`GET /api/library`、`PUT|DELETE /api/library/items/:id`、`POST /api/library/items/:id/share|unshare`、
  `POST /api/campaigns/:id/library/state`（DM 开 / 关）。
- `/api/campaigns/:id/hub` 现在返回：`sources`、`role`、`items`（**临时兼容投影**，旧形状，第 1 期删）、
  `attached`（全部挂载，含待审 / 关掉的，给资源管理器用）、`mine`。
- 旧界面的「战役资料」接口（`PUT|DELETE /api/campaigns/:id/hub/items/:id`）还是一份兼容垫片：写进 DM 自己的库再挂到战役，
  第 1 期新界面上来之后连 `items` 一起删。
- 代码：[src/library/](src/library)（形状 / 检查 / 条目→规则层，浏览器和服务器共用）、
  [server/library.ts](server/library.ts)（表 + 接口 + `campaignRules` / `rulesOfOwner`）、[server/hub.ts](server/hub.ts)（启用的书 + 全服怪物 AI）。
- 一次设计上的修正：**只写战斗数据的一条不进卡面**——它的键是官方键，若照旧生成一条空的卡面家规，会把官方卡面数据顶掉。
  另外覆盖官方能力的条目不允许勾「选了才生效」（按能力键生效，勾了没意义），结构检查会直接拒。
- 验收：`tests/library.test.ts`（10 个用例，结构检查 / 挂载状态 / 条目→规则层）、整套 `npm test` 213 个全过；
  另外真起了一次服务器把 18 项接口行为走了一遍（注册 → 建团 → 玩家挂新内容（auto）→ 玩家覆盖官方（pending）→
  非 DM 开关 403 → DM 开 / 关 → 不合格条目被拒 → 旧接口兼容）。

## 已做（第 1 期，资料库页 + 战役资源管理器）

- 新页面「资料库」（顶部导航，[app/pages/DataPanel.tsx](app/pages/DataPanel.tsx)）：我的内容列表（类别、覆盖了什么 / 新内容、
  卡面 / 战斗标签、挂了几个团）、新建 / 编辑 / 删除、**挂到战役…**（勾选，勾完直接告诉你是「自动生效」还是「等 DM 点头」）。
  没登录时说明为什么不能建。
- 条目编辑器（[app/components/LibraryEditor.tsx](app/components/LibraryEditor.tsx)）：一份资源多条 part 的编辑界面 ——
  键留空 = 新内容（自动用 `HR:<part id>`）、填官方键 = 覆盖；每条自己的卡面 / 战斗 JSON；每条一个「AI 写这条的战斗数据…」。
- 战役「资料」改成**资源管理器**（[app/pages/CampaignHub.tsx](app/pages/CampaignHub.tsx)）：启用的书 + 挂上来的内容
  （谁挂的、什么状态）、DM 的**开 / 关**按钮、**同一个官方键被多条覆盖时列出来并指出现在生效的是哪条**、「挂我的内容…」、
  「打开我的资料库」。玩家只能摘自己的，开关归 DM。
- 人物卡「数据」页：AI 补的数据**存进自己的资料库**（不再要求卡在战役里、不再要求是 DM），存完自动挂到卡所在的战役
  （覆盖官方的会变成待审，界面上明说）；「可选内容」列的是你自己的库 + 本团生效的。
- 客户端数据层重写：[app/lib/hub.ts](app/lib/hub.ts) 删掉 → [app/lib/library.ts](app/lib/library.ts)
  （我的库、战役挂载、分享开关、生效判定、书目与图鉴）。`useHubVersion` → `useLibraryVersion`。
- 旧的兼容垫片**已删**：`/api/campaigns/:id/hub` 不再返回旧形状的 `items`，老接口 `PUT|DELETE /hub/items/:id` 也去掉了；
  hub 现在只返回 `sources` / `role` / `attached` / `mine`。
- 顺手修的两个问题：
  1. **退团 / 被请出时，把他挂在这个战役里的内容摘掉**（内容还在他自己的库里）——设计里写了，第 0 期漏了实现。
  2. `npm run build` 在 worktree 里会失败：`data/5etools` 是 junction 时，`cpSync` 想照着建符号链接，Windows 上 EPERM。
     [vite.config.ts](vite.config.ts) 的 `cpSync` 加了 `dereference: true`（部署时是把数据复制进 dist，本来就一样）。
- 验收：`npm run typecheck` 干净、`npm test` 213 个全过、`npm run build` 绿（含 5etools 复制进 dist）；
  真起后端跑了 **15 项接口验收**（库是私有的 / 玩家挂新内容 auto / 覆盖官方 pending / 非 DM 开关 403 / DM 开与关 /
  DM 自己挂覆盖直接 on / 摘下来 / 退团自动摘 / 一个子职拆成多条能存能挂 / hub 里 parts 完整），15/15 通过；
  再把 Vite 开发服务器和 /api 代理起起来，新写的界面模块（App / library / DataPanel / LibraryEditor / CampaignHub / SheetData）
  全部编译通过、`/api/health` 走代理 200。
- **没验证到的**：这一轮没有浏览器可用，**界面的实际点击流程（建条目、挂战役、DM 开关）没有人工点过**，
  只到了「类型 / 构建 / 模块编译 / 接口行为」这一层。第 2 期做卡面接入时会连界面一起点一遍。

## 已做（第 2 期，我的库接进卡面）

- **第四层落位**：`SheetEnv.homelib` 多一层 `user`（[src/sheet/env.ts](src/sheet/env.ts)），
  `homelibAll` 的顺序变成 `全服 → 本团 → 我的库 → 本卡`（[src/sheet/abilities.ts](src/sheet/abilities.ts):417）。
  同 id 时靠后的盖前面的——所以**你把自己的条目挂到战役后，对你自己仍然是「我的库」那一层**，
  DM 把某个覆盖关掉只影响别人，你自己的卡照旧按你自己的库算（和服务器跑战斗的口径一致）。
- **来源书放行**：`SheetEnv.userSources` 是新的一格；`useCampaign` 把「战役启用的书」和「我库里条目带的来源书」
  并起来给 `Source.extra`。来源书从条目键的前缀认（`XGE:spell:…` → XGE，`sourcesOfItem`），
  所以不在战役里也能选到那本书的法术 / 子职。
- **客户端接线**（[app/lib/library.ts](app/lib/library.ts)）：`installLibrary` 挂上 `homelib.user` 和 `userSources`；
  订阅账户状态（`subscribeSync`）——登录后重新取库、退出清缓存；算卡前 `useComputed` 会 `await loadLibrary()`。
- **人物卡「数据」页**：「可选内容」现在列的是**我自己的库 + 本团生效的**；「战斗数据」标签区分「我的库 · / 本团 ·」
  （`combatFor` 先看我的库，再看本团）；AI 补数据默认写进我自己的库（第 1 期就是这样）。
- 一个沿用第 0 期的规矩：**只带战斗数据的一条不进卡面**，我自己的库也一样（不然空的家规会把官方卡面数据顶掉）。
- 验收：`npm test` **219 个全过**、`npm run typecheck` 干净、`npm run build` 绿、Vite 里模块编译通过 + `/api` 代理 200。新增两个测试文件：
  - [tests/sheet/library-layer.test.ts](tests/sheet/library-layer.test.ts)（4 个）：不在战役里也生效**并且真的算进卡里（AC +1）**、
    「选了才生效」要勾、层序 `本团 → 我的库 → 本卡` 同 id 靠后的赢、来源书放行让 XGE 的法术能选到；
  - [tests/library-client.test.ts](tests/library-client.test.ts)（2 个）：把 `sync → api → library → 规则环境` 这条链路
    用假接口跑通（登录 → 取到我的库 → 接成第 3 层家规 + 来源书），以及没登录时不去要库。
- **仍然没验证到的**：界面的人工点击（这一轮同样没有浏览器）。

## 已做（第 3 期，全 5etools 搜索导入）

- **索引**：用站点自己的 `/search/index.json`（3.07 MB、18308 条），加进 [tools/fetch-data.ts](tools/fetch-data.ts)
  的抓取清单（`Source.FILES.searchIndex` 本来就有，只是没人用）。本地缓存起来之后开发服务器直接从
  `/5etools/search/index.json` 提供，浏览器不再跨域去站点取。
- **解析**（[src/sheet/search.ts](src/sheet/search.ts)，纯逻辑 + 一份缓存）：
  - **slug → 条目键**：`名字_来源`（法术 / 物品 / 专长 / 可选特性 / 种族 / 状态…）、
    职业特性 5 段 `名字_职业_来源_等级_职业来源` → `XPHB:圣武士:圣疗:1`、
    子职特性 7 段（多出子职与子职来源）、子职 4 段（slug 里混了 `state:`，名字和来源改从 `cn` / `s` 取）。
    职业特性 / 子职特性的 `s` 字段在站点索引里没填（是来源代号字符串），所以这两类一律从 slug 取来源。
  - **类目码 → 类别**：`CAT_KIND`（拿本地数据反查出来的那张表，LIBRARY.md §6.2）。
  - **可搜范围**：18308 条里 **13747** 条能用（其余是遭遇、随机表、卡牌、载具、书页链接这类，按设计丢掉）。
  - `SUPPORTED` 是「buildTask 能直接取原文」的类别；状态 / 动作 / 怪物这些给得了键但取不了原文 → 界面上标「要自己写」。
- **界面**：[app/components/SearchPicker.tsx](app/components/SearchPicker.tsx)，接进「资料库」页的
  **「从 5etools 搜一条…」**：搜名字（中英文都行）→ 列表（中文名 · 类别 · 来源 · 页码 · 「2024」标记）→
  选中后**自动取回原文预览 + 条目键 + 出处** → 「用这条」直接进编辑器（键已填好，覆盖官方的那种挂到战役就是待审）。
  编辑器的「出处」那行来自条目的 `ref`。
- 验收：`npm test` **230 个全过**（新增 [tests/search.test.ts](tests/search.test.ts) 11 个：手写索引验解析规则 +
  拿真索引和真数据验「搜圣疗 → `XPHB:圣武士:圣疗:1` → 原文含治疗能量」、「火球术 / 治疗药水 / 巨武器大师 / 警觉的键都能取到原文」）、
  `npm run typecheck` 干净、`npm run build` 绿；Vite 里新模块编译通过、`/5etools/search/index.json` 本地能取到（3,066,531 字节）、`/api` 代理 200。
- **仍然没验证到的**：界面的人工点击（这一轮同样没有浏览器）。

## 已做（第 4 期，AI 双写：卡面 + 战斗）

- **一次调用写两边**：模型输出 `{ "parts": [ { key, name, text, sheet, combat } ] }`，一条 part = 一条条目
  （一个子职 = 每级特性一条）。`key` 不写 = 新内容（保存时自动填 `HR:<id>`）；`combat` 直接写 Entry
  （写 `{ entry }` / `{ patch }` / `{ value }` 的包装也认）。落地在 [app/lib/ai.ts](app/lib/ai.ts) 的
  `checkParts` / `partsFromAnswer` / `partsJobForKey`。
- **两边互通**（这是双写的意义）：卡面 `sheet.resources` 里声明的次数池会**并进战斗检查的可花资源**，
  所以「池子写在卡面、`cost: [{ resource }]` 写在战斗」是正确写法，不会被误报成「没有这个资源」。
  重写一遍时同一个键会**沿用原来的 part id**——卡上「选了才生效」勾的是 id，不会丢。
- **说明书拆节**（[src/factory/spec.ts](src/factory/spec.ts)）：`buildSpec({ mode })`，
  `combat` = 原来那份（怪物那种「按名字一条条回答」的流程照旧用），`both` = 加上第 7 节「卡面数据怎么写」。
  卡面那一节是从代码生成的：`MOD_KIND_DOC`（每个 kind 的说明 + **允许的字段名**）、`GRANT_KINDS`、`CHOICE_POOLS`。
  这三份现在是**唯一的一份**——注册也从它取，加了 kind 却忘写说明会直接抛错，模型不会照着过时的说明写。
  卡面的例子直接取 `data/abilities-2024.json` 里的真实条目（不手抄）。
- **卡面检查**（新文件 [src/factory/sheet-lint.ts](src/factory/sheet-lint.ts)）：字段名拼错（引擎会静默忽略，这是最容易
  「写了却不生效」的地方）、kind 不认识、grant 缺 values/formula/text、choice 的 pool 不认识、
  资源上限算不出数、resource 的 recovery 不合法——都报出来。
- **卡面试算**（`smokeSheet`）：有真角色时（人物卡「数据」页那个入口）把这条卡面数据临时挂上去算一遍，
  只报两种问题：**算的时候报错**、**声称有内容但数值 / 资源 / 熟练一点没变**（「只有 note」的不算错）。
  算完会把临时那条拿掉，不影响后面的计算。
- 顺手两处：`MOD_KIND_DOC` 里新加了 `immune`（伤害免疫——卡面数据以前表达不出来，只能靠物品数据）；
  `AbilityBook.audit()` 现在也会报「不认识的 grant 类型」。
- 界面：条目编辑器里每条 part 一个「AI 写这条的数据（卡面 + 战斗）…」（同键更新、新键追加）；
  人物卡「数据」页的入口改成「AI 写数据（卡面 + 战斗）」并**带试算**；怪物流程不受影响（仍是 combat 版）。
- 验收：`npm test` **247 个全过**（新增 [tests/factory/parts.test.ts](tests/factory/parts.test.ts) 14 个 +
  [tests/sheet/mod-kinds.test.ts](tests/sheet/mod-kinds.test.ts) 3 个）、`npm run typecheck` 干净、
  `npm run check:data` 1534 条无问题、`npm run build` 绿、Vite 里改过的模块都编译通过 + `/api` 代理 200。
- **仍然没验证到的**：界面的人工点击（这一轮同样没有浏览器）；也**没有真的拿一个真模型跑过双写**
  （说明书变长了，一条大概多花多少 token 没量过）。

## 已做（第 5 期，战斗接入）

- **遭遇的规则层**（新函数 `encounterLayers`，[src/combat/rulebook.ts](src/combat/rulebook.ts)）：
  `官方文件 → 本团（战役挂载且 DM 开着的）→ 每个参战者自己的资料库（按加入顺序，靠后的盖前面）`。
  **服务器和客户端用同一个函数**，两边重放出来的结果才不会不一样。
- **服务器**（[server/encounters.ts](server/encounters.ts)）：`Live` 多了 `ownerRules`（也写进遭遇的 `meta`，重启后还在）；
  加 PC 时按 `cardId` 查卡主（`cards.owner_id`），把那个人的资料库战斗部分叠一层，然后 `Session.restore` 重放——
  **他的自定义数据从进场就生效**。同一个人的库只叠一次；这层让重放失败就撤回去（不把整场弄坏，DM 可以点「更新规则」再试）。
  「更新规则」现在同时刷新本团和每个参战者那几层。`stateOf` 把 `ownerRules` 一起发给客户端。
- **客户端**（[app/lib/combat.ts](app/lib/combat.ts)）：`useEncounterRules(engine, rules, ownerRules)` 按同一份层建规则书；
  **本地遭遇**（不在战役里）走 [app/lib/library.ts](app/lib/library.ts) 的 `applyLocalRules`——规则书 = 官方 + **我的资料库**，
  这就是第 2 期说的那个洞（以前本地遭遇根本用不了自定义战斗数据）。战斗页的按钮改叫「更新规则」。
- 验收：`npm test` **252 个全过**（新增 [tests/combat/rules.test.ts](tests/combat/rules.test.ts) 3 个：层的顺序与名字、同键参战者盖本团、
  两个参战者改同一个键时后者赢；[tests/library-client.test.ts](tests/library-client.test.ts) 2 个：`applyLocalRules` 叠上我的库 / 库里没内容就用官方那本）；
  `npm run typecheck` 干净、`npm run build` 绿；
  另外真起后端跑了 **13 项遭遇验收**（玩家用没挂内容的团，只靠自己的库）：
  本团层是空的、加卡后多出「卡主资料库」那一层且层名是卡主、同一个人的库只叠一次、不带卡的怪不加层、
  点「更新规则」两层都刷新、**玩家中途改库不影响进行中的遭遇（快照），点更新才换**。13/13 通过。
- **仍然没验证到的**：界面的人工点击（这一轮同样没有浏览器）——多人在线同步那部分（两个浏览器窗口、SSE 推 `ownerRules`）
  只有接口层证据，没有真的开两个窗口看过。

## 六期都做完了

照着本文第八节「分期」走：0 表与接口 → 1 资料库页与战役资源管理器 → 2 卡面接入 → 3 全 5etools 搜索导入 →
4 AI 双写 → 5 战斗接入。每期都跑了 `npm run typecheck` + `npm test` + `npm run build`，接口 / 遭遇那两块另外真起后端验过。
累计新增测试 39 个（`tests/library.test.ts` 10、`tests/sheet/library-layer.test.ts` 4、`tests/library-client.test.ts` 4、
`tests/search.test.ts` 11、`tests/factory/parts.test.ts` 14、`tests/sheet/mod-kinds.test.ts` 3，另有 `tests/combat/rules.test.ts` +3）。






