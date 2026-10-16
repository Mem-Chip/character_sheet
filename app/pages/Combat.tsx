/**
 * 战斗页。两种布局：
 * - 列表布局（本地遭遇，或战役遭遇里切过来）：参与者 / 选中者的行动 / 日志 三栏。
 * - 地图布局（战役遭遇默认）：地图铺满，四周一圈尺寸统一的浮层 ——
 *   顶栏（遭遇名 + 菜单 | 先攻条 | 参与者）、左边工具条（在 MapView 里）、右边日志、底部行动栏；
 *   参与者列表和完整的角色详情是从左边拉出来的抽屉；要做的决定是贴在行动栏上面的卡片，不挡地图。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { combat, initCombat, useCombat } from '../lib/combat';
import type { Engine } from '../lib/engine';
import { Actor } from './combat/Actor';
import { AddMonsterDialog, AddPcDialog, DecisionDialog, SettingsDialog } from './combat/Dialogs';
import { Hotbar } from './combat/Hotbar';
import { Initiative } from './combat/Initiative';
import { Log } from './combat/Log';
import { MapView } from './combat/MapView';
import { OnlineDialog } from './combat/Online';
import { TokenMenu } from './combat/TokenMenu';
import { diceColor, diceLocalColor, diceLocalPhys, scanChat, scanTape } from '../lib/dicefx';
import { describe, txTitle } from '../lib/events';
import type { GameEvent } from '../../src/combat';
import { DiceCaption } from './combat/DiceCaption';
import { namer } from './combat/shared';
import { Roster } from './combat/Roster';
import { Tag } from '../components/ui';

type Drawer = null | 'roster' | 'detail';

export function CombatPage({ engine }: { engine: Engine }) {
  const ui = useCombat();
  const uiRef = useRef(ui);
  uiRef.current = ui;
  const [dlg, setDlg] = useState<null | 'pc' | 'monster' | 'settings' | 'online'>(null);
  /** DM 代玩家回答：记下是哪个决定，换了决定就自动收起 */
  const [proxy, setProxy] = useState<string | null>(null);
  // 战役遭遇默认用地图布局
  const [showMap, setShowMap] = useState(true);
  const [drawer, setDrawer] = useState<Drawer>(null);
  const [logOpen, setLogOpen] = useState(() => { try { return localStorage.getItem('dnd2024-engine:dock:log') !== '0'; } catch { return true; } });
  const [hotOpen, setHotOpen] = useState(() => { try { return localStorage.getItem('dnd2024-engine:dock:hot') !== '0'; } catch { return true; } });
  // session 为空就（重新）初始化 —— 开发时热更新会把 combat.ts 的模块状态清掉
  useEffect(() => { if (!ui.session) initCombat(engine); }, [engine, ui.session]);
  // Esc：在选目标就取消选目标，否则取消选中的人和标的目标
  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (uiRef.current.aim) { combat.aimCancel(); return; }
      combat.select(null);
      if (uiRef.current.targets.length) combat.clearTargets();
    };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, []);
  // 3D 掷骰动画：新掷出来的骰子（引擎掷的、指令框 /r）播一下
  useEffect(() => {
    const ss = ui.session;
    const r = ui.remote;
    // 战役遭遇：服务器的状态到了再扫（不然先记下的是空的历史，状态一到就把旧骰子全播一遍）
    if (!ss || (r && !r.connected)) return;
    const enc = r ? r.id : 'local';
    const phys = r ? r.dicePhys : diceLocalPhys();
    const colors: Record<string, string> = r ? r.diceColors : { 0: diceLocalColor() ?? '', dm: diceLocalColor() ?? '' };
    const nm = namer(ss);
    const ctlOf = (id: string | null) => (id ? ss.state.combatants[id]?.controller ?? id : null);
    scanTape(ss, {
      encounter: enc,
      physics: phys,
      subject: (cmd) => { const c = cmd as Record<string, unknown>; return String(c.actor ?? c.roller ?? c.id ?? '') || null; },
      visible: (id) => !id || !combat.isSecret(id),
      mine: (id) => !r || (!!id && r.owners[ctlOf(id) ?? ''] === r.me) || (!id && r.role === 'dm'),
      // 玩家的角色用玩家的颜色，其余（怪物、DM 的 NPC）用 DM 的
      color: (id) => diceColor(r ? r.owners[ctlOf(id) ?? ''] ?? 'dm' : 0, colors),
      label: (cmd) => txTitle(cmd as { type: string }, nm),
      // 这次掷骰对应的日志：从掷的位置往后找第一条 d20 / 伤害骰事件，连同它前面那句结论
      line: (events, from) => {
        const evs = events as GameEvent[];
        const secret = (id: unknown) => combat.isSecret(String(id ?? ''));
        for (let i = from; i < evs.length; i++) {
          if (evs[i].type !== 'd20Rolled' && evs[i].type !== 'damageRolled') continue;
          const l = describe(evs[i], nm, secret);
          if (!l) return null;
          return { title: l.text, detail: l.receipt };
        }
        return null;
      },
    });
    scanChat(enc, r ? r.chat : ui.chat, r ? r.me : 0, phys, colors);
  });

  const s = ui.session;
  if (!s) return <div className="page empty">正在准备遭遇…</div>;
  const st = s.state;
  const name = namer(s);
  const inCombat = st.round !== null;
  const current = inCombat ? st.order[st.turnIndex] : null;
  const count = Object.keys(st.combatants).length;
  const remote = ui.remote;
  const dm = !remote || remote.role === 'dm';
  const myTurn = !!current && combat.canControl(current);
  const pendingKey = s.pending ? `${s.transactions.length}:${s.pending.decision.id}:${Object.keys(s.pending.input.answers).length}:${s.pending.input.tape.length}` : '';
  const curName = combat.isHidden(current) ? '？？？' : name(current);
  const battle = !!remote && showMap;

  const confirmReset = () => {
    if (confirm('清空这场遭遇，开一场新的？日志和撤销记录都会丢掉（人物卡不受影响：生命值、法术位这些已经自动写回卡上了）。')) combat.reset(engine);
  };
  const turnButton = !inCombat
    ? (dm ? <button className="btn primary" disabled={!count} onClick={() => combat.dispatch({ type: 'startCombat' })} title="所有人掷先攻">开始战斗</button> : null)
    : dm
      ? <button className="btn primary" onClick={() => combat.dispatch({ type: 'nextTurn' })}>下一回合</button>
      : <button className="btn primary" disabled={!myTurn} onClick={() => combat.dispatch({ type: 'nextTurn' })} title={myTurn ? '' : '还没轮到你'}>结束我的回合</button>;

  const prompts = <>
    {s.pending && !combat.isMyDecision() && proxy !== pendingKey && (
      <div className={battle ? 'prompt-wait panel' : 'toast'} role="status">
        等{name(s.pending.decision.to)}{s.pending.decision.kind === 'physicalDice' ? '掷骰' : '决定'}：{s.pending.decision.prompt}
        {s.pending.decision.options.length > 0 && <span className="faint">（可选：{s.pending.decision.options.map((o) => o.label).join('、')}）</span>}
        {dm && <button className="btn sm" style={{ marginLeft: 8 }} onClick={() => setProxy(pendingKey)}>DM 代答</button>}
      </div>
    )}
    {s.pending && combat.isMyDecision() && <DecisionDialog key={pendingKey} s={s} name={name} docked={battle} />}
    {s.pending && !combat.isMyDecision() && dm && proxy === pendingKey && <DecisionDialog key={pendingKey} s={s} name={name} docked={battle} onClose={() => setProxy(null)} />}
  </>;

  const dialogs = <>
    {dlg === 'pc' && <AddPcDialog engine={engine} ui={ui} onClose={() => setDlg(null)} />}
    {dlg === 'monster' && <AddMonsterDialog canHide={!!remote && dm} onClose={() => setDlg(null)} />}
    {dlg === 'online' && <OnlineDialog engine={engine} onClose={() => setDlg(null)} />}
    {dlg === 'settings' && <SettingsDialog s={s} ui={ui} onClose={() => setDlg(null)} />}
    {ui.toast && <div className={'toast ' + ui.toast.tone} role="status">{ui.toast.text}</div>}
  </>;

  if (battle) {
    const toggleLog = () => { setLogOpen(!logOpen); try { localStorage.setItem('dnd2024-engine:dock:log', logOpen ? '0' : '1'); } catch { /* 无所谓 */ } };
    const toggleHot = () => { setHotOpen(!hotOpen); try { localStorage.setItem('dnd2024-engine:dock:hot', hotOpen ? '0' : '1'); } catch { /* 无所谓 */ } };
    // 选目标时总是展开（要看确认按钮）
    const hotShown = hotOpen || !!ui.aim;
    return (
      <div className={'battle' + (logOpen ? '' : ' log-closed') + (hotShown ? '' : ' hot-closed') + (drawer ? ' drawer-open' : '')}>
        <MapView s={s} ui={ui} remote={remote!} name={name} />
        <div className="hud hud-top">
          <Menu label={remote!.name}>
            <div className="menu-head">
              <Tag tone={remote!.role === 'dm' ? 'accent' : undefined}>{remote!.role === 'dm' ? 'DM' : '玩家'}</Tag>
            </div>
            <button onClick={() => setDrawer('roster')}>参与者列表</button>
            <button onClick={() => setDlg('settings')}>{dm ? '遭遇设置与骰子' : '我的骰子'}</button>
            <button onClick={() => setShowMap(false)}>切到列表布局</button>
            {dm && inCombat && <button onClick={() => { if (confirm('结束战斗？')) combat.dispatch({ type: 'endCombat' }); }}>结束战斗</button>}
            {dm && <button className="danger" onClick={confirmReset}>清空遭遇</button>}
            <button onClick={() => combat.leave(engine)}>回到本地遭遇</button>
          </Menu>
          <Initiative s={s} ui={ui} name={name} />
          {!remote!.connected && <Tag tone="warn">重连中</Tag>}
          <button className={'btn sm' + (drawer === 'roster' ? ' on' : '')} onClick={() => setDrawer(drawer === 'roster' ? null : 'roster')}>参与者</button>
        </div>

        {drawer && (
          <div className="hud hud-drawer">
            <div className="drawer-tabs">
              <button className={drawer === 'roster' ? 'on' : ''} onClick={() => setDrawer('roster')}>参与者</button>
              <button className={drawer === 'detail' ? 'on' : ''} onClick={() => setDrawer('detail')}>角色详情</button>
              <span style={{ flex: 1 }} />
              <button className="btn ghost sm" onClick={() => setDrawer(null)}>收起</button>
            </div>
            <div className="drawer-body">
              {drawer === 'roster'
                ? <Roster s={s} ui={ui} onAddPc={() => setDlg('pc')} onAddMonster={() => setDlg('monster')} />
                : <Actor s={s} ui={ui} engine={engine} name={name} />}
            </div>
          </div>
        )}

        {logOpen
          ? <div className="hud hud-log"><Log s={s} name={name} onCollapse={toggleLog} /></div>
          : <button className="btn sm hud-log-open" onClick={toggleLog}>日志 · {s.transactions.length}</button>}

        <div className="hud hud-hot">
          <Hotbar s={s} ui={ui} engine={engine} name={name} onDetail={() => setDrawer(drawer === 'detail' ? null : 'detail')} turnButton={turnButton} collapsed={!hotShown} onToggle={toggleHot} />
        </div>
        <div className="hud-prompt">{prompts}</div>
        {dialogs}
        <DiceCaption />
        <TokenMenu s={s} ui={ui} engine={engine} name={name} />
      </div>
    );
  }

  return (
    <div className="page">
      <div className="combat-bar">
        <h2 className="serif">{remote ? remote.name : '遭遇'}</h2>
        {remote
          ? <>
            <Tag tone={remote.role === 'dm' ? 'accent' : undefined}>战役遭遇 · {remote.role === 'dm' ? 'DM' : '玩家'}</Tag>
            {!remote.connected && <Tag tone="warn">连接断开，正在重连…</Tag>}
          </>
          : <Tag>本地</Tag>}
        <span className="muted small">
          {inCombat ? <>第 <b className="num">{st.round}</b> 轮 · {curName} 的回合</> : count ? `${count} 名参与者，战斗未开始` : '空的遭遇'}
        </span>
        <span style={{ flex: 1 }} />
        {turnButton}
        {inCombat && dm && <button className="btn" onClick={() => { if (confirm('结束战斗？')) combat.dispatch({ type: 'endCombat' }); }}>结束战斗</button>}
        {remote && <button className="btn" onClick={() => setShowMap(true)}>地图布局</button>}
        <button className="btn" onClick={() => setDlg('settings')}>{dm ? '设置' : '我的骰子'}</button>
        {dm && <button className="btn ghost danger" onClick={confirmReset}>{remote ? '清空' : '新遭遇'}</button>}
        {remote
          ? <button className="btn" onClick={() => combat.leave(engine)}>回到本地遭遇</button>
          : <button className="btn" onClick={() => setDlg('online')}>战役遭遇…</button>}
      </div>
      <div className="combat-grid">
        <Roster s={s} ui={ui} onAddPc={() => setDlg('pc')} onAddMonster={() => setDlg('monster')} />
        <Actor s={s} ui={ui} engine={engine} name={name} />
        <Log s={s} name={name} />
      </div>
      {prompts}
      {dialogs}
      <DiceCaption />
      <TokenMenu s={s} ui={ui} engine={engine} name={name} />
    </div>
  );
}

/** 顶栏左边：遭遇名，点开是菜单（点外面、按 Esc 收起） */
function Menu({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', off);
    window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('mousedown', off); window.removeEventListener('keydown', esc); };
  }, [open]);
  return (
    <div className="hud-menu" ref={box}>
      <button className="hud-title" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="burger" aria-hidden>≡</span><span className="serif">{label}</span>
      </button>
      {open && <div className="menu-pop panel" onClick={(e) => { if ((e.target as Element).closest('button')) setOpen(false); }}>{children}</div>}
    </div>
  );
}
