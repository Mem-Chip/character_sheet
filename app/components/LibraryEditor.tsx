/**
 * 库条目编辑器（LIBRARY.md 第二节）：一份资源可以拆成多条 part —— 一个子职 = 每级特性一条。
 *
 * 键留空 = 新内容（自动用 `HR:<part id>`，这张卡上这条能力的键也是它）；
 * 填官方键 = 覆盖官方那条（覆盖官方能力的条目不能勾「选了才生效」，服务器会拒）。
 * 卡面 / 战斗两块都是 JSON，写法同 data/abilities-*.json 和战斗 Entry。
 */
import { useState } from 'react';
import { keyProblem, type LibraryItem, type ResPart } from '../../src/library';
import type { Json } from '../../src/sheet';
import { AiDatafy } from './AiDatafy';
import { Dialog, Field, Tag } from './ui';
import { CombatEditor } from './CombatEditor';
import { SyntaxHelp } from './SyntaxHelp';
import { ModsEditor } from './ModsEditor';
import { aiExamples, aiSheetExamplesText, aiSpec, partsFromAnswer, partsJobForKey } from '../lib/ai';
import type { Engine } from '../lib/engine';
import { newPartId } from '../lib/library';
import { RULE_FILES } from '../../src/bridge/rule-files';
import { RuleBook, auditRuleBook, type Entry, type RuleFile } from '../../src/combat';
import { lintEntry, lintShape } from '../../src/factory/lint';
import { genericOwner, smoke } from '../../src/factory/smoke';

const KINDS: Array<[string, string]> = [
  ['homerule', '家规 / 自制'], ['feat', '专长'], ['classFeature', '职业特性'], ['subclassFeature', '子职特性'],
  ['subclass', '子职'], ['spell', '法术'], ['item', '物品'], ['race', '种族'], ['optfeature', '可选特性'], ['monster', '怪物'],
];
export const kindLabel = (k: string) => KINDS.find(([v]) => v === k)?.[1] ?? k;

interface DraftPart {
  id: string; key: string; name: string; text: string; pickable: boolean; removed: boolean; sheet: string; combat: string;
}
interface Draft { id: string; kind: string; name: string; text: string; by: string; reviewed: boolean; parts: DraftPart[] }

const pretty = (v: unknown) => (v === undefined ? '' : JSON.stringify(v, null, 1));
const partToDraft = (p: ResPart): DraftPart => ({
  id: p.id, key: p.key.startsWith('HR:') ? '' : p.key, name: p.name ?? '', text: p.text ?? '',
  pickable: !!p.pickable, removed: !!p.removed, sheet: pretty(p.sheet), combat: pretty(p.combat),
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
      // 本版删除的不带数据（写了也不要）
      const sheet = raw.removed ? undefined : parse(raw.sheet, '卡面数据') as ResPart['sheet'] | undefined;
      const combat = raw.removed ? undefined : parse(raw.combat, '战斗数据') as ResPart['combat'] | undefined;
      return {
        id, key,
        ...(raw.name.trim() ? { name: raw.name.trim() } : {}),
        ...(raw.text.trim() ? { text: raw.text } : {}),
        ...(raw.pickable && key.startsWith('HR:') ? { pickable: true } : {}),
        ...(raw.removed && !key.startsWith('HR:') ? { removed: true } : {}),
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

              </div>
              {!isNew && (
                <label className="row small" style={{ gap: 6 }} title="改版里没有这条：卡面上不再显示它，它的加值、资源和战斗数据都拿掉">
                  <input type="checkbox" checked={raw.removed} disabled={ro} onChange={(e) => setPart(i, { removed: e.target.checked })} />
                  本版删除这条官方特性
                </label>
              )}
              {raw.removed
                ? <div className="small muted">这条会从卡面和战斗里拿掉（{key}）。</div>
                : <PartData raw={raw} ro={ro} onChange={(patch) => setPart(i, patch)} />}
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
            <button className="btn sm" onClick={() => setD({ ...d, parts: [...d.parts, { id: newPartId(), key: '', name: '', text: '', pickable: false, removed: false, sheet: '', combat: '' }] })}>再加一条</button>
            <span className="small muted">{d.parts.length > 1 ? '一个子职 / 职业的每条特性各加一条，键分别是它的条目键。' : ''}</span>
          </div>
        )}

        <div className="row" style={{ gap: 6, marginTop: 4 }}>
          <CheckPanel parts={d.parts} />
          <SyntaxButton />
        </div>
        {problems.length > 0 && <div className="dangerline small">{problems.map((x, i) => <div key={i}>{x}</div>)}</div>}
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
            prepare={() => partsJobForKey(p.engine, p.cid ?? null, { key, name: raw.name || d.name, text: raw.text || d.text, cls: p.item?.ref?.cls })}
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
                  removed: !!np.removed,
                  sheet: pretty(np.sheet),
                  combat: pretty(np.combat),
                };
                if (j >= 0) next[j] = { ...next[j], name: fresh.name || next[j].name, text: fresh.text || next[j].text, removed: fresh.removed, sheet: fresh.sheet, combat: fresh.combat };
                else next.push(fresh);
              }
              // 整个子职拆成了每级特性：原来那条（子职键、还没数据）是个空壳，去掉
              const shell = next[aiPart];
              if (!parts.some((np) => np.key === key) && !shell.sheet.trim() && !shell.combat.trim()) next.splice(aiPart, 1);
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

