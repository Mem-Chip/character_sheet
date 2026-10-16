/**
 * 「资料库」页（LIBRARY.md 第七节）：这里的内容跟着你的账户走。
 *
 * - 你自己的卡都能用（第 2 期接上卡面那一层）；
 * - 挂到战役里才会对别人生效：新内容直接生效，覆盖官方规则的要 DM 点头；
 * - 名单里能看出「挂了哪几个团、现在是什么状态」。
 */
import { useEffect, useState } from 'react';
import { api, type Campaign } from '../lib/api';
import { useSync } from '../lib/sync';
import {
  hubNow, loadHub, newItemId, newPartId, removeLibraryItem, saveLibraryItem, shareItem, unshareItem,
  useLibrary, useLibraryVersion, type LibraryItem,
} from '../lib/library';
import { ItemTags, LibraryEditor, kindLabel } from '../components/LibraryEditor';
import { SearchPicker } from '../components/SearchPicker';
import { Dialog, Panel, Tag } from '../components/ui';
import type { Engine } from '../lib/engine';

const STATE_CN: Record<string, [string, 'accent' | 'warn' | 'danger' | undefined]> = {
  auto: ['自动生效', 'accent'],
  pending: ['等 DM 点头', 'warn'],
  on: ['DM 开着', 'accent'],
  off: ['DM 关掉了', 'danger'],
};

const blankItem = (): LibraryItem => ({
  id: newItemId(), kind: 'homerule', name: '', text: '',
  parts: [{ id: newPartId(), key: '', sheet: { mods: [], grants: [], choices: [], resources: [] } }],
  by: 'hand', reviewed: true,
});

