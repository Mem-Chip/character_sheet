/**
 * 事件 → 日志行。只管文字；纯记账的事件（经济、HP 绝对值…）不出行，它们的结果在叙事事件里已经说了。
 */
import { ABIL_CN, type Ability } from '../../src/expr';
import type { GameEvent } from '../../src/combat';

export type Tone = 'hit' | 'miss' | 'crit' | 'dmg' | 'heal' | 'warn' | 'danger' | 'dm' | 'head' | undefined;

export interface Line {
  seq: number;
  text: string;
  tone?: Tone;
  /** 掷骰明细（等宽小字） */
  receipt?: string;
  /** 次级行（修正来源、伤害注记） */
  sub?: string[];
  /** 可以被 DM 事后裁定的东西 */
  roll?: { index: number; kind: string; judged: boolean };
  damage?: { index: number; byType: Record<string, number> };
  /** 这一行是一次掷骰（d20 / 伤害骰）：r / d + 这笔事务里的第几次。日志里转明 / 转暗用 */
  dice?: { kind: 'r' | 'd'; index: number };
}

type P = Record<string, any>;

const OUTCOME_CN: Record<string, string> = { hit: '命中', miss: '未命中', success: '成功', fail: '失败' };
const ACT_CN: Record<string, string> = { action: '动作', bonus: '附赠动作', reaction: '反应', free: '', none: '', special: '' };
const MOD_CN: Record<string, string> = {
  adv: '优势', disadv: '劣势', noAdv: '禁止优势', add: '加值', addDice: '加骰', autoFail: '自动失败', autoSucceed: '自动成功',
  critRange: '重击范围', autoCritOnHit: '命中即重击', minD20: 'd20 保底', minDie: '伤害骰保底', targetAdd: '目标加值',
};

const sgn = (n: number) => (n >= 0 ? `+ ${n}` : `− ${-n}`);
const abil = (a: unknown) => (a ? ABIL_CN[a as Ability] ?? String(a) : '');

/** 玩家视角下要保密的参与者（怪物）：它的骰子明细、AC、生命值数字不显示 */
export type Secret = (id: unknown) => boolean;

const ZONE_WHY: Record<string, string> = {
  enter: '进入', turnStart: '在里面开始回合', turnEnd: '在里面结束回合', create: '在区域出现的地方', leave: '离开', move: '在里面移动',
};

