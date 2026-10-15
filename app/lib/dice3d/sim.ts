import * as CANNON from 'cannon-es';
import * as THREE from 'three';
import type { DieShape } from './geometry';

export interface Arena {
  w: number;
  d: number;
}

export interface SimOptions {
  arena: Arena;
  /** 停下后把斜靠的骰子放平 */
  layFlat: boolean;
}

/** 每帧记录 7 个数：位置 xyz + 四元数 xyzw */
export const STRIDE = 7;

export interface SimResult {
  frames: Float32Array;
  /** 记录的帧数 */
  count: number;
  /** 两帧之间的模拟时间（秒） */
  dt: number;
}

const RECORD_DT = 1 / 60;
/** 从这个时间起逐渐加大阻尼，让骰子尽快停下来（只影响尾巴，看不出来） */
const SETTLE_START = 1.0;
const SETTLE_FULL = 2.0;
const MAX_TIME = 3;
/**
 * 判定“停稳”：速度、角速度都很小，连续若干帧。
 * 平放的骰子 8 帧就算停稳；没平放的（压在棱上、靠着别的骰子）要静止更久才算，
 * 免得把正在慢慢翻倒的骰子冻在斜角上。
 */
const REST_SPEED = 0.15;
const REST_SPIN = 0.3;
const REST_FRAMES_FLAT = 8;
const REST_FRAMES_TILTED = 20;
/** 底面法线和正下方的夹角余弦超过这个值，就算“平放”（约 4°） */
const FLAT_DOT = 0.9975;
/** 最后把斜靠着的骰子放平所用的时间 */
const TIP_TIME = 0.3;

const polyCache = new WeakMap<DieShape, CANNON.ConvexPolyhedron>();

function convexOf(shape: DieShape): CANNON.ConvexPolyhedron {
  let p = polyCache.get(shape);
  if (!p) {
    p = new CANNON.ConvexPolyhedron({
      vertices: shape.vertices.map((v) => new CANNON.Vec3(v.x, v.y, v.z)),
      faces: shape.faces.map((f) => f.slice()),
    });
    polyCache.set(shape, p);
  }
  return p;
}

function randomQuat(rng: () => number): CANNON.Quaternion {
  // Shoemake 均匀随机旋转
  const u1 = rng();
  const u2 = rng() * Math.PI * 2;
  const u3 = rng() * Math.PI * 2;
  const a = Math.sqrt(1 - u1);
  const b = Math.sqrt(u1);
  return new CANNON.Quaternion(a * Math.sin(u2), a * Math.cos(u2), b * Math.sin(u3), b * Math.cos(u3));
}

function radiusOf(shape: DieShape): number {
  return Math.max(...shape.vertices.map((v) => v.length()));
}

const DOWN = new THREE.Vector3(0, -1, 0);
const tmpV = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const prevQ = new THREE.Quaternion();

/** 最朝下的那个面：返回它的索引和法线 y 分量（-1 = 完全贴平） */
function bottomFace(shape: DieShape, q: THREE.Quaternion): { face: number; y: number } {
  let y = Infinity;
  let face = 0;
  shape.normals.forEach((nrm, j) => {
    tmpV.copy(nrm).applyQuaternion(q);
    if (tmpV.y < y) {
      y = tmpV.y;
      face = j;
    }
  });
  return { face, y };
}

