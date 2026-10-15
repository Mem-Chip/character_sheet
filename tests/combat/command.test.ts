import { describe, expect, it } from 'vitest';
import { parseCommand, rollExpr, seededRng } from '../../src/combat';

describe('指令框 /r', () => {
  it('解析：多个表达式、说明、优势、取高', () => {
    const p = parseCommand('/r ad20+5， 4d6kh3 - 1 偷看箱子')!;
    expect(p.cmd).toBe('r');
    expect(p.note).toBe('偷看箱子');
    expect(p.exprs.map((e) => e.text)).toEqual(['ad20+5', '4d6kh3-1']);
    expect(parseCommand('随便说句话')).toBeNull();
    expect(() => parseCommand('/x 1d6')).toThrow();
    expect(() => parseCommand('/r 1d6 说明, 1d8')).toThrow();
    expect(() => parseCommand('/r 1d6 2d8')).toThrow();
  });
  it('掷：取高只算留下的；优势是 2d20 取高', () => {
    const p = parseCommand('/pr 4d6kh3, ad20+2')!;
    const [a, b] = p.exprs.map((e) => rollExpr(e, seededRng(7)));
    const t = a.terms[0];
    expect(t.faces).toHaveLength(4);
    expect(t.dropped).toHaveLength(1);
    expect(a.total).toBe(t.faces.reduce((s, f) => s + f, 0) - t.faces[t.dropped[0]]);
    expect(b.total).toBe(Math.max(...b.terms[0].faces) + 2);
  });
});

describe('指令框：说明和表达式的分界', () => {
  it('空格隔开的没有运算符的内容算说明；说明以 D 开头也不会被吃掉', () => {
    expect(parseCommand('/r 1d20+2 DM 也来一个')).toMatchObject({ note: 'DM 也来一个', exprs: [{ text: '1d20+2' }] });
    expect(parseCommand('/r 1d20 + 5 先攻')).toMatchObject({ note: '先攻', exprs: [{ text: '1d20+5' }] });
    expect(() => parseCommand('/r 2d6 3')).toThrow();
  });
});
