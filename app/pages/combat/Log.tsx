/** 战斗日志：按事务分组，新的在上面。掷骰带回执；DM 可以事后改某次检定的结果或某次伤害 */
import { useState } from 'react';
import type { GameEvent, Session } from '../../../src/combat';
import { NumInput, Panel } from '../../components/ui';
import { combat, useCombat } from '../../lib/combat';
import { describe, txTitle, type Line } from '../../lib/events';
import type { Namer } from './shared';

const OUTCOMES: Record<string, Array<[string, string]>> = {
  attack: [['hit', '命中'], ['miss', '未命中'], ['crit', '重击']],
  save: [['success', '成功'], ['fail', '失败']],
  check: [['success', '成功'], ['fail', '失败']],
};

export function Log({ s, name }: { s: Session; name: Namer }) {
  const ui = useCombat();
  const dm = !ui.remote || ui.remote.role === 'dm';
  // 玩家视角：DM 藏起来的参与者相关的整笔都不显示；怪物的数值不显示
  const hidden = ui.remote && !dm ? ui.remote.hidden : [];
  const mentionsHidden = (x: unknown) => hidden.length > 0 && hidden.some((h) => JSON.stringify(x).includes(`"${h}"`));
  const secret = (id: unknown) => combat.isSecret(String(id ?? ''));
  const txs = s.transactions;
  const [open, setOpen] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? txs.length : Math.min(txs.length, 40);

  return (
    <Panel
      title="日志"
      flush
      aside={<>
        <span className="tiny">{txs.length} 笔</span>
        {dm && <button className="btn sm" disabled={!txs.length} onClick={() => combat.undo()} title="撤销最后一笔（从起点重放其余的）">撤销</button>}
      </>}
    >
      <div className="log">
        {!txs.length && <div className="empty">还没有发生任何事。</div>}
        {txs.slice(-shown).map((t, k) => {
          const i = txs.length - shown + k;
          return { t, i };
        }).reverse().map(({ t, i }) => {
          if (mentionsHidden(t.input.cmd)) return null;
          // 「加入 xx」的标题已经说了，不再重复那一行
          const lines = t.events
            .filter((e) => e.type !== 'combatantAdded')
            // 先攻顺序里去掉藏着的；其他提到藏着的人的事件整条不显示
            .map((e) => (e.type === 'combatStarted' && hidden.length ? { ...e, payload: { ...e.payload, order: (e.payload as { order: string[] }).order.filter((x) => !hidden.includes(x)) } } : e))
            .filter((e) => e.type === 'combatStarted' || !mentionsHidden(e.payload))
            .map((e) => describe(e, name, secret)).filter((x): x is Line => !!x);
          const overridden = t.input.overrides.length > 0;
          return (
            <div key={i} className="tx">
              <div className="hd">
                <span className="tiny faint num">#{i + 1}</span>
                <span className="who">{txTitle(t.input.cmd as never, name)}</span>
                {overridden && <span className="tag warn">已裁定</span>}
              </div>
              {lines.map((l) => (
                <LineView
                  key={l.seq}
                  l={l}
                  dm={dm}
                  open={open === `${i}:${l.seq}`}
                  onToggle={() => setOpen(open === `${i}:${l.seq}` ? null : `${i}:${l.seq}`)}
                  onOverride={(patch) => { setOpen(null); combat.override(i, patch); }}
                />
              ))}
            </div>
          );
        })}
        {txs.length > shown && <div className="empty"><button className="btn sm" onClick={() => setShowAll(true)}>显示更早的 {txs.length - shown} 笔</button></div>}
      </div>
    </Panel>
  );
}

function LineView({ l, dm, open, onToggle, onOverride }: {
  l: Line;
  dm: boolean;
  open: boolean;
  onToggle: () => void;
  onOverride: (patch: Parameters<typeof combat.override>[1]) => void;
}) {
  const canRule = dm && (!!l.roll || !!l.damage);
  return (
    <div className={'ev' + (l.tone ? ' t-' + l.tone : '')}>
      <div className="evline">
        <span className="txt">{l.text}</span>
        {canRule && <button className="btn ghost sm rule-btn" onClick={onToggle} title="DM 事后改这个结果：从这一笔起重放后面所有的事">裁定</button>}
      </div>
      {l.receipt && <div className="receipt">{l.receipt}</div>}
      {l.sub?.map((x, j) => <div key={j} className="receipt sub">{x}</div>)}
      {open && l.roll && (
        <div className="row rule-row">
          <span className="tiny faint">改为</span>
          {(l.roll.judged ? OUTCOMES[l.roll.kind] ?? [] : []).map(([k, label]) => (
            <button key={k} className="btn sm" onClick={() => onOverride({ roll: l.roll!.index, outcome: k as 'hit', reason: `DM 裁定为${label}` })}>{label}</button>
          ))}
          <TotalInput onSet={(n) => onOverride({ roll: l.roll!.index, total: n, reason: `DM 裁定总值为 ${n}` })} />
        </div>
      )}
      {open && l.damage && <DamageRule byType={l.damage.byType} onSet={(amounts) => onOverride({ damage: l.damage!.index, amounts, reason: 'DM 改写伤害' })} />}
    </div>
  );
}

function TotalInput({ onSet }: { onSet: (n: number) => void }) {
  const [v, setV] = useState('');
  return (
    <>
      <input type="number" placeholder="总值" value={v} onChange={(e) => setV(e.target.value)} aria-label="改写总值" />
      <button className="btn sm" disabled={v === ''} onClick={() => onSet(Number(v))}>按总值</button>
    </>
  );
}

function DamageRule({ byType, onSet }: { byType: Record<string, number>; onSet: (a: Record<string, number>) => void }) {
  const [vals, setVals] = useState<Record<string, number>>(byType);
  return (
    <div className="row rule-row">
      <span className="tiny faint">伤害改为</span>
      {Object.keys(byType).map((t) => (
        <label key={t} className="row tiny" style={{ gap: 4 }}>
          <NumInput min={0} value={vals[t]} onChange={(n) => setVals({ ...vals, [t]: n })} aria-label={`${t}伤害`} />
          {t}
        </label>
      ))}
      <button className="btn sm" onClick={() => onSet(vals)}>确定</button>
    </div>
  );
}

/** 决定对话框里预览「停下来之前发生了什么」用 */
export function previewLines(events: GameEvent[], name: Namer): Line[] {
  return events.map((e) => describe(e, name)).filter((x): x is Line => !!x).slice(-8);
}