/** 把整段物理过程先算完，记下每一帧的位姿 */
export function simulate(shapes: DieShape[], rng: () => number, opts: SimOptions): SimResult {
  const { arena } = opts;
  // 不用 cannon 自带的睡眠：它只看速度，会把正在慢慢翻过棱的骰子冻在半空的斜角上
  const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -42, 0), allowSleep: false });
  world.broadphase = new CANNON.NaiveBroadphase();
  (world.solver as CANNON.GSSolver).iterations = 12;

  const diceMat = new CANNON.Material('dice');
  const floorMat = new CANNON.Material('floor');
  const wallMat = new CANNON.Material('wall');
  world.addContactMaterial(new CANNON.ContactMaterial(diceMat, floorMat, { friction: 0.45, restitution: 0.28 }));
  world.addContactMaterial(new CANNON.ContactMaterial(diceMat, wallMat, { friction: 0.05, restitution: 0.55 }));
  world.addContactMaterial(new CANNON.ContactMaterial(diceMat, diceMat, { friction: 0.2, restitution: 0.4 }));

  const addPlane = (mat: CANNON.Material, pos: [number, number, number], axis: CANNON.Vec3, angle: number) => {
    const b = new CANNON.Body({ mass: 0, material: mat, shape: new CANNON.Plane() });
    b.position.set(...pos);
    b.quaternion.setFromAxisAngle(axis, angle);
    world.addBody(b);
  };
  // Plane 的法线默认是 +z
  const X = new CANNON.Vec3(1, 0, 0);
  const Y = new CANNON.Vec3(0, 1, 0);
  const hw = arena.w / 2;
  const hd = arena.d / 2;
  addPlane(floorMat, [0, 0, 0], X, -Math.PI / 2);
  addPlane(wallMat, [-hw, 0, 0], Y, Math.PI / 2);
  addPlane(wallMat, [hw, 0, 0], Y, -Math.PI / 2);
  addPlane(wallMat, [0, 0, -hd], Y, 0);
  addPlane(wallMat, [0, 0, hd], Y, Math.PI);

  // 从左、右或靠近镜头的一边扔进来。起始队形按骰子大小和桌子大小排，放不下就往上叠一层
  const side = Math.floor(rng() * 3);
  const dir = side === 0 ? [1, 0] : side === 1 ? [-1, 0] : [0, -1];
  const perp = [-dir[1], dir[0]];
  const edge = side === 2 ? hd : hw;
  const perpHalf = side === 2 ? hw : hd;
  const n = shapes.length;
  const rMax = Math.max(...shapes.map(radiusOf));
  const gap = rMax * 2 + 0.3;
  const across = Math.max(1, Math.min(n, 5, Math.floor((perpHalf * 2 - 2 * rMax - 0.4) / gap) + 1));
  const alongFit = Math.max(1, Math.floor((edge - rMax - 0.3) / gap) + 1); // 只占从墙到中线这一半
  const along = Math.ceil(n / across);
  const spin = (rng() - 0.5) * 0.5; // 整体扔的方向稍微偏一点
  const speedK = Math.sqrt(arena.w / 17);

  const bodies = shapes.map((shape, i) => {
    const row = Math.floor(i / across);
    const a = row % alongFit;
    const layer = Math.floor(row / alongFit);
    const p = i % across;
    const offA = edge - rMax - 0.3 - a * gap; // 离墙的距离
    const offP = (p - (across - 1) / 2) * gap + (rng() - 0.5) * 0.3;
    const x = -dir[0] * offA + perp[0] * offP;
    const z = -dir[1] * offA + perp[1] * offP;
    const body = new CANNON.Body({
      mass: 1,
      material: diceMat,
      shape: convexOf(shape),
      linearDamping: 0.1,
      angularDamping: 0.2,
    });
    body.position.set(x, 2.2 * rMax + rng() * 2.5 + (along - row) * 0.3 + layer * gap, z);
    body.quaternion.copy(randomQuat(rng));
    const ang = spin + (rng() - 0.5) * 0.5;
    const speed = (13 + rng() * 6) * speedK;
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    body.velocity.set((dir[0] * c - dir[1] * s) * speed, -2 + rng() * 4, (dir[0] * s + dir[1] * c) * speed);
    const w = new CANNON.Vec3(rng() - 0.5, rng() - 0.5, rng() - 0.5);
    w.normalize();
    w.scale(14 + rng() * 14, w);
    body.angularVelocity.copy(w);
    world.addBody(body);
    return body;
  });

  const tipFrames = opts.layFlat ? Math.round(TIP_TIME / RECORD_DT) : 0;
  const simFrames = Math.ceil(MAX_TIME / RECORD_DT) + 1;
  const frames = new Float32Array((simFrames + tipFrames) * n * STRIDE);
  const record = (f: number) => {
    bodies.forEach((b, i) => {
      const o = (f * n + i) * STRIDE;
      frames[o] = b.position.x;
      frames[o + 1] = b.position.y;
      frames[o + 2] = b.position.z;
      frames[o + 3] = b.quaternion.x;
      frames[o + 4] = b.quaternion.y;
      frames[o + 5] = b.quaternion.z;
      frames[o + 6] = b.quaternion.w;
    });
  };

  const still = new Array<number>(n).fill(0);
  const flat = new Array<boolean>(n).fill(false);
  record(0);
  let count = 1;
  while (count < simFrames) {
    const t = count * RECORD_DT;
    if (t > SETTLE_START) {
      // 平移阻尼加得重，转动阻尼加得轻：骰子会停下，但压在棱上的还会继续倒下去
      const k = Math.min(1, (t - SETTLE_START) / (SETTLE_FULL - SETTLE_START));
      for (const b of bodies) {
        b.linearDamping = 0.1 + 0.8 * k;
        b.angularDamping = 0.2 + 0.55 * k;
      }
    }
    world.step(RECORD_DT);
    record(count++);
    // 用相邻两帧的位姿差算速度：cannon 报告的 velocity 在静止接触时会有残留抖动，不可靠
    let all = true;
    const cur = (count - 1) * n * STRIDE;
    const prev = cur - n * STRIDE;
    bodies.forEach((b, i) => {
      const o = cur + i * STRIDE;
      const po = prev + i * STRIDE;
      const speed =
        Math.hypot(frames[o] - frames[po], frames[o + 1] - frames[po + 1], frames[o + 2] - frames[po + 2]) / RECORD_DT;
      tmpQ.set(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w);
      prevQ.fromArray(frames, po + 3);
      const spin = tmpQ.angleTo(prevQ) / RECORD_DT;
      const rest = speed < REST_SPEED && spin < REST_SPIN;
      still[i] = rest ? still[i] + 1 : 0;
      if (still[i] === 1) flat[i] = bottomFace(shapes[i], tmpQ).y < -FLAT_DOT;
      if (still[i] < (flat[i] ? REST_FRAMES_FLAT : REST_FRAMES_TILTED)) all = false;
      // 按我们自己的标准判定停稳后，手动让它睡：不再参与求解，省时间；被别的骰子撞到会自动醒
      else if (b.sleepState !== CANNON.Body.SLEEPING) b.sleep();
    });
    if (all) break;
  }
  if (opts.layFlat) count = layFlat(shapes, frames, count, tipFrames, arena);
  return { frames: frames.subarray(0, count * n * STRIDE), count, dt: RECORD_DT };
}

