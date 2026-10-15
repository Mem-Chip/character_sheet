export type DieKind = 4 | 6 | 8 | 10 | 12 | 20;
export type LabelPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

/**
 * 所有可调参数。都是可选的，没给的用默认值（见 DEFAULT_DICE_OPTIONS），超出范围的会截到范围内。
 * 注意：physics 里的参数会改变滚法，多人同步时各端必须一致，否则同一个种子各端看到的过程不同
 * （最终点数仍然一定正确）。其余参数只影响外观，各端可以不一样。
 */
export interface DiceOptions {
  /** 主题。不给就跟随系统 prefers-color-scheme */
  theme?: 'light' | 'dark';
  camera?: {
    /** 视场角（度），越小透视越弱、越接近正交俯视。1–90，默认 20 */
    fov?: number;
    /** 镜头偏离正上方的角度（度）。0 = 正俯视。0–80，默认 16 */
    tilt?: number;
    /** 桌面占屏幕的比例（取宽高里更紧的那个方向）。0.2–1，默认 0.95 */
    fill?: number;
  };
  lighting?: {
    /** 环境光（半球光）强度。0–10，默认 1.6 */
    ambient?: number;
    /** 主光（平行光，投影子）强度。0–10，默认 2.2 */
    sun?: number;
    /** 影子浓度。0–1，不给就按主题：浅色 0.28、深色 0.5 */
    shadowOpacity?: number;
  };
  look?: {
    /** DieSpec 没给 color 时用的颜色（hex）。默认 #4f5bd5 */
    defaultColor?: string;
    /** 表面粗糙度，越小越亮（高光越强）。0–1，默认 0.42 */
    roughness?: number;
    /** dropped 骰子变暗后的亮度（1 = 不变暗）。0–1，默认 0.4 */
    droppedBrightness?: number;
    /** dropped 骰子变暗后的不透明度（1 = 不透明）。0–1，默认 0.6 */
    droppedOpacity?: number;
    /** label 显示在哪个角。默认 top-left */
    labelPosition?: LabelPosition;
    /** 渲染分辨率上限（相对 CSS 像素）。0.5–4，默认 2 */
    maxPixelRatio?: number;
  };
  timing?: {
    /** 滚动最长播多久（毫秒），物理过程更长就加速播放。200–10000，默认 2300 */
    maxRollMs?: number;
    /** 停稳后停留多久再淡出。0–20000，默认 1000 */
    holdMs?: number;
    /** 跳过后停留多久再淡出。0–20000，默认 650 */
    skipHoldMs?: number;
    /** dropped 骰子变暗用时。0–5000，默认 300 */
    dimMs?: number;
    /** 淡出用时。0–5000，默认 400 */
    fadeMs?: number;
  };
  /** 会改变滚法：多人同步时各端必须一致 */
  physics?: {
    /** 桌面宽（世界单位，骰子直径约 1.7）。4–200，默认 17 */
    tableWidth?: number;
    /** 桌面纵深。4–200，默认 10.6 */
    tableDepth?: number;
    /** 骰子多于 9 颗时按 √(n/9) 放大桌面（镜头跟着拉远）。默认 true */
    tableGrow?: boolean;
    /** 骰子大小倍数。一个数 = 全部，或按面数分别给。0.2–5，默认 1 */
    dieScale?: number | Partial<Record<DieKind, number>>;
    /** 停下后把斜靠/叠起来的骰子放平。默认 true */
    layFlat?: boolean;
    /** 一次最多播几颗实体骰子（d100 算 2 颗），多的忽略。1–100，默认 20 */
    maxDice?: number;
  };
}

/** 填满默认值后的完整参数 */
export interface ResolvedDiceOptions {
  theme: 'light' | 'dark';
  camera: { fov: number; tilt: number; fill: number };
  lighting: { ambient: number; sun: number; shadowOpacity: number | null };
  look: {
    defaultColor: string;
    roughness: number;
    droppedBrightness: number;
    droppedOpacity: number;
    labelPosition: LabelPosition;
    maxPixelRatio: number;
  };
  timing: { maxRollMs: number; holdMs: number; skipHoldMs: number; dimMs: number; fadeMs: number };
  physics: {
    tableWidth: number;
    tableDepth: number;
    tableGrow: boolean;
    dieScale: Record<DieKind, number>;
    layFlat: boolean;
    maxDice: number;
  };
}

const KINDS: DieKind[] = [4, 6, 8, 10, 12, 20];

