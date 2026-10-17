# 引擎接口速查（写数据前先看这一页）

> 数据格式的权威定义在 `src/combat/types.ts`；给 AI 写数据用的完整说明书在 `src/factory/spec.ts`
> （`npm run spec` 能生成纯文本版）。这一页只是审查时快速对照用。

## 1. 「动作」能写什么（`actions[]`）

```json
{ "id": "cast", "name": "显示名", "activation": "action | bonus | reaction | free | none",
  "tags": ["spell", "magical"], "cost": [{ "slot": { "min": 1 } }],
  "concentration": { "rounds": 10 },
  "targeting": { "type": "self | creature | point | area", "count": 1, "range": 60, "filter": "…", "area": {…} },
  "trigger": { "on": "spellCast", "role": "any", "aim": "actor" },
  "requires": "…表达式…", "root": [ …节点… ] }
```

- **代价**（`cost`）：`{slot:{min,max}}`、`{economy:'action'|'bonus'|'reaction'|'attack'}`、
  `{resource:'池子 id', n?}`、`{item:'物品名'}`、`{hp:N}`、`{hitDie:{faces,count}}` 等（见 `Cost`）。
- **窗口触发的动作**（`trigger`）：配合 `role`（actor / target / any）与 `aim: 'actor'`。
- **一次性动作**（池子消耗、充能）用 `requires` 表条件。

## 2. 节点（`root` / `do` / `onHit` 里用）

`attack`、`save`、`check`、`damage`、`addDamage`、`heal`、`tempHp`、`applyEffect`、`removeEffect`、
`extendEffect`、`endConcentration`、`grantAction`、`removeGrant`、`castFrom`、`modifyCast`、
`resource`、`economy`、`choose`、`if`、`forEach`、`repeat`、`move`、`note`、`number`、`modify`、`zone`、`summon`。

常用的几个：

| 节点 | 用途 |
|---|---|
| `attack` | 攻击检定（`bonus` 缺省 `self.spell.atk`）+ `onHit` / `onMiss` |
| `save` | 豁免（`ability` / `dc` / `to` / `onFail` / `onSuccess`；`to: 'attacker'` 打施法者） |
| `damage` | 立刻造成伤害（`dice` / `type` / `to` / `scale: 0.5` = 半伤） |
| `applyEffect` | 挂效应（`template` 相对本条目的 `effects` 名，或绝对键；`to` / `duration`） |
| `choose` | 让人选：写死 `options`，或 `pool: { from: 'ownSpells' | 'ownCantrips', maxLevel?, castTime?, singleTarget? }` |
| `grantAction` | 临时给一个动作（`from` / `fromVar` / `action`；可改 `cost` / `activation` / `targeting`；`until: 'turnEnd'`） |
| `castFrom` | 借前面挑中的那道动作**当场结算**（`fromVar` + `to: 'attacker' | 'target' | 'self' | 'each'`） |
| `modifyCast` | 改**正在施展的那道法术**（`cancel` / `dc` / `attackBonus` / `damageType`） |
| `move` | `mode: 'push' | 'pull' | 'teleport'`（推拉自动，传送会让界面选落点） |
| `zone` | 地图区域（进入 / 回合开始 / 结束触发） |
| `summon` | 召唤（`count` / `group` 同组顶替） |
| `if` / `forEach` / `repeat` / `number` / `note` | 控制流与提示 |

## 3. 触发器（`triggers[]`）

```json
{ "id": "t1", "label": "显示名", "on": "damageIncoming", "window": "before | after",
  "role": "actor | target | any | ally", "when": "…表达式…", "cost": [ … ],
  "modify": [{ "op": "…" }], "do": [ …节点… ], "aim": "actor", "limit": "oncePerTurn | oncePerRound" }
```

**窗口事件**（`on`）：`turnStarted`、`turnEnded`、`turnEnding`、`initiativeRolled`、`spellCast`、`d20Rolled`、
`attackHit`、`attackMissed`、`saveForced`、`damageIncoming`、`damageTaken`、`reducedTo0`、`restCompleted`、
`leftReach`、`roundStarted`、`combatStarted`、`combatEnded`。

**modify 的 op**：`reroll`、`addToRoll`、`reduceDamage`、`halveDamage`、`doubleDamage`、`setHp`、`cancel`（可 `refundSlot`）、
`cancelUnlessSave`（引擎先掷豁免，失败才打断）、`unlessSave`（引擎先掷豁免，按结果应用子修改：`setDc` / `setAttackBonus` / `setDamageType` / `cancel`）、
`evasion`、`succeed`、`redirect`、`absorb`、`clearAdv`。

> ⚠️ 窗口的 `modify` 是**同步求值**的，触发器的 `do` **不保证**在结算之前执行。
> 所以「先掷豁免、失败了才改/打断」必须用 `unlessSave` / `cancelUnlessSave`，不能先 `do` 里掷再改。

## 4. 效应的旗标（`effects[…].flags`）

`blocks: ['action' | 'bonus' | 'reaction']`（经济视为 0）、`breaksConcentration`、
`cannot: ['concentrate' | 'castSpells' | 'speak' | 'see' | 'hear' | 'perceive' | 'moveCloser:…' | 'opportunityAttack' | 'provoke']`、
`forbidTarget: 'source'`、`quicken`。

效应还能带：`statics`（`ac` / `speed` / `resist` / `save` / `spellDc` / `attack` …）、`rollMods`、
`triggers`、`aura`（`grant` 里的 `statics` 会并进范围内生物的 view）、`implies`、`onApply` / `onEnd`、`duration`。

## 5. 明确做不到的（别硬写）

- 视线 / 光照 / 掩护 / 隐蔽的判定（没有地图几何）；
- 三维高度、滞空、坠落；
- 两个生物**换位**；
- 「改写另一道法术的施法时间 / 成分 / 专注」这类（除了上面第 3 节的 4 个 plan 字段）；
- 变形（替换整张数据卡）、改变体型；
- 骰池（生命骰、偷袭骰）的扣除。
