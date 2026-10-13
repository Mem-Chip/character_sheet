import { ExprError, type Ast } from './ast';

/**
 * 静态类型。只用于**构建期检查**（数据工厂 / 房规编辑器保存前），运行时不依赖它。
 *
 * 目的就一个：把「写了一个不存在的名字」「把字符串当数字用」这类错误挡在数据进库之前 ——
 * 原项目 `resolveNum` 时代，这些错误的表现是「静默算成 +0」。
 */
export type Ty =
  | { k: 'num' }
  | { k: 'bool' }
  | { k: 'str' }
  | { k: 'dice' }
  | { k: 'null' }
  | { k: 'any' }
  | { k: 'ref' }
  | { k: 'list'; of: Ty }
  /** `fields` 缺省 = 开放对象（任何成员都是 any），例如 `event`、`effect.state` */
  | { k: 'obj'; fields?: Record<string, Ty> };

export const T = {
  num: { k: 'num' } as Ty,
  bool: { k: 'bool' } as Ty,
  str: { k: 'str' } as Ty,
  dice: { k: 'dice' } as Ty,
  null: { k: 'null' } as Ty,
  any: { k: 'any' } as Ty,
  ref: { k: 'ref' } as Ty,
  list: (of: Ty): Ty => ({ k: 'list', of }),
  obj: (fields?: Record<string, Ty>): Ty => ({ k: 'obj', fields }),
  open: { k: 'obj' } as Ty,
};

export interface FnSig {
  params: Ty[];
  /** 末尾有几个参数可以省略 */
  optional?: number;
  returns: Ty;
  doc?: string;
}

export interface RefShape {
  fields: Record<string, Ty>;
  methods: Record<string, FnSig>;
}

/** 一个作用域：这个字段里能用哪些名字、哪些函数 */
export interface ScopeDef {
  name: string;
  roots: Record<string, Ty>;
  funcs: Record<string, FnSig>;
  ref: RefShape;
}

export function tyName(t: Ty): string {
  switch (t.k) {
    case 'num': return '数字';
    case 'bool': return '布尔';
    case 'str': return '字符串';
    case 'dice': return '骰子';
    case 'null': return 'null';
    case 'any': return '任意';
    case 'ref': return '参与者';
    case 'list': return `${tyName(t.of)}列表`;
    case 'obj': return '对象';
  }
}

/** `from` 能不能用在要求 `to` 的地方 */
export function assignable(from: Ty, to: Ty): boolean {
  if (from.k === 'any' || to.k === 'any') return true;
  if (to.k === 'dice' && from.k === 'num') return true;          // 常数也是骰子表达式
  if (from.k === 'null') return true;                            // null 可以出现在任何位置（缺省值）
  if (from.k !== to.k) return false;
  if (from.k === 'list' && to.k === 'list') return assignable(from.of, to.of);
  return true;
}

const isNumLike = (t: Ty) => t.k === 'num' || t.k === 'any';
const isDiceLike = (t: Ty) => t.k === 'num' || t.k === 'dice' || t.k === 'any';

