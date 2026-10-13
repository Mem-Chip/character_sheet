/**
 * 工具 / 语言 / 物品 / 可选项 / 特性内选项（移植自原项目 rules/items.js）。
 * 起始装备包（PackRules）是建卡流程的一部分，随建卡界面一起移植。
 */
import type { SheetEnv } from './env';
import { Source } from './source';
import type { Json } from './store';
import { entryText, proseExpertiseChoice } from './text';

/* ---------------- 工具熟练（背景三种写法） ---------------- */

export const TOOL_KEYS: Record<string, { id: string; label: string; types: string[] }> = {
  anyArtisansTool: { id: 'artisan', label: '工匠工具', types: ['AT'] },
  anyMusicalInstrument: { id: 'instrument', label: '乐器', types: ['INS'] },
  anyGamingSet: { id: 'gaming', label: '赌具', types: ['GS'] },
  anyTool: { id: 'anyTool', label: '任意工具', types: ['AT', 'INS', 'GS', 'T'] },
};

export class ToolRules {
  readonly KEYS = TOOL_KEYS;
  constructor(private readonly env: SheetEnv) {}

  poolFor(key: string) {
    if (this.KEYS[key]) return this.KEYS[key];
    const k = String(key).toLowerCase();
    if (/artisan|工匠/.test(k)) return this.KEYS.anyArtisansTool;
    if (/musical|instrument|乐器/.test(k)) return this.KEYS.anyMusicalInstrument;
    if (/gaming|赌具/.test(k)) return this.KEYS.anyGamingSet;
    return null;
  }

  /** 自选池里的工具（只认 2024 核心、排除魔法物品、按名字去重） */
  items(poolId: string): Array<{ name: string; type: string; source: string }> {
    const d = this.env.store.data;
    const all = [...(d.itemsBase?.baseitem || []), ...(d.items?.item || [])];
    const K = Object.values(this.KEYS).find((x) => x.id === poolId);
    const types = K ? K.types : ['AT', 'INS', 'GS', 'T'];
    const seen = new Set<string>();
    const out: Array<{ name: string; type: string; source: string }> = [];
    for (const x of all) {
      const t = String(x.type).split('|')[0];
      if (!types.includes(t)) continue;
      if (!Source.isCore2024(x)) continue;
      if (x.rarity && x.rarity !== 'none') continue;
      if (seen.has(x.name)) continue;
      seen.add(x.name);
      out.push({ name: x.name, type: t, source: x.source });
    }
    out.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    return out;
  }

  /** 背景里的固定工具键是英文小写名 → 按 ENG_name 反查中文 */
  resolveFixed(key: string): string | null {
    const d = this.env.store.data;
    const want = String(key).toLowerCase();
    const all = [...(d.itemsBase?.baseitem || []), ...(d.items?.item || [])];
    const hits = all.filter((x: Json) => String(x.ENG_name || '').toLowerCase() === want);
    if (!hits.length) return null;
    return (hits.find((h: Json) => Source.isCore2024(h)) || hits[0]).name;
  }

  fromBackground(bg: Json): { fixed: string[]; choices: Array<{ key: string; pool: string; label: string; count: number }> } {
    const fixed: string[] = [];
    const choices: Array<{ key: string; pool: string; label: string; count: number }> = [];
    for (const tp of bg?.toolProficiencies || []) {
      for (const [k, v] of Object.entries(tp)) {
        const pool = this.poolFor(k);
        if (pool) choices.push({ key: k, pool: pool.id, label: pool.label, count: typeof v === 'number' ? v : 1 });
        else {
          const nm = this.resolveFixed(k);
          if (nm) fixed.push(nm);
        }
      }
    }
    return { fixed, choices };
  }
}

/* ---------------- 语言 ---------------- */

