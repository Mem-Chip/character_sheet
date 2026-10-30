/**
 * 遭遇管理（战斗页没进任何遭遇时显示）：各战役的遭遇列表、进入、新开（可以沿用某一场的地图）、删除，
 * 最上面是「继续上次的遭遇」。本地遭遇（不联网、只存在这台电脑上）只留底下一个小入口。
 */
import { useEffect, useState } from 'react';
import { api, type Campaign } from '../../lib/api';
import { combat, lastEncounter } from '../../lib/combat';
import type { Engine } from '../../lib/engine';
import { actions } from '../../lib/store';
import { useSync } from '../../lib/sync';
import { Tag } from '../../components/ui';

interface EncRow { id: string; name: string; updated: number }

const when = (t: number) => {
  const d = Date.now() - t;
  if (d < 60_000) return '刚刚';
  if (d < 3600_000) return `${Math.floor(d / 60_000)} 分钟前`;
  if (d < 86400_000) return `${Math.floor(d / 3600_000)} 小时前`;
  return new Date(t).toLocaleDateString('zh-CN');
};

export function EncounterHub({ engine, onLocal }: { engine: Engine; onLocal: () => void }) {
  const sync = useSync();
  const [camps, setCamps] = useState<Campaign[] | null>(null);
  const [encs, setEncs] = useState<Record<string, EncRow[]>>({});
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const { campaigns } = await api<{ campaigns: Campaign[] }>('GET', 'campaigns');
      const lists = await Promise.all(campaigns.map((c) => api<{ encounters: EncRow[] }>('GET', `campaigns/${c.id}/encounters`)));
      setEncs(Object.fromEntries(campaigns.map((c, i) => [c.id, lists[i].encounters])));
      setCamps(campaigns);
    } catch (e) { setErr((e as Error).message); }
  };
  useEffect(() => { if (sync.user) void load(); }, [sync.user]);

  const enter = async (id: string) => {
    setBusy(true);
    try { await combat.join(engine, id); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  // 上次进的那场（还在列表里才显示）
  const lastId = lastEncounter();
  const last = camps && lastId ? camps.flatMap((c) => (encs[c.id] ?? []).map((e) => ({ e, c }))).find((x) => x.e.id === lastId) : null;

  return (
    <div className="page hub">
      <div className="combat-bar">
        <h2 className="serif">遭遇</h2>
        <span className="muted small">战役遭遇在服务器上跑：团里每个人打开同一场，看到的是同一个战斗。</span>
        <span style={{ flex: 1 }} />
        {sync.user && <button className="btn ghost sm" onClick={() => void load()}>刷新</button>}
      </div>

      {!sync.user ? (
        <div className="panel hub-empty">
          <p>登录之后，这里会列出你所在战役的遭遇（右上角登录）。</p>
          <p className="muted small">还没有战役？登录后去「战役」页建团，或者用邀请码加入。</p>
        </div>
      ) : camps === null ? <div className="empty">正在读取…</div>
        : !camps.length ? (
          <div className="panel hub-empty">
            <p>你还不在任何战役里。</p>
            <button className="btn primary" onClick={() => actions.go('campaigns')}>去「战役」页建团或加入</button>
          </div>
        ) : (
          <div className="stack">
            {last && (
              <div className="panel hub-last">
                <div>
                  <div className="tiny faint">上次的遭遇</div>
                  <b className="serif">{last.e.name}</b> <span className="muted small">· {last.c.name} · {when(last.e.updated)}</span>
                </div>
                <button className="btn primary" disabled={busy} onClick={() => void enter(last.e.id)}>继续</button>
              </div>
            )}
            <div className="hub-grid">
              {camps.map((c) => <CampaignCard key={c.id} c={c} list={encs[c.id] ?? []} busy={busy} onEnter={enter} onChanged={load} onErr={setErr} />)}
            </div>
          </div>
        )}

      {err && <div className="dangerline small">{err}</div>}

      <div className="hub-local small muted">
        只想自己试试规则？<button className="btn ghost sm" onClick={onLocal}>打开本地遭遇</button>（不联网，只存在这台电脑上）
      </div>
    </div>
  );
}

function CampaignCard(p: { c: Campaign; list: EncRow[]; busy: boolean; onEnter: (id: string) => Promise<void>; onChanged: () => Promise<void>; onErr: (e: string) => void }) {
  const { c, list } = p;
  const dm = c.role === 'dm';
  const [name, setName] = useState('');
  // 新遭遇沿用哪一场的地图（底图、格子、画的东西；棋子不带）。默认沿用最近那场
  const [mapFrom, setMapFrom] = useState<string>(list[0]?.id ?? '');
  useEffect(() => { if (mapFrom && !list.some((e) => e.id === mapFrom)) setMapFrom(list[0]?.id ?? ''); }, [list]);

  const create = async () => {
    try {
      const r = await api<{ id: string }>('POST', `campaigns/${c.id}/encounters`, { name: name.trim() || '遭遇', ...(mapFrom ? { copyMapFrom: mapFrom } : {}) });
      setName('');
      await p.onEnter(r.id);
    } catch (e) { p.onErr((e as Error).message); }
  };
  const remove = (e: EncRow) => {
    if (!confirm(`删除遭遇「${e.name}」？日志和地图会一起删掉。`)) return;
    api('DELETE', `encounters/${e.id}`).then(p.onChanged, (x: Error) => p.onErr(x.message));
  };

  return (
    <section className="panel hub-camp">
      <div className="hub-camp-hd">
        <b className="serif">{c.name}</b>
        <Tag tone={dm ? 'accent' : undefined}>{dm ? 'DM' : '玩家'}</Tag>
        <span className="tiny faint">{list.length} 场</span>
      </div>
      <div className="hub-list">
        {list.map((e) => (
          <div key={e.id} className="hub-row">
            <span className="nm">{e.name}</span>
            <span className="tiny faint">{when(e.updated)}</span>
            <button className="btn sm primary" disabled={p.busy} onClick={() => void p.onEnter(e.id)}>进入</button>
            {dm && <button className="btn ghost sm danger" onClick={() => remove(e)} title="删除这场遭遇">删除</button>}
          </div>
        ))}
        {!list.length && <div className="small faint">{dm ? '还没有遭遇，在下面开一场。' : '还没有遭遇，等 DM 开一场。'}</div>}
      </div>
      {dm && (
        <form className="hub-new" onSubmit={(ev) => { ev.preventDefault(); void create(); }}>
          <input placeholder="新遭遇的名字" value={name} onChange={(ev) => setName(ev.target.value)} />
          {list.length > 0 && (
            <select value={mapFrom} onChange={(ev) => setMapFrom(ev.target.value)} title="新遭遇的地图从哪来">
              <option value="">空白地图</option>
              {list.map((e) => <option key={e.id} value={e.id}>沿用「{e.name}」的地图</option>)}
            </select>
          )}
          <button className="btn sm" disabled={p.busy}>开一场新遭遇</button>
        </form>
      )}
    </section>
  );
}
