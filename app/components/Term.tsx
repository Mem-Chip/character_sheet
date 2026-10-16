/**
 * 术语悬浮窗（像 5etools 的悬停卡片）：
 * - 鼠标停在术语上 → 弹出一个悬浮窗（整页同时只有一个）。它不接鼠标：移开术语就消失，不挡视线；
 * - 悬浮窗开着时按 Ctrl → 变成固定窗（可以同时开好几个，拖标题栏移动，点一下放到最上面）。
 *   不用点击固定：术语常常在按钮里，点击要留给按钮；
 * - 固定窗里的正文也是术语，悬停、按 Ctrl 照样能开新的；
 * - Esc 关掉所有浮窗。
 * 窗口总在当前屏幕范围内：放在术语下面，放不下就翻到上面，左右夹在屏幕里。
 */
import { useLayoutEffect, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { Engine } from '../lib/engine';
import { getApp } from '../lib/store';
import { canLookup, lookupTerm, type TermData, type TermRef } from '../lib/terms';
import { Entries } from './Entries';

interface Box { left: number; top: number; bottom: number; right: number }
interface Win { id: number; ref: TermRef; at: Box; x?: number; y?: number; z: number }

let engine: Engine | null = null;
let hover: Win | null = null;
/** 悬浮窗（或正要弹出的）是哪个术语元素的 —— 它被卸载时（按钮点完整栏换掉了）收起来，因为收不到 mouseleave */
let owner: Element | null = null;
/** 悬浮窗现在画在哪（按 Ctrl 固定时就固定在原地） */
let hoverPos: { x: number; y: number } | null = null;
let pins: Win[] = [];
let seq = 0;
let zTop = 100;
let hideTimer: ReturnType<typeof setTimeout> | undefined;
let showTimer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();
let version = 0;
const emit = () => { version++; for (const l of listeners) l(); };

export function setTermEngine(e: Engine): void { engine = e; }
export const termEngine = (): Engine | null => engine;

const boxOf = (el: Element): Box => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, bottom: r.bottom, right: r.right }; };
const sameRef = (a: TermRef, b: TermRef) => a.kind === b.kind && a.name === b.name && a.source === b.source && a.cls === b.cls && a.level === b.level;

const popups = {
  hoverSoon(ref: TermRef, el: Element) {
    clearTimeout(hideTimer);
    clearTimeout(showTimer);
    owner = el;
    if (hover && sameRef(hover.ref, ref)) return;
    const delay = getApp().termDelay;
    if (delay < 0) return;
    if (delay === 0) {
      hover = { id: ++seq, ref, at: boxOf(el), z: 0 };
      emit();
      return;
    }
    showTimer = setTimeout(() => { hover = { id: ++seq, ref, at: boxOf(el), z: 0 }; emit(); }, delay);
  },
  leaveSoon() {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { if (hover) { hover = null; emit(); } }, 220);
  },
  pin(ref: TermRef, at: Box, xy?: { x: number; y: number }) {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    hover = null;
    pins = [...pins, { id: ++seq, ref, at, z: ++zTop, ...(xy ?? {}) }];
    emit();
  },
  /** 术语元素没了：它的悬浮窗立刻收起 */
  gone(el: Element) {
    if (owner !== el) return;
    owner = null;
    clearTimeout(showTimer);
    if (hover) { hover = null; emit(); }
  },
  close(id: number) { pins = pins.filter((p) => p.id !== id); emit(); },
  closeAll() { clearTimeout(showTimer); pins = []; hover = null; emit(); },
  front(id: number) { pins = pins.map((p) => (p.id === id ? { ...p, z: ++zTop } : p)); emit(); },
  move(id: number, x: number, y: number) { pins = pins.map((p) => (p.id === id ? { ...p, x, y } : p)); emit(); },
};

/** 直接开一个固定窗（/match 用），放在屏幕中间偏上 */
export function openTerm(ref: TermRef): void {
  const x = Math.max(8, window.innerWidth / 2 - 220), y = Math.max(8, window.innerHeight * 0.18);
  popups.pin(ref, { left: x, top: y, bottom: y, right: x }, { x, y });
}

/**
 * 一个术语。点击不做任何事（交给外面的按钮）；固定靠 Ctrl。`inButton` 只影响样式。
 * 查不到的类别不加效果，只渲染文字。
 */
