/**
 * 选法术：按职业分页、按环阶折叠的列表，勾选就加，不用一道一道点。
 *
 * 2024 规则里每个施法职业都是「准备」法术，上限来自职业表；区别在什么时候能换：
 * - 牧师、德鲁伊、圣武士、法师：长休后可以换；
 * - 吟游诗人、游侠、术士、魔契师：升级时才能换一道。
 * 法师多一步：先抄进法术书（1 级 6 道，之后每级 +2），只能从法术书里准备。
 * 子职、种族、专长给的「常备」法术不占名额，锁着显示。超过上限只提醒，不拦。
 */
import { useState } from 'react';
import { SCHOOL_CN, classSpells, type Json } from '../../src/sheet';
import type { Engine } from '../lib/engine';
import { actions } from '../lib/store';
import { Entries } from './Entries';
import { Dialog, Tag } from './ui';

const SWAP_ON_REST = new Set(['牧师', '德鲁伊', '圣武士', '法师']);

interface Props { engine: Engine; id: string; char: Json; sheet: Json; onClose: () => void }

export function SpellBrowser({ engine, id, char, sheet, onClose }: Props) {
  const sc = sheet.spell || {};
  const casters: Json[] = sc.casters || [];
  const [cls, setCls] = useState<string>(casters[0]?.name ?? '');
  const [q, setQ] = useState('');
  const [peek, setPeek] = useState<string | null>(null);
  const caster = casters.find((k) => k.name === cls) ?? casters[0];
  if (!caster) return <Dialog title="选法术" onClose={onClose}><div className="empty">这张卡没有施法职业。</div></Dialog>;

  const wizard = caster.name === '法师';
  // 能施展的最高环：法术位（或契约位）里最高的那一环
  const maxSlot = Math.max(0, ...(sc.slots || []).map((v: number, i: number) => (v ? i + 1 : 0)), sc.pact?.level ?? 0);
  const list = classSpells(engine.env, caster.name, { maxLevel: Math.max(maxSlot, 0) });
  const spells: Json[] = char.spells || [];
  const book: string[] = char.spellbook || [];
  const granted = new Set((sc.granted || []).map((g: Json) => g.name));
  /** 这道法术算在哪个职业上：记了 cls 的按记的，没记的（老卡）算第一个施法职业 */
  const mine = (s: Json) => (s.cls ?? casters[0]?.name) === caster.name;
  const entryOf = (name: string) => spells.find((s) => s.name === name && mine(s));
  const cantrips = spells.filter((s) => mine(s) && lvlOf(s.name) === 0).length;
  const prepared = spells.filter((s) => mine(s) && lvlOf(s.name) > 0 && s.prepared !== false).length;
  function lvlOf(name: string) { return list.find((x) => x.name === name)?.level ?? (engine.env.store.data.spellsXphb?.spell || []).find((x: Json) => x.name === name)?.level ?? 1; }

  const toggle = (name: string, level: number) => actions.update(id, (c) => {
    const arr: Json[] = c.spells || [];
    const i = arr.findIndex((s) => s.name === name && (s.cls ?? casters[0]?.name) === caster.name);
    if (i >= 0) arr.splice(i, 1);
    else arr.push({ name, prepared: true, cls: caster.name, ...(level === 0 ? { isCantrip: true } : {}) });
    c.spells = arr;
  });
  const toggleBook = (name: string) => actions.update(id, (c) => {
    const b: string[] = c.spellbook || [];
    if (b.includes(name)) {
      c.spellbook = b.filter((x) => x !== name);
      c.spells = (c.spells || []).filter((s: Json) => !(s.name === name && (s.cls ?? casters[0]?.name) === '法师'));
    } else c.spellbook = [...b, name];
  });

  const query = q.trim();
  const levels = [...new Set(list.map((s) => s.level as number))].sort((a, b) => a - b);
  const over = (cur: number, max: number | null | undefined) => max != null && max > 0 && cur > max;

  return (
    <Dialog title="选法术" onClose={onClose}>
      <div className="spellbrowser">
        {casters.length > 1 && (
          <div className="tabs" role="tablist" style={{ marginBottom: 0 }}>
            {casters.map((k) => <button key={k.name} role="tab" aria-selected={k.name === caster.name} onClick={() => setCls(k.name)}>{k.name} {k.level}</button>)}
          </div>
        )}
        <div className="row small">
          {(caster.cantrips > 0 || cantrips > 0) && <span className={over(cantrips, caster.cantrips) ? 'warnline' : ''}>戏法 {cantrips}{caster.cantrips != null ? ` / ${caster.cantrips}` : ''}</span>}
          <span className={over(prepared, caster.prepared) ? 'warnline' : ''}>已准备 {prepared}{caster.prepared != null ? ` / ${caster.prepared}` : ''}</span>
          {wizard && <span className={over(book.length, sc.spellbookMax) ? 'warnline' : ''}>法术书 {book.length}{sc.spellbookMax != null ? ` / ${sc.spellbookMax}` : ''}</span>}
          <span className="faint">{SWAP_ON_REST.has(caster.name) ? '长休后可以换准备的法术' : '升级时可以换一道'}</span>
          <span style={{ flex: 1 }} />
          <input placeholder="筛选名字" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 130 }} />
        </div>
        {wizard && <div className="small muted">法师：先「抄进书」，再点法术准备；戏法不用进书。</div>}
        <div className="spelllevels">
          {levels.map((lv) => {
            const rows = list.filter((s) => s.level === lv && (!query || String(s.name).includes(query)));
            if (!rows.length) return null;
            const picked = rows.filter((s) => entryOf(s.name)).length;
            return (
              <details key={lv} open={!!query || lv <= 1 || picked > 0}>
                <summary><span className="serif">{lv ? `${lv} 环` : '戏法'}</span><span className="tiny faint">{rows.length} 道{picked ? ` · 已选 ${picked}` : ''}</span></summary>
                {rows.map((s) => {
                  const on = !!entryOf(s.name);
                  const inBook = book.includes(s.name);
                  const locked = granted.has(s.name);
                  const conc = JSON.stringify(s.duration || '').includes('concentration');
                  const ritual = !!s.meta?.ritual;
                  return (
                    <div key={s.name} className={'spellrow' + (on || locked ? ' on' : '')}>
                      {wizard && lv > 0 && (
                        <button type="button" className={'bk' + (inBook ? ' in' : '')} title={inBook ? '从法术书里划掉' : '抄进法术书'} onClick={() => toggleBook(s.name)}>{inBook ? '书 ✓' : '抄进书'}</button>
                      )}
                      {/* 整行就是「选 / 不选」 */}
                      <button
                        type="button" className="pick" aria-pressed={on || locked}
                        disabled={locked || (wizard && lv > 0 && !inBook)}
                        title={locked ? '常备法术，不占名额' : wizard && lv > 0 && !inBook ? '先抄进法术书' : on ? '点一下取消' : lv ? '点一下准备' : '点一下学会'}
                        onClick={() => toggle(s.name, lv)}
                      >
                        <span className="box">{on || locked ? '✓' : ''}</span>
                        <span className="nm">{s.name}</span>
                        <span className="tiny faint">{SCHOOL_CN[s.school] ?? ''}</span>
                        {conc && <Tag>专注</Tag>}
                        {ritual && <Tag>仪式</Tag>}
                        {locked && <Tag tone="accent">常备</Tag>}
                      </button>
                      <button type="button" className="btn ghost sm" onClick={() => setPeek(peek === s.name ? null : s.name)}>{peek === s.name ? '收起' : '原文'}</button>
                      {peek === s.name && <div className="prose small peek"><Entries entries={s.entries || []} /></div>}
                    </div>
                  );
                })}
              </details>
            );
          })}
        </div>
      </div>
    </Dialog>
  );
}
