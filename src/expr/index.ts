import { ExprError, type Ast } from './ast';
import { evaluate, type EvalEnv } from './eval';
import { parse } from './parser';
import { assignable, check, tyName, type ScopeDef, type Ty } from './types';
import { Dice, Unknown, describe, type Value } from './values';

export * from './ast';
export * from './values';
export * from './types';
export { evaluate, cmpNums, type EvalEnv, type FnImpl } from './eval';
export { parse } from './parser';
export { lex } from './lexer';
export { fromLegacy, ABILS, ABIL_CN, ABIL_WORD, isAbility, type Ability } from './legacy';

/** 数据里写表达式的地方，允许直接写数字或布尔（`"value": 5`） */
export type ExprSrc = string | number | boolean;

export const srcOf = (e: ExprSrc): string => (typeof e === 'string' ? e : String(e));

const astCache = new Map<string, Ast>();

/** 解析（带缓存）。同一段源码只解析一次 —— 规则数据在每次掷骰时都会被反复求值 */
export function compile(e: ExprSrc): Ast {
  const src = srcOf(e);
  let ast = astCache.get(src);
  if (!ast) {
    ast = parse(src);
    astCache.set(src, ast);
  }
  return ast;
}

/** 构建期检查：解析 + 推导类型 + 检查是否符合期望类型 */
export function checkExpr(e: ExprSrc, scope: ScopeDef, expected?: Ty | Ty[]): Ty {
  const src = srcOf(e);
  const ast = compile(src);
  const t = check(ast, scope, src);
  if (expected) {
    const list = Array.isArray(expected) ? expected : [expected];
    if (!list.some((x) => assignable(t, x))) {
      throw new ExprError(`这里需要${list.map(tyName).join('或')}，表达式的结果是${tyName(t)}`, src, 0, 'check');
    }
  }
  return t;
}

export function run(e: ExprSrc, env: EvalEnv): Value {
  const src = srcOf(e);
  return evaluate(compile(src), env, src);
}

export function runBool(e: ExprSrc, env: EvalEnv): boolean | Unknown {
  const v = run(e, env);
  if (typeof v === 'boolean' || v instanceof Unknown) return v;
  throw new ExprError(`这里需要布尔值，实际是${describe(v)}`, srcOf(e), 0, 'eval');
}

export function runNum(e: ExprSrc, env: EvalEnv): number | Unknown {
  const v = run(e, env);
  if ((typeof v === 'number' && Number.isFinite(v)) || v instanceof Unknown) return v;
  throw new ExprError(`这里需要数字，实际是${describe(v)}`, srcOf(e), 0, 'eval');
}

/** 数值上下文的最终结果向下取整（2024 默认「向下取整」，见 COMBAT-DESIGN §2.2） */
export function runInt(e: ExprSrc, env: EvalEnv): number | Unknown {
  const v = runNum(e, env);
  return typeof v === 'number' ? Math.floor(v) : v;
}

/** 骰子上下文：数字视为常数骰子；字符串按骰子表达式再解析一次（`classTable('偷袭')` 返回 `'3d6'`） */
export function runDice(e: ExprSrc, env: EvalEnv): Dice | Unknown {
  const v = run(e, env);
  if (v instanceof Dice || v instanceof Unknown) return v;
  if (typeof v === 'number') return Dice.constant(Math.floor(v));
  if (typeof v === 'string') return parseDice(v);
  throw new ExprError(`这里需要骰子，实际是${describe(v)}`, srcOf(e), 0, 'eval');
}

const NO_ENV: EvalEnv = {
  root: (name) => { throw new Error(`骰子文本里不能引用「${name}」`); },
  fn: () => undefined,
};

/** 解析一段纯骰子文本（`'2d6 + 3'`、`'1d4'`、`'5'`）。表格单元格、旧数据里的伤害骰走这里 */
export function parseDice(text: string): Dice {
  const v = evaluate(compile(text), NO_ENV, text);
  if (v instanceof Dice) return v;
  if (typeof v === 'number') return Dice.constant(Math.floor(v));
  throw new ExprError(`「${text}」不是骰子表达式`, text, 0, 'eval');
}
