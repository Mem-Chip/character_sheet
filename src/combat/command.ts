/**
 * 日志下面的指令框：`/r` 公开掷骰、`/pr` 私密掷骰（日志里别人只看到「掷了骰子」，DM 可以点开看）。
 *
 * 语法：
 *   /r 2d6+3                  一个表达式
 *   /r 1d20+5, 2d6+3 偷看箱子   逗号（中英文都行）隔开好几个；最后一段空格后面的字是说明
 *   /r 4d6kh3                 取高 3 颗（kl = 取低）
 *   /r ad20+5   /r dd20+5     优势 / 劣势（就是 2d20kh1 / 2d20kl1）
 * 不以 / 开头的就是一句话，原样进日志。
 * 和战斗引擎无关：不进事务、不能撤销。
 */

export interface DiceTerm { sign: 1 | -1; count: number; faces: number; keep?: { hi: boolean; n: number }; text: string }
export interface FlatTerm { sign: 1 | -1; value: number }
export interface RollExpr { text: string; dice: DiceTerm[]; flat: FlatTerm[] }
export interface ParsedCommand { cmd: 'r' | 'pr'; exprs: RollExpr[]; note: string }

/** dropped：没取的那几颗的位置（kh / kl、优势劣势） */
export interface RolledTerm { text: string; faces: number[]; dropped: number[]; total: number }
export interface RolledExpr { text: string; terms: RolledTerm[]; flat: number; total: number }

const MAX_DICE = 100;
const TERM = '(?:[0-9]*d[0-9]+(?:k[hl][0-9]+)?|[ad]d20|[0-9]+)';
/** 一个空格隔开的片段：几项用 + - 连着，两头可以挂着 + 或 -（「1d20 + 5」这种写法） */
const TOKEN = new RegExp(`^[+-]?(?:${TERM})?(?:[+-]${TERM})*[+-]?$`, 'i');

/** 解析一行指令；不是指令返回 null，写错了抛 Error（消息给人看） */
export function parseCommand(line: string): ParsedCommand | null {
  const m = line.trim().match(/^\/(r|pr)(?:\s+|$)([\s\S]*)$/i);
  if (!m) {
    if (line.trim().startsWith('/')) throw new Error('只认识 /r（公开掷骰）和 /pr（私密掷骰）');
    return null;
  }
  const cmd = m[1].toLowerCase() as 'r' | 'pr';
  const segs = m[2].split(/[,，]/).map((x) => x.trim()).filter(Boolean);
  if (!segs.length) throw new Error('要写骰子，比如 /r 1d20+5');
  const exprs: RollExpr[] = [];
  let note = '';
  segs.forEach((seg, i) => {
    // 按空格切开，从头吃能连成表达式的片段（片段之间要有 + 或 - 连着）；剩下的是说明（只允许出现在最后一段）
    const toks = seg.split(/\s+/);
    let exprText = '';
    let k = 0;
    for (; k < toks.length; k++) {
      const t = toks[k];
      if (!t || !TOKEN.test(t)) break;
      if (exprText && !/[+-]$/.test(exprText) && !/^[+-]/.test(t)) break;
      exprText += t;
    }
    if (exprText && toks[k] && TOKEN.test(toks[k])) throw new Error(`「${exprText} ${toks[k]}」：好几个骰子要用逗号隔开，加在一起要用 +`);
    const rest = toks.slice(k).join(' ').trim();
    if (!exprText) throw new Error(`看不懂「${seg}」：要写骰子，比如 2d6+3`);
    if (rest) {
      if (i !== segs.length - 1) throw new Error(`「${rest}」：说明只能写在最后`);
      note = rest;
    }
    exprs.push(parseExpr(exprText));
  });
  return { cmd, exprs, note };
}

