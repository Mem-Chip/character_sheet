/**
 * 数据化工厂（Node 侧）：从本地站点数据里取原文，从静态层取上下文，拼成任务。
 *
 * 资源 id 和职业表列名不靠猜：造一个 20 级的同职业角色（子职特性就带上子职），
 * 跑一遍真实的人物卡管线，桥接成战斗参与者，看它身上实际有哪些资源和列 —— 和真角色进战斗时一模一样。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { viewFromSheet } from '../../src/bridge/from-sheet';
import { flattenEntries, type Task, type TaskInterface } from '../../src/factory';
import { blankCharacter, type CharData, type Json, type SheetEnv } from '../../src/sheet';
import type { CombatantView } from '../../src/combat';

const DATA = resolve(import.meta.dirname, '..', '..', 'data', '5etools', 'data');
const read = (p: string): Json => JSON.parse(readFileSync(resolve(DATA, p), 'utf8'));
const abilities = (JSON.parse(readFileSync(resolve(import.meta.dirname, '..', '..', 'data', 'abilities-2024.json'), 'utf8')) as Json).entries as Record<string, Json>;

let classFiles: Json[] | null = null;
/** 法术文件：XPHB 以外的书按站点的 spells/index.json 找 */
export function spellsOf(source: string): Json[] {
  if (source === 'XPHB') return read('spells/spells-xphb.json').spell;
  const idx = read('spells/index.json') as Record<string, string>;
  const file = idx[source];
  if (!file) throw new Error(`站点没有 ${source} 的法术文件`);
  return read(`spells/${file}`).spell;
}
/** 职业特性 / 子职特性：同名同级的几份里，优先给 2024 职业用的（classSource = XPHB） */
export function findClassFeature(src: string, cls: string, name: string, level: number): { hit: Json; sub: Json | null; sf: boolean } | null {
  for (const file of classes()) {
    const pickOne = (arr: Json[]) => {
      const hits = arr.filter((f) => f.source === src && f.className === cls && f.name === name && f.level === level);
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

const classes = (): Json[] => (classFiles ??= readdirSync(resolve(DATA, 'class')).filter((f) => f.startsWith('class-')).map((f) => read(`class/${f}`)));

const UNIT: Record<string, string> = { action: '动作', bonus: '附赠动作', reaction: '反应', minute: '分钟', hour: '小时', round: '轮' };

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

/** 静态层能力数据：真的算了的（staticPart）和只是文字的备注（staticNotes）分开 */
function staticOf(key: string): { staticPart: string[]; staticNotes: string[] } {
  const a = abilities[key];
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

type Probe = { resources: Record<string, string>; classTable: Record<string, string | number>; view: CombatantView };
const probes = new Map<string, Promise<Probe>>();

/** 造一个 20 级角色，看它进战斗后的资源与职业表（同一职业 / 子职只算一次） */
function probe(env: SheetEnv, cls: string, subclass?: string): Promise<Probe> {
  const k = `${cls}/${subclass ?? ''}`;
  let p = probes.get(k);
  if (!p) probes.set(k, (p = probeOnce(env, cls, subclass)));
  return p;
}

async function probeOnce(env: SheetEnv, cls: string, subclass?: string): Promise<Probe> {
  const char: CharData = {
    ...blankCharacter(), name: '探针',
    abilities: { str: 14, dex: 14, con: 14, int: 14, wis: 14, cha: 14 },
    classes: [{ name: cls, level: 20, ...(subclass ? { subclass } : {}) }],
  };
  const sheet = await env.compute(char);
  const v = viewFromSheet(env, char, sheet);
  return { resources: v.resourceNames, classTable: v.classTable, view: v };
}

/** 试算用的「持有者」：职业特性用 20 级探针角色，其余用一个通用角色 */
export async function ownerView(env: SheetEnv, key: string): Promise<CombatantView | null> {
  const parts = key.split(':');
  if (parts.length === 4) {
    const [src, cls, name, lv] = parts;
    const f = findClassFeature(src, cls, name, Number(lv));
    return f ? (await probe(env, cls, f.sub?.name)).view : null;
  }
  const opt = (read('optionalfeatures.json').optionalfeature as Json[]).find((f) => f.source === parts[0] && f.name === parts.slice(1).join(':'));
  const host = opt ? OPT_HOST[(opt.featureType || [])[0]] : undefined;
  return host ? (await probe(env, host.cls, host.subclass)).view : null;
}

export async function buildTask(env: SheetEnv, id: string, key: string, iface?: TaskInterface): Promise<Task> {
  const parts = key.split(':');
  const src = parts[0];
  // 法术：<来源>:spell:<名字>
  if (parts[1] === 'spell') {
    const name = parts.slice(2).join(':');
    const sp = spellsOf(src).find((s) => s.name === name);
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
  // 职业 / 子职特性：<来源>:<职业>:<特性>:<等级>
  if (parts.length === 4) {
    const [, cls, name, lv] = parts;
    const level = Number(lv);
    const f = findClassFeature(src, cls, name, level);
    if (!f) throw new Error(`找不到职业特性「${key}」`);
    const p = await probe(env, cls, f.sub?.name);
    return {
      id, key, name, kind: f.sf ? 'subclassFeature' : 'classFeature',
      where: `${cls} ${level} 级${f.sub ? `（${f.sub.name}${src !== 'XPHB' ? `，${src}` : ''}）` : ''}`,
      text: flattenEntries(f.hit.entries), classTable: p.classTable, resources: p.resources,
      ...staticOf(key), interface: iface,
    };
  }
  // 专长 / 可选特性 / 种族：XPHB:<名字>
  const name = parts.slice(1).join(':');
  const own: Record<string, string> = {};
  for (const r of abilities[key]?.resources || []) if (r.id) own[r.id] = r.name;

  const feat = (read('feats.json').feat as Json[]).find((f) => f.source === src && f.name === name);
  if (feat) {
    return {
      id, key, name, kind: 'feat', where: `专长${feat.category ? `（${FEAT_CAT[feat.category] ?? feat.category}）` : ''}`,
      text: flattenEntries(feat.entries), resources: own, ...staticOf(key), interface: iface,
    };
  }
  const opt = (read('optionalfeatures.json').optionalfeature as Json[]).find((f) => f.source === src && f.name === name);
  if (opt) {
    // 可选特性挂在哪个职业上：用那个职业（子职）的探针取资源
    const type = (opt.featureType || [])[0] as string;
    const host = OPT_HOST[type];
    const p = host ? await probe(env, host.cls, host.subclass) : { resources: {}, classTable: {}, view: null };
    return {
      id, key, name, kind: 'optfeature', where: `可选特性（${host?.label ?? type}）`,
      text: flattenEntries(opt.entries) + (opt.prerequisite ? `\n（前置条件：${JSON.stringify(opt.prerequisite)}）` : ''),
      classTable: p.classTable, resources: { ...p.resources, ...own }, ...staticOf(key), interface: iface,
      extra: host?.extra,
    };
  }
  const race = ((read('races.json').race || []) as Json[]).find((r) => r.source === src && r.name === name);
  if (race) {
    return {
      id, key, name, kind: 'race', where: '种族（下面是这个种族的全部特质，写成一个条目）',
      text: flattenEntries(race.entries), resources: own, ...staticOf(key), interface: iface,
    };
  }
  throw new Error(`找不到专长 / 可选特性 / 种族「${name}」`);
}

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