/** dark：这次掷骰在当前视角下是暗骰（不给骰面和明细）；不给 = 掷骰的人是要保密的就算暗骰 */
export function describe(ev: GameEvent, name: (id: unknown) => string, secret: Secret = () => false, dark?: boolean): Line | null {
  const p = ev.payload as P;
  const L = (text: string, tone?: Tone, extra: Partial<Line> = {}): Line => ({ seq: ev.seq, text, tone, ...extra });
  switch (ev.type) {
    case 'combatantAdded': return L(`${p.combatant.name} 加入遭遇`);
    case 'combatantRemoved': return L(`${name(p.id)} 离开遭遇`);
    case 'baseRefreshed': return L(`${name(p.id)} 的数值按人物卡更新${p.hpMaxBefore !== p.base.hpMax && !secret(p.id) ? `（生命值上限 ${p.hpMaxBefore} → ${p.base.hpMax}）` : ''}`);
    case 'combatStarted': return L(`战斗开始。先攻顺序：${(p.order as string[]).map(name).join('、')}`, 'head');
    case 'combatEnded': return L('战斗结束', 'head');
    case 'roundStarted': return L(`第 ${p.round} 轮`, 'head');
    case 'turnStarted': return L(`${name(p.id)} 的回合`, 'head');
    case 'actionUsed': {
      const act = ACT_CN[p.activation] ?? '';
      const tg = (p.targets as string[] ?? []).filter((t) => t !== p.actor);
      return L(`${name(p.actor)} 使用「${p.action}」${act ? `（${act}）` : ''}${tg.length ? ` → ${tg.map(name).join('、')}` : ''}`);
    }
    case 'spellCast': return p.slotLevel ? L(`消耗 ${p.slotLevel} 环法术位`) : null;
    case 'd20Rolled': return d20Line(ev, p, name, secret, dark);
    case 'attackHit': return L(`${p.crit ? '重击！' : '命中'} ${name(p.target)}`, p.crit ? 'crit' : 'hit');
    case 'attackMissed': return L(`未命中 ${name(p.target)}${p.why ? `（${p.why}）` : ''}`, 'miss');
    case 'attackRechecked': return secret(p.target) ? L('复核 → 未命中', 'miss') : L(`复核：总值 ${p.total} 对 AC ${p.vs}（原 ${p.vsBefore}）→ 未命中`, 'miss');
    case 'critUpgraded': return L(`升级为重击（${(p.by as string[]).join('、')}）`, 'crit');
    case 'saveForced': return null;
    case 'saveFailed': return null;
    case 'saveSucceeded': return null;
    case 'damageAdded': return null;
    case 'damageRolled': {
      const parts = (p.parts as P[]).map((x) => `${x.dice} [${(x.faces as number[]).join(', ')}] = ${x.total} ${x.type}${x.from && x.from !== p.label ? `（${x.from}）` : ''}`);
      return L(`伤害骰${p.crit ? '（重击）' : ''}${p.scale !== 1 ? `，×${p.scale}` : ''}`, undefined, { receipt: dark ? undefined : parts.join('；'), dice: { kind: 'd', index: p.index } });
    }
    case 'damageApplied': {
      if (secret(p.target)) return L(`${name(p.target)} 受到 ${p.total} 点伤害`, 'dmg', { damage: { index: p.index, byType: p.byType } });
      const types = Object.entries(p.byType as Record<string, number>).map(([t, n]) => `${n} ${t}`).join(' + ');
      const notes = (p.notes as string[] | undefined)?.filter(Boolean) ?? [];
      return L(
        `${name(p.target)} 受到 ${p.total} 点伤害${types && Object.keys(p.byType).length > 1 ? `（${types}）` : types ? `（${Object.keys(p.byType)[0]}）` : ''}　生命值 ${p.hpBefore} → ${p.hpAfter}${p.tempAbsorbed ? `，临时生命值吸收 ${p.tempAbsorbed}` : ''}`,
        'dmg', { sub: notes, damage: { index: p.index, byType: p.byType } },
      );
    }
    case 'healed': return secret(p.target) ? L(`${name(p.target)} 恢复了生命值`, 'heal') : L(`${name(p.target)} 恢复 ${p.amount} 点生命值（${p.label}）　${p.hpBefore} → ${p.hpAfter}`, 'heal');
    case 'tempHpGained': return L(`${name(p.target)} 获得 ${p.amount} 点临时生命值${p.kept !== p.amount ? `（保留较高的 ${p.kept}）` : ''}`, 'heal');
    case 'effectApplied': return L(`${name(p.bearer)} 获得「${p.name}」${p.source && p.source !== p.bearer ? `（来自 ${name(p.source)}）` : ''}`);
    case 'effectEnded': return L(`${name(p.bearer)} 的「${p.name}」结束${p.reason ? `（${p.reason}）` : ''}`);
    case 'effectBlocked': return L(p.reason, 'warn');
    case 'effectLevel': return L(`${name(p.bearer)} 的「${p.name}」到 ${p.level} 级`, 'warn');
    case 'effectExtended': return L(`${name(p.bearer)} 的「${p.name}」延长（${p.by}）`);
    case 'effectSuppressed': return L(`${name(p.bearer)} 的「${p.name}」被同名效应压制`);
    case 'effectResumed': return L(`${name(p.bearer)} 的「${p.name}」恢复生效`);
    case 'triggerFired': return L(`${name(p.owner)}：${p.label}`, 'warn');
    case 'note': return L(String(p.text));
    case 'moved': return p.forced ? L(`${name(p.id)} 被移动到新位置`) : null;
    case 'leftReach': return L(`${name(p.id)} 离开了 ${name(p.from)} 的触及范围`, 'warn');
    case 'zoneCreated': return L(`地图上出现区域「${p.zone.name}」`);
    case 'zoneRemoved': return L(`区域「${p.name}」消失${p.reason ? `（${p.reason}）` : ''}`);
    case 'zoneMoved': return L(`区域「${p.name}」挪到了新位置`);
    case 'zoneHit': return L(`${name(p.id)} ${ZONE_WHY[p.why] ?? '碰到'}：区域「${p.name}」`, 'warn');
    case 'died': return L(`${name(p.id)} 死亡（${p.reason}）`, 'danger');
    case 'deathSaveResult': return L(`${name(p.id)}：${p.result}`, 'heal');
    case 'deathSaveFailed': return L(`${name(p.id)} 死亡豁免失败 ×${p.failures}（${p.by}）`, 'danger');
    case 'stableChanged': return p.stable ? L(`${name(p.id)} 伤势稳定`) : null;
    case 'manualOverride': return p.what === 'hp' && secret(p.id) ? L(`DM 调整了 ${name(p.id)} 的生命值`, 'dm') : L(`DM：${overrideText(p, name)}`, 'dm');
    case 'ruleError': return L(`规则出错：${p.where}：${p.message}`, 'danger');
    case 'restStarted': return L(`${p.kind === 'long' ? '长休' : '短休'}开始`, 'head');
    case 'restCompleted': return L(`${p.kind === 'long' ? '长休' : '短休'}结束`);
    case 'timeAdvanced': return L(`时间流逝 ${p.minutes} 分钟`);
    case 'settingsChanged': return L(`设置变更：${Object.entries(p.patch).map(([k, v]) => `${SETTING_CN[k] ?? k} = ${SETTING_VAL_CN[String(v)] ?? v}`).join('，')}`, 'dm');
    case 'answersRemembered': return null;
    default: return null;
  }
}

