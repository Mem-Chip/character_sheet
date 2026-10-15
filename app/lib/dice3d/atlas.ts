import type { DieShape } from './geometry';

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

function parseHex(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.replace(/./g, (ch) => ch + ch);
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function normalizeColor(hex: string | undefined, fallback: string): string {
  const rgb = hex ? parseHex(hex) : null;
  return rgb ? `rgb(${rgb[0]},${rgb[1]},${rgb[2]})` : fallback;
}

function luminance(css: string): number {
  const m = /rgb\((\d+),(\d+),(\d+)\)/.exec(css);
  if (!m) return 0.5;
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(+m[1]) + 0.7152 * lin(+m[2]) + 0.0722 * lin(+m[3]);
}

function drawLabel(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  size: number,
  maxWidth: number,
  rotation: number,
  underline: boolean,
) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rotation);
  ctx.font = `700 ${size}px ${FONT}`;
  const w = ctx.measureText(text).width;
  if (w > maxWidth) {
    size *= maxWidth / w;
    ctx.font = `700 ${size}px ${FONT}`;
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 0, size * 0.04);
  if (underline) {
    const uw = Math.max(ctx.measureText(text).width * 0.8, size * 0.45);
    ctx.fillRect(-uw / 2, size * 0.46, uw, Math.max(2, size * 0.09));
  }
  ctx.restore();
}

/**
 * 给一颗骰子画贴图集。labels 按面索引（d4 按顶点索引）。
 * 每次掷骰都按「重新贴号」后的 labels 画一张。
 * top 是最后朝上的面（d4 是顶点）：它的数字画得实一点、大一点，其余面稍淡，停稳后一眼能看到结果。
 */
export function drawAtlas(shape: DieShape, labels: string[], color: string, top: number): HTMLCanvasElement {
  const { width, height, cell, faces } = shape.atlas;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = color;
  ctx.fillRect(0, 0, width, height);

  const light = luminance(color) > 0.35;
  const ink = light ? '#1b1b1f' : '#ffffff';
  const softInk = light ? 'rgba(27,27,31,0.62)' : 'rgba(255,255,255,0.68)';
  const edge = light ? 'rgba(0,0,0,0.22)' : 'rgba(0,0,0,0.35)';
  const sheen = light ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.12)';
  // 所有骰子的 6 和 9 都加下划线（d4 的角标除外）
  const mark69 = true;

  faces.forEach((f, i) => {
    // 面的边：内侧一圈深色描边，看起来像倒角
    ctx.beginPath();
    f.pts.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.lineJoin = 'round';
    ctx.strokeStyle = edge;
    ctx.lineWidth = cell * 0.05;
    ctx.stroke();
    ctx.strokeStyle = sheen;
    ctx.lineWidth = cell * 0.015;
    ctx.stroke();

    if (shape.vertexMode) {
      // d4：每个面三个数字，各自靠近一个顶点，字头朝向那个顶点
      shape.faces[i].forEach((vi, k) => {
        const [px, py] = f.pts[k];
        const dx = px - f.cx;
        const dy = py - f.cy;
        const rot = Math.atan2(dx, -dy);
        const hit = vi === top;
        ctx.fillStyle = hit ? ink : softInk;
        const size = cell * (hit ? 0.28 : 0.24);
        drawLabel(ctx, labels[vi], f.cx + dx * 0.52, f.cy + dy * 0.52, size, cell * 0.32, rot, false);
      });
    } else {
      const text = labels[i];
      const r = f.inradius;
      // 三角面内切圆小，字要相对放大一点
      const tri = f.pts.length === 3;
      const hit = i === top;
      ctx.fillStyle = hit ? ink : softInk;
      const size = r * (text.length > 1 ? (tri ? 1.3 : 1.05) : tri ? 1.55 : 1.25) * (hit ? 1.1 : 1);
      drawLabel(ctx, text, f.cx, f.cy, size, r * (tri ? 2.3 : 1.75), 0, mark69 && (text === '6' || text === '9'));
    }
  });
  return canvas;
}
