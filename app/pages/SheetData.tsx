/**
 * 人物卡的「数据」页：这张卡的每一项能力背后是什么数据，以及怎么补、怎么改。
 *
 * 一项能力有三层：原文（5etools）、卡面数据（人物卡怎么算：加值、授予、选择、资源）、
 * 战斗数据（战斗里怎么动）。这里把三层并排摆出来，标出谁写的（手写 / AI 未审 / 没有）。
 *
 * 改动都存成这张卡的家规（char.homerules）：
 * - 「用家规覆盖」：同一个键的官方卡面数据换成你的版本（covers = 条目键）；
 * - 「从规则库添加」：5etools 里任何专长、可选特性、物品、法术，没数据化也能加到卡上，
 *   至少能看原文、记次数（资源池进人物卡和战斗）。
 */
import { useMemo, useState } from 'react';
import { HR_SOURCE, sourceKeyOf, type HomeRuleEntry, type Json, type SourceSpec } from '../../src/sheet';
import { Entries } from '../components/Entries';
import { Term } from '../components/Term';
import { termOfKey } from '../lib/terms';
import { Field, Panel, Tag } from '../components/ui';
import type { Engine } from '../lib/engine';
import { cardCampaign, combatFor, effectiveItems, newItemId, pickablesOf, pickablesOfItems, saveLibraryItem, shareItem, useHub, useLibrary, type LibraryItem } from '../lib/library';
import { AiDatafy } from '../components/AiDatafy';
import { kindOfKey } from '../../src/library';
import { aiExamples, aiSheetExamplesText, aiSpec, partsFromAnswer, partsJobForKey } from '../lib/ai';
import { actions, stripDerived, useApp } from '../lib/store';
import { useSync } from '../lib/sync';

interface Props { engine: Engine; id: string; char: Json; sheet: Json }

const KIND_CN: Record<string, string> = {
  race: '种族', background: '背景', feat: '专长', classFeature: '职业特性', subclassFeature: '子职特性',
  optfeature: '可选特性', homerule: '家规 / 导入', item: '物品', spell: '法术',
};
const RECOVERY = [['long', '长休恢复'], ['short', '短休恢复'], ['none', '不自动恢复']] as const;

/** 去掉内部字段（_ 开头），给人看 */
const clean = (v: unknown): unknown => (Array.isArray(v) ? v.map(clean)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([k]) => !k.startsWith('_')).map(([k, x]) => [k, clean(x)])) : v);

function originalEntries(engine: Engine, char: Json, s: SourceSpec): Json[] {
  const res = char._resolved || {};
  if (s.kind === 'classFeature' || s.kind === 'subclassFeature') {
    for (const k of res.classes || []) {
      if (k.cls?.name !== s.cls) continue;
      const f = [...(k.features || []), ...(k.subFeatures || [])].find((x: Json) => x.name === s.name && x.level === s.level);
      if (f) return f.entries || [];
    }
  }
  if (s.kind === 'feat') return (res.feats || []).find((f: Json) => f.name === s.name)?.entries || [];
  if (s.kind === 'race') return res.race?.entries || [];
  if (s.kind === 'background') return res.background?.entries || [];
  if (s.kind === 'optfeature') {
    return (engine.env.store.data.optionalfeatures?.optionalfeature || []).find((o: Json) => o.name === s.name && o.source === s.source)?.entries || [];
  }
  if (s.kind === 'homerule') {
    const h = (char.homerules || []).find((x: HomeRuleEntry) => x.id === s.name);
    return h?.entries || (h?.text ? [h.text] : []);
  }
  return [];
}

const hasCardData = (a: Json) => !!a && ['mods', 'grants', 'choices', 'resources'].some((k) => (a[k] || []).length);
const isAiCard = (a: Json) => !!a && (a.confidence === 'ai' || (a.resources || []).some((r: Json) => r.by === 'ai'));

