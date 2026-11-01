import { ABIL_CN, parseDice } from '../expr';
import { applyDamagePacket, applyHeal, grantTempHp, normType, rollComponent, type DamageComponent } from './damage';
import { d20Test } from './d20';
import { applyEffect, checkEndsOn, concentrationOf, effectiveView, endConcentration, endEffect, skillBonus } from './effects';
import { Dice } from '../expr';
import { engineDice } from './dice';
import { executeAction, findAction } from './exec';
import { placeSummon, placeZone, relocateZone, removeZone, travel } from './space';
import { advanceTime, nextTurn, rest, startCombat } from './turns';
import { NeedDecision, Rejected, Tx, setPostEmit, type EngineCtx, type TapeEntry, type TxInput } from './tx';
import type { Action, CombatantView, Command, Decision, EncounterState, GameEvent, OverridePatch, Settings, UserId, Zone } from './types';

setPostEmit(checkEndsOn);

/**
 * 会话：一场遭遇的完整记录与操作入口。
 *
 * 真正的记录是**事务列表**（命令 + 骰面磁带 + 回答 + 裁定），事件是它们的输出。
 * 撤销 = 丢掉末尾的事务，从起点重跑；DM 事后改结果 = 给某笔事务加一条裁定，从那里往后重跑。
 */

export const DEFAULT_SETTINGS: Settings = {
  automation: 'assist',
  dice: { '*': 'engine' },
  monsterAt0: 'dead',
  reactionTiming: 'afterResult',
  useGuesses: true,
};

export function createEncounter(id = 'enc', settings: Partial<Settings> = {}): EncounterState {
  return {
    id,
    round: null,
    turnIndex: 0,
    order: [],
    combatants: {},
    effects: {},
    answers: {},
    settings: { ...DEFAULT_SETTINGS, ...settings },
    seq: 0,
    nextId: 1,
  };
}

export type TxResult =
  | { kind: 'done'; state: EncounterState; events: GameEvent[]; tape: TapeEntry[] }
  | { kind: 'pending'; decision: Decision; preview: GameEvent[]; tape: TapeEntry[] }
  | { kind: 'rejected'; reason: string };

/** 纯函数：从 state 出发跑一笔事务。不改传入的 state */
export function runTx(state: EncounterState, input: TxInput, ctx: EngineCtx): TxResult {
  const draft = structuredClone(state);
  const tx = new Tx(draft, input, ctx);
  try {
    handle(tx, input.cmd);
    const remember: Record<string, { value: boolean; scope: 'turn' | 'round' | 'sticky'; at: string }> = {};
    for (const [id, a] of tx.qAnswers) {
      if (a.scope === 'turn' || a.scope === 'round' || a.scope === 'sticky') remember[id] = { value: a.value, scope: a.scope, at: tx.turnKey() };
    }
    if (Object.keys(remember).length) tx.emit('answersRemembered', { answers: remember });
    return { kind: 'done', state: draft, events: tx.events, tape: tx.tapeOut.slice() };
  } catch (e) {
    if (e instanceof NeedDecision) return { kind: 'pending', decision: e.decision, preview: e.preview, tape: tx.tapeOut.slice() };
    if (e instanceof Rejected) return { kind: 'rejected', reason: e.message };
    return { kind: 'rejected', reason: `规则执行出错：${(e as Error).message}` };
  }
}

