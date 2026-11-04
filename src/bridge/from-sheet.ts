/**
 * 静态层 → 动态层的桥（COMBAT-DESIGN §10.1 的 `View.fromSheet`）。
 *
 * 人物卡算出来的 SHEET（与原项目同形）→ 战斗引擎要的 CombatantView。
 * 静态数值（AC、豁免、技能、攻击行、施法 DC）一律以 SHEET 为准，战斗引擎只在它上面叠效应。
 */
import { normType } from '../combat/damage';
import { freshEconomy } from '../combat/view';
import type { AttackRow, Combatant, CombatantView, Entry, LiveState } from '../combat/types';
import { plain } from './from-monster';
import { RULE_FILES } from './rule-files';
import { ABILS, COUNT_ONLY, SIZE_CN, sourceKeyOf, type CharData, type Json, type SheetEnv } from '../sheet';
import type { Ability } from '../expr';

export const CREATURE_TYPE_CN: Record<string, string> = {
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
    keys.push(sourceKeyOf(s));
    // 覆盖官方能力的家规：战斗数据还在官方键上（本团房规层可能改了它）
    if (s.kind === 'homerule' && s.covers?.includes(':')) keys.push(s.covers);
  }
  // 能用的法术：已准备的（或没标 prepared 的）、戏法、能力授予的
  const spells = new Set<string>();
  for (const sp of char.spells || []) if (sp?.name && sp.prepared !== false) spells.add(sp.name);
  for (const n of char._derived?.spells || []) spells.add(n);
  for (const n of char._derived?.cantrips || []) spells.add(n);
  // 子职给的始终准备法术（誓约法术、领域法术、宗主法术…）：解析时放在 _resolved.subclassSpells，不在 _derived 里
  for (const g of char._resolved?.subclassSpells || []) if (g?.name) spells.add(g.name);
  // 别的书的法术（战役启用的）：键用那本书的来源
  for (const n of spells) keys.push(`${env.store.spellByName(n)?.source || 'XPHB'}:spell:${n}`);
  return [...new Set(keys)];
}

export interface ResourceMap {
  /** 战斗引擎里的资源 id → 人物卡 char.resources 的键 */
  toSheetKey: Record<string, string>;
  max: Record<string, number>;
  used: Record<string, number>;
  name: Record<string, string>;
  /** 短休恢复：'all' = 全恢复，数字 = 恢复几 */
  shortRest: Record<string, number | 'all'>;
}

/**
 * 资源池：引擎里用能力数据声明的 id（「狂暴」），没有 id 的用池名（「回气」）。
 * 职业表的池和能力声明的池在人物卡那边已经合并过了，这里把合并后的池挂回能力的 id 上。
 */
export function resourceMap(char: CharData, sheet: Json): ResourceMap {
  const out: ResourceMap = { toSheetKey: {}, max: {}, used: {}, name: {}, shortRest: {} };
  const declared = (char._derived?.resources || []) as Json[];
  for (const r of sheet._resources || []) {
    if (r.max == null || COUNT_ONLY.has(r.name)) continue;
    const decl = declared.find((d) => d.name === r.name || (d.id && r.key.endsWith(':' + d.id)));
    const id = String(decl?.id ?? r.id ?? r.name);
    out.toSheetKey[id] = r.key;
    out.max[id] = r.max;
    out.used[id] = r.used || 0;
    out.name[id] = String(r.name ?? id);
    if (r.recovery === 'short') {
      out.shortRest[id] = 'all';
    } else if (Array.isArray(r.regain)) {
      let back = 0;
      for (const g of r.regain) if (g?.on === 'short') back = Math.max(back, Number(g.amount) || 0);
      if (back > 0) out.shortRest[id] = back;
    }
  }
  return out;
}

const ITEM_RES = '物品:';
/** 用得掉的物品：药水、标了「消耗品」的 */
export function isConsumable(ent: Json): boolean {
  return String(ent?.type ?? '').split('|')[0] === 'P' || (ent?.miscTags || []).includes('CNS');
}
/** 治疗药水这类：「恢复 2d4 + 2 点生命值」→ '2d4 + 2'（认不出 = null） */
export function healDiceOf(ent: Json): string | null {
  const text = plain((ent?.entries ?? []).filter((x: unknown) => typeof x === 'string').join(' '));
  const m = /恢复\s*(\d+d\d+(?:\s*[+-]\s*\d+)?)\s*点?\s*生命值/.exec(text);
  return m ? m[1].replace(/\s+/g, ' ') : null;
}
/** 物品的规则条目键：和法术一样，<来源>:item:<名字> */
export const itemKey = (ent: Json) => `${ent.source ?? 'XPHB'}:item:${ent.name}`;
const CHARGE_RES = '物品充能:';
const USES_RES = '物品次数:';

