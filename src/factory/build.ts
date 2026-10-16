/**
 * 数据化工厂：从站点数据里取原文，从静态层取上下文，拼成任务。浏览器（自带密钥）和 Node（出题工具）共用。
 *
 * 资源 id 和职业表列名不靠猜：造一个 20 级的同职业角色（子职特性就带上子职），
 * 跑一遍真实的人物卡管线，桥接成战斗参与者，看它身上实际有哪些资源和列 —— 和真角色进战斗时一模一样。
 */
import { viewFromSheet } from '../bridge/from-sheet';
import type { CombatantView } from '../combat';
import { blankCharacter, type CharData, type Json, type SheetEnv } from '../sheet';
import { flattenEntries, type Task, type TaskInterface } from './task';

export interface TaskSource {
  env: SheetEnv;
  /** 读站点数据：`spells/index.json` 这种相对 data/ 的路径 */
  load(rel: string): Promise<Json>;
  /** 静态层能力数据（abilities-2024.json 的 entries） */
  abilities: Record<string, Json>;
  /** 探针角色算卡前调用（浏览器里给它标上战役，好让启用的书里的子职能找到） */
  tag?(char: CharData): void | Promise<void>;
}

type Probe = { resources: Record<string, string>; classTable: Record<string, string | number>; view: CombatantView };

const UNIT: Record<string, string> = { action: '动作', bonus: '附赠动作', reaction: '反应', minute: '分钟', hour: '小时', round: '轮' };
const RAR: Record<string, string> = { common: '普通', uncommon: '非普通', rare: '珍稀', 'very rare': '非常珍稀', legendary: '传说', artifact: '神器' };
const FEAT_CAT: Record<string, string> = { O: '起源专长', G: '通用专长', FS: '战斗风格专长', 'FS:P': '战斗风格专长', 'FS:R': '战斗风格专长', EB: '史诗恩惠' };

/** 可选特性的宿主：哪个职业（子职）的角色会选它 */
const OPT_HOST: Record<string, { cls: string; subclass?: string; label: string; extra?: string[] }> = {
  'MV:B': {
    cls: '战士', subclass: '战斗大师', label: '战斗大师的战技',
    extra: [
      "战技消耗卓越骰：`cost: [{ resource: '卓越骰' }]`。",
      "卓越骰的大小随战士等级变：`cond(self.levelOf('战士') >= 18, 1d12, cond(self.levelOf('战士') >= 10, 1d10, 1d8))`。",
      "战技的豁免 DC = 8 + 熟练加值 + 力量或敏捷调整值（取高）：`8 + self.pb + max(self.mod.str, self.mod.dex)`。",
    ],
  },
  EI: { cls: '魔契师', label: '魔契师的魔能祈唤' },
  MM: { cls: '术士', label: '术士的超魔法', extra: ["超魔法消耗术法点：`cost: [{ resource: 'sorcery_points', n: <点数> }]`。超魔法改的是「下一个施展的法术」，引擎还没有改写法术的机制，通常写成 manual 并说明。"] },
};

function spellTime(t: Json[]): string {
  return (t || []).map((x) => `${x.number ?? ''} ${UNIT[x.unit] ?? x.unit}${x.condition ? `（${flattenEntries(x.condition)}）` : ''}`.trim()).join(' 或 ');
}
function spellRange(r: Json): string {
  const d = r?.distance;
  if (!d) return String(r?.type ?? '—');
  if (d.type === 'self') return '自身';
  if (d.type === 'touch') return '触及';
  return `${d.amount ?? ''} ${d.type === 'feet' ? '尺' : d.type}`.trim();
}
function spellDuration(ds: Json[]): string {
  return (ds || []).map((d) => {
    if (d.type === 'instant') return '立即';
    if (d.type === 'timed') return `${d.duration?.amount ?? ''} ${UNIT[d.duration?.type] ?? d.duration?.type}`;
    if (d.type === 'permanent') return '永久';
    return String(d.type);
  }).join(' / ');
}

