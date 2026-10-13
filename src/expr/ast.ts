/**
 * 表达式语言的词法单元与语法树。语法见 COMBAT-DESIGN.md §2.2。
 *
 * 优先级（从低到高）：
 *   ||  →  &&  →  == !=  →  < <= > >=  →  + -  →  * /  →  一元 ! -  →  骰子 d  →  成员/调用  →  原子
 *
 * ⚠️ 一元 `!` 比比较运算绑得紧（和 JS 一致）：`!a == b` 是 `(!a) == b`。
 *    写数据的人多半带着 JS 的直觉，跟着 JS 走最不容易写错。
 */

export type TokKind = 'num' | 'str' | 'id' | 'op' | 'dice' | 'eof';

export interface Token {
  kind: TokKind;
  value: string;
  pos: number;
}

export type BinOp = '||' | '&&' | '==' | '!=' | '<' | '<=' | '>' | '>=' | '+' | '-' | '*' | '/';
export type CmpOp = '<' | '<=' | '>' | '>=' | '==' | '!=';

export type Ast =
  | { k: 'num'; v: number; pos: number }
  | { k: 'str'; v: string; pos: number }
  | { k: 'bool'; v: boolean; pos: number }
  | { k: 'null'; pos: number }
  | { k: 'id'; name: string; pos: number }
  | { k: 'member'; obj: Ast; name: string; pos: number }
  | { k: 'call'; callee: Ast; args: Ast[]; pos: number }
  | { k: 'unary'; op: '!' | '-'; arg: Ast; pos: number }
  | { k: 'bin'; op: BinOp; l: Ast; r: Ast; pos: number }
  | { k: 'dice'; count: Ast; faces: Ast; pos: number }
  | { k: 'list'; items: Ast[]; pos: number }
  | { k: 'obj'; entries: Array<[string, Ast]>; pos: number };

/** 带源码位置的错误。`phase` 区分「写错了」（parse/check）和「跑的时候才发现」（eval） */
export class ExprError extends Error {
  constructor(
    message: string,
    readonly src: string,
    readonly pos: number,
    readonly phase: 'parse' | 'check' | 'eval',
  ) {
    super(`${message}（位置 ${pos}：${ExprError.excerpt(src, pos)}）`);
    this.name = 'ExprError';
  }
  static excerpt(src: string, pos: number): string {
    const a = Math.max(0, pos - 12);
    const b = Math.min(src.length, pos + 12);
    return (a > 0 ? '…' : '') + src.slice(a, pos) + '▸' + src.slice(pos, b) + (b < src.length ? '…' : '');
  }
}
