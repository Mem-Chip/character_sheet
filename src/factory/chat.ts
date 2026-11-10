/**
 * 数据化工厂：OpenAI 兼容接口的调用（浏览器和 Node 共用同一份）。
 *
 * 两件事要在这一层处理掉：
 * - `response_format: json_object` 有的接口不认 → 去掉再试一次；
 * - 原生 tool calling 有的接口不认 → 抛 `ToolsUnsupported`，让 datafy 退回文字查询协议。
 * 密钥不落在这层（调用方传进来），浏览器和命令行的差别只在 `browser` 那句提示上。
 */
import type { Chat, ChatMsg, ChatReply, ToolCall, ToolChat } from './ai';
import { ToolsUnsupported } from './ai';
import type { ToolSpec } from './lookup';

export interface ChatHttpOpts {
  /** 到 /v1 为止 */
  baseUrl: string;
  model: string;
  key?: string;
  /** 要 JSON 输出（response_format: json_object），缺省要 */
  json?: boolean;
  /** 浏览器里调：连不上时提示多半是跨域 */
  browser?: boolean;
}

interface WireMsg {
  role: string;
  content: string;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

/** 我们的消息形状 → 接口要的形状（函数调用是 tool_calls，arguments 是 JSON 字符串） */
const wireMsg = (m: ChatMsg): WireMsg => ({
  role: m.role,
  content: m.content,
  ...(m.toolCalls?.length
    ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: JSON.stringify(c.args) } })) }
    : {}),
  ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
});

const parseArgs = (raw: unknown): Record<string, unknown> => {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  try {
    const v = JSON.parse(String(raw ?? '{}')) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch { return {}; }
};

/** 接口不认 tools 的表现：400 / 404 / 422，而且骂的就是 tools 这一套字段 */
const noTools = (status: number, body: string) =>
  (status === 400 || status === 404 || status === 422)
  && /tool_choice|tools|function[_ ]?call/i.test(body);

export function createChat(o: ChatHttpOpts): Chat {
  const url = `${o.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  let useJson = o.json !== false;
  let toolsOk: boolean | null = null;

  async function post(body: Record<string, unknown>, signal?: AbortSignal): Promise<{ status: number; ok: boolean; text: string }> {
    let r: Response;
    try {
      r = await fetch(url, {
        method: 'POST', signal,
        headers: { 'content-type': 'application/json', ...(o.key ? { authorization: `Bearer ${o.key}` } : {}) },
        body: JSON.stringify(body),
      });
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
      throw new Error(`连不上 ${url}${o.browser ? '（地址不对，或者这个接口不允许浏览器直接调用）' : '（地址不对，或者服务没起来）'}`);
    }
    return { status: r.status, ok: r.ok, text: await r.text() };
  }

  function messageOf(text: string): { content?: unknown; tool_calls?: unknown } {
    let data: { choices?: Array<{ message?: { content?: unknown; tool_calls?: unknown } }> };
    try { data = JSON.parse(text) as typeof data; } catch { throw new Error(`接口返回的不是 JSON：${text.slice(0, 200)}`); }
    return data.choices?.[0]?.message ?? {};
  }

  const chat = async (messages: ChatMsg[], signal?: AbortSignal): Promise<string> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await post({
        model: o.model, messages: messages.map(wireMsg), temperature: 0.2,
        ...(useJson ? { response_format: { type: 'json_object' } } : {}),
      }, signal);
      if (!res.ok) {
        // 有的接口不认 response_format：去掉再试一次
        if (useJson && res.status === 400 && /response_format|json_object/i.test(res.text)) { useJson = false; continue; }
        throw new Error(`接口返回 ${res.status}：${res.text.slice(0, 300)}`);
      }
      const content = messageOf(res.text).content;
      if (typeof content !== 'string' || !content.trim()) throw new Error(`接口没给出内容：${res.text.slice(0, 200)}`);
      return content;
    }
    throw new Error('接口调用失败');
  };

  const tools: ToolChat = async (messages: ChatMsg[], specs: ToolSpec[], signal?: AbortSignal): Promise<ChatReply> => {
    if (toolsOk === false) throw new ToolsUnsupported();
    const res = await post({
      model: o.model, messages: messages.map(wireMsg), temperature: 0.2,
      tools: specs.map((s) => ({ type: 'function', function: { name: s.name, description: s.description, parameters: s.parameters } })),
      tool_choice: 'auto',
    }, signal);
    if (!res.ok) {
      if (noTools(res.status, res.text)) {
        toolsOk = false;
        throw new ToolsUnsupported(`接口不认 tools（${res.status}）：${res.text.slice(0, 120)}`);
      }
      throw new Error(`接口返回 ${res.status}：${res.text.slice(0, 300)}`);
    }
    toolsOk = true;
    const msg = messageOf(res.text);
    const calls: ToolCall[] = Array.isArray(msg.tool_calls)
      ? (msg.tool_calls as Array<{ id?: unknown; function?: { name?: unknown; arguments?: unknown } }>)
        .map((c, i) => ({
          id: typeof c.id === 'string' && c.id ? c.id : `call_${i + 1}`,
          name: String(c.function?.name ?? ''),
          args: parseArgs(c.function?.arguments),
        }))
      : [];
    return { content: typeof msg.content === 'string' ? msg.content : '', toolCalls: calls };
  };

  return Object.assign(chat, { tools });
}
