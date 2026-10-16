/**
 * 自制怪物：贴一段纯文本数据块（照 MONSTER_TEMPLATE 的写法）→ 5etools 格式的怪物 → parseMonster。
 * 只认规则化的写法；认不出来的照样原文列进「要手动处理」。以后 AI 洗过的文本也走这里。
 */
type Json = any;

export const MONSTER_TEMPLATE = `名字：洞穴巨魔
体型：大型　类型：巨人　挑战等级：5
AC 15　生命值 84　速度 30 尺
力量 18　敏捷 13　体质 20　智力 7　感知 9　魅力 7
豁免：体质 +8
技能：察觉 +2
伤害抗性：
伤害免疫：
状态免疫：

特性
再生。巨魔在自己的回合开始时恢复 10 点生命值；受到强酸或火焰伤害后，下一回合不恢复。

动作
多重攻击。巨魔进行三次攻击：一次啃咬和两次爪击。
啃咬。近战攻击检定：+7，触及 5 尺。命中：7（1d6+4）穿刺伤害。
爪击。近战攻击检定：+7，触及 5 尺。命中：11（2d6+4）挥砍伤害。
腐臭吐息（充能 5–6）。体质豁免：DC 15，15 尺锥状区域内的每名生物。失败：21（6d6）毒素伤害。成功：半伤。

附赠动作

反应

传奇动作（3 次）
`;

const SIZE: Record<string, string> = { 微型: 'T', 小型: 'S', 中型: 'M', 大型: 'L', 巨型: 'H', 超巨型: 'G' };
const TYPE: Record<string, string> = {
  异怪: 'aberration', 野兽: 'beast', 天界生物: 'celestial', 构装生物: 'construct', 龙类: 'dragon', 元素生物: 'elemental', 精类: 'fey',
  邪魔: 'fiend', 巨人: 'giant', 类人生物: 'humanoid', 怪兽: 'monstrosity', 泥怪: 'ooze', 植物: 'plant', 不死生物: 'undead',
};
const ABIL: Record<string, string> = { 力量: 'str', 敏捷: 'dex', 体质: 'con', 智力: 'int', 感知: 'wis', 魅力: 'cha' };
const SKILL_EN: Record<string, string> = {
  体操: 'acrobatics', 驯兽: 'animal handling', 奥秘: 'arcana', 运动: 'athletics', 欺瞒: 'deception', 历史: 'history', 洞悉: 'insight',
  威吓: 'intimidation', 调查: 'investigation', 医药: 'medicine', 自然: 'nature', 察觉: 'perception', 表演: 'performance',
  游说: 'persuasion', 宗教: 'religion', 巧手: 'sleight of hand', 隐匿: 'stealth', 求生: 'survival',
};
const SECTIONS: Record<string, string> = { 特性: 'trait', 动作: 'action', 附赠动作: 'bonus', 反应: 'reaction', 传奇动作: 'legendary' };

/** 正文里的规则化写法 → 5etools 标记（parseMonster 认这些） */
function tag(s: string): string {
  return s
    .replace(/近战或远程攻击检定\s*[：:]\s*([+-]?\d+)/g, (_, n) => `{@atkr m,r} {@hit ${Number(n)}}`)
    .replace(/近战攻击检定\s*[：:]\s*([+-]?\d+)/g, (_, n) => `{@atkr m} {@hit ${Number(n)}}`)
    .replace(/远程攻击检定\s*[：:]\s*([+-]?\d+)/g, (_, n) => `{@atkr r} {@hit ${Number(n)}}`)
    .replace(/(力量|敏捷|体质|智力|感知|魅力)豁免\s*[：:]\s*DC\s*(\d+)/g, (_, a, n) => `{@actSave ${ABIL[a]}} {@dc ${n}}`)
    .replace(/命中\s*[：:]/g, '{@h}')
    .replace(/失败\s*[：:]/g, '{@actSaveFail} ')
    .replace(/成功\s*[：:]/g, '{@actSaveSuccess} ')
    .replace(/[（(]\s*(\d+d\d+(?:\s*[+-]\s*\d+)?)\s*[）)]/g, (_, d) => `（{@damage ${d.replace(/\s+/g, ' ')}}）`)
    .replace(/(\d+)\s*尺\s*(锥状|球状|线状|立方|放射|圆柱)/g, (_, n, sh) => `${n} 尺{@variantrule ${sh}}`);
}

