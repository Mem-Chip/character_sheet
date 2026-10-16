import * as THREE from 'three';
import { drawAtlas, normalizeColor } from './atlas';
import { getShape, topIndex, type DieShape } from './geometry';
import {
  cloneOptions,
  DEFAULT_DICE_OPTIONS,
  resolveOptions,
  type DiceOptions,
  type DieKind,
  type ResolvedDiceOptions,
} from './options';
import { mulberry32 } from './rng';
import { STRIDE, simulate, type Arena } from './sim';

export { DEFAULT_DICE_OPTIONS };
export type { DiceOptions, DieKind, LabelPosition, ResolvedDiceOptions } from './options';

export interface DieSpec {
  faces: 4 | 6 | 8 | 10 | 12 | 20 | 100; // d100 = 十位骰 + 个位骰两颗 d10
  value: number; // 要停在几（1..faces）
  dropped?: boolean; // 没被取的：落地后变暗
  color?: string; // 骰子颜色，hex
}

export interface RollRequest {
  dice: DieSpec[];
  seed?: number; // 同一个种子 → 同样的滚法
  label?: string; // 显示在角落
  onSettle?: () => void; // 骰子停稳（或被跳过、不滚直接摆好）时调一次
}

/** 保险：正常流程之外再多给这么久，到点一定结束（比如窗口被遮挡、rAF 被浏览器暂停），队列不会卡死 */
const WATCHDOG_EXTRA_MS = 3000;

/** 一颗实体骰子（d100 拆成两颗） */
interface PhysDie {
  shape: DieShape;
  labels: string[];
  target: string;
  color: string;
  dropped: boolean;
}

function expand(specs: DieSpec[], o: ResolvedDiceOptions): PhysDie[] {
  const out: PhysDie[] = [];
  const max = o.physics.maxDice;
  const fallback = normalizeColor(o.look.defaultColor, 'rgb(79,91,213)');
  const shape = (kind: DieKind) => getShape(kind, o.physics.dieScale[kind]);
  const range = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i));
  for (const spec of specs) {
    const faces = spec.faces;
    let v = Math.round(Number(spec.value));
    if (!(v >= 1 && v <= faces)) {
      console.warn(`[dice3d] d${faces} 的点数 ${spec.value} 不合法，已截到范围内`);
      v = Math.min(faces, Math.max(1, Number.isFinite(v) ? v : 1));
    }
    const color = normalizeColor(spec.color, fallback);
    const dropped = !!spec.dropped;
    if (faces === 100) {
      if (out.length + 2 > max) break;
      const tens = Math.floor(v / 10) % 10; // 100 → 00 + 0
      out.push({
        shape: shape(10),
        labels: range(10, (i) => String(i * 10).padStart(2, '0')),
        target: String(tens * 10).padStart(2, '0'),
        color,
        dropped,
      });
      out.push({ shape: shape(10), labels: range(10, (i) => String(i)), target: String(v % 10), color, dropped });
    } else {
      if (out.length + 1 > max) break;
      if (![4, 6, 8, 10, 12, 20].includes(faces)) {
        console.warn(`[dice3d] 不支持 d${faces}，跳过`);
        continue;
      }
      out.push({
        shape: shape(faces as DieKind),
        labels: range(faces, (i) => String(i + 1)),
        target: String(v),
        color,
        dropped,
      });
    }
  }
  return out;
}

/** 桌面大小：只跟参数和骰子数有关、跟屏幕无关，这样同一个种子在各端滚法一样 */
function arenaFor(n: number, o: ResolvedDiceOptions): Arena {
  const k = o.physics.tableGrow ? Math.max(1, Math.sqrt(n / 9)) : 1;
  return { w: o.physics.tableWidth * k, d: o.physics.tableDepth * k };
}

type Phase = 'roll' | 'hold' | 'fade';

interface Playback {
  dice: PhysDie[];
  group: THREE.Group;
  materials: THREE.MeshStandardMaterial[];
  textures: THREE.Texture[];
  frames: Float32Array;
  count: number;
  dt: number;
  rate: number;
  phase: Phase;
  phaseStart: number;
  holdMs: number;
  watchdog: number;
  resolve: () => void;
  onSettle?: () => void;
}

const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);

