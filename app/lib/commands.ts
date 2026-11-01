/**
 * 指令框里的斜杠指令：把一行字解析成要做的事（不发命令，发命令在 Log.tsx 的 CommandBox）。
 * 都是纯函数，方便测试。缩写都不分大小写：
 *   伤害类型 f / fi / fire / 火焰；属性 dex / 敏捷 / 敏；技能 perc / perception / 察觉。
 */
import { ABILS, ABIL_CN, type Ability } from '../../src/expr';
import { SKILL_DEFS } from '../../src/combat/effects';

/** 伤害类型缩写 → 引擎用的名字（必要时 normType 再归一，比如「暗蚀」） */
const DAMAGE: Array<[cn: string, one: string, two: string, en: string]> = [
  ['钝击', 'b', 'bl', 'bludgeoning'],
  ['穿刺', 'p', 'pi', 'piercing'],
  ['挥砍', 's', 'sl', 'slashing'],
  ['力场', 'k', 'fo', 'force'],
  ['光耀', 'r', 'ra', 'radiant'],
  ['暗蚀', 'n', 'ne', 'necrotic'],
  ['心灵', 'y', 'ps', 'psychic'],
  ['强酸', 'a', 'ac', 'acid'],
  ['火焰', 'f', 'fi', 'fire'],
  ['毒素', 'x', 'po', 'poison'],
  ['闪电', 'l', 'li', 'lightning'],
  ['雷鸣', 't', 'th', 'thunder'],
  ['寒冷', 'c', 'co', 'cold'],
];
const DAMAGE_ALIAS: Record<string, string> = (() => {
  const m: Record<string, string> = { 黯蚀: '暗蚀', 死灵: '暗蚀', 斩击: '挥砍' };
  for (const [cn, one, two, en] of DAMAGE) { m[cn] = cn; m[one] = cn; m[two] = cn; m[en] = cn; }
  return m;
})();

/** 伤害类型：认不出返回 null */
export function damageType(word: string): string | null {
  return DAMAGE_ALIAS[word.trim().toLowerCase()] ?? DAMAGE_ALIAS[word.trim()] ?? null;
}

const ABIL_ALIAS: Record<string, Ability> = (() => {
  const m: Record<string, Ability> = {};
  const en: Record<Ability, string> = { str: 'strength', dex: 'dexterity', con: 'constitution', int: 'intelligence', wis: 'wisdom', cha: 'charisma' };
  for (const a of ABILS) { m[a] = a; m[en[a]] = a; m[ABIL_CN[a]] = a; m[ABIL_CN[a][0]] = a; }
  return m;
})();

export function ability(word: string): Ability | null {
  return ABIL_ALIAS[word.trim().toLowerCase()] ?? ABIL_ALIAS[word.trim()] ?? null;
}

/** 技能：中文名、英文全名、英文前缀（至少 3 个字母、只对上一个）；prc / soh 这种常见缩写也认 */
export function skill(word: string): { cn: string; ability: Ability } | { error: string } | null {
  const w = word.trim().toLowerCase().replace(/[\s_]/g, '-');
  const byCn = SKILL_DEFS.find((d) => d[1] === word.trim() || (word.trim() === '求生' && d[0] === 'survival') || (word.trim() === '特技' && d[0] === 'acrobatics'));
  if (byCn) return { cn: byCn[1], ability: byCn[2] };
  const extra: Record<string, string> = { prc: 'perception', soh: 'sleight-of-hand', ah: 'animal-handling', sleight: 'sleight-of-hand', animal: 'animal-handling' };
  const en = extra[w] ?? w;
  const exact = SKILL_DEFS.find((d) => d[0] === en);
  if (exact) return { cn: exact[1], ability: exact[2] };
  if (en.length < 3) return null;
  const hits = SKILL_DEFS.filter((d) => d[0].startsWith(en));
  if (hits.length === 1) return { cn: hits[0][1], ability: hits[0][2] };
  if (hits.length > 1) return { error: `「${word}」可能是 ${hits.map((d) => `${d[1]}（${d[0]}）`).join('、')}，多写几个字母` };
  return null;
}

export type Parsed =
  | { kind: 'save'; ability: Ability; dc: number; damage?: { dice: string; type: string }; half: boolean }
  | { kind: 'check'; ability: Ability; skill?: string; dc?: number }
  | { kind: 'next' }
  | { kind: 'undo'; n: number }
  | { kind: 'help' }
  | { kind: 'mod'; stat: ModStat; n: number; ability?: Ability; skill?: string }
  | { kind: 'error'; message: string };

