// 账户资料库：结构检查、挂载状态、条目 → 卡面 / 战斗两个规则层的映射（LIBRARY.md 第二、三节）
import { describe, expect, it } from 'vitest';
import { checkItem, coversOf, homeRulesOf, houseRulesOf, isOverridePart, ruleKeyOf, shareStateOf, type LibraryItem } from '../src/library';
/** 一条合法的内容（覆盖官方的狂暴） */
const raw = (over: Record<string, unknown> = {}) => ({
  kind: 'classFeature', name: '狂暴', text: '进入狂暴…',
  parts: [{
    id: 'hr-aa11bb', key: 'XPHB:野蛮人:狂暴:1', name: '狂暴',
    sheet: { resources: [{ id: 'rage', name: '狂暴', formula: 'cond(level >= 17, 6, 2)', recovery: 'long' }] },
    combat: { entry: { name: '狂暴' } },
  }],
  by: 'hand', reviewed: true,
  ...over,
});

const ok = (x: unknown, id = 'hr-item01'): LibraryItem => {
  const r = checkItem(x, id);
  expect(r.problems).toEqual([]);
  return r.item!;
};

describe('资料库：结构检查', () => {
  it('覆盖官方的一条内容能过，字段被整理出来', () => {
    const it = ok(raw());
    expect(it.name).toBe('狂暴');
    expect(it.kind).toBe('classFeature');
    expect(it.parts).toHaveLength(1);
    expect(it.parts[0].key).toBe('XPHB:野蛮人:狂暴:1');
    expect(it.parts[0].combat?.entry).toEqual({ name: '狂暴' });
  });

  it('一个子职拆成多条：每级特性一条，各自的键', () => {
    const it = ok({
      kind: 'subclass', name: '战斗大师',
      parts: [
        { id: 'hr-bb0001', key: 'XPHB:战士:卓越战技:3', combat: { entry: { name: '卓越战技' } } },
        { id: 'hr-bb0002', key: 'XPHB:战士:战术素养:7', combat: { entry: { name: '战术素养' } } },
      ],
      by: 'byok:deepseek-chat', reviewed: false,
    }, 'hr-sub0001');
    expect(it.parts.map((p) => p.key)).toEqual(['XPHB:战士:卓越战技:3', 'XPHB:战士:战术素养:7']);
    expect(it.by).toBe('byok:deepseek-chat');
  });

  it('挑得出写错的地方', () => {
    const bad = (over: unknown) => checkItem(over, 'hr-item01').problems.join('；');
    expect(bad({ name: 'x', parts: [] })).toContain('parts');
    expect(bad(raw({ parts: [{ id: 'nope', key: 'XPHB:警觉' }] }))).toContain('id 不合法');
    expect(bad(raw({ parts: [{ id: 'hr-aa11bb', key: '警觉' }] }))).toContain('冒号');
    expect(bad(raw({ parts: [{ id: 'hr-aa11bb', key: 'HR:hr-aa11bb' }, { id: 'hr-aa11cc', key: 'HR:hr-aa11bb' }] }))).toContain('重复');
    expect(bad(raw({ parts: [{ id: 'hr-aa11bb', key: 'HR:hr-aa11bb', combat: { patch: { 'automation': 'manual' } } }] }))).toContain('patch');
    expect(bad(raw({ parts: [{ id: 'hr-aa11bb', key: 'XPHB:警觉', combat: { entry: { name: 'x' }, patch: {} } }] }))).toContain('只能写');
    expect(bad(raw({ parts: [{ id: 'hr-aa11bb', key: 'XPHB:警觉', combat: {} }] }))).toContain('空的');
    expect(bad(raw({ parts: [{ id: 'hr-aa11bb', key: 'XPHB:警觉', combat: { value: 3 } }] }))).toContain('core.');
    expect(bad(raw({ parts: [{ id: 'hr-aa11bb', key: 'XPHB:警觉', sheet: { mods: '不是数组' } }] }))).toContain('mods');
    expect(bad(raw({ parts: [{ id: 'hr-aa11bb', key: 'XPHB:警觉', combat: { entry: { 拼错: 1 } } }] }))).toContain('不认识的字段');
  });
});

