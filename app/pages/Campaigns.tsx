/**
 * 战役：建团、用邀请码加入、把自己的卡带进去。
 * DM 能看到团里所有人的卡（同步进 DM 的卡片库，标「来自 某某」），战斗页「加角色」里直接选，战斗后能写回。
 */
import { useCallback, useEffect, useState } from 'react';
import { api, type Campaign } from '../lib/api';
import { actions, useApp } from '../lib/store';
import { pull, useSync } from '../lib/sync';
import { Panel, Tag } from '../components/ui';
import { CampaignHub } from './CampaignHub';

export function CampaignsPage() {
  const sync = useSync();
  const [list, setList] = useState<Campaign[] | null>(null);
  const [err, setErr] = useState('');
  const [name, setName] = useState('');
  const [code, setCode] = useState('');

  const load = useCallback(async () => {
    try {
      setList((await api<{ campaigns: Campaign[] }>('GET', 'campaigns')).campaigns);
      setErr('');
    } catch (e) { setErr((e as Error).message); }
  }, []);
  useEffect(() => { if (sync.user) void load(); }, [sync.user, load]);

  /** 做一件事，然后刷新战役列表和卡（卡的归属变了） */
  const act = async (fn: () => Promise<unknown>) => {
    try { await fn(); setErr(''); } catch (e) { setErr((e as Error).message); }
    await load();
    await pull();
  };

  if (!sync.user) {
    return (
      <div className="page">
        <Panel title="战役">
          <p className="muted" style={{ margin: 0 }}>登录之后可以建团、用邀请码加入别人的团，把自己的卡带进去。右上角登录。</p>
        </Panel>
      </div>
    );
  }

  return (
    <div className="page stack">
      <div className="row">
        <h2 className="serif" style={{ margin: 0, fontWeight: 500 }}>战役</h2>
        <span style={{ flex: 1 }} />
      </div>
      <div className="row" style={{ flexWrap: 'wrap', gap: 12 }}>
        <form className="row" onSubmit={(e) => { e.preventDefault(); if (name.trim()) void act(() => api('POST', 'campaigns', { name })).then(() => setName('')); }}>
          <input placeholder="新战役的名字" value={name} onChange={(e) => setName(e.target.value)} style={{ width: 180 }} />
          <button className="btn primary" disabled={!name.trim()}>建团（我当 DM）</button>
        </form>
        <form className="row" onSubmit={(e) => { e.preventDefault(); if (code.trim()) void act(() => api('POST', 'campaigns/join', { code })).then(() => setCode('')); }}>
          <input placeholder="邀请码" value={code} onChange={(e) => setCode(e.target.value)} style={{ width: 110, textTransform: 'uppercase' }} />
          <button className="btn" disabled={!code.trim()}>加入</button>
        </form>
      </div>
      {err && <div className="dangerline small">{err}</div>}
      {list === null ? <div className="empty">正在读取…</div>
        : !list.length ? <div className="empty">还没有战役。建一个，或者向 DM 要邀请码。</div>
          : list.map((c) => <CampaignPanel key={c.id} c={c} act={act} />)}
    </div>
  );
}