export class LanguageRules {
  /** 职业特殊语言：数据里没有 languageProficiencies，只能认正文 */
  readonly SPECIAL = [
    { name: '德鲁伊语', pattern: /你学会了德鲁伊语/, alsoChoose: 0 },
    { name: '盗贼黑话', pattern: /你习得盗贼黑话/, alsoChoose: 1 },
  ];
  readonly TYPES = { standard: '标准语言', rare: '稀有语言' };
  constructor(private readonly env: SheetEnv) {}

  list(type?: string): Array<{ name: string; type: string; origin: string }> {
    const all = this.env.store.data.languages?.language || [];
    const seen = new Set<string>();
    const out: Array<{ name: string; type: string; origin: string }> = [];
    for (const l of all) {
      if (type && l.type !== type) continue;
      if (!Source.isCore2024(l)) continue;
      if (seen.has(l.name)) continue;
      seen.add(l.name);
      out.push({ name: l.name, type: l.type, origin: l.origin });
    }
    out.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    return out;
  }
}

/* ---------------- 物品 ---------------- */

export class ItemRules {
  readonly MAX_ATTUNE = 3;
  constructor(private readonly env: SheetEnv) {}

  magicItems(): Json[] {
    return (this.env.store.data.items?.item || []).filter((x: Json) => x.rarity && x.rarity !== 'none' && Source.isCore2024(x));
  }

  attuneOf(ent: Json): { need: boolean; optional: boolean; text: string } {
    const r = ent?.reqAttune;
    if (r === true) return { need: true, optional: false, text: '' };
    if (typeof r === 'string' && r) {
      if (r === 'optional') return { need: false, optional: true, text: '可同调' };
      return { need: true, optional: false, text: r };
    }
    return { need: false, optional: false, text: '' };
  }

  attuned(char: Json) {
    const list = (char.equipment || []).filter((q: Json) => q.attuned);
    return { list, count: list.length, max: this.MAX_ATTUNE, over: list.length > this.MAX_ATTUNE };
  }

  /** 装备包展开（packContents，至多两层） */
  expand(name: string, depth = 0): Array<{ name: string; qty: number; label: string; special?: boolean }> | null {
    const out: Array<{ name: string; qty: number; label: string; special?: boolean }> = [];
    const ent = this.find(name);
    const contents = ent?.packContents;
    if (!contents?.length || depth >= 2) return null;
    for (const it of contents) {
      if (!it) continue;
      if (typeof it === 'string') {
        const nm = it.split('|')[0];
        const sub = this.expand(nm, depth + 1);
        if (sub) out.push(...sub); else out.push({ name: nm, qty: 1, label: nm });
        continue;
      }
      if (it.item) {
        const nm = String(it.item).split('|')[0];
        out.push({ name: nm, qty: Math.max(1, +it.quantity || 1), label: nm });
        continue;
      }
      if (it.special) out.push({ name: it.special, qty: 1, label: it.special, special: true });
    }
    return out.length ? out : null;
  }

  /** 按名字找物品：基础物品优先，2024 优先 */
  find(name: string): Json | null {
    const d = this.env.store.data;
    const base = d.itemsBase?.baseitem || [];
    const items = d.items?.item || [];
    return base.find((x: Json) => x.name === name && Source.is2024(x))
      || base.find((x: Json) => x.name === name)
      || items.find((x: Json) => x.name === name && Source.is2024(x))
      || items.find((x: Json) => x.name === name)
      || null;
  }

  /** 物品组（奥术法器 / 德鲁伊法器 / 圣徽…）：名字 → 成员 */
  groups(): Map<string, { name: string; scfType: string; focus: unknown[]; items: string[]; source: string }> {
    const list = this.env.store.data.items?.itemGroup || [];
    const out = new Map<string, { name: string; scfType: string; focus: unknown[]; items: string[]; source: string }>();
    for (const g of list) {
      if (!out.has(g.name) || Source.is2024(g)) {
        out.set(g.name, {
          name: g.name, scfType: g.scfType || '', focus: g.focus || [],
          items: (g.items || []).map((x: unknown) => String(x).split('|')[0]),
          source: g.source,
        });
      }
    }
    return out;
  }

