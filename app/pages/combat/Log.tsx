/** 战斗日志：按事务分组，新的在上面。掷骰带回执；DM 可以事后改某次检定的结果或某次伤害 */
import { useEffect, useState } from 'react';
import { describeRoll, type ChatRoll, type GameEvent, type Session } from '../../../src/combat';
import { NumInput, Panel } from '../../components/ui';
import { combat, useCombat } from '../../lib/combat';
import { KIND_LABEL, lookupTerm, searchTerms, type TermData, type TermRef } from '../../lib/terms';
import { Term, termEngine } from '../../components/Term';
import { Entries } from '../../components/Entries';
import { describe, txTitle, type Line } from '../../lib/events';
import type { Namer } from './shared';

const OUTCOMES: Record<string, Array<[string, string]>> = {
  attack: [['hit', '命中'], ['miss', '未命中'], ['crit', '重击']],
  save: [['success', '成功'], ['fail', '失败']],
  check: [['success', '成功'], ['fail', '失败']],
};

export function Log({ s, name, onCollapse }: { s: Session; name: Namer; onCollapse?: () => void }) {
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
  // 指令框掷的骰：按「掷的时候有几笔事务」插进去
  const chat: ChatRoll[] = ui.remote ? ui.remote.chat : ui.chat;
  const chatAt = (n: number) => chat.filter((c) => (n === txs.length ? c.afterTx >= n : c.afterTx === n)).reverse();
  const me = ui.remote ? ui.remote.me : 0;
  const r = ui.remote;
  /** 战役遭遇里这次掷骰在玩家那边是不是暗骰（DM 那边照样看全，只是标出来） */
  const darkOf = (t: Session['transactions'][number], i: number, k: number): boolean | undefined => {
    const e = t.events[k];
    if (!r || (e.type !== 'd20Rolled' && e.type !== 'damageRolled')) return undefined;
    const p = e.payload as { index: number; roller?: string; source?: string | null };
    // 这次用的骰子：上一次掷骰事件之后、这一条之前掷的
    let prev = -1;
    for (let j = k - 1; j >= 0; j--) if (t.events[j].type === 'd20Rolled' || t.events[j].type === 'damageRolled') { prev = j; break; }
    const tapeDark = t.input.tape.some((x) => x?.dark && x.ev != null && x.ev > prev && x.ev <= k);
    return combat.rollDark(`${e.type === 'd20Rolled' ? 'r' : 'd'}:${i}:${p.index}`, p.roller ?? p.source ?? null, tapeDark);
  };

  return (
    <div className="logwrap">
    <Panel
      title="日志"
      flush
      aside={<>
        <span className="tiny">{txs.length} 笔</span>
        <button
          className={'btn sm' + (ui.replay !== null ? ' on' : '')}
          disabled={!txs.length && ui.replay === null}
          onClick={() => combat.setReplay(ui.replay === null ? txs.length : null)}
          title="回放历史记录：点任意一笔跳到那一刻，或一步一步前后翻看"
        >{ui.replay !== null ? '退出回放' : '回放'}</button>
        {dm && <button className="btn sm" disabled={!txs.length} onClick={() => combat.undo()} title="撤销最后一笔（从起点重放其余的）">撤销</button>}
        {onCollapse && <button className="btn ghost sm" onClick={onCollapse} title="收起日志">收起</button>}
      </>}
    >
      {ui.replay !== null && (
        <div className="replay-bar">
          <span className="small">
            <b>回放</b>：{ui.replay === 0 ? '起点（第 1 笔前）' : `第 #${ui.replay} / ${txs.length} 笔`}
          </span>
          <span style={{ flex: 1 }} />
          <button className="btn sm" disabled={ui.replay <= 0} onClick={() => combat.setReplay(0)} title="回到起点（第 1 笔之前）">⏮</button>
          <button className="btn sm" disabled={ui.replay <= 0} onClick={() => combat.setReplay(ui.replay! - 1)} title="上一笔">◀</button>
          <button className="btn sm" disabled={ui.replay >= txs.length} onClick={() => combat.setReplay(ui.replay! + 1)} title="下一笔">▶</button>
        </div>
      )}
      <div className="log">
        {!txs.length && !chat.length && <div className="empty">还没有发生任何事。</div>}
        {chatAt(txs.length).map((c) => <ChatLine key={c.id} c={c} mine={c.by === me} dm={dm} />)}
        {txs.slice(-shown).map((t, k) => {
          const i = txs.length - shown + k;
          return { t, i };
        }).reverse().map(({ t, i }) => {
          const chats = chatAt(i).map((c) => <ChatLine key={c.id} c={c} mine={c.by === me} dm={dm} />);
          if (mentionsHidden(t.input.cmd)) return chats.length ? <div key={i}>{chats}</div> : null;
          // 「加入 xx」的标题已经说了，不再重复那一行
          const darkSeq = new Map<number, boolean>();
          const lines = t.events
            .map((e, k) => { const d = darkOf(t, i, k); if (d !== undefined) darkSeq.set(e.seq, d); return e; })
            .filter((e) => e.type !== 'combatantAdded')
            // 先攻顺序里去掉藏着的；其他提到藏着的人的事件整条不显示
            .map((e) => (e.type === 'combatStarted' && hidden.length ? { ...e, payload: { ...e.payload, order: (e.payload as { order: string[] }).order.filter((x) => !hidden.includes(x)) } } : e))
            .filter((e) => e.type === 'combatStarted' || !mentionsHidden(e.payload))
            .map((e) => describe(e, name, secret, darkSeq.has(e.seq) ? !dm && darkSeq.get(e.seq) : undefined)).filter((x): x is Line => !!x);
          const overridden = t.input.overrides.length > 0;
          const isReplayAt = ui.replay === i + 1;
          const isFuture = ui.replay !== null && i + 1 > ui.replay;
          return (
            <div key={i}>
            <div
              className={'tx' + (ui.replay === null && i === txs.length - 1 ? ' latest' : '') + (isReplayAt ? ' replaying' : '') + (isFuture ? ' future' : '')}
              onClick={ui.replay !== null ? () => combat.setReplay(i + 1) : undefined}
              style={ui.replay !== null ? { cursor: 'pointer' } : undefined}
              title={ui.replay !== null ? `跳到第 #${i + 1} 笔之后` : undefined}
            >
              <div className="hd">
                <span className="tiny faint num">#{i + 1}</span>
                <span className="who">{txTitle(t.input.cmd as never, name)}</span>
                {overridden && <span className="tag warn">已裁定</span>}
                {isReplayAt && <span className="tag accent">当前位置</span>}
              </div>
              {lines.map((l) => (
                <LineView
                  key={l.seq}
                  l={l}
                  dm={dm}
                  open={open === `${i}:${l.seq}`}
                  onToggle={() => setOpen(open === `${i}:${l.seq}` ? null : `${i}:${l.seq}`)}
                  onOverride={(patch) => { setOpen(null); combat.override(i, patch); }}
                  dark={r && dm && l.dice ? darkSeq.get(l.seq) : undefined}
                  onDark={(d) => l.dice && combat.reveal({ key: `${l.dice.kind}:${i}:${l.dice.index}` }, !d)}
                />
              ))}
            </div>
            {chats}
            </div>
          );
        })}
        {txs.length > shown && <div className="empty"><button className="btn sm" onClick={() => setShowAll(true)}>显示更早的 {txs.length - shown} 笔</button></div>}
      </div>
    </Panel>
    <CommandBox />
    </div>
  );
}