/**
 * 物理停下后，仍可能有骰子斜靠在别的骰子或墙上、或者叠在别的骰子上面，读不清点数。
 * 把这些骰子在最后一小段里放平，必要时挪开一点避免和邻居重叠。
 * 只有真的要横向挪开时才会稍微抬起来，原地放平不抬。
 * 返回追加后的帧数。
 */
function layFlat(shapes: DieShape[], frames: Float32Array, count: number, extra: number, arena: Arena): number {
  const n = shapes.length;
  const last = (count - 1) * n * STRIDE;
  const radius = shapes.map(radiusOf);
  const pos = shapes.map((_, i) => new THREE.Vector3().fromArray(frames, last + i * STRIDE));
  const quat = shapes.map((_, i) => new THREE.Quaternion().fromArray(frames, last + i * STRIDE + 3));
  const goalPos = pos.map((p) => p.clone());
  const goalQuat = quat.map((q) => q.clone());
  const moving: number[] = [];
  const v = new THREE.Vector3();
  const fix = new THREE.Quaternion();

  shapes.forEach((s, i) => {
    const { face, y } = bottomFace(s, quat[i]);
    if (y < -FLAT_DOT && Math.abs(pos[i].y - s.restHeight) < 0.05 * radius[i]) return;
    v.copy(s.normals[face]).applyQuaternion(quat[i]);
    fix.setFromUnitVectors(v, DOWN);
    goalQuat[i].premultiply(fix);
    goalPos[i].y = s.restHeight;
    moving.push(i);
  });
  if (!moving.length) return count;

  // 简单的松弛：只挪需要放平的那些，直到不和任何骰子重叠
  for (let it = 0; it < 30; it++) {
    let ok = true;
    for (const i of moving) {
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const dx = goalPos[i].x - goalPos[j].x;
        const dz = goalPos[i].z - goalPos[j].z;
        const d = Math.hypot(dx, dz);
        const min = (radius[i] + radius[j]) * 0.92;
        if (d >= min) continue;
        ok = false;
        const push = min - d + 1e-3;
        const ux = d > 1e-6 ? dx / d : 1;
        const uz = d > 1e-6 ? dz / d : 0;
        const share = moving.includes(j) ? 0.5 : 1;
        goalPos[i].x += ux * push * share;
        goalPos[i].z += uz * push * share;
      }
      const mx = arena.w / 2 - radius[i];
      const mz = arena.d / 2 - radius[i];
      goalPos[i].x = Math.max(-mx, Math.min(mx, goalPos[i].x));
      goalPos[i].z = Math.max(-mz, Math.min(mz, goalPos[i].z));
    }
    if (ok) break;
  }

  // 横向挪多远就抬多高（最多 0.4 个半径），原地放平的完全不抬
  const lift = moving.map((i) =>
    Math.min(0.4 * radius[i], 0.5 * Math.hypot(goalPos[i].x - pos[i].x, goalPos[i].z - pos[i].z)),
  );
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  for (let f = 1; f <= extra; f++) {
    const t = f / extra;
    const e = t * t * (3 - 2 * t); // smoothstep：起止都没有突变
    const o = (count - 1 + f) * n * STRIDE;
    frames.copyWithin(o, last, last + n * STRIDE);
    moving.forEach((i, m) => {
      p.lerpVectors(pos[i], goalPos[i], e);
      p.y += Math.sin(Math.PI * t) * lift[m];
      q.slerpQuaternions(quat[i], goalQuat[i], e);
      p.toArray(frames, o + i * STRIDE);
      q.toArray(frames, o + i * STRIDE + 3);
    });
  }
  return count + extra;
}
