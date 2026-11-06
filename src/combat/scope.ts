import {
  ABILS, T, Unknown, isAbility, isRef, parseDice,
  type CmpOp, type EvalEnv, type FnImpl, type FnSig, type Question, type RefShape, type RefValue, type ScopeDef, type Ty, type Value,
} from '../expr';
import { effectiveView, exhaustionOf, findEffect, hasCondition, concentrationOf } from './effects';
import { actionValue, currentAction } from './instance';
import type { Tx } from './tx';
import type { ActiveEffect, AttackInfo, Id } from './types';

/**
 * 表达式在战斗里的作用域：类型定义（构建期检查用）+ 运行时环境（求值用）。
 * COMBAT-DESIGN §2.3–2.5。
 */

/* ============================================================================
 * 类型定义（构建期）
 * ========================================================================== */

const abilObj = T.obj(Object.fromEntries(ABILS.map((a) => [a, T.num])));
const DICE_CELL = /^\s*\d*d\d+(\s*[+-]\s*\d+)?\s*$/i;

export const REF_SHAPE: RefShape = {
  fields: {
    id: T.str, name: T.str, side: T.str, kind: T.str,
    hp: T.num, tempHp: T.num, hpMax: T.num, ac: T.num, speed: T.num, pb: T.num, level: T.num, initiative: T.num,
    exhaustion: T.num, size: T.str, type: T.str,
    mod: abilObj, score: abilObj, save: abilObj,
    spell: T.obj({ dc: T.num, atk: T.num, mod: T.num }),
    levels: T.open,
    dead: T.bool, concentrating: T.bool,
  },
  methods: {
    has: { params: [T.str], returns: T.bool, doc: '是否处于某状态（含隐含的）' },
    hasEffect: { params: [T.str], returns: T.bool, doc: '身上是否有某个效应（名字或键）' },
    effect: { params: [T.str], returns: T.open, doc: '取效应实例：{id, name, key, state, source}' },
    hasSource: { params: [T.str], returns: T.bool, doc: '是否拥有某规则条目（特性、专长、法术）' },
    levelOf: { params: [T.str], returns: T.num, doc: '某职业的等级' },
    wearing: { params: [T.str], returns: T.bool, doc: "是否着装某类护甲：'LA' 'MA' 'HA' 'S'" },
    isEnemyOf: { params: [T.ref], returns: T.bool },
    isAllyOf: { params: [T.ref], returns: T.bool },
    resource: { params: [T.str], returns: T.num, doc: '资源剩余次数' },
  },
};

const FUNCS: Record<string, FnSig> = {
  min: { params: [T.num, T.num, T.num], optional: 1, returns: T.num },
  max: { params: [T.num, T.num, T.num], optional: 1, returns: T.num },
  floor: { params: [T.num], returns: T.num },
  ceil: { params: [T.num], returns: T.num },
  abs: { params: [T.num], returns: T.num },
  cond: { params: [T.bool, T.any, T.any], returns: T.any, doc: "按条件二选一：cond(self.levelOf('战士') >= 10, 1d10, 1d8)" },
  classTable: { params: [T.str], returns: T.any, doc: '职业等级表当前行的某一列' },
  dist: { params: [T.ref, T.ref], returns: T.num, doc: '距离（尺）。没有地图时只能和数字比较，变成一个问题' },
  within: { params: [T.ref, T.ref, T.num], returns: T.bool },
  allyWithin: { params: [T.ref, T.num, T.open], optional: 1, returns: T.bool, doc: 'x 周围 ft 尺内有没有 self 的盟友' },
  canSee: { params: [T.ref, T.ref], returns: T.bool },
  ask: { params: [T.str], returns: T.bool, doc: '显式询问' },
  abilityMod: { params: [T.str], returns: T.num, doc: "self 某属性的调整值：abilityMod(attack.ability)" },
  combatant: { params: [T.str], returns: T.ref, doc: '按 id 取参与者（事件载荷里只有 id）' },
  includes: { params: [T.any, T.any], returns: T.bool, doc: "列表里有没有某个值：includes(action.spell.lists, '法师')；第一个是文字时看有没有这一段：includes(action.name, '吐息')" },
};

