// 地图范围模板的几何（app/lib/area.ts）：一格 50 像素 = 5 尺
import { describe, expect, it } from 'vitest';
import { cellCenters, inside, spellTpl, type Tpl } from '../../app/lib/area';

const gr = { size: 50, ox: 0, oy: 0 };
const hits = (t: Tpl, x: number, y: number, n = 1) => cellCenters(gr, { x, y }, n).some(([px, py]) => inside(t, px, py));

describe('范围模板', () => {
  it('火球（半径 20 尺）：放在格点上，圈住 8×8 格里中心在圆内的', () => {
    const t = spellTpl({ area: { shape: 'sphere', radius: 20 }, self: false }, gr, null, { x: 510, y: 495 })!;
    expect(t).toEqual({ shape: 'circle', cx: 500, cy: 500, r: 200 });
    expect(hits(t, 10, 10)).toBe(true);
    expect(hits(t, 13, 10)).toBe(true); // 中心离圆心 175
    expect(hits(t, 14, 10)).toBe(false); // 225
    expect(hits(t, 13, 13)).toBe(false); // 斜角 247
  });

  it('燃烧之手（15 尺锥）：从施法者身边出发，正前方 3 格都在，旁边的不在', () => {
    // 施法者占 (0,0) 那一格，中心 (25,25)，朝右
    const t = spellTpl({ area: { shape: 'cone', length: 15 }, self: true }, gr, { x: 25, y: 25, half: 25 }, { x: 500, y: 25 })!;
    expect(hits(t, 1, 0)).toBe(true);
    expect(hits(t, 3, 0)).toBe(true);
    expect(hits(t, 4, 0)).toBe(false);
    expect(hits(t, 3, 1)).toBe(true); // 末端宽 15 尺
    expect(hits(t, 1, 1)).toBe(false);
    expect(hits(t, 0, 0)).toBe(false);
  });

  it('雷鸣波（15 尺立方，自身）：贴着施法者那一面', () => {
    const t = spellTpl({ area: { shape: 'cube', size: 15 }, self: true }, gr, { x: 125, y: 125, half: 25 }, { x: 600, y: 130 })!;
    expect(t).toEqual({ shape: 'rect', x: 150, y: 50, w: 150, h: 150 });
    expect(hits(t, 3, 1)).toBe(true);
    expect(hits(t, 2, 2)).toBe(false);
  });

  it('大型生物：占的格子有一格在范围里就算', () => {
    const t: Tpl = { shape: 'circle', cx: 0, cy: 0, r: 60 };
    expect(hits(t, 0, 0, 2)).toBe(true);
    expect(hits(t, 1, -3, 2)).toBe(false);
  });
});