function handle(tx: Tx, cmd: Command): void {
  switch (cmd.type) {
    case 'addCombatant': {
      if (tx.state.combatants[cmd.combatant.id]) throw new Rejected(`已经有 id 为 ${cmd.combatant.id} 的参与者`);
      const seq = tx.emit('combatantAdded', { combatant: cmd.combatant });
      if (cmd.combatant.summoner) placeSummon(tx, cmd.combatant.summoner, cmd.combatant.id, cmd.combatant.base.size, seq);
      return;
    }
    case 'removeCombatant':
      tx.emit('combatantRemoved', { id: cmd.id });
      return;
    case 'refreshCombatant': {
      const c = tx.state.combatants[cmd.id];
      if (!c) throw new Rejected(`没有参与者 ${cmd.id}`);
      tx.emit('baseRefreshed', { id: cmd.id, base: cmd.view, hpMaxBefore: c.base.hpMax });
      return;
    }
    case 'startCombat':
      startCombat(tx, cmd.order, null);
      return;
    case 'nextTurn':
      nextTurn(tx, null);
      return;
    case 'endCombat': {
      // 战斗结束：所有专注先结束 —— 它链接的区域（匕首之云这类）会跟着一起清掉。
      // 不这么做的话：区域留在场上还能挪、专注也还占着，下一次战斗里那道法术再也放不出来。
      for (const id of Object.keys(tx.state.combatants)) {
        if (concentrationOf(tx, id)) endConcentration(tx, id, '战斗结束', null);
      }
      tx.emit('combatEnded', {});
      return;
    }
    case 'useAction': {
      const { key, action } = findAction(tx, cmd.actor, cmd.action);
      executeAction(tx, {
        actor: cmd.actor, actionKey: key, action, targets: cmd.targets ?? [], slotLevel: cmd.slotLevel,
        force: cmd.force, cause: null, options: cmd.options,
        ...(cmd.area ? { area: cmd.area } : {}),
      });
      return;
    }
    case 'roll': {
      const v = effectiveView(tx, cmd.roller);
      const ability = cmd.ability;
      const bonus = cmd.kind === 'save' && ability ? v.save[ability]
        : cmd.skill ? skillBonus(v, cmd.skill, ability)
        : ability ? v.mod[ability] : 0;
      d20Test(tx, {
        roller: cmd.roller, kind: cmd.kind, ability, skill: cmd.skill, bonus, vs: cmd.dc,
        label: cmd.label ?? `${ability ? ABIL_CN[ability] : ''}${cmd.skill ? `（${cmd.skill}）` : ''}${cmd.kind === 'save' ? '豁免' : '检定'}`,
        cause: null,
      });
      return;
    }
    case 'applyEffect': {
      const seq = tx.emit('manualOverride', { what: 'applyEffect', to: cmd.to, template: cmd.template ?? cmd.name ?? '现场效应' });
      applyEffect(tx, {
        bearer: cmd.to, source: cmd.source ?? null, ref: cmd.template, inline: cmd.inline, name: cmd.name,
        baseKey: cmd.template ?? 'manual', duration: cmd.duration, form: cmd.form,
        origin: { kind: cmd.template?.includes(':condition:') ? 'condition' : 'manual', ref: cmd.template ?? 'manual' },
        cause: seq,
      });
      // 生命值上限降到当前生命值以下：当前生命值跟着降
      const c = tx.state.combatants[cmd.to];
      const max = c ? effectiveView(tx, cmd.to).hpMax : 0;
      if (c && c.live.hp > max) tx.emit('hpChanged', { id: cmd.to, hp: max, tempHp: c.live.tempHp }, seq);
      return;
    }
    case 'removeEffect':
      if (!tx.state.effects[cmd.id]) throw new Rejected(`没有效应 ${cmd.id}`);
      endEffect(tx, cmd.id, '手动移除', tx.emit('manualOverride', { what: 'removeEffect', id: cmd.id }));
      return;
    case 'adjustHp': {
      const c = tx.state.combatants[cmd.id];
      if (!c) throw new Rejected(`没有参与者 ${cmd.id}`);
      const max = effectiveView(tx, cmd.id).hpMax;
      const hp = Math.max(0, Math.min(max, cmd.set ?? c.live.hp + (cmd.delta ?? 0)));
      const seq = tx.emit('manualOverride', { what: 'hp', id: cmd.id, from: c.live.hp, to: hp });
      // 手动把死了的人调回正数生命值 = DM 让他活过来
      if (c.live.dead && hp > 0) revive(tx, cmd.id, seq);
      tx.emit('hpChanged', { id: cmd.id, hp, tempHp: cmd.temp ?? c.live.tempHp }, seq);
      return;
    }
    case 'damage': {
      const seq = tx.emit('manualOverride', { what: 'damage', id: cmd.id, amount: cmd.amount, type: cmd.damageType });
      applyDamagePacket(tx, {
        source: cmd.source ?? null, target: cmd.id, components: [{ dice: Dice.constant(cmd.amount), type: cmd.damageType, from: '手动伤害' }],
        crit: false, label: '手动伤害', reduce: [],
      }, seq);
      return;
    }
    case 'groupRoll': {
      const ids = [...new Set(cmd.ids)].filter((id) => tx.state.combatants[id]);
      if (!ids.length) throw new Rejected('没有要掷骰的人');
      const save = cmd.kind === 'save';
      const label = `${ABIL_CN[cmd.ability]}${cmd.skill ? `（${cmd.skill}）` : ''}${save ? '豁免' : '检定'}`; // DC 不写进来：掷骰那行自己会写「对 DC n」
      const seq = tx.emit('manualOverride', { what: 'groupRoll', kind: cmd.kind, ids, label: label + (cmd.dc ? ` DC ${cmd.dc}` : ''), ...(save && cmd.damage ? { damage: cmd.damage, half: !!cmd.half } : {}) });
      // 伤害只掷一次，所有人共用这一次（和火球术一样）
      let comp: DamageComponent | null = null;
      if (save && cmd.damage) {
        let dice: Dice;
        try { dice = parseDice(cmd.damage.dice); } catch { throw new Rejected(`看不懂伤害「${cmd.damage.dice}」`); }
        const type = normType(cmd.damage.type || '钝击');
        const c: DamageComponent = { dice, type, from: label };
        c.rolled = { ...rollComponent(tx, c, false, 'dm', 0), crit: false };
        comp = c;
      }
      for (const id of ids) {
        const v = effectiveView(tx, id);
        const bonus = save ? v.save[cmd.ability] : cmd.skill ? skillBonus(v, cmd.skill, cmd.ability) : v.mod[cmd.ability];
        const r = d20Test(tx, { roller: id, kind: cmd.kind, ability: cmd.ability, skill: cmd.skill, bonus, ...(cmd.dc ? { vs: cmd.dc } : {}), label, cause: seq });
        if (!save) continue;
        const ok = r.outcome === 'success';
        const s2 = tx.emit(ok ? 'saveSucceeded' : 'saveFailed', { actor: null, target: id, ability: cmd.ability, dc: cmd.dc ?? 0, label }, r.seq);
        if (!comp || (ok && !cmd.half)) continue;
        applyDamagePacket(tx, {
          source: null, target: id, components: [{ ...comp }], crit: false, label, reduce: [],
          ...(ok ? { scale: 0.5 } : {}), save: { ability: cmd.ability, success: ok, half: !!cmd.half },
        }, s2);
      }
      return;
    }
    case 'heal': {
      if (!tx.state.combatants[cmd.id]) throw new Rejected(`没有参与者 ${cmd.id}`);
      const seq = tx.emit('manualOverride', { what: 'heal', id: cmd.id, amount: cmd.amount });
      // 手动治疗死了的人：DM 的裁定，先让他活过来（规则里的治疗不能复活，走 applyHeal 会被挡）
      if (tx.state.combatants[cmd.id].live.dead && cmd.amount > 0) revive(tx, cmd.id, seq);
      applyHeal(tx, cmd.id, cmd.amount, '手动治疗', seq);
      return;
    }
    case 'tempHp': {
      if (!tx.state.combatants[cmd.id]) throw new Rejected(`没有参与者 ${cmd.id}`);
      const seq = tx.emit('manualOverride', { what: 'tempHp', id: cmd.id, amount: cmd.amount });
      grantTempHp(tx, cmd.id, cmd.amount, '手动', seq);
      return;
    }
    case 'manualCast': {
      const action: Action = {
        id: 'manual', name: cmd.spell, activation: cmd.activation ?? 'none',
        cost: cmd.slotLevel ? [{ slot: { min: cmd.slotLevel, max: cmd.slotLevel } }] : [],
        concentration: cmd.concentration ? { manual: true } : undefined,
        root: [{ kind: 'note', text: `「${cmd.spell}」还没有自动化数据，效果请手动处理` }],
        tags: ['spell', 'manual'],
      };
      executeAction(tx, {
        actor: cmd.actor, actionKey: `XPHB:spell:${cmd.spell}#manual`, action, targets: cmd.targets ?? [],
        slotLevel: cmd.slotLevel, force: cmd.force, cause: null,
      });
      return;
    }
    case 'setUsage': {
      if (!tx.state.combatants[cmd.id]) throw new Rejected(`没有参与者 ${cmd.id}`);
      const v = effectiveView(tx, cmd.id);
      const max = cmd.slot !== undefined ? v.slots[cmd.slot] ?? 0
        : cmd.hitDie !== undefined ? v.hitDice?.[cmd.hitDie] ?? 0
        : cmd.resource ? v.resources[cmd.resource] ?? 0 : 0;
      const used = Math.max(0, Math.min(max, cmd.used));
      const seq = tx.emit('manualOverride', { what: 'usage', id: cmd.id, resource: cmd.resource ?? null, slot: cmd.slot ?? null, hitDie: cmd.hitDie ?? null, used });
      if (cmd.slot !== undefined) tx.emit('slotUsed', { id: cmd.id, level: cmd.slot, used }, seq);
      else if (cmd.hitDie !== undefined) tx.emit('hitDieUsed', { id: cmd.id, faces: cmd.hitDie, used }, seq);
      else if (cmd.resource) tx.emit('resourceUsed', { id: cmd.id, resource: cmd.resource, used }, seq);
      return;
    }
    case 'setTriggerOff': {
      if (!tx.state.combatants[cmd.id]) throw new Rejected(`没有参与者 ${cmd.id}`);
      tx.emit('triggerPref', { id: cmd.id, key: cmd.key, off: cmd.off });
      return;
    }
    case 'spendHitDie': {
      const c = tx.state.combatants[cmd.id];
      if (!c) throw new Rejected(`没有参与者 ${cmd.id}`);
      if (c.live.dead) throw new Rejected('已经死亡，不能花生命骰');
      const v = effectiveView(tx, cmd.id);
      const max = v.hitDice?.[cmd.faces] ?? c.base.hitDice?.[cmd.faces] ?? 0;
      const used = c.live.hitDiceUsed?.[cmd.faces] ?? 0;
      const count = Math.max(1, Math.round(cmd.count ?? 1));
      if (max - used < count) throw new Rejected(`d${cmd.faces} 生命骰只剩 ${Math.max(0, max - used)} 颗`);
      const [rolls] = tx.roll([{ faces: cmd.faces, count }], c.controller, `生命骰 ${count}d${cmd.faces}`);
      const conMod = v.mod.con;
      const total = rolls.reduce((sum, r) => sum + Math.max(1, r + conMod), 0);
      const seq = tx.emit('hitDieUsed', { id: cmd.id, faces: cmd.faces, used: used + count });
      const modText = conMod ? (conMod > 0 ? ` + ${conMod * count}` : ` − ${-conMod * count}`) : '';
      tx.emit('note', { text: `${c.name} 花 ${count}d${cmd.faces} 生命骰：[${rolls.join(', ')}]${modText} = ${total}`, owner: cmd.id }, seq);
      applyHeal(tx, cmd.id, total, `生命骰 ${count}d${cmd.faces}`, seq);
      return;
    }
    case 'setEconomy': {
      if (!tx.state.combatants[cmd.id]) throw new Rejected(`没有参与者 ${cmd.id}`);
      const patch: Record<string, number> = {};
      for (const k of ['action', 'bonus', 'reaction', 'move'] as const) {
        const v = cmd.patch[k];
        if (typeof v === 'number' && Number.isFinite(v)) patch[k] = Math.max(0, Math.min(k === 'move' ? 1000 : 9, Math.round(v)));
      }
      const seq = tx.emit('manualOverride', { what: 'economy', id: cmd.id, patch });
      tx.emit('economyChanged', { id: cmd.id, patch }, seq);
      return;
    }
    case 'endConcentration':
      endConcentration(tx, cmd.id, '主动终止', null);
      return;
    case 'move': {
      const c = tx.state.combatants[cmd.id];
      if (!c) throw new Rejected(`没有参与者 ${cmd.id}`);
      const ft = Math.max(0, Math.round(cmd.ft));
      if (tx.state.round === null) return;
      const left = c.economy.move;
      if (ft > left && !cmd.force) throw new Rejected(`${c.name} 只剩 ${left} 尺移动，这一步要 ${ft} 尺`);
      const seq = tx.emit('note', { text: `${c.name} 移动 ${ft} 尺（剩 ${Math.max(0, left - ft)} 尺）`, owner: cmd.id });
      tx.emit('economyChanged', { id: cmd.id, patch: { move: Math.max(0, left - ft) } }, seq);
      // 一格一格走：借机攻击、进入区域
      if (cmd.path && cmd.path.length > 1) travel(tx, cmd.id, cmd.path, { forced: false, cause: seq });
      return;
    }
    case 'createZone': {
      const z = cmd.zone;
      if (!z.cells?.length) throw new Rejected('区域里没有格子');
      const round = tx.state.round;
      const zone: Zone = {
        id: tx.nextId('z'), name: z.name || '区域', cells: z.cells.slice(), ...(z.tpl ? { tpl: z.tpl } : {}), source: null, entryKey: 'zone',
        on: z.on, do: z.do, ...(z.while?.length ? { while: z.while } : {}), affects: z.affects ?? 'all', oncePerTurn: z.oncePerTurn ?? true, confirm: !!z.confirm, link: null,
        untilRound: z.rounds && round !== null ? round + z.rounds : null, hits: {},
      };
      placeZone(tx, zone, null);
      return;
    }
    case 'removeZone': {
      const z = tx.state.zones?.[cmd.id];
      if (!z) throw new Rejected('没有这个区域');
      removeZone(tx, z, '移除', null);
      return;
    }
    case 'moveZone': {
      const z = tx.state.zones?.[cmd.id];
      if (!z) throw new Rejected('没有这个区域');
      if (!cmd.cells?.length) throw new Rejected('区域里没有格子');
      relocateZone(tx, z, cmd.cells, cmd.tpl, null);
      return;
    }
    case 'advanceTime':
      advanceTime(tx, cmd.minutes, null);
      return;
    case 'rest':
      rest(tx, cmd.kind, cmd.ids, null);
      return;
    case 'setSettings':
      tx.emit('settingsChanged', { patch: cmd.settings });
      return;
  }
}

