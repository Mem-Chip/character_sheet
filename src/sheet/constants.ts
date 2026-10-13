/** 常量表（移植自原项目 core/util.js） */
import type { Ability } from '../expr';

export const ABILS: readonly Ability[] = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
export const ABIL_CN: Record<Ability, string> = { str: '力量', dex: '敏捷', con: '体质', int: '智力', wis: '感知', cha: '魅力' };
export const ABIL_EN: Record<Ability, string> = { str: 'Strength', dex: 'Dexterity', con: 'Constitution', int: 'Intelligence', wis: 'Wisdom', cha: 'Charisma' };
export const ABIL_WORD: Record<string, Ability> = { 力量: 'str', 敏捷: 'dex', 体质: 'con', 智力: 'int', 感知: 'wis', 魅力: 'cha' };

/** [键, 中文, 属性] */
export const SKILLS: ReadonlyArray<readonly [string, string, Ability]> = [
  ['acrobatics', '体操', 'str'], ['animal handling', '驯兽', 'wis'], ['arcana', '奥秘', 'int'],
  ['athletics', '运动', 'str'], ['deception', '欺瞒', 'cha'], ['history', '历史', 'int'],
  ['insight', '洞悉', 'wis'], ['intimidation', '威吓', 'cha'], ['investigation', '调查', 'int'],
  ['medicine', '医药', 'wis'], ['nature', '自然', 'int'], ['perception', '察觉', 'wis'],
  ['performance', '表演', 'cha'], ['persuasion', '游说', 'cha'], ['religion', '宗教', 'int'],
  ['sleight of hand', '巧手', 'dex'], ['stealth', '隐匿', 'dex'], ['survival', '求生', 'wis'],
];

export const SCHOOL_CN: Record<string, string> = { A: '防护', C: '咒法', D: '预言', E: '惑控', V: '塑能', I: '幻术', N: '死灵', T: '变化' };
export const SCHOOL_ORDER = ['A', 'C', 'D', 'E', 'V', 'I', 'N', 'T'];
export const SIZE_CN: Record<string, string> = { T: '微型', S: '小型', M: '中型', L: '大型', H: '巨型', G: '超巨型' };
/** ⚠️ 原项目的旧译（「斩击」）。卡面文字照旧以保持一致；战斗引擎那边会规范化成站点 2024 译名「挥砍」 */
export const DMG_CN: Record<string, string> = {
  B: '钝击', P: '穿刺', S: '斩击', A: '强酸', C: '寒冷', F: '火焰', O: '闪电', N: '暗蚀', R: '光耀', Y: '心灵', T: '毒素', E: '力场', L: '闪电', I: '雷鸣',
};
export const STATUS_CN: Record<string, string> = {
  blinded: '目盲', charmed: '魅惑', deafened: '耳聋', exhaustion: '力竭', frightened: '恐慌',
  grappled: '擒抱', incapacitated: '失能', invisible: '隐形', paralyzed: '麻痹', petrified: '石化',
  poisoned: '中毒', prone: '倒地', restrained: '束缚', stunned: '震慑', unconscious: '昏迷',
  concentration: '专注', surprised: '受惊', bloodied: '浴血',
};
export const ARMOR_TYPES: Record<string, string> = { LA: '轻甲', MA: '中甲', HA: '重甲', S: '盾牌' };
export const CASTER_LABEL: Record<string, string> = { full: '全施法者', half: '半施法者', third: '三分之一施法者', pact: '契约魔法', artificer: '半施法者(向上取整)' };
export const MAGIC_RARITY_CN: Record<string, string> = {
  common: '普通', uncommon: '非普通', rare: '稀有', 'very rare': '非常稀有', legendary: '传说', artifact: '神器', varies: '不定', unknown: '未知',
};

export type CasterFamily = 'full' | 'half' | 'third' | 'pact';
export function CASTER_FAMILY(prog: unknown): CasterFamily | null {
  switch (String(prog)) {
    case 'full': return 'full';
    case '1/2': case 'half': case 'artificer': return 'half';
    case '1/3': case 'third': return 'third';
    case 'pact': return 'pact';
    default: return null;
  }
}
export const CASTER_CONTRIB: Record<CasterFamily, number> = { full: 1, half: 0.5, third: 1 / 3, pact: 0 };

/* ---------------- 小工具（原项目 U.*） ---------------- */
export const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));
export const modOf = (score: number) => Math.floor((score - 10) / 2);
export const sgn = (n: number) => (n >= 0 ? '+' : '') + n;
export function parseDiceText(str: unknown): { n: number; f: number; b: number } | null {
  const m = String(str).match(/(\d+)d(\d+)\s*([+-]\s*\d+)?/i);
  if (!m) return null;
  return { n: +m[1], f: +m[2], b: m[3] ? +m[3].replace(/\s/g, '') : 0 };
}
