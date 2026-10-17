/**
 * 生成「覆盖率审查」工作包（audit-review/）：把每条动态数据 + 规则原文 + 旧审查意见，
 * 按每批 20 条写成 JSON，连同说明书和引擎接口速查表一起交给外部 agent 逐条过。
 *
 * 用法：npm run review:pack（= npx tsx tools/make-review-package.ts）
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';

const OUT = 'audit-review';
const BATCH = 10;
const MAX_TEXT = 900;
const MAX_DATA = 3200;

type AnyRec = Record<string, any>;

/* ---------- 1. 读所有动态数据 ---------- */
const FILES = [
  'data/dyn/features.json', 'data/dyn/spells.json', 'data/rules-2024.json',
  ...readdirSync('data/dyn/ai').filter((f) => f.endsWith('.json')).map((f) => `data/dyn/ai/${f}`),
];
/** 键 → 合并后的条目（后读的盖前面的，和 RuleBook 的顺序一致） */
const entries = new Map<string, { e: AnyRec; file: string }>();
for (const f of FILES) {
  const j = JSON.parse(readFileSync(f, 'utf8')) as { entries: Record<string, AnyRec> };
  for (const [k, e] of Object.entries(j.entries ?? {})) entries.set(k, { e, file: f });
}

/* ---------- 2. 读旧的审查报告（可能过时，作为线索给审查者） ---------- */
const oldAudit = new Map<string, { gap: string; need: string; now: boolean }>();
try {
  for (const f of readdirSync('datafy/manual-audit/answers')) {
    for (const r of JSON.parse(readFileSync(`datafy/manual-audit/answers/${f}`, 'utf8')) as AnyRec[]) {
      oldAudit.set(r.key, { gap: r.gap, need: r.need, now: !!r.now });
    }
  }
} catch { /* 没有就算了 */ }

/* ---------- 3. 摘要：动作 / 触发器 / 效应 / 资源，够判断就行 ---------- */
const kindsOf = (nodes: AnyRec[] | undefined): string[] => [...new Set((nodes ?? []).map((n) => String(n?.kind ?? '?')))];
const briefAction = (a: AnyRec) => ({
  id: a.id, name: a.name, activation: a.activation,
  cost: a.cost ?? [], targeting: a.targeting ?? null,
  trigger: a.trigger ?? null, concentration: a.concentration ?? null,
  requires: a.requires ?? null,
  root: kindsOf(a.root),
});
const briefTrigger = (t: AnyRec) => ({
  id: t.id, label: t.label, on: t.on, role: t.role ?? null, window: t.window ?? 'after',
  when: t.when ?? null, cost: t.cost ?? [],
  modify: (t.modify ?? []).map((m: AnyRec) => m.op), do: kindsOf(t.do),
});
const summarize = (e: AnyRec) => ({
  automation: e.automation ?? '?',
  actions: (e.actions ?? []).map(briefAction),
  triggers: (e.triggers ?? []).map(briefTrigger),
  effects: Object.entries(e.effects ?? {}).map(([name, t]) => ({
    name,
    statics: ((t as AnyRec).statics ?? []).map((s: AnyRec) => s.kind),
    flags: (t as AnyRec).flags ?? null,
    rollMods: ((t as AnyRec).rollMods ?? []).length,
    triggers: ((t as AnyRec).triggers ?? []).length,
    duration: (t as AnyRec).duration ?? null,
  })),
  resources: (e.resources ?? []).map((r: AnyRec) => ({ id: r.id, name: r.name, formula: r.formula, recovery: r.recovery })),
});

/* ---------- 4. 只挑「不是 full」的条目 ---------- */
const tasks: AnyRec[] = [];
for (const [key, { e, file }] of entries) {
  if (e.automation === 'full') continue;
  const text = String(e.text ?? '').slice(0, MAX_TEXT);
  const data = summarize(e);
  const dataJson = JSON.stringify(data);
  tasks.push({
    key,
    name: e.name ?? key,
    kind: key.includes(':spell:') ? 'spell' : key.includes(':item:') ? 'item' : key.includes(':怪物:') ? 'monster'
      : key.split(':').length === 4 ? 'classFeature' : key.includes(':') ? 'feature' : 'other',
    from: file,
    automation: e.automation ?? '?',
    text,
    ...(text.length >= MAX_TEXT ? { text_truncated: true } : {}),
    data: dataJson.length <= MAX_DATA ? data : { ...data, _truncated: true },
    old_audit: oldAudit.get(key) ?? null,
  });
}

