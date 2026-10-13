import { ExprError, type Token } from './ast';

const OPS2 = ['||', '&&', '==', '!=', '<=', '>='];
const OPS1 = ['<', '>', '!', '+', '-', '*', '/', '(', ')', '[', ']', '{', '}', ',', '.', ':'];

const isDigit = (c: string) => c >= '0' && c <= '9';
const isIdStart = (c: string) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
const isIdPart = (c: string) => isIdStart(c) || isDigit(c);

/**
 * 词法分析。
 *
 * ⭐ 骰子运算符 `d` 的判定：**紧跟**在数字或 `)` 之后、且后面紧跟数字或 `(` 的 `d`。
 *   `2d6`、`(5 + slot.level)d6`、`1d(x)` 都是骰子；`self.damage`、`d6`（没有个数）都不是。
 *   要求紧挨着（不允许 `2 d6`），这样标识符里出现的 d 永远不会被误认。
 */
export function lex(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const prevAllowsDice = () => {
    const p = out[out.length - 1];
    return !!p && (p.kind === 'num' || (p.kind === 'op' && p.value === ')'));
  };
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }

    if (c === 'd' && prevAllowsDice() && i + 1 < src.length && (isDigit(src[i + 1]) || src[i + 1] === '(')) {
      // 前一个 token 必须紧挨着（中间不能有空白）
      const p = out[out.length - 1];
      const prevEnd = p.pos + p.value.length;
      if (prevEnd === i) {
        out.push({ kind: 'dice', value: 'd', pos: i });
        i++;
        continue;
      }
    }

    if (isDigit(c)) {
      let j = i;
      while (j < src.length && isDigit(src[j])) j++;
      if (src[j] === '.' && isDigit(src[j + 1] ?? '')) {
        j++;
        while (j < src.length && isDigit(src[j])) j++;
      }
      out.push({ kind: 'num', value: src.slice(i, j), pos: i });
      i = j;
      continue;
    }

    if (isIdStart(c)) {
      let j = i;
      while (j < src.length && isIdPart(src[j])) j++;
      out.push({ kind: 'id', value: src.slice(i, j), pos: i });
      i = j;
      continue;
    }

    if (c === "'" || c === '"') {
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\' && j + 1 < src.length) { s += src[j + 1]; j += 2; continue; }
        s += src[j++];
      }
      if (j >= src.length) throw new ExprError('字符串没有结束引号', src, i, 'parse');
      // value 存解码后的内容（字符串后面不可能接骰子，所以不影响「紧挨着」的判定）
      out.push({ kind: 'str', value: s, pos: i });
      i = j + 1;
      continue;
    }

    const two = src.slice(i, i + 2);
    if (OPS2.includes(two)) { out.push({ kind: 'op', value: two, pos: i }); i += 2; continue; }
    if (OPS1.includes(c)) { out.push({ kind: 'op', value: c, pos: i }); i++; continue; }

    throw new ExprError(`无法识别的字符「${c}」`, src, i, 'parse');
  }
  out.push({ kind: 'eof', value: '', pos: src.length });
  return out;
}