const ROLL_FULL = T.obj({
  kind: T.str, sub: T.str, ability: T.str, skill: T.str, natural: T.num, total: T.num, vs: T.num, adv: T.bool, disadv: T.bool,
  roller: T.str, target: T.str, crit: T.bool, failing: T.bool, against: T.list(T.str),
});
/** against：这次检定防的是哪些状态（豁免失败会挂上的、豁免成功能摆脱的），includes(roll.against, '中毒') */
const ROLL_PRE = T.obj({ kind: T.str, sub: T.str, ability: T.str, skill: T.str, roller: T.str, target: T.str, against: T.list(T.str) });
const ATTACK = T.obj({
  melee: T.bool, ranged: T.bool, weapon: T.bool, spell: T.bool, unarmed: T.bool, finesse: T.bool, reach: T.bool,
  ability: T.str, damageType: T.str, item: T.str, mastery: T.str,
});
/** 动作实例（instance.ts）：正在结算的那次动作；不在动作里 = null */
const ACTION = T.obj({
  name: T.str, key: T.str, kind: T.str, economy: T.str, onMyTurn: T.bool, by: T.ref,
  spell: T.obj({ level: T.num, slot: T.num, school: T.str, lists: T.list(T.str), concentration: T.bool, ritual: T.bool, range: T.any, components: T.str }),
  attack: ATTACK, targets: T.list(T.ref), targetCount: T.num, marks: T.open, parent: T.open, zone: T.str,
  result: T.obj({ hit: T.bool, crit: T.bool, saved: T.bool, damage: T.num, reducedTo0: T.bool, killed: T.bool }),
  results: T.list(T.open), hitCount: T.num, critCount: T.num, savedCount: T.num, failedCount: T.num, damageTotal: T.num, downedCount: T.num,
  damage: T.obj({ dice: T.dice, die: T.dice, type: T.str, total: T.num, parts: T.list(T.str) }),
});
/** 正在结算的这包伤害；isAttack：是不是攻击（命中）造成的，法术豁免、区域、持续伤害都是 false */
const DAMAGE = T.obj({ type: T.str, amount: T.num, crit: T.bool, save: T.str, saved: T.bool, isAttack: T.bool, parts: T.list(T.str) });

const COMMON: Record<string, Ty> = {
  self: T.ref, source: T.ref,
  pb: T.num, level: T.num, mod: abilObj, score: abilObj,
  ...Object.fromEntries(ABILS.map((a) => [a, T.num])),
  round: T.num,
  turn: T.obj({ isMine: T.bool, of: T.ref }),
  action: ACTION,
  core: T.open,
};

export type ScopeKind = 'action' | 'node' | 'rollMod' | 'trigger' | 'static' | 'endsOn' | 'aura';

const EXTRA: Record<ScopeKind, Record<string, Ty>> = {
  action: { target: T.ref, slot: T.obj({ level: T.num }) },
  node: {
    target: T.ref, attacker: T.ref, slot: T.obj({ level: T.num }),
    roll: ROLL_FULL, attack: ATTACK, damage: DAMAGE, event: T.open, effect: T.open, vars: T.open,
  },
  rollMod: { target: T.ref, attacker: T.ref, attack: ATTACK, roll: ROLL_PRE, effect: T.open },
  trigger: {
    target: T.ref, attacker: T.ref, slot: T.obj({ level: T.num }),
    roll: ROLL_FULL, attack: ATTACK, damage: DAMAGE, event: T.open, effect: T.open, vars: T.open,
  },
  static: { effect: T.open },
  endsOn: { event: T.open, effect: T.open },
  aura: { effect: T.open },
};

const SCOPE_CN: Record<ScopeKind, string> = {
  action: '动作条件', node: '效果节点', rollMod: '检定修正', trigger: '触发器', static: '静态修正', endsOn: '结束条件', aura: '灵光',
};