export function Term(p: { kind: string; name: string; source?: string; cls?: string; level?: number; inButton?: boolean; children?: ReactNode }) {
  const self = useRef<HTMLSpanElement>(null);
  useEffect(() => { const el = self.current; return () => { if (el) popups.gone(el); }; }, []);
  const ref: TermRef = { kind: p.kind, name: p.name, ...(p.source ? { source: p.source } : {}), ...(p.cls ? { cls: p.cls } : {}), ...(p.level != null ? { level: p.level } : {}) };
  if (!canLookup(p.kind) || !p.name) return <>{p.children ?? p.name}</>;
  return (
    <span
      ref={self}
      className={'term' + (p.inButton ? ' in-btn' : '')}
      onMouseEnter={(e) => popups.hoverSoon(ref, e.currentTarget)}
      onMouseLeave={() => popups.leaveSoon()}
    >
      {p.children ?? p.name}
    </span>
  );
}

/** 整页挂一个：画悬浮窗和固定窗 */
export function TermLayer() {
  useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => version);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && (hover || pins.length)) popups.closeAll();
      else if (e.key === 'Control' && !e.repeat && hover) popups.pin(hover.ref, hover.at, hoverPos ?? undefined);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <>
      {pins.map((w) => <TermWindow key={w.id} w={w} pinned />)}
      {hover && <TermWindow key={hover.id} w={hover} pinned={false} />}
      {pins.length > 1 && <button className="btn sm term-closeall" onClick={() => popups.closeAll()}>关掉全部浮窗（{pins.length}）</button>}
    </>
  );
}

function TermWindow({ w, pinned }: { w: Win; pinned: boolean }) {
  const el = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<TermData | null | undefined>(undefined);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(w.x != null && w.y != null ? { x: w.x, y: w.y } : null);

  useEffect(() => {
    let alive = true;
    if (!engine) { setData(null); return; }
    void lookupTerm(engine, w.ref).then((d) => alive && setData(d));
    return () => { alive = false; };
  }, [w.ref]);

  // 放在术语下面；下面放不下就放上面；左右夹在屏幕里
  useLayoutEffect(() => {
    if (w.x != null && w.y != null) { setPos({ x: w.x, y: w.y }); return; }
    const box = el.current?.getBoundingClientRect();
    if (!box) return;
    const vw = window.innerWidth, vh = window.innerHeight, m = 8;
    const x = Math.max(m, Math.min(w.at.left, vw - box.width - m));
    const below = w.at.bottom + 4;
    const above = w.at.top - 4 - box.height;
    const y = below + box.height <= vh - m ? below : above >= m ? above : Math.max(m, vh - box.height - m);
    setPos({ x, y });
    if (!pinned) hoverPos = { x, y };
  }, [w.at, w.x, w.y, data]);

  const drag = (e: React.PointerEvent) => {
    if (!pinned || !pos) return;
    const sx = e.clientX - pos.x, sy = e.clientY - pos.y;
    const onMove = (ev: PointerEvent) => {
      const x = Math.max(0, Math.min(window.innerWidth - 80, ev.clientX - sx));
      const y = Math.max(0, Math.min(window.innerHeight - 40, ev.clientY - sy));
      popups.move(w.id, x, y);
    };
    const onUp = () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  return (
    <div
      ref={el}
      className={'termwin' + (pinned ? ' pinned' : '')}
      style={{ left: pos?.x ?? -9999, top: pos?.y ?? -9999, zIndex: pinned ? w.z : 10000 }}
      onMouseDown={pinned ? () => popups.front(w.id) : undefined}
      role={pinned ? 'dialog' : 'tooltip'}
    >
      <header onPointerDown={drag} style={{ cursor: pinned ? 'move' : undefined }}>
        <b className="serif">{data?.name ?? w.ref.name}</b>
        <span className="tiny faint">{data ? `${data.kindLabel}${data.source ? ` · ${data.source}` : ''}` : ''}</span>
        <span style={{ flex: 1 }} />
        {pinned
          ? <button className="btn ghost sm" onPointerDown={(e) => e.stopPropagation()} onClick={() => popups.close(w.id)} aria-label="关闭">×</button>
          : <span className="tiny faint">Ctrl 固定</span>}
      </header>
      <div className="body prose small">
        {data === undefined ? <span className="faint">正在查…</span>
          : data === null ? <span className="faint">没查到「{w.ref.name}」的原文。</span>
            : <>
              {data.meta.length > 0 && <div className="meta">{data.meta.map((m, i) => <div key={i}>{m}</div>)}</div>}
              <Entries entries={data.entries} />
            </>}
      </div>
    </div>
  );
}
