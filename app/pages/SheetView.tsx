/** 人物卡「卡面」：跑团时看的那一面 */
import { useState } from 'react';
import { ABILS, ABIL_CN, SCHOOL_CN, classSpells, type CharData, type Json } from '../../src/sheet';
import { Choices, openChoiceItems } from '../components/Choices';
import { Term } from '../components/Term';
import { SpellBrowser } from '../components/SpellBrowser';
import { SpellPicker } from '../components/SpellPicker';
import { Entries } from '../components/Entries';
import { Clip, Panel, Pips, Tag, sgn } from '../components/ui';
import type { Engine } from '../lib/engine';
import { actions, stripDerived } from '../lib/store';
import { termOfResource } from '../lib/terms';
import {
  getSpellbooks,
  createSpellbook,
  renameSpellbook,
  deleteSpellbook,
  removeSpellFromBook,
  togglePrepareFromBook,
} from '../../src/sheet/spellbook';

const ABBR: Record<string, string> = { str: '力', dex: '敏', con: '体', int: '智', wis: '感', cha: '魅' };
const RECOVERY_CN: Record<string, string> = { short: '短休', long: '长休', initiative: '先攻', none: '特殊', '?': '按规则' };

interface Props { engine: Engine; id: string; char: CharData; sheet: Record<string, Json> }

