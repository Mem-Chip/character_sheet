/**
 * 数据化工厂：给模型看的「动态层数据怎么写」说明书。
 *
 * 能从代码生成的部分（类型定义、每个字段能用的名字、参与者的字段与方法、函数、窗口事件）都从代码生成，
 * 不手抄 —— 引擎改了，说明书跟着变，模型不会照着过时的说明写。
 * 纯逻辑，浏览器（自带密钥）和 Node（子代理）共用。
 */
import { tyName, type FnSig, type Ty } from '../expr';
import { EMITTED_EVENTS, WINDOW_EVENTS } from '../combat/audit';
import { REF_SHAPE, scopeDef, type ScopeKind } from '../combat/scope';
import { CREATURE_TYPE_CN } from '../bridge/from-sheet';
import { CHOICE_POOLS, GRANT_KINDS, MOD_KIND_DOC } from '../sheet';

/** 伤害类型（站点 2024 译名） */
export const DAMAGE_TYPES = ['钝击', '穿刺', '挥砍', '火焰', '寒冷', '闪电', '雷鸣', '强酸', '毒素', '黯蚀', '光耀', '心灵', '力场'];
/** 生物类型（`target.type` 的取值） */
export const CREATURE_TYPES = [...new Set(Object.values(CREATURE_TYPE_CN))];
export const SKILLS = ['运动', '体操', '巧手', '隐匿', '奥秘', '历史', '调查', '自然', '宗教', '驯兽', '洞悉', '医药', '察觉', '求生', '欺瞒', '威吓', '表演', '游说'];

function fmtTy(t: Ty): string {
  if (t.k === 'obj' && t.fields) return `{ ${Object.keys(t.fields).join(', ')} }`;
  return tyName(t);
}

function fmtSig(name: string, f: FnSig): string {
  const req = f.params.length - (f.optional ?? 0);
  const ps = f.params.map((p, i) => (i < req ? tyName(p) : `${tyName(p)}?`)).join(', ');
  return `\`${name}(${ps})\` → ${tyName(f.returns)}${f.doc ? `　${f.doc}` : ''}`;
}

/** 声明部分的类型定义：types.ts 里「声明」到「运行时对象」之间那一段 */
export function declarationTypes(typesSource: string): string {
  const start = typesSource.indexOf('export type RollKind');
  const marker = typesSource.indexOf(' * 运行时对象');
  const end = marker < 0 ? -1 : typesSource.lastIndexOf('/* ===', marker);
  if (start < 0 || end < 0 || end <= start) throw new Error('types.ts 的结构变了：找不到「声明」那一段');
  return typesSource.slice(start, end).trim();
}

const SCOPE_FIELDS: Array<[ScopeKind, string]> = [
  ['action', 'Action.requires、targeting.count、targeting.filter'],
  ['node', '效果节点里的所有表达式（dice、dc、amount、when、delta、max…）'],
  ['trigger', 'Trigger.when、Action.trigger.when、modify 的 value'],
  ['rollMod', 'RollMod.when、RollMod.value'],
  ['static', 'StaticMod 的 bonus'],
  ['endsOn', 'Duration.endsOn[].when'],
  ['aura', 'Aura.requires'],
];

