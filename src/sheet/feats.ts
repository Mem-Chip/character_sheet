/**
 * 专长：槽位 + 前置判定（移植自原项目 rules/feats.js）。
 * 模型是「职业给槽 → 往槽里填」：槽的来源在职业的 featProgression 上，不在专长身上。
 */
import { ABIL_CN } from './constants';
import type { SheetEnv } from './env';
import { Source } from './source';
import type { Json } from './store';

export function fmtPrereq(p: Json[] | null | undefined): string {
  if (!p) return '—';
  const parts: string[] = [];
  for (const x of p) {
    if (x.level && typeof x.level === 'number') parts.push(`等级 ${x.level}`);
    else if (x.level) parts.push(`${x.level.class?.name || ''} ${x.level.level} 级`);
    if (x.ability) for (const a of x.ability) for (const [k, v] of Object.entries(a)) parts.push(`${ABIL_CN[k as keyof typeof ABIL_CN] || k} ${v}`);
    if (x.spell) parts.push('需能施放特定法术');
    if (x.race) parts.push('特定种族');
    if (x.feature) parts.push('特定特性');
    if (x.campaign) parts.push('特定战役');
    if (x.other) parts.push(String(x.other));
  }
  return parts.join('；') || '—';
}

export function sourceShort(s: unknown): string {
  const map: Record<string, string> = {
    XPHB: '2024 PHB', XDMG: '2024 DMG', XMM: '2024 MM', EFA: '2024 奇械师',
    PHB: '2014 PHB', DMG: '2014 DMG', MM: '2014 MM',
    TCE: '塔莎', XGE: '珊娜萨', FRHOF: '被遗忘国度', SCAG: '剑湾', EEPC: '元素邪恶', AU: '自制',
  };
  const k = String(s || '').toUpperCase();
  return map[k] || k || '未知来源';
}

export interface FeatSlot {
  category: string;
  categories: string[];
  label: string;
  from: string;
  fromLevel: number;
  cls: string;
  count: number;
  fromFeature?: boolean;
  fromText?: boolean;
  id: string;
}

export class FeatRules {
  readonly CAT: Record<string, string> = { O: '起源', G: '通用', FS: '战斗风格', 'FS:P': '圣武士战斗风格', 'FS:R': '游侠战斗风格', EB: '史诗恩惠' };
  readonly GROUP: Record<string, string[]> = { FS: ['FS', 'FS:P', 'FS:R'] };
  constructor(private readonly env: SheetEnv) {}

  pool(): Json[] { return this.env.store.data.feats?.feat || []; }
  catOf(f: Json): string[] { return String(f.category || '').split(',').map((s) => s.trim()).filter(Boolean); }