/** 一条 part 的数据：卡面（表单 / JSON）+ 战斗（积木 / JSON） */
function PartData({ raw, ro, onChange }: { raw: { sheet: string; combat: string }; ro: boolean; onChange: (patch: { sheet?: string; combat?: string }) => void }) {
  const [tab, setTab] = useState<'sheet' | 'combat'>('sheet');
  const [json, setJson] = useState<Record<'sheet' | 'combat', boolean>>({ sheet: false, combat: false });
  let sheetObj: Json = {};
  try { sheetObj = raw.sheet.trim() ? (JSON.parse(raw.sheet) as Json) : {}; } catch { sheetObj = {}; }
  let combatObj: Json = {};
  try { combatObj = raw.combat.trim() ? (JSON.parse(raw.combat) as Json) : {}; } catch { combatObj = {}; }
  const entry: Json = (combatObj.entry as Json) ?? (combatObj.actions || combatObj.triggers ? combatObj : {});
  const hasCombat = !!(combatObj.entry || combatObj.patch || combatObj.value || Object.keys(entry).length);
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="row" style={{ gap: 6, alignItems: 'center' }}>
        <button className={tab === 'sheet' ? 'btn sm primary' : 'btn sm'} onClick={() => setTab('sheet')}>卡面</button>
        <button className={tab === 'combat' ? 'btn sm primary' : 'btn sm'} onClick={() => setTab('combat')}>战斗</button>
        <span style={{ flex: 1 }} />
        <button className="btn ghost sm" onClick={() => setJson({ ...json, [tab]: !json[tab] })}>{json[tab] ? '用表单' : '原始 JSON'}</button>
      </div>
      {tab === 'sheet' ? (
        json.sheet ? (
          <textarea rows={5} className="mono" value={raw.sheet} readOnly={ro} onChange={(e) => onChange({ sheet: e.target.value })} placeholder='{ "mods": [], "grants": [], "resources": [] }' />
        ) : (
          <ModsEditor
            mods={(sheetObj.mods || []) as Json[]}
            grants={(sheetObj.grants || []) as Json[]}
            resources={(sheetObj.resources || []) as Json[]}
            onChange={(patch) => onChange({ sheet: JSON.stringify({ ...sheetObj, ...patch }, null, 1) })}
          />
        )
      ) : (
        json.combat ? (
          <textarea rows={6} className="mono" value={raw.combat} readOnly={ro} onChange={(e) => onChange({ combat: e.target.value })} placeholder='{ "entry": { "name": "…", "actions": [] } }' />
        ) : (
          <>
            {combatObj.patch || combatObj.value ? (
              <div className="tiny faint">这条是「只改字段」或「核心参数」，请用原始 JSON 编辑。</div>
            ) : null}
            <CombatEditor entry={entry} onChange={(next) => onChange({ combat: JSON.stringify({ ...(combatObj.entry ? { ...combatObj, entry: next } : hasCombat ? next : { entry: next }) }, null, 1) })} />
          </>
        )
      )}
    </div>
  );
}

