/**
 * 角色模型、名称解析、计算入口（移植自原项目 core/data.js 的 Character）。
 *
 * 角色只存名字（种族 / 背景 / 职业 / 专长 / 物品），实体每次从数据里取 —— 数据更新了卡就跟着更新。
 * 角色 JSON 的形状与原项目一致：原项目导出的卡可以直接读。
 */
import { buildOrigins, CalcCtx } from './pipeline';
import { Source, classSlug, subclassCandidates } from './source';
import type { SheetEnv } from './env';
import type { Json } from './store';
import { totalLevel } from './abilities';

/** 角色数据（与原项目 Character.blank() 同形；`_` 开头的是计算时挂上去的派生物，不存盘） */
export type CharData = Record<string, any>;

export function blankCharacter(): CharData {
  return {
    name: '', player: '', alignment: '', xp: 0,
    abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
    abilityMode: 'standard',
    race: '', size: 'M', background: '', backgroundBonus: null, backgroundBonusMode: '2/1',
    backgroundBonusDraft: null,
    classes: [{ name: '', level: 1, subclass: '' }],
    startingClass: '',
    feats: [], featChoices: {},
    skillProf: [], skillExp: [], languages: [], tools: [],
    masteries: [],
    wildShape: null,
    equipment: [], spells: [], customItems: [], extraAsi: {}, manual: {},
    packs: {},
    purse: { cp: 0 },
    profile: { portrait: '', height: '', weight: '', age: '', gender: '', eyes: '', hair: '', skin: '', appearance: '', backstory: '' },
    sheetNotes: [],
    spellbook: [],
    decisions: {},
    homerules: [],
    subclassArchive: {},
    resources: {},
    slots: {},
    hp: { current: null, temp: 0 },
    hpRolls: {},
    deathSaves: { success: 0, failure: 0 },
    arcaneRecovery: { used: false },
    hitDiceSpent: {},
    /** 身上持续存在的效应（法师护甲、力竭、长时间增益…）：战斗引擎的 ActiveEffect 实例 */
    effects: [],
    notes: '',
  };
}

export { totalLevel };

/** 这个角色实际拥有哪些专长：char.feats ∪「再选一项起源专长」那类决策里选的值 */
export function featNames(c: CharData): string[] {
  const out = new Set<string>((c.feats || []).filter((x: unknown) => typeof x === 'string' && x));
  for (const [k, v] of Object.entries(c.decisions || {})) {
    if (!/originFeat/i.test(k)) continue;
    for (const x of Array.isArray(v) ? v : [v]) if (typeof x === 'string' && x) out.add(x);
  }
  return [...out];
}

