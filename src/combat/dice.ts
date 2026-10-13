/**
 * 骰子来源（COMBAT-DESIGN §6.1）。引擎只要骰面，不关心骰面从哪来。
 *
 * 返回 null 表示「这个来源要等外界输入」（实体骰 / 3D 物理骰）——
 * 事务会因此停下来产生一个 `physicalDice` 决定，回答就是骰面。
 */
export interface DiceRequest {
  faces: number;
  count: number;
}

export interface DiceSource {
  readonly id: string;
  roll(reqs: DiceRequest[], purpose: string): number[][] | null;
}

/** mulberry32：小、快、可复现。测试和「同一个种子重放」用 */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function engineDice(rng: () => number = Math.random): DiceSource {
  return {
    id: 'engine',
    roll: (reqs) => reqs.map((r) => Array.from({ length: r.count }, () => 1 + Math.floor(rng() * r.faces))),
  };
}

/** 实体骰：永远等输入 */
export const physicalDice: DiceSource = { id: 'physical', roll: () => null };

/**
 * 测试用：按顺序吐出预先写好的骰面。面数不对、用完了都直接报错 ——
 * 黄金场景里「多掷了一颗骰子」本身就是 bug，不能悄悄补一个随机数。
 */
export function scriptedDice(faces: number[] = []): DiceSource & { left(): number; push(...f: number[]): void } {
  const q = faces.slice();
  return {
    id: 'scripted',
    left: () => q.length,
    push: (...f) => { q.push(...f); },
    roll: (reqs, purpose) => reqs.map((r) => Array.from({ length: r.count }, () => {
      if (!q.length) throw new Error(`预设骰面用完了（正在掷：${purpose} ${r.count}d${r.faces}）`);
      const v = q.shift()!;
      if (v < 1 || v > r.faces) throw new Error(`预设骰面 ${v} 不是 d${r.faces} 的合法结果（${purpose}）`);
      return v;
    })),
  };
}

export const diceSig = (reqs: DiceRequest[]) => reqs.map((r) => `${r.count}d${r.faces}`).join('+');
