import { ABIL_CN, Unknown, runBool, runInt, type Question, type Value } from '../expr';
import { d20Test } from './d20';
import { triggeredActionsOf, triggersOf } from './collect';
import { activeTemplates, effectiveView } from './effects';
import { actionCosts, canPay, describeCost, executeAction, payCosts, runNodes, triggeredActionUsable, type ExecCtx } from './exec';
import { normType, type DamagePacket } from './damage';
import type { CastPlan } from './castplan';
import { makeEnv, nameOf, type ScopeData } from './scope';
import type { Tx } from './tx';
import type { Action, ActiveEffect, Cost, Id, Modify, Trigger, TriggerSpec } from './types';

/**
 * 触发器分发（COMBAT-DESIGN §8.2 / §九）。
 *
 * 一个「窗口」= 某个事件的 before 或 after 时机。窗口打开时：
 *   1. 找出所有声明了这个时机的触发器（常驻、效应、灵光授予、反应型动作）；
 *   2. 过滤身份（actor/target/ally/enemy）、次数限制、代价是否付得起、条件；
 *   3. 强制的直接执行；可选的按控制者合并成**一个**决定（不打扰原则：没人能用就不停顿）。
 */

export interface TriggerCand {
  key: string;
  owner: Id;
  source: Id | null;
  effect?: ActiveEffect;
  from: string;
  label: string;
  trigger?: Trigger;
  action?: Action;
  optional: boolean;
  cost: Cost[];
  questions: Question[];
  scope: ScopeData;
}

export interface WindowSpec {
  event: string;
  window: 'before' | 'after';
  actor?: Id;
  target?: Id;
  scope: Omit<Partial<ScopeData>, 'self' | 'source' | 'effect'>;
  /** attackHit 窗口分段：防守方 / 进攻方（§六⑦） */
  phase?: 'defensive' | 'offensive';
  modify?: (m: Modify, by: TriggerCand) => void;
  /** 修改之后刷新 roll 作用域（重骰窗口循环用） */
  refresh?: () => Record<string, Value>;
  packet?: DamagePacket;
  /** 这个窗口属于哪次施法（窗口里的能力改的就是这份计划书） */
  plan?: CastPlan;
  cause: number | null;
}

const arr = <T>(x: T | T[]): T[] => (Array.isArray(x) ? x : [x]);

/** 某个触发器在当前房间设置下实际挂在哪个时机（§9.5：看到结果再决定 → deferTo） */
function effectiveTiming(tx: Tx, t: TriggerSpec): { on: string[]; window: 'before' | 'after' } {
  if (tx.state.settings.reactionTiming === 'afterResult' && t.deferTo) return { on: [t.deferTo], window: 'before' };
  return { on: arr(t.on), window: t.window ?? 'after' };
}

function roleOk(tx: Tx, spec: WindowSpec, owner: Id, role: TriggerSpec['role']): boolean {
  if (role === 'any') return true;
  if (role === 'actor') return owner === spec.actor;
  if (role === 'target') return owner === spec.target;
  if (owner === spec.actor || owner === spec.target) return false;
  const ref = spec.target ?? spec.actor;
  if (!ref) return false;
  const same = tx.state.combatants[owner]?.side === tx.state.combatants[ref]?.side;
  return role === 'ally' ? same : !same;
}

/** 「不问我」开关的键：`条目键#触发 id`（效应带来的不带效应 id，下次同一能力还认得） */
export function prefKey(c: { from: string; trigger?: { id: string }; action?: { id: string } }): string {
  return `${c.from}#${c.trigger?.id ?? c.action?.id ?? ''}`;
}

function limitKey(c: { from: string; id: string }): string {
  return `${c.from}#${c.id}`;
}

function limitUsed(tx: Tx, owner: Id, limit: Trigger['limit'], key: string): boolean {
  if (!limit || typeof limit === 'object') return false;
  const used = tx.state.combatants[owner].economy.once[key];
  if (limit === 'oncePerTurn') return used === tx.turnKey();
  return used === `r${tx.state.round ?? 0}`;
}

