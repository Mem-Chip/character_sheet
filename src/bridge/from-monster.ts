/**
 * 怪物图鉴（5etools 格式的数据块）→ 战斗参与者。不用 AI，只认规则化的写法：
 *   - 数值：AC、生命值、属性、豁免、技能、抗性 / 免疫 / 易伤、状态免疫、速度、挑战等级 → 熟练加值；
 *   - 攻击：「{@atkr m} {@hit 5}，触及 5 尺。{@h}7（{@damage 1d8 + 3}）穿刺伤害外加 3（{@damage 1d6}）火焰伤害」；
 *   - 多重攻击：「进行两次攻击」「一次啃咬和两次爪击」→ 每个动作几次攻击；
 *   - 豁免类动作（吐息）：「{@actSave dex} {@dc 21}，60 尺锥状……{@actSaveFail} …伤害 {@actSaveSuccess} 半伤」，带充能；
 *   - 传奇抗性（豁免失败时改成功，每日 N 次）、传奇动作的次数池（动作本身手动）。
 * 认不出来的（特性、施法、附带效果）原文列在 notes 里，界面上标「需手动」。
 */
import type { Ability } from '../expr';
import type { Action, AttackRow, Entry, Node, Trigger, ViewInit } from '../combat';

type Json = any;

const SIZE: Record<string, string> = { T: '微型', S: '小型', M: '中型', L: '大型', H: '巨型', G: '超巨型' };
const TYPE: Record<string, string> = {
  aberration: '异怪', beast: '野兽', celestial: '天界生物', construct: '构装生物', dragon: '龙类', elemental: '元素生物', fey: '精类',
  fiend: '邪魔', giant: '巨人', humanoid: '类人生物', monstrosity: '怪兽', ooze: '泥怪', plant: '植物', undead: '不死生物',
};
const SKILL: Record<string, string> = {
  acrobatics: '体操', 'animal handling': '驯兽', arcana: '奥秘', athletics: '运动', deception: '欺瞒', history: '历史', insight: '洞悉',
  intimidation: '威吓', investigation: '调查', medicine: '医药', nature: '自然', perception: '察觉', performance: '表演',
  persuasion: '游说', religion: '宗教', 'sleight of hand': '巧手', stealth: '隐匿', survival: '求生',
};
const ABILS: Ability[] = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
const DMG = ['钝击', '穿刺', '挥砍', '火焰', '寒冷', '闪电', '雷鸣', '强酸', '毒素', '暗蚀', '黯蚀', '光耀', '心灵', '力场'];
const DMG_RE = DMG.join('|');
const CN_NUM: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

/** 去掉 {@tag 文本|来源} 标记，留下文本 */
export function plain(s: string): string {
  return String(s).replace(/\{@(\w+)\s*([^}]*)\}/g, (_, tag: string, body: string) => {
    if (tag === 'h') return '命中：';
    if (tag === 'hit') return `+${body}`.replace('+-', '-');
    if (tag === 'atkr') return body.includes('r') && body.includes('m') ? '近战或远程攻击检定：' : body.includes('r') ? '远程攻击检定：' : '近战攻击检定：';
    if (tag === 'actSave') return `${({ str: '力量', dex: '敏捷', con: '体质', int: '智力', wis: '感知', cha: '魅力' } as Record<string, string>)[body] ?? body}豁免：`;
    if (tag === 'actSaveFail') return '失败：';
    if (tag === 'actSaveSuccess') return '成功：';
    if (tag === 'recharge') return `（充能 ${body ? `${body}–6` : '6'}）`;
    if (tag === 'dc') return `DC ${body}`;
    return body.split('|')[0];
  }).replace(/\s+/g, ' ').trim();
}

const flat = (entries: unknown): string => (Array.isArray(entries) ? entries : [entries]).map((e) => {
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object') {
    const o = e as Json;
    if (o.items) return flat(o.items);
    if (o.entries) return flat(o.entries);
    if (o.entry) return flat(o.entry);
  }
  return '';
}).join(' ');

export function crNum(cr: unknown): number {
  const s = typeof cr === 'object' && cr ? String((cr as Json).cr) : String(cr ?? '0');
  const [a, b] = s.split('/');
  return b ? Number(a) / Number(b) : Number(a) || 0;
}
export const pbOfCr = (cr: number) => (cr < 5 ? 2 : cr < 9 ? 3 : cr < 13 ? 4 : cr < 17 ? 5 : cr < 21 ? 6 : cr < 25 ? 7 : cr < 29 ? 8 : 9);

const slug = (s: string) => s.replace(/\{@[^}]*\}/g, '').trim().toLowerCase().replace(/[^a-z0-9一-鿿]+/g, '-').replace(/^-|-$/g, '') || 'a';

