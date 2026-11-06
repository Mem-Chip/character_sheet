import { ABIL_CN, Dice, Unknown, run, runBool, runDice, runInt, type ExprSrc, type Question, type Value } from '../expr';
import { applyDamagePacket, applyHeal, grantTempHp, maxDiceFor, normType, rollComponent, type DamageComponent, type DamagePacket } from './damage';
import { controllerOf, d20Test, rollValue } from './d20';
import { newCastPlan, type CastPlan } from './castplan';
import { currentAction, markAction, resultOf, spellMetaOf, type ActionInstance } from './instance';
import { activeTemplates, applyEffect, conditionsInNodes, effectiveView, effectsOf, endConcentration, endEffect, skillBonus, startConcentration } from './effects';
import { makeEnv, nameOf, type ScopeData } from './scope';
import { entryOf } from './collect';
import { placeSummon, placeZone, relocateZone, shove } from './space';
import { blockedEconomy, fireWindow } from './triggers';
import { Rejected, type Tx } from './tx';
import { makeCombatant, makeView } from './view';
import type { Action, ActiveEffect, AttackInfo, AttackRow, CombatantView, Cost, Duration, EffectId, Entry, Id, Modify, Node, TargetPick, Zone } from './types';

/**
 * 效果树解释器 + 动作执行（COMBAT-DESIGN §4.1 / §4.2）。
 *
 * 约定（实现时定下的，见设计稿勘误）：
 * - 动作的 root 只执行一次。需要目标的节点（attack / save / 指向 target 的节点）在没有「当前目标」
 *   而有多个目标时，**隐式地对每个目标各执行一次**（共享同一份 locals：同 id 的伤害只掷一次）。
 * - 一个分支（节点列表）里的 `damage` 节点合成**一个伤害包**先结算，然后再执行其余节点
 *   （「命中：X 点伤害，并且目标须进行豁免」—— 伤害在前）。
 */

export interface RolledDamage {
  comps: DamageComponent[];
}

export interface ExecCtx {
  /** 窗口触发器正在打断 / 改写的那次施法（`modifyCast` 改它） */
  interrupting?: CastPlan;
  self: Id;
  source?: Id | null;
  targets: Id[];
  target?: Id;
  attacker?: Id;
  slot?: number;
  entryKey: string;
  actionName: string;
  cause: number | null;
  locals: Record<string, RolledDamage>;
  /** 本动作里所有带 id 的伤害节点（ref 指向的那个还没掷过时，按它的定义补掷） */
  damageDefs?: Record<string, Extract<Node, { kind: 'damage' }>>;
  effectId?: EffectId;
  /** 本动作开启的专注（施加的效应默认链接到它） */
  concentrationId?: EffectId;
  concentrationDuration?: Duration;
  attack?: AttackInfo;
  roll?: Record<string, Value>;
  damage?: Record<string, Value>;
  event?: Record<string, unknown>;
  /** 这次动作所属的施法计划书（法术才有；save / attack / damage 会读它上面的改写） */
  cast?: CastPlan;
  /** attackHit 窗口里：addDamage 往这里加 */
  packet?: DamagePacket;
  /** 最近一次豁免的 DC（saveEnds 缺省用它） */
  dc?: number;
  originKind?: ActiveEffect['origin']['kind'];
  /** number / choose 节点选出来的值（同一次执行里共享） */
  vars?: Record<string, number | string>;
  /** 窗口里能改正在结算的东西（modify 节点用）；不在 before 窗口里就没有 */
  modify?: (m: Modify) => void;
  /** 正在生效的区域（区域的 do / while 里）：applyEffect 的 whileInZone 标到它上面 */
  zone?: string;
  /** 在区域的 while 里：挂的效应一律随区域 */
  zoneWhile?: boolean;
  /** 范围法术选的格子（zone 节点用） */
  area?: { cells: string[]; tpl?: Record<string, unknown> };
  /** 当前在豁免的哪个分支里（伤害包据此知道「成功减半」，反射闪避用） */
  save?: { ability: string; success: boolean; half: boolean };
  /** 荒野形态 / 召唤动作从 UI 传入的生物面板 */
  form?: CombatantView;
}

export function scopeOf(tx: Tx, ctx: ExecCtx): ScopeData {
  return {
    self: ctx.self,
    source: ctx.source,
    target: ctx.target,
    attacker: ctx.attacker,
    slot: ctx.slot,
    roll: ctx.roll,
    attack: ctx.attack,
    damage: ctx.damage,
    event: ctx.event,
    effect: ctx.effectId ? tx.state.effects[ctx.effectId] : undefined,
    vars: ctx.vars,
  };
}

const env = (tx: Tx, ctx: ExecCtx) => makeEnv(tx, scopeOf(tx, ctx));

function num(tx: Tx, ctx: ExecCtx, e: ExprSrc, what: string): number {
  const v = runInt(e, env(tx, ctx));
  if (v instanceof Unknown) throw new Error(`${what}：数值依赖一个还没回答的问题（${v.questions.map((q) => q.text).join('；')}）`);
  return v;
}

function dice(tx: Tx, ctx: ExecCtx, e: ExprSrc, what: string): Dice {
  const v = runDice(e, env(tx, ctx));
  if (v instanceof Unknown) throw new Error(`${what}：骰子依赖一个还没回答的问题`);
  return v;
}

/** 数量字段可以写骰子（「重获 1d4 点」「合计 2d8 + 等级点」）：写死的数直接用，有骰子就当场掷 */
function rolledNum(tx: Tx, ctx: ExecCtx, e: ExprSrc, what: string): number {
  const d = dice(tx, ctx, e, what);
  return rollComponent(tx, { dice: d, type: what, from: ctx.actionName }, false, controllerOf(tx, ctx.self), 0).total;
}

/** 伤害类型字段：含「.」的当表达式（`attack.damageType`），否则是字面类型名 */
function typeOf(tx: Tx, ctx: ExecCtx, t: string | undefined): string {
  if (ctx.cast?.damageType) return ctx.cast.damageType;
  if (!t) return ctx.attack?.damageType ?? '';
  if (/^[a-z]+\./.test(t)) return normType(String(run(t, env(tx, ctx)) ?? ''));
  return normType(t);
}

/** 三值条件：不知道就问（一个 ask 决定），回答后重算 */
export function resolveBool(tx: Tx, e: ExprSrc, scope: ScopeData, askTo: Id, label: string): boolean {
  for (let i = 0; i < 4; i++) {
    const v = runBool(e, makeEnv(tx, scope));
    if (typeof v === 'boolean') return v;
    const qs = v.questions;
    const ans = tx.decide({
      kind: 'ask', to: controllerOf(tx, askTo), prompt: `${label}：需要确认`, options: [],
      questions: qs.map((q) => ({ id: q.id, text: q.text, guess: q.guess, scope: q.scope })),
      default: Object.fromEntries(qs.map((q) => [q.id, q.guess ?? false])),
    }) as Record<string, boolean>;
    for (const q of qs) tx.qAnswers.set(q.id, { value: !!ans[q.id], scope: q.scope });
  }
  throw new Error(`${label}：问了 4 轮仍不确定`);
}

/* ============================================================================
 * 节点执行
 * ========================================================================== */

export function runNodes(tx: Tx, nodes: Node[] | undefined, ctx: ExecCtx): void {
  if (!nodes?.length) return;
  const dmg = nodes.filter((n): n is Extract<Node, { kind: 'damage' }> => n.kind === 'damage');
  // 写在第一个伤害节点前面的 choose / number / modify 先做：伤害要用选出来的类型、减伤要先于反击
  const first = nodes.findIndex((n) => n.kind === 'damage');
  const early = new Set<Node>(first < 0 ? [] : nodes.slice(0, first).filter((n) => n.kind === 'choose' || n.kind === 'number' || n.kind === 'modify'));
  for (const n of early) runNode(tx, n, ctx);
  if (dmg.length) runDamageNodes(tx, dmg, ctx);
  for (const n of nodes) if (n.kind !== 'damage' && !early.has(n)) runNode(tx, n, ctx);
}

/** 需要目标却没有「当前目标」时，对每个目标各执行一次 */
function perTarget(tx: Tx, ctx: ExecCtx, fn: (c: ExecCtx) => void): void {
  if (ctx.target) { fn(ctx); return; }
  if (!ctx.targets.length) throw new Error(`「${ctx.actionName}」需要目标，但没有选择目标`);
  for (const t of ctx.targets) if (tx.state.combatants[t]) fn({ ...ctx, target: t });
}

function recipients(tx: Tx, ctx: ExecCtx, to: 'target' | 'self' | 'attacker' | 'each' | undefined): Id[] {
  if (to === 'self') return [ctx.self];
  if (to === 'attacker') {
    if (!ctx.attacker || !tx.state.combatants[ctx.attacker]) throw new Error(`「${ctx.actionName}」要对攻击者 / 伤害来源生效，但这里没有`);
    return [ctx.attacker];
  }
  if (to === 'each') return ctx.targets.slice();
  if (to === 'target' || to === undefined) {
    if (ctx.target) return [ctx.target];
    if (ctx.targets.length) return ctx.targets.slice();
    if (to === undefined) return [ctx.self];
    throw new Error(`「${ctx.actionName}」需要目标，但没有选择目标`);
  }
  return [];
}