export function SheetData(p: Props) {
  const { engine, char } = p;
  const sources = engine.env.abilities.collectSources(char);
  const homerules: HomeRuleEntry[] = char.homerules || [];
  const [open, setOpen] = useState<string | null>(null);
  const [editing, setEditing] = useState<HomeRuleEntry | null>(null);
  const cid = cardCampaign(useApp().cards[p.id]);
  const hub = useHub(cid);
  const sync = useSync();
  const [msg, setMsg] = useState('');
  const [ai, setAi] = useState<{ s: SourceSpec; key: string; card: Json; existing?: LibraryItem } | null>(null);
  /** 生效内容（我的库 + 这个战役开着的）里给这条能力补的战斗数据 */
  const hubCombatOf = (key: string) => combatFor(key, hub);
  const campIds = new Set(effectiveItems(hub).flatMap((it) => (it.parts ?? []).map((x) => x.id)));
  // 可选内容 = 我的库里「选了才生效」的 + 本团生效的（同一条只列一次）
  const myItems = useLibrary();
  const pickables = [...pickablesOfItems(myItems), ...pickablesOf(hub)]
    .filter((x, i, a) => a.findIndex((y) => y.part.id === x.part.id) === i);
  const picked: string[] = char.hrPicked || [];
  const togglePick = (hrId: string) => actions.update(p.id, (c) => {
    const cur: string[] = c.hrPicked || [];
    c.hrPicked = cur.includes(hrId) ? cur.filter((x) => x !== hrId) : [...cur, hrId];
  });

  const saveHr = (e: HomeRuleEntry) => {
    actions.update(p.id, (c) => {
      const list: HomeRuleEntry[] = c.homerules || [];
      const i = list.findIndex((x) => x.id === e.id);
      c.homerules = i >= 0 ? list.map((x) => (x.id === e.id ? e : x)) : [...list, e];
    });
    setEditing(null);
  };
  const removeHr = (hrId: string) => actions.update(p.id, (c) => { c.homerules = (c.homerules || []).filter((x: HomeRuleEntry) => x.id !== hrId); });

  /** 从官方数据起一条覆盖它的家规 */
  const startCover = (s: SourceSpec, card: Json) => {
    const base = clean(card || {}) as Json;
    setEditing({
      ...engine.env.abilities.hrBlank(), name: s.name, covers: sourceKeyOf(s),
      text: `覆盖「${s.name}」`, mods: base.mods || [], grants: base.grants || [], choices: base.choices || [], resources: base.resources || [],
    });
  };

  return (
    <div className="stack">
      <Panel
        title="这张卡的能力"
        aside={<>
          <span>{sources.length} 项</span>
          {/* 从零建一条家规能力（不走「覆盖官方」也不走「从规则库导入」） */}
          <button
            className="btn sm"
            onClick={() => setEditing({ ...engine.env.abilities.hrBlank(), name: '新家规能力' })}
            title="建一条只属于这张卡的能力：名字、说明、加值、次数池都在弹窗里填"
          >＋ 新建</button>
        </>}
        flush
      >
        <table className="rows datatable">
          <thead><tr><th>能力</th><th>类别</th><th>卡面数据</th><th>战斗数据</th><th /></tr></thead>
          <tbody>
            {sources.map((s) => {
              const key = sourceKeyOf(s);
              const isHr = s.source === HR_SOURCE;
              const hr = isHr ? homerules.find((x) => x.id === s.name) : homerules.find((x) => x.covers === key);
              const card = engine.env.abilities.resolve(s);
              const hubC = isHr ? null : hubCombatOf(key);
              const combat = isHr ? undefined : (hubC?.part.combat?.entry as import('../../src/combat').Entry | undefined) ?? engine.rules.entry(key);
              const aiTag = (combat?.tags || []).includes('ai');
              const rowOpen = open === key;
              return (
                <FragmentRow key={key}>
                  <tr className={rowOpen ? 'on' : ''} onClick={() => setOpen(rowOpen ? null : key)} style={{ cursor: 'pointer' }}>
                    <td className="serif">{isHr ? <>{hr?.name || s.displayName || s.name}{campIds.has(s.name) && <Tag>本团</Tag>}</> : (() => { const t = termOfKey(key); return t ? <Term {...t} inButton>{s.name}</Term> : s.name; })()}{s.level ? <span className="faint small"> {s.level} 级</span> : null}</td>
                    <td className="small muted">{KIND_CN[s.kind] ?? s.kind}{s.cls ? ` · ${s.cls}` : ''}</td>
                    <td>
                      {hr && !isHr ? <Tag tone="warn">家规覆盖</Tag>
                        : hasCardData(card) ? <Tag tone={isAiCard(card) ? undefined : 'accent'}>{isAiCard(card) ? 'AI 补的' : '有'}</Tag>
                          : <span className="faint small">没有</span>}
                    </td>
                    <td>
                      {isHr ? <span className="faint small">—</span>
                        : combat ? <Tag tone={aiTag ? undefined : 'accent'}>{hubC ? (hubC.from === 'mine' ? '我的库 · ' : '本团 · ') : ''}{aiTag ? (hubC?.item.reviewed ? 'AI · 已看过' : 'AI 未审') : '手写'}{combat.automation && combat.automation !== 'full' ? ` · ${combat.automation === 'manual' ? '手动' : '部分'}` : ''}</Tag>
                          : <span className="faint small">没有</span>}
                    </td>
                    <td className="tiny faint">{rowOpen ? '收起' : '展开'}</td>
                  </tr>
                  {rowOpen && (
                    <tr className="detail"><td colSpan={5}>
                      <div className="datagrid">
                        <section>
                          <h4>原文</h4>
                          <div className="prose small"><Entries entries={originalEntries(engine, char, s)} /></div>
                        </section>
                        <section>
                          <h4>卡面数据 <span className="faint tiny">{key}</span></h4>
                          {hasCardData(card) ? <pre className="json">{JSON.stringify(clean({ mods: card.mods, grants: card.grants, choices: card.choices, resources: card.resources }), null, 1)}</pre>
                            : <div className="small muted">没有：人物卡不会因为这项能力自动加任何东西。</div>}
                        </section>
                        <section>
                          <h4>战斗数据</h4>
                          {combat ? <pre className="json">{JSON.stringify(combat, null, 1)}</pre>
                            : <div className="small muted">没有：战斗里只能手动处理。</div>}
                        </section>
                      </div>
                      <div className="row" style={{ marginTop: 8 }}>
                        {isHr && hr && <>
                          <button className="btn sm" onClick={() => setEditing(hr)}>编辑</button>
                          <button className="btn ghost sm danger" onClick={() => { if (confirm(`从这张卡上拿掉「${hr.name}」？`)) removeHr(hr.id); }}>拿掉</button>
                        </>}
                        {!isHr && (hr
                          ? <>
                            <button className="btn sm" onClick={() => setEditing(hr)}>编辑家规</button>
                            <button className="btn ghost sm danger" onClick={() => { if (confirm('删掉这条家规，恢复官方数据？')) removeHr(hr.id); }}>恢复官方数据</button>
                          </>
                          : <button className="btn sm" onClick={() => startCover(s, card)}>用家规覆盖（只改这张卡）</button>)}
                        {!isHr && sync.user && (!combat || combat.automation === 'manual' || hubC) && (
                          <button className="btn sm" onClick={() => setAi({ s, key, card, existing: hubC?.from === 'mine' ? hubC.item : undefined })}>{hubC ? 'AI 再写一遍（卡面 + 战斗）…' : 'AI 写数据（卡面 + 战斗，存进我的资料库）…'}</button>
                        )}
                      </div>
                    </td></tr>
                  )}
                </FragmentRow>
              );
            })}
          </tbody>
        </table>
      </Panel>

      {msg && <div className="small ok">{msg}</div>}

      {pickables.length > 0 && (
        <Panel title="可选内容" aside={<span className="small muted">你的资料库 / 本团里的；勾上才对这张卡生效</span>}>
          <div className="stack" style={{ gap: 4 }}>
            {pickables.map(({ part, item }) => (
              <label key={part.id} className="row small" style={{ gap: 6, alignItems: 'flex-start' }}>
                <input type="checkbox" checked={picked.includes(part.id)} onChange={() => togglePick(part.id)} />
                <span className="serif" style={{ minWidth: 100 }}>{part.name || item.name}</span>
                <span className="muted">{(part.text ?? item.text ?? '').slice(0, 120)}{(part.text ?? item.text ?? '').length > 120 ? '…' : ''}</span>
              </label>
            ))}
          </div>
        </Panel>
      )}

      <ImportPanel engine={engine} onAdd={(e) => setEditing(e)} />

      {ai && (
        <AiDatafy
          title={`AI 写「${ai.s.name}」的数据（卡面 + 战斗）`}
          initial={ai.existing ? {
            parts: ai.existing.parts.map((p) => ({
              key: p.key, name: p.name, text: p.text, sheet: p.sheet, combat: p.combat?.entry ?? p.combat,
            })),
          } : undefined}
          saveLabel="存进我的资料库"
          spec={aiSpec('both')}
          examples={`${aiExamples()}\n\n## 卡面数据的例子（真实数据，照这个粒度写）\n\n${aiSheetExamplesText()}`}
          prepare={() => partsJobForKey(engine, cid, { key: ai.key, name: ai.s.name, text: '', smokeChar: stripDerived(p.char) })}
          onSave={async (a, by) => {
            const parts = partsFromAnswer(a, { key: ai.key, existing: ai.existing });
            if (!parts.length) return ['AI 没给出内容（parts 是空的）'];
            const item: LibraryItem = {
              id: ai.existing?.id ?? newItemId(),
              kind: ai.existing?.kind ?? kindOfKey(ai.key),
              name: ai.existing?.name ?? ai.s.name,
              text: ai.existing?.text ?? `给「${ai.s.name}」写的数据（卡面 + 战斗）`,
              parts, by, reviewed: false,
            };
            const problems = await saveLibraryItem(item);
            if (problems.length) return problems;
            if (cid) {
              const state = await shareItem(cid, item.id);
              setMsg(state === 'pending'
                ? `「${item.name}」存进你的资料库了。它覆盖官方规则，已挂到这个战役，等 DM 点头。`
                : `「${item.name}」存进你的资料库了，这个战役里的人立刻能用。`);
            } else {
              setMsg(`「${item.name}」存进你的资料库了，你自己的卡都能用。`);
            }
            return [];
          }}
          onClose={() => setAi(null)}
        />
      )}

      {editing && <HrEditor engine={engine} entry={editing} onCancel={() => setEditing(null)} onSave={saveHr} />}
    </div>
  );
}