function LineView({ l, dm, open, onToggle, onOverride, dark, onDark }: {
  l: Line;
  dm: boolean;
  open: boolean;
  onToggle: () => void;
  onOverride: (patch: Parameters<typeof combat.override>[1]) => void;
  /** DM 看：这次掷骰在玩家那边是暗骰（undefined = 不是战役遭遇里的掷骰，不给开关） */
  dark?: boolean;
  onDark?: (dark: boolean) => void;
}) {
  const canRule = dm && (!!l.roll || !!l.damage);
  return (
    <div className={'ev' + (l.tone ? ' t-' + l.tone : '')}>
      <div className="evline">
        <span className="txt">{l.text}</span>
        {dark !== undefined && <DarkToggle dark={dark} onSet={(d) => onDark?.(d)} />}
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

/** 暗骰 / 明骰开关：暗的时候玩家看不到骰面和明细 */
function DarkToggle({ dark, onSet }: { dark: boolean; onSet: (dark: boolean) => void }) {
  return (
    <button className={'btn ghost sm dark-btn' + (dark ? ' on' : '')} onClick={() => onSet(!dark)}
      title={dark ? '暗骰：玩家看不到骰面和明细。点一下转成明骰' : '明骰：大家都看得到骰面。点一下转成暗骰'}>
      {dark ? '暗骰' : '明骰'}
    </button>
  );
}

/** 决定对话框里预览「停下来之前发生了什么」用 */
export function previewLines(events: GameEvent[], name: Namer): Line[] {
  return events.map((e) => describe(e, name)).filter((x): x is Line => !!x).slice(-8);
}

/** /match 分享的条目：标题 + 原文（长的先折起来） */
function TermLine({ c }: { c: ChatRoll }) {
  const t = c.term!;
  const [data, setData] = useState<TermData | null | undefined>(undefined);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const eng = termEngine();
    let alive = true;
    if (eng) void lookupTerm(eng, t).then((d) => alive && setData(d));
    else setData(null);
    return () => { alive = false; };
  }, [t.kind, t.name, t.source]);
  return (
    <div className="chatroll termmsg">
      <div className="evline"><span className="txt"><b>{c.byName}</b> 分享了</span></div>
      {/* 条目本身框起来：标题、类别、原文 */}
      <div className="term-card">
        <div className="term-head">
          <b className="serif"><Term {...t}>{t.name}</Term></b>
          <span className="tiny faint">{data ? `${data.kindLabel}${data.source ? ` · ${data.source}` : ''}` : KIND_LABEL[t.kind] ?? t.kind}</span>
        </div>
        {data === null && <div className="tiny faint">查不到这条的原文。</div>}
        {data && (
          <div className={'prose small term-body' + (open ? ' open' : '')}>
            {data.meta.length > 0 && <div className="meta">{data.meta.map((m, i) => <div key={i}>{m}</div>)}</div>}
            <Entries entries={data.entries} />
          </div>
        )}
        {data && <button className="btn ghost sm" onClick={() => setOpen(!open)}>{open ? '收起' : '展开全文'}</button>}
      </div>
    </div>
  );
}