function runNode(tx: Tx, n: Node, ctx: ExecCtx): void {
  switch (n.kind) {
    case 'attack': return perTarget(tx, ctx, (c) => runAttack(tx, n, c));
    case 'save': {
      if (n.to && n.to !== 'target') {
        for (const id of recipients(tx, ctx, n.to)) runSave(tx, n, { ...ctx, target: id });
        return;
      }
      return perTarget(tx, ctx, (c) => runSave(tx, n, c));
    }
    case 'check': {
      const v = effectiveView(tx, ctx.self);
      const bonus = n.skill ? skillBonus(v, n.skill, n.ability) : v.mod[n.ability];
      const dc = num(tx, ctx, n.dc, '检定 DC');
      const r = d20Test(tx, {
        roller: ctx.self, kind: 'check', ability: n.ability, skill: n.skill, bonus, vs: dc, against: conditionsInNodes(tx, n.onFail, ctx.entryKey),
        label: `${ABIL_CN[n.ability]}${n.skill ? `（${n.skill}）` : ''}检定`, cause: ctx.cause,
      });
      runNodes(tx, r.outcome === 'success' ? n.onSuccess : n.onFail, { ...ctx, roll: rollValue(r), cause: r.seq, dc });
      return;
    }
    case 'damage': return runDamageNodes(tx, [n], ctx);
    case 'mark': {
      const v = n.value === undefined ? true : run(n.value, env(tx, ctx));
      if (v instanceof Unknown) throw new Error('mark：值依赖一个还没回答的问题');
      markAction(tx, n.name, v);
      return;
    }
    case 'runBranch': return runBranch(tx, n, ctx);
    case 'refund': return refund(tx, n, ctx);
    case 'chooseTargets': {
      const picks = pickTargets(tx, ctx, n, n.prompt);
      if (n.var) (ctx.vars ??= {})[n.var] = picks.length;
      if (n.addTo === 'cast') {
        const plan = ctx.interrupting ?? tx.windowPlan;
        if (!plan) {
          tx.emit('note', { text: `${ctx.actionName}：这里没有正在施展的法术，挑的目标加不进去`, owner: ctx.self }, ctx.cause);
        } else {
          for (const id of picks) if (!plan.targets.includes(id)) plan.targets.push(id);
          if (picks.length) plan.notes.push(`${ctx.actionName}：目标加上 ${picks.map((id) => nameOf(tx, id)).join('、')}`);
        }
      }
      for (const id of picks) runNodes(tx, n.do, { ...ctx, target: id });
      return;
    }
    case 'allocate': return allocate(tx, n, ctx);
    case 'retype': {
      const t = /^[a-z]+\./.test(n.value) ? normType(String(run(n.value, env(tx, ctx)) ?? '')) : normType(n.value);
      if (!t) return;
      if (ctx.packet && ctx.packet.components.length) {
        const base = normType(ctx.packet.components[0].type);
        for (const c of ctx.packet.components) if (normType(c.type) === base) c.type = t;
        tx.emit('note', { text: `${ctx.actionName}：这次伤害改为${t}`, owner: ctx.self, target: ctx.packet.target }, ctx.cause);
        return;
      }
      const plan = ctx.interrupting ?? tx.windowPlan ?? ctx.cast;
      if (plan) { plan.damageType = t; plan.notes.push(`${ctx.actionName}：伤害类型改为${t}`); return; }
      tx.emit('note', { text: `${ctx.actionName}：这里没有正在结算的伤害可改（改成${t}请手动处理）`, owner: ctx.self }, ctx.cause);
      return;
    }
    case 'trimDamage': {
      const p = ctx.packet;
      const c = p?.components.find((x) => x.from.includes(n.from) && !x.dice.isConstant);
      if (!p || !c) {
        tx.emit('note', { text: `${ctx.actionName}：这次伤害里没有「${n.from}」的骰子可扣`, owner: ctx.self }, ctx.cause);
        return;
      }
      let k = Math.max(0, num(tx, ctx, n.dice, '扣掉几颗骰子'));
      const terms = c.dice.terms.map((t) => ({ ...t }));
      for (const t of terms) { const d = Math.min(t.count, k); t.count -= d; k -= d; }
      const left = terms.filter((t) => t.count > 0);
      c.dice = new Dice(left, c.dice.flat);
      if (!left.length && !c.dice.flat) p.components.splice(p.components.indexOf(c), 1);
      tx.emit('note', { text: `「${c.from}」少掷 ${num(tx, ctx, n.dice, '扣掉几颗骰子')} 颗骰子（剩 ${c.dice.toString() || '0'}）`, owner: ctx.self, target: p.target }, ctx.cause);
      return;
    }
    case 'repeatAction': {
      const inst = currentAction(tx);
      if (!inst?.rerun) throw new Error('repeatAction 只能用在一次动作结算期间（命中、失手、豁免这些窗口里）');
      if ((inst.repeats ?? 0) >= 10) { tx.emit('note', { text: `${ctx.actionName}：连续再执行太多次，停下`, owner: ctx.self }, ctx.cause); return; }
      const picks = pickTargets(tx, ctx, { exclude: ['self', 'target'], ...n }, n.prompt);
      for (const id of picks) {
        inst.repeats = (inst.repeats ?? 0) + 1;
        tx.emit('note', { text: `${ctx.actionName}：「${inst.name}」对 ${nameOf(tx, id)} 再来一次`, owner: ctx.self, target: id }, ctx.cause);
        inst.rerun(id);
      }
      return;
    }
    case 'addDamage': {
      if (!ctx.packet) throw new Error('addDamage 只能用在命中窗口里（偷袭、至圣斩这类）');
      ctx.packet.components.push({ dice: dice(tx, ctx, n.dice, ctx.actionName), type: typeOf(tx, ctx, n.type), from: ctx.actionName });
      if (n.ignoreResist) ctx.packet.ignoreResist = true;
      if (n.ignoreImmunity) ctx.packet.ignoreImmunity = true;
      tx.emit('damageAdded', { owner: ctx.self, label: ctx.actionName, dice: dice(tx, ctx, n.dice, ctx.actionName).toString() }, ctx.cause);
      return;
    }
    case 'heal': {
      for (const id of recipients(tx, ctx, n.to)) {
        const d = dice(tx, ctx, n.amount, '治疗量');
        const max = maxDiceFor(tx, ctx.self, 'heal', { target: id, slot: ctx.slot, spell: ctx.originKind === 'spell' });
        const amount = rollComponent(tx, { dice: d, type: '治疗', from: ctx.actionName }, false, controllerOf(tx, ctx.self), 0, max).total;
        applyHeal(tx, id, amount, ctx.actionName, ctx.cause);
      }
      return;
    }
    case 'tempHp': {
      for (const id of recipients(tx, ctx, n.to)) {
        const d = dice(tx, ctx, n.amount, '临时生命值');
        const amount = rollComponent(tx, { dice: d, type: '临时生命值', from: ctx.actionName }, false, controllerOf(tx, ctx.self), 0).total;
        grantTempHp(tx, id, amount, ctx.actionName, ctx.cause);
      }
      return;
    }
    case 'applyEffect': {
      // ⚠️ 承受者单独传：给自己施加的效应（侵扰、猎人印记）在 state 里要记的是「当前目标」，不能被承受者覆盖
      for (const id of recipients(tx, ctx, n.to)) applyEffectNode(tx, n, ctx, id);
      return;
    }
    case 'removeEffect': {
      for (const id of recipients(tx, ctx, n.from ?? 'target')) {
        for (const e of effectsOf(tx, id)) {
          const m = n.match;
          const hit =
            (m.key && (e.key === m.key || e.key.split('#')[0] === m.key)) ||
            (m.name && (e.name === m.name || e.key.split('#')[1] === m.name)) ||
            (m.tag && e.tags.includes(m.tag));
          if (hit) endEffect(tx, e.id, `被「${ctx.actionName}」移除`, ctx.cause);
        }
      }
      return;
    }
    case 'endConcentration': {
      // 「目标挣脱 → 法术结束」：数据里显式写，别指望移除效应自动触发（多目标法术里一个目标摆脱不代表整个法术结束）
      endConcentration(tx, ctx.self, `「${ctx.actionName}」结束`, ctx.cause);
      return;
    }
    case 'grantAction': {
      grantActionNode(tx, n, ctx);
      return;
    }
    case 'removeGrant': {
      tx.emit('entryRevoked', { id: ctx.self, key: n.key }, ctx.cause);
      return;
    }
    case 'modifyCast': {
      // 改「正在施展的那道法术」的计划书：取消 / 改 DC / 改攻击加值 / 改伤害类型
      const plan = ctx.interrupting ?? tx.windowPlan;
      if (!plan) {
        tx.emit('note', { text: `${ctx.actionName}：这里没有正在施展的法术可改`, owner: ctx.self }, ctx.cause);
        return;
      }
      if (n.cancel) plan.canceled = { by: ctx.actionName, refundSlot: n.refundSlot !== false };
      if (n.dc !== undefined) plan.dc = num(tx, ctx, n.dc, '改写后的豁免 DC');
      if (n.attackBonus !== undefined) plan.attackBonus = num(tx, ctx, n.attackBonus, '改写后的攻击加值');
      if (n.damageType) plan.damageType = normType(n.damageType);
      if (n.slotDelta !== undefined) plan.slotDelta += num(tx, ctx, n.slotDelta, '有效环阶加值');
      if (n.note) plan.notes.push(String(n.note));
      return;
    }
    case 'castFrom': {
      // 直接借那道动作结算一次：代价默认清空（反应已经付过）、不打动作经济、落地后不留痕迹
      const ref = n.fromVar ? String(ctx.vars?.[n.fromVar] ?? '') : n.from;
      if (!ref) {
        tx.emit('note', { text: `${ctx.actionName}：没有挑到要施展的法术`, owner: ctx.self }, ctx.cause);
        return;
      }
      let found: { key: string; action: Action };
      try {
        found = findAction(tx, ctx.self, ref);
      } catch (e) {
        tx.emit('note', { text: `${ctx.actionName}：没法施展（${(e as Error).message}）`, owner: ctx.self }, ctx.cause);
        return;
      }
      const cast: Action = {
        ...structuredClone(found.action),
        // 代价默认沿用那道动作自己的（战地施法者仍然要花法术位）；要免位就在数据里写 `cost: []`
        ...(n.cost ? { cost: structuredClone(n.cost) } : {}),
        activation: n.activation ?? 'free',
      };
      absolutizeTemplates(tx, cast, found.key);
      // 免位施展：按来源法术的基础环阶把 `slot.level` 定下来（和 grantAction 一样）
      if (!cast.cost?.some((k) => 'slot' in k)) {
        const base = slotBaseOf(tx.rules.entry(found.key)?.actions, found.action.id);
        if (base !== undefined) substituteSlotLevel(cast, base);
      }
      const to = n.to ?? (ctx.attacker ? 'attacker' : 'target');
      const targets = to === 'self' ? [ctx.self]
        : to === 'attacker' ? (ctx.attacker ? [ctx.attacker] : [])
        : to === 'each' ? ctx.targets.slice()
        : ctx.target ? [ctx.target] : ctx.targets.slice();
      // with：这一次自带的修正，结算前挂上、结算完摘掉（真效应，走事件）
      const tmp = n.with ? applyEffect(tx, {
        bearer: ctx.self, source: ctx.self, inline: n.with, key: `${ctx.entryKey}#with`, name: n.with.name ?? ctx.actionName,
        baseKey: ctx.entryKey, duration: { manual: true }, origin: { kind: ctx.originKind ?? 'feature', ref: ctx.entryKey }, cause: ctx.cause,
      }) : null;
      // 反应本身已经在触发器那边付过了：这里不要再按 reaction 结算一次
      try {
        executeAction(tx, {
          actor: ctx.self, actionKey: `${found.key}#${cast.id}`, action: cast, targets,
          cause: ctx.cause, force: true,
        });
      } finally {
        if (tmp && tx.state.effects[tmp.id]) endEffect(tx, tmp.id, `「${ctx.actionName}」结束`, ctx.cause);
      }
      return;
    }
    case 'extendEffect': {
      const r = tx.rules.resolveTemplate(n.template, ctx.entryKey);
      const e = effectsOf(tx, ctx.self).find((x) => x.key === (r?.key ?? n.template) || x.name === n.template);
      if (!e) return;
      if (e.timing.untilCount !== 0) {
        tx.emit('effectUpdated', { id: e.id, patch: { timing: { ...e.timing, untilCount: 0 } } }, ctx.cause);
      }
      tx.emit('effectExtended', { id: e.id, name: e.name, bearer: e.bearer, by: ctx.actionName }, ctx.cause);
      return;
    }
    case 'resource': {
      const id = ctx.self;
      const c = tx.state.combatants[id];
      const max = effectiveView(tx, id).resources[n.id] ?? 0;
      const used = c.live.resourcesUsed[n.id] ?? 0;
      const delta = rolledNum(tx, ctx, n.delta, '资源变化');
      tx.emit('resourceUsed', { id, resource: n.id, used: Math.max(0, Math.min(max, used - delta)) }, ctx.cause);
      return;
    }
    case 'economy': {
      const e = tx.state.combatants[ctx.self].economy;
      const patch: Record<string, number> = {};
      if (n.action) patch.action = e.action + n.action;
      if (n.bonus) patch.bonus = e.bonus + n.bonus;
      if (n.reaction) patch.reaction = e.reaction + n.reaction;
      if (n.attacks) patch.attacksLeft = e.attacksLeft + n.attacks;
      if (n.move !== undefined) patch.move = e.move + num(tx, ctx, n.move, '移动');
      tx.emit('economyChanged', { id: ctx.self, patch }, ctx.cause);
      return;
    }
    case 'choose': {
      // `pool`：选项由引擎按池子现算（战地施法者那种「从我的法术里挑一道」）—— 选项的 value 就是法术键
      const fromPool = n.pool ? poolOptions(tx, ctx, n.pool) : null;
      const options: Array<{ label: string; do?: Node[]; when?: ExprSrc; value?: string }> = fromPool ?? n.options ?? [];
      // 带 when 的选项：条件明确不满足就不列出来（圣疗「移除中毒」要求目标中毒、能量池至少 5 点）
      const open = options.map((o, i) => ({ o, i })).filter(({ o }) => {
        if (o.when === undefined) return true;
        const v = runBool(o.when, env(tx, ctx));
        return v !== false;
      });
      if (!open.length) {
        tx.emit('note', { text: `${ctx.actionName}：${n.prompt}——眼下没有可选的项`, owner: ctx.self }, ctx.cause);
        return;
      }
      // count 可以是表达式（进阶诡诈打击：11 级起选两种）
      const count = n.count === undefined ? 1 : Math.max(1, num(tx, ctx, n.count, `${n.prompt} 选几项`));
      // 变量已经定好（发起时就挑了：界面上点了哪件武器做借机攻击），而且是个可选项：不再问
      const preset = n.var !== undefined && ctx.vars?.[n.var] !== undefined
        ? open.find(({ o }) => (o.value ?? o.label) === String(ctx.vars![n.var!])) : undefined;
      const picked = preset ? [String(preset.i)] : open.length === 1 && count === 1 ? [String(open[0].i)] : tx.decide({
        kind: 'choose', to: controllerOf(tx, ctx.self), prompt: count > 1 ? `${n.prompt}（最多 ${count} 项）` : n.prompt, multi: count > 1,
        options: open.map(({ o, i }) => ({ id: String(i), label: o.label })),
        default: [String(open[0].i)],
      });
      const list = (Array.isArray(picked) ? picked : [picked]).map(String).slice(0, count);
      for (const i of list) {
        const o = options[Number(i)] ?? options.find((x) => x.label === i || x.value === i);
        if (!o) continue;
        if (n.var) (ctx.vars ??= {})[n.var] = o.value ?? o.label;
        runNodes(tx, o.do, ctx);
      }
      return;
    }
    case 'number': {
      const min = n.min !== undefined ? num(tx, ctx, n.min, `${n.prompt} 的下限`) : 0;
      const max = num(tx, ctx, n.max, `${n.prompt} 的上限`);
      const vars = (ctx.vars ??= {});
      if (max < min) {
        vars[n.var] = 0;
        tx.emit('note', { text: `${ctx.actionName}：${n.prompt}——可选范围是空的（最多 ${max}）`, owner: ctx.self }, ctx.cause);
        return;
      }
      const def = n.default !== undefined ? num(tx, ctx, n.default, `${n.prompt} 的默认值`) : max;
      const v = Number(tx.decide({
        kind: 'number', to: controllerOf(tx, ctx.self), prompt: `${ctx.actionName}：${n.prompt}`, options: [], min, max,
        default: Math.max(min, Math.min(max, def)),
      }));
      vars[n.var] = Number.isFinite(v) ? Math.max(min, Math.min(max, Math.floor(v))) : min;
      return;
    }
    case 'if': {
      const ok = resolveBool(tx, n.when, scopeOf(tx, ctx), ctx.self, ctx.actionName);
      runNodes(tx, ok ? n.then : n.else, ctx);
      return;
    }
    case 'forEach': {
      for (const t of ctx.targets) if (tx.state.combatants[t]) runNodes(tx, n.do, { ...ctx, target: t });
      return;
    }
    case 'repeat': {
      const k = num(tx, ctx, n.n, '重复次数');
      for (let i = 0; i < k; i++) runNodes(tx, n.do, ctx);
      return;
    }
    case 'move': {
      const ft = num(tx, ctx, n.ft, '距离');
      // 推离 / 拉近：有地图就真的动棋子；传送提示人手动拖（界面看到这条会自动进入「选落点」模式）
      const done = n.mode !== 'teleport' && !!ctx.target && shove(tx, ctx.self, ctx.target, ft, n.mode, ctx.cause);
      if (!done) {
        const who = n.mode === 'teleport' ? (ctx.target ?? ctx.self) : ctx.target;
        tx.emit('note', {
          kind: n.mode === 'teleport' ? 'teleport' : 'move',
          text: `${ctx.actionName}：${n.mode === 'push' ? '推离' : n.mode === 'pull' ? '拉近' : '传送'} ${ft} 尺（请在地图上移动）`,
          target: ctx.target, id: who, maxFt: ft, owner: ctx.self,
        }, ctx.cause);
      }
      return;
    }
    case 'zone': {
      if (!ctx.area?.cells.length) {
        tx.emit('note', { text: `${ctx.actionName}：没有在地图上选范围，区域没有放上去（效果请手动处理）`, owner: ctx.self }, ctx.cause);
        return;
      }
      const round = tx.state.round;
      const zone: Zone = {
        id: tx.nextId('z'), name: n.name ?? ctx.actionName, cells: ctx.area.cells.slice(), ...(ctx.area.tpl ? { tpl: ctx.area.tpl } : {}),
        source: ctx.self, entryKey: ctx.entryKey, on: n.on ?? [], do: n.do ?? [], affects: n.affects ?? 'all',
        ...(n.while?.length ? { while: n.while } : {}), ...(n.difficult ? { difficult: true } : {}), ...(n.fully ? { fully: true } : {}), ...(ctx.vars && Object.keys(ctx.vars).length ? { vars: { ...ctx.vars } } : {}),
        oncePerTurn: n.oncePerTurn ?? true, confirm: false, link: ctx.concentrationId ?? null,
        ...(Object.keys(currentAction(tx)?.marks ?? {}).length ? { marks: { ...currentAction(tx)!.marks } } : {}),
        untilRound: n.rounds && round !== null ? round + n.rounds : null, hits: {}, ...(ctx.slot !== undefined ? { slot: ctx.slot } : {}),
      };
      placeZone(tx, zone, ctx.cause);
      return;
    }
    case 'moveZone': {
      const key = n.key ?? ctx.entryKey;
      const mine = Object.values(tx.state.zones ?? {}).filter((z) => z.source === ctx.self && z.entryKey === key);
      if (!mine.length) {
        tx.emit('note', { text: `${ctx.actionName}：地图上没有可以挪的区域`, owner: ctx.self }, ctx.cause);
        return;
      }
      if (!ctx.area?.cells.length) {
        tx.emit('note', { text: `${ctx.actionName}：没有在地图上选新位置，区域没动`, owner: ctx.self }, ctx.cause);
        return;
      }
      // 同一道法术放了好几块（不常见）：挪最近放下的那块
      relocateZone(tx, mine[mine.length - 1], ctx.area.cells, ctx.area.tpl, ctx.cause);
      return;
    }
    case 'note':
      tx.emit('note', { text: n.text, owner: ctx.self, target: ctx.target }, ctx.cause);
      return;
    case 'modify': {
      if (!ctx.modify) throw new Error(`「${ctx.actionName}」：modify 只能用在 before 窗口触发的反应 / 触发器里`);
      for (const m of n.modify) {
        // 值在这里求（能用 slot.level、vars），带骰子的由自己的控制者当场掷；交给窗口的是一个定数
        if ('value' in m && m.value !== undefined) {
          const d = dice(tx, ctx, m.value, ctx.actionName);
          const total = d.isConstant ? d.flat : rollComponent(tx, { dice: d, type: '', from: ctx.actionName }, false, controllerOf(tx, ctx.self), 0).total;
          ctx.modify({ ...m, value: String(total) } as Modify);
        } else ctx.modify(m);
      }
      return;
    }
    case 'summon': {
      runSummon(tx, n, ctx);
      return;
    }
  }
}