function FragmentRow({ children }: { children: React.ReactNode }) { return <>{children}</>; }

/* ───────────── 从规则库添加 ───────────── */

interface LibItem { kind: string; name: string; source: string; entries: Json[] }

function libraryOf(engine: Engine): LibItem[] {
  const d = engine.env.store.data;
  const out: LibItem[] = [];
  const add = (kind: string, list: Json[] | undefined) => {
    for (const x of list || []) if (x?.name) out.push({ kind, name: x.name, source: x.source || '', entries: x.entries || [] });
  };
  add('feat', d.feats?.feat);
  add('optfeature', d.optionalfeatures?.optionalfeature);
  add('item', d.items?.item);
  add('spell', engine.env.store.spellsAll);
  return out;
}

function ImportPanel({ engine, onAdd }: { engine: Engine; onAdd: (e: HomeRuleEntry) => void }) {
  const lib = useMemo(() => libraryOf(engine), [engine]);
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('');
  const [pick, setPick] = useState<LibItem | null>(null);
  const query = q.trim();
  const hits = query ? lib.filter((x) => (!kind || x.kind === kind) && x.name.includes(query)).slice(0, 40) : [];
  return (
    <Panel title="从规则库添加" aside={<span>没数据化的也能加：显示原文、记次数</span>}>
      <div className="row">
        <input placeholder="搜名字（专长、可选特性、物品、法术）" value={q} onChange={(e) => { setQ(e.target.value); setPick(null); }} style={{ flex: 1, minWidth: 200 }} />
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">全部</option>
          {['feat', 'optfeature', 'item', 'spell'].map((k) => <option key={k} value={k}>{KIND_CN[k]}</option>)}
        </select>
      </div>
      {query && !hits.length && <div className="small muted" style={{ marginTop: 8 }}>没找到。</div>}
      {hits.length > 0 && (
        <div className="importlist">
          {hits.map((x, i) => (
            <button key={i} type="button" className={'opt' + (pick === x ? ' on' : '')} onClick={() => setPick(x)}>
              <span style={{ flex: 1 }} className="serif">{x.name}</span>
              <span className="tiny faint">{KIND_CN[x.kind]} · {x.source}</span>
            </button>
          ))}
        </div>
      )}
      {pick && (
        <div className="stack" style={{ marginTop: 10 }}>
          <div className="preview prose"><Entries entries={pick.entries} /></div>
          <div className="row">
            <button className="btn primary sm" onClick={() => onAdd({
              ...engine.env.abilities.hrBlank(), name: pick.name, text: `从规则库导入：${KIND_CN[pick.kind]}「${pick.name}」（${pick.source}）`,
              entries: pick.entries, ref: { kind: pick.kind, source: pick.source, name: pick.name },
            })}>加到这张卡…</button>
            <span className="small muted">下一步可以给它加一个次数池（比如「每次长休 1 次」）。</span>
          </div>
        </div>
      )}
    </Panel>
  );
}

