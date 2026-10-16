/** 人物卡「物品」页：钱包（收支流水）、负重、同调、装备中 / 背包、加物品（普通装备、魔法物品、自定义） */
import { useMemo, useState } from 'react';
import type { CharData, Json } from '../../src/sheet';
import { Source } from '../../src/sheet';
import { healDiceOf, isConsumable } from '../../src/bridge/from-sheet';
import { NumInput, Panel } from '../components/ui';
import { Term } from '../components/Term';
import type { Engine } from '../lib/engine';
import { actions } from '../lib/store';

const upd = (id: string, fn: (c: CharData) => void) => actions.update(id, fn);

const COINS: Array<[string, string, number]> = [['pp', '铂币', 10], ['gp', '金币', 1], ['ep', '银金币', 0.5], ['sp', '银币', 0.1], ['cp', '铜币', 0.01]];
const COIN_ALIAS: Array<[RegExp, string]> = [[/^(pp|铂|铂金|铂币|铂金币)$/i, 'pp'], [/^(gp|金|金币)$/i, 'gp'], [/^(ep|银金|银金币)$/i, 'ep'], [/^(sp|银|银币)$/i, 'sp'], [/^(cp|铜|铜币)$/i, 'cp']];
const RARITY: Record<string, string> = { common: '普通', uncommon: '非普通', rare: '珍稀', 'very rare': '非常珍稀', legendary: '传说', artifact: '神器', varies: '不定' };

/** 「+15金 -3 银」「-2gp」→ { gp: 15, sp: -3 } */
function parseCoins(s: string): Record<string, number> | null {
  const out: Record<string, number> = {};
  const re = /([+-]?)\s*(\d+)\s*([a-z]+|[一-鿿]+)/gi;
  let m: RegExpExecArray | null, any = false;
  while ((m = re.exec(s))) {
    const coin = COIN_ALIAS.find(([r]) => r.test(m![3]))?.[1];
    if (!coin) return null;
    out[coin] = (out[coin] ?? 0) + (m[1] === '-' ? -1 : 1) * Number(m[2]);
    any = true;
  }
  return any ? out : null;
}

/** 掷「2d4 + 2」 */
function rollText(d: string): number {
  const m = /(\d+)d(\d+)\s*([+-]\s*\d+)?/.exec(d);
  if (!m) return Number(d) || 0;
  let t = Number((m[3] ?? '0').replace(/\s/g, ''));
  for (let i = 0; i < Number(m[1]); i++) t += 1 + Math.floor(Math.random() * Number(m[2]));
  return t;
}

