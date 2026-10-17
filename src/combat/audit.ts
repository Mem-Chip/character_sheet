import { T, checkExpr, type ExprSrc, type Ty } from '../expr';
import type { RuleBook } from './rulebook';
import { scopeDef, type ScopeKind } from './scope';
import type { Action, EffectTemplate, Entry, Node, RollMod, Trigger } from './types';

/**
 * 规则数据审计（COMBAT-DESIGN §十二）：数据进库之前、房规保存之前都跑一遍。
 *
 * 查的是「写下去了但不会按预期生效」的那一类问题 —— 原项目里这类问题的表现
 * 永远是「静默算错」，只能靠人肉发现：
 *   - 表达式拼错名字 / 类型不对 / 用了当前作用域里没有的东西；
 *   - 效应模板引用、隐含状态引用指向不存在的条目；
 *   - 触发器挂在引擎从不发出的事件上（声明了，永远不触发）；
 *   - 同一个效应在 statics 和 rollMods 里改同一个量（双计）。
 */

/** 引擎会打开窗口的事件（触发器只能挂这些） */
export const WINDOW_EVENTS = new Set([
  'turnStarted', 'turnEnded', 'initiativeRolled', 'spellCast', 'd20Rolled', 'attackHit', 'attackMissed',
  'saveForced', 'damageIncoming', 'damageTaken', 'reducedTo0', 'restCompleted', 'leftReach',
]);

/** 引擎会发出的事件（endsOn 能监听的） */
export const EMITTED_EVENTS = new Set([
  ...WINDOW_EVENTS,
  'actionUsed', 'actionDone', 'saveFailed', 'saveSucceeded', 'damageApplied', 'damageRolled', 'healed', 'tempHpGained',
  'effectApplied', 'effectEnded', 'turnEnding', 'roundStarted', 'combatStarted', 'combatEnded', 'died', 'timeAdvanced',
  'moved', 'zoneHit',
]);

const NODE_KINDS = new Set([
  'attack', 'save', 'check', 'damage', 'addDamage', 'heal', 'tempHp', 'applyEffect', 'removeEffect', 'extendEffect', 'endConcentration',
  'resource', 'economy', 'choose', 'if', 'forEach', 'repeat', 'move', 'note', 'number', 'modify', 'zone', 'summon',
]);
const ROLL_OPS = new Set(['adv', 'disadv', 'noAdv', 'add', 'addDice', 'autoFail', 'autoSucceed', 'critRange', 'autoCritOnHit', 'minD20', 'minDie', 'targetAdd', 'maxDice']);
const MODIFY_OPS = new Set(['reroll', 'addToRoll', 'reduceDamage', 'halveDamage', 'doubleDamage', 'setHp', 'cancel', 'evasion', 'succeed', 'redirect', 'absorb', 'clearAdv']);
const STATIC_KINDS = new Set(['ac', 'speed', 'speedSet', 'spellDc', 'resist', 'resistAll', 'immune', 'vuln', 'conditionImmune']);

const NUM = T.num;
const DICE = T.dice;
const BOOL = T.bool;

export function auditRuleBook(book: RuleBook): string[] {
  const out: string[] = [...book.problems];
  for (const key of book.keys()) {
    const e = book.entry(key)!;
    auditEntry(book, key, e, out);
  }
  // 核心参数里的表达式
  try {
    checkExpr(book.coreParam<string>('concentrationDc'), scopeDef('node'), NUM);
  } catch (err) {
    out.push(`core.concentrationDc：${(err as Error).message}`);
  }
  return out;
}

