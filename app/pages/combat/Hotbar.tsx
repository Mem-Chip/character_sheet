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
import { setResHidden, useHiddenRes } from '../../lib/hotres';
import { Clip } from '../../components/ui';
import type { Engine } from '../../lib/engine';
import { CostIcon, actionsFor, costKind, freeSlots, runAction, type ActItem, type Group } from './Actor';
import { woundOf } from './Initiative';
import { effectLabel } from './shared';
import type { Namer } from './shared';

const ECON_CN = { action: '动作', bonus: '附赠', reaction: '反应' } as const;

/** 动作分页：未自动化的法术并进「法术」；时机能力只是列出来让人知道 */
const TABS: Array<{ k: string; label: string; groups: Group[] }> = [
  { k: 'weapon', label: '武器', groups: ['武器攻击'] },
  { k: 'spell', label: '法术', groups: ['法术', '法术（未自动化）'] },
  { k: 'feature', label: '特性', groups: ['特性'] },
  { k: 'item', label: '物品', groups: ['物品'] },
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
        <span className="tiny faint">
          {a.area
            ? `在地图上点一下放范围${a.area.self ? (a.area.area.shape === 'emanation' || a.area.area.shape === 'sphere' || a.area.area.shape === 'cylinder' ? '（以你为中心）' : '（从你身上出发，跟着鼠标转向）') : ''}，圈里的人自动选中；先攻条里点人可以加减`
            : `${a.repeat ? '同一个可以选好几次 · ' : ''}点棋子或先攻条里的人加进来，右键去掉${a.max != null && a.max > 1 ? '；可以少选' : ''}`}
          {a.range != null && !a.area?.self ? ` · 射程 ${a.range} 尺` : ''}
        </span>
      </div>
      <div className="aim-picks">
        {[...counts].map(([id, n]) => (
          <button key={id} className="tag" onClick={() => combat.aimUnpick(id)} title="去掉一个">{combat.isHidden(id) ? '看不见的东西' : name(id)}{n > 1 ? ` ×${n}` : ''} ✕</button>
        ))}
        {!a.picks.length && <span className="faint small">还没选。</span>}
        <span style={{ flex: 1 }} />
        <button className="btn sm" onClick={combat.aimCancel}>取消</button>
        <button className="btn primary" disabled={!a.picks.length && !a.placed} onClick={combat.aimConfirm}>确认{a.cmd.type === 'useAction' && a.cmd.slotLevel ? `（${a.cmd.slotLevel} 环）` : ''}</button>
      </div>
    </div>
  );
}

