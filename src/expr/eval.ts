import { ExprError, type Ast, type CmpOp } from './ast';
import { Dice, Unknown, describe, isPlainObject, isRef, type Value } from './values';

/** 运行时函数。默认参数里有「未知」就直接返回未知，不调用实现；`acceptsUnknown` 的函数自己处理 */
export interface FnImpl {
  (args: Value[], env: EvalEnv): Value;
  acceptsUnknown?: boolean;
}

export interface EvalEnv {
  /** 根名字的值（`self` / `roll` / `pb` …）。上下文里没有就抛错，**不要**返回 undefined 装没事 */
  root(name: string): Value;
  fn(name: string): FnImpl | undefined;
}

const FLIP: Record<CmpOp, CmpOp> = { '<': '>', '<=': '>=', '>': '<', '>=': '<=', '==': '==', '!=': '!=' };

export function cmpNums(op: CmpOp, a: number, b: number): boolean {
  switch (op) {
    case '<': return a < b;
    case '<=': return a <= b;
    case '>': return a > b;
    case '>=': return a >= b;
    case '==': return a === b;
    case '!=': return a !== b;
  }
}

/**
 * 求值。三值逻辑：`&&` / `||` 按 Kleene 规则合成，并且**短路** ——
 * 已经能确定结果时不去求另一边，所以不会产生多余的问题（`false && dist(...) <= 5` 不会问距离）。
 * 「未知」只携带**真正影响结果**的问题：`未知 && false` 得 false，那个问题就被丢掉了。
 */
export function evaluate(ast: Ast, env: EvalEnv, src: string): Value {
  const err = (msg: string, pos: number): never => { throw new ExprError(msg, src, pos, 'eval'); };

  const asBool = (v: Value, pos: number): boolean | Unknown => {
    if (typeof v === 'boolean' || v instanceof Unknown) return v;
    return err(`这里需要布尔值，实际是${describe(v)}`, pos);
  };

  const equals = (a: Value, b: Value): boolean => {
    if (a == null || b == null) return a == null && b == null;
    if (isRef(a) || isRef(b)) return isRef(a) && isRef(b) && a.id === b.id;
    if (a instanceof Dice || b instanceof Dice) {
      const da = a instanceof Dice ? a : typeof a === 'number' ? Dice.constant(a) : null;
      const db = b instanceof Dice ? b : typeof b === 'number' ? Dice.constant(b) : null;
      return !!da && !!db && da.toString() === db.toString();
    }
    if (typeof a === 'object' || typeof b === 'object') return err('列表和对象不能比较是否相等', ast.pos);
    return a === b;
  };

  function walk(n: Ast): Value {
    switch (n.k) {
      case 'num': return n.v;
      case 'str': return n.v;
      case 'bool': return n.v;
      case 'null': return null;
      case 'id': return env.root(n.name);
      case 'member': {
        const o = walk(n.obj);
        if (o instanceof Unknown) return Unknown.merge(o);
        if (o == null) return undefined;                 // 可选链语义：缺省字段一路是 undefined
        if (isRef(o)) return o.get(n.name);
        if (isPlainObject(o)) return o[n.name];
        return err(`${describe(o)}没有成员「${n.name}」`, n.pos);
      }
      case 'call': {
        const args = n.args.map(walk);
        if (n.callee.k === 'id') {
          const f = env.fn(n.callee.name);
          if (!f) return err(`没有函数「${n.callee.name}」`, n.callee.pos);
          if (!f.acceptsUnknown && args.some((a) => a instanceof Unknown)) return Unknown.merge(...args);
          return f(args, env);
        }
        if (n.callee.k === 'member') {
          const o = walk(n.callee.obj);
          if (o instanceof Unknown) return Unknown.merge(o, ...args);
          if (!isRef(o)) return err(`${describe(o)}没有方法「${n.callee.name}」`, n.callee.pos);
          if (args.some((a) => a instanceof Unknown)) return Unknown.merge(...args);
          return o.call(n.callee.name, args);
        }
        return err('只有函数名或方法可以被调用', n.pos);
      }
      case 'unary': {
        const a = walk(n.arg);
        if (a instanceof Unknown) return Unknown.merge(a);   // 取反/取负之后符号数就不再成立
        if (n.op === '!') return !asBool(a, n.arg.pos);
        if (typeof a === 'number') return -a;
        if (a instanceof Dice) return a.neg();
        return err(`「-」只能用在数字或骰子上，实际是${describe(a)}`, n.pos);
      }
      case 'dice': {
        const c = walk(n.count);
        const f = walk(n.faces);
        if (c instanceof Unknown || f instanceof Unknown) return Unknown.merge(c, f);
        if (typeof c !== 'number') return err(`骰子个数应该是数字，实际是${describe(c)}`, n.count.pos);
        if (typeof f !== 'number') return err(`骰子面数应该是数字，实际是${describe(f)}`, n.faces.pos);
        try { return Dice.of(c, f); } catch (e) { return err((e as Error).message, n.pos); }
      }
      case 'list': return n.items.map(walk);
      case 'obj': {
        const o: { [k: string]: Value } = {};
        for (const [k, v] of n.entries) o[k] = walk(v);
        return o;
      }
      case 'bin': {
        if (n.op === '&&' || n.op === '||') {
          const stop = n.op === '||';                    // || 遇 true 短路，&& 遇 false 短路
          const l = asBool(walk(n.l), n.l.pos);
          if (l === stop) return stop;
          const r = asBool(walk(n.r), n.r.pos);
          if (l === !stop) return r;                     // l 不影响结果，结果就是 r
          // l 未知
          if (r === stop) return stop;
          if (r === !stop) return l;
          return Unknown.merge(l, r);
        }
        const l = walk(n.l);
        const r = walk(n.r);
        if (n.op === '==' || n.op === '!=' || n.op === '<' || n.op === '<=' || n.op === '>' || n.op === '>=') {
          const op: CmpOp = n.op;
          if (l instanceof Unknown && l.sym && typeof r === 'number') return l.sym.compare(op, r);
          if (r instanceof Unknown && r.sym && typeof l === 'number') return r.sym.compare(FLIP[op], l);
          if (l instanceof Unknown || r instanceof Unknown) return Unknown.merge(l, r);
          if (op === '==') return equals(l, r);
          if (op === '!=') return !equals(l, r);
          if (typeof l !== 'number' || typeof r !== 'number') {
            return err(`「${op}」两边应该是数字，实际是${describe(l)}和${describe(r)}`, n.pos);
          }
          return cmpNums(op, l, r);
        }
        if (l instanceof Unknown || r instanceof Unknown) return Unknown.merge(l, r);
        if (n.op === '+' || n.op === '-') {
          const rr = n.op === '-' ? (typeof r === 'number' ? -r : r instanceof Dice ? r.neg() : r) : r;
          if (typeof l === 'number' && typeof rr === 'number') return l + rr;
          if ((l instanceof Dice || typeof l === 'number') && (rr instanceof Dice || typeof rr === 'number')) {
            const dl = l instanceof Dice ? l : Dice.constant(l);
            return dl.plus(rr);
          }
          return err(`「${n.op}」两边应该是数字或骰子，实际是${describe(l)}和${describe(r)}`, n.pos);
        }
        // * /
        if (typeof l !== 'number' || typeof r !== 'number') {
          return err(`「${n.op}」两边应该是数字，实际是${describe(l)}和${describe(r)}`, n.pos);
        }
        if (n.op === '/' && r === 0) return err('除以 0', n.pos);
        return n.op === '*' ? l * r : l / r;
      }
    }
  }

  return walk(ast);
}