export function DataPanel({ engine }: { engine: Engine }) {
  const sync = useSync();
  const items = useLibrary();
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [edit, setEdit] = useState<LibraryItem | null>(null);
  const [shareOf, setShareOf] = useState<LibraryItem | null>(null);
  const [searching, setSearching] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!sync.user) { setCampaigns([]); return; }
    api<{ campaigns: Campaign[] }>('GET', 'campaigns')
      .then((r) => { setCampaigns(r.campaigns ?? []); for (const c of r.campaigns ?? []) void loadHub(c.id); }, (e: Error) => setErr(e.message));
  }, [sync.user]);

  if (!sync.user) {
    return (
      <div className="page">
        <Panel title="资料库">
          <p className="muted" style={{ margin: 0 }}>
            这里放你自己的规则内容：家规、改官方某条能力、给没自动化的能力补数据。内容跟着账户走，你自己的卡都能用，
            挂到战役里才会对别人生效。<b>登录之后才能建</b>（右上角）。
          </p>
        </Panel>
      </div>
    );
  }

  const attachedCount = (id: string) => campaigns.filter((c) => (hubNow(c.id)?.attached ?? []).some((s) => s.itemId === id && s.item.id === id)).length;

  return (
    <div className="page stack">
      <div className="row">
        <h2 className="serif" style={{ margin: 0, fontWeight: 500 }}>资料库</h2>
        <span className="small muted">内容跟着你的账户走：你的卡都能用；挂到战役里才对别人生效（新内容直接生效，覆盖官方规则的要 DM 点头）</span>
        <span style={{ flex: 1 }} />
        <button className="btn" onClick={() => setSearching(true)}>从 5etools 搜一条…</button>
        <button className="btn primary" onClick={() => setEdit(blankItem())}>新建</button>
      </div>
      {err && <div className="dangerline small">{err}</div>}

      <Panel title={`我的内容（${items.length} 条）`} flush>
        {!items.length ? <div className="empty">还没有。点右上角「新建」，或者从人物卡「数据」页让 AI 补一条。</div> : (
          <table className="rows">
            <thead><tr><th>名字</th><th>类别</th><th>内容</th><th>挂了哪些团</th><th /></tr></thead>
            <tbody>
              {items.map((it) => {
                const n = attachedCount(it.id);
                return (
                  <tr key={it.id}>
                    <td className="serif" style={{ minWidth: 120 }}>{it.name}{it.source ? <span className="tiny faint"> · {it.source}</span> : null}</td>
                    <td className="small muted">{kindLabel(it.kind)}</td>
                    <td><span className="row" style={{ gap: 4, flexWrap: 'wrap' }}><ItemTags item={it} /></span></td>
                    <td className="small">
                      {n ? <Tag tone="accent">{n} 个团</Tag> : <span className="faint">只对自己</span>}
                    </td>
                    <td className="row" style={{ justifyContent: 'flex-end', gap: 4 }}>
                      <button className="btn ghost sm" onClick={() => setEdit(it)}>编辑</button>
                      <button className="btn ghost sm" onClick={() => setShareOf(it)}>挂到战役…</button>
                      <button className="btn ghost sm danger" onClick={() => { if (confirm(`删掉「${it.name}」？挂着的战役也会一起拿掉。`)) void removeLibraryItem(it.id); }}>删除</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Panel>

      {edit && (
        <LibraryEditor
          item={edit}
          engine={engine}
          onClose={() => setEdit(null)}
          onSave={async (it) => saveLibraryItem(it)}
          onDelete={items.some((x) => x.id === edit.id) ? () => { void removeLibraryItem(edit.id); setEdit(null); } : undefined}
        />
      )}
      {shareOf && <ShareDialog item={shareOf} campaigns={campaigns} onClose={() => setShareOf(null)} />}
      {searching && (
        <SearchPicker
          engine={engine}
          onPick={(draft) => { setSearching(false); setEdit(draft); }}
          onClose={() => setSearching(false)}
        />
      )}
    </div>
  );
}

/** 一条内容挂到哪些战役：勾上 = 挂；状态由服务器定（新内容自动，覆盖官方待审） */
function ShareDialog({ item, campaigns, onClose }: { item: LibraryItem; campaigns: Campaign[]; onClose: () => void }) {
  useLibraryVersion();
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const shareOf = (cid: string) => (hubNow(cid)?.attached ?? []).find((s) => s.itemId === item.id && s.item.id === item.id);
  const covers = (item.parts ?? []).filter((p) => !p.key.startsWith('HR:')).map((p) => p.key);

  const toggle = async (c: Campaign, on: boolean) => {
    setBusy(c.id); setErr(''); setMsg('');
    try {
      if (on) {
        const state = await shareItem(c.id, item.id);
        setMsg(state === 'pending'
          ? `挂到「${c.name}」了：这条覆盖官方规则，要 DM 在战役页点开才对别人生效。`
          : `挂到「${c.name}」了：新内容，团里的人立刻能用。`);
      } else {
        await unshareItem(c.id, item.id);
        setMsg(`从「${c.name}」拿下来了。`);
      }
    } catch (e) { setErr((e as Error).message); }
    setBusy('');
  };

  return (
    <Dialog title={`「${item.name}」挂到哪些战役`} onClose={onClose} footer={<>
      <span style={{ flex: 1 }} />
      <button className="btn" onClick={onClose}>关闭</button>
    </>}>
      <div className="stack" style={{ gap: 8 }}>
        {covers.length > 0 && (
          <div className="small muted">这条覆盖官方规则（{covers.join('、')}）：挂上之后要 DM 点头才对全团生效，你自己的卡不受影响。</div>
        )}
        {!campaigns.length ? <div className="small muted">你还没加入任何战役。</div> : campaigns.map((c) => {
          const s = shareOf(c.id);
          const cn = s ? STATE_CN[s.state] : null;
          return (
            <label key={c.id} className="row small" style={{ gap: 8, alignItems: 'center' }}>
              <input type="checkbox" checked={!!s} disabled={busy === c.id} onChange={(e) => void toggle(c, e.target.checked)} />
              <span className="serif" style={{ minWidth: 120 }}>{c.name}</span>
              <Tag>{c.role === 'dm' ? '我是 DM' : '我是玩家'}</Tag>
              {cn && <Tag tone={cn[1]}>{cn[0]}</Tag>}
            </label>
          );
        })}
        {msg && <div className="small ok">{msg}</div>}
        {err && <div className="dangerline small">{err}</div>}
      </div>
    </Dialog>
  );
}
