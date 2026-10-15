/**
 * 地图布局底部的行动栏：选中者的状态 | 分组的动作（小按钮，悬停看原文）| 结束回合。
 * 只放每回合都用的东西；效应、手动调整、资源明细在「详情」抽屉里（完整的 Actor 面板）。
 */
import { useMemo, useState } from 'react';
import type { Json } from '../../../src/sheet';
import type { Session } from '../../../src/combat';
import { Term } from '../../components/Term';
import { termOfKey } from '../../lib/terms';
import { combat, type CombatUi } from '../../lib/combat';
import type { Engine } from '../../lib/engine';
import { COST_CN, CostIcon, actionsFor, costKind, freeSlots, runAction, type ActItem, type CostKind, type Group } from './Actor';
import { woundOf } from './Initiative';
import type { Namer } from './shared';

/** 动作分页：未自动化的法术并进「法术」；时机能力只是列出来让人知道 */
const TABS: Array<{ k: string; label: string; groups: Group[] }> = [
  { k: 'weapon', label: '武器', groups: ['武器攻击'] },
  { k: 'spell', label: '法术', groups: ['法术', '法术（未自动化）'] },
  { k: 'feature', label: '特性', groups: ['特性'] },
  { k: 'general', label: '通用', groups: ['通用动作'] },
  { k: 'timed', label: '时机', groups: ['时机到了会问'] },
];

/** 选目标模式的条：选了谁（可重复的显示 ×N）、还能选几个、确认 / 取消 */
export function AimBar({ ui, name }: { ui: CombatUi; name: Namer }) {
  const a = ui.aim;
  if (!a) return null;
  const counts = new Map<string, number>();
  for (const p of a.picks) counts.set(p, (counts.get(p) ?? 0) + 1);
  return (
    <div className="aimbar">
      <div className="aim-head">
        <b className="serif">「{a.name}」选目标</b>
        <span className="num">{a.picks.length}{a.max != null ? ` / ${a.max}` : ''}</span>
        <span className="tiny faint">{a.repeat ? '同一个可以选好几次 · ' : ''}点棋子或先攻条里的人加进来，右键去掉{a.max != null && a.max > 1 ? '；可以少选' : ''}</span>
      </div>
      <div className="aim-picks">
        {[...counts].map(([id, n]) => (
          <button key={id} className="tag" onClick={() => combat.aimUnpick(id)} title="去掉一个">{name(id)}{n > 1 ? ` ×${n}` : ''} ✕</button>
        ))}
        {!a.picks.length && <span className="faint small">还没选。</span>}
        <span style={{ flex: 1 }} />
        <button className="btn sm" onClick={combat.aimCancel}>取消</button>
        <button className="btn primary" disabled={!a.picks.length} onClick={combat.aimConfirm}>确认{a.cmd.type === 'useAction' && a.cmd.slotLevel ? `（${a.cmd.slotLevel} 环）` : ''}</button>
      </div>
    </div>
  );
}