export type DispatchResult =
  | { status: 'done'; events: GameEvent[] }
  | { status: 'pending'; decision: Decision; preview: GameEvent[] }
  | { status: 'rejected'; reason: string };

interface TxRecord {
  input: TxInput;
  events: GameEvent[];
}

export interface SessionSave {
  base: EncounterState;
  inputs: TxInput[];
  pending: TxInput | null;
}

export class Session {
  private readonly base: EncounterState;
  private txs: TxRecord[] = [];
  /** 事后裁定导致重跑时，排在暂停事务后面、还没重跑的事务 */
  private queue: TxInput[] = [];
  state: EncounterState;
  pending: { input: TxInput; decision: Decision; preview: GameEvent[] } | null = null;

  constructor(init: EncounterState, readonly ctx: EngineCtx) {
    this.base = structuredClone(init);
    this.state = structuredClone(init);
  }

  /** 某个参与者当前的有效数值（基础 + 效应的静态部分）—— 界面和测试用 */
  view(id: string): CombatantView {
    const tx = new Tx(structuredClone(this.state), { cmd: { type: 'endCombat' }, by: 'view', tape: [], answers: {}, overrides: [] }, this.ctx);
    return effectiveView(tx, id);
  }

  /** 在当前状态上做只读查询（has / 有效数值 / 收集修正…） */
  peek<T>(fn: (tx: Tx) => T): T {
    const tx = new Tx(structuredClone(this.state), { cmd: { type: 'endCombat' }, by: 'view', tape: [], answers: {}, overrides: [] }, this.ctx);
    return fn(tx);
  }

