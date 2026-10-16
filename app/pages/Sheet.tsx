/** 人物卡页：抬头 + 「卡面 / 建卡」两个视图 */
import { useState } from 'react';
import type { Json } from '../../src/sheet';
import { Tag } from '../components/ui';
import type { Engine } from '../lib/engine';
import { actions, useApp } from '../lib/store';
import { useComputed } from '../lib/useSheet';
import { SheetBuild } from './SheetBuild';
import { SheetData } from './SheetData';
import { SheetItems } from './SheetItems';
import { SheetLevelUp } from './SheetLevelUp';
import { SheetHero, SheetView } from './SheetView';

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
  const [tab, setTab] = useState<'view' | 'items' | 'levelup' | 'build' | 'data'>(card && !card.char.race && !card.char.classes?.[0]?.name ? 'build' : 'view');

  if (!card || !id) {
    return <div className="page"><div className="empty">还没有打开角色。去 <button className="btn sm" onClick={() => actions.go('library')}>卡片库</button> 选一张，或者新建。</div></div>;
  }
  if (!computed) return <div className="page"><div className="empty">正在计算…</div></div>;

  const { char, sheet } = computed;
  const pendingList: Json[] = (sheet._pending || []).filter((c: Json) => !c.decided);
  const pending = pendingList.length;
  return (
    <div className="page sheet-page">
      <SheetHero
        id={id} char={char} sheet={sheet}
        tags={<>
          <Tag>{sheet.level || 0} 级</Tag>
          {pending > 0 && (
            <button className="pendingtag" onClick={() => setTab('levelup')} title={pendingList.map((c) => c.label || c.id).join('\n')}>
              <Tag tone="warn">待决定 {pending} 项</Tag>
            </button>
          )}
        </>}
      />
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'view'} onClick={() => setTab('view')}>卡面</button>
        <button role="tab" aria-selected={tab === 'items'} onClick={() => setTab('items')}>物品</button>
        <button role="tab" aria-selected={tab === 'levelup'} onClick={() => setTab('levelup')}>升级{pending > 0 && <span className="count">●{pending}</span>}</button>
        <button role="tab" aria-selected={tab === 'build'} onClick={() => setTab('build')}>建卡 / 编辑</button>
        <button role="tab" aria-selected={tab === 'data'} onClick={() => setTab('data')}>数据</button>
        <span style={{ flex: 1 }} />
        <button className="btn ghost sm" onClick={() => download(`${char.name || '人物卡'}.json`, actions.exportJson(id))}>导出 JSON</button>
      </div>
      {tab === 'view' ? <SheetView engine={engine} id={id} char={char} sheet={sheet} />
        : tab === 'items' ? <SheetItems engine={engine} id={id} char={char} sheet={sheet} />
        : tab === 'levelup' ? <SheetLevelUp engine={engine} id={id} char={char} sheet={sheet} />
        : tab === 'data' ? <SheetData engine={engine} id={id} char={char} sheet={sheet} />
          : <SheetBuild engine={engine} id={id} char={char} sheet={sheet} />}
    </div>
  );
}