export function blockedEconomy(tx: Tx, id: Id): Set<string> {
  const out = new Set<string>();
  for (const at of activeTemplates(tx, id)) for (const b of at.tpl.flags?.blocks ?? []) out.add(b);
  return out;
}

function collect(tx: Tx, spec: WindowSpec, done: Set<string>): TriggerCand[] {
  const out: TriggerCand[] = [];
  const order = turnOrder(tx);
  for (const owner of order) {
    const c = tx.state.combatants[owner];
    if (!c || c.live.dead) continue;
    if (spec.phase === 'defensive' && owner === spec.actor) continue;
    if (spec.phase === 'offensive' && owner !== spec.actor) continue;

    const consider = (base: Omit<TriggerCand, 'questions' | 'scope'>, t: TriggerSpec & { limit?: Trigger['limit'] }, pre: Question[] = []) => {
      if (done.has(base.key)) return;
      // 控制者关掉了这个可选能力（「不问我」）：不进候选
      if (base.optional && c.triggerOff?.includes(prefKey(base))) return;
      const timing = effectiveTiming(tx, t);
      if (timing.window !== spec.window || !timing.on.includes(spec.event)) return;
      if (!roleOk(tx, spec, owner, t.role)) return;
      if (limitUsed(tx, owner, t.limit, base.key)) return;
      if (!canPay(tx, owner, base.cost)) return;
      const scope: ScopeData = {
        ...spec.scope,
        self: owner,
        source: base.source,
        effect: base.effect,
        target: spec.target ?? spec.actor,
        attacker: spec.scope.attacker ?? spec.actor,
        roll: spec.refresh ? spec.refresh() : spec.scope.roll,
      };
      let ok: boolean | Unknown = true;
      if (t.when !== undefined) {
        try {
          ok = runBool(t.when, makeEnv(tx, scope));
        } catch (e) {
          tx.emit('ruleError', { where: `触发器「${base.label}」（${base.from}）的条件`, message: (e as Error).message }, spec.cause);
          ok = false;
        }
      }
      if (ok === false) return;
      out.push({ ...base, questions: [...pre, ...(ok instanceof Unknown ? ok.questions : [])], scope });
    };

    for (const d of triggersOf(tx, owner)) {
      const t = d.item;
      const cost = [...(t.cost ?? [])];
      consider({
        key: limitKey({ from: d.effect ? `${d.from}@${d.effect.id}` : d.from, id: t.id }),
        owner, source: d.source, effect: d.effect, from: d.from,
        label: t.label ?? t.id, trigger: t, optional: !!t.optional, cost,
      }, t);
    }
    for (const { key, action } of triggeredActionsOf(tx, owner)) {
      // 窗口不对的先跳过（requires 的求值可能要问问题，别为不相干的窗口问）
      const timing = effectiveTiming(tx, action.trigger!);
      if (timing.window !== spec.window || !timing.on.includes(spec.event)) continue;
      const usable = triggeredActionUsable(tx, owner, action);
      if (!usable.ok) continue;
      consider({
        key: limitKey({ from: key, id: action.id }),
        owner, source: owner, from: key, label: action.name, action, optional: true, cost: actionCosts(action),
      }, action.trigger!, usable.questions);
    }
  }
  return out;
}

/** 从回合持有者开始的先攻顺序（同时效应：回合持有者先处理，§9.3） */
function turnOrder(tx: Tx): Id[] {
  const ids = Object.keys(tx.state.combatants);
  const order = tx.state.order.length ? tx.state.order.filter((x) => ids.includes(x)) : ids;
  const rest = ids.filter((x) => !order.includes(x));
  const all = [...order, ...rest];
  const i = tx.state.round === null ? 0 : Math.max(0, all.indexOf(tx.state.order[tx.state.turnIndex]));
  return [...all.slice(i), ...all.slice(0, i)];
}

