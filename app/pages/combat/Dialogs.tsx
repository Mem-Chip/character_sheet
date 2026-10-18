/** 战斗页的对话框：等待中的决定、加角色、加怪物、荒野形态 / 魔宠、召唤物、遭遇设置 */
import { useEffect, useMemo, useState } from 'react';
import { crNum, parseMonster } from '../../../src/bridge/from-monster';
import type { Decision, Session, Settings, ViewInit } from '../../../src/combat';
import { Dialog, Field, NumInput } from '../../components/ui';
import { useMonsterAi, withMonsterAi } from '../../lib/ai';
import { combat, useCombat, type CombatUi, type DiceMode, type FormPick } from '../../lib/combat';
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

/* ------------------------------ 荒野形态 / 魔宠 ------------------------------ */

const BEAST_PRESETS: Array<{ label: string; cr: number; fly?: boolean; view: ViewInit }> = [
  {
    label: '猫头鹰', cr: 0, fly: true,
    view: {
      name: '猫头鹰', size: '微型', type: '野兽', ac: 11, hpMax: 1, speed: 60, pb: 2,
      score: { str: 3, dex: 13, con: 8, int: 2, wis: 12, cha: 7 },
      skill: { '察觉': 5, '隐匿': 5 },
      attacks: [{ id: 'talons', name: '爪击', bonus: 3, damage: '1', damageType: '挥砍', melee: true, ranged: false, finesse: true, ability: 'dex' }],
      notes: [{ group: '特性', name: '飞掠', text: '猫头鹰飞出敌人的触及范围时不会引发借机攻击。' }],
    },
  },
  {
    label: '猫', cr: 0,
    view: {
      name: '猫', size: '微型', type: '野兽', ac: 12, hpMax: 2, speed: 40, pb: 2,
      score: { str: 3, dex: 15, con: 10, int: 3, wis: 12, cha: 7 },
      skill: { '察觉': 3, '隐匿': 4 },
      attacks: [{ id: 'claws', name: '爪击', bonus: 4, damage: '1', damageType: '挥砍', melee: true, ranged: false, finesse: true, ability: 'dex' }],
    },
  },
  {
    label: '渡鸦', cr: 0, fly: true,
    view: {
      name: '渡鸦', size: '微型', type: '野兽', ac: 12, hpMax: 2, speed: 50, pb: 2,
      score: { str: 2, dex: 14, con: 10, int: 5, wis: 13, cha: 6 },
      skill: { '察觉': 3 },
      attacks: [{ id: 'beak', name: '喙啄', bonus: 4, damage: '1', damageType: '穿刺', melee: true, ranged: false, finesse: true, ability: 'dex' }],
    },
  },
  {
    label: '狼', cr: 0.25,
    view: {
      name: '狼', size: '中型', type: '野兽', ac: 12, hpMax: 11, speed: 40, pb: 2,
      score: { str: 14, dex: 15, con: 12, int: 3, wis: 12, cha: 6 },
      skill: { '察觉': 5, '隐匿': 4 },
      attacks: [{ id: 'bite', name: '啃咬', bonus: 4, damage: '2d4 + 2', damageType: '穿刺', melee: true, ranged: false, finesse: false, ability: 'str' }],
      notes: [{ group: '特性', name: '群体战术', text: '目标生物 5 尺内有至少一名狼未失能的盟友时，狼对该生物进行的攻击检定具有优势。' }],
    },
  },
  {
    label: '黑熊', cr: 0.5,
    view: {
      name: '黑熊', size: '中型', type: '野兽', ac: 11, hpMax: 19, speed: 30, pb: 2,
      score: { str: 15, dex: 12, con: 14, int: 2, wis: 12, cha: 7 },
      skill: { '察觉': 5 },
      attacksPerAction: 2,
      attacks: [{ id: 'rend', name: '撕裂', bonus: 4, damage: '1d6 + 2', damageType: '挥砍', melee: true, ranged: false, finesse: false, ability: 'str' }],
    },
  },
  {
    label: '棕熊', cr: 1,
    view: {
      name: '棕熊', size: '大型', type: '野兽', ac: 11, hpMax: 22, speed: 40, pb: 2,
      score: { str: 17, dex: 12, con: 15, int: 2, wis: 13, cha: 7 },
      skill: { '察觉': 3 },
      attacksPerAction: 2,
      attacks: [
        { id: 'bite', name: '啃咬', bonus: 5, damage: '1d8 + 3', damageType: '穿刺', melee: true, ranged: false, finesse: false, ability: 'str' },
        { id: 'claw', name: '爪击', bonus: 5, damage: '1d4 + 3', damageType: '挥砍', melee: true, ranged: false, finesse: false, ability: 'str' },
      ],
    },
  },
  {
    label: '恐狼', cr: 1,
    view: {
      name: '恐狼', size: '大型', type: '野兽', ac: 14, hpMax: 22, speed: 50, pb: 2,
      score: { str: 17, dex: 15, con: 15, int: 3, wis: 12, cha: 7 },
      skill: { '察觉': 5, '隐匿': 4 },
      attacks: [{ id: 'bite', name: '啃咬', bonus: 5, damage: '1d10 + 3', damageType: '穿刺', melee: true, ranged: false, finesse: false, ability: 'str' }],
      notes: [{ group: '特性', name: '群体战术', text: '目标生物 5 尺内有至少一名恐狼未失能的盟友时，恐狼对该生物进行的攻击检定具有优势。' }],
    },
  },
  {
    label: '巨蜘蛛', cr: 1,
    view: {
      name: '巨蜘蛛', size: '大型', type: '野兽', ac: 14, hpMax: 26, speed: 30, pb: 2,
      score: { str: 14, dex: 16, con: 12, int: 2, wis: 11, cha: 4 },
      skill: { '察觉': 4, '隐匿': 7 },
      attacks: [{ id: 'bite', name: '啃咬', bonus: 5, damage: '1d8 + 3', damageType: '穿刺', extra: [{ dice: '2d6', type: '毒素' }], melee: true, ranged: false, finesse: true, ability: 'dex' }],
    },
  },
  {
    label: '剑齿虎', cr: 2,
    view: {
      name: '剑齿虎', size: '大型', type: '野兽', ac: 13, hpMax: 52, speed: 40, pb: 2,
      score: { str: 18, dex: 17, con: 15, int: 3, wis: 12, cha: 8 },
      skill: { '察觉': 5, '隐匿': 6 },
      attacksPerAction: 2,
      attacks: [{ id: 'rend', name: '撕裂', bonus: 6, damage: '2d6 + 4', damageType: '挥砍', melee: true, ranged: false, finesse: false, ability: 'str' }],
    },
  },
  {
    label: '巨蝎', cr: 3,
    view: {
      name: '巨蝎', size: '大型', type: '野兽', ac: 15, hpMax: 52, speed: 40, pb: 2,
      score: { str: 16, dex: 13, con: 15, int: 1, wis: 9, cha: 3 },
      attacksPerAction: 3,
      attacks: [
        { id: 'claw', name: '螯钳', bonus: 5, damage: '1d8 + 3', damageType: '钝击', melee: true, ranged: false, finesse: false, ability: 'str' },
        { id: 'sting', name: '尾刺', bonus: 5, damage: '1d10 + 3', damageType: '穿刺', extra: [{ dice: '2d10', type: '毒素' }], melee: true, ranged: false, finesse: false, ability: 'str' },
      ],
    },
  },
  {
    label: '象', cr: 4,
    view: {
      name: '象', size: '巨型', type: '野兽', ac: 12, hpMax: 76, speed: 40, pb: 2,
      score: { str: 22, dex: 9, con: 17, int: 3, wis: 11, cha: 6 },
      attacksPerAction: 2,
      attacks: [{ id: 'gore', name: '象牙', bonus: 8, damage: '2d8 + 6', damageType: '穿刺', melee: true, ranged: false, finesse: false, ability: 'str' }],
    },
  },
  {
    label: '猛犸象', cr: 6,
    view: {
      name: '猛犸象', size: '巨型', type: '野兽', ac: 13, hpMax: 126, speed: 50, pb: 3,
      score: { str: 24, dex: 9, con: 21, int: 3, wis: 11, cha: 6 },
      save: { str: 10, con: 8 },
      attacksPerAction: 2,
      attacks: [{ id: 'gore', name: '象牙', bonus: 10, damage: '2d10 + 7', damageType: '穿刺', melee: true, ranged: false, finesse: false, ability: 'str' }],
    },
  },
];

