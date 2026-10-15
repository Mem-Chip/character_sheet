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

/** 掷的是什么：d20（攻击、豁免、检定）/ 伤害 / 其他（治疗、减伤……） */
export type RollKind = 'd20' | 'damage' | 'other';

export interface DiceSource {
  readonly id: string;
  roll(reqs: DiceRequest[], purpose: string, kind?: RollKind): number[][] | null;
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
 * 骰子设置（按人）：
 * - engine：全自动（引擎直接掷）
 * - confirm：每颗都停下来等人点「掷！」（也可以填实体骰）
 * - confirmNoDamage：伤害骰自动，其余停下来确认
 * - physical：实体骰，等人填骰面
 * 「停下来确认」和实体骰走同一个决定（physicalDice）；回答 'roll' 就由引擎来掷。
 */
export type DiceMode = 'engine' | 'confirm' | 'confirmNoDamage' | 'physical';
export const DICE_MODES: DiceMode[] = ['confirmNoDamage', 'confirm', 'engine', 'physical'];
export function diceSourceFor(mode: DiceMode): DiceSource {
  if (mode === 'physical') return physicalDice;
  if (mode === 'confirm') return { id: 'confirm', roll: () => null };
  if (mode === 'confirmNoDamage') {
    const auto = engineDice();
    return { id: 'confirm', roll: (reqs, purpose, kind) => (kind === 'damage' ? auto.roll(reqs, purpose) : null) };
  }
  return engineDice();
}
/** 没设置时的默认：DM（怪物）全自动；玩家伤害骰自动、其余确认 */
export function defaultDiceMode(user: string): DiceMode {
  return user === 'dm' ? 'engine' : 'confirmNoDamage';
}

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
