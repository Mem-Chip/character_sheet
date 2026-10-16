/** 战斗页的对话框：等待中的决定、加角色、加怪物、遭遇设置 */
import { useEffect, useState } from 'react';
import type { Decision, Session, Settings, ViewInit } from '../../../src/combat';
import { Dialog, Field, NumInput } from '../../components/ui';
import { combat, useCombat, type CombatUi, type DiceMode } from '../../lib/combat';
import type { Engine } from '../../lib/engine';
import { DiceSettings } from './DiceSettings';
import { BestiaryPicker, TextMonster } from './Bestiary';
import { useApp } from '../../lib/store';
import { previewLines } from './Log';
import { CREATURE_TYPES, DAMAGE_TYPES, type Namer } from './shared';

/* ------------------------------ 决定 ------------------------------ */

const KIND_CN: Record<string, string> = { optionalTrigger: '可以做出反应', ask: '需要确认', choose: '请选择', physicalDice: '掷骰', slotLevel: '选择法术位', targets: '选择目标', number: '选择数值' };

/** onClose：DM 代玩家回答时可以关掉，回去等玩家自己答 */
export function DecisionDialog({ s, name, onClose, docked }: { s: Session; name: Namer; onClose?: () => void; docked?: boolean }) {
  const p = s.pending!;
  const d = p.decision;
  const preview = previewLines(p.preview, name);
  const who = s.state.combatants[d.to]?.name ?? (d.to === 'dm' ? 'DM' : name(d.to));
  // 掷骰：小窗口，一行写清楚在掷什么，下面是按钮（实体骰模式直接带着填骰面的框）
  if (d.kind === 'physicalDice') return <DiceAsk d={d} who={who} proxy={!!onClose} onClose={onClose} />;
  return (
    <Dialog title={<>{KIND_CN[d.kind] ?? '需要决定'} <span className="faint small">· 交给 {who}{onClose ? '（DM 代答）' : ''}</span></>} onClose={onClose} docked={docked}>
      {preview.length > 0 && (
        <div className="preview">
          {preview.map((l) => (
            <div key={l.seq} className={'ev' + (l.tone ? ' t-' + l.tone : '')}>
              <div className="evline"><span className="txt">{l.text}</span></div>
              {l.receipt && <div className="receipt">{l.receipt}</div>}
            </div>
          ))}
        </div>
      )}
      <div className="serif">{d.prompt}</div>
      {d.kind === 'optionalTrigger' || d.kind === 'choose' || d.kind === 'slotLevel' ? <PickOptions d={d} />
        : d.kind === 'number' ? <NumberPick d={d} />
        : d.kind === 'ask' ? <AskQuestions d={d} />
            : <div className="dangerline">界面还不支持这种决定（{d.kind}）。可以放弃这次操作。</div>}
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn ghost sm danger" onClick={() => combat.cancelPending()} title="当作这笔操作没有发生过">放弃这次操作</button>
      </div>
    </Dialog>
  );
}

function PickOptions({ d }: { d: Decision }) {
  const [sel, setSel] = useState<string[]>(Array.isArray(d.default) ? (d.default as string[]) : typeof d.default === 'string' ? [d.default] : []);
  const multi = d.kind === 'optionalTrigger' || !!d.multi;
  const toggle = (id: string) => setSel(multi ? (sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]) : [id]);
  return (
    <>
      <div className="stack" style={{ gap: 6 }}>
        {d.options.map((o) => (
          <div key={o.id} className={'opt' + (sel.includes(o.id) ? ' on' : '')} onClick={() => toggle(o.id)} role="checkbox" aria-checked={sel.includes(o.id)}>
            <input type={multi ? 'checkbox' : 'radio'} readOnly checked={sel.includes(o.id)} tabIndex={-1} />
            <div>
              <div>{o.label}</div>
              {o.detail && <div className="d">{o.detail}</div>}
            </div>
          </div>
        ))}
      </div>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        {d.kind === 'optionalTrigger' && <button className="btn" onClick={() => combat.decide([])}>都不用</button>}
        <button className="btn primary" disabled={d.kind !== 'optionalTrigger' && !sel.length} onClick={() => combat.decide(sel)}>
          {d.kind === 'optionalTrigger' ? (sel.length ? `使用选中的 ${sel.length} 项` : '不用，继续') : '确定'}
        </button>
      </div>
    </>
  );
}