/** 推导类型；有问题就抛 ExprError（phase = 'check'） */
export function check(ast: Ast, scope: ScopeDef, src: string): Ty {
  const err = (msg: string, pos: number): never => { throw new ExprError(msg, src, pos, 'check'); };

  const callSig = (sig: FnSig, args: Ast[], what: string, pos: number): Ty => {
    const min = sig.params.length - (sig.optional ?? 0);
    if (args.length < min || args.length > sig.params.length) {
      err(`${what} 需要 ${min === sig.params.length ? min : `${min}～${sig.params.length}`} 个参数，给了 ${args.length} 个`, pos);
    }
    args.forEach((a, i) => {
      const at = walk(a);
      if (!assignable(at, sig.params[i])) {
        err(`${what} 的第 ${i + 1} 个参数应该是${tyName(sig.params[i])}，这里是${tyName(at)}`, a.pos);
      }
    });
    return sig.returns;
  };

  function walk(n: Ast): Ty {
    switch (n.k) {
      case 'num': return T.num;
      case 'str': return T.str;
      case 'bool': return T.bool;
      case 'null': return T.null;
      case 'id': {
        const t = scope.roots[n.name];
        if (!t) {
          const fn = scope.funcs[n.name] ? `（「${n.name}」是函数，要加括号调用）` : '';
          return err(`在「${scope.name}」里没有「${n.name}」这个名字${fn}`, n.pos);
        }
        return t;
      }
      case 'member': {
        const o = walk(n.obj);
        if (o.k === 'any') return T.any;
        if (o.k === 'ref') {
          const f = scope.ref.fields[n.name];
          if (f) return f;
          if (scope.ref.methods[n.name]) return err(`「${n.name}」是方法，要加括号调用`, n.pos);
          return err(`参与者没有「${n.name}」这个字段`, n.pos);
        }
        if (o.k === 'obj') {
          if (!o.fields) return T.any;
          const f = o.fields[n.name];
          if (!f) return err(`这里没有「${n.name}」（可用：${Object.keys(o.fields).join('、')}）`, n.pos);
          return f;
        }
        return err(`${tyName(o)}没有成员「${n.name}」`, n.pos);
      }
      case 'call': {
        if (n.callee.k === 'id') {
          const sig = scope.funcs[n.callee.name];
          if (!sig) return err(`在「${scope.name}」里没有函数「${n.callee.name}」`, n.callee.pos);
          return callSig(sig, n.args, n.callee.name, n.pos);
        }
        if (n.callee.k === 'member') {
          const o = walk(n.callee.obj);
          if (o.k === 'any') { n.args.forEach(walk); return T.any; }
          if (o.k !== 'ref') return err(`${tyName(o)}没有方法「${n.callee.name}」`, n.callee.pos);
          const sig = scope.ref.methods[n.callee.name];
          if (!sig) return err(`参与者没有方法「${n.callee.name}」`, n.callee.pos);
          return callSig(sig, n.args, n.callee.name, n.pos);
        }
        return err('只有函数名或方法可以被调用', n.pos);
      }
      case 'unary': {
        const a = walk(n.arg);
        if (n.op === '!') {
          if (a.k !== 'bool' && a.k !== 'any') err(`「!」只能用在布尔值上，这里是${tyName(a)}`, n.pos);
          return T.bool;
        }
        if (a.k === 'dice') return T.dice;
        if (!isNumLike(a)) err(`「-」只能用在数字或骰子上，这里是${tyName(a)}`, n.pos);
        return a.k === 'any' ? T.any : T.num;
      }
      case 'dice': {
        const c = walk(n.count);
        const f = walk(n.faces);
        if (!isNumLike(c)) err(`骰子个数应该是数字，这里是${tyName(c)}`, n.count.pos);
        if (!isNumLike(f)) err(`骰子面数应该是数字，这里是${tyName(f)}`, n.faces.pos);
        return T.dice;
      }
      case 'bin': {
        const l = walk(n.l);
        const r = walk(n.r);
        switch (n.op) {
          case '&&':
          case '||':
            if (l.k !== 'bool' && l.k !== 'any') err(`「${n.op}」左边应该是布尔值，这里是${tyName(l)}`, n.l.pos);
            if (r.k !== 'bool' && r.k !== 'any') err(`「${n.op}」右边应该是布尔值，这里是${tyName(r)}`, n.r.pos);
            return T.bool;
          case '==':
          case '!=':
            if (l.k !== 'any' && r.k !== 'any' && l.k !== 'null' && r.k !== 'null' && l.k !== r.k
              && !(isDiceLike(l) && isDiceLike(r))) {
              err(`不能拿${tyName(l)}和${tyName(r)}比较是否相等`, n.pos);
            }
            return T.bool;
          case '<': case '<=': case '>': case '>=':
            if (!isNumLike(l) || !isNumLike(r)) err(`「${n.op}」两边应该是数字，这里是${tyName(l)}和${tyName(r)}`, n.pos);
            return T.bool;
          case '+': case '-':
            if (!isDiceLike(l) || !isDiceLike(r)) err(`「${n.op}」两边应该是数字或骰子，这里是${tyName(l)}和${tyName(r)}`, n.pos);
            if (l.k === 'dice' || r.k === 'dice') return T.dice;
            if (l.k === 'any' || r.k === 'any') return T.any;
            return T.num;
          case '*': case '/':
            if (!isNumLike(l) || !isNumLike(r)) {
              err(`「${n.op}」两边应该是数字（骰子不能乘除，倍数请用 scale 字段），这里是${tyName(l)}和${tyName(r)}`, n.pos);
            }
            return l.k === 'any' || r.k === 'any' ? T.any : T.num;
        }
        return T.any;
      }
      case 'list': {
        const ts = n.items.map(walk);
        if (!ts.length) return T.list(T.any);
        const first = ts[0];
        return T.list(ts.every((t) => t.k === first.k) ? first : T.any);
      }
      case 'obj': {
        const fields: Record<string, Ty> = {};
        for (const [k, v] of n.entries) fields[k] = walk(v);
        return T.obj(fields);
      }
    }
  }

  return walk(ast);
}
