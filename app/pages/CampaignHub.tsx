/**
 * 战役页的「资料」：这个战役启用了哪些书，以及挂上来的内容（谁挂的、现在什么状态）。
 *
 * 内容本身存在各人的账户资料库里（[LIBRARY.md](LIBRARY.md)），这里只管这个战役的开关：
 * - 新内容（没覆盖官方规则）挂上就生效；
 * - 覆盖官方规则的，DM 在这里点开才对全团生效；同一个键被几条覆盖时列出来，指出现在用的是哪条。
 */
import { useEffect, useMemo, useState } from 'react';
import {
  effectiveItems, hubNow, loadBooks, removeLibraryItem, saveLibraryItem, setShareState, setSources, shareItem, unshareItem,
  useHub, useLibrary, useLibraryVersion, type Book, type LibraryItem, type ShareView,
} from '../lib/library';
import { useSync } from '../lib/sync';
import { ItemTags, LibraryEditor, kindLabel } from '../components/LibraryEditor';
import { Dialog, Tag } from '../components/ui';
import { actions } from '../lib/store';
import { useEngine } from '../lib/useSheet';
import type { Campaign } from '../lib/api';

/** 2024 核心三本：一直在 */
const BUILTIN = new Set(['XPHB', 'XDMG', 'XMM']);
const GROUP_CN: Record<string, string> = {
  core: '核心', supplement: '扩展', setting: '设定', 'supplement-alt': '其他扩展', 'setting-alt': '其他设定',
  'organized-play': '冒险者联盟', other: '其他', screen: '帷幕', recipe: '食谱', homecraft: '手工',
};
/** 没有规则内容的书，默认不列 */
const HIDDEN_GROUPS = new Set(['screen', 'recipe', 'homecraft']);

const coversOfItem = (s: ShareView): string[] =>
  (s.item.parts ?? []).filter((p) => !p.key.startsWith('HR:')).map((p) => p.key);

const STATE_CN: Record<string, [string, 'accent' | 'warn' | 'danger' | undefined]> = {
  auto: ['自动生效', 'accent'],
  pending: ['等 DM 点头', 'warn'],
  on: ['开着', 'accent'],
  off: ['关掉了', 'danger'],
};

