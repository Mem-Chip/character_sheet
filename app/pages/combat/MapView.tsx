/**
 * 极简地图（战役遭遇）：格子 + 底图 + 画笔 + 棋子。
 *
 * - 世界坐标就是底图的像素；一格 grid.size 像素，格子原点在 (ox, oy)。没有底图时铺 cols × rows 格。
 * - 工具：移动（拖棋子，拖空白处平移）、测距（只在自己屏幕上；拖的时候按 Q 打个折点接着量）、形状（方 / 圆 / 锥，大家都看得到）、
 *   画笔、橡皮。滚轮缩放，按住中键 / 空格随时平移。
 * - 回合中，轮到的人这一回合走过的路画成虚线，换人就没了。
 * - 选目标模式里的范围法术：模板跟着鼠标走（锥 / 线 / 贴身立方跟着鼠标转向），点一下定下来，圈里的人自动选中。
 * - 棋子：点一下选中，右键设为目标；能控制的才拖得动，松手吸附到格子，拖的时候显示走了多少尺。
 * - 改动先在本地生效（乐观更新），再发给服务器；服务器广播回来的地图为准。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { footprint, gridFeet, pathFeet, type Session } from '../../../src/combat';
import { cellCenters, directional, inside, snapLen, snapPt, spellTpl, tplLabel, tplOrigin, tplPath, type Tpl } from '../../lib/area';
import { NumInput } from '../../components/ui';
import { combat, type CombatUi, type MapState, type Remote } from '../../lib/combat';
import type { Namer } from './shared';

type Tool = 'move' | 'measure' | 'shape' | 'pen' | 'erase';
const TOOL_CN: Record<Tool, string> = { move: '移动', measure: '测距', shape: '形状', pen: '画笔', erase: '橡皮' };
const TOOL_TIP: Record<Tool, string> = {
  move: '拖棋子；拖空白处平移', measure: '量两格之间多远；拖的时候按 Q 打个折点接着量（只有你看得到）',
  shape: '放一个方 / 圆 / 锥，量范围用（所有人看得到）', pen: '在地图上画（所有人看得到）', erase: '擦掉画的线和形状',
};
type ShapeKind = 'rect' | 'circle' | 'cone';
const SHAPE_CN: Record<ShapeKind, string> = { rect: '方', circle: '圆', cone: '锥' };
const COLORS = ['#c0392b', '#2f5241', '#1f5f99', '#8a5a12', '#2b241a', '#ffffff'];
const WIDTHS = [3, 6, 12];
const MAX_IMG = 4096;

interface View { x: number; y: number; k: number }
type Drag =
  | { kind: 'pan'; sx: number; sy: number; vx: number; vy: number }
  | { kind: 'token'; id: string; n: number; from: { x: number; y: number }; at: { x: number; y: number } }
  | { kind: 'pen'; pts: number[] }
  | { kind: 'measure'; pts: Array<{ x: number; y: number }>; to: { x: number; y: number } }
  | { kind: 'shape'; from: { x: number; y: number }; to: { x: number; y: number } }
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
  const [shapeKind, setShapeKind] = useState<ShapeKind>('rect');
  /** 范围法术：鼠标在哪（预览），点了之后定下来的模板 */
  const [pt, setPt] = useState<{ x: number; y: number } | null>(null);
  const [fixed, setFixed] = useState<Tpl | null>(null);
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
    const down = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.code === 'Space') space.current = true;
      // 测距时按 Q：在当前格打个折点，接着量
      if (e.code === 'KeyQ') setDrag((d) => (d?.kind === 'measure' && !sameCell(d.to, d.pts[d.pts.length - 1]) ? { ...d, pts: [...d.pts, d.to] } : d));
    };
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

  /* ───── 范围法术的模板 ───── */
  const aim = ui.aim;
  const areaAim = aim?.area ?? null;
  const aimKey = aim ? `${aim.actor}|${aim.ref}` : '';
  const casterTok = aim ? map.tokens[aim.actor] : undefined;
  const casterN = aim ? footprint(st.combatants[aim.actor]?.base.size) : 1;
  const caster = casterTok ? { x: map.grid.ox + (casterTok.x + casterN / 2) * g, y: map.grid.oy + (casterTok.y + casterN / 2) * g, half: (casterN * g) / 2 } : null;
  const tplAt = (p: { x: number; y: number }) => (areaAim ? spellTpl(areaAim, map.grid, caster, p) : null);
  /** 模板的原点离施法者多远（尺）；自身出发的不算 */
  const originFeet = (t: Tpl): number | null => {
    if (!areaAim || areaAim.self || !casterTok) return null;
    const o = toCell(tplOrigin(t));
    const dx = Math.max(0, o.x - (casterTok.x + casterN - 1), casterTok.x - o.x);
    const dy = Math.max(0, o.y - (casterTok.y + casterN - 1), casterTok.y - o.y);
    return gridFeet(dx, dy, diagonal);
  };
  const outOfRange = (t: Tpl) => { const d = originFeet(t); return d != null && aim?.range != null && d > aim.range; };
  /** 圈到的人：占的格子有一格中心在模板里；自身出发的不含自己；死了的不算 */
  const caught = (t: Tpl) => Object.entries(map.tokens).filter(([id, tk]) => {
    const c = st.combatants[id];
    if (!c || c.live.dead || (areaAim?.self && id === aim?.actor)) return false;
    return cellCenters(map.grid, tk, footprint(c.base.size)).some(([x, y]) => inside(t, x, y));
  }).map(([id]) => id);
  const fix = (t: Tpl) => { setFixed(t); combat.aimSet(caught(t)); };
  // 换了动作：模板重来；不用选方向的贴身范围（光环、身边一圈）直接定下来
  useEffect(() => {
    setFixed(null);
    if (areaAim?.self && !directional(areaAim.area) && caster) { const t = tplAt({ x: caster.x, y: caster.y }); if (t) fix(t); }
  }, [aimKey]);

  /* ───── 指针 ───── */
  const onDown = (e: React.PointerEvent) => {
    if (e.button === 2) return;
    const p = toWorld(e);
    if (areaAim && e.button === 0 && !space.current) {
      const t = tplAt(p);
      if (!t) { combat.toast('施法者不在地图上，在先攻条 / 列表里点人选目标'); return; }
      if (outOfRange(t)) { combat.toast(`超出「${aim!.name}」的射程 ${aim!.range} 尺`); return; }
      fix(t);
      return;
    }
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
      setDrag({ kind: 'measure', pts: [c], to: c });
    } else if (tool === 'shape') {
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
      const s0 = snapPt(map.grid, p.x, p.y);
      setDrag({ kind: 'shape', from: s0, to: s0 });
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
    if (areaAim && !fixed) setPt(toWorld(e));
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
      if (!sameCell(c, drag.to)) setDrag({ ...drag, to: c });
    } else if (drag.kind === 'shape') {
      setDrag({ ...drag, to: toWorld(e) });
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
    } else if (drag.kind === 'shape') {
      const t = shapeTpl(drag.from, drag.to);
      if (t) {
        combat.patchMap((m) => { m.shapes = [...(m.shapes ?? []), { id: `tmp-${Date.now()}`, by: remote.me, color, tpl: t }]; });
        void combat.map({ action: 'shape', color, tpl: t });
      }
    } else if (drag.kind === 'token' && (drag.at.x !== drag.from.x || drag.at.y !== drag.from.y)) {
      placeToken(drag.id, drag.at.x, drag.at.y);
    }
    setDrag(null);
  };
  /** 橡皮擦得到的线和形状：DM 都能擦，玩家只能擦自己的 */
  const eraseTarget = (el: EventTarget | Element | null): string | null => {
    const id = el instanceof Element ? el.getAttribute('data-stroke') ?? el.getAttribute('data-shape') : null;
    if (!id) return null;
    const hit = [...map.strokes, ...(map.shapes ?? [])].find((x) => x.id === id);
    return hit && (dm || hit.by === remote.me) ? id : null;
  };
  /** 拖出来的形状：方 = 两个格点之间；圆 = 中心 + 半径；锥 = 顶点 + 长度 + 朝向。长度按 5 尺取整 */
  const shapeTpl = (a: { x: number; y: number }, b: { x: number; y: number }): Tpl | null => {
    if (shapeKind === 'rect') {
      const q = snapPt(map.grid, b.x, b.y);
      const w = Math.abs(q.x - a.x), h = Math.abs(q.y - a.y);
      return w && h ? { shape: 'rect', x: Math.min(a.x, q.x), y: Math.min(a.y, q.y), w, h } : null;
    }
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    if (d < g / 2) return null;
    if (shapeKind === 'circle') return { shape: 'circle', cx: a.x, cy: a.y, r: snapLen(d, g) };
    return { shape: 'cone', x: a.x, y: a.y, len: snapLen(d, g), dir: Math.atan2(b.y - a.y, b.x - a.x) };
  };
  const placeToken = (id: string, x: number, y: number) => {
    combat.patchMap((m) => { m.tokens[id] = { x, y }; });
    void combat.map({ action: 'token', id, x, y });
  };

  const tokenDown = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0 || placing || space.current) return;
    // 范围法术：交给地图（放模板）
    if (ui.aim?.area) return;
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
  // 当前回合的人这一回合走过的路（服务器记的；换人 / 换轮作废）
  const trail = (() => {
    const tr = map.trail;
    if (!tr || st.round === null || tr.id !== current || tr.key !== `${st.round}:${st.turnIndex}` || !visible(tr.id) || tr.cells.length < 2) return null;
    return { ...tr, n: footprint(st.combatants[tr.id]?.base.size) };
  })();
  const aimed: Record<string, number> = {};
  for (const p of ui.aim?.picks ?? []) aimed[p] = (aimed[p] ?? 0) + 1;

  const hint = `滚轮缩放 · 拖空白处或按住空格平移 · 点棋子选中、右键设为目标、Delete 拿下地图、Esc 取消选中 · 每格 5 尺，斜走${diagonal === '5' ? '也算 5 尺' : '交替 5 / 10 尺'}，引擎按棋子位置自动判断距离`;
  return (
    <div className="map-root">
      <div className="hud map-rail" title={hint}>
        {(['move', 'measure', 'shape', 'pen', 'erase'] as Tool[]).map((t) => (
          <button key={t} className={tool === t ? 'on' : ''} onClick={() => setTool(t)} title={TOOL_TIP[t]}>{TOOL_CN[t]}</button>
        ))}
        <hr />
        <button onClick={fit} title="缩放到整张图">适应</button>
        {dm && <button className={setup ? 'on' : ''} onClick={() => setSetup(!setup)} title="上传底图、对齐格子、斜走规则">底图</button>}
      </div>
      <div className="map-fly">
      {tool === 'shape' && (
        <div className="hud map-bar">
          {(['rect', 'circle', 'cone'] as ShapeKind[]).map((k) => <button key={k} className={'btn sm' + (k === shapeKind ? ' on' : '')} onClick={() => setShapeKind(k)}>{SHAPE_CN[k]}</button>)}
          <span style={{ width: 4 }} />
          {COLORS.map((c) => <button key={c} className={'swatch' + (c === color ? ' on' : '')} style={{ background: c }} onClick={() => setColor(c)} aria-label={`颜色 ${c}`} />)}
          <span style={{ width: 4 }} />
          <span className="tiny faint">{shapeKind === 'rect' ? '从一角拖到对角' : shapeKind === 'circle' ? '从圆心往外拖' : '从顶点往外拖'}</span>
        </div>
      )}
      {tool === 'pen' && (
        <div className="hud map-bar">
          {COLORS.map((c) => <button key={c} className={'swatch' + (c === color ? ' on' : '')} style={{ background: c }} onClick={() => setColor(c)} aria-label={`颜色 ${c}`} />)}
          <span style={{ width: 4 }} />
          {WIDTHS.map((w) => <button key={w} className={'btn sm' + (w === width ? ' on' : '')} onClick={() => setWidth(w)}>{w === 3 ? '细' : w === 6 ? '中' : '粗'}</button>)}
          <span style={{ width: 4 }} />
          <button className="btn ghost sm" onClick={() => { if (confirm('擦掉你画的所有线和形状？')) void combat.map({ action: 'clear', mine: true }); }}>擦掉我画的</button>
          {dm && <button className="btn ghost sm danger" onClick={() => { if (confirm('擦掉所有人画的线和形状？')) void combat.map({ action: 'clear' }); }}>全部擦掉</button>}
        </div>
      )}
      {tool === 'erase' && <div className="hud map-bar tiny faint">按住拖过线条或形状就擦掉。{dm ? '' : '只能擦你自己画的。'}</div>}
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
        className={'map-box tool-' + (placing ? 'place' : ui.aim ? 'aim' : tool === 'shape' ? 'measure' : tool) + (drag?.kind === 'pan' ? ' panning' : '')}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onPointerLeave={() => { if (areaAim && !fixed) setPt(null); }}
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
            {(map.shapes ?? []).map((x) => {
              const lb = tplLabel(x.tpl, g);
              return (
                <g key={x.id} className={'map-shape' + (drag?.kind === 'erase' && drag.ids.has(x.id) ? ' erasing' : '')}>
                  <path d={tplPath(x.tpl)} data-shape={x.id} fill={x.color} fillOpacity={0.14} stroke={x.color} strokeWidth={2 / view.k}
                    style={{ pointerEvents: tool === 'erase' ? 'visiblePainted' : 'none' }} />
                  <text className="map-dist" fontSize={12 / view.k} x={lb.x} y={lb.y}>{lb.text}</text>
                </g>
              );
            })}
            {drag?.kind === 'shape' && (() => {
              const t = shapeTpl(drag.from, drag.to);
              if (!t) return null;
              const lb = tplLabel(t, g);
              return (
                <g className="map-shape">
                  <path d={tplPath(t)} fill={color} fillOpacity={0.14} stroke={color} strokeWidth={2 / view.k} strokeDasharray={`${6 / view.k} ${4 / view.k}`} />
                  <text className="map-dist" fontSize={14 / view.k} x={lb.x} y={lb.y}>{lb.text}</text>
                </g>
              );
            })()}
            {trail && (() => {
              // 这一回合走过的路：格子中心连起来
              const half = (trail.n * g) / 2;
              const pts = trail.cells.map((c) => `${map.grid.ox + c.x * g + half},${map.grid.oy + c.y * g + half}`).join(' ');
              const last = trail.cells[trail.cells.length - 1];
              return (
                <g className="map-trail">
                  <polyline points={pts} fill="none" strokeWidth={3 / view.k} strokeDasharray={`${2 / view.k} ${6 / view.k}`} strokeLinecap="round" />
                  <text className="map-dist" fontSize={12 / view.k} x={map.grid.ox + last.x * g + half} y={map.grid.oy + last.y * g - 4 / view.k}>本回合 {pathFeet(trail.cells, diagonal)} 尺</text>
                </g>
              );
            })()}
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
                  {id === ui.selected && <circle className="ring-sel" r={r * 0.86 + 5} />}
                  {ui.targets.includes(id) && <circle className="ring-tgt" r={r * 0.86 + (id === ui.selected ? 10 : 5)} />}
                  <circle className="body" r={r * 0.86} />
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
              const all = [...drag.pts, drag.to];
              const last = drag.pts[drag.pts.length - 1];
              return (
                <g className="map-measure">
                  <polyline points={all.map((c) => `${cx(c)},${cy(c)}`).join(' ')} fill="none" strokeWidth={3 / view.k} strokeDasharray={`${8 / view.k} ${5 / view.k}`} />
                  {drag.pts.map((c, i) => <circle key={i} cx={cx(c)} cy={cy(c)} r={5 / view.k} />)}
                  <text className="map-dist" fontSize={16 / view.k} x={cx(drag.to)} y={cy(drag.to) - g * 0.6}>
                    {pathFeet(all, diagonal)} 尺{drag.pts.length > 1 ? `（这段 ${gridFeet(drag.to.x - last.x, drag.to.y - last.y, diagonal)}）` : ''}
                  </text>
                </g>
              );
            })()}
            {areaAim && (() => {
              const t = fixed ?? (pt ? tplAt(pt) : null);
              if (!t) return null;
              const bad = !fixed && outOfRange(t);
              const d = originFeet(t);
              const lb = tplLabel(t, g);
              return (
                <g className={'map-aoe' + (fixed ? ' fixed' : '') + (bad ? ' bad' : '')}>
                  <path d={tplPath(t)} strokeWidth={2 / view.k} />
                  <text className="map-dist" fontSize={13 / view.k} x={lb.x} y={lb.y}>{lb.text}{d != null ? ` · 距你 ${d} 尺` : ''}</text>
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

const sameCell = (a: { x: number; y: number }, b: { x: number; y: number }) => a.x === b.x && a.y === b.y;
