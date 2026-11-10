// 原生 tool calling：有函数就调函数，不认 tools 就退回文字协议；两条通道共用一个查询计数
import { describe, expect, it } from 'vitest';
import { datafy, ToolsUnsupported, type Chat, type ChatMsg, type ChatReply, type ToolCall } from '../../src/factory/ai';

/** 假模型：既会说话也会调函数 */
function scripted(replies: Array<{ content: string; toolCalls?: ToolCall[] } | Error>): { chat: Chat; sent: ChatMsg[][]; toolSpecs: string[][] } {
  const sent: ChatMsg[][] = [];
  const toolSpecs: string[][] = [];
  let i = 0;
  const next = () => {
    const r = replies[i++];
    if (r === undefined) throw new Error('剧本用完了');
    return r;
  };
  const chat = (async (msgs: ChatMsg[]) => {
    sent.push(structuredClone(msgs));
    const r = next();
    if (r instanceof Error) throw r;
    return r.content;
  }) as Chat;
  chat.tools = async (msgs: ChatMsg[], tools): Promise<ChatReply> => {
    sent.push(structuredClone(msgs));
    toolSpecs.push(tools.map((t) => t.name));
    const r = next();
    if (r instanceof Error) throw r;
    return { content: r.content, toolCalls: r.toolCalls ?? [] };
  };
  return { chat, sent, toolSpecs };
}

const call = (id: string, name: string, q: string): ToolCall => ({ id, name, args: { q } });
const base = {
  spec: '速览',
  examples: '',
  task: '写一条',
  check: (a: unknown) => ((a as { ok?: boolean }).ok ? [] : ['不对']),
  lookup: { run: async (reqs: unknown) => `结果：${JSON.stringify(reqs)}` },
};

describe('原生 tool calling', () => {
  it('先调函数、拿结果、再交卷；工具是速览里那几个', async () => {
    const { chat, sent, toolSpecs } = scripted([
      { content: '', toolCalls: [call('c1', 'node', 'zone'), call('c2', 'example', 'summon')] },
      { content: '{"ok":true}' },
    ]);
    const r = await datafy({ ...base, chat });
    expect(r.answer).toEqual({ ok: true });
    expect(r.rounds).toBe(2);
    expect(toolSpecs[0]).toEqual(['node', 'type', 'window', 'expr', 'spec', 'example', 'check']);
    // 第二次发的对话：助手消息带 tool_calls，每个调用各一条 tool 回执
    const msgs = sent[1];
    const assistant = msgs[msgs.length - 3];
    expect(assistant.role).toBe('assistant');
    expect(assistant.toolCalls?.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(msgs[msgs.length - 2]).toMatchObject({ role: 'tool', toolCallId: 'c1' });
    expect(msgs[msgs.length - 2].content).toContain('node');
    expect(msgs[msgs.length - 1]).toMatchObject({ role: 'tool', toolCallId: 'c2' });
  });

  it('接口不认 tools：退回文字协议，还能交卷', async () => {
    const { chat, sent, toolSpecs } = scripted([
      new ToolsUnsupported('不支持'),
      { content: '{"lookup":[{"tool":"node","q":"zone"}]}' },
      { content: '{"ok":true}' },
    ]);
    const r = await datafy({ ...base, chat });
    expect(r.answer).toEqual({ ok: true });
    // 第一次走函数通道失败；之后两次都是文字通道
    expect(toolSpecs).toHaveLength(1);
    expect(sent[1].map((m) => m.content).join('\n')).toContain('这个接口不支持函数调用');
  });

  it('文字和函数一起回：当「要资料」，文字留在助手消息里', async () => {
    const { chat, sent } = scripted([
      { content: '我查一下区域的定义。', toolCalls: [call('c1', 'node', 'zone')] },
      { content: '{"ok":true}' },
    ]);
    const r = await datafy({ ...base, chat });
    expect(r.answer).toEqual({ ok: true });
    const assistant = sent[1].find((m) => m.role === 'assistant' && m.toolCalls?.length);
    expect(assistant?.content).toContain('我查一下');
  });

  it('轮数上限对函数通道一样生效', async () => {
    const { chat } = scripted([
      { content: '', toolCalls: [call('c1', 'node', 'a')] },
      { content: '', toolCalls: [call('c2', 'node', 'b')] },
      { content: '{"ok":true}' },
    ]);
    let ran = 0;
    const r = await datafy({ ...base, chat, maxLookup: 1, lookup: { run: async () => { ran++; return '结果'; } } });
    expect(ran).toBe(1);
    expect(r.answer).toEqual({ ok: true });
  });

  it('函数名带了 lookup_ 前缀也认', async () => {
    const { chat } = scripted([
      { content: '', toolCalls: [call('c1', 'lookup_node', 'zone')] },
      { content: '{"ok":true}' },
    ]);
    const seen: unknown[] = [];
    await datafy({ ...base, chat, lookup: { run: async (reqs) => { seen.push(reqs); return '结果'; } } });
    expect(seen).toEqual([[{ tool: 'node', q: 'zone', draft: undefined }]]);
  });

  it('函数调用里也能自查（check 的 draft 是整份答卷）', async () => {
    const { chat, sent } = scripted([
      { content: '', toolCalls: [{ id: 'c1', name: 'check', args: { draft: { ok: false } } }] },
      { content: '{"ok":true}' },
    ]);
    await datafy({
      ...base, chat,
      lookup: {
        run: async (reqs, ctx) => (await ctx!.check!((reqs as Array<{ draft: unknown }>)[0].draft)).join('、'),
      },
    });
    const tool = sent[1].find((m) => m.role === 'tool');
    expect(tool?.content).toBe('不对');
  });
});
