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
  const out: string[] = (c.feats || []).filter((x: unknown): x is string => typeof x === 'string' && !!x);
  for (const [k, v] of Object.entries(c.decisions || {})) {
    if (!/originFeat/i.test(k)) continue;
    for (const x of Array.isArray(v) ? v : [v]) {
      if (typeof x === 'string' && x && !out.includes(x)) out.push(x);
    }
  }
  return out;
}

/** 降级或移除职业时，清理超出新等级槽位的专长、高阶决策、多余武器精通与生命骰记录 */
export function pruneCharByLevel(env: SheetEnv, char: CharData): void {
  const classes: Json[] = (char.classes || []).filter((c: Json) => c && c.name);
  if (char.hpRolls && typeof char.hpRolls === 'object') {
    for (const [clsName, arr] of Object.entries(char.hpRolls)) {
      const spec = classes.find((c) => c.name === clsName);
      if (!spec) delete char.hpRolls[clsName];
      else if (Array.isArray(arr) && arr.length > (+spec.level || 1)) {
        char.hpRolls[clsName] = arr.slice(0, +spec.level || 1);
      }
    }
  }
  if (char.decisions && typeof char.decisions === 'object') {
    for (const key of Object.keys(char.decisions)) {
      const owner = key.split('#')[0];
      const parts = owner.split(':');
      if (parts.length >= 4) {
        const [, clsLabel, , lvStr] = parts;
        const baseCls = clsLabel.split('·')[0];
        const subCls = clsLabel.includes('·') ? clsLabel.split('·')[1] : null;
        const spec = classes.find((x) => x.name === baseCls);
        const lv = Number(lvStr);
        if (!spec || (subCls && ((+spec.level || 1) < 3 || (spec.subclass && spec.subclass !== subCls))) || (Number.isFinite(lv) && lv > (+spec.level || 1))) {
          delete char.decisions[key];
        }
      }
    }
  }
  if (char._resolved?.classes) {
    const nextResClasses = classes.map((spec: Json) => {
      const old = (char._resolved.classes || []).find((x: Json) => x.cls?.name === spec.name);
      if (!old) return null;
      const lv = +spec.level || 1;
      return {
        ...old,
        level: lv,
        features: (old.features || []).filter((f: Json) => f.level <= lv),
        subFeatures: lv >= 3 ? (old.subFeatures || []).filter((f: Json) => f.level <= lv) : [],
      };
    }).filter(Boolean);
    const slots = env.feats.slots(char, { ...char._resolved, classes: nextResClasses });
    const rawFeats: string[] = (char.feats || []).filter((x: unknown): x is string => typeof x === 'string' && !!x);
    const { bySlot, unmatched } = env.feats.assign(rawFeats, slots);
    const keepIdx = new Set<number>(bySlot.filter((b) => b.index >= 0).map((b) => b.index));
    let originKept = false;
    for (const u of unmatched) {
      if (!u.f || (!originKept && u.cats.includes('O'))) {
        if (u.f) originKept = true;
        keepIdx.add(u.i);
      }
    }
    const nextFeats = rawFeats.filter((_, i) => keepIdx.has(i));
    const removedFeats = rawFeats.filter((_, i) => !keepIdx.has(i));
    char.feats = nextFeats;
    if (removedFeats.length && char.decisions) {
      for (const rf of removedFeats) {
        const remainCount = nextFeats.filter((n) => n === rf).length;
        for (const k of Object.keys(char.decisions)) {
          if (remainCount === 0 && (k.startsWith(`XPHB:${rf}#`) || k.startsWith(`expanded:${rf}#`) || k.startsWith(`XPHB:${rf}:`))) {
            delete char.decisions[k];
          } else if (remainCount > 0) {
            const m = new RegExp(`^XPHB:${rf}:(\\d+)#`).exec(k);
            if (m && Number(m[1]) > remainCount) delete char.decisions[k];
          }
        }
      }
    }
    const optData: Json[] = env.store.data.optionalfeatures?.optionalfeature || [];
    const totLv = totalLevel(char);
    for (const k of nextResClasses) {
      for (const c of [...env.options.forClass(k), ...env.options.forSubclass(k)]) {
        if (c.kind !== 'optfeature' || !char.decisions) continue;
        const oKey = env.options.optionKey({ _resolved: { classes: nextResClasses } }, c);
        const v = char.decisions[oKey];
        if (!Array.isArray(v)) continue;
        let nextV = v.filter((nm: string) => {
          const opt = optData.find((o) => o.name === nm && o.source === 'XPHB') ?? optData.find((o) => o.name === nm);
          return !opt || env.optional.meetsLevelPrereq(opt, k.cls.name, k.level, totLv);
        });
        if (c.count && nextV.length > c.count) nextV = nextV.slice(0, c.count);
        if (nextV.length) char.decisions[oKey] = nextV;
        else delete char.decisions[oKey];
      }
    }
  }
  const maxMasteries = env.mastery.allowance(char).total;
  if (Array.isArray(char.masteries) && char.masteries.length > maxMasteries) {
    char.masteries = char.masteries.slice(0, maxMasteries);
  }
}