/** 名称 → 实体。子职不足 3 级会被摘掉（记进 subclassArchive，升回 3 级自动恢复） */
export async function resolveCharacter(env: SheetEnv, char: CharData): Promise<Json> {
  const d = env.store.data;
  const res: Json = { classes: [], feats: [], race: null, background: null, warnings: [] };
  if (!d.races) return res;
  res._authored = { languages: {}, tools: {}, skills: {} };
  res.racesLoaded = true;

  if (char.race) res.race = (d.races.race || []).find((r: Json) => r.name === char.race && Source.is2024(r)) || null;
  if (char.background) res.background = (d.backgrounds.background || []).find((b: Json) => b.name === char.background && Source.is2024(b)) || null;

  const baseItems = d.itemsBase?.baseitem || [];
  const items = d.items?.item || [];
  res.equipment = (char.equipment || []).map((eq: Json) => {
    const n = typeof eq === 'string' ? eq : eq.name;
    let ent = baseItems.find((x: Json) => x.name === n && Source.is2024(x))
      || baseItems.find((x: Json) => x.name === n)
      || items.find((x: Json) => x.name === n && Source.is2024(x))
      || items.find((x: Json) => x.name === n)
      || null;
    // 魔法武器 / 护甲：底材（「黑刃」= 巨剑）的数据补进来，攻击、AC 照底材算，再加魔法加值
    if (ent?.baseItem && !ent.weapon && !ent.armor) {
      const bn = String(ent.baseItem).split('|')[0];
      const base = baseItems.find((x: Json) => x.name === bn && Source.is2024(x)) || baseItems.find((x: Json) => x.name === bn);
      if (base) ent = { ...base, ...ent, name: ent.name, weight: ent.weight ?? base.weight };
    }
    // 自定义物品：只有名字、重量、说明
    if (!ent && eq?.custom) ent = { name: n, weight: Number(eq.custom.weight) || 0, entries: eq.custom.desc ? [eq.custom.desc] : [], custom: true };
    if (!ent) {
      const grp = env.items.groupOf(n);
      if (grp) res.warnings.push(`「${n}」是一类物品，还没选具体哪一件（可选：${grp.items.join('、')}）`);
      else res.warnings.push('找不到物品数据：' + n);
    }
    return { ...(typeof eq === 'string' ? { name: n, qty: 1, equipped: true } : eq), name: n, _ent: ent };
  });
  res.props = env.store.props || {};

  for (const f of featNames(char)) {
    const e = (d.feats.feat || []).find((x: Json) => x.name === f && Source.is2024(x));
    if (e) res.feats.push(e); else res.warnings.push('找不到专长：' + f);
  }

  res.languagesGranted = [];
  res.languageChoices = [];
  {
    const { fixed, choices } = env.tools.fromBackground(res.background);
    res.toolsFixed = fixed;
    res.toolChoices = choices;
    for (const t of fixed) res._authored.tools[t] = 'background';
  }

  for (const spec of char.classes || []) {
    if (!spec.name) continue;
    const slug = classSlug(spec.name);
    if (!d.classIndex[slug]) { res.warnings.push('未知职业：' + spec.name); continue; }
    const cdata = await env.store.classData(slug);
    const cls = (cdata.class || []).find((c: Json) => c.name === spec.name && Source.isClass2024(c))
      || (cdata.class || []).find((c: Json) => c.name === spec.name);
    if (!cls) { res.warnings.push('职业数据里找不到：' + spec.name); continue; }
    const lvl = +spec.level || 1;
    const features = (cdata.classFeature || []).filter((f: Json) => f.className === cls.name && f.classSource === cls.source && f.level <= lvl);
    let subFeatures: Json[] = [];
    let subclass: Json = null;
    const needSub = lvl >= 3 || (+spec.level || 0) + 1 >= 3;
    if (spec.subclass && lvl < 3) {
      char.subclassArchive = char.subclassArchive || {};
      if (char.subclassArchive[cls.name] !== spec.subclass) {
        char.subclassArchive[cls.name] = spec.subclass;
        res.warnings.push(`「${cls.name}」等级是 ${lvl}（不足 3 级），子职「${spec.subclass}」已暂时摘掉 —— 升回 3 级会自动恢复`);
        env.log(`子职摘除：${cls.name} L${lvl} · ${spec.subclass}（升回 3 级会恢复）`);
      }
      spec.subclass = '';
    } else if (lvl >= 3 && !spec.subclass && char.subclassArchive?.[cls.name]) {
      spec.subclass = char.subclassArchive[cls.name];
      delete char.subclassArchive[cls.name];
      res.warnings.push(`升回 3 级，子职「${spec.subclass}」已自动恢复`);
      env.log(`子职恢复：${cls.name} L${lvl} · ${spec.subclass}`);
    }
    if (spec.subclass && lvl >= 3) {
      const sameName = (cdata.subclass || []).filter((s: Json) => s.name === spec.subclass && s.className === cls.name);
      let picked: Json = subclassCandidates(sameName, cls.source)[0] || null;
      if (!picked && sameName.length) {
        // 旧存档里的 2014 子职名 → 按站点自己的 reprintedAs 重定向到 2024 版
        const target = String(sameName[0].reprintedAs?.[0] || '');
        const [tName, , , tSrc] = target.split('|');
        if (tName) {
          picked = subclassCandidates((cdata.subclass || []).filter((s: Json) => s.name === tName && s.className === cls.name), cls.source)
            .find((s: Json) => !tSrc || s.source === tSrc) || null;
          if (picked) env.log(`子职「${spec.subclass}」是 2014 版，按数据里的 reprintedAs 改到 2024 版「${picked.name}」`);
        }
      }
      if (!picked && sameName.length) res.warnings.push(`子职「${spec.subclass}」在 2024 数据里找不到（也没有 2014→2024 的重定向信息）`);
      subclass = picked || null;
      const subSrc = subclass?.source;
      subFeatures = (cdata.subclassFeature || []).filter((f: Json) => f.className === cls.name
        && f.subclassShortName === (subclass?.shortName || spec.subclass)
        && f.level <= lvl
        && (subSrc && f.subclassSource ? f.subclassSource === subSrc : Source.is2024(f) === Source.is2024(cls)));
    }
    const optPool = (d.optionalfeatures?.optionalfeature || []).filter((o: Json) => o.source === cls.source || o.source === 'XPHB');
    const subSeen = new Set<string>();
    const allSubclasses: Json[] = [];
    if (needSub) {
      for (const s of cdata.subclass || []) {
        if (s.className !== cls.name || !String(s.name || '').trim()) continue;
        if (!Source.isSubclass2024(s, cls.source)) continue;
        const k2 = s.name + '|' + s.source;
        if (subSeen.has(k2)) continue;
        subSeen.add(k2);
        allSubclasses.push(s);
      }
      for (const sf of d.classIndex?.[slug]?.subclass || []) {
        try {
          const sc = await env.store.classData(sf);
          for (const s of sc.subclass || []) {
            if (s.className !== cls.name) continue;
            if (!Source.isSubclass2024(s, cls.source)) continue;
            const k2 = s.name + '|' + s.source;
            if (subSeen.has(k2)) continue;
            subSeen.add(k2);
            allSubclasses.push(s);
          }
        } catch { /* 单个扩展文件拿不到不该让整张卡失败 */ }
      }
    }
    res.classes.push({ cls, level: lvl, subclassName: spec.subclass, subclass, features, subFeatures, optPool, allSubclasses });
  }

  // 职业/子职特殊语言（德鲁伊语、盗贼黑话…）只能从正文识别
  for (const k of res.classes) {
    for (const f of [...(k.features || []), ...(k.subFeatures || [])]) {
      const txt = (f.entries || []).map((e: Json) => (typeof e === 'string' ? e : JSON.stringify(e))).join(' ');
      for (const spec of env.languages.SPECIAL) {
        if (!spec.pattern.test(txt)) continue;
        if (spec.name) {
          res.languagesGranted.push({ name: spec.name, from: `${k.cls.name}「${f.name}」` });
          res._authored.languages[spec.name] = 'class';
        }
        if (spec.alsoChoose) {
          res.languageChoices.push({
            id: 'lang-' + f.name, count: spec.alsoChoose,
            label: `${k.cls.name}「${f.name}」：另从语言表中选 ${spec.alsoChoose} 项`,
            from: `${k.cls.name}「${f.name}」`,
          });
        }
      }
    }
  }
  return res;
}

