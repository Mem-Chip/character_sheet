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

/** 伤害类型（站点 2024 译名） */
export const DAMAGE_TYPES = ['钝击', '穿刺', '挥砍', '火焰', '寒冷', '闪电', '雷鸣', '强酸', '毒素', '黯蚀', '光耀', '心灵', '力场'];
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
  ['d20Rolled', 'before', '掷骰者 / 攻击检定的目标', 'roll（还没判定；roll.failing = 按现在的结果会失败）、attack', 'reroll、addToRoll'],
  ['d20Rolled', 'after', '同上', 'roll（已判定）、attack', '—'],
  ['attackHit', 'before', '攻击者 / 被命中者', 'attack、roll。先问防守方，再问进攻方', '防守方：halveDamage、cancel；进攻方用 do 里的 addDamage 加伤害'],
  ['attackHit', 'after', '同上', 'attack、roll、damage（已结算）', '—'],
  ['attackMissed', 'after', '攻击者 / 目标', 'attack、roll', '—'],
  ['saveForced', 'after', '迫使豁免的人 / 豁免的人', '—', '—'],
  ['damageIncoming', 'before', '伤害来源 / 承受者', 'damage（掷出来的总数）、attack', 'reduceDamage、halveDamage、cancel'],
  ['damageTaken', 'after', '来源 / 承受者', 'damage', '—'],
  ['reducedTo0', 'before', '来源 / 承受者', 'damage', 'setHp（「改为降到 1」这类）'],
  ['turnStarted / turnEnded', 'after', '回合的主人', '—', '—'],
  ['spellCast', 'after', '施法者', 'event.spell、event.key', '—'],
  ['initiativeRolled', 'after', '掷先攻的人', '—', '—'],
  ['restCompleted', 'after', '休息的人', 'event.kind（short / long）', '—'],
];

export interface SpecInput {
  /** src/combat/types.ts 的源码（Node 里 readFileSync，浏览器里 `?raw` 导入） */
  typesSource: string;
}

export function buildSpec(input: SpecInput): string {
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

  return `# 动态层规则数据：写法说明

你要把一条 D&D 2024 规则（职业特性、专长、法术）写成引擎能执行的 JSON。

## 1. 产出什么

一个 JSON 对象，类型是下面的 \`Entry\`，描述这条规则**在游戏进行中、按时机生效**的部分：
主动使用的动作（actions）、在某个时机触发的能力（triggers）、对检定的修正（rollMods）、灵光（auras）、它施加的效应（effects）。

**不要写静态部分**：属性加值、熟练、授予法术、资源池上限、恒定的 AC / 速度加值，人物卡已经算好了（任务里会列出来）。
条件性的东西才写在这里：「豁免具有优势」「命中时加伤害」「失败时可以重骰」。

只输出这个 JSON 对象本身，不要包在别的结构里，不要解释。

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

效应的 \`duration.endsOn\` 可以监听的事件：${[...EMITTED_EVENTS].map((e) => `\`${e}\``).join('、')}。
\`endsOn\` 的 \`when\` 里，\`event\` 是事件内容（d20Rolled 有 \`kind\`、\`roller\`、\`target\`、\`total\`；effectApplied 有 \`bearer\`、\`name\`），\`self\` 是效应的承受者。

## 5. 约定（照着做）

1. **主动用的能力** → \`actions\`。动作的 \`id\` 和 \`name\` 用任务「接口」里给的。\`activation\`：动作 action、附赠动作 bonus、反应 reaction、不占动作 free、武器式的一次攻击 none（配 \`cost: [{ economy: 'attack' }]\`）。
2. **玩家可以选择用不用**的 → \`optional: true\`（引擎会问）；每回合一次 → \`limit: 'oncePerTurn'\`。
3. **花资源** → \`cost: [{ resource: '<id>' }]\`，id **只能**用任务里列出的。法术位 → \`cost: [{ slot: { min: <环> } }]\`，升环效果写在表达式里（\`slot.level\`）。
4. **由事件触发、还要花附赠动作或反应**的（护盾术、至圣斩）→ 写成 \`actions\` 里带 \`trigger\` 的动作；代价按 \`activation\` 自动算。只能在自己回合用的加 \`requires: 'turn.isMine'\`。
5. **命中时加伤害**（偷袭类）→ \`attackHit\` before 窗口、\`role: 'actor'\`，\`do: [{ kind: 'addDamage', … }]\`；跟武器同类型就写 \`type: 'attack.damageType'\`。
6. **「检定失败时」** → \`d20Rolled\` before 窗口，\`when\` 里用 \`roll.failing\`。可选能力只在会改变结果时才提供，别让玩家每次掷骰都被问。
7. **持续时间**：\`until.nth: 0\` = 本回合，\`1\` = 下一个回合；\`of: 'bearer'\`（承受者的回合）或 \`'source'\`（施加者的回合）。「直到你的下一回合开始」施加在别人身上 → \`{ until: { at: 'turnStart', of: 'source', nth: 1 } }\`。没有写持续时间的效应要手动移除，一般都该写。
8. **引用效应**：状态用全键 \`'XPHB:condition:<名>'\`；通用动作的效应 \`'XPHB:action:<名>#<效应名>'\`；本条目自己的效应写在 \`effects\` 里、用名字引用。可用的状态：目盲 魅惑 耳聋 力竭 恐慌 受擒 失能 隐形 麻痹 石化 中毒 倒地 束缚 震慑 昏迷。
9. **专注**写在动作的 \`concentration\` 上（时长）；这个动作施加的效应默认随专注结束。
10. **法术**的动作 \`tags: ['spell', 'magical']\`，动作 id 一般是 \`cast\`。
11. **名字**：动作 \`name\`、触发器 \`label\`、检定修正 \`label\` 都以能力的中文名开头（可以加「：说明」）。回执和弹窗上显示的就是它。
12. **让人选**：几个选项选一个 → \`choose\` 节点（选项可以带 \`when\`，条件不满足就不列）；选一个数 → \`number\` 节点，结果在 \`vars.<var>\`。
13. **引擎做不到的**（移动、视线、地形）→ \`move\` / \`note\` 节点，或在 \`when\` 里用 \`ask('…')\` 问人。**没把握就整条写成 \`{ "automation": "manual", "text": "…" }\`**：不自动化，比写错强。
14. 伤害类型用中文：${DAMAGE_TYPES.join(' ')}。技能用中文：${SKILLS.join(' ')}。
15. 恒定的数值（AC +1、速度 +10、熟练）不写；只有带条件的写成 \`rollMods\` / \`statics\`（在效应里）。

## 6. 例子

例子文件里是一批写好的条目（键 → Entry），照着它们的风格和粒度写。
`;
}
