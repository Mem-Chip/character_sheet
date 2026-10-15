/**
 * 地图布局顶上的先攻条：当前行动者排第一个、展开显示名字和伤势；其余的折叠成小圆片，悬停才展开名字。
 * 点一下选中，右键设为 / 取消目标（和地图上的棋子一样）。前面一行写清楚「第几轮、轮到谁、在等谁」。
 */
import type { Session } from '../../../src/combat';
import { combat, type CombatUi } from '../../lib/combat';
import { rosterOrder, type Namer } from './shared';

/** 不给玩家看具体数字时的伤势说法（2024 规则里「浴血」= 生命值不到一半） */
export function woundOf(hp: number, max: number): string {
  if (hp <= 0) return '倒地';
  if (hp >= max) return '完好';
  return hp * 2 <= max ? '浴血' : '受伤';
}

export function Initiative({ s, ui, name }: { s: Session; ui: CombatUi; name: Namer }) {
  const st = s.state;
  const inCombat = st.round !== null;
  const ids = rosterOrder(s).filter((id) => !combat.isHidden(id));
  const current = inCombat ? st.order[st.turnIndex] : null;
  // 当前的排第一个，后面按先攻往下数（一轮转回来）
  const at = current ? ids.indexOf(current) : -1;
  const order = at > 0 ? [...ids.slice(at), ...ids.slice(0, at)] : ids;
  const r = ui.remote;
  const pending = s.pending;

  let status: string;
  const verb = pending?.decision.kind === 'physicalDice' ? '掷骰' : '决定';
  if (pending) status = combat.isMyDecision() && r?.role !== 'dm' ? `该你${verb}` : `等${name(pending.decision.to)}${verb}`;
  else if (!inCombat) status = ids.length ? '战斗未开始' : '还没有参与者';
  else {
    // 谁在操作：归我的 → 轮到你了；没归属的（怪物、NPC）→ DM；归别的玩家 → 等那个人
    const owner = current && r ? r.owners[st.combatants[current]?.controller ?? ''] : undefined;
    if (!r || owner === r.me || (owner === undefined && r.role === 'dm')) status = '轮到你了';
    else if (owner === undefined) status = 'DM 操作中';
    else status = `等${name(current)}行动`;
  }

  return (
    <div className="ini">
      <div className="ini-status">
        {inCombat && <span className="ini-round">第 <b className="num">{st.round}</b> 轮</span>}
        <span className={'ini-what' + (status === '轮到你了' || status.startsWith('该你') ? ' me' : pending ? ' wait' : '')}>{status}</span>
      </div>
      <div className="ini-list">
        {order.map((id, i) => {
          const c = st.combatants[id];
          const secret = combat.isSecret(id);
          const hp = secret ? woundOf(c.live.hp, c.base.hpMax) : `${c.live.hp}/${c.base.hpMax}`;
          const bloodied = c.live.hp > 0 && c.live.hp * 2 <= c.base.hpMax;
          const cls = ['ini-chip', c.side === 'party' ? 'party' : c.side === 'enemy' ? 'enemy' : 'other',
            id === current && 'cur', i === 1 && inCombat && 'next', id === ui.selected && 'sel', ui.targets.includes(id) && 'tgt',
            c.live.dead && 'dead', bloodied && 'bloodied', r?.role === 'dm' && r.hidden.includes(id) && 'hid'].filter(Boolean).join(' ');
          return (
            <button
              key={id} className={cls} title={`${c.name} · ${hp}${c.initiative != null ? ` · 先攻 ${c.initiative}` : ''}`}
              onClick={() => combat.select(id)}
              onContextMenu={(e) => { e.preventDefault(); combat.toggleTarget(id); }}
            >
              <span className="ini-dot">{c.name.slice(0, 1)}</span>
              <span className="ini-name">{c.name}<small>{c.live.dead ? '死亡' : hp}</small></span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