/** 窗口：引擎在什么时候问「有没有能力要在这时生效」 */
const WINDOWS: Array<[string, string, string, string, string]> = [
  ['d20Rolled', 'before', '掷骰者 / 攻击检定的目标', 'roll（还没判定；roll.failing = 按现在的结果会失败）、attack', 'reroll、addToRoll、succeed（改成成功 / 命中）、cancel、clearAdv（消掉优势 / 劣势）'],
  ['d20Rolled', 'after', '同上', 'roll（已判定）、attack', '—'],
  ['attackHit', 'before', '攻击者 / 被命中者', 'attack、roll。先问防守方，再问进攻方', '防守方：halveDamage、cancel（改为未命中）、redirect（改攻击目标）；进攻方：doubleDamage，或用 do 里的 addDamage 加伤害'],
  ['attackHit', 'after', '同上', 'attack、roll、damage（已结算）', '—'],
  ['attackMissed', 'after', '攻击者 / 目标', 'attack、roll', '—'],
  ['saveForced', 'after', '迫使豁免的人 / 豁免的人', '—', '—'],
  ['damageIncoming', 'before', '伤害来源 / 承受者', 'damage（掷出来的总数）、attack', 'reduceDamage（值可以带骰子，掷一次）、halveDamage、doubleDamage、cancel、evasion、redirect（整包伤害转给自己）、absorb（用自己的临时生命值或生命值替盟友承伤）'],
  ['damageTaken', 'after', '来源 / 承受者', 'damage', '—'],
  ['reducedTo0', 'before', '来源 / 承受者', 'damage', 'setHp（「改为降到 1」这类）'],
  ['turnStarted / turnEnded', 'after', '回合的主人（触发器里 target 也是他）', '—', '—'],
  ['leftReach', 'after', '走开的人 / 被离开触及范围的人', '—（借机攻击引擎自己会问，不用写）', '—'],
  ['spellCast', 'before', '施法者（role: \'target\' 是被施法的那个）', 'event.spell、event.key、event.targets；attacker = 施法者，target = 被施法的那个', 'cancel（打断施法，缺省退回法术位；要消耗法术位写 refundSlot: false）'],
  ['spellCast', 'after', '施法者（role: \'target\' 是被施法的那个）', 'event.spell、event.key、event.targets；attacker = 施法者，target = 被施法的那个', '—'],
  ['initiativeRolled', 'after', '掷先攻的人', '—', '—'],
  ['restCompleted', 'after', '休息的人', 'event.kind（short / long）', '—'],
];

export interface SpecInput {
  /** src/combat/types.ts 的源码（Node 里 readFileSync，浏览器里 `?raw` 导入） */
  typesSource: string;
  /**
   * `combat`（缺省）= 只写动态层，回答是一个 `Entry`（怪物那种「按名字一条条回答」的流程用这个）；
   * `both` = 卡面 + 战斗都写，回答是 `{ parts: [ { key, name, text, sheet, combat } ] }`（资料库的流程用这个）。
   */
  mode?: 'combat' | 'both';
}

export function buildSpec(input: SpecInput): string {
  const both = input.mode === 'both';
  const scopeRows = SCOPE_FIELDS.map(([k, where]) => {
    const roots = scopeDef(k).roots;
    const names = Object.entries(roots).map(([n, t]) => `\`${n}\`${t.k === 'obj' && t.fields ? fmtTy(t) : `：${fmtTy(t)}`}`);
    return `| ${where} | ${names.join('、')} |`;
  });
  const refFields = Object.entries(REF_SHAPE.fields).map(([n, t]) => `\`${n}\`（${fmtTy(t)}）`).join('、');
  const refMethods = Object.entries(REF_SHAPE.methods).map(([n, f]) => `- ${fmtSig(n, f)}`).join('\n');
  const funcs = Object.entries(scopeDef('node').funcs).map(([n, f]) => `- ${fmtSig(n, f)}`).join('\n');
  const missing = [...WINDOW_EVENTS].filter((e) => !WINDOWS.some(([w]) => w.split(' / ').includes(e)));
  if (missing.length) throw new Error(`说明书的窗口表漏了：${missing.join('、')}`);

  return `# ${both ? '规则数据' : '动态层规则数据'}：写法说明

你要把一条 D&D 2024 规则（职业特性、专长、法术、物品）写成引擎能执行的 JSON。

## 1. 产出什么

${both ? `一个 JSON 对象，里面的 \`parts\` 是**一条或多条条目**：

\`\`\`json
{ "parts": [
  { "key": "XPHB:野蛮人:狂暴:1", "name": "狂暴", "text": "原文摘要（中文，照抄不要编）",
    "sheet": { "mods": [], "grants": [], "choices": [], "resources": [ { "id": "rage", "name": "狂暴", "formula": "cond(level >= 17, 6, 2)", "recovery": "long" } ] },
    "combat": { "name": "狂暴", "actions": [ … ] } }
] }
\`\`\`

- **一个 part = 一条条目（一个键）**。一份资源拆成几条就写几个 part：一个子职 = 每级特性一条，各写自己的键。
- \`key\`：覆盖官方就写任务里给的官方键；**新内容不写 \`key\`**（保存时会自动填 \`HR:<id>\`）。
- \`sheet\` 写这张卡上恒定的东西（第 7 节），\`combat\` 写按时机生效的东西（第 2～6 节，**直接写 Entry 的内容**，
  不要包成 \`{ "entry": … }\`）。两个至少写一个；确实都没有就输出 \`{ "parts": [] }\`。` : `一个 JSON 对象，类型是下面的 \`Entry\`，描述这条规则**在游戏进行中、按时机生效**的部分：
主动使用的动作（actions）、在某个时机触发的能力（triggers）、对检定的修正（rollMods）、灵光（auras）、它施加的效应（effects）。

**不要写静态部分**：属性加值、熟练、授予法术、资源池上限、恒定的 AC / 速度加值，人物卡已经算好了（任务里会列出来）。
条件性的东西才写在这里：「豁免具有优势」「命中时加伤害」「失败时可以重骰」。`}