  groupOf(name: string) { return this.groups().get(String(name || '')) || null; }

  weight(char: Json, sheet?: Json) {
    const strength = sheet?.['score:str'] ?? (char.abilities?.str || 10);
    let total = 0;
    let unknown = 0;
    let count = 0;
    for (const q of char.equipment || []) {
      const ent = this.find(q.name);
      const w = ent?.weight;
      const qty = Math.max(1, +q.qty || 1);
      count += qty;
      if (typeof w === 'number') total += w * qty; else unknown++;
    }
    const capacity = strength * 15;
    return {
      total: Math.round(total * 10) / 10, unknown, count, capacity,
      push: strength * 30, over: total > capacity, left: Math.max(0, Math.round((capacity - total) * 10) / 10),
    };
  }
}

/* ---------------- 可选项（祈唤 / 超魔法 / 战技） ---------------- */

export class OptionalFeatureRules {
  readonly TYPE_CN: Record<string, string> = { EI: '魔能祈唤', 'MV:B': '战技', MM: '超魔法', AS: '奥术射击', ED: '元能选项' };
  constructor(private readonly env: SheetEnv) {}

  refsOf(feature: Json): string[] {
    const out: string[] = [];
    for (const e of feature?.entries || []) {
      if (e && typeof e === 'object') {
        if (e.type === 'refOptionalfeature' && e.optionalfeature) out.push(String(e.optionalfeature).split('|')[0]);
        if (e.type === 'options') {
          for (const it of e.entries || []) {
            if (it?.type === 'refOptionalfeature' && it.optionalfeature) out.push(String(it.optionalfeature).split('|')[0]);
          }
        }
      }
    }
    return [...new Set(out)];
  }

  /** 两种形态（数组下标 = 等级-1 / 对象键 = 等级）归一化成 {等级: 数量} */
  progressionOf(g: Json): Record<number, number> {
    const p = g.progression;
    const out: Record<number, number> = {};
    if (Array.isArray(p)) p.forEach((n: number, i: number) => { if (n) out[i + 1] = n; });
    else if (p && typeof p === 'object') for (const [lv, n] of Object.entries(p)) if (n) out[Number(lv)] = n as number;
    return out;
  }

  forClass(k: Json): Json[] {
    const out: Json[] = [];
    for (const g of k.cls.optionalfeatureProgression || []) {
      const prog = this.progressionOf(g);
      const lvls = Object.keys(prog).map(Number).filter((l) => l <= k.level);
      if (!lvls.length) continue;
      const maxLv = Math.max(...lvls);
      const count = prog[maxLv];
      const types = g.featureType || [];
      out.push({
        id: 'opt-' + types.join('_'), kind: 'optfeature', count, types, cls: k.cls.name,
        label: g.name || this.TYPE_CN[types[0]] || types.join('/'), from: `${k.cls.name} ${maxLv} 级`, pool: 'optionalfeature',
      });
    }
    return out;
  }

  forSubclass(k: Json): Json[] {
    const out: Json[] = [];
    const groups = new Map<string, { count: number; refs: Set<string>; name: string; level: number }>();
    for (const f of k.subFeatures || []) {
      const refs = this.refsOf(f);
      if (!refs.length) continue;
      const txt = (f.entries || []).map((e: Json) => (typeof e === 'string' ? e : JSON.stringify(e))).join(' ');
      let count = 1;
      const optNode = (f.entries || []).find((e: Json) => e && e.type === 'options' && e.count);
      if (optNode) count = optNode.count;
      else {
        const m = txt.match(/习得(\d+|一|二|三|四|五|六|七|八|九|十)种自选/);
        if (m) count = ({ 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 } as Record<string, number>)[m[1]] || Number(m[1]) || 1;
      }
      const key = k.subclassName + '|' + count;
      if (!groups.has(key)) groups.set(key, { count, refs: new Set(), name: f.name, level: f.level });
      for (const r of refs) groups.get(key)!.refs.add(r);
    }
    for (const g of groups.values()) {
      out.push({
        id: 'subopt-' + k.subclassName + '-' + g.count, kind: 'optfeature', count: g.count, cls: k.cls.name,
        label: `${k.subclassName}「${g.name}」`, from: `${k.cls.name}·${k.subclassName} ${g.level} 级`,
        pool: 'whitelist', whitelist: [...g.refs],
      });
    }
    return out;
  }