/** 不滚的时候（prefers-reduced-motion）：在桌面中间摆好，目标面朝上，字正对镜头 */
function restingFrames(dice: PhysDie[]): Float32Array {
  const n = dice.length;
  const cols = Math.min(n, Math.ceil(Math.sqrt(n * 1.8)));
  const rows = Math.ceil(n / cols);
  const rMax = Math.max(...dice.map((d) => Math.max(...d.shape.vertices.map((v) => v.length()))));
  const gap = rMax * 2 + 0.5;
  const frames = new Float32Array(n * STRIDE);
  const q = new THREE.Quaternion();
  const yaw = new THREE.Quaternion();
  const v = new THREE.Vector3();
  dice.forEach((d, i) => {
    const s = d.shape;
    const k = d.labels.indexOf(d.target);
    if (s.vertexMode) {
      // d4：目标顶点对面的那个面贴地
      const face = s.faces.findIndex((f) => !f.includes(k));
      q.setFromUnitVectors(s.normals[face], DOWN);
      v.copy(s.vertices[s.faces[face][0]]).negate(); // 让一个底角朝向镜头，三面都看得到
    } else {
      q.setFromUnitVectors(s.normals[k], UP);
      v.copy(s.textUp[k]);
    }
    v.applyQuaternion(q);
    // 绕 y 转，让字头朝屏幕上方（-z）
    yaw.setFromAxisAngle(UP, Math.PI - Math.atan2(v.x, v.z));
    q.premultiply(yaw);
    const col = i % cols;
    const row = Math.floor(i / cols);
    const o = i * STRIDE;
    const inRow = row === rows - 1 ? n - row * cols : cols; // 最后一排单独居中
    frames[o] = (col - (inRow - 1) / 2) * gap;
    frames[o + 1] = s.restHeight;
    frames[o + 2] = (row - (rows - 1) / 2) * gap;
    frames[o + 3] = q.x;
    frames[o + 4] = q.y;
    frames[o + 5] = q.z;
    frames[o + 6] = q.w;
  });
  return frames;
}

class DiceStage {
  private root: HTMLDivElement;
  private labelEl: HTMLDivElement;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(20, 1, 1, 400);
  private hemi: THREE.HemisphereLight;
  private sun: THREE.DirectionalLight;
  private floor: THREE.Mesh;
  private shadowMat: THREE.ShadowMaterial;
  private current: Playback | null = null;
  private raf = 0;
  private anisotropy: number;
  private tmpQa = new THREE.Quaternion();
  private tmpQb = new THREE.Quaternion();
  private arena: Arena;

  constructor(
    container: HTMLElement,
    private o: ResolvedDiceOptions,
  ) {
    this.arena = arenaFor(1, o);
    this.root = document.createElement('div');
    Object.assign(this.root.style, {
      position: 'fixed',
      inset: '0',
      pointerEvents: 'none',
      zIndex: '2147483000',
      visibility: 'hidden',
    } satisfies Partial<CSSStyleDeclaration>);
    this.root.setAttribute('aria-hidden', 'true');

    this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    Object.assign(this.renderer.domElement.style, { width: '100%', height: '100%', display: 'block' });
    this.root.appendChild(this.renderer.domElement);

    this.labelEl = document.createElement('div');
    Object.assign(this.labelEl.style, {
      position: 'absolute',
      padding: '6px 12px',
      borderRadius: '999px',
      font: '600 14px/1.3 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
      maxWidth: 'calc(100% - 32px)',
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      display: 'none',
      backdropFilter: 'blur(6px)',
    } satisfies Partial<CSSStyleDeclaration>);
    this.root.appendChild(this.labelEl);
    container.appendChild(this.root);

    this.hemi = new THREE.HemisphereLight(0xffffff, 0x8890a0, 1);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xffffff, 1);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.radius = 4;
    this.scene.add(this.sun);