export function textToMonster(text: string): Json {
  const lines = text.replace(/\r/g, '').split('\n').map((l) => l.trim());
  const m: Json = { source: 'HB', size: ['M'], type: 'humanoid', ac: [10], hp: { average: 1 }, speed: { walk: 30 }, cr: '0' };
  const field = (re: RegExp) => { for (const l of lines) { const x = re.exec(l); if (x) return x; } return null; };
  m.name = field(/^名字\s*[：:]\s*(.+)$/)?.[1]?.trim() || '自制怪物';
  m.ENG_name = '';
  const size = field(/体型\s*[：:]\s*(\S+?)(?:\s|　|$)/)?.[1];
  if (size && SIZE[size]) m.size = [SIZE[size]];
  const type = field(/类型\s*[：:]\s*(\S+?)(?:\s|　|$)/)?.[1];
  if (type && TYPE[type]) m.type = TYPE[type];
  const cr = field(/挑战等级\s*[：:]?\s*([\d/]+)/)?.[1];
  if (cr) m.cr = cr;
  const ac = field(/(?:^|\s|　)AC\s*[：:]?\s*(\d+)/i)?.[1];
  if (ac) m.ac = [Number(ac)];
  const hp = field(/生命值\s*[：:]?\s*(\d+)/)?.[1];
  if (hp) m.hp = { average: Number(hp) };
  const sp = field(/速度\s*[：:]?\s*(\d+)/)?.[1];
  if (sp) m.speed = { walk: Number(sp) };
  for (const [cn, en] of Object.entries(ABIL)) {
    const v = field(new RegExp(`(?:^|\\s|　)${cn}\\s*[：:]?\\s*(\\d+)(?!\\s*尺)`))?.[1];
    if (v) m[en] = Number(v);
  }
  const listField = (name: string) => (field(new RegExp(`^${name}\\s*[：:]\\s*(.*)$`))?.[1] ?? '').split(/[，,、；;]/).map((x) => x.trim()).filter(Boolean);
  const save: Record<string, string> = {};
  for (const s of listField('豁免')) { const x = /(力量|敏捷|体质|智力|感知|魅力)\s*([+-]\d+)/.exec(s); if (x) save[ABIL[x[1]]] = x[2]; }
  if (Object.keys(save).length) m.save = save;
  const skill: Record<string, string> = {};
  for (const s of listField('技能')) { const x = /(\S+?)\s*([+-]\d+)/.exec(s); if (x && SKILL_EN[x[1]]) skill[SKILL_EN[x[1]]] = x[2]; }
  if (Object.keys(skill).length) m.skill = skill;
  const res = listField('伤害抗性'); if (res.length) m.resist = res;
  const imm = listField('伤害免疫'); if (imm.length) m.immune = imm;
  const vul = listField('伤害易伤'); if (vul.length) m.vulnerable = vul;
  const ci = listField('状态免疫'); if (ci.length) m.conditionImmune = ci;

  // 分节：特性 / 动作 / 附赠动作 / 反应 / 传奇动作（次数写在标题里）
  let sec: string | null = null;
  for (const l of lines) {
    const head = /^(特性|动作|附赠动作|反应|传奇动作)(?:\s*[（(](\d+)\s*次[）)])?\s*$/.exec(l);
    if (head) {
      sec = SECTIONS[head[1]];
      if (head[2]) m.legendaryActions = Number(head[2]);
      continue;
    }
    if (!sec || !l) continue;
    const x = /^([^。.]{1,30}?)[。.]\s*(.+)$/.exec(l);
    if (!x) continue;
    let name = x[1].trim();
    const rc = /[（(]\s*充能\s*(\d)?\s*(?:[–\-~～]\s*6)?\s*[）)]/.exec(name);
    if (rc) name = name.replace(rc[0], '').trim() + ` {@recharge ${rc[1] ?? '6'}}`;
    (m[sec] ??= []).push({ name, ENG_name: '', entries: [tag(x[2])] });
  }
  // 传奇抗性写在特性名字里：「传奇抗性（3/日）」——parseMonster 认
  return m;
}