/** 「三次」「两次」「2 次」→ 数字；「一次啃咬和两次爪击」→ 3 */
function countAttacks(text: string): number {
  // 只看第一句（「其中一次攻击可以替换为……」不算）
  const t = text.split(/[，。；]|替换|代替|取代/)[0];
  // 「进行三次攻击：一次啃咬和两次爪击」：有总数就用总数
  const total = /([一二两三四五六七八九十]|\d+)\s*次攻击/.exec(t);
  if (total) return Math.max(1, Math.min(10, CN_NUM[total[1]] ?? Number(total[1])));
  let n = 0;
  for (const m of t.matchAll(/([一二两三四五六七八九十]|\d+)\s*次/g)) n += CN_NUM[m[1]] ?? Number(m[1]);
  return Math.max(1, Math.min(10, n));
}

/** 伤害：「7（{@damage 1d8 + 3}）穿刺伤害」→ [{dice, type}] */
function damages(text: string): Array<{ dice: string; type: string }> {
  const out: Array<{ dice: string; type: string }> = [];
  // 「暗蚀或光耀伤害（由它选择）」「点伤害，伤害类型由它从下列选项中选择」：先按第一个类型算（界面上另外提示）
  for (const m of text.matchAll(new RegExp(`\\{@damage ([^}]+)\\}\\s*[）)]\\s*点?\\s*(?:(${DMG_RE})(?:或(?:${DMG_RE}))?)?伤害`, 'g'))) {
    const type = m[2] ?? new RegExp(DMG_RE).exec(text.slice((m.index ?? 0) + m[0].length))?.[0];
    if (!type) continue;
    out.push({ dice: m[1].replace(/\s+/g, ' ').trim(), type: type === '黯蚀' ? '暗蚀' : type });
  }
  // 没有骰子的固定伤害：「1 点穿刺伤害」
  if (!out.length) {
    const m = new RegExp(`(\\d+)\\s*点?\\s*(${DMG_RE})伤害`).exec(text);
    if (m) out.push({ dice: m[1], type: m[2] });
  }
  return out;
}

export interface ParsedMonster {
  key: string;
  view: ViewInit;
  /** 棋子图地址（5etools 站点按「来源 / 英文名」放）。界面加载成功之后才设到棋子身上 */
  tokenUrl?: string;
  /** 候选棋子图（先试自己的来源，再退到 MM） */
  tokenUrls?: string[];
  /** 引擎能自动处理的（给界面显示） */
  auto: string[];
  /** 需要人处理的能力原文 */
  notes: Array<{ group: string; name: string; text: string }>;
}

/** 5etools 站点的棋子图地址（约定：`/img/bestiary/tokens/<来源>/<英文名>.webp`，名字里的空格是 %20） */
export function tokenUrlOf(m: Json, source?: string): string | undefined {
  const src = String(source ?? m?.source ?? '').trim().toUpperCase();
  const eng = String(m?.ENG_name ?? m?.name ?? '').trim();
  if (!src || !eng) return undefined;
  return `https://5e.kiwee.top/img/bestiary/tokens/${src}/${encodeURIComponent(eng)}.webp`;
}

/**
 * 候选棋子图（界面按顺序试）：先按怪物自己的来源，再退到 2014 的 MM ——
 * 2024 很多怪沿用旧图，站点的 XMM 目录里不一定有。
 */
export function tokenUrlsOf(m: Json): string[] {
  const own = tokenUrlOf(m);
  const src = String(m?.source ?? '').trim().toUpperCase();
  const legacy = src && src !== 'MM' ? tokenUrlOf(m, 'MM') : undefined;
  return [...new Set([own, legacy].filter((x): x is string => !!x))];
}