只输出这个 JSON 对象本身，不要包在别的结构里，不要解释。

**没有可写的就跳过**：这条规则在战斗 / 游戏进行中没有按时机生效的部分（纯静态加值、熟练、授予法术、只在休息或探索时用的、纯叙事），
输出 \`{ "skip": "一句话原因" }\`。有一部分能写、一部分引擎做不到 → 写能写的，\`automation: "partial"\`，在 \`text\` 里说清楚哪部分要人处理。

**同名特性的高等级版本**（同一个职业里名字相同、等级更高，比如 17 级的「动作如潮」）通常只是加强低等级那条：
不要再写一遍动作或触发器（角色两条都有，会出现两份）。加强能用表达式按等级写进低等级那条的，就在这条写 skip 并说明。

**戏法按角色等级变强**（5、11、17 级各加一颗骰）：骰子个数写 \`(1 + floor((self.level + 1) / 6))\`，例如 \`(1 + floor((self.level + 1) / 6))d10\`。

## 2. 类型定义

\`\`\`ts
${declarationTypes(input.typesSource)}
\`\`\`

\`ExprSrc\` = 表达式（字符串；也可以直接写数字或布尔）。\`Ability\` = \`'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha'\`。

## 3. 表达式

写在字符串里：\`"pb + mod.str"\`、\`"(1 + slot.level)d8"\`、\`"target.has('倒地') && roll.failing"\`。

- 运算：\`+ - * /\`、\`< <= > >= == !=\`、\`&& || !\`、括号；数值最后向下取整。
- 骰子：\`2d6\`、\`1d8 + 3\`、\`(slot.level + 1)d8\`（个数可以是表达式）。
- 字符串用**单引号**。没有三元运算符：要分支就用 \`if\` 节点。
- \`classTable('列名')\`：职业等级表当前行的某一列（骰子格直接是骰子，比如武艺骰）。列名见任务。
- 不确定的事实（距离、视线）引擎会去问人；用 \`dist\`、\`within\`、\`allyWithin\`、\`canSee\` 写，不要自己假设。

### 3.1 每个字段能用的名字

| 字段 | 能用的名字 |
|---|---|
${scopeRows.join('\n')}

\`self\` = 持有这条能力 / 效应的人；\`source\` = 效应的来源（谁施加的）；\`target\` = 当前目标；\`attacker\` = 攻击者。
\`mod.str\` 等是调整值；\`slot.level\` 只在消耗法术位的动作里有。\`vars.<名>\` 是 \`number\` 节点选出来的数。

### 3.2 参与者（self / target / source / attacker）

字段：${refFields}

方法：
${refMethods}

### 3.3 函数

${funcs}

## 4. 时机（窗口）

触发器（\`Trigger\`）和带 \`trigger\` 的动作挂在窗口上。\`role\` 决定谁能用：
\`actor\` = 事件的发起者（下表第三列的前者）、\`target\` = 承受者（后者）、\`ally\` / \`enemy\` = 相对承受者的盟友 / 敌人、\`any\`。
\`window\` 缺省是 \`after\`。\`modify\` 只能用在 before 窗口。

| 事件 | 窗口 | 发起者 / 承受者 | 能读到 | 能 modify |
|---|---|---|---|---|
${WINDOWS.map((r) => `| ${r.join(' | ')} |`).join('\n')}

反应类能力想「看到伤害再决定」（直觉闪避）：挂在 \`attackHit\` before，再写 \`deferTo: 'damageIncoming'\`。

**某人开始 / 结束回合时**（「敌人在你 10 尺内开始回合时」）：\`on: 'turnStarted'\`、\`role: 'enemy'\`（或 ally / any），\`when: 'dist(self, target) <= 10'\` —— 回合窗口里 \`target\` 就是回合的主人；
写在效应里、只管承受者自己回合的用 \`role: 'actor'\`。灵光（aura）授予的触发器也一样。

**借机攻击**引擎自己处理：走的人离开敌人的触及范围（有触及武器 10 尺，否则 5 尺）时，问那个敌人要不要用反应打一下；撤离了的不会被打。
「移动不引发借机攻击」的效应写 \`flags: { cannot: ['provoke'] }\`；被离开时还要做点什么的（哨兵）挂 \`leftReach\` 窗口。

**地图区域**（火墙、蛛网、刃之屏障这类持续存在的范围）：动作的 \`targeting.type\` 是 \`area\`，root 里写
\`{ kind: 'zone', on: ['enter', 'turnStart'], do: [ …对进来的生物做什么… ] }\`。区域占的就是施法时选的那些格子；
生物进入（自己走进来、被推进来）、在里面开始 / 结束回合时执行 do（\`self\` = 施法者，\`target\` = 那个生物，能用 \`slot.level\`）。
同一个生物每回合最多受一次（\`oncePerTurn\`，缺省 true）；只对敌人 / 盟友的写 \`affects\`。专注法术的区域随专注结束，否则写 \`rounds\`。
施放当下就在范围里的生物要受的效果，照常写在 root 的其他节点里（区域只管之后）。

**推离 / 拉近**（\`move\` 节点）在地图上会真的移动目标：沿两者连线的方向走直线，碰到别的棋子停下；拉近到贴身为止。传送还是提示人手动拖。

**带 \`trigger\` 的反应动作也能改正在结算的东西**：在 \`root\` 里写 \`{ kind: 'modify', modify: [ … ] }\`（和触发器的 modify 一样的写法），只能挂在 before 窗口。
值在动作自己的作用域里求，所以能用 \`slot.level\`：反冲术 = \`damageIncoming\` before 的反应法术，\`root: [{ kind: 'modify', modify: [{ op: 'reduceDamage', value: '(slot.level)d6 + self.spell.mod' }] }, …]\`。
反应动作默认打窗口的承受者（至圣斩打被命中的、护盾术护自己）；要打**窗口的发起者**（攻击者、伤害来源、施法者），在 \`trigger\` 上写 \`aim: 'actor'\`（炼狱叱喝、法术反制）。

效应的 \`duration.endsOn\` 可以监听的事件：${[...EMITTED_EVENTS].map((e) => `\`${e}\``).join('、')}。
\`endsOn\` 的 \`when\` 里，\`event\` 是事件内容（d20Rolled 有 \`kind\`、\`roller\`、\`target\`、\`total\`；effectApplied 有 \`bearer\`、\`name\`），\`self\` 是效应的承受者。

## 5. 约定（照着做）

1. **主动用的能力** → \`actions\`。动作的 \`id\` 和 \`name\` 用任务「接口」里给的。\`activation\`：动作 action、附赠动作 bonus、反应 reaction、不占动作 free、武器式的一次攻击 none（配 \`cost: [{ economy: 'attack' }]\`）。
2. **玩家可以选择用不用**的 → \`optional: true\`（引擎会问）；每回合一次 → \`limit: 'oncePerTurn'\`。
3. **花资源** → \`cost: [{ resource: '<id>' }]\`，id 用任务里列出的。这条能力**自己**有次数（「每次长休可以用 X 次」）而列表里没有对应的池 →
   在条目顶层声明：\`resources: [{ id: '<新 id>', name: '<中文名>', formula: '<上限>', recovery: 'short' | 'long' }]\`，再照常在 cost 里用它（人物卡会据此加上这个池）。
   formula 写法：数字、\`'pb'\`、\`'max(1, wis)'\`（属性调整值）、\`'level * 5'\`（level 是**该职业**等级）、\`'cond(level >= 11, 3, 2)'\`。不要拿别的池子凑。法术位 → \`cost: [{ slot: { min: <环> } }]\`，升环效果写在表达式里（\`slot.level\`）。
4. **由事件触发、还要花附赠动作或反应**的（护盾术、至圣斩）→ 写成 \`actions\` 里带 \`trigger\` 的动作；代价按 \`activation\` 自动算。只能在自己回合用的加 \`requires: 'turn.isMine'\`。
5. **命中时加伤害**（偷袭类）→ \`attackHit\` before 窗口、\`role: 'actor'\`，\`do: [{ kind: 'addDamage', … }]\`；跟武器同类型就写 \`type: 'attack.damageType'\`。
6. **「检定失败时」** → \`d20Rolled\` before 窗口，\`when\` 里用 \`roll.failing\`。可选能力只在会改变结果时才提供，别让玩家每次掷骰都被问。
7. **持续时间**：\`until.nth: 0\` = 本回合，\`1\` = 下一个回合；\`of: 'bearer'\`（承受者的回合）或 \`'source'\`（施加者的回合）。「直到你的下一回合开始」施加在别人身上 → \`{ until: { at: 'turnStart', of: 'source', nth: 1 } }\`。没有写持续时间的效应要手动移除，一般都该写。
8. **引用效应**：状态用全键 \`'XPHB:condition:<名>'\`；通用动作的效应 \`'XPHB:action:<名>#<效应名>'\`；本条目自己的效应写在 \`effects\` 里、用名字引用。可用的状态：目盲 魅惑 耳聋 力竭 恐慌 受擒 失能 隐形 麻痹 石化 中毒 倒地 束缚 震慑 昏迷。
9. **专注**写在动作的 \`concentration\` 上（时长）；这个动作施加的效应默认随专注结束。
10. **法术**的动作 \`tags: ['spell', 'magical']\`，动作 id 一般是 \`cast\`。
11. **名字**：动作 \`name\`、触发器 \`label\`、检定修正 \`label\` 都以能力的中文名开头（可以加「：说明」）。回执和弹窗上显示的就是它。
12. **让人选**：几个选项选一个 → \`choose\` 节点（选项可以带 \`when\`，条件不满足就不列）；选一个数 → \`number\` 节点，结果在 \`vars.<var>\`。
   \`choose\` 也可以写 \`var\`：选中项的 \`value\`（没写就是 \`label\`）放进 \`vars.<var>\`，后面的节点能用 —— 伤害类型 \`type: 'vars.elem'\`；
   要让效应记住（防护能量伤害），\`applyEffect\` 上写 \`state: { type: 'vars.elem' }\`，效应里 \`statics: [{ kind: 'resist', values: ['effect.state.type'] }]\`（抗性 / 免疫 / 易伤的类型可以写成表达式）。
13. **引擎做不到的**（传送、视线、光照）→ \`move\` / \`note\` 节点，或在 \`when\` 里用 \`ask('…')\` 问人。**没把握就整条写成 \`{ "automation": "manual", "text": "…" }\`**：不自动化，比写错强。
14. 伤害类型用中文：${DAMAGE_TYPES.join(' ')}。技能用中文：${SKILLS.join(' ')}。
15. 恒定的数值（AC +1、速度 +10、熟练）不写；只有带条件的写成 \`rollMods\` / \`statics\`（在效应里）。
16. **对攻击者 / 伤害来源生效**（黯冰狱铠的反噬、火焰护盾、庇护术让攻击者做豁免）：节点上写 \`to: 'attacker'\`（damage、heal、tempHp、applyEffect、save 都行）。在命中、受伤这些窗口的触发器和反应里用。
17. **反射闪避**这类（「豁免成功只受一半的效果：成功改为不受伤害，失败改为一半」）：\`damageIncoming\` before 的触发器，\`when: "damage.save == 'dex'"\`，\`modify: [{ op: 'evasion' }]\`。
   \`damage.save\` 是这次伤害来自哪项豁免（不是豁免带来的就是空字符串），\`damage.saved\` 是成功了没有。evasion 只对「成功分支里写了 \`scale: 0.5\`」的伤害起作用。
18. **骰子取最大值**（极效治疗、超限导能）：\`rollMods\` 里 \`op: 'maxDice'\`，\`on: { kind: 'heal' }\` 或 \`{ kind: 'damage' }\`；只管法术的加 \`spell: true\`（\`on: { kind: 'damage', spell: true }\`）。
19. **改攻击目标 / 让攻击落空**：在 \`attackHit\` before 窗口，\`{ op: 'redirect', to: 'self' }\` 把攻击改打自己（骑乘战斗、迎矢）；\`{ op: 'redirect', to: 'choose' }\` 让攻击者改选另一目标或取消这次攻击（庇护术：配 \`save\` 的 \`to: 'attacker'\`，在 \`onFail\` 里写 \`{ kind: 'modify', modify: [{ op: 'redirect', to: 'choose' }] }\`）。转火后会按新目标的 AC 重新判定。直接让攻击未命中用 \`{ op: 'cancel' }\`。
20. **替盟友承受伤害**：在 \`damageIncoming\` before 窗口（\`role: 'ally'\`），用自己的临时生命值或生命值吸收伤害（原目标抗性算完之后先扣你的，扣不完再落回原目标）：写 \`{ op: 'absorb', from: 'tempHp' }\`（投射守御，配 \`when: 'self.tempHp > 0'\`）或 \`{ op: 'absorb', from: 'hp' }\`（护卫灵光）。整包伤害直接转给自己承受（按自己的抗性算）：写 \`{ op: 'redirect', to: 'self' }\`（保护联结）。
21. **打断施法**（法术反制）：挂在 \`spellCast\` before 窗口（\`role: 'any'\`、\`aim: 'actor'\`），在豁免失败分支里写 \`{ kind: 'modify', modify: [{ op: 'cancel' }] }\`（2024 版不消耗对方体内的法术位，缺省 \`refundSlot: true\`）。
22. **抹掉优势 / 劣势**：常驻「攻击检定不会对你有优势」（飘忽不定、序列意识）在 \`rollMods\` 里写 \`op: 'noAdv'\`；触发时消掉本次掷骰的优势 / 劣势（归复平衡、醉汉机运）在 \`d20Rolled\` before 写 \`modify: [{ op: 'clearAdv', which: 'both' | 'adv' | 'disadv' }]\`。
23. **召唤生物**（野兽召唤术、原初伴侣、寻获魔宠、荒野伙伴）：用 \`{ kind: 'summon', name: '…', size: 'S' | 'M' | 'L', creatureType: '…', ac: '11 + slot.level', hp: '30 + 5 * (slot.level - 2)', speed: 30, attacksPerAction: 'floor(slot.level / 2)', attacks: [{ name: '…', damage: '1d8 + 4 + slot.level', damageType: '穿刺' }] }\`。有多种形态（陆生 / 空生 / 水生）的套在 \`choose\` 节点里。专注法术召唤出的生物默认随专注结束退场；非专注或独立存续的写 \`link: false\`。
    独立存续（\`link: false\`）的召唤物**按组顶替**：同一道法术再施展一次会换掉旧的（缺省按这次动作分组），不同来源（坐骑 + 魔宠）各留各的；同一效果被拆成两个条目时（寻获坐骑 / 圣武士的「信实坐骑」）在两条里写相同的 \`group: 'steed'\` 才会互相顶替。
24. **目标挣脱 / 效应被移除之后法术是否结束**：引擎**不会**因为「效应被移除」就自动结束专注 —— 多目标法术里一个目标摆脱了，法术对别人还在（golden #4 定身类人就是这么设计的）。
    原文说「成功则法术结束」的（诱捕打击这类），在 root 里显式写 \`{ kind: 'endConcentration' }\`：结束施法者自己的专注，链接的效应、区域、召唤物会一并退场。
25. **灵光授予的静态修正**（\`aura.grant.statics\`：抗性、免疫、AC 加值…）会并进范围内生物的 view —— 不用再拿「受伤前减半」之类的写法绕。
26. **临时给一个动作**（免法术位施放、篡改后的法术副本、临时武器）：\`{ kind: 'grantAction', key: 'grant:fireball', from: 'XPHB:spell:火球术#cast', cost: [] }\`。
    - \`from\` 复制某个条目键里的动作（可以再用 \`cost\` / \`activation\` 改写），或者用 \`action\` 直接写动作 JSON；
    - 授予的条目挂在 \`key\` 下，**动作栏里直接能用**（不用额外做什么）；**同 key 会盖住规则书里的同名条目** —— 这就是「用一个改过的副本覆盖原动作」；
    - \`until: 'turnEnd'\` = 当前这回合结束时自动收回；要立刻收回写 \`{ kind: 'removeGrant', key }\`；
    - 还能改写 \`targeting\`（\`{ type: 'self' }\` = 只能对自己，免位施放护盾类要靠它）；
    - **免法术位施放的标准写法**：外层动作 \`activation: 'action'\`（付掉动作 / 附赠动作），root 写
      \`{ kind: 'grantAction', from: 'XPHB:spell:<法术>#cast', cost: [], activation: 'free', until: 'turnEnd' }\` ——
      授予的那个法术动作不再花动作经济，也不扣法术位；复制时会自动把「相对模板名」换成绝对键、\`slot.level\` 按基础环阶定下来；
    - 注意它只换**动作**，不改「引擎内部行为」（借机攻击、能不能用反应、专注）—— 那些用 \`flags\`（\`cannot\` / \`blocks\` / \`forbidTarget\`）。

## 6. 引擎怎么执行（容易想错的地方）

1. **攻击节点的 \`bonus\` 缺省是 \`self.spell.atk\`（法术攻击）。** 武器攻击、徒手打击一定要自己写命中加值（\`self.pb + max(self.mod.str, self.mod.dex)\` 这类）；伤害骰里也要自己写属性调整值，引擎不会替你加。
2. **\`damage\` 节点会立刻造成伤害**，不只是掷骰。一个分支里的 damage 节点先合成一个伤害包结算，再执行同一分支的其他节点
   （例外：写在第一个 damage 前面的 \`choose\`、\`number\`、\`modify\` 先做，好让伤害用上选出来的值）。
   几个目标共用同一次掷骰（火球术）：在**第一次用到的分支里**写 \`id\`，其他分支用 \`ref\` 引用（可以加 \`scale: 0.5\` 减半）。不要在根上单独掷一次 —— 那会直接对目标造成一次伤害。
3. **需要目标的节点**（attack、save、写给 target 的节点）有多个目标时，会自动对每个目标各执行一次，不用自己包 \`forEach\`。\`targeting.count\` 是最多能选几个（玩家可以少选）。同一个生物能被选好几次、每次都结算一遍的（魔法飞弹的飞弹、灼热射线的射线、魔能爆的光束），写 \`targeting.repeat: true\`。
4. **触发器的执行顺序**：先付代价（cost），再应用 modify，最后执行 do。do 里读到的 \`roll\` 已经是 modify 之后的结果 ——
   所以「加完仍然失败就不消耗」可以写成：do 里 \`if roll.failing\` → \`{ kind: 'resource', id: …, delta: 1 }\` 把代价退回去。
5. **效应模板里的表达式**（效应的 rollMods、triggers、statics），\`self\` 是**承受这个效应的人**，\`source\` 是施加者。
   要用施加者那边的数值（施加者职业表里的骰子、施加时的环阶），在 \`applyEffect\` 上用 \`state\` 记下来：
   \`state: { die: "classTable('…')" }\` 在施加者的作用域里求值，之后在效应里用 \`effect.state.die\` 读。
6. **防御性的反应改 AC**（护盾术这类）：挂在 \`attackHit\` 的 before 窗口（防守方先问），施加一个加 AC 的效应即可。
   防守方处理完之后，引擎会**按新的 AC 重新判定**，不够就变成未命中。不要挂在 \`d20Rolled\` 上：那时这次攻击要对比的 AC 已经定了。
7. **升环公式**按原文逐环累加：「2 环 4d6，每高一环多 1d6」= \`(2 + slot.level)d6\`；「1 环 3d4，每高一环多 1d4」= \`(2 + slot.level)d4\`。代进最低环验算一遍。
8. **生物类型**（\`target.type\`）只有这些写法：${CREATURE_TYPES.join('、')}。
9. \`allyWithin(x, 尺, { exclude: [self], notCond: '失能' })\`：第三个参数可选，\`exclude\` 不算哪些人，\`notCond\` 要求那个盟友不处于某个状态。
10. 原文说「另一名生物」→ \`targeting.filter: 'target.id != self.id'\`。

${both ? sheetSection() : ''}## 8. 例子

${both
    ? '例子文件里是一批写好的条目（键 → Entry）；卡面那一侧照任务里另外给的那几条真实卡面数据写。'
    : '例子文件里是一批写好的条目（键 → Entry），照着它们的风格和粒度写。'}
`;
}

