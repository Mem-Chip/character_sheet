/**
 * 术语查表：给悬浮窗用。名字（+ 类别、来源）→ 5etools 里的那一条。
 *
 * 类别就是 5etools 标签的名字（spell、condition、feat、item、skill、action、variantrule…），
 * 所以正文里的 {@spell 火球术} 直接能查；界面上自己写的名字（法术列表、技能表）也用同样的类别。
 * 数据按需装载：第一次查某一类时才去取那份文件（职业特性要取职业文件）。
 */
import { CLASS_SLUG_BY_NAME, SCHOOL_CN, fmtPrereq, type Json } from '../../src/sheet';
import type { Engine } from './engine';

export interface TermRef { kind: string; name: string; source?: string; cls?: string; level?: number }
export interface TermData { kind: string; name: string; source: string; kindLabel: string; meta: string[]; entries: Json[] }

export const KIND_LABEL: Record<string, string> = {
  spell: '法术', condition: '状态', status: '状态', disease: '疾病', feat: '专长', optfeature: '可选特性', item: '物品',
  skill: '技能', action: '动作', sense: '感官', variantrule: '规则', language: '语言', race: '种族', background: '背景',
  classFeature: '职业特性', subclassFeature: '子职特性', itemMastery: '武器精通', itemProperty: '武器属性',
};

/** 类别 → [数据键, 数组名]；一个类别可以查好几份 */
const TABLES: Record<string, Array<[string, string]>> = {
  spell: [['spellsXphb', 'spell']],
  condition: [['conditions', 'condition'], ['conditions', 'status']],
  status: [['conditions', 'status'], ['conditions', 'condition']],
  disease: [['conditions', 'disease']],
  feat: [['feats', 'feat']],
  optfeature: [['optionalfeatures', 'optionalfeature']],
  item: [['items', 'item'], ['itemsBase', 'baseitem']],
  skill: [['skills', 'skill']],
  action: [['actions', 'action']],
  sense: [['senses', 'sense']],
  variantrule: [['variantrules', 'variantrule']],
  language: [['languages', 'language']],
  race: [['races', 'race']],
  background: [['backgrounds', 'background']],
  itemMastery: [['itemsBase', 'itemMastery']],
  itemProperty: [['itemsBase', 'itemProperty']],
};

export const canLookup = (kind: string) => kind in TABLES || kind === 'classFeature' || kind === 'subclassFeature' || kind === 'auto';

/** 规则条目键 → 术语：`XPHB:spell:名`、`XPHB:action:名`、`XPHB:condition:名`、职业特性 `XPHB:职业:名:等级`、其余 `XPHB:名` */
export function termOfKey(key: string): TermRef | null {
  const p = key.split('#')[0].split(':');
  if (p.length === 4) return { kind: 'classFeature', cls: p[1], name: p[2], level: Number(p[3]) || undefined };
  if (p.length === 3 && ['spell', 'action', 'condition'].includes(p[1])) return { kind: p[1], name: p[2] };
  if (p.length === 2 && p[0] !== 'HR') return { kind: 'auto', name: p[1] };
  return null;
}
/** 不知道类别时按这个顺序找 */
const AUTO = ['feat', 'optfeature', 'spell', 'condition', 'action', 'item', 'race', 'background'];

/** 同名多条时：指定来源的优先，其次 2024（XPHB / XDMG / XMM），最后随便一条 */
function pick(list: Json[], name: string, source?: string): Json | null {
  const hits = list.filter((x) => x?.name === name || x?.abbreviation?.split('|')[0] === name);
  if (!hits.length) return null;
  const src = source?.toUpperCase();
  return (src && hits.find((x) => String(x.source).toUpperCase() === src))
    || hits.find((x) => /^X(PHB|DMG|MM)$/.test(x.source)) || hits[0];
}

const UNIT: Record<string, string> = { action: '动作', bonus: '附赠动作', reaction: '反应', minute: '分钟', hour: '小时', day: '天', round: '轮', turn: '回合', week: '周', year: '年' };
const RARITY: Record<string, string> = { common: '普通', uncommon: '非普通', rare: '珍稀', 'very rare': '非常珍稀', legendary: '传说', artifact: '神器', none: '' };