  options(choice: Json): Json[] {
    const all = this.env.store.data.optionalfeatures?.optionalfeature || [];
    if (choice.pool === 'whitelist') {
      const set = new Set(choice.whitelist || []);
      const seen = new Set<string>();
      return all
        .filter((o: Json) => set.has(o.name) && Source.isCore2024(o))
        .filter((o: Json) => (seen.has(o.name) ? false : (seen.add(o.name), true)))
        .sort((a: Json, b: Json) => a.name.localeCompare(b.name, 'zh'));
    }
    const seen2 = new Set<string>();
    return all
      .filter((o: Json) => Source.isCore2024(o) && (o.featureType || []).some((t: string) => (choice.types || []).includes(t)))
      .filter((o: Json) => (seen2.has(o.name) ? false : (seen2.add(o.name), true)))
      .sort((a: Json, b: Json) => a.name.localeCompare(b.name, 'zh'));
  }
}

/* ---------------- 特性正文里的「从下列选项选一项」 ---------------- */

export interface OptionGroup {
  count: number;
  refs: string[];
  options: Json[];
  classFeatures: string[];
}

export class FeatureOptions {
  constructor(private readonly env: SheetEnv) {}

  extract(feature: Json): OptionGroup[] {
    const groups: OptionGroup[] = [];
    const entries = feature.entries || [];
    const push = (g: OptionGroup) => { if (g && (g.refs?.length || g.options?.length || g.classFeatures?.length)) groups.push(g); };
    const walk = (node: Json): void => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (node.type === 'options') {
        const refs: Array<string | { classFeature: string }> = [];
        const options: Json[] = [];
        for (const it of node.entries || []) {
          if (it?.type === 'refOptionalfeature' && it.optionalfeature) refs.push(String(it.optionalfeature).split('|')[0]);
          else if (it?.type === 'refClassFeature' && it.classFeature) refs.push({ classFeature: String(it.classFeature).split('|')[0] });
          else if (it?.name) options.push(it);
        }
        const classFeatures = refs.filter((r): r is { classFeature: string } => typeof r === 'object').map((r) => r.classFeature);
        const optRefs = refs.filter((r): r is string => typeof r === 'string');
        const count = node.count || 1;
        if (optRefs.length || options.length || classFeatures.length) push({ count, refs: optRefs, options, classFeatures });
        for (const it of node.entries || []) walk(it);
        return;
      }
      for (const k of ['entries', 'entry', 'items']) if (node[k] !== undefined) walk(node[k]);
    };
    walk(entries);
    if (Array.isArray(entries)) {
      const flat = entries.filter((x: Json) => x && typeof x === 'object' && x.name && (x.entries || x.entry));
      const lead = entries.find((x: Json) => typeof x === 'string' && /(从下列|下列|从以下|以下)[^。]{0,14}(选择|选一项|选其一|择一)/.test(x));
      if (flat.length >= 2 && lead) {
        const already = groups.some((g) => g.options.some((o) => o.name === flat[0].name));
        if (!already) {
          const m = lead.match(/选择?\s*(\d+|一|二|三|四|五|六)\s*(项|种|个)/);
          const count = m ? (({ 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 } as Record<string, number>)[m[1]] || Number(m[1]) || 1) : 1;
          push({ count, refs: [], options: flat, classFeatures: [] });
        }
      }
    }
    return groups;
  }

  optionKey(char: Json, c: Json): string {
    const cls = (char._resolved?.classes || []).find((x: Json) => x.cls.name === c.cls);
    const src = cls?.cls.source || 'XPHB';
    const name = String(c.from || '').split(/[ L（(]/)[0] || c.cls;
    return `${src}:${c.cls}:${name}:${c.level ?? 0}#${c.id}`;
  }

  choicesFor(feature: Json, kindLabel: string): Json[] {
    const out: Json[] = [];
    this.extract(feature).forEach((g, i) => {
      const id = `featopt-${feature.name}-${i}`;
      let pool: string;
      let whitelist: string[] | undefined;
      let candidates: string[] | undefined;
      let label: string;
      if (g.refs.length) {
        pool = 'whitelist'; whitelist = g.refs;
        label = `${kindLabel}：从「${feature.name}」的选项里选`;
      } else if (g.classFeatures.length) {
        pool = 'classFeature'; candidates = g.classFeatures;
        label = `${kindLabel}：从「${feature.name}」里选一项特性`;
      } else {
        pool = 'inline'; candidates = g.options.map((o) => o.name).filter(Boolean);
        label = `${kindLabel}：从「${feature.name}」的选项里选`;
      }
      out.push({
        id, kind: pool === 'classFeature' ? 'classFeature' : 'optfeature',
        count: g.count, pool, whitelist, candidates,
        cls: kindLabel, level: feature.level ?? 0,
        from: `${feature.name}${feature.level != null ? ` L${feature.level}` : ''}`,
        label,
      });
    });
    return out;
  }

  grantedCandidates(resolved: Json): Set<string> {
    const set = new Set<string>();
    for (const k of resolved?.classes || []) {
      for (const f of [...(k.features || []), ...(k.subFeatures || [])]) {
        for (const g of this.extract(f)) for (const nm of g.classFeatures) set.add(`${f.className}|${nm}`);
      }
    }
    return set;
  }

  forClass(k: Json): Json[] {
    const out = this.env.optional.forClass(k);
    for (const f of k.features || []) out.push(...this.choicesFor(f, k.cls.name));
    return out;
  }

  forSubclass(k: Json): Json[] {
    const out = this.env.optional.forSubclass(k);
    for (const f of k.subFeatures || []) out.push(...this.choicesFor(f, `${k.cls.name}·${k.subclassName}`));
    return out;
  }

  proseChoices(feature: Json, kindLabel: string): Json[] {
    const out: Json[] = [];
    if (this.env.abilities.get(feature.source, feature.name, feature.className, feature.level)) return out;
    if (this.extract(feature).length) return out;
    if (/专精/.test(String(feature.name || ''))) return out;
    if ((feature.entries || []).some((e: Json) => e && typeof e === 'object' && Array.isArray(e.items))) return out;
    const text = (feature.entries || []).map((e: Json) => (typeof e === 'string' ? e : entryText(e))).join('\n');
    const ex = proseExpertiseChoice(text);
    if (ex) {
      out.push({
        ...ex,
        cls: kindLabel,
        level: feature.level ?? 0,
        from: `${feature.name}${feature.level != null ? ` L${feature.level}` : ''} · 正文句式`,
        label: `「${feature.name}」：${ex.label}`,
      });
    }
    return out;
  }

  proseForClass(k: Json): Json[] {
    const out: Json[] = [];
    for (const f of k.features || []) out.push(...this.proseChoices(f, k.cls.name));
    return out;
  }

  proseForSubclass(k: Json): Json[] {
    const out: Json[] = [];
    for (const f of k.subFeatures || []) out.push(...this.proseChoices(f, `${k.cls.name}·${k.subclassName}`));
    return out;
  }

  inlineDescriptions(feature: Json, name: string): Json | null {
    for (const g of this.extract(feature)) {
      const hit = (g.options || []).find((o) => o.name === name);
      if (hit) return hit;
    }
    return null;
  }
}
