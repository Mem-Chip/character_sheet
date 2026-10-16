import { ABILS, type Ability } from '../expr';
import type { Combatant, CombatantView, Economy, LiveState } from './types';

/**
 * CombatantView 的构造（COMBAT-DESIGN §10.1）。
 *
 * PC 的 view 以后由人物卡管线生成（`fromSheet`，移植静态层时实现）；
 * 怪物由数据卡生成（第 3 步）。这里先提供「手搓」入口：测试、假目标、DM 临时加的杂兵都走它。
 */

export const modOf = (score: number) => Math.floor((score - 10) / 2);

export type ViewInit = Partial<Omit<CombatantView, 'score' | 'mod' | 'save'>> & {
  name: string;
  score?: Partial<Record<Ability, number>>;
  /** 豁免**熟练**的属性（加值自动 = 调整值 + 熟练加值） */
  saveProf?: Ability[];
  /** 直接指定豁免总值（覆盖上面的推算） */
  save?: Partial<Record<Ability, number>>;
};

export function makeView(init: ViewInit): CombatantView {
  const score = Object.fromEntries(ABILS.map((a) => [a, init.score?.[a] ?? 10])) as Record<Ability, number>;
  const mod = Object.fromEntries(ABILS.map((a) => [a, modOf(score[a])])) as Record<Ability, number>;
  const pb = init.pb ?? 2;
  const save = Object.fromEntries(ABILS.map((a) => [
    a,
    init.save?.[a] ?? mod[a] + (init.saveProf?.includes(a) ? pb : 0),
  ])) as Record<Ability, number>;
  return {
    name: init.name,
    size: init.size ?? '中型',
    type: init.type ?? '类人生物',
    ac: init.ac ?? 10 + mod.dex,
    hpMax: init.hpMax ?? 10,
    speed: init.speed ?? 30,
    pb,
    level: init.level ?? 1,
    levels: init.levels ?? {},
    score,
    mod,
    save,
    skill: init.skill ?? {},
    initiative: init.initiative ?? mod.dex,
    spell: init.spell ?? null,
    resist: init.resist ?? [],
    immune: init.immune ?? [],
    vuln: init.vuln ?? [],
    conditionImmune: init.conditionImmune ?? [],
    attacks: init.attacks ?? [],
    attacksPerAction: init.attacksPerAction ?? 1,
    sources: init.sources ?? [],
    resources: init.resources ?? {},
    resourceNames: init.resourceNames ?? {},
    slots: init.slots ?? {},
    classTable: init.classTable ?? {},
    wearing: init.wearing ?? [],
    ...(init.entries ? { entries: init.entries } : {}),
    ...(init.notes?.length ? { notes: init.notes } : {}),
  };
}

export function freshEconomy(view: CombatantView): Economy {
  return { action: 1, bonus: 1, reaction: 1, move: view.speed, attacksLeft: 0, slotSpellCast: false, once: {} };
}

export function freshLive(view: CombatantView): LiveState {
  return {
    hp: view.hpMax,
    tempHp: 0,
    deathSaves: { s: 0, f: 0 },
    resourcesUsed: {},
    slotsUsed: {},
    heroicInspiration: false,
    stable: false,
    dead: false,
  };
}

export interface CombatantInit {
  id: string;
  kind?: Combatant['kind'];
  controller?: string;
  side?: string;
  view: CombatantView;
  hp?: number;
}

export function makeCombatant(init: CombatantInit): Combatant {
  const live = freshLive(init.view);
  if (init.hp !== undefined) live.hp = init.hp;
  const kind = init.kind ?? 'monster';
  return {
    id: init.id,
    kind,
    name: init.view.name,
    controller: init.controller ?? (kind === 'pc' ? init.id : 'dm'),
    side: init.side ?? (kind === 'pc' ? 'party' : 'enemy'),
    base: init.view,
    live,
    economy: freshEconomy(init.view),
    initiative: null,
  };
}