function NumberPick({ d }: { d: Decision }) {
  const min = d.min ?? 0;
  const max = d.max ?? min;
  const [v, setV] = useState(String(d.default ?? max));
  const n = Number(v);
  const ok = v !== '' && Number.isInteger(n) && n >= min && n <= max;
  return (
    <>
      <div className="row">
        <input
          type="number" min={min} max={max} value={v} autoFocus aria-label="数值"
          onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && ok) combat.decide(n); }}
        />
        <input type="range" min={min} max={max} value={ok ? n : min} onChange={(e) => setV(e.target.value)} aria-label="拖动选择" style={{ flex: 1 }} />
        <span className="tiny faint num">{min}–{max}</span>
      </div>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn primary" disabled={!ok} onClick={() => combat.decide(n)}>确定</button>
      </div>
    </>
  );
}

function AskQuestions({ d }: { d: Decision }) {
  const [ans, setAns] = useState<Record<string, boolean>>((d.default as Record<string, boolean>) ?? {});
  return (
    <>
      <div className="stack" style={{ gap: 6 }}>
        {(d.questions ?? []).map((q) => (
          <div key={q.id} className="spread opt" style={{ cursor: 'default' }}>
            <div>
              <div>{q.text}</div>
              {q.guess !== undefined && <div className="d">推测：{q.guess ? '是' : '否'}{q.scope !== 'once' ? `（回答会记住：${q.scope === 'turn' ? '本回合' : q.scope === 'round' ? '本轮' : '一直'}）` : ''}</div>}
            </div>
            <div className="row" style={{ flexWrap: 'nowrap' }}>
              <button className={'btn sm' + (ans[q.id] ? ' on' : '')} onClick={() => setAns({ ...ans, [q.id]: true })}>是</button>
              <button className={'btn sm' + (ans[q.id] === false ? ' on' : '')} onClick={() => setAns({ ...ans, [q.id]: false })}>否</button>
            </div>
          </div>
        ))}
      </div>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn primary" onClick={() => combat.decide(ans)}>确定</button>
      </div>
    </>
  );
}

function DiceAsk({ d, who, proxy, onClose }: { d: Decision; who: string; proxy: boolean; onClose?: () => void }) {
  const reqs = d.dice ?? [];
  const [manual, setManual] = useState(!d.confirm);
  const [faces, setFaces] = useState<string[][]>(reqs.map((r) => Array.from({ length: r.count }, () => '')));
  const ui = useCombat();
  const dmHere = !!ui.remote && ui.remote.role === 'dm';
  // DM 可以选这一次暗骰（玩家那边的 3D 骰子不显示点数）；默认：替怪物掷的暗骰，替玩家掷的明骰
  const [dark, setDark] = useState(() => dmHere && !ui.remote!.owners[d.to] && !ui.remote!.diceOpen);
  const valid = reqs.every((r, i) => faces[i].every((f) => f !== '' && Number.isInteger(Number(f)) && Number(f) >= 1 && Number(f) <= r.faces));
  // 「请输入骰子结果：」这类前缀去掉，只留在掷什么
  const what = d.prompt.replace(/^请输入骰子结果：/, '');
  const submit = () => { if (valid) combat.decide(faces.map((row) => row.map(Number))); };
  return (
    <div className="panel dice-ask">
      <div className="q">{what}{proxy && <span className="tiny faint">（DM 代 {who} 掷）</span>}</div>
      {manual && (
        <div className="dice-fields">
          {reqs.map((r, i) => faces[i].map((f, j) => (
            <input
              key={`${i}-${j}`} type="number" min={1} max={r.faces} value={f} placeholder={`d${r.faces}`}
              autoFocus={i === 0 && j === 0} aria-label={`第 ${j + 1} 颗 d${r.faces}`}
              onChange={(e) => setFaces(faces.map((row, a) => (a === i ? row.map((x, b) => (b === j ? e.target.value : x)) : row)))}
              onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
            />
          )))}
        </div>
      )}
      <div className="row">
        {manual
          ? <button className="btn primary" disabled={!valid} onClick={submit}>确定</button>
          : <button className="btn primary" autoFocus onClick={() => combat.decide(dark ? 'roll-dark' : 'roll')}>掷</button>}
        {manual
          ? <button className="btn" onClick={() => combat.decide(dark ? 'roll-dark' : 'roll')}>让网页掷</button>
          : <button className="btn" onClick={() => setManual(true)}>手动输入</button>}
        {dmHere && <label className="tiny" title="玩家那边的 3D 骰子不显示点数"><input type="checkbox" checked={dark} onChange={(e) => setDark(e.target.checked)} /> 暗骰</label>}
        <span style={{ flex: 1 }} />
        <button className="btn ghost danger" onClick={() => (onClose ? onClose() : combat.cancelPending())} title={onClose ? '不代答了' : '当作这笔操作没有发生过'}>取消</button>
      </div>
    </div>
  );
}

