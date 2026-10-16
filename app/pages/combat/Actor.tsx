/** 选中的参与者：数值、行动经济、可用动作、效应、手动调整 */
import { setResHidden, useHiddenRes } from '../../lib/hotres';
import { useMemo, useState } from 'react';
import { ABIL_CN, ABILS, type Ability } from '../../../src/expr';
import type { Json } from '../../../src/sheet';
import {
  actionCosts, canPay, concentrationOf, describeCost, effectiveAction, maxTargets, weaponAction,
  type Action, type Command, type ActiveEffect, type Cost, type Duration, type RuleBook, type Session,
} from '../../../src/combat';
import { Clip, NumInput, Panel, Pips, Stat, Tag, sgn } from '../../components/ui';
import { Term } from '../../components/Term';
import { termOfKey, type TermRef } from '../../lib/terms';
import { combat, type CombatUi } from '../../lib/combat';
import { getApp } from '../../lib/store';
import type { Engine } from '../../lib/engine';
import { AimBar } from './Hotbar';
import { DAMAGE_TYPES, type Namer } from './shared';

export type Group = '武器攻击' | '法术' | '法术（未自动化）' | '特性' | '通用动作' | '时机到了会问';
export const GROUPS: Group[] = ['武器攻击', '法术', '法术（未自动化）', '特性', '通用动作', '时机到了会问'];

/** 触发时机的说法（「时机到了会问」那一组用） */
const EVENT_CN: Record<string, string> = {
  attackHit: '命中时', attackMissed: '未命中时', d20Rolled: '掷出 d20 后', damageIncoming: '将要受伤时', damageTaken: '受伤后',
  saveForced: '迫使豁免时', turnStart: '回合开始时', turnEnd: '回合结束时', spellCast: '施法后',
};

export interface ActItem {
  /** 有动态数据的：useAction 的动作引用；没有的：manual:<法术名> */
  ref: string;
  group: Group;
  name: string;
  sub: string;
  action: Action;
  slot: { min: number; max?: number } | null;
  needsTargets: boolean;
  ok: boolean;
  why: string;
  manual?: { activation: 'action' | 'bonus' | 'reaction' | 'none'; concentration: boolean };
  /** 不能主动点：由窗口触发（偷袭、至圣斩、护盾术……），只是列出来让人知道 */
  passive?: boolean;
  /** 悬浮窗查哪一条 */
  term?: TermRef | null;
}

const TIME_UNIT: Record<string, 'action' | 'bonus' | 'reaction'> = { action: 'action', bonus: 'bonus', reaction: 'reaction' };

const ACT_CN: Record<string, string> = { action: '动作', bonus: '附赠', reaction: '反应', free: '免费', none: '' };


/** 这个动作花的是什么：动作 / 附赠 / 反应 / 免费 / 要很久（分钟级施法）/ 时机到了才问 */
export type CostKind = 'action' | 'bonus' | 'reaction' | 'free' | 'long' | 'trigger';
export const COST_CN: Record<CostKind, string> = { action: '动作', bonus: '附赠动作', reaction: '反应', free: '免费', long: '长时间', trigger: '时机触发' };
export function costKind(it: ActItem, asReaction = false): CostKind {
  if (it.passive) return 'trigger';
  if (it.group === '武器攻击') return asReaction ? 'reaction' : 'action';
  const a = it.action.activation;
  if (a === 'action' || a === 'bonus' || a === 'reaction' || a === 'free') return a;
  if (typeof a === 'object') return 'long';
  for (const c of it.action.cost ?? []) {
    if ('economy' in c) return c.economy === 'bonus' ? 'bonus' : c.economy === 'reaction' ? 'reaction' : c.economy === 'move' ? 'free' : 'action';
  }
  return 'free';
}
/** 动作前面的小图标：● 动作  ▲ 附赠  ◆ 反应  ○ 免费 */
export function CostIcon({ kind }: { kind: CostKind }) {
  return <i className={'cost-ic ' + kind} aria-label={COST_CN[kind]} />;
}