/**
 * 完整计算：解析 → 能力框架（派生 + mods）→ 规则管线 → 资源池。
 * 临时效应（狂暴、祝福、状态…）不在这里：它们由战斗引擎叠在算出来的数值上（src/combat/effects.ts 的 effectiveView）。
 * 顺序要紧：能力的 mods 必须在管线之前进 ctx，否则 AC / HP 那些阶段读不到。
 */
export async function computeCharacter(env: SheetEnv, char: CharData): Promise<Record<string, any>> {
  env.abilities.ensureHomerules(char);
  env.abilities.augmentFromFeatData();
  const res = await resolveCharacter(env, char);
  char._resolved = res;
  const derived = env.abilities.derive(char);
  char._derived = derived;
  for (const h of env.charHooks) {
    try { h(char); } catch (e) { env.log('charHook 失败：' + (e as Error).message, 1); }
  }
  const ctx = new CalcCtx(char, env);
  env.abilities.applyMods(ctx);
  env.rules.run(ctx, env.log);
  ctx.out._warnings = res.warnings;
  ctx.out._derived = derived;
  ctx.out._pending = derived.pending;
  ctx.out._resources = env.resources.collect(char, ctx.out);
  ctx.out.origins = buildOrigins(char, res);
  return ctx.out;
}

/** 起源专长默认值：玩家还没选起源专长时，填上背景给的那条（原项目在建卡页渲染时做） */
export function applyOriginFeatDefault(env: SheetEnv, char: CharData): boolean {
  const res = char._resolved;
  if (!res || !res.racesLoaded) return false;
  const bg = res.background;
  if (!bg) return false;
  const pool = env.feats.pool();
  if (!pool.length) return false;
  const origin = pool.filter((f: Json) => Source.isCore2024(f) && env.feats.catOf(f).includes('O')).map((f: Json) => f.name);
  if (!origin.length) return false;
  if ((char.feats || []).some((n: string) => origin.includes(n))) return false;
  let granted: string | null = null;
  for (const o of bg.feats || []) for (const k of Object.keys(o)) granted = String(k).split('；')[0].split('|')[0];
  if (!granted || !origin.includes(granted)) return false;
  char.feats = char.feats || [];
  char.feats.push(granted);
  return true;
}
