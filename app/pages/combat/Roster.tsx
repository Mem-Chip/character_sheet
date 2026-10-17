/** 参与者列表：先攻顺序、生命值、状态；点一下选中，点「目标」切换目标 */
import { tokenMenu } from './TokenMenu';
import type { Session } from '../../../src/combat';
import { Panel, Tag } from '../../components/ui';
import { Term } from '../../components/Term';
import { termOfEffect } from '../../lib/terms';
import { combat, type CombatUi } from '../../lib/combat';
import { woundOf } from './Initiative';
import { avatarOf, effectLabel, rosterOrder } from './shared';

export function Roster({ s, ui, onAddPc, onAddMonster }: { s: Session; ui: CombatUi; onAddPc: () => void; onAddMonster: () => void }) {
  const st = s.state;
  // 玩家看不到 DM 藏起来的
  const ids = rosterOrder(s).filter((id) => !combat.isHidden(id));
  const dmRemote = ui.remote?.role === 'dm';
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
        const v = s.view(id);
        const max = v.hpMax;
        const pct = max ? Math.max(0, Math.min(100, (c.live.hp / max) * 100)) : 0;
        const effects = Object.values(st.effects).filter((e) => e.bearer === id);
        const down = c.live.hp === 0 && !c.live.dead;
        const isTarget = ui.targets.includes(id);
        const secret = combat.isSecret(id);
        const hiddenNow = dmRemote && ui.remote!.hidden.includes(id);
        const av = avatarOf(s, ui, id);
        return (
          <div
            key={id}
            className={['cbt', id === ui.selected && 'sel', id === current && 'turn', c.live.dead && 'dead', isTarget && 'is-tgt', hiddenNow && 'is-hidden'].filter(Boolean).join(' ')}
            onClick={() => combat.clickCombatant(id)}
            onContextMenu={(e) => tokenMenu(e, id, ui)}
          >
            <span className="init">{c.initiative ?? '—'}</span>
            <span className="nm">
              {av && <img className="cbt-av" src={av} alt="" />}
              {c.name}
              {c.summoner && <span className="tiny faint" style={{ marginLeft: 4 }}>（{st.combatants[c.summoner]?.name ?? c.summoner}）</span>}
              <span className={'faction ' + (c.side === 'party' ? 'party' : c.side === 'enemy' ? 'enemy' : '')}>{c.side === 'party' ? '友' : c.side === 'enemy' ? '敌' : c.side}</span>
            </span>
            {secret
              ? <span className="hp small muted">{c.live.dead ? '' : woundOf(c.live.hp, max)}</span>
              : (
                <span className="hp num">
                  {c.live.hp}<span className="faint">/{max}</span>{c.live.tempHp ? <span className="tmp"> +{c.live.tempHp}</span> : null}
                </span>
              )}
            <div className="side">
              {!secret && <div className={'hpbar' + (pct <= 35 ? ' low' : '')} style={{ flexBasis: '100%' }}><i style={{ width: `${pct}%` }} /></div>}
              {hiddenNow && <Tag tone="warn">玩家看不到</Tag>}
              {c.live.dead && <Tag tone="danger">死亡</Tag>}
              {down && <Tag tone="danger">{c.live.stable ? '稳定' : `濒死 ${c.live.deathSaves.s}✓ ${c.live.deathSaves.f}✗`}</Tag>}
              {effects.map((e) => {
                const t = termOfEffect(e);
                const lb = effectLabel(e.name);
                const txt = e.key === 'concentration' ? `专注·${e.name}` : e.form ? `${e.name}·${e.form.name}` : e.name;
                return (
                  <Tag key={e.id} tone={e.key === 'concentration' || e.form ? 'accent' : undefined} title={e.suppressed ? '被同名效应压制' : undefined}>
                    <span style={e.suppressed ? { opacity: 0.5 } : undefined}>
                      {lb.cond
                        ? <><Term kind="condition" name={lb.cond}>{lb.text}</Term>{lb.from && <small className="faint"> · {t ? <Term {...t}>{lb.from}</Term> : lb.from}</small>}</>
                        : t ? <Term {...t}>{txt}</Term> : txt}
                    </span>
                  </Tag>
                );
              })}
              <span style={{ flex: 1 }} />
              {dmRemote && (
                <button className="btn ghost sm" onClick={(ev) => { ev.stopPropagation(); combat.setHidden(id, !hiddenNow); }} title={hiddenNow ? '让玩家看到它' : '对玩家藏起来（列表、地图、日志里都不显示）'}>
                  {hiddenNow ? '亮出' : '藏起'}
                </button>
              )}
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