export function actionsFor(s: Session, rules: RuleBook, spells: Json[], id: string): ActItem[] {
  const c = s.state.combatants[id];
  const v = s.view(id);
  const names = v.resourceNames ?? {};
  const inCombat = s.state.round !== null;
  const out: ActItem[] = [];
  for (const row of v.attacks) {
    const can = !c.live.dead && (!inCombat || c.economy.attacksLeft > 0 || c.economy.action > 0);
    out.push({
      ref: `weapon:${row.id}`, group: '武器攻击', name: row.name, term: { kind: 'item', name: row.name },
      sub: `${sgn(row.bonus)} · ${row.damage} ${row.damageType}${row.mastery ? ` · ${row.mastery}` : ''}`,
      action: weaponAction(row), slot: null, needsTargets: true, ok: can,
      why: can ? '' : c.live.dead ? '已经死亡' : '本回合的动作和攻击次数都用完了',
    });
  }
  // 准备了、但规则书里还没有动态数据的法术：可以手动施放（付代价，效果由人处理）
  for (const key of v.sources) {
    if (!key.startsWith('XPHB:spell:') || rules.entry(key)?.actions?.length) continue;
    const nm = key.slice('XPHB:spell:'.length);
    const sp = spells.find((x) => x.name === nm);
    const level = Number(sp?.level ?? 1);
    const unit = sp?.time?.[0]?.unit as string | undefined;
    const activation = (unit && TIME_UNIT[unit]) || 'none';
    const concentration = !!sp?.duration?.some((d: Json) => d.concentration);
    const timeText = unit && !TIME_UNIT[unit] ? `${sp.time[0].number ?? ''} ${unit === 'minute' ? '分钟' : unit === 'hour' ? '小时' : unit}` : ACT_CN[activation];
    out.push({
      ref: `manual:${nm}`, group: '法术（未自动化）', name: nm, term: { kind: 'spell', name: nm },
      sub: [level ? `${level} 环` : '戏法', timeText, concentration ? '专注' : ''].filter(Boolean).join(' · '),
      action: { id: 'manual', name: nm, activation, root: [] },
      slot: level > 0 ? { min: level } : null, needsTargets: false,
      ok: !c.live.dead, why: c.live.dead ? '已经死亡' : '',
      manual: { activation, concentration },
    });
  }
  const offTurn = (a: Action) => inCombat && s.state.order[s.state.turnIndex] !== id && (a.activation === 'action' || a.activation === 'bonus');
  const keys = [...v.sources, ...rules.keys().filter((k) => k.startsWith('XPHB:action:'))];
  const seen = new Set<string>();
  for (const key of keys) {
    const e = v.entries?.[key] ?? rules.entry(key);
    if (!e?.actions?.length || seen.has(key)) continue;
    seen.add(key);
    for (const a of e.actions) {
      if (a.trigger) continue;   // 窗口触发的动作列在「时机到了会问」里
      // 瞬发法术：动作法术按附赠动作算代价
      const eff = s.peek((tx) => effectiveAction(tx, id, a));
      const costs = actionCosts(eff);
      const ok = s.peek((tx) => canPay(tx, id, costs));
      const slotCost = (a.cost ?? []).find((k): k is Extract<Cost, { slot: unknown }> => 'slot' in k);
      const group: Group = (a.tags ?? []).includes('spell') ? '法术' : key.includes(':action:') ? '通用动作' : '特性';
      const act = typeof eff.activation === 'string' ? ACT_CN[eff.activation] + (eff !== a ? '（瞬发）' : '') : '';
      const t = a.targeting;
      out.push({
        ref: `${key}#${a.id}`, group, name: a.name, term: termOfKey(key),
        sub: [act, ...(a.cost ?? []).map((k) => describeCost(k, names)), a.concentration ? '专注' : ''].filter(Boolean).join(' · '),
        action: a, slot: slotCost?.slot ?? null,
        needsTargets: !!t && (t.type === 'creature' || t.type === 'area'),
        ok, why: ok ? '' : offTurn(a) ? '不是这个角色的回合（别人的回合里只能用反应）' : `付不起：${costs.map((k) => describeCost(k, names)).join('、')}`,
      });
    }
  }
  // 时机能力：常驻的触发器 + 窗口触发的动作
  for (const key of new Set(v.sources)) {
    const e = v.entries?.[key] ?? rules.entry(key);
    if (!e || e.automation === 'manual') continue;
    const timed = [
      ...(e.triggers ?? []).map((t) => ({ id: t.id, name: t.label ?? e.name ?? t.id, on: t.on, cost: t.cost ?? [], action: null as Action | null })),
      ...(e.actions ?? []).filter((a) => a.trigger).map((a) => ({ id: a.id, name: a.name, on: a.trigger!.on, cost: actionCosts(a), action: a })),
    ];
    for (const t of timed) {
      const on = [t.on].flat().map((x) => EVENT_CN[x] ?? x).join(' / ');
      const ok = s.peek((tx) => canPay(tx, id, t.cost));
      out.push({
        ref: `${key}~${t.id}`, group: '时机到了会问', name: t.name,
        sub: [on, ...t.cost.map((k) => describeCost(k, names))].filter(Boolean).join(' · '),
        action: t.action ?? { id: t.id, name: t.name, activation: 'none', root: [] },
        slot: null, needsTargets: false, ok, why: ok ? '' : '现在付不起代价', passive: true,
      });
    }
  }
  return out;
}

