/** 战斗页：参与者 / 选中者的行动 / 日志 */
import { useEffect, useState } from 'react';
import { combat, initCombat, useCombat } from '../lib/combat';
import type { Engine } from '../lib/engine';
import { Actor } from './combat/Actor';
import { AddMonsterDialog, AddPcDialog, DecisionDialog, SettingsDialog } from './combat/Dialogs';
import { Log } from './combat/Log';
import { MapView } from './combat/MapView';
import { OnlineDialog } from './combat/Online';
import { Roster } from './combat/Roster';
import { namer } from './combat/shared';
import { Tag } from '../components/ui';

export function CombatPage({ engine }: { engine: Engine }) {
  const ui = useCombat();
  const [dlg, setDlg] = useState<null | 'pc' | 'monster' | 'settings' | 'online'>(null);
  /** DM 代玩家回答：记下是哪个决定，换了决定就自动收起 */
  const [proxy, setProxy] = useState<string | null>(null);
  const [showMap, setShowMap] = useState(false);
  // session 为空就（重新）初始化 —— 开发时热更新会把 combat.ts 的模块状态清掉
  useEffect(() => { if (!ui.session) initCombat(engine); }, [engine, ui.session]);

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
        {dm && !inCombat && <button className="btn primary" disabled={!count} onClick={() => combat.dispatch({ type: 'startCombat' })} title="所有人掷先攻">开始战斗</button>}
        {inCombat && (dm
          ? <button className="btn primary" onClick={() => combat.dispatch({ type: 'nextTurn' })}>下一回合</button>
          : <button className="btn primary" disabled={!myTurn} onClick={() => combat.dispatch({ type: 'nextTurn' })} title={myTurn ? '' : '还没轮到你'}>结束我的回合</button>)}
        {inCombat && dm && <button className="btn" onClick={() => { if (confirm('结束战斗？')) combat.dispatch({ type: 'endCombat' }); }}>结束战斗</button>}
        {remote && <button className={'btn' + (showMap ? ' primary' : '')} onClick={() => setShowMap(!showMap)}>地图</button>}
        <button className="btn" onClick={() => setDlg('settings')}>{dm ? '设置' : '我的骰子'}</button>
        {dm && <button className="btn ghost danger" onClick={() => {
          if (confirm('清空这场遭遇，开一场新的？日志和撤销记录都会丢掉（人物卡不受影响，要保留结果先「写回人物卡」）。')) combat.reset(engine);
        }}>{remote ? '清空' : '新遭遇'}</button>}
        {remote
          ? <button className="btn" onClick={() => combat.leave(engine)}>回到本地遭遇</button>
          : <button className="btn" onClick={() => setDlg('online')}>战役遭遇…</button>}
      </div>

      {showMap && remote
        ? (
          <div className="combat-grid with-map">
            <Roster s={s} ui={ui} onAddPc={() => setDlg('pc')} onAddMonster={() => setDlg('monster')} />
            <MapView s={s} ui={ui} remote={remote} name={name} />
            <div className="stack side-col">
              <Actor s={s} ui={ui} engine={engine} name={name} />
              <Log s={s} name={name} />
            </div>
          </div>
        )
        : (
          <div className="combat-grid">
            <Roster s={s} ui={ui} onAddPc={() => setDlg('pc')} onAddMonster={() => setDlg('monster')} />
            <Actor s={s} ui={ui} engine={engine} name={name} />
            <Log s={s} name={name} />
          </div>
        )}

      {s.pending && !combat.isMyDecision() && proxy !== pendingKey && (
        <div className="toast" role="status">
          等{name(s.pending.decision.to)}{s.pending.decision.kind === 'physicalDice' ? '掷骰' : '决定'}：{s.pending.decision.prompt}
          {dm && <button className="btn sm" style={{ marginLeft: 8 }} onClick={() => setProxy(pendingKey)}>DM 代答</button>}
        </div>
      )}
      {s.pending && combat.isMyDecision() && <DecisionDialog key={pendingKey} s={s} name={name} />}
      {s.pending && !combat.isMyDecision() && dm && proxy === pendingKey && <DecisionDialog key={pendingKey} s={s} name={name} onClose={() => setProxy(null)} />}
      {dlg === 'pc' && <AddPcDialog engine={engine} ui={ui} onClose={() => setDlg(null)} />}
      {dlg === 'monster' && <AddMonsterDialog canHide={!!remote && dm} onClose={() => setDlg(null)} />}
      {dlg === 'online' && <OnlineDialog engine={engine} onClose={() => setDlg(null)} />}
      {dlg === 'settings' && <SettingsDialog s={s} ui={ui} onClose={() => setDlg(null)} />}
      {ui.toast && <div className={'toast ' + ui.toast.tone} role="status">{ui.toast.text}</div>}
    </div>
  );
}
