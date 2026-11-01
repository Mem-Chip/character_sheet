/**
 * 行动栏里的「资源 / 触发」面板（快速掷骰、详情旁边那个按钮打开）：
 * - 资源：生命骰（能花一颗回血）、法术位、次数池，短休 / 长休 —— 和「详情」抽屉里那张表一样，只是不用翻进去；
 * - 触发：这个人身上「时机到了会问」的可选能力，一个一个开关。关掉的引擎直接跳过，不再弹「要使用以下能力吗」
 *   （银光锐语这种每个 d20 都会问的）。开关记在参与者身上（setTriggerOff），战役遭遇里也是服务器那份为准。
 */
import { useMemo } from 'react';
import type { Session } from '../../../src/combat';
import { Term } from '../../components/Term';
import { Clip, sgn } from '../../components/ui';
import { combat } from '../../lib/combat';
import type { Engine } from '../../lib/engine';
import { termOfKey, termOfResource } from '../../lib/terms';
import { Usage } from './Actor';

interface TrigRow { key: string; label: string; entry: string }

/** 某人身上的可选触发能力（可选触发器 + 写了 trigger 的动作），同一能力只列一次 */
export function optionalTriggers(s: Session, engine: Engine, id: string): TrigRow[] {
  const v = s.view(id);
  const out = new Map<string, TrigRow>();
  const scan = (k: string) => {
    const e = engine.rules.entry(k);
    if (!e) return;
    for (const t of e.triggers ?? []) if (t.optional) out.set(`${k}#${t.id}`, { key: `${k}#${t.id}`, label: t.label ?? e.name ?? t.id, entry: k });
    for (const a of e.actions ?? []) if (a.trigger) out.set(`${k}#${a.id}`, { key: `${k}#${a.id}`, label: a.name, entry: k });
  };
  for (const k of new Set(v.sources)) scan(k);
  for (const [k] of engine.rules.globals()) scan(k);
  return [...out.values()];
}

export function ManagePanel({ s, engine, id, mine }: { s: Session; engine: Engine; id: string; mine: boolean }) {
  const c = s.state.combatants[id];
  const v = s.view(id);
  const trig = useMemo(() => optionalTriggers(s, engine, id), [s, engine, id]);
  const off = new Set(c.triggerOff ?? []);
  const hitDice = Object.entries(v.hitDice ?? c.base.hitDice ?? {}).filter(([, n]) => n > 0);
  const slots = Object.entries(v.slots).filter(([, n]) => n > 0);
  const names = v.resourceNames ?? {};
  return (
    <div className="hot-grid manage-panel">
      <section>
        <div className="manage-hd">
          <b>资源</b>
          <span style={{ flex: 1 }} />
          {mine && <>
            <button className="btn sm" onClick={() => combat.dispatch({ type: 'rest', kind: 'short', ids: [id] })} title="恢复短休资源与契约法术位">短休</button>
            <button className="btn sm" onClick={() => combat.dispatch({ type: 'rest', kind: 'long', ids: [id] })} title="回满生命值、法术位、资源与生命骰">长休</button>
          </>}
        </div>
        <table className="rows">
          <tbody>
            {hitDice.map(([faces, n]) => {
              const f = Number(faces);
              const used = c.live.hitDiceUsed?.[f] ?? 0;
              return (
                <tr key={'hd' + f}>
                  <td>
                    d{f} 生命骰
                    {mine && <button className="btn sm" style={{ marginLeft: 6 }} disabled={used >= n || c.live.dead}
                      onClick={() => combat.dispatch({ type: 'spendHitDie', id, faces: f })}
                      title={`掷 1d${f} + 体质调整值（${sgn(v.mod.con)}）回血`}>花 1 颗</button>}
                  </td>
                  <td className="r"><Usage max={n} used={used} onChange={(u) => combat.dispatch({ type: 'setUsage', id, hitDie: f, used: u })} /></td>
                </tr>
              );
            })}
            {slots.map(([L, n]) => (
              <tr key={'s' + L}>
                <td>{L} 环法术位</td>
                <td className="r"><Usage max={n} used={c.live.slotsUsed[Number(L)] ?? 0} onChange={(u) => combat.dispatch({ type: 'setUsage', id, slot: Number(L), used: u })} /></td>
              </tr>
            ))}
            {Object.entries(v.resources).map(([k, n]) => {
              const label = names[k] ?? k;
              const tr = termOfResource({ key: k, name: label });
              return (
                <tr key={'r' + k}>
                  <td>{tr ? <Term {...tr} inButton><Clip text={label} /></Term> : <Clip text={label} />}</td>
                  <td className="r"><Usage max={n} used={c.live.resourcesUsed[k] ?? 0} onChange={(u) => combat.dispatch({ type: 'setUsage', id, resource: k, used: u })} /></td>
                </tr>
              );
            })}
            {!hitDice.length && !slots.length && !Object.keys(v.resources).length && <tr><td className="faint small">没有可记的资源。</td></tr>}
          </tbody>
        </table>
      </section>
      <section>
        <div className="manage-hd"><b>时机能力</b><span className="tiny faint">勾着 = 时机到了问我；不勾 = 直接跳过</span></div>
        {trig.length ? trig.map((t) => {
          const tm = termOfKey(t.entry);
          return (
            <label key={t.key} className="row small manage-trig">
              <input type="checkbox" disabled={!mine} checked={!off.has(t.key)}
                onChange={(e) => combat.dispatch({ type: 'setTriggerOff', id, key: t.key, off: !e.target.checked })} />
              {tm ? <Term {...tm} inButton>{t.label}</Term> : t.label}
            </label>
          );
        }) : <div className="faint small">没有会问的时机能力。</div>}
      </section>
    </div>
  );
}
