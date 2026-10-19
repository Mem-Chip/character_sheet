/**
 * 卡面家规的**可视化编辑器**：`mods`（加值/抗性/免疫…）和 `grants`（授予法术/技能/专长…）一行一条。
 *
 * 设计：
 * - 一行 = 一个 mod：左边下拉选种类（`app/lib/mod-form.ts` 的 MOD_FORMS），右边按种类出字段；
 * - 字段类型只有五种：数字 / 文本 / 表达式 / 多选列表 / 下拉 —— 复杂的（choices、嵌套 effect）留给 JSON 页签；
 * - 行尾实时显示中文摘要（「速度 +10」），选完就能确认自己写对了；
 * - 不认识的种类也不拦：给一个 JSON 输入框，仍然能存。
 */
import { useState } from 'react';
import type { Json } from '../../src/sheet';
import { GRANT_FORMS, MOD_FORMS, grantSummary, modSummary, type FieldDef } from '../lib/mod-form';

const FIELD_STYLE = { width: 150 } as const;

function FieldInput({ def, value, onChange }: { def: FieldDef; value: unknown; onChange: (v: unknown) => void }) {
  if (def.type === 'select') {
    const opts = (def.options ?? []).map((o) => {
      const [v, l] = o.includes(':') ? o.split(':') : [o, o];
      return { v, l };
    });
    return (
      <select value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} style={{ width: 140 }} title={def.hint}>
        <option value="">{def.label}…</option>
        {opts.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
      </select>
    );
  }
  if (def.type === 'list') {
    const arr = Array.isArray(value) ? (value as string[]) : [];
    return (
      <input
        value={arr.join('、')}
        onChange={(e) => onChange(e.target.value.split(/[、,，;；]/).map((x) => x.trim()).filter(Boolean))}
        placeholder={def.hint ?? '多个用「、」隔开'}
        title={def.hint}
        list={`dl-${def.key}`}
        style={FIELD_STYLE}
      />
    );
  }
  const isNum = def.type === 'number';
  return (
    <input
      value={value === undefined || value === null ? '' : String(value)}
      onChange={(e) => {
        const raw = e.target.value;
        if (isNum) onChange(raw === '' ? undefined : Number(raw));
        else onChange(raw === '' ? undefined : raw);
      }}
      placeholder={def.hint ?? (def.type === 'expr' ? '可写表达式，如 pb + 2' : '')}
      title={def.hint ?? def.note}
      inputMode={isNum ? 'numeric' : undefined}
      style={FIELD_STYLE}
    />
  );
}

/** 一条 mod / grant 的编辑行 */
function Row({
  forms, kind, item, onKind, onChange, onRemove,
}: {
  forms: Record<string, { label: string; hint: string; fields: FieldDef[] }>;
  kind: 'mod' | 'grant';
  item: Json;
  onKind: (k: string) => void;
  onChange: (patch: Json) => void;
  onRemove: () => void;
}) {
  const form = forms[String(item.kind)];
  const [json, setJson] = useState('');
  const summary = kind === 'mod' ? modSummary(item) : grantSummary(item);
  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 'var(--r)', padding: '6px 8px', marginBottom: 6 }}>
      <div className="row" style={{ gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <select value={String(item.kind ?? '')} onChange={(e) => onKind(e.target.value)}>
          <option value="">{kind === 'mod' ? '加什么…' : '授予什么…'}</option>
          {Object.entries(forms).map(([k, f]) => <option key={k} value={k}>{f.label}</option>)}
          {item.kind && !form ? <option value={String(item.kind)}>{String(item.kind)}（自定义）</option> : null}
        </select>
        {form && form.fields.map((def) => (
          <span key={def.key} className="row" style={{ gap: 4, alignItems: 'center' }}>
            <span className="tiny faint">{def.label}</span>
            <FieldInput def={def} value={item[def.key]} onChange={(v) => onChange({ [def.key]: v })} />
          </span>
        ))}
        {form && form.hint && <span className="tiny faint">{form.hint}</span>}
        <span style={{ flex: 1 }} />
        <span className="small">{summary}</span>
        <button className="btn ghost sm danger" onClick={onRemove} title="删掉这一条">删</button>
      </div>
      {!form && (
        <div className="row" style={{ marginTop: 4 }}>
          <input
            value={json}
            onChange={(e) => setJson(e.target.value)}
            placeholder='自定义：{"kind":"…",…} —— 粘一段 JSON 再按右边的按钮'
            style={{ flex: 1 }}
          />
          <button
            className="btn sm"
            onClick={() => {
              try {
                const o = JSON.parse(json || '{}') as Json;
                if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('要是一个对象');
                onChange(o);
                setJson('');
              } catch (e) {
                window.alert('JSON 有问题：' + (e as Error).message);
              }
            }}
          >应用</button>
        </div>
      )}
    </div>
  );
}

export function ModsEditor({ mods, grants, onChange }: { mods: Json[]; grants: Json[]; onChange: (p: { mods?: Json[]; grants?: Json[] }) => void }) {
  const set = (i: number, patch: Json) => onChange({ mods: mods.map((m, j) => (j === i ? { ...m, ...patch } : m)) });
  const setG = (i: number, patch: Json) => onChange({ grants: grants.map((m, j) => (j === i ? { ...m, ...patch } : m)) });
  return (
    <div className="stack">
      <div>
        <div className="small faint" style={{ marginBottom: 4 }}>加值 / 改动（mods）：会算进人物卡的 AC、生命、速度、抗性、技能加值…</div>
        {mods.map((m, i) => (
          <Row
            key={i} kind="mod" forms={MOD_FORMS} item={m}
            onKind={(k) => set(i, { kind: k })}
            onChange={(patch) => set(i, patch)}
            onRemove={() => onChange({ mods: mods.filter((_, j) => j !== i) })}
          />
        ))}
        <button className="btn sm" onClick={() => onChange({ mods: [...mods, { kind: '' }] })}>＋ 加一条改动</button>
      </div>
      <div>
        <div className="small faint" style={{ marginBottom: 4 }}>授予（grants）：法术、戏法、专长、技能熟练、语言…</div>
        {grants.map((g, i) => (
          <Row
            key={i} kind="grant" forms={GRANT_FORMS} item={g}
            onKind={(k) => setG(i, { kind: k })}
            onChange={(patch) => setG(i, patch)}
            onRemove={() => onChange({ grants: grants.filter((_, j) => j !== i) })}
          />
        ))}
        <button className="btn sm" onClick={() => onChange({ grants: [...grants, { kind: '' }] })}>＋ 加一条授予</button>
      </div>
    </div>
  );
}