const crFmt = (n: number) => (n === 0.125 ? '1/8' : n === 0.25 ? '1/4' : n === 0.5 ? '1/2' : String(n));

export function WildShapeDialog({ s, pick, loadMonsters, onClose }: { s: Session; pick: FormPick; loadMonsters?: () => Promise<unknown[]>; onClose: () => void }) {
  const v = s.view(pick.actor);
  const lv = v.levels['德鲁伊'] ?? v.level ?? 1;
  const moon = v.sources.some((x) => x.includes(':月亮结社:'));
  const isFamiliar = pick.kind === 'familiar';
  const maxCr = isFamiliar ? 0 : moon ? Math.max(1, Math.floor(lv / 3)) : lv < 4 ? 0.25 : lv < 8 ? 0.5 : 1;
  const canFly = isFamiliar || lv >= 8;

  const [monsters, setMonsters] = useState<any[] | null>(null);
  useEffect(() => { void loadMonsters?.().then((m) => setMonsters(m as any[]), () => setMonsters([])); }, []);
  const [q, setQ] = useState('');
  const [allBeasts, setAllBeasts] = useState(false);
  const aiMap = useMonsterAi();

  const presets = useMemo(
    () => BEAST_PRESETS.filter((p) => allBeasts || (p.cr <= maxCr && (canFly || !p.fly))),
    [allBeasts, maxCr, canFly],
  );
  const [selectedPreset, setSelectedPreset] = useState<ViewInit | null>(() => presets[presets.length - 1]?.view ?? BEAST_PRESETS[0].view);
  const [selectedMonster, setSelectedMonster] = useState<any | null>(null);

  const bookBeasts = useMemo(() => {
    if (!monsters) return [];
    const t = q.trim().toLowerCase();
    return monsters.filter((m) => {
      const tp = typeof m.type === 'string' ? m.type : m.type?.type;
      if (!allBeasts && tp !== 'beast') return false;
      if (t && !String(m.name).includes(t) && !String(m.ENG_name ?? '').toLowerCase().includes(t)) return false;
      const c = crNum(m.cr);
      if (!allBeasts && c > maxCr) return false;
      const hasFly = Boolean(m.speed?.fly);
      if (!allBeasts && !canFly && hasFly) return false;
      return true;
    }).sort((a, b) => crNum(b.cr) - crNum(a.cr) || String(a.name).localeCompare(String(b.name), 'zh'));
  }, [monsters, q, allBeasts, maxCr, canFly]);

  const parsedMonster = useMemo(() => {
    if (!selectedMonster) return null;
    const raw = parseMonster(selectedMonster);
    return withMonsterAi(raw, aiMap[raw.key]);
  }, [selectedMonster, aiMap]);

  const currentView = parsedMonster?.view ?? selectedPreset;

  const confirmPick = () => {
    if (!currentView) return;
    const chosen: ViewInit = isFamiliar ? { ...currentView, type: '妖精' } : currentView;
    combat.confirmFormPick(chosen);
  };

  return (
    <Dialog
      title={isFamiliar ? `选择魔宠形态 · ${pick.name}` : `选择荒野形态 · ${v.name}`}
      onClose={onClose}
      footer={
        <>
          <label className="small" style={{ marginRight: 'auto' }}>
            <input type="checkbox" checked={allBeasts} onChange={(e) => setAllBeasts(e.target.checked)} /> 显示全部（不限 CR / 飞行 / 生物类型）
          </label>
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn primary" disabled={!currentView} onClick={confirmPick}>
            {isFamiliar ? `召唤「${currentView?.name ?? ''}」` : `变形为「${currentView?.name ?? ''}」`}
          </button>
        </>
      }
    >
      <div className="tiny faint" style={{ marginBottom: 6 }}>
        {isFamiliar
          ? '2024 规则：寻获魔宠 / 荒野伙伴可选择挑战等级 0 的野兽，召唤后生物类型为妖精（或天界 / 邪魔），先攻紧随你之后。'
          : `德鲁伊 ${lv} 级${moon ? '（月亮结社）' : ''} · 上限 CR ${crFmt(maxCr)}${canFly ? ' · 可选飞行野兽' : ' · 8 级前不能选有飞行速度的野兽'} · 临时生命值 +${moon ? lv * 3 : lv}${moon ? ` · AC 至少 ${13 + v.mod.wis}` : ''}`}
      </div>
      {/* 角色卡上勾选的「已知形态」：和卡面（建卡页的荒野形态面板）对上，优先列出来 */}
      {(v.knownForms ?? []).length > 0 && (
        <div className="row" style={{ gap: 4, flexWrap: 'wrap', marginBottom: 8 }}>
          <span className="tiny faint">已知形态（卡上选的）：</span>
          {(v.knownForms ?? []).map((nm) => {
            // 名字匹配放宽：中文名 / 英文原名 / 去空白都算（以前要求完全相等，图鉴里带英文的会 match 不到）
            const norm = (x: unknown) => String(x ?? '').replace(/\s/g, '').toLowerCase();
            const hit = (monsters ?? []).find((m) => norm(m.name) === norm(nm) || norm(m.ENG_name) === norm(nm));
            const on = selectedMonster && String(selectedMonster.name) === nm;
            return (
              <button
                key={nm}
                className={'chip' + (on ? ' on' : '')}
                title={hit ? '卡上勾选的已知形态' : '图鉴里没找到这个名字（可能在别的书里）'}
                onClick={() => { if (hit) setSelectedMonster(hit); }}
              >{nm}{!hit && <span className="faint"> ?</span>}</button>
            );
          })}
        </div>
      )}

      <div className="row" style={{ gap: 4, flexWrap: 'wrap', marginBottom: 8 }}>
        <span className="tiny faint">常用形态：</span>
        {presets.map((p) => (
          <button
            key={p.label}
            className={'chip' + (!selectedMonster && selectedPreset?.name === p.view.name ? ' on' : '')}
            onClick={() => { setSelectedMonster(null); setSelectedPreset(p.view); }}
          >
            {p.label} <span className="faint">CR {crFmt(p.cr)}</span>
          </button>
        ))}
      </div>
      <div className="bestiary">
        <div className="bestiary-list">
          <div className="row" style={{ gap: 6 }}>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="在图鉴中搜索野兽（中文或英文）" style={{ flex: 1, minWidth: 0 }} />
          </div>
          <div className="bestiary-rows">
            {!monsters && <div className="tiny faint">正在加载怪物图鉴…（可直接点上方常用形态）</div>}
            {monsters && bookBeasts.slice(0, 150).map((m) => (
              <button
                key={`${m.source}:${m.name}`}
                className={'bestiary-row' + (selectedMonster === m ? ' on' : '')}
                onClick={() => setSelectedMonster(m)}
              >
                <b>{m.name}</b><small>{m.ENG_name}</small>
                <span className="tiny faint">CR {crFmt(crNum(m.cr))}{m.speed?.fly ? ' · 飞行' : ''}</span>
              </button>
            ))}
            {monsters && !bookBeasts.length && <div className="tiny faint">图鉴中没有符合条件的野兽。</div>}
          </div>
        </div>
        <div className="bestiary-preview">
          {!currentView ? (
            <div className="empty">在左边或上方挑一个野兽形态。</div>
          ) : (
            <>
              <div className="serif" style={{ fontSize: 18 }}>{currentView.name}</div>
              <div className="tiny faint">{currentView.size ?? '中型'} {isFamiliar ? '妖精（魔宠）' : (currentView.type ?? '野兽')}</div>
              <div className="row" style={{ gap: 14, margin: '6px 0' }}>
                <span>AC <b>{!isFamiliar && moon ? Math.max(currentView.ac ?? 10, 13 + v.mod.wis) : (currentView.ac ?? 10)}</b></span>
                {isFamiliar ? (
                  <span>生命值 <b>{currentView.hpMax ?? 1}</b></span>
                ) : (
                  <span>临时生命值 <b>+{moon ? lv * 3 : lv}</b>（保留自身生命值）</span>
                )}
                <span>速度 <b>{currentView.speed ?? 30}</b> 尺</span>
              </div>
              {currentView.score && (
                <div className="tiny muted" style={{ marginBottom: 6 }}>
                  力量 {currentView.score.str ?? 10} · 敏捷 {currentView.score.dex ?? 10} · 体质 {currentView.score.con ?? 10}
                  {!isFamiliar && '（智力、感知、魅力保留自身）'}
                </div>
              )}
              {(currentView.attacks?.length ?? 0) > 0 && (
                <div className="bestiary-sec">
                  <div className="tiny ok">攻击{(currentView.attacksPerAction ?? 1) > 1 ? `（多重攻击 ×${currentView.attacksPerAction}）` : ''}</div>
                  <ul>
                    {currentView.attacks!.map((a) => (
                      <li key={a.id}>{a.name}：{a.bonus >= 0 ? `+${a.bonus}` : a.bonus}，{a.damage} {a.damageType}伤害</li>
                    ))}
                  </ul>
                </div>
              )}
              {(currentView.notes?.length ?? 0) > 0 && (
                <div className="bestiary-sec">
                  <div className="tiny warnline">特性与附带效果</div>
                  <ul>
                    {currentView.notes!.map((n, i) => (
                      <li key={i} title={n.text}><span className="faint">{n.group}·</span>{n.name}：{n.text}</li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}

/* ------------------------------ 手动加召唤物 / 伙伴 ------------------------------ */

export function SummonDialog({ s, summonerId, loadMonsters, onClose }: { s: Session; summonerId: string; loadMonsters?: () => Promise<unknown[]>; onClose: () => void }) {
  const summoner = s.state.combatants[summonerId];
  const [tab, setTab] = useState<'book' | 'text' | 'custom'>(loadMonsters ? 'book' : 'custom');
  const [monsters, setMonsters] = useState<unknown[] | null>(null);
  useEffect(() => { void loadMonsters?.().then(setMonsters, () => setMonsters([])); }, []);
  const [f, setF] = useState<MonsterForm>({
    name: '召唤生物', count: 1, side: summoner?.side ?? 'party', type: '野兽', ac: 13, hp: 20, init: 2, speed: 30,
    atkName: '猛击', atkBonus: 5, atkDamage: '1d8 + 3', atkType: '钝击', perAction: 1, ranged: false,
  });
  const set = (p: Partial<MonsterForm>) => setF({ ...f, ...p });
  const add = () => {
    const view: ViewInit = {
      name: f.name.trim() || '召唤生物', type: f.type, ac: f.ac, hpMax: Math.max(1, f.hp), speed: f.speed,
      score: { dex: 10 + 2 * f.init }, initiative: f.init, attacksPerAction: Math.max(1, f.perAction),
      attacks: f.atkName.trim() ? [{
        id: 'a1', name: f.atkName.trim(), bonus: f.atkBonus, damage: f.atkDamage, damageType: f.atkType,
        melee: !f.ranged, ranged: f.ranged, finesse: false, ability: f.ranged ? 'dex' : 'str', range: f.ranged ? 150 : undefined,
      }] : [],
    };
    combat.addSummon(summonerId, view, Math.max(1, Math.min(20, f.count)));
    onClose();
  };
  const tabs = (
    <div className="row" style={{ gap: 4, marginBottom: 8 }}>
      {loadMonsters && <button className={'btn sm' + (tab === 'book' ? ' on' : '')} onClick={() => setTab('book')}>图鉴</button>}
      <button className={'btn sm' + (tab === 'text' ? ' on' : '')} onClick={() => setTab('text')}>贴文本</button>
      <button className={'btn sm' + (tab === 'custom' ? ' on' : '')} onClick={() => setTab('custom')}>快速填</button>
      <span className="tiny faint" style={{ marginLeft: 'auto' }}>归属：{summoner?.name ?? summonerId}（同阵营、紧随其后行动）</span>
    </div>
  );
  const added = (view: ViewInit, n: number) => { combat.addSummon(summonerId, view, n); onClose(); };
  const title = `为 ${summoner?.name ?? summonerId} 添加召唤物 / 伙伴`;
  if (tab === 'text') {
    return (
      <Dialog title={title} onClose={onClose}>
        {tabs}
        <TextMonster onAdd={added} />
      </Dialog>
    );
  }
  if (tab === 'book' && loadMonsters) {
    return (
      <Dialog title={title} onClose={onClose}>
        {tabs}
        {!monsters ? <div className="empty">正在加载图鉴…</div> : <BestiaryPicker monsters={monsters} onAdd={added} />}
      </Dialog>
    );
  }
  return (
    <Dialog title={title} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>取消</button>
      <button className="btn primary" onClick={add}>召唤 {f.count > 1 ? `${f.count} 个` : ''}</button>
    </>}>
      {tabs}
      <div className="formgrid">
        <Field label="名字"><input value={f.name} onChange={(e) => set({ name: e.target.value })} /></Field>
        <Field label="数量"><NumInput min={1} max={20} value={f.count} onChange={(n) => set({ count: n })} /></Field>
        <Field label="类型"><select value={f.type} onChange={(e) => set({ type: e.target.value })}>{CREATURE_TYPES.map((t) => <option key={t}>{t}</option>)}</select></Field>
        <Field label="AC"><NumInput value={f.ac} onChange={(n) => set({ ac: n })} /></Field>
        <Field label="生命值"><NumInput min={1} value={f.hp} onChange={(n) => set({ hp: n })} /></Field>
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
    </Dialog>
  );
}