/* ------------------------------ 加角色 ------------------------------ */

export function AddPcDialog({ engine, ui, onClose }: { engine: Engine; ui: CombatUi; onClose: () => void }) {
  const app = useApp();
  const linked = new Set(Object.entries(ui.links).filter(([cid]) => ui.session?.state.combatants[cid]).map(([, card]) => card));
  const cards = app.order.map((id) => app.cards[id]).filter(Boolean);
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <Dialog title="从卡片库加角色" onClose={onClose}>
      {!cards.length && <div className="empty">卡片库是空的。</div>}
      <div className="stack" style={{ gap: 6 }}>
        {cards.map((c) => {
          const cls = (c.char.classes || []).filter((k: { name?: string }) => k.name).map((k: { name: string; level: number }) => `${k.name} ${k.level}`).join(' / ');
          const here = linked.has(c.id);
          return (
            <button key={c.id} type="button" className={'opt' + (here ? ' on' : '')} disabled={here} onClick={async () => {
              if (here || busy) return;
              setBusy(c.id);
              try { await combat.addPc(engine, c.id); } finally { setBusy(null); }
            }}>
              <span style={{ flex: 1, display: 'grid' }}>
                <span className="serif">{c.char.name || '未命名'}</span>
                <span className="d">{[c.char.race, cls].filter(Boolean).join(' · ') || '—'}</span>
              </span>
              <span className="tiny faint">{here ? '已在遭遇中' : busy === c.id ? '正在计算…' : '加入'}</span>
            </button>
          );
        })}
      </div>
    </Dialog>
  );
}

/* ------------------------------ 加怪物 ------------------------------ */

interface MonsterForm {
  name: string; count: number; side: string; type: string;
  ac: number; hp: number; init: number; speed: number;
  atkName: string; atkBonus: number; atkDamage: string; atkType: string; perAction: number; ranged: boolean;
}

/** 速成模板（不是官方数据卡：怪物数据卡解析还没做，先用这些手调） */
const PRESETS: Array<[string, Partial<MonsterForm>]> = [
  ['杂兵', { name: '杂兵', ac: 13, hp: 7, init: 2, atkName: '短剑', atkBonus: 4, atkDamage: '1d6 + 2', atkType: '穿刺', perAction: 1 }],
  ['精兵', { name: '精兵', ac: 15, hp: 22, init: 1, atkName: '长剑', atkBonus: 5, atkDamage: '1d8 + 3', atkType: '挥砍', perAction: 1 }],
  ['弓手', { name: '弓手', ac: 13, hp: 11, init: 3, atkName: '长弓', atkBonus: 5, atkDamage: '1d8 + 3', atkType: '穿刺', perAction: 1, ranged: true }],
  ['头目', { name: '头目', ac: 16, hp: 60, init: 2, atkName: '巨剑', atkBonus: 6, atkDamage: '2d6 + 4', atkType: '挥砍', perAction: 2 }],
  ['训练假人', { name: '训练假人', ac: 10, hp: 100, init: 0, atkName: '', perAction: 1, type: '构装生物' }],
];

