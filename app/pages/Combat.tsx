/** 战斗页：参与者 / 选中者的行动 / 日志 */
import { useEffect, useState } from 'react';
import { combat, initCombat, useCombat } from '../lib/combat';
import type { Engine } from '../lib/engine';
import { Actor } from './combat/Actor';
import { AddMonsterDialog, AddPcDialog, DecisionDialog, SettingsDialog } from './combat/Dialogs';
import { Log } from './combat/Log';
import { Roster } from './combat/Roster';
import { namer } from './combat/shared';

export function CombatPage({ engine }: { engine: Engine }) {
  const ui = useCombat();
  const [dlg, setDlg] = useState<null | 'pc' | 'monster' | 'settings'>(null);
  // session 为空就（重新）初始化 —— 开发时热更新会把 combat.ts 的模块状态清掉
  useEffect(() => { if (!ui.session) initCombat(engine); }, [engine, ui.session]);

  const s = ui.session;
  if (!s) return <div className="page empty">正在准备遭遇…</div>;
  const st = s.state;
  const name = namer(s);
  const inCombat = st.round !== null;
  const current = inCombat ? st.order[st.turnIndex] : null;
  const count = Object.keys(st.combatants).length;

  return (
    <div className="page">
      <div className="combat-bar">
        <h2 className="serif">遭遇</h2>
        <span className="muted small">
          {inCombat ? <>第 <b className="num">{st.round}</b> 轮 · {name(current)} 的回合</> : count ? `${count} 名参与者，战斗未开始` : '空的遭遇'}
        </span>
        <span style={{ flex: 1 }} />
        {!inCombat
          ? <button className="btn primary" disabled={!count} onClick={() => combat.dispatch({ type: 'startCombat' })} title="所有人掷先攻">开始战斗</button>
          : <>
            <button className="btn primary" onClick={() => combat.dispatch({ type: 'nextTurn' })}>下一回合</button>
            <button className="btn" onClick={() => { if (confirm('结束战斗？')) combat.dispatch({ type: 'endCombat' }); }}>结束战斗</button>
          </>}
        <button className="btn" onClick={() => setDlg('settings')}>设置</button>
        <button className="btn ghost danger" onClick={() => {
          if (confirm('清空这场遭遇，开一场新的？日志和撤销记录都会丢掉（人物卡不受影响，要保留结果先「写回人物卡」）。')) combat.reset(engine);
        }}>新遭遇</button>
      </div>

      <div className="combat-grid">
        <Roster s={s} ui={ui} onAddPc={() => setDlg('pc')} onAddMonster={() => setDlg('monster')} />
        <Actor s={s} ui={ui} engine={engine} name={name} />
        <Log s={s} name={name} />
      </div>

      {s.pending && <DecisionDialog key={`${s.transactions.length}:${s.pending.decision.id}:${Object.keys(s.pending.input.answers).length}:${s.pending.input.tape.length}`} s={s} name={name} />}
      {dlg === 'pc' && <AddPcDialog engine={engine} ui={ui} onClose={() => setDlg(null)} />}
      {dlg === 'monster' && <AddMonsterDialog onClose={() => setDlg(null)} />}
      {dlg === 'settings' && <SettingsDialog s={s} ui={ui} onClose={() => setDlg(null)} />}
      {ui.toast && <div className={'toast ' + ui.toast.tone} role="status">{ui.toast.text}</div>}
    </div>
  );
}
