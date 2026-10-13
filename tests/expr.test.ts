import { describe, expect, it } from 'vitest';
import {
  Dice, ExprError, T, Unknown, checkExpr, compile, fromLegacy, lex, parseDice, run, runBool, runDice, runInt,
  type EvalEnv, type FnImpl, type Question, type RefValue, type ScopeDef, type Value,
} from '../src/expr';

/* ---------- 测试用的小环境 ---------- */

function ref(id: string, fields: Record<string, Value>, methods: Record<string, (args: Value[]) => Value> = {}): RefValue {
  return {
    __ref: true,
    id,
    get: (f) => fields[f],
    call: (m, args) => {
      const fn = methods[m];
      if (!fn) throw new Error('no method ' + m);
      return fn(args);
    },
  };
}

function env(roots: Record<string, Value>, fns: Record<string, FnImpl> = {}): EvalEnv {
  return {
    root: (name) => {
      if (!(name in roots)) throw new Error(`当前上下文没有 ${name}`);
      return roots[name];
    },
    fn: (name) => fns[name],
  };
}

const q = (id: string, guess?: boolean): Question => ({ id, text: id, subjects: [], scope: 'roll', guess });

const scope: ScopeDef = {
  name: '测试',
  roots: {
    self: T.ref, target: T.ref, pb: T.num, level: T.num,
    mod: T.obj({ str: T.num, dex: T.num }),
    slot: T.obj({ level: T.num }),
    roll: T.obj({ adv: T.bool, disadv: T.bool, kind: T.str }),
    event: T.open,
  },
  funcs: {
    max: { params: [T.num, T.num], returns: T.num },
    dist: { params: [T.ref, T.ref], returns: T.num },
  },
  ref: {
    fields: { hp: T.num, type: T.str },
    methods: { has: { params: [T.str], returns: T.bool } },
  },
};

describe('词法：骰子运算符', () => {
  const kinds = (s: string) => lex(s).map((t) => t.kind + ':' + t.value).join(' ');
  it('数字紧跟 d 和数字是骰子', () => {
    expect(kinds('2d6')).toBe('num:2 dice:d num:6 eof:');
  });
  it('右括号紧跟 d 是骰子', () => {
    expect(kinds('(5 + slot.level)d6')).toContain(') dice:d num:6');
  });
  it('成员名里的 d 不是骰子', () => {
    expect(kinds('self.damage')).toBe('id:self op:. id:damage eof:');
  });
  it('中间有空格就不是骰子（随后作为多余内容报错）', () => {
    expect(() => compile('2 d6')).toThrow(ExprError);
  });
  it('中文字符串', () => {
    expect(lex("target.type == '类人生物'")[4]).toMatchObject({ kind: 'str', value: '类人生物' });
  });
});

describe('求值：数字与骰子', () => {
  const e = env({ pb: 3, level: 5, mod: { str: 3, dex: 1 }, slot: { level: 3 } }, {
    max: Object.assign((a: Value[]) => Math.max(a[0] as number, a[1] as number), {}),
    ceil: Object.assign((a: Value[]) => Math.ceil(a[0] as number), {}),
  });
  it('优先级', () => {
    expect(run('1 + 2 * 3', e)).toBe(7);
    expect(run('(1 + 2) * 3', e)).toBe(9);
    expect(run('-pb + 10', e)).toBe(7);
  });
  it('骰子加常数、合并同面数', () => {
    expect((run('2d6 + 1d6 + 3', e) as Dice).toString()).toBe('3d6 + 3');
    expect((run('1d8 + mod.str', e) as Dice).toString()).toBe('1d8 + 3');
  });
  it('骰子个数可以是表达式（火球术升环）', () => {
    expect((run('(5 + slot.level)d6', e) as Dice).toString()).toBe('8d6');
    expect((run('(ceil(level / 2))d6', e) as Dice).toString()).toBe('3d6');
  });
  it('负骰子（灾祸）', () => {
    expect((run('-1d4', e) as Dice).toString()).toBe('-1d4');
    expect((run('1d20 - 1d4', e) as Dice).toString()).toBe('1d20 - 1d4');
  });
  it('向下取整', () => {
    expect(runInt('level / 2', e)).toBe(2);
  });
  it('数字放进骰子上下文是常数骰子', () => {
    expect((runDice('max(1, mod.dex)', e) as Dice).toString()).toBe('1');
  });
  it('解析纯骰子文本', () => {
    expect(parseDice('3d6 + 2').toString()).toBe('3d6 + 2');
    expect(parseDice('1d6').diceCount).toBe(1);
    expect(parseDice('7').isConstant).toBe(true);
  });
  it('重击翻倍只翻骰子', () => {
    expect(parseDice('1d8 + 3').doubled().toString()).toBe('2d8 + 3');
  });
});

describe('求值：三值逻辑（Kleene + 短路）', () => {
  const U = (id: string) => new Unknown([q(id)]);
  const e = env({ u: U('距离'), v: U('能否看见'), t: true, f: false });
  it('false && 未知 = false，且不留下问题', () => {
    expect(run('f && u', e)).toBe(false);
    expect(run('u && f', e)).toBe(false);
  });
  it('true || 未知 = true', () => {
    expect(run('u || t', e)).toBe(true);
  });
  it('未知 && true = 未知，只带那一个问题', () => {
    const v = run('u && t', e) as Unknown;
    expect(v).toBeInstanceOf(Unknown);
    expect(v.questions.map((x) => x.id)).toEqual(['距离']);
  });
  it('两个未知合并问题', () => {
    const v = run('u && v', e) as Unknown;
    expect(v.questions.map((x) => x.id).sort()).toEqual(['能否看见', '距离']);
  });
  it('取反保持未知', () => {
    expect(run('!u', e)).toBeInstanceOf(Unknown);
  });
});