export function Hotbar({ s, ui, engine, name, onDetail, turnButton }: {
  s: Session; ui: CombatUi; engine: Engine; name: Namer; onDetail: () => void; turnButton: React.ReactNode;
}) {
  const id = ui.selected && s.state.combatants[ui.selected] && !combat.isHidden(ui.selected) ? ui.selected : null;
  const spells: Json[] = engine.env.store.data.spellsXphb?.spell || [];
  const items = useMemo(() => (id && !combat.isSecret(id) ? actionsFor(s, engine.rules, spells, id) : []), [s, engine.rules, spells, id, ui.version]);
  const [tab, setTab] = useState('weapon');
  const [pick, setPick] = useState<string | null>(null);
  const [asReaction, setAsReaction] = useState(false);

  if (!id) return <div className="hotbar"><div className="hot-empty muted small">点地图上的棋子或者先攻条里的人，选中谁就在这里操作谁。</div><div className="hot-end">{turnButton}</div></div>;

  const c = s.state.combatants[id];
  const v = s.view(id);
  const inCombat = s.state.round !== null;
  const effects = Object.values(s.state.effects).filter((e) => e.bearer === id);
  const mine = combat.canControl(id);
  const r = ui.remote;
  // 玩家看自己的角色不用再写名字（先攻条里有）；DM 换着操作好几个，要写
  const showName = !r || r.role === 'dm' || !mine;

  const effTags = effects.length > 0 && (
    <div className="hot-effects">
      {effects.map((e) => {
        const t = termOfKey(String(e.key ?? ''));
        return <span key={e.id} className={'tag' + (e.key === 'concentration' ? ' accent' : '')}>{e.key === 'concentration' ? `专注·${e.name}` : t ? <Term {...t}>{e.name}</Term> : e.name}</span>;
      })}
    </div>
  );

  // 玩家看怪物：只有外表
  if (combat.isSecret(id)) {
    return (
      <div className="hotbar">
        <div className="hot-status">
          <div className="hot-name serif">{c.name}<small>{v.size} {v.type}</small></div>
          <div className="hot-wound">{c.live.dead ? '已经死亡' : woundOf(c.live.hp, v.hpMax)}</div>
          {effTags}
        </div>
        <div className="hot-actions muted small" style={{ alignSelf: 'center' }}>具体数值只有 DM 看得到。</div>
        <div className="hot-end">{turnButton}</div>
      </div>
    );
  }

  const tabs = TABS.map((t) => ({ ...t, list: items.filter((x) => t.groups.includes(x.group)) })).filter((t) => t.list.length);
  const cur = tabs.find((t) => t.k === tab) ?? tabs[0];
  const econ = c.economy;
  const slots = Object.entries(v.slots).filter(([, n]) => n > 0);
  const pct = v.hpMax ? Math.max(0, Math.min(100, (c.live.hp / v.hpMax) * 100)) : 0;

  const click = (it: ActItem) => {
    if (it.passive || !mine) return;
    const avail = it.slot ? freeSlots(s, id, it.slot.min, it.slot.max) : [];
    if (avail.length > 1) { setPick(pick === it.ref ? null : it.ref); return; }
    setPick(null);
    runAction(s, ui, id, it, undefined, asReaction);
  };

  return (
    <div className="hotbar">
      <div className="hot-status">
        {showName && <div className="hot-name serif">{c.name}<small>{c.kind === 'pc' ? '角色' : c.kind === 'npc' ? 'NPC' : '怪物'}</small></div>}
        <div className="hot-vitals">
          <div className="hot-hp">
            <b className="hot-big">{c.live.hp}<small>/{v.hpMax}</small></b>
            {c.live.tempHp ? <span className="hot-tmp">+{c.live.tempHp}</span> : null}
            <div className={'hpbar' + (pct <= 50 ? ' low' : '')}><i style={{ width: `${pct}%` }} /></div>
          </div>
          <div className="hot-stat"><span>AC</span><b>{v.ac}</b></div>
          <div className="hot-stat"><span>{inCombat ? '移动' : '速度'}</span><b>{inCombat ? econ.move : v.speed}<small>尺</small></b></div>
        </div>
        {inCombat && (
          <div className="hot-econ">
            <span className={econ.action ? 'on' : ''}>动作</span>
            <span className={econ.bonus ? 'on' : ''}>附赠</span>
            <span className={econ.reaction ? 'on' : ''}>反应</span>
            {econ.attacksLeft > 0 && <span className="on">攻击 ×{econ.attacksLeft}</span>}
          </div>
        )}
        {slots.length > 0 && (
          <div className="hot-slots">
            {slots.map(([L, n]) => {
              const left = n - (c.live.slotsUsed[Number(L)] ?? 0);
              return <span key={L} title={`${L} 环法术位：剩 ${left} / ${n}`}><i>{L}</i>{Array.from({ length: n }, (_, k) => <b key={k} className={k < left ? 'on' : ''} />)}</span>;
            })}
          </div>
        )}
        {c.live.hp === 0 && !c.live.dead && c.kind === 'pc' && <div className="dangerline">死亡豁免 {c.live.deathSaves.s}✓ {c.live.deathSaves.f}✗</div>}
        {effTags}
      </div>

      {ui.aim ? <div className="hot-actions"><AimBar ui={ui} name={name} /></div> : <div className="hot-actions">
        <div className="hot-tabs">
          {tabs.map((t) => (
            <button key={t.k} className={t.k === cur?.k ? 'on' : ''} onClick={() => { setTab(t.k); setPick(null); }}>{t.label}<small>{t.list.length}</small></button>
          ))}
          <span style={{ flex: 1 }} />
          <span className="cost-legend">{(['action', 'bonus', 'reaction', 'free'] as CostKind[]).map((k) => <span key={k}><CostIcon kind={k} />{COST_CN[k].replace('动作', '') || '动作'}</span>)}</span>
          {cur?.k === 'weapon' && <label className="tiny faint"><input type="checkbox" checked={asReaction} onChange={(e) => setAsReaction(e.target.checked)} /> 用反应攻击</label>}
        </div>
        <div className="hot-grid">
          {!cur && <span className="faint small">没有可用的动作。</span>}
          {cur?.list.map((it) => {
            const avail = it.slot ? freeSlots(s, id, it.slot.min, it.slot.max) : [];
            return (
              <span key={it.ref} className="hot-act-wrap">
                <button
                  className={'hot-act' + (it.ok ? '' : ' no') + (it.passive ? ' passive' : '') + (pick === it.ref ? ' open' : '')}
                  onClick={() => click(it)} disabled={!mine && !it.passive}
                  title={it.term ? undefined : [it.sub, it.why].filter(Boolean).join('\n')}
                >
                  <CostIcon kind={costKind(it, asReaction)} />
                  {it.term ? <Term {...it.term} inButton>{it.name}</Term> : it.name}
                  {it.slot && <small>{avail.length ? `${avail[0]}环` : '无位'}</small>}
                </button>
                {pick === it.ref && (
                  <span className="hot-pick">
                    {avail.map((L) => <button key={L} className="btn sm" onClick={() => { setPick(null); runAction(s, ui, id, it, L, asReaction); }}>{L} 环</button>)}
                  </span>
                )}
              </span>
            );
          })}
        </div>
      </div>}

      <div className="hot-end">
        {turnButton}
        <button className="btn sm" onClick={onDetail} title="效应、手动调整、资源明细、检定">详情</button>
      </div>
    </div>
  );
}