export function CampaignHub({ c }: { c: Campaign }) {
  const hub = useHub(c.id);
  useLibraryVersion();
  const sync = useSync();
  const dm = c.role === 'dm';
  const [picking, setPicking] = useState(false);
  const [attach, setAttach] = useState(false);
  const [edit, setEdit] = useState<LibraryItem | null>(null);
  const [err, setErr] = useState('');
  const [books, setBooks] = useState<Book[]>([]);
  const { engine } = useEngine();
  useEffect(() => { if (engine) loadBooks(engine).then(setBooks, () => {}); }, [engine]);
  const bookName = (id: string) => books.find((b) => b.id === id)?.name ?? id;

  const attached = hub?.attached ?? [];
  /** 同一个官方键被多条覆盖：列出来，指出按层序现在生效的是哪条（最后一条开着的） */
  const conflicts = useMemo(() => {
    const byKey = new Map<string, ShareView[]>();
    for (const s of attached) for (const k of coversOfItem(s)) byKey.set(k, [...(byKey.get(k) ?? []), s]);
    return [...byKey.entries()].filter(([, list]) => list.length > 1)
      .map(([key, list]) => {
        const live = [...list].reverse().find((s) => s.state === 'auto' || s.state === 'on');
        return { key, list, live };
      });
  }, [attached]);

  if (!hub) return <div className="small muted">正在读取资料…</div>;

  const toggle = (s: ShareView) => {
    const next = s.state === 'off' ? 'on' : 'off';
    setShareState(c.id, s.ownerId, s.itemId, next).catch((e: Error) => setErr(e.message));
  };
  const detach = (s: ShareView) => {
    unshareItem(c.id, s.itemId).catch((e: Error) => setErr(e.message));
  };

  return (
    <div className="stack" style={{ gap: 8 }}>
      <div>
        <div className="row small" style={{ marginBottom: 4 }}>
          <span className="faint">启用的书</span>
          <span className="muted">（2024 核心三本一直在；启用的书里没被 2024 重印的种族、背景、专长、子职、法术、物品、怪物都能选）</span>
          <span style={{ flex: 1 }} />
          {dm && <button className="btn ghost sm" onClick={() => setPicking(true)}>选书…</button>}
        </div>
        <div className="row" style={{ flexWrap: 'wrap', gap: 4 }}>
          {!hub.sources.length ? <span className="small muted">只有 2024 核心书。</span>
            : hub.sources.map((s) => <Tag key={s} title={s}>{bookName(s)}</Tag>)}
        </div>
      </div>

      <div>
        <div className="row small" style={{ marginBottom: 4 }}>
          <span className="faint">挂上来的内容</span>
          <span className="muted">（各人自己的资料库挂过来的；新内容直接生效，覆盖官方规则的要 {dm ? '你' : 'DM'} 点头）</span>
          <span style={{ flex: 1 }} />
          <button className="btn ghost sm" onClick={() => setAttach(true)}>挂我的内容…</button>
        </div>

        {conflicts.length > 0 && (
          <div className="small warnline" style={{ marginBottom: 6 }}>
            {conflicts.map((x) => (
              <div key={x.key}>
                「{x.key}」有 {x.list.length} 条都在改：{x.list.map((s) => `${s.item.name}（${s.ownerName}）`).join('、')}
                {x.live ? `　现在生效的是「${x.live.item.name}」（后面开着的盖前面）` : '　现在都没开'}
              </div>
            ))}
          </div>
        )}

        {!attached.length ? <div className="small muted">还没有。点「挂我的内容…」把自己库里的东西挂上来。</div> : (
          <div className="stack" style={{ gap: 4 }}>
            {attached.map((s) => {
              const cn = STATE_CN[s.state] ?? ['—', undefined];
              const mine = s.ownerId === sync.user?.id;
              return (
                <div key={`${s.ownerId}/${s.itemId}`} className="row small" style={{ gap: 6, flexWrap: 'wrap' }}>
                  <span className="serif" style={{ minWidth: 110 }}>{s.item.name}</span>
                  <Tag>{kindLabel(s.item.kind)}</Tag>
                  <span className="row" style={{ gap: 4, flexWrap: 'wrap', flex: 1 }}>
                    <ItemTags item={s.item} />
                    {!mine && <Tag title={`${s.ownerName} 的库`}>{s.ownerName}</Tag>}
                  </span>
                  <Tag tone={cn[1]}>{cn[0]}</Tag>
                  {dm && <button className="btn ghost sm" onClick={() => toggle(s)}>{s.state === 'off' ? '打开' : '关掉'}</button>}
                  {mine && <button className="btn ghost sm" onClick={() => setEdit(s.item)}>编辑</button>}
                  {mine && <button className="btn ghost sm danger" onClick={() => { if (confirm(`把「${s.item.name}」从「${c.name}」拿下来？（内容还在你的资料库里）`)) detach(s); }}>摘下</button>}
                </div>
              );
            })}
          </div>
        )}
        {err && <div className="dangerline small" style={{ marginTop: 4 }}>{err}</div>}
        <div className="row small" style={{ marginTop: 6 }}>
          <span className="muted">生效的内容：{effectiveItems(hub).length} 条；你自己的卡还额外按你自己的资料库算。</span>
          <span style={{ flex: 1 }} />
          <button className="btn ghost sm" onClick={() => actions.go('data')}>打开我的资料库</button>
        </div>
      </div>

      {picking && <BookPicker books={books} chosen={hub.sources} onClose={() => setPicking(false)} onSave={async (list) => { await setSources(c.id, list); setPicking(false); }} />}
      {attach && <AttachDialog cid={c.id} onClose={() => setAttach(false)} />}
      {edit && engine && (
        <LibraryEditor
          item={edit}
          engine={engine}
          cid={c.id}
          onClose={() => setEdit(null)}
          onSave={async (it) => saveLibraryItem(it)}
          onDelete={async () => { await removeLibraryItem(edit.id); setEdit(null); }}
        />
      )}
    </div>
  );
}

