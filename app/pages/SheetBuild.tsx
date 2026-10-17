/** 人物卡「建卡」：改角色的建卡决定（种族、背景、职业、属性、专长、装备…） */
import { useMemo, useState } from 'react';
import {
  ABILS, ABIL_CN, CLASS_SLUG_BY_NAME, SKILLS, STANDARD_ARRAY, backgroundBonusFrom, backgroundOriginFeat, featNames,
  pointBuyCost, pruneCharByLevel, subclassCandidates, subclassLabel, type CharData, type Json,
} from '../../src/sheet';
import { Field, NumInput, Panel, Tag, sgn } from '../components/ui';
import { Term } from '../components/Term';
import { StartingEquipmentDialog } from '../components/StartingEquipmentDialog';
import type { Engine } from '../lib/engine';
import { actions } from '../lib/store';

interface Props { engine: Engine; id: string; char: CharData; sheet: Record<string, Json> }

const CORE_CLASSES = Object.keys(CLASS_SLUG_BY_NAME).filter((n) => !['心灵术士', '随从'].includes(n));
const upd = (id: string, fn: (c: CharData) => void) => actions.update(id, fn);

function Basics({ engine, id, char }: Props) {
  const env = engine.env;
  const race = (char._resolved?.race) as Json;
  const bg = (char._resolved?.background) as Json;
  const sizes: string[] = race?.size || [];
  const mode = char.backgroundBonusMode === '1/1/1' ? '1/1/1' : '2/1';
  const need = mode === '2/1' ? 2 : 3;
  const cur = char.backgroundBonus || {};
  const init = mode === '2/1'
    ? [Object.keys(cur).find((k) => cur[k] === 2) || '', Object.keys(cur).find((k) => cur[k] === 1) || '']
    : [...Object.keys(cur), '', '', ''].slice(0, 3);
  const [slots, setSlots] = useState<string[]>(init);
  const from = backgroundBonusFrom(bg);
  const writeSlots = (next: string[]) => {
    setSlots(next);
    const filled = next.filter(Boolean);
    if (filled.length === need && new Set(filled).size === need) {
      upd(id, (c) => { c.backgroundBonus = need === 2 ? { [next[0]]: 2, [next[1]]: 1 } : { [next[0]]: 1, [next[1]]: 1, [next[2]]: 1 }; });
    }
  };
  const origin = backgroundOriginFeat(bg);
  const originFeats = env.feats.pool().filter((f) => env.feats.catOf(f).includes('O') && ['XPHB'].includes(f.source));
  const curOrigin = (char.feats || []).find((n: string) => originFeats.some((o) => o.name === n)) || '';
  return (
    <Panel title="身份与出身">
      <div className="stack">
        <div className="row">
          <Field label="名字"><input value={char.name || ''} onChange={(e) => upd(id, (c) => { c.name = e.target.value; })} /></Field>
          <Field label="玩家"><input value={char.player || ''} onChange={(e) => upd(id, (c) => { c.player = e.target.value; })} /></Field>
          <Field label="阵营"><input value={char.alignment || ''} onChange={(e) => upd(id, (c) => { c.alignment = e.target.value; })} /></Field>
        </div>
        <div className="row">
          <Field label={<>种族{char.race ? <> · <Term kind="race" name={char.race}>词条</Term></> : null}</>}>
            <select value={char.race || ''} onChange={(e) => upd(id, (c) => { c.race = e.target.value; c.size = 'M'; })}>
              <option value="">—</option>
              {env.store.races2024.map((r) => <option key={r.name} value={r.name}>{r.name}</option>)}
            </select>
          </Field>
          {sizes.length > 1 && (
            <Field label="体型">
              <select value={char.size || sizes[0]} onChange={(e) => upd(id, (c) => { c.size = e.target.value; })}>
                {sizes.map((s) => <option key={s} value={s}>{({ S: '小型', M: '中型', L: '大型' } as Record<string, string>)[s] ?? s}</option>)}
              </select>
            </Field>
          )}
          <Field label={<>背景{char.background ? <> · <Term kind="background" name={char.background}>词条</Term></> : null}</>}>
            <select value={char.background || ''} onChange={(e) => upd(id, (c) => { c.background = e.target.value; c.backgroundBonus = null; })}>
              <option value="">—</option>
              {env.store.backgrounds2024.map((b) => <option key={b.name} value={b.name}>{b.name}</option>)}
            </select>
          </Field>
        </div>
        {bg && (
          <div>
            <div className="row small">
              <span className="faint">背景属性加值</span>
              <button className={'btn sm' + (mode === '2/1' ? ' on' : '')} onClick={() => { setSlots(['', '']); upd(id, (c) => { c.backgroundBonusMode = '2/1'; c.backgroundBonus = null; }); }}>+2 / +1</button>
              <button className={'btn sm' + (mode === '1/1/1' ? ' on' : '')} onClick={() => { setSlots(['', '', '']); upd(id, (c) => { c.backgroundBonusMode = '1/1/1'; c.backgroundBonus = null; }); }}>+1 / +1 / +1</button>
            </div>
            <div className="row" style={{ marginTop: 6 }}>
              {slots.slice(0, need).map((v, i) => (
                <Field key={i} label={need === 2 ? (i === 0 ? '+2' : '+1') : '+1'}>
                  <select value={v} onChange={(e) => { const next = slots.slice(0, need); next[i] = e.target.value; writeSlots(next); }}>
                    <option value="">—</option>
                    {from.map((a) => <option key={a} value={a} disabled={slots.includes(a) && slots[i] !== a}>{ABIL_CN[a as keyof typeof ABIL_CN]}</option>)}
                  </select>
                </Field>
              ))}
              <span className="small">{char.backgroundBonus ? <Tag tone="accent">已生效：{Object.entries(char.backgroundBonus).map(([k, v]) => `${ABIL_CN[k as keyof typeof ABIL_CN]} +${v}`).join('，')}</Tag> : <span className="warnline">选满才生效</span>}</span>
            </div>
          </div>
        )}
        {bg && (
          <Field label={<>起源专长{origin ? <>（背景提供：<Term kind="feat" name={origin.name}>{origin.name}</Term>{origin.lockList ? `，锁定${origin.lockList}法表` : ''}）</> : ''}{curOrigin && curOrigin !== origin?.name ? <> · <Term kind="feat" name={curOrigin}>词条</Term></> : null}</>}>
            <select value={curOrigin} onChange={(e) => upd(id, (c) => {
              c.feats = (c.feats || []).filter((n: string) => !originFeats.some((o) => o.name === n));
              if (e.target.value) c.feats.push(e.target.value);
            })}>
              <option value="">—</option>
              {originFeats.map((f) => <option key={f.name} value={f.name}>{f.name}</option>)}
            </select>
          </Field>
        )}
      </div>
    </Panel>
  );
}

