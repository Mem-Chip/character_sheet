/**
 * 按需查资料的对比考试（AI-LOOKUP.md 第 5 步）：同一批题，用「速览 + 现查」和「一次给全」各跑一遍。
 *
 *   npx tsx tools/factory/exam.ts prepare                            出卷（.factory/exam-<时间>/）
 *   npx tsx tools/factory/exam-run.ts run <卷> --fold A --mode brief   跑一遍（要接口，见下）
 *   npx tsx tools/factory/exam.ts grade <卷> answers-brief            阅卷
 *
 * 接口走环境变量（OpenAI 兼容的 /chat/completions）：
 *   OPENAI_BASE_URL（到 /v1 为止）、OPENAI_API_KEY、OPENAI_MODEL
 * 答案写在 `<卷>/answers-<mode>/`，两个模式各跑一遍再分别阅卷，比通过率、自查次数、交上来的字数。
 * 做题和阅卷分开：卷子里的 spec.md / examples-<组>.json 是标准答案的对照组，跑的时候按模式自己挑。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { GOLDEN_FILES } from '../../src/bridge/rule-files';
import type { Entry, RuleFile } from '../../src/combat';
import { buildBrief, buildSpec, checkEntry } from '../../src/factory';
import { datafy, type Chat, type ChatMsg } from '../../src/factory/ai';
import { createChat } from '../../src/factory/chat';
import { createLookup } from '../../src/factory/lookup';

const ROOT = resolve(import.meta.dirname, '..', '..');
const FILES = GOLDEN_FILES as RuleFile[];

/** 速览版附的那几条典型例子；考试时要把本组考到的题剔掉，免得白送答案 */
const BRIEF_EXAMPLES = ['XPHB:野蛮人:狂暴:1', 'XPHB:游荡者:偷袭:1', 'XPHB:spell:火球术', 'XPHB:spell:野兽召唤术', 'XPHB:spell:匕首之云'];

interface ManifestRow { id: string; key: string; fold: string; name: string }

const args = process.argv.slice(2);
const cmd = args[0];
const dir = args[1] ? resolve(args[1]) : '';
const opt = (name: string, dflt?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};

/** 环境变量里的接口 → Chat（和浏览器侧同一份实现，只是不经过 localStorage） */
function envChat(): Chat {
  const baseUrl = process.env.OPENAI_BASE_URL ?? '';
  const model = process.env.OPENAI_MODEL ?? '';
  if (!baseUrl || !model) throw new Error('先设 OPENAI_BASE_URL / OPENAI_MODEL（还有 OPENAI_API_KEY）');
  return createChat({ baseUrl, model, key: process.env.OPENAI_API_KEY ?? '' });
}

async function run(): Promise<void> {
  if (!dir || !existsSync(resolve(dir, 'manifest.json'))) throw new Error('用法：exam-run.ts run <卷目录> [--fold A|B] [--mode brief|full] [--max N]');
  const fold = opt('fold');
  const mode = (opt('mode', 'brief') === 'full' ? 'full' : 'brief') as 'brief' | 'full';
  if (mode === 'full' && !opt('fold')) throw new Error('一次给全（--mode full）要指定 --fold：不然另一组的答案会从例子里漏出去');
  const max = Number(opt('max', '0')) || 0;
  const manifest = JSON.parse(readFileSync(resolve(dir, 'manifest.json'), 'utf8')) as ManifestRow[];
  const todo = manifest.filter((m) => !fold || m.fold === fold).slice(0, max || undefined);
  const answers = resolve(dir, `answers-${mode}`);
  mkdirSync(answers, { recursive: true });

  // 例子里不能出现这一组的答案（出卷时已经按组切开了；查询工具也照这个来）
  const gold: Record<string, Entry> = {};
  for (const f of FILES) Object.assign(gold, f.entries);
  const foldKeys = new Set(manifest.filter((m) => !fold || m.fold === fold).map((m) => m.key));
  const spec = mode === 'brief'
    ? buildBrief({ typesSource: readFileSync(resolve(ROOT, 'src', 'combat', 'types.ts'), 'utf8') })
    : readFileSync(resolve(dir, 'spec.md'), 'utf8');
  const examples = mode === 'brief'
    ? JSON.stringify(Object.fromEntries(
      [...BRIEF_EXAMPLES.filter((k) => !foldKeys.has(k)), ...Object.keys(gold).filter((k) => !foldKeys.has(k))]
        .slice(0, 5).map((k) => [k, gold[k]]),
    ))
    : readFileSync(resolve(dir, `examples-${fold || 'A'}.json`), 'utf8');
  const lookup = mode === 'brief'
    ? createLookup({
      spec: readFileSync(resolve(dir, 'spec.md'), 'utf8'),
      typesSource: readFileSync(resolve(ROOT, 'src', 'combat', 'types.ts'), 'utf8'),
      entries: Object.fromEntries(Object.entries(gold).filter(([k]) => !foldKeys.has(k))),
    })
    : null;

  const chat = envChat();
  console.log(`卷：${dir}\n模式：${mode}；题：${todo.length} 道（${fold || 'A + B'}）；说明书 ${spec.length} 字；例子 ${examples.length} 字`);
  const rows: string[] = [];
  for (const m of todo) {
    const task = readFileSync(resolve(dir, 'tasks', `${m.id}.md`), 'utf8');
    const ctx = JSON.parse(readFileSync(resolve(dir, 'tasks', `${m.id}.ctx.json`), 'utf8')) as { key: string; resourceIds?: string[]; classTableColumns?: string[] };
    let chars = 0;
    let queries = 0;
    // 记一下发给模型的字数（≈token 的量级），函数通道也要算上
    const count = (msgs: ChatMsg[]) => { chars += msgs.reduce((n, x) => n + x.content.length, 0); };
    const countingChat: Chat = Object.assign(
      async (msgs: ChatMsg[], signal?: AbortSignal) => { count(msgs); return chat(msgs, signal); },
      chat.tools ? { tools: async (msgs: ChatMsg[], tools: Parameters<NonNullable<Chat['tools']>>[1], signal?: AbortSignal) => { count(msgs); return chat.tools!(msgs, tools, signal); } } : {},
    );
    const r = await datafy({
      chat: countingChat, spec, examples, task,
      check: (a) => checkEntry(a, ctx, FILES),
      ...(lookup ? { lookup: { run: async (reqs, c) => { queries++; return lookup.run(reqs, c); } } } : {}),
    });
    const answer = r.answer ?? { skip: `没交出合法的 JSON：${r.problems.join('；')}` };
    writeFileSync(resolve(answers, `${m.id}.json`), JSON.stringify(answer, null, 1));
    const state = r.problems.length ? `还剩 ${r.problems.length} 个问题` : '检查通过';
    rows.push(`${m.id} ${m.name}：${state}；查 ${queries} 轮；发给模型的字 ${chars}`);
    console.log(`  ${rows[rows.length - 1]}`);
  }
  writeFileSync(resolve(dir, `run-${mode}.txt`), rows.join('\n') + '\n');
  console.log(`\n答案在 ${answers}\n阅卷：npx tsx tools/factory/exam.ts grade ${dir} answers-${mode}`);
}

if (cmd === 'run') await run();
else console.log('用法：exam-run.ts run <卷目录> [--fold A|B] [--mode brief|full] [--max N]\n出卷和阅卷用 tools/factory/exam.ts');