export function scopeDef(kind: ScopeKind): ScopeDef {
  return { name: SCOPE_CN[kind], roots: { ...COMMON, ...EXTRA[kind] }, funcs: FUNCS, ref: REF_SHAPE };
}

/* ============================================================================
 * 运行时环境
 * ========================================================================== */

export interface ScopeData {
  self: Id;
  /** undefined = 与 self 相同（常驻能力）；null = 没有来源（DM 手动施加的效应） */
  source?: Id | null;
  target?: Id;
  attacker?: Id;
  slot?: number;
  roll?: Record<string, Value>;
  attack?: AttackInfo;
  damage?: Record<string, Value>;
  event?: Record<string, unknown>;
  effect?: ActiveEffect;
  /** number 节点选出来的数 */
  vars?: Record<string, number | string>;
}

export function nameOf(tx: Tx, id: Id): string {
  return tx.state.combatants[id]?.name ?? id;
}

/** 参与者引用。字段按需现算（有效 view + 实时状态），不缓存副本 */
export function refOf(tx: Tx, id: Id): RefValue {
  const c = () => {
    const x = tx.state.combatants[id];
    if (!x) throw new Error(`参与者 ${id} 已不在遭遇中`);
    return x;
  };
  return {
    __ref: true,
    id,
    get(field) {
      const v = () => effectiveView(tx, id);
      switch (field) {
        case 'id': return id;
        case 'name': return c().name;
        case 'side': return c().side;
        case 'kind': return c().kind;
        case 'hp': return c().live.hp;
        case 'tempHp': return c().live.tempHp;
        case 'hpMax': return v().hpMax;
        case 'ac': return v().ac;
        case 'speed': return v().speed;
        case 'pb': return v().pb;
        case 'level': return v().level;
        case 'initiative': return v().initiative;
        case 'size': return v().size;
        case 'type': return v().type;
        case 'exhaustion': return exhaustionOf(tx, id);
        case 'mod': return { ...v().mod };
        case 'score': return { ...v().score };
        case 'save': return { ...v().save };
        case 'spell': { const s = v().spell; return s ? { dc: s.dc, atk: s.atk, mod: s.mod } : null; }
        case 'levels': return { ...v().levels };
        case 'dead': return c().live.dead;
        case 'concentrating': return !!concentrationOf(tx, id);
        default: return undefined;
      }
    },
    call(method, args) {
      const s = (i: number) => String(args[i]);
      switch (method) {
        case 'has': return hasCondition(tx, id, s(0));
        case 'hasEffect': return !!findEffect(tx, id, s(0));
        case 'effect': {
          const e = findEffect(tx, id, s(0));
          return e ? { id: e.id, name: e.name, key: e.key, state: e.state as Record<string, Value>, source: e.source } : null;
        }
        case 'hasSource': {
          const q = s(0);
          return effectiveView(tx, id).sources.some((x) => x === q || x.includes(`:${q}:`) || x.endsWith(`:${q}`));
        }
        case 'levelOf': return effectiveView(tx, id).levels[s(0)] ?? 0;
        case 'wearing': return effectiveView(tx, id).wearing.includes(s(0));
        case 'isEnemyOf': {
          const o = args[0];
          return isRef(o) && o.id !== id && tx.state.combatants[o.id]?.side !== c().side;
        }
        case 'isAllyOf': {
          const o = args[0];
          return isRef(o) && o.id !== id && tx.state.combatants[o.id]?.side === c().side;
        }
        case 'resource': {
          const max = effectiveView(tx, id).resources[s(0)] ?? 0;
          return max - (c().live.resourcesUsed[s(0)] ?? 0);
        }
        default: throw new Error(`参与者没有方法「${method}」`);
      }
    },
  };
}

/**
 * 求值环境。`assumptions` 收集「按推测走」的问题，掷骰回执上要列出来。
 */
