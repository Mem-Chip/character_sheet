/**
 * 待决定项：能力数据里的 choices + 结构性选项（祈唤 / 战技 / 原初职能…）+ 种族「再选一项起源专长」+ 职业专长槽。
 * 决策写进 char.decisions[key]；子职选择直接写 classes[i].subclass；专长槽写进 char.feats。
 */
import { useState } from 'react';
import { ABILS, ABIL_CN, abilityPlans, choiceOptions, featNames, type CharData, type FeatSlot, type Json, type SheetEnv } from '../../src/sheet';
import type { Engine } from '../lib/engine';
import { actions } from '../lib/store';
import { choiceTerm } from '../lib/terms';
import { Term } from './Term';
import { Panel, Tag } from './ui';

const KIND_CN: Record<string, string> = {
  skill: '技能', expertise: '专精', language: '语言', tool: '工具', feat: '专长', spell: '法术', cantrip: '戏法',
  itemMastery: '武器精通', ability: '属性', classFeature: '特性', optfeature: '可选项', save: '豁免', note: '说明', subclass: '子职',
};

function asList(v: unknown): string[] {
  if (v == null || v === '') return [];
  return (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === 'string' && !!x);
}

/** 汇总所有尚未决定的事项（未填专长槽 + 未完成的能力/结构选择） */
export function openChoiceItems(env: SheetEnv, char: CharData, sheet: Json): Array<{ key: string; label: string }> {
  const slots = env.feats.slots(char, char._resolved);
  const { bySlot } = env.feats.assign(char.feats || [], slots);
  const openSlots = bySlot
    .filter((b) => !b.name)
    .map((b) => ({ key: `featSlot:${b.slot.id}`, label: `${b.slot.label}（${b.slot.from}）` }));
  const openPending = ((sheet._pending || []) as Json[])
    .filter((c) => !c.decided)
    .map((c) => ({ key: String(c.key), label: String(c.label || c.id) }));
  return [...openSlots, ...openPending];
}