export function createTaskBuilder(src: TaskSource) {
  const probes = new Map<string, Promise<Probe>>();
  let classFiles: Promise<Json[]> | null = null;
  const classes = (): Promise<Json[]> => (classFiles ??= (async () => {
    const idx = await src.load('class/index.json') as Record<string, string>;
    return Promise.all(Object.values(idx).map((f) => src.load(`class/${f}`)));
  })());

  /** 法术文件：XPHB 以外的书按站点的 spells/index.json 找 */
  async function spellsOf(source: string): Promise<Json[]> {
    if (source === 'XPHB') return (await src.load('spells/spells-xphb.json')).spell;
    const idx = await src.load('spells/index.json') as Record<string, string>;
    const file = idx[source];
    if (!file) throw new Error(`站点没有 ${source} 的法术文件`);
    return (await src.load(`spells/${file}`)).spell;
  }

  /** 职业特性 / 子职特性：同名同级的几份里，优先给 2024 职业用的（classSource = XPHB） */
  async function findClassFeature(source: string, cls: string, name: string, level: number): Promise<{ hit: Json; sub: Json | null; sf: boolean } | null> {
    for (const file of await classes()) {
      const pickOne = (arr: Json[]) => {
        const hits = arr.filter((f) => f.source === source && f.className === cls && f.name === name && f.level === level);
        return hits.find((f) => f.classSource === 'XPHB') ?? hits[0] ?? null;
      };
      const cf = pickOne(file.classFeature || []);
      const sf = cf ? null : pickOne(file.subclassFeature || []);
      const hit = cf ?? sf;
      if (!hit) continue;
      const sub = sf ? (file.subclass || []).find((x: Json) => x.className === cls && x.shortName === sf.subclassShortName && x.source === sf.subclassSource && x.classSource === sf.classSource) ?? null : null;
      return { hit, sub, sf: !!sf };
    }
    return null;
  }

  /** 静态层能力数据：真的算了的（staticPart）和只是文字的备注（staticNotes）分开 */
  function staticOf(key: string): { staticPart: string[]; staticNotes: string[] } {
    const a = src.abilities[key];
    const part: string[] = [];
    const notes: string[] = [];
    if (!a) return { staticPart: part, staticNotes: notes };
    for (const m of a.mods || []) {
      if (m.kind === 'note') { notes.push(m.note); continue; }
      part.push(`修正 ${m.kind}：${JSON.stringify({ ...m, kind: undefined, note: undefined })}`);
      if (m.note) notes.push(m.note);
    }
    for (const g of a.grants || []) {
      if (g.kind === 'note') notes.push(g.text ?? '');
      else part.push(`授予 ${g.kind}：${(g.values || []).join('、')}`);
    }
    for (const r of a.resources || []) part.push(`资源池「${r.name}」（id ${r.id}）的上限：${r.formula}，${r.recovery === 'short' ? '短休' : '长休'}恢复`);
    for (const c of a.choices || []) part.push(`建卡时的选择：${c.label ?? c.id}`);
    return { staticPart: part, staticNotes: notes.filter(Boolean) };
  }

  /** 造一个 20 级角色，看它进战斗后的资源与职业表（同一职业 / 子职只算一次） */
  function probe(cls: string, subclass?: string): Promise<Probe> {
    const k = `${cls}/${subclass ?? ''}`;
    let p = probes.get(k);
    if (!p) {
      probes.set(k, (p = (async () => {
        const char: CharData = {
          ...blankCharacter(), name: '探针',
          abilities: { str: 14, dex: 14, con: 14, int: 14, wis: 14, cha: 14 },
          classes: [{ name: cls, level: 20, ...(subclass ? { subclass } : {}) }],
        };
        await src.tag?.(char);
        const sheet = await src.env.compute(char);
        const v = viewFromSheet(src.env, char, sheet);
        return { resources: v.resourceNames, classTable: v.classTable, view: v };
      })()));
    }
    return p;
  }

  /** 试算用的「持有者」：职业特性用 20 级探针角色，其余用一个通用角色（null） */
  async function ownerView(key: string): Promise<CombatantView | null> {
    const parts = key.split(':');
    if (parts.length === 4) {
      const [source, cls, name, lv] = parts;
      const f = await findClassFeature(source, cls, name, Number(lv));
      return f ? (await probe(cls, f.sub?.name)).view : null;
    }
    const opt = ((await src.load('optionalfeatures.json')).optionalfeature as Json[]).find((f) => f.source === parts[0] && f.name === parts.slice(1).join(':'));
    const host = opt ? OPT_HOST[(opt.featureType || [])[0]] : undefined;
    return host ? (await probe(host.cls, host.subclass)).view : null;
  }

  async function buildTask(id: string, key: string, iface?: TaskInterface): Promise<Task> {
    const parts = key.split(':');
    const source = parts[0];
    // 法术：<来源>:spell:<名字>
    if (parts[1] === 'spell') {
      const name = parts.slice(2).join(':');
      const sp = (await spellsOf(source)).find((s) => s.name === name);
      if (!sp) throw new Error(`找不到法术「${name}」`);
      return {
        id, key, name, kind: 'spell', where: sp.level ? `${sp.level} 环法术` : '戏法',
        text: flattenEntries(sp.entries),
        spell: {
          level: sp.level, time: spellTime(sp.time), range: spellRange(sp.range), duration: spellDuration(sp.duration),
          concentration: (sp.duration || []).some((d: Json) => d.concentration),
          higher: sp.entriesHigherLevel ? flattenEntries(sp.entriesHigherLevel) : undefined,
        },
        resources: {}, ...staticOf(key), interface: iface,
      };
    }
    // 物品：<来源>:item:<名字>
    if (parts[1] === 'item') {
      const name = parts.slice(2).join(':');
      const it = [...((await src.load('items.json')).item as Json[]), ...((await src.load('items-base.json')).baseitem as Json[])].find((x) => x.source === source && x.name === name);
      if (!it) throw new Error(`找不到物品「${name}」`);
      const magic = it.rarity && it.rarity !== 'none';
      const consumable = String(it.type ?? '').split('|')[0] === 'P' || (it.miscTags || []).includes('CNS');
      const resources: Record<string, string> = {};
      if (consumable) resources['物品:' + name] = `${name}（数量）`;
      if (Number(it.charges)) resources['物品充能:' + name] = `${name}（充能 ${it.charges}）`;
      return {
        id, key, name, kind: 'item',
        where: magic ? `魔法物品（${RAR[it.rarity] ?? it.rarity}${it.reqAttune ? '，需同调' : ''}）` : '冒险装备',
        text: flattenEntries(it.entries), resources, interface: iface,
        extra: [
          '物品的条目在**装备着**（需要同调的还要已同调）时生效；消耗品带在身上就能用。',
          ...(consumable ? [`这是消耗品：用一次的动作写 \`cost: [{ resource: '物品:${name}' }]\`（数量引擎自己管）。喝药水是附赠动作（activation: 'bonus'）；投掷类（炼金火、圣水、强酸瓶）是一次攻击或豁免。`] : []),
          ...(Number(it.charges) ? [`有 ${it.charges} 发充能：花充能写 \`cost: [{ resource: '物品充能:${name}', n: <几发> }]\`。充能怎么恢复（黎明）由长休处理，**不要**自己声明 resources。`] : []),
          '护甲、武器的 +N 和 AC / 豁免 / 法术攻击 / 法术 DC 的固定加值、属性定值、伤害抗性 / 免疫、固定的速度，人物卡已经算了（只要物品数据里有），**不要**再写 —— 只有这些的物品直接跳过。',
          '「消耗 1 发充能施展火球术」这类：写成动作，root 里照那个法术的效果写（DC 用物品写的数值，没写就用 self.spell.dc）。',
          `「长休（或黎明）前只能用一次」这类没有充能的次数：在条目顶层声明 \`resources: [{ id: '物品次数:${name}', name: '${name}', formula: 1, recovery: 'long' }]\`，动作写 \`cost: [{ resource: '物品次数:${name}' }]\`（一件物品有好几种次数，就用 '物品次数:${name}:<短名>'）。`,
        ],
        ...staticOf(key),
      };
    }
    // 职业 / 子职特性：<来源>:<职业>:<特性>:<等级>
    if (parts.length === 4) {
      const [, cls, name, lv] = parts;
      const level = Number(lv);
      const f = await findClassFeature(source, cls, name, level);
      if (!f) throw new Error(`找不到职业特性「${key}」`);
      const p = await probe(cls, f.sub?.name);
      return {
        id, key, name, kind: f.sf ? 'subclassFeature' : 'classFeature',
        where: `${cls} ${level} 级${f.sub ? `（${f.sub.name}${source !== 'XPHB' ? `，${source}` : ''}）` : ''}`,
        text: flattenEntries(f.hit.entries), classTable: p.classTable, resources: p.resources,
        ...staticOf(key), interface: iface,
      };
    }
    // 专长 / 可选特性 / 种族：<来源>:<名字>
    const name = parts.slice(1).join(':');
    const own: Record<string, string> = {};
    for (const r of src.abilities[key]?.resources || []) if (r.id) own[r.id] = r.name;

    const feat = ((await src.load('feats.json')).feat as Json[]).find((f) => f.source === source && f.name === name);
    if (feat) {
      return {
        id, key, name, kind: 'feat', where: `专长${feat.category ? `（${FEAT_CAT[feat.category] ?? feat.category}）` : ''}`,
        text: flattenEntries(feat.entries), resources: own, ...staticOf(key), interface: iface,
      };
    }
    const opt = ((await src.load('optionalfeatures.json')).optionalfeature as Json[]).find((f) => f.source === source && f.name === name);
    if (opt) {
      // 可选特性挂在哪个职业上：用那个职业（子职）的探针取资源
      const type = (opt.featureType || [])[0] as string;
      const host = OPT_HOST[type];
      const p = host ? await probe(host.cls, host.subclass) : { resources: {}, classTable: {} };
      return {
        id, key, name, kind: 'optfeature', where: `可选特性（${host?.label ?? type}）`,
        text: flattenEntries(opt.entries) + (opt.prerequisite ? `\n（前置条件：${JSON.stringify(opt.prerequisite)}）` : ''),
        classTable: p.classTable, resources: { ...p.resources, ...own }, ...staticOf(key), interface: iface,
        extra: host?.extra,
      };
    }
    const race = (((await src.load('races.json')).race || []) as Json[]).find((r) => r.source === source && r.name === name);
    if (race) {
      return {
        id, key, name, kind: 'race', where: '种族（下面是这个种族的全部特质，写成一个条目）',
        text: flattenEntries(race.entries), resources: own, ...staticOf(key), interface: iface,
      };
    }
    throw new Error(`找不到专长 / 可选特性 / 种族「${name}」`);
  }

  return { buildTask, ownerView, findClassFeature, spellsOf, staticOf };
}