export const DEFAULT_DICE_OPTIONS: Readonly<ResolvedDiceOptions> = {
  theme: 'light',
  camera: { fov: 20, tilt: 16, fill: 0.95 },
  lighting: { ambient: 1.6, sun: 2.2, shadowOpacity: null },
  look: {
    defaultColor: '#4f5bd5',
    roughness: 0.42,
    droppedBrightness: 0.4,
    droppedOpacity: 0.6,
    labelPosition: 'top-left',
    maxPixelRatio: 2,
  },
  timing: { maxRollMs: 2300, holdMs: 1000, skipHoldMs: 650, dimMs: 300, fadeMs: 400 },
  physics: {
    tableWidth: 17,
    tableDepth: 10.6,
    tableGrow: true,
    dieScale: { 4: 1, 6: 1, 8: 1, 10: 1, 12: 1, 20: 1 },
    layFlat: true,
    maxDice: 20,
  },
};

function num(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return Math.min(max, Math.max(min, n));
}

/** 在 base 上叠加 patch，并把每个值截到合法范围 */
export function resolveOptions(base: ResolvedDiceOptions, patch: DiceOptions = {}): ResolvedDiceOptions {
  const c = patch.camera ?? {};
  const l = patch.lighting ?? {};
  const k = patch.look ?? {};
  const t = patch.timing ?? {};
  const p = patch.physics ?? {};

  const scale = { ...base.physics.dieScale };
  if (typeof p.dieScale === 'number') for (const kind of KINDS) scale[kind] = p.dieScale;
  else if (p.dieScale) for (const kind of KINDS) if (p.dieScale[kind] !== undefined) scale[kind] = p.dieScale[kind]!;
  for (const kind of KINDS) scale[kind] = num(scale[kind], 1, 0.2, 5);

  const positions: LabelPosition[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
  const shadow = 'shadowOpacity' in l ? l.shadowOpacity : base.lighting.shadowOpacity;

  return {
    theme: patch.theme === 'dark' || patch.theme === 'light' ? patch.theme : base.theme,
    camera: {
      fov: num(c.fov, base.camera.fov, 1, 90),
      tilt: num(c.tilt, base.camera.tilt, 0, 80),
      fill: num(c.fill, base.camera.fill, 0.2, 1),
    },
    lighting: {
      ambient: num(l.ambient, base.lighting.ambient, 0, 10),
      sun: num(l.sun, base.lighting.sun, 0, 10),
      shadowOpacity: shadow == null ? null : num(shadow, 0.3, 0, 1),
    },
    look: {
      defaultColor: typeof k.defaultColor === 'string' ? k.defaultColor : base.look.defaultColor,
      roughness: num(k.roughness, base.look.roughness, 0, 1),
      droppedBrightness: num(k.droppedBrightness, base.look.droppedBrightness, 0, 1),
      droppedOpacity: num(k.droppedOpacity, base.look.droppedOpacity, 0, 1),
      labelPosition: positions.includes(k.labelPosition!) ? k.labelPosition! : base.look.labelPosition,
      maxPixelRatio: num(k.maxPixelRatio, base.look.maxPixelRatio, 0.5, 4),
    },
    timing: {
      maxRollMs: num(t.maxRollMs, base.timing.maxRollMs, 200, 10000),
      holdMs: num(t.holdMs, base.timing.holdMs, 0, 20000),
      skipHoldMs: num(t.skipHoldMs, base.timing.skipHoldMs, 0, 20000),
      dimMs: num(t.dimMs, base.timing.dimMs, 0, 5000),
      fadeMs: num(t.fadeMs, base.timing.fadeMs, 0, 5000),
    },
    physics: {
      tableWidth: num(p.tableWidth, base.physics.tableWidth, 4, 200),
      tableDepth: num(p.tableDepth, base.physics.tableDepth, 4, 200),
      tableGrow: typeof p.tableGrow === 'boolean' ? p.tableGrow : base.physics.tableGrow,
      dieScale: scale,
      layFlat: typeof p.layFlat === 'boolean' ? p.layFlat : base.physics.layFlat,
      maxDice: Math.round(num(p.maxDice, base.physics.maxDice, 1, 100)),
    },
  };
}

/** 深拷贝一份，交给调用方不会改到内部状态 */
export function cloneOptions(o: ResolvedDiceOptions): ResolvedDiceOptions {
  return JSON.parse(JSON.stringify(o));
}
