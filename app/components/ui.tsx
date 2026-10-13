import type { ReactNode } from 'react';

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

export function Dialog(p: { title: ReactNode; children: ReactNode; footer?: ReactNode; onClose?: () => void }) {
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) p.onClose?.(); }}>
      <section className="panel dialog" role="dialog" aria-modal="true">
        <header>
          <h3>{p.title}</h3>
          {p.onClose && <div className="aside"><button className="btn ghost sm" onClick={p.onClose} aria-label="关闭">关闭</button></div>}
        </header>
        <div className="body">{p.children}</div>
        {p.footer && <footer>{p.footer}</footer>}
      </section>
    </div>
  );
}

export function Field(p: { label: ReactNode; children: ReactNode; style?: React.CSSProperties }) {
  return <label className="field" style={p.style}><span>{p.label}</span>{p.children}</label>;
}
