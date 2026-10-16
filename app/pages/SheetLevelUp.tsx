/**
 * 升级：和建卡分开。建卡是「从零填一张卡」，升级是「在已有的卡上加一级」：
 *   ① 选升哪个职业（已有的职业 +1，或者兼一个新职业）
 *   ② 先看这一级会得到什么（新特性、生命值、法术位、要做的选择）——在卡的副本上算一遍，和现在比
 *   ③ 生命值取平均或者填掷出来的数，确认
 *   ④ 接着把这一级要做的决定做完（子职、属性提升 / 专长、新法术…）
 * 「建卡」页还在，用来自由修改（改错了等级、换职业）。
 */
import { useEffect, useState } from 'react';
import { CLASS_SLUG_BY_NAME, type CharData, type Json } from '../../src/sheet';
import { Choices } from '../components/Choices';
import { Entries } from '../components/Entries';
import { SpellBrowser } from '../components/SpellBrowser';
import { NumInput, Panel, Tag } from '../components/ui';
import type { Engine } from '../lib/engine';
import { tagCampaign } from '../lib/hub';
import { actions, getApp, stripDerived } from '../lib/store';

interface Props { engine: Engine; id: string; char: CharData; sheet: Json }

const CORE_CLASSES = Object.keys(CLASS_SLUG_BY_NAME).filter((n) => !['心灵术士', '随从'].includes(n));
const featKey = (f: Json) => `${f._cls ?? f._origin}|${f.name}|${f.level}`;

/** 在副本上把某个职业 +1 级 */
function leveled(char: CharData, cls: string): CharData {
  const c = structuredClone(stripDerived(char));
  const k = (c.classes || []).find((x: Json) => x.name === cls);
  if (k) k.level += 1;
  else c.classes = [...(c.classes || []).filter((x: Json) => x.name), { name: cls, level: 1, subclass: '' }];
  return c;
}