/* ───────────── 卡面那一节（mode: 'both' 时接在战斗那几节后面） ───────────── */

function sheetSection(): string {
  const mods = Object.entries(MOD_KIND_DOC).map(([k, d]) => `| \`${k}\` | ${d.doc} | ${d.fields} |`).join('\n');
  const grants = Object.entries(GRANT_KINDS)
    .map(([k, d]) => `| \`${k}\` | ${d.doc} | ${d.needs === 'values' ? '`values: […]`' : d.needs === 'formula' ? '`formula`' : '`text`'} |`)
    .join('\n');
  return `## 7. 卡面数据（静态层）怎么写

一条 part 的 \`sheet\` 描述**这张卡上恒定的东西**：改数值（mods）、授予实体（grants）、要玩家做的决定（choices）、
次数池（resources）。和 \`combat\` 用同一个条目键；一个能力两边都要写时写在一个 part 里。

### 7.1 \`mods\`：改数值

| kind | 是什么 | 怎么写 |
|---|---|---|
${mods}

每个 mod 都可以带 \`note\`（显示用的一句话）。

### 7.2 \`grants\`：授予实体（熟练、法术、专长…）

| kind | 是什么 | 要写 |
|---|---|---|
${grants}

### 7.3 \`choices\`：要玩家做的决定

\`{ "id": "…", "kind": "ability" | "skill" | "spell" | …, "label": "…", "pool": "…" 或 "from": [ … ], "count": 1 }\`。
\`pool\` 只能用这些（不在里面就给 \`from\` 数组）：${[...CHOICE_POOLS].join(' ')}。
**id 必须和 combat 里用到的对上**（选择的结果在战斗里用 \`vars\` / decisions 读）。

### 7.4 \`resources\`：次数池

\`{ "id": "rage", "name": "狂暴", "formula": "…", "recovery": "short" | "long" }\`。
\`formula\` 写法：数字、\`'pb'\`、\`'max(1, wis)'\`（属性调整值）、\`'level * 5'\`（level 是**该职业**等级）、
\`'cond(level >= 17, 6, 2)'\`、\`'table'\`（等级表里已经有了，别重复）。
战斗里花的写法：动作上 \`cost: [{ resource: '<id>' }]\`。

### 7.5 分界线（很重要）

- **恒定**的加值、熟练、授予、次数池上限 → \`sheet\`；
- **带条件的**（「豁免具有优势」「命中时加伤害」「失败时重骰」）→ \`combat\`；
- 「人物卡（静态层）已经算进去的」那一节列过的东西**不要重复写**（物品的固定加值、属性定值、固定的速度都算过了）；
- 引擎做不到的（传送、视线、光照）→ 照旧写 \`combat\` 里的 \`manual\` / \`note\`，卡面这一侧不要硬凑。

`;
}
