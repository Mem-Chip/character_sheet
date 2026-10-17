import { ABIL_CN, Dice, Unknown, run, runBool, runDice, runInt, type ExprSrc, type Question, type Value } from '../expr';
import { applyDamagePacket, applyHeal, grantTempHp, maxDiceFor, normType, rollComponent, type DamageComponent, type DamagePacket } from './damage';
import { controllerOf, d20Test, rollValue } from './d20';
import { activeTemplates, applyEffect, effectiveView, effectsOf, endEffect, skillBonus, startConcentration } from './effects';
import { makeEnv, nameOf, type ScopeData } from './scope';
import { entryOf } from './collect';
import { placeSummon, shove } from './space';
import { blockedEconomy, fireWindow } from './triggers';
import { Rejected, type Tx } from './tx';
import { makeCombatant, makeView } from './view';
import type { Action, ActiveEffect, AttackInfo, AttackRow, CombatantView, Cost, Duration, EffectId, Entry, Id, Modify, Node, Zone } from './types';

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
  /** attackHit 窗口里：addDamage 往这里加 */
  packet?: DamagePacket;
  /** 最近一次豁免的 DC（saveEnds 缺省用它） */
  dc?: number;
  originKind?: ActiveEffect['origin']['kind'];
  /** number / choose 节点选出来的值（同一次执行里共享） */
  vars?: Record<string, number | string>;
  /** 窗口里能改正在结算的东西（modify 节点用）；不在 before 窗口里就没有 */
  modify?: (m: Modify) => void;
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