const SUMMON_SIZE_CN: Record<string, string> = {
  T: '微型', S: '小型', M: '中型', L: '大型', H: '巨型', G: '超巨型',
};
const SUMMON_TYPE_CN: Record<string, string> = {
  beast: '野兽', fey: '妖精', undead: '不死生物', elemental: '元素生物',
  aberration: '异怪', construct: '构装体', dragon: '龙类', celestial: '天界生物', fiend: '邪魔',
};

/**
 * 临时授予一个动作：从别的条目复制（`from`）或直接写（`action`），可选改写代价 / 激活方式，
 * 挂到 `key` 下。授予的条目在 `entryOf` 里**优先于规则书**，所以同 key = 覆盖。
 * 典型用法：免法术位施放（复制法术动作 + `cost: []`）、篡改后的法术副本、临时武器。
 */
function grantActionNode(tx: Tx, n: Extract<Node, { kind: 'grantAction' }>, ctx: ExecCtx): void {
  let action: Action | undefined;
  let srcName: string | undefined;
  let srcKey: string | undefined;
  let srcActionId: string | undefined;
  // fromVar：要复制的条目键来自前面 choose/number 存进 vars 的值（战地施法者那种「从我的法术里挑一道」）
  const fromRef = n.fromVar ? String(ctx.vars?.[n.fromVar] ?? '') : n.from;
  try {
    if (n.action) {
      action = structuredClone(n.action);
    } else if (fromRef) {
      const found = findAction(tx, ctx.self, fromRef);
      action = structuredClone(found.action);
      srcName = found.action.name;
      srcKey = found.key;
      srcActionId = found.action.id;
    }
  } catch (e) {
    tx.emit('note', { text: `${ctx.actionName}：授予动作失败（${(e as Error).message}）`, owner: ctx.self }, ctx.cause);
    return;
  }
  if (!action) {
    tx.emit('note', { text: `${ctx.actionName}：没有可授予的动作（from / action 至少写一个）`, owner: ctx.self }, ctx.cause);
    return;
  }
  // 复制来的动作里，效应模板是**相对来源条目**写的（`template: '法师护甲'`）—— 换成绝对键，
  // 否则结算时按授予条目的键去找，找不到模板
  if (srcKey) absolutizeTemplates(tx, action, srcKey);
  if (n.cost) action.cost = structuredClone(n.cost);
  // 免位施放：原动作按法术位算的地方（`slot.level`）按**基础环阶**定下来，
  // 否则结算时没有 slot 上下文会报「当前上下文没有 slot（不是施法）」
  if (n.cost && !n.cost.some((k) => 'slot' in k)) {
    const base = srcKey ? slotBaseOf(tx.rules.entry(srcKey)?.actions, srcActionId) : undefined;
    if (base !== undefined) substituteSlotLevel(action, base);
  }
  if (n.activation) action.activation = n.activation;
  // 改写射程 / 目标类型：「只对自己施放」这类免位施法要靠它，不然复制来的法术能放别人身上
  if (n.targeting) action.targeting = structuredClone(n.targeting);
  const key = n.key ?? `grant:${fromRef ?? action.id}`;
  const entry: Entry = {
    name: n.name ?? srcName ?? action.name,
    actions: [action],
    ...(n.text ? { text: n.text } : {}),
  };
  tx.emit('entryGranted', { id: ctx.self, key, entry, untilTurn: n.until === 'turnEnd' ? tx.turnKey() : null }, ctx.cause);
}

/**
 * `choose.pool` 的选项现算：从参与者**自己身上带施法动作的法术**里挑。
 * 战地施法者「用一道法术代替借机攻击」、各种「从你的已知法术里选一道」都用它；
 * 选项的 value 是法术键（`XPHB:spell:火球术`），配合 `grantAction.fromVar` 施展。
 */
type Pool = NonNullable<Extract<Node, { kind: 'choose' }>['pool']>;

/**
 * 选择池：引擎现算的选项，value 是能交给 castFrom 跑的东西（法术键 / `weapon:<id>`）。
 * 「从哪挑」只有这一处：自己会的法术、规则书里的全部法术、自己的武器攻击。
 */
function poolOptions(tx: Tx, ctx: ExecCtx, pool: Pool): Array<{ label: string; value: string }> {
  if (pool.from === 'attacks') {
    return effectiveView(tx, ctx.self).attacks
      .filter((a) => (pool.melee === undefined || a.melee === pool.melee) && (pool.ranged === undefined || a.ranged === pool.ranged))
      .map((a) => ({ label: a.name, value: `weapon:${a.id}` }));
  }
  const keys = pool.from === 'spells' ? [...tx.rules.keys()] : effectiveView(tx, ctx.self).sources ?? [];
  return spellPoolOptions(tx, ctx, pool, keys);
}

function spellPoolOptions(tx: Tx, ctx: ExecCtx, pool: Pool, keys: Iterable<string>): Array<{ label: string; value: string }> {
  const max = pool.maxLevel !== undefined ? num(tx, ctx, pool.maxLevel, '法术最高环阶') : Infinity;
  const min = pool.minLevel !== undefined ? num(tx, ctx, pool.minLevel, '法术最低环阶') : 0;
  const out: Array<{ label: string; value: string }> = [];
  const seen = new Set<string>();
  for (const key of keys) {
    if (seen.has(key)) continue;
    seen.add(key);
    if (!key.includes(':spell:')) continue;
    const entry = tx.rules.entry(key) ?? effectiveView(tx, ctx.self).entries?.[key];
    if (!entry?.actions?.length || entry.automation === 'manual') continue;
    const act = entry.actions[0];
    const level = slotBaseOf(entry.actions, undefined) ?? 0;
    if (pool.from === 'ownCantrips' ? level !== 0 : level < min || level > max) continue;
    // 「施法时间是动作」「只打一个生物」：战地施法者这类原文限制，能在池子这层筛掉就先筛掉
    if (pool.castTime && act.activation !== pool.castTime) continue;
    if (pool.singleTarget && !(act.targeting?.type === 'creature' && Number(act.targeting.count ?? 1) === 1)) continue;
    if (pool.school || pool.list) {
      const meta = spellMetaOf(key, entry, act);
      if (pool.school && meta.school !== pool.school) continue;
      if (pool.list && !meta.lists.includes(pool.list)) continue;
    }
    out.push({ label: entry.name ?? key.split(':spell:')[1] ?? key, value: key });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label, 'zh'));
}