/** 检查 / 试算：把当前这几条 part 过一遍结构检查、规则审计，再拿假持有者跑一次 */
/** 打开语法速查（给「留空自己写节点」的人） */
function SyntaxButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="btn ghost sm" onClick={() => setOpen(true)}>语法速查</button>
      {open && <SyntaxHelp onClose={() => setOpen(false)} />}
    </>
  );
}

function CheckPanel({ parts }: { parts: Array<{ id: string; key: string; name: string; sheet: string; combat: string }> }) {
  const [errs, setErrs] = useState<string[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [done, setDone] = useState(false);

  const entries = () => parts.map((raw) => {
    const key = raw.key.trim() || `HR:${raw.id}`;
    let combat: Json = {};
    try { combat = raw.combat.trim() ? (JSON.parse(raw.combat) as Json) : {}; } catch { /* 交给 lint 报 */ }
    const entry = (combat.entry as Entry) ?? (combat as unknown as Entry);
    return { key, name: raw.name, entry };
  });

  const check = () => {
    const es: string[] = [];
    const ns: string[] = [];
    const files = RULE_FILES as unknown as RuleFile[];
    for (const { key, name, entry } of entries()) {
      if (!entry || !Object.keys(entry).length) continue;
      const e = { name: name || key.split(':').pop(), ...entry } as unknown as Entry;
      try {
        for (const m of lintShape(e)) es.push(`${key}：${m}`);
        for (const m of lintEntry(key, e, { files })) es.push(`${key}：${m}`);
        const book = new RuleBook([...files, { entries: { [key]: e } } as unknown as RuleFile]);
        for (const m of auditRuleBook(book)) if (m.startsWith(key)) es.push(m);
      } catch (x) {
        es.push(`${key}：检查器崩了（${(x as Error).message}）`);
      }
    }
    setErrs(es);
    setNotes(ns);
    setDone(true);
  };

  const trial = () => {
    const es: string[] = [];
    const ns: string[] = [];
    const files = RULE_FILES as unknown as RuleFile[];
    for (const { key, name, entry } of entries()) {
      if (!entry || !Object.keys(entry).length) continue;
      const e = { name: name || key.split(':').pop(), ...entry } as unknown as Entry;
      try {
        const owner = genericOwner(key, {});
        const r = smoke(key, e, files, owner);
        for (const m of r.errors) es.push(`${key}：${m}`);
        for (const m of r.notes) ns.push(`${key}：${m}`);
        if (!r.errors.length && !r.notes.length) ns.push(`${key}：跑通了`);
      } catch (x) {
        es.push(`${key}：试算崩了（${(x as Error).message}）`);
      }
    }
    setErrs(es);
    setNotes(ns);
    setDone(true);
  };

  return (
    <div className="stack" style={{ gap: 4, marginTop: 4 }}>
      <div className="row" style={{ gap: 6 }}>
        <button className="btn sm" onClick={check}>检查</button>
        <button className="btn sm" onClick={trial}>试算（假持有者跑一遍）</button>
      </div>
      {done && !errs.length && <div className="small ok">没问题{notes.length ? `（${notes.length} 条提示）` : ''}</div>}
      {errs.length > 0 && (
        <div className="dangerline small">
          {errs.slice(0, 12).map((x, i) => <div key={i}>{x}</div>)}
          {errs.length > 12 && <div>…还有 {errs.length - 12} 条</div>}
        </div>
      )}
      {notes.length > 0 && (
        <div className="small muted">
          {notes.slice(0, 8).map((x, i) => <div key={i}>{x}</div>)}
        </div>
      )}
    </div>
  );
}
