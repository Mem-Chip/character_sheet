/** 卡片库：所有角色卡；新建、导入、导出、复制、删除 */
import { useRef, useState } from 'react';
import samples from '../../tests/fixtures/chars.json';
import type { Json } from '../../src/sheet';
import { Panel } from '../components/ui';
import { actions, useApp } from '../lib/store';
import { uploadOne, useSync } from '../lib/sync';
import { Tag } from '../components/ui';
import { download } from './Sheet';

const SAMPLE_IDS = ['fighter5-plate', 'rogue5', 'wizard3-evoker', 'barbarian3-unarmored', 'paladin6', 'cleric1-hprolls'];

export function Library() {
  const app = useApp();
  const sync = useSync();
  const file = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState('');
  const cards = app.order.map((id) => app.cards[id]).filter(Boolean);

  const onFiles = async (files: FileList | null) => {
    if (!files) return;
    const got: string[] = [];
    for (const f of Array.from(files)) {
      try { actions.importJson(await f.text()); got.push(f.name); } catch (e) { setMsg(`${f.name}：${(e as Error).message}`); return; }
    }
    setMsg(`导入了 ${got.length} 张卡`);
    actions.go('library');
  };

  return (
    <div className="page stack">
      <div className="row">
        <h2 className="serif" style={{ margin: 0, fontWeight: 500 }}>卡片库</h2>
        <span className="faint small">{cards.length} 张</span>
        <span style={{ flex: 1 }} />
        <button className="btn primary" onClick={() => actions.create()}>新建角色</button>
        <button className="btn" onClick={() => file.current?.click()}>导入 JSON</button>
        <input ref={file} type="file" accept=".json,application/json" multiple hidden onChange={(e) => { void onFiles(e.target.files); e.target.value = ''; }} />
      </div>
      {msg && <div className="small muted">{msg}</div>}
      {cards.length ? (
        <div className="lib">
          {cards.map((c) => {
            const ch = c.char;
            const cls = (ch.classes || []).filter((k: Json) => k.name).map((k: Json) => `${k.name} ${k.level}`).join(' / ');
            return (
              <div key={c.id} className="panel card-item" onClick={() => actions.open(c.id)}>
                <div className="spread"><span className="nm">{ch.name || '未命名'}</span><span className="tiny faint">{new Date(c.updatedAt).toLocaleDateString('zh-CN')}</span></div>
                <div className="small muted">{[ch.race, ch.background].filter(Boolean).join(' · ') || '—'}</div>
                <div className="small">{cls || '还没选职业'}</div>
                {sync.user && (
                  <div className="row" style={{ gap: 4, marginTop: 4, flexWrap: 'wrap' }}>
                    {c.owner && c.owner.id !== sync.user.id && <Tag tone="accent">来自 {c.owner.name}</Tag>}
                    {!c.rev && !c.dirty && <Tag tone="warn">只在本机</Tag>}
                    {c.dirty && !c.localOnly && <Tag>未同步</Tag>}
                    {c.campaignId && <Tag>在战役中</Tag>}
                  </div>
                )}
                <div className="row" style={{ marginTop: 8 }} onClick={(e) => e.stopPropagation()}>
                  <button className="btn sm" onClick={() => actions.open(c.id)}>打开</button>
                  <button className="btn sm" onClick={() => actions.duplicate(c.id)}>复制</button>
                  <button className="btn sm" onClick={() => download(`${ch.name || '人物卡'}.json`, actions.exportJson(c.id))}>导出</button>
                  {sync.user && !c.rev && !c.dirty && <button className="btn sm" onClick={() => uploadOne(c.id)}>传到账户</button>}
                  {(!c.owner || c.owner.id === sync.user?.id) && (
                    <button className="btn ghost sm danger" onClick={() => { if (confirm(`删除「${ch.name || '未命名'}」？${c.rev ? '账户里的这张也会删掉。' : ''}这一步不能撤销。`)) actions.remove(c.id); }}>删除</button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <Panel title="从这里开始">
          <p className="muted" style={{ marginTop: 0 }}>新建一张卡，导入原项目或本项目导出的 JSON，或者先加几张示例角色看看。</p>
          <button className="btn" onClick={() => {
            for (const s of (samples as Array<{ id: string; char: Json }>).filter((x) => SAMPLE_IDS.includes(x.id)).reverse()) actions.create(structuredClone(s.char));
            actions.go('library');
          }}>加入示例角色</button>
        </Panel>
      )}
    </div>
  );
}
