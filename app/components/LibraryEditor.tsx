/**
 * 库条目编辑器（LIBRARY.md 第二节）：一份资源可以拆成多条 part —— 一个子职 = 每级特性一条。
 *
 * 键留空 = 新内容（自动用 `HR:<part id>`，这张卡上这条能力的键也是它）；
 * 填官方键 = 覆盖官方那条（覆盖官方能力的条目不能勾「选了才生效」，服务器会拒）。
 * 卡面 / 战斗两块都是 JSON，写法同 data/abilities-*.json 和战斗 Entry。
 */
import { useState } from 'react';
import { keyProblem, type LibraryItem, type ResPart } from '../../src/library';
import { AiDatafy } from './AiDatafy';
import { Dialog, Field, Tag } from './ui';
import { aiExamples, aiSheetExamplesText, aiSpec, partsFromAnswer, partsJobForKey } from '../lib/ai';
import type { Engine } from '../lib/engine';
import { newPartId } from '../lib/library';

const KINDS: Array<[string, string]> = [
  ['homerule', '家规 / 自制'], ['feat', '专长'], ['classFeature', '职业特性'], ['subclassFeature', '子职特性'],
  ['subclass', '子职'], ['spell', '法术'], ['item', '物品'], ['race', '种族'], ['optfeature', '可选特性'], ['monster', '怪物'],
];
export const kindLabel = (k: string) => KINDS.find(([v]) => v === k)?.[1] ?? k;

interface DraftPart {
  id: string; key: string; name: string; text: string; pickable: boolean; sheet: string; combat: string;
}
interface Draft { id: string; kind: string; name: string; text: string; by: string; reviewed: boolean; parts: DraftPart[] }

const pretty = (v: unknown) => (v === undefined ? '' : JSON.stringify(v, null, 1));
const partToDraft = (p: ResPart): DraftPart => ({
  id: p.id, key: p.key.startsWith('HR:') ? '' : p.key, name: p.name ?? '', text: p.text ?? '',
  pickable: !!p.pickable, sheet: pretty(p.sheet), combat: pretty(p.combat),
});
const itemToDraft = (it: LibraryItem): Draft => ({
  id: it.id, kind: it.kind || 'homerule', name: it.name, text: it.text, by: it.by, reviewed: it.reviewed,
  parts: (it.parts ?? []).map(partToDraft),
});

