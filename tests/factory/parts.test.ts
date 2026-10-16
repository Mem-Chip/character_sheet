// AI 双写（卡面 + 战斗）：答卷检查、两边互通（卡面声明的池子战斗花得掉）、答卷 → 库条目 → 两层规则
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkItem, homeRulesOf, houseRulesOf, type LibraryItem } from '../../src/library';
import type { CharData } from '../../src/sheet';
import { createNodeEnv } from '../../src/sheet/node-env';
import { hasLocalData } from '../../src/sheet/node-provider';
import { aiSheetExamplesText, aiSpec, checkParts, partsFromAnswer, smokeSheet, type PartsCheckCtx } from '../../app/lib/ai';

const chars = JSON.parse(readFileSync(resolve(import.meta.dirname, '..', 'fixtures', 'chars.json'), 'utf8')) as Array<{ id: string; char: CharData }>;
const fighter = () => structuredClone(chars.find((c) => c.id === 'fighter5-plate')!.char);

/** 一份写得对的答卷：卡面声明狂暴池，战斗花它 */
const good = {
  parts: [{
    key: 'XPHB:野蛮人:狂暴:1', name: '狂暴', text: '附赠动作进入狂暴。',
    sheet: { resources: [{ id: 'rage', name: '狂暴', formula: 'cond(level >= 17, 6, 2)', recovery: 'long' }] },
    combat: {
      name: '狂暴',
      actions: [{ id: 'use', name: '狂暴', activation: 'bonus', cost: [{ resource: 'rage' }], root: [{ kind: 'note', text: '进入狂暴' }] }],
    },
  }],
};
const okFormula = () => 6;
const base: PartsCheckCtx = { key: 'XPHB:野蛮人:狂暴:1', resourceIds: [] };

describe('AI 双写：答卷检查', () => {
  it('写得对就通过（两边互通：池子声明在卡面，战斗里花得掉）', () => {
    expect(checkParts(good, { ...base, resolveFormula: okFormula })).toEqual([]);
  });

  it('池子没声明却花了：报出来（这正是卡面和战斗要对上的地方）', () => {
    const bad = { parts: [{ ...good.parts[0], sheet: {} }] };
    expect(checkParts(bad, base).join()).toContain('rage');
  });

  it('卡面字段拼错 / kind 不认识 / 上限算不出 / 什么都没写：都报出来', () => {
    const bad = {
      parts: [{
        key: base.key,
        sheet: {
          mods: [{ kind: 'ac', bonu: 1 }, { kind: '不认识的' }],
          resources: [{ id: 'x', name: 'X', formula: '???', recovery: 'long' }],
        },
        combat: { name: 'x' },
      }],
    };
    const p = checkParts(bad, { ...base, resolveFormula: () => null }).join('\n');
    expect(p).toContain('bonu');                 // 拼错的字段（引擎会静默忽略）
    expect(p).toContain('不认识的 kind');
    expect(p).toContain('什么都没写');
    expect(p).toContain('算不出数');
  });

  it('拆成多条：键重复要报；不同键的多条要过', () => {
    const dup = { parts: [{ key: 'XPHB:战士:卓越战技:3', combat: { name: 'a' } }, { key: 'XPHB:战士:卓越战技:3', combat: { name: 'b' } }] };
    expect(checkParts(dup, base).join()).toContain('重复');
    const many = {
      parts: [
        { key: 'XPHB:战士:卓越战技:3', combat: { name: '卓越战技' } },
        { key: 'XPHB:战士:战术素养:7', combat: { name: '战术素养' } },
      ],
    };
    expect(checkParts(many, base)).toEqual([]);
  });

  it('空答卷和 skip 都放行（这条确实没内容写）', () => {
    expect(checkParts({ parts: [] }, base)).toEqual([]);
    expect(checkParts({ skip: '纯叙事' }, base)).toEqual([]);
  });
});

