import type { Session } from '../../../src/combat';
import type { CombatUi } from '../../lib/combat';
import { getApp } from '../../lib/store';

export type Namer = (id: unknown) => string;

/** id → 名字：现在在场的 + 日志里出现过的（被移出遭遇的也要能显示名字） */
export function namer(s: Session): Namer {
  const map: Record<string, string> = {};
  for (const t of s.transactions) {
    const cmd = t.input.cmd;
    if (cmd.type === 'addCombatant') map[cmd.combatant.id] = cmd.combatant.name;
    for (const ev of t.events) {
      if (ev.type === 'combatantAdded') {
        const c = ev.payload.combatant as { id?: string; name?: string } | undefined;
        if (c?.id && c?.name) map[c.id] = c.name;
      }
    }
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

export const CONDITIONS = ['目盲', '魅惑', '耳聋', '力竭', '恐慌', '受擒', '失能', '隐形', '麻痹', '石化', '中毒', '倒地', '束缚', '震慑', '昏迷'];
/**
 * 效应怎么显示：法术带来的状态在数据里叫「睡眠术：失能」（带着法术自己的持续时间和触发），
 * 机制上它就是失能（implies 了真正的状态），所以显示成状态名，来源另外写。
 */
export function effectLabel(name: string): { cond: string | null; text: string; from: string | null } {
  const m = /^(.+)：(.+)$/.exec(name);
  if (m) return { cond: CONDITIONS.includes(m[2]) ? m[2] : null, text: m[2], from: m[1] };
  if (CONDITIONS.includes(name)) return { cond: name, text: name, from: null };
  return { cond: null, text: name, from: null };
}

/** 参与者立绘：优先地图上临时覆盖的立绘，其次角色/怪物的 base.avatar，再次关联人物卡的 portrait */
export function avatarOf(s: Session, ui: CombatUi, id: string): string | null {
  const mapAv = ui.remote?.map.avatars?.[id];
  if (mapAv) return mapAv;
  const c = s.state.combatants[id];
  if (c?.base.avatar) return c.base.avatar;
  const cardId = ui.links[id];
  if (cardId) {
    const p = getApp().cards[cardId]?.char.profile?.portrait;
    if (typeof p === 'string' && p) return p;
  }
  return null;
}

/** 将上传的图片居中裁切成正方形缩略图（默认 160×160 WebP dataURL），体积约 5~15KB */
export async function cropAvatarFile(file: File, size = 160): Promise<string> {
  const img = await createImageBitmap(file);
  const side = Math.min(img.width, img.height);
  const sx = Math.floor((img.width - side) / 2);
  const sy = Math.floor((img.height - side) / 2);
  const cv = document.createElement('canvas');
  cv.width = size;
  cv.height = size;
  cv.getContext('2d')!.drawImage(img, sx, sy, side, side, 0, 0, size, size);
  let dataUrl = cv.toDataURL('image/webp', 0.85);
  if (!dataUrl.startsWith('data:image/webp')) dataUrl = cv.toDataURL('image/jpeg', 0.85);
  return dataUrl;
}

