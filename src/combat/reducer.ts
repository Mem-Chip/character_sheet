import type { ActiveEffect, Combatant, EncounterState, Economy, GameEvent, RememberedAnswer, Settings, Zone } from './types';

/**
 * Reducer：**唯一**修改遭遇状态的地方。
 *
 * 约定：
 * - 改状态的事件都带**绝对值**（hp = 12，而不是 -5）。重放、撤销、事后改结果都不会累积误差。
 * - 叙事事件（d20Rolled / attackHit / damageApplied …）不改状态，这里直接忽略。
 * - 传进来的 state 是事务自己的草稿（已经克隆过），这里原地修改。
 */
export function applyEvent(s: EncounterState, ev: GameEvent): void {
  s.seq = ev.seq;
  const p = ev.payload as Record<string, any>;
  const c = (id: string): Combatant => {
    const x = s.combatants[id];
    if (!x) throw new Error(`事件 ${ev.type} 指向不存在的参与者 ${id}`);
    return x;
  };
  switch (ev.type) {
    case 'zoneCreated': {
      const z = p.zone as Zone;
      (s.zones ??= {})[z.id] = structuredClone(z);
      const n = Number(/^z(\d+)$/.exec(z.id)?.[1]);
      if (Number.isFinite(n) && s.nextId <= n) s.nextId = n + 1;
      break;
    }
    case 'zoneRemoved':
      if (s.zones) delete s.zones[p.id as string];
      break;
    case 'zoneHit': {
      const z = s.zones?.[p.zone as string];
      if (z) z.hits[p.id as string] = p.at as string;
      break;
    }
    case 'combatantAdded': {
      const cb = p.combatant as Combatant;
      s.combatants[cb.id] = structuredClone(cb);
      const n = Number(/^s(\d+)$/.exec(cb.id)?.[1]);
      if (Number.isFinite(n) && s.nextId <= n) s.nextId = n + 1;
      if (s.round !== null && !s.order.includes(cb.id)) {
        const sumIdx = cb.summoner ? s.order.indexOf(cb.summoner) : -1;
        if (sumIdx >= 0) {
          let idx = sumIdx + 1;
          while (idx < s.order.length && s.combatants[s.order[idx]]?.summoner === cb.summoner) idx++;
          s.order.splice(idx, 0, cb.id);
          if (idx <= s.turnIndex) s.turnIndex++;
        } else {
          s.order.push(cb.id);
        }
      }
      break;
    }
    case 'baseRefreshed': {
      const cb = c(p.id as string);
      cb.base = structuredClone(p.base as Combatant['base']);
      cb.name = cb.base.name;
      cb.live.hp = Math.min(cb.live.hp, cb.base.hpMax);
      break;
    }
    case 'combatantRemoved': {
      const id = p.id as string;
      delete s.combatants[id];
      const i = s.order.indexOf(id);
      if (i >= 0) {
        s.order.splice(i, 1);
        if (i < s.turnIndex) s.turnIndex--;
        if (s.turnIndex >= s.order.length) s.turnIndex = 0;
      }
      for (const [eid, e] of Object.entries(s.effects)) if (e.bearer === id) delete s.effects[eid];
      break;
    }
    case 'combatStarted':
      s.order = (p.order as string[]).slice();
      s.round = 1;
      s.turnIndex = 0;
      break;
    case 'turnChanged':
      s.round = p.round as number;
      s.turnIndex = p.turnIndex as number;
      break;
    case 'combatEnded':
      s.round = null;
      s.turnIndex = 0;
      break;
    case 'initiativeSet':
      c(p.id).initiative = p.value as number;
      break;
    case 'economyReset':
      c(p.id).economy = structuredClone(p.economy as Economy);
      break;
    case 'economyChanged':
      Object.assign(c(p.id).economy, p.patch as Partial<Economy>);
      break;
    case 'onceUsed':
      c(p.id).economy.once[p.key as string] = p.at as string;
      break;
    case 'hpChanged': {
      const x = c(p.id);
      x.live.hp = p.hp as number;
      x.live.tempHp = p.tempHp as number;
      break;
    }
    case 'deathSavesChanged':
      c(p.id).live.deathSaves = { s: p.s as number, f: p.f as number };
      break;
    case 'stableChanged':
      c(p.id).live.stable = p.stable as boolean;
      break;
    case 'deadChanged':
      c(p.id).live.dead = p.dead as boolean;
      break;
    case 'resourceUsed':
      c(p.id).live.resourcesUsed[p.resource as string] = p.used as number;
      break;
    case 'slotUsed':
      c(p.id).live.slotsUsed[p.level as number] = p.used as number;
      break;
    case 'hitDieUsed':
      (c(p.id).live.hitDiceUsed ??= {})[p.faces as number] = p.used as number;
      break;
    case 'heroicInspirationChanged':
      c(p.id).live.heroicInspiration = p.value as boolean;
      break;
    case 'effectApplied': {
      const e = p.effect as ActiveEffect;
      s.effects[e.id] = structuredClone(e);
      // 只靠事件折叠重建状态时，id 计数器也要跟上（事务里分配 id 时已经推进过，这里是兜底）
      const n = Number(/^e(\d+)$/.exec(e.id)?.[1]);
      if (Number.isFinite(n) && s.nextId <= n) s.nextId = n + 1;
      break;
    }
    case 'effectEnded':
      delete s.effects[p.id as string];
      break;
    case 'effectUpdated': {
      const e = s.effects[p.id as string];
      if (e) Object.assign(e, structuredClone(p.patch as Partial<ActiveEffect>));
      break;
    }
    case 'answersRemembered':
      Object.assign(s.answers, p.answers as Record<string, RememberedAnswer>);
      break;
    case 'settingsChanged':
      Object.assign(s.settings, p.patch as Partial<Settings>);
      break;
    default:
      // 叙事事件：不改状态
      break;
  }
}

/** 会改状态的事件类型（审计与测试用：其余类型必须是纯叙事） */
export const STATE_EVENTS = new Set([
  'combatantAdded', 'combatantRemoved', 'baseRefreshed', 'combatStarted', 'turnChanged', 'combatEnded', 'initiativeSet',
  'economyReset', 'economyChanged', 'onceUsed', 'hpChanged', 'deathSavesChanged', 'stableChanged', 'deadChanged',
  'resourceUsed', 'slotUsed', 'hitDieUsed', 'heroicInspirationChanged', 'effectApplied', 'effectEnded', 'effectUpdated',
  'answersRemembered', 'settingsChanged',
]);