function spellMeta(s: Json): string[] {
  const out: string[] = [`${s.level ? `${s.level} 环` : '戏法'} · ${SCHOOL_CN[s.school] ?? s.school}${s.meta?.ritual ? '（仪式）' : ''}`];
  const t = (s.time || [])[0];
  if (t) out.push(`施法时间：${t.number ?? 1} ${UNIT[t.unit] ?? t.unit}${t.condition ? `，${t.condition}` : ''}`);
  const r = s.range;
  if (r) {
    const d = r.distance || {};
    out.push('射程：' + (d.type === 'self' ? '自身' : d.type === 'touch' ? '触及' : d.type === 'sight' ? '视线内' : d.type === 'unlimited' ? '无限'
      : d.amount != null ? `${d.amount} ${d.type === 'miles' ? '里' : '尺'}` : '') + (r.type && !['point'].includes(r.type) ? `（${({ radius: '半径', sphere: '球', cone: '锥', line: '线', cube: '立方', emanation: '光环', cylinder: '柱' } as Record<string, string>)[r.type] ?? r.type}）` : ''));
  }
  const c = s.components;
  if (c) out.push('成分：' + [c.v && '言语', c.s && '姿势', c.m && `材料（${typeof c.m === 'string' ? c.m : c.m.text ?? ''}）`].filter(Boolean).join('、'));
  const du = (s.duration || [])[0];
  if (du) {
    out.push('持续时间：' + (du.type === 'instant' ? '立即' : du.type === 'permanent' ? '永久' : du.type === 'special' ? '特殊'
      : `${du.concentration ? '专注，至多 ' : ''}${du.duration?.amount ?? ''} ${UNIT[du.duration?.type] ?? du.duration?.type ?? ''}`));
  }
  return out;
}

function metaOf(kind: string, e: Json): string[] {
  if (kind === 'spell') return spellMeta(e);
  if (kind === 'feat') return [fmtPrereq(e.prerequisite)].filter(Boolean).map((x) => `先决条件：${x}`);
  if (kind === 'item') return [[RARITY[e.rarity] ?? e.rarity, e.reqAttune ? '需同调' : ''].filter(Boolean).join(' · ')].filter(Boolean);
  if (kind === 'skill' && e.ability) return [`属性：${({ str: '力量', dex: '敏捷', con: '体质', int: '智力', wis: '感知', cha: '魅力' } as Record<string, string>)[e.ability] ?? e.ability}`];
  return [];
}

const cache = new Map<string, Promise<TermData | null>>();

export function lookupTerm(engine: Engine, ref: TermRef): Promise<TermData | null> {
  const key = JSON.stringify(ref);
  let job = cache.get(key);
  if (!job) {
    job = find(engine, ref).catch(() => null);
    cache.set(key, job);
  }
  return job;
}

async function find(engine: Engine, ref: TermRef): Promise<TermData | null> {
  const store = engine.env.store;
  const done = (e: Json | null, kind = ref.kind): TermData | null => (e ? {
    kind, name: e.name ?? ref.name, source: e.source ?? '', kindLabel: KIND_LABEL[kind] ?? kind,
    meta: metaOf(kind, e), entries: e.entries || (e.entry ? [e.entry] : []),
  } : null);

  if (ref.kind === 'classFeature' || ref.kind === 'subclassFeature') {
    const slug = ref.cls ? CLASS_SLUG_BY_NAME[ref.cls] : undefined;
    if (!slug) return null;
    const data = await store.classData(slug);
    // 引擎的条目键不区分职业特性和子职特性：两张表都找
    for (const kind of ref.kind === 'classFeature' ? ['classFeature', 'subclassFeature'] : ['subclassFeature', 'classFeature']) {
      const hits = (data?.[kind] as Json[] || []).filter((f) => f.name === ref.name && (ref.level == null || f.level === ref.level));
      const hit = hits.find((f) => /^X/.test(f.source)) ?? hits[0];
      if (hit) return done(hit, kind);
    }
    return null;
  }
  if (ref.kind === 'auto') {
    for (const kind of AUTO) {
      const hit = await find(engine, { ...ref, kind });
      if (hit) return hit;
    }
    return null;
  }
  for (const [file, arr] of TABLES[ref.kind] || []) {
    const d = await store.ensure(file).catch(() => null);
    const hit = pick(d?.[arr] || [], ref.name, ref.source);
    if (hit) return done(hit);
  }
  return null;
}