function AbilitiesPanel({ sheet }: Props) {
  return (
    <Panel title="属性" flush>
      <div className="abilities">
        {ABILS.map((a) => (
          <div className="ability" key={a}>
            <div className="k">{ABIL_CN[a]}</div>
            <div className="m">{sgn(sheet['mod:' + a])}</div>
            <div className="s">{sheet['score:' + a]}</div>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function SavesSkills({ sheet }: Props) {
  return (
    <>
      <Panel title="豁免" flush>
        {/* 两列：力敏 / 体智 / 感魅 */}
        <div className="saves2">
          {ABILS.map((a) => {
            const s = sheet.saves?.[a];
            return (
              <div key={a} className={s?.prof ? 'on' : ''}>
                <span className={'dot' + (s?.prof ? ' on' : '')} />
                <span>{ABIL_CN[a]}</span>
                <b className="num serif">{sgn(s?.total)}</b>
              </div>
            );
          })}
        </div>
      </Panel>
      <Panel title="技能" aside={<span>被动察觉 {sheet.passivePerception}</span>} flush>
        <table className="rows">
          <tbody>
            {Object.entries(sheet.skills || {}).map(([k, s]: [string, Json]) => (
              <tr key={k} className={s.prof ? '' : 'dim'}>
                <td style={{ width: 16 }}><span className={'dot' + (s.prof ? ' on' : '') + (s.exp ? ' double' : '')} /></td>
                <td><Term kind="skill" name={s.cn} /> <span className="faint tiny">{ABBR[s.ability]}</span></td>
                <td className="r num serif">{sgn(s.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </>
  );
}

/**
 * 人物卡顶上那一条：左边名字、种族职业、等级和待决定；右边一排关键数值（AC 突出，生命值带加减）。
 * 卡面、升级、建卡、数据四页共用。
 */
export function SheetHero({ id, char, sheet, tags, tools }: Omit<Props, 'engine'> & { tags?: React.ReactNode; tools?: React.ReactNode }) {
  const [amt, setAmt] = useState('');
  const max = sheet.hpMax ?? 0;
  const cur = char.hp?.current ?? max;
  const temp = char.hp?.temp ?? 0;
  const setHp = (current: number, t = temp) => actions.update(id, (c) => {
    c.hp = { ...(c.hp || {}), current: current >= max ? null : Math.max(0, current), temp: Math.max(0, t) };
  });
  const n = Math.max(0, Math.round(Number(amt) || 0));
  const ds = char.deathSaves || { success: 0, failure: 0 };
  const classes = (char.classes || []).filter((k: Json) => k.name).map((k: Json) => `${k.name} ${k.level}${k.subclass ? `（${k.subclass}）` : ''}`).join(' / ');
  return (
    <section className="hero panel">
      <div className="hero-id">
        <h1>{char.name || '未命名'}</h1>
        <div className="sub">
          {[
            char.race ? <Term key="race" kind="race" name={char.race}>{char.race}</Term> : null,
            char.background ? <Term key="bg" kind="background" name={char.background}>{char.background}</Term> : null,
            classes || null,
          ].filter(Boolean).map((node, idx) => <span key={idx}>{idx > 0 && ' · '}{node}</span>)}
          {!char.race && !char.background && !classes && '还没选种族、背景、职业'}
        </div>
        <div className="row hero-tags">{tags}</div>
      </div>
      <div className="hero-vitals">
        <div className="vt vt-ac" title={sheet.acNote}>
          <i>护甲等级</i><b>{sheet.ac}</b>
        </div>
        <div className="vt vt-hp">
          <i title={sheet.hpNotes}>生命值</i>
          <b>{cur}<span>/ {max}</span>{temp > 0 && <u>+{temp} 临时</u>}</b>
          <div className={'hpbar' + (cur <= max / 4 ? ' low' : '')}><i style={{ width: `${Math.min(100, (cur / Math.max(1, max)) * 100)}%` }} /></div>
          {cur === 0
            ? (
              <div className="row tiny">
                <span>死亡豁免 成功</span>
                <Pips max={3} used={ds.success} onChange={(v) => actions.update(id, (c) => { c.deathSaves = { ...ds, success: v }; })} />
                <span>失败</span>
                <Pips max={3} used={ds.failure} onChange={(v) => actions.update(id, (c) => { c.deathSaves = { ...ds, failure: v }; })} />
              </div>
            )
            : (
              <div className="hp-ctl">
                <input type="number" min={0} value={amt} placeholder="数值" onChange={(e) => setAmt(e.target.value)} aria-label="数值" />
                <button className="btn sm" disabled={!n} onClick={() => {
                  const absorbed = Math.min(temp, n);
                  setHp(cur - (n - absorbed), temp - absorbed);
                  setAmt('');
                }}>伤害</button>
                <button className="btn sm" disabled={!n} onClick={() => { setHp(Math.min(max, cur + n)); setAmt(''); }}>治疗</button>
                <button className="btn sm" disabled={!n} onClick={() => { setHp(cur, Math.max(temp, n)); setAmt(''); }}>临时</button>
              </div>
            )}
        </div>
        <div className="vt"><i>速度</i><b>{sheet.speed}<small>尺</small></b></div>
        <div className="vt"><i>先攻</i><b>{sgn(sheet.initiative)}</b></div>
        <div className="vt"><i>熟练加值</i><b>{sgn(sheet.pb)}</b></div>
        <div className="vt"><i>被动察觉</i><b>{sheet.passivePerception}</b></div>
      </div>
      {tools && <div className="hero-tools">{tools}</div>}
    </section>
  );
}

function Attacks({ sheet }: Props) {
  const rows: Json[] = sheet.attacks || [];
  return (
    <Panel title="攻击" flush>
      {rows.length ? (
        <table className="rows">
          <thead><tr><th>武器</th><th className="r">命中</th><th>伤害</th><th>精通</th><th>属性</th></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td className="serif"><Term kind="item" name={r.name}>{r.name}</Term>{!r.prof && <span className="warnline tiny"> 未熟练</span>}</td>
                <td className="r num serif">{sgn(r.atk)}</td>
                <td className="num">{r.dmgText}{r.dmg2 && <span className="faint tiny"> / 双手 {r.dmg2}</span>}</td>
                <td>{(sheet.masteries || []).includes(r.name) && r.mastery?.[0] ? <Tag tone="accent"><Term kind="itemMastery" name={r.mastery[0]}>{r.mastery[0]}</Term></Tag> : <span className="faint">—</span>}</td>
                <td className="small muted">{ABIL_CN[r.abil as keyof typeof ABIL_CN]}{r.range ? ` · ${r.range} 尺` : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <div className="empty">没有装备武器。去「物品」页加。</div>}
    </Panel>
  );
}

function Spells({ engine, id, char, sheet }: Props) {
  const sc = sheet.spell || {};
  const [expanded, setExpanded] = useState(false);

  // 法术书相关状态
  const books = getSpellbooks(char);
  const [activeBookId, setActiveBookId] = useState<string>(char.activeSpellbookId || books[0]?.id || 'main');
  const [showNewBook, setShowNewBook] = useState(false);
  const [newBookName, setNewBookName] = useState('');
  const [cloneFromId, setCloneFromId] = useState<string>('blank');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');

  if (!sc.casters?.length && !(char.spells || []).length && !sc.granted?.length) return null;

  const all: Json[] = engine.env.store.spellsAll;
  const ent = (n: string) => all.find((s) => s.name === n);

  // 判断是否拥有法师职业
  const isWizard =
    (char.classes || []).some((c: any) => c.name === '法师' || c.name === 'Wizard') ||
    (sc.casters || []).some((c: any) => (typeof c === 'string' ? c : c.name) === '法师' || (typeof c === 'string' ? c : c.name) === 'Wizard');

  // 当前激活的法术书
  const curBook = books.find((b) => b.id === activeBookId) ?? books[0] ?? { id: 'main', name: '主法术书', spells: [] };

  // 按环阶排（戏法在前），同环按名字
  const order = (char.spells || []).map((s: Json, i: number) => ({ s, i, lv: ent(s.name)?.level ?? 1 }))
    .sort((a: Json, b: Json) => a.lv - b.lv || String(a.s.name).localeCompare(String(b.s.name), 'zh'));
  const slotsUsed = (lvl: number) => char.slots?.[lvl]?.used ?? 0;
  const setSlot = (lvl: number, used: number) => actions.update(id, (c) => { c.slots = { ...(c.slots || {}), [lvl]: { used } }; });
  const prepared = (char.spells || []).filter((s: Json) => s.prepared !== false && (ent(s.name)?.level ?? 1) > 0).length;

  // 当前法术书收录的法术（按环阶、名字排序）
  const bookSpellsOrder = [...curBook.spells]
    .map((name) => ({ name, e: ent(name), lv: ent(name)?.level ?? 1 }))
    .sort((a, b) => a.lv - b.lv || String(a.name).localeCompare(String(b.name), 'zh'));

  // 创建新法术书
  const handleCreateBook = () => {
    if (!newBookName.trim()) return;
    actions.update(id, (c) => {
      const created = createSpellbook(c, newBookName.trim(), cloneFromId === 'blank' ? undefined : cloneFromId);
      setActiveBookId(created.id);
    });
    setNewBookName('');
    setShowNewBook(false);
  };

  // 重命名法术书
  const handleRenameBook = (bId: string) => {
    if (!renameText.trim()) return;
    actions.update(id, (c) => {
      renameSpellbook(c, bId, renameText.trim());
    });
    setRenamingId(null);
  };

  // 删除法术书
  const handleDeleteBook = (bId: string) => {
    if (books.length <= 1) return;
    if (!window.confirm(`确定要删除法术书「${curBook.name}」吗？`)) return;
    actions.update(id, (c) => {
      deleteSpellbook(c, bId);
      const remaining = getSpellbooks(c);
      setActiveBookId(remaining[0]?.id || 'main');
    });
  };

  return (
    <Panel
      title="法术"
      aside={<>
        {sc.dc != null && <span>豁免 DC <b className="serif">{sc.dc}</b> · 攻击 <b className="serif">{sgn(sc.atk)}</b> · {ABIL_CN[sc.ability as keyof typeof ABIL_CN]}</span>}
      </>}
    >
      {/* 法术位方格 */}
      {((sc.slots || []).some((v: number) => v) || sc.pact) && (
        <div className="slots">
          {(sc.slots || []).map((v: number, i: number) => v ? (
            <div key={i} className="slot">
              <span className="lv">{i + 1} 环</span>
              <Pips max={v} used={slotsUsed(i + 1)} onChange={(u) => setSlot(i + 1, u)} />
              <span className="left">剩 {Math.max(0, v - slotsUsed(i + 1))}</span>
            </div>
          ) : null)}
          {sc.pact && (
            <div className="slot">
              <span className="lv">契约 {sc.pact.level} 环</span>
              <Pips max={sc.pact.count} used={slotsUsed(sc.pact.level)} onChange={(u) => setSlot(sc.pact.level, u)} />
              <span className="left">剩 {Math.max(0, sc.pact.count - slotsUsed(sc.pact.level))}</span>
            </div>
          )}
        </div>
      )}

      {/* 准备上限与戏法上限提示 */}
      {sc.casters?.length > 0 && (
        <div className="small muted" style={{ marginBottom: 6 }}>
          已准备 {prepared}{sc.preparedMax ? ` / ${sc.preparedMax}` : ''} · 戏法上限 {sc.cantripsKnown}
          {prepared > sc.preparedMax && sc.preparedMax > 0 && <span className="warnline"> · 超出 {prepared - sc.preparedMax} 道（只提醒）</span>}
        </div>
      )}

      {/* 常驻列表 1：已准备法术与戏法 */}
      <div style={{ marginBottom: isWizard ? 14 : 6 }}>
        <table className="rows">
          <tbody>
            {order.map(({ s, i }: Json) => {
              const e = ent(s.name);
              const isCantrip = (e?.level ?? 1) === 0;
              const isRitual = !!e?.meta?.ritual;
              const isConc = JSON.stringify(e?.duration || '').includes('concentration');
              return (
                <tr key={s.name + i} className={s.prepared === false ? 'dim' : ''}>
                  <td className="serif">
                    <Term kind="spell" name={s.name} />
                    {isConc && <span style={{ marginLeft: 4 }}><Tag>专注</Tag></span>}
                    {isRitual && <span style={{ marginLeft: 4 }}><Tag>仪式</Tag></span>}
                  </td>
                  <td className="small muted">
                    {e ? (isCantrip ? '戏法' : `${e.level} 环`) + ' · ' + (SCHOOL_CN[e.school] ?? '') : ''}
                    {sc.casters?.length > 1 && s.cls ? ` · ${s.cls}` : ''}
                  </td>
                  <td className="r">
                    <button
                      className="btn ghost sm"
                      aria-label={`移除${s.name}`}
                      onClick={() => actions.update(id, (c) => {
                        if (isWizard && !isCantrip) {
                          togglePrepareFromBook(c, s.name);
                        } else {
                          c.spells.splice(i, 1);
                        }
                      })}
                    >
                      移除
                    </button>
                  </td>
                </tr>
              );
            })}
            {(sc.granted || []).map((g: Json) => (
              <tr key={'g' + g.name}><td className="serif"><Term kind="spell" name={g.name} /></td><td className="small muted">额外法术 · {g.from}</td><td className="r tiny faint">常备</td></tr>
            ))}
            {order.length === 0 && !(sc.granted || []).length && (
              <tr><td colSpan={3} className="empty" style={{ padding: '8px 0' }}>{isWizard ? '尚未准备任何法术。可从下方「法术书」中点击「准备」。' : '尚未添加任何法术。点击下方展开添加。'}</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* 法师专属：常驻「法术书」列表 */}
      {isWizard && (
        <div style={{ marginTop: 12, padding: '10px 10px 8px', background: 'var(--panel-2)', borderRadius: 'var(--r)', border: '1px solid var(--line)' }}>
          {/* 法术书切换与管理条 */}
          <div className="row spread" style={{ alignItems: 'center', marginBottom: 8, flexWrap: 'wrap', gap: 6 }}>
            <div className="row" style={{ alignItems: 'center', gap: 6 }}>
              <span className="serif" style={{ fontWeight: 600 }}>法术书：</span>
              <select
                value={curBook.id}
                onChange={(e) => {
                  const targetId = e.target.value;
                  setActiveBookId(targetId);
                  actions.update(id, (c) => { c.activeSpellbookId = targetId; });
                }}
                style={{ padding: '2px 6px', fontSize: 13 }}
              >
                {books.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name} ({b.spells.length} 道)
                  </option>
                ))}
              </select>

              <button
                type="button"
                className="btn ghost sm"
                onClick={() => {
                  setRenamingId(curBook.id);
                  setRenameText(curBook.name);
                }}
                title="重命名当前法术书"
              >
                改名
              </button>

              <button
                type="button"
                className="btn sm"
                onClick={() => {
                  setShowNewBook(!showNewBook);
                  setNewBookName('');
                  setCloneFromId('blank');
                }}
                title="新建一本法术书（如备用法术书、旅行手抄本等）"
              >
                + 新建法术书
              </button>

              {books.length > 1 && (
                <button
                  type="button"
                  className="btn ghost sm"
                  style={{ color: 'var(--warn)' }}
                  onClick={() => handleDeleteBook(curBook.id)}
                  title="删除当前法术书"
                >
                  删除
                </button>
              )}
            </div>

            <div className="tiny faint">
              共收录 {curBook.spells.length} 道法术
            </div>
          </div>

          {/* 重命名输入表单 */}
          {renamingId && (
            <div className="row" style={{ gap: 6, marginBottom: 8, padding: '6px 8px', background: 'var(--panel)', borderRadius: 'var(--r)', border: '1px solid var(--line)' }}>
              <span className="small muted">书名：</span>
              <input
                style={{ flex: 1, padding: '2px 6px' }}
                value={renameText}
                autoFocus
                onChange={(e) => setRenameText(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleRenameBook(renamingId)}
              />
              <button type="button" className="btn sm primary" onClick={() => handleRenameBook(renamingId)}>保存</button>
              <button type="button" className="btn ghost sm" onClick={() => setRenamingId(null)}>取消</button>
            </div>
          )}

          {/* 新建法术书表单 */}
          {showNewBook && (
            <div style={{ marginBottom: 8, padding: '8px 10px', background: 'var(--panel)', borderRadius: 'var(--r)', border: '1px solid var(--line)' }}>
              <div className="small bold" style={{ marginBottom: 6 }}>新建法术书</div>
              <div className="row" style={{ gap: 8, marginBottom: 6, alignItems: 'center' }}>
                <span className="small muted">法术书名称：</span>
                <input
                  style={{ flex: 1, padding: '3px 8px' }}
                  placeholder="如：备用手抄本、旅行法术书、古代魔典…"
                  value={newBookName}
                  autoFocus
                  onChange={(e) => setNewBookName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleCreateBook()}
                />
              </div>
              <div className="row spread" style={{ alignItems: 'center' }}>
                <div className="row" style={{ gap: 6, alignItems: 'center' }}>
                  <span className="small muted">法术来源：</span>
                  <select
                    value={cloneFromId}
                    onChange={(e) => setCloneFromId(e.target.value)}
                    style={{ padding: '2px 6px', fontSize: 12 }}
                  >
                    <option value="blank">空白法术书（0 道）</option>
                    {books.map((b) => (
                      <option key={b.id} value={b.id}>
                        完整备份自「{b.name}」({b.spells.length} 道)
                      </option>
                    ))}
                  </select>
                </div>
                <div className="row" style={{ gap: 6 }}>
                  <button type="button" className="btn sm primary" disabled={!newBookName.trim()} onClick={handleCreateBook}>创建</button>
                  <button type="button" className="btn ghost sm" onClick={() => setShowNewBook(false)}>取消</button>
                </div>
              </div>
            </div>
          )}

          {/* 法术书中记载的法术表格 */}
          {bookSpellsOrder.length === 0 ? (
            <div className="empty" style={{ padding: '12px 0' }}>
              此法术书尚未抄录任何法术。展开下方「抄录新法术入书」开始添加。
            </div>
          ) : (
            <table className="rows">
              <tbody>
                {bookSpellsOrder.map(({ name, e, lv }) => {
                  const isPrep = (char.spells || []).some((s: Json) => s.name === name && s.prepared !== false);
                  const isRitual = !!e?.meta?.ritual;
                  const isConc = JSON.stringify(e?.duration || '').includes('concentration');
                  return (
                    <tr key={name} className={isPrep ? '' : 'dim'}>
                      <td className="serif">
                        <Term kind="spell" name={name} />
                        {isConc && <span style={{ marginLeft: 4 }}><Tag>专注</Tag></span>}
                        {isRitual && <span style={{ marginLeft: 4 }}><Tag tone="accent">仪式可用</Tag></span>}
                      </td>
                      <td className="small muted">
                        {lv ? `${lv} 环` : '戏法'} · {e ? (SCHOOL_CN[e.school] ?? '') : ''}
                      </td>
                      <td className="r">
                        <button
                          type="button"
                          className={'btn sm' + (isPrep ? ' on' : '')}
                          onClick={() => actions.update(id, (c) => togglePrepareFromBook(c, name))}
                        >
                          {isPrep ? '已准备' : '准备'}
                        </button>
                        <button
                          type="button"
                          className="btn ghost sm"
                          aria-label={`从法术书中擦除${name}`}
                          onClick={() => actions.update(id, (c) => removeSpellFromBook(c, curBook.id, name))}
                        >
                          擦除
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* 底部可展开的挑选/添加区域 */}
      {expanded ? (
        <SpellPicker
          engine={engine}
          id={id}
          char={char}
          sheet={sheet}
          activeBookId={curBook?.id}
          onClose={() => setExpanded(false)}
        />
      ) : (
        <button
          type="button"
          className="btn ghost"
          style={{
            width: '100%',
            marginTop: 10,
            padding: '8px 12px',
            border: '1px dashed var(--line)',
            borderRadius: 'var(--r)',
            textAlign: 'center',
          }}
          onClick={() => setExpanded(true)}
        >
          {isWizard ? `+ 抄录新法术入「${curBook.name}」… ▾` : '+ 添加/准备法术… ▾'}
        </button>
      )}
    </Panel>
  );
}

function Resources({ engine, id, char, sheet }: Props) {
  const pools: Json[] = (sheet._resources || []).filter((r: Json) => r.max != null);
  const rest = (kind: 'short' | 'long') => {
    const work = structuredClone(char);
    work._resolved = char._resolved;
    work._derived = char._derived;
    engine.env.rest.do(kind, work, sheet);
    actions.replace(id, stripDerived(work));
  };
  return (
    <Panel title="资源" aside={<><button className="btn sm" onClick={() => rest('short')}>短休</button><button className="btn sm" onClick={() => rest('long')}>长休</button></>} flush>
      {pools.length ? (
        <table className="rows">
          <tbody>
            {pools.map((r) => {
              const tr = termOfResource(r);
              return (
                <tr key={r.key}>
                  <td className="serif">{tr ? <Term {...tr} inButton><Clip text={String(r.name)} /></Term> : <Clip text={String(r.name)} />}</td>
                  <td><Pips max={r.max} used={r.used || 0} onChange={(u) => actions.update(id, (c) => { c.resources = { ...(c.resources || {}), [r.key]: { ...(c.resources?.[r.key] || {}), used: u } }; })} /></td>
                  <td className="r small faint">{RECOVERY_CN[r.recovery] ?? r.recovery}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : <div className="empty">没有资源池。</div>}
      <div className="body small muted" style={{ borderTop: '1px solid var(--line)' }}>
        生命骰：{(sheet.hitDice || []).map((h: Json) => `${h.level}d${h.faces}`).join(' + ') || '—'}
        {Object.keys(char.hitDiceSpent || {}).length > 0 && `（已花 ${Object.entries(char.hitDiceSpent).map(([f, n]) => `${n}d${f}`).join('、')}）`}
      </div>
    </Panel>
  );
}

/**
 * 特性：按来源分组（种族 / 每个职业 / 每个子职），组里按等级排；组和条目都能折叠。
 * 像 5etools 的职业页一样，子职是职业下面的一个大条目，它的特性是小条目。
 */
function Features({ sheet, char }: Props) {
  const list: Json[] = sheet.features || [];
  const groups: Array<{ key: string; title: string; sub?: boolean; items: Json[] }> = [];
  const groupOf = (key: string, title: string, sub?: boolean) => {
    let g = groups.find((x) => x.key === key);
    if (!g) groups.push(g = { key, title, sub, items: [] });
    return g;
  };
  for (const f of list) {
    if (f._origin === 'race') { groupOf('race', `种族 · ${char.race || '种族特质'}`).items.push(f); continue; }
    const cls = (char.classes || []).find((k: Json) => k.name === f._cls);
    if (f._sub) groupOf(`sub:${f._cls}`, `${cls?.subclass || '子职'}`, true).items.push(f);
    else groupOf(`cls:${f._cls}`, `${f._cls}${cls?.level ? ` ${cls.level} 级` : ''}`).items.push(f);
  }
  for (const h of (char.homerules || []) as Json[]) {
    if (h.covers || h.pickable) continue;
    groupOf('hr', '导入与家规').items.push({ name: h.name, entries: h.entries?.length ? h.entries : h.text ? [h.text] : [], _origin: 'hr' });
  }
  // 子职紧跟在它的职业后面
  const ordered = groups.filter((g) => !g.sub).flatMap((g) => [g, ...groups.filter((x) => x.sub && x.key === 'sub:' + g.key.slice(4))]);
  for (const g of groups) if (!ordered.includes(g)) ordered.push(g);
  return (
    <Panel title="特性" aside={<span>{list.length} 条</span>} flush>
      {ordered.map((g) => (
        <details className={'fgroup' + (g.sub ? ' sub' : '')} key={g.key} open>
          <summary><span className="nm">{g.sub ? '子职 · ' : ''}{g.title}</span><span className="tiny faint">{g.items.length} 条</span></summary>
          {[...g.items].sort((a, b) => (a.level ?? 0) - (b.level ?? 0)).map((f, i) => (
            <details className="feature" key={i}>
              <summary>
                <span className="nm">{f._origin === 'hr' ? f.name : f._origin === 'race' ? <Term kind="raceFeature" name={f.name} inButton>{f.name}</Term> : <Term kind={f._sub ? 'subclassFeature' : 'classFeature'} name={f.name} cls={f._cls} level={f.level} inButton>{f.name}</Term>}</span>
                {f.level ? <span className="tiny faint">{f.level} 级</span> : null}
              </summary>
              <div className="prose"><Entries entries={f.entries || []} /></div>
            </details>
          ))}
        </details>
      ))}
    </Panel>
  );
}

function Profs({ sheet }: Props) {
  const line = (k: string, v: string[]) => (
    <div className="spread small" style={{ padding: '3px 0' }}>
      <span className="faint">{k}</span>
      <span style={{ textAlign: 'right' }}>{v.length ? v.join('、') : '—'}</span>
    </div>
  );
  const senses = [
    sheet.darkvision ? `黑暗视觉 ${sheet.darkvision} 尺` : '',
    ...Object.entries(sheet.senses || {}).map(([k, v]) => `${({ blindsight: '盲视', tremorsense: '震颤感知', truesight: '真实视觉' } as Record<string, string>)[k] ?? k} ${v} 尺`),
  ].filter(Boolean);
  return (
    <Panel title="熟练与感官">
      {line('护甲', sheet.armorProfs || [])}
      {line('武器', sheet.weaponProfs || [])}
      {line('工具', sheet.tools || [])}
      {line('语言', sheet.languages || [])}
      {line('抗性', sheet.resist || [])}
      {line('感官', senses)}
    </Panel>
  );
}

export function SheetView(p: Props) {
  const { sheet } = p;
  const warnings: string[] = sheet._warnings || [];
  return (
    <div className="sheet-grid">
      <div className="stack">
        <AbilitiesPanel {...p} />
        <SavesSkills {...p} />
        <Profs {...p} />
      </div>
      <div className="stack">
        <Attacks {...p} />
        <Spells {...p} />
        <Features {...p} />
      </div>
      <div className="stack">
        {openChoiceItems(p.engine.env, p.char, sheet).length > 0 && <Choices {...p} />}
        {warnings.length > 0 && (
          <Panel title="提示">{warnings.map((w, i) => <div key={i} className="warnline">{w}</div>)}</Panel>
        )}
        <Resources {...p} />
      </div>
    </div>
  );
}
