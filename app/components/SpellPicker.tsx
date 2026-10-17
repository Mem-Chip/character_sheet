/**
 * 可展开的法术挑选器（嵌入人物卡法术面板下方）：
 * - 支持中英文即时搜索（name、ENG_name）
 * - 支持按环阶（戏法、1~9环）与专注/仪式标签筛选
 * - 支持多职业施法者标签切换
 * - 针对法师：1 环及以上只能「抄写入书」；在常驻法术书中再行准备
 * - 针对非法师（牧师/德鲁伊等）：一键直接「准备 / 取消准备」
 */
import { useMemo, useState } from 'react';
import { SCHOOL_CN, classSpells, type CharData, type Json } from '../../src/sheet';
import { addSpellToBook, getSpellbooks, removeSpellFromBook } from '../../src/sheet/spellbook';
import type { Engine } from '../lib/engine';
import { actions } from '../lib/store';
import { Term } from './Term';
import { Tag } from './ui';

interface Props {
  engine: Engine;
  id: string;
  char: CharData;
  sheet: Json;
  activeBookId?: string;
  onClose?: () => void;
}

export function SpellPicker({ engine, id, char, sheet, activeBookId, onClose }: Props) {
  const sc = sheet.spell || {};
  const casters: Json[] = sc.casters || [];
  const [cls, setCls] = useState<string>(casters[0]?.name ?? '');
  const [q, setQ] = useState('');
  const [filterLevel, setFilterLevel] = useState<number | null>(null); // null = 全部
  const [onlyRitual, setOnlyRitual] = useState(false);
  const [onlyConc, setOnlyConc] = useState(false);

  const caster = casters.find((k) => k.name === cls) ?? casters[0];
  if (!caster) return <div className="empty">该角色没有施法职业。</div>;

  const isWizard = caster.name === '法师';
  // 当前能施展的最高环
  const maxSlot = Math.max(0, ...(sc.slots || []).map((v: number, i: number) => (v ? i + 1 : 0)), sc.pact?.level ?? 0);
  const list: Json[] = useMemo(() => {
    return classSpells(engine.env, caster.name, { maxLevel: Math.max(maxSlot, 0) });
  }, [engine.env, caster.name, maxSlot]);

  // 当前激活的法术书
  const books = getSpellbooks(char);
  const curBook = books.find((b) => b.id === (activeBookId || char.activeSpellbookId)) ?? books[0];
  const inCurBook = (name: string) => (curBook?.spells || []).includes(name);

  // 当前已准备 / 拥有的法术
  const spells: Json[] = char.spells || [];
  const mine = (s: Json) => (s.cls ?? casters[0]?.name) === caster.name;
  const entryOf = (name: string) => spells.find((s) => s.name === name && mine(s));
  const granted = new Set((sc.granted || []).map((g: Json) => g.name));

  // 搜索与过滤
  const query = q.trim().toLowerCase();
  const filtered = useMemo(() => {
    return list.filter((s: Json) => {
      if (filterLevel !== null && s.level !== filterLevel) return false;
      const isRitual = !!s.meta?.ritual;
      if (onlyRitual && !isRitual) return false;
      const isConc = JSON.stringify(s.duration || '').includes('concentration');
      if (onlyConc && !isConc) return false;

      if (!query) return true;
      const cn = String(s.name || '').toLowerCase();
      const en = String(s.ENG_name || '').toLowerCase();
      const school = String(SCHOOL_CN[s.school] || '').toLowerCase();
      return cn.includes(query) || en.includes(query) || school.includes(query);
    });
  }, [list, query, filterLevel, onlyRitual, onlyConc]);

  // 环阶列表
  const allLevels = [...new Set(list.map((s) => s.level as number))].sort((a, b) => a - b);

  // 操作函数
  const handleTogglePrepare = (name: string, level: number) => {
    actions.update(id, (c) => {
      const arr: Json[] = c.spells || [];
      const i = arr.findIndex((s) => s.name === name && (s.cls ?? casters[0]?.name) === caster.name);
      if (i >= 0) arr.splice(i, 1);
      else arr.push({ name, prepared: true, cls: caster.name, ...(level === 0 ? { isCantrip: true } : {}) });
      c.spells = arr;
    });
  };

  const handleToggleBook = (name: string) => {
    actions.update(id, (c) => {
      if (!curBook) return;
      if (inCurBook(name)) {
        removeSpellFromBook(c, curBook.id, name);
      } else {
        addSpellToBook(c, curBook.id, name);
      }
    });
  };

  return (
    <div className="spell-picker-box" style={{ marginTop: 10, padding: '10px 12px', background: 'var(--panel-2)', borderRadius: 'var(--r-lg)', border: '1px solid var(--line)' }}>
      {/* 头部：职业切换与关闭 */}
      <div className="row spread" style={{ marginBottom: 8, alignItems: 'center' }}>
        <div className="row" style={{ gap: 6, alignItems: 'center' }}>
          <b>{isWizard ? `抄录法术入书 (${curBook?.name || '主法术书'})` : '添加/准备法术'}</b>
          {casters.length > 1 && (
            <div className="row" style={{ gap: 4, marginLeft: 8 }}>
              {casters.map((k) => (
                <button
                  key={k.name}
                  type="button"
                  className={'btn sm' + (k.name === caster.name ? ' on' : '')}
                  onClick={() => setCls(k.name)}
                >
                  {k.name} {k.level}级
                </button>
              ))}
            </div>
          )}
        </div>
        {onClose && (
          <button type="button" className="btn ghost sm" onClick={onClose} title="收起法术库">
            收起 ▴
          </button>
        )}
      </div>

      {/* 搜索栏 */}
      <div className="row" style={{ gap: 8, marginBottom: 8 }}>
        <input
          style={{ flex: 1 }}
          placeholder="中英文即时搜索（如：火球术 / Fireball / 护盾 / Shield / 治疗…）"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {q && (
          <button type="button" className="btn sm" onClick={() => setQ('')}>
            清空
          </button>
        )}
      </div>

      {/* 环阶与标签快速筛选 */}
      <div className="row" style={{ gap: 4, flexWrap: 'wrap', marginBottom: 8, alignItems: 'center' }}>
        <span className="tiny faint" style={{ marginRight: 2 }}>环阶：</span>
        <button
          type="button"
          className={'chip' + (filterLevel === null ? ' on' : '')}
          onClick={() => setFilterLevel(null)}
        >
          全部 ({list.length})
        </button>
        {allLevels.map((lv) => {
          const count = list.filter((s) => s.level === lv).length;
          return (
            <button
              key={lv}
              type="button"
              className={'chip' + (filterLevel === lv ? ' on' : '')}
              onClick={() => setFilterLevel(filterLevel === lv ? null : lv)}
            >
              {lv === 0 ? '戏法' : `${lv} 环`} ({count})
            </button>
          );
        })}
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className={'chip' + (onlyConc ? ' on' : '')}
          onClick={() => setOnlyConc(!onlyConc)}
        >
          专注
        </button>
        <button
          type="button"
          className={'chip' + (onlyRitual ? ' on' : '')}
          onClick={() => setOnlyRitual(!onlyRitual)}
        >
          仪式
        </button>
      </div>

      {/* 法术列表 */}
      <div className="spell-picker-list" style={{ maxHeight: 380, overflowY: 'auto', border: '1px solid var(--line)', borderRadius: 'var(--r)', background: 'var(--panel)' }}>
        {filtered.length === 0 ? (
          <div className="empty" style={{ padding: '16px 0' }}>未找到匹配的法术。</div>
        ) : (
          <div className="stack" style={{ gap: 0 }}>
            {filtered.map((s: Json) => {
              const lv = s.level as number;
              const isLocked = granted.has(s.name);
              const isConc = JSON.stringify(s.duration || '').includes('concentration');
              const isRitual = !!s.meta?.ritual;

              // 法师状态判断
              const inBook = inCurBook(s.name);
              // 非法师或戏法判断
              const entry = entryOf(s.name);
              const isPrep = !!entry && entry.prepared !== false;

              return (
                <div
                  key={s.name}
                  className="row spread"
                  style={{
                    padding: '5px 10px',
                    borderBottom: '1px solid var(--line)',
                    alignItems: 'center',
                    background: (isWizard && lv > 0 ? inBook : isPrep) ? 'var(--accent-bg)' : 'transparent',
                  }}
                >
                  <div className="row" style={{ gap: 8, alignItems: 'center', minWidth: 0, flex: 1 }}>
                    <span className="serif" style={{ fontWeight: 600 }}>
                      <Term kind="spell" name={s.name} inButton>{s.name}</Term>
                    </span>
                    {s.ENG_name && <span className="tiny faint font-mono">{s.ENG_name}</span>}
                    <span className="tiny muted">{lv === 0 ? '戏法' : `${lv} 环`} · {SCHOOL_CN[s.school] ?? ''}</span>
                    {isConc && <Tag>专注</Tag>}
                    {isRitual && <Tag>仪式</Tag>}
                    {isLocked && <Tag tone="accent">常备</Tag>}
                  </div>

                  <div className="row" style={{ gap: 6, alignItems: 'center' }}>
                    {isLocked ? (
                      <span className="tiny faint">职业/种族常备</span>
                    ) : isWizard && lv > 0 ? (
                      // 法师 1 环及以上：抄写入法术书
                      <button
                        type="button"
                        className={'btn sm' + (inBook ? ' on' : ' primary')}
                        onClick={() => handleToggleBook(s.name)}
                      >
                        {inBook ? '已在书中 ✓' : '+ 抄写入书'}
                      </button>
                    ) : (
                      // 非法师，或法师戏法：直接准备/学习
                      <button
                        type="button"
                        className={'btn sm' + (isPrep ? ' on' : ' primary')}
                        onClick={() => handleTogglePrepare(s.name, lv)}
                      >
                        {isPrep ? (lv === 0 ? '已学戏法 ✓' : '已准备 ✓') : (lv === 0 ? '+ 学习戏法' : '+ 准备法术')}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="spread small faint" style={{ marginTop: 6 }}>
        <span>共匹配 {filtered.length} 道法术</span>
        {onClose && (
          <button type="button" className="btn ghost sm" onClick={onClose}>
            完成并收起 ▴
          </button>
        )}
      </div>
    </div>
  );
}
