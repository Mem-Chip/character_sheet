/**
 * 资源池与休息（移植自原项目 rules/pools.js）。
 *
 * 资源池两个来源：职业等级表里的那几列（狂暴次数 / 荒野形态 / 回气 / 功力…）+ 能力数据的 resources 声明。
 * 同名（或表列名以能力名开头）的合并成一个池；玩家记账在 char.resources[key] = { used, max? }。
 */
import { clamp } from './constants';
import { ABILS, run, type EvalEnv, type FnImpl } from '../expr';
import { resolveNum, totalLevel } from './abilities';
import type { SheetEnv } from './env';
import type { Json } from './store';
import type { CharData } from './character';

export const RESOURCE_PICKS: Record<string, { n: number; hint: string }> = {
  神圣干预: { n: 2, hint: '指定你要请求的法术（用掉一次 = 一次请求）' },
  魔法物品: { n: 3, hint: '你这一级选定的方案/物品（用掉一次 = 用其中一件）' },
  贤者石: { n: 2, hint: '这次用的是哪一块贤者石' },
  已知方案: { n: 2, hint: '奇械师的已知方案' },
};

/** 只是「计数」、不是可消耗的池（已知祈唤数、已知方案数…）：战斗里不当资源用 */
export const COUNT_ONLY = new Set(['祈唤', ...Object.keys(RESOURCE_PICKS)]);

export class Resources {
  // 只有**能用掉、会恢复**的才算资源池。注意别把「已知祈唤 / 已知戏法」这种**已知数量上限**加进来 ——
  // 那是「最多能知道几个」，不是次数池（加了会多出一个永远用不掉的池子）
  readonly SPENDABLE = /^(狂暴次数|引导神力|荒野形态|回气|功力|术法点|宿敌|已知方案|魔法物品)$/;
  readonly RECOVERY: Record<string, string> = {
    狂暴次数: 'long', 引导神力: 'long', 荒野形态: 'long', 回气: 'long',
    功力: 'short', 术法点: 'long', 宿敌: 'long',
    已知方案: 'long', 魔法物品: 'long',
  };
  /** 2024：这几种短休只恢复一次，长休全部恢复 */
  readonly SHORT_REGAIN_ONE = new Set(['狂暴次数', '引导神力', '荒野形态', '回气']);
  readonly RECOVERY_CN: Record<string, string> = { short: '短休恢复', long: '长休恢复', initiative: '先攻时恢复', none: '特殊', '?': '按规则' };

  constructor(private readonly env: SheetEnv) {}

  pickSpec(r: Json): Json {
    const nm = String(r?.name || '').trim();
    for (const a of Object.values(this.env.abilities.data.entries)) {
      for (const decl of a.resources || []) {
        if (!decl.pick) continue;
        if (decl.name === nm) return { ...decl.pick, name: nm, from: 'data' };
      }
    }
    const hit = RESOURCE_PICKS[nm];
    return hit ? { ...hit, name: nm, from: 'table' } : null;
  }