function parseExpr(text: string): RollExpr {
  const src = text.replace(/\s+/g, '').toLowerCase();
  const out: RollExpr = { text: src, dice: [], flat: [] };
  const re = /([+-]?)(?:(a|d)d20|(\d*)d(\d+)(?:k([hl])(\d+))?|(\d+))/gy;
  let pos = 0;
  let total = 0;
  while (pos < src.length) {
    re.lastIndex = pos;
    const t = re.exec(src);
    if (!t || t[0] === '' || (pos > 0 && !t[1])) throw new Error(`看不懂「${text}」：项之间要用 + 或 - 连起来`);
    const sign = t[1] === '-' ? -1 : 1;
    if (t[2]) {
      out.dice.push({ sign, count: 2, faces: 20, keep: { hi: t[2] === 'a', n: 1 }, text: `${t[2]}d20` });
    } else if (t[4]) {
      const count = t[3] ? Number(t[3]) : 1;
      const faces = Number(t[4]);
      if (count < 1 || faces < 2) throw new Error(`「${t[0]}」不是合法的骰子`);
      const keep = t[5] ? { hi: t[5] === 'h', n: Number(t[6]) } : undefined;
      if (keep && (keep.n < 1 || keep.n > count)) throw new Error(`「${t[0]}」：取的颗数要在 1 到 ${count} 之间`);
      out.dice.push({ sign, count, faces, keep, text: `${count}d${faces}${keep ? `k${keep.hi ? 'h' : 'l'}${keep.n}` : ''}` });
    } else {
      out.flat.push({ sign, value: Number(t[7]) });
    }
    total += t[4] || t[2] ? out.dice[out.dice.length - 1].count : 0;
    pos = re.lastIndex;
  }
  if (!out.dice.length && !out.flat.length) throw new Error(`看不懂「${text}」`);
  if (total > MAX_DICE) throw new Error(`一次最多掷 ${MAX_DICE} 颗`);
  return out;
}

export function rollExpr(e: RollExpr, rng: () => number = Math.random): RolledExpr {
  const terms: RolledTerm[] = e.dice.map((d) => {
    const faces = Array.from({ length: d.count }, () => 1 + Math.floor(rng() * d.faces));
    let keep = faces.map((_, i) => i);
    if (d.keep) keep = faces.map((f, i) => ({ f, i })).sort((a, b) => (d.keep!.hi ? b.f - a.f : a.f - b.f)).slice(0, d.keep.n).map((x) => x.i);
    const dropped = faces.map((_, i) => i).filter((i) => !keep.includes(i));
    return { text: `${d.sign < 0 ? '-' : ''}${d.text}`, faces, dropped, total: d.sign * keep.reduce((a, i) => a + faces[i], 0) };
  });
  const flat = e.flat.reduce((a, f) => a + f.sign * f.value, 0);
  return { text: e.text, terms, flat, total: terms.reduce((a, t) => a + t.total, 0) + flat };
}

/** 回执：ad20+5 → [17, 4] + 5 = 22 */
export function describeRoll(r: RolledExpr): string {
  const parts = r.terms.map((t) => `[${t.faces.map((f, i) => (t.dropped.includes(i) ? `~${f}~` : String(f))).join(', ')}]`);
  const flat = r.flat ? ` ${r.flat > 0 ? '+' : '-'} ${Math.abs(r.flat)}` : '';
  return `${r.text} → ${parts.join(' + ')}${flat} = ${r.total}`;
}

/** 一条掷骰记录（日志里显示） */
export interface ChatRoll {
  id: string;
  /** 谁掷的（战役里是用户 id；本地是 0） */
  by: number;
  byName: string;
  at: number;
  /** 掷的时候日志里已经有几笔事务 —— 用来把它插在对的位置 */
  afterTx: number;
  private: boolean;
  note: string;
  results: RolledExpr[];
  /** 不是指令、只是说了一句话（这时 results 为空） */
  text?: string;
  /** /match 分享的条目（法术、状态……），日志里显示原文 */
  term?: { kind: string; name: string; source?: string };
}

/** 指令框发出的一行 → 日志条目（掷骰或一句话）；写错了抛 Error，空行返回 null */
export function chatEntry(line: string, who: Pick<ChatRoll, 'id' | 'by' | 'byName' | 'at' | 'afterTx'>): ChatRoll | null {
  const t = line.trim();
  if (!t) return null;
  const p = parseCommand(t);
  if (!p) return { ...who, private: false, note: '', results: [], text: t.slice(0, 500) };
  return { ...who, private: p.cmd === 'pr', note: p.note.slice(0, 80), results: p.exprs.map((x) => rollExpr(x)) };
}
