/**
 * 数据化工厂：自带密钥的 AI 数据化（浏览器直接调 OpenAI 兼容接口，不经过服务器）。
 *
 * 一轮 = 说明书（system）+ 例子 + 任务 → 模型出 JSON → 检查（结构、审计、资源、试算）→
 * 没过就把问题原样回给它再改（最多 maxFix 次）。人看了不满意，写一句修改意见再来一轮（带上上一版）。
 *
 * 说明书太长时走「按需查资料」（AI-LOOKUP.md）：给的是速览版 + `lookup` 工具，
 * 模型先回 `{ "lookup": [...] }` 要细节，我们查完发回去，它接着写。查询轮数和改稿轮数分开算。
 * 纯逻辑：怎么调接口（chat）、怎么检查（check）、怎么查（lookup）由调用方给。
 */
import type { ParsedMonster } from '../bridge/from-monster';
import { isLookupReq, lookupTools, type Lookup, type LookupReq, type LookupTool, type ToolSpec } from './lookup';

/** 一次函数调用（原生 tool calling）：模型要我们查什么 */
export interface ToolCall { id: string; name: string; args: Record<string, unknown> }
/** 模型的一轮回复：文字 + 可能还有要调的函数 */
export interface ChatReply { content: string; toolCalls: ToolCall[] }

export interface ChatMsg {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** assistant 这一轮调了哪些函数 */
  toolCalls?: ToolCall[];
  /** role: 'tool' 的回执对应哪一次调用 */
  toolCallId?: string;
}

/** 接口支持原生 tool calling 时的另一条通道 */
export type ToolChat = (messages: ChatMsg[], tools: ToolSpec[], signal?: AbortSignal) => Promise<ChatReply>;

export type Chat = ((messages: ChatMsg[], signal?: AbortSignal) => Promise<string>) & {
  /** 挂上它 = 这个接口能传 tools；datafy 会优先走函数调用，不认就退回文字协议 */
  tools?: ToolChat;
};

/** 接口不认 tools 参数（本地小模型、部分中转站）：datafy 见到它就退回文字协议 */
export class ToolsUnsupported extends Error {
  constructor(message = '这个接口不支持函数调用') { super(message); this.name = 'ToolsUnsupported'; }
}

/** 函数调用的参数 → 我们的查询请求（名字允许带 lookup_ 前缀，模型偶尔会自己加） */
export function callToReq(c: ToolCall): LookupReq {
  const name = c.name.replace(/^lookup[_:.-]/i, '') as LookupTool;
  return { tool: name, q: typeof c.args.q === 'string' ? c.args.q : '', draft: c.args.draft };
}


export interface DatafyInput {
  chat: Chat;
  /** 说明书（buildSpec；按需查资料时是 buildBrief） */
  spec: string;
  /** 例子：键 → Entry 的 JSON */
  examples: string;
  /** 任务（renderTask / renderMonsterTask） */
  task: string;
  /** 检查一份答卷，返回问题（空 = 通过）；`check` 工具也是用它 */
  check: (answer: unknown) => string[] | Promise<string[]>;
  /** 上一版 + 人写的修改意见 */
  previous?: unknown;
  feedback?: string;
  /** 检查没过时自动让它改几次（缺省 2） */
  maxFix?: number;
  /** 按需查资料的工具（createLookup 的产物；只用得到 run——检查由 check 提供） */
  lookup?: Pick<Lookup, 'run'>;
  /** 最多查几轮（缺省 6，和改稿轮数分开算） */
  maxLookup?: number;
  onStep?: (msg: string) => void;
  signal?: AbortSignal;
}

export interface DatafyResult {
  answer: unknown;
  /** 最后一版还剩的问题 */
  problems: string[];
  /** 最后一次的原始输出 */
  raw: string;
  rounds: number;
}

/** 从模型输出里取 JSON：去掉 ```json 围栏，取第一个 { 到最后一个 } */
export function parseAnswer(text: string): unknown {
  const t = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  try { return JSON.parse(t); } catch { /* 前后有废话 */ }
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('输出里没有 JSON 对象');
  return JSON.parse(t.slice(a, b + 1));
}

export const isSkip = (a: unknown): a is { skip: string } =>
  !!a && typeof a === 'object' && 'skip' in (a as object) && Object.keys(a as object).length === 1;