const SETTING_CN: Record<string, string> = { monsterAt0: '怪物 0 生命值', reactionTiming: '反应时机', useGuesses: '按推测走', automation: '自动化' };
const SETTING_VAL_CN: Record<string, string> = {
  dead: '直接死亡', unconscious: '昏迷', afterResult: '看到结果再决定', raw: '按规则原文', true: '是', false: '否',
};

function overrideText(p: P, name: (id: unknown) => string): string {
  switch (p.what) {
    case 'hp': return `${name(p.id)} 生命值 ${p.from} → ${p.to}`;
    case 'damage': return `对 ${name(p.id)} 造成 ${p.amount} 点${p.type}伤害`;
    case 'heal': return `治疗 ${name(p.id)} ${p.amount} 点`;
    case 'tempHp': return `给 ${name(p.id)} ${p.amount} 点临时生命值`;
    case 'applyEffect': return `给 ${name(p.to)} 施加「${String(p.template).split(':').pop()}」`;
    case 'removeEffect': return '移除效应';
    case 'groupRoll': {
      const dmg = p.damage as { dice: string; type: string } | undefined;
      return `${(p.ids as string[]).map(name).join('、')} 做${p.label}${dmg ? `，没过的受 ${dmg.dice} ${dmg.type}伤害，${p.half ? '过了的减半' : '过了的不受伤害'}` : ''}`;
    }
    case 'economy': return `${name(p.id)} 的${Object.entries(p.patch as Record<string, number>).map(([k, v]) => `${({ action: '动作', bonus: '附赠动作', reaction: '反应', move: '移动' } as Record<string, string>)[k] ?? k}${k === 'move' ? ` ${v} 尺` : v ? '可用' : '已用'}`).join('、')}`;
    case 'usage': return `${name(p.id)} 的${p.slot != null ? ` ${p.slot} 环法术位` : p.hitDie != null ? ` d${p.hitDie} 生命骰` : `「${p.resource}」`}已用次数改为 ${p.used}`;
    default: return String(p.what);
  }
}

