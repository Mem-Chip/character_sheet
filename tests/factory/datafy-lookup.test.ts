// 数据化循环里的「按需查资料」：查询轮和改稿轮分开算、查过的会提醒、轮数用完就催交卷
import { describe, expect, it } from 'vitest';
import { datafy } from '../../src/factory/ai';
import type { Chat, ChatMsg } from '../../src/factory/ai';

/** 按剧本依次回答的假模型：记下每次收到的对话，方便断言「结果回给它了」 */
function scripted(replies: string[]): { chat: Chat; sent: ChatMsg[][] } {
  const sent: ChatMsg[][] = [];
  let i = 0;
  return {
    sent,
    chat: async (msgs) => {
      sent.push(structuredClone(msgs));
      const r = replies[i++];
      if (r === undefined) throw new Error('剧本用完了');
      return r;
    },
  };
}

const req = (q: string) => JSON.stringify({ lookup: [{ tool: 'node', q }] });
const base = {
  spec: '速览',
  examples: '',
  task: '写一条',
  check: (a: unknown) => ((a as { ok?: boolean }).ok ? [] : ['不对']),
};

describe('按需查资料（datafy 的查询协议）', () => {
  it('回查询请求就去查，结果作为 user 消息发回去，然后拿答卷', async () => {
    const { chat, sent } = scripted([req('zone'), '{"ok":true}']);
    const calls: unknown[] = [];
    const r = await datafy({
      ...base, chat,
      lookup: {
        run: async (reqs) => { calls.push(reqs); return '## 查询 1：node zone\n\n区域的定义'; },
      },
    });
    expect(calls).toEqual([[{ tool: 'node', q: 'zone' }]]);
    expect(r.answer).toEqual({ ok: true });
    expect(r.problems).toEqual([]);
    expect(r.rounds).toBe(2);
    // 第二次发给模型的对话里带着查询结果
    const last = sent[1].map((m) => m.content).join('\n');
    expect(last).toContain('区域的定义');
    expect(last).toContain('接着写');
  });

  it('查询轮不算改稿轮：查一次之后还能按 maxFix 改一次', async () => {
    const { chat } = scripted([req('summon'), '{"bad":1}', '{"ok":true}']);
    const r = await datafy({ ...base, chat, maxFix: 1, lookup: { run: async () => '召唤的定义' } });
    expect(r.answer).toEqual({ ok: true });
    expect(r.rounds).toBe(3);
  });

  it('查够 maxLookup 轮就催交卷，之后不再查', async () => {
    const { chat, sent } = scripted([req('a'), req('b'), req('c'), '{"ok":true}']);
    let ran = 0;
    const r = await datafy({ ...base, chat, maxLookup: 2, lookup: { run: async () => { ran++; return '结果'; } } });
    expect(ran).toBe(2);
    expect(r.answer).toEqual({ ok: true });
    expect(sent[3].map((m) => m.content).join('\n')).toContain('查询轮数已经用完了');
  });

  it('催过之后还一直查：按答卷处理，不陪它兜圈', async () => {
    const { chat } = scripted([req('a'), req('b'), req('c'), req('d')]);
    let ran = 0;
    const r = await datafy({ ...base, chat, maxLookup: 1, lookup: { run: async () => { ran++; return '结果'; } } });
    expect(ran).toBe(1);
    expect(r.rounds).toBe(3);
    expect(r.problems.join('\n')).toContain('这是查询请求，不是答卷');
  });

  it('连着两轮查的全是查过的：提醒它别再查了', async () => {
    const { chat, sent } = scripted([req('zone'), req('zone'), req('zone'), '{"ok":true}']);
    const r = await datafy({ ...base, chat, lookup: { run: async () => '定义' } });
    expect(r.answer).toEqual({ ok: true });
    expect(sent[3].map((m) => m.content).join('\n')).toContain('这些你查过了');
  });

  it('答卷里混了 lookup 字段的当答卷处理（不查）', async () => {
    const { chat } = scripted(['{"parts":[],"lookup":[]}']);
    let ran = 0;
    const r = await datafy({ ...base, chat, maxFix: 0, lookup: { run: async () => { ran++; return ''; } } });
    expect(ran).toBe(0);
    expect(r.answer).toEqual({ parts: [], lookup: [] });
    expect(r.problems).toEqual(['不对']);
  });

  it('没给 lookup 就走了老路（查询请求被当成不合法的答卷）', async () => {
    const { chat } = scripted([req('zone'), '{"ok":true}']);
    const r = await datafy({ ...base, chat, maxFix: 0 });
    expect(r.answer).toEqual({ lookup: [{ tool: 'node', q: 'zone' }] });
    expect(r.problems).toEqual(['不对']);
    expect(r.rounds).toBe(1);
  });

  it('check 用作自查工具：拿的是同一份检查函数', async () => {
    const { chat, sent } = scripted([
      JSON.stringify({ lookup: [{ tool: 'check', draft: { ok: false } }] }),
      '{"ok":true}',
    ]);
    const r = await datafy({ ...base, chat, lookup: { run: async (reqs, ctx) => `自查：${(await ctx!.check!((reqs as Array<{ draft: unknown }>)[0].draft)).join('、')}` } });
    expect(r.answer).toEqual({ ok: true });
    expect(sent[1].map((m) => m.content).join('\n')).toContain('自查：不对');
  });
});