function fire(tx: Tx, spec: WindowSpec, c: TriggerCand): void {
  const seq = tx.emit('triggerFired', {
    owner: c.owner, label: c.label, from: c.from, event: spec.event, window: spec.window,
  }, spec.cause);
  const lim = c.trigger?.limit;
  if (lim === 'oncePerTurn') tx.emit('onceUsed', { id: c.owner, key: c.key, at: tx.turnKey() }, seq);
  if (lim === 'oncePerRound') tx.emit('onceUsed', { id: c.owner, key: c.key, at: `r${tx.state.round ?? 0}` }, seq);

  // 窗口允许修改时，modify 节点经由这里改（值已经在节点那边求好）
  const modify = spec.modify ? (m: Modify) => spec.modify!(m, c) : undefined;
  if (c.action) {
    // 窗口触发的动作：动作自己付代价（反应 / 附赠 + 法术位…），自己跑效果树；
    // 目标 = 窗口里的目标（至圣斩打的是被命中的那个），没有就是自己；aim: 'actor' = 窗口的发起者（炼狱叱喝打伤害来源、法术反制打施法者）
    const aimed = c.action.trigger?.aim === 'actor' ? spec.actor : (spec.target ?? (c.action.targeting?.type === 'creature' ? spec.actor : undefined));
    executeAction(tx, {
      actor: c.owner, actionKey: `${c.from}#${c.action.id}`, action: c.action,
      targets: aimed && tx.state.combatants[aimed] ? [aimed] : [c.owner],
      cause: seq, viaReaction: true,
      interrupting: spec.plan,
      window: {
        packet: spec.packet, attack: spec.scope.attack, attacker: spec.scope.attacker ?? spec.actor,
        roll: spec.refresh ? spec.refresh() : spec.scope.roll, damage: spec.scope.damage, event: spec.scope.event, modify,
      },
    });
    return;
  }
  const t = c.trigger!;
  payCosts(tx, c.owner, t.cost ?? [], `${c.label}`, seq);
  if (t.modify?.length) {
    if (!spec.modify) {
      tx.emit('ruleError', { where: `触发器「${c.label}」`, message: `「${spec.event}」窗口不接受修改（modify）` }, seq);
    } else {
      for (const m of t.modify) applyModify(tx, spec, c, m);
    }
  }
  if (t.do?.length) {
    // 窗口没有承受者（回合开始 / 结束）：目标就是事件的主人 —— 自己的回合就是自己（恐惧术、降咒的回合末豁免），
    // 别人的回合就是那个人（「敌人在你 10 尺内开始回合时」）；aim: 'actor' = 显式打窗口发起者
    const target = t.aim === 'actor' ? spec.actor : (spec.target ?? spec.actor);
    const ctx: ExecCtx = {
      self: c.owner,
      source: c.source,
      targets: target ? [target] : [],
      target,
      attacker: spec.scope.attacker ?? spec.actor,
      entryKey: c.from,
      actionName: c.label,
      cause: seq,
      locals: {},
      effectId: c.effect?.id,
      attack: spec.scope.attack,
      roll: spec.refresh ? spec.refresh() : spec.scope.roll,
      damage: spec.scope.damage,
      event: spec.scope.event,
      packet: spec.packet,
      originKind: c.from.includes(':spell:') ? 'spell' : 'feature',
      modify,
    };
    const outerPlan = tx.windowPlan;
    tx.windowPlan = spec.plan ?? outerPlan;
    try { runNodes(tx, t.do, ctx); } finally { tx.windowPlan = outerPlan; }
  }
}

/**
 * 打开一个窗口。返回触发了的候选。
 * before 窗口会循环：有人改了结果（重骰、加骰）之后，别人可能因此能用或不能用了。
 */
