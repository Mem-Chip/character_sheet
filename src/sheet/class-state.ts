/**
 * 职业相关的派生（移植自原项目 rules/class-state.js 的逻辑部分）：
 * 武器精通容量、职业技能预算、软约束（超出只提醒不阻止）、荒野形态、特性法术表解锁。
 * 原文件里的折叠面板等界面代码随界面一起重写，不在这里。
 */
import { SKILLS, clamp } from './constants';
import type { SheetEnv } from './env';
import { Source } from './source';
import type { Json } from './store';
import type { CharData } from './character';

export function numOf(x: Json): number {
  if (typeof x === 'number') return x;
  if (x && typeof x === 'object' && x.type === 'bonus' && typeof x.value === 'number') return x.value;
  const n = parseInt(String(x ?? ''), 10);
  return Number.isFinite(n) ? n : 0;
}

export const skillCn = (key: string) => (SKILLS.find((s) => s[0] === key) || [, key])[1];

/* ---------------- 武器精通 ---------------- */

export class MasteryRules {
  constructor(private readonly env: SheetEnv) {}

  /** 容量：职业等级表「武器精通」列 */
  allowance(c: CharData): { total: number; byClass: Array<{ cls: string; level: number; n: number }> } {
    const out = { total: 0, byClass: [] as Array<{ cls: string; level: number; n: number }> };
    for (const k of c._resolved?.classes || []) {
      const cls = k.cls;
      const lv = k.level;
      let n = 0;
      for (const g of cls.classTableGroups || []) {
        const idx = (g.colLabels || []).findIndex((l: unknown) => /精通/.test(String(l)));
        const rows = g.rows || g.rowsSpellProgression;
        if (idx < 0 || !rows) continue;
        n = numOf(rows[clamp(lv - 1, 0, rows.length - 1)]?.[idx]);
        break;
      }
      if (n) { out.total += n; out.byClass.push({ cls: cls.name, level: lv, n }); }
    }
    return out;
  }

  /** 有精通属性的 2024 武器（武器自身的 type 是近战/远程，类别在 weaponCategory） */
  weapons(_c: CharData, profs?: string[]) {
    const set = new Set((profs || []).map(String));
    return (this.env.store.data.itemsBase?.baseitem || [])
      .filter((x: Json) => Source.is2024(x) && x.mastery)
      .map((x: Json) => {
        const cat = x.weaponCategory === 'simple' ? 'simple' : 'martial';
        return {
          name: x.name, type: x.type, cat, weaponCategory: x.weaponCategory || '',
          mastery: (x.mastery || []).map((m: Json) => String(m.uid || m).split('|')[0]),
          proficient: cat === 'simple' ? set.has('简易') : set.has('军用'),
        };
      });
  }

  collect(c: CharData) {
    const byName = new Map<string, Json>((this.env.store.data.itemsBase?.baseitem || []).map((x: Json) => [x.name, x]));
    const desc = this.env.store.data.itemsBase?.itemMastery || [];
    return (c.masteries || []).map((name: string) => {
      const ent = byName.get(name);
      const props = (ent?.mastery || []).map((m: Json) => String(m.uid || m).split('|')[0]);
      return {
        name, props, type: ent?.type || '',
        entries: props.map((p: string) => ({ prop: p, text: desc.find((d: Json) => d.name === p)?.entries?.[0] || '' })),
      };
    });
  }

  overBy(c: CharData): number { return (c.masteries || []).length - this.allowance(c).total; }
}

/* ---------------- 职业技能预算 ---------------- */

export function classSkillBudget(env: SheetEnv, c: CharData) {
  const spec = c?._resolved?.classes?.[0]?.cls?.startingProficiencies?.skills?.[0]?.choose;
  if (!spec?.count) return null;
  const pool: string[] = spec.from || [];
  const eff = env.abilities.effectiveSkills(c);
  const bgSkills = new Set((c._resolved?.background?.skillProficiencies || []).flatMap((o: Json) => Object.keys(o || {})));
  const ownInPool = eff.own.filter((k: string) => pool.includes(k));
  const fromOther = (k: string) => (bgSkills.has(k) ? '背景' : (eff.granted.includes(k) ? '能力' : null));
  return {
    max: spec.count as number,
    pool,
    picked: ownInPool.filter((k: string) => !fromOther(k)),
    redundant: ownInPool.filter((k: string) => fromOther(k)),
    grantedInPool: pool.filter((k) => fromOther(k)).map((k) => ({ key: k, from: fromOther(k) })),
  };
}

