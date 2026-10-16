/** 加怪物：从图鉴里挑（2024 怪物手册）。左边搜索列表，右边预览：哪些引擎自动处理、哪些要手动 */
import { useMemo, useState } from 'react';
import { crNum, parseMonster } from '../../../src/bridge/from-monster';
import type { ViewInit } from '../../../src/combat';
import { NumInput } from '../../components/ui';

type Json = any;

const CR_BANDS: Array<[string, number, number]> = [['全部', -1, 99], ['0–1', 0, 1], ['2–4', 2, 4], ['5–10', 5, 10], ['11–16', 11, 16], ['17+', 17, 99]];
const TYPE_CN: Record<string, string> = {
  aberration: '异怪', beast: '野兽', celestial: '天界生物', construct: '构装生物', dragon: '龙类', elemental: '元素生物', fey: '精类',
  fiend: '邪魔', giant: '巨人', humanoid: '类人生物', monstrosity: '怪兽', ooze: '泥怪', plant: '植物', undead: '不死生物',
};
const typeOf = (m: Json) => TYPE_CN[typeof m.type === 'string' ? m.type : m.type?.type] ?? '';
const crText = (m: Json) => String(typeof m.cr === 'object' && m.cr ? m.cr.cr : m.cr ?? '—');

export function BestiaryPicker({ monsters, canHide, onAdd }: {
  monsters: Json[];
  canHide?: boolean;
  onAdd: (view: ViewInit, count: number, side: string, hidden: boolean) => void;
}) {
  const [q, setQ] = useState('');
  const [band, setBand] = useState(0);
  const [type, setType] = useState('');
  const [pick, setPick] = useState<Json | null>(null);
  const [count, setCount] = useState(1);
  const [side, setSide] = useState('enemy');
  const [hidden, setHidden] = useState(false);

  const list = useMemo(() => {
    const t = q.trim().toLowerCase();
    const [, lo, hi] = CR_BANDS[band];
    return monsters.filter((m) => {
      if (t && !String(m.name).includes(t) && !String(m.ENG_name ?? '').toLowerCase().includes(t)) return false;
      const c = crNum(m.cr);
      if (c < lo || c > hi) return false;
      return !type || typeOf(m) === type;
    }).sort((a, b) => crNum(a.cr) - crNum(b.cr) || String(a.name).localeCompare(String(b.name), 'zh'));
  }, [monsters, q, band, type]);
  const parsed = useMemo(() => (pick ? parseMonster(pick) : null), [pick]);
  const v = parsed?.view;

  return (
    <div className="bestiary">
      <div className="bestiary-list">
        <div className="row" style={{ gap: 6 }}>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="名字（中文或英文）" style={{ flex: 1, minWidth: 0 }} autoFocus />
          <select value={band} onChange={(e) => setBand(Number(e.target.value))} title="挑战等级">{CR_BANDS.map(([l], i) => <option key={l} value={i}>CR {l}</option>)}</select>
          <select value={type} onChange={(e) => setType(e.target.value)}><option value="">所有类型</option>{Object.values(TYPE_CN).map((t) => <option key={t}>{t}</option>)}</select>
        </div>
        <div className="bestiary-rows">
          {list.slice(0, 200).map((m) => (
            <button key={m.name} className={'bestiary-row' + (pick === m ? ' on' : '')} onClick={() => setPick(m)}>
              <b>{m.name}</b><small>{m.ENG_name}</small><span className="tiny faint">CR {crText(m)} · {typeOf(m)}</span>
            </button>
          ))}
          {list.length > 200 && <div className="tiny faint">还有 {list.length - 200} 个，缩小一下范围</div>}
          {!list.length && <div className="tiny faint">没有符合的。</div>}
        </div>
      </div>
      <div className="bestiary-preview">
        {!parsed || !v ? <div className="empty">在左边挑一个。</div> : (
          <>
            <div className="serif" style={{ fontSize: 18 }}>{pick.name} <small className="faint">{pick.ENG_name}</small></div>
            <div className="tiny faint">{v.size} {v.type} · CR {crText(pick)} · 熟练 +{v.pb}</div>
            <div className="row" style={{ gap: 14, margin: '6px 0' }}>
              <span>AC <b>{v.ac}</b></span><span>生命值 <b>{v.hpMax}</b></span><span>速度 <b>{v.speed}</b> 尺</span>
              <span>先攻 <b>{(v.initiative ?? 0) >= 0 ? '+' : ''}{v.initiative}</b></span>
            </div>
            {parsed.auto.length > 0 && (
              <div className="bestiary-sec"><div className="tiny ok">引擎自动处理</div>
                <ul>{parsed.auto.map((a) => <li key={a}>{a}</li>)}</ul>
              </div>
            )}
            {parsed.notes.length > 0 && (
              <div className="bestiary-sec"><div className="tiny warnline">要手动处理（加入后在「详情」里能看到原文）</div>
                <ul>{parsed.notes.map((n, i) => <li key={i} title={n.text}><span className="faint">{n.group}·</span>{n.name}</li>)}</ul>
              </div>
            )}
            <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
              <label className="row tiny" style={{ gap: 4 }}>数量 <NumInput min={1} max={20} value={count} onChange={setCount} style={{ width: 56 }} /></label>
              <select value={side} onChange={(e) => setSide(e.target.value)}>
                <option value="enemy">敌方</option><option value="party">友方</option><option value="neutral">中立</option>
              </select>
              {canHide && <label className="tiny"><input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} /> 先藏起来</label>}
              <span style={{ flex: 1 }} />
              <button className="btn primary" onClick={() => onAdd(v, Math.max(1, Math.min(20, count)), side, hidden)}>加入{count > 1 ? ` ${count} 个` : ''}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
