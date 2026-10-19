/**
 * 卡面家规（`mods` / `grants`）的**表单 schema**：给可视化编辑器用。
 *
 * 引擎那边只认 `{ kind, ...字段 }`（`src/sheet/abilities.ts` 的 `reg(...)`）。
 * 这里补上「给人看的标签 / 输入类型 / 可选项」，并提供一个 `modSummary()` 生成中文摘要
 * （「速度 +10」「抗性：火焰、寒冷」），编辑器里实时显示，省得用户对着 JSON 猜。
 *
 * 加新的 mod kind 时：`src/sheet/abilities.ts` 注册 reg → 这里补一条 → 编辑器自动出现。
 */

export type FieldType = 'number' | 'text' | 'expr' | 'list' | 'select';
export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  /** select 的选项 */
  options?: string[];
  /** 输入框里的灰色提示 */
  hint?: string;
  /** 数字/文本的解释（显示在行尾） */
  note?: string;
}
export interface KindForm {
  label: string;
  hint: string;
  fields: FieldDef[];
}

const ABIL_CN = ['力量', '敏捷', '体质', '智力', '感知', '魅力'];
const ABIL_EN = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
export const ABILITY_OPTIONS = ABIL_EN.map((k, i) => `${k}:${ABIL_CN[i]}`);

const DAMAGE_TYPES = ['酸蚀', '钝击', '冷冻', '火焰', '力场', '闪电', '黯蚀', '穿刺', '毒素', '心灵', '光耀', '挥砍', '雷鸣'];
const SKILLS = ['运动', '体操', '巧手', '隐匿', '奥秘', '历史', '调查', '自然', '宗教', '驯兽', '洞悉', '医疗', '察觉', '生存', '欺瞒', '威吓', '表演', '说服'];
const CONDITION_IMMUNE = ['目盲', '魅惑', '耳聋', '力竭', '恐慌', '擒抱', '失能', '隐形', '麻痹', '石化', '中毒', '倒地', '受擒', '震慑', '昏迷'];

const listOf = (key: string, label: string, options: string[], note?: string): FieldDef =>
  ({ key, label, type: 'list', options, note });

/** 卡面 mod：kind → 表单 */
export const MOD_FORMS: Record<string, KindForm> = {
  speed: { label: '速度', hint: '走路速度的加值或改值', fields: [{ key: 'bonus', label: '加值（尺）', type: 'number' }, { key: 'set', label: '改为（尺）', type: 'number', note: '填了就覆盖' }] },
  hp: { label: '生命值上限', hint: '加最大生命值', fields: [{ key: 'bonus', label: '加值', type: 'number' }, { key: 'perLevel', label: '每级再加', type: 'number' }] },
  ac: { label: 'AC 算式', hint: '无甲防御这类「10 + 敏捷」；只想加几点就用「防御加值」', fields: [{ key: 'formula', label: '算式', type: 'expr', hint: '10 + dex + con' }, { key: 'ability', label: '属性（可选）', type: 'select', options: ABILITY_OPTIONS }] },
  initiative: { label: '先攻加值', hint: '先攻检定加值', fields: [{ key: 'bonus', label: '加值', type: 'number' }] },
  darkvision: { label: '黑暗视觉', hint: '给黑暗视觉', fields: [{ key: 'value', label: '距离（尺）', type: 'number' }] },
  sense: { label: '特殊感官', hint: '盲视 / 震颤感知 / 真实视觉', fields: [{ key: 'sense', label: '种类', type: 'select', options: ['blindsight:盲视', 'tremorsense:震颤感知', 'truesight:真实视觉'] }, { key: 'value', label: '距离（尺）', type: 'number' }] },
  moveSpeed: { label: '移动模式', hint: '飞行 / 游泳 / 攀爬速度', fields: [{ key: 'mode', label: '模式', type: 'select', options: ['fly:飞行', 'swim:游泳', 'climb:攀爬'] }, { key: 'value', label: '速度（尺）', type: 'number' }] },
  resist: { label: '伤害抗性', hint: '受到该类型伤害减半', fields: [listOf('values', '伤害类型', DAMAGE_TYPES)] },
  immune: { label: '伤害免疫', hint: '该类型伤害为 0', fields: [listOf('values', '伤害类型', DAMAGE_TYPES)] },
  conditionImmune: { label: '状态免疫', hint: '免疫该状态', fields: [listOf('values', '状态', CONDITION_IMMUNE)] },
  saveProf: { label: '豁免熟练', hint: '某属性的豁免加熟练加值', fields: [listOf('values', '属性', ABILITY_OPTIONS)] },
  saveBonus: { label: '豁免加值', hint: '豁免额外加值', fields: [{ key: 'value', label: '加值', type: 'number' }, { key: 'ability', label: '限定属性（可选）', type: 'select', options: ABILITY_OPTIONS }] },
  skillBonus: { label: '技能加值', hint: '某项技能的额外加值', fields: [{ key: 'skill', label: '技能', type: 'select', options: SKILLS }, { key: 'bonus', label: '加值', type: 'expr', hint: '2 / wis' }] },
  armorProf: { label: '护甲熟练', hint: '轻甲 / 中甲 / 重甲 / 盾牌', fields: [listOf('values', '护甲', ['轻甲', '中甲', '重甲', '盾牌'])] },
  weaponProf: { label: '武器熟练', hint: '简易 / 军用', fields: [listOf('values', '武器', ['简易', '军用'])] },
  tempHp: { label: '临时生命值', hint: '每次长休 / 短休给的临时生命值', fields: [{ key: 'bonus', label: '数值', type: 'expr', hint: '2d8 + 牧师等级' }, { key: 'perLevel', label: '每级', type: 'number' }] },
  note: { label: '说明', hint: '只作展示，不改数值', fields: [{ key: 'note', label: '文字', type: 'text' }] },
};

