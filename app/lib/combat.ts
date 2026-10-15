/**
 * 战斗页的状态：一场遭遇（Session）+ 页面上的选择。存 localStorage。
 *
 * 存的是 Session 的存档（起点 + 每笔事务的命令、骰面、回答、裁定），读档时重跑一遍，
 * 所以刷新页面、等待中的决定、撤销历史都不丢。
 */
import { useSyncExternalStore } from 'react';
import { combatantFromSheet, syncLiveToChar, viewFromSheet } from '../../src/bridge/from-sheet';
import {
  Session, createEncounter, engineDice, makeCombatant, makeView, physicalDice,
  type Command, type DispatchResult, type EngineCtx, type OverridePatch, type SessionSave, type ViewInit,
} from '../../src/combat';
import { api } from './api';
import type { Engine } from './engine';
import { actions as cardActions, getApp, stripDerived } from './store';

const KEY = 'dnd2024-engine:combat';

export type DiceMode = 'engine' | 'physical';

export interface CombatUi {
  session: Session | null;
  /** 每次变化 +1（Session 是可变对象，界面靠它知道要重画） */
  version: number;
  /** 参与者 id → 卡片库里的卡 id（写回人物卡用） */
  links: Record<string, string>;
  /** 骰子来源：按控制者（'*' = 默认） */
  dice: Record<string, DiceMode>;
  selected: string | null;
  targets: string[];
  toast: { text: string; tone: 'danger' | 'ok' } | null;
  /** 战役遭遇（在服务器上跑）：本地的 session 只是镜像，所有操作发给服务器 */
  remote: Remote | null;
}

export interface Remote {
  id: string;
  name: string;
  campaignId: string;
  role: 'dm' | 'player';
  me: number;
  /** 控制者 id → 用户 id */
  owners: Record<string, number>;
  /** 骰子来源（按控制者，服务器上存的） */
  dice: Record<string, DiceMode>;
  /** DM 藏起来的参与者 */
  hidden: string[];
  map: MapState;
  connected: boolean;
}

export interface Stroke { id: string; by: number; color: string; width: number; pts: number[] }
export interface MapState {
  grid: { size: number; ox: number; oy: number; cols: number; rows: number; show: boolean; diagonal?: '5' | '5-10-5' };
  bg: { img: string; w: number; h: number } | null;
  strokes: Stroke[];
  tokens: Record<string, { x: number; y: number }>;
}
interface RemoteState {
  save: SessionSave; owners: Record<string, number>; cards: Record<string, string>; name: string;
  dice?: Record<string, DiceMode>; hidden?: string[]; map?: MapState;
}

let ui: CombatUi = { session: null, version: 0, links: {}, dice: { '*': 'engine' }, selected: null, targets: [], toast: null, remote: null };
let engineRef: Engine | null = null;
let stream: EventSource | null = null;
const listeners = new Set<() => void>();
let toastTimer: ReturnType<typeof setTimeout> | undefined;

function set(next: Partial<CombatUi>, persistNow = true): void {
  ui = { ...ui, ...next, version: ui.version + 1 };
  if (persistNow) persist();
  for (const l of listeners) l();
  scheduleAutoWrite();
}

/* ───── 战斗 → 人物卡：自动写回 ─────
 * 关联了人物卡的参与者，记账字段（生命值、临时生命值、法术位、资源、死亡豁免）一变就写回卡上。
 * 只在这台电脑「管」这张卡时写：本地遭遇都写；战役遭遇里只写自己的卡（DM 不替玩家写，免得两边打架）。
 * 第一次看到某个参与者时只记下现状、不写 —— 打开一场旧遭遇不应该把卡上的血量改回去。 */
const lastLive = new Map<string, string>();
let autoTimer: ReturnType<typeof setTimeout> | undefined;
const liveKey = (c: { live: { hp: number; tempHp: number; deathSaves: unknown; resourcesUsed: unknown; slotsUsed: unknown } }) =>
  JSON.stringify([c.live.hp, c.live.tempHp, c.live.deathSaves, c.live.resourcesUsed, c.live.slotsUsed]);

function scheduleAutoWrite(): void {
  clearTimeout(autoTimer);
  autoTimer = setTimeout(autoWrite, 600);
}
function autoWrite(): void {
  const s = ui.session;
  if (!s || !engineRef || s.pending) return;
  const r = ui.remote;
  for (const [id, cardId] of Object.entries(ui.links)) {
    const c = s.state.combatants[id];
    const card = getApp().cards[cardId];
    if (!c || !card) continue;
    if (r && !(card.owner ? card.owner.id === r.me : r.owners[c.controller] === r.me)) continue;
    const k = `${r?.id ?? 'local'}:${id}`;
    const now = liveKey(c);
    const prev = lastLive.get(k);
    lastLive.set(k, now);
    if (prev === undefined || prev === now) continue;
    void combat.writeBack(engineRef, id, true);
  }
}

