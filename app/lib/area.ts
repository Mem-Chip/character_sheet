/**
 * 地图上的范围形状（世界坐标 = 底图像素；一格 g 像素 = 5 尺）。
 * 两处用：玩家手放的测量形状（MapState.shapes），选目标模式里范围法术的模板。
 *
 * - 圆：中心 + 半径。
 * - 方：左上角 + 宽高（和格线对齐）。
 * - 锥：顶点 + 长度 + 朝向；末端宽度 = 长度（半角 atan(1/2) ≈ 26.6°），2024 规则。
 * - 线：起点 + 长度 + 宽度 + 朝向。
 * 生物算在范围里：它占的格子里有任何一格的中心落在形状里（压线也算）。
 */
import type { Area } from '../../src/combat';

export type Tpl =
  | { shape: 'circle'; cx: number; cy: number; r: number }
  | { shape: 'rect'; x: number; y: number; w: number; h: number }
  | { shape: 'cone'; x: number; y: number; len: number; dir: number }
  | { shape: 'line'; x: number; y: number; len: number; width: number; dir: number };

const CONE_HALF = Math.atan(0.5);
const EPS = 0.5;

export function inside(t: Tpl, px: number, py: number): boolean {
  switch (t.shape) {
    case 'circle': return Math.hypot(px - t.cx, py - t.cy) <= t.r + EPS;
    case 'rect': return px >= t.x - EPS && px <= t.x + t.w + EPS && py >= t.y - EPS && py <= t.y + t.h + EPS;
    case 'cone': {
      const dx = px - t.x, dy = py - t.y;
      const d = Math.hypot(dx, dy);
      if (d < EPS) return false;
      // 沿朝向的投影不超过长度（末端是平的），偏角不超过半角
      const along = dx * Math.cos(t.dir) + dy * Math.sin(t.dir);
      let a = Math.atan2(dy, dx) - t.dir;
      a = Math.atan2(Math.sin(a), Math.cos(a));
      return along <= t.len + EPS && Math.abs(a) <= CONE_HALF + 1e-6;
    }
    case 'line': {
      const dx = px - t.x, dy = py - t.y;
      const along = dx * Math.cos(t.dir) + dy * Math.sin(t.dir);
      const perp = -dx * Math.sin(t.dir) + dy * Math.cos(t.dir);
      return along >= -EPS && along <= t.len + EPS && Math.abs(perp) <= t.width / 2 + EPS;
    }
  }
}

/** SVG 路径 */
export function tplPath(t: Tpl): string {
  switch (t.shape) {
    case 'circle': return `M${t.cx - t.r} ${t.cy}a${t.r} ${t.r} 0 1 0 ${2 * t.r} 0a${t.r} ${t.r} 0 1 0 ${-2 * t.r} 0Z`;
    case 'rect': return `M${t.x} ${t.y}h${t.w}v${t.h}h${-t.w}Z`;
    case 'cone': {
      // 末端是平的：两条边长 len / cos(半角)
      const e = t.len / Math.cos(CONE_HALF);
      const p = (a: number) => `${t.x + e * Math.cos(a)} ${t.y + e * Math.sin(a)}`;
      return `M${t.x} ${t.y}L${p(t.dir - CONE_HALF)}L${p(t.dir + CONE_HALF)}Z`;
    }
    case 'line': {
      const c = Math.cos(t.dir), s = Math.sin(t.dir), w = t.width / 2;
      const pts = [[-s * w, c * w], [t.len * c - s * w, t.len * s + c * w], [t.len * c + s * w, t.len * s - c * w], [s * w, -c * w]];
      return 'M' + pts.map(([x, y]) => `${t.x + x} ${t.y + y}`).join('L') + 'Z';
    }
  }
}

/** 标签：形状的尺寸（尺），以及放标签的位置 */
export function tplLabel(t: Tpl, g: number): { text: string; x: number; y: number } {
  const ft = (px: number) => Math.round((px / g) * 5);
  switch (t.shape) {
    case 'circle': return { text: `半径 ${ft(t.r)} 尺`, x: t.cx, y: t.cy };
    case 'rect': return { text: `${ft(t.w)} × ${ft(t.h)} 尺`, x: t.x + t.w / 2, y: t.y + t.h / 2 };
    case 'cone': return { text: `锥 ${ft(t.len)} 尺`, x: t.x + (t.len * 0.6) * Math.cos(t.dir), y: t.y + (t.len * 0.6) * Math.sin(t.dir) };
    case 'line': return { text: `线 ${ft(t.len)} 尺`, x: t.x + (t.len / 2) * Math.cos(t.dir), y: t.y + (t.len / 2) * Math.sin(t.dir) };
  }
}

export interface Grid { size: number; ox: number; oy: number }
/** 吸附到最近的格线交点 */
export const snapPt = (gr: Grid, x: number, y: number) => ({
  x: gr.ox + Math.round((x - gr.ox) / gr.size) * gr.size,
  y: gr.oy + Math.round((y - gr.oy) / gr.size) * gr.size,
});
/** 吸附到 5 尺的整数倍 */
export const snapLen = (px: number, g: number) => Math.max(g, Math.round(px / g) * g);

/** 一个棋子占的格子的中心 */
export function cellCenters(gr: Grid, t: { x: number; y: number }, n: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) out.push([gr.ox + (t.x + i + 0.5) * gr.size, gr.oy + (t.y + j + 0.5) * gr.size]);
  return out;
}