function Abilities({ id, char, sheet }: Props) {
  const spent = pointBuyCost(char.abilities || {});
  return (
    <Panel title="属性值" aside={<>
      <span className={spent > 27 ? 'warnline' : ''}>购点 {spent} / 27</span>
      <button className="btn sm" onClick={() => upd(id, (c) => { c.abilities = { ...STANDARD_ARRAY }; })}>填入标准阵列</button>
    </>}>
      <div className="row" style={{ alignItems: 'flex-end' }}>
        {ABILS.map((a) => {
          const base = char.abilities?.[a] ?? 10;
          const fin = sheet['score:' + a];
          return (
            <Field key={a} label={ABIL_CN[a]}>
              <NumInput min={1} max={30} value={base} onChange={(n) => upd(id, (c) => { c.abilities[a] = n; })} />
              <span className="tiny faint">{fin !== base ? `→ ${fin}（${sgn(fin - base)}）` : ' '} 调整 {sgn(sheet['mod:' + a])}</span>
            </Field>
          );
        })}
      </div>
      <div className="tiny faint" style={{ marginTop: 6 }}>购点和标准阵列只是参考，不拦着你填别的数。</div>
    </Panel>
  );
}

function Classes({ engine, id, char }: Props) {
  const resolved: Json[] = char._resolved?.classes || [];
  const starting = char.startingClass || char.classes?.[0]?.name;
  return (
    <Panel title="职业" aside={<button className="btn sm" onClick={() => upd(id, (c) => { c.classes = [...(c.classes || []), { name: '', level: 1, subclass: '' }]; })}>加一个职业（兼职）</button>}>
      <div className="stack">
        {(char.classes || []).map((k: Json, i: number) => {
          const r = resolved.find((x) => x.cls.name === k.name);
          const subs = r ? subclassCandidates(r.allSubclasses, r.cls.source) : [];
          const hd = r?.cls?.hd?.faces;
          const rolls: unknown[] = char.hpRolls?.[k.name] || [];
          return (
            <div key={i} style={{ borderBottom: '1px solid var(--line)', paddingBottom: 10 }}>
              <div className="row" style={{ alignItems: 'flex-end' }}>
                <Field label="职业">
                  <select value={k.name} onChange={(e) => upd(id, (c) => {
                    const old = c.classes[i].name;
                    c.classes[i] = { name: e.target.value, level: c.classes[i].level, subclass: '' };
                    if (!c.startingClass || c.startingClass === old) c.startingClass = i === 0 ? e.target.value : c.startingClass;
                    pruneCharByLevel(engine.env, c);
                  })}>
                    <option value="">—</option>
                    {CORE_CLASSES.map((n) => <option key={n} value={n} disabled={n !== k.name && char.classes.some((x: Json) => x.name === n)}>{n}</option>)}
                  </select>
                </Field>
                <Field label="等级">
                  <NumInput min={1} max={20} value={k.level} onChange={(n) => upd(id, (c) => {
                    const prev = +c.classes[i].level || 1;
                    c.classes[i].level = n;
                    if (n < prev) pruneCharByLevel(engine.env, c);
                  })} />
                </Field>
                <Field label={k.level >= 3 ? '子职' : '子职（3 级）'}>
                  <select value={k.subclass || ''} disabled={k.level < 3 || !subs.length} onChange={(e) => upd(id, (c) => {
                    c.classes[i].subclass = e.target.value;
                    pruneCharByLevel(engine.env, c);
                  })}>
                    <option value="">—</option>
                    {subs.map((s: Json) => <option key={s.name + s.source} value={s.name}>{subclassLabel(s)}</option>)}
                  </select>
                </Field>
                <label className="row small" style={{ gap: 4 }}>
                  <input type="radio" name="starting" checked={starting === k.name} onChange={() => upd(id, (c) => { c.startingClass = k.name; })} /> 起始职业
                </label>
                {char.classes.length > 1 && <button className="btn ghost sm danger" onClick={() => upd(id, (c) => {
                  c.classes.splice(i, 1);
                  pruneCharByLevel(engine.env, c);
                })}>移除</button>}
              </div>
              {hd && k.level > (starting === k.name ? 1 : 0) && (
                <div className="row small" style={{ marginTop: 6 }}>
                  <span className="faint">每级生命骰 d{hd}（空着 = 取平均 {Math.floor(hd / 2) + 1}）</span>
                  {Array.from({ length: k.level }, (_, lv) => (lv === 0 && starting === k.name) ? null : (
                    <input
                      key={lv} type="number" min={1} max={hd} style={{ width: 48 }} title={`${k.name} 第 ${lv + 1} 级`}
                      value={rolls[lv] == null ? '' : String(rolls[lv])} placeholder={`${lv + 1}级`}
                      onChange={(e) => upd(id, (c) => {
                        const arr = [...(c.hpRolls?.[k.name] || [])];
                        arr[lv] = e.target.value === '' ? null : Math.max(1, Math.min(hd, Math.round(+e.target.value)));
                        c.hpRolls = { ...(c.hpRolls || {}), [k.name]: arr };
                      })}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

function Feats({ engine, id, char, sheet }: Props) {
  const env = engine.env;
  const slots = env.feats.slots(char, char._resolved);
  const owned = featNames(char);
  const { bySlot } = env.feats.assign(char.feats || [], slots);
  if (!slots.length) return null;
  return (
    <Panel title="专长槽" aside={<span>来自职业等级表</span>}>
      <div className="stack">
        {bySlot.map(({ slot, name, index }) => {
          const cands = env.feats.candidates(slot.category, sheet, char, slot);
          return (
            <div key={slot.id} className="row">
              <span className="small" style={{ minWidth: 150 }}>{slot.label} <span className="faint tiny">{slot.from}</span></span>
              <select value={name || ''} style={{ flex: 1 }} onChange={(e) => upd(id, (c) => {
                const list: string[] = [...(c.feats || [])];
                const at = index >= 0 ? index : (name ? list.indexOf(name) : -1);
                const nextVal = e.target.value;
                if (at >= 0) { if (nextVal) list[at] = nextVal; else list.splice(at, 1); }
                else if (nextVal) list.push(nextVal);
                c.feats = list;
                if (name && name !== nextVal && c.decisions) {
                  const remain = list.filter((n) => n === name).length;
                  for (const k of Object.keys(c.decisions)) {
                    if (remain === 0 && (k.startsWith(`XPHB:${name}#`) || k.startsWith(`expanded:${name}#`) || k.startsWith(`XPHB:${name}:`))) {
                      delete c.decisions[k];
                    } else if (remain > 0) {
                      const m = new RegExp(`^XPHB:${name}:(\\d+)#`).exec(k);
                      if (m && Number(m[1]) > remain) delete c.decisions[k];
                    }
                  }
                }
              })}>
                <option value="">— 未选 —</option>
                {cands.map((x) => (
                  <option key={x.feat.name} value={x.feat.name} disabled={!x.ok || (owned.includes(x.feat.name) && x.feat.name !== name && !x.feat.repeatable)}>
                    {x.feat.name}{x.ok ? '' : `（${x.reasons[0]}）`}
                  </option>
                ))}
              </select>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

function Skills({ engine, id, char, sheet }: Props) {
  const budget = engine.env.classSkillBudget(char);
  const own = new Set<string>(char.skillProf || []);
  const exp = new Set<string>(char.skillExp || []);
  const cycle = (k: string) => upd(id, (c) => {
    const p = new Set<string>(c.skillProf || []);
    const x = new Set<string>(c.skillExp || []);
    if (x.has(k)) { x.delete(k); p.delete(k); } else if (p.has(k)) x.add(k); else p.add(k);
    c.skillProf = [...p];
    c.skillExp = [...x];
  });
  return (
    <Panel title="技能熟练" aside={budget && <span className={budget.picked.length > budget.max ? 'warnline' : ''}>职业可选 {budget.picked.length} / {budget.max}</span>}>
      {budget && (
        <div className="small muted" style={{ marginBottom: 6 }}>
          职业技能池：{budget.pool.map((k: string) => SKILLS.find((s) => s[0] === k)?.[1]).join('、')}
          {budget.grantedInPool.length > 0 && `（${budget.grantedInPool.map((g) => SKILLS.find((s) => s[0] === g.key)?.[1] + '已由' + g.from + '给出').join('，')}）`}
        </div>
      )}
      <div className="opts" style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {SKILLS.map(([k, cn]) => {
          const s = sheet.skills?.[k];
          const granted = s?.fromAbility && !own.has(k);
          return (
            <button
              key={k}
              className={'chip' + (s?.prof ? ' on' : '')}
              title={granted ? '由种族 / 背景 / 能力授予（不在这里取消）' : '点一下：熟练 → 专精 → 取消'}
              disabled={granted && !s?.exp}
              onClick={() => cycle(k)}
            >
              <Term kind="skill" name={cn} inButton>{cn}</Term>{exp.has(k) || s?.exp ? ' ×2' : ''}{budget?.pool.includes(k) ? ' ·' : ''}
            </button>
          );
        })}
      </div>
    </Panel>
  );
}

function Equipment({ engine, id, char, sheet }: Props) {
  const [openDialog, setOpenDialog] = useState(false);
  const env = engine.env;
  const allowance = env.mastery.allowance(char).total;
  const masteryWeapons = env.mastery.weapons(char, sheet.weaponProfs).filter((w: Json) => w.proficient);
  const picked: string[] = char.masteries || [];
  return (
    <>
      <Panel
        title="装备"
        aside={<button className="btn sm primary" onClick={() => setOpenDialog(true)}>一键填写起始装备…</button>}
      >
        <div className="small">
          {(char.equipment || []).length
            ? (char.equipment as Json[]).map((e, idx) => (
                <span key={idx}>
                  {idx > 0 && '、'}
                  <Term kind="item" name={e.name}>{e.name}</Term>
                  {(e.qty ?? 1) > 1 ? ` ×${e.qty}` : ''}
                  {e.equipped ? '（装备中）' : ''}
                </span>
              ))
            : <span className="faint">还没有物品。点右上角一键导入起始装备，或在「物品」页添加。</span>}
        </div>
        <div className="tiny faint" style={{ marginTop: 4 }}>装备、背包、金钱、同调都在上面的「物品」页里管理。</div>
      </Panel>
      {openDialog && (
        <StartingEquipmentDialog
          engine={engine}
          id={id}
          char={char}
          onClose={() => setOpenDialog(false)}
        />
      )}
      {allowance > 0 && (
        <Panel title="武器精通" aside={<span className={picked.length > allowance ? 'warnline' : ''}>{picked.length} / {allowance}</span>}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {masteryWeapons.map((w: Json) => {
              const on = picked.includes(w.name);
              return (
                <button key={w.name} className={'chip' + (on ? ' on' : '')} title={w.mastery.join('、')} onClick={() => upd(id, (c) => {
                  c.masteries = on ? picked.filter((x) => x !== w.name) : [...picked, w.name];
                })}>
                  <Term kind="item" name={w.name} inButton>{w.name}</Term> · <Term kind="itemMastery" name={w.mastery[0]} inButton>{w.mastery[0]}</Term>
                </button>
              );
            })}
          </div>
        </Panel>
      )}
    </>
  );
}

function LangsTools({ engine, id, char }: Props) {
  const [lang, setLang] = useState('');
  const [tool, setTool] = useState('');
  const choices: Json[] = char._resolved?.toolChoices || [];
  const langs = engine.env.languages.list();
  return (
    <Panel title="语言与工具">
      <div className="stack">
        <div className="row">
          <span className="small faint" style={{ minWidth: 36 }}>语言</span>
          {(char.languages || []).map((l: string) => <Tag key={l} onRemove={() => upd(id, (c) => { c.languages = c.languages.filter((x: string) => x !== l); })}><Term kind="language" name={l}>{l}</Term></Tag>)}
          <select value={lang} onChange={(e) => setLang(e.target.value)}>
            <option value="">选语言…</option>
            {langs.filter((l) => !(char.languages || []).includes(l.name)).map((l) => <option key={l.name} value={l.name}>{l.name}{l.type === 'rare' ? '（稀有）' : ''}</option>)}
          </select>
          <button className="btn sm" disabled={!lang} onClick={() => { upd(id, (c) => { c.languages = [...(c.languages || []), lang]; }); setLang(''); }}>添加</button>
        </div>
        <div className="row">
          <span className="small faint" style={{ minWidth: 36 }}>工具</span>
          {(char.tools || []).map((t: string) => <Tag key={t} onRemove={() => upd(id, (c) => { c.tools = c.tools.filter((x: string) => x !== t); })}><Term kind="item" name={t}>{t}</Term></Tag>)}
          <input placeholder="工具名" value={tool} onChange={(e) => setTool(e.target.value)} style={{ width: 140 }} />
          <button className="btn sm" disabled={!tool.trim()} onClick={() => { upd(id, (c) => { c.tools = [...(c.tools || []), tool.trim()]; }); setTool(''); }}>添加</button>
        </div>
        {choices.map((tc) => {
          const key = `tool:${tc.key}`;
          const cur = char.decisions?.[key];
          return (
            <div key={key} className="row">
              <span className="small faint">背景：选 {tc.count} 种{tc.label}</span>
              <select value={Array.isArray(cur) ? cur[0] ?? '' : cur ?? ''} onChange={(e) => upd(id, (c) => { c.decisions = { ...(c.decisions || {}), [key]: e.target.value ? [e.target.value] : [] }; })}>
                <option value="">—</option>
                {engine.env.tools.items(tc.pool).map((x) => <option key={x.name} value={x.name}>{x.name}</option>)}
              </select>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

export function SheetBuild(p: Props) {
  return (
    <div className="sheet-grid" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)' }}>
      <div className="stack">
        <Basics key={p.id + "/" + (p.char.background || "")} {...p} />
        <Abilities {...p} />
        <Classes {...p} />
        <Feats {...p} />
      </div>
      <div className="stack">
        <Skills {...p} />
        <Equipment {...p} />
        <LangsTools {...p} />
      </div>
    </div>
  );
}
