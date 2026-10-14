/** 人物卡页：抬头 + 「卡面 / 建卡」两个视图 */
import { useState } from 'react';
import type { Json } from '../../src/sheet';
import { Tag } from '../components/ui';
import type { Engine } from '../lib/engine';
import { actions, useApp } from '../lib/store';
import { useComputed } from '../lib/useSheet';
import { SheetBuild } from './SheetBuild';
import { SheetData } from './SheetData';
import { SheetLevelUp } from './SheetLevelUp';
import { SheetView } from './SheetView';

export function download(name: string, text: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function SheetPage({ engine }: { engine: Engine }) {
  const app = useApp();
  const id = app.currentId;
  const card = id ? app.cards[id] : null;
  const computed = useComputed(engine, id, card?.char ?? null);
  const [tab, setTab] = useState<'view' | 'levelup' | 'build' | 'data'>(card && !card.char.race && !card.char.classes?.[0]?.name ? 'build' : 'view');

  if (!card || !id) {
    return <div className="page"><div className="empty">还没有打开角色。去 <button className="btn sm" onClick={() => actions.go('library')}>卡片库</button> 选一张，或者新建。</div></div>;
  }
  if (!computed) return <div className="page"><div className="empty">正在计算…</div></div>;

  const { char, sheet } = computed;
  const classes = (char.classes || []).filter((k: Json) => k.name).map((k: Json) => `${k.name} ${k.level}${k.subclass ? `（${k.subclass}）` : ''}`).join(' / ');
  const pendingList: Json[] = (sheet._pending || []).filter((c: Json) => !c.decided);
  const pending = pendingList.length;
  return (
    <div className="page">
      <div className="sheet-head">
        <div>
          <h1>{char.name || '未命名'}</h1>
          <div className="sub">{[char.race, char.background, classes].filter(Boolean).join(' · ') || '还没选种族、背景、职业'}</div>
        </div>
        <div className="row">
          <Tag>{sheet.level || 0} 级</Tag>
          {pending > 0 && (
            <button className="pendingtag" onClick={() => setTab('levelup')} title="点一下去选">
              <Tag tone="warn">待决定：{pendingList.slice(0, 3).map((c) => c.label || c.id).join('、')}{pending > 3 ? ` 等 ${pending} 项` : ''}</Tag>
            </button>
          )}
        </div>
        <div className="tools row">
          <button className="btn sm" onClick={() => download(`${char.name || '人物卡'}.json`, actions.exportJson(id))}>导出 JSON</button>
        </div>
      </div>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'view'} onClick={() => setTab('view')}>卡面</button>
        <button role="tab" aria-selected={tab === 'levelup'} onClick={() => setTab('levelup')}>升级</button>
        <button role="tab" aria-selected={tab === 'build'} onClick={() => setTab('build')}>建卡 / 编辑{pending > 0 && <span className="count">●{pending}</span>}</button>
        <button role="tab" aria-selected={tab === 'data'} onClick={() => setTab('data')}>数据</button>
      </div>
      {tab === 'view' ? <SheetView engine={engine} id={id} char={char} sheet={sheet} />
        : tab === 'levelup' ? <SheetLevelUp engine={engine} id={id} char={char} sheet={sheet} />
        : tab === 'data' ? <SheetData engine={engine} id={id} char={char} sheet={sheet} />
          : <SheetBuild engine={engine} id={id} char={char} sheet={sheet} />}
    </div>
  );
}