    this.shadowMat = new THREE.ShadowMaterial();
    this.floor = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.shadowMat);
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.receiveShadow = true;
    this.scene.add(this.floor);

    this.applyOptions();
    window.addEventListener('resize', this.resize);
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('pointerdown', this.onPointer, true);
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  get options(): ResolvedDiceOptions {
    return this.o;
  }

  /** 换参数。外观类的立刻生效（播放中也会变），物理类的从下一次掷骰开始生效 */
  setOptions(o: ResolvedDiceOptions) {
    this.o = o;
    this.applyOptions();
  }

  private applyOptions() {
    const { theme, lighting, look } = this.o;
    this.hemi.intensity = lighting.ambient;
    this.sun.intensity = lighting.sun;
    this.shadowMat.opacity = lighting.shadowOpacity ?? (theme === 'dark' ? 0.5 : 0.28);
    for (const m of this.current?.materials ?? []) m.roughness = look.roughness;

    const [v, h] = look.labelPosition.split('-');
    Object.assign(this.labelEl.style, {
      top: v === 'top' ? '16px' : '',
      bottom: v === 'bottom' ? '16px' : '',
      left: h === 'left' ? '16px' : '',
      right: h === 'right' ? '16px' : '',
      background: theme === 'dark' ? 'rgba(20,22,28,0.72)' : 'rgba(255,255,255,0.82)',
      color: theme === 'dark' ? '#f2f3f5' : '#1b1c20',
      boxShadow: theme === 'dark' ? '0 2px 10px rgba(0,0,0,0.4)' : '0 2px 10px rgba(0,0,0,0.12)',
    });
    this.resize();
  }

  private resize = () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.o.look.maxPixelRatio));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.fitCamera();
    if (this.current) this.renderer.render(this.scene, this.camera);
  };

  /** 桌面变了（骰子数、桌面参数）就要重新摆镜头、灯和影子范围 */
  private setArena(arena: Arena) {
    if (arena.w === this.arena.w && arena.d === this.arena.d) return;
    this.arena = arena;
    this.fitCamera();
  }

  private fitCamera() {
    const { w: aw, d: ad } = this.arena;
    const { fov, tilt, fill } = this.o.camera;

    // 影子：光源和影子相机跟着桌面大小走，桌子再大影子也不会被截断
    const k = Math.max(aw / 17, ad / 10.6);
    this.sun.position.set(-6 * k, 20 * k, 9 * k);
    Object.assign(this.sun.shadow.camera, {
      left: -aw / 2 - 2,
      right: aw / 2 + 2,
      top: ad / 2 + 2,
      bottom: -ad / 2 - 2,
      near: 1,
      far: 40 * k + 20,
    });
    this.sun.shadow.camera.updateProjectionMatrix();
    this.floor.scale.set(aw * 3, ad * 3, 1);

    // 镜头从斜上方看桌面，二分出一个刚好把整个桌面装进画面的距离
    this.camera.fov = fov;
    const t = THREE.MathUtils.degToRad(tilt);
    const dir = new THREE.Vector3(0, Math.cos(t), Math.sin(t));
    const pts: THREE.Vector3[] = [];
    for (const x of [-1, 1]) for (const z of [-1, 1]) for (const y of [0, 1.2]) pts.push(new THREE.Vector3((x * aw) / 2, y, (z * ad) / 2));
    const p = new THREE.Vector3();
    const place = (dist: number) => {
      this.camera.position.copy(dir).multiplyScalar(dist);
      this.camera.lookAt(0, 0, 0);
      // 近远裁剪面跟着距离走：视场角很小时镜头会退得很远
      this.camera.near = Math.max(0.1, dist * 0.05);
      this.camera.far = dist * 2 + Math.hypot(aw, ad) * 2;
      this.camera.updateProjectionMatrix();
      this.camera.updateMatrixWorld();
    };
    const fits = (dist: number) => {
      place(dist);
      return pts.every((q) => {
        p.copy(q).project(this.camera);
        return p.z < 1 && Math.abs(p.x) <= fill && Math.abs(p.y) <= fill;
      });
    };
    let lo = 0.5;
    let hi = 10000;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) hi = mid;
      else lo = mid;
    }
    place(hi);
  }

  private onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && this.current) this.skip();
  };

  // 点在带 data-dice-noskip 的元素里（比如聊天输入框、设置面板）不算跳过
  private onPointer = (e: PointerEvent) => {
    if (!this.current) return;
    const el = e.target instanceof Element ? e.target : null;
    if (el?.closest('[data-dice-noskip]')) return;
    this.skip();
  };

  // 后台标签页里 requestAnimationFrame 不跑：切走时直接结束，免得回来后一口气补播一堆
  private onVisibility = () => {
    if (document.hidden) this.finish();
  };

  play(req: RollRequest): Promise<void> {
    const o = this.o;
    const dice = expand(req.dice ?? [], o);
    if (!dice.length || document.hidden) return Promise.resolve();
    const n = dice.length;
    const arena = arenaFor(n, o);
    this.setArena(arena);

    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    let frames: Float32Array;
    let count = 1;
    let dt = 1 / 60;
    if (reduced) {
      frames = restingFrames(dice);
    } else {
      const seed = req.seed ?? Math.floor(Math.random() * 2 ** 32);
      const sim = simulate(
        dice.map((d) => d.shape),
        mulberry32(seed),
        { arena, layFlat: o.physics.layFlat },
      );
      ({ frames, count, dt } = sim);
    }

    // 关键一步：看物理结果里哪一面朝上，把那一面和目标点数对调
    const q = new THREE.Quaternion();
    const tops: number[] = [];
    dice.forEach((d, i) => {
      const off = ((count - 1) * n + i) * STRIDE;
      q.set(frames[off + 3], frames[off + 4], frames[off + 5], frames[off + 6]);
      const landed = topIndex(d.shape, q);
      const want = d.labels.indexOf(d.target);
      [d.labels[landed], d.labels[want]] = [d.labels[want], d.labels[landed]];
      tops.push(landed);
    });

    const group = new THREE.Group();
    const materials: THREE.MeshStandardMaterial[] = [];
    const textures: THREE.Texture[] = [];
    dice.forEach((d, i) => {
      const tex = new THREE.CanvasTexture(drawAtlas(d.shape, d.labels, d.color, tops[i]));
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = this.anisotropy;
      const mat = new THREE.MeshStandardMaterial({
        map: tex,
        roughness: o.look.roughness,
        metalness: 0.0,
        transparent: d.dropped,
      });
      const mesh = new THREE.Mesh(d.shape.geometry, mat);
      mesh.castShadow = true;
      group.add(mesh);
      materials.push(mat);
      textures.push(tex);
    });
    this.scene.add(group);

    const t = o.timing;
    const duration = (count - 1) * dt * 1000;
    const now = performance.now();
    return new Promise<void>((resolve) => {
      const pb: Playback = {
        dice,
        group,
        materials,
        textures,
        frames,
        count,
        dt,
        rate: Math.max(1, duration / t.maxRollMs),
        phase: 'roll',
        phaseStart: now,
        holdMs: t.holdMs,
        watchdog: window.setTimeout(
          () => {
            if (this.current === pb) this.finish();
          },
          t.maxRollMs + Math.max(t.holdMs, t.skipHoldMs, t.dimMs) + t.fadeMs + WATCHDOG_EXTRA_MS,
        ),
        resolve,
        onSettle: req.onSettle,
      };
      this.current = pb;
      this.applyFrame(pb, 0);
      if (reduced) this.enterHold(pb, now, t.holdMs);

      if (req.label) {
        this.labelEl.textContent = req.label;
        this.labelEl.style.display = 'block';
      } else {
        this.labelEl.style.display = 'none';
      }
      this.root.style.opacity = '1';
      this.root.style.visibility = 'visible';
      this.start();
    });
  }

  skip() {
    const pb = this.current;
    if (!pb) return;
    const now = performance.now();
    if (pb.phase === 'roll') {
      this.applyFrame(pb, pb.count - 1);
      this.enterHold(pb, now, this.o.timing.skipHoldMs);
    } else if (pb.phase === 'hold') {
      this.dim(pb, 1);
      pb.phase = 'fade';
      pb.phaseStart = now;
    }
    this.start();
  }

  private start() {
    if (!this.raf) this.raf = requestAnimationFrame(this.tick);
  }

  private tick = (now: number) => {
    this.raf = 0;
    const pb = this.current;
    if (!pb) return;
    this.update(pb, now);
    if (this.current) {
      this.renderer.render(this.scene, this.camera);
      this.raf = requestAnimationFrame(this.tick);
    }
  };

  private update(pb: Playback, now: number) {
    const el = now - pb.phaseStart;
    const t = this.o.timing;
    if (pb.phase === 'roll') {
      const f = ((el / 1000) * pb.rate) / pb.dt;
      if (f >= pb.count - 1) {
        this.applyFrame(pb, pb.count - 1);
        this.enterHold(pb, now, t.holdMs);
      } else {
        this.applyFrame(pb, f);
      }
    } else if (pb.phase === 'hold') {
      this.dim(pb, t.dimMs > 0 ? Math.min(1, el / t.dimMs) : 1);
      if (el >= pb.holdMs) {
        pb.phase = 'fade';
        pb.phaseStart = now;
      }
    } else {
      const k = t.fadeMs > 0 ? Math.min(1, el / t.fadeMs) : 1;
      this.root.style.opacity = String(1 - k * k);
      if (k >= 1) this.finish();
    }
  }

  private enterHold(pb: Playback, now: number, holdMs: number) {
    const f = pb.onSettle;
    pb.onSettle = undefined;
    f?.();
    pb.phase = 'hold';
    pb.phaseStart = now;
    pb.holdMs = holdMs;
  }

  private dim(pb: Playback, k: number) {
    const { droppedBrightness, droppedOpacity } = this.o.look;
    pb.dice.forEach((d, i) => {
      if (!d.dropped) return;
      const m = pb.materials[i];
      m.color.setScalar(1 - (1 - droppedBrightness) * k);
      m.opacity = 1 - (1 - droppedOpacity) * k;
    });
  }

  private applyFrame(pb: Playback, f: number) {
    const n = pb.dice.length;
    const i0 = Math.floor(f);
    const i1 = Math.min(i0 + 1, pb.count - 1);
    const a = f - i0;
    const fr = pb.frames;
    pb.group.children.forEach((mesh, i) => {
      const o0 = (i0 * n + i) * STRIDE;
      const o1 = (i1 * n + i) * STRIDE;
      mesh.position.set(
        fr[o0] + (fr[o1] - fr[o0]) * a,
        fr[o0 + 1] + (fr[o1 + 1] - fr[o0 + 1]) * a,
        fr[o0 + 2] + (fr[o1 + 2] - fr[o0 + 2]) * a,
      );
      this.tmpQa.set(fr[o0 + 3], fr[o0 + 4], fr[o0 + 5], fr[o0 + 6]);
      this.tmpQb.set(fr[o1 + 3], fr[o1 + 4], fr[o1 + 5], fr[o1 + 6]);
      mesh.quaternion.slerpQuaternions(this.tmpQa, this.tmpQb, a);
    });
  }

  private finish() {
    const pb = this.current;
    if (!pb) return;
    this.current = null;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    clearTimeout(pb.watchdog);
    this.scene.remove(pb.group);
    pb.materials.forEach((m) => m.dispose());
    pb.textures.forEach((t) => t.dispose());
    this.root.style.visibility = 'hidden';
    this.root.style.opacity = '1';
    this.labelEl.style.display = 'none';
    // 清掉最后一帧，下次显示时不会闪出旧画面
    this.renderer.clear();
    pb.resolve();
  }

  destroy() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.finish();
    window.removeEventListener('resize', this.resize);
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('pointerdown', this.onPointer, true);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.shadowMat.dispose();
    this.floor.geometry.dispose();
    this.renderer.dispose();
    this.root.remove();
  }
}