  /** 等级表单元格 → 数值 / 骰子 / 文本 */
  cellValue(v: Json): { kind: string; n?: number; text?: string; blank?: boolean; speed?: boolean } {
    if (v == null) return { kind: 'none' };
    if (typeof v === 'number') return { kind: 'count', n: v };
    if (typeof v === 'object') {
      if (v.type === 'dice') {
        const d = (v.toRoll || [])[0];
        return d ? { kind: 'dice', text: `${d.number}d${d.faces}`, n: d.number } : { kind: 'none' };
      }
      if (v.type === 'bonus') return { kind: 'bonus', n: v.value };
      if (v.type === 'bonusSpeed') return { kind: 'bonus', n: v.value, speed: true };
      return { kind: 'none' };
    }
    const s = String(v).replace(/\{@\w+ ([^}|]+)[^}]*\}/g, '$1').trim();
    const m = s.match(/^(\d+)d(\d+)$/i);
    if (m) return { kind: 'dice', text: s.toLowerCase(), n: +m[1] };
    const n = Number(s.replace(/[+＋]/g, ''));
    if (Number.isFinite(n)) return { kind: 'count', n, blank: s === '—' || s === '' };
    return { kind: 'text', text: s };
  }

  fromClass(k: Json): Json[] {
    const out: Json[] = [];
    const lvl = clamp(k.level, 1, 20);
    for (const g of k.cls.classTableGroups || []) {
      const rows = g.rows || [];
      if (!rows.length) continue;
      (g.colLabels || []).forEach((label: unknown, i: number) => {
        const name = String(label).replace(/\{@\w+ ([^}|]+)[^}]*\}/g, '$1').trim();
        if (!this.SPENDABLE.test(name)) return;
        const cell = this.cellValue(rows[lvl - 1]?.[i]);
        if (cell.kind !== 'count' || cell.blank) return;
        out.push({
          key: `table:${k.cls.source}:${k.cls.name}:${name}`,
          name, max: cell.n, recovery: this.RECOVERY[name] || '?',
          ...(this.SHORT_REGAIN_ONE.has(name) ? { regain: [{ on: 'short', amount: 1 }] } : {}),
          from: `${k.cls.name} ${lvl} 级 · 职业表`, source: 'levelTable',
        });
      });
    }
    return out;
  }

  /**
   * 资源上限公式：数字 / 'pb' / 属性名 / 'max(1, int)' / 'table'（交给等级表），
   * 其余按表达式算（`level * 5`、`cond(level >= 17, 2, 1)`）—— 表达式里的 `level` 是**该职业**的等级。
   */
  resolveFormula(formula: unknown, sheet: Json, char: CharData | null, cls?: string): number | null {
    if (formula == null) return null;
    if (typeof formula === 'number') return formula;
    const s = String(formula).trim();
    if (s === 'table') return null;
    const m = s.match(/^max\s*\(\s*(\d+)\s*,\s*([^)]+)\)$/i);
    if (m) {
      const inner = this.resolveFormula(m[2].trim(), sheet, char, cls);
      return inner == null ? +m[1] : Math.max(+m[1], inner);
    }
    const ctx = { out: sheet || {}, char: char || null };
    const viaNum = resolveNum(s, ctx);
    if (typeof viaNum === 'number' && Number.isFinite(viaNum)) {
      if (viaNum !== 0) return viaNum;
      const isNumber = Number.isFinite(Number(s));
      const isKnown = /^(pb|level|spellcasting|mod:[a-z]+|[a-z]{2,3})$/i.test(s) || /调整值|调整/.test(s);
      if (!isNumber && !isKnown) return this.exprFormula(s, sheet, char, cls);
      const m0 = s.match(/^mod:([a-z]{3})$/i);
      if (m0 && sheet?.['mod:' + m0[1]] === undefined && sheet?.[m0[1]] === undefined) return null;
      return viaNum;
    }
    return this.exprFormula(s, sheet, char, cls);
  }

  /** 表达式公式。根：level（该职业等级，非职业资源 = 总等级）、totalLevel、pb、mod、六个属性名；函数：max/min/floor/ceil/cond/levelOf */
  private exprFormula(src: string, sheet: Json, char: CharData | null, cls?: string): number | null {
    const classes: Json[] = char?._resolved?.classes || [];
    const total = sheet?.level || totalLevel(char);
    const levelOf = (name: string) => classes.find((k) => k.cls?.name === name)?.level ?? 0;
    const mod = Object.fromEntries(ABILS.map((a) => [a, sheet?.['mod:' + a] ?? 0]));
    const fns: Record<string, FnImpl> = {
      max: (a) => Math.max(...(a as number[])),
      min: (a) => Math.min(...(a as number[])),
      floor: (a) => Math.floor(a[0] as number),
      ceil: (a) => Math.ceil(a[0] as number),
      cond: (a) => (a[0] ? a[1] : a[2]),
      levelOf: (a) => levelOf(String(a[0])),
    };
    const env: EvalEnv = {
      root(name) {
        if (name === 'level') return cls ? levelOf(cls) || total : total;
        if (name === 'totalLevel') return total;
        if (name === 'pb') return sheet?.pb ?? 2 + Math.floor((Math.max(1, total) - 1) / 4);
        if (name === 'mod') return mod;
        if ((ABILS as readonly string[]).includes(name)) return mod[name];
        throw new Error(`资源公式里不认识「${name}」`);
      },
      fn: (name) => fns[name],
    };
    try {
      const v = run(src, env);
      return typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : null;
    } catch {
      return null;
    }
  }

  fromAbilities(derived: Json, char: CharData, sheet: Json): Json[] {
    const out: Json[] = [];
    for (const r of derived?.resources || []) {
      if (!r.id || !r.name) continue;
      out.push({
        key: `ability:${r.from}:${r.id}`, name: r.name,
        id: r.id,
        max: this.resolveFormula(r.formula, sheet, char, r.cls),
        recovery: r.recovery || '?', from: r.from, note: r.note || '', source: 'ability', _src: r._src ?? null,
        override: !!r.override,
        regain: Array.isArray(r.regain) ? r.regain : null,
      });
    }
    return out;
  }

  collect(char: CharData, sheet: Json): Json[] {
    const out = new Map<string, Json>();
    const covered = this.env.abilities.hrCoverKeys(char);
    // 家规覆盖的键可以是 `<来源>:<名字>`，也可以是职业特性的 `<来源>:<职业>:<名字>:<等级>`
    const isCovered = (nm: string) => covered.some((k) => { const p = k.split(':'); return p.length === 4 ? p[2] === nm : k.slice(k.indexOf(':') + 1) === nm; });
    for (const k of char._resolved?.classes || []) {
      const clsCovered = [...(k.features || []), ...(k.subFeatures || [])].some((f: Json) => isCovered(f.name));
      if (clsCovered) continue;
      for (const r of this.fromClass(k)) if (!out.has(r.name)) out.set(r.name, r);
    }
    const tableNames = [...out.keys()];
    const abilityPools = this.fromAbilities(char._derived, char, sheet);
    const mergedAway = new Map<string, string>();
    for (const r of abilityPools) {
      const host = (tableNames.find((n) => n !== r.name && n.startsWith(r.name)) || null) || (out.has(r.name) ? r.name : null);
      if (host) {
        const cur = out.get(host)!;
        const next = { ...cur };
        if (cur.max == null && r.max != null) next.max = r.max;
        if (r.override && r.max != null) {
          next.max = r.max;
          if (r.recovery) next.recovery = r.recovery;
        }
        if (r.note && !next.note) next.note = r.note;
        if (r.regain?.length) {
          const merged = [...(cur.regain || [])];
          for (const g of r.regain) if (!merged.some((x: Json) => x.on === g.on)) merged.push(g);
          next.regain = merged;
        }
        out.set(host, next);
        if (r.key !== host) mergedAway.set(r.key, out.get(host).key);
        continue;
      }
      if (!out.has(r.name)) out.set(r.name, r);
    }
    const state = char.resources || {};
    for (const r of out.values()) {
      const legacy = [...mergedAway.entries()].find(([, to]) => to === r.key)?.[0];
      const st = state[r.key] || (legacy ? state[legacy] : null);
      r.used = st?.used || 0;
      if (st?.max != null) r.max = st.max;
      r.left = r.max == null ? null : Math.max(0, r.max - (r.used || 0));
    }
    return [...out.values()];
  }
}