/* ---------- 5. 写包 ---------- */
rmSync(`${OUT}/tasks`, { recursive: true, force: true });
mkdirSync(`${OUT}/tasks`, { recursive: true });
mkdirSync(`${OUT}/answers`, { recursive: true });

const index: AnyRec[] = [];
for (let i = 0; i < tasks.length; i += BATCH) {
  const slice = tasks.slice(i, i + BATCH);
  const no = String(i / BATCH + 1).padStart(3, '0');
  const file = `batch-${no}.json`;
  writeFileSync(`${OUT}/tasks/${file}`, JSON.stringify({ batch: `batch-${no}`, count: slice.length, entries: slice }, null, 1) + '\n');
  index.push({ batch: `batch-${no}`, file: `tasks/${file}`, count: slice.length, keys: slice.map((t) => t.key) });
}
writeFileSync(`${OUT}/tasks/index.json`, JSON.stringify({ total: tasks.length, batches: index.length, items: index }, null, 1) + '\n');
writeFileSync(`${OUT}/answers/.gitkeep`, '');

/* ---------- 6. 接口速查表 ---------- */
const iface = readFileSync('src/combat/types.ts', 'utf8');
const ops = /MODIFY_OPS|'reroll'/.test(iface) ? null : null;   // 真实清单手写在下面
const interfaces = `# 引擎接口速查（写数据前先看这一页）

> 数据格式的权威定义在 \`src/combat/types.ts\`；给 AI 写数据用的完整说明书在 \`src/factory/spec.ts\`
> （\`npm run spec\` 能生成纯文本版）。这一页只是审查时快速对照用。

## 1. 「动作」能写什么（\`actions[]\`）

\`\`\`json
{ "id": "cast", "name": "显示名", "activation": "action | bonus | reaction | free | none",
  "tags": ["spell", "magical"], "cost": [{ "slot": { "min": 1 } }],
  "concentration": { "rounds": 10 },
  "targeting": { "type": "self | creature | point | area", "count": 1, "range": 60, "filter": "…", "area": {…} },
  "trigger": { "on": "spellCast", "role": "any", "aim": "actor" },
  "requires": "…表达式…", "root": [ …节点… ] }
\`\`\`

- **代价**（\`cost\`）：\`{slot:{min,max}}\`、\`{economy:'action'|'bonus'|'reaction'|'attack'}\`、
  \`{resource:'池子 id', n?}\`、\`{item:'物品名'}\`、\`{hp:N}\`、\`{hitDie:{faces,count}}\` 等（见 \`Cost\`）。
- **窗口触发的动作**（\`trigger\`）：配合 \`role\`（actor / target / any）与 \`aim: 'actor'\`。
- **一次性动作**（池子消耗、充能）用 \`requires\` 表条件。

## 2. 节点（\`root\` / \`do\` / \`onHit\` 里用）

\`attack\`、\`save\`、\`check\`、\`damage\`、\`addDamage\`、\`heal\`、\`tempHp\`、\`applyEffect\`、\`removeEffect\`、
\`extendEffect\`、\`endConcentration\`、\`grantAction\`、\`removeGrant\`、\`castFrom\`、\`modifyCast\`、
\`resource\`、\`economy\`、\`choose\`、\`if\`、\`forEach\`、\`repeat\`、\`move\`、\`note\`、\`number\`、\`modify\`、\`zone\`、\`summon\`。

常用的几个：

| 节点 | 用途 |
|---|---|
| \`attack\` | 攻击检定（\`bonus\` 缺省 \`self.spell.atk\`）+ \`onHit\` / \`onMiss\` |
| \`save\` | 豁免（\`ability\` / \`dc\` / \`to\` / \`onFail\` / \`onSuccess\`；\`to: 'attacker'\` 打施法者） |
| \`damage\` | 立刻造成伤害（\`dice\` / \`type\` / \`to\` / \`scale: 0.5\` = 半伤） |
| \`applyEffect\` | 挂效应（\`template\` 相对本条目的 \`effects\` 名，或绝对键；\`to\` / \`duration\`） |
| \`choose\` | 让人选：写死 \`options\`，或 \`pool: { from: 'ownSpells' | 'ownCantrips', maxLevel?, castTime?, singleTarget? }\` |
| \`grantAction\` | 临时给一个动作（\`from\` / \`fromVar\` / \`action\`；可改 \`cost\` / \`activation\` / \`targeting\`；\`until: 'turnEnd'\`） |
| \`castFrom\` | 借前面挑中的那道动作**当场结算**（\`fromVar\` + \`to: 'attacker' | 'target' | 'self' | 'each'\`） |
| \`modifyCast\` | 改**正在施展的那道法术**（\`cancel\` / \`dc\` / \`attackBonus\` / \`damageType\`） |
| \`move\` | \`mode: 'push' | 'pull' | 'teleport'\`（推拉自动，传送会让界面选落点） |
| \`zone\` | 地图区域（进入 / 回合开始 / 结束触发） |
| \`summon\` | 召唤（\`count\` / \`group\` 同组顶替） |
| \`if\` / \`forEach\` / \`repeat\` / \`number\` / \`note\` | 控制流与提示 |

## 3. 触发器（\`triggers[]\`）

\`\`\`json
{ "id": "t1", "label": "显示名", "on": "damageIncoming", "window": "before | after",
  "role": "actor | target | any | ally", "when": "…表达式…", "cost": [ … ],
  "modify": [{ "op": "…" }], "do": [ …节点… ], "aim": "actor", "limit": "oncePerTurn | oncePerRound" }
\`\`\`

**窗口事件**（\`on\`）：\`turnStarted\`、\`turnEnded\`、\`turnEnding\`、\`initiativeRolled\`、\`spellCast\`、\`d20Rolled\`、
\`attackHit\`、\`attackMissed\`、\`saveForced\`、\`damageIncoming\`、\`damageTaken\`、\`reducedTo0\`、\`restCompleted\`、
\`leftReach\`、\`roundStarted\`、\`combatStarted\`、\`combatEnded\`。

**modify 的 op**：\`reroll\`、\`addToRoll\`、\`reduceDamage\`、\`halveDamage\`、\`doubleDamage\`、\`setHp\`、\`cancel\`（可 \`refundSlot\`）、
\`cancelUnlessSave\`（引擎先掷豁免，失败才打断）、\`unlessSave\`（引擎先掷豁免，按结果应用子修改：\`setDc\` / \`setAttackBonus\` / \`setDamageType\` / \`cancel\`）、
\`evasion\`、\`succeed\`、\`redirect\`、\`absorb\`、\`clearAdv\`。

> ⚠️ 窗口的 \`modify\` 是**同步求值**的，触发器的 \`do\` **不保证**在结算之前执行。
> 所以「先掷豁免、失败了才改/打断」必须用 \`unlessSave\` / \`cancelUnlessSave\`，不能先 \`do\` 里掷再改。

## 4. 效应的旗标（\`effects[…].flags\`）

\`blocks: ['action' | 'bonus' | 'reaction']\`（经济视为 0）、\`breaksConcentration\`、
\`cannot: ['concentrate' | 'castSpells' | 'speak' | 'see' | 'hear' | 'perceive' | 'moveCloser:…' | 'opportunityAttack' | 'provoke']\`、
\`forbidTarget: 'source'\`、\`quicken\`。

效应还能带：\`statics\`（\`ac\` / \`speed\` / \`resist\` / \`save\` / \`spellDc\` / \`attack\` …）、\`rollMods\`、
\`triggers\`、\`aura\`（\`grant\` 里的 \`statics\` 会并进范围内生物的 view）、\`implies\`、\`onApply\` / \`onEnd\`、\`duration\`。

## 5. 明确做不到的（别硬写）

- 视线 / 光照 / 掩护 / 隐蔽的判定（没有地图几何）；
- 三维高度、滞空、坠落；
- 两个生物**换位**；
- 「改写另一道法术的施法时间 / 成分 / 专注」这类（除了上面第 3 节的 4 个 plan 字段）；
- 变形（替换整张数据卡）、改变体型；
- 骰池（生命骰、偷袭骰）的扣除。
`;
writeFileSync(`${OUT}/interfaces.md`, interfaces);

