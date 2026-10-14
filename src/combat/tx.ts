import { diceSig, type DiceRequest, type DiceSource } from './dice';
import { applyEvent } from './reducer';
import type { RuleBook } from './rulebook';
import type { Command, Decision, DecisionKind, EncounterState, GameEvent, OverridePatch, UserId } from './types';

/**
 * 一笔事务 = 一条命令的完整结算。
 *
 * ⭐ 暂停与恢复靠**重跑**，不靠保存解释器的栈（这是对设计稿 §9.1 的修订）：
 *   结算中途需要人做决定时抛出 NeedDecision，事务作废；拿到回答后，
 *   从同一个起点、带着**已经掷出的骰面（磁带）**和**已经得到的回答**把整条命令再跑一遍。
 *   因为结算是确定的（同样的状态 + 同样的骰面 + 同样的回答 → 同样的结果），
 *   它会走到同一个决定点，拿到回答，继续往下。
 *
 * 这样做的好处：
 *   - 要存的只有「命令 + 磁带 + 回答」，天然可序列化（刷新页面、断线重连都不丢）；
 *   - 实体骰输入 = 一种决定（回答就是骰面），不需要特殊流程；
 *   - DM 事后改结果（§15.3）= 带着修改把这笔事务重跑一遍，和这里是同一套机制；
 *   - 撤销 = 丢掉若干笔事务，从起点重跑剩下的。
 */

export class NeedDecision {
  constructor(
    readonly decision: Decision,
    /** 停下来之前已经发生的事（给界面预览：玩家要看到攻击总值才决定用不用护盾术） */
    readonly preview: GameEvent[],
  ) {}
}

export class Rejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Rejected';
  }
}

export interface AnswerRecord {
  kind: DecisionKind;
  value: unknown;
}

export interface TapeEntry {
  sig: string;
  faces: number[][];
  source: string;
}

export interface TxInput {
  cmd: Command;
  by: UserId;
  tape: TapeEntry[];
  answers: Record<string, AnswerRecord>;
  overrides: OverridePatch[];
  /** 发起这笔操作时地图上的棋子（格子坐标 + 占几格）。重放时用它，不用现在的位置 */
  positions?: Positions;
  /** 斜走规则（发起时的设置；没有 = 每格 5 尺） */
  diagonal?: Diagonal;
}

export type Positions = Record<string, { x: number; y: number; s: number }>;
/** 斜着走一格算多远：'5' = 2024 规则，每格 5 尺；'5-10-5' = 交替 5 尺、10 尺（DMG 可选规则） */
export type Diagonal = '5' | '5-10-5';

/** 空间查询（地图实现它；没有地图时为 null，相关问题走询问或推测） */
export interface Spatial {
  distance(a: string, b: string): number | null;
  alliesWithin(of: string, ft: number, allyOf: string, exclude: string[]): string[] | null;
  canSee(a: string, b: string): boolean | null;
}

export interface EngineCtx {
  rules: RuleBook;
  /** 某个用户用哪个骰子来源（按人设置，§6.1） */
  diceFor(user: UserId): DiceSource;
  spatial?: Spatial | null;
  /** 地图上现在的棋子位置（有地图时）；发起新操作时拍一张快照存进 TxInput */
  positions?: () => Positions | null;
  diagonal?: () => Diagonal;
}

type PostEmit = (tx: Tx, ev: GameEvent) => void;
let postEmit: PostEmit | null = null;
/** 事件发出后的钩子（效应的 endsOn 在这里检查）。由引擎入口注册 */
export function setPostEmit(fn: PostEmit): void { postEmit = fn; }

export interface QAnswer {
  value: boolean;
  scope: string;
}

export class Tx {
  readonly events: GameEvent[] = [];
  readonly tapeOut: TapeEntry[] = [];
  /** 这笔事务里问到并得到回答的问题 */
  readonly qAnswers = new Map<string, QAnswer>();
  private tapeIdx = 0;
  private decIdx = 0;
  private diverged = false;
  private depth = 0;
  /** 第几次 D20 检定 / 第几次伤害结算 —— 一次性裁定按它定位 */
  rollIdx = 0;
  damageIdx = 0;

  constructor(
    readonly state: EncounterState,
    readonly input: TxInput,
    readonly ctx: EngineCtx,
  ) {}

  get rules(): RuleBook { return this.ctx.rules; }

  private sp: Spatial | null | undefined;
  /** 空间查询：这笔操作记了棋子位置就按位置算，否则用 ctx 给的（没有就是 null → 问人） */
  get spatial(): Spatial | null {
    if (this.sp === undefined) this.sp = this.input.positions ? gridSpatial(this.input.positions, this.state, this.input.diagonal) : this.ctx.spatial ?? null;
    return this.sp;
  }

  emit(type: string, payload: Record<string, unknown>, cause: number | null = null): number {
    const ev: GameEvent = { seq: this.state.seq + 1, type, payload, cause };
    applyEvent(this.state, ev);
    this.events.push(ev);
    if (postEmit && this.depth < 8) {
      this.depth++;
      try { postEmit(this, ev); } finally { this.depth--; }
    }
    return ev.seq;
  }