function d20Line(ev: GameEvent, p: P, name: (id: unknown) => string, secret: Secret, darkRoll?: boolean): Line {
  const d20 = p.d20 as number[];
  const mode = p.cancelled ? '优劣势抵消' : p.adv ? '优势' : p.disadv ? '劣势' : '';
  const dice = d20.length > 1 ? `d20 [${d20.join(', ')}]${mode ? ` ${mode}` : ''} → ${p.natural}` : `d20 [${p.natural}]${mode ? ` ${mode}` : ''}`;
  const extras = (p.extra as P[]).map((x) => ` ${sgn(x.total)}（${x.label} ${x.dice}）`).join('');
  const parts = [`${dice}${p.kept !== p.natural ? ` → 保底 ${p.kept}` : ''}`, p.bonus ? ` ${sgn(p.bonus)}` : '', p.flat ? ` ${sgn(p.flat)}` : '', extras, ` = ${p.total}`];
  // 攻击怪物不告诉 AC；怪物自己掷的骰子（暗骰）不给明细
  const vs = p.vs === null || p.vs === undefined || (p.kind === 'attack' && secret(p.target)) ? ''
    : p.kind === 'attack' ? ` 对 AC ${p.vs}` : ` 对 DC ${p.vs}`;
  const dark = darkRoll ?? secret(p.roller);
  const out = p.outcome ? OUTCOME_CN[p.outcome] + (p.crit ? '（重击）' : '') : '';
  const what = p.kind === 'attack' ? `用「${String(p.label).replace(/\s*攻击检定$/, '')}」攻击${p.target ? ` ${name(p.target)}` : ''}`
    : p.sub === 'initiative' ? '先攻' : p.sub === 'deathSave' ? '死亡豁免' : p.sub === 'concentration' ? '专注检定'
      : p.label || `${abil(p.ability)}${p.kind === 'save' ? '豁免' : '检定'}`;
  const tone: Tone = p.crit ? 'crit' : p.outcome === 'hit' || p.outcome === 'success' ? 'hit' : p.outcome ? 'miss' : undefined;
  const sub: string[] = [];
  for (const m of p.mods as P[]) sub.push(`${MOD_CN[m.op] ?? m.op}${m.value ? ` ${m.value}` : ''}：${m.label}${m.owner !== p.roller ? `（${name(m.owner)}）` : ''}${m.rule ? ` · ${m.rule}` : ''}`);
  for (const a of p.assumptions as string[]) sub.push(`按推测：${a}`);
  if (p.autoFail) sub.push('自动失败');
  if (p.autoSucceed) sub.push('自动成功');
  if (p.overridden) sub.push(`DM 裁定：${p.overridden}`);
  return {
    seq: ev.seq,
    text: `${name(p.roller)} ${what}${vs}${out ? ` → ${out}` : ''}`,
    tone,
    receipt: dark ? undefined : parts.join(''),
    sub: dark ? [] : sub,
    roll: { index: p.index, kind: p.kind, judged: p.vs !== null && p.vs !== undefined },
    dice: { kind: 'r', index: p.index },
  };
}

/** 一笔事务的标题（命令本身） */
export function txTitle(cmd: { type: string } & P, name: (id: unknown) => string): string {
  switch (cmd.type) {
    case 'addCombatant': return `加入 ${cmd.combatant.name}`;
    case 'removeCombatant': return `移除 ${name(cmd.id)}`;
    case 'refreshCombatant': return `${name(cmd.id)} 按人物卡更新`;
    case 'startCombat': return '开始战斗';
    case 'nextTurn': return '下一回合';
    case 'endCombat': return '结束战斗';
    case 'useAction': return `${name(cmd.actor)} 的动作`;
    case 'roll': return `${name(cmd.roller)} 掷骰`;
    case 'applyEffect': return `施加效应`;
    case 'removeEffect': return '移除效应';
    case 'adjustHp': return '调整生命值';
    case 'damage': return '手动伤害';
    case 'groupRoll': return `${cmd.ids.length} 人${ABIL_CN[cmd.ability as Ability]}${cmd.kind === 'save' ? '豁免' : '检定'}`;
    case 'heal': return '手动治疗';
    case 'tempHp': return '临时生命值';
    case 'manualCast': return `${name(cmd.actor)} 施放「${cmd.spell}」`;
    case 'setUsage': return '调整次数';
    case 'spendHitDie': return `${name(cmd.id)} 花生命骰`;
    case 'setEconomy': return `${name(cmd.id)} 调整动作`;
    case 'endConcentration': return `${name(cmd.id)} 终止专注`;
    case 'move': return `${name(cmd.id)} 移动`;
    case 'createZone': return `DM 放下区域「${cmd.zone.name}」`;
    case 'removeZone': return '删除区域';
    case 'moveZone': return '挪动区域';
    case 'advanceTime': return `时间流逝 ${cmd.minutes} 分钟`;
    case 'rest': return `${cmd.ids?.length === 1 ? `${name(cmd.ids[0])} ` : ''}${cmd.kind === 'long' ? '长休' : '短休'}`;
    case 'setSettings': return '设置';
    default: return cmd.type;
  }
}
