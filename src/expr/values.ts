import type { CmpOp } from './ast';

/* ============================== 骰子值 ============================== */

export interface DiceTerm {
  count: number;
  faces: number;
  sign: 1 | -1;
}

/**
 * 一个**还没掷**的骰子表达式：若干骰子项 + 常数。`2d6 + 1d4 + 3`、`-1d4`（灾祸）。
 * 掷骰不是表达式语言的事（见 combat/dice.ts）—— 这里只负责把「要掷什么」算清楚。
 */
export class Dice {
  constructor(
    readonly terms: readonly DiceTerm[],
    readonly flat: number,
  ) {}

  static of(count: number, faces: number): Dice {
    if (!Number.isFinite(count) || !Number.isFinite(faces)) throw new RangeError('骰子个数/面数不是数字');
    const n = Math.floor(count);
    const f = Math.floor(faces);
    if (n < 0) throw new RangeError(`骰子个数不能为负：${n}`);
    if (f < 1) throw new RangeError(`骰子面数至少为 1：${f}`);
    return new Dice(n === 0 ? [] : [{ count: n, faces: f, sign: 1 }], 0);
  }

  static constant(n: number): Dice { return new Dice([], n); }

  plus(o: Dice | number): Dice {
    if (typeof o === 'number') return new Dice(this.terms, this.flat + o);
    return Dice.normalize([...this.terms, ...o.terms], this.flat + o.flat);
  }

  neg(): Dice {
    return new Dice(this.terms.map((t) => ({ ...t, sign: (t.sign * -1) as 1 | -1 })), -this.flat);
  }

  /** 重击：所有伤害骰的个数翻倍，常数不变 */
  doubled(): Dice {
    return new Dice(this.terms.map((t) => ({ ...t, count: t.count * 2 })), this.flat);
  }

  get diceCount(): number { return this.terms.reduce((a, t) => a + t.count, 0); }
  get isConstant(): boolean { return this.terms.length === 0; }
  /** 期望值（「取平均值」的那种显示用，不参与规则） */
  get average(): number {
    return this.terms.reduce((a, t) => a + t.sign * t.count * (t.faces + 1) / 2, 0) + this.flat;
  }

  /** 合并同号同面数的项：`1d6 + 2d6` → `3d6` */
  static normalize(terms: DiceTerm[], flat: number): Dice {
    const map = new Map<string, DiceTerm>();
    for (const t of terms) {
      if (t.count === 0) continue;
      const k = `${t.sign}:${t.faces}`;
      const prev = map.get(k);
      map.set(k, prev ? { ...prev, count: prev.count + t.count } : { ...t });
    }
    return new Dice([...map.values()], flat);
  }

  toString(): string {
    const parts: string[] = [];
    this.terms.forEach((t, i) => {
      const s = `${t.count}d${t.faces}`;
      parts.push(i === 0 ? (t.sign < 0 ? '-' + s : s) : (t.sign < 0 ? ' - ' + s : ' + ' + s));
    });
    if (this.flat || !parts.length) {
      if (!parts.length) parts.push(String(this.flat));
      else parts.push(this.flat < 0 ? ` - ${-this.flat}` : ` + ${this.flat}`);
    }
    return parts.join('');
  }
}

/* ============================== 三值：未知 ============================== */

/**
 * 一个需要人来回答（或者由地图回答）的问题。
 * `id` 必须是**确定的**：同一个事实问两次得到同一个 id —— 回答按 id 缓存。
 */
export interface Question {
  id: string;
  text: string;
  subjects: string[];
  /** 能从上下文推测时给出（见 COMBAT-DESIGN §2.5）。没有就必须问 */
  guess?: boolean;
  /** 回答缓存多久 */
  scope: 'roll' | 'turn' | 'round' | 'sticky';
}

/**
 * 符号数：一个「现在不知道是多少」的数，但和已知数比较时可以变成一个**布尔问题**。
 * 典型是 `dist(attacker, self)`：没有地图就不知道距离，但 `dist(...) <= 5`
 * 可以问成「攻击者是否在 5 尺内？」—— 一个人能回答的问题。
 */
export interface SymNum {
  key: string;
  compare(op: CmpOp, n: number): boolean | Unknown;
}

/** 三值逻辑里的「不知道」。带着导致它的问题；只有真正影响结果的问题才会留下来。 */
export class Unknown {
  constructor(
    readonly questions: readonly Question[],
    readonly sym?: SymNum,
  ) {}

  static merge(...vs: unknown[]): Unknown {
    const seen = new Map<string, Question>();
    for (const v of vs) {
      if (v instanceof Unknown) for (const q of v.questions) if (!seen.has(q.id)) seen.set(q.id, q);
    }
    return new Unknown([...seen.values()]);
  }
}

/* ============================== 引用：战斗参与者 ============================== */

/**
 * 表达式里的 `self` / `target` / `attacker`。
 * 表达式层不知道「战斗参与者」长什么样 —— 由战斗层实现这个接口（combat/scope.ts）。
 */
export interface RefValue {
  readonly __ref: true;
  readonly id: string;
  get(field: string): Value;
  call(method: string, args: Value[]): Value;
}

export const isRef = (v: unknown): v is RefValue =>
  !!v && typeof v === 'object' && (v as { __ref?: unknown }).__ref === true;

export type Value =
  | number
  | boolean
  | string
  | null
  | undefined
  | Dice
  | Unknown
  | RefValue
  | Value[]
  | { [k: string]: Value };

export const isPlainObject = (v: unknown): v is { [k: string]: Value } =>
  !!v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Dice) && !(v instanceof Unknown) && !isRef(v);

export function describe(v: Value): string {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (v instanceof Dice) return `骰子 ${v.toString()}`;
  if (v instanceof Unknown) return `未知（${v.questions.map((q) => q.text).join('；')}）`;
  if (isRef(v)) return `参与者 ${v.id}`;
  if (Array.isArray(v)) return `列表[${v.length}]`;
  if (typeof v === 'object') return '对象';
  return `${typeof v} ${String(v)}`;
}