function FeatSlotChoice(p: { engine: Engine; id: string; char: CharData; sheet: Json; slot: FeatSlot; name: string | null }) {
  const { engine, id, char, sheet, slot, name } = p;
  const env = engine.env;
  const owned = featNames(char);
  const rawCands = env.feats.candidates(slot.category, sheet, char, slot);
  const cands = [...rawCands].sort((a, b) => {
    if (slot.label === '属性值提升') {
      if (a.feat.name === '属性值提升') return -1;
      if (b.feat.name === '属性值提升') return 1;
    }
    const aAvail = a.ok && (!owned.includes(a.feat.name) || a.feat.name === name || !!a.feat.repeatable);
    const bAvail = b.ok && (!owned.includes(b.feat.name) || b.feat.name === name || !!b.feat.repeatable);
    if (aAvail !== bAvail) return aAvail ? -1 : 1;
    return String(a.feat.name).localeCompare(String(b.feat.name), 'zh');
  });

  const selectFeat = (nextFeat: string | null) => actions.update(id, (c) => {
    const list: string[] = [...(c.feats || [])];
    const curSlots = env.feats.slots(c, c._resolved);
    const { bySlot } = env.feats.assign(list, curSlots);
    const hit = bySlot.find((b) => b.slot.id === slot.id);
    const oldName = hit?.name ?? name;
    const at = hit && hit.index >= 0 ? hit.index : (oldName ? list.indexOf(oldName) : -1);
    if (at >= 0) {
      if (nextFeat) list[at] = nextFeat;
      else list.splice(at, 1);
    } else if (nextFeat) {
      list.push(nextFeat);
    }
    c.feats = list;
    if (oldName && oldName !== nextFeat && c.decisions) {
      const remain = list.filter((n) => n === oldName).length;
      for (const k of Object.keys(c.decisions)) {
        if (remain === 0 && (k.startsWith(`XPHB:${oldName}#`) || k.startsWith(`expanded:${oldName}#`) || k.startsWith(`XPHB:${oldName}:`))) {
          delete c.decisions[k];
        } else if (remain > 0) {
          const m = new RegExp(`^XPHB:${oldName}:(\\d+)#`).exec(k);
          if (m && Number(m[1]) > remain) delete c.decisions[k];
        }
      }
    }
  });

  const catLabel = env.feats.CAT[slot.category] || slot.category;
  return (
    <div className="choice">
      <div className="spread">
        <div className="t">
          {slot.label}：选择一项{catLabel}专长 <Tag>专长</Tag>
          {name && <Tag tone="accent">已决定：{name}</Tag>}
        </div>
        {name && <button className="btn ghost sm" onClick={() => selectFeat(null)}>重选</button>}
      </div>
      <div className="from">来自 {slot.from}</div>
      <div className="opts">
        {cands.map((x) => {
          const on = name === x.feat.name;
          const had = !on && owned.includes(x.feat.name) && !x.feat.repeatable;
          const disabled = (!on && !x.ok) || had;
          const reason = !x.ok ? x.reasons.join('；') : had ? `${x.feat.name}：别处已经有了` : undefined;
          return (
            <button
              key={x.feat.name}
              className={'chip' + (on ? ' on' : '')}
              disabled={disabled}
              title={reason}
              onClick={() => selectFeat(on ? null : x.feat.name)}
            >
              <Term kind="feat" name={x.feat.name} inButton>{x.feat.name}</Term>
              {had && <span className="faint">（已有）</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Choice(p: { engine: Engine; id: string; char: CharData; sheet: Json; ch: Json }) {
  const { engine, id, char, sheet, ch } = p;
  const [modeCount, setModeCount] = useState<number | null>(null);
  const need = ch.count || 1;
  const isSub = ch.pool === 'subclass';
  const subIdx = isSub ? (char.classes || []).findIndex((c: Json) => {
    const k = (char._resolved?.classes || []).find((x: Json) => x.cls.name === c.name);
    return k && (k.allSubclasses || []).length && k.level >= 3;
  }) : -1;
  const cur: unknown = isSub ? (subIdx >= 0 ? char.classes[subIdx].subclass : '') : char.decisions?.[ch.key];
  const write = (v: unknown) => actions.update(id, (c) => {
    if (isSub && subIdx >= 0) { c.classes[subIdx].subclass = String(v || ''); return; }
    c.decisions = c.decisions || {};
    if (v == null || (Array.isArray(v) && !v.length) || v === '') delete c.decisions[ch.key];
    else c.decisions[ch.key] = v;
  });

  const head = (
    <div className="spread">
      <div className="t">
        {ch.label || ch.id} <Tag>{KIND_CN[ch.kind] ?? ch.kind}</Tag>
        {ch.decided && <Tag tone="accent">已决定</Tag>}
      </div>
      {cur != null && cur !== '' && !(Array.isArray(cur) && !cur.length) && <button className="btn ghost sm" onClick={() => write(null)}>重选</button>}
    </div>
  );
  const from = <div className="from">来自 {ch.from || ch.ability}{need > 1 ? ` · 选 ${need} 项` : ''}</div>;

  // 属性加值：方案（一项 +2 / 两项各 +1）
  if (ch.kind === 'ability' && !ch.pick) {
    const plans = abilityPlans(ch);
    const pool: string[] = Array.isArray(ch.from) ? ch.from : [...ABILS];
    const val = (cur && typeof cur === 'object' && !Array.isArray(cur) ? cur : {}) as Record<string, number>;
    const picked = Object.keys(val);
    const matchedPlan = plans.find((pl) => picked.length > 0 && picked.every((k) => val[k] === pl.amount) && picked.length <= pl.count);
    const plan = (modeCount != null ? plans.find((pl) => pl.count === modeCount) : null) ?? matchedPlan ?? plans[0];
    return (
      <div className="choice">
        {head}
        <div className="from">来自 {ch.from || ch.ability}{plan.count > 1 ? ` · 已选 ${picked.length} / ${plan.count} 项` : ''}</div>
        {plans.length > 1 && (
          <div className="opts" style={{ marginBottom: 6 }}>
            {plans.map((pl) => (
              <button
                key={pl.count}
                className={'chip' + (pl.count === plan.count ? ' on' : '')}
                onClick={() => {
                  setModeCount(pl.count);
                  if (picked.length > 0) write(null);
                }}
              >
                {pl.count === 1 ? `一项 +${pl.amount}` : `${pl.count} 项各 +${pl.amount}`}
              </button>
            ))}
          </div>
        )}
        <div className="opts">
          {pool.map((a) => {
            const on = picked.includes(a);
            const full = !on && picked.length >= plan.count;
            return (
              <button
                key={a}
                className={'chip' + (on ? ' on' : '')}
                disabled={full && plan.count > 1}
                onClick={() => {
                  const next = { ...val };
                  if (on) delete next[a];
                  else {
                    if (plan.count === 1) {
                      for (const k of Object.keys(next)) delete next[k];
                    } else if (Object.keys(next).length >= plan.count) {
                      return;
                    }
                    next[a] = plan.amount;
                  }
                  write(Object.keys(next).length ? next : null);
                }}
              >
                {ABIL_CN[a as keyof typeof ABIL_CN] ?? a}{on ? ` +${val[a]}` : ''}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  function termForChoiceOption(ch: Json, o: { value: string; label: string }): { kind: string; name: string } | null {
    return choiceTerm({ kind: String(ch.kind ?? ''), pool: String(ch.pool ?? ''), value: o.value, label: o.label });
  }

  const res = choiceOptions(engine.env, char, sheet, ch);
  const vals = asList(cur);
  // 别处已经有了的（背景给的技能、另一项选择选过的语言…）：不能再选，标出来
  const taken = takenElsewhere(sheet, ch, vals);
  return (
    <div className="choice">
      {head}{from}
      {res.empty && !res.options.length ? <div className="warnline">{res.empty}</div> : (
        <div className="opts">
          {res.options.map((o) => {
            const on = vals.includes(o.value);
            const full = !on && vals.length >= need;
            const had = !on && taken.has(o.value);
            const tr = termForChoiceOption(ch, o);
            return (
              <button
                key={o.value}
                className={'chip' + (on ? ' on' : '')}
                disabled={(full && need > 1) || had}
                title={had ? `${o.label}：别处已经有了` : undefined}
                onClick={() => {
                  if (need === 1) write(on ? null : (isSub || ch.pick ? o.value : [o.value]));
                  else write(on ? vals.filter((x) => x !== o.value) : [...vals, o.value]);
                }}
              >
                {tr ? <Term {...tr} inButton>{o.label}</Term> : o.label}
                {had && <span className="faint">（已有）</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** 这一项选择之外已经拥有的（这一项自己选的不算） */
function takenElsewhere(sheet: Json, ch: Json, own: string[]): Set<string> {
  const pool = String(ch.pool ?? '');
  let have: Iterable<string> = [];
  if (ch.kind === 'expertise' || pool === 'profSkill' || pool === 'anyProfSkill') have = sheet.skillExpSet ?? [];
  else if (ch.kind === 'skill' || pool === 'skill' || pool === 'skillOrTool') have = [...(sheet.skillProfSet ?? []), ...(pool === 'skillOrTool' ? sheet.tools ?? [] : [])];
  else if (ch.kind === 'language' || pool === 'language') have = sheet.languages ?? [];
  else if (ch.kind === 'tool' || ['tool', 'artisan', 'instrument'].includes(pool)) have = sheet.tools ?? [];
  const out = new Set(have);
  for (const v of own) out.delete(v);
  return out;
}

export function Choices(p: { engine: Engine; id: string; char: CharData; sheet: Json; title?: string; hideEmpty?: boolean }) {
  const slots = p.engine.env.feats.slots(p.char, p.char._resolved);
  const { bySlot } = p.engine.env.feats.assign(p.char.feats || [], slots);
  const openSlots = bySlot.filter((b) => !b.name);
  const doneSlots = bySlot.filter((b) => !!b.name);
  const pending: Json[] = p.sheet._pending || [];
  const open = pending.filter((c) => !c.decided);
  const done = pending.filter((c) => c.decided);
  const totalOpen = openSlots.length + open.length;
  const totalDone = doneSlots.length + done.length;
  const title = p.title ?? '待决定';
  if (p.hideEmpty && totalOpen === 0 && totalDone === 0) return null;
  return (
    <div id="sheet-choices-panel">
      {totalOpen > 0 && (
        <Panel title={title} aside={<span>{totalOpen} 项待定</span>} flush>
          <div className="stack">
            {openSlots.map(({ slot, name }) => <FeatSlotChoice key={`featSlot:${slot.id}`} {...p} slot={slot} name={name} />)}
            {open.map((ch) => <Choice key={ch.key} {...p} ch={ch} />)}
          </div>
        </Panel>
      )}
      {totalDone > 0 && (
        <Panel title="已决定" aside={<span className="tiny faint">{totalOpen > 0 ? `已决定 ${totalDone} 项` : '都选完了'}</span>} flush>
          {/* 全选完时默认折起来，只留一行；点开可以改 */}
          <details open={false}>
            <summary className="small" style={{ cursor: 'pointer', padding: '6px 10px' }}>
              已决定 {totalDone} 项 —— 点开可以重选
            </summary>
            <div className="stack" style={{ paddingTop: 6 }}>
              {doneSlots.map(({ slot, name }) => <FeatSlotChoice key={`featSlot:${slot.id}`} {...p} slot={slot} name={name} />)}
              {done.map((ch) => <Choice key={ch.key} {...p} ch={ch} />)}
            </div>
          </details>
        </Panel>
      )}
      {totalOpen === 0 && totalDone === 0 && (
        <Panel title={title} flush><div className="empty">没有需要决定的事。</div></Panel>
      )}
    </div>
  );
}
