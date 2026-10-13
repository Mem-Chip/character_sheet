/**
 * 静态层 → 动态层的桥（COMBAT-DESIGN §10.1 的 `View.fromSheet`）。
 *
 * 人物卡算出来的 SHEET（与原项目同形）→ 战斗引擎要的 CombatantView。
 * 静态数值（AC、豁免、技能、攻击行、施法 DC）一律以 SHEET 为准，战斗引擎只在它上面叠效应。
 */
import { normType } from '../combat/damage';
import { freshEconomy } from '../combat/view';
import type { AttackRow, Combatant, CombatantView, LiveState } from '../combat/types';
import { ABILS, COUNT_ONLY, SIZE_CN, type CharData, type Json, type SheetEnv } from '../sheet';
import type { Ability } from '../expr';

const CREATURE_TYPE_CN: Record<string, string> = {
  humanoid: '类人生物', beast: '野兽', fey: '精类', fiend: '邪魔', celestial: '天界生物', construct: '构装生物',
  dragon: '龙类', elemental: '元素生物', giant: '巨人', monstrosity: '怪兽', ooze: '泥怪', plant: '植物', undead: '不死生物', aberration: '异怪',
};

const stripTags = (s: unknown) => String(s ?? '').replace(/\{@\w+\s+([^}|]+)[^}]*\}/g, '$1').trim();

/** 职业表单元格 → 引擎能用的值（'3d6' / 2 / 文本） */
function cellToValue(v: Json): string | number | null {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'object') {
    if (v.type === 'dice') {
      const d = (v.toRoll || []).map((t: Json) => `${t.number}d${t.faces}`).join(' + ');
      return d || null;
    }
    if (v.type === 'bonus' || v.type === 'bonusSpeed') return v.value;
    return null;
  }
  const s = stripTags(v);
  if (/^[+＋]?\d+$/.test(s)) return Number(s.replace(/[+＋]/g, ''));
  return s || null;
}

/** 当前等级那一行：列名 → 值（多职业时各职业的列合在一起，同名列取等级高的那个职业） */
function classTableRow(char: CharData): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  const classes = [...(char._resolved?.classes || [])].sort((a: Json, b: Json) => a.level - b.level);
  for (const k of classes) {
    for (const g of k.cls.classTableGroups || []) {
      const rows = g.rows || g.rowsSpellProgression;
      if (!rows?.length) continue;
      const row = rows[Math.max(0, Math.min(rows.length - 1, k.level - 1))];
      (g.colLabels || []).forEach((label: unknown, i: number) => {
        const v = cellToValue(row?.[i]);
        if (v !== null) out[stripTags(label)] = v;
      });
    }
  }
  return out;
}

const EXTRA_ATTACK: Record<string, number> = { 额外攻击: 2, '额外攻击（二）': 3, '额外攻击（三）': 4 };

/** 规则条目键：职业特性 `<来源>:<职业>:<名字>:<等级>`，其余 `<来源>:<名字>`，家规 `HR:<id>` */
export function sourceKeys(env: SheetEnv, char: CharData): string[] {
  const keys: string[] = [];
  for (const s of env.abilities.collectSources(char)) {
    if (s.kind === 'classFeature' || s.kind === 'subclassFeature') keys.push(`${s.source}:${s.cls}:${s.name}:${s.level}`);
    else keys.push(`${s.source}:${s.name}`);
  }
  // 能用的法术：已准备的（或没标 prepared 的）、戏法、能力授予的
  const spells = new Set<string>();
  for (const sp of char.spells || []) if (sp?.name && sp.prepared !== false) spells.add(sp.name);
  for (const n of char._derived?.spells || []) spells.add(n);
  for (const n of char._derived?.cantrips || []) spells.add(n);
  for (const n of spells) keys.push(`XPHB:spell:${n}`);
  return [...new Set(keys)];
}

export interface ResourceMap {
  /** 战斗引擎里的资源 id → 人物卡 char.resources 的键 */
  toSheetKey: Record<string, string>;
  max: Record<string, number>;
  used: Record<string, number>;
  name: Record<string, string>;
}

/**
 * 资源池：引擎里用能力数据声明的 id（「狂暴」），没有 id 的用池名（「回气」）。
 * 职业表的池和能力声明的池在人物卡那边已经合并过了，这里把合并后的池挂回能力的 id 上。
 */
export function resourceMap(char: CharData, sheet: Json): ResourceMap {
  const out: ResourceMap = { toSheetKey: {}, max: {}, used: {}, name: {} };
  const declared = (char._derived?.resources || []) as Json[];
  for (const r of sheet._resources || []) {
    if (r.max == null || COUNT_ONLY.has(r.name)) continue;
    const decl = declared.find((d) => d.name === r.name || (d.id && r.key.endsWith(':' + d.id)));
    const id = String(decl?.id ?? r.id ?? r.name);
    out.toSheetKey[id] = r.key;
    out.max[id] = r.max;
    out.used[id] = r.used || 0;
    out.name[id] = String(r.name ?? id);
  }
  return out;
}

