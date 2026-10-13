/** 参与者列表：先攻顺序、生命值、状态；点一下选中，点「目标」切换目标 */
import type { Session } from '../../../src/combat';
import { Panel, Tag } from '../../components/ui';
import { combat, type CombatUi } from '../../lib/combat';
import { rosterOrder } from './shared';

export function Roster({ s, ui, onAddPc, onAddMonster }: { s: Session; ui: CombatUi; onAddPc: () => void; onAddMonster: () => void }) {
  const st = s.state;
  const ids = rosterOrder(s);
  const current = st.round !== null ? st.order[st.turnIndex] : null;
  return (
    <Panel
      title="参与者"
      flush
      aside={<>
        <button className="btn sm" onClick={onAddPc}>+ 角色</button>
        <button className="btn sm" onClick={onAddMonster}>+ 怪物</button>
      </>}
    >
      {ids.length === 0 && <div className="empty">还没有人。从卡片库加角色，或者加几个怪物。</div>}
      {ids.map((id) => {
        const c = st.combatants[id];
        const max = c.base.hpMax;
        const pct = max ? Math.max(0, Math.min(100, (c.live.hp / max) * 100)) : 0;
        const effects = Object.values(st.effects).filter((e) => e.bearer === id);
        const down = c.live.hp === 0 && !c.live.dead;
        const isTarget = ui.targets.includes(id);
        return (
          <div
            key={id}
            className={['cbt', id === ui.selected && 'sel', id === current && 'turn', c.live.dead && 'dead', isTarget && 'is-tgt'].filter(Boolean).join(' ')}
            onClick={() => combat.select(id)}
          >
            <span className="init">{c.initiative ?? '—'}</span>
            <span className="nm">
              {c.name}
              <span className={'faction ' + (c.side === 'party' ? 'party' : c.side === 'enemy' ? 'enemy' : '')}>{c.side === 'party' ? '友' : c.side === 'enemy' ? '敌' : c.side}</span>
            </span>
            <span className="hp num">
              {c.live.hp}<span className="faint">/{max}</span>{c.live.tempHp ? <span className="tmp"> +{c.live.tempHp}</span> : null}
            </span>
            <div className="side">
              <div className={'hpbar' + (pct <= 35 ? ' low' : '')} style={{ flexBasis: '100%' }}><i style={{ width: `${pct}%` }} /></div>
              {c.live.dead && <Tag tone="danger">死亡</Tag>}
              {down && <Tag tone="danger">{c.live.stable ? '稳定' : `濒死 ${c.live.deathSaves.s}✓ ${c.live.deathSaves.f}✗`}</Tag>}
              {effects.map((e) => (
                <Tag key={e.id} tone={e.key === 'concentration' ? 'accent' : undefined} title={e.suppressed ? '被同名效应压制' : undefined}>
                  <span style={e.suppressed ? { opacity: 0.5 } : undefined}>{e.key === 'concentration' ? `专注·${e.name}` : e.name}</span>
                </Tag>
              ))}
              <span style={{ flex: 1 }} />
              <button
                className={'btn sm tgtbtn' + (isTarget ? ' on' : '')}
                onClick={(ev) => { ev.stopPropagation(); combat.toggleTarget(id); }}
                title="把它设为 / 取消为当前动作的目标"
              >{isTarget ? '已选为目标' : '目标'}</button>
            </div>
          </div>
        );
      })}
    </Panel>
  );
}