export function fireWindow(tx: Tx, spec: WindowSpec): TriggerCand[] {
  const fired: TriggerCand[] = [];
  const done = new Set<string>();
  const passes = spec.window === 'before' ? 5 : 1;
  for (let pass = 0; pass < passes; pass++) {
    const cands = collect(tx, spec, done);
    if (!cands.length) break;
    let any = false;

    // 强制的：条件不确定就先问
    for (const c of cands.filter((x) => !x.optional)) {
      if (c.questions.length) {
        const ans = tx.decide({
          kind: 'ask',
          to: tx.state.combatants[c.owner].controller,
          prompt: `「${c.label}」是否生效？`,
          options: [],
          questions: c.questions.map((q) => ({ id: q.id, text: q.text, guess: q.guess, scope: q.scope })),
          default: Object.fromEntries(c.questions.map((q) => [q.id, q.guess ?? false])),
        }) as Record<string, boolean>;
        for (const q of c.questions) tx.qAnswers.set(q.id, { value: !!ans[q.id], scope: q.scope });
        if (!c.questions.every((q) => ans[q.id])) { done.add(c.key); continue; }
      }
      done.add(c.key);
      fire(tx, spec, c);
      fired.push(c);
      any = true;
    }

    // 可选的：按控制者合并成一个决定
    const byController = new Map<string, TriggerCand[]>();
    for (const c of cands.filter((x) => x.optional && !done.has(x.key))) {
      const ctl = tx.state.combatants[c.owner].controller;
      byController.set(ctl, [...(byController.get(ctl) ?? []), c]);
    }
    for (const [ctl, list] of byController) {
      const picked = tx.decide({
        kind: 'optionalTrigger',
        to: ctl,
        prompt: windowPrompt(tx, spec),
        multi: true,
        options: list.map((c, i) => ({
          id: String(i),
          label: `${nameOf(tx, c.owner)}：${c.label}`,
          detail: [
            c.cost.length ? `代价：${c.cost.map((k) => describeCost(k, effectiveView(tx, c.owner).resourceNames ?? {})).join('、')}` : '',
            c.questions.length ? `前提：${c.questions.map((q) => q.text).join('；')}` : '',
          ].filter(Boolean).join('　'),
        })),
        default: [],
      }) as string[];
      list.forEach((c, i) => {
        done.add(c.key);
        if (!picked.includes(String(i))) return;
        // 选了 = 玩家确认了前提
        for (const q of c.questions) tx.qAnswers.set(q.id, { value: true, scope: q.scope });
        if (!canPay(tx, c.owner, c.cost)) return;   // 同一决定里先选的可能已经用掉了反应
        fire(tx, spec, c);
        fired.push(c);
        any = true;
      });
    }
    if (!any) break;
  }
  return fired;
}

const KIND_CN: Record<string, string> = { attack: '攻击', save: '豁免', check: '检定' };
/** 「谁的什么掷出了多少」—— 暂停时让人知道为什么停。攻击检定不写 AC（可能是怪物的，不给玩家看） */
function rollText(spec: WindowSpec, a: string, t: string): string {
  const r = (spec.refresh?.() ?? spec.scope.roll) as Record<string, unknown> | undefined;
  if (!r || r.total == null) return `${a} 的检定已掷出。`;
  const what = r.sub === 'initiative' ? '先攻' : r.sub === 'deathSave' ? '死亡豁免' : r.sub === 'concentration' ? '专注检定'
    : r.kind === 'attack' ? `对 ${t || '目标'} 的攻击` : KIND_CN[String(r.kind)] ?? '检定';
  const mode = r.adv ? '（优势）' : r.disadv ? '（劣势）' : '';
  const vs = r.vs != null && r.kind !== 'attack' ? `，对 DC ${r.vs}` : '';
  const fail = r.failing ? '，按现在会失败' : '';
  return `${a} 的${what}掷出 d20 = ${r.natural}${mode}，总值 ${r.total}${vs}${fail}。`;
}

function windowPrompt(tx: Tx, spec: WindowSpec): string {
  const a = spec.actor ? nameOf(tx, spec.actor) : '';
  const t = spec.target ? nameOf(tx, spec.target) : '';
  switch (spec.event) {
    case 'attackHit': {
      const r = (spec.refresh?.() ?? spec.scope.roll) as Record<string, unknown> | undefined;
      return `${a} 的攻击命中了 ${t}${r?.total != null ? `（总值 ${r.total}${r.vs != null ? ` 对 AC ${r.vs}` : ''}${r.crit ? '，重击' : ''}）` : ''}。要使用以下能力吗？`;
    }
    case 'damageIncoming': return `${t} 即将受到伤害。要使用以下能力吗？`;
    case 'd20Rolled': return `${rollText(spec, a, t)}要使用以下能力吗？`;
    case 'damageTaken': return `${t} 受到了伤害。要使用以下能力吗？`;
    case 'spellCast': {
      const sp = (spec.scope.event as Record<string, unknown> | undefined)?.spell;
      return `${a} 正在施展${sp ? `「${sp}」` : '法术'}。要使用以下能力吗？`;
    }
    default: return `「${spec.event}」时机：要使用以下能力吗？`;
  }
}