/** 名称 → 实体。子职不足 3 级会被摘掉（记进 subclassArchive，升回 3 级自动恢复） */
export async function resolveCharacter(env: SheetEnv, char: CharData): Promise<Json> {
  const d = env.store.data;
  const res: Json = { classes: [], feats: [], race: null, background: null, warnings: [], subclassSpells: [] };
  if (!d.races) return res;
  res._authored = { languages: {}, tools: {}, skills: {} };
  res.racesLoaded = true;

  if (char.race) res.race = (d.races.race || []).find((r: Json) => r.name === char.race && Source.is2024(r)) || null;
  // 自建种族：5etools 里没有这个名字时，到本卡 / 战役 / 资料库的家规里按名字找一条
  // （SheetBuild 的「自定义种族」会往本卡的 homerules 里写这么一条，名字就是种族名）
  if (char.race && !res.race) {
    const pool = [
      ...((char.homerules || []) as Json[]),
      ...(env.homelib?.camp?.(char) || []),
      ...(env.homelib?.user?.(char) || []),
    ];
    const hr = pool.find((h) => String(h?.name ?? '') === char.race);
    if (hr) {
      res.race = {
        name: char.race,
        source: 'HR',
        _hr: hr.id,
        entries: (hr.entries as Json[]) ?? (hr.text ? [String(hr.text)] : []),
      };
    } else {
      // 连家规里都没有：至少把名字显示出来（以前这里 race 是 undefined，卡面一片空白）
      res.race = { name: char.race, source: 'HR', entries: [], _bare: true };
      res.warnings.push(`「${char.race}」不是内置种族，也没有对应的家规条目（特性要自己在家规里写）`);
    }
  }
  if (char.background) res.background = (d.backgrounds.background || []).find((b: Json) => b.name === char.background && Source.is2024(b)) || null;
  for (const f of featNames(char)) {
    const e = (d.feats.feat || []).find((x: Json) => x.name === f && Source.is2024(x));
    if (!e) res.warnings.push('找不到专长：' + f);
  }

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
      // 子职给的法术（誓约法术 / 宗主法术 / 领域法术…）：2024 数据写在 additionalSpells 的 prepared 里，
      // 键是「从几级起」。这些法术**始终准备**，不占准备上限、也不进法术书。
      if (subclass) {
        for (const grp of (subclass.additionalSpells || []) as Json[]) {
          const label = String(grp?.name || '子职法术');
          for (const [from, list] of Object.entries({ ...(grp?.prepared || {}), ...(grp?.known || {}) })) {
            const at = Number(from);
            if (!Number.isFinite(at) || at > lvl) continue;
            let chooseIdx = 0;
            for (const raw of (Array.isArray(list) ? list : [list])) {
              const obj = raw && typeof raw === 'object' ? (raw as Json) : null;
              // 固定法术名（字符串，或 `{ name }`）
              const fixed = obj ? (typeof obj.name === 'string' ? obj.name : null) : String(raw);
              if (fixed) {
                const nm = fixed.split('|')[0].split('#')[0];
                if (nm && nm !== '[object Object]') res.subclassSpells.push({ name: nm, from: `${spec.subclass}：${label}`, level: at });
                continue;
              }
              // `{ choose: 'level=0;1;2|class=法师|school=C' }`：让玩家自己选，选了算「始终准备」
              if (obj?.choose) {
                const i = chooseIdx++;
                const key = `${subclass.source}:${cls.name}:${subclass.name}:${at}#spell-${i}`;
                const chooseStr = String(obj.choose);
                const schoolKey = /school=([A-Z])/.exec(chooseStr)?.[1] ?? '';
                const lvKeys = (/level=([0-9;]+)/.exec(chooseStr)?.[1] ?? '').split(';').filter(Boolean);
                const lvTxt = lvKeys.length ? (lvKeys.length > 1 ? `环阶 ${lvKeys[0]}–${lvKeys[lvKeys.length - 1]} 的` : `环阶 ${lvKeys[0]} 的`) : '';
                const schoolCn = schoolKey ? `${({ A: '防护', C: '咒法', D: '预言', E: '附魔', V: '塑能', I: '幻术', N: '死灵', T: '变化' } as Record<string, string>)[schoolKey] ?? ''}系` : '';
                (res.subclassSpellChoices ??= []).push({
                  key, id: `spell-${at}-${i}`, choose: chooseStr, count: 1,
                  from: `${spec.subclass}：${label}`,
                  label: `${spec.subclass}：选一道${lvTxt}${schoolCn}法师法术（始终准备）`,
                  cls: cls.name,
                });
                const dec = (char.decisions || {})[key];
                for (const pick of (Array.isArray(dec) ? dec : dec ? [dec] : [])) {
                  const nm = String(pick);
                  const lvl2 = Number((env.store.spellsAll.find((sp: Json) => sp.name === nm) as Json | undefined)?.level ?? at);
                  res.subclassSpells.push({ name: nm, from: `${spec.subclass}：${label}`, level: lvl2 });
                }
              }
            }
          }
          if (grp?.expanded && !grp?.prepared) {
            res.warnings.push(`子职「${spec.subclass}」的法术列表是 2014 的 expanded 写法，暂不自动加进「始终准备」`);
          }
        }
      }
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

  // 解析已生效的专长：只认匹配到当前等级专长槽的专长 + 至多 1 项背景起源专长 + 当前种族决策授予的起源专长
  {
    const slots = env.feats.slots(char, res);
    const rawFeats: string[] = (char.feats || []).filter((x: unknown): x is string => typeof x === 'string' && !!x);
    const { bySlot, unmatched } = env.feats.assign(rawFeats, slots);
    const activeIndices = new Set<number>(bySlot.filter((b) => b.index >= 0).map((b) => b.index));
    let originKept = false;
    for (const u of unmatched) {
      if (!u.f) {
        activeIndices.add(u.i);
      } else if (!originKept && u.cats.includes('O')) {
        originKept = true;
        activeIndices.add(u.i);
      }
    }
    const activeFeatList: string[] = rawFeats.filter((_, i) => activeIndices.has(i));
    for (const [k, v] of Object.entries(char.decisions || {})) {
      if (!/originFeat/i.test(k)) continue;
      const racePart = k.split('#')[0]?.split(':')[1];
      if (racePart && char.race && racePart !== char.race) continue;
      for (const x of Array.isArray(v) ? v : [v]) {
        if (typeof x === 'string' && x && !activeFeatList.includes(x)) activeFeatList.push(x);
      }
    }
    for (const f of activeFeatList) {
      const e = (d.feats.feat || []).find((x: Json) => x.name === f && Source.is2024(x));
      if (e) res.feats.push(e);
    }
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