describe('求值：符号数（没有地图时的距离）', () => {
  const asked: string[] = [];
  const symDist = (a: string, b: string): Unknown => new Unknown([], {
    key: `dist:${a}:${b}`,
    compare: (op, n) => {
      asked.push(`${op}${n}`);
      return new Unknown([q(`within:${a}:${b}:${n}:${op}`)]);
    },
  });
  const e = env({ self: ref('A', {}), target: ref('B', {}) }, {
    dist: Object.assign((a: Value[]) => symDist((a[0] as RefValue).id, (a[1] as RefValue).id), {}),
  });
  it('dist(...) <= 5 变成一个布尔问题', () => {
    const v = run('dist(self, target) <= 5', e) as Unknown;
    expect(v.questions[0].id).toBe('within:A:B:5:<=');
  });
  it('数字在左边时比较符号翻转', () => {
    run('5 >= dist(self, target)', e);
    expect(asked.at(-1)).toBe('<=5');
  });
  it('参与算术之后就只是普通未知', () => {
    const v = run('dist(self, target) * 2 <= 10', e) as Unknown;
    expect(v).toBeInstanceOf(Unknown);
    expect(v.sym).toBeUndefined();
  });
});

describe('求值：引用、成员、相等', () => {
  const e = env({
    self: ref('A', { hp: 10, type: '类人生物' }, { has: (a) => a[0] === '倒地' }),
    target: ref('B', { hp: 0 }),
    event: { action: 'XPHB:spell:魔法飞弹' },
  });
  it('字段与方法', () => {
    expect(run('self.hp', e)).toBe(10);
    expect(runBool("self.has('倒地') && !self.has('麻痹')", e)).toBe(true);
    expect(runBool("self.type == '类人生物'", e)).toBe(true);
  });
  it('引用按 id 比较', () => {
    expect(runBool('self == target', e)).toBe(false);
    expect(runBool('self != target', e)).toBe(true);
  });
  it('开放对象：缺省字段是 undefined，等于 null', () => {
    expect(runBool("event.action == 'XPHB:spell:魔法飞弹'", e)).toBe(true);
    expect(runBool('event.nope == null', e)).toBe(true);
    expect(run('event.nope.deeper', e)).toBeUndefined();
  });
  it('上下文里没有的根名字直接报错（不装作 0）', () => {
    expect(() => run('attack.melee', e)).toThrow(/没有 attack/);
  });
  it('把数字当布尔用会报错', () => {
    expect(() => runBool('self.hp', e)).toThrow(ExprError);
  });
});

describe('类型检查（构建期）', () => {
  const ok = (s: string) => () => checkExpr(s, scope);
  const bad = (s: string, re: RegExp) => expect(() => checkExpr(s, scope)).toThrow(re);
  it('正常表达式通过', () => {
    expect(ok("roll.adv || (target.hp > 0 && !roll.disadv)")).not.toThrow();
    expect(checkExpr('(5 + slot.level)d6', scope)).toEqual(T.dice);
    expect(checkExpr('max(1, mod.str)', scope)).toEqual(T.num);
    expect(checkExpr("target.has('倒地')", scope)).toEqual(T.bool);
  });
  it('未知名字', () => bad('attack.melee', /没有「attack」/));
  it('拼错的成员', () => bad('roll.advantage', /没有「advantage」.*可用：adv/));
  it('参与者没有的字段', () => bad('self.hpp', /参与者没有「hpp」/));
  it('方法没加括号', () => bad('self.has', /要加括号/));
  it('函数没加括号', () => bad('max', /是函数/));
  it('参数个数', () => bad('max(1)', /需要 2 个参数/));
  it('参数类型', () => bad("max(1, 'a')", /第 2 个参数应该是数字/));
  it('字符串和数字比较大小', () => bad("roll.kind > 3", /两边应该是数字/));
  it('字符串和数字判等', () => bad("roll.kind == 3", /不能拿字符串和数字比较/));
  it('骰子不能乘', () => bad('2d6 * 2', /骰子不能乘除/));
  it('开放对象任意成员', () => expect(ok('event.whatever.deep == 1')).not.toThrow());
  it('期望类型', () => {
    expect(() => checkExpr('pb + 1', scope, T.bool)).toThrow(/需要布尔/);
    expect(() => checkExpr('pb + 1', scope, T.dice)).not.toThrow();   // 数字可以当常数骰子
  });
});

describe('旧写法兼容（resolveNum → 表达式）', () => {
  it.each([
    [3, '3'],
    ['pb', 'pb'],
    ['level', 'level'],
    ['wis', 'mod.wis'],
    ['mod:cha', 'mod.cha'],
    ['spellcasting', 'self.spell.mod'],
    ['mod:spellcasting', 'self.spell.mod'],
    ['魅力调整值', 'mod.cha'],
    ['你的感知调整值', 'mod.wis'],
    ['-2', '-2'],
  ])('%s → %s', (input, out) => {
    expect(fromLegacy(input)).toBe(out);
  });
  it('认不出来返回 null，而不是 0', () => {
    expect(fromLegacy('等于你的某种东西')).toBeNull();
    expect(fromLegacy('')).toBeNull();
    expect(fromLegacy(undefined)).toBeNull();
  });
});