export function Hotbar({ s, ui, engine, name, onDetail, turnButton, collapsed, onToggle }: {
  s: Session; ui: CombatUi; engine: Engine; name: Namer; onDetail: () => void; turnButton: React.ReactNode; collapsed: boolean; onToggle: () => void;
}) {
  const id = ui.selected && s.state.combatants[ui.selected] && !combat.isHidden(ui.selected) ? ui.selected : null;
  const spells: Json[] = engine.env.store.data.spellsXphb?.spell || [];
  const items = useMemo(() => (id && !combat.isSecret(id) ? actionsFor(s, engine.rules, spells, id) : []), [s, engine.rules, spells, id, ui.version]);
  const [tab, setTab] = useState('weapon');
  /** 升环：点左边的法术位选一个环阶，下一个法术就按这一环放（放完回到默认的最低环）；换人就清掉 */
  const [castAt, setCastAt] = useState<{ id: string; L: number } | null>(null);
  const [asReaction, setAsReaction] = useState(false);
  const hiddenRes = useHiddenRes(id ?? '');

  const fold = <button className="btn ghost sm hot-fold" onClick={onToggle} title={collapsed ? '展开行动栏' : '收起行动栏'}>{collapsed ? '展开' : '收起'}</button>;
  // 收起：一行，只剩名字、生命值和结束回合
  if (collapsed) {
    const c0 = id ? s.state.combatants[id] : null;
    const secret = !!id && combat.isSecret(id);
    return (
      <div className="hotbar folded">
        <div className="hot-fold-row">
          {c0 ? <><b className="serif">{c0.name}</b>{!secret && <span className="num">{c0.live.hp}/{s.view(id!).hpMax}</span>}</> : <span className="muted small">没选中人</span>}
          <span style={{ flex: 1 }} />
          {turnButton}
          {fold}
        </div>
      </div>
    );
  }

  if (!id) return <div className="hotbar"><div className="hot-empty muted small">点地图上的棋子或者先攻条里的人，选中谁就在这里操作谁。</div><div className="hot-end">{turnButton}{fold}</div></div>;

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
        if (e.key === 'concentration') {
          return (
            <span key={e.id} className="tag accent">
              专注·{e.name}
              {combat.canControl(id) && <button className="tag-x" title="结束专注" onClick={() => combat.dispatch({ type: 'endConcentration', id })}>✕</button>}
            </span>
          );
        }
        // 「睡眠术：失能」显示成失能（悬停看状态原文），来源小字
        const lb = effectLabel(e.name);
        if (lb.cond) return <span key={e.id} className="tag"><Term kind="condition" name={lb.cond}>{lb.text}</Term>{lb.from && <small className="faint"> · {lb.from}</small>}</span>;
        return <span key={e.id} className="tag">{t ? <Term {...t}>{e.name}</Term> : e.name}</span>;
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
        <div className="hot-end">{turnButton}{fold}</div>
      </div>
    );
  }

  const tabs = TABS.map((t) => ({ ...t, list: items.filter((x) => t.groups.includes(x.group)) })).filter((t) => t.list.length);
  const cur = tabs.find((t) => t.k === tab) ?? tabs[0];
  const econ = c.economy;
  const resList = Object.entries(v.resources).filter(([k, n]) => n > 0 && !hiddenRes.includes(k) && !k.startsWith('物品:'));
  const slots = Object.entries(v.slots).filter(([, n]) => n > 0);
  const pct = v.hpMax ? Math.max(0, Math.min(100, (c.live.hp / v.hpMax) * 100)) : 0;

  const at = castAt?.id === id ? castAt.L : null;
  /** 选了环阶时，这个法术能不能用这一环放 */
  const fits = (it: ActItem) => !it.slot || at == null || (it.slot.min <= at && at <= (it.slot.max ?? 9));
  const click = (it: ActItem) => {
    if (it.passive || !mine || !fits(it)) return;
    // 默认按最低的可用环；选了环阶就按那一环（放完回到默认）
    runAction(s, ui, id, it, it.slot && at != null ? at : undefined, asReaction);
    if (it.slot && at != null) setCastAt(null);
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
            {/* 点一下在「可用 / 已用」之间切换（裁定、规则没覆盖到的额外动作），记进日志 */}
            {(['action', 'bonus', 'reaction'] as const).map((k) => (
              <button key={k} className={econ[k] ? 'on' : ''} disabled={!mine}
                title={`${ECON_CN[k]}：${econ[k] ? `可用${econ[k] > 1 ? ` ×${econ[k]}` : ''}` : '已用'}。点一下手动改成${econ[k] ? '已用' : '可用'}`}
                onClick={() => combat.dispatch({ type: 'setEconomy', id, patch: { [k]: econ[k] ? 0 : 1 } })}>
                <CostIcon kind={k} />{ECON_CN[k]}{econ[k] > 1 ? `×${econ[k]}` : ''}
              </button>
            ))}
            {econ.attacksLeft > 0 && <span className="on">攻击 ×{econ.attacksLeft}</span>}
          </div>
        )}
        {slots.length > 0 && (
          <div className="hot-slots">
            {slots.map(([L, n]) => {
              const left = n - (c.live.slotsUsed[Number(L)] ?? 0);
              const on = at === Number(L);
              return (
                <button
                  key={L} className={'slot-pick' + (on ? ' on' : '')} disabled={!left || !mine}
                  title={on ? '取消：回到默认（最低环）' : `${L} 环法术位：剩 ${left} / ${n}。点一下，下一个法术按 ${L} 环放`}
                  onClick={() => setCastAt(on ? null : { id, L: Number(L) })}
                >
                  <i>{L}</i>{Array.from({ length: n }, (_, k) => <b key={k} className={k < left ? 'on' : ''} />)}
                </button>
              );
            })}
          </div>
        )}
        {resList.length > 0 && (
          <div className="hot-res">
            {resList.map(([k, n]) => {
              const used = c.live.resourcesUsed[k] ?? 0;
              const set = (u: number) => combat.dispatch({ type: 'setUsage', id, resource: k, used: Math.max(0, Math.min(n, u)) });
              return (
                <span key={k} className={'hot-res-item' + (used >= n ? ' empty' : '')}>
                  <Clip text={(v.resourceNames ?? {})[k] ?? k} />
                  <b className="num">{n - used}<small>/{n}</small></b>
                  {mine && <>
                    <button className="tag-x" disabled={used >= n} onClick={() => set(used + 1)} title="用掉 1">−</button>
                    <button className="tag-x" disabled={used <= 0} onClick={() => set(used - 1)} title="恢复 1">+</button>
                  </>}
                  <button className="tag-x" onClick={() => setResHidden(id, k, true)} title="从动作栏拿掉（「详情」的资源表里可以加回来）">✕</button>
                </span>
              );
            })}
          </div>
        )}
        {c.live.hp === 0 && !c.live.dead && c.kind === 'pc' && <div className="dangerline">死亡豁免 {c.live.deathSaves.s}✓ {c.live.deathSaves.f}✗</div>}
        {effTags}
      </div>

      {ui.aim ? <div className="hot-actions"><AimBar ui={ui} name={name} /></div> : <div className="hot-actions">
        <div className="hot-tabs">
          {tabs.map((t) => (
            <button key={t.k} className={t.k === cur?.k ? 'on' : ''} onClick={() => setTab(t.k)}>{t.label}<small>{t.list.length}</small></button>
          ))}
          <span style={{ flex: 1 }} />
          {at != null && <span className="tiny cast-at">按 {at} 环放 <button className="tag-x" onClick={() => setCastAt(null)} title="回到默认（最低环）">✕</button></span>}
          {cur?.k === 'weapon' && <label className="tiny faint"><input type="checkbox" checked={asReaction} onChange={(e) => setAsReaction(e.target.checked)} /> 用反应攻击</label>}
        </div>
        <div className="hot-grid">
          {!cur && <span className="faint small">没有可用的动作。</span>}
          {cur?.list.map((it) => {
            const avail = it.slot ? freeSlots(s, id, it.slot.min, it.slot.max) : [];
            const ok = fits(it);
            return (
              <span key={it.ref} className="hot-act-wrap">
                <button
                  className={'hot-act' + (it.ok ? '' : ' no') + (it.passive ? ' passive' : '') + (ok ? '' : ' off')}
                  onClick={() => click(it)} disabled={(!mine && !it.passive) || !ok}
                  title={it.term ? undefined : [it.sub, it.why].filter(Boolean).join('\n')}
                >
                  <CostIcon kind={costKind(it, asReaction)} />
                  {it.term ? <Term {...it.term} inButton>{it.name}</Term> : it.name}
                  {it.slot && <small>{at != null && ok ? `${at}环` : avail.length ? `${avail[0]}环` : '无位'}</small>}
                  {it.group === '物品' && <small>×{(v.resources['物品:' + it.name] ?? 0) - (c.live.resourcesUsed['物品:' + it.name] ?? 0)}</small>}
                </button>
              </span>
            );
          })}
        </div>
      </div>}

      <div className="hot-end">
        {turnButton}
        <button className="btn sm" onClick={onDetail} title="效应、手动调整、资源明细、检定">详情</button>
        {fold}
      </div>
    </div>
  );
}