export function LibraryEditor(p: {
  item: LibraryItem;
  engine: Engine;
  /** AI 拼任务时的战役上下文（按这个团的资料算探针角色）；账户页里可以不给 */
  cid?: string | null;
  readOnly?: boolean;
  onClose: () => void;
  onSave: (it: LibraryItem) => Promise<string[]>;
  onDelete?: () => void;
}) {
  const ro = !!p.readOnly;
  const [d, setD] = useState<Draft>(() => itemToDraft(p.item));
  const [problems, setProblems] = useState<string[]>([]);
  const [aiPart, setAiPart] = useState<number | null>(null);
  const setPart = (i: number, patch: Partial<DraftPart>) => setD((s) => ({ ...s, parts: s.parts.map((x, j) => (j === i ? { ...x, ...patch } : x)) }));

  const save = async () => {
    const bad: string[] = [];
    const parts: ResPart[] = d.parts.map((raw, i) => {
      const at = `第 ${i + 1} 条`;
      const id = raw.id;
      const key = raw.key.trim() || `HR:${id}`;
      const kp = keyProblem(key);
      if (kp) bad.push(`${at}：${kp}`);
      const parse = (s: string, what: string) => {
        if (!s.trim()) return undefined;
        try { return JSON.parse(s) as unknown; } catch { bad.push(`${at}：${what}不是合法的 JSON`); return undefined; }
      };
      const sheet = parse(raw.sheet, '卡面数据') as ResPart['sheet'] | undefined;
      const combat = parse(raw.combat, '战斗数据') as ResPart['combat'] | undefined;
      return {
        id, key,
        ...(raw.name.trim() ? { name: raw.name.trim() } : {}),
        ...(raw.text.trim() ? { text: raw.text } : {}),
        ...(raw.pickable && key.startsWith('HR:') ? { pickable: true } : {}),
        ...(sheet ? { sheet } : {}),
        ...(combat ? { combat } : {}),
      };
    });
    if (!d.name.trim()) bad.push('这条内容要有名字');
    if (!parts.length) bad.push('至少要有一条');
    if (bad.length) { setProblems(bad); return; }
    try {
      const r = await p.onSave({
        id: d.id, kind: d.kind, name: d.name.trim(), text: d.text, parts, by: d.by, reviewed: d.reviewed,
        ...(p.item.source ? { source: p.item.source } : {}),
        ...(p.item.ref ? { ref: p.item.ref } : {}),
      });
      if (r.length) setProblems(r); else p.onClose();
    } catch (e) { setProblems([(e as Error).message]); }
  };

  return (
    <Dialog title={ro ? d.name : p.item.name ? `编辑「${p.item.name}」` : '新的内容'} onClose={p.onClose} footer={<>
      {!ro && d.by !== 'hand' && <label className="row small"><input type="checkbox" checked={d.reviewed} onChange={(e) => setD({ ...d, reviewed: e.target.checked })} />看过了，没问题</label>}
      <span style={{ flex: 1 }} />
      {!ro && p.onDelete && <button className="btn ghost sm danger" onClick={() => { if (confirm(`删掉「${d.name}」？挂着的战役也会一起拿掉。`)) p.onDelete!(); }}>删除</button>}
      <button className="btn" onClick={p.onClose}>{ro ? '关闭' : '取消'}</button>
      {!ro && <button className="btn primary" disabled={!d.name.trim()} onClick={() => void save()}>保存</button>}
    </>}>
      <div className="stack" style={{ gap: 8 }}>
        <div className="row" style={{ gap: 8 }}>
          <Field label="名字" style={{ flex: 1 }}><input value={d.name} readOnly={ro} onChange={(e) => setD({ ...d, name: e.target.value })} /></Field>
          <Field label="类别">
            <select value={d.kind} disabled={ro} onChange={(e) => setD({ ...d, kind: e.target.value })}>
              {KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </Field>
        </div>
        <Field label="说明（原文摘要 / 家规正文；会显示在这条内容上）">
          <textarea rows={3} value={d.text} readOnly={ro} onChange={(e) => setD({ ...d, text: e.target.value })} />
        </Field>
        {p.item.ref && (
          <div className="small muted">
            出处：{kindLabel(p.item.ref.kind)} · {p.item.ref.source}
            {p.item.ref.cls ? ` · ${p.item.ref.cls}` : ''}{p.item.ref.level !== undefined ? ` ${p.item.ref.level} 级` : ''}
            {p.item.ref.name !== d.name ? ` · ${p.item.ref.name}` : ''}
          </div>
        )}

        <div className="small faint">条目（一份资源可以拆成几条：一个子职就是每级特性一条）</div>
        {d.parts.map((raw, i) => {
          const key = raw.key.trim() || `HR:${raw.id}`;
          const isNew = key.startsWith('HR:');
          return (
            <div key={raw.id} className="stack" style={{ gap: 6, border: '1px solid var(--line, #ddd)', borderRadius: 6, padding: 8 }}>
              <div className="row small" style={{ gap: 6 }}>
                <Tag>{i + 1}</Tag>
                {isNew ? <Tag tone="accent" title={key}>新内容</Tag> : <Tag tone="warn" title={key}>覆盖 {key}</Tag>}
                <span style={{ flex: 1 }} />
                {!ro && d.parts.length > 1 && <button className="btn ghost sm danger" onClick={() => setD({ ...d, parts: d.parts.filter((_, j) => j !== i) })}>删掉这条</button>}
              </div>
              <Field label="条目键（留空 = 新内容；填官方键 = 覆盖它，比如 XPHB:野蛮人:狂暴:1）">
                <input value={raw.key} readOnly={ro} onChange={(e) => setPart(i, { key: e.target.value })} placeholder={`留空 = 新内容（HR:${raw.id}）`} />
              </Field>
              <div className="row" style={{ gap: 8 }}>
                <Field label="这条的名字" style={{ flex: 1 }}><input value={raw.name} readOnly={ro} onChange={(e) => setPart(i, { name: e.target.value })} placeholder="不填就用整条的名字" /></Field>
                {isNew && (
                  <label className="row small" style={{ alignItems: 'flex-start', whiteSpace: 'normal', flex: 1 }}>
                    <input type="checkbox" checked={raw.pickable} disabled={ro} onChange={(e) => setPart(i, { pickable: e.target.checked })} />
                    不是人人都有：卡上选了才生效<br /><span className="faint">（不勾 = 有这个能力或选了这条的卡直接生效）</span>
                  </label>
                )}
              </div>
              <Field label="卡面数据（JSON：mods / grants / choices / resources；写法同能力数据）">
                <textarea rows={4} className="mono" value={raw.sheet} readOnly={ro} onChange={(e) => setPart(i, { sheet: e.target.value })} placeholder='{ "mods": [], "grants": [], "choices": [], "resources": [] }' />
              </Field>
              <Field label="战斗数据（JSON：{ entry } 整条；覆盖官方的可以 { patch } 只改字段；核心参数写 { value } 配 key = core.<名>）">
                <textarea rows={6} className="mono" value={raw.combat} readOnly={ro} onChange={(e) => setPart(i, { combat: e.target.value })} placeholder='{ "entry": { "name": "…", "actions": [] } }' />
              </Field>
              {!ro && (
                <div className="row small" style={{ gap: 6 }}>
                  <button className="btn sm" disabled={!d.name.trim()} onClick={() => setAiPart(i)}>AI 写这条的数据（卡面 + 战斗）…</button>
                  <span className="muted">按这条的键和原文让 AI 写；检查过了填进下面两块。一个子职这种要拆成多条的，AI 会多写几个 part。</span>
                </div>
              )}
            </div>
          );
        })}
        {!ro && (
          <div className="row">
            <button className="btn sm" onClick={() => setD({ ...d, parts: [...d.parts, { id: newPartId(), key: '', name: '', text: '', pickable: false, sheet: '', combat: '' }] })}>再加一条</button>
            <span className="small muted">{d.parts.length > 1 ? '一个子职 / 职业的每条特性各加一条，键分别是它的条目键。' : ''}</span>
          </div>
        )}

        {problems.length > 0 && <div className="dangerline small">{problems.map((x, i) => <div key={i}>{x}</div>)}</div>}
        {!ro && <div className="small muted">存进你自己的库。挂到战役之后：新内容立刻对全团生效，覆盖官方的要 DM 点头。</div>}
      </div>

      {aiPart !== null && (() => {
        const raw = d.parts[aiPart];
        const key = raw.key.trim() || `HR:${raw.id}`;
        // 已经写过的内容当「上一版」：在里面改比从零写稳
        let initial: unknown;
        try {
          const sheet = raw.sheet.trim() ? JSON.parse(raw.sheet) : undefined;
          const combat = raw.combat.trim() ? JSON.parse(raw.combat) : undefined;
          initial = (sheet || combat)
            ? { parts: [{ key, name: raw.name || d.name, text: raw.text || d.text, sheet, combat: combat?.entry ?? combat }] }
            : undefined;
        } catch { initial = undefined; }
        return (
          <AiDatafy
            title={`AI 写「${raw.name || d.name}」的数据（卡面 + 战斗）`}
            initial={initial}
            saveLabel="填进这条"
            spec={aiSpec('both')}
            examples={`${aiExamples()}\n\n## 卡面数据的例子（真实数据，照这个粒度写）\n\n${aiSheetExamplesText()}`}
            prepare={() => partsJobForKey(p.engine, p.cid ?? null, { key, name: raw.name || d.name, text: raw.text || d.text })}
            onSave={async (a, by) => {
              const parts = partsFromAnswer(a, { key });
              if (!parts.length) return ['AI 没给出内容（parts 是空的）'];
              // 同键的更新原来那条（保住 id：卡上「选了才生效」勾的是它），新键的追加（一个子职会多出几条）
              const next = [...d.parts];
              for (const np of parts) {
                const j = next.findIndex((x) => (x.key.trim() || `HR:${x.id}`) === np.key);
                const fresh: DraftPart = {
                  id: np.id,
                  key: np.key.startsWith('HR:') ? '' : np.key,
                  name: np.name ?? '',
                  text: np.text ?? '',
                  pickable: !!np.pickable,
                  sheet: pretty(np.sheet),
                  combat: pretty(np.combat),
                };
                if (j >= 0) next[j] = { ...next[j], name: fresh.name || next[j].name, text: fresh.text || next[j].text, sheet: fresh.sheet, combat: fresh.combat };
                else next.push(fresh);
              }
              setD((s) => ({ ...s, parts: next, by }));
              setAiPart(null);
              return [];
            }}
            onClose={() => setAiPart(null)}
          />
        );
      })()}
    </Dialog>
  );
}

/** 一条内容在列表里的标签：覆盖了什么 / 新内容 / 卡面 / 战斗 / AI 未审 */
export function ItemTags({ item }: { item: LibraryItem }) {
  const parts = item.parts ?? [];
  const covers = parts.filter((x) => !x.key.startsWith('HR:')).map((x) => x.key);
  return (
    <>
      {covers.length
        ? <Tag tone="warn" title={covers.join('\n')}>覆盖 {covers.length > 1 ? `${covers.length} 条` : covers[0]}</Tag>
        : <Tag>新内容</Tag>}
      {parts.length > 1 && <Tag title="拆成了几条">{parts.length} 条</Tag>}
      {parts.some((x) => x.sheet) && <Tag>卡面</Tag>}
      {parts.some((x) => x.combat) && <Tag>战斗</Tag>}
      {item.by !== 'hand' && <Tag tone={item.reviewed ? undefined : 'warn'}>{item.reviewed ? 'AI · 已看过' : 'AI · 未审'}</Tag>}
    </>
  );
}
