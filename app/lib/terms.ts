/**
 * 术语查表：给悬浮窗用。名字（+ 类别、来源）→ 5etools 里的那一条。
 *
 * 类别就是 5etools 标签的名字（spell、condition、feat、item、skill、action、variantrule…），
 * 所以正文里的 {@spell 火球术} 直接能查；界面上自己写的名字（法术列表、技能表）也用同样的类别。
 * 数据按需装载：第一次查某一类时才去取那份文件（职业特性要取职业文件）。
 */
import { CLASS_SLUG_BY_NAME, SCHOOL_CN, fmtPrereq, type Json } from '../../src/sheet';
import type { Engine } from './engine';

export interface TermRef { kind: string; name: string; source?: string; cls?: string; level?: number; /** 英文原名（只在搜索结果里有） */ en?: string }
export interface TermData { kind: string; name: string; source: string; kindLabel: string; meta: string[]; entries: Json[] }

export const KIND_LABEL: Record<string, string> = {
  spell: '法术', condition: '状态', status: '状态', disease: '疾病', feat: '专长', optfeature: '可选特性', item: '物品',
  skill: '技能', action: '动作', sense: '感官', variantrule: '规则', language: '语言', race: '种族', background: '背景',
  classFeature: '职业特性', subclassFeature: '子职特性', raceFeature: '种族特质', itemMastery: '武器精通', itemProperty: '武器属性',
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

export const canLookup = (kind: string) => kind in TABLES || kind === 'classFeature' || kind === 'subclassFeature' || kind === 'raceFeature' || kind === 'auto';

/** 规则条目键 → 术语：`XPHB:spell:名`、`XPHB:action:名`、`XPHB:condition:名`、职业特性 `XPHB:职业:名:等级`、其余 `XPHB:名` */
export function termOfKey(key: string): TermRef | null {
  if (!key) return null;
  const p = key.split('#')[0].split(':');
  if (p.length === 4) return { kind: 'classFeature', cls: p[1], name: p[2], level: Number(p[3]) || undefined };
  if (p.length === 3 && ['spell', 'action', 'condition', 'item'].includes(p[1])) return { kind: p[1], name: p[2] };
  if (p.length === 3 && p[1] === 'mastery') return { kind: 'itemMastery', name: p[2] };
  if (p.length === 2 && !['HR', 'inline', 'weapon', 'summon'].includes(p[0])) return { kind: 'auto', name: p[1] };
  return null;
}

/** 身上挂载的效应 → 指向来源法术 / 特性 / 状态的术语引用（供悬浮窗查看原文） */
export function termOfEffect(e: { key?: string; name?: string; origin?: { ref?: string; kind?: string } }): TermRef | null {
  if (e.key === 'concentration') {
    return (e.origin?.ref ? termOfKey(e.origin.ref) : null) ?? (e.name ? { kind: 'spell', name: e.name } : null);
  }
  const byKey = termOfKey(String(e.key ?? ''));
  if (byKey) return byKey;
  if (e.origin?.ref) {
    const byOrigin = termOfKey(e.origin.ref);
    if (byOrigin) return byOrigin;
  }
  const m = e.name ? /^(.+)：(.+)$/.exec(e.name) : null;
  if (m) return { kind: e.origin?.kind === 'spell' ? 'spell' : 'auto', name: m[1] };
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

  if (ref.kind === 'raceFeature') {
    return findRaceFeature(engine, ref.name);
  }
  if (ref.kind === 'classFeature' || ref.kind === 'subclassFeature') {
    const slugs = ref.cls ? [CLASS_SLUG_BY_NAME[ref.cls]].filter(Boolean) : Object.values(CLASS_SLUG_BY_NAME);
    for (const slug of slugs) {
      if (!slug) continue;
      const data = await store.classData(slug).catch(() => null);
      for (const kind of ref.kind === 'classFeature' ? ['classFeature', 'subclassFeature'] : ['subclassFeature', 'classFeature']) {
        const hits = (data?.[kind] as Json[] || []).filter((f) => f.name === ref.name && (ref.level == null || f.level === ref.level));
        const hit = hits.find((f) => /^X/.test(f.source)) ?? hits[0];
        if (hit) return done(hit, kind);
      }
    }
    return null;
  }
  if (ref.kind === 'auto') {
    for (const kind of AUTO) {
      const hit = await find(engine, { ...ref, kind });
      if (hit) return hit;
    }
    const hitCls = await find(engine, { ...ref, kind: 'classFeature' });
    if (hitCls) return hitCls;
    const hitRace = await findRaceFeature(engine, ref.name);
    if (hitRace) return hitRace;
    return null;
  }
  for (const [file, arr] of TABLES[ref.kind] || []) {
    const d = await store.ensure(file).catch(() => null);
    const hit = pick(d?.[arr] || [], ref.name, ref.source);
    if (hit) return done(hit);
  }
  // 战役启用的书里的法术
  if (ref.kind === 'spell') {
    const hit = pick([...store.bookSpells.values()].flat(), ref.name, ref.source);
    if (hit) return done(hit);
  }
  return null;
}

async function findRaceFeature(engine: Engine, name: string): Promise<TermData | null> {
  const store = engine.env.store;
  const d = await store.ensure('races').catch(() => null);
  for (const r of (d?.race || []) as Json[]) {
    for (const ent of (r.entries || []) as Json[]) {
      if (ent && typeof ent === 'object' && ent.name === name) {
        return {
          kind: 'raceFeature',
          name: ent.name,
          source: r.source ?? 'XPHB',
          kindLabel: '种族特质',
          meta: [`种族：${r.name}`],
          entries: ent.entries || (ent.entry ? [ent.entry] : []),
        };
      }
    }
  }
  return null;
}

const RESOURCE_FEATURE_MAP: Record<string, string> = {
  狂暴次数: '狂暴',
  引导神力: '引导神力',
  荒野形态: '荒野形态',
  回气: '回气',
  功力: '运转周天',
  功力点: '运转周天',
  术法点: '术法点',
  宿敌: '宿敌',
  祈唤: '魔能祈唤',
};

/** 资源对象 → 术语引用（用于鼠标悬浮查看说明） */
export function termOfResource(r: Json): TermRef | null {
  if (!r) return null;
  const name = String(r.name || '').trim();
  const key = String(r.key || '');
  if (key.startsWith('table:XPHB:')) {
    const [, , cls, col] = key.split(':');
    const featName = RESOURCE_FEATURE_MAP[col] || col.replace(/次数$/, '');
    return { kind: 'classFeature', cls, name: featName };
  }
  if (r.from && r.from !== '能力' && r.from !== '职业表') {
    return { kind: 'auto', name: String(r.from).trim() };
  }
  if (name) {
    const cleanName = RESOURCE_FEATURE_MAP[name] || name.replace(/次数$/, '');
    return { kind: 'auto', name: cleanName };
  }
  return null;
}

/** 指令框的 /match：按名字找条目，中文名或英文原名都行（先完全一样的，再包含的），最多 limit 条 */
export async function searchTerms(engine: Engine, q: string, limit = 12): Promise<TermRef[]> {
  const want = q.trim();
  if (!want) return [];
  const low = want.toLowerCase();
  const store = engine.env.store;
  const exact: TermRef[] = [], part: TermRef[] = [];
  const seen = new Set<string>();
  for (const [kind, tables] of Object.entries(TABLES)) {
    if (kind === 'status') continue;
    for (const [file, arr] of tables) {
      const d = await store.ensure(file).catch(() => null);
      for (const x of (d?.[arr] || []) as Json[]) {
        const nm = String(x?.name ?? '');
        const en = String(x?.ENG_name ?? '');
        if (!nm || !(nm.includes(want) || en.toLowerCase().includes(low))) continue;
        const k = `${kind}|${nm}`;
        if (seen.has(k)) continue;
        seen.add(k);
        (nm === want || en.toLowerCase() === low ? exact : part).push({ kind, name: nm, ...(en ? { en } : {}) });
      }
    }
  }
  // 短的名字排前面（「火球术」比「延迟爆裂火球」更可能是要找的）
  part.sort((a, b) => a.name.length - b.name.length);
  return [...exact, ...part].slice(0, limit);
}

/**
 * 选择框里的一个选项 → 术语类别（悬停看原文用）。
 *
 * ⚠️ 别用 `pool.includes('feat')` 判断专长：可选特性的池子叫 `optionalfeature`，里面也含 "feat"，
 * 会把超魔法 / 魔能祈唤的选项当成专长去查（查不到 → 悬浮窗显示「没查到」）。
 */
export function choiceTerm(p: { kind?: string; pool?: string; value: string; label?: string }): TermRef | null {
  const kind = String(p.kind ?? '');
  const pool = String(p.pool ?? '');
  const name = p.value;
  if (kind === 'optfeature' || pool === 'optionalfeature' || pool === 'optfeature') return { kind: 'optfeature', name };
  if (kind === 'classFeature' || pool === 'classFeature') return { kind: 'classFeature', name };
  if (kind === 'feat' || pool === 'feat' || pool === 'originFeat' || pool === 'fightingStyle') return { kind: 'feat', name };
  if (kind === 'skill' || kind === 'expertise' || pool === 'skill' || pool.startsWith('skill')) return { kind: 'skill', name: p.label ?? name };
  if (kind === 'language' || pool === 'language') return { kind: 'language', name };
  if (kind === 'itemMastery' || pool === 'mastery') return { kind: 'itemMastery', name };
  if (kind === 'tool' || pool.includes('tool') || pool === 'artisan' || pool === 'instrument') return { kind: 'item', name };
  if (kind === 'spell' || kind === 'cantrip' || pool === 'spell' || pool === 'cantrip') return { kind: 'spell', name };
  if (pool === 'subclass') return { kind: 'subclassFeature', name };
  if (name) return { kind: 'auto', name };
  return null;
}
