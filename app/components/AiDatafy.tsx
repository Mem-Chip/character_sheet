/**
 * 「AI 数据化」对话框：拼任务 → 调你自己的模型 → 检查（结构、审计、试算）→ 没过自动让它改 →
 * 你看结果，不满意写一句修改意见再来一轮，满意就存。结果可以直接手改，改完点「重新检查」。
 */
import { useEffect, useRef, useState } from 'react';
import { datafy } from '../../src/factory/ai';
import { AI_PRESETS, aiBy, aiExamples, aiSpec, makeChat, setAiSettings, useAiSettings, type AiJob, type AiSettings } from '../lib/ai';
import { Dialog, Field } from './ui';

export function AiDatafy(p: {
  title: string;
  prepare: () => Promise<AiJob>;
  /** 已有的结果（再改一版用） */
  initial?: unknown;
  saveLabel?: string;
  /** 说明书：缺省只讲动态层（怪物那种按名字回答的流程）；资料库的双写流程传 `aiSpec('both')` */
  spec?: string;
  /** 例子：缺省是战斗黄金条目；双写流程再拼上卡面数据的例子 */
  examples?: string;
  onSave: (answer: unknown, by: string) => Promise<string[] | void>;
  onClose: () => void;
}) {
  const settings = useAiSettings();
  const [editSettings, setEditSettings] = useState(!settings);
  const [job, setJob] = useState<AiJob | null>(null);
  const [prepErr, setPrepErr] = useState('');
  const [text, setText] = useState(p.initial === undefined ? '' : JSON.stringify(p.initial, null, 1));
  const [problems, setProblems] = useState<string[]>([]);
  const [checked, setChecked] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [step, setStep] = useState('');
  const [err, setErr] = useState('');
  const [showTask, setShowTask] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const running = !!step;

  useEffect(() => {
    p.prepare().then(setJob, (e: Error) => setPrepErr(e.message));
    return () => abort.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const parsed = (): unknown => { try { return text.trim() ? JSON.parse(text) : undefined; } catch { return undefined; } };

  const run = async (revise: boolean) => {
    if (!job || !settings) return;
    setErr('');
    abort.current = new AbortController();
    try {
      const r = await datafy({
        chat: makeChat(settings), spec: p.spec ?? aiSpec(), examples: p.examples ?? aiExamples(), task: job.task, check: job.check,
        ...(revise ? { previous: parsed(), feedback } : {}),
        onStep: setStep, signal: abort.current.signal,
      });
      setText(r.answer === null ? r.raw : JSON.stringify(r.answer, null, 1));
      setProblems(r.problems);
      setChecked(true);
      if (revise) setFeedback('');
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setErr((e as Error).message);
    } finally {
      setStep('');
      abort.current = null;
    }
  };

  const recheck = async () => {
    if (!job) return;
    const a = parsed();
    setProblems(a === undefined ? ['不是合法的 JSON'] : await job.check(a));
    setChecked(true);
  };

  const save = async () => {
    const a = parsed();
    if (a === undefined) { setProblems(['不是合法的 JSON']); return; }
    if (problems.length && !confirm('检查还有问题，仍然存？（服务器只查结构，写错的地方战斗里可能不生效）')) return;
    try {
      const r = await p.onSave(a, aiBy(settings));
      if (r && r.length) setProblems(r); else p.onClose();
    } catch (e) { setErr((e as Error).message); }
  };

  if (editSettings) return <AiSettingsDialog onClose={() => (settings ? setEditSettings(false) : p.onClose())} onSaved={() => setEditSettings(false)} />;

  return (
    <Dialog title={p.title} onClose={p.onClose} footer={<>
      <span className="small muted" style={{ flex: 1 }}>
        {settings?.model} · <button className="btn ghost sm" onClick={() => setEditSettings(true)}>接口设置</button>
      </span>
      {running && <button className="btn" onClick={() => abort.current?.abort()}>停止</button>}
      <button className="btn" onClick={p.onClose}>取消</button>
      <button className="btn primary" disabled={running || !text.trim()} onClick={() => void save()}>{p.saveLabel ?? '存'}</button>
    </>}>
      <div className="stack" style={{ gap: 8 }}>
        {prepErr && <div className="dangerline small">拼任务出错：{prepErr}</div>}
        {!job && !prepErr && <div className="small muted">正在准备任务…</div>}
        {job && (
          <div className="row small" style={{ gap: 6, flexWrap: 'wrap' }}>
            {!text.trim()
              ? <button className="btn primary sm" disabled={running} onClick={() => void run(false)}>开始</button>
              : <button className="btn sm" disabled={running} onClick={() => { if (confirm('从头重写？现在的结果会被替换')) void run(false); }}>从头重写</button>}
            <button className="btn ghost sm" onClick={() => setShowTask(!showTask)}>{showTask ? '收起任务' : '看给模型的任务'}</button>
            <span className="muted">{step}</span>
          </div>
        )}
        {showTask && job && <pre className="json" style={{ maxHeight: 240, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{job.task}</pre>}
        {err && <div className="dangerline small">{err}</div>}
        {text.trim() !== '' && <>
          <Field label="结果（可以直接改，改完点「重新检查」）">
            <textarea className="mono" rows={14} value={text} onChange={(e) => { setText(e.target.value); setChecked(false); }} spellCheck={false} />
          </Field>
          <div className="row small" style={{ gap: 6 }}>
            <button className="btn ghost sm" disabled={running} onClick={() => void recheck()}>重新检查</button>
            {checked && !problems.length && <span className="ok">检查通过（结构、审计、试算）</span>}
          </div>
          {problems.length > 0 && <div className="dangerline small">{problems.map((x, i) => <div key={i}>{x}</div>)}</div>}
          <Field label="修改意见（写给模型，比如「豁免失败才倒地」「这是附赠动作」）">
            <textarea rows={2} value={feedback} onChange={(e) => setFeedback(e.target.value)} />
          </Field>
          <div className="row"><button className="btn sm" disabled={running || !feedback.trim()} onClick={() => void run(true)}>按意见再改</button></div>
        </>}
        <div className="tiny faint">AI 写的会标「AI · 未审」。检查只保证写法合法、跑起来不出错，意思对不对要人看。</div>
      </div>
    </Dialog>
  );
}

/** AI 接口设置（自带密钥）的对话框：设置面板里内嵌用的是下面那个表单 */
export function AiSettingsDialog(p: { onClose: () => void; onSaved: () => void }) {
  return (
    <Dialog title="AI 接口（自带密钥）" size="wide" onClose={p.onClose}>
      <AiSettingsForm onSaved={p.onSaved} />
    </Dialog>
  );
}

/**
 * AI 接口的表单主体：接口地址 / 模型 / 密钥，只存浏览器。
 * 单独一个组件是为了上栏的「设置」面板能内嵌它（不再套一层对话框）。
 */
export function AiSettingsForm(p: { onSaved?: () => void } = {}) {
  const cur = useAiSettings();
  const [s, setS] = useState<AiSettings>(cur ?? { baseUrl: AI_PRESETS[0].baseUrl, model: AI_PRESETS[0].model, key: '' });
  const [msg, setMsg] = useState('');
  const [saved, setSaved] = useState(false);
  const test = async () => {
    setMsg('试一下…');
    try {
      const out = await makeChat(s, { json: false })([{ role: 'user', content: '回答两个字：可以' }]);
      setMsg(`通了：${out.slice(0, 40)}`);
    } catch (e) { setMsg((e as Error).message); }
  };
  const save = () => {
    setAiSettings({ baseUrl: s.baseUrl.trim(), model: s.model.trim(), key: s.key.trim() });
    setSaved(true);
    setMsg('存好了（只在这个浏览器里）');
    p.onSaved?.();
  };
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="small muted">OpenAI 兼容的接口。密钥只存在这个浏览器里，浏览器直接调用，不经过我们的服务器。</div>
      <div className="row small" style={{ gap: 4, flexWrap: 'wrap' }}>
        {AI_PRESETS.map((x) => <button key={x.label} className="btn ghost sm" onClick={() => { setS({ ...s, baseUrl: x.baseUrl, model: x.model }); setSaved(false); }}>{x.label}</button>)}
      </div>
      <Field label="接口地址（到 /v1 为止）"><input value={s.baseUrl} onChange={(e) => { setS({ ...s, baseUrl: e.target.value }); setSaved(false); }} placeholder="https://api.deepseek.com/v1" /></Field>
      <Field label="模型"><input value={s.model} onChange={(e) => { setS({ ...s, model: e.target.value }); setSaved(false); }} /></Field>
      <Field label="密钥"><input type="password" value={s.key} onChange={(e) => { setS({ ...s, key: e.target.value }); setSaved(false); }} autoComplete="off" /></Field>
      <div className="tiny faint">一条要发约 3 万 token 的说明书和例子；挑上下文长、写 JSON 稳的模型。</div>
      <div className="row" style={{ gap: 6 }}>
        {cur && <button className="btn ghost sm danger" onClick={() => { setAiSettings(null); setS({ baseUrl: AI_PRESETS[0].baseUrl, model: AI_PRESETS[0].model, key: '' }); setMsg('清掉了'); setSaved(false); }}>清除</button>}
        <span style={{ flex: 1 }} />
        <button className="btn" onClick={() => void test()}>试一下</button>
        <button className="btn primary" disabled={!s.baseUrl.trim() || !s.model.trim()} onClick={save}>{saved ? '已保存' : '保存'}</button>
      </div>
      {msg && <div className="small">{msg}</div>}
    </div>
  );
}
