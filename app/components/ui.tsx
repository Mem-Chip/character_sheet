import { useState, type ReactNode } from 'react';

export function Panel(p: { title: ReactNode; aside?: ReactNode; flush?: boolean; children?: ReactNode; className?: string }) {
  return (
    <section className={'panel ' + (p.className ?? '')}>
      <header>
        <h3>{p.title}</h3>
        {p.aside != null && <div className="aside">{p.aside}</div>}
      </header>
      <div className={'body' + (p.flush ? ' flush' : '')}>{p.children}</div>
    </section>
  );
}

export function Stat(p: { k: ReactNode; v: ReactNode; s?: ReactNode; title?: string }) {
  return (
    <div className="stat" title={p.title}>
      <div className="k">{p.k}</div>
      <div className="v">{p.v}</div>
      {p.s != null && <div className="s">{p.s}</div>}
    </div>
  );
}

export const sgn = (n: number | null | undefined) => (n == null ? '—' : (n >= 0 ? '+' : '') + n);

/** 次数方格：点一下切换「用掉 / 恢复」（点第 i 格 = 用掉到第 i 格） */
export function Pips(p: { max: number; used: number; onChange?: (used: number) => void; title?: string }) {
  const n = Math.max(0, Math.min(p.max, 30));
  return (
    <span className="pips" title={p.title}>
      {Array.from({ length: n }, (_, i) => (
        <button
          key={i}
          type="button"
          className={'pip' + (i < p.used ? ' used' : '')}
          aria-label={i < p.used ? `恢复到 ${i} 次已用` : `用掉到第 ${i + 1} 次`}
          onClick={() => p.onChange?.(i < p.used ? i : i + 1)}
        />
      ))}
    </span>
  );
}

export function Tag(p: { tone?: 'accent' | 'danger' | 'warn'; children: ReactNode; title?: string; onRemove?: () => void }) {
  return (
    <span className={'tag' + (p.tone ? ' ' + p.tone : '')} title={p.title}>
      {p.children}
      {p.onRemove && <button type="button" aria-label="移除" onClick={p.onRemove}>×</button>}
    </span>
  );
}

/** docked：不盖遮罩、不居中，贴在页面给它留的位置（地图布局里要做的决定用，不挡地图） */
export function Dialog(p: { title: ReactNode; children: ReactNode; footer?: ReactNode; onClose?: () => void; docked?: boolean }) {
  const box = (
      <section className={'panel dialog' + (p.docked ? ' docked' : '')} role="dialog" aria-modal={!p.docked}>
        <header>
          <h3>{p.title}</h3>
          {p.onClose && <div className="aside"><button className="btn ghost sm" onClick={p.onClose} aria-label="关闭">关闭</button></div>}
        </header>
        <div className="body">{p.children}</div>
        {p.footer && <footer>{p.footer}</footer>}
      </section>
  );
  if (p.docked) return box;
  return <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) p.onClose?.(); }}>{box}</div>;
}

export function Field(p: { label: ReactNode; children: ReactNode; style?: React.CSSProperties }) {
  return <label className="field" style={p.style}><span>{p.label}</span>{p.children}</label>;
}

/**
 * 数字输入框：打字的时候可以先删空再输（不在每次按键时夹到最小值），
 * 输入落在范围内就立刻生效；离开或回车时，空的恢复原值，越界的夹到范围内。
 */
export function NumInput(p: {
  value: number; onChange: (n: number) => void; min?: number; max?: number;
  style?: React.CSSProperties; title?: string; placeholder?: string; 'aria-label'?: string; autoFocus?: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const clamp = (n: number) => Math.max(p.min ?? -Infinity, Math.min(p.max ?? Infinity, Math.round(n)));
  const commit = (s: string) => {
    const n = Number(s);
    if (s.trim() !== '' && Number.isFinite(n) && clamp(n) !== p.value) p.onChange(clamp(n));
    setDraft(null);
  };
  return (
    <input
      type="number" min={p.min} max={p.max} style={p.style} title={p.title} placeholder={p.placeholder}
      aria-label={p['aria-label']} autoFocus={p.autoFocus}
      value={draft ?? String(p.value)}
      onChange={(e) => {
        const s = e.target.value;
        setDraft(s);
        const n = Number(s);
        if (s.trim() !== '' && Number.isFinite(n) && clamp(n) === Math.round(n) && Math.round(n) !== p.value) p.onChange(Math.round(n));
      }}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => { if (e.key === 'Enter') commit((e.target as HTMLInputElement).value); }}
    />
  );
}