/** 来源动作的法术位基础环阶（`cost: [{slot:{min}}]` 的 min） */
function slotBaseOf(actions: Action[] | undefined, id: string | undefined): number | undefined {
  const a = (actions ?? []).find((x) => x.id === id) ?? (actions ?? [])[0];
  const slotCost = (a?.cost ?? []).find((k): k is Extract<Cost, { slot: unknown }> => 'slot' in k);
  return slotCost ? slotCost.slot.min : undefined;
}

/** 把动作里所有 `slot.level` 换成固定环阶（免位施放时按基础环阶算） */
function substituteSlotLevel(action: Action, level: number): void {
  const walk = (x: unknown): void => {
    if (Array.isArray(x)) { for (const y of x) walk(y); return; }
    if (!x || typeof x !== 'object') return;
    const o = x as Record<string, unknown>;
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === 'string' && v.includes('slot.level')) o[k] = v.replace(/slot\.level/g, String(level));
      else walk(v);
    }
  };
  walk(action);
}

/**
 * 把复制来的动作里的「相对模板名」换成绝对键：`applyEffect.template: '法师护甲'` → `XPHB:spell:法师护甲#法师护甲`。
 * 只在来源条目里确实有这个模板时才换（原本就是绝对键的、或者模板在别处的，不动）。
 */function absolutizeTemplates(tx: Tx, action: Action, base: string): void {
  const own = tx.rules.entry(base)?.effects ?? {};
  const walk = (x: unknown): void => {
    if (Array.isArray(x)) { for (const y of x) walk(y); return; }
    if (!x || typeof x !== 'object') return;
    const o = x as Record<string, unknown>;
    const tpl = o.template;
    if (typeof tpl === 'string' && !tpl.includes('#') && own[tpl]) o.template = `${base}#${tpl}`;
    for (const v of Object.values(o)) walk(v);
  };
  walk(action);
}

/** 回合结束时收回「只活到本回合」的临时动作 */
export function expireGrants(tx: Tx, cause: number | null): void {
  const now = tx.turnKey();
  for (const [id, map] of Object.entries(tx.state.grants ?? {})) {
    for (const [key, g] of Object.entries(map)) {
      if (g.untilTurn === now) tx.emit('entryRevoked', { id, key }, cause);
    }
  }
}

function runSummon(tx: Tx, n: Extract<Node, { kind: 'summon' }>, ctx: ExecCtx): void {
  const summoner = tx.state.combatants[ctx.self];
  if (!summoner) return;
  const sv = effectiveView(tx, ctx.self);
  const count = n.count !== undefined ? Math.max(1, num(tx, ctx, n.count, '召唤数量')) : 1;
  const linkEffect = n.link !== false ? (ctx.concentrationId ?? ctx.effectId) : undefined;
  // 独立存续的召唤物按「组」顶替：缺省同一动作一组（同一道法术再施展一次 = 换一只），
  // 不同来源（坐骑 + 魔宠）互不影响；同一效果拆成多个条目时在数据里写相同的 group。
  const group = n.group ?? `${ctx.entryKey}#${ctx.actionName}`;
  if (!linkEffect) {
    for (const c of Object.values(tx.state.combatants)) {
      if (c.summoner === ctx.self && !c.linkEffect && c.summonGroup === group) tx.emit('combatantRemoved', { id: c.id }, ctx.cause);
    }
  }
  const rawType = n.type ?? n.creatureType;
  const typeCn = rawType ? (SUMMON_TYPE_CN[rawType] ?? rawType) : undefined;

  for (let i = 0; i < count; i++) {
    const id = tx.nextId('s');
    const baseName = ctx.form?.name ?? n.name;
    const name = count > 1 ? `${baseName} ${i + 1}` : baseName;
    let view: CombatantView;
    if (ctx.form) {
      view = {
        ...structuredClone(ctx.form),
        name,
        ...(typeCn ? { type: typeCn } : {}),
      };
    } else {
      const score = {
        str: n.score?.str !== undefined ? num(tx, ctx, n.score.str, '力量') : 10,
        dex: n.score?.dex !== undefined ? num(tx, ctx, n.score.dex, '敏捷') : 10,
        con: n.score?.con !== undefined ? num(tx, ctx, n.score.con, '体质') : 10,
        int: n.score?.int !== undefined ? num(tx, ctx, n.score.int, '智力') : 10,
        wis: n.score?.wis !== undefined ? num(tx, ctx, n.score.wis, '感知') : 10,
        cha: n.score?.cha !== undefined ? num(tx, ctx, n.score.cha, '魅力') : 10,
      };
      const fallbackAtk = sv.spell?.atk ?? (sv.pb + sv.mod.wis);
      const attacks: AttackRow[] = (n.attacks ?? []).map((a, idx) => ({
        id: a.id ?? `atk-${idx + 1}`,
        name: a.name,
        melee: a.melee ?? !a.ranged,
        ranged: a.ranged ?? false,
        finesse: false,
        ability: 'str',
        bonus: a.bonus !== undefined ? num(tx, ctx, a.bonus, `${a.name} 命中加值`) : fallbackAtk,
        damage: dice(tx, ctx, a.damage, `${a.name} 伤害`).toString(),
        damageType: normType(a.damageType),
        extra: a.extra?.map((x) => ({ dice: dice(tx, ctx, x.dice, `${a.name} 额外伤害`).toString(), type: normType(x.type) })),
        reach: a.reach,
        range: a.range,
        long: a.long,
      }));
      const entryKey = `summon:${id}`;
      const hasEntry = !!(n.actions?.length || n.triggers?.length || n.rollMods?.length);
      const entries: Record<string, Entry> | undefined = hasEntry
        ? {
            [entryKey]: {
              name,
              ...(n.actions?.length ? { actions: n.actions.map((a) => structuredClone(a)) } : {}),
              ...(n.triggers?.length ? { triggers: n.triggers.map((t) => structuredClone(t)) } : {}),
              ...(n.rollMods?.length ? { rollMods: n.rollMods.map((m) => structuredClone(m)) } : {}),
            },
          }
        : undefined;
      const notes = (n.notes ?? []).map((x) =>
        typeof x === 'string'
          ? { group: '特性', name: x.includes('：') ? x.split('：')[0] : '特性', text: x }
          : structuredClone(x),
      );
      const rawSize = n.size ?? 'M';
      view = makeView({
        name,
        size: SUMMON_SIZE_CN[rawSize] ?? rawSize,
        type: typeCn ?? '野兽',
        ac: n.ac !== undefined ? Math.max(1, num(tx, ctx, n.ac, '召唤物 AC')) : 12,
        hpMax: n.hp !== undefined ? Math.max(1, num(tx, ctx, n.hp, '召唤物生命值')) : 10,
        speed: n.speed !== undefined ? Math.max(0, num(tx, ctx, n.speed, '召唤物速度')) : 30,
        pb: n.pb !== undefined ? num(tx, ctx, n.pb, '召唤物熟练加值') : sv.pb,
        initiative: summoner.initiative ?? sv.initiative,
        score,
        spell: sv.spell ? { ...sv.spell } : null,
        attacks,
        attacksPerAction: n.attacksPerAction !== undefined ? Math.max(1, num(tx, ctx, n.attacksPerAction, '多重攻击次数')) : 1,
        resist: (n.resist ?? []).map(normType),
        immune: (n.immune ?? []).map(normType),
        conditionImmune: [...(n.conditionImmune ?? [])],
        sources: hasEntry ? [entryKey] : [],
        ...(entries ? { entries } : {}),
        ...(notes.length ? { notes } : {}),
      });
    }
    const cb = makeCombatant({
      id,
      kind: 'monster',
      side: summoner.side,
      controller: summoner.controller,
      view,
      initiative: summoner.initiative,
      summoner: ctx.self,
      linkEffect,
      ...(linkEffect ? {} : { summonGroup: group }),
    });
    const seq = tx.emit('combatantAdded', { combatant: cb }, ctx.cause);
    placeSummon(tx, ctx.self, id, view.size, seq);
  }
}

function applyEffectNode(tx: Tx, n: Extract<Node, { kind: 'applyEffect' }>, ctx: ExecCtx, bearer: Id): void {
  const linkTo = n.link !== false ? ctx.concentrationId : undefined;
  const duration = n.duration ?? (linkTo ? ctx.concentrationDuration : undefined);
  const state: Record<string, unknown> = {};
  for (const [k, e] of Object.entries(n.state ?? {})) {
    const v = run(e, env(tx, ctx));
    // 状态要能存档（JSON / structuredClone）：参与者存 id，骰子存文本
    state[k] = v instanceof Dice ? v.toString() : v && typeof v === 'object' && '__ref' in (v as object) ? (v as { id: string }).id : v;
  }
  const snap: Record<string, unknown> = {};
  if (ctx.dc !== undefined) snap.dc = ctx.dc;
  applyEffect(tx, {
    bearer,
    source: ctx.self,
    ref: n.template,
    inline: n.inline,
    name: n.name,
    baseKey: ctx.entryKey,
    duration,
    link: linkTo ?? null,
    potency: n.potency !== undefined ? num(tx, ctx, n.potency, '效应强度') : 0,
    state,
    snap,
    form: bearer === ctx.self ? ctx.form : undefined,
    origin: { kind: ctx.originKind ?? 'feature', ref: ctx.entryKey },
    cause: ctx.cause,
    zone: ctx.zone && (n.whileInZone || ctx.zoneWhile) ? ctx.zone : undefined,
  });
}

/* ------------------------------ 攻击 ------------------------------ */

const DEFAULT_ATTACK: AttackInfo = {
  melee: true, ranged: false, weapon: false, spell: false, unarmed: false, finesse: false, reach: false,
  ability: null, damageType: '', item: null, mastery: null,
};

