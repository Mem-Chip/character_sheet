/**
 * **战斗数据的积木编辑器**：编辑一份 `Entry` 里的 `actions` / `triggers`。
 *
 * 设计取舍：
 * - 不做流程图，做「缩进列表 + 下拉 + 输入框」——节点树的形状固定（root / onHit / onFail / then…），
 *   所以每一层只是一个列表，人一眼能看懂；
 * - 只把**最常用的 7 种节点**做成表单：damage / save / heal / tempHp / applyEffect / attack / if / note；
 *   其它节点（zone / summon / grantAction / choose…）显示成「JSON 行」，照样能编辑，只是没有表单；
 * - 覆盖范围刻意窄：看不懂的字段不会被丢掉（原样保留），表单只改它认识的那几个。
 */
import { useState } from 'react';
import type { Json } from '../../src/sheet';

const ACTIVATION = [['action', '动作'], ['bonus', '附赠动作'], ['reaction', '反应'], ['free', '自由'], ['none', '不算动作']] as const;
const WINDOWS = [
  'turnStarted', 'turnEnded', 'combatStarted', 'roundStarted', 'initiativeRolled',
  'spellCast', 'd20Rolled', 'attackHit', 'attackMissed', 'saveForced',
  'damageIncoming', 'damageTaken', 'reducedTo0', 'leftReach', 'restCompleted',
] as const;
const ROLES = [['any', '任何人'], ['actor', '发起者'], ['target', '被打的'], ['ally', '自己人']] as const;
const ABILS = [['str', '力量'], ['dex', '敏捷'], ['con', '体质'], ['int', '智力'], ['wis', '感知'], ['cha', '魅力']] as const;
const TOS = [['target', '目标'], ['attacker', '伤害来源 / 攻击者'], ['self', '自己'], ['each', '每个目标']] as const;
const DAMAGE_TYPES = ['酸蚀', '钝击', '冷冻', '火焰', '力场', '闪电', '黯蚀', '穿刺', '毒素', '心灵', '光耀', '挥砍', '雷鸣'];

/** 每种节点的表单：字段名 → 输入类型 */
type NodeField = { key: string; label: string; type: 'text' | 'expr' | 'number' | 'select' | 'list'; options?: readonly string[]; hint?: string };
const NODE_FORMS: Record<string, { label: string; fields: NodeField[]; branches?: string[] }> = {
  damage: { label: '伤害', fields: [
    { key: 'dice', label: '骰子', type: 'expr', hint: '2d6 / slot.level d8' },
    { key: 'type', label: '类型', type: 'select', options: DAMAGE_TYPES },
    { key: 'to', label: '给谁', type: 'select', options: TOS.map(([v, l]) => `${v}:${l}`) },
    { key: 'scale', label: '倍率', type: 'number', hint: '0.5 = 减半' },
  ] },
  save: { label: '豁免', fields: [
    { key: 'ability', label: '属性', type: 'select', options: ABILS.map(([v, l]) => `${v}:${l}`) },
    { key: 'dc', label: 'DC', type: 'expr', hint: 'self.spell.dc' },
    { key: 'to', label: '谁豁免', type: 'select', options: TOS.map(([v, l]) => `${v}:${l}`) },
  ], branches: ['onFail', 'onSuccess'] },
  heal: { label: '治疗', fields: [{ key: 'amount', label: '数值', type: 'expr', hint: '1d8 + 3' }, { key: 'to', label: '给谁', type: 'select', options: TOS.map(([v, l]) => `${v}:${l}`) }] },
  tempHp: { label: '临时生命值', fields: [{ key: 'amount', label: '数值', type: 'expr' }, { key: 'to', label: '给谁', type: 'select', options: TOS.map(([v, l]) => `${v}:${l}`) }] },
  applyEffect: { label: '挂效应', fields: [
    { key: 'template', label: '模板', type: 'text', hint: '本条目的 effects 名，或绝对键' },
    { key: 'to', label: '给谁', type: 'select', options: TOS.map(([v, l]) => `${v}:${l}`) },
  ] },
  attack: { label: '攻击', fields: [{ key: 'bonus', label: '命中加值', type: 'expr', hint: 'self.spell.atk' }], branches: ['onHit', 'onMiss'] },
  if: { label: '条件', fields: [{ key: 'when', label: '条件', type: 'expr', hint: 'self.hp <= 10' }], branches: ['then', 'else'] },
  note: { label: '说明', fields: [{ key: 'text', label: '文字', type: 'text' }] },
};
const BRANCH_LABEL: Record<string, string> = { onHit: '命中时', onMiss: '没命中', onFail: '失败时', onSuccess: '成功时', then: '成立', else: '不成立', root: '做这些', do: '做这些' };

