/** 加怪物：从图鉴里挑（2024 怪物手册），或者贴一段自制怪物的文本。右边预览：哪些引擎自动处理、哪些要手动 */
import { useMemo, useState } from 'react';
import { crNum, parseMonster, tokenUrlsOf, type ParsedMonster } from '../../../src/bridge/from-monster';
import { MONSTER_TEMPLATE, textToMonster } from '../../../src/bridge/from-text-monster';
import { makeView, type ViewInit } from '../../../src/combat';
import { renderMonsterTask } from '../../../src/factory/ai';
import { AiDatafy, AiSettingsDialog } from '../../components/AiDatafy';
import { Dialog, NumInput } from '../../components/ui';
import {
  checkMonster, monsterAiOf, removeMonsterAi, saveMonsterAi, tidyMonsterText, useAiSettings, useMonsterAi, withMonsterAi, type MonsterAi,
} from '../../lib/ai';

type Json = any;
type OnAdd = (view: ViewInit, count: number, side: string, hidden: boolean) => void;
/** 图能不能加载得到（5etools 的棋子图不一定每只都有；加载不到就别设，否则棋子上是个空圈） */
const probeImage = (url: string): Promise<boolean> => new Promise((res) => {
  const img = new Image();
  img.onload = () => res(true);
  img.onerror = () => res(false);
  img.src = url;
});
/** 按顺序试几张图，返回第一张能加载的 */
const firstImage = async (urls: string[]): Promise<string | null> => {
  for (const u of urls) if (await probeImage(u)) return u;
  return null;
};
const CR_BANDS: Array<[string, number, number]> = [['全部', -1, 99], ['0–1', 0, 1], ['2–4', 2, 4], ['5–10', 5, 10], ['11–16', 11, 16], ['17+', 17, 99]];
const TYPE_CN: Record<string, string> = {
  aberration: '异怪', beast: '野兽', celestial: '天界生物', construct: '构装生物', dragon: '龙类', elemental: '元素生物', fey: '精类',
  fiend: '邪魔', giant: '巨人', humanoid: '类人生物', monstrosity: '怪兽', ooze: '泥怪', plant: '植物', undead: '不死生物',
};
const typeOf = (m: Json) => TYPE_CN[typeof m.type === 'string' ? m.type : m.type?.type] ?? '';
const crText = (m: Json) => String(typeof m.cr === 'object' && m.cr ? m.cr.cr : m.cr ?? '—');

export function BestiaryPicker({ monsters, canHide, onAdd }: { monsters: Json[]; canHide?: boolean; onAdd: OnAdd }) {
  const [q, setQ] = useState('');
  const [band, setBand] = useState(0);
  const [type, setType] = useState('');
  const [pick, setPick] = useState<Json | null>(null);

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
  const aiMap = useMonsterAi();
  const raw = useMemo(() => (pick ? parseMonster(pick) : null), [pick]);
  const parsed = useMemo(() => (raw ? withMonsterAi(raw, aiMap[raw.key]) : null), [raw, aiMap]);

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
        {!parsed ? <div className="empty">在左边挑一个。</div>
          : <MonsterPreview parsed={parsed} raw={raw!} title={<>{pick.name} <small className="faint">{pick.ENG_name}</small></>} cr={crText(pick)} canHide={canHide} onAdd={onAdd}
            ai={{ existing: aiMap[raw!.key], shared: true, save: (x) => saveMonsterAi(raw!.key, x), remove: () => removeMonsterAi(raw!.key) }} />}
      </div>
    </div>
  );
}

/** 自制怪物：照模板写（或贴别处的数据块改一改），边改边预览 */
export function TextMonster({ canHide, onAdd }: { canHide?: boolean; onAdd: OnAdd }) {
  const [text, setTextRaw] = useState(MONSTER_TEMPLATE);
  const [local, setLocal] = useState<MonsterAi | undefined>(undefined);
  const [tidy, setTidy] = useState(false);
  // 文本改了，之前 AI 写的特性可能对不上了：丢掉
  const setText = (t: string) => { setTextRaw(t); setLocal(undefined); };
  const res = useMemo(() => {
    try {
      const m = textToMonster(text);
      const raw = parseMonster(m);
      return { m, raw, parsed: withMonsterAi(raw, local), err: '' };
    } catch (e) { return { m: null, raw: null, parsed: null, err: (e as Error).message }; }
  }, [text, local]);
  return (
    <div className="bestiary">
      <div className="bestiary-list">
        <textarea className="monster-text" value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
        <div className="row tiny" style={{ gap: 6 }}>
          <button className="btn ghost sm" onClick={() => { if (confirm('换回模板？现在写的会丢掉')) setText(MONSTER_TEMPLATE); }}>换回模板</button>
          <span style={{ flex: 1 }} />
          <button className="btn sm" title="贴任意格式、任意语言的数据块，AI 改写成上面的写法" onClick={() => setTidy(true)}>AI 整理…</button>
        </div>
        <div className="tiny faint">{TEXT_HINT}别的照写，会列进「要手动处理」。</div>
        {tidy && <TidyDialog onDone={(t) => { setText(t); setTidy(false); }} onClose={() => setTidy(false)} />}
      </div>
      <div className="bestiary-preview">
        {res.err && <div className="dangerline tiny">{res.err}</div>}
        {res.parsed && <MonsterPreview parsed={res.parsed} raw={res.raw!} title={res.m.name} cr={String(res.m.cr)} canHide={canHide} onAdd={onAdd}
          ai={{ existing: local, shared: false, save: async (x) => { setLocal(x); return []; }, remove: async () => setLocal(undefined) }} />}
      </div>
    </div>
  );
}