export function AddMonsterDialog({ onClose, canHide, loadMonsters }: { onClose: () => void; canHide?: boolean; loadMonsters?: () => Promise<unknown[]> }) {
  const [hidden, setHidden] = useState(false);
  const [tab, setTab] = useState<'book' | 'text' | 'custom'>(loadMonsters ? 'book' : 'custom');
  // 图鉴按需加载（1 MB 多）
  const [monsters, setMonsters] = useState<unknown[] | null>(null);
  useEffect(() => { void loadMonsters?.().then(setMonsters, () => setMonsters([])); }, []);
  const [f, setF] = useState<MonsterForm>({
    name: '杂兵', count: 1, side: 'enemy', type: '类人生物', ac: 13, hp: 7, init: 2, speed: 30,
    atkName: '短剑', atkBonus: 4, atkDamage: '1d6 + 2', atkType: '穿刺', perAction: 1, ranged: false,
  });
  const set = (p: Partial<MonsterForm>) => setF({ ...f, ...p });
  const add = () => {
    const view: ViewInit = {
      name: f.name.trim() || '怪物', type: f.type, ac: f.ac, hpMax: Math.max(1, f.hp), speed: f.speed,
      score: { dex: 10 + 2 * f.init }, initiative: f.init, attacksPerAction: Math.max(1, f.perAction),
      attacks: f.atkName.trim() ? [{
        id: 'a1', name: f.atkName.trim(), bonus: f.atkBonus, damage: f.atkDamage, damageType: f.atkType,
        melee: !f.ranged, ranged: f.ranged, finesse: false, ability: f.ranged ? 'dex' : 'str', range: f.ranged ? 150 : undefined,
      }] : [],
    };
    combat.addMonster(view, Math.max(1, Math.min(20, f.count)), f.side, hidden);
    onClose();
  };
  const tabs = (
    <div className="row" style={{ gap: 4, marginBottom: 8 }}>
      {loadMonsters && <button className={'btn sm' + (tab === 'book' ? ' on' : '')} onClick={() => setTab('book')}>图鉴</button>}
      <button className={'btn sm' + (tab === 'text' ? ' on' : '')} onClick={() => setTab('text')} title="贴一段数据块文本：自制怪物、别的书里的怪物">贴文本</button>
      <button className={'btn sm' + (tab === 'custom' ? ' on' : '')} onClick={() => setTab('custom')}>快速填</button>
    </div>
  );
  const added = (view: ViewInit, n: number, side: string, hid: boolean) => { combat.addMonster(view, n, side, hid); onClose(); };
  if (tab === 'text') {
    return (
      <Dialog title="加怪物" onClose={onClose}>
        {tabs}
        <TextMonster canHide={canHide} onAdd={added} />
      </Dialog>
    );
  }
  if (tab === 'book' && loadMonsters) {
    return (
      <Dialog title="加怪物" onClose={onClose}>
        {tabs}
        {!monsters ? <div className="empty">正在加载图鉴…</div> : <BestiaryPicker monsters={monsters} canHide={canHide} onAdd={(view, n, side, hid) => { combat.addMonster(view, n, side, hid); onClose(); }} />}
      </Dialog>
    );
  }
  return (
    <Dialog title="加怪物" onClose={onClose} footer={<>
      {canHide && <label className="small" style={{ marginRight: 'auto' }}><input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} /> 先藏起来（玩家看不到，之后在参与者列表里亮出）</label>}
      <button className="btn" onClick={onClose}>取消</button><button className="btn primary" onClick={add}>加入 {f.count > 1 ? `${f.count} 个` : ''}</button></>}>
      {tabs}
      <div className="row">
        <span className="tiny faint">速成模板</span>
        {PRESETS.map(([label, p]) => <button key={label} className="chip" onClick={() => set({ ...p, ranged: !!p.ranged, type: p.type ?? '类人生物' })}>{label}</button>)}
      </div>
      <div className="formgrid">
        <Field label="名字"><input value={f.name} onChange={(e) => set({ name: e.target.value })} /></Field>
        <Field label="数量"><NumInput min={1} max={20} value={f.count} onChange={(n) => set({ count: n })} /></Field>
        <Field label="阵营">
          <select value={f.side} onChange={(e) => set({ side: e.target.value })}>
            <option value="enemy">敌方</option>
            <option value="party">友方</option>
            <option value="neutral">中立</option>
          </select>
        </Field>
        <Field label="类型"><select value={f.type} onChange={(e) => set({ type: e.target.value })}>{CREATURE_TYPES.map((t) => <option key={t}>{t}</option>)}</select></Field>
        <Field label="AC"><NumInput value={f.ac} onChange={(n) => set({ ac: n })} /></Field>
        <Field label="生命值"><NumInput min={1} value={f.hp} onChange={(n) => set({ hp: n })} /></Field>
        <Field label="先攻加值"><NumInput value={f.init} onChange={(n) => set({ init: n })} /></Field>
        <Field label="速度"><NumInput value={f.speed} onChange={(n) => set({ speed: n })} /></Field>
      </div>
      <div className="formgrid">
        <Field label="攻击（留空 = 没有）"><input value={f.atkName} onChange={(e) => set({ atkName: e.target.value })} /></Field>
        <Field label="命中加值"><NumInput value={f.atkBonus} onChange={(n) => set({ atkBonus: n })} /></Field>
        <Field label="伤害"><input value={f.atkDamage} onChange={(e) => set({ atkDamage: e.target.value })} style={{ width: 90 }} /></Field>
        <Field label="伤害类型"><select value={f.atkType} onChange={(e) => set({ atkType: e.target.value })}>{DAMAGE_TYPES.map((t) => <option key={t}>{t}</option>)}</select></Field>
        <Field label="每个攻击动作"><NumInput min={1} value={f.perAction} onChange={(n) => set({ perAction: n })} /></Field>
        <Field label="远程"><input type="checkbox" checked={f.ranged} onChange={(e) => set({ ranged: e.target.checked })} style={{ height: 28 }} /></Field>
      </div>
      <div className="tiny faint">图鉴里没有的怪物在这里手填，数值都可以在战斗中手动调整。</div>
    </Dialog>
  );
}

