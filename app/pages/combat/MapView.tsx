/**
 * 极简地图（战役遭遇）：格子 + 底图 + 画笔 + 棋子。
 *
 * - 世界坐标就是底图的像素；一格 grid.size 像素，格子原点在 (ox, oy)。没有底图时铺 cols × rows 格。
 * - 工具：移动（拖棋子，拖空白处平移）、测距（只在自己屏幕上）、画笔、橡皮。滚轮缩放，按住中键 / 空格随时平移。
 * - 棋子：点一下选中，右键设为目标；能控制的才拖得动，松手吸附到格子，拖的时候显示走了多少尺。
 * - 改动先在本地生效（乐观更新），再发给服务器；服务器广播回来的地图为准。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { footprint, gridFeet, type Session } from '../../../src/combat';
import { NumInput } from '../../components/ui';
import { combat, type CombatUi, type MapState, type Remote } from '../../lib/combat';
import type { Namer } from './shared';

type Tool = 'move' | 'measure' | 'pen' | 'erase';
const TOOL_CN: Record<Tool, string> = { move: '移动', measure: '测距', pen: '画笔', erase: '橡皮' };
const TOOL_TIP: Record<Tool, string> = { move: '拖棋子；拖空白处平移', measure: '量两格之间多远', pen: '在地图上画（所有人看得到）', erase: '擦掉画的线' };
const COLORS = ['#c0392b', '#2f5241', '#1f5f99', '#8a5a12', '#2b241a', '#ffffff'];
const WIDTHS = [3, 6, 12];
const MAX_IMG = 4096;

interface View { x: number; y: number; k: number }
type Drag =
  | { kind: 'pan'; sx: number; sy: number; vx: number; vy: number }
  | { kind: 'token'; id: string; n: number; from: { x: number; y: number }; at: { x: number; y: number } }
  | { kind: 'pen'; pts: number[] }
  | { kind: 'measure'; from: { x: number; y: number }; to: { x: number; y: number } }
  | { kind: 'erase'; ids: Set<string> };

export function MapView({ s, ui, remote, name }: { s: Session; ui: CombatUi; remote: Remote; name: Namer }) {
  const map = remote.map;
  const dm = remote.role === 'dm';
  const g = map.grid.size;
  const diagonal = map.grid.diagonal ?? '5';
  const worldW = map.bg ? map.bg.w : map.grid.ox + map.grid.cols * g;
  const worldH = map.bg ? map.bg.h : map.grid.oy + map.grid.rows * g;

  const box = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  const [tool, setTool] = useState<Tool>('move');
  const [color, setColor] = useState(COLORS[0]);
  const [width, setWidth] = useState(WIDTHS[0]);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [placing, setPlacing] = useState<string | null>(null);
  const [setup, setSetup] = useState(false);
  const space = useRef(false);

  // 第一次打开、换了底图：缩放到正好放得下
  const fitKey = `${worldW}x${worldH}`;
  const fit = () => {
    const el = box.current;
    if (!el) return;
    const k = Math.min(el.clientWidth / worldW, el.clientHeight / worldH, 2);
    setView({ k, x: (el.clientWidth - worldW * k) / 2, y: (el.clientHeight - worldH * k) / 2 });
  };
  useEffect(fit, [fitKey]);

  useEffect(() => {
    const down = (e: KeyboardEvent) => { if (e.code === 'Space' && !(e.target instanceof HTMLInputElement)) space.current = true; };
    const up = (e: KeyboardEvent) => { if (e.code === 'Space') space.current = false; };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, []);

  // Delete：把选中的棋子拿下地图（要确认）
  const selRef = useRef<string | null>(null);
  selRef.current = ui.selected && map.tokens[ui.selected] && combat.canControl(ui.selected) ? ui.selected : null;
  useEffect(() => {
    const del = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      const id = selRef.current;
      if (!id || !confirm(`把 ${name(id)} 拿下地图？（人还在遭遇里，之后可以再放上来）`)) return;
      combat.patchMap((m) => { delete m.tokens[id]; });
      void combat.map({ action: 'token', id, x: null });
    };
    window.addEventListener('keydown', del);
    return () => window.removeEventListener('keydown', del);
  }, [name]);

  // 滚轮缩放（以鼠标为中心）；要非被动监听才能拦住页面滚动
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      setView((v) => {
        const k = Math.max(0.1, Math.min(6, v.k * Math.exp(-e.deltaY * 0.0015)));
        return { k, x: mx - ((mx - v.x) * k) / v.k, y: my - ((my - v.y) * k) / v.k };
      });
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, []);

  const toWorld = (e: { clientX: number; clientY: number }) => {
    const r = box.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left - view.x) / view.k, y: (e.clientY - r.top - view.y) / view.k };
  };
  const toCell = (p: { x: number; y: number }) => ({ x: Math.floor((p.x - map.grid.ox) / g), y: Math.floor((p.y - map.grid.oy) / g) });

  const st = s.state;
  const current = st.round !== null ? st.order[st.turnIndex] : null;
  const visible = (id: string) => !combat.isHidden(id);
  const tokens = Object.entries(map.tokens).filter(([id]) => st.combatants[id] && visible(id));
  const offMap = Object.keys(st.combatants).filter((id) => !map.tokens[id] && visible(id) && (dm || combat.canControl(id)));

  /* ───── 指针 ───── */
  const onDown = (e: React.PointerEvent) => {
    if (e.button === 2) return;
    const p = toWorld(e);
    if (placing) {
      const c = toCell(p);
      placeToken(placing, c.x, c.y);
      setPlacing(null);
      return;
    }
    if (e.button === 1 || space.current || (tool === 'move' && !(e.target as Element).closest('[data-token]'))) {
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
      setDrag({ kind: 'pan', sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y });
      return;
    }
    if (tool === 'measure') {
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
      const c = toCell(p);
      setDrag({ kind: 'measure', from: c, to: c });
    } else if (tool === 'pen') {
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
      setDrag({ kind: 'pen', pts: [p.x, p.y] });
    } else if (tool === 'erase') {
      const ids = new Set<string>();
      const id = eraseTarget(e.target);
      if (id) ids.add(id);
      setDrag({ kind: 'erase', ids });
    }
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drag) return;
    if (drag.kind === 'pan') setView({ ...view, x: drag.vx + e.clientX - drag.sx, y: drag.vy + e.clientY - drag.sy });
    else if (drag.kind === 'pen') {
      const p = toWorld(e);
      const n = drag.pts.length;
      // 太密的点不要（屏幕上 2 像素以内）
      if (Math.hypot(p.x - drag.pts[n - 2], p.y - drag.pts[n - 1]) * view.k >= 2) setDrag({ kind: 'pen', pts: [...drag.pts, p.x, p.y] });
    } else if (drag.kind === 'erase') {
      const id = eraseTarget(document.elementFromPoint(e.clientX, e.clientY));
      if (id && !drag.ids.has(id)) setDrag({ kind: 'erase', ids: new Set([...drag.ids, id]) });
    } else if (drag.kind === 'measure') {
      const c = toCell(toWorld(e));
      if (c.x !== drag.to.x || c.y !== drag.to.y) setDrag({ ...drag, to: c });
    } else if (drag.kind === 'token') {
      // 鼠标在哪，棋子的中心就在哪（不管当初按在棋子的哪个位置）
      const p = toWorld(e);
      const at = { x: Math.round((p.x - map.grid.ox) / g - drag.n / 2), y: Math.round((p.y - map.grid.oy) / g - drag.n / 2) };
      if (at.x !== drag.at.x || at.y !== drag.at.y) setDrag({ ...drag, at });
    }
  };
  const onUp = () => {
    if (!drag) return;
    if (drag.kind === 'pen' && drag.pts.length >= 4) {
      const pts = drag.pts.map((v) => Math.round(v * 10) / 10);
      combat.patchMap((m) => { m.strokes.push({ id: `tmp-${Date.now()}`, by: remote.me, color, width, pts }); });
      void combat.map({ action: 'stroke', color, width, pts });
    } else if (drag.kind === 'erase' && drag.ids.size) {
      const ids = [...drag.ids];
      combat.patchMap((m) => { m.strokes = m.strokes.filter((x) => !drag.ids.has(x.id)); });
      void combat.map({ action: 'erase', ids });
    } else if (drag.kind === 'token' && (drag.at.x !== drag.from.x || drag.at.y !== drag.from.y)) {
      placeToken(drag.id, drag.at.x, drag.at.y);
    }
    setDrag(null);
  };
  /** 橡皮擦得到的线：DM 都能擦，玩家只能擦自己的 */
  const eraseTarget = (el: EventTarget | Element | null): string | null => {
    const id = el instanceof Element ? el.getAttribute('data-stroke') : null;
    if (!id) return null;
    const st = map.strokes.find((x) => x.id === id);
    return st && (dm || st.by === remote.me) ? id : null;
  };
  const placeToken = (id: string, x: number, y: number) => {
    combat.patchMap((m) => { m.tokens[id] = { x, y }; });
    void combat.map({ action: 'token', id, x, y });
  };

  const tokenDown = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0 || placing || space.current) return;
    if (ui.aim) { e.stopPropagation(); combat.aimPick(id); return; }
    if (tool !== 'move') return;
    e.stopPropagation();
    combat.select(id);
    if (!combat.canControl(id)) return;
    const t = map.tokens[id];
    box.current!.setPointerCapture(e.pointerId);
    setDrag({ kind: 'token', id, n: footprint(st.combatants[id]?.base.size), from: t, at: t });
  };

  /* ───── 画 ───── */
  const gridLines = useMemo(() => {
    if (!map.grid.show) return null;
    const { ox, oy } = map.grid;
    const cols = map.bg ? Math.ceil((worldW - ox) / g) : map.grid.cols;
    const rows = map.bg ? Math.ceil((worldH - oy) / g) : map.grid.rows;
    let d = '';
    for (let i = 0; i <= cols; i++) d += `M${ox + i * g} ${oy}V${oy + rows * g}`;
    for (let j = 0; j <= rows; j++) d += `M${ox} ${oy + j * g}H${ox + cols * g}`;
    return <path d={d} className="map-grid" strokeWidth={1 / view.k} style={map.grid.line ? { stroke: map.grid.line, strokeOpacity: 1 } : undefined} />;
  }, [map.grid, map.bg, worldW, worldH, g, view.k]);

  const bgUrl = map.bg ? new URL('api/', document.baseURI).pathname + `encounters/${remote.id}/bg?v=${map.bg.img}` : null;
  const moving = drag?.kind === 'token' ? drag : null;
  const aimed: Record<string, number> = {};
  for (const p of ui.aim?.picks ?? []) aimed[p] = (aimed[p] ?? 0) + 1;

  const hint = `滚轮缩放 · 拖空白处或按住空格平移 · 点棋子选中、右键设为目标、Delete 拿下地图、Esc 取消选中 · 每格 5 尺，斜走${diagonal === '5' ? '也算 5 尺' : '交替 5 / 10 尺'}，引擎按棋子位置自动判断距离`;
  return (
    <div className="map-root">
      <div className="hud map-rail" title={hint}>
        {(['move', 'measure', 'pen', 'erase'] as Tool[]).map((t) => (
          <button key={t} className={tool === t ? 'on' : ''} onClick={() => setTool(t)} title={TOOL_TIP[t]}>{TOOL_CN[t]}</button>
        ))}
        <hr />
        <button onClick={fit} title="缩放到整张图">适应</button>
        {dm && <button className={setup ? 'on' : ''} onClick={() => setSetup(!setup)} title="上传底图、对齐格子、斜走规则">底图</button>}
      </div>
      <div className="map-fly">
      {tool === 'pen' && (
        <div className="hud map-bar">
          {COLORS.map((c) => <button key={c} className={'swatch' + (c === color ? ' on' : '')} style={{ background: c }} onClick={() => setColor(c)} aria-label={`颜色 ${c}`} />)}
          <span style={{ width: 4 }} />
          {WIDTHS.map((w) => <button key={w} className={'btn sm' + (w === width ? ' on' : '')} onClick={() => setWidth(w)}>{w === 3 ? '细' : w === 6 ? '中' : '粗'}</button>)}
          <span style={{ width: 4 }} />
          <button className="btn ghost sm" onClick={() => { if (confirm('擦掉你画的所有线？')) void combat.map({ action: 'clear', mine: true }); }}>擦掉我画的</button>
          {dm && <button className="btn ghost sm danger" onClick={() => { if (confirm('擦掉所有人画的线？')) void combat.map({ action: 'clear' }); }}>全部擦掉</button>}
        </div>
      )}
      {tool === 'erase' && <div className="hud map-bar tiny faint">按住拖过线条就擦掉。{dm ? '' : '只能擦你自己画的。'}</div>}
      {tool === 'measure' && <div className="hud map-bar tiny faint">按住从一格拖到另一格。只有你自己看得到。</div>}
      {setup && dm && <MapSetup map={map} />}
      {offMap.length > 0 && (
        <div className="hud map-bar">
          <span className="tiny faint">还没上图：</span>
          {offMap.map((id) => (
            <button key={id} className={'btn sm' + (placing === id ? ' on' : '')} onClick={() => setPlacing(placing === id ? null : id)}>{name(id)}</button>
          ))}
          {placing && <span className="tiny">点一格放下 {name(placing)}</span>}
        </div>
      )}
      </div>
      <div
        ref={box}
        className={'map-box tool-' + (placing ? 'place' : ui.aim ? 'aim' : tool) + (drag?.kind === 'pan' ? ' panning' : '')}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onContextMenu={(e) => e.preventDefault()}
      >
        <svg width="100%" height="100%">
          <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
            {bgUrl ? <image href={bgUrl} x={0} y={0} width={map.bg!.w} height={map.bg!.h} /> : <rect width={worldW} height={worldH} className="map-paper" style={map.grid.paper ? { fill: map.grid.paper } : undefined} />}
            {gridLines}
            {map.strokes.map((x) => (
              <polyline
                key={x.id} data-stroke={x.id} points={x.pts.join(' ')} fill="none" stroke={x.color} strokeWidth={x.width}
                strokeLinecap="round" strokeLinejoin="round"
                className={drag?.kind === 'erase' && drag.ids.has(x.id) ? 'erasing' : undefined}
                style={{ pointerEvents: tool === 'erase' ? 'stroke' : 'none' }}
              />
            ))}
            {drag?.kind === 'pen' && <polyline points={drag.pts.join(' ')} fill="none" stroke={color} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" />}
            {tokens.map(([id, t]) => {
              const c = st.combatants[id];
              const at = moving?.id === id ? moving.at : t;
              const n = footprint(c.base.size);
              const r = (n * g) / 2;
              const cls = ['token', c.side === 'party' ? 'party' : c.side === 'enemy' ? 'enemy' : 'other', id === ui.selected && 'sel', id === current && 'turn',
                ui.targets.includes(id) && 'tgt', c.live.dead && 'dead', remote.hidden.includes(id) && 'hid', combat.canControl(id) && 'mine'].filter(Boolean).join(' ');
              return (
                <g
                  key={id} data-token={id} className={cls}
                  transform={`translate(${map.grid.ox + at.x * g + r} ${map.grid.oy + at.y * g + r})`}
                  onPointerDown={(e) => tokenDown(e, id)}
                  onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); if (ui.aim) combat.aimUnpick(id); else combat.toggleTarget(id); }}
                >
                  <title>{c.name}</title>
                  <circle r={r * 0.86} />
                  <text dy="0.35em" fontSize={Math.max(10, r * 0.62)}>{c.name.slice(0, n > 1 ? 4 : 2)}</text>
                  {aimed[id] && (
                    <g className="aim-badge" transform={`translate(${r * 0.62} ${-r * 0.62})`}>
                      <circle r={Math.max(7, r * 0.3)} />
                      <text dy="0.35em" fontSize={Math.max(9, r * 0.32)}>{aimed[id] > 1 ? aimed[id] : '✓'}</text>
                    </g>
                  )}
                </g>
              );
            })}
            {moving && (() => {
              // 从哪来：原位置的中心 → 现在的中心
              const half = (moving.n * g) / 2;
              const c = (p: { x: number; y: number }) => ({ x: map.grid.ox + p.x * g + half, y: map.grid.oy + p.y * g + half });
              const a = c(moving.from), b = c(moving.at);
              return (
                <g className="map-measure">
                  <circle cx={a.x} cy={a.y} r={half * 0.86} className="map-ghost" />
                  <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} strokeWidth={3 / view.k} strokeDasharray={`${8 / view.k} ${5 / view.k}`} />
                </g>
              );
            })()}
            {moving && (
              <text
                className="map-dist" fontSize={14 / view.k}
                x={map.grid.ox + (moving.at.x + moving.n / 2) * g} y={map.grid.oy + moving.at.y * g - 6 / view.k}
              >{gridFeet(moving.at.x - moving.from.x, moving.at.y - moving.from.y, diagonal)} 尺</text>
            )}
            {drag?.kind === 'measure' && (() => {
              const cx = (c: { x: number }) => map.grid.ox + (c.x + 0.5) * g;
              const cy = (c: { y: number }) => map.grid.oy + (c.y + 0.5) * g;
              return (
                <g className="map-measure">
                  <line x1={cx(drag.from)} y1={cy(drag.from)} x2={cx(drag.to)} y2={cy(drag.to)} strokeWidth={3 / view.k} strokeDasharray={`${8 / view.k} ${5 / view.k}`} />
                  <circle cx={cx(drag.from)} cy={cy(drag.from)} r={5 / view.k} />
                  <text className="map-dist" fontSize={16 / view.k} x={cx(drag.to)} y={cy(drag.to) - g * 0.6}>
                    {gridFeet(drag.to.x - drag.from.x, drag.to.y - drag.from.y, diagonal)} 尺
                  </text>
                </g>
              );
            })()}
          </g>
        </svg>
      </div>
    </div>
  );
}

