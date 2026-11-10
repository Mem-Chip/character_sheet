// 接口这一层：response_format 不认就去掉重试；tools 不认就抛 ToolsUnsupported；函数调用的消息形状要对
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolsUnsupported, type ChatMsg } from '../../src/factory/ai';
import { createChat } from '../../src/factory/chat';

/** 假 fetch：按顺序发回预设的响应，同时记下每次发出去的请求体 */
function stubFetch(queue: Array<{ status?: number; body?: unknown }>) {
  const sent: Array<Record<string, unknown>> = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
    sent.push(JSON.parse(init.body) as Record<string, unknown>);
    const r = queue.shift();
    if (!r) throw new Error('剧本用完了');
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
  }));
  return sent;
}

const say = (content: string) => ({ body: { choices: [{ message: { content } }] } });
const chat = () => createChat({ baseUrl: 'https://x/v1/', model: 'm', key: 'k' });
const hello: ChatMsg[] = [{ role: 'user', content: '在吗' }];

afterEach(() => vi.unstubAllGlobals());

describe('接口调用（src/factory/chat.ts）', () => {
  it('文字通道：地址拼对、带 response_format、密钥走 Bearer', async () => {
    const sent = stubFetch([say('可以')]);
    expect(await chat()(hello)).toBe('可以');
    expect(sent[0]).toMatchObject({ model: 'm', response_format: { type: 'json_object' } });
    expect(sent[0].messages).toEqual([{ role: 'user', content: '在吗' }]);
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe('https://x/v1/chat/completions');
  });

  it('response_format 不认：去掉再试一次', async () => {
    const sent = stubFetch([
      { status: 400, body: { error: { message: 'response_format is not supported' } } },
      say('可以'),
    ]);
    expect(await chat()(hello)).toBe('可以');
    expect(sent[0].response_format).toBeDefined();
    expect(sent[1].response_format).toBeUndefined();
  });

  it('tools 通道：请求带函数定义，回 tool_calls 解析成参数对象', async () => {
    const sent = stubFetch([{
      body: {
        choices: [{
          message: {
            content: null,
            tool_calls: [
              { id: 'c1', type: 'function', function: { name: 'node', arguments: '{"q":"zone"}' } },
              { id: 'c2', type: 'function', function: { name: 'check', arguments: '{"draft":{"ok":true}}' } },
            ],
          },
        }],
      },
    }]);
    const r = await chat().tools!(hello, [{ name: 'node', description: '看节点', parameters: { type: 'object' } }]);
    expect(sent[0].tool_choice).toBe('auto');
    expect((sent[0].tools as unknown[])[0]).toMatchObject({ type: 'function', function: { name: 'node' } });
    expect(r.content).toBe('');
    expect(r.toolCalls).toEqual([
      { id: 'c1', name: 'node', args: { q: 'zone' } },
      { id: 'c2', name: 'check', args: { draft: { ok: true } } },
    ]);
  });

  it('函数调用的后续消息按接口要的形状发：tool_calls 是 JSON 字符串，回执带 tool_call_id', async () => {
    const sent = stubFetch([{ body: { choices: [{ message: { content: 'ok' } }] } }]);
    await chat()([
      { role: 'user', content: '写' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'node', args: { q: 'zone' } }] },
      { role: 'tool', toolCallId: 'c1', content: '区域的定义' },
    ]);
    const msgs = sent[0].messages as Array<Record<string, unknown>>;
    expect(msgs[1].tool_calls).toEqual([{ id: 'c1', type: 'function', function: { name: 'node', arguments: '{"q":"zone"}' } }]);
    expect(msgs[2]).toEqual({ role: 'tool', content: '区域的定义', tool_call_id: 'c1' });
  });

  it('tools 不认：抛 ToolsUnsupported，之后不再发带 tools 的请求', async () => {
    const sent = stubFetch([
      { status: 400, body: { error: { message: 'tools is not supported by this model' } } },
    ]);
    const c = chat();
    await expect(c.tools!(hello, [])).rejects.toBeInstanceOf(ToolsUnsupported);
    await expect(c.tools!(hello, [])).rejects.toBeInstanceOf(ToolsUnsupported);
    expect(sent).toHaveLength(1);
    // 文字通道照样能用
    stubFetch([say('可以')]);
    expect(await c(hello)).toBe('可以');
  });

  it('别的错误不装成「不支持 tools」', async () => {
    stubFetch([{ status: 401, body: { error: { message: 'bad key' } } }]);
    await expect(chat().tools!(hello, [])).rejects.toThrow(/401/);
  });
});