/** 休息（原项目 Rest：直接改 char 的记账字段；sheet 是当前算出来的 SHEET） */
export class Rest {
  constructor(private readonly env: SheetEnv) {}

  restoreResources(char: CharData, sheet: Json, kind: 'short' | 'long', opts: { detail?: boolean } = {}): number | string[] {
    const pools = this.env.resources.collect(char, sheet);
    const state = char.resources || (char.resources = {});
    const got: string[] = [];
    for (const r of pools) {
      const rec = String(r.recovery || '');
      const hit = kind === 'long' ? rec === 'short' || rec === 'long' : rec === 'short';
      if (hit) {
        if (state[r.key]?.used) { state[r.key] = { ...state[r.key], used: 0 }; got.push(r.name); }
        continue;
      }
      const rules = (r.regain || []).filter((g: Json) => g.on === kind);
      if (!rules.length) continue;
      const used = state[r.key]?.used || 0;
      if (!used) continue;
      let back = 0;
      for (const g of rules) {
        if (g.when === 'empty' && used < (r.max ?? Infinity)) continue;
        back = Math.max(back, +g.amount || 0);
      }
      if (!back) continue;
      state[r.key] = { ...(state[r.key] || {}), used: Math.max(0, used - back) };
      got.push(`${r.name} +${Math.min(back, used)}`);
    }
    return opts.detail ? got : got.length;
  }