/** DM：上传底图、对齐格子 */
function MapSetup({ map }: { map: MapState }) {
  const [busy, setBusy] = useState(false);
  const gr = map.grid;
  const put = (p: Partial<MapState['grid']>) => void combat.map({ action: 'grid', ...gr, ...p });
  const upload = async (file: File) => {
    setBusy(true);
    try {
      const img = await createImageBitmap(file);
      // 太大的图缩到 4096 以内，转成 webp，基本都在 2MB 以下
      const k = Math.min(1, MAX_IMG / Math.max(img.width, img.height));
      const w = Math.round(img.width * k), h = Math.round(img.height * k);
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      cv.getContext('2d')!.drawImage(img, 0, 0, w, h);
      let dataUrl = cv.toDataURL('image/webp', 0.85);
      if (!dataUrl.startsWith('data:image/webp')) dataUrl = cv.toDataURL('image/jpeg', 0.85);
      if (dataUrl.length > 7.5 * 1024 * 1024) { combat.toast('图太大了，换一张小一点的'); return; }
      await combat.map({ action: 'bg', dataUrl, w, h });
    } catch (e) {
      combat.toast('读不了这张图：' + (e as Error).message);
    } finally { setBusy(false); }
  };
  return (
    <div className="hud map-bar wrap">
      <label className="btn sm">
        {busy ? '上传中…' : map.bg ? '换底图' : '上传底图'}
        <input type="file" accept="image/*" hidden disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void upload(f); }} />
      </label>
      {map.bg && <button className="btn ghost sm danger" onClick={() => { if (confirm('去掉底图？')) void combat.map({ action: 'bg', dataUrl: null }); }}>去掉底图</button>}
      <label className="row tiny" style={{ gap: 4 }}>一格<NumInput min={8} max={400} value={gr.size} onChange={(n) => put({ size: n })} />像素</label>
      <label className="row tiny" style={{ gap: 4 }}>偏移<NumInput min={-400} max={400} value={gr.ox} onChange={(n) => put({ ox: n })} /><NumInput min={-400} max={400} value={gr.oy} onChange={(n) => put({ oy: n })} /></label>
      {!map.bg && <label className="row tiny" style={{ gap: 4 }}>大小<NumInput min={1} max={200} value={gr.cols} onChange={(n) => put({ cols: n })} />×<NumInput min={1} max={200} value={gr.rows} onChange={(n) => put({ rows: n })} />格</label>}
      {!map.bg && <HexInput label="底色" value={gr.paper} onChange={(v) => put({ paper: v })} />}
      <HexInput label="格线" value={gr.line} onChange={(v) => put({ line: v })} />
      <label className="row tiny" style={{ gap: 4 }}><input type="checkbox" checked={gr.show} onChange={(e) => put({ show: e.target.checked })} />显示格子</label>
      <label className="row tiny" style={{ gap: 4 }}>
        斜走
        <select value={gr.diagonal ?? '5'} onChange={(e) => put({ diagonal: e.target.value as '5' | '5-10-5' })}>
          <option value="5">每格 5 尺（2024 规则）</option>
          <option value="5-10-5">交替 5 / 10 尺</option>
        </select>
      </label>
    </div>
  );
}

/** 颜色：直接写 hex（#334、#2a3b4c、带透明度 #2a3b4c80），空着 = 默认；回车或离开输入框生效 */
function HexInput({ label, value, onChange }: { label: string; value?: string; onChange: (v: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? value ?? '';
  const ok = (v: string) => v === '' || /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v);
  const commit = () => {
    if (draft == null) return;
    let v = draft.trim();
    if (v && !v.startsWith('#')) v = '#' + v;
    if (ok(v) && v !== (value ?? '')) onChange(v);
    setDraft(null);
  };
  return (
    <label className="row tiny" style={{ gap: 4 }}>
      {label}
      {value && <i className="hex-dot" style={{ background: value }} />}
      <input
        className={'hex' + (draft != null && !ok(draft.trim() && !draft.trim().startsWith('#') ? '#' + draft.trim() : draft.trim()) ? ' bad' : '')}
        value={text} placeholder="默认" size={9} spellCheck={false}
        onChange={(e) => setDraft(e.target.value)} onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') commit(); else if (e.key === 'Escape') setDraft(null); }}
      />
    </label>
  );
}