/* ---------------- 软约束：超出只提醒（家规 / 魔法物品），不阻止 ---------------- */

export interface SoftLimit {
  id: string;
  label: string;
  why: string;
  over: boolean;
  max: number;
  cur: number;
  extra: string[];
}

export class SoftLimits {
  constructor(private readonly env: SheetEnv) {}

  private specs(c: CharData, sheet: Json): Array<{ id: string; label: string; why: string; get: () => { max: number; cur: number; extra: string[] } | null }> {
    const env = this.env;
    return [
      {
        id: 'skill', label: '职业技能选择', why: '来自职业的 startingProficiencies.skills[0].choose.count',
        get: () => {
          const b = classSkillBudget(env, c);
          if (!b) return null;
          return { max: b.max, cur: b.picked.length, extra: b.picked.slice(b.max) };
        },
      },
      {
        id: 'mastery', label: '武器精通', why: '来自职业等级表「武器精通」列',
        get: () => {
          const a = env.mastery.allowance(c);
          if (!a.total) return null;
          const picked = c.masteries || [];
          return { max: a.total, cur: picked.length, extra: picked.slice(a.total) };
        },
      },
      {
        id: 'wildshapeKnown', label: '荒野形态·已知形态', why: '来自职业等级表「形态」列',
        get: () => {
          const lim = env.wildShape.limits(c);
          if (!lim) return null;
          const known = env.wildShape.known(c);
          return { max: lim.known, cur: known.length, extra: known.slice(lim.known) };
        },
      },
      {
        id: 'cantrip', label: '已知戏法', why: '来自职业等级表「戏法」列',
        get: () => {
          const sc = sheet?.spell;
          if (sc?.cantripsKnown == null) return null;
          const spells = (c.spells || []).filter((s: Json) => s.level === 0 || s.isCantrip);
          return { max: sc.cantripsKnown, cur: spells.length, extra: spells.slice(sc.cantripsKnown).map((s: Json) => s.name) };
        },
      },
      {
        id: 'prepared', label: '已准备法术', why: '来自职业等级表「准备法术」列',
        get: () => {
          const sc = sheet?.spell;
          if (sc?.preparedMax == null) return null;
          const prep = (c.spells || []).filter((s: Json) => s.prepared && s.level !== 0 && !s.isCantrip);
          return { max: sc.preparedMax, cur: prep.length, extra: prep.slice(sc.preparedMax).map((s: Json) => s.name) };
        },
      },
      {
        id: 'spellbook', label: '法术书', why: '法师：1 级 6 道，此后每级 +2',
        get: () => {
          const max = spellbookMax(c);
          if (max == null) return null;
          const book = c.spellbook || [];
          return { max, cur: book.length, extra: book.slice(max) };
        },
      },
      {
        id: 'tool', label: '工具选择', why: '来自背景的 toolChoices',
        get: () => {
          const tcs = c._resolved?.toolChoices || [];
          if (!tcs.length) return null;
          let cur = 0;
          let max = 0;
          for (const tc of tcs) {
            const v = (c.decisions || {})[`tool:${tc.key}`];
            cur += Array.isArray(v) ? v.length : v ? 1 : 0;
            max += tc.count || 0;
          }
          return { max, cur, extra: [] };
        },
      },
      {
        id: 'lang', label: '语言选择', why: '来自种族/背景/能力的语言选择',
        get: () => {
          const lcs = c._resolved?.languageChoices || [];
          if (!lcs.length) return null;
          let cur = 0;
          let max = 0;
          for (const lc of lcs) {
            const v = (c.decisions || {})[`lang:${lc.key}`];
            cur += Array.isArray(v) ? v.length : v ? 1 : 0;
            max += lc.count || 0;
          }
          return { max, cur, extra: [] };
        },
      },
    ];
  }