  get events(): GameEvent[] {
    return this.txs.flatMap((t) => t.events);
  }

  get transactions(): ReadonlyArray<Readonly<TxRecord>> {
    return this.txs;
  }

  dispatch(cmd: Command, by: UserId = 'dm'): DispatchResult {
    if (this.pending) return { status: 'rejected', reason: `还有一个决定没有回答：${this.pending.decision.prompt}` };
    const positions = this.ctx.positions?.() ?? undefined;
    const diagonal = positions ? this.ctx.diagonal?.() : undefined;
    return this.run({ cmd, by, tape: [], answers: {}, overrides: [], ...(positions ? { positions } : {}), ...(diagonal && diagonal !== '5' ? { diagonal } : {}) });
  }

  /** 回答当前的决定。实体骰的回答是骰面（number[][]），会写进磁带 */
  decide(value: unknown, decisionId?: string): DispatchResult {
    const p = this.pending;
    if (!p) return { status: 'rejected', reason: '没有等待中的决定' };
    if (decisionId && decisionId !== p.decision.id) return { status: 'rejected', reason: `决定 ${decisionId} 已过期（当前是 ${p.decision.id}）` };
    const input = structuredClone(p.input);
    if (p.decision.kind === 'physicalDice') {
      const idx = Number(p.decision.id.split(':')[1]);
      const reqs = p.decision.dice ?? [];
      // 'roll'：确认掷骰 —— 由引擎（战役遭遇里是服务器）来掷；'roll-dark'：同上，但是暗骰（别人的 3D 骰子不显示点数）
      const dark = value === 'roll-dark';
      const auto = value === 'roll' || dark;
      const faces = auto ? engineDice().roll(reqs, '')! : value as number[][];
      const bad = reqs.some((r, i) => !Array.isArray(faces?.[i]) || faces[i].length !== r.count || faces[i].some((f) => !Number.isInteger(f) || f < 1 || f > r.faces));
      if (bad) return { status: 'rejected', reason: '骰面不合法（个数或点数不对）' };
      input.tape[idx] = { sig: reqs.map((r) => `${r.count}d${r.faces}`).join('+'), faces, source: auto ? 'engine' : 'physical', ...(dark ? { dark: true } : {}) };
    } else {
      input.answers[p.decision.id] = { kind: p.decision.kind, value };
    }
    this.pending = null;
    return this.run(input);
  }