function auditEntry(book: RuleBook, key: string, e: Entry, out: string[]): void {
  const where = (s: string) => `${key} ${s}`;
  const expr = (src: ExprSrc | undefined, scope: ScopeKind, ty: Ty | Ty[], at: string) => {
    if (src === undefined) return;
    try { checkExpr(src, scopeDef(scope), ty); } catch (err) { out.push(`${where(at)}：${(err as Error).message}`); }
  };
  const tplRef = (ref: string | undefined, at: string) => {
    if (!ref) return;
    if (!book.resolveTemplate(ref, key)) out.push(`${where(at)}：效应模板「${ref}」不存在`);
  };
  /** 攻击行的开关位是布尔：写数字会被静默当成真（`reach` 尤其危险 —— 真 = 10 尺触及） */
  const flagsOf = (a: unknown, at: string) => {
    if (!a || typeof a !== 'object') return;
    for (const k of ['melee', 'ranged', 'reach', 'finesse']) {
      const v = (a as Record<string, unknown>)[k];
      if (v !== undefined && typeof v !== 'boolean') {
        out.push(`${where(`${at}.${k}`)}：要写 true / false（${k === 'reach' ? '真 = 10 尺触及，不是几尺的意思' : '写数字会被当成真'}）`);
      }
    }
  };

  const nodes = (list: Node[] | undefined, at: string) => {
    (list ?? []).forEach((n, i) => node(n, `${at}[${i}]`));
  };
  const node = (n: Node, at: string) => {
    if (!NODE_KINDS.has(n.kind)) { out.push(`${where(at)}：未知节点类型「${n.kind}」`); return; }
    switch (n.kind) {
      case 'attack':
        expr(n.bonus, 'node', NUM, `${at}.bonus`);
        expr(n.critRange, 'node', NUM, `${at}.critRange`);
        flagsOf(n.attack, `${at}.attack`);
        nodes(n.onHit, `${at}.onHit`);
        nodes(n.onMiss, `${at}.onMiss`);
        break;
      case 'save':
      case 'check':
        expr(n.dc, 'node', NUM, `${at}.dc`);
        nodes(n.onFail, `${at}.onFail`);
        nodes(n.onSuccess, `${at}.onSuccess`);
        break;
      case 'damage':
        if (!n.dice && !n.ref) out.push(`${where(at)}：伤害节点既没有 dice 也没有 ref`);
        expr(n.dice, 'node', DICE, `${at}.dice`);
        if (n.type && /^[a-z]+\./.test(n.type)) expr(n.type, 'node', T.str, `${at}.type`);
        break;
      case 'addDamage':
        expr(n.dice, 'node', DICE, `${at}.dice`);
        if (/^[a-z]+\./.test(n.type)) expr(n.type, 'node', T.str, `${at}.type`);
        break;
      case 'heal':
      case 'tempHp':
        expr(n.amount, 'node', DICE, `${at}.amount`);
        break;
      case 'applyEffect':
        if (!n.template && !n.inline) out.push(`${where(at)}：applyEffect 既没有 template 也没有 inline`);
        tplRef(n.template, `${at}.template`);
        if (n.inline) template(n.inline, `${at}.inline`);
        expr(n.potency, 'node', NUM, `${at}.potency`);
        for (const [k, v] of Object.entries(n.state ?? {})) expr(v, 'node', T.any, `${at}.state.${k}`);
        if (n.duration) duration(n.duration, `${at}.duration`);
        break;
      case 'extendEffect':
        tplRef(n.template, `${at}.template`);
        break;
      case 'resource':
        expr(n.delta, 'node', NUM, `${at}.delta`);
        break;
      case 'economy':
        expr(n.move, 'node', NUM, `${at}.move`);
        break;
      case 'choose':
        n.options.forEach((o, i) => {
          expr(o.when, 'node', BOOL, `${at}.options[${i}].when`);
          nodes(o.do, `${at}.options[${i}]`);
        });
        break;
      case 'number':
        if (!n.var) out.push(`${where(at)}：number 节点缺少 var（选出来的数放在哪）`);
        expr(n.min, 'node', NUM, `${at}.min`);
        expr(n.max, 'node', NUM, `${at}.max`);
        expr(n.default, 'node', NUM, `${at}.default`);
        break;
      case 'if':
        expr(n.when, 'node', BOOL, `${at}.when`);
        nodes(n.then, `${at}.then`);
        nodes(n.else, `${at}.else`);
        break;
      case 'forEach':
        nodes(n.do, `${at}.do`);
        break;
      case 'repeat':
        expr(n.n, 'node', NUM, `${at}.n`);
        nodes(n.do, `${at}.do`);
        break;
      case 'move':
        expr(n.ft, 'node', NUM, `${at}.ft`);
        break;
      case 'zone':
        if (!n.on?.length) out.push(`${where(at)}：zone 节点缺少 on（进入 / 回合开始 / 回合结束）`);
        for (const w of n.on ?? []) if (!['enter', 'turnStart', 'turnEnd'].includes(w)) out.push(`${where(at)}：zone 的 on 不认识「${w}」`);
        nodes(n.do, `${at}.do`);
        break;
      case 'modify':
        for (const m of n.modify ?? []) {
          if (!MODIFY_OPS.has(m.op)) out.push(`${where(at)}：未知修改「${m.op}」`);
          if ('value' in m) expr(m.value, 'node', m.op === 'addToRoll' || m.op === 'reduceDamage' ? DICE : NUM, `${at}.modify`);
        }
        break;
      case 'summon':
        if (!n.name) out.push(`${where(at)}：summon 节点缺少 name`);
        expr(n.count, 'node', NUM, `${at}.count`);
        expr(n.ac, 'node', NUM, `${at}.ac`);
        expr(n.hp, 'node', NUM, `${at}.hp`);
        expr(n.speed, 'node', NUM, `${at}.speed`);
        expr(n.pb, 'node', NUM, `${at}.pb`);
        expr(n.attacksPerAction, 'node', NUM, `${at}.attacksPerAction`);
        (n.attacks ?? []).forEach((a, i) => {
          expr(a.bonus, 'node', NUM, `${at}.attacks[${i}].bonus`);
          expr(a.damage, 'node', DICE, `${at}.attacks[${i}].damage`);
          flagsOf(a, `${at}.attacks[${i}]`);
          (a.extra ?? []).forEach((x, j) => expr(x.dice, 'node', DICE, `${at}.attacks[${i}].extra[${j}].dice`));
        });
        (n.actions ?? []).forEach((a) => action(a, `${at}.actions[${a.id}]`));
        (n.triggers ?? []).forEach((t) => trigger(t, `${at}.triggers[${t.id}]`));
        (n.rollMods ?? []).forEach((m, i) => rollMod(m, `${at}.rollMods[${i}]`));
        break;
      default:
        break;
    }
  };

  const rollMod = (m: RollMod, at: string) => {
    if (!ROLL_OPS.has(m.op)) out.push(`${where(at)}：未知检定修正「${m.op}」`);
    if (!m.label) out.push(`${where(at)}：检定修正缺少 label（回执上要显示来源）`);
    expr(m.when, 'rollMod', BOOL, `${at}.when`);
    const vt = m.op === 'add' || m.op === 'addDice' ? DICE : NUM;
    expr(m.value, 'rollMod', vt, `${at}.value`);
    if ((m.op === 'add' || m.op === 'addDice' || m.op === 'critRange' || m.op === 'minD20' || m.op === 'minDie' || m.op === 'targetAdd') && m.value === undefined) {
      out.push(`${where(at)}：「${m.op}」需要 value`);
    }
  };

  const trigger = (t: Trigger, at: string) => {
    for (const ev of [t.on].flat()) if (!WINDOW_EVENTS.has(ev)) out.push(`${where(at)}：触发器挂在「${ev}」上，但引擎不会为它打开窗口`);
    if (t.deferTo && !WINDOW_EVENTS.has(t.deferTo)) out.push(`${where(at)}：deferTo「${t.deferTo}」不是窗口事件`);
    expr(t.when, 'trigger', BOOL, `${at}.when`);
    nodes(t.do, `${at}.do`);
    for (const m of t.modify ?? []) {
      if (!MODIFY_OPS.has(m.op)) out.push(`${where(at)}：未知修改「${m.op}」`);
      if ('value' in m) expr(m.value, 'trigger', m.op === 'addToRoll' || m.op === 'reduceDamage' ? DICE : NUM, `${at}.modify`);
    }
    if (t.modify?.length && (t.window ?? 'after') === 'after' && !t.deferTo) {
      out.push(`${where(at)}：modify 只能用在 before 窗口（after 时结果已经定了）`);
    }
    if (!t.do?.length && !t.modify?.length) out.push(`${where(at)}：触发器什么也不做（没有 do 也没有 modify）`);
  };

  const duration = (d: NonNullable<EffectTemplate['duration']>, at: string) => {
    for (const c of d.endsOn ?? []) {
      if (!EMITTED_EVENTS.has(c.event)) out.push(`${where(at)}.endsOn：引擎不会发出「${c.event}」事件`);
      expr(c.when, 'endsOn', BOOL, `${at}.endsOn`);
    }
    if (d.saveEnds) expr(d.saveEnds.dc, 'node', NUM, `${at}.saveEnds.dc`);
  };

  const template = (tpl: EffectTemplate, at: string) => {
    for (const s of tpl.statics ?? []) {
      if (!STATIC_KINDS.has(s.kind)) out.push(`${where(at)}：未知静态修正「${s.kind}」`);
      if (s.kind === 'ac' || s.kind === 'speed' || s.kind === 'spellDc') expr(s.bonus, 'static', NUM, `${at}.statics`);
    }
    (tpl.rollMods ?? []).forEach((m, i) => rollMod(m, `${at}.rollMods[${i}]`));
    (tpl.triggers ?? []).forEach((t, i) => trigger(t, `${at}.triggers[${i}]`));
    for (const ref of tpl.implies ?? []) tplRef(ref, `${at}.implies`);
    nodes(tpl.onApply, `${at}.onApply`);
    nodes(tpl.onEnd, `${at}.onEnd`);
    if (tpl.duration) duration(tpl.duration, `${at}.duration`);
    if (tpl.aura) aura(tpl.aura, `${at}.aura`);
    // 双计：同一个效应既在 statics 里改 AC，又在 rollMods 里改「被攻击时的 AC」
    if ((tpl.statics ?? []).some((s) => s.kind === 'ac') && (tpl.rollMods ?? []).some((m) => m.op === 'targetAdd')) {
      out.push(`${where(at)}：同一个效应在 statics 和 rollMods 里都改了 AC（会双计，见设计稿 §0.2）`);
    }
  };

  const aura = (a: NonNullable<Entry['auras']>[number], at: string) => {
    expr(a.requires, 'aura', BOOL, `${at}.requires`);
    (a.grant.rollMods ?? []).forEach((m, i) => rollMod(m, `${at}.grant.rollMods[${i}]`));
    (a.grant.triggers ?? []).forEach((t, i) => trigger(t, `${at}.grant.triggers[${i}]`));
  };

  const action = (a: Action, at: string) => {
    if (a.activation === 'reaction' && !a.trigger) out.push(`${where(at)}：反应型动作必须写 trigger（什么时候可以用）`);
    if (a.trigger) {
      for (const ev of [a.trigger.on].flat()) if (!WINDOW_EVENTS.has(ev)) out.push(`${where(at)}.trigger：引擎不会为「${ev}」打开窗口`);
      expr(a.trigger.when, 'trigger', BOOL, `${at}.trigger.when`);
    }
    expr(a.requires, 'action', BOOL, `${at}.requires`);
    if (a.targeting) {
      expr(a.targeting.count, 'action', NUM, `${at}.targeting.count`);
      expr(a.targeting.filter, 'action', BOOL, `${at}.targeting.filter`);
    }
    for (const c of a.cost ?? []) if ('n' in c && c.n !== undefined) expr(c.n, 'action', NUM, `${at}.cost`);
    nodes(a.root, `${at}.root`);
  };

  (e.actions ?? []).forEach((a) => action(a, `动作「${a.id}」`));
  (e.triggers ?? []).forEach((t) => trigger(t, `触发器「${t.id}」`));
  (e.rollMods ?? []).forEach((m, i) => rollMod(m, `rollMods[${i}]`));
  (e.auras ?? []).forEach((a) => aura(a, `灵光「${a.id}」`));
  for (const [name, tpl] of Object.entries(e.effects ?? {})) template(tpl, `效应「${name}」`);
}