  slots(_char: Json, resolved: Json): FeatSlot[] {
    const out: FeatSlot[] = [];
    for (const k of resolved?.classes || []) {
      for (const f of k.features || []) {
        if (f.name !== '属性值提升') continue;
        const txt = JSON.stringify(f.entries || []);
        if (!/获得属性值提升专长|\{@feat 属性值提升/.test(txt)) continue;
        out.push({
          category: 'G', categories: ['G'], label: '属性值提升',
          from: `${k.cls.name} ${f.level} 级`, fromLevel: f.level, cls: k.cls.name, count: 1, fromFeature: true,
          id: `${k.cls.name}|属性值提升|${f.level}|0`,
        });
      }
      for (const g of k.cls.featProgression || []) {
        const cats = (g.category || []).slice();
        if (!cats.length) cats.push('G');
        for (const [lv, n] of Object.entries(g.progression || {})) {
          if (k.level < Number(lv)) continue;
          const num = Math.max(1, Number(n) || 1);
          for (let i = 0; i < num; i++) {
            out.push({
              category: cats[0], categories: cats, label: g.name,
              from: `${k.cls.name} ${lv} 级`, fromLevel: Number(lv), cls: k.cls.name, count: 1,
              id: `${k.cls.name}|${g.name}|${lv}|${i}`,
            });
          }
        }
      }
      // 勇士 7 级「额外战斗风格」：槽由正文给出
      for (const f of k.subFeatures || []) {
        if (f.featProgression) continue;
        const txt = JSON.stringify(f.entries || []);
        if (/另一个自选的[^"]{0,20}战斗风格专长/.test(txt)) {
          out.push({
            category: 'FS', categories: ['FS'], label: '额外战斗风格',
            from: `${k.cls.name}·${k.subclassName} ${f.level} 级`, fromLevel: f.level,
            cls: k.cls.name, count: 1, fromText: true,
            id: `${k.cls.name}|额外战斗风格|${f.level}|0`,
          });
        }
      }
    }
    out.sort((a, b) => (a.fromLevel || 0) - (b.fromLevel || 0)
      || String(a.cls).localeCompare(String(b.cls), 'zh') || String(a.label).localeCompare(String(b.label), 'zh'));
    return out;
  }

  byName(name: string): Json {
    const all = this.pool().filter((x) => x.name === name);
    if (!all.length) return null;
    return all.find((x) => Source.isCore2024(x)) || all.find((x) => this.catOf(x).length) || all[0];
  }

  /** 已有专长按类别贪心填进槽 */
  assign(feats: string[], slots: FeatSlot[]) {
    const list = (feats || []).filter(Boolean);
    const used = new Array(list.length).fill(false);
    const matched = list.map((name, i) => {
      const f = this.byName(name);
      return { name, i, f, cats: f ? this.catOf(f) : [] };
    });
    const bySlot: Array<{ slot: FeatSlot; name: string | null; index: number }> = [];
    for (const s of slots) {
      const accepted = s.categories?.length ? s.categories : [s.category];
      const hit = matched.find((m) => !used[m.i] && m.cats.some((c) => accepted.includes(c)));
      if (hit) used[hit.i] = true;
      bySlot.push({ slot: s, name: hit ? hit.name : null, index: hit ? hit.i : -1 });
    }
    return { bySlot, unmatched: matched.filter((m) => !used[m.i]) };
  }

  /** 前置判定。遇到没见过的前置结构不猜 —— 拒绝并说明「需人工核查」 */
  canTake(feat: Json, sheet: Json, slot?: Partial<FeatSlot> | null): { ok: boolean; reasons: string[] } {
    if (!feat) return { ok: false, reasons: ['找不到该专长'] };
    if (slot) {
      const accepted = slot.categories && slot.categories.length ? slot.categories : [slot.category!];
      const cats = this.catOf(feat);
      const SUBS: Record<string, string[]> = { FS: ['FS:P', 'FS:R'] };
      for (const [broad, subs] of Object.entries(SUBS)) {
        if (!accepted.includes(broad)) continue;
        for (const s of subs) {
          if (cats.includes(s) && !accepted.includes(s)) {
            return { ok: false, reasons: [`「${this.CAT[s] || s}」需要相应的职业槽（当前槽只接受${accepted.map((c) => this.CAT[c] || c).join('/')}）`] };
          }
        }
      }
    }
    const pre = feat.prerequisite || [];
    if (!pre.length) return { ok: true, reasons: [] };
    const level = sheet?.level || 1;
    const score = (a: string) => sheet?.['score:' + a] || 0;
    const groupOk = (p: Json) => {
      const bad: string[] = [];
      let recognized = false;
      if (p.level != null) {
        recognized = true;
        const need = typeof p.level === 'number' ? p.level : (p.level.level || 0);
        if (level < need) bad.push(`需要 ${need} 级（当前 ${level}）`);
      }
      if (p.ability) {
        recognized = true;
        for (const a of p.ability) {
          for (const [ab, v] of Object.entries(a)) {
            if (score(ab) < (v as number)) bad.push(`需要${ABIL_CN[ab as keyof typeof ABIL_CN] || ab} ${v}（当前 ${score(ab)}）`);
          }
        }
      }
      if (p.feature) {
        recognized = true;
        for (const f of p.feature) {
          const has = (sheet?.features || []).some((x: Json) => String(x.name).includes(String(f)));
          if (!has) bad.push(`需要「${f}」特性`);
        }
      }
      if (p.proficiency) {
        recognized = true;
        const ARM: Record<string, string> = { light: '轻甲', medium: '中甲', heavy: '重甲', shield: '盾牌' };
        for (const pr of p.proficiency) {
          for (const [k, v] of Object.entries(pr)) {
            if (k === 'type' || !v) continue;
            const want = ARM[k];
            if (!want) continue;
            if (!(sheet?.armorProfs || []).includes(want)) bad.push(`需要${want}熟练`);
          }
        }
      }
      if (p.spellcasting2020 === true) {
        recognized = true;
        if (!sheet?.spell?.casters?.length) bad.push('需要施法能力');
      }
      if (p.feat) {
        recognized = true;
        for (const f of p.feat) {
          const nm = String(f).split('|')[0];
          const has = (sheet?.origins?.feats || []).some((x: Json) => x.name === nm);
          if (!has) bad.push(`需要专长「${nm}」`);
        }
      }
      if (p.otherSummary) {
        recognized = true;
        p._otherSummaryNote = String(p.otherSummary.entrySummary || '');
      }
      if (p.campaign) { recognized = true; bad.push('需要特定战役'); }
      if (!recognized) return { ok: false, bad: ['未识别的前置结构，需人工核查：' + JSON.stringify(p)] };
      return { ok: !bad.length, bad };
    };
    const results = pre.map(groupOk);
    if (results.some((r: { ok: boolean }) => r.ok)) return { ok: true, reasons: [] };
    return { ok: false, reasons: results.flatMap((r: { bad: string[] }) => r.bad) };
  }

  candidates(category: string, sheet: Json, char: Json, slot?: Partial<FeatSlot>) {
    const raw = slot?.categories?.length ? slot.categories : this.GROUP[category] || [category];
    const accept = [...new Set(raw.flatMap((c) => this.GROUP[c] || [c]))];
    const effSlot = slot || { category, categories: raw };
    return this.pool()
      .filter((f) => Source.isCore2024(f))
      .filter((f) => this.catOf(f).some((c) => accept.includes(c)))
      .map((f) => ({ feat: f, taken: (char?.feats || []).includes(f.name), ...this.canTake(f, sheet, effSlot) }));
  }
}