/* ------------------------------ 设置 ------------------------------ */

export function SettingsDialog({ s, ui, onClose }: { s: Session; ui: CombatUi; onClose: () => void }) {
  const st = s.state.settings;
  const put = (patch: Partial<Settings>) => combat.dispatch({ type: 'setSettings', settings: patch });
  const remote = ui.remote;
  const dm = !remote || remote.role === 'dm';
  // 战役遭遇：骰子设置存在服务器上；玩家只能改自己的
  const dice = remote ? remote.dice : ui.dice;
  const pcs = Object.values(s.state.combatants).filter((c) => c.kind === 'pc' && (dm || remote!.owners[c.controller] === remote!.me));
  const diceSel = (user: string, label: string, inherit: boolean) => (
    <Field key={user} label={label}>
      <select
        value={dice[user] ?? ''}
        onChange={(e) => combat.setDice(user, e.target.value as DiceMode)}
      >
        <option value="">{inherit ? '跟随默认' : '按身份（玩家：伤害骰自动、其余确认；DM：全自动）'}</option>
        <option value="confirmNoDamage">伤害骰自动，其余点一下确认</option>
        <option value="confirm">每颗骰子都点一下确认</option>
        <option value="engine">全自动</option>
        <option value="physical">实体骰（手动输入）</option>
      </select>
    </Field>
  );
  return (
    <Dialog title={dm ? '遭遇设置' : '我的骰子'} onClose={onClose}>
      {dm && <>
      <div className="formgrid">
        <Field label="怪物降到 0 生命值">
          <select value={st.monsterAt0} onChange={(e) => put({ monsterAt0: e.target.value as Settings['monsterAt0'] })}>
            <option value="dead">直接死亡</option>
            <option value="unconscious">昏迷（DM 决定生死）</option>
          </select>
        </Field>
        <Field label="反应时机">
          <select value={st.reactionTiming} onChange={(e) => put({ reactionTiming: e.target.value as Settings['reactionTiming'] })}>
            <option value="afterResult">看到结果再决定</option>
            <option value="raw">按规则原文（命中前决定）</option>
          </select>
        </Field>
        <Field label="规则有推测时">
          <select value={st.useGuesses ? 'y' : 'n'} onChange={(e) => put({ useGuesses: e.target.value === 'y' })}>
            <option value="y">直接按推测走（回执上标出来）</option>
            <option value="n">一律问我</option>
          </select>
        </Field>
      </div>
      <div className="tiny faint">上面三项会作为一笔操作记进日志，可以撤销。</div>
      <hr className="rule" />
      </>}
      <div className="formgrid">
        {dm && diceSel('*', '骰子（默认）', false)}
        {dm && diceSel('dm', 'DM / 怪物', true)}
        {pcs.map((c) => diceSel(c.controller, c.name, true))}
      </div>
      {!pcs.length && !dm && <div className="muted small">你在这场遭遇里还没有角色。</div>}
      <div className="tiny faint">
        骰子来源按人设置，只影响之后新掷的骰子；撤销、重放、事后裁定都复用已经掷出的骰面。
        {remote && '选「实体骰」后，轮到你掷骰时会弹出框让你填骰面。'}
      </div>
      <hr className="rule" />
      <h3 className="serif" style={{ margin: '4px 0 6px' }}>3D 掷骰动画</h3>
      <DiceSettings ui={ui} />
    </Dialog>
  );
}
