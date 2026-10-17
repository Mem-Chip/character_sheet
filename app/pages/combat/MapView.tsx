/**
 * 极简地图（战役遭遇）：格子 + 底图 + 画笔 + 棋子。
 *
 * - 世界坐标就是底图的像素；一格 grid.size 像素，格子原点在 (ox, oy)。没有底图时铺 cols × rows 格。
 * - 工具：移动（拖棋子，拖空白处平移）、测距（只在自己屏幕上；拖的时候按 Q 打个折点接着量）、形状（方 / 圆 / 锥，大家都看得到）、
 *   画笔、橡皮。滚轮缩放，按住中键 / 空格随时平移。
 * - 回合中，轮到的人这一回合走过的路画成虚线，换人就没了。
 * - 双击地图 = 标点；测距时按 Ctrl = 把这条线分享给所有人。两样都过几秒自己淡出。
 * - 形状和范围法术都把盖住的格子（格子中心在里面）涂上颜色；选中的锥 / 线末端有个把手，拖着转。
 * - 右键棋子开菜单（设为目标、状态、拿下地图、藏起）；棋子右下角的数字 = 身上有几个状态。
 * - 选目标模式里的范围法术：模板跟着鼠标走（锥 / 线 / 贴身立方跟着鼠标转向），点一下定下来，圈里的人自动选中。
 * - 棋子：点一下选中，右键设为目标；能控制的才拖得动，松手吸附到格子，拖的时候显示走了多少尺。
 * - 改动先在本地生效（乐观更新），再发给服务器；服务器广播回来的地图为准。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { footprint, gridFeet, pathFeet, reachOf, type Session } from '../../../src/combat';
import { ZoneDialog } from './ZoneDialog';
import { cellHit, coveredCells, directional, snapHalf, snapLen, spellTpl, tplLabel, tplOrigin, tplPath, type Tpl } from '../../lib/area';
import { PING_LIFE } from '../../lib/combat';
import { tokenMenu } from './TokenMenu';
import { effectLabel } from './shared';
import { hoverTerm, leaveTerm } from '../../components/Term';
import { termOfEffect } from '../../lib/terms';
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
  | { kind: 'shapeMove'; id: string; start: { x: number; y: number }; d: { x: number; y: number } }
  | { kind: 'shapeRot'; id: string; dir: number }
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
  /** 选中的形状（移动工具下点一下）：拖着挪，Delete 删，Esc 取消 */
  const [selShape, setSelShape] = useState<string | null>(null);
  /** DM 正在把哪个形状变成区域 */
  const [zoneOf, setZoneOf] = useState<string | null>(null);
  const selShapeRef = useRef<string | null>(null);
  selShapeRef.current = selShape;
  const space = useRef(false);
  /** Shift：放形状、范围法术时吸附到九点（格子中心、边中点、角） */
  const [shift, setShift] = useState(false);
  /** 范围法术：按住拖着调（转向 / 挪位置），松手定下来 */
  const aimDrag = useRef(false);
  const dragRef = useRef<Drag | null>(null);
  dragRef.current = drag;

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
      if (e.key === 'Shift') setShift(true);
      if (e.key === 'Escape') { setSelShape(null); setSetup(false); }
      // 测距时按 Ctrl：把现在这条线分享给所有人
      if (e.key === 'Control' && !e.repeat) {
        const d = dragRef.current;
        if (d?.kind === 'measure' && !(d.pts.length === 1 && sameCell(d.pts[0], d.to))) { combat.ping({ kind: 'measure', cells: [...d.pts, d.to] }); combat.toast('测距已经分享给所有人'); }
      }
      // 测距时按 Q：在当前格打个折点，接着量
      if (e.code === 'KeyQ') setDrag((d) => (d?.kind === 'measure' && !sameCell(d.to, d.pts[d.pts.length - 1]) ? { ...d, pts: [...d.pts, d.to] } : d));
    };
    const up = (e: KeyboardEvent) => { if (e.code === 'Space') space.current = false; if (e.key === 'Shift') setShift(false); };
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
      const sh = selShapeRef.current;
      if (sh) {
        setSelShape(null);
        combat.patchMap((m) => { m.shapes = (m.shapes ?? []).filter((x) => x.id !== sh); });
        void combat.map({ action: 'erase', ids: [sh] });
        return;
      }
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
  /** 选中的棋子在哪些敌人的触及范围里：把那些敌人的触及范围框出来（走出去会被借机攻击） */
  const threats = useMemo(() => {
    const id = ui.selected, me = id ? map.tokens[id] : undefined, c = id ? st.combatants[id] : undefined;
    if (!id || !me || !c || c.live.dead) return [];
    const n = footprint(s.view(id).size);
    const out: Array<{ id: string; x: number; y: number; w: number }> = [];
    for (const [eid, t] of tokens) {
      const e = st.combatants[eid];
      if (eid === id || e.live.dead || e.side === c.side) continue;
      const reach = s.peek((tx) => reachOf(tx, eid));
      if (reach == null) continue;
      const m = footprint(s.view(eid).size);
      const dx = Math.max(0, me.x - (t.x + m - 1), t.x - (me.x + n - 1));
      const dy = Math.max(0, me.y - (t.y + m - 1), t.y - (me.y + n - 1));
      if (gridFeet(dx, dy, diagonal) > reach) continue;
      const r = reach / 5;
      out.push({ id: eid, x: t.x - r, y: t.y - r, w: m + 2 * r });
    }
    return out;
  }, [ui.selected, map.tokens, s, diagonal]);
  const offMap = Object.keys(st.combatants).filter((id) => !map.tokens[id] && visible(id) && (dm || combat.canControl(id)));

  /* ───── 范围法术的模板 ───── */
  const aim = ui.aim;
  const areaAim = aim?.area ?? null;
  const aimKey = aim ? `${aim.actor}|${aim.ref}` : '';
  const casterTok = aim ? map.tokens[aim.actor] : undefined;
  const casterN = aim ? footprint(s.view(aim.actor).size) : 1;
  const caster = casterTok ? { x: map.grid.ox + (casterTok.x + casterN / 2) * g, y: map.grid.oy + (casterTok.y + casterN / 2) * g, half: (casterN * g) / 2 } : null;
  const tplAt = (p: { x: number; y: number }, snap = shift) => (areaAim ? spellTpl(areaAim, map.grid, caster, p, undefined, snap) : null);
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
    const n = footprint(s.view(id).size);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (cellHit(t, map.grid, tk.x + i, tk.y + j)) return true;
    return false;
  }).map(([id]) => id);
  const fix = (t: Tpl) => { setFixed(t); combat.aimSet(caught(t), { cells: coveredCells(t, map.grid).map((c) => `${c.x},${c.y}`), tpl: t as unknown as Record<string, unknown> }); };
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
      if (!tplAt(p)) { combat.toast('施法者不在地图上，在先攻条 / 列表里点人选目标'); return; }
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
      aimDrag.current = true;
      setFixed(null);
      setPt(p);
      return;
    }
    if (placing) {
      const c = toCell(p);
      placeToken(placing, c.x, c.y);
      setPlacing(null);
      return;
    }
    if (tool === 'move' && e.button === 0) setSelShape(null);
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
      // 起点默认就在鼠标处；按住 Shift 吸附到九点
      const s0 = e.shiftKey ? snapHalf(map.grid, p.x, p.y) : p;
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
    if (e.shiftKey !== shift) setShift(e.shiftKey);
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
    } else if (drag.kind === 'shapeRot') {
      const sh = (map.shapes ?? []).find((x) => x.id === drag.id);
      const p = toWorld(e);
      if (sh && 'dir' in sh.tpl) setDrag({ ...drag, dir: Math.atan2(p.y - sh.tpl.y, p.x - sh.tpl.x) });
    } else if (drag.kind === 'shapeMove') {
      // 自由挪；按住 Shift 按整格挪（和格子的相对位置不变）
      const p = toWorld(e);
      const d = e.shiftKey
        ? { x: Math.round((p.x - drag.start.x) / g) * g, y: Math.round((p.y - drag.start.y) / g) * g }
        : { x: p.x - drag.start.x, y: p.y - drag.start.y };
      if (d.x !== drag.d.x || d.y !== drag.d.y) setDrag({ ...drag, d });
    } else if (drag.kind === 'token') {
      // 鼠标在哪，棋子的中心就在哪（不管当初按在棋子的哪个位置）
      const p = toWorld(e);
      const at = { x: Math.round((p.x - map.grid.ox) / g - drag.n / 2), y: Math.round((p.y - map.grid.oy) / g - drag.n / 2) };
      if (at.x !== drag.at.x || at.y !== drag.at.y) setDrag({ ...drag, at });
    }
  };
  const onUp = (e?: React.PointerEvent) => {
    if (aimDrag.current) {
      aimDrag.current = false;
      const t = e ? tplAt(toWorld(e), e.shiftKey) : pt ? tplAt(pt) : null;
      if (t && outOfRange(t)) combat.toast(`超出「${aim!.name}」的射程 ${aim!.range} 尺`);
      else if (t) fix(t);
      return;
    }
    if (!drag) return;
    if (drag.kind === 'pen' && drag.pts.length >= 4) {
      const pts = drag.pts.map((v) => Math.round(v * 10) / 10);
      combat.patchMap((m) => { m.strokes.push({ id: `tmp-${Date.now()}`, by: remote.me, color, width, pts }); });
      void combat.map({ action: 'stroke', color, width, pts });
    } else if (drag.kind === 'erase' && drag.ids.size) {
      const ids = [...drag.ids];
      combat.patchMap((m) => { m.strokes = m.strokes.filter((x) => !drag.ids.has(x.id)); });
      void combat.map({ action: 'erase', ids });
    } else if (drag.kind === 'shapeRot') {
      const { id, dir } = drag;
      combat.patchMap((m) => { m.shapes = (m.shapes ?? []).map((x) => (x.id === id && 'dir' in x.tpl ? { ...x, tpl: { ...x.tpl, dir } } : x)); });
      void combat.map({ action: 'shapeRotate', id, dir });
    } else if (drag.kind === 'shapeMove' && (drag.d.x || drag.d.y)) {
      const { id, d } = drag;
      combat.patchMap((m) => { m.shapes = (m.shapes ?? []).map((x) => (x.id === id ? { ...x, tpl: shiftTpl(x.tpl, d.x, d.y) } : x)); });
      void combat.map({ action: 'shapeMove', id, dx: d.x, dy: d.y });
    } else if (drag.kind === 'shape') {
      const t = shapeTpl(drag.from, drag.to);
      if (t) {
        combat.patchMap((m) => { m.shapes = [...(m.shapes ?? []), { id: `tmp-${Date.now()}`, by: remote.me, color, tpl: t }]; });
        void combat.map({ action: 'shape', color, tpl: t });
      }
    } else if (drag.kind === 'token' && (drag.at.x !== drag.from.x || drag.at.y !== drag.from.y)) {
      placeToken(drag.id, drag.at.x, drag.at.y, !!e?.shiftKey && dm);
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
  /** 拖出来的形状：方 = 从一角拖到对角；圆 = 中心 + 半径；锥 = 顶点 + 长度 + 朝向。边长、半径、长度按 5 尺取整 */
  const shapeTpl = (a: { x: number; y: number }, b: { x: number; y: number }): Tpl | null => {
    if (shapeKind === 'rect') {
      const dx = b.x - a.x, dy = b.y - a.y;
      if (Math.abs(dx) < g / 2 || Math.abs(dy) < g / 2) return null;
      const w = snapLen(Math.abs(dx), g), h = snapLen(Math.abs(dy), g);
      return { shape: 'rect', x: dx < 0 ? a.x - w : a.x, y: dy < 0 ? a.y - h : a.y, w, h };
    }
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    if (d < g / 2) return null;
    if (shapeKind === 'circle') return { shape: 'circle', cx: a.x, cy: a.y, r: snapLen(d, g) };
    return { shape: 'cone', x: a.x, y: a.y, len: snapLen(d, g), dir: Math.atan2(b.y - a.y, b.x - a.x) };
  };
  /** free：DM 按住 Shift 放下 = 不扣移动力。服务器拒绝了（移动力不够）就退回原位 */
  const placeToken = (id: string, x: number, y: number, free = false) => {
    const prev = map.tokens[id];
    combat.patchMap((m) => { m.tokens[id] = { x, y }; });
    void combat.map({ action: 'token', id, x, y, free: free || undefined }).then((ok) => {
      if (!ok) combat.patchMap((m) => { if (prev) m.tokens[id] = prev; else delete m.tokens[id]; });
    });
  };

  const shapeDown = (e: React.PointerEvent, id: string, by: number) => {
    // 别人的形状不接（照样拖地图平移）
    if (e.button !== 0 || tool !== 'move' || placing || ui.aim || space.current || (!dm && by !== remote.me)) return;
    e.stopPropagation();
    setSelShape(id);
    box.current!.setPointerCapture(e.pointerId);
    setDrag({ kind: 'shapeMove', id, start: toWorld(e), d: { x: 0, y: 0 } });
  };
  const rotDown = (e: React.PointerEvent, id: string, dir: number) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    box.current!.setPointerCapture(e.pointerId);
    setDrag({ kind: 'shapeRot', id, dir });
  };
  /** 双击空白处：标点（所有人看得到） */
  const onDbl = (e: React.MouseEvent) => {
    if (ui.aim || placing || (e.target as Element).closest('[data-token]')) return;
    const p = toWorld(e);
    combat.ping({ kind: 'point', x: p.x, y: p.y });
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
    setDrag({ kind: 'token', id, n: footprint(s.view(id).size), from: t, at: t });
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
  /** 形状现在的样子（正在拖 / 转的按拖到的算） */
  const tplOf = (x: { id: string; tpl: Tpl }): Tpl => {
    if (drag?.kind === 'shapeMove' && drag.id === x.id) return shiftTpl(x.tpl, drag.d.x, drag.d.y);
    if (drag?.kind === 'shapeRot' && drag.id === x.id && 'dir' in x.tpl) return { ...x.tpl, dir: drag.dir };
    return x.tpl;
  };
  /** 每个人身上的状态（棋子角标与悬浮窗用） */
  const effOf: Record<string, string[]> = {};
  const rawEffOf: Record<string, Array<(typeof st.effects)[string]>> = {};
  const concOf: Record<string, (typeof st.effects)[string]> = {};
  const proneOf: Record<string, boolean> = {};
  for (const e of Object.values(st.effects)) {
    if (e.suppressed) continue;
    if (e.key === 'concentration') { concOf[e.bearer] = e; continue; }
    const lb = effectLabel(e.name);
    if (lb.cond === '倒地' || e.key === 'XPHB:condition:倒地' || e.origin?.ref === 'XPHB:condition:倒地') proneOf[e.bearer] = true;
    (effOf[e.bearer] ??= []).push(lb.text);
    (rawEffOf[e.bearer] ??= []).push(e);
  }
  // 当前回合的人这一回合走过的路（服务器记的；换人 / 换轮作废）
  const trail = (() => {
    const tr = map.trail;
    if (!tr || st.round === null || tr.id !== current || tr.key !== `${st.round}:${st.turnIndex}` || !visible(tr.id) || tr.cells.length < 2) return null;
    return { ...tr, n: footprint(s.view(tr.id).size) };
  })();
  const aimed: Record<string, number> = {};
  for (const p of ui.aim?.picks ?? []) aimed[p] = (aimed[p] ?? 0) + 1;

  const hint = `滚轮缩放 · 拖空白处或按住空格平移 · 放形状 / 范围法术时按住 Shift 吸附到格子中心、边、角 · 点棋子选中、右键开菜单、Delete 拿下地图、Esc 取消选中 · 双击地图标点 · 测距时按 Q 打折点、按 Ctrl 分享 · 形状可以点选拖动，Delete 删 · DM 按住 Shift 拖棋子不扣移动力 · 每格 5 尺，斜走${diagonal === '5' ? '也算 5 尺' : '交替 5 / 10 尺'}，引擎按棋子位置自动判断距离`;
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
      {dm && tool === 'move' && selShape && (map.shapes ?? []).some((x) => x.id === selShape) && (
        <div className="hud map-bar">
          <span className="tiny faint">选中了一个形状</span>
          <button className="btn sm" onClick={() => setZoneOf(selShape)} title="变成持续的区域：进入、在里面开始 / 结束回合时受伤害或状态">设为区域…</button>
        </div>
      )}
      {zoneOf && (() => {
        const sh = (map.shapes ?? []).find((x) => x.id === zoneOf);
        if (!sh) return null;
        const t = tplOf(sh);
        return (
          <ZoneDialog
            cells={coveredCells(t, map.grid).map((c) => `${c.x},${c.y}`)} tpl={t as unknown as Record<string, unknown>}
            onClose={() => setZoneOf(null)}
            onDone={() => {
              setZoneOf(null); setSelShape(null);
              combat.patchMap((m) => { m.shapes = (m.shapes ?? []).filter((x) => x.id !== sh.id); });
              void combat.map({ action: 'erase', ids: [sh.id] });
            }}
          />
        );
      })()}
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
        onDoubleClick={onDbl}
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
            {Object.values(st.zones ?? {}).map((z) => {
              const cells = z.cells.map((k) => { const [x, y] = k.split(',').map(Number); return { x, y }; });
              const tpl = z.tpl as Tpl | undefined;
              const lb = tpl ? tplLabel(tpl, g) : { x: map.grid.ox + (cells[0].x + 0.5) * g, y: map.grid.oy + (cells[0].y + 0.5) * g };
              return (
                <g key={z.id} className="map-zone">
                  <path d={cellsPath(cells, map.grid)} className="zcells" />
                  {tpl && <path d={tplPath(tpl)} className="zline" strokeWidth={2 / view.k} strokeDasharray={`${8 / view.k} ${4 / view.k}`} />}
                  <text className={'map-dist zname' + (dm ? ' del' : '')} fontSize={13 / view.k} x={lb.x} y={lb.y - 16 / view.k}
                    style={{ pointerEvents: dm ? 'auto' : 'none' }}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => { if (dm && confirm(`删除区域「${z.name}」？`)) combat.dispatch({ type: 'removeZone', id: z.id }); }}>
                    {z.name}{dm && <title>点一下删除</title>}
                  </text>
                </g>
              );
            })}
            {threats.map((t) => (
              <rect key={'th' + t.id} className="map-threat" x={map.grid.ox + t.x * g} y={map.grid.oy + t.y * g} width={t.w * g} height={t.w * g}
                strokeWidth={2 / view.k} strokeDasharray={`${6 / view.k} ${4 / view.k}`}><title>{name(t.id)} 的触及范围：走出去会被借机攻击</title></rect>
            ))}
            {(map.shapes ?? []).map((x) => {
              const tpl = tplOf(x);
              const lb = tplLabel(tpl, g);
              const mine = dm || x.by === remote.me;
              return (
                <g key={x.id} className={'map-shape' + (drag?.kind === 'erase' && drag.ids.has(x.id) ? ' erasing' : '') + (selShape === x.id ? ' sel' : '') + (mine && tool === 'move' ? ' mine' : '')}>
                  <path d={cellsPath(coveredCells(tpl, map.grid), map.grid)} fill={x.color} fillOpacity={0.16} className="cells" />
                  <path d={tplPath(tpl)} data-shape={x.id} fill={x.color} fillOpacity={0.14} stroke={x.color} strokeWidth={(selShape === x.id ? 3 : 2) / view.k}
                    onPointerDown={(e) => shapeDown(e, x.id, x.by)}
                    style={{ pointerEvents: tool === 'erase' || (tool === 'move' && !ui.aim && !placing) ? 'visiblePainted' : 'none' }} />
                  <OriginDot t={tpl} k={view.k} color={x.color} />
                  <text className="map-dist" fontSize={12 / view.k} x={lb.x} y={lb.y}>{lb.text}</text>
                  {selShape === x.id && mine && tool === 'move' && 'dir' in tpl && (
                    <circle className="rot-handle" cx={tpl.x + tpl.len * Math.cos(tpl.dir)} cy={tpl.y + tpl.len * Math.sin(tpl.dir)} r={7 / view.k}
                      strokeWidth={2 / view.k} onPointerDown={(e) => rotDown(e, x.id, tpl.dir)}><title>拖着转</title></circle>
                  )}
                </g>
              );
            })}
            {drag?.kind === 'shape' && (() => {
              const t = shapeTpl(drag.from, drag.to);
              if (!t) return null;
              const lb = tplLabel(t, g);
              return (
                <g className="map-shape">
                  <path d={cellsPath(coveredCells(t, map.grid), map.grid)} fill={color} fillOpacity={0.16} className="cells" />
                  <path d={tplPath(t)} fill={color} fillOpacity={0.14} stroke={color} strokeWidth={2 / view.k} strokeDasharray={`${6 / view.k} ${4 / view.k}`} />
                  <OriginDot t={t} k={view.k} color={color} />
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
              const n = footprint(s.view(id).size);
              const r = (n * g) / 2;
              const conc = concOf[id];
              const down = !c.live.dead && c.live.hp <= 0;
              const prone = !c.live.dead && (proneOf[id] || down);
              const effs = rawEffOf[id] ?? [];
              const firstTerm = effs.map((e) => {
                const lb = effectLabel(e.name);
                return lb.cond ? { kind: 'condition', name: lb.cond } : termOfEffect(e);
              }).find(Boolean);
              const tipParts = [
                conc ? `专注·${conc.name}` : '',
                down && !proneOf[id] ? (c.live.stable ? '倒地（稳定）' : '倒地（濒死）') : '',
                ...(effOf[id] ?? []),
              ].filter(Boolean);
              const cls = ['token', c.side === 'party' ? 'party' : c.side === 'enemy' ? 'enemy' : 'other', id === ui.selected && 'sel', id === current && 'turn',
                ui.targets.includes(id) && 'tgt', c.live.dead && 'dead', prone && 'prone', conc && 'conc', remote.hidden.includes(id) && 'hid', combat.canControl(id) && 'mine'].filter(Boolean).join(' ');
              return (
                <g
                  key={id} data-token={id} className={cls}
                  transform={`translate(${map.grid.ox + at.x * g + r} ${map.grid.oy + at.y * g + r})`}
                  onPointerDown={(e) => tokenDown(e, id)}
                  onContextMenu={(e) => tokenMenu(e, id, ui)}
                >
                  <title>{c.name}{tipParts.length ? `：${tipParts.join('、')}` : ''}</title>
                  {id === ui.selected && <circle className="ring-sel" r={r * 0.86 + 5} />}
                  {ui.targets.includes(id) && <circle className="ring-tgt" r={r * 0.86 + (id === ui.selected ? 10 : 5)} />}
                  {conc && <circle className="ring-conc" r={r * 0.86 + 2.5} />}
                  <circle className="body" r={r * 0.86} />
                  <text dy="0.35em" fontSize={Math.max(10, r * 0.62)}>{c.name.slice(0, n > 1 ? 4 : 2)}</text>
                  {prone && (
                    <g
                      className="prone-badge"
                      transform={`translate(${-r * 0.62} ${-r * 0.62})`}
                      onMouseEnter={(ev) => hoverTerm({ kind: 'condition', name: down && !proneOf[id] ? '昏迷' : '倒地' }, ev.currentTarget)}
                      onMouseLeave={leaveTerm}
                    >
                      <title>{down ? (c.live.stable ? '倒地（稳定）' : '倒地（濒死）') : '倒地'}</title>
                      <circle r={Math.max(7, r * 0.28)} />
                      <text dy="0.35em" fontSize={Math.max(9, r * 0.28)}>倒</text>
                    </g>
                  )}
                  {conc && (
                    <g
                      className="conc-badge"
                      transform={`translate(${-r * 0.62} ${r * 0.62})`}
                      onMouseEnter={(ev) => hoverTerm(termOfEffect(conc), ev.currentTarget)}
                      onMouseLeave={leaveTerm}
                    >
                      <title>专注：{conc.name}</title>
                      <circle r={Math.max(7, r * 0.28)} />
                      <text dy="0.35em" fontSize={Math.max(9, r * 0.28)}>专</text>
                    </g>
                  )}
                  {effOf[id]?.length > 0 && (
                    <g
                      className="eff-badge"
                      transform={`translate(${r * 0.62} ${r * 0.62})`}
                      onMouseEnter={(ev) => hoverTerm(firstTerm, ev.currentTarget)}
                      onMouseLeave={leaveTerm}
                    >
                      <title>{effOf[id].join('、')}</title>
                      <circle r={Math.max(7, r * 0.28)} />
                      <text dy="0.35em" fontSize={Math.max(9, r * 0.3)}>{effOf[id].length}</text>
                    </g>
                  )}
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
              >{(() => {
                // 回合中轮到的人：顺便显示还剩多少移动
                const ft = gridFeet(moving.at.x - moving.from.x, moving.at.y - moving.from.y, diagonal);
                const left = moving.id === current ? st.combatants[moving.id]?.economy.move : undefined;
                return left != null ? `${ft} / 剩 ${left} 尺` : `${ft} 尺`;
              })()}</text>
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
                    {pathFeet(all, diagonal)} 尺{drag.pts.length > 1 ? `（${gridFeet(drag.to.x - last.x, drag.to.y - last.y, diagonal)}）` : ''}
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
                  <path d={cellsPath(coveredCells(t, map.grid), map.grid)} className="cells" />
                  <path d={tplPath(t)} strokeWidth={2 / view.k} />
                  <OriginDot t={t} k={view.k} />
                  <text className="map-dist" fontSize={13 / view.k} x={lb.x} y={lb.y}>{lb.text}{d != null ? ` · 距你 ${d} 尺` : ''}</text>
                </g>
              );
            })()}
            {remote.pings.map((p) => {
              const life = PING_LIFE[p.kind];
              const style = { animationDuration: `${life}ms` };
              if (p.kind === 'point') {
                return (
                  <g key={p.id} className="map-ping" style={style} transform={`translate(${p.x} ${p.y})`}>
                    <circle className="wave" r={g * 0.9} strokeWidth={3 / view.k} />
                    <circle r={5 / view.k} />
                    <text className="map-dist" fontSize={12 / view.k} y={-g * 0.6}>{p.byName}</text>
                  </g>
                );
              }
              const cx = (c: { x: number }) => map.grid.ox + (c.x + 0.5) * g;
              const cy = (c: { y: number }) => map.grid.oy + (c.y + 0.5) * g;
              const end = p.cells[p.cells.length - 1];
              return (
                <g key={p.id} className="map-ping measure" style={style}>
                  <polyline points={p.cells.map((c) => `${cx(c)},${cy(c)}`).join(' ')} fill="none" strokeWidth={3 / view.k} strokeDasharray={`${8 / view.k} ${5 / view.k}`} />
                  {p.cells.slice(0, -1).map((c, i) => <circle key={i} cx={cx(c)} cy={cy(c)} r={5 / view.k} />)}
                  <text className="map-dist" fontSize={14 / view.k} x={cx(end)} y={cy(end) - g * 0.6}>{p.byName}：{pathFeet(p.cells, diagonal)} 尺</text>
                </g>
              );
            })}
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
      <label className="row tiny" style={{ gap: 4 }} title="形状、范围法术盖住哪些格子（选人也按这个）">
        范围判定
        <select value={gr.cover ?? 'center'} onChange={(e) => put({ cover: e.target.value as 'center' | 'corners' })}>
          <option value="center">格子中心</option>
          <option value="corners">中心或小方格的角</option>
        </select>
        {gr.cover === 'corners' && <><NumInput min={10} max={100} value={Math.round((gr.coverK ?? 0.75) * 100)} onChange={(n) => put({ coverK: n / 100 })} />%</>}
      </label>
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

/** 平移一个形状 */
const shiftTpl = (t: Tpl, dx: number, dy: number): Tpl => (t.shape === 'circle' ? { ...t, cx: t.cx + dx, cy: t.cy + dy } : { ...t, x: t.x + dx, y: t.y + dy });

/** 一串格子 → 一条 SVG 路径（每格一个方块） */
const cellsPath = (cells: Array<{ x: number; y: number }>, gr: { size: number; ox: number; oy: number }) =>
  cells.map((c) => `M${gr.ox + c.x * gr.size} ${gr.oy + c.y * gr.size}h${gr.size}v${gr.size}h${-gr.size}Z`).join('');

/** 形状的原点：圆心、锥 / 线的顶点（画个小十字点，看得出从哪出发）；方的不画（中间是尺寸标签） */
function OriginDot({ t, k, color }: { t: Tpl; k: number; color?: string }) {
  if (t.shape === 'rect') return null;
  const o = tplOrigin(t);
  const r = 4 / k, a = 7 / k;
  return (
    <g className="origin-dot" style={color ? { color } : undefined}>
      <path d={`M${o.x - a} ${o.y}H${o.x + a}M${o.x} ${o.y - a}V${o.y + a}`} strokeWidth={1.5 / k} />
      <circle cx={o.x} cy={o.y} r={r} strokeWidth={1.5 / k} />
    </g>
  );
}