/** 范围法术的数据 → 原点在哪（自身 / 选一个点）、要不要选方向 */
export interface AreaSpec { area: Area; self: boolean }
export const directional = (a: Area) => a.shape === 'cone' || a.shape === 'line' || a.shape === 'cube';

/**
 * 范围法术的模板。
 * caster：施法者中心和半个身位（像素）；at：鼠标 / 选的点；origin：已经选好的原点（点出发的锥 / 线要先选原点再选方向）。
 */
export function spellTpl(spec: AreaSpec, gr: Grid, caster: { x: number; y: number; half: number } | null, at: { x: number; y: number }, origin?: { x: number; y: number }): Tpl | null {
  const g = gr.size;
  const px = (ft: number | undefined) => ((ft ?? 5) / 5) * g;
  const a = spec.area;
  if (spec.self) {
    if (!caster) return null;
    const dir = Math.atan2(at.y - caster.y, at.x - caster.x);
    switch (a.shape) {
      case 'emanation': case 'sphere': case 'cylinder':
        return { shape: 'circle', cx: caster.x, cy: caster.y, r: px(a.radius ?? a.size) + caster.half };
      case 'cone': return { shape: 'cone', x: caster.x + caster.half * Math.cos(dir), y: caster.y + caster.half * Math.sin(dir), len: px(a.length ?? a.size), dir };
      case 'line': return { shape: 'line', x: caster.x + caster.half * Math.cos(dir), y: caster.y + caster.half * Math.sin(dir), len: px(a.length ?? a.size), width: px(a.width ?? 5), dir };
      case 'cube': {
        // 贴着施法者的一面（或一角），朝鼠标的方向，八个方向吸附
        const S = px(a.size);
        const k = Math.round(dir / (Math.PI / 4));
        const dx = Math.round(Math.cos((k * Math.PI) / 4)), dy = Math.round(Math.sin((k * Math.PI) / 4));
        const x = dx > 0 ? caster.x + caster.half : dx < 0 ? caster.x - caster.half - S : caster.x - S / 2;
        const y = dy > 0 ? caster.y + caster.half : dy < 0 ? caster.y - caster.half - S : caster.y - S / 2;
        const p = snapPt(gr, x, y);
        return { shape: 'rect', x: p.x, y: p.y, w: S, h: S };
      }
    }
  }
  switch (a.shape) {
    case 'sphere': case 'cylinder': case 'emanation': {
      const p = snapPt(gr, at.x, at.y);
      return { shape: 'circle', cx: p.x, cy: p.y, r: px(a.radius ?? a.size) };
    }
    case 'cube': {
      const S = px(a.size);
      const p = snapPt(gr, at.x - S / 2, at.y - S / 2);
      return { shape: 'rect', x: p.x, y: p.y, w: S, h: S };
    }
    case 'cone': case 'line': {
      const o = origin ?? snapPt(gr, at.x, at.y);
      const dir = origin ? Math.atan2(at.y - o.y, at.x - o.x) : 0;
      return a.shape === 'cone'
        ? { shape: 'cone', x: o.x, y: o.y, len: px(a.length ?? a.size), dir }
        : { shape: 'line', x: o.x, y: o.y, len: px(a.length ?? a.size), width: px(a.width ?? 5), dir };
    }
  }
}

/** 模板的「原点」（量施法距离用） */
export function tplOrigin(t: Tpl): { x: number; y: number } {
  switch (t.shape) {
    case 'circle': return { x: t.cx, y: t.cy };
    case 'rect': return { x: t.x + t.w / 2, y: t.y + t.h / 2 };
    default: return { x: t.x, y: t.y };
  }
}

/** 外接框（世界像素） */
export function tplBounds(t: Tpl): { x0: number; y0: number; x1: number; y1: number } {
  switch (t.shape) {
    case 'circle': return { x0: t.cx - t.r, y0: t.cy - t.r, x1: t.cx + t.r, y1: t.cy + t.r };
    case 'rect': return { x0: t.x, y0: t.y, x1: t.x + t.w, y1: t.y + t.h };
    default: {
      // 锥 / 线：最远不超过 长度 + 半宽 的圆
      const R = t.shape === 'cone' ? t.len / Math.cos(CONE_HALF) : Math.hypot(t.len, t.width / 2);
      return { x0: t.x - R, y0: t.y - R, x1: t.x + R, y1: t.y + R };
    }
  }
}

/** 被覆盖的格子（格子中心在形状里）：和范围法术选人用同一条规则 */
export function coveredCells(t: Tpl, gr: Grid, max = 4000): Array<{ x: number; y: number }> {
  const b = tplBounds(t);
  const out: Array<{ x: number; y: number }> = [];
  const i0 = Math.floor((b.x0 - gr.ox) / gr.size), i1 = Math.ceil((b.x1 - gr.ox) / gr.size);
  const j0 = Math.floor((b.y0 - gr.oy) / gr.size), j1 = Math.ceil((b.y1 - gr.oy) / gr.size);
  for (let i = i0; i <= i1; i++) {
    for (let j = j0; j <= j1; j++) {
      if (inside(t, gr.ox + (i + 0.5) * gr.size, gr.oy + (j + 0.5) * gr.size)) out.push({ x: i, y: j });
      if (out.length >= max) return out;
    }
  }
  return out;
}