let stage: DiceStage | null = null;
let queue: Promise<void> = Promise.resolve();

/**
 * 挂到页面上（全屏透明覆盖层，不挡鼠标）。返回卸载函数。
 * opts 见 DiceOptions；没给的用 DEFAULT_DICE_OPTIONS，theme 没给就跟随系统。
 */
export function mountDice(container: HTMLElement, opts?: DiceOptions): () => void {
  const theme =
    opts?.theme ?? (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const resolved = resolveOptions(DEFAULT_DICE_OPTIONS, { ...opts, theme });
  if (stage) {
    stage.destroy();
    stage = null;
  }
  let mine: DiceStage | null;
  try {
    mine = new DiceStage(container, resolved);
  } catch (err) {
    console.error('[dice3d] WebGL 初始化失败，掷骰动画不可用', err);
    return () => {};
  }
  stage = mine;
  return () => {
    if (stage === mine) {
      stage.destroy();
      stage = null;
    }
  };
}

/**
 * 运行中改参数（只改给出的那些，其余保持）。
 * 镜头、灯光、主题、label 位置立刻生效；骰子材质、时长、物理参数从下一次掷骰开始生效。
 */
export function configureDice(patch: DiceOptions): void {
  if (!stage) {
    console.warn('[dice3d] 还没有 mountDice()，configureDice 被忽略');
    return;
  }
  stage.setOptions(resolveOptions(stage.options, patch));
}

/** 当前生效的完整参数（拷贝）。没挂载时返回默认值 */
export function getDiceOptions(): ResolvedDiceOptions {
  return cloneOptions(stage ? stage.options : DEFAULT_DICE_OPTIONS);
}

/** 播一次。动画播完（停稳、停留、淡出）后 resolve。连续调用会排队播 */
export function rollDice(req: RollRequest): Promise<void> {
  if (!stage) console.warn('[dice3d] 还没有 mountDice()，这次掷骰不会显示');
  const p = queue.then(() => (stage ? stage.play(req) : undefined));
  queue = p.catch((err) => console.error('[dice3d]', err));
  return p;
}

/** 立刻结束当前动画（直接显示最终结果，再淡出） */
export function skipDice(): void {
  stage?.skip();
}
