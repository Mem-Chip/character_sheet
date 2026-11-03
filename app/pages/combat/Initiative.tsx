/**
 * 地图布局顶上的先攻条：当前行动者排第一个、展开显示名字和伤势；其余的折叠成小圆片，悬停才展开名字。
 * 点一下选中，右键开菜单（和地图上的棋子一样）。前面一行写清楚「第几轮、轮到谁、在等谁」。
 */
import { useState } from 'react';
import { tokenMenu } from './TokenMenu';
import type { Session } from '../../../src/combat';
import { combat, type CombatUi } from '../../lib/combat';
import { avatarOf, rosterOrder, type Namer } from './shared';

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
  // 当前的排第一个，后面按先攻往下数（一轮转回来）；没进先攻的（移出了的）排在最后
  const inOrder = ids.filter((id) => !inCombat || st.order.includes(id));
  const at = current ? inOrder.indexOf(current) : -1;
  const order = [...(at > 0 ? [...inOrder.slice(at), ...inOrder.slice(0, at)] : inOrder), ...ids.filter((id) => !inOrder.includes(id))];
  const r = ui.remote;
  const pending = s.pending;
  // DM 战斗中拖动改顺序：轮到的人不能拖、也不能被插到前面（他的回合进行到一半）
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const canDrag = (id: string) => inCombat && (!r || r.role === 'dm') && id !== current && !pending;
  const drop = (target: string) => {
    const from = dragId;
    setDragId(null); setOverId(null);
    if (!from || from === target || target === current) return;
    // 显示顺序（当前行动者在第一个）→ 改完 → 按原来的轮次起点转回去（谁在第一位决定「一轮」从哪开始）
    const shown = st.order.slice(st.turnIndex).concat(st.order.slice(0, st.turnIndex));
    const fromAt = shown.indexOf(from);
    const rest = shown.filter((x) => x !== from);
    let to = rest.indexOf(target);
    if (to < 0) return;
    // 往后拖放到目标后面，往前拖（或从「没进先攻」里拖进来）放到目标前面
    if (fromAt >= 0 && fromAt < shown.indexOf(target)) to += 1;
    const next = [...rest.slice(0, to), from, ...rest.slice(to)];
    const k = next.length - st.turnIndex;
    combat.dispatch({ type: 'setOrder', order: [...next.slice(k % next.length), ...next.slice(0, k % next.length)] });
  };

  let status: string;
  const verb = pending?.decision.kind === 'physicalDice' ? '掷骰' : '决定';
  if (pending) status = combat.isMyDecision() && (r?.role !== 'dm' || r.actingAs === pending.decision.to) ? `该你${verb}` : `等${name(pending.decision.to)}${verb}`;
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
          const av = avatarOf(s, ui, id);
          const cls = ['ini-chip', c.side === 'party' ? 'party' : c.side === 'enemy' ? 'enemy' : 'other',
            id === current && 'cur', i === 1 && inCombat && 'next', id === ui.selected && 'sel', ui.targets.includes(id) && 'tgt',
            c.live.dead && 'dead', bloodied && 'bloodied', r?.role === 'dm' && r.hidden.includes(id) && 'hid',
            inCombat && !st.order.includes(id) && 'out', dragId === id && 'dragging', overId === id && dragId !== id && 'drop'].filter(Boolean).join(' ');
          const out = inCombat && !st.order.includes(id);
          return (
            <button
              key={id} className={cls}
              title={`${c.name} · ${hp}${c.initiative != null ? ` · 先攻 ${c.initiative}` : ''}${out ? ' · 不在先攻里（右键加入，或拖进队列）' : ''}${canDrag(id) ? ' · 拖动改顺序' : ''}`}
              onClick={() => combat.clickCombatant(id)}
              onContextMenu={(e) => tokenMenu(e, id, ui)}
              draggable={canDrag(id)}
              onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; setDragId(id); }}
              onDragEnd={() => { setDragId(null); setOverId(null); }}
              onDragOver={(e) => { if (dragId && !out && id !== current) { e.preventDefault(); if (overId !== id) setOverId(id); } }}
              onDragLeave={() => { if (overId === id) setOverId(null); }}
              onDrop={(e) => { e.preventDefault(); drop(id); }}
            >
              <span className="ini-dot">{av ? <img src={av} alt="" /> : c.name.slice(0, 1)}</span>
              <span className="ini-name">{c.name}<small>{c.live.dead ? '死亡' : hp}</small></span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