  collect(c: CharData, sheet: Json, onlyOver = true): SoftLimit[] {
    const out: SoftLimit[] = [];
    for (const sp of this.specs(c, sheet)) {
      let r: { max: number; cur: number; extra: string[] } | null = null;
      try { r = sp.get(); } catch (e) { this.env.log(`软约束「${sp.label}」统计失败：${(e as Error).message}`, 1); continue; }
      if (!r || r.max == null) continue;
      const over = r.cur > r.max;
      if (onlyOver && !over) continue;
      out.push({ id: sp.id, label: sp.label, why: sp.why, over, ...r });
    }
    return out;
  }
}

/** 法师：1 级 6 道，此后每升 1 级再抄 2 道 */
export function spellbookMax(c: CharData): number | null {
  const wiz = (c._resolved?.classes || []).find((k: Json) => k.cls.name === '法师');
  if (!wiz) return null;
  return 6 + (wiz.level - 1) * 2;
}

/* ---------------- 荒野形态 ---------------- */

export class WildShape {
  /** 特性正文没有表时的兜底：[等级, 最高挑战等级, 能否飞行] */
  readonly TABLE: Array<[number, string, boolean]> = [[2, '1/4', false], [4, '1/2', false], [8, '1', true]];
  constructor(private readonly env: SheetEnv) {}

  private druid(c: CharData): Json {
    return (c._resolved?.classes || []).find((x: Json) => x.cls.name === '德鲁伊');
  }

  /** 「荒野形态」特性正文里的那张表（等级 / 已知形态 / 挑战等级 / 飞行） */
  table(c: CharData): Array<{ level: number; known: number; cr: string; fly: boolean }> {
    const k = this.druid(c);
    if (!k) return [];
    const feat = (k.features || []).find((f: Json) => f.name === '荒野形态') || {};
    const tables: Json[] = [];
    const walk = (e: Json): void => {
      if (!e || typeof e !== 'object') return;
      if (Array.isArray(e)) { e.forEach(walk); return; }
      if (e.type === 'table' && (e.colLabels || []).some((l: unknown) => /已知形态/.test(String(l)))) tables.push(e);
      if (e.entries) walk(e.entries);
    };
    walk(feat.entries);
    const t = tables[0];
    if (!t) return [];
    const L = (t.colLabels || []).map(String);
    const iLv = L.findIndex((l: string) => /等级/.test(l));
    const iKnown = L.findIndex((l: string) => /已知形态/.test(l));
    const iCr = L.findIndex((l: string) => /挑战等级|CR/i.test(l));
    const iFly = L.findIndex((l: string) => /飞行/.test(l));
    const crOf = (cell: unknown) => {
      const m = String(cell || '').match(/\{@filter\s+([^|}]+)/);
      return m ? m[1].trim() : String(cell || '').trim();
    };
    return (t.rows || []).map((r: Json[]) => ({
      level: parseInt(String(r[iLv]).replace(/\D/g, ''), 10),
      known: parseInt(String(r[iKnown]).replace(/\D/g, ''), 10),
      cr: crOf(r[iCr]),
      fly: /^(是|yes|true)$/i.test(String(r[iFly] || '').trim()),
    })).filter((x: { level: number }) => Number.isFinite(x.level)).sort((a: { level: number }, b: { level: number }) => a.level - b.level);
  }

  uses(c: CharData): { n: number; col: string | null } {
    const k = this.druid(c);
    if (!k) return { n: 0, col: null };
    for (const g of k.cls.classTableGroups || []) {
      const idx = (g.colLabels || []).findIndex((l: unknown) => /荒野形态/.test(String(l)));
      const rows = g.rows || g.rowsSpellProgression;
      if (idx < 0 || !rows) continue;
      return { n: numOf(rows[clamp(k.level - 1, 0, rows.length - 1)]?.[idx]), col: '荒野形态' };
    }
    return { n: 0, col: null };
  }

