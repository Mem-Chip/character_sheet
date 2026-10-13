import { ExprError, type Ast, type BinOp, type Token } from './ast';
import { lex } from './lexer';

/** 递归下降解析。每一层对应 ast.ts 顶部注释里的一档优先级。 */
export function parse(src: string): Ast {
  const toks = lex(src);
  let i = 0;
  const peek = () => toks[i];
  const next = () => toks[i++];
  const isOp = (v: string) => peek().kind === 'op' && peek().value === v;
  const expectOp = (v: string) => {
    const t = next();
    if (t.kind !== 'op' || t.value !== v) {
      throw new ExprError(`这里应该是「${v}」，实际是「${t.value || '结尾'}」`, src, t.pos, 'parse');
    }
    return t;
  };

  const binLevel = (ops: BinOp[], sub: () => Ast) => (): Ast => {
    let l = sub();
    while (peek().kind === 'op' && (ops as string[]).includes(peek().value)) {
      const t = next();
      const r = sub();
      l = { k: 'bin', op: t.value as BinOp, l, r, pos: t.pos };
    }
    return l;
  };

  const primary = (): Ast => {
    const t = next();
    switch (t.kind) {
      case 'num': return { k: 'num', v: Number(t.value), pos: t.pos };
      case 'str': return { k: 'str', v: t.value, pos: t.pos };
      case 'id':
        if (t.value === 'true' || t.value === 'false') return { k: 'bool', v: t.value === 'true', pos: t.pos };
        if (t.value === 'null') return { k: 'null', pos: t.pos };
        return { k: 'id', name: t.value, pos: t.pos };
      case 'op':
        if (t.value === '(') {
          const e = expr();
          expectOp(')');
          return e;
        }
        if (t.value === '[') {
          const items: Ast[] = [];
          if (!isOp(']')) {
            items.push(expr());
            while (isOp(',')) { next(); items.push(expr()); }
          }
          expectOp(']');
          return { k: 'list', items, pos: t.pos };
        }
        if (t.value === '{') {
          const entries: Array<[string, Ast]> = [];
          if (!isOp('}')) {
            do {
              if (isOp(',')) next();
              const key = next();
              if (key.kind !== 'id' && key.kind !== 'str') {
                throw new ExprError('对象的键应该是名字或字符串', src, key.pos, 'parse');
              }
              expectOp(':');
              entries.push([key.value, expr()]);
            } while (isOp(','));
          }
          expectOp('}');
          return { k: 'obj', entries, pos: t.pos };
        }
        break;
    }
    throw new ExprError(`这里不应该出现「${t.value || '结尾'}」`, src, t.pos, 'parse');
  };

  const postfix = (): Ast => {
    let e = primary();
    for (;;) {
      if (isOp('.')) {
        const dot = next();
        const name = next();
        if (name.kind !== 'id') throw new ExprError('「.」后面应该是名字', src, name.pos, 'parse');
        e = { k: 'member', obj: e, name: name.value, pos: dot.pos };
      } else if (isOp('(')) {
        const open = next();
        if (e.k !== 'id' && e.k !== 'member') {
          throw new ExprError('只有函数名或方法可以被调用', src, open.pos, 'parse');
        }
        const args: Ast[] = [];
        if (!isOp(')')) {
          args.push(expr());
          while (isOp(',')) { next(); args.push(expr()); }
        }
        expectOp(')');
        e = { k: 'call', callee: e, args, pos: open.pos };
      } else {
        return e;
      }
    }
  };

  const dice = (): Ast => {
    const count = postfix();
    if (peek().kind === 'dice') {
      const t = next();
      const faces = postfix();
      return { k: 'dice', count, faces, pos: t.pos };
    }
    return count;
  };

  const unary = (): Ast => {
    if (isOp('!') || isOp('-')) {
      const t = next();
      return { k: 'unary', op: t.value as '!' | '-', arg: unary(), pos: t.pos };
    }
    return dice();
  };

  const mul = binLevel(['*', '/'], unary);
  const add = binLevel(['+', '-'], mul);
  const rel = binLevel(['<', '<=', '>', '>='], add);
  const eq = binLevel(['==', '!='], rel);
  const and = binLevel(['&&'], eq);
  const or = binLevel(['||'], and);
  function expr(): Ast { return or(); }

  if (peek().kind === 'eof') throw new ExprError('表达式是空的', src, 0, 'parse');
  const ast = expr();
  const end: Token = peek();
  if (end.kind !== 'eof') throw new ExprError(`多出来的内容「${end.value}」`, src, end.pos, 'parse');
  return ast;
}