export function SheetLevelUp({ engine, id, char, sheet }: Props) {
  const classes: Json[] = (char.classes || []).filter((k: Json) => k.name);
  const total = classes.reduce((a, k) => a + (k.level || 0), 0);
  const [cls, setCls] = useState<string>(classes[0]?.name ?? '');
  const [preview, setPreview] = useState<Json | null>(null);
  const [roll, setRoll] = useState<number | null>(null);
  const [done, setDone] = useState<{ cls: string; level: number } | null>(null);
  const [browse, setBrowse] = useState(false);

  const isNew = !classes.some((k) => k.name === cls);
  const cur = classes.find((k) => k.name === cls);
  const nextLevel = (cur?.level ?? 0) + 1;
  const hd: number | undefined = (char._resolved?.classes || []).find((k: Json) => k.cls?.name === cls)?.cls?.hd?.faces;

  // ② 预览：副本升一级算一遍
  useEffect(() => {
    if (!cls || total >= 20) { setPreview(null); return; }
    let alive = true;
    const work = leveled(char, cls);
    tagCampaign(work, getApp().cards[id]?.campaignId).then(() => engine.env.compute(work)).then((s: Json) => { if (alive) setPreview({ sheet: s, char: work }); }, () => alive && setPreview(null));
    return () => { alive = false; };
  }, [engine, char, cls, total]);

  const confirm = () => {
    actions.update(id, (c) => {
      const k = (c.classes || []).find((x: Json) => x.name === cls);
      if (k) k.level += 1;
      else c.classes = [...(c.classes || []).filter((x: Json) => x.name), { name: cls, level: 1, subclass: '' }];
      if (!c.startingClass) c.startingClass = cls;
      // 生命值：填了掷骰结果就记下（空着 = 取平均）
      if (roll != null && !(c.startingClass === cls && nextLevel === 1)) {
        const arr = [...(c.hpRolls?.[cls] || [])];
        arr[nextLevel - 1] = roll;
        c.hpRolls = { ...(c.hpRolls || {}), [cls]: arr };
      }
    });
    setDone({ cls, level: nextLevel });
    setRoll(null);
  };

  if (total >= 20 && !done) return <div className="empty">已经 20 级了。</div>;

  const before = new Set((sheet.features || []).map(featKey));
  const gained: Json[] = preview ? (preview.sheet.features || []).filter((f: Json) => !before.has(featKey(f))) : [];
  const pendBefore = new Set((sheet._pending || []).map((c: Json) => c.key));
  const newChoices: Json[] = preview ? (preview.sheet._pending || []).filter((c: Json) => !c.decided && !pendBefore.has(c.key)) : [];
  const diff = (label: string, a: unknown, b: unknown) => (a !== b && b != null ? <div className="spread small"><span className="faint">{label}</span><span>{String(a ?? '—')} → <b>{String(b)}</b></span></div> : null);
  const slotStr = (s: Json) => (s?.spell?.slots || []).map((v: number, i: number) => (v ? `${i + 1}环×${v}` : '')).filter(Boolean).join(' ') || '—';
  const avg = hd ? Math.floor(hd / 2) + 1 : null;

  return (
    <div className="levelup">
      <div className="stack">
        {done && (
          <Panel title={`升好了：${done.cls} ${done.level} 级`} aside={<button className="btn ghost sm" onClick={() => setDone(null)}>再升一级</button>}>
            <div className="small muted">下面「待决定」里是这一级（和以前）还没做的选择。{sheet.spell?.casters?.length ? '新法术在这里选：' : ''}
              {sheet.spell?.casters?.length > 0 && <button className="btn sm" style={{ marginLeft: 6 }} onClick={() => setBrowse(true)}>选法术…</button>}
            </div>
          </Panel>
        )}
        {!done && (
          <Panel title={`升到 ${total + 1} 级`}>
            <div className="stack">
              <div>
                <div className="small faint" style={{ marginBottom: 4 }}>升哪个职业</div>
                <div className="row" style={{ gap: 6 }}>
                  {classes.map((k) => (
                    <button key={k.name} className={'btn' + (cls === k.name ? ' on' : '')} onClick={() => setCls(k.name)}>{k.name} {k.level} → {k.level + 1}</button>
                  ))}
                  <select value={isNew ? cls : ''} onChange={(e) => e.target.value && setCls(e.target.value)}>
                    <option value="">兼一个新职业…</option>
                    {CORE_CLASSES.filter((n) => !classes.some((k) => k.name === n)).map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                </div>
                {isNew && cls && <div className="small muted" style={{ marginTop: 4 }}>兼职要求：原职业和新职业的主属性都至少 13（规则书「兼职」一节）。这里不拦，自己确认。</div>}
              </div>

              {hd && !(isNew && classes.length === 0) && (
                <div className="row small">
                  <span>生命值：d{hd} + 体质调整值。</span>
                  <button className={'btn sm' + (roll == null ? ' on' : '')} onClick={() => setRoll(null)}>取平均（{avg}）</button>
                  <span className="faint">或者填掷出来的数</span>
                  <NumInput min={1} max={hd} value={roll ?? avg ?? 1} onChange={setRoll} style={{ width: 56 }} aria-label="生命骰结果" />
                </div>
              )}

              <div className="row">
                <button className="btn primary" disabled={!cls || !preview} onClick={confirm}>升级：{cls || '—'} {nextLevel} 级</button>
                {!preview && cls && <span className="small faint">正在算这一级会得到什么…</span>}
              </div>
            </div>
          </Panel>
        )}
        {!done && preview && (
          <Panel title="这一级会得到">
            <div className="stack" style={{ gap: 6 }}>
              {diff('生命值上限', sheet.hpMax, preview.sheet.hpMax)}
              {diff('熟练加值', sheet.pb, preview.sheet.pb)}
              {diff('法术位', slotStr(sheet), slotStr(preview.sheet))}
              {diff('可准备法术', sheet.spell?.preparedMax, preview.sheet.spell?.preparedMax)}
              {diff('戏法', sheet.spell?.cantripsKnown, preview.sheet.spell?.cantripsKnown)}
              <div>
                <div className="small faint">新特性</div>
                {gained.length ? gained.map((f) => (
                  <details key={featKey(f)} className="feature">
                    <summary><span className="nm">{f.name}</span>{f._sub && <Tag>子职</Tag>}</summary>
                    <div className="prose small"><Entries entries={f.entries || []} /></div>
                  </details>
                )) : <div className="small muted">这一级没有新特性。</div>}
              </div>
              {newChoices.length > 0 && (
                <div>
                  <div className="small faint">升级后要决定</div>
                  <div className="row" style={{ gap: 4 }}>{newChoices.map((c) => <Tag key={c.key} tone="warn">{c.label || c.id}</Tag>)}</div>
                </div>
              )}
            </div>
          </Panel>
        )}
      </div>
      <div className="stack">
        {(sheet._pending || []).some((c: Json) => !c.decided)
          ? <Choices engine={engine} id={id} char={char} sheet={sheet} title="待决定" />
          : <Panel title="待决定"><div className="small muted">没有要决定的事。</div></Panel>}
      </div>
      {browse && <SpellBrowser engine={engine} id={id} char={char} sheet={sheet} onClose={() => setBrowse(false)} />}
    </div>
  );
}
