/** 战役遭遇：选战役、进入或开一场在服务器上跑的遭遇 */
import { useEffect, useState } from 'react';
import { api, type Campaign } from '../../lib/api';
import { combat } from '../../lib/combat';
import type { Engine } from '../../lib/engine';
import { useSync } from '../../lib/sync';
import { Dialog, Tag } from '../../components/ui';

interface EncRow { id: string; name: string; updated: number }

export function OnlineDialog({ engine, onClose }: { engine: Engine; onClose: () => void }) {
  const sync = useSync();
  const [camps, setCamps] = useState<Campaign[] | null>(null);
  const [encs, setEncs] = useState<Record<string, EncRow[]>>({});
  const [name, setName] = useState('');
  const [err, setErr] = useState('');

  const load = async () => {
    try {
      const { campaigns } = await api<{ campaigns: Campaign[] }>('GET', 'campaigns');
      setCamps(campaigns);
      const out: Record<string, EncRow[]> = {};
      for (const c of campaigns) out[c.id] = (await api<{ encounters: EncRow[] }>('GET', `campaigns/${c.id}/encounters`)).encounters;
      setEncs(out);
    } catch (e) { setErr((e as Error).message); }
  };
  useEffect(() => { if (sync.user) void load(); }, [sync.user]);

  const enter = async (id: string) => {
    try { await combat.join(engine, id); onClose(); } catch (e) { setErr((e as Error).message); }
  };

  return (
    <Dialog title="战役遭遇" onClose={onClose}>
      {!sync.user ? <div className="muted">先登录（右上角），再在「战役」页建团或加入。</div>
        : camps === null ? <div className="empty">正在读取…</div>
          : !camps.length ? <div className="muted">你还不在任何战役里。去「战役」页建团或用邀请码加入。</div>
            : (
              <div className="stack">
                <div className="small muted">战役遭遇在服务器上跑：团里每个人打开同一场，看到的是同一个战斗；玩家操作自己的角色、回答问自己的决定，DM 管其他的。</div>
                {camps.map((c) => (
                  <div key={c.id} className="stack" style={{ gap: 4 }}>
                    <div className="row"><b className="serif">{c.name}</b><Tag tone={c.role === 'dm' ? 'accent' : undefined}>{c.role === 'dm' ? 'DM' : '玩家'}</Tag></div>
                    {(encs[c.id] || []).map((e) => (
                      <div key={e.id} className="row small">
                        <span style={{ flex: 1 }}>{e.name} <span className="faint">· {new Date(e.updated).toLocaleString('zh-CN')}</span></span>
                        <button className="btn sm primary" onClick={() => void enter(e.id)}>进入</button>
                        {c.role === 'dm' && <button className="btn ghost sm danger" onClick={() => {
                          if (confirm(`删除遭遇「${e.name}」？日志会一起删掉。`)) void api('DELETE', `encounters/${e.id}`).then(load, (x: Error) => setErr(x.message));
                        }}>删除</button>}
                      </div>
                    ))}
                    {!(encs[c.id] || []).length && <div className="small faint">还没有遭遇。</div>}
                    {c.role === 'dm' && (
                      <form className="row" onSubmit={(ev) => {
                        ev.preventDefault();
                        void api<{ id: string }>('POST', `campaigns/${c.id}/encounters`, { name: name || '遭遇' }).then((r) => enter(r.id), (x: Error) => setErr(x.message));
                      }}>
                        <input placeholder="新遭遇的名字" value={name} onChange={(ev) => setName(ev.target.value)} style={{ width: 160 }} />
                        <button className="btn sm">开一场新遭遇</button>
                      </form>
                    )}
                  </div>
                ))}
              </div>
            )}
      {err && <div className="dangerline small">{err}</div>}
    </Dialog>
  );
}
