import * as THREE from 'three';

import type { DieKind } from './options';

export type ShapeKind = DieKind;

/** 一个面在贴图集里的二维排布（像素坐标，canvas y 向下） */
export interface FaceLayout {
  /** 所在格子的中心 */
  cx: number;
  cy: number;
  /** 面上各顶点在贴图里的位置（与 faces[i] 顺序一致） */
  pts: [number, number][];
  /** 面的内切半径（像素），用来定字号 */
  inradius: number;
}

export interface DieShape {
  kind: ShapeKind;
  vertices: THREE.Vector3[];
  /** 每个面的顶点索引，从外面看逆时针 */
  faces: number[][];
  normals: THREE.Vector3[];
  /** 每个面上数字的“字头”方向（在面内） */
  textUp: THREE.Vector3[];
  /** d4：读数看朝上的那个顶点，而不是朝上的面 */
  vertexMode: boolean;
  /** 平放时中心离桌面的高度 */
  restHeight: number;
  /** 贴图集：格子数、尺寸、每个面的排布 */
  atlas: { cols: number; rows: number; cell: number; width: number; height: number; faces: FaceLayout[] };
  /** 共享的渲染几何体（非索引、平面法线、UV 指向各自格子） */
  geometry: THREE.BufferGeometry;
}

const PHI = (1 + Math.sqrt(5)) / 2;

/** 外接球半径：让各种骰子看起来差不多大 */
const SIZE: Record<ShapeKind, number> = { 4: 1.1, 6: 0.85, 8: 0.92, 10: 0.92, 12: 0.92, 20: 0.95 };

function rawVertices(kind: ShapeKind): number[][] {
  switch (kind) {
    case 4:
      return [[1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1]];
    case 6: {
      const v: number[][] = [];
      for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) v.push([x, y, z]);
      return v;
    }
    case 8:
      return [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    case 10: {
      // 五角偏方面体：两极 + 上下交错的两圈；z0 取值保证每个风筝面共面
      const h = 1.1;
      const c = Math.cos(Math.PI / 5);
      const z0 = (h * (1 - c)) / (1 + c);
      const v: number[][] = [[0, h, 0], [0, -h, 0]];
      for (let k = 0; k < 5; k++) {
        const a = (k * 2 * Math.PI) / 5;
        const b = a + Math.PI / 5;
        v.push([Math.cos(a), z0, Math.sin(a)]);
        v.push([Math.cos(b), -z0, Math.sin(b)]);
      }
      return v;
    }
    case 12: {
      const v: number[][] = [];
      for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) v.push([x, y, z]);
      const p = PHI;
      const q = 1 / PHI;
      for (const a of [-1, 1])
        for (const b of [-1, 1]) {
          v.push([0, a * q, b * p]);
          v.push([a * q, b * p, 0]);
          v.push([a * p, 0, b * q]);
        }
      return v;
    }
    case 20: {
      const v: number[][] = [];
      for (const a of [-1, 1])
        for (const b of [-1, 1]) {
          v.push([0, a, b * PHI]);
          v.push([a, b * PHI, 0]);
          v.push([a * PHI, 0, b]);
        }
      return v;
    }
  }
}

/** 由凸多面体的顶点求出所有面（顶点不超过 20 个，暴力就够了） */
function hullFaces(pts: THREE.Vector3[], eps = 1e-5): { faces: number[][]; normals: THREE.Vector3[] } {
  const faces: number[][] = [];
  const normals: THREE.Vector3[] = [];
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  for (let i = 0; i < pts.length; i++)
    for (let j = i + 1; j < pts.length; j++)
      for (let k = j + 1; k < pts.length; k++) {
        const n = new THREE.Vector3().crossVectors(e1.subVectors(pts[j], pts[i]), e2.subVectors(pts[k], pts[i]));
        if (n.lengthSq() < eps) continue;
        n.normalize();
        let d = n.dot(pts[i]);
        let pos = false;
        let neg = false;
        for (const p of pts) {
          const s = n.dot(p) - d;
          if (s > eps) pos = true;
          else if (s < -eps) neg = true;
        }
        if (pos && neg) continue;
        if (pos) {
          n.negate();
          d = -d;
        }
        if (normals.some((m) => m.dot(n) > 1 - 1e-6)) continue;
        const idx = pts.map((_, m) => m).filter((m) => Math.abs(n.dot(pts[m]) - d) < eps);
        const c = new THREE.Vector3();
        for (const m of idx) c.add(pts[m]);
        c.divideScalar(idx.length);
        const a = new THREE.Vector3().subVectors(pts[idx[0]], c).normalize();
        const b = new THREE.Vector3().crossVectors(n, a);
        const ang = (m: number) => {
          const r = new THREE.Vector3().subVectors(pts[m], c);
          return Math.atan2(r.dot(b), r.dot(a));
        };
        idx.sort((x, y) => ang(x) - ang(y));
        faces.push(idx);
        normals.push(n);
      }
  return { faces, normals };
}