/** 指令框掷的一次骰。私密的：别人只看到「掷了骰子」；DM 可以点开看 */
function ChatLine({ c, mine, dm }: { c: ChatRoll; mine: boolean; dm: boolean }) {
  const [peek, setPeek] = useState(false);
  const remote = !!useCombat().remote;
  const visible = !c.private || mine || peek;
  if (c.term) return <TermLine c={c} />;
  if (c.text != null) return <div className="chatroll said"><div className="evline"><span className="txt"><b>{c.byName}</b>：{c.text}</span></div></div>;
  return (
    <div className={'chatroll' + (c.private ? ' private' : '')}>
      <div className="evline">
        <span className="txt">
          <b>{c.byName}</b> 掷骰{c.private && <span className="tag">私密</span>}
          {visible && c.note && <span className="muted">：{c.note}</span>}
          {visible && <> → {c.results.map((r, i) => <b key={i} className="num roll-total">{r.total}</b>)}</>}
        </span>
        {!visible && dm && <button className="btn ghost sm" onClick={() => setPeek(true)}>看</button>}
        {(mine || dm) && remote && <DarkToggle dark={c.private} onSet={(d) => combat.reveal({ chat: c.id }, !d)} />}
        {c.private && !mine && peek && <button className="btn ghost sm" onClick={() => setPeek(false)}>收起</button>}
      </div>
      {visible && c.results.map((r, i) => (
        <div key={i} className="receipt">
          {/* 没取的骰子（~5~）画删除线 */}
          {describeRoll(r).split(/(~\d+~)/).map((part, k) => (part.startsWith('~') ? <s key={k} className="faint">{part.slice(1, -1)}</s> : part))}
        </div>
      ))}
    </div>
  );
}