  /**
   * 掷骰。先看磁带：同一位置、同一规格就复用。
   * 一旦有一格对不上（事后改结果导致结算路径变了），从这里往后全部重新掷 ——
   * 宁可重掷，也不能把一颗 d6 的结果塞给 d20。
   */
  roll(reqs: DiceRequest[], user: UserId, purpose: string): number[][] {
    const sig = diceSig(reqs);
    const idx = this.tapeIdx++;
    const rec = this.input.tape[idx];
    if (!this.diverged && rec && rec.sig === sig) {
      this.tapeOut[idx] = rec;
      return rec.faces;
    }
    if (rec) this.diverged = true;
    const src = this.ctx.diceFor(user);
    const faces = src.roll(reqs, purpose);
    if (faces === null) {
      throw new NeedDecision({
        id: `dice:${idx}`,
        kind: 'physicalDice',
        to: user,
        prompt: `请输入骰子结果：${purpose}（${sig}）`,
        options: [],
        dice: reqs,
        default: null,
      }, this.events.slice());
    }
    this.tapeOut[idx] = { sig, faces, source: src.id };
    return faces;
  }

  /** 需要人做决定。已经有回答（重跑时）就直接返回；没有就暂停整笔事务 */
  decide(d: Omit<Decision, 'id'>): unknown {
    const id = `d${this.decIdx++}`;
    const rec = this.input.answers[id];
    if (rec && rec.kind === d.kind) return rec.value;
    throw new NeedDecision({ ...d, id }, this.events.slice());
  }

  nextId(prefix = 'e'): string {
    return `${prefix}${this.state.nextId++}`;
  }

  turnKey(): string {
    return `${this.state.round ?? 0}:${this.state.turnIndex}`;
  }

  /** 问题的答案：本事务里刚回答的 > 遭遇里记住的（按 scope 判断是否过期） */
  answerOf(qid: string): boolean | undefined {
    const a = this.qAnswers.get(qid);
    if (a) return a.value;
    const r = this.state.answers[qid];
    if (!r) return undefined;
    if (r.scope === 'sticky') return r.value;
    if (r.scope === 'round') return r.at.split(':')[0] === String(this.state.round ?? 0) ? r.value : undefined;
    return r.at === this.turnKey() ? r.value : undefined;
  }

  overrideRoll(index: number): Extract<OverridePatch, { roll: number }> | undefined {
    return this.input.overrides.find((o): o is Extract<OverridePatch, { roll: number }> => 'roll' in o && o.roll === index);
  }

  overrideDamage(index: number): Extract<OverridePatch, { damage: number }> | undefined {
    return this.input.overrides.find((o): o is Extract<OverridePatch, { damage: number }> => 'damage' in o && o.damage === index);
  }
}

/** 横着 dx 格、竖着 dy 格走过去要多少尺 */
export function gridFeet(dx: number, dy: number, diagonal: Diagonal = '5'): number {
  const a = Math.abs(dx), b = Math.abs(dy);
  const diag = Math.min(a, b);
  const straight = Math.max(a, b) - diag;
  // 5-10-5：每走两格斜的多算 5 尺
  return (straight + diag + (diagonal === '5-10-5' ? Math.floor(diag / 2) : 0)) * 5;
}

/**
 * 按格子算的空间查询。距离 = 两者占的格子之间最近的那两格之间走过去的距离（gridFeet）。
 * 不在地图上的 → null（问人）。
 */
export function gridSpatial(pos: Positions, state: EncounterState, diagonal: Diagonal = '5'): Spatial {
  const gap = (a: string, b: string): number | null => {
    const p = pos[a], q = pos[b];
    if (!p || !q) return null;
    const dx = Math.max(0, p.x - (q.x + q.s - 1), q.x - (p.x + p.s - 1));
    const dy = Math.max(0, p.y - (q.y + q.s - 1), q.y - (p.y + p.s - 1));
    return gridFeet(dx, dy, diagonal);
  };
  return {
    distance: gap,
    alliesWithin(of, ft, allyOf, exclude) {
      if (!pos[of]) return null;
      const side = state.combatants[allyOf]?.side;
      const allies = Object.values(state.combatants).filter((c) => c.side === side && c.id !== allyOf && c.id !== of && !exclude.includes(c.id) && !c.live.dead);
      const near = allies.filter((c) => { const d = gap(of, c.id); return d !== null && d <= ft; }).map((c) => c.id);
      // 有盟友不在地图上、而在图上的又都不够近：说不准，还是问人
      if (!near.length && allies.some((c) => !pos[c.id])) return null;
      return near;
    },
    canSee: () => null,
  };
}

/** 体型 → 占几格（微型、小型、中型都是 1 格） */
export function footprint(size: string | undefined): number {
  return size === '大型' ? 2 : size === '巨型' ? 3 : size === '超巨型' ? 4 : 1;
}