function cellSize(kind: ShapeKind): number {
  if (kind <= 8) return 256;
  if (kind <= 12) return 208;
  return 168;
}

function build(kind: ShapeKind, scale: number): DieShape {
  const raw = rawVertices(kind).map(([x, y, z]) => new THREE.Vector3(x, y, z));
  const rmax = Math.max(...raw.map((v) => v.length()));
  const vertices = raw.map((v) => v.multiplyScalar((SIZE[kind] * scale) / rmax));
  const { faces, normals } = hullFaces(vertices);
  const restHeight = Math.min(...faces.map((f, i) => normals[i].dot(vertices[f[0]])));

  const cell = cellSize(kind);
  const cols = Math.ceil(Math.sqrt(faces.length));
  const rows = Math.ceil(faces.length / cols);
  const width = cols * cell;
  const height = rows * cell;

  const layouts: FaceLayout[] = [];
  const textUp: THREE.Vector3[] = [];
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];

  faces.forEach((f, i) => {
    const n = normals[i];
    const c = new THREE.Vector3();
    for (const m of f) c.add(vertices[m]);
    c.divideScalar(f.length);

    // 字的“上”方向：d10 指向极点；方面指向一条边的中点；三角面指向一个顶点
    let up: THREE.Vector3;
    if (kind === 10) {
      const far = f.reduce((a, b) => (vertices[a].distanceTo(c) > vertices[b].distanceTo(c) ? a : b));
      up = vertices[far].clone().sub(c);
    } else if (f.length === 3) {
      up = vertices[f[0]].clone().sub(c);
    } else {
      up = vertices[f[0]].clone().add(vertices[f[1]]).multiplyScalar(0.5).sub(c);
    }
    up.sub(n.clone().multiplyScalar(up.dot(n))).normalize();
    textUp.push(up);
    const right = new THREE.Vector3().crossVectors(up, n);

    const local = f.map((m) => {
      const r = vertices[m].clone().sub(c);
      return [r.dot(right), r.dot(up)] as [number, number];
    });
    const circ = Math.max(...local.map(([x, y]) => Math.hypot(x, y)));
    const s = (cell * 0.47) / circ;
    const cx = (i % cols) * cell + cell / 2;
    const cy = Math.floor(i / cols) * cell + cell / 2;
    const pts = local.map(([x, y]) => [cx + x * s, cy - y * s] as [number, number]);

    let inradius = Infinity;
    for (let k = 0; k < pts.length; k++) {
      const [ax, ay] = pts[k];
      const [bx, by] = pts[(k + 1) % pts.length];
      const dist = Math.abs((bx - ax) * (ay - cy) - (ax - cx) * (by - ay)) / Math.hypot(bx - ax, by - ay);
      inradius = Math.min(inradius, dist);
    }
    layouts.push({ cx, cy, pts, inradius });

    // 扇形三角化
    for (let k = 1; k < f.length - 1; k++) {
      for (const t of [0, k, k + 1]) {
        const v = vertices[f[t]];
        pos.push(v.x, v.y, v.z);
        nor.push(n.x, n.y, n.z);
        uv.push(pts[t][0] / width, 1 - pts[t][1] / height);
      }
    }
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geometry.computeBoundingSphere();

  return {
    kind,
    vertices,
    faces,
    normals,
    textUp,
    vertexMode: kind === 4,
    restHeight,
    atlas: { cols, rows, cell, width, height, faces: layouts },
    geometry,
  };
}

const cache = new Map<string, DieShape>();

/** scale：大小倍数。同一 (kind, scale) 共享一份几何体 */
export function getShape(kind: ShapeKind, scale = 1): DieShape {
  const key = `${kind}:${scale}`;
  let s = cache.get(key);
  if (!s) {
    s = build(kind, scale);
    cache.set(key, s);
  }
  return s;
}

/** 在给定姿态下，朝上的面（d4 是朝上的顶点）的索引 */
export function topIndex(shape: DieShape, q: THREE.Quaternion): number {
  const list = shape.vertexMode ? shape.vertices : shape.normals;
  const v = new THREE.Vector3();
  let best = -Infinity;
  let bi = 0;
  list.forEach((p, i) => {
    v.copy(p).applyQuaternion(q);
    if (v.y > best) {
      best = v.y;
      bi = i;
    }
  });
  return bi;
}