function runAttack(tx: Tx, n: Extract<Node, { kind: 'attack' }>, ctx: ExecCtx): void {
  let target = ctx.target!;
  const attack: AttackInfo = { ...DEFAULT_ATTACK, ...(n.attack ?? {}) };
  const bonus = ctx.cast?.attackBonus ?? num(tx, ctx, n.bonus ?? 'self.spell.atk', '攻击加值');
  const acBefore = effectiveView(tx, target).ac;
  const r = d20Test(tx, {
    roller: ctx.self, kind: 'attack', attack, target, bonus, vs: acBefore,
    critRange: n.critRange !== undefined ? num(tx, ctx, n.critRange, '重击范围') : undefined,
    label: `${ctx.actionName} 攻击检定`, cause: ctx.cause,
  });
  const hctx: ExecCtx = { ...ctx, attack, attacker: ctx.self, roll: rollValue(r), cause: r.seq };
  const inst = currentAction(tx);
  if (inst) { inst.attack = attack; resultOf(inst, target); }

  const miss = (why?: string) => {
    const seq = tx.emit('attackMissed', { attacker: ctx.self, target, label: ctx.actionName, total: r.total, vs: r.vs, why }, r.seq);
    const mctx = { ...hctx, target, cause: seq };
    if (inst) resultOf(inst, target).hit = false;
    runNodes(tx, n.onMiss, mctx);
    withPending(inst, { kind: 'attack', target, node: n, ran: 'onMiss', ctx: mctx }, () =>
      fireWindow(tx, { event: 'attackMissed', window: 'after', actor: ctx.self, target, scope: { attack, roll: rollValue(r) }, cause: seq }));
  };
  if (r.outcome !== 'hit') { miss(); return; }

  // 命中：先建伤害包（防守方的减伤会标记在包上），再走三段命中窗口
  const dmgNodes = (n.onHit ?? []).filter((x): x is Extract<Node, { kind: 'damage' }> => x.kind === 'damage');
  const packet: DamagePacket = {
    source: ctx.self, target, components: [], crit: r.crit, label: ctx.actionName, attack, reduce: [],
  };
  for (const d of dmgNodes) packet.components.push({ dice: dice(tx, hctx, d.dice ?? '0', ctx.actionName), type: typeOf(tx, hctx, d.type), from: ctx.actionName });
  const hitSeq = tx.emit('attackHit', { attacker: ctx.self, target, label: ctx.actionName, total: r.total, vs: r.vs, crit: r.crit }, r.seq);
  if (inst) {
    Object.assign(resultOf(inst, target), { hit: true, crit: r.crit });
    // 命中窗口里伤害还没掷：先记下这次要掷的骰子（「多掷一颗武器伤害骰」读 action.damage.die）
    if (packet.components[0]) inst.damage = { dice: packet.components[0].dice.toString(), type: normType(packet.components[0].type), total: 0, parts: [], live: packet.components };
  }

  // a. 防守方（护盾术、镜影术、庇护术、骑乘战斗、云雾符文……）
  let cancelledBy: string | null = null;
  let redirected = false;
  const modify = (m: Modify, by?: { owner: Id; label: string }) => {
    if (m.op === 'halveDamage') packet.halve = true;
    else if (m.op === 'doubleDamage') packet.double = true;
    else if (m.op === 'cancel') cancelledBy = by?.label ?? '攻击被抵消';
    else if (m.op === 'redirect') {
      const who = by?.owner ?? target;
      const label = by?.label ?? '改换目标';
      if (m.to === 'self') {
        if (who !== target && who !== ctx.self && tx.state.combatants[who] && !tx.state.combatants[who].live.dead) {
          target = who;
          packet.target = target;
          redirected = true;
          tx.emit('note', { text: `${label}：攻击目标改为 ${nameOf(tx, target)}`, owner: who, target }, hitSeq);
        }
      } else {
        const others = Object.values(tx.state.combatants).filter((c) => !c.live.dead && c.id !== target && c.id !== ctx.self);
        if (!others.length) {
          cancelledBy = `${label}：没有可改选的目标`;
        } else {
          const opts = [...others.map((c) => ({ id: c.id, label: c.name })), { id: 'cancel', label: '放弃攻击（落空）' }];
          const picked = tx.decide({
            kind: 'choose', to: controllerOf(tx, who), prompt: `${label}：选择新的攻击目标`, multi: false,
            options: opts, default: [opts[0].id],
          });
          const raw = String(Array.isArray(picked) ? picked[0] : picked);
          const cid = opts.some((o) => o.id === raw) ? raw : opts[Number(raw)]?.id;
          if (!cid || cid === 'cancel' || !tx.state.combatants[cid]) {
            cancelledBy = `${label}：放弃攻击`;
          } else {
            target = cid;
            packet.target = target;
            redirected = true;
            tx.emit('note', { text: `${label}：攻击目标改为 ${nameOf(tx, target)}`, owner: who, target }, hitSeq);
          }
        }
      }
    }
  };
  fireWindow(tx, { event: 'attackHit', window: 'before', actor: ctx.self, target, scope: { attack, roll: rollValue(r) }, packet, phase: 'defensive', cause: hitSeq, modify });
  if (cancelledBy) {
    miss(cancelledBy);
    return;
  }

  // b. 重新判定：AC 或目标可能变了（天然 20 / 重击 / autoSucceed 仍然命中）
  const acAfter = effectiveView(tx, target).ac;
  if ((redirected || acAfter !== acBefore) && !r.crit && !r.autoSucceed && r.vs !== null) {
    const vs = redirected ? acAfter : r.vs + (acAfter - acBefore);
    if (r.total < vs) {
      tx.emit('attackRechecked', { attacker: ctx.self, target, total: r.total, vsBefore: r.vs, vs, result: 'miss' }, hitSeq);
      miss(redirected ? `对 ${nameOf(tx, target)} AC ${acAfter} 未命中` : `AC 变为 ${acAfter}`);
      return;
    }
  }
  if (!packet.crit && r.autoCritOnHit.length) {
    packet.crit = true;
    tx.emit('critUpgraded', { attacker: ctx.self, target, by: r.autoCritOnHit }, hitSeq);
  }

  // c. 进攻方（偷袭、至圣斩、猎人印记、致命一击……）
  const offRoll = { ...rollValue(r), target, crit: packet.crit };
  fireWindow(tx, { event: 'attackHit', window: 'before', actor: ctx.self, target, scope: { attack, roll: offRoll }, packet, phase: 'offensive', cause: hitSeq, modify });

  if (inst) Object.assign(resultOf(inst, target), { hit: true, crit: packet.crit });
  const res = applyDamagePacket(tx, packet, hitSeq);
  const after: ExecCtx = { ...hctx, target, roll: offRoll, damage: { type: packet.components[0]?.type ?? '', amount: res.total, crit: packet.crit }, cause: res.seq };
  runNodes(tx, (n.onHit ?? []).filter((x) => x.kind !== 'damage'), after);
  fireWindow(tx, {
    event: 'attackHit', window: 'after', actor: ctx.self, target,
    scope: { attack, roll: offRoll, damage: after.damage }, cause: res.seq,
  });
}

/* ------------------------------ 豁免 ------------------------------ */

function runSave(tx: Tx, n: Extract<Node, { kind: 'save' }>, ctx: ExecCtx): void {
  const target = ctx.target!;
  // 计划书被改过（篡改类 / 反制）就以它为准
  const dc = ctx.cast?.dc ?? num(tx, ctx, n.dc, '豁免 DC');
  const tv = effectiveView(tx, target);
  // 由目标选择属性时，替目标选加值高的那个
  const ability = Array.isArray(n.ability) ? n.ability.reduce((best, a) => (tv.save[a] > tv.save[best] ? a : best)) : n.ability;
  const forced = tx.emit('saveForced', { actor: ctx.self, target, ability, dc, label: ctx.actionName }, ctx.cause);
  fireWindow(tx, { event: 'saveForced', window: 'after', actor: ctx.self, target, scope: {}, cause: forced });
  const r = d20Test(tx, {
    roller: target, kind: 'save', ability, bonus: tv.save[ability], vs: dc, against: conditionsInNodes(tx, n.onFail, ctx.entryKey),
    label: `${ABIL_CN[ability]}豁免（${ctx.actionName}）`, cause: forced,
  });
  const ok = r.outcome === 'success';
  const seq = tx.emit(ok ? 'saveSucceeded' : 'saveFailed', { actor: ctx.self, target, ability, dc, label: ctx.actionName }, r.seq);
  // 成功分支里有减半的伤害 = 「豁免成功只受一半」（反射闪避据此把成功改成不受伤害、失败改成一半）
  const half = (n.onSuccess ?? []).some((x) => x.kind === 'damage' && x.scale === 0.5);
  const sctx: ExecCtx = { ...ctx, target, roll: rollValue(r), cause: seq, dc, save: { ability, success: ok, half } };
  const sinst = currentAction(tx);
  if (sinst) resultOf(sinst, target).saved = ok;
  runNodes(tx, ok ? n.onSuccess : n.onFail, sctx);
  // 结果窗口：强力戏法这类「豁免成功时…」挂这里；runBranch 能改跑另一支
  withPending(currentAction(tx), { kind: 'save', target, node: n, ran: ok ? 'onSuccess' : 'onFail', ctx: sctx }, () =>
    fireWindow(tx, { event: ok ? 'saveSucceeded' : 'saveFailed', window: 'after', actor: ctx.self, target, scope: { roll: rollValue(r) }, cause: seq }));
}

/** 开窗口期间把「停在哪个结果上」挂到动作实例上（窗口关了就撤，免得后面的窗口误用） */
function withPending(inst: ActionInstance | null, p: NonNullable<ActionInstance['pending']>, fn: () => void): void {
  if (!inst) { fn(); return; }
  const outer = inst.pending;
  inst.pending = p;
  try { fn(); } finally { inst.pending = outer; }
}

/**
 * 「挑生物」：按 TargetPick 筛候选，再让控制者挑（只有不多于下限的候选时不问，直接全要）。
 * 距离：有地图就按地图筛；没有地图时不筛，选项后面注明「N 尺内」让人自己把握。
 */
function pickTargets(tx: Tx, ctx: ExecCtx, pick: TargetPick, prompt: string): Id[] {
  const me = tx.state.combatants[ctx.self];
  const max = pick.count !== undefined ? num(tx, ctx, pick.count, `${prompt} 最多几个`) : 1;
  const min = Math.min(max, pick.min !== undefined ? num(tx, ctx, pick.min, `${prompt} 至少几个`) : 0);
  if (max <= 0) return [];
  const ex = new Set(pick.exclude ?? []);
  const base = pick.from === 'targets' ? (currentAction(tx)?.targets ?? ctx.targets) : Object.keys(tx.state.combatants);
  const ft = pick.within ? num(tx, ctx, pick.within.ft, `${prompt} 的距离`) : null;
  const of = pick.within?.of === 'target' ? ctx.target ?? ctx.self : ctx.self;
  let unsure = false;
  const cands: Id[] = [];
  for (const id of [...new Set(base)]) {
    const c = tx.state.combatants[id];
    if (!c || c.live.dead) continue;
    if (ex.has('self') && id === ctx.self) continue;
    if (ex.has('target') && id === ctx.target) continue;
    if (pick.from === 'enemies' && c.side === me?.side) continue;
    if (pick.from === 'allies' && c.side !== me?.side) continue;
    if (ft !== null && id !== of) {
      const d = tx.spatial?.distance(of, id);
      if (typeof d === 'number') { if (d > ft) continue; } else unsure = true;
    }
    if (pick.filter !== undefined && !resolveBool(tx, pick.filter, { ...scopeOf(tx, ctx), target: id }, ctx.self, prompt)) continue;
    cands.push(id);
  }
  if (!cands.length) {
    tx.emit('note', { text: `${ctx.actionName}：${prompt}——没有符合条件的生物`, owner: ctx.self }, ctx.cause);
    return [];
  }
  if (cands.length <= min) return cands;
  const where = ft !== null && unsure ? `（${of === ctx.self ? '你' : nameOf(tx, of)} ${ft} 尺内的才算，没有地图请自己把握）` : '';
  const options = cands.map((id) => ({ id, label: nameOf(tx, id) }));
  if (max === 1 && min === 0) options.push({ id: '__none', label: '不选' });
  const picked = tx.decide({
    kind: 'choose', to: controllerOf(tx, ctx.self), multi: max > 1,
    prompt: `${ctx.actionName}：${prompt}${max > 1 ? `（最多 ${max} 个${min ? `，至少 ${min} 个` : ''}）` : ''}${where}`,
    options, default: cands.slice(0, Math.max(1, min)),
  });
  let list = (Array.isArray(picked) ? picked : [picked]).map(String).filter((id) => cands.includes(id)).slice(0, max);
  if (list.length < min) list = [...list, ...cands.filter((id) => !list.includes(id))].slice(0, min);
  return list;
}

/** 分配点数：按候选逐个问给多少（剩下的点数用完就停），对分到的执行 do */
function allocate(tx: Tx, n: Extract<Node, { kind: 'allocate' }>, ctx: ExecCtx): void {
  let left = rolledNum(tx, ctx, n.total, `${n.prompt} 的总数`);
  const cap = n.maxEach !== undefined ? n.maxEach : undefined;
  const who = pickTargets(tx, ctx, { ...n, count: n.count ?? 99, min: n.min ?? 0 }, n.prompt);
  const share: Array<[Id, number]> = [];
  for (const id of who) {
    if (left <= 0) break;
    const most = Math.min(left, cap !== undefined ? num(tx, { ...ctx, target: id }, cap, `${n.prompt} 每个最多`) : left);
    if (most <= 0) continue;
    const v = Number(tx.decide({
      kind: 'number', to: controllerOf(tx, ctx.self), prompt: `${ctx.actionName}：${n.prompt}——给 ${nameOf(tx, id)} 多少（还剩 ${left}）`,
      options: [], min: 0, max: most, default: most,
    }));
    const got = Number.isFinite(v) ? Math.max(0, Math.min(most, Math.floor(v))) : 0;
    left -= got;
    if (got > 0) share.push([id, got]);
  }
  for (const [id, got] of share) runNodes(tx, n.do, { ...ctx, target: id, vars: { ...(ctx.vars ?? {}), [n.var]: got } });
}

const BRANCH_CN: Record<string, string> = { onHit: '命中', onMiss: '未命中', onFail: '豁免失败', onSuccess: '豁免成功' };

/**
 * runBranch：在攻击 / 豁免的结果窗口里，改跑那个节点的另一支（强力戏法：失手也跑命中那一支的伤害，减半）。
 * 用的是原节点本来的执行上下文（施法者、环阶、共享掷骰都一样）。
 */