/** 卡面 grant：kind → 表单（授予某种东西） */
export const GRANT_FORMS: Record<string, KindForm> = {
  spell: { label: '法术', hint: '授予一道法术（视为已学会 / 常备）', fields: [listOf('values', '法术', [])] },
  cantrip: { label: '戏法', hint: '授予戏法', fields: [listOf('values', '戏法', [])] },
  feat: { label: '专长', hint: '授予专长', fields: [listOf('values', '专长', [])] },
  skill: { label: '技能熟练', hint: '授予技能熟练', fields: [listOf('values', '技能', SKILLS)] },
  expertise: { label: '技能专精', hint: '技能熟练加倍', fields: [listOf('values', '技能', SKILLS)] },
  tool: { label: '工具熟练', hint: '工具 / 乐器 / 工匠工具', fields: [listOf('values', '工具', [])] },
  language: { label: '语言', hint: '授予语言', fields: [listOf('values', '语言', [])] },
  itemMastery: { label: '武器精通', hint: '授予武器精通', fields: [listOf('values', '武器', [])] },
  note: { label: '说明', hint: '只显示一句话', fields: [{ key: 'text', label: '文字', type: 'text' }] },
};

/** "speed +10" 这种给人看的一句摘要 */
export function modSummary(m: Record<string, unknown>): string {
  const form = MOD_FORMS[String(m.kind)];
  const label = form?.label ?? String(m.kind ?? '?');
  const val = (k: string) => (m[k] === undefined || m[k] === '' ? '' : String(m[k]));
  const num = (k: string) => {
    const v = Number(m[k]);
    return Number.isFinite(v) && v !== 0 ? (v > 0 ? `+${v}` : String(v)) : '';
  };
  switch (String(m.kind)) {
    case 'speed': return `速度 ${num('bonus') || `改为 ${val('set')}`}`;
    case 'hp': return `生命上限 ${num('bonus')}${val('perLevel') ? `（每级 ${num('perLevel')}）` : ''}`;
    case 'ac': return `AC = ${val('formula') || '?'}`;
    case 'initiative': return `先攻 ${num('bonus')}`;
    case 'saveBonus': return `${val('ability') ? `${val('ability')} ` : ''}豁免 ${num('value')}`;
    case 'skillBonus': return `${val('skill')} ${num('bonus') || val('bonus')}`;
    case 'darkvision': return `黑暗视觉 ${val('value')} 尺`;
    case 'sense': return `${val('sense')} ${val('value')} 尺`;
    case 'moveSpeed': return `${val('mode')} 速度 ${val('value')} 尺`;
    case 'tempHp': return `临时生命值 ${val('bonus')}${val('perLevel') ? `（每级 ${num('perLevel')}）` : ''}`;
    case 'note': return `说明：${val('note').slice(0, 40)}`;
    default: {
      const list = Array.isArray(m.values) ? (m.values as string[]) : [];
      return list.length ? `${label}：${list.join('、')}` : label;
    }
  }
}

export function grantSummary(g: Record<string, unknown>): string {
  const form = GRANT_FORMS[String(g.kind)];
  const label = form?.label ?? String(g.kind ?? '?');
  const list = Array.isArray(g.values) ? (g.values as string[]) : [];
  if (list.length) return `${label}：${list.join('、')}`;
  if (g.text) return `说明：${String(g.text).slice(0, 40)}`;
  return label;
}