/** 把我库里的内容挂到这个战役 / 摘下来 */
function AttachDialog({ cid, onClose }: { cid: string; onClose: () => void }) {
  useLibraryVersion();
  const items = useLibrary();
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const attachedTo = (id: string) => (hubNow(cid)?.attached ?? []).find((s) => s.itemId === id);

  const toggle = async (it: LibraryItem, on: boolean) => {
    setBusy(it.id); setErr(''); setMsg('');
    try {
      if (on) {
        const state = await shareItem(cid, it.id);
        setMsg(state === 'pending' ? `「${it.name}」覆盖了官方规则，挂上了，等 DM 点头。` : `「${it.name}」挂上了，团里的人立刻能用。`);
      } else {
        await unshareItem(cid, it.id);
        setMsg(`「${it.name}」拿下来了。`);
      }
    } catch (e) { setErr((e as Error).message); }
    setBusy('');
  };

  return (
    <Dialog title="挂我的内容到这个战役" onClose={onClose} footer={<>
      <span style={{ flex: 1 }} />
      <button className="btn" onClick={onClose}>关闭</button>
    </>}>
      <div className="stack" style={{ gap: 6 }}>
        <div className="small muted">新内容挂上就生效；覆盖官方规则的挂上后要 DM 点头。</div>
        {!items.length ? <div className="small muted">你的资料库还是空的。先去「资料库」页建一条，或者从人物卡「数据」页让 AI 补一条。</div>
          : items.map((it) => {
            const s = attachedTo(it.id);
            return (
              <label key={it.id} className="row small" style={{ gap: 8, alignItems: 'center' }}>
                <input type="checkbox" checked={!!s} disabled={busy === it.id} onChange={(e) => void toggle(it, e.target.checked)} />
                <span className="serif" style={{ minWidth: 110 }}>{it.name}</span>
                <span className="row" style={{ gap: 4, flexWrap: 'wrap', flex: 1 }}><ItemTags item={it} /></span>
                {s && <Tag tone={STATE_CN[s.state]?.[1]}>{STATE_CN[s.state]?.[0]}</Tag>}
              </label>
            );
          })}
        {msg && <div className="small ok">{msg}</div>}
        {err && <div className="dangerline small">{err}</div>}
      </div>
    </Dialog>
  );
}

function BookPicker(p: { books: Book[]; chosen: string[]; onClose: () => void; onSave: (list: string[]) => Promise<void> }) {
  const [on, setOn] = useState(() => new Set(p.chosen));
  const [q, setQ] = useState('');
  const [all, setAll] = useState(false);
  const [err, setErr] = useState('');
  const groups = useMemo(() => {
    const want = q.trim().toLowerCase();
    const out = new Map<string, Book[]>();
    for (const b of [...p.books].sort((a, b) => b.published.localeCompare(a.published))) {
      if (!all && HIDDEN_GROUPS.has(b.group) && !on.has(b.id)) continue;
      if (want && !(b.name.toLowerCase().includes(want) || b.enName.toLowerCase().includes(want) || b.id.toLowerCase().includes(want))) continue;
      out.set(b.group, [...(out.get(b.group) ?? []), b]);
    }
    return [...out];
  }, [p.books, q, all, on]);
  const toggle = (id: string) => setOn((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <Dialog title="启用哪些书" onClose={p.onClose} footer={<>
      {err && <span className="dangerline small">{err}</span>}
      <span className="small muted" style={{ flex: 1 }}>已选 {on.size} 本</span>
      <button className="btn" onClick={p.onClose}>取消</button>
      <button className="btn primary" onClick={() => { p.onSave([...on]).catch((e: Error) => setErr(e.message)); }}>保存</button>
    </>}>
      <div className="row" style={{ marginBottom: 8 }}>
        <input placeholder="搜书名 / 代号" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1 }} />
        <label className="row small"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />也列出帷幕、食谱这类</label>
      </div>
      {!p.books.length && <div className="small muted">书目还没取到（5etools 的 books.json）。</div>}
      <div className="stack" style={{ gap: 10, maxHeight: '60vh', overflow: 'auto' }}>
        {groups.map(([g, list]) => (
          <div key={g}>
            <div className="small faint" style={{ marginBottom: 4 }}>{GROUP_CN[g] ?? g}</div>
            <div className="stack" style={{ gap: 2 }}>
              {list.map((b) => (
                <label key={b.id} className="row small" style={{ gap: 6 }}>
                  <input type="checkbox" disabled={BUILTIN.has(b.id)} checked={BUILTIN.has(b.id) || on.has(b.id)} onChange={() => toggle(b.id)} />
                  <span>{b.name}</span>
                  <span className="muted">{b.id} · {b.published.slice(0, 4)}{BUILTIN.has(b.id) ? ' · 内置' : ''}</span>
                </label>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Dialog>
  );
}