/** 给界面用：某人当前的经济是否被状态挡住 */
export function economyAvailable(tx: Tx, id: Id, kind: 'action' | 'bonus' | 'reaction'): boolean {
  if (blockedEconomy(tx, id).has(kind)) return false;
  const c = tx.state.combatants[id];
  if (!c) return false;
  return tx.state.round === null || c.economy[kind] > 0;
}
/**
 * 应用一条窗口修改。大部分 op 直接交给窗口的处理函数；
 * `cancelUnlessSave` 由**引擎**先替那个生物掷一次豁免，失败了才发 cancel ——
 * 「先豁免、失败了才打断」这类规则靠它（窗口里 `do` 的执行时机不一定在结算之前）。
 */
function applyModify(tx: Tx, spec: WindowSpec, c: TriggerCand, m: Modify, depth = 0): void {
  if (!spec.modify) return;
  // 写计划书的几个 op：直接改 CastPlan，窗口关掉之后结算照它走
  if (m.op === 'setDc' || m.op === 'setAttackBonus' || m.op === 'setDamageType') {
    const plan = tx.windowPlan;
    if (!plan) {
      tx.emit('note', { text: `${c.label}：这里没有正在施展的法术可改` }, spec.cause);
      return;
    }
    const env = makeEnv(tx, { self: c.owner, target: spec.scope.attacker ?? spec.actor });
    if (m.op === 'setDc') { const v = runInt(m.value, env); if (!(v instanceof Unknown)) plan.dc = v; }
    else if (m.op === 'setAttackBonus') { const v = runInt(m.value, env); if (!(v instanceof Unknown)) plan.attackBonus = v; }
    else plan.damageType = normType(m.value);
    plan.notes.push(`${c.label}：${m.op === 'setDamageType' ? `伤害类型改为${normType(m.value)}` : m.op === 'setDc' ? '改写了豁免 DC' : '改写了攻击加值'}`);
    return;
  }
  // 需要先掷豁免的两种 op
  const isSaveOp = m.op === 'cancelUnlessSave' || m.op === 'unlessSave';
  if (!isSaveOp) { spec.modify(m, c); return; }
  if (depth > 1) return;   // 不嵌套太深
  const who = m.against === 'self' ? c.owner : (spec.scope.attacker ?? spec.actor);
  if (!who || !tx.state.combatants[who]) {
    if (m.op === 'cancelUnlessSave') spec.modify({ op: 'cancel', refundSlot: m.refundSlot }, c);
    return;
  }
  const tv = effectiveView(tx, who);
  const env = makeEnv(tx, { self: c.owner, target: who });
  const dcRaw = runInt(m.dc, env);
  const dc = dcRaw instanceof Unknown ? 0 : dcRaw;
  const r = d20Test(tx, {
    roller: who, kind: 'save', ability: m.ability, bonus: tv.save[m.ability], vs: dc,
    label: `${c.label}：${ABIL_CN[m.ability]}豁免`, cause: spec.cause,
  });
  tx.emit(r.outcome === 'success' ? 'saveSucceeded' : 'saveFailed', { actor: c.owner, target: who, ability: m.ability, dc, label: c.label }, r.seq);
  if (m.op === 'cancelUnlessSave') {
    if (r.outcome === 'success') {
      tx.emit('note', { text: `${nameOf(tx, who)} 豁免成功，「${c.label}」没能打断它` }, r.seq);
      return;
    }
    spec.modify({ op: 'cancel', refundSlot: m.refundSlot !== false }, c);
    return;
  }
  // unlessSave：按结果应用子修改
  const branch = r.outcome === 'success' ? m.onSuccess : m.onFail;
  if (!branch?.length) {
    if (r.outcome === 'success') tx.emit('note', { text: `${nameOf(tx, who)} 豁免成功` }, r.seq);
    return;
  }
  for (const sub of branch) applyModify(tx, spec, c, sub, depth + 1);
}