/** 物品条目里声明的次数池（「长休前只能用一次」）：规则书里写好的条目才有；后面的文件盖前面的 */
function itemPools(key: string): Array<{ id: string; name: string; max: number }> {
  let decl: Array<{ id: string; name?: string; formula?: unknown }> | undefined;
  for (const f of RULE_FILES) {
    const e = (f.entries as Record<string, { resources?: typeof decl }>)[key];
    if (e?.resources) decl = e.resources;
  }
  return (decl ?? []).filter((r) => r.id?.startsWith(USES_RES)).map((r) => ({ id: r.id, name: r.name ?? r.id, max: Math.max(1, Number(r.formula) || 1) }));
}

/**
 * 物品进战斗：
 *   - 消耗品（药水之类）：数量记成资源「物品:名字」；条目里的动作花它。治疗药水认得出就自动生成治疗动作（规则书里有写好的条目时用写好的）；
 *   - 装备着的魔法物品（要同调的同调了）：它的条目键进 sources（规则书里有就生效）；
 *   - 有充能的：资源「物品充能:名字」= 充能数（用过的记在卡上）。
 */
function itemsForCombat(char: CharData): { max: Record<string, number>; used: Record<string, number>; name: Record<string, string>; entries: Record<string, Entry>; keys: string[] } {
  const out = { max: {} as Record<string, number>, used: {} as Record<string, number>, name: {} as Record<string, string>, entries: {} as Record<string, Entry>, keys: [] as string[] };
  for (const eq of char._resolved?.equipment || []) {
    const ent = eq._ent;
    if (!ent || ent.custom) continue;
    const key = itemKey(ent);
    const active = eq.equipped && (!ent.reqAttune || eq.attuned);
    const charges = Number(ent.charges) || 0;
    if (charges && (active || isConsumable(ent))) {
      const id = CHARGE_RES + eq.name;
      out.max[id] = charges;
      out.used[id] = Math.min(charges, Number(eq.chargesUsed) || 0);
      out.name[id] = `${eq.name}（充能）`;
    }
    if (active) {
      for (const p of itemPools(key)) {
        out.max[p.id] = p.max;
        out.used[p.id] = Math.min(p.max, Number(eq.uses?.[p.id]) || 0);
        out.name[p.id] = p.name;
      }
    }
    if (!isConsumable(ent)) {
      if (active) out.keys.push(key);
      continue;
    }
    const id = ITEM_RES + eq.name;
    const qty = Math.max(0, Number(eq.qty ?? 1) || 0);
    if (!qty) continue;
    out.max[id] = (out.max[id] ?? 0) + qty;
    out.name[id] = eq.name;
    out.keys.push(key);
    const heal = healDiceOf(ent);
    const potion = String(ent.type ?? '').split('|')[0] === 'P';
    out.entries[key] = {
      name: eq.name,
      actions: [{
        id: 'use', name: eq.name, activation: potion ? 'bonus' : 'action', tags: ['item'], cost: [{ resource: id }],
        ...(heal ? { targeting: { type: 'creature', count: 1, range: 5 } } : {}),
        root: heal ? [{ kind: 'heal', amount: heal }] : [{ kind: 'note', text: `${eq.name}：${plain((ent.entries ?? []).filter((x: unknown) => typeof x === 'string').join(' '))}（效果请手动处理）` }],
      }],
    };
  }
  out.keys = [...new Set(out.keys)];
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
    const [range, long] = String(row.range ?? '').split('/').map((x) => Number(x) || undefined);
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
      long,
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

  // 消耗品（药水之类）：数量记成资源「物品:名字」，用掉一次 = 资源用掉一次；各自一个动作
  const items = itemsForCombat(char);
  const ctype = char._resolved?.race?.creatureTypes?.[0];
  const hitDice: Record<number, number> = {};
  for (const h of sheet.hitDice || []) {
    if (h?.faces && h?.level) hitDice[h.faces] = (hitDice[h.faces] ?? 0) + h.level;
  }
  const shortRest = (Object.keys(res.shortRest).length || sc.pact)
    ? {
        ...(Object.keys(res.shortRest).length ? { resources: res.shortRest } : {}),
        ...(sc.pact ? { pact: { level: Number(sc.pact.level), count: Number(sc.pact.count) } } : {}),
      }
    : undefined;
  return {
    name: char.name || '未命名',
    size: SIZE_CN[sheet.size] || sheet.size || '中型',
    type: CREATURE_TYPE_CN[ctype] ?? '类人生物',
    ac: sheet.ac,
    hpMax: sheet.hpMax,
    // 荒野形态：把卡上勾选的「已知形态」带进战斗，形态选择器优先列这些
    ...((char.wildShapeKnown || []).length ? { knownForms: (char.wildShapeKnown as string[]).slice() } : {}),
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
    immune: [...new Set((sheet.immune || []).map((x: string) => normType(x)))] as string[],
    vuln: [],
    conditionImmune: sheet.conditionImmune || [],
    attacks,
    attacksPerAction,
    sources: [...sourceKeys(env, char), ...items.keys],
    resources: { ...res.max, ...items.max },
    resourceNames: { ...res.name, ...items.name },
    ...(Object.keys(items.entries).length ? { entries: items.entries } : {}),
    slots,
    classTable: classTableRow(char),
    wearing,
    ...(char.profile?.portrait ? { avatar: String(char.profile.portrait) } : {}),
    ...(Object.keys(hitDice).length ? { hitDice } : {}),
    ...(shortRest ? { shortRest } : {}),
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
  const hitDiceUsed: Record<number, number> = {};
  for (const [faces, n] of Object.entries(char.hitDiceSpent || {})) {
    const f = Number(faces);
    const max = view.hitDice?.[f] ?? 0;
    const u = Math.min(max, Number(n) || 0);
    if (u > 0) hitDiceUsed[f] = u;
  }
  const live: LiveState = {
    hp: char.hp?.current ?? view.hpMax,
    tempHp: char.hp?.temp ?? 0,
    deathSaves: { s: char.deathSaves?.success ?? 0, f: char.deathSaves?.failure ?? 0 },
    resourcesUsed: { ...res.used, ...Object.fromEntries(Object.entries(itemsForCombat(char).used).filter(([, n]) => n > 0)) },
    slotsUsed,
    hitDiceUsed,
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
 * 战斗结果写回人物卡（LiveSink）：HP、临时生命值、法术位、资源、生命骰、死亡豁免。
 * 只写记账字段；build 半边（属性、职业、装备…）一概不碰。
 */
export function syncLiveToChar(char: CharData, sheet: Json, c: Combatant): void {
  // 物品的次数池（长休一次之类）：记在卡上那件物品下
  for (const [id, max] of Object.entries(c.base.resources)) {
    if (!id.startsWith(USES_RES)) continue;
    const i = (char.equipment || []).findIndex((e: Json) => e?.name === id.slice(USES_RES.length).split(':')[0]);
    if (i >= 0) char.equipment[i] = { ...char.equipment[i], uses: { ...(char.equipment[i].uses || {}), [id]: Math.min(max, c.live.resourcesUsed[id] ?? 0) } };
  }
  // 充能物品：用过几次记在卡上
  for (const [id, max] of Object.entries(c.base.resources)) {
    if (!id.startsWith(CHARGE_RES)) continue;
    const i = (char.equipment || []).findIndex((e: Json) => e?.name === id.slice(CHARGE_RES.length));
    if (i >= 0) char.equipment[i] = { ...char.equipment[i], chargesUsed: Math.min(max, c.live.resourcesUsed[id] ?? 0) };
  }
  // 消耗品：带进来多少 − 用掉多少（绝对值，重复写回不会重复扣）
  for (const [id, max] of Object.entries(c.base.resources)) {
    if (!id.startsWith(ITEM_RES)) continue;
    const name = id.slice(ITEM_RES.length);
    const left = Math.max(0, max - (c.live.resourcesUsed[id] ?? 0));
    const i = (char.equipment || []).findIndex((e: Json) => (typeof e === 'string' ? e : e.name) === name);
    if (i < 0) continue;
    if (left <= 0) char.equipment.splice(i, 1);
    else char.equipment[i] = { ...(typeof char.equipment[i] === 'string' ? { name } : char.equipment[i]), qty: left };
  }
  const view = c.base;
  char.hp = { ...(char.hp || {}), current: c.live.hp >= view.hpMax ? null : c.live.hp, temp: c.live.tempHp };
  char.deathSaves = { success: c.live.deathSaves.s, failure: c.live.deathSaves.f };
  const slots: Record<string, { used: number }> = {};
  for (const [lvl, used] of Object.entries(c.live.slotsUsed)) if (used) slots[lvl] = { used };
  char.slots = slots;
  if (view.hitDice && Object.keys(view.hitDice).length) {
    const spent: Record<string, number> = {};
    for (const [faces, max] of Object.entries(view.hitDice)) {
      const u = Math.min(max, c.live.hitDiceUsed?.[Number(faces)] ?? 0);
      if (u > 0) spent[faces] = u;
    }
    char.hitDiceSpent = spent;
  }
  const res = resourceMap(char, sheet);
  char.resources = char.resources || {};
  for (const [id, used] of Object.entries(c.live.resourcesUsed)) {
    const key = res.toSheetKey[id];
    if (!key) continue;
    char.resources[key] = { ...(char.resources[key] || {}), used };
  }
}
