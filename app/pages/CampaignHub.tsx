/**
 * 战役页的「资料」：这个战役启用了哪些书（5etools 书目里挑），以及本团内容（家规、补的数据）。
 * DM 能改，玩家只能看。卡在战役里时，建卡、升级、战斗都按这里的资料来。
 */
import { useEffect, useMemo, useState } from 'react';
import { Dialog, Field, Tag } from '../components/ui';
import type { Campaign } from '../lib/api';
import { loadBooks, removeItem, saveItem, setSources, useHub, type Book, type HubItem } from '../lib/hub';
import { useEngine } from '../lib/useSheet';

/** 2024 核心三本：一直在 */
const BUILTIN = new Set(['XPHB', 'XDMG', 'XMM']);
const GROUP_CN: Record<string, string> = {
  core: '核心', supplement: '扩展', setting: '设定', 'supplement-alt': '其他扩展', 'setting-alt': '其他设定',
  'organized-play': '冒险者联盟', other: '其他', screen: '帷幕', recipe: '食谱', homecraft: '手工',
};
/** 没有规则内容的书，默认不列 */
const HIDDEN_GROUPS = new Set(['screen', 'recipe', 'homecraft']);

const newItemId = () => 'hr-' + Date.now().toString(36).slice(-6) + Math.random().toString(36).slice(2, 6);