const TEXT_HINT = '攻击写成「名字。近战攻击检定：+7，触及 5 尺。命中：11（2d6+4）挥砍伤害。」；豁免类写「敏捷豁免：DC 15，……失败：28（8d6）火焰伤害。成功：半伤。」；充能写在名字后面「（充能 5–6）」。';

/** 贴别处的数据块，AI 改写成模板的写法 */
function TidyDialog({ onDone, onClose }: { onDone: (text: string) => void; onClose: () => void }) {
  const settings = useAiSettings();
  const [src, setSrc] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [setup, setSetup] = useState(!settings);
  if (setup) return <AiSettingsDialog onClose={() => (settings ? setSetup(false) : onClose())} onSaved={() => setSetup(false)} />;
  const go = async () => {
    setBusy(true); setErr('');
    try { onDone(await tidyMonsterText(settings!, MONSTER_TEMPLATE, TEXT_HINT, src)); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Dialog title="AI 整理数据块" onClose={onClose} footer={<>
      <span className="small muted" style={{ flex: 1 }}>{settings?.model} · <button className="btn ghost sm" onClick={() => setSetup(true)}>接口设置</button></span>
      <button className="btn" onClick={onClose}>取消</button>
      <button className="btn primary" disabled={busy || !src.trim()} onClick={() => void go()}>{busy ? '整理中…' : '整理（会替换左边的文本）'}</button>
    </>}>
      <textarea rows={14} value={src} onChange={(e) => setSrc(e.target.value)} placeholder="贴怪物数据块：英文、别的网站的格式都行" style={{ width: '100%' }} />
      {err && <div className="dangerline small">{err}</div>}
      <div className="tiny faint">整理完照常预览；要手动处理的能力可以再点「AI 数据化」。</div>
    </Dialog>
  );
}

interface AiHooks {
  existing?: MonsterAi;
  /** 存进全服（图鉴里的怪）还是只用在这次（自制怪物） */
  shared: boolean;
  save: (ai: MonsterAi) => Promise<string[]>;
  remove: () => Promise<void>;
}

function MonsterPreview({ parsed, raw, title, cr, canHide, onAdd, ai }: { parsed: ParsedMonster; raw: ParsedMonster; title: React.ReactNode; cr: string; canHide?: boolean; onAdd: OnAdd; ai: AiHooks }) {  const [count, setCount] = useState(1);
  const [aiOpen, setAiOpen] = useState(false);
  const [side, setSide] = useState('enemy');
  const [hidden, setHidden] = useState(false);
  const v = parsed.view;
  return (
    <>
      <div className="serif" style={{ fontSize: 18 }}>{title}</div>
      <div className="tiny faint">{v.size} {v.type} · CR {cr} · 熟练 +{v.pb}</div>
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
      {raw.notes.length > 0 && (
        <div className="row tiny" style={{ gap: 6, flexWrap: 'wrap' }}>
          <button className="btn sm" onClick={() => setAiOpen(true)}>{ai.existing ? 'AI 再改…' : 'AI 数据化要手动的…'}</button>
          {ai.existing && <button className="btn ghost sm danger" onClick={() => { if (confirm(ai.shared ? '删掉这只怪的 AI 结果？（全服共享的）' : '不用 AI 写的了？')) void ai.remove(); }}>不用 AI 的</button>}
          <span className="faint">{ai.shared ? '存进全服怪物库，大家加这只怪都会用上' : '只用在这只自制怪物上'}</span>
        </div>
      )}
      {aiOpen && (
        <AiDatafy
          title={`AI 数据化「${raw.view.name}」要手动的能力`}
          initial={ai.existing ? Object.fromEntries(Object.entries(ai.existing.entries).map(([k, e]) => [k.slice(raw.key.length + 1), e])) : undefined}
          saveLabel={ai.shared ? '存进全服' : '用上'}
          prepare={async () => {
            const owner = makeView(raw.view);
            return { task: renderMonsterTask(raw, cr), check: (a) => checkMonster(a, raw, owner) };
          }}
          onSave={(a, by) => ai.save(monsterAiOf(a as Record<string, unknown>, raw, by))}
          onClose={() => setAiOpen(false)}
        />
      )}
      <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        <label className="row tiny" style={{ gap: 4 }}>数量 <NumInput min={1} max={20} value={count} onChange={setCount} style={{ width: 56 }} /></label>
        <select value={side} onChange={(e) => setSide(e.target.value)}>
          <option value="enemy">敌方</option><option value="party">友方</option><option value="neutral">中立</option>
        </select>
        {canHide && <label className="tiny"><input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} /> 先藏起来</label>}
        <span style={{ flex: 1 }} />
        <button
          className="btn primary"
          onClick={async () => {
            // 5etools 图鉴里的怪：顺手把它的棋子图也带上（先试一下加载得到，免得棋子上是个空圈）
            const url = await firstImage(raw.tokenUrls ?? []);
            onAdd(url ? { ...v, avatar: url } : v, Math.max(1, Math.min(20, count)), side, hidden);
          }}
        >加入{count > 1 ? ` ${count} 个` : ''}</button>
      </div>
    </>
  );
}