  initiative(char: CharData, sheet: Json): string[] {
    const pools = this.env.resources.collect(char, sheet);
    const state = char.resources || (char.resources = {});
    const got: string[] = [];
    for (const r of pools) {
      const used = state[r.key]?.used || 0;
      if (String(r.recovery || '') === 'initiative') {
        if (used) { state[r.key] = { ...state[r.key], used: 0 }; got.push(r.name); }
        continue;
      }
      const rules = (r.regain || []).filter((g: Json) => g.on === 'initiative');
      if (!rules.length || !used) continue;
      let back = 0;
      for (const g of rules) {
        if (g.when === 'empty' && used < (r.max ?? Infinity)) continue;
        back = Math.max(back, +g.amount || 0);
      }
      if (!back) continue;
      state[r.key] = { ...(state[r.key] || {}), used: Math.max(0, used - back) };
      got.push(`${r.name} +${Math.min(back, used)}`);
    }
    return got;
  }

  restoreSlots(char: CharData, sheet: Json, kind: 'short' | 'long'): boolean {
    const pact = sheet?.spell?.pact;
    const before = JSON.stringify(char.slots || {});
    if (kind === 'long') char.slots = {};
    else if (pact) char.slots = {};
    return before !== JSON.stringify(char.slots || {});
  }

  restoreHp(char: CharData, kind: 'short' | 'long'): boolean {
    if (kind !== 'long') return false;
    char.hp = { current: null, temp: 0, maxBonus: char.hp?.maxBonus || 0 };
    char.wildShape = null;
    return true;
  }

  restoreHitDice(char: CharData, kind: 'short' | 'long'): number {
    if (kind !== 'long') return 0;
    const spent = char.hitDiceSpent || (char.hitDiceSpent = {});
    const used = Object.values(spent).reduce((a: number, n) => a + (+(n as number) || 0), 0);
    if (!used) return 0;
    char.hitDiceSpent = {};
    return used;
  }

  do(kind: 'short' | 'long', char: CharData, sheet: Json): string {
    const got = this.restoreResources(char, sheet, kind, { detail: true }) as string[];
    this.restoreSlots(char, sheet, kind);
    const hp = this.restoreHp(char, kind);
    const dice = this.restoreHitDice(char, kind);
    if (kind === 'long' && char.arcaneRecovery) char.arcaneRecovery.used = false;
    const parts = [got.length ? `已恢复：${got.join('、')}` : '没有需要恢复的资源池'];
    parts.push(kind === 'long' ? '法术位已全恢复' : sheet?.spell?.pact ? '契约法术位已恢复' : '法术位不受短休影响');
    if (hp) parts.push('HP 已回满、临时生命值已清空');
    if (dice) parts.push(`恢复了 ${dice} 颗生命骰`);
    if (kind === 'long' && char.arcaneRecovery) parts.push('「奥术回想」的已用标记也清了');
    if (kind === 'short') parts.push('HP 需要花生命骰恢复（在「生命值记账」里手动填）');
    return parts.join('；');
  }

  hitDicePools(char: CharData, sheet: Json): Array<{ faces: number; total: number; used: number; left: number; cls: string }> {
    const out: Array<{ faces: number; total: number; used: number; left: number; cls: string }> = [];
    for (const h of sheet?.hitDice || []) {
      const faces = h.faces;
      const total = h.level || 0;
      const used = Math.min((char.hitDiceSpent || {})[String(faces)] || 0, total);
      const hit = out.find((x) => x.faces === faces);
      if (hit) { hit.total += total; hit.used += used; hit.left = Math.max(0, hit.total - hit.used); }
      else out.push({ faces, total, used, left: Math.max(0, total - used), cls: h.cls?.name || '' });
    }
    for (const p of out) p.left = Math.max(0, p.total - p.used);
    return out;
  }

  spendHitDie(char: CharData, sheet: Json, faces?: number): { faces: number; left: number } | null {
    const pool = this.hitDicePools(char, sheet);
    const f = faces || (pool[0] && pool[0].faces);
    if (!f) return null;
    const p = pool.find((x) => x.faces === f);
    if (!p || p.left <= 0) return null;
    char.hitDiceSpent = char.hitDiceSpent || {};
    const key = String(f);
    char.hitDiceSpent[key] = (char.hitDiceSpent[key] || 0) + 1;
    return { faces: f, left: p.left - 1 };
  }

  refundHitDie(char: CharData, faces: number): boolean {
    const spent = char.hitDiceSpent || {};
    const key = String(faces);
    if (!spent[key]) return false;
    spent[key] -= 1;
    if (spent[key] <= 0) delete spent[key];
    return true;
  }
}