/* ───────────── 家规编辑器 ───────────── */

function HrEditor({ engine, entry, onSave, onCancel }: { engine: Engine; entry: HomeRuleEntry; onSave: (e: HomeRuleEntry) => void; onCancel: () => void }) {
  const [e, setE] = useState<HomeRuleEntry>(structuredClone(entry));
  const [adv, setAdv] = useState(JSON.stringify({ mods: e.mods || [], grants: e.grants || [], choices: e.choices || [] }, null, 1));
  const [err, setErr] = useState('');
  const res: Json[] = e.resources || [];
  const setRes = (i: number, patch: Json) => setE({ ...e, resources: res.map((r, j) => (j === i ? { ...r, ...patch } : r)) });

  const save = () => {
    let parsed: Json;
    try { parsed = JSON.parse(adv || '{}'); } catch (x) { setErr('高级数据不是合法的 JSON：' + (x as Error).message); return; }
    for (const r of res) {
      if (!r.name?.trim()) { setErr('次数池要有名字'); return; }
      const v = engine.env.resources.resolveFormula(r.formula, { level: 20, pb: 6, 'mod:str': 3, 'mod:dex': 3, 'mod:con': 3, 'mod:int': 3, 'mod:wis': 3, 'mod:cha': 3 }, null);
      if (v == null) { setErr(`次数池「${r.name}」的上限「${r.formula}」算不出数（可以写数字、pb、wis、max(1, cha) 这类）`); return; }
    }
    onSave({
      ...e, name: e.name?.trim() || '未命名',
      mods: parsed.mods || [], grants: parsed.grants || [], choices: parsed.choices || [],
      resources: res.map((r) => ({ ...r, id: r.id || `${e.id}-${r.name}` })),
    });
  };

  return (
    <div className="overlay" onMouseDown={(ev) => { if (ev.target === ev.currentTarget) onCancel(); }}>
      <section className="panel dialog wide" role="dialog" aria-modal="true">
        <header><h3>{e.covers ? `家规：覆盖 ${e.covers}` : '家规 / 导入的能力'}</h3></header>
        <div className="body">
          <Field label="名字"><input value={e.name || ''} onChange={(x) => setE({ ...e, name: x.target.value })} /></Field>
          <Field label="说明（会显示在卡上）"><textarea rows={2} value={e.text || ''} onChange={(x) => setE({ ...e, text: x.target.value })} /></Field>
          <div>
            <div className="small faint" style={{ marginBottom: 4 }}>次数池（进人物卡的资源，战斗里也能用）</div>
            {res.map((r, i) => (
              <div className="row" key={i} style={{ marginBottom: 4 }}>
                <input placeholder="名字" value={r.name || ''} onChange={(x) => setRes(i, { name: x.target.value })} style={{ width: 140 }} />
                <input placeholder="上限：1 / pb / max(1, wis)" value={String(r.formula ?? '')} onChange={(x) => setRes(i, { formula: x.target.value })} style={{ width: 170 }} />
                <select value={r.recovery || 'long'} onChange={(x) => setRes(i, { recovery: x.target.value })}>
                  {RECOVERY.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
                <button className="btn ghost sm danger" onClick={() => setE({ ...e, resources: res.filter((_, j) => j !== i) })}>删</button>
              </div>
            ))}
            <button className="btn sm" onClick={() => setE({ ...e, resources: [...res, { name: e.name || '', formula: '1', recovery: 'long' }] })}>加一个次数池</button>
          </div>
          <details>
            <summary className="small">高级：卡面数据（mods / grants / choices，JSON）</summary>
            <textarea rows={10} className="mono" value={adv} onChange={(x) => setAdv(x.target.value)} style={{ width: '100%', marginTop: 6 }} />
          </details>
          {err && <div className="dangerline small">{err}</div>}
        </div>
        <footer>
          <button className="btn" onClick={onCancel}>取消</button>
          <button className="btn primary" onClick={save}>保存到这张卡</button>
        </footer>
      </section>
    </div>
  );
}
