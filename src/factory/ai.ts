/**
 * 数据化工厂：自带密钥的 AI 数据化（浏览器直接调 OpenAI 兼容接口，不经过服务器）。
 *
 * 一轮 = 说明书（system）+ 例子 + 任务 → 模型出 JSON → 检查（结构、审计、资源、试算）→
 * 没过就把问题原样回给它再改（最多 maxFix 次）。人看了不满意，写一句修改意见再来一轮（带上上一版）。
 * 纯逻辑：怎么调接口（chat）、怎么检查（check）由调用方给。
 */
import type { ParsedMonster } from '../bridge/from-monster';

export interface ChatMsg { role: 'system' | 'user' | 'assistant'; content: string }
export type Chat = (messages: ChatMsg[], signal?: AbortSignal) => Promise<string>;

export interface DatafyInput {
  chat: Chat;
  /** 说明书（buildSpec） */
  spec: string;
  /** 例子：键 → Entry 的 JSON */
  examples: string;
  /** 任务（renderTask / renderMonsterTask） */
  task: string;
  /** 检查一份答卷，返回问题（空 = 通过） */
  check: (answer: unknown) => string[] | Promise<string[]>;
  /** 上一版 + 人写的修改意见 */
  previous?: unknown;
  feedback?: string;
  /** 检查没过时自动让它改几次（缺省 2） */
  maxFix?: number;
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
  let raw = '';
  let answer: unknown = null;
  let problems: string[] = [];
  for (let round = 0; ; round++) {
    input.onStep?.(round ? `检查没过，让它改（第 ${round} 次）…` : '等模型回答…');
    raw = await input.chat(msgs, input.signal);
    try {
      answer = parseAnswer(raw);
      input.onStep?.('检查中…');
      problems = await input.check(answer);
    } catch (e) {
      answer = null;
      problems = [`不是合法的 JSON：${(e as Error).message}`];
    }
    if (!problems.length || round >= maxFix) return { answer, problems, raw, rounds: round + 1 };
    msgs.push({ role: 'assistant', content: raw });
    msgs.push({ role: 'user', content: `检查没过：\n${problems.map((p) => `- ${p}`).join('\n')}\n\n改好后输出完整的 JSON（只输出 JSON）。` });
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