function runBranch(tx: Tx, n: Extract<Node, { kind: 'runBranch' }>, ctx: ExecCtx): void {
  const p = currentAction(tx)?.pending;
  if (!p) throw new Error('runBranch 只能用在攻击 / 豁免的结果窗口里（attackMissed、saveSucceeded、saveFailed）');
  const branch = (b: string) => ((p.node as unknown as Record<string, unknown>)[b] as Node[] | undefined) ?? [];
  // 「原本那支没有伤害才用」（强力戏法：豁免成功本来就有一半伤害的法术不管）
  if (n.ifNoDamage && branch(p.ran).some((x) => x.kind === 'damage')) return;
  let nodes = branch(n.branch);
  if (n.damageOnly) nodes = nodes.filter((x) => x.kind === 'damage');
  const k = n.scale;
  if (k !== undefined) nodes = nodes.map((x) => (x.kind === 'damage' ? { ...x, scale: (x.scale ?? 1) * k } : x));
  if (!nodes.length) return;
  const base = p.ctx as ExecCtx;
  // 上一行日志已经写了是哪项能力触发的，这里只说改成了什么
  const how = [n.damageOnly ? '只取伤害' : '', k !== undefined && k !== 1 ? `×${k}` : ''].filter(Boolean).join('、');
  tx.emit('note', { text: `「${inst0(tx)}」改按「${BRANCH_CN[n.branch]}」结算${how ? `（${how}）` : ''}`, owner: ctx.self, target: p.target }, ctx.cause);
  runNodes(tx, nodes, { ...base, target: p.target, save: undefined, cause: ctx.cause ?? base.cause });
}

const inst0 = (tx: Tx) => currentAction(tx)?.name ?? '';

/** refund：退还触发这个窗口的那次动作花掉的法术位 / 资源 */
function refund(tx: Tx, n: Extract<Node, { kind: 'refund' }>, ctx: ExecCtx): void {
  const inst = currentAction(tx);
  if (!inst) throw new Error('refund 只能用在动作结算期间（施法、攻击的窗口里）');
  const c = tx.state.combatants[inst.by];
  if (!c) return;
  if (n.what === 'slot') {
    const lv = inst.paid.slot;
    if (lv === undefined) return;
    inst.paid.slot = undefined;
    tx.emit('slotUsed', { id: inst.by, level: lv, used: Math.max(0, (c.live.slotsUsed[lv] ?? 1) - 1) }, ctx.cause);
    if (inCombat(tx)) tx.emit('economyChanged', { id: inst.by, patch: { slotSpellCast: false } }, ctx.cause);
    tx.emit('note', { text: `${ctx.actionName}：退还「${inst.name}」的 ${lv} 环法术位`, owner: inst.by }, ctx.cause);
    return;
  }
  const i = inst.paid.resources.findIndex((r) => !n.id || r.id === n.id);
  if (i < 0) return;
  const [r] = inst.paid.resources.splice(i, 1);
  tx.emit('resourceUsed', { id: inst.by, resource: r.id, used: Math.max(0, (c.live.resourcesUsed[r.id] ?? r.n) - r.n) }, ctx.cause);
  tx.emit('note', { text: `${ctx.actionName}：退还「${inst.name}」花的 ${r.id} ${r.n} 次`, owner: inst.by }, ctx.cause);
}

/* ------------------------------ 伤害节点 ------------------------------ */

/**
 * 一个分支里的伤害节点 → 每个承受者一个伤害包。
 * 带 `id` 的节点在一次动作执行里只掷一次（火球术对所有目标用同一次掷骰），`ref` 复用它（可以 scale 减半）。
 */
function runDamageNodes(tx: Tx, nodes: Array<Extract<Node, { kind: 'damage' }>>, ctx: ExecCtx): void {
  const byRecipient = new Map<Id, DamageComponent[]>();
  let scale: number | undefined;
  let maxed: boolean | undefined;
  const maxDmg = () => (maxed ??= maxDiceFor(tx, ctx.self, 'damage', { target: ctx.target, slot: ctx.slot, spell: ctx.originKind === 'spell', attack: ctx.attack }));
  for (const n of nodes) {
    let comps: DamageComponent[];
    if (n.ref) {
      let shared = ctx.locals[n.ref];
      if (!shared) {
        // 例：火球术第一个目标就豁免成功 —— 失败分支里那次「共享掷骰」还没发生，按定义现在掷
        const def = ctx.damageDefs?.[n.ref];
        if (!def) throw new Error(`伤害节点引用了不存在的 id「${n.ref}」`);
        const c: DamageComponent = { dice: dice(tx, ctx, def.dice ?? '0', ctx.actionName), type: typeOf(tx, ctx, def.type), from: ctx.actionName };
        c.rolled = { ...rollComponent(tx, c, false, controllerOf(tx, ctx.self), 0, maxDmg()), crit: false };
        shared = ctx.locals[n.ref] = { comps: [c] };
      }
      comps = shared.comps.map((c) => ({ ...c, type: n.type ? typeOf(tx, ctx, n.type) : c.type, rolled: c.rolled ? { ...c.rolled } : undefined }));
    } else {
      const c: DamageComponent = { dice: dice(tx, ctx, n.dice ?? '0', ctx.actionName), type: typeOf(tx, ctx, n.type), from: ctx.actionName };
      if (n.id) {
        const prev = ctx.locals[n.id];
        if (prev) comps = prev.comps.map((x) => ({ ...x, rolled: x.rolled ? { ...x.rolled } : undefined }));
        else {
          c.rolled = { ...rollComponent(tx, c, false, controllerOf(tx, ctx.self), 0, maxDmg()), crit: false };
          ctx.locals[n.id] = { comps: [c] };
          comps = [c];
        }
      } else comps = [c];
    }
    if (n.scale !== undefined) scale = n.scale;
    const to = n.to ?? 'target';
    for (const id of recipients(tx, ctx, to)) byRecipient.set(id, [...(byRecipient.get(id) ?? []), ...comps]);
  }
  const ignoreResist = nodes.some((n) => n.ignoreResist);
  const ignoreImmunity = nodes.some((n) => n.ignoreImmunity);
  // 共享掷骰（火球术）：这一组用的是哪次掷骰 —— 同一次掷骰的各个目标算「一次伤害掷骰」（hideMarksOfRoll）
  const shared = nodes.find((n) => n.id || n.ref);
  const rollKey = shared ? String(shared.id ?? shared.ref) : undefined;
  for (const [id, comps] of byRecipient) {
    applyDamagePacket(tx, {
      rollKey,
      source: ctx.self, target: id, components: comps.map((c) => ({ ...c })), crit: false, label: ctx.actionName,
      scale, reduce: [], save: ctx.save, max: maxDmg() || undefined,
      ...(ignoreResist ? { ignoreResist: true } : {}),
      ...(ignoreImmunity ? { ignoreImmunity: true } : {}),
    }, ctx.cause);
  }
}

/* ============================================================================
 * 代价
 * ========================================================================== */

/** 代价的说法。names = 资源 id → 显示名（有就用名字，没有就显示 id） */
export function describeCost(c: Cost, names: Record<string, string> = {}): string {
  if ('economy' in c) return ({ action: '动作', bonus: '附赠动作', reaction: '反应', attack: '一次攻击', move: '移动' } as const)[c.economy];
  if ('resource' in c) return `${names[c.resource] ?? c.resource}${c.n === undefined || c.n === 1 ? ' 1 次' : ` ×${c.n}`}`;
  if ('slot' in c) return `${c.slot.min} 环或更高的法术位`;
  if ('recharge' in c) return `充能 ${c.recharge}`;
  return `${c.charges} 充能`;
}

const inCombat = (tx: Tx) => tx.state.round !== null;

function slotAvailable(tx: Tx, id: Id, level: number): boolean {
  const v = effectiveView(tx, id);
  const c = tx.state.combatants[id];
  return (v.slots[level] ?? 0) - (c.live.slotsUsed[level] ?? 0) > 0;
}

function lowestSlot(tx: Tx, id: Id, min: number, max = 9): number | null {
  for (let l = min; l <= max; l++) if (slotAvailable(tx, id, l)) return l;
  return null;
}

/** 充能记在 resourcesUsed 里的名字：「充能:5:火焰吐息」（阈值写在名字里，回合开始掷骰时要用） */
export const rechargeKey = (k: { recharge: '5-6' | '6'; id?: string }) => `充能:${k.recharge === '6' ? 6 : 5}:${k.id ?? '?'}`;

/** 付得起吗（不付）。战斗外不限制动作经济 */
export function canPay(tx: Tx, id: Id, costs: Cost[]): boolean {
  const c = tx.state.combatants[id];
  if (!c || c.live.dead) return false;
  const blocked = blockedEconomy(tx, id);
  for (const k of costs) {
    if ('economy' in k) {
      if (k.economy === 'action' || k.economy === 'bonus' || k.economy === 'reaction') {
        if (blocked.has(k.economy)) return false;
        if (inCombat(tx) && c.economy[k.economy] < 1) return false;
        // 2024：动作和附赠动作只能在自己的回合里用（别人的回合里只有反应）。
        // 引擎统一管，数据里就不用每条都写 requires: turn.isMine
        if (inCombat(tx) && k.economy !== 'reaction' && tx.state.order[tx.state.turnIndex] !== id) return false;
      }
    } else if ('resource' in k) {
      const max = effectiveView(tx, id).resources[k.resource] ?? 0;
      if (max - (c.live.resourcesUsed[k.resource] ?? 0) < 1) return false;
    } else if ('slot' in k) {
      if (lowestSlot(tx, id, k.slot.min, k.slot.max) === null) return false;
    } else if ('recharge' in k) {
      if ((c.live.resourcesUsed[rechargeKey(k)] ?? 0) > 0) return false;
    }
  }
  return true;
}

/** 付代价。法术位选环：传入 slotLevel；没传就用能用的最低环（反应型的护盾术就是这样） */
export function payCosts(tx: Tx, id: Id, costs: Cost[], label: string, cause: number | null, slotLevel?: number, paid?: ActionInstance['paid']): number | undefined {
  const c = tx.state.combatants[id];
  let usedSlot: number | undefined;
  for (const k of costs) {
    if ('economy' in k) {
      if (k.economy === 'attack') continue;   // 由 executeAction 处理（「攻击」动作的次数）
      if (k.economy === 'move') continue;
      if (inCombat(tx)) tx.emit('economyChanged', { id, patch: { [k.economy]: c.economy[k.economy] - 1 } }, cause);
    } else if ('resource' in k) {
      const n = k.n === undefined ? 1 : num(tx, { self: id, targets: [], entryKey: '', actionName: label, cause, locals: {} }, k.n, '资源消耗');
      tx.emit('resourceUsed', { id, resource: k.resource, used: (c.live.resourcesUsed[k.resource] ?? 0) + n }, cause);
      paid?.resources.push({ id: k.resource, n });
    } else if ('slot' in k) {
      const level = slotLevel ?? lowestSlot(tx, id, k.slot.min, k.slot.max);
      if (level === null || level < k.slot.min || !slotAvailable(tx, id, level)) throw new Rejected(`${label}：没有可用的 ${slotLevel ?? k.slot.min} 环法术位`);
      tx.emit('slotUsed', { id, level, used: (c.live.slotsUsed[level] ?? 0) + 1 }, cause);
      usedSlot = level;
    } else if ('recharge' in k) {
      tx.emit('resourceUsed', { id, resource: rechargeKey(k), used: 1 }, cause);
    }
  }
  return usedSlot;
}

/* ============================================================================
 * 动作
 * ========================================================================== */

export function collectDamageDefs(nodes: Node[], out: Record<string, Extract<Node, { kind: 'damage' }>> = {}): Record<string, Extract<Node, { kind: 'damage' }>> {
  for (const n of nodes) {
    if (n.kind === 'damage' && n.id) out[n.id] = n;
    for (const v of Object.values(n)) {
      if (Array.isArray(v) && v.length && typeof v[0] === 'object' && v[0] && 'kind' in v[0]) collectDamageDefs(v as Node[], out);
      if (Array.isArray(v) && v.length && typeof v[0] === 'object' && v[0] && 'do' in v[0]) for (const o of v as Array<{ do?: Node[] }>) collectDamageDefs(o.do ?? [], out);
    }
  }
  return out;
}