  limits(c: CharData): { level: number; cr: string; fly: boolean; known: number; uses: number; fromTable: boolean } | null {
    const k = this.druid(c);
    if (!k || k.level < 2) return null;
    const rows = this.table(c);
    if (rows.length) {
      let cur: { level: number; known: number; cr: string; fly: boolean } | null = null;
      for (const r of rows) if (k.level >= r.level) cur = r;
      if (!cur) return null;
      return { level: k.level, cr: cur.cr, fly: cur.fly, known: cur.known, uses: this.uses(c).n, fromTable: true };
    }
    let cur: [number, string, boolean] | null = null;
    for (const row of this.TABLE) if (k.level >= row[0]) cur = row;
    if (!cur) return null;
    const known = k.level >= 8 ? 8 : k.level >= 4 ? 6 : 4;
    return { level: k.level, cr: cur[1], fly: cur[2], known, uses: this.uses(c).n, fromTable: false };
  }

  crNum(s: unknown): number {
    const [a, b] = String(s ?? '').split('/');
    return b ? (+a) / (+b) : +a;
  }

  private shape(m: Json) {
    return {
      name: m.name, source: m.source || 'XMM', cr: m.cr, size: (m.size || ['M'])[0],
      ac: Array.isArray(m.ac) ? (typeof m.ac[0] === 'number' ? m.ac[0] : m.ac[0]?.ac) : (m.ac?.ac ?? null),
      hp: m.hp?.average ?? null, hpFormula: m.hp?.formula || '',
      speed: m.speed || {}, abil: { str: m.str, dex: m.dex, con: m.con, int: m.int, wis: m.wis, cha: m.cha },
      flying: !!m.speed?.fly,
      actions: m.action || [], bonusActions: m.bonus || [], reactions: m.reaction || [],
      traits: (m.trait || []).map((t: Json) => t.name).filter(Boolean),
      senses: Object.entries(m.sense || {}).map(([k, v]) => `${({ darkvision: '黑暗视觉', blindsight: '盲视', tremorsense: '震颤感知', truesight: '真实视觉', passive: '被动察觉' } as Record<string, string>)[k] || k} ${v}`).join(' · '),
      skills: m.skill || {},
      immune: m.immune || [],
    };
  }

  /** 可变的形态（需要怪物图鉴 bestiaryXmm） */
  forms(c: CharData) {
    const lim = this.limits(c);
    if (!lim) return { lim: null, list: [] as Json[], excluded: [] as Json[], loaded: false };
    const best = this.env.store.data.bestiaryXmm;
    if (!best) return { lim, list: [] as Json[], excluded: [] as Json[], loaded: false };
    const maxCr = this.crNum(lim.cr);
    const crSort = (a: Json, b: Json) => this.crNum(b.cr) - this.crNum(a.cr) || a.name.localeCompare(b.name);
    const inRange = (best.monster || []).filter((m: Json) => {
      const t = typeof m.type === 'string' ? m.type : m.type?.type;
      return t === 'beast' && this.crNum(m.cr) <= maxCr;
    }).map((m: Json) => this.shape(m));
    return {
      lim,
      list: inRange.filter((f: Json) => lim.fly || !f.flying).sort(crSort),
      excluded: inRange.filter((f: Json) => !lim.fly && f.flying).sort(crSort),
      loaded: true,
    };
  }

  known(c: CharData): string[] {
    if (!Array.isArray(c.wildShapeKnown)) c.wildShapeKnown = [];
    return c.wildShapeKnown;
  }

  allForms(): Json[] {
    const best = this.env.store.data.bestiaryXmm;
    if (!best) return [];
    return (best.monster || []).filter((m: Json) => {
      const t = typeof m.type === 'string' ? m.type : m.type?.type;
      return t === 'beast';
    }).map((m: Json) => this.shape(m));
  }