export function CampaignHub({ c }: { c: Campaign }) {
  const hub = useHub(c.id);
  const dm = c.role === 'dm';
  const [picking, setPicking] = useState(false);
  const [edit, setEdit] = useState<HubItem | null>(null);
  const [books, setBooks] = useState<Book[]>([]);
  const { engine } = useEngine();
  useEffect(() => { if (engine) loadBooks(engine).then(setBooks, () => {}); }, [engine]);
  const bookName = (id: string) => books.find((b) => b.id === id)?.name ?? id;

  if (!hub) return <div className="small muted">正在读取资料…</div>;
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
          <span className="faint">本团内容</span>
          <span className="muted">（家规、改官方能力、给没自动化的能力补战斗数据）</span>
          <span style={{ flex: 1 }} />
          {dm && <button className="btn ghost sm" onClick={() => setEdit({ id: newItemId(), name: '', text: '', by: 'hand', reviewed: true })}>新建</button>}
        </div>
        {!hub.items.length ? <div className="small muted">还没有。</div> : (
          <div className="stack" style={{ gap: 4 }}>
            {hub.items.map((it) => (
              <div key={it.id} className="row small">
                <span className="serif" style={{ minWidth: 110 }}>{it.name}</span>
                <span className="row" style={{ gap: 4, flex: 1, flexWrap: 'wrap' }}>
                  {it.covers ? <Tag tone="warn" title="覆盖了这条官方能力">覆盖 {it.covers}</Tag> : <Tag>新内容</Tag>}
                  {it.pickable && <Tag>建卡时可选</Tag>}
                  {it.sheet && <Tag>卡面</Tag>}
                  {it.combat && <Tag>战斗</Tag>}
                  {it.by !== 'hand' && <Tag tone={it.reviewed ? undefined : 'warn'}>{it.reviewed ? 'AI · 已审' : 'AI · 未审'}</Tag>}
                </span>
                <button className="btn ghost sm" onClick={() => setEdit(it)}>{dm ? '编辑' : '查看'}</button>
                {dm && <button className="btn ghost sm danger" onClick={() => { if (confirm(`删除「${it.name}」？`)) void removeItem(c.id, it.id); }}>删除</button>}
              </div>
            ))}
          </div>
        )}
      </div>

      {picking && <BookPicker books={books} chosen={hub.sources} onClose={() => setPicking(false)} onSave={async (list) => { await setSources(c.id, list); setPicking(false); }} />}
      {edit && <ItemEditor item={edit} readOnly={!dm} onClose={() => setEdit(null)} onSave={(it) => saveItem(c.id, it)} />}
    </div>
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

const pretty = (v: unknown) => (v === undefined ? '' : JSON.stringify(v, null, 2));

function ItemEditor(p: { item: HubItem; readOnly: boolean; onClose: () => void; onSave: (it: HubItem) => Promise<string[]> }) {
  const [name, setName] = useState(p.item.name);
  const [text, setText] = useState(p.item.text);
  const [covers, setCovers] = useState(p.item.covers ?? '');
  const [pickable, setPickable] = useState(!!p.item.pickable);
  const [reviewed, setReviewed] = useState(p.item.reviewed);
  const [sheet, setSheet] = useState(pretty(p.item.sheet));
  const [combat, setCombat] = useState(pretty(p.item.combat));
  const [problems, setProblems] = useState<string[]>([]);
  const ro = p.readOnly;

  const save = async () => {
    const bad: string[] = [];
    const parse = (s: string, what: string) => {
      if (!s.trim()) return undefined;
      try { return JSON.parse(s); } catch { bad.push(`${what}不是合法的 JSON`); return undefined; }
    };
    const it: HubItem = {
      id: p.item.id, name: name.trim(), text, by: p.item.by, reviewed,
      ...(covers.trim() ? { covers: covers.trim() } : {}),
      ...(pickable ? { pickable: true } : {}),
    };
    const sh = parse(sheet, '卡面数据');
    const cb = parse(combat, '战斗数据');
    if (sh !== undefined) it.sheet = sh;
    if (cb !== undefined) it.combat = cb;
    if (bad.length) { setProblems(bad); return; }
    try {
      const r = await p.onSave(it);
      if (r.length) setProblems(r); else p.onClose();
    } catch (e) { setProblems([(e as Error).message]); }
  };

  return (
    <Dialog title={ro ? name : p.item.name ? `编辑「${p.item.name}」` : '新的本团内容'} onClose={p.onClose} footer={<>
      {!ro && p.item.by !== 'hand' && <label className="row small"><input type="checkbox" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} />审过了</label>}
      <span style={{ flex: 1 }} />
      <button className="btn" onClick={p.onClose}>{ro ? '关闭' : '取消'}</button>
      {!ro && <button className="btn primary" disabled={!name.trim()} onClick={() => void save()}>保存</button>}
    </>}>
      <div className="stack" style={{ gap: 8 }}>
        <Field label="名字"><input value={name} readOnly={ro} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="说明（给人看的原文 / 家规内容）"><textarea rows={4} value={text} readOnly={ro} onChange={(e) => setText(e.target.value)} /></Field>
        <Field label="覆盖哪条官方能力（条目键，比如 XPHB:警觉、XPHB:野蛮人:狂暴:1；空 = 新内容）">
          <input value={covers} readOnly={ro} onChange={(e) => setCovers(e.target.value)} placeholder="空 = 新内容" />
        </Field>
        <label className="row small" style={{ alignItems: 'flex-start', whiteSpace: 'normal' }}>
          <input type="checkbox" checked={pickable} disabled={ro} onChange={(e) => setPickable(e.target.checked)} />
          不是人人都有：卡上选了才生效（不勾 = 团里每张卡都生效；覆盖官方能力的只改有这项能力的卡）
        </label>
        <Field label="卡面数据（JSON：mods / grants / choices / resources，写法同能力数据）">
          <textarea rows={6} className="mono" value={sheet} readOnly={ro} onChange={(e) => setSheet(e.target.value)} placeholder='{ "mods": [], "grants": [], "choices": [], "resources": [] }' />
        </Field>
        <Field label="战斗数据（JSON：{ entry } 整条；{ key, patch } 改官方条目的字段；key 不写 = 覆盖的那条 / 新内容）">
          <textarea rows={8} className="mono" value={combat} readOnly={ro} onChange={(e) => setCombat(e.target.value)} placeholder='{ "entry": { "name": "…", "actions": [] } }' />
        </Field>
        {!ro && <div className="small muted">改了之后：人物卡马上按新的算；已经开着的遭遇要 DM 在遭遇菜单里点「更新本团规则」。AI 帮写的入口下一步做。</div>}
        {problems.length > 0 && <div className="dangerline small">{problems.map((x, i) => <div key={i}>{x}</div>)}</div>}
      </div>
    </Dialog>
  );
}