  /** 存档：起点 + 每笔事务的输入（命令、骰面磁带、回答、裁定）+ 等待中的那笔 */
  save(): SessionSave {
    return {
      base: structuredClone(this.base),
      inputs: this.txs.map((t) => structuredClone(t.input)),
      pending: this.pending ? structuredClone(this.pending.input) : null,
    };
  }

  /** 读档：从存档的起点把事务重跑一遍（磁带里有骰面，结果和存档时一样） */
  static restore(save: SessionSave, ctx: EngineCtx): Session {
    const s = new Session(save.base, ctx);
    s.rebuild(save.inputs);
    if (save.pending && !s.pending) s.run(save.pending);
    return s;
  }

  /** 回放：从起点只重跑前 n 笔事务（0 <= n <= transactions.length），返回那一刻的只读会话快照 */
  replayTo(n: number): Session {
    const k = Math.max(0, Math.min(this.txs.length, Math.floor(n)));
    const s = new Session(this.base, this.ctx);
    s.rebuild(this.txs.slice(0, k).map((t) => structuredClone(t.input)));
    return s;
  }

  /** 放弃等待中的事务（什么都没发生过） */
  cancelPending(): void {
    this.pending = null;
    this.queue = [];
  }

  undo(count = 1): void {
    this.cancelPending();
    const keep = this.txs.slice(0, Math.max(0, this.txs.length - count)).map((t) => t.input);
    this.rebuild(keep);
  }