export function weaponAction(row: AttackRow): Action {
  const attack: Partial<AttackInfo> = {
    melee: row.melee, ranged: row.ranged, weapon: true, spell: false, unarmed: false, finesse: row.finesse,
    reach: !!row.reach, ability: row.ability, damageType: normType(row.damageType), item: row.name, mastery: row.mastery ?? null,
  };
  return {
    id: row.id,
    name: row.name,
    activation: 'none',
    cost: [{ economy: 'attack' }],
    // 射程：近战按触及（5 / 10 尺），能投掷 / 远程的按远射程
    targeting: { type: 'creature', count: 1, range: Math.max(row.melee ? (row.reach ? 10 : 5) : 0, row.long ?? row.range ?? 0) || undefined },
    root: [{
      kind: 'attack', bonus: row.bonus, attack,
      onHit: [{ kind: 'damage', dice: row.damage, type: normType(row.damageType) }, ...(row.extra ?? []).map((x) => ({ kind: 'damage' as const, dice: x.dice, type: normType(x.type) }))],
    }],
    tags: ['weapon'],
  };
}

export function findAction(tx: Tx, actor: Id, ref: string): { key: string; action: Action } {
  if (ref.startsWith('weapon:')) {
    const id = ref.slice(7);
    const row = effectiveView(tx, actor).attacks.find((a) => a.id === id);
    if (!row) throw new Rejected(`${nameOf(tx, actor)} 没有武器攻击「${id}」`);
    return { key: ref, action: weaponAction(row) };
  }
  const [key, aid] = ref.split('#');
  const entry = entryOf(tx, actor, key);
  const action = entry?.actions?.find((a) => a.id === (aid ?? entry.actions?.[0]?.id));
  if (!entry || !action) throw new Rejected(`找不到动作「${ref}」`);
  return { key, action };
}

export interface ExecuteOpts {
  /** 这个动作是在「某个正在施展的法术」的窗口里执行的：它下面 modifyCast 改的就是这份计划书 */
  interrupting?: CastPlan;
  actor: Id;
  actionKey: string;
  action: Action;
  targets: Id[];
  slotLevel?: number;
  force?: boolean;
  cause: number | null;
  viaReaction?: boolean;
  options?: Record<string, unknown>;
  /** 预先定好的变量（vars.<名>）：choose 发现这个变量已经是一个可选项，就不再问 */
  vars?: Record<string, number | string>;
  /** 由窗口触发的动作（至圣斩、护盾术）：带上窗口的上下文 —— 命中窗口里的伤害包、攻击信息、检定 */
  window?: Pick<ExecCtx, 'packet' | 'attack' | 'attacker' | 'roll' | 'damage' | 'event' | 'modify'>;
  area?: ExecCtx['area'];
}

/** 这个动作的代价（动作经济 + 声明的代价） */
export function actionCosts(action: Action, asReaction = false): Cost[] {
  const act = asReaction ? 'reaction' : typeof action.activation === 'string' ? action.activation : 'special';
  const costs: Cost[] = [];
  if (act === 'action' || act === 'bonus' || act === 'reaction') costs.push({ economy: act });
  costs.push(...(action.cost ?? []).filter((k) => !(asReaction && 'economy' in k && k.economy === 'attack')));
  return costs;
}

const MOON_SPELLS = new Set(['疗伤术', '月华之光', '点点星芒', '咒唤兽群', '月光涌泉', '群体疗伤术']);

const hasSourceName = (sources: string[], name: string) =>
  sources.some((s) => s === name || s.includes(`:${name}:`) || s.endsWith(`:${name}`) || s.endsWith(`#${name}`));

function cannotCastSpell(tx: Tx, owner: Id, action: Action): boolean {
  const blockers = activeTemplates(tx, owner).filter((a) => a.tpl.flags?.cannot?.includes('castSpells'));
  if (!blockers.length) return false;
  if (blockers.some((a) => !a.effect.form && !(a.tpl.tags ?? []).includes('wildshape'))) return true;
  const v = effectiveView(tx, owner);
  if ((v.levels['德鲁伊'] ?? 0) >= 18 || hasSourceName(v.sources, '兽形施法')) return false;
  if (MOON_SPELLS.has(action.name) && (hasSourceName(v.sources, '月亮结社法术') || hasSourceName(v.sources, '结社形态'))) {
    return false;
  }
  return true;
}

/**
 * flags.cannot 里的 `<动作 id>:source`：不能对效应来源用这个动作（梦幻舞步：本回合不能对你借机攻击）。
 * 和 `moveCloser:source` 一个写法；不带 `:source` 的（`opportunityAttack`）是对谁都不能用。
 */
export function forbiddenAgainst(tx: Tx, owner: Id, action: Action, target: Id | undefined): boolean {
  if (!target) return false;
  return activeTemplates(tx, owner).some((a) => a.tpl.flags?.cannot?.includes(`${action.id}:source`) && a.effect.source === target);
}

/**
 * 窗口触发的动作现在能不能用（不抛错版的 executeAction 前置检查，不含目标检查）。
 * requires 不确定时返回问题，交给窗口一起问。
 */
export function triggeredActionUsable(tx: Tx, owner: Id, action: Action): { ok: boolean; questions: Question[] } {
  const no = { ok: false, questions: [] };
  const c = tx.state.combatants[owner];
  if (!c || c.live.dead) return no;
  const isSpell = (action.tags ?? []).includes('spell');
  const costs = actionCosts(action);
  if (!canPay(tx, owner, costs)) return no;
  const cannot = new Set(activeTemplates(tx, owner).flatMap((a) => a.tpl.flags?.cannot ?? []));
  // flags.cannot 里写动作 id = 不能用那个动作（opportunityAttack：不能借机攻击）
  if (cannot.has(action.id)) return no;
  if (isSpell && cannotCastSpell(tx, owner, action)) return no;
  if (action.concentration && cannot.has('concentrate')) return no;
  if (inCombat(tx) && isSpell && costs.some((k) => 'slot' in k) && c.economy.slotSpellCast) return no;
  if (action.requires === undefined) return { ok: true, questions: [] };
  const v = runBool(action.requires, makeEnv(tx, { self: owner }));
  if (v === false) return no;
  return { ok: true, questions: v instanceof Unknown ? [...v.questions] : [] };
}

/** 最多能选几个目标（targeting.count 可以随环阶变：魔法飞弹 2 + slot.level）；没写 = null（不限） */
export function maxTargets(tx: Tx, actor: Id, action: Action, slotLevel?: number): number | null {
  const t = action.targeting;
  if (!t || t.count === undefined) return null;
  return num(tx, { self: actor, targets: [], entryKey: '', actionName: action.name, cause: null, locals: {}, slot: slotLevel }, t.count, '目标数');
}

/** 效果随环阶变化的动作（表达式里用到 slot.level）—— 没指定环阶时值得问一句 */
const scalesWithSlot = (a: Action) => JSON.stringify(a.root).includes('slot.level');

const ACT_CN: Record<string, string> = { action: '动作', bonus: '附赠动作', reaction: '反应', free: '免费', none: '' };

/** 瞬发：持有者身上带 quicken 标记的效应（没有 = undefined） */
function quickenOf(tx: Tx, actor: Id, action: Action): ActiveEffect | undefined {
  if (action.activation !== 'action' || !(action.tags ?? []).includes('spell')) return undefined;
  return activeTemplates(tx, actor).find((a) => a.tpl.flags?.quicken)?.effect;
}

/** 这个动作实际怎么施放（瞬发法术：施法时间为动作的法术改成附赠动作）。界面算代价也用它 */
/**
 * 这个动作实际的射程（尺）：远程法术这类效应（flags.rangeMult / touchRange）只改法术的。
 * 引擎不查射程（选目标是界面的事），界面选目标时用它；null = 不查（自身、没写）。
 */
export function effectiveRange(tx: Tx, actor: Id, action: Action): number | null {
  const r = action.targeting?.range;
  const base = typeof r === 'number' ? r : r === 'touch' || r === 'reach' ? 5 : null;
  if (!(action.tags ?? []).includes('spell') || base === null) return base;
  let out = base;
  for (const a of activeTemplates(tx, actor)) {
    const f = a.tpl.flags;
    if (r === 'touch' && f?.touchRange) out = Math.max(out, f.touchRange);
    else if (typeof r === 'number' && f?.rangeMult) out = Math.max(out, r * f.rangeMult);
  }
  return out;
}

export function effectiveAction(tx: Tx, actor: Id, action: Action): Action {
  return quickenOf(tx, actor, action) ? { ...action, activation: 'bonus' } : action;
}