/** 伤害类型字段：含「.」的当表达式（`attack.damageType`），否则是字面类型名 */
function typeOf(tx: Tx, ctx: ExecCtx, t: string | undefined): string {
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
        roller: ctx.self, kind: 'check', ability: n.ability, skill: n.skill, bonus, vs: dc,
        label: `${ABIL_CN[n.ability]}${n.skill ? `（${n.skill}）` : ''}检定`, cause: ctx.cause,
      });
      runNodes(tx, r.outcome === 'success' ? n.onSuccess : n.onFail, { ...ctx, roll: rollValue(r), cause: r.seq, dc });
      return;
    }
    case 'damage': return runDamageNodes(tx, [n], ctx);
    case 'addDamage': {
      if (!ctx.packet) throw new Error('addDamage 只能用在命中窗口里（偷袭、至圣斩这类）');
      ctx.packet.components.push({ dice: dice(tx, ctx, n.dice, ctx.actionName), type: typeOf(tx, ctx, n.type), from: ctx.actionName });
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
      const delta = num(tx, ctx, n.delta, '资源变化');
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
      // 带 when 的选项：条件明确不满足就不列出来（圣疗「移除中毒」要求目标中毒、能量池至少 5 点）
      const open = n.options.map((o, i) => ({ o, i })).filter(({ o }) => {
        if (o.when === undefined) return true;
        const v = runBool(o.when, env(tx, ctx));
        return v !== false;
      });
      if (!open.length) {
        tx.emit('note', { text: `${ctx.actionName}：${n.prompt}——眼下没有可选的项`, owner: ctx.self }, ctx.cause);
        return;
      }
      const picked = open.length === 1 && (n.count ?? 1) === 1 ? [String(open[0].i)] : tx.decide({
        kind: 'choose', to: controllerOf(tx, ctx.self), prompt: n.prompt, multi: (n.count ?? 1) > 1,
        options: open.map(({ o, i }) => ({ id: String(i), label: o.label })),
        default: [String(open[0].i)],
      });
      const list = (Array.isArray(picked) ? picked : [picked]).map(String).slice(0, n.count ?? 1);
      for (const i of list) {
        const o = n.options[Number(i)] ?? n.options.find((x) => x.label === i || x.value === i);
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
      // 推离 / 拉近：有地图就真的动棋子；传送、或者不在地图上 → 提示人手动拖
      const done = n.mode !== 'teleport' && !!ctx.target && shove(tx, ctx.self, ctx.target, ft, n.mode, ctx.cause);
      if (!done) tx.emit('note', { kind: 'move', text: `${ctx.actionName}：${n.mode === 'push' ? '推离' : n.mode === 'pull' ? '拉近' : '传送'} ${ft} 尺（请在地图上移动）`, target: ctx.target }, ctx.cause);
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
        source: ctx.self, entryKey: ctx.entryKey, on: n.on, do: n.do, affects: n.affects ?? 'all',
        oncePerTurn: n.oncePerTurn ?? true, confirm: false, link: ctx.concentrationId ?? null,
        untilRound: n.rounds && round !== null ? round + n.rounds : null, hits: {}, ...(ctx.slot !== undefined ? { slot: ctx.slot } : {}),
      };
      tx.emit('zoneCreated', { zone }, ctx.cause);
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
  const bonus = num(tx, ctx, n.bonus ?? 'self.spell.atk', '攻击加值');
  const acBefore = effectiveView(tx, target).ac;
  const r = d20Test(tx, {
    roller: ctx.self, kind: 'attack', attack, target, bonus, vs: acBefore,
    critRange: n.critRange !== undefined ? num(tx, ctx, n.critRange, '重击范围') : undefined,
    label: `${ctx.actionName} 攻击检定`, cause: ctx.cause,
  });
  const hctx: ExecCtx = { ...ctx, attack, attacker: ctx.self, roll: rollValue(r), cause: r.seq };

  const miss = (why?: string) => {
    const seq = tx.emit('attackMissed', { attacker: ctx.self, target, label: ctx.actionName, total: r.total, vs: r.vs, why }, r.seq);
    runNodes(tx, n.onMiss, { ...hctx, target, cause: seq });
    fireWindow(tx, { event: 'attackMissed', window: 'after', actor: ctx.self, target, scope: { attack, roll: rollValue(r) }, cause: seq });
  };
  if (r.outcome !== 'hit') { miss(); return; }

  // 命中：先建伤害包（防守方的减伤会标记在包上），再走三段命中窗口
  const dmgNodes = (n.onHit ?? []).filter((x): x is Extract<Node, { kind: 'damage' }> => x.kind === 'damage');
  const packet: DamagePacket = {
    source: ctx.self, target, components: [], crit: r.crit, label: ctx.actionName, attack, reduce: [],
  };
  for (const d of dmgNodes) packet.components.push({ dice: dice(tx, hctx, d.dice ?? '0', ctx.actionName), type: typeOf(tx, hctx, d.type), from: ctx.actionName });
  const hitSeq = tx.emit('attackHit', { attacker: ctx.self, target, label: ctx.actionName, total: r.total, vs: r.vs, crit: r.crit }, r.seq);

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
  const dc = num(tx, ctx, n.dc, '豁免 DC');
  const tv = effectiveView(tx, target);
  // 由目标选择属性时，替目标选加值高的那个
  const ability = Array.isArray(n.ability) ? n.ability.reduce((best, a) => (tv.save[a] > tv.save[best] ? a : best)) : n.ability;
  const forced = tx.emit('saveForced', { actor: ctx.self, target, ability, dc, label: ctx.actionName }, ctx.cause);
  fireWindow(tx, { event: 'saveForced', window: 'after', actor: ctx.self, target, scope: {}, cause: forced });
  const r = d20Test(tx, {
    roller: target, kind: 'save', ability, bonus: tv.save[ability], vs: dc,
    label: `${ABIL_CN[ability]}豁免（${ctx.actionName}）`, cause: forced,
  });
  const ok = r.outcome === 'success';
  const seq = tx.emit(ok ? 'saveSucceeded' : 'saveFailed', { actor: ctx.self, target, ability, dc, label: ctx.actionName }, r.seq);
  // 成功分支里有减半的伤害 = 「豁免成功只受一半」（反射闪避据此把成功改成不受伤害、失败改成一半）
  const half = (n.onSuccess ?? []).some((x) => x.kind === 'damage' && x.scale === 0.5);
  runNodes(tx, ok ? n.onSuccess : n.onFail, { ...ctx, target, roll: rollValue(r), cause: seq, dc, save: { ability, success: ok, half } });
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
  for (const [id, comps] of byRecipient) {
    applyDamagePacket(tx, {
      source: ctx.self, target: id, components: comps.map((c) => ({ ...c })), crit: false, label: ctx.actionName,
      scale, reduce: [], save: ctx.save, max: maxDmg() || undefined,
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
export function payCosts(tx: Tx, id: Id, costs: Cost[], label: string, cause: number | null, slotLevel?: number): number | undefined {
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
  actor: Id;
  actionKey: string;
  action: Action;
  targets: Id[];
  slotLevel?: number;
  force?: boolean;
  cause: number | null;
  viaReaction?: boolean;
  options?: Record<string, unknown>;
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
export function effectiveAction(tx: Tx, actor: Id, action: Action): Action {
  return quickenOf(tx, actor, action) ? { ...action, activation: 'bonus' } : action;
}

export function executeAction(tx: Tx, o: ExecuteOpts): void {
  const quick = o.options?.as === 'reaction' ? undefined : quickenOf(tx, o.actor, o.action);
  const actor = o.actor;
  const action = quick ? { ...o.action, activation: 'bonus' as const } : o.action;
  const c = tx.state.combatants[actor];
  if (!c) throw new Rejected(`没有参与者 ${actor}`);
  const isSpell = (action.tags ?? []).includes('spell');
  const asReaction = o.options?.as === 'reaction';
  const act = asReaction ? 'reaction' : typeof action.activation === 'string' ? action.activation : 'special';
  const costs = actionCosts(action, asReaction);
  const entryKey = o.actionKey.split('#')[0];

  if (!o.force) {
    if (c.live.dead) throw new Rejected(`${c.name} 已经死亡`);
    const blocked = blockedEconomy(tx, actor);
    if ((act === 'action' || act === 'bonus' || act === 'reaction') && blocked.has(act)) {
      throw new Rejected(`${c.name} 现在无法执行${ACT_CN[act]}（失能）`);
    }
    const cannot = new Set(activeTemplates(tx, actor).flatMap((a) => a.tpl.flags?.cannot ?? []));
    if (isSpell && cannotCastSpell(tx, actor, action)) throw new Rejected(`${c.name} 现在不能施法`);
    if (action.concentration && cannot.has('concentrate')) throw new Rejected(`${c.name} 现在无法保持专注`);
    if (action.requires !== undefined) {
      const ok = resolveBool(tx, action.requires, { self: actor, slot: o.slotLevel }, actor, action.name);
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
        const max = maxTargets(tx, actor, action, o.slotLevel) ?? Infinity;
        if (o.targets.length > max) throw new Rejected(`「${action.name}」最多 ${max} 个目标，选了 ${o.targets.length} 个`);
      }
      if (!t.repeat && new Set(o.targets).size < o.targets.length) throw new Rejected(`「${action.name}」不能重复选同一个目标`);
      for (const tid of o.targets) {
        if (!tx.state.combatants[tid]) throw new Rejected(`目标 ${tid} 不在遭遇中`);
        const forbidden = activeTemplates(tx, actor).some((a) => a.tpl.flags?.forbidTarget === 'source' && a.effect.source === tid);
        if (forbidden && tx.state.combatants[tid]) throw new Rejected(`${c.name} 处于魅惑状态，不能以 ${nameOf(tx, tid)} 为目标`);
        // 范围法术里「你选择的生物」（filter 写成 ask(...)）：人已经在选目标时挑过了，不再逐个问
        const picked = t.type === 'area' && typeof t.filter === 'string' && /^\s*ask\(/.test(t.filter);
        if (t.filter !== undefined && !picked) {
          const ok = resolveBool(tx, t.filter, { self: actor, target: tid, slot: o.slotLevel }, actor, `${action.name} 的目标限制`);
          if (!ok) throw new Rejected(`${nameOf(tx, tid)} 不是「${action.name}」的合法目标`);
        }
      }
    }
  }

  const seq = tx.emit('actionUsed', {
    actor, action: action.name, key: o.actionKey, targets: o.targets, activation: act, slotLevel: o.slotLevel ?? null,
  }, o.cause);

  // 武器攻击：消耗「攻击」动作给的攻击次数（额外攻击）
  if (inCombat(tx) && costs.some((k) => 'economy' in k && k.economy === 'attack')) {
    if (c.economy.attacksLeft > 0) {
      tx.emit('economyChanged', { id: actor, patch: { attacksLeft: c.economy.attacksLeft - 1 } }, seq);
    } else if (o.force || c.economy.action > 0) {
      const per = effectiveView(tx, actor).attacksPerAction;
      tx.emit('economyChanged', { id: actor, patch: { action: Math.max(0, c.economy.action - 1), attacksLeft: per - 1 } }, seq);
      tx.emit('note', { text: `${c.name} 执行「攻击」动作（本动作共 ${per} 次攻击）`, owner: actor }, seq);
    } else {
      throw new Rejected(`${c.name} 没有剩余的攻击次数，也没有动作了`);
    }
  }
  // 没指定环阶、效果又随环阶变化（窗口里触发的至圣斩）：问用几环
  let slotLevel = o.slotLevel;
  const slotCost = costs.find((k): k is Extract<Cost, { slot: unknown }> => 'slot' in k);
  if (slotLevel === undefined && slotCost && scalesWithSlot(action)) {
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
  const slot = payCosts(tx, actor, costs, action.name, seq, slotLevel);
  if (quick) endEffect(tx, quick.id, `用在了「${action.name}」上（附赠动作施放）`, seq);
  if (slot !== undefined && inCombat(tx) && isSpell) tx.emit('economyChanged', { id: actor, patch: { slotSpellCast: true } }, seq);
  if (isSpell) {
    // 窗口里能读到这次施法的目标（role: 'target' 就是「被打的那个」；范围法术读 event.targets）
    const castTargets = o.targets.slice();
    const evScope = { actor, spell: action.name, key: entryKey, slotLevel: slot ?? 0, targets: castTargets };
    const castTarget = castTargets.length === 1 ? castTargets[0] : undefined;
    let countered: { by: string; refundSlot: boolean } | null = null;
    fireWindow(tx, {
      event: 'spellCast', window: 'before', actor, target: castTarget,
      scope: { slot, event: evScope },
      cause: seq,
      modify: (m, by) => {
        if (m.op === 'cancel') countered = { by: by.label, refundSlot: m.refundSlot !== false };
      },
    });
    if (countered !== null) {
      const { by, refundSlot } = countered as { by: string; refundSlot: boolean };
      if (slot !== undefined && refundSlot) {
        tx.emit('slotUsed', { id: actor, level: slot, used: Math.max(0, (c.live.slotsUsed[slot] ?? 1) - 1) }, seq);
        if (inCombat(tx)) tx.emit('economyChanged', { id: actor, patch: { slotSpellCast: false } }, seq);
      }
      tx.emit('note', {
        text: `「${action.name}」被「${by}」打断，法术失效${slot !== undefined ? (refundSlot ? '（法术位不消耗）' : '（法术位已消耗）') : ''}`,
        owner: actor,
      }, seq);
      tx.emit('actionDone', { actor, action: action.name }, seq);
      return;
    }
    const cast = tx.emit('spellCast', { actor, spell: action.name, key: entryKey, slotLevel: slot ?? null, targets: castTargets }, seq);
    fireWindow(tx, { event: 'spellCast', window: 'after', actor, target: castTarget, scope: { slot, event: evScope }, cause: cast });
  }

  let concentrationId: EffectId | undefined;
  if (action.concentration) {
    concentrationId = startConcentration(tx, actor, action.name, action.concentration, entryKey, seq).id;
  }
  const form = o.options?.form as CombatantView | undefined;
  const ctx: ExecCtx = {
    self: actor,
    targets: o.targets.slice(),
    target: o.targets.length === 1 ? o.targets[0] : undefined,
    slot,
    entryKey,
    actionName: action.name,
    cause: seq,
    locals: {},
    concentrationId,
    concentrationDuration: action.concentration,
    damageDefs: collectDamageDefs(action.root),
    originKind: isSpell ? 'spell' : (action.tags ?? []).includes('weapon') ? 'item' : 'feature',
    vars: {},
    ...(o.area ? { area: o.area } : {}),
    ...(form ? { form } : {}),
    ...o.window,
  };
  runNodes(tx, action.root, ctx);
  tx.emit('actionDone', { actor, action: action.name }, seq);
}
