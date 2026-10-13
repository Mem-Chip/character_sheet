/**
 * 待决定项：能力数据里的 choices + 结构性选项（祈唤 / 战技 / 原初职能…）+ 种族「再选一项起源专长」。
 * 决策写进 char.decisions[key]；子职选择直接写 classes[i].subclass。
 */
import { useState } from 'react';
import { ABILS, ABIL_CN, abilityPlans, choiceOptions, type CharData, type Json } from '../../src/sheet';
import type { Engine } from '../lib/engine';
import { actions } from '../lib/store';
import { Panel, Tag } from './ui';

const KIND_CN: Record<string, string> = {
  skill: '技能', expertise: '专精', language: '语言', tool: '工具', feat: '专长', spell: '法术', cantrip: '戏法',
  itemMastery: '武器精通', ability: '属性', classFeature: '特性', optfeature: '可选项', save: '豁免', note: '说明', subclass: '子职',
};

function asList(v: unknown): string[] {
  if (v == null || v === '') return [];
  return (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === 'string' && !!x);
}

function Choice(p: { engine: Engine; id: string; char: CharData; sheet: Json; ch: Json }) {
  const { engine, id, char, sheet, ch } = p;
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
    const plan = plans.find((pl) => pl.count === picked.length && picked.every((k) => val[k] === pl.amount)) ?? plans[0];
    return (
      <div className="choice">
        {head}{from}
        {plans.length > 1 && (
          <div className="opts">
            {plans.map((pl) => (
              <button key={pl.count} className={'chip' + (pl === plan ? ' on' : '')} onClick={() => write(null)}>
                {pl.count === 1 ? `一项 +${pl.amount}` : `${pl.count} 项各 +${pl.amount}`}
              </button>
            ))}
          </div>
        )}
        <div className="opts">
          {pool.map((a) => {
            const on = picked.includes(a);
            return (
              <button
                key={a}
                className={'chip' + (on ? ' on' : '')}
                onClick={() => {
                  const next = { ...val };
                  if (on) delete next[a];
                  else {
                    const target = plans.find((pl) => pl.count === Object.keys(next).length + 1) ?? plans[0];
                    if (Object.keys(next).length >= Math.max(...plans.map((x) => x.count))) return;
                    next[a] = target.amount;
                    for (const k of Object.keys(next)) next[k] = target.amount;
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

  const res = choiceOptions(engine.env, char, sheet, ch);
  const vals = asList(cur);
  return (
    <div className="choice">
      {head}{from}
      {res.empty && !res.options.length ? <div className="warnline">{res.empty}</div> : (
        <div className="opts">
          {res.options.map((o) => {
            const on = vals.includes(o.value);
            const full = !on && vals.length >= need;
            return (
              <button
                key={o.value}
                className={'chip' + (on ? ' on' : '')}
                disabled={full && need > 1}
                title={o.label}
                onClick={() => {
                  if (need === 1) write(on ? null : (isSub || ch.pick ? o.value : [o.value]));
                  else write(on ? vals.filter((x) => x !== o.value) : [...vals, o.value]);
                }}
              >
                {o.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function Choices(p: { engine: Engine; id: string; char: CharData; sheet: Json; title?: string }) {
  const [showDone, setShowDone] = useState(false);
  const pending: Json[] = p.sheet._pending || [];
  const open = pending.filter((c) => !c.decided);
  const done = pending.filter((c) => c.decided);
  const list = showDone ? [...open, ...done] : open;
  return (
    <Panel
      title={p.title ?? '待决定'}
      aside={<>
        <span>{open.length} 项待定</span>
        {done.length > 0 && <button className="btn ghost sm" onClick={() => setShowDone(!showDone)}>{showDone ? '隐藏已决定' : `显示已决定（${done.length}）`}</button>}
      </>}
      flush
    >
      {list.length ? list.map((ch) => <Choice key={ch.key} {...p} ch={ch} />) : <div className="empty">没有需要决定的事。</div>}
    </Panel>
  );
}