/* ---------- 7. 说明书 ---------- */
const readme = `# 覆盖率审查工作包（audit-review）

这个包是给**外部 agent** 的：逐条判断「引擎能不能把这条规则完全自动结算」，不能的话说清缺什么。

## 目录

| 文件 | 内容 |
|---|---|
| \`interfaces.md\` | **先读这个**：引擎现在能做什么（动作 / 节点 / 触发器 / 旗标 / 明确做不到的清单） |
| \`tasks/index.json\` | 总共多少条、分成多少批、每批包含哪些键 |
| \`tasks/batch-NNN.json\` | 每批 ${BATCH} 条：规则原文、现在的数据摘要、旧的审查意见（可能过时） |
| \`answers/batch-NNN.json\` | **你的产出**，和 tasks 同名 |
| \`../tools/check-review.ts\` | 自检脚本：\`npx tsx tools/check-review.ts\` 会校验格式 + 跑一遍数据检查 |

## 一条任务长什么样

\`\`\`json
{
  "key": "XPHB:spell:某某术",
  "name": "某某术",
  "kind": "spell",
  "automation": "partial",
  "text": "规则原文（可能被截断到 900 字）",
  "data": { "automation": "partial", "actions": [...], "triggers": [...], "effects": [...], "resources": [...] },
  "old_audit": { "gap": "旧审查的归类", "need": "旧审查认为缺什么", "now": false }
}
\`\`\`

\`old_audit\` **只是线索，可能过时**（引擎这几个月加了不少接口）。以 \`interfaces.md\` 和 \`data\` 为准。

## 你要产出什么（每批一个文件，同名）

\`\`\`json
{
  "batch": "batch-001",
  "answers": [
    {
      "key": "XPHB:spell:某某术",
      "verdict": "full | partial | manual",
      "why": "一句话：这条规则的哪部分自动了、哪部分没有（引用原文片段）",
      "missing": ["缺少的接口名或能力（用 interfaces.md 里的说法）"],
      "patch": { "…可选：能改成什么样，直接给 data 里的条目 JSON…" }
    }
  ]
}
\`\`\`

### verdict 怎么判

- **full**：原文里的数值、时机、限制全都能由现有接口自动完成；玩家只需要点一下动作、回答必要的选择。
- **partial**：有自动化，但还有一部分必须人来（写清是哪部分、以及为什么引擎做不了）。
- **manual**：现在只有说明文字，没有任何自动结算。

### 判断纪律

1. **只认原文**。不要按 2014 版或记忆里的规则写；\`text\` 就是这条的规则原文。
2. **能自动就别说做不到**。先在 \`interfaces.md\` 里找有没有对应的节点 / op / 旗标；
   找不到再考虑「能不能用别的写法绕」（比如用 \`note\` + \`ask\` 让 DM 确认，或拆成两个动作）。
3. \`missing\` 里不要写「引擎不支持」，要写**具体缺什么**，例如
   「缺少把目标移出战场并从先攻条隐藏的接口」「缺少改另一道正在施展法术的射程」。
4. 已经有数据但不是 full 的，优先判断：**能不能用现有接口把剩下的补上**。能就写 \`verdict: "full"\` + \`patch\`。
5. 同一条不要重复评论多遍；一批里每个 key 一条。

## 提示

- 一批 ${BATCH} 条，逐条看完再写，别抽样。
- \`patch\` 里的 JSON 只要包含你要改的字段就行（引擎是按字段合并的）。
- 拿不准的宁可写 \`partial\` + 说明，也不要谎报 \`full\`。
`;
writeFileSync(`${OUT}/README.md`, readme);

console.log(`✓ 生成 ${OUT}/：${tasks.length} 条待审，分 ${index.length} 批（每批 ${BATCH}）`);
const byKind = new Map<string, number>();
for (const t of tasks) byKind.set(t.kind, (byKind.get(t.kind) ?? 0) + 1);
console.log('  按类型：' + [...byKind.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' '));

