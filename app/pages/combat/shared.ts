import type { Session } from '../../../src/combat';

export type Namer = (id: unknown) => string;

/** id → 名字：现在在场的 + 日志里出现过的（被移出遭遇的也要能显示名字） */
export function namer(s: Session): Namer {
  const map: Record<string, string> = {};
  for (const t of s.transactions) {
    const cmd = t.input.cmd;
    if (cmd.type === 'addCombatant') map[cmd.combatant.id] = cmd.combatant.name;
  }
  for (const [id, c] of Object.entries(s.state.combatants)) map[id] = c.name;
  return (id) => (id == null ? '—' : map[String(id)] ?? String(id));
}

/** 参与者的显示顺序：战斗中按先攻，战斗外按加入顺序 */
export function rosterOrder(s: Session): string[] {
  const all = Object.keys(s.state.combatants);
  if (s.state.round === null) return all;
  return [...s.state.order.filter((id) => s.state.combatants[id]), ...all.filter((id) => !s.state.order.includes(id))];
}

export const DAMAGE_TYPES = ['钝击', '穿刺', '挥砍', '火焰', '寒冷', '闪电', '雷鸣', '强酸', '毒素', '黯蚀', '光耀', '心灵', '力场'];
export const CREATURE_TYPES = ['类人生物', '野兽', '不死生物', '邪魔', '天界生物', '精类', '构装生物', '龙类', '元素生物', '巨人', '怪兽', '泥怪', '植物', '异怪'];