  current(c: CharData): Json {
    if (!c.wildShape?.name) return null;
    const nm = c.wildShape.name;
    const forms = this.forms(c);
    const f = forms.list.find((x: Json) => x.name === nm)
      || forms.excluded.find((x: Json) => x.name === nm)
      || (this.known(c).includes(nm) ? this.allForms().find((x) => x.name === nm) : null)
      || this.allForms().find((x) => x.name === nm);
    if (!f) return null;
    return { ...f, hpNow: c.wildShape.hpNow ?? f.hp };
  }
}

/* ---------------- 特性里的法术表（领域法术、结社法术…）：到级自动获得 ---------------- */

export class Unlocks {
  isSpellTable(e: Json): boolean {
    if (!e || typeof e !== 'object' || e.type !== 'table' || !Array.isArray(e.rows)) return false;
    const labels = (e.colLabels || []).map(String);
    const lvCol = labels.findIndex((l: string) => /等级|级/.test(l));
    if (lvCol < 0) return false;
    return e.rows.some((r: Json[]) => (r || []).some((cell, i) => i !== lvCol && /\{@spell /.test(String(cell))));
  }

  tablesIn(entries: Json[], out: Json[] = [], owner: string | null = null): Json[] {
    for (const e of entries || []) {
      if (this.isSpellTable(e)) out.push({ ...e, _owner: owner });
      else if (e && typeof e === 'object' && e.entries) this.tablesIn(e.entries, out, e.name || owner);
    }
    return out;
  }

  spellsIn(cell: unknown): Array<{ name: string; src: string }> {
    const out: Array<{ name: string; src: string }> = [];
    const re = /\{@spell\s+([^}|]+)(?:\|([^}]*))?\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(String(cell)))) out.push({ name: m[1].trim(), src: (m[2] || 'XPHB').trim() });
    if (!out.length) {
      for (const part of String(cell).split(/[，,、]/)) {
        const n = part.replace(/\{@\w+\s+([^}|]+)[^}]*\}/g, '$1').trim();
        if (n && !/^\d+$/.test(n)) out.push({ name: n, src: 'XPHB' });
      }
    }
    return out;
  }

  all(char: CharData) {
    const res = char._resolved || {};
    const rows: Array<{ level: number; name: string; src: string; owner: string; cls: string; reached: boolean; owned: boolean }> = [];
    const onCard = new Set((char.spells || []).map((s: Json) => s.name));
    for (const k of res.classes || []) {
      for (const f of [...(k.features || []), ...(k.subFeatures || [])]) {
        for (const t of this.tablesIn(f.entries, [], f.name)) {
          const labels = (t.colLabels || []).map(String);
          const lvCol = labels.findIndex((l: string) => /等级|级/.test(l));
          t.rows.forEach((r: Json[]) => {
            const lv = parseInt(String(r?.[lvCol]).replace(/\D/g, ''), 10);
            if (!Number.isFinite(lv)) return;
            (r || []).forEach((cell, i) => {
              if (i === lvCol) return;
              for (const s of this.spellsIn(cell)) {
                rows.push({ level: lv, name: s.name, src: s.src, owner: t.caption || t._owner || f.name, cls: k.cls.name, reached: k.level >= lv, owned: onCard.has(s.name) });
              }
            });
          });
        }
      }
    }
    const seen = new Set<string>();
    return rows
      .filter((r) => { const k2 = r.level + '|' + r.name + '|' + r.owner; if (seen.has(k2)) return false; seen.add(k2); return true; })
      .sort((a, b) => a.level - b.level || a.name.localeCompare(b.name, 'zh'));
  }

  grantReached(char: CharData): number {
    const spells = char.spells || (char.spells = []);
    let n = 0;
    for (const r of this.all(char)) {
      if (!r.reached || r.owned) continue;
      spells.push({ name: r.name, prepared: true, always: true, from: r.owner });
      n++;
    }
    return n;
  }

  clearGranted(char: CharData): number {
    const before = (char.spells || []).length;
    char.spells = (char.spells || []).filter((s: Json) => !s.always);
    return before - char.spells.length;
  }
}