function CampaignPanel({ c, act }: { c: Campaign; act: (fn: () => Promise<unknown>) => Promise<void> }) {
  const app = useApp();
  const sync = useSync();
  const me = sync.user!;
  const isOwner = c.ownerId === me.id;
  const myCards = app.order.map((id) => app.cards[id]).filter((k) => k && k.rev && (!k.owner || k.owner.id === me.id));
  const [pick, setPick] = useState('');

  return (
    <Panel
      title={<>{c.name} <Tag tone={c.role === 'dm' ? 'accent' : undefined}>{c.role === 'dm' ? 'DM' : '玩家'}</Tag></>}
      aside={c.role === 'dm' && c.code ? (
        <span className="row small">
          邀请码 <b style={{ letterSpacing: 1 }}>{c.code}</b>
          <button className="btn ghost sm" onClick={() => void navigator.clipboard?.writeText(c.code!)}>复制</button>
          <button className="btn ghost sm" onClick={() => { if (confirm('换一个邀请码？旧的立刻失效。')) void act(() => api('PATCH', `campaigns/${c.id}`, { newCode: true })); }}>换一个</button>
        </span>
      ) : undefined}
    >
      <div className="stack">
        <div>
          <div className="small faint" style={{ marginBottom: 4 }}>成员</div>
          <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
            {c.members.map((m) => (
              <span key={m.id} className="row" style={{ gap: 4 }}>
                <Tag tone={m.role === 'dm' ? 'accent' : undefined}>{m.name}{m.role === 'dm' ? '（DM）' : ''}</Tag>
                {isOwner && m.id !== me.id && (
                  <>
                    <button className="btn ghost sm" onClick={() => void act(() => api('POST', `campaigns/${c.id}/role`, { userId: m.id, role: m.role === 'dm' ? 'player' : 'dm' }))}>
                      {m.role === 'dm' ? '改为玩家' : '设为 DM'}
                    </button>
                    <button className="btn ghost sm danger" onClick={() => { if (confirm(`请 ${m.name} 离开？他的卡会移出这个战役。`)) void act(() => api('POST', `campaigns/${c.id}/kick`, { userId: m.id })); }}>请离</button>
                  </>
                )}
              </span>
            ))}
          </div>
        </div>

        <div>
          <div className="small faint" style={{ marginBottom: 4 }}>团里的角色</div>
          {!c.cards.length ? <div className="small muted">还没有人把卡带进来。</div> : (
            <div className="stack" style={{ gap: 4 }}>
              {c.cards.map((k) => (
                <div key={k.id} className="row small">
                  <span className="serif" style={{ minWidth: 90 }}>{k.name}</span>
                  <span className="muted" style={{ flex: 1 }}>{k.summary || '—'} · {k.ownerName}</span>
                  {(c.role === 'dm' || k.ownerId === me.id) && app.cards[k.id] && <button className="btn ghost sm" onClick={() => actions.open(k.id)}>打开</button>}
                  {k.ownerId === me.id && <button className="btn ghost sm" onClick={() => void act(() => api('PUT', `cards/${k.id}/campaign`, { campaignId: null }))}>移出</button>}
                </div>
              ))}
            </div>
          )}
          {c.role === 'dm' && c.cards.length > 0 && (
            <div className="small muted" style={{ marginTop: 6 }}>队伍的卡已经同步到你的卡片库（标「来自 某某」）。战斗页「加角色」里直接选；战斗后写回会改到玩家的卡上。</div>
          )}
        </div>

        <details>
          <summary className="small faint" style={{ cursor: 'pointer' }}>资料（启用的书、挂上来的内容）</summary>
          <div style={{ marginTop: 6 }}><CampaignHub c={c} /></div>
        </details>

        <div className="row">
          <select value={pick} onChange={(e) => setPick(e.target.value)} style={{ minWidth: 180 }}>
            <option value="">把我的一张卡带进来…</option>
            {myCards.filter((k) => k.campaignId !== c.id).map((k) => (
              <option key={k.id} value={k.id}>{k.char.name || '未命名'}{k.campaignId ? '（在别的战役里，会移过来）' : ''}</option>
            ))}
          </select>
          <button className="btn sm" disabled={!pick} onClick={() => { const id = pick; setPick(''); void act(() => api('PUT', `cards/${id}/campaign`, { campaignId: c.id })); }}>带进来</button>
          {!myCards.length && <span className="small muted">（只有传到账户里的卡能带进战役）</span>}
          <span style={{ flex: 1 }} />
          {isOwner
            ? <button className="btn ghost sm danger" onClick={() => { if (confirm(`删除战役「${c.name}」？卡不会删，只是移出。`)) void act(() => api('DELETE', `campaigns/${c.id}`)); }}>删除战役</button>
            : <button className="btn ghost sm danger" onClick={() => { if (confirm(`退出「${c.name}」？你的卡会移出这个战役。`)) void act(() => api('POST', `campaigns/${c.id}/leave`, {})); }}>退出战役</button>}
        </div>
      </div>
    </Panel>
  );
}