  /** DM 事后改某笔事务里的结果（§15.3）：从那笔事务开始，带着裁定重跑后面所有事务 */
  override(txIndex: number, patch: OverridePatch): DispatchResult {
    if (this.pending) return { status: 'rejected', reason: '先处理完等待中的决定' };
    const t = this.txs[txIndex];
    if (!t) return { status: 'rejected', reason: `没有第 ${txIndex} 笔事务` };
    const inputs = this.txs.map((x) => structuredClone(x.input));
    inputs[txIndex].overrides = [...inputs[txIndex].overrides.filter((o) => !sameTarget(o, patch)), patch];
    return this.rebuild(inputs);
  }

  private rebuild(inputs: TxInput[]): DispatchResult {
    this.txs = [];
    this.state = structuredClone(this.base);
    this.queue = inputs.slice();
    return this.drain();
  }

  private drain(): DispatchResult {
    let last: DispatchResult = { status: 'done', events: [] };
    while (this.queue.length) {
      const input = this.queue.shift()!;
      last = this.run(input, true);
      if (last.status !== 'done') return last;
    }
    return last;
  }

  private run(input: TxInput, fromQueue = false): DispatchResult {
    const out = runTx(this.state, input, this.ctx);
    if (out.kind === 'done') {
      this.txs.push({ input: { ...input, tape: out.tape }, events: out.events });
      this.state = out.state;
      if (!fromQueue && this.queue.length) {
        const rest = this.drain();
        if (rest.status !== 'done') return rest;
      }
      return { status: 'done', events: out.events };
    }
    if (out.kind === 'pending') {
      this.pending = { input: { ...input, tape: out.tape }, decision: out.decision, preview: out.preview };
      return { status: 'pending', decision: out.decision, preview: out.preview };
    }
    return { status: 'rejected', reason: out.reason };
  }
}

function sameTarget(a: OverridePatch, b: OverridePatch): boolean {
  if ('roll' in a && 'roll' in b) return a.roll === b.roll;
  if ('damage' in a && 'damage' in b) return a.damage === b.damage;
  return false;
}

/** DM 手动复活：去掉死亡、清空死亡豁免 */
function revive(tx: Tx, id: string, cause: number): void {
  tx.emit('deadChanged', { id, dead: false }, cause);
  tx.emit('deathSavesChanged', { id, s: 0, f: 0 }, cause);
  tx.emit('note', { text: `${tx.state.combatants[id].name} 被 DM 复活`, owner: id }, cause);
}

