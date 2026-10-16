/**
 * 从 5etools 搜一条（LIBRARY.md 第六节）：搜名字 → 自动带出**条目键 + 出处 + 原文** → 交给资料库编辑器。
 *
 * 数据是站点自己的搜索索引（`/search/index.json`），原文由 `buildTask` 按条目键去取
 * （它支持法术 / 物品 / 专长 / 可选特性 / 种族 / 职业特性 / 子职特性；其余类别只带出处，数据自己写）。
 */
import { useEffect, useMemo, useState } from 'react';
import { KIND_CN, SUPPORTED, hitWhere, loadSearchHits, searchHits, type SearchHit } from '../../src/sheet';
import type { LibraryItem } from '../../src/library';
import { Dialog, Tag } from './ui';
import { taskBuilder } from '../lib/ai';
import type { Engine } from '../lib/engine';
import { newItemId, newPartId } from '../lib/library';

/** 界面上出现的类别（按这个顺序排） */
const KIND_ORDER = ['spell', 'item', 'feat', 'optfeature', 'race', 'classFeature', 'subclassFeature', 'condition', 'action', 'subclass'];

export function SearchPicker(p: {
  engine: Engine;
  /** 拼任务时的战役上下文（按这个团的资料算探针角色） */
  cid?: string | null;
  onPick: (draft: LibraryItem) => void;
  onClose: () => void;
}) {
  const [all, setAll] = useState<SearchHit[] | null>(null);
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('');
  const [pick, setPick] = useState<SearchHit | null>(null);
  const [pre, setPre] = useState<{ name: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    loadSearchHits(p.engine.env.store).then(setAll, (e: Error) => setErr(e.message));
  }, [p.engine]);

  const hits = useMemo(() => searchHits(all ?? [], q, { kinds: kind ? [kind] : undefined }), [all, q, kind]);
  const kinds = useMemo(() => {
    const have = new Set((all ?? []).map((h) => h.kind));
    return KIND_ORDER.filter((k) => have.has(k));
  }, [all]);

  /** 选中一条：能取原文的取回来当预览 */
  useEffect(() => {
    if (!pick) { setPre(null); return; }
    let alive = true;
    setPre(null);
    if (!pick.key || !pick.supported) return;
    setBusy(true);
    taskBuilder(p.engine, p.cid)
      .buildTask('search', pick.key)
      .then((t) => { if (alive) setPre({ name: t.name, text: t.text }); },
        () => { if (alive) setPre(null); })
      .finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
  }, [pick, p.engine, p.cid]);

  const use = () => {
    if (!pick) return;
    const id = newItemId();
    const partId = newPartId();
    p.onPick({
      id, kind: pick.kind, name: pick.name, text: pre?.text ?? '',
      source: pick.source,
      ref: {
        kind: pick.kind, source: pick.source, name: pick.name,
        ...(pick.cls ? { cls: pick.cls } : {}), ...(pick.level !== undefined ? { level: pick.level } : {}),
      },
      parts: [{ id: partId, key: pick.key || `HR:${partId}`, name: typeof pick.name === 'string' ? pick.name : '' }],
      by: 'hand', reviewed: true,
    });
  };

  return (
    <Dialog title="从 5etools 搜一条" onClose={p.onClose} footer={<>
      <span className="small muted" style={{ flex: 1 }}>
        {all ? `索引 ${all.length} 条：法术、物品、专长、可选特性、种族、职业 / 子职特性、状态…` : busy ? '正在取原文…' : ''}
      </span>
      <button className="btn" onClick={p.onClose}>取消</button>
      <button className="btn primary" disabled={!pick || busy} onClick={use}>用这条</button>
    </>}>
      <div className="stack" style={{ gap: 8 }}>
        <div className="row" style={{ gap: 6 }}>
          <input autoFocus placeholder="搜名字：圣疗、火球术、巨武器大师…（中文或英文）" value={q} onChange={(e) => { setQ(e.target.value); setPick(null); }} style={{ flex: 1 }} />
        </div>
        <div className="row small" style={{ gap: 4, flexWrap: 'wrap' }}>
          <button className={'btn ghost sm' + (kind === '' ? ' on' : '')} onClick={() => setKind('')}>全部</button>
          {kinds.map((k) => <button key={k} className={'btn ghost sm' + (kind === k ? ' on' : '')} onClick={() => setKind(k)}>{KIND_CN[k] ?? k}</button>)}
        </div>
        {err && <div className="dangerline small">{err}</div>}
        {!all && !err && <div className="small muted">正在取搜索索引（约 3 MB，第一次慢一点，之后就缓存在本地了）…</div>}
        {all && !q.trim() && <div className="small muted">输入名字开始搜。搜到的条目会带出条目键和原文；点「用这条」直接进编辑器。</div>}
        {q.trim() && !hits.length && <div className="small muted">没找到。</div>}
        {hits.length > 0 && (
          <div className="stack" style={{ gap: 2, maxHeight: '38vh', overflow: 'auto' }}>
            {hits.map((h) => (
              <button key={h.i} type="button" className={'opt' + (pick === h ? ' on' : '')} onClick={() => setPick(h)}>
                <span className="serif" style={{ minWidth: 120, textAlign: 'left' }}>{h.cn || h.name}</span>
                <span className="tiny faint" style={{ flex: 1, textAlign: 'left' }}>{hitWhere(h)}</span>
                {h.core2024 && <Tag tone="accent">2024</Tag>}
                {!h.supported && <Tag tone="warn">要自己写</Tag>}
              </button>
            ))}
          </div>
        )}
        {pick && (
          <div className="stack" style={{ gap: 6 }}>
            <div className="row small" style={{ gap: 6, flexWrap: 'wrap' }}>
              <span className="faint">条目键</span>
              <code>{pick.key || '（这个类别给不出条目键，会当新内容）'}</code>
              <span style={{ flex: 1 }} />
              <span className="faint">出处</span>
              <span>{pick.source}{pick.page ? ` p${pick.page}` : ''}</span>
            </div>
            <div className="preview prose small" style={{ maxHeight: '28vh', overflow: 'auto' }}>
              {busy ? <span className="muted">正在取原文…</span>
                : pre?.text ? <pre style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{pre.text.slice(0, 4000)}{pre.text.length > 4000 ? '\n…（后面还有，导入时会带上全部）' : ''}</pre>
                  : <span className="muted">
                    {pick.key && !SUPPORTED.has(pick.kind)
                      ? '这个类别取不了原文（引擎还没有它的取数方式）：导入之后键已经填好，数据自己写或让 AI 写。'
                      : '没取到原文：导入之后数据自己写或让 AI 写。'}
                  </span>}
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
}