describe('资料库：挂到战役的状态', () => {
  it('覆盖官方键的要 DM 点头，新内容自动生效', () => {
    expect(shareStateOf(ok(raw()))).toBe('pending');
    expect(shareStateOf(ok(raw({ parts: [{ id: 'hr-cc0001', key: 'HR:hr-cc0001', combat: { entry: { name: '自制' } } }] })))).toBe('auto');
    expect(isOverridePart({ id: 'hr-cc0001', key: 'core.critDamage' })).toBe(true);
  });
});

describe('资料库：条目 → 规则层', () => {
  it('覆盖官方：卡面 covers 和战斗键都用官方键，entry 带 fill', () => {
    const it = ok(raw());
    const [hr] = homeRulesOf(it);
    expect(hr).toMatchObject({ id: 'hr-aa11bb', covers: 'XPHB:野蛮人:狂暴:1' });
    expect(hr.resources?.[0]).toMatchObject({ id: 'rage' });
    const [hb] = houseRulesOf(it);
    expect(hb).toMatchObject({ id: 'hr-aa11bb', key: 'XPHB:野蛮人:狂暴:1', fill: true });
  });

  it('新内容：卡面 covers 空、键是 HR:<part.id>，不带 fill', () => {
    const it = ok(raw({
      parts: [{
        id: 'hr-cc0002', key: 'HR:hr-cc0002', name: '自制专长', text: '每次长休一次',
        pickable: true, sheet: { resources: [{ id: 'x', name: '次数', formula: '1', recovery: 'long' }] },
        combat: { entry: { name: '自制专长' } },
      }],
    }));
    const [hr] = homeRulesOf(it);
    expect(hr).toMatchObject({ id: 'hr-cc0002', covers: '', pickable: true });
    const [hb] = houseRulesOf(it);
    expect(hb.key).toBe('HR:hr-cc0002');
    expect(hb.fill).toBeUndefined();
    expect(hb.text).toBe('每次长休一次');
  });

  it('只写战斗数据的一条不进卡面（空的卡面家规会把官方数据顶掉）', () => {
    const it = ok(raw({
      parts: [{
        id: 'hr-aa11bb', key: 'XPHB:野蛮人:狂暴:1',
        sheet: { mods: [{ kind: 'note', note: '只记一笔' }] },
        combat: { entry: { name: '狂暴' } },
      }],
    }));
    expect(homeRulesOf(it)).toHaveLength(1);
    const combatOnly = ok(raw({ parts: [{ id: 'hr-dd0001', key: 'XPHB:战士:动作如潮:2', combat: { entry: { name: '动作如潮' } } }] }));
    expect(homeRulesOf(combatOnly)).toEqual([]);
    expect(houseRulesOf(combatOnly)).toHaveLength(1);
  });

  it('纯说明的一条只是文档：不进卡面也不进战斗', () => {
    const textOnly = ok(raw({ parts: [{ id: 'hr-dd0002', key: 'HR:hr-dd0002', text: '纯家规文字' }] }));
    expect(homeRulesOf(textOnly)).toEqual([]);
    expect(houseRulesOf(textOnly)).toEqual([]);
  });

  it('覆盖官方能力的不允许勾「选了才生效」', () => {
    const r = checkItem(raw({ parts: [{ id: 'hr-aa11bb', key: 'XPHB:野蛮人:狂暴:1', pickable: true, combat: { entry: { name: '狂暴' } } }] }), 'hr-item01');
    expect(r.problems.join('；')).toContain('选了才生效');
  });

  it('一个包里的每条都出自己那条（子职）', () => {
    const it = ok({
      kind: 'subclass', name: '战斗大师',
      parts: [
        { id: 'hr-ee0001', key: 'XPHB:战士:卓越战技:3', combat: { entry: { name: '卓越战技' } } },
        { id: 'hr-ee0002', key: 'XPHB:战士:战术素养:7', sheet: { mods: [{ kind: 'note', note: '先攻 +pb' }] } },
      ],
    }, 'hr-sub0001');
    expect(homeRulesOf(it).map((x) => x.id)).toEqual(['hr-ee0002']);
    expect(houseRulesOf(it).map((x) => x.key)).toEqual(['XPHB:战士:卓越战技:3']);
    expect(it.parts.map(ruleKeyOf)).toEqual(['XPHB:战士:卓越战技:3', 'XPHB:战士:战术素养:7']);
    expect(it.parts.map(coversOf)).toEqual(['XPHB:战士:卓越战技:3', 'XPHB:战士:战术素养:7']);
  });
});