export async function datafy(input: DatafyInput): Promise<DatafyResult> {
  const msgs: ChatMsg[] = [
    { role: 'system', content: input.spec },
    // 例子可以不给（整理自制书那一步：说明书里已经有格式）
    ...(input.examples.trim() ? [
      { role: 'user' as const, content: `## 例子（键 → Entry，照它们的风格和粒度写）\n\n\`\`\`json\n${input.examples}\n\`\`\`` },
      { role: 'assistant' as const, content: '明白，我会照说明书和例子的写法输出。请给任务。' },
    ] : []),
    {
      role: 'user',
      content: input.task + (input.previous !== undefined
        ? `\n## 上一版\n\n\`\`\`json\n${JSON.stringify(input.previous, null, 1)}\n\`\`\`\n\n## 修改意见\n\n${input.feedback?.trim() || '（没写，按说明书再检查一遍）'}\n\n在上一版的基础上改，输出改好的完整 JSON。\n`
        : ''),
    },
  ];
  const maxFix = input.maxFix ?? 2;
  const maxLookup = input.maxLookup ?? 6;
  const lookup = input.lookup;
  const toolChat = input.chat.tools;
  let useTools = !!lookup && !!toolChat;
  let raw = '';
  let answer: unknown = null;
  let problems: string[] = [];
  let chats = 0;      // 一共问了几次模型
  let fixes = 0;      // 检查没过、让它改了几次
  let queries = 0;    // 查了几轮资料
  let closed = false; // 已经告诉过它「不能再查了」
  let stale = 0;      // 连续几轮查的全是查过的
  const seen = new Set<string>();

  for (;;) {
    input.onStep?.(fixes ? `检查没过，让它改（第 ${fixes} 次）…` : '等模型回答…');
    let calls: ToolCall[] = [];
    if (useTools) {
      // 原生 tool calling：接口认 tools 就用它；不认就退回文字协议（这次请求没进历史）
      try {
        const reply = await toolChat!(msgs, lookupTools(), input.signal);
        raw = reply.content ?? '';
        calls = reply.toolCalls ?? [];
        chats++;
      } catch (e) {
        if (!(e instanceof ToolsUnsupported)) throw e;
        useTools = false;
        input.onStep?.('这个接口不支持函数调用，改用文字查询…');
        msgs.push({ role: 'user', content: '这个接口不支持函数调用：要资料时只回一个 JSON 查询请求 `{"lookup":[…]}`（照速览第 0 节），不要调用函数。' });
        continue;
      }
    } else {
      raw = await input.chat(msgs, input.signal);
      chats++;
    }

    let parsed: unknown;
    let badJson: string | null = null;
    if (!calls.length) {
      try { parsed = parseAnswer(raw); } catch (e) { badJson = `不是合法的 JSON：${(e as Error).message}`; }
    }

    // 这一回要的是资料，不是答卷（函数调用优先，其次是文字协议）
    const reqs: LookupReq[] | null = calls.length ? calls.map(callToReq)
      : !badJson && lookup && isLookupReq(parsed) ? (parsed.lookup as unknown[]).filter((r): r is LookupReq => !!r && typeof r === 'object')
        : null;
    if (reqs && lookup) {
      if (closed) {
        // 说过不能再查了还查：按答卷处理，交给检查去报，不再陪它兜圈
        answer = parsed ?? null;
        problems = [...await safeCheck(input.check, answer), '这是查询请求，不是答卷'];
        return { answer, problems, raw, rounds: chats };
      }
      const sig = reqs.map((r) => `${r.tool}:${String(r.q ?? '')}`);
      const fresh = sig.filter((s) => !seen.has(s));
      for (const s of sig) seen.add(s);
      stale = fresh.length ? 0 : stale + 1;
      if (queries >= maxLookup) {
        closed = true;
        // 不带 toolCalls 的助手消息：API 要求 tool_calls 后面必须跟 tool 回执，这里干脆只发一条 user
        msgs.push({ role: 'user', content: '查询轮数已经用完了，不能再查了。照速览直接输出答卷（做不到的部分写 skip / manual）。' });
        continue;
      }
      queries++;
      input.onStep?.(`查资料（第 ${queries} 轮）：${sig.map((s) => s.replace(':', ' ')).join('、') || '（空）'}`);
      if (calls.length) {
        // 函数调用：一条助手消息带全部调用，每个调用各回一条 tool 结果
        const results: string[] = [];
        for (const r of reqs) results.push(await lookup.run([r], { check: input.check }));
        msgs.push({ role: 'assistant', content: raw, toolCalls: calls });
        results.forEach((text, i) => msgs.push({ role: 'tool', toolCallId: calls[i].id, content: text }));
        if (stale >= 2) msgs.push({ role: 'user', content: '这些你查过了，没有新东西。别再查了，照现在知道的直接写答卷。' });
      } else {
        const text = await lookup.run(reqs, { check: input.check });
        msgs.push({ role: 'assistant', content: raw });
        msgs.push({
          role: 'user',
          content: `## 查询结果\n\n${text}\n\n`
            + (stale >= 2 ? '这些你查过了，没有新东西。别再查了，照现在知道的直接写答卷。\n' : '接着写。要更多细节就再查，够了就输出答卷。\n'),
        });
      }
      continue;
    }

    // 答卷（混了 lookup 字段的也算答卷）
    if (badJson) {
      answer = null;
      problems = [badJson];
    } else {
      input.onStep?.('检查中…');
      answer = parsed;
      problems = await safeCheck(input.check, parsed);
    }
    if (!problems.length || fixes >= maxFix) return { answer, problems, raw, rounds: chats };
    fixes++;
    msgs.push({ role: 'assistant', content: raw });
    msgs.push({ role: 'user', content: `检查没过：\n${problems.map((p) => `- ${p}`).join('\n')}\n\n改好后输出完整的 JSON（只输出 JSON）。` });
  }
}