/** 日志下面的指令框。回车发出；写错了在下面提示 */
function CommandBox() {
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  const [hist, setHist] = useState<string[]>([]);
  const [h, setH] = useState(-1);
  /** /match 找到好几条时列出来，点一个打开 */
  const [found, setFound] = useState<TermRef[] | null>(null);
  const match = async (q: string) => {
    const eng = termEngine();
    if (!q) { setErr('要写名字，比如 /match 魔法飞弹'); return; }
    if (!eng) return;
    const list = await searchTerms(eng, q);
    if (!list.length) { setErr(`没找到「${q}」`); setFound(null); return; }
    // 只有一条、或者名字完全对上：直接发；否则列出来让人挑
    const low = q.toLowerCase();
    const exact = list.filter((r) => r.name === q || r.en?.toLowerCase() === low);
    if (list.length === 1 || exact.length === 1) { share((exact[0] ?? list[0])); return; }
    setFound(list);
  };
  const share = (r: TermRef) => { combat.shareTerm({ kind: r.kind, name: r.name, ...(r.source ? { source: r.source } : {}) }); setFound(null); };
  const send = () => {
    const t = text.trim();
    if (!t) return;
    const mm = t.match(/^\/match(?:\s+([\s\S]*))?$/i);
    if (mm) {
      void match((mm[1] ?? '').trim());
      setHist([t, ...hist.filter((x) => x !== t)].slice(0, 20));
      setH(-1);
      setText('');
      return;
    }
    // 批量结算：作用在「主选 + Shift 多选」上（/heal 10 · /damage 8 火焰 · /temphp 5 · /cond 中毒）
    const mm2 = t.match(/^\/(heal|damage|temphp|cond)(?:\s+([\s\S]*))?$/i);
    if (mm2) {
      const kind = mm2[1].toLowerCase() as 'heal' | 'damage' | 'temphp' | 'cond';
      const rest = (mm2[2] ?? '').trim();
      const need = kind === 'cond' ? '要写状态名，比如 /cond 中毒' : '要写数值，比如 /heal 10';
      if (!rest) { setErr(need); return; }
      if (kind === 'cond') {
        const [cond, ...notes] = rest.split(/\s+/);
        const err = combat.batch('cond', 0, cond);
        if (err) { setErr(err); return; }
        setErr(''); setFound(null); setText('');
        setHist([t, ...hist.filter((x) => x !== t)].slice(0, 20)); setH(-1);
        void notes;
        return;
      }
      const [numRaw, ...types] = rest.split(/\s+/);
      // 数字或骰子（2d6+3 / 8d6）都行，掷骰交给 batch（会进日志）
      const err = combat.batch(kind === 'temphp' ? 'tempHp' : kind, numRaw, types.join(' '));
      if (err) { setErr(err); return; }
      setErr(''); setFound(null); setText('');
      setHist([t, ...hist.filter((x) => x !== t)].slice(0, 20)); setH(-1);
      return;
    }
    setFound(null);
    const e = combat.say(t);
    if (e) { setErr(e); return; }
    setErr('');
    setHist([t, ...hist.filter((x) => x !== t)].slice(0, 20));
    setH(-1);
    setText('');
  };
  return (
    <div className="cmdbox">
      <input
        value={text} title={['直接打字 = 说一句话', '/r 1d20+5, 2d6+3 说明 · ad20 优势 · dd20 劣势 · 4d6kh3 取高', '/pr 私密掷骰', '/match 名字（中文或英文）：把法术、状态、专长、物品、怪物的原文发到日志',
        '/heal 10（也能写 2d6+3）· /damage 8 火焰（或 8d6 火焰）· /temphp 5 · /cond 中毒：批量作用在当前选中的那些（Shift 点可以多选）'].join('\n')}
        onChange={(e) => { setText(e.target.value); setErr(''); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') send();
          // 上下键翻之前发过的
          else if (e.key === 'ArrowUp' && hist.length) { const k = Math.min(hist.length - 1, h + 1); setH(k); setText(hist[k]); e.preventDefault(); }
          else if (e.key === 'ArrowDown' && h >= 0) { const k = h - 1; setH(k); setText(k >= 0 ? hist[k] : ''); e.preventDefault(); }
        }}
        aria-label="指令"
      />
      {err && <div className="dangerline tiny">{err}</div>}
      {found && (
        <div className="match-list">
          {found.map((r) => (
            <button key={r.kind + r.name} className="tag" onClick={() => share(r)} title="发到日志">
              <Term {...r} inButton>{r.name}</Term>{r.en && <small>{r.en}</small>}<small>{KIND_LABEL[r.kind] ?? r.kind}</small>
            </button>
          ))}
          <button className="btn ghost sm" onClick={() => setFound(null)}>不发了</button>
        </div>
      )}
    </div>
  );
}


