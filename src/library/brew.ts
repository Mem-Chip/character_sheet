/**
 * 自制书：资料库条目里带的一份 **5etools 格式**数据（现在只有子职：一条 subclass + 每级一条 subclassFeature）。
 *
 * 为什么不用「覆盖官方」：改版子职的特性名字、等级和官方对不上（XGE 的牧人结社特性挂在 2 级，改版写 3 级），
 * 卡面显示的还是官方原文，硬凑键总有对不上的。自制书直接合进职业数据，卡上像官方子职一样选它，
 * 特性按它自己的等级出现、显示它自己的文字；每条特性的键（`<来源>:<职业>:<特性>:<等级>`）从这份数据来，
 * AI 写卡面 / 战斗数据也按这些键写，两边天然对上。
 *
 * 来源代号由条目 id 定（`HB-<id>`），各种 source / className / shortName 字段都由 normalizeBrew 补齐，
 * AI 和手写的人只需要写名字、职业、等级、原文。纯逻辑，浏览器和服务器共用。
 */
import type { Json } from '../sheet';

export interface Brew {
  subclass: Json[];
  subclassFeature: Json[];
}

/** 能挂子职的职业（中文名，和 5etools 数据的 className 一致） */
export const BREW_CLASSES = ['野蛮人', '吟游诗人', '牧师', '德鲁伊', '战士', '武僧', '圣武士', '游侠', '游荡者', '术士', '魔契师', '法师', '奇械师'];

/** 这条内容的自制书来源代号 */
export const brewSource = (itemId: string): string => `HB-${String(itemId).replace(/^hr-/, '').toUpperCase()}`.slice(0, 24);

const isObj = (x: unknown): x is Record<string, any> => !!x && typeof x === 'object' && !Array.isArray(x);
const str = (x: unknown) => (typeof x === 'string' ? x.trim() : '');

/** 检查一份自制书的结构；返回问题（空 = 没问题） */
export function checkBrew(raw: unknown): string[] {
  const p: string[] = [];
  if (!isObj(raw)) return ['自制书要是一个对象：{ "subclass": [ … ], "subclassFeature": [ … ] }'];
  const subs = Array.isArray(raw.subclass) ? raw.subclass : [];
  if (subs.length !== 1) p.push('subclass 里要正好一条（一份自制书写一个子职）');
  const sc = subs[0];
  if (isObj(sc)) {
    if (!str(sc.name)) p.push('子职缺 name');
    if (!BREW_CLASSES.includes(str(sc.className))) p.push(`子职的 className 要是职业的中文名（${BREW_CLASSES.join('、')}）`);
    if (sc.additionalSpells !== undefined && !Array.isArray(sc.additionalSpells)) p.push('additionalSpells 要是数组（写法同 5etools：[{ "prepared": { "3": ["命令术"], "5": ["…"] } }]）');
  } else if (subs.length) p.push('subclass[0] 要是对象');
  const feats = Array.isArray(raw.subclassFeature) ? raw.subclassFeature : null;
  if (!feats?.length) p.push('subclassFeature 至少要有一条（每级的特性各一条）');
  const seen = new Set<string>();
  (feats ?? []).forEach((f: unknown, i: number) => {
    const at = `subclassFeature[${i}]`;
    if (!isObj(f)) { p.push(`${at} 要是对象`); return; }
    if (!str(f.name)) p.push(`${at} 缺 name`);
    if (/[:#]/.test(str(f.name))) p.push(`${at} 的名字里不能有「:」「#」（它们是条目键的分隔符）`);
    if (!Number.isInteger(f.level) || f.level < 1 || f.level > 20) p.push(`${at}（${str(f.name)}）的 level 要是 1～20 的整数`);
    if (!Array.isArray(f.entries) || !f.entries.length) p.push(`${at}（${str(f.name)}）缺 entries（原文，5etools 的 entries 数组）`);
    const k = `${str(f.name)}|${f.level}`;
    if (seen.has(k)) p.push(`${at}：同一级有两条同名特性「${str(f.name)}」`);
    seen.add(k);
  });
  if (JSON.stringify(raw).length > 300_000) p.push('自制书太大了');
  return p;
}

/**
 * 补齐 5etools 的关联字段（来源、职业来源、shortName、subclassFeatures 引用），去掉没用的字段。
 * 先 checkBrew 过了再调。
 */
export function normalizeBrew(raw: Json, source: string): Brew {
  const sc = raw.subclass[0];
  const className = str(sc.className);
  const name = str(sc.name);
  const shortName = str(sc.shortName) || name;
  const feats = (raw.subclassFeature as Json[]).map((f) => ({
    name: str(f.name), level: f.level, entries: f.entries,
    source, className, classSource: 'XPHB', subclassShortName: shortName, subclassSource: source,
  })).sort((a, b) => a.level - b.level);
  return {
    subclass: [{
      name, shortName, source, className, classSource: 'XPHB',
      // edition one = 2024 版：建卡页的子职列表只列 2024 的
      edition: 'one',
      ...(Array.isArray(sc.additionalSpells) ? { additionalSpells: sc.additionalSpells } : {}),
      subclassFeatures: feats.map((f) => `${f.name}|${className}|XPHB|${shortName}|${source}|${f.level}`),
    }],
    subclassFeature: feats,
  };
}

/** 自制书里每条特性在卡上的条目键（和 sourceKeyOf 一致） */
export function brewFeatureKeys(b: Brew): Array<{ key: string; name: string; level: number }> {
  return b.subclassFeature.map((f) => ({ key: `${f.source}:${f.className}:${f.name}:${f.level}`, name: f.name, level: f.level }));
}