export function makeEnv(tx: Tx, d: ScopeData, assumptions?: string[]): EvalEnv {
  const self = d.self;
  const view = () => effectiveView(tx, self);
  const need = <T>(v: T | undefined, name: string): T => {
    if (v === undefined) throw new Error(`当前上下文没有 ${name}`);
    return v;
  };

  /** 问题的统一出口：已有回答 → 用回答；有推测且允许 → 用推测并记下；否则 → 未知 */
  const ask = (q: Question): boolean | Unknown => {
    const a = tx.answerOf(q.id);
    if (a !== undefined) return a;
    if (q.guess !== undefined && tx.state.settings.useGuesses) {
      assumptions?.push(`假设：${q.text.replace(/？$/, '')} —— ${q.guess ? '是' : '否'}`);
      return q.guess;
    }
    return new Unknown([q]);
  };

  /** 「a 与 b 是否在 ft 尺内」—— 和攻击上下文对得上时可以推测（近战 → 是，远程 → 否） */
  const withinQ = (a: Id, b: Id, ft: number): Question => {
    const [x, y] = [a, b].sort();
    let guess: boolean | undefined;
    const pair = d.attack && d.attacker && d.target
      && ((d.attacker === a && d.target === b) || (d.attacker === b && d.target === a));
    if (pair && d.attack) {
      if (d.attack.melee && !d.attack.reach && ft >= 5) guess = true;
      else if (d.attack.ranged && !d.attack.melee && ft <= 5) guess = false;
    }
    return {
      id: `within:${x}:${y}:${ft}`,
      text: `${nameOf(tx, a)} 与 ${nameOf(tx, b)} 相距是否在 ${ft} 尺以内？`,
      subjects: [x, y],
      guess,
      scope: 'roll',
    };
  };

  const within = (a: Id, b: Id, ft: number): boolean | Unknown => {
    const dist = tx.spatial?.distance(a, b);
    if (typeof dist === 'number') return dist <= ft;
    return ask(withinQ(a, b, ft));
  };

  const fns: Record<string, FnImpl> = {
    min: (a) => Math.min(...(a as number[])),
    max: (a) => Math.max(...(a as number[])),
    floor: (a) => Math.floor(a[0] as number),
    ceil: (a) => Math.ceil(a[0] as number),
    abs: (a) => Math.abs(a[0] as number),
    cond: (a) => (a[0] ? a[1] : a[2]),
    classTable: (a) => {
      const col = String(a[0]);
      const v = view().classTable[col];
      if (v === undefined) throw new Error(`${nameOf(tx, self)} 的职业等级表里没有「${col}」这一列`);
      // 骰子格（武艺 1d8、偷袭 3d6）直接给骰子值，才能写 `classTable('武艺') + mod.dex`
      return typeof v === 'string' && DICE_CELL.test(v) ? parseDice(v) : v;
    },
    dist: (a) => {
      const [p, q] = a as RefValue[];
      const dist = tx.spatial?.distance(p.id, q.id);
      if (typeof dist === 'number') return dist;
      // 符号数：只有和数字比较时才变成问题
      return new Unknown([], {
        key: `dist:${p.id}:${q.id}`,
        compare: (op: CmpOp, n: number) => {
          switch (op) {
            case '<=': return within(p.id, q.id, n);
            case '<': return within(p.id, q.id, n - 1);
            case '>': { const r = within(p.id, q.id, n); return r instanceof Unknown ? r : !r; }
            case '>=': { const r = within(p.id, q.id, n - 1); return r instanceof Unknown ? r : !r; }
            default:
              return ask({ id: `dist:${p.id}:${q.id}:${op}${n}`, text: `${nameOf(tx, p.id)} 与 ${nameOf(tx, q.id)} 的距离是否${op === '==' ? '正好' : '不是'} ${n} 尺？`, subjects: [p.id, q.id], scope: 'roll' });
          }
        },
      });
    },
    within: (a) => within((a[0] as RefValue).id, (a[1] as RefValue).id, a[2] as number),
    allyWithin: (a) => {
      const x = (a[0] as RefValue).id;
      const ft = a[1] as number;
      const opts = (a[2] ?? {}) as { exclude?: Value[]; notCond?: string };
      const exclude = (opts.exclude ?? []).filter(isRef).map((r) => r.id);
      const sp = tx.spatial?.alliesWithin(x, ft, self, exclude);
      if (sp) {
        return sp.some((id) => !opts.notCond || !hasCondition(tx, id, opts.notCond));
      }
      const ex = exclude.length ? `（不算${exclude.map((e) => nameOf(tx, e)).join('、')}）` : '';
      const nc = opts.notCond ? `、且没有陷入${opts.notCond}` : '';
      return ask({
        id: `ally:${x}:${ft}:${self}:${exclude.join(',')}:${opts.notCond ?? ''}`,
        text: `${nameOf(tx, x)} 周围 ${ft} 尺内是否有 ${nameOf(tx, self)} 的盟友${ex}${nc}？`,
        subjects: [x, self],
        scope: 'roll',
      });
    },
    canSee: (a) => {
      const [p, q] = a as RefValue[];
      const sp = tx.spatial?.canSee(p.id, q.id);
      if (typeof sp === 'boolean') return sp;
      const guess = !hasCondition(tx, p.id, '目盲') && !hasCondition(tx, q.id, '隐形');
      return ask({
        id: `see:${p.id}:${q.id}`,
        text: `${nameOf(tx, p.id)} 能看见 ${nameOf(tx, q.id)} 吗？`,
        subjects: [p.id, q.id],
        guess,
        scope: 'turn',
      });
    },
    ask: (a) => ask({ id: `ask:${self}:${String(a[0])}`, text: String(a[0]), subjects: [self], scope: 'roll' }),
    abilityMod: (a) => {
      const ab = String(a[0]);
      if (!isAbility(ab)) throw new Error(`abilityMod：「${ab}」不是属性名`);
      return view().mod[ab];
    },
    includes: (a) => {
      const [list, x] = a;
      if (typeof list === 'string') return typeof x === 'string' && list.includes(x);
      if (!Array.isArray(list)) return false;
      return list.some((v) => (isRef(v) && isRef(x) ? v.id === x.id : v === x));
    },
    combatant: (a) => {
      const id = String(a[0]);
      if (!tx.state.combatants[id]) throw new Error(`combatant：没有参与者 ${id}`);
      return refOf(tx, id);
    },
  };

  return {
    root(name) {
      switch (name) {
        case 'self': return refOf(tx, self);
        case 'source': return d.source === undefined ? refOf(tx, self) : d.source === null ? null : refOf(tx, d.source);
        case 'target': return refOf(tx, need(d.target, 'target'));
        case 'attacker': return refOf(tx, need(d.attacker, 'attacker'));
        case 'pb': return view().pb;
        case 'level': return view().level;
        case 'mod': return { ...view().mod };
        case 'score': return { ...view().score };
        case 'slot': return { level: need(d.slot, 'slot（不是施法）') };
        case 'roll': return need(d.roll, 'roll');
        case 'attack': return need(d.attack, 'attack') as unknown as Record<string, Value>;
        case 'damage': return need(d.damage, 'damage');
        case 'event': return need(d.event, 'event') as Record<string, Value>;
        case 'effect': {
          const e = need(d.effect, 'effect');
          return { id: e.id, name: e.name, key: e.key, state: e.state as Record<string, Value>, source: e.source };
        }
        case 'vars': return { ...(d.vars ?? {}) };
        case 'action': return actionValue(tx, currentAction(tx));
        case 'round': return tx.state.round ?? 0;
        case 'turn': {
          const cur = tx.state.order[tx.state.turnIndex];
          // 战斗外没有回合：视为「随时都是自己的回合」（单卡测试狂暴延长等）
          return { isMine: tx.state.round === null || cur === self, of: cur ? refOf(tx, cur) : null };
        }
        case 'core': return tx.rules.coreAll() as Record<string, Value>;
        default:
          // 旧写法兼容：裸属性名 = 该属性调整值
          if (isAbility(name)) return view().mod[name];
          throw new Error(`当前上下文没有 ${name}`);
      }
    },
    fn: (name) => fns[name],
  };
}
