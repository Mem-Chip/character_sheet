import { readFileSync } from 'node:fs';
import rulesJson from '../../data/rules-2024.json';
import spellsJson from '../../data/dyn/spells.json';
import featuresJson from '../../data/dyn/features.json';
import {
  RuleBook, Session, createEncounter, hasCondition, makeCombatant, makeView, physicalDice, scriptedDice,
  type AttackRow, type Decision, type DispatchResult, type RuleFile, type RuleLayer, type Settings, type ViewInit,
} from '../../src/combat';

/**
 * 环境变量 RULES_OVERLAY 指向一个 `{ entries: { 键: 条目 } }` 文件时，用里面的条目**整条替换**同键的官方条目。
 * 数据化工厂用它拿现有的场景测试给候选条目打分（`tools/factory/exam.ts grade`）。
 * 不能直接追加成一个文件：规则书对同键条目是逐字段合并的，官方条目里候选没写的字段会漏进来。
 */
function withOverlay(files: RuleFile[]): RuleFile[] {
  const path = process.env.RULES_OVERLAY;
  if (!path) return files;
  const overlay = JSON.parse(readFileSync(path, 'utf8')) as RuleFile;
  const out = files.map((f) => ({ ...f, entries: { ...f.entries } }));
  for (const [key, entry] of Object.entries(overlay.entries)) {
    const home = out.find((f) => key in f.entries) ?? out[out.length - 1];
    for (const f of out) delete f.entries[key];
    home.entries[key] = entry;
  }
  return out;
}

export const FILES = withOverlay([rulesJson, spellsJson, featuresJson] as unknown as RuleFile[]);

export interface Who {
  id: string;
  kind?: 'pc' | 'monster' | 'npc';
  side?: string;
  hp?: number;
  view: ViewInit;
}

export function setup(cs: Who[], o: { settings?: Partial<Settings>; layers?: RuleLayer[]; physical?: string[] } = {}) {
  const dice = scriptedDice();
  const rules = new RuleBook(FILES, o.layers ?? []);
  const s = new Session(createEncounter('t', o.settings), {
    rules,
    diceFor: (u) => (o.physical?.includes(u) ? physicalDice : dice),
  });
  for (const c of cs) {
    done(s.dispatch({ type: 'addCombatant', combatant: makeCombatant({ id: c.id, kind: c.kind, side: c.side, hp: c.hp, view: makeView(c.view) }) }));
  }
  return { s, dice, rules };
}

/**
 * 结算完成，且**没有规则出错**。
 * ruleError 的处理是「条件当 false、继续跑」—— 测试不盯着它的话，出错的规则可能碰巧让断言通过。
 */
export function done(r: DispatchResult): Extract<DispatchResult, { status: 'done' }> {
  if (r.status === 'pending') throw new Error(`还在等决定：${r.decision.prompt}`);
  if (r.status === 'rejected') throw new Error(`被拒绝：${r.reason}`);
  const errs = r.events.filter((e) => e.type === 'ruleError');
  if (errs.length) throw new Error(`规则出错：${errs.map((e) => `${e.payload.where}：${e.payload.message}`).join('\n')}`);
  return r;
}

export function pending(r: DispatchResult): Decision {
  if (r.status === 'rejected') throw new Error(`被拒绝：${r.reason}`);
  if (r.status !== 'pending') throw new Error('应该停下来等决定，但已经结算完了');
  return r.decision;
}

export const evs = (s: Session, type: string) => s.events.filter((e) => e.type === type).map((e) => e.payload as any);
export const last = (s: Session, type: string) => evs(s, type).at(-1);
export const has = (s: Session, id: string, cond: string) => s.peek((tx) => hasCondition(tx, id, cond));
export const effectNames = (s: Session, id: string) => Object.values(s.state.effects).filter((e) => e.bearer === id).map((e) => e.name).sort();

/* ---------------- 常用参与者 ---------------- */

export const LONGSWORD: AttackRow = { id: 'ls', name: '长剑', bonus: 5, damage: '1d8 + 3', damageType: '挥砍', melee: true, ranged: false, finesse: false, ability: 'str' };
export const SHORTBOW: AttackRow = { id: 'sb', name: '短弓', bonus: 4, damage: '1d6 + 2', damageType: '穿刺', melee: false, ranged: true, finesse: false, ability: 'dex', range: 80 };
export const RAPIER: AttackRow = { id: 'rp', name: '刺剑', bonus: 7, damage: '1d8 + 4', damageType: '穿刺', melee: true, ranged: false, finesse: true, ability: 'dex' };
export const SCIMITAR: AttackRow = { id: 'sc', name: '弯刀', bonus: 4, damage: '1d6 + 2', damageType: '挥砍', melee: true, ranged: false, finesse: true, ability: 'dex' };
export const GREATAXE: AttackRow = { id: 'ga', name: '巨斧', bonus: 5, damage: '1d12 + 3', damageType: '挥砍', melee: true, ranged: false, finesse: false, ability: 'str' };

export const fighter = (over: Partial<ViewInit> = {}, id = 'f'): Who => ({
  id, kind: 'pc',
  view: { name: '战士', score: { str: 16, dex: 14, con: 14 }, ac: 16, hpMax: 30, attacks: [LONGSWORD, SHORTBOW], ...over },
});
export const goblin = (id = 'g', over: Partial<ViewInit> = {}, hp?: number): Who => ({
  id, kind: 'monster', hp,
  view: { name: `地精${id}`, score: { str: 8, dex: 14 }, ac: 15, hpMax: 7, attacks: [SCIMITAR], ...over },
});
export const rogue = (over: Partial<ViewInit> = {}): Who => ({
  id: 'r', kind: 'pc',
  view: {
    name: '游荡者', score: { dex: 18 }, pb: 3, level: 5, hpMax: 30, attacks: [RAPIER], classTable: { 偷袭: '3d6' },
    sources: ['XPHB:游荡者:偷袭:1', 'XPHB:游荡者:直觉闪避:5'], ...over,
  },
});
export const cleric = (id = 'c', over: Partial<ViewInit> = {}): Who => ({
  id, kind: 'pc',
  view: {
    name: `牧师${id}`, score: { wis: 16 }, hpMax: 30, spell: { dc: 13, atk: 5, mod: 3, ability: 'wis' }, slots: { 1: 2, 2: 1, 3: 1 },
    sources: ['XPHB:spell:祝福术', 'XPHB:spell:定身类人', 'XPHB:spell:治愈真言'], ...over,
  },
});
export const wizard = (over: Partial<ViewInit> = {}): Who => ({
  id: 'w', kind: 'pc',
  view: {
    name: '法师', score: { int: 16 }, ac: 12, hpMax: 20, spell: { dc: 13, atk: 5, mod: 3, ability: 'int' }, slots: { 1: 2, 3: 1 },
    sources: ['XPHB:spell:护盾术', 'XPHB:spell:火球术'], ...over,
  },
});
export const barbarian = (over: Partial<ViewInit> = {}): Who => ({
  id: 'b', kind: 'pc',
  view: {
    name: '野蛮人', score: { str: 16, con: 14 }, level: 2, hpMax: 25, attacks: [GREATAXE],
    sources: ['XPHB:野蛮人:狂暴:1'], resources: { 狂暴: 2 }, classTable: { 狂暴伤害: 2 }, ...over,
  },
});
