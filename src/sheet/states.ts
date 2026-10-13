/**
 * 旧版临时状态（移植自原项目 rules/class-state.js 的 TEMP_STATES / States）。
 *
 * ⚠️ 这是**兼容层**：只为了让原项目导出的卡（`char.states` 里存着 'rage' 之类）算出来的数值不变。
 * 新卡的狂暴 / 先天术法 / 剑歌都走动态层的 ActiveEffect（data/dyn/*.json），那边修掉了这里的已知错误：
 * 这里的狂暴写的是 `rounds: 10`（1 分钟），2024 原文是「至多 10 分钟、需要逐轮延长」。
 */
import type { CalcCtx } from './pipeline';
import type { Json } from './store';
import type { CharData } from './character';

export const TEMP_STATES: Record<string, Json> = {
  rage: {
    name: '狂暴', from: '野蛮人·狂暴',
    action: '附赠动作', duration: '至你下一回合结束（可延长）',
    cost: '1 次狂暴次数',
    requires: '未着装重甲',
    effects: [
      { kind: 'note', note: '力量检定与力量豁免具有优势' },
      { kind: 'damageBonus', ability: 'str', note: '力量攻击的伤害掷骰获得加值（数值见野蛮人等级表「狂暴伤害」列）' },
      { kind: 'resist', damage: ['B', 'P', 'S'], note: '钝击 / 穿刺 / 斩击抗性' },
    ],
    flags: ['无法保持专注', '不能施展法术'],
    endsOn: ['穿戴重甲', '陷入失能'],
    rounds: 10,
    extendable: true,
  },
  innateSorcery: {
    name: '先天术法', from: '术士·先天术法',
    action: '附赠动作', duration: '1 分钟',
    cost: '1 次使用次数（共 2 次，长休全恢复）',
    effects: [
      { kind: 'spellDcBonus', bonus: 1, list: '术士', note: '你施展的术士法术豁免 DC +1' },
      { kind: 'note', note: '你施展的术士法术的攻击检定具有优势' },
    ],
    rounds: 10,
  },
  starryForm: {
    name: '星耀形态', from: '德鲁伊·星辰结社·星耀形态',
    action: '附赠动作', duration: '10 分钟',
    cost: '1 次荒野形态使用次数',
    effects: [{ kind: 'note', note: '选择射手座 / 圣杯座 / 巨龙座之一，获得对应效果' }],
    choices: [{ id: 'constellation', kind: 'note', count: 1, from: ['射手座', '圣杯座', '巨龙座'], label: '选择星座形态' }],
  },
  bladesong: {
    name: '剑歌', from: '法师·剑咏者·剑歌',
    action: '附赠动作', duration: '1 分钟',
    costResource: 'bladesong',
    requires: '未着装中甲 / 重甲、未持盾',
    effects: [
      { kind: 'ac', ability: 'int', note: 'AC 加上智力调整值（最低 +1）' },
      { kind: 'speed', bonus: 10 },
      { kind: 'note', note: '专注豁免具有优势；智力（奥秘）检定获得加值；可用智力代替力量/敏捷做武器攻击与伤害' },
    ],
    endsOn: ['再次使用剑歌', '着装中甲/重甲或持盾', '陷入失能', '用双手进行武器攻击'],
    rounds: 10,
  },
  wildShape: {
    name: '荒野形态', from: '德鲁伊·荒野形态',
    action: '附赠动作', duration: '德鲁伊等级一半的小时',
    cost: '1 次荒野形态使用次数',
    transform: 'wildshape',
    effects: [], flags: ['使用野兽的属性 / AC / HP / 速度'],
    endsOn: ['HP 归零', '再次使用荒野形态', '陷入失能', '死亡'],
  },
};

export class States {
  active(c: CharData): string[] { return Array.isArray(c.states) ? c.states : (c.states = []); }
  isOn(c: CharData, id: string): boolean { return this.active(c).includes(id); }
  round(c: CharData): number { return Number.isFinite(c.round) ? c.round : (c.round = 1); }
  list(c: CharData): Json[] { return this.active(c).map((id) => ({ id, ...(TEMP_STATES[id] || { name: id }) })); }

  toggle(c: CharData, id: string): boolean {
    const a = this.active(c);
    const i = a.indexOf(id);
    if (i >= 0) {
      a.splice(i, 1);
      delete (c.statesRounds || {})[id];
    } else {
      a.push(id);
      (c.statesRounds = c.statesRounds || {})[id] = this.round(c);
    }
    return i < 0;
  }

  /** 状态是否属于这个角色（三段 from = 职业·子职·特性，要校验子职） */
  available(c: CharData, id: string): boolean {
    const st = TEMP_STATES[id];
    if (!st) return false;
    const segs = String(st.from || '').split('·').map((s) => s.trim()).filter(Boolean);
    if (!segs.length) return true;
    const [clsName, subNeed] = segs;
    const needsSub = segs.length >= 3;
    return (c._resolved?.classes || []).some((k: Json) => {
      if (k.cls.name !== clsName) return false;
      if (!needsSub) return true;
      const sub = String(k.subclassName || '');
      if (!sub) return false;
      return sub.includes(subNeed) || subNeed.includes(sub);
    });
  }

  /** 把激活状态的 effect 灌进计算上下文（与 Abilities.applyMods 同一层） */
  applyEffects(ctx: CalcCtx): void {
    for (const st of this.list(ctx.char)) {
      for (const e of st.effects || []) {
        if (e.kind === 'note') continue;
        ctx.addEffect({ ...e, source: `状态：${st.name}` });
      }
    }
  }
}