function Sel({ value, onChange, options, placeholder }: { value: unknown; onChange: (v: string) => void; options: readonly string[]; placeholder: string }) {
  const opts = options.map((o) => (o.includes(':') ? { v: o.split(':')[0], l: o.split(':')[1] } : { v: o, l: o }));
  return (
    <select value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} style={{ minWidth: 90 }}>
      <option value="">{placeholder}</option>
      {opts.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
    </select>
  );
}

function Value({ f, value, onChange }: { f: NodeField; value: unknown; onChange: (v: unknown) => void }) {
  if (f.type === 'select') return <Sel value={value} onChange={(v) => onChange(v || undefined)} options={f.options ?? []} placeholder={`${f.label}…`} />;
  return (
    <input
      value={value === undefined || value === null ? '' : String(value)}
      onChange={(e) => {
        const raw = e.target.value;
        if (f.type === 'number') onChange(raw === '' ? undefined : Number(raw));
        else onChange(raw === '' ? undefined : raw);
      }}
      placeholder={f.hint ?? f.label}
      title={f.hint}
      style={{ width: f.type === 'expr' ? 130 : 150 }}
    />
  );
}

/** 一个节点（递归：save/if/attack 的分支里还是节点列表） */
function NodeRow({ node, depth, onChange, onRemove }: { node: Json; depth: number; onChange: (n: Json) => void; onRemove: () => void }) {
  const [raw, setRaw] = useState('');
  const [showRaw, setShowRaw] = useState(false);
  const form = NODE_FORMS[String(node.kind)];
  const set = (patch: Json) => onChange({ ...node, ...patch });
  return (
    <div style={{ marginLeft: depth * 14, borderLeft: depth ? '2px solid var(--line)' : undefined, paddingLeft: depth ? 8 : 0, marginBottom: 4 }}>
      <div className="row" style={{ gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
        <select value={String(node.kind ?? '')} onChange={(e) => onChange({ kind: e.target.value })}>
          <option value="">+ 节点…</option>
          {Object.entries(NODE_FORMS).map(([k, f]) => <option key={k} value={k}>{f.label}</option>)}
          {node.kind && !form ? <option value={String(node.kind)}>{String(node.kind)}（JSON）</option> : null}
        </select>
        {form?.fields.map((f) => (
          <span key={f.key} className="row" style={{ gap: 3, alignItems: 'center' }}>
            <span className="tiny faint">{f.label}</span>
            <Value f={f} value={node[f.key]} onChange={(v) => set({ [f.key]: v })} />
          </span>
        ))}
        {!form && (
          <button className="btn ghost sm" onClick={() => { setRaw(JSON.stringify(node)); setShowRaw(!showRaw); }}>{showRaw ? '收起' : '编辑 JSON'}</button>
        )}
        <span style={{ flex: 1 }} />
        <button className="btn ghost sm danger" onClick={onRemove} title="删掉这个节点">×</button>
      </div>
      {!form && showRaw && (
        <div className="row" style={{ marginTop: 3 }}>
          <input className="mono" value={raw} onChange={(e) => setRaw(e.target.value)} placeholder='{"kind":"zone",…}' style={{ flex: 1 }} />
          <button className="btn sm" onClick={() => { try { onChange(JSON.parse(raw) as Json); } catch { window.alert('JSON 有问题'); } }}>应用</button>
        </div>
      )}
      {form?.branches?.map((b) => (
        <div key={b} style={{ marginTop: 3 }}>
          <div className="tiny faint">{BRANCH_LABEL[b] ?? b}</div>
          <NodeList
            nodes={(node[b] as Json[]) ?? []} depth={depth + 1}
            onChange={(list) => set({ [b]: list.length ? list : undefined })}
          />
        </div>
      ))}
    </div>
  );
}

function NodeList({ nodes, depth, onChange }: { nodes: Json[]; depth: number; onChange: (n: Json[]) => void }) {
  return (
    <div>
      {nodes.map((n, i) => (
        <NodeRow
          key={i} node={n} depth={depth}
          onChange={(next) => onChange(nodes.map((x, j) => (j === i ? next : x)))}
          onRemove={() => onChange(nodes.filter((_, j) => j !== i))}
        />
      ))}
      <div style={{ marginLeft: depth * 14 }}>
        <button className="btn ghost sm" onClick={() => onChange([...nodes, { kind: '' }])}>＋ 节点</button>
      </div>
    </div>
  );
}

/** 代价：只做最常见的三种（动作经济 / 法术位 / 资源），其余写 JSON */
function Cost({ costs, onChange }: { costs: Json[]; onChange: (c: Json[]) => void }) {
  const eco = costs.find((c) => c.economy)?.economy;
  const slot = costs.find((c) => c.slot)?.slot?.min;
  return (
    <span className="row" style={{ gap: 4, alignItems: 'center' }}>
      <span className="tiny faint">代价</span>
      <Sel value={eco} onChange={(v) => onChange([...(v && v !== 'action' ? [{ economy: v }] : v === 'action' ? [{ economy: 'action' }] : []), ...(slot ? [{ slot: { min: slot } }] : [])])} options={ACTIVATION.map(([v, l]) => `${v}:${l}`)} placeholder="无" />
      <span className="tiny faint">法术位</span>
      <input type="number" min={0} value={slot ?? ''} onChange={(e) => onChange([...(eco ? [{ economy: eco }] : []), ...(e.target.value ? [{ slot: { min: Number(e.target.value) } }] : [])])} style={{ width: 56 }} title="最低环阶（空 = 不用法术位）" />
    </span>
  );
}

export function CombatEditor({ entry, onChange }: { entry: Json; onChange: (e: Json) => void }) {
  const actions: Json[] = (entry.actions as Json[]) ?? [];
  const triggers: Json[] = (entry.triggers as Json[]) ?? [];
  const setA = (i: number, patch: Json) => onChange({ ...entry, actions: actions.map((a, j) => (j === i ? { ...a, ...patch } : a)) });
  const setT = (i: number, patch: Json) => onChange({ ...entry, triggers: triggers.map((t, j) => (j === i ? { ...t, ...patch } : t)) });
  return (
    <div className="stack">
      <div>
        <div className="small bold" style={{ marginBottom: 4 }}>动作（玩家点一下就能用的）</div>
        {actions.map((a, i) => (
          <div key={i} style={{ border: '1px solid var(--line)', borderRadius: 'var(--r)', padding: '6px 8px', marginBottom: 6 }}>
            <div className="row" style={{ gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <input value={String(a.name ?? '')} onChange={(e) => setA(i, { name: e.target.value })} placeholder="动作名" style={{ width: 130 }} />
              <Sel value={a.activation} onChange={(v) => setA(i, { activation: v || undefined })} options={ACTIVATION.map(([v, l]) => `${v}:${l}`)} placeholder="激活方式" />
              <span className="tiny faint">动作 id</span>
              <input value={String(a.id ?? '')} onChange={(e) => setA(i, { id: e.target.value })} placeholder="cast" style={{ width: 70 }} title="同一个条目里不能重名；触发器里靠它找动作" />
              <Cost costs={(a.cost as Json[]) ?? []} onChange={(c) => setA(i, { cost: c.length ? c : undefined })} />
              <span style={{ flex: 1 }} />
              <button className="btn ghost sm danger" onClick={() => onChange({ ...entry, actions: actions.filter((_, j) => j !== i) })}>删动作</button>
            </div>
            <div className="row" style={{ gap: 6, marginTop: 4, alignItems: 'center', flexWrap: 'wrap' }}>
              <span className="tiny faint">目标</span>
              <Sel value={a.targeting?.type} onChange={(v) => setA(i, { targeting: v ? { ...(a.targeting ?? {}), type: v } : undefined })} options={['creature:一个生物', 'self:自己', 'point:一点', 'area:范围']} placeholder="选目标" />
              {a.targeting?.type && a.targeting.type !== 'self' && (
                <>
                  <span className="tiny faint">射程</span>
                  <input type="number" value={a.targeting?.range ?? ''} onChange={(e) => setA(i, { targeting: { ...a.targeting, range: Number(e.target.value) || undefined } })} style={{ width: 70 }} placeholder="60" />
                </>
              )}
            </div>
            <div style={{ marginTop: 4 }}>
              <NodeList nodes={(a.root as Json[]) ?? []} depth={0} onChange={(list) => setA(i, { root: list })} />
            </div>
          </div>
        ))}
        <button className="btn sm" onClick={() => onChange({ ...entry, actions: [...actions, { id: 'use', name: '新动作', activation: 'action', root: [] }] })}>＋ 加一个动作</button>
      </div>

      <div>
        <div className="small bold" style={{ marginBottom: 4 }}>触发器（什么时候自动发生）</div>
        {triggers.map((t, i) => (
          <div key={i} style={{ border: '1px solid var(--line)', borderRadius: 'var(--r)', padding: '6px 8px', marginBottom: 6 }}>
            <div className="row" style={{ gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <input value={String(t.label ?? '')} onChange={(e) => setT(i, { label: e.target.value })} placeholder="显示名" style={{ width: 130 }} />
              <Sel value={t.on} onChange={(v) => setT(i, { on: v || undefined })} options={WINDOWS.map((w) => `${w}:${w}`)} placeholder="什么时机" />
              <Sel value={t.role} onChange={(v) => setT(i, { role: v || undefined })} options={ROLES.map(([v, l]) => `${v}:${l}`)} placeholder="谁的能力" />
              <Sel value={t.window} onChange={(v) => setT(i, { window: v || undefined })} options={['before:结算前', 'after:结算后']} placeholder="前/后" />
              <span style={{ flex: 1 }} />
              <button className="btn ghost sm danger" onClick={() => onChange({ ...entry, triggers: triggers.filter((_, j) => j !== i) })}>删触发器</button>
            </div>
            <div className="row" style={{ gap: 6, marginTop: 4, alignItems: 'center' }}>
              <span className="tiny faint">条件</span>
              <input value={String(t.when ?? '')} onChange={(e) => setT(i, { when: e.target.value || undefined })} placeholder="attacker != null && within(self, target, 30)" style={{ flex: 1 }} />
            </div>
            <div style={{ marginTop: 4 }}>
              <div className="tiny faint">触发时做什么</div>
              <NodeList nodes={(t.do as Json[]) ?? []} depth={0} onChange={(list) => setT(i, { do: list })} />
            </div>
          </div>
        ))}
        <button className="btn sm" onClick={() => onChange({ ...entry, triggers: [...triggers, { id: `t${triggers.length + 1}`, label: '新触发器', on: 'damageTaken', role: 'any', do: [] }] })}>＋ 加一个触发器</button>
      </div>
    </div>
  );
}
