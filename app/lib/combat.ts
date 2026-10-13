/**
 * 战斗页的状态：一场遭遇（Session）+ 页面上的选择。存 localStorage。
 *
 * 存的是 Session 的存档（起点 + 每笔事务的命令、骰面、回答、裁定），读档时重跑一遍，
 * 所以刷新页面、等待中的决定、撤销历史都不丢。
 */
import { useSyncExternalStore } from 'react';
import { combatantFromSheet, syncLiveToChar } from '../../src/bridge/from-sheet';
import {
  Session, createEncounter, engineDice, makeCombatant, makeView, physicalDice,
  type Command, type DispatchResult, type EngineCtx, type OverridePatch, type SessionSave, type ViewInit,
} from '../../src/combat';
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
}

let ui: CombatUi = { session: null, version: 0, links: {}, dice: { '*': 'engine' }, selected: null, targets: [], toast: null };
const listeners = new Set<() => void>();
let toastTimer: ReturnType<typeof setTimeout> | undefined;

function set(next: Partial<CombatUi>, persistNow = true): void {
  ui = { ...ui, ...next, version: ui.version + 1 };
  if (persistNow) persist();
  for (const l of listeners) l();
}

function persist(): void {
  if (!ui.session) return;
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
    // 读档重跑时磁带里有骰面，不会走到这里；只有新掷的骰子按当前设置取来源
    diceFor: (user) => ((ui.dice[user] ?? ui.dice['*'] ?? 'engine') === 'physical' ? physicalDice : engineDice()),
  };
}

export function initCombat(engine: Engine): void {
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

export const combat = {
  dispatch(cmd: Command): DispatchResult {
    const s = ui.session!;
    const turnBefore = `${s.state.round}:${s.state.turnIndex}`;
    const r = s.dispatch(cmd);
    if (r.status === 'done' && (cmd.type === 'startCombat' || cmd.type === 'nextTurn') && `${s.state.round}:${s.state.turnIndex}` !== turnBefore) {
      ui = { ...ui, selected: s.state.order[s.state.turnIndex] ?? ui.selected };
    }
    return after(r);
  },
  decide(value: unknown): DispatchResult {
    return after(ui.session!.decide(value));
  },
  cancelPending(): void {
    ui.session!.cancelPending();
    set({});
  },
  undo(n = 1): void {
    ui.session!.undo(n);
    after({ status: 'done', events: [] });
  },
  override(txIndex: number, patch: OverridePatch): DispatchResult {
    return after(ui.session!.override(txIndex, patch));
  },
  reset(engine: Engine): void {
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
    const r = ui.session!.dispatch({ type: 'addCombatant', combatant: c });
    if (r.status === 'done') ui = { ...ui, links: { ...ui.links, [id]: cardId } };
    after(r);
  },

  addMonster(view: ViewInit, count: number, side = 'enemy'): void {
    const s = ui.session!;
    for (let i = 1; i <= count; i++) {
      const name = count > 1 ? `${view.name} ${i}` : view.name;
      const r = s.dispatch({ type: 'addCombatant', combatant: makeCombatant({ id: uniqueId('m'), kind: 'monster', side, view: makeView({ ...view, name }) }) });
      if (r.status !== 'done') { after(r); return; }
    }
    after({ status: 'done', events: [] });
  },

  /** 战斗结果写回人物卡：HP、临时生命值、法术位、资源、死亡豁免 */
  async writeBack(engine: Engine, id: string): Promise<boolean> {
    const cardId = ui.links[id];
    const card = cardId ? getApp().cards[cardId] : null;
    const c = ui.session!.state.combatants[id];
    if (!card || !c) { toast('这个参与者没有对应的人物卡'); return false; }
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