export function parseMonster(m: Json): ParsedMonster {
  const key = `${m.source ?? 'XMM'}:怪物:${m.name}`;
  const tokenUrls = tokenUrlsOf(m);
  const tokenUrl = tokenUrls[0];
  const score = Object.fromEntries(ABILS.map((a) => [a, Number(m[a]) || 10])) as Record<Ability, number>;
  const mod = (a: Ability) => Math.floor((score[a] - 10) / 2);
  const cr = crNum(m.cr);
  const pb = pbOfCr(cr);
  const save: Partial<Record<Ability, number>> = {};
  for (const [a, v] of Object.entries(m.save ?? {})) save[a as Ability] = Number(String(v).replace(/\s/g, '')) || 0;
  const skill: Record<string, number> = {};
  for (const [k, v] of Object.entries(m.skill ?? {})) if (SKILL[k]) skill[SKILL[k]] = Number(String(v).replace(/\s/g, '')) || 0;
  const strs = (x: unknown): string[] => (Array.isArray(x) ? x : []).flatMap((v) => (typeof v === 'string' ? [v] : []));
  const typeRaw = typeof m.type === 'string' ? m.type : typeof m.type?.type === 'string' ? m.type.type : '';
  const ac = Array.isArray(m.ac) ? (typeof m.ac[0] === 'number' ? m.ac[0] : m.ac[0]?.ac) : m.ac;
  const speed = typeof m.speed?.walk === 'number' ? m.speed.walk : m.speed?.walk?.number ?? 30;

  const notes: ParsedMonster['notes'] = [];
  const auto: string[] = [];
  const attacks: AttackRow[] = [];
  const actions: Action[] = [];
  const triggers: Trigger[] = [];
  const resources: Record<string, number> = {};
  let perAction = 1;

  const handle = (group: string, list: Json[] | undefined) => {
    for (const a of list ?? []) {
      const raw = flat(a.entries);
      const name = plain(a.name ?? '');
      const bare = name.replace(/（充能[^）]*）/, '').trim();
      // 多重攻击
      if (group === '动作' && /多重攻击|Multiattack/i.test(`${a.name} ${a.ENG_name ?? ''}`)) {
        perAction = countAttacks(plain(raw));
        auto.push(`多重攻击：每个动作 ${perAction} 次攻击`);
        if (/替换|代替|取代|施展|使用/.test(raw)) notes.push({ group, name, text: plain(raw) });
        continue;
      }
      // 攻击
      const atk = /\{@atkr ([mr,]+)\}[^{]*\{@hit (-?\d+)\}/.exec(raw);
      if (atk && group === '动作') {
        const hitPart = raw.split(/{@h}|命中[：:]/).slice(1).join('') ?? '';
        const main = hitPart.split(/，若|，如果|。/)[0];
        const ds = damages(main);
        if (ds.length) {
          const melee = atk[1].includes('m'), ranged = atk[1].includes('r');
          const reach = Number(/触及\s*(\d+)\s*(?:英)?尺/.exec(raw)?.[1] ?? 5);
          const rng = /射程\s*(\d+)(?:\s*\/\s*(\d+))?\s*(?:英)?尺/.exec(raw);
          attacks.push({
            id: slug(a.ENG_name || bare) + (attacks.some((x) => x.id === slug(a.ENG_name || bare)) ? `-${attacks.length}` : ''),
            name: bare, bonus: Number(atk[2]), damage: ds[0].dice, damageType: ds[0].type,
            melee, ranged, finesse: false, ability: ranged && !melee ? 'dex' : 'str', reach: melee && reach >= 10,
            ...(rng ? { range: Number(rng[1]), ...(rng[2] ? { long: Number(rng[2]) } : {}) } : {}),
            ...(ds.length > 1 ? { extra: ds.slice(1) } : {}),
          });
          auto.push(`攻击：${bare}`);
          // 命中后还有别的效果（擒抱、状态、条件伤害）：自动掷伤害，其余手动
          const rest = hitPart.slice(main.length).replace(/^[。\s]+/, '');
          if (rest.trim() || /\{@condition/.test(hitPart)) notes.push({ group, name: `${bare}（命中后的附带效果）`, text: plain(hitPart) });
          continue;
        }
      }
      // 豁免类动作（吐息武器之类）
      const sv = /\{@actSave (\w+)\}\s*\{@dc (\d+)\}/.exec(raw);
      if (sv && /\{@actSaveFail\}/.test(raw) && (group === '动作' || group === '附赠动作')) {
        const fail = raw.split('{@actSaveFail}')[1]?.split('{@actSaveSuccess}')[0] ?? '';
        const ds = damages(fail);
        const succ = raw.split('{@actSaveSuccess}')[1] ?? '';
        const half = /半伤|一半/.test(succ);
        const rc = /\{@recharge\s*(\d?)\}/.exec(`${a.name}`);
        const area = /(\d+)\s*(?:英)?尺(?:长的|宽的)?\s*\{@variantrule (锥状|球状|线状|立方|放射|圆柱)/.exec(raw)
          ?? /(\d+)\s*(?:英)?尺(?:长的|宽的)?\s*(锥状|球状|线状|立方|放射|圆柱)/.exec(raw);
        if (ds.length) {
          const len = area ? Number(area[1]) : 0;
          const shape = area?.[2];
          const aid = slug(a.ENG_name || bare);
          const hit: Node[] = ds.map((d, i) => ({ kind: 'damage', id: `${aid}${i}`, dice: d.dice, type: d.type }));
          const onSuccess: Node[] = half ? ds.map((_, i) => ({ kind: 'damage', ref: `${aid}${i}`, scale: 0.5 })) : [];
          const extraFx = /\{@condition/.test(fail) || /\{@condition/.test(succ);
          actions.push({
            id: aid, name: bare, activation: group === '附赠动作' ? 'bonus' : 'action',
            ...(rc ? { cost: [{ recharge: rc[1] === '6' || !rc[1] ? '6' : '5-6', id: bare }] } : {}),
            targeting: shape
              ? {
                type: 'area', range: 'self',
                area: shape === '锥状' ? { shape: 'cone', length: len } : shape === '线状' ? { shape: 'line', length: len, width: 5 }
                  : shape === '立方' ? { shape: 'cube', size: len } : shape === '放射' ? { shape: 'emanation', radius: len } : { shape: 'sphere', radius: len },
              }
              : { type: 'creature', count: 20 },
            root: [{
              kind: 'save', ability: sv[1] as Ability, dc: sv[2],
              onFail: [...hit, ...(extraFx ? [{ kind: 'note' as const, text: `${bare}：${plain(fail)}（附带效果请手动处理）` }] : [])],
              onSuccess,
            }],
          });
          auto.push(`豁免动作：${bare}${rc ? '（充能）' : ''}`);
          if (extraFx) notes.push({ group, name: `${bare}（附带效果）`, text: plain(raw) });
          continue;
        }
      }
      notes.push({ group, name, text: plain(raw) });
    }
  };
  handle('特性', m.trait);
  handle('动作', m.action);
  handle('附赠动作', m.bonus);
  handle('反应', m.reaction);

  // 传奇抗性：特性里「传奇抗性（3/日」
  const lrIdx = notes.findIndex((n) => n.group === '特性' && /传奇抗性/.test(n.name));
  if (lrIdx >= 0) {
    const n = Number(/(\d+)\s*\/\s*日/.exec(notes[lrIdx].name)?.[1] ?? 3);
    resources['传奇抗性'] = n;
    triggers.push({
      id: 'legendary-resistance', label: '传奇抗性', on: 'd20Rolled', role: 'actor', window: 'before', optional: true,
      when: "roll.kind == 'save' && roll.failing", cost: [{ resource: '传奇抗性' }], modify: [{ op: 'succeed' }],
    });
    notes.splice(lrIdx, 1);
    auto.push(`传奇抗性 ${n} 次`);
  }
  // 传奇动作：次数池（每回合开始回满），动作本身手动
  if (m.legendary?.length) {
    const n = Number(m.legendaryActions ?? 3);
    resources['传奇动作'] = n;
    triggers.push({ id: 'legendary-refresh', label: '传奇动作：回满', on: 'turnStarted', role: 'actor', do: [{ kind: 'resource', id: '传奇动作', delta: String(n) }] });
    for (const l of m.legendary) {
      const nm = plain(l.name ?? '');
      actions.push({
        id: `legend-${slug(l.ENG_name || nm)}`, name: `传奇动作：${nm}`, activation: 'free', cost: [{ resource: '传奇动作' }],
        root: [{ kind: 'note', text: `${nm}：${plain(flat(l.entries))}` }],
      });
    }
    auto.push(`传奇动作 ${n} 次（次数自动扣，效果手动）`);
  }
  if (m.spellcasting) for (const sc of m.spellcasting) notes.push({ group: '施法', name: plain(sc.name ?? '施法'), text: plain(flat([sc.headerEntries, ...(sc.will ? ['随意：' + sc.will.join('、')] : []), ...Object.entries(sc.daily ?? {}).map(([k, v]) => `${k.replace('e', '')}/日：${(v as string[]).join('、')}`)])) });

  const entry: Entry = { name: m.name, ...(actions.length ? { actions } : {}), ...(triggers.length ? { triggers } : {}) };
  const hasEntry = actions.length > 0 || triggers.length > 0;
  const initProf = Number(m.initiative?.proficiency ?? 0);
  const view: ViewInit = {
    name: m.name, size: SIZE[(m.size ?? ['M'])[0]] ?? '中型', type: TYPE[typeRaw] ?? '怪兽',
    ac: Number(ac) || 10, hpMax: Math.max(1, Number(m.hp?.average) || 1), speed: Number(speed) || 0, pb, level: Math.max(1, Math.floor(cr)),
    score, save, skill, initiative: mod('dex') + initProf * pb,
    resist: strs(m.resist), immune: strs(m.immune), vuln: strs(m.vulnerable), conditionImmune: strs(m.conditionImmune),
    attacks, attacksPerAction: perAction,
    resources, resourceNames: Object.fromEntries(Object.keys(resources).map((k) => [k, k])),
    ...(hasEntry ? { sources: [key], entries: { [key]: entry } } : {}),
    ...(notes.length ? { notes } : {}),
  };
  return { key, view, auto, notes, ...(tokenUrl ? { tokenUrl, tokenUrls } : {}) };
}
