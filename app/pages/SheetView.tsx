/** 人物卡「卡面」：跑团时看的那一面 */
import { useState } from 'react';
import { ABILS, ABIL_CN, SCHOOL_CN, classSpells, type CharData, type Json } from '../../src/sheet';
import { Choices } from '../components/Choices';
import { Entries } from '../components/Entries';
import { Panel, Pips, Stat, Tag, sgn } from '../components/ui';
import type { Engine } from '../lib/engine';
import { actions, stripDerived } from '../lib/store';

const ABBR: Record<string, string> = { str: '力', dex: '敏', con: '体', int: '智', wis: '感', cha: '魅' };
const RECOVERY_CN: Record<string, string> = { short: '短休', long: '长休', initiative: '先攻', none: '特殊', '?': '按规则' };

interface Props { engine: Engine; id: string; char: CharData; sheet: Record<string, Json> }

function AbilitiesPanel({ sheet }: Props) {
  return (
    <Panel title="属性" flush>
      <div className="abilities">
        {ABILS.map((a) => (
          <div className="ability" key={a}>
            <div className="k">{ABIL_CN[a]}</div>
            <div className="m">{sgn(sheet['mod:' + a])}</div>
            <div className="s">{sheet['score:' + a]}</div>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function SavesSkills({ sheet }: Props) {
  return (
    <>
      <Panel title="豁免" flush>
        <table className="rows">
          <tbody>
            {ABILS.map((a) => {
              const s = sheet.saves?.[a];
              return (
                <tr key={a}>
                  <td style={{ width: 16 }}><span className={'dot' + (s?.prof ? ' on' : '')} /></td>
                  <td>{ABIL_CN[a]}</td>
                  <td className="r num serif">{sgn(s?.total)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Panel>
      <Panel title="技能" aside={<span>被动察觉 {sheet.passivePerception}</span>} flush>
        <table className="rows">
          <tbody>
            {Object.entries(sheet.skills || {}).map(([k, s]: [string, Json]) => (
              <tr key={k} className={s.prof ? '' : 'dim'} title={s.fromAbility ? '由种族 / 背景 / 能力授予' : undefined}>
                <td style={{ width: 16 }}><span className={'dot' + (s.prof ? ' on' : '') + (s.exp ? ' double' : '')} /></td>
                <td>{s.cn} <span className="faint tiny">{ABBR[s.ability]}</span></td>
                <td className="r num serif">{sgn(s.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </>
  );
}

function Vitals({ id, char, sheet }: Props) {
  const [amt, setAmt] = useState('');
  const max = sheet.hpMax;
  const cur = char.hp?.current ?? max;
  const temp = char.hp?.temp ?? 0;
  const setHp = (current: number, t = temp) => actions.update(id, (c) => {
    c.hp = { ...(c.hp || {}), current: current >= max ? null : Math.max(0, current), temp: Math.max(0, t) };
  });
  const n = Math.max(0, Math.round(Number(amt) || 0));
  const ds = char.deathSaves || { success: 0, failure: 0 };
  return (
    <Panel title="生命值" aside={<span className="faint" title={sheet.hpNotes}>{String(sheet.hpNotes || '').split('\n')[0]}</span>}>
      <div className="spread">
        <div className="serif num" style={{ fontSize: 30, lineHeight: 1.1 }}>
          {cur}<span className="faint" style={{ fontSize: 15 }}> / {max}</span>
          {temp > 0 && <span className="small" style={{ color: 'var(--accent)', marginLeft: 8 }}>+{temp} 临时</span>}
        </div>
        <div className="row">
          <input type="number" min={0} value={amt} placeholder="数值" onChange={(e) => setAmt(e.target.value)} style={{ width: 70 }} />
          <button className="btn sm" disabled={!n} onClick={() => {
            const absorbed = Math.min(temp, n);
            setHp(cur - (n - absorbed), temp - absorbed);
            setAmt('');
          }}>伤害</button>
          <button className="btn sm" disabled={!n} onClick={() => { setHp(Math.min(max, cur + n)); setAmt(''); }}>治疗</button>
          <button className="btn sm" disabled={!n} onClick={() => { setHp(cur, Math.max(temp, n)); setAmt(''); }}>临时</button>
        </div>
      </div>
      <div className={'hpbar' + (cur <= max / 4 ? ' low' : '')} style={{ marginTop: 6 }}><i style={{ width: `${Math.min(100, (cur / Math.max(1, max)) * 100)}%` }} /></div>
      {cur === 0 && (
        <div className="row" style={{ marginTop: 8 }}>
          <span className="small">死亡豁免</span>
          <span className="small faint">成功</span>
          <Pips max={3} used={ds.success} onChange={(v) => actions.update(id, (c) => { c.deathSaves = { ...ds, success: v }; })} />
          <span className="small faint">失败</span>
          <Pips max={3} used={ds.failure} onChange={(v) => actions.update(id, (c) => { c.deathSaves = { ...ds, failure: v }; })} />
        </div>
      )}
    </Panel>
  );
}

function Attacks({ sheet }: Props) {
  const rows: Json[] = sheet.attacks || [];
  return (
    <Panel title="攻击" flush>
      {rows.length ? (
        <table className="rows">
          <thead><tr><th>武器</th><th className="r">命中</th><th>伤害</th><th>精通</th><th>属性</th></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td className="serif">{r.name}{!r.prof && <span className="warnline tiny"> 未熟练</span>}</td>
                <td className="r num serif">{sgn(r.atk)}</td>
                <td className="num">{r.dmgText}{r.dmg2 && <span className="faint tiny"> / 双手 {r.dmg2}</span>}</td>
                <td>{(sheet.masteries || []).includes(r.name) && r.mastery?.[0] ? <Tag tone="accent">{r.mastery[0]}</Tag> : <span className="faint">—</span>}</td>
                <td className="small muted">{ABIL_CN[r.abil as keyof typeof ABIL_CN]}{r.range ? ` · ${r.range} 尺` : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <div className="empty">没有装备武器。去「建卡」的装备里加。</div>}
    </Panel>
  );
}

function Spells({ engine, id, char, sheet }: Props) {
  const sc = sheet.spell || {};
  const [pick, setPick] = useState('');
  if (!sc.casters?.length && !(char.spells || []).length && !sc.granted?.length) return null;
  const all: Json[] = engine.env.store.data.spellsXphb?.spell || [];
  const ent = (n: string) => all.find((s) => s.name === n);
  const maxSlot = Math.max(0, ...(sc.slots || []).map((v: number, i: number) => (v ? i + 1 : 0)), sc.pact?.level ?? 0);
  const pool = sc.casters?.length
    ? [...new Map(sc.casters.flatMap((k: Json) => classSpells(engine.env, k.name, { maxLevel: maxSlot })).map((s: Json) => [s.name, s])).values()] as Json[]
    : [];
  const have = new Set((char.spells || []).map((s: Json) => s.name));
  const slotsUsed = (lvl: number) => char.slots?.[lvl]?.used ?? 0;
  const setSlot = (lvl: number, used: number) => actions.update(id, (c) => { c.slots = { ...(c.slots || {}), [lvl]: { used } }; });
  const prepared = (char.spells || []).filter((s: Json) => s.prepared !== false && (ent(s.name)?.level ?? 1) > 0).length;
  return (
    <Panel
      title="法术"
      aside={sc.dc != null && <span>豁免 DC <b className="serif">{sc.dc}</b> · 攻击 <b className="serif">{sgn(sc.atk)}</b> · {ABIL_CN[sc.ability as keyof typeof ABIL_CN]}</span>}
    >
      {(sc.slots || []).some((v: number) => v) && (
        <div className="row" style={{ marginBottom: 8 }}>
          {(sc.slots as number[]).map((v, i) => v ? (
            <span key={i} className="row" style={{ gap: 4 }}><span className="small faint">{i + 1} 环</span><Pips max={v} used={slotsUsed(i + 1)} onChange={(u) => setSlot(i + 1, u)} /></span>
          ) : null)}
          {sc.pact && <span className="row" style={{ gap: 4 }}><span className="small faint">契约 {sc.pact.level} 环</span><Pips max={sc.pact.count} used={slotsUsed(sc.pact.level)} onChange={(u) => setSlot(sc.pact.level, u)} /></span>}
        </div>
      )}
      {sc.casters?.length > 0 && (
        <div className="small muted" style={{ marginBottom: 6 }}>
          已准备 {prepared}{sc.preparedMax ? ` / ${sc.preparedMax}` : ''} · 戏法上限 {sc.cantripsKnown}
          {prepared > sc.preparedMax && sc.preparedMax > 0 && <span className="warnline"> · 超出 {prepared - sc.preparedMax} 道（只提醒）</span>}
        </div>
      )}
      <table className="rows">
        <tbody>
          {(char.spells || []).map((s: Json, i: number) => {
            const e = ent(s.name);
            return (
              <tr key={s.name + i} className={s.prepared === false ? 'dim' : ''}>
                <td className="serif">{s.name}</td>
                <td className="small muted">{e ? (e.level ? `${e.level} 环` : '戏法') + ' · ' + (SCHOOL_CN[e.school] ?? '') : ''}</td>
                <td className="r">
                  {e?.level ? (
                    <button className={'btn sm' + (s.prepared !== false ? ' on' : '')} onClick={() => actions.update(id, (c) => { c.spells[i].prepared = s.prepared === false; })}>
                      {s.prepared !== false ? '已准备' : '未准备'}
                    </button>
                  ) : null}
                  <button className="btn ghost sm" aria-label={`移除${s.name}`} onClick={() => actions.update(id, (c) => { c.spells.splice(i, 1); })}>移除</button>
                </td>
              </tr>
            );
          })}
          {(sc.granted || []).map((g: Json) => (
            <tr key={'g' + g.name}><td className="serif">{g.name}</td><td className="small muted">额外法术 · {g.from}</td><td /></tr>
          ))}
        </tbody>
      </table>
      {pool.length > 0 && (
        <div className="row" style={{ marginTop: 8 }}>
          <select value={pick} onChange={(e) => setPick(e.target.value)} style={{ flex: 1 }}>
            <option value="">从职业法表添加法术…</option>
            {pool.filter((s) => !have.has(s.name)).map((s) => <option key={s.name} value={s.name}>{s.level ? `${s.level} 环` : '戏法'} · {s.name}</option>)}
          </select>
          <button className="btn sm" disabled={!pick} onClick={() => { actions.update(id, (c) => { c.spells = [...(c.spells || []), { name: pick, prepared: true }]; }); setPick(''); }}>添加</button>
        </div>
      )}
    </Panel>
  );
}

function Resources({ engine, id, char, sheet }: Props) {
  const pools: Json[] = (sheet._resources || []).filter((r: Json) => r.max != null);
  const rest = (kind: 'short' | 'long') => {
    const work = structuredClone(char);
    work._resolved = char._resolved;
    work._derived = char._derived;
    engine.env.rest.do(kind, work, sheet);
    actions.replace(id, stripDerived(work));
  };
  return (
    <Panel title="资源" aside={<><button className="btn sm" onClick={() => rest('short')}>短休</button><button className="btn sm" onClick={() => rest('long')}>长休</button></>} flush>
      {pools.length ? (
        <table className="rows">
          <tbody>
            {pools.map((r) => (
              <tr key={r.key}>
                <td className="serif">{r.name}</td>
                <td><Pips max={r.max} used={r.used || 0} onChange={(u) => actions.update(id, (c) => { c.resources = { ...(c.resources || {}), [r.key]: { ...(c.resources?.[r.key] || {}), used: u } }; })} /></td>
                <td className="r small faint">{RECOVERY_CN[r.recovery] ?? r.recovery}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <div className="empty">没有资源池。</div>}
      <div className="body small muted" style={{ borderTop: '1px solid var(--line)' }}>
        生命骰：{(sheet.hitDice || []).map((h: Json) => `${h.level}d${h.faces}`).join(' + ') || '—'}
        {Object.keys(char.hitDiceSpent || {}).length > 0 && `（已花 ${Object.entries(char.hitDiceSpent).map(([f, n]) => `${n}d${f}`).join('、')}）`}
      </div>
    </Panel>
  );
}

function Features({ sheet }: Props) {
  const list: Json[] = sheet.features || [];
  return (
    <Panel title="特性" aside={<span>{list.length} 条</span>} flush>
      {list.map((f, i) => (
        <details className="feature" key={i}>
          <summary>
            <span className="nm">{f.name}</span>
            <span className="tiny faint">{f._origin === 'race' ? '种族' : `${f._cls}${f._sub ? '·子职' : ''} ${f.level} 级`}</span>
          </summary>
          <div className="prose"><Entries entries={f.entries || []} /></div>
        </details>
      ))}
    </Panel>
  );
}

function Profs({ sheet }: Props) {
  const line = (k: string, v: string[]) => (
    <div className="spread small" style={{ padding: '3px 0' }}>
      <span className="faint">{k}</span>
      <span style={{ textAlign: 'right' }}>{v.length ? v.join('、') : '—'}</span>
    </div>
  );
  const senses = [
    sheet.darkvision ? `黑暗视觉 ${sheet.darkvision} 尺` : '',
    ...Object.entries(sheet.senses || {}).map(([k, v]) => `${({ blindsight: '盲视', tremorsense: '震颤感知', truesight: '真实视觉' } as Record<string, string>)[k] ?? k} ${v} 尺`),
  ].filter(Boolean);
  return (
    <Panel title="熟练与感官">
      {line('护甲', sheet.armorProfs || [])}
      {line('武器', sheet.weaponProfs || [])}
      {line('工具', sheet.tools || [])}
      {line('语言', sheet.languages || [])}
      {line('抗性', sheet.resist || [])}
      {line('感官', senses)}
    </Panel>
  );
}

export function SheetView(p: Props) {
  const { sheet } = p;
  const sc = sheet.spell || {};
  const warnings: string[] = sheet._warnings || [];
  return (
    <div className="sheet-grid">
      <div className="stack">
        <AbilitiesPanel {...p} />
        <SavesSkills {...p} />
      </div>
      <div className="stack">
        <div className="stats">
          <Stat k="护甲等级" v={sheet.ac} s={String(sheet.acNote || '').split('\n')[0]} title={sheet.acNote} />
          <Stat k="先攻" v={sgn(sheet.initiative)} />
          <Stat k="速度" v={<>{sheet.speed}<small> 尺</small></>} />
          <Stat k="熟练加值" v={sgn(sheet.pb)} />
          {sc.dc != null && <Stat k="法术 DC" v={sc.dc} s={`攻击 ${sgn(sc.atk)}`} />}
          <Stat k="被动察觉" v={sheet.passivePerception} />
        </div>
        <Vitals {...p} />
        <Attacks {...p} />
        <Spells {...p} />
        <Resources {...p} />
      </div>
      <div className="stack">
        {(sheet._pending || []).some((c: Json) => !c.decided) && <Choices {...p} />}
        {warnings.length > 0 && (
          <Panel title="提示">{warnings.map((w, i) => <div key={i} className="warnline">{w}</div>)}</Panel>
        )}
        <Profs {...p} />
        <Features {...p} />
      </div>
    </div>
  );
}