export function viewFromSheet(env: SheetEnv, char: CharData, sheet: Json): CombatantView {
  const res = resourceMap(char, sheet);
  const score = Object.fromEntries(ABILS.map((a) => [a, sheet['score:' + a] ?? 10])) as Record<Ability, number>;
  const mod = Object.fromEntries(ABILS.map((a) => [a, sheet['mod:' + a] ?? 0])) as Record<Ability, number>;
  const save = Object.fromEntries(ABILS.map((a) => [a, sheet.saves?.[a]?.total ?? mod[a]])) as Record<Ability, number>;
  const skill = Object.fromEntries(Object.entries(sheet.skills || {}).map(([k, v]) => [k, (v as Json).total as number]));
  const levels = Object.fromEntries((char._resolved?.classes || []).map((k: Json) => [k.cls.name, k.level]));
  const sc = sheet.spell || {};
  const spellAbility = sc.ability as Ability | null;

  const masteries = new Set<string>(sheet.masteries || []);
  const attacks: AttackRow[] = (sheet.attacks || []).map((row: Json, i: number) => {
    const props: string[] = (row.ent?.property || []).map((p: unknown) => String(p).split('|')[0]);
    const dmgMod = (sheet['mod:' + row.abil] || 0) + (Number(/([+-]\s*\d+)$/.exec(String(row.ent?.dmg1 || ''))?.[1]?.replace(/\s/g, '')) || 0);
    const damage = row.dmg === '—' ? '0' : `${row.dmg}${dmgMod ? (dmgMod > 0 ? ` + ${dmgMod}` : ` - ${-dmgMod}`) : ''}`;
    const range = Number(String(row.range ?? '').split('/')[0]) || undefined;
    return {
      id: `${row.name}#${i}`,
      name: row.name,
      bonus: row.atk,
      damage,
      damageType: normType(row.dmgType || ''),
      melee: !row.ranged,
      ranged: !!row.ranged,
      finesse: !!row.finesse,
      reach: props.includes('R'),
      ability: row.abil as Ability,
      mastery: masteries.has(row.name) ? (row.mastery?.[0] ?? null) : null,
      range,
    };
  });

  const featureNames = new Set((sheet.features || []).map((f: Json) => f.name));
  let attacksPerAction = 1;
  for (const [nm, n] of Object.entries(EXTRA_ATTACK)) if (featureNames.has(nm)) attacksPerAction = Math.max(attacksPerAction, n);

  const slots: Record<number, number> = {};
  (sc.slots || []).forEach((n: number, i: number) => { if (n) slots[i + 1] = n; });
  // 契约法术位并进同环的法术位（战斗里用法一样；短休恢复由人物卡那边管）
  if (sc.pact) slots[sc.pact.level] = (slots[sc.pact.level] ?? 0) + sc.pact.count;

  const wearing: string[] = [];
  for (const eq of char._resolved?.equipment || []) {
    if (!eq.equipped || !eq._ent) continue;
    const t = String(eq._ent.type || '').split('|')[0];
    if (['LA', 'MA', 'HA', 'S'].includes(t)) wearing.push(t);
  }

  const ctype = char._resolved?.race?.creatureTypes?.[0];
  return {
    name: char.name || '未命名',
    size: SIZE_CN[sheet.size] || sheet.size || '中型',
    type: CREATURE_TYPE_CN[ctype] ?? '类人生物',
    ac: sheet.ac,
    hpMax: sheet.hpMax,
    speed: sheet.speed,
    pb: sheet.pb,
    level: sheet.level,
    levels,
    score,
    mod,
    save,
    skill,
    initiative: sheet.initiative,
    spell: sc.dc != null && spellAbility ? { dc: sc.dc, atk: sc.atk, mod: mod[spellAbility], ability: spellAbility } : null,
    resist: [...new Set((sheet.resist || []).map((x: string) => normType(x)))] as string[],
    immune: [],
    vuln: [],
    conditionImmune: sheet.conditionImmune || [],
    attacks,
    attacksPerAction,
    sources: sourceKeys(env, char),
    resources: res.max,
    resourceNames: res.name,
    slots,
    classTable: classTableRow(char),
    wearing,
  };
}

export interface CombatantFromSheetOpts {
  id: string;
  controller?: string;
  side?: string;
}

/** 人物卡 → 战斗参与者（实时状态从 char 的记账字段取） */
export function combatantFromSheet(env: SheetEnv, char: CharData, sheet: Json, o: CombatantFromSheetOpts): Combatant {
  const view = viewFromSheet(env, char, sheet);
  const res = resourceMap(char, sheet);
  const slotsUsed: Record<number, number> = {};
  for (const [lvl, st] of Object.entries(char.slots || {})) {
    const used = (st as Json)?.used ?? 0;
    if (used) slotsUsed[Number(lvl)] = used;
  }
  const live: LiveState = {
    hp: char.hp?.current ?? view.hpMax,
    tempHp: char.hp?.temp ?? 0,
    deathSaves: { s: char.deathSaves?.success ?? 0, f: char.deathSaves?.failure ?? 0 },
    resourcesUsed: res.used,
    slotsUsed,
    heroicInspiration: false,
    stable: false,
    dead: false,
  };
  return {
    id: o.id,
    kind: 'pc',
    name: view.name,
    controller: o.controller ?? o.id,
    side: o.side ?? 'party',
    base: view,
    live,
    economy: freshEconomy(view),
    initiative: null,
  };
}

/**
 * 战斗结果写回人物卡（LiveSink）：HP、临时生命值、法术位、资源、死亡豁免。
 * 只写记账字段；build 半边（属性、职业、装备…）一概不碰。
 */
export function syncLiveToChar(char: CharData, sheet: Json, c: Combatant): void {
  const view = c.base;
  char.hp = { ...(char.hp || {}), current: c.live.hp >= view.hpMax ? null : c.live.hp, temp: c.live.tempHp };
  char.deathSaves = { success: c.live.deathSaves.s, failure: c.live.deathSaves.f };
  const slots: Record<string, { used: number }> = {};
  for (const [lvl, used] of Object.entries(c.live.slotsUsed)) if (used) slots[lvl] = { used };
  char.slots = slots;
  const res = resourceMap(char, sheet);
  char.resources = char.resources || {};
  for (const [id, used] of Object.entries(c.live.resourcesUsed)) {
    const key = res.toSheetKey[id];
    if (!key) continue;
    char.resources[key] = { ...(char.resources[key] || {}), used };
  }
}