function persist(): void {
  if (!ui.session || ui.remote) return;   // 战役遭遇存在服务器上
  try {
    localStorage.setItem(KEY, JSON.stringify({ save: ui.session.save(), links: ui.links, dice: ui.dice, selected: ui.selected, targets: ui.targets }));
  } catch { /* 存不下：这次会话照常用 */ }
}

export function useCombat(): CombatUi {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => ui);
}

function ctxFor(engine: Engine): EngineCtx {
  return {
    rules: engine.rules,
    // 读档重跑时磁带里有骰面，不会走到这里；只有新掷的骰子按当前设置取来源。
    // 战役遭遇：骰子只由服务器掷。服务器那边正停着等骰面时，本地重放也必须停在同一处，不能自己补一颗
    diceFor: (user) => (ui.remote || (ui.dice[user] ?? ui.dice['*'] ?? 'engine') === 'physical' ? physicalDice : engineDice()),
  };
}

export function initCombat(engine: Engine): void {
  engineRef = engine;
  if (ui.session) return;
  let saved: { save: SessionSave; links?: Record<string, string>; dice?: Record<string, DiceMode>; selected?: string | null; targets?: string[] } | null = null;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) saved = JSON.parse(raw);
  } catch { /* 坏了就开新遭遇 */ }
  if (saved?.save) {
    ui = { ...ui, links: saved.links ?? {}, dice: saved.dice ?? { '*': 'engine' }, selected: saved.selected ?? null, targets: saved.targets ?? [] };
    try {
      set({ session: Session.restore(saved.save, ctxFor(engine)) }, false);
      return;
    } catch (e) {
      console.error('读档失败，开新遭遇', e);
    }
  }
  set({ session: new Session(createEncounter('enc'), ctxFor(engine)) });
}

function toast(text: string, tone: 'danger' | 'ok' = 'danger'): void {
  clearTimeout(toastTimer);
  set({ toast: { text, tone } }, false);
  toastTimer = setTimeout(() => set({ toast: null }, false), 4200);
}

function after(r: DispatchResult): DispatchResult {
  if (r.status === 'rejected') toast(r.reason);
  const s = ui.session!;
  // 回合推进时，选中跟着当前行动者走
  const cur = s.state.round !== null ? s.state.order[s.state.turnIndex] : null;
  const selected = ui.selected && s.state.combatants[ui.selected] ? ui.selected : cur ?? Object.keys(s.state.combatants)[0] ?? null;
  set({ selected, targets: ui.targets.filter((t) => s.state.combatants[t]) });
  return r;
}

/** 战役遭遇：把操作发给服务器（结果通过 SSE 回来） */
function act(body: Record<string, unknown>): DispatchResult {
  const r = ui.remote!;
  api<{ status: string; reason?: string }>('POST', `encounters/${r.id}/act`, body)
    .then((x) => { if (x.status === 'rejected') toast(x.reason || '被拒绝了'); }, (e: Error) => toast(e.message));
  return { status: 'done', events: [] };
}

/** 服务器推来的完整状态：在本地重放一遍用来画界面 */
function applyRemote(data: RemoteState): void {
  if (!ui.remote || !engineRef) return;
  try {
    const session = Session.restore(data.save, ctxFor(engineRef));
    const st = session.state;
    const cur = st.round !== null ? st.order[st.turnIndex] : null;
    const selected = ui.selected && st.combatants[ui.selected] ? ui.selected : cur ?? Object.keys(st.combatants)[0] ?? null;
    set({ session, links: data.cards, selected, targets: ui.targets.filter((t) => st.combatants[t]), remote: {
      ...ui.remote, owners: data.owners, name: data.name, dice: data.dice ?? {}, hidden: data.hidden ?? [], map: data.map ?? ui.remote.map, connected: true,
    } }, false);
  } catch (e) {
    toast('同步遭遇失败：' + (e as Error).message);
  }
}