export function SheetItems({ engine, id, char, sheet }: { engine: Engine; id: string; char: Json; sheet: Json }) {
  const env = engine.env;
  const eq: Json[] = char.equipment || [];
  const resolved: Json[] = char._resolved?.equipment || [];
  const purse = char.purse || {};
  const weight = env.items.weight(char, sheet);
  const attuned = eq.filter((e) => e.attuned).length;
  const [flow, setFlow] = useState('');
  const [flowNote, setFlowNote] = useState('');
  const [flowErr, setFlowErr] = useState('');
  const [msg, setMsg] = useState('');

  const total = COINS.reduce((a, [k, , v]) => a + (Number(purse[k]) || 0) * v, 0);
  const applyFlow = () => {
    const d = parseCoins(flow);
    if (!d) { setFlowErr('写成「+15 金」「-3 银 -2 铜」这样'); return; }
    upd(id, (c) => {
      c.purse = { ...(c.purse || {}) };
      for (const [k, n] of Object.entries(d)) c.purse[k] = Math.max(0, (Number(c.purse[k]) || 0) + n);
      c.purseLog = [{ at: Date.now(), delta: d, note: flowNote.trim() }, ...(c.purseLog || [])].slice(0, 50);
    });
    setFlow(''); setFlowNote(''); setFlowErr('');
  };

  const use = (i: number) => {
    const r = resolved[i];
    const heal = healDiceOf(r?._ent);
    let note = `用掉一个「${eq[i].name}」`;
    upd(id, (c) => {
      const e = c.equipment[i];
      const q = (Number(e.qty) || 1) - 1;
      if (q <= 0) c.equipment.splice(i, 1); else e.qty = q;
      if (heal) {
        const n = rollText(heal);
        const max = sheet.hpMax ?? 0;
        const cur = c.hp?.current ?? max;
        const next = Math.min(max, cur + n);
        c.hp = { ...(c.hp || {}), current: next >= max ? null : next };
        note += `：${heal} = ${n}，生命值 ${cur} → ${next}`;
      }
    });
    setMsg(note + (heal ? '' : '（效果请自己处理）'));
  };

  const rows = eq.map((e, i) => ({ e, r: resolved[i], i }));
  const table = (list: typeof rows) => (
    <table className="rows items-table">
      <tbody>
        {list.map(({ e, r, i }) => {
          const ent = r?._ent;
          const rarity = ent?.rarity && ent.rarity !== 'none' ? RARITY[ent.rarity] ?? ent.rarity : '';
          const needAttune = !!ent?.reqAttune;
          const mundaneGear = ent && (ent.weapon || ent.armor || String(ent.type).split('|')[0] === 'S') && !ent.bonusWeapon && !ent.bonusAc && !rarity;
          return (
            <tr key={i}>
              <td className="serif">
                {ent && !e.custom ? <Term kind="item" name={ent.name}>{e.name}</Term> : e.name}
                {e.bonus ? <b className="tiny"> +{e.bonus}</b> : null}
                {rarity && <span className="tag">{rarity}</span>}
                {needAttune && <span className={'tag' + (e.attuned ? ' on' : '')} title={typeof ent.reqAttune === 'string' ? `需要同调（${ent.reqAttune}）` : '需要同调才生效'}>{e.attuned ? '已同调' : '需同调'}</span>}
                {!ent && !e.custom && <span className="warnline tiny"> 数据里找不到</span>}
                {e.custom?.desc && <div className="tiny faint">{e.custom.desc}</div>}
              </td>
              <td style={{ width: 66 }}><NumInput min={1} value={e.qty ?? 1} onChange={(n) => upd(id, (c) => { c.equipment[i].qty = n; })} style={{ width: 56 }} /></td>
              <td className="r nowrap">
                {mundaneGear && (
                  <select value={e.bonus ?? 0} onChange={(ev) => upd(id, (c) => { const n = Number(ev.target.value); if (n) c.equipment[i].bonus = n; else delete c.equipment[i].bonus; })} title="魔法武器 / 护甲的加值">
                    <option value={0}>普通</option><option value={1}>+1</option><option value={2}>+2</option><option value={3}>+3</option>
                  </select>
                )}
                {ent && isConsumable(ent) && <button className="btn sm" onClick={() => use(i)}>使用</button>}
                {needAttune && (
                  <button className={'btn sm' + (e.attuned ? ' on' : '')} disabled={!e.attuned && attuned >= 3}
                    title={!e.attuned && attuned >= 3 ? '同调已满 3 个' : ''}
                    onClick={() => upd(id, (c) => { c.equipment[i].attuned = !e.attuned; })}>{e.attuned ? '解除同调' : '同调'}</button>
                )}
                <button className={'btn sm' + (e.equipped ? ' on' : '')} onClick={() => upd(id, (c) => { c.equipment[i].equipped = !e.equipped; })}>{e.equipped ? '卸下' : '装备'}</button>
                <button className="btn ghost sm" onClick={() => { if (confirm(`扔掉「${e.name}」？`)) upd(id, (c) => { c.equipment.splice(i, 1); }); }}>移除</button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );

  return (
    <div className="items-page">
      <Panel title="钱包" aside={<span className="tiny">合计约 {Math.round(total * 100) / 100} 金币</span>}>
        <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
          {COINS.map(([k, label]) => (
            <label key={k} className="row tiny" style={{ gap: 4 }}>{label}
              <NumInput min={0} value={Number(purse[k]) || 0} onChange={(n) => upd(id, (c) => { c.purse = { ...(c.purse || {}), [k]: n }; })} style={{ width: 72 }} />
            </label>
          ))}
        </div>
        <div className="row" style={{ gap: 6, marginTop: 8 }}>
          <input value={flow} onChange={(e) => { setFlow(e.target.value); setFlowErr(''); }} placeholder="收支：+15 金、-3 银 -2 铜" style={{ width: 200 }} onKeyDown={(e) => e.key === 'Enter' && applyFlow()} />
          <input value={flowNote} onChange={(e) => setFlowNote(e.target.value)} placeholder="备注（买了什么、谁给的）" style={{ flex: 1, minWidth: 0 }} onKeyDown={(e) => e.key === 'Enter' && applyFlow()} />
          <button className="btn sm" onClick={applyFlow}>记一笔</button>
        </div>
        {flowErr && <div className="dangerline tiny">{flowErr}</div>}
        {(char.purseLog || []).length > 0 && (
          <details className="tiny" style={{ marginTop: 6 }}>
            <summary className="faint">最近的收支</summary>
            {(char.purseLog as Json[]).slice(0, 20).map((l, k) => (
              <div key={k} className="faint">{new Date(l.at).toLocaleDateString()}　{Object.entries(l.delta as Record<string, number>).map(([c, n]) => `${n > 0 ? '+' : ''}${n} ${COINS.find((x) => x[0] === c)?.[1] ?? c}`).join(' ')}{l.note ? `　${l.note}` : ''}</div>
            ))}
          </details>
        )}
      </Panel>

      <div className="row items-meta" style={{ gap: 18 }}>
        <span className={weight.over ? 'warnline' : ''}>负重 <b>{weight.total}</b> / {weight.capacity} 磅{weight.over ? '（超重了）' : ''}{weight.unknown ? <span className="faint tiny">（{weight.unknown} 样不知道重量）</span> : null}</span>
        <span className={attuned > 3 ? 'warnline' : ''}>同调 <b>{attuned}</b> / 3</span>
      </div>
      {msg && <div className="okline small">{msg} <button className="tag-x" onClick={() => setMsg('')}>✕</button></div>}

      <Panel title="装备中" aside={<span className="tiny">护甲、盾牌、武器算进 AC 和攻击；魔法物品的加值要装备（和同调）才算</span>} flush>
        {rows.some((x) => x.e.equipped) ? table(rows.filter((x) => x.e.equipped)) : <div className="empty">没有装备任何东西。</div>}
      </Panel>
      <Panel title="背包" flush>
        {rows.some((x) => !x.e.equipped) ? table(rows.filter((x) => !x.e.equipped)) : <div className="empty">背包是空的。</div>}
      </Panel>
      <AddItem engine={engine} id={id} />
    </div>
  );
}

function AddItem({ engine, id }: { engine: Engine; id: string }) {
  const env = engine.env;
  const [q, setQ] = useState('');
  const [custom, setCustom] = useState({ name: '', weight: '', desc: '' });
  const all = useMemo(() => {
    const d = env.store.data;
    const seen = new Set<string>();
    const out: Array<{ name: string; label: string; magic: boolean; ent: Json }> = [];
    const push = (x: Json, magic: boolean) => {
      if (!x?.name || seen.has(x.name)) return;
      seen.add(x.name);
      const t = String(x.type ?? '').split('|')[0];
      const label = magic ? RARITY[x.rarity] ?? '魔法物品' : x.weapon ? '武器' : x.armor ? '护甲' : t === 'S' ? '盾牌' : '物品';
      out.push({ name: x.name, label, magic, ent: x });
    };
    // 2024 的优先；普通装备在前
    for (const x of (d.itemsBase?.baseitem || []).filter((x: Json) => Source.is2024(x))) push(x, false);
    for (const x of (d.items?.item || []).filter((x: Json) => (!x.rarity || x.rarity === 'none') && Source.is2024(x))) push(x, false);
    for (const x of (d.items?.item || []).filter((x: Json) => x.rarity && x.rarity !== 'none' && Source.is2024(x))) push(x, true);
    for (const x of (d.items?.item || []).filter((x: Json) => x.rarity && x.rarity !== 'none')) push(x, true);
    return out;
  }, [env]);
  const t = q.trim().toLowerCase();
  const hits = t ? all.filter((x) => x.name.includes(t) || String(x.ent.ENG_name ?? '').toLowerCase().includes(t)).slice(0, 40) : [];
  const add = (name: string, extra: Json = {}) => upd(id, (c) => {
    const eq = c.equipment || [];
    const has = !extra.custom && eq.find((x: Json) => x.name === name && !x.bonus);
    if (has) has.qty = (has.qty || 1) + 1; else eq.push({ name, qty: 1, equipped: false, ...extra });
    c.equipment = eq;
  });
  return (
    <Panel title="加物品">
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索：长剑、背包、治疗药水、防护斗篷…（中文或英文）" style={{ width: '100%' }} />
      {hits.length > 0 && (
        <div className="row" style={{ marginTop: 6, flexWrap: 'wrap', gap: 4 }}>
          {hits.map((x) => (
            <button key={x.name} className="chip" onClick={() => add(x.name)} title="加进背包">
              {x.name}<small className="faint"> {x.label}</small>
            </button>
          ))}
        </div>
      )}
      <details style={{ marginTop: 8 }}>
        <summary className="tiny faint">自定义物品（数据里没有的）</summary>
        <div className="row" style={{ gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
          <input value={custom.name} onChange={(e) => setCustom({ ...custom, name: e.target.value })} placeholder="名字" style={{ width: 140 }} />
          <input value={custom.weight} onChange={(e) => setCustom({ ...custom, weight: e.target.value })} placeholder="重量（磅）" style={{ width: 90 }} />
          <input value={custom.desc} onChange={(e) => setCustom({ ...custom, desc: e.target.value })} placeholder="说明" style={{ flex: 1, minWidth: 160 }} />
          <button className="btn sm" disabled={!custom.name.trim()} onClick={() => {
            add(custom.name.trim(), { custom: { desc: custom.desc.trim(), weight: Number(custom.weight) || 0 } });
            setCustom({ name: '', weight: '', desc: '' });
          }}>加入</button>
        </div>
      </details>
    </Panel>
  );
}