/** 检查出错不该把整轮对话弄崩：当成一条问题报回去 */
async function safeCheck(check: (a: unknown) => string[] | Promise<string[]>, a: unknown): Promise<string[]> {
  try {
    return await check(a);
  } catch (e) {
    return [`检查出错：${(e as Error).message}`];
  }
}

/* ───── 怪物：一只怪的所有「要手动处理」一次写完 ───── */

export function renderMonsterTask(p: ParsedMonster, cr: string): string {
  const v = p.view;
  const lines = [
    `# 任务：怪物「${v.name}」要手动处理的能力`, '',
    `- ${v.size} ${v.type}，挑战等级 ${cr}；AC ${v.ac}，生命值 ${v.hpMax}，熟练加值 ${v.pb}（\`self.pb\`）`,
    `- 属性值：${Object.entries(v.score ?? {}).map(([k, n]) => `${k} ${n}`).join('、')}（调整值用 \`self.mod.str\` 这些）`,
    '- 怪物没有施法属性：法术的 DC、攻击加值一律写原文给的数字，不要用 `self.spell`。',
    `- 现有资源：${Object.entries(v.resources ?? {}).map(([k, n]) => `\`${k}\`（${n}）`).join('、') || '没有'}`,
  ];
  if (p.auto.length) lines.push('', '## 引擎已经自动处理了（不要重复写）', '', p.auto.map((a) => `- ${a}`).join('\n'));
  lines.push('', '## 要你写的（每条单独一个 Entry）', '');
  for (const n of p.notes) lines.push(`### ${n.name}`, `（${n.group}）${n.text}`, '');
  lines.push(
    '## 输出格式（和说明书 §1 不同，以这里为准）', '',
    '一个 JSON 对象：键是上面每一条的名字（原样照抄 ### 后面的），值是这一条的 Entry，或者 `{ "skip": "原因" }`。',
    '- 动作的 `id` 用英文小写加短横线；名字以能力名开头。',
    '- 「（X/日）」这类次数：在那条 Entry 顶层 `resources: [{ id: \'<能力名>\', name: \'<能力名>\', formula: X, recovery: \'long\' }]`，动作 `cost: [{ resource: \'<能力名>\' }]`。',
    "- 「（充能 5–6）」：`cost: [{ recharge: '5-6', id: '<能力名>' }]`（只有 6 就写 '6'）。",
    '- 「命中后的附带效果」：写成 `attackHit` after 窗口、`role: \'actor\'` 的触发器，`when` 里用 `attack.item` 或攻击名限定是哪一招（拿不准就 `ask`）。',
    '- 施法：常用的攻击 / 豁免法术写成动作（DC 用原文的数），其余的写 `{ "automation": "manual", "text": "…" }`。',
    '- 做不到、没把握的照样 skip 或 manual，不要硬写。',
  );
  return lines.join('\n') + '\n';
}