function durText(d: Duration, e: ActiveEffect): string {
  const parts: string[] = [];
  if (d.rounds) parts.push(`${d.rounds} 轮`);
  if (d.minutes) parts.push(`${d.minutes} 分钟`);
  if (d.hours) parts.push(`${d.hours} 小时`);
  if (d.until) parts.push(`到${d.until.of === 'bearer' ? '自己' : '来源'}${d.until.nth && d.until.nth > 1 ? `第 ${d.until.nth} 个` : '下个'}回合${d.until.at === 'turnStart' ? '开始' : '结束'}`);
  if (d.saveEnds) parts.push(`每回合${d.saveEnds.at === 'turnStart' ? '开始' : '结束'}${ABIL_CN[d.saveEnds.ability]}豁免`);
  if (d.manual) parts.push('直到移除');
  if (e.link) parts.push('随专注');
  if (e.timing.ticks && d.rounds) parts.push(`已过 ${e.timing.ticks}`);
  return parts.join('，');
}

export function Actor({ s, ui, engine, name }: { s: Session; ui: CombatUi; engine: Engine; name: Namer }) {
  const id = ui.selected && s.state.combatants[ui.selected] ? ui.selected : null;
  const spells: Json[] = engine.env.store.data.spellsXphb?.spell || [];
  const items = useMemo(() => (id ? actionsFor(s, engine.rules, spells, id) : []), [s, engine.rules, spells, id, ui.version]);
  const [slotPick, setSlotPick] = useState<Record<string, number>>({});
  const [asReaction, setAsReaction] = useState(false);
  const [amt, setAmt] = useState(5);
  const [dtype, setDtype] = useState('钝击');
  const [cond, setCond] = useState('');
  const [mark, setMark] = useState('');
  const [roll, setRoll] = useState<{ kind: 'check' | 'save'; ability: Ability; skill: string; dc: string }>({ kind: 'save', ability: 'dex', skill: '', dc: '' });
  const hiddenRes = useHiddenRes(id ?? '');

  if (!id) return <Panel title="行动"><div className="empty">在左边选一个参与者。</div></Panel>;

  const c = s.state.combatants[id];
  const v = s.view(id);
  const inCombat = s.state.round !== null;
  const isTurn = inCombat && s.state.order[s.state.turnIndex] === id;
  const effects = Object.values(s.state.effects).filter((e) => e.bearer === id).sort((a, b) => a.appliedSeq - b.appliedSeq);

  // 玩家看怪物：只看得到外表 —— 体型、伤势、身上的状态
  if (combat.isSecret(id) || combat.isHidden(id)) {
    return (
      <Panel title={<>{c.name} <span className="faint small">{v.size} {v.type}</span></>} aside={isTurn ? <Tag tone="accent">当前回合</Tag> : undefined}>
        <div className="stack">
          <div className="muted small">{c.live.dead ? '已经死亡' : c.live.hp <= 0 ? '倒地' : c.live.hp >= v.hpMax ? '看起来毫发无伤' : c.live.hp * 2 <= v.hpMax ? '浴血（伤得不轻）' : '受了伤'}</div>
          {effects.length > 0 && (
            <div className="row">
              {effects.map((e) => {
                const t = termOfKey(String(e.key ?? ''));
                return <Tag key={e.id}>{e.key === 'concentration' ? `专注：${e.name}` : t ? <Term {...t}>{e.name}</Term> : e.name}</Tag>;
              })}
            </div>
          )}
          <div className="tiny faint">具体数值只有 DM 看得到。</div>
        </div>
      </Panel>
    );
  }
  const conc = s.peek((tx) => concentrationOf(tx, id));
  const conditions = engine.rules.keys().filter((k) => k.startsWith('XPHB:condition:'));
  const tnames = ui.targets.map(name);

  const slotsFor = (min: number, max = 9) => freeSlots(s, id, min, max);
  const use = (it: ActItem) => runAction(s, ui, id, it, slotPick[it.ref], asReaction);

  const econ = c.economy;
  return (
    <div className="stack">
      <Panel
        title={<>{c.name} <span className="faint small">{c.kind === 'pc' ? '角色' : c.kind === 'npc' ? 'NPC' : '怪物'} · {v.size} {v.type}</span></>}
        aside={<>
          {isTurn && <Tag tone="accent">当前回合</Tag>}
          {/* 战斗 → 卡是自动的（生命值、法术位、资源、死亡豁免）；卡 → 战斗要点这个（升级、换装备之后） */}
          {ui.links[id] && getApp().cards[ui.links[id]] && combat.canControl(id) && (
            <button className="btn sm" onClick={() => void combat.refreshFromCard(engine, id)} title="人物卡改过（升级、换装备）之后，按卡上现在的样子更新数值；当前生命值和已用次数不变。会记进日志，可以撤销">从人物卡刷新</button>
          )}
          <button className="btn ghost sm danger" onClick={() => { if (confirm(`把 ${c.name} 移出遭遇？`)) combat.dispatch({ type: 'removeCombatant', id }); }}>移出</button>
        </>}
        flush
      >
        <div className="stats" style={{ border: 0, borderRadius: 0 }}>
          <Stat k="护甲等级" v={v.ac} s={v.ac !== c.base.ac ? `基础 ${c.base.ac}` : undefined} />
          <Stat k="生命值" v={<>{c.live.hp}<small>/{v.hpMax}</small></>} s={c.live.tempHp ? `临时 ${c.live.tempHp}` : undefined} />
          {/* 战斗中主数字是这回合还能走多远（疾走之后会比速度多），速度放在下面 */}
          {inCombat
            ? <Stat k="剩余移动" v={<>{econ.move}<small>尺</small></>} s={`速度 ${v.speed} 尺`} />
            : <Stat k="速度" v={<>{v.speed}<small>尺</small></>} />}
          <Stat k="先攻" v={c.initiative ?? sgn(v.initiative)} s={c.initiative != null ? `加值 ${sgn(v.initiative)}` : undefined} />
          {v.spell && <Stat k="法术 DC" v={v.spell.dc} s={`攻击 ${sgn(v.spell.atk)}`} />}
        </div>
        {inCombat && (
          <div className="econ">
            <span className={'eco' + (econ.action ? ' on' : '')}>动作</span>
            <span className={'eco' + (econ.bonus ? ' on' : '')}>附赠</span>
            <span className={'eco' + (econ.reaction ? ' on' : '')}>反应</span>
            {econ.attacksLeft > 0 && <span className="eco on">还能攻击 {econ.attacksLeft} 次</span>}
            {econ.slotSpellCast && <span className="eco">本回合已用法术位施法</span>}
          </div>
        )}
        {c.live.hp === 0 && !c.live.dead && c.kind === 'pc' && (
          <div className="econ dangerline">死亡豁免：成功 {c.live.deathSaves.s} / 失败 {c.live.deathSaves.f}{c.live.stable ? '（已稳定）' : ''}</div>
        )}
      </Panel>

      <Panel
        title="动作"
        aside={<span className="small">{tnames.length ? <>目标：{tnames.join('、')} <button className="btn ghost sm" onClick={combat.clearTargets}>清空</button></> : '未选目标'}</span>}
        flush
      >
        <AimBar ui={ui} name={name} />
        {GROUPS.map((g) => {
          const list = items.filter((x) => x.group === g);
          if (!list.length) return null;
          return (
            <div key={g} className="actgroup">
              <div className="gh">
                {g}
                {g === '武器攻击' && (
                  <label className="tiny faint" style={{ marginLeft: 'auto' }}>
                    <input type="checkbox" checked={asReaction} onChange={(e) => setAsReaction(e.target.checked)} /> 用反应攻击（借机攻击）
                  </label>
                )}
              </div>
              {list.map((it) => {
                const avail = it.slot ? slotsFor(it.slot.min, it.slot.max) : [];
                return (
                  <div key={it.ref} className={'act' + (it.ok ? '' : ' no')} title={it.term ? undefined : it.why || it.action.text || undefined}>
                    <CostIcon kind={costKind(it, asReaction)} />
                    {it.passive
                      ? <span className="passive-name">{it.term ? <Term {...it.term}>{it.name}</Term> : it.name}</span>
                      : <button className="btn sm" onClick={() => use(it)}>{it.term ? <Term {...it.term} inButton>{it.name}</Term> : it.name}</button>}
                    <span className="small muted">{it.sub}</span>
                    {it.slot && !it.passive && (
                      avail.length
                        ? (
                          <select className="slotsel" value={slotPick[it.ref] ?? avail[0]} onChange={(e) => setSlotPick({ ...slotPick, [it.ref]: Number(e.target.value) })} aria-label="法术位环阶">
                            {avail.map((L) => <option key={L} value={L}>{L} 环</option>)}
                          </select>
                        )
                        : <span className="tiny faint">没有可用法术位</span>
                    )}
                    {!it.ok && <span className="tiny faint">{it.why}</span>}
                  </div>
                );
              })}
            </div>
          );
        })}
        {!items.length && <div className="empty">没有可用的动作。</div>}
      </Panel>

      <Panel title="效应与状态" flush>
        {effects.length === 0 && <div className="empty" style={{ padding: '8px 12px' }}>没有效应。</div>}
        {effects.map((e) => (
          <div key={e.id} className="effrow">
            <span className={'nm' + (e.suppressed ? ' faint' : '')}>{e.key === 'concentration' ? `专注：${e.name}` : (() => { const t = termOfKey(String(e.key ?? '')); return t ? <Term {...t}>{e.name}</Term> : e.name; })()}</span>
            <span className="tiny faint">{[e.source && e.source !== id ? `来自 ${name(e.source)}` : '', durText(e.duration, e), e.suppressed ? '被压制' : ''].filter(Boolean).join(' · ')}</span>
            <span style={{ flex: 1 }} />
            {e.key === 'concentration'
              ? <button className="btn ghost sm" onClick={() => combat.dispatch({ type: 'endConcentration', id })}>终止专注</button>
              : <button className="btn ghost sm" onClick={() => combat.dispatch({ type: 'removeEffect', id: e.id })} title="DM 手动移除">移除</button>}
          </div>
        ))}
        <div className="effrow">
          <select value={cond} onChange={(e) => setCond(e.target.value)} aria-label="状态">
            <option value="">施加状态…</option>
            {conditions.map((k) => <option key={k} value={k}>{k.split(':').pop()}</option>)}
          </select>
          <button className="btn sm" disabled={!cond} onClick={() => { combat.dispatch({ type: 'applyEffect', to: id, template: cond }); setCond(''); }}>施加</button>
          <span style={{ width: 8 }} />
          <input value={mark} onChange={(e) => setMark(e.target.value)} placeholder="自定义标记" style={{ width: 110 }} />
          <button className="btn sm" disabled={!mark.trim()} onClick={() => {
            combat.dispatch({ type: 'applyEffect', to: id, name: mark.trim(), inline: { name: mark.trim(), tags: ['manual'] }, duration: { manual: true } });
            setMark('');
          }}>加上</button>
          {conc && <span className="tiny faint">正在专注：{conc.name}</span>}
        </div>
      </Panel>

      <Panel title="手动调整" aside={<span className="tiny">都会记进日志，可以撤销</span>}>
        <div className="row">
          <NumInput min={0} value={amt} onChange={setAmt} aria-label="数值" />
          <select value={dtype} onChange={(e) => setDtype(e.target.value)} aria-label="伤害类型">
            {DAMAGE_TYPES.map((t) => <option key={t}>{t}</option>)}
          </select>
          <button className="btn sm" onClick={() => combat.dispatch({ type: 'damage', id, amount: amt, damageType: dtype })} title="走完整伤害流程：抗性、临时生命值、专注、倒地">伤害</button>
          <button className="btn sm" onClick={() => combat.dispatch({ type: 'heal', id, amount: amt })}>治疗</button>
          <button className="btn sm" onClick={() => combat.dispatch({ type: 'tempHp', id, amount: amt })}>临时生命值</button>
          <button className="btn ghost sm" onClick={() => combat.dispatch({ type: 'adjustHp', id, set: amt })} title="直接改成这个数，不触发任何规则">设为</button>
        </div>
        <hr className="rule" />
        <div className="row">
          <select value={roll.kind} onChange={(e) => setRoll({ ...roll, kind: e.target.value as 'check' | 'save', skill: '' })} aria-label="检定类型">
            <option value="save">豁免</option>
            <option value="check">检定</option>
          </select>
          <select value={roll.ability} onChange={(e) => setRoll({ ...roll, ability: e.target.value as Ability })} aria-label="属性">
            {ABILS.map((a) => <option key={a} value={a}>{ABIL_CN[a]} {sgn(roll.kind === 'save' ? v.save[a] : v.mod[a])}</option>)}
          </select>
          {roll.kind === 'check' && Object.keys(v.skill).length > 0 && (
            <select value={roll.skill} onChange={(e) => setRoll({ ...roll, skill: e.target.value })} aria-label="技能">
              <option value="">（不用技能）</option>
              {Object.entries(v.skill).map(([k, n]) => <option key={k} value={k}>{k} {sgn(n)}</option>)}
            </select>
          )}
          <input type="number" placeholder="DC" value={roll.dc} onChange={(e) => setRoll({ ...roll, dc: e.target.value })} aria-label="DC" />
          <button className="btn sm" onClick={() => combat.dispatch({
            type: 'roll', roller: id, kind: roll.kind, ability: roll.ability, skill: roll.skill || undefined,
            dc: roll.dc ? Number(roll.dc) : undefined,
          })}>掷骰</button>
        </div>
      </Panel>

      {(v.notes?.length ?? 0) > 0 && (
        <Panel title="要手动处理的能力" aside={<span className="tiny">引擎不自动结算，按原文处理</span>}>
          {v.notes!.map((n, i) => (
            <details key={i} className="note-ab">
              <summary><span className="faint tiny">{n.group}</span> {n.name}</summary>
              <div className="small">{n.text}</div>
            </details>
          ))}
        </Panel>
      )}
      {(Object.keys(v.resources).length > 0 || Object.keys(v.slots).length > 0) && (
        <Panel title="资源" aside={<span className="tiny">点方格手动改（记进日志）</span>} flush>
          <table className="rows">
            <tbody>
              {Object.entries(v.slots).filter(([, n]) => n > 0).map(([L, n]) => (
                <tr key={'s' + L}>
                  <td>{L} 环法术位</td>
                  <td className="r"><Usage max={n} used={c.live.slotsUsed[Number(L)] ?? 0} onChange={(used) => combat.dispatch({ type: 'setUsage', id, slot: Number(L), used })} /></td>
                </tr>
              ))}
              {Object.entries(v.resources).map(([k, n]) => (
                <tr key={'r' + k}>
                  <td><Clip text={(v.resourceNames ?? {})[k] ?? k} />{hiddenRes.includes(k) && <button className="btn ghost sm" onClick={() => setResHidden(id, k, false)} title="放回底部动作栏">放回动作栏</button>}</td>
                  <td className="r"><Usage max={n} used={c.live.resourcesUsed[k] ?? 0} onChange={(used) => combat.dispatch({ type: 'setUsage', id, resource: k, used })} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}
    </div>
  );
}

/** 次数：少的画方格，多的（圣疗能量池 30 点）用数字框改「剩余」 */
function Usage({ max, used, onChange }: { max: number; used: number; onChange: (used: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  if (max <= 12) return <Pips max={max} used={used} onChange={onChange} />;
  // 改完（回车 / 离开输入框）才记一笔，不是每敲一个数字记一笔
  const commit = () => {
    if (draft === null) return;
    const left = Number(draft);
    setDraft(null);
    if (draft !== '' && Number.isFinite(left) && max - left !== used) onChange(Math.max(0, Math.min(max, max - Math.floor(left))));
  };
  return (
    <span className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
      <span className="tiny faint">剩</span>
      <input
        type="number" min={0} max={max} value={draft ?? String(max - used)} aria-label="剩余"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') commit(); }}
      />
      <span className="tiny faint num">/ {max}</span>
    </span>
  );
}

/** 还有剩的法术位（环阶从低到高） */
export function freeSlots(s: Session, id: string, min: number, max = 9): number[] {
  const c = s.state.combatants[id];
  const v = s.view(id);
  return Object.keys(v.slots).map(Number)
    .filter((L) => L >= min && L <= max && (v.slots[L] ?? 0) - (c.live.slotsUsed[L] ?? 0) > 0).sort((a, b) => a - b);
}

/** 执行一个动作。slotLevel 没给或者用不了 → 用最低的可用环阶 */
/** 射程（尺）：触及 / 触及范围 = 5 尺；自身或没写 = 不查 */
const rangeOf = (r: number | 'touch' | 'self' | 'reach' | undefined): number | null =>
  typeof r === 'number' ? r : r === 'touch' || r === 'reach' ? 5 : null;

export function runAction(s: Session, ui: CombatUi, id: string, it: ActItem, slotPick?: number, asReaction = false): void {
  // 付不起代价的动作也能点：DM 可以强制执行（不检查代价和次数）
  const force = !it.ok;
  if (force && !confirm(`${it.why}。\n仍然执行？（DM 强制：不检查代价）`)) return;
  let slotLevel: number | undefined;
  if (it.slot) {
    const avail = freeSlots(s, id, it.slot.min, it.slot.max);
    slotLevel = slotPick && avail.includes(slotPick) ? slotPick : avail[0];
  }
  if (it.manual) {
    if (it.slot && slotLevel === undefined && !force) { combat.toast(`没有可用的 ${it.slot.min} 环或更高的法术位`); return; }
    combat.dispatch({
      type: 'manualCast', actor: id, spell: it.name, slotLevel,
      activation: it.manual.activation, concentration: it.manual.concentration, targets: ui.targets, force: force || undefined,
    });
    return;
  }
  const cmd: Command = {
    type: 'useAction', actor: id, action: it.ref,
    targets: it.needsTargets ? ui.targets : [id],
    slotLevel,
    options: asReaction && it.group === '武器攻击' ? { as: 'reaction' } : undefined,
    force: force || undefined,
  };
  // 要目标的：进选目标模式，在地图 / 先攻条上点人，再确认
  if (it.needsTargets) {
    const t = it.action.targeting;
    const max = t?.type === 'creature' ? s.peek((tx) => maxTargets(tx, id, it.action, slotLevel)) : null;
    const area = t?.type === 'area' && t.area
      // 锥和线都从施法者身上出发（数据里个别写了数字射程的也是）
      ? { area: t.area, self: t.range === 'self' || t.area.shape === 'cone' || t.area.shape === 'line' }
      : undefined;
    combat.startAim({ actor: id, ref: it.ref, name: it.name, max, repeat: !!t?.repeat, cmd, range: rangeOf(t?.range), area });
    return;
  }
  combat.dispatch(cmd);
}