const DICE = /^\d*d?\d+([+-]\d*d?\d+)*$/i;

/** 解析 /save /check /next /undo /h；别的指令返回 null（交给原来的 /r /match …） */
export function parseCommand(text: string): Parsed | null {
  const m = text.trim().match(/^\/(\S+)(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  const cmd = m[1].toLowerCase();
  const args = (m[2] ?? '').trim().split(/\s+/).filter(Boolean);
  const err = (message: string): Parsed => ({ kind: 'error', message });
  switch (cmd) {
    case 'h': case 'help': case '?': return { kind: 'help' };
    case 'next': case 'n': return { kind: 'next' };
    case 'undo': {
      const n = args[0] ? Number(args[0]) : 1;
      if (!Number.isInteger(n) || n < 1 || n > 20) return err('写 /undo 或 /undo 3（撤销最近几步，最多 20）');
      return { kind: 'undo', n };
    }
    case 'save': {
      const usage = '写法：/save dex 15 · 带伤害 /save dex 15 8d6 f h（h = 过了减半，不写 = 过了不受伤害）';
      const a = args[0] ? ability(args[0]) : null;
      if (!a) return err(args[0] ? `「${args[0]}」不是属性（str dex con int wis cha）。${usage}` : usage);
      const dc = Number(args[1]);
      if (!Number.isInteger(dc) || dc < 1 || dc > 40) return err(`要写 DC，比如 /save ${args[0]} 15`);
      const rest = args.slice(2);
      let half = false;
      if (rest.length && /^(h|half|半|减半)$/i.test(rest[rest.length - 1])) { half = true; rest.pop(); }
      if (!rest.length) return half ? err('写了 h（减半）但没写伤害，比如 /save dex 15 8d6 f h') : { kind: 'save', ability: a, dc, half };
      if (!DICE.test(rest[0])) return err(`「${rest[0]}」不是伤害骰，比如 8d6 或 3d8+2`);
      let type = '钝击';
      if (rest[1]) {
        const t = damageType(rest[1]);
        if (!t) return err(`「${rest[1]}」不是伤害类型。输入 /h 看缩写`);
        type = t;
      }
      if (rest.length > 2) return err(usage);
      return { kind: 'save', ability: a, dc, damage: { dice: rest[0], type }, half };
    }
    case 'check': case 'c': {
      const usage = '写法：/check perc（技能）· /check str 15（属性检定，DC 可不写）';
      if (!args[0]) return err(usage);
      const dc = args[1] != null ? Number(args[1]) : undefined;
      if (dc !== undefined && (!Number.isInteger(dc) || dc < 1 || dc > 40)) return err(`「${args[1]}」不是 DC`);
      // 属性名优先（int = 智力，不是 intimidation）
      const a = ability(args[0]);
      if (a) return { kind: 'check', ability: a, ...(dc !== undefined ? { dc } : {}) };
      const s = skill(args[0]);
      if (!s) return err(`「${args[0]}」不是技能也不是属性。${usage}`);
      if ('error' in s) return err(s.error);
      return { kind: 'check', ability: s.ability, skill: s.cn, ...(dc !== undefined ? { dc } : {}) };
    }
    case 'mod': {
      const usage = '写法：/mod ac -2 · /mod speed 10 · /mod hp 5（生命值上限）· /mod atk 1 · /mod save dex 2 · /mod check perc 1 · /mod dc 2';
      if (!args[0]) return err(usage);
      const stat = MOD_STATS[args[0].toLowerCase()];
      if (!stat) return err(`「${args[0]}」改不了。${usage}`);
      // 豁免 / 检定可以指定属性（检定还可以是技能）：/mod save dex 2 · /mod check str 1 · /mod check perc 1；不写 = 全部
      let ab: Ability | undefined;
      let sk: string | undefined;
      let rest = args.slice(1);
      if ((stat === 'save' || stat === 'check') && rest.length > 1) {
        const a = ability(rest[0]);
        if (a) ab = a;
        else if (stat === 'check') {
          const s = skill(rest[0]);
          if (!s) return err(`「${rest[0]}」不是属性也不是技能`);
          if ('error' in s) return err(s.error);
          sk = s.cn;
          ab = s.ability;
        } else return err(`「${rest[0]}」不是属性（str dex con int wis cha）`);
        rest = rest.slice(1);
      }
      const n = Number(String(rest[0] ?? '').replace(/^＋/, '+'));
      if (!Number.isInteger(n) || n === 0 || rest.length > 1) return err(`要写一个非零整数，比如 /mod ${args[0]} 2 或 /mod ${args[0]} -2`);
      return { kind: 'mod', stat, n, ...(ab ? { ability: ab } : {}), ...(sk ? { skill: sk } : {}) };
    }
    default: return null;
  }
}

export type ModStat = 'ac' | 'speed' | 'hpMax' | 'spellDc' | 'attack' | 'save' | 'check' | 'd20';
/** /mod 能改的东西（写法 → 改哪个） */
const MOD_STATS: Record<string, ModStat> = {
  ac: 'ac', 护甲: 'ac',
  speed: 'speed', spd: 'speed', 速度: 'speed',
  hp: 'hpMax', hpmax: 'hpMax', maxhp: 'hpMax', 生命: 'hpMax', 生命上限: 'hpMax',
  dc: 'spellDc', spelldc: 'spellDc',
  atk: 'attack', attack: 'attack', 攻击: 'attack',
  save: 'save', 豁免: 'save',
  check: 'check', 检定: 'check',
  d20: 'd20',
};
export const MOD_CN: Record<ModStat, string> = { ac: 'AC', speed: '速度', hpMax: '生命值上限', spellDc: '法术 DC', attack: '攻击检定', save: '豁免', check: '属性检定', d20: '所有 d20' };

/** /mod → 一个手动结束的现场效应（静态修正或检定加值） */
export function modTemplate(stat: ModStat, n: number, only: { ability?: Ability; skill?: string } = {}): { name: string; duration: { manual: true }; statics?: Array<{ kind: 'ac' | 'speed' | 'hpMax' | 'spellDc'; bonus: number }>; rollMods?: Array<{ on: { kind: 'attack' | 'save' | 'check' | 'd20'; ability?: Ability; skill?: string }; who: 'bearer'; op: 'add'; value: number; label: string }> } {
  // 「感知豁免」「察觉检定」：指定了属性 / 技能就写进名字
  const what = only.skill ? `${only.skill}检定` : only.ability ? `${ABIL_CN[only.ability]}${stat === 'save' ? '豁免' : '检定'}` : MOD_CN[stat];
  const name = `调整：${what} ${n > 0 ? '+' : '−'}${Math.abs(n)}${stat === 'speed' ? ' 尺' : ''}`;
  if (stat === 'attack' || stat === 'save' || stat === 'check' || stat === 'd20') {
    const on = { kind: stat, ...(only.ability && !only.skill ? { ability: only.ability } : {}), ...(only.skill ? { skill: only.skill } : {}) };
    return { name, duration: { manual: true }, rollMods: [{ on, who: 'bearer', op: 'add', value: n, label: name }] };
  }
  return { name, duration: { manual: true }, statics: [{ kind: stat, bonus: n }] };
}

/** 指令框的帮助（/h）：[写法, 说明] */
export const HELP: Array<[string, string]> = [
  ['直接打字', '说一句话'],
  ['/r 1d20+5, 2d6+3 说明', '公开掷骰（ad20 优势 · dd20 劣势 · 4d6kh3 取高）；/pr 私密掷骰'],
  ['/save dex 15', '选中的人各掷一次敏捷豁免，日志里列出谁过了'],
  ['/save dex 15 8d6 f h', '豁免 + 伤害：伤害掷一次，没过的全额，过了的减半（不写 h = 过了不受伤害）'],
  ['/check perc · /check str 15', '选中的人做技能 / 属性检定（DC 可不写）'],
  ['/damage 8d6 f · /heal 2d6+3 · /temphp 5', '选中的人受伤 / 治疗 / 临时生命值（骰子只掷一次）'],
  ['/temphp 10 o · /damage 8d6 f o', '末尾加 o：DM 暗中执行，玩家的日志里看不到'],
  ['/cond 中毒', '选中的人加一个状态'],
  ['/mod ac -2 · /mod speed 10 · /mod hp 5', '选中的人挂一个调整效应（hp = 生命值上限；还有 atk、d20、dc）；在效应标签上点 ✕ 去掉'],
  ['/mod save dex 2 · /mod check perc 1', '豁免 / 检定的加值：可以指定属性或技能，不写就是全部'],
  ['/next · /undo · /undo 3', '下一回合 · 撤销最近一步（或几步）'],
  ['/match 名字', '把法术、状态、专长、物品、怪物的原文发到日志'],
  ['/h', '这份说明'],
];

/** 伤害类型缩写表（帮助里显示） */
export const DAMAGE_HELP = DAMAGE.map(([cn, one, two]) => `${one}/${two} ${cn}`).join(' · ');
/** 属性缩写 */
export const ABIL_HELP = ABILS.map((a) => `${a} ${ABIL_CN[a]}`).join(' · ');
