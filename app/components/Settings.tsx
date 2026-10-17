/**
 * 上栏的「设置」：外观（主题 / 页面宽度 / 配色 / 词条提示延迟）和 AI 接口。
 *
 * 以前这些是散在上栏的一串下拉框（加上一个主题按钮），把上栏挤得挺满；现在收进一个面板，
 * 每一项都点一下就生效、立刻能看出效果，不用先选下拉再回头看。
 */
import { useState } from 'react';
import { PALETTES, TERM_DELAYS, WIDTHS, actions, useApp } from '../lib/store';
import { useAiSettings } from '../lib/ai';
import { AiSettingsForm } from './AiDatafy';
import { Dialog, Field, NumInput, Tag } from './ui';

export function SettingsButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="btn sm" onClick={() => setOpen(true)} title="外观、词条提示、AI 接口" aria-label="设置">设置</button>
      {open && <SettingsDialog onClose={() => setOpen(false)} />}
    </>
  );
}

type Tab = 'look' | 'ai';

function SettingsDialog({ onClose }: { onClose: () => void }) {
  const app = useApp();
  const ai = useAiSettings();
  const [tab, setTab] = useState<Tab>('look');

  return (
    <Dialog title="设置" size="wide" onClose={onClose} footer={<>
      <span className="small muted" style={{ flex: 1 }}>这些都存在这个浏览器里，跟着你走</span>
      <button className="btn" onClick={onClose}>关闭</button>
    </>}>
      <div className="tabs" role="tablist" style={{ marginBottom: 8 }}>
        <button role="tab" aria-selected={tab === 'look'} onClick={() => setTab('look')}>外观</button>
        <button role="tab" aria-selected={tab === 'ai'} onClick={() => setTab('ai')}>AI 接口</button>
      </div>

      {tab === 'look' ? (
        <div className="stack" style={{ gap: 12 }}>
          <Field label="主题">
            <div className="row" style={{ gap: 4 }}>
              <button className={'btn sm' + (app.theme === 'light' ? ' on' : '')} onClick={() => actions.setTheme('light')}>浅色</button>
              <button className={'btn sm' + (app.theme === 'dark' ? ' on' : '')} onClick={() => actions.setTheme('dark')}>深色</button>
            </div>
          </Field>
          <Field label="页面宽度">
            <div className="row" style={{ gap: 4 }}>
              {WIDTHS.map(([k, label]) => (
                <button key={k} className={'btn sm' + (app.width === k ? ' on' : '')} onClick={() => actions.setWidth(k)}>{label}</button>
              ))}
            </div>
          </Field>
          <Field label="配色">
            <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
              {PALETTES.map(([k, label]) => (
                <button key={k} className={'btn sm' + (app.palette === k ? ' on' : '')} onClick={() => actions.setPalette(k)}>{label}</button>
              ))}
            </div>
          </Field>
          <div>
            <div className="small faint">词条悬浮提示：鼠标放在名词上多久后弹说明</div>
            <div className="row" style={{ gap: 4, flexWrap: 'wrap', marginTop: 4, alignItems: 'center' }}>
              {TERM_DELAYS.map(([d, label]) => (
                <button key={d} className={'btn sm' + (app.termDelay === d ? ' on' : '')} onClick={() => actions.setTermDelay(d)}>{label}</button>
              ))}
              <span className="row small" style={{ gap: 4 }}>
                自定义
                <NumInput value={app.termDelay} min={-1} max={5000} onChange={(n) => actions.setTermDelay(n)} style={{ width: 72 }} aria-label="自定义提示延迟（毫秒）" />
                毫秒（-1 = 关闭）
              </span>
            </div>
          </div>
        </div>
      ) : (
        <div className="stack" style={{ gap: 8 }}>
          {ai
            ? <div className="row small" style={{ gap: 6 }}>现在用：<Tag>{ai.model}</Tag><span className="muted">{ai.baseUrl}</span></div>
            : <div className="small muted">还没设置接口。要用「AI 数据化」（写战斗 / 卡面数据、整理怪物）得先填一个 OpenAI 兼容的接口。</div>}
          <AiSettingsForm />
        </div>
      )}
    </Dialog>
  );
}