export function executeAction(tx: Tx, o: ExecuteOpts): void {
  // 用反应发起一次武器攻击（界面上勾「用反应攻击」）= 用这件武器做一次借机攻击：
  // 走规则里的借机攻击（core.opportunityAttack），这样「借机攻击命中时」的能力（哨兵、坚韧复仇）认得出来
  const oaRef = tx.rules.coreAll().opportunityAttack as string | undefined;
  if (o.options?.as === 'reaction' && (o.action.tags ?? []).includes('weapon') && oaRef && o.actionKey !== oaRef) {
    try {
      const oa = findAction(tx, o.actor, oaRef);
      executeAction(tx, { ...o, actionKey: `${oa.key}#${oa.action.id}`, action: oa.action, options: undefined, vars: { weapon: o.actionKey } });
      return;
    } catch (e) {
      if (!(e instanceof Rejected) || !/找不到动作/.test(e.message)) throw e;
    }
  }
  const quick = o.options?.as === 'reaction' ? undefined : quickenOf(tx, o.actor, o.action);
  const actor = o.actor;
  const action = quick ? { ...o.action, activation: 'bonus' as const } : o.action;
  const c = tx.state.combatants[actor];
  if (!c) throw new Rejected(`没有参与者 ${actor}`);
  const isSpell = (action.tags ?? []).includes('spell');
  const asReaction = o.options?.as === 'reaction';
  const act = asReaction ? 'reaction' : typeof action.activation === 'string' ? action.activation : 'special';
  const costs = actionCosts(action, asReaction);
  // 没指定环阶：按动作自己的最低环阶（`slot.min`）当默认值，别让 slot.level 在表达式里求值失败
  const slotLevel0 = o.slotLevel ?? (action.cost ?? []).flatMap((k) => ('slot' in k ? [k.slot.min] : []))[0];
  const entryKey = o.actionKey.split('#')[0];

  if (!o.force) {
    if (c.live.dead) throw new Rejected(`${c.name} 已经死亡`);
    const blocked = blockedEconomy(tx, actor);
    if ((act === 'action' || act === 'bonus' || act === 'reaction') && blocked.has(act)) {
      throw new Rejected(`${c.name} 现在无法执行${ACT_CN[act]}（失能）`);
    }
    const cannot = new Set(activeTemplates(tx, actor).flatMap((a) => a.tpl.flags?.cannot ?? []));
    if (cannot.has(action.id)) throw new Rejected(`${c.name} 现在不能用「${action.name}」`);
    if (isSpell && cannotCastSpell(tx, actor, action)) throw new Rejected(`${c.name} 现在不能施法`);
    if (action.concentration && cannot.has('concentrate')) throw new Rejected(`${c.name} 现在无法保持专注`);
    if (action.requires !== undefined) {
      const ok = resolveBool(tx, action.requires, { self: actor, slot: slotLevel0 }, actor, action.name);
      if (!ok) throw new Rejected(`「${action.name}」的使用条件不满足`);
    }
    if (inCombat(tx) && costs.some((k) => 'economy' in k && k.economy === 'attack') && tx.state.order[tx.state.turnIndex] !== actor) {
      throw new Rejected(`现在不是${c.name}的回合：在别人的回合里攻击要用反应（借机攻击）`);
    }
    if (!canPay(tx, actor, costs)) {
      const names = effectiveView(tx, actor).resourceNames ?? {};
      throw new Rejected(`「${action.name}」的代价付不起（${costs.map((k) => describeCost(k, names)).join('、')}）`);
    }
    if (inCombat(tx) && isSpell && costs.some((k) => 'slot' in k) && c.economy.slotSpellCast) {
      throw new Rejected('2024 规则：一个回合里只能消耗一个法术位来施法');
    }
    const t = action.targeting;
    if (t && (t.type === 'creature' || t.type === 'area')) {
      // 范围里可以一个生物都没有（只留下区域的火墙），只要选了范围
      if (!o.targets.length && !(t.type === 'area' && o.area)) throw new Rejected(`「${action.name}」需要选择目标`);
      if (t.count !== undefined && t.type === 'creature') {
        const max = maxTargets(tx, actor, action, slotLevel0) ?? Infinity;
        if (o.targets.length > max) throw new Rejected(`「${action.name}」最多 ${max} 个目标，选了 ${o.targets.length} 个`);
      }
      if (!t.repeat && new Set(o.targets).size < o.targets.length) throw new Rejected(`「${action.name}」不能重复选同一个目标`);
      for (const tid of o.targets) {
        if (!tx.state.combatants[tid]) throw new Rejected(`目标 ${tid} 不在遭遇中`);
        const forbidden = activeTemplates(tx, actor).some((a) => a.tpl.flags?.forbidTarget === 'source' && a.effect.source === tid);
        if (forbidden && tx.state.combatants[tid]) throw new Rejected(`${c.name} 处于魅惑状态，不能以 ${nameOf(tx, tid)} 为目标`);
        if (forbiddenAgainst(tx, actor, action, tid)) throw new Rejected(`${c.name} 现在不能对 ${nameOf(tx, tid)} 用「${action.name}」`);
        // 范围法术里「你选择的生物」（filter 写成 ask(...)）：人已经在选目标时挑过了，不再逐个问
        const picked = t.type === 'area' && typeof t.filter === 'string' && /^\s*ask\(/.test(t.filter);
        if (t.filter !== undefined && !picked) {
          const ok = resolveBool(tx, t.filter, { self: actor, target: tid, slot: slotLevel0 }, actor, `${action.name} 的目标限制`);
          if (!ok) throw new Rejected(`${nameOf(tx, tid)} 不是「${action.name}」的合法目标`);
        }
      }
    }
  }

  const seq = tx.emit('actionUsed', {
    actor, action: action.name, key: o.actionKey, targets: o.targets, activation: act, slotLevel: slotLevel0 ?? null,
  }, o.cause);

  // 动作实例：这次动作结算期间，所有窗口和表达式都能用 action.* 读到它（instance.ts）
  const tags = action.tags ?? [];
  const meta = isSpell ? spellMetaOf(entryKey, entryOf(tx, actor, entryKey), action) : null;
  const inst: ActionInstance = {
    seq, by: actor, name: action.name, key: entryKey,
    kind: isSpell ? 'spell' : tags.includes('weapon') ? 'weapon' : tags.includes('item') ? 'item' : 'feature',
    economy: act,
    onMyTurn: !inCombat(tx) || tx.state.order[tx.state.turnIndex] === actor,
    spell: meta ? { ...meta, slot: slotLevel0 ?? meta.level } : null,
    attack: null, targets: o.targets.slice(), marks: {}, markRoll: {}, paid: { resources: [] }, results: {}, last: null, damage: null,
    parent: currentAction(tx), pending: null,
  };
  tx.actions.push(inst);
  try {
    runAction(tx, o, { action, actor, c, isSpell, costs, slotLevel0, entryKey, quick, seq, inst });
  } finally {
    tx.actions.pop();
  }
}

/** executeAction 做完前置检查、压好实例之后的部分 */
function runAction(tx: Tx, o: ExecuteOpts, x: {
  action: Action; actor: Id; c: Tx['state']['combatants'][string]; isSpell: boolean; costs: Cost[];
  slotLevel0: number | undefined; entryKey: string; quick: ActiveEffect | undefined; seq: number; inst: ActionInstance;
}): void {
  const { action, actor, c, isSpell, costs, slotLevel0, entryKey, quick, seq, inst } = x;

  // 武器攻击：消耗「攻击」动作给的攻击次数（额外攻击）；n = 一次花几次攻击（精通战争魔法：两次攻击换一道法术）
  const atkCost = costs.find((k): k is Extract<Cost, { economy: unknown }> => 'economy' in k && k.economy === 'attack');
  if (inCombat(tx) && atkCost) {
    const need = atkCost.n === undefined ? 1 : Math.max(1, num(tx, { self: actor, targets: [], entryKey, actionName: action.name, cause: seq, locals: {} }, atkCost.n, '花几次攻击'));
    const per = effectiveView(tx, actor).attacksPerAction;
    if (c.economy.attacksLeft >= need) {
      tx.emit('economyChanged', { id: actor, patch: { attacksLeft: c.economy.attacksLeft - need } }, seq);
    } else if (c.economy.attacksLeft === 0 && (o.force || c.economy.action > 0) && per >= need) {
      tx.emit('economyChanged', { id: actor, patch: { action: Math.max(0, c.economy.action - 1), attacksLeft: per - need } }, seq);
      tx.emit('note', { text: `${c.name} 执行「攻击」动作（本动作共 ${per} 次攻击）`, owner: actor }, seq);
    } else if (o.force) {
      tx.emit('economyChanged', { id: actor, patch: { attacksLeft: 0 } }, seq);
    } else if (c.economy.attacksLeft > 0) {
      throw new Rejected(`「${action.name}」要花 ${need} 次攻击，这个攻击动作只剩 ${c.economy.attacksLeft} 次`);
    } else if (per < need) {
      throw new Rejected(`「${action.name}」要花 ${need} 次攻击，${c.name} 一个攻击动作只有 ${per} 次`);
    } else {
      throw new Rejected(`${c.name} 没有剩余的攻击次数，也没有动作了`);
    }
  }
  // 没指定环阶、效果又随环阶变化（窗口里触发的至圣斩）：问用几环
  // 注意：这里看的是**调用方**给的环阶（o.slotLevel），slotLevel0 只是给表达式求值兜底的默认值
  let slotLevel = slotLevel0;
  const slotCost = costs.find((k): k is Extract<Cost, { slot: unknown }> => 'slot' in k);
  if (o.slotLevel === undefined && slotCost && scalesWithSlot(action)) {
    const levels: number[] = [];
    for (let l = slotCost.slot.min; l <= (slotCost.slot.max ?? 9); l++) if (slotAvailable(tx, actor, l)) levels.push(l);
    if (levels.length > 1) {
      const v = tx.decide({
        kind: 'slotLevel', to: controllerOf(tx, actor), prompt: `「${action.name}」用几环法术位？`,
        options: levels.map((l) => ({ id: String(l), label: `${l} 环（剩 ${(effectiveView(tx, actor).slots[l] ?? 0) - (c.live.slotsUsed[l] ?? 0)}）` })),
        default: String(levels[0]),
      });
      const picked = Number(Array.isArray(v) ? v[0] : v);
      slotLevel = levels.includes(picked) ? picked : levels[0];
    }
  }
  const slot = payCosts(tx, actor, costs, action.name, seq, slotLevel, inst.paid);
  inst.paid.slot = slot;
  if (inst.spell && slot !== undefined) inst.spell.slot = slot;
  if (quick) endEffect(tx, quick.id, `用在了「${action.name}」上（附赠动作施放）`, seq);
  if (slot !== undefined && inCombat(tx) && isSpell) tx.emit('economyChanged', { id: actor, patch: { slotSpellCast: true } }, seq);
  let castPlan: CastPlan | null = null;
  if (isSpell) {
    // 窗口里能读到这次施法的目标（role: 'target' 就是「被打的那个」；范围法术读 event.targets）
    const castTargets = o.targets.slice();
    const evScope = { actor, spell: action.name, key: entryKey, slotLevel: slot ?? 0, targets: castTargets };
    const castTarget = castTargets.length === 1 ? castTargets[0] : undefined;
    // 这次施法的**计划书**：窗口里的能力改它，窗口关掉之后照它结算（法术反制「先豁免再打断」靠这个）
    const view0 = effectiveView(tx, actor);
    const plan = newCastPlan({
      seq, caster: actor, spell: action.name, key: entryKey, level: slot ?? 0, targets: castTargets,
      dc: view0.spell?.dc ?? null, attackBonus: view0.spell?.atk ?? null,
    });
    tx.casts.set(seq, plan);
    castPlan = plan;
    const outerPlan = tx.windowPlan;
    tx.windowPlan = plan;
    try {
      fireWindow(tx, {
        event: 'spellCast', window: 'before', actor, target: castTarget, plan,
        scope: { slot, event: evScope },
        cause: seq,
        modify: (m, by) => {
          if (m.op === 'cancel') plan.canceled = { by: by.label, refundSlot: m.refundSlot !== false };
        },
      });
      if (plan.canceled === null && tx.windowPlan !== plan) {
        // 窗口里的节点已经改过计划书（比如 `modifyCast` 写了 cancel）——保留它
      }
    } finally {
      tx.windowPlan = outerPlan;
    }
    if (plan.canceled !== null) {
      const { by, refundSlot } = plan.canceled;
      if (slot !== undefined && refundSlot) {
        tx.emit('slotUsed', { id: actor, level: slot, used: Math.max(0, (c.live.slotsUsed[slot] ?? 1) - 1) }, seq);
        if (inCombat(tx)) tx.emit('economyChanged', { id: actor, patch: { slotSpellCast: false } }, seq);
      }
      tx.emit('note', {
        text: `「${action.name}」被「${by}」打断，法术失效${slot !== undefined ? (refundSlot ? '（法术位不消耗）' : '（法术位已消耗）') : ''}`,
        owner: actor,
      }, seq);
      tx.casts.delete(seq);
      tx.emit('actionDone', { actor, action: action.name }, seq);
      return;
    }
    for (const n of plan.notes) tx.emit('note', { text: n, owner: actor }, seq);
    const cast = tx.emit('spellCast', { actor, spell: action.name, key: entryKey, slotLevel: slot ?? null, targets: castTargets }, seq);
    fireWindow(tx, { event: 'spellCast', window: 'after', actor, target: castTarget, plan, scope: { slot, event: evScope }, cause: cast });
  }

  let concentrationId: EffectId | undefined;
  if (action.concentration) {
    concentrationId = startConcentration(tx, actor, action.name, action.concentration, entryKey, seq).id;
  }
  const form = o.options?.form as CombatantView | undefined;
  // 「只对自己」的动作（免位施放护盾类：targeting.type = 'self'）没点目标也当成选了自己，
  // 否则复制来的法术 root 里 `to: 'target'` 会报「需要目标」
  const asked = castPlan ? castPlan.targets : o.targets;
  const targets = asked.length ? asked.slice() : action.targeting?.type === 'self' ? [actor] : [];
  // 孪生法术这类：有效环阶加几（不多花法术位）
  const effSlot = castPlan && castPlan.slotDelta > 0 ? (slot ?? inst.spell?.level ?? 0) + castPlan.slotDelta : slot;
  if (castPlan && castPlan.slotDelta > 0 && inst.spell) inst.spell.slot = effSlot ?? inst.spell.slot;
  inst.targets = targets.slice();
  const ctx: ExecCtx = {
    self: actor,
    targets,
    target: targets.length === 1 ? targets[0] : undefined,
    slot: effSlot,
    entryKey,
    actionName: action.name,
    cause: seq,
    locals: {},
    concentrationId,
    concentrationDuration: action.concentration,
    damageDefs: collectDamageDefs(action.root),
    ...(castPlan ? { cast: castPlan } : {}),
    ...(o.interrupting ? { interrupting: o.interrupting } : {}),
    originKind: isSpell ? 'spell' : (action.tags ?? []).includes('weapon') ? 'item' : 'feature',
    vars: { ...(o.vars ?? {}) },
    ...(o.area ? { area: o.area } : {}),
    ...(form ? { form } : {}),
    ...o.window,
  };
  // repeatAction：对另一个目标再执行一次（共享掷骰另起，环阶、选项照旧）
  inst.rerun = (t: Id) => runNodes(tx, action.root, { ...ctx, targets: [t], target: t, locals: {}, vars: { ...(ctx.vars ?? {}) } });
  runNodes(tx, action.root, ctx);
  const doneSeq = tx.emit('actionDone', { actor, action: action.name }, seq);
  // 「用完一个动作之后」（施法后传送、攻击后附赠动作…）：只开给最外层的动作 —— 反应、窗口里用的动作不再触发一轮
  if (!inst.parent && !o.viaReaction) {
    fireWindow(tx, { event: 'actionDone', window: 'after', actor, target: inst.targets.length === 1 ? inst.targets[0] : undefined, scope: {}, cause: doneSeq });
  }
}