describe('AI 双写：答卷 → 库条目', () => {
  const item = (): LibraryItem => {
    const parts = partsFromAnswer(good, { key: base.key });
    const r = checkItem({ kind: 'classFeature', name: '狂暴', parts, by: 'byok:deepseek-chat' }, 'hr-ai0001');
    expect(r.problems).toEqual([]);
    return r.item!;
  };

  it('落成库条目：服务器结构检查能过，两层规则都对', () => {
    const it0 = item();
    expect(it0.parts).toHaveLength(1);
    const [hr] = homeRulesOf(it0);
    expect(hr).toMatchObject({ id: it0.parts[0].id, covers: 'XPHB:野蛮人:狂暴:1' });
    expect(hr.resources?.[0]).toMatchObject({ id: 'rage', formula: 'cond(level >= 17, 6, 2)' });
    const [hb] = houseRulesOf(it0);
    expect(hb.key).toBe('XPHB:野蛮人:狂暴:1');
    expect((hb.entry as { tags?: string[] }).tags).toContain('ai');
  });

  it('重写一遍不会把卡上的勾选弄丢（同一个键沿用原来的 id）', () => {
    const it0 = item();
    const again = partsFromAnswer(good, { key: base.key, existing: it0 });
    expect(again[0].id).toBe(it0.parts[0].id);
  });

  it('子职那种多条：一个回答出多条 part', () => {
    const multi = {
      parts: [
        { key: 'XPHB:战士:卓越战技:3', name: '卓越战技', combat: { name: '卓越战技' } },
        { key: 'XPHB:战士:战术素养:7', name: '战术素养', sheet: { mods: [{ kind: 'initiative', bonus: 'pb' }] } },
      ],
    };
    const parts = partsFromAnswer(multi, { key: 'XPHB:战士:卓越战技:3' });
    expect(parts.map((p) => p.key)).toEqual(['XPHB:战士:卓越战技:3', 'XPHB:战士:战术素养:7']);
    expect(parts[1].sheet?.mods).toHaveLength(1);
    // 第 2 条只有卡面：也能落库（服务器结构检查要求每条至少有名字 / 数据之一）
    const r = checkItem({ kind: 'subclass', name: '战斗大师', parts, by: 'byok:test' }, 'hr-ai0002');
    expect(r.problems).toEqual([]);
  });
});

describe('说明书：双写那一节', () => {
  it('both 版有卡面那一节（mods / grants / choices / resources 和分界线），combat 版没有', () => {
    const both = aiSpec('both');
    expect(both).toContain('## 7. 卡面数据（静态层）怎么写');
    expect(both).toContain('7.1 `mods`');
    expect(both).toContain('`conditionImmune`');      // kind 表是从代码生成的那一份
    expect(both).toContain('`itemMastery`');
    expect(both).toContain('分界线');
    expect(aiSpec('combat')).not.toContain('## 7. 卡面数据');
  });

  it('卡面例子用的是真实数据（从 abilities-2024.json 里取的）', () => {
    const ex = aiSheetExamplesText();
    expect(ex).toContain('resources');
    expect(ex.length).toBeGreaterThan(100);
  });
});

describe.skipIf(!hasLocalData())('AI 双写：卡面试算', () => {
  it('真的有作用（AC +1）→ 不算问题', async () => {
    const env = await createNodeEnv();
    expect(await smokeSheet({ env } as never, fighter(), { mods: [{ kind: 'ac', bonus: 1 }] })).toEqual([]);
  });

  it('只有 note（本来就不改数值）→ 不该报', async () => {
    const env = await createNodeEnv();
    expect(await smokeSheet({ env } as never, fighter(), { mods: [{ kind: 'note', note: '记一笔' }] })).toEqual([]);
  });

  it('字段写对了但什么都没变 → 报出来', async () => {
    const env = await createNodeEnv();
    const problems = await smokeSheet({ env } as never, fighter(), { mods: [{ kind: 'skillBonus', skill: '不存在', bonus: 1 }] });
    expect(problems.join()).toContain('没有让这张卡');
  });

  it('算完把临时挂上去的那条拿掉（不影响后面的计算）', async () => {
    const env = await createNodeEnv();
    const before = await env.compute(fighter());
    await smokeSheet({ env } as never, fighter(), { mods: [{ kind: 'ac', bonus: 5 }] });
    const after = await env.compute(fighter());
    expect(after.ac).toBe(before.ac);
  });
});