export const combat = {
  /** 进入一场战役遭遇 */
  async join(engine: Engine, encounterId: string): Promise<void> {
    engineRef = engine;
    stream?.close();
    const info = await api<RemoteState & { role: 'dm' | 'player'; me: number; campaignId: string; map: MapState }>('GET', `encounters/${encounterId}`);
    ui = {
      ...ui, selected: null, targets: [],
      remote: { id: encounterId, name: info.name, campaignId: info.campaignId, role: info.role, me: info.me, owners: info.owners, dice: {}, hidden: [], map: info.map, connected: false },
    };
    applyRemote(info);
    stream = new EventSource(new URL('api/', document.baseURI).pathname + `encounters/${encounterId}/stream`);
    stream.addEventListener('state', (ev) => applyRemote(JSON.parse((ev as MessageEvent).data)));
    stream.addEventListener('map', (ev) => { if (ui.remote) set({ remote: { ...ui.remote, map: JSON.parse((ev as MessageEvent).data) } }, false); });
    stream.onerror = () => { if (ui.remote) set({ remote: { ...ui.remote, connected: false } }, false); };
  },
  /** 回到本地遭遇 */
  leave(engine: Engine): void {
    stream?.close();
    stream = null;
    ui = { ...ui, session: null, remote: null, links: {}, selected: null, targets: [] };
    initCombat(engine);
  },
  /** 这个参与者我能不能操作（本地遭遇：都能） */
  canControl(combatantId: string | null): boolean {
    const r = ui.remote;
    if (!r || r.role === 'dm' || !combatantId) return true;
    const c = ui.session?.state.combatants[combatantId];
    return r.owners[c?.controller ?? combatantId] === r.me;
  },
  /** 等待中的决定是不是问我的（DM：没有归属玩家的都问 DM；问玩家的 DM 可以代答，见战斗页） */
  isMyDecision(): boolean {
    const r = ui.remote;
    const p = ui.session?.pending;
    if (!p) return false;
    if (!r) return true;
    const owner = r.owners[p.decision.to];
    return r.role === 'dm' ? owner === undefined : owner === r.me;
  },
  /** 玩家视角下藏起来的参与者（DM 和本地遭遇：没有） */
  isHidden(id: string | null | undefined): boolean {
    const r = ui.remote;
    return !!id && !!r && r.role !== 'dm' && r.hidden.includes(id);
  },
  /** 玩家视角下要保密的参与者：不是自己的、也不是队友（怪物、DM 的 NPC）—— 数值和骰子明细只给 DM 看 */
  isSecret(id: string | null | undefined): boolean {
    const r = ui.remote;
    if (!id || !r || r.role === 'dm') return false;
    const c = ui.session?.state.combatants[id];
    if (!c) return false;
    return c.side !== 'party' && r.owners[c.controller] !== r.me;
  },
  /** DM 藏 / 亮出一个参与者 */
  setHidden(id: string, hidden: boolean): void {
    if (ui.remote) act({ op: 'setHidden', id, hidden });
  },
  /** 地图操作（只在战役遭遇里） */
  map(body: Record<string, unknown>): Promise<boolean> {
    const r = ui.remote;
    if (!r) return Promise.resolve(false);
    return api<{ status: string; reason?: string }>('POST', `encounters/${r.id}/act`, { op: 'map', ...body })
      .then((x) => { if (x.status === 'rejected') toast(x.reason || '被拒绝了'); return x.status !== 'rejected'; }, (e: Error) => { toast(e.message); return false; });
  },
  /** 乐观更新地图（拖棋子、画线不用等服务器回来） */
  patchMap(fn: (m: MapState) => void): void {
    if (!ui.remote) return;
    const map = structuredClone(ui.remote.map);
    fn(map);
    set({ remote: { ...ui.remote, map } }, false);
  },

  dispatch(cmd: Command): DispatchResult {
    if (ui.remote) return act({ op: 'dispatch', cmd });
    const s = ui.session!;
    const turnBefore = `${s.state.round}:${s.state.turnIndex}`;
    const r = s.dispatch(cmd);
    if (r.status === 'done' && (cmd.type === 'startCombat' || cmd.type === 'nextTurn') && `${s.state.round}:${s.state.turnIndex}` !== turnBefore) {
      ui = { ...ui, selected: s.state.order[s.state.turnIndex] ?? ui.selected };
    }
    return after(r);
  },
  decide(value: unknown): DispatchResult {
    if (ui.remote) return act({ op: 'decide', value });
    return after(ui.session!.decide(value));
  },
  cancelPending(): void {
    if (ui.remote) { act({ op: 'cancelPending' }); return; }
    ui.session!.cancelPending();
    set({});
  },
  undo(n = 1): void {
    if (ui.remote) { act({ op: 'undo', n }); return; }
    ui.session!.undo(n);
    after({ status: 'done', events: [] });
  },
  override(txIndex: number, patch: OverridePatch): DispatchResult {
    if (ui.remote) return act({ op: 'override', txIndex, patch });
    return after(ui.session!.override(txIndex, patch));
  },
  reset(engine: Engine): void {
    if (ui.remote) { act({ op: 'reset' }); return; }
    set({ session: new Session(createEncounter('enc'), ctxFor(engine)), links: {}, selected: null, targets: [] });
  },
  select(id: string | null): void {
    set({ selected: id }, true);
  },
  toggleTarget(id: string): void {
    set({ targets: ui.targets.includes(id) ? ui.targets.filter((t) => t !== id) : [...ui.targets, id] });
  },
  clearTargets(): void {
    set({ targets: [] });
  },
  /** mode 为空 = 跟随默认 */
  setDice(user: string, mode: DiceMode | ''): void {
    if (ui.remote) { act({ op: 'setDice', user, mode }); return; }
    const dice = { ...ui.dice };
    if (mode) dice[user] = mode;
    else delete dice[user];
    set({ dice });
  },
  toast,

  /** 从卡片库加一个角色：现算一遍人物卡，转成参与者 */
  async addPc(engine: Engine, cardId: string): Promise<void> {
    const card = getApp().cards[cardId];
    if (!card) return;
    const work = structuredClone(stripDerived(card.char));
    const sheet = await engine.env.compute(work);
    const id = uniqueId('pc');
    const c = combatantFromSheet(engine.env, work, sheet, { id, controller: id, side: 'party' });
    if (!c.name) c.name = card.char.name || '未命名';
    // 战役遭遇：交给服务器；DM 替玩家加的卡，控制权归卡主
    if (ui.remote) { act({ op: 'dispatch', cmd: { type: 'addCombatant', combatant: c }, cardId, owner: card.owner?.id }); return; }
    const r = ui.session!.dispatch({ type: 'addCombatant', combatant: c });
    if (r.status === 'done') ui = { ...ui, links: { ...ui.links, [id]: cardId } };
    after(r);
  },

  /** 人物卡 → 战斗：按卡上现在的样子重算数值（升级、换装备之后），作为一笔操作记进日志 */
  async refreshFromCard(engine: Engine, id: string): Promise<void> {
    const card = getApp().cards[ui.links[id]];
    if (!card) { toast('这个参与者没有对应的人物卡（或者卡不在这台电脑上）'); return; }
    const work = structuredClone(stripDerived(card.char));
    const sheet = await engine.env.compute(work);
    const view = viewFromSheet(engine.env, work, sheet);
    if (!view.name) view.name = card.char.name || '未命名';
    const r = combat.dispatch({ type: 'refreshCombatant', id, view });
    if (r.status === 'done' && !ui.remote) toast('已按人物卡更新', 'ok');
  },

  addMonster(view: ViewInit, count: number, side = 'enemy', hidden = false): void {
    const s = ui.session!;
    for (let i = 1; i <= count; i++) {
      const name = count > 1 ? `${view.name} ${i}` : view.name;
      const cmd: Command = { type: 'addCombatant', combatant: makeCombatant({ id: uniqueId('m'), kind: 'monster', side, view: makeView({ ...view, name }) }) };
      if (ui.remote) { act({ op: 'dispatch', cmd, hidden }); continue; }
      const r = s.dispatch(cmd);
      if (r.status !== 'done') { after(r); return; }
    }
    after({ status: 'done', events: [] });
  },

  /** 战斗结果写回人物卡：HP、临时生命值、法术位、资源、死亡豁免（quiet：自动写回，出错不弹提示） */
  async writeBack(engine: Engine, id: string, quiet = false): Promise<boolean> {
    const cardId = ui.links[id];
    const card = cardId ? getApp().cards[cardId] : null;
    const c = ui.session!.state.combatants[id];
    if (!card || !c) { if (!quiet) toast('这个参与者没有对应的人物卡'); return false; }
    const work = structuredClone(stripDerived(card.char));
    const sheet = await engine.env.compute(work);
    syncLiveToChar(work, sheet, c);
    cardActions.replace(cardId, work);
    return true;
  },
};

function uniqueId(prefix: string): string {
  const taken = ui.session?.state.combatants ?? {};
  for (;;) {
    const id = `${prefix}-${Math.random().toString(36).slice(2, 7)}`;
    if (!taken[id]) return id;
  }
}
