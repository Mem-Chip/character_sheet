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

const DATA = resolve(import.meta.dirname, '..', '..', 'data', '5etools', 'data');
const read = (p: string): Json => JSON.parse(readFileSync(resolve(DATA, p), 'utf8'));
const abilities = (JSON.parse(readFileSync(resolve(import.meta.dirname, '..', '..', 'data', 'abilities-2024.json'), 'utf8')) as Json).entries as Record<string, Json>;

let classFiles: Json[] | null = null;
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

/** 造一个 20 级角色，看它进战斗后的资源与职业表 */
async function probe(env: SheetEnv, cls: string, subclass?: string): Promise<{ resources: Record<string, string>; classTable: Record<string, string | number> }> {
  const char: CharData = {
    ...blankCharacter(), name: '探针',
    abilities: { str: 14, dex: 14, con: 14, int: 14, wis: 14, cha: 14 },
    classes: [{ name: cls, level: 20, ...(subclass ? { subclass } : {}) }],
  };
  const sheet = await env.compute(char);
  const v = viewFromSheet(env, char, sheet);
  return { resources: v.resourceNames, classTable: v.classTable };
}

export async function buildTask(env: SheetEnv, id: string, key: string, iface?: TaskInterface): Promise<Task> {
  const parts = key.split(':');
  // 法术
  if (parts[1] === 'spell') {
    const name = parts.slice(2).join(':');
    const sp = (read('spells/spells-xphb.json').spell as Json[]).find((s) => s.name === name);
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
  // 职业 / 子职特性：XPHB:<职业>:<特性>:<等级>
  if (parts.length === 4) {
    const [, cls, name, lv] = parts;
    const level = Number(lv);
    for (const file of classes()) {
      const cf = (file.classFeature || []).find((f: Json) => f.source === 'XPHB' && f.className === cls && f.name === name && f.level === level);
      const sf = cf ? null : (file.subclassFeature || []).find((f: Json) => f.source === 'XPHB' && f.className === cls && f.name === name && f.level === level);
      const hit = cf ?? sf;
      if (!hit) continue;
      const sub = sf ? (file.subclass || []).find((s: Json) => s.className === cls && s.shortName === sf.subclassShortName && s.source === sf.subclassSource) : null;
      const p = await probe(env, cls, sub?.name);
      return {
        id, key, name, kind: sf ? 'subclassFeature' : 'classFeature',
        where: `${cls} ${level} 级${sub ? `（${sub.name}）` : ''}`,
        text: flattenEntries(hit.entries), classTable: p.classTable, resources: p.resources,
        ...staticOf(key), interface: iface,
      };
    }
    throw new Error(`找不到职业特性「${key}」`);
  }
  // 专长 / 可选特性：XPHB:<名字>
  const name = parts.slice(1).join(':');
  const feat = (read('feats.json').feat as Json[]).find((f) => f.source === 'XPHB' && f.name === name);
  const opt = feat ? null : (read('optionalfeatures.json').optionalfeature as Json[]).find((f) => f.source === 'XPHB' && f.name === name);
  const hit = feat ?? opt;
  if (!hit) throw new Error(`找不到专长 / 可选特性「${name}」`);
  const resources: Record<string, string> = {};
  for (const r of abilities[key]?.resources || []) if (r.id) resources[r.id] = r.name;
  return {
    id, key, name, kind: feat ? 'feat' : 'optfeature', where: feat ? `专长${hit.category ? `（${hit.category}）` : ''}` : '可选特性',
    text: flattenEntries(hit.entries), resources, ...staticOf(key), interface: iface,
  };
}
