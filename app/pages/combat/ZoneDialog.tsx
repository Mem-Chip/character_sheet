/** DM 把地图上的一个形状变成区域：谁进来 / 在里面开始、结束回合时受伤害（可以带豁免、状态），自动结算或者每次问 DM；也可以只是困难地形 */
import { useState } from 'react';
import type { Node, ZoneWhen } from '../../../src/combat';
import { Dialog } from '../../components/ui';
import { combat, useCombat } from '../../lib/combat';
import { CONDITIONS, DAMAGE_TYPES } from './shared';

const ABILS: Array<[string, string]> = [['', '不用豁免'], ['str', '力量'], ['dex', '敏捷'], ['con', '体质'], ['int', '智力'], ['wis', '感知'], ['cha', '魅力']];
const WHEN: Array<[ZoneWhen, string]> = [['enter', '进入时'], ['turnStart', '在里面开始回合'], ['turnEnd', '在里面结束回合']];

export function ZoneDialog({ cells, tpl, onDone, onClose }: {
  cells: string[];
  tpl: Record<string, unknown>;
  onDone: () => void;
  onClose: () => void;
}) {
  const [name, setName] = useState('危险区域');
  const [on, setOn] = useState<ZoneWhen[]>(['enter', 'turnStart']);
  const [dice, setDice] = useState('2d6');
  const [type, setType] = useState('火焰');
  const [abil, setAbil] = useState('dex');
  const [dc, setDc] = useState('13');
  const [onSave, setOnSave] = useState<'half' | 'none'>('half');
  const [cond, setCond] = useState('');
  const [once, setOnce] = useState(true);
  const [confirmEach, setConfirmEach] = useState(true);
  const [rounds, setRounds] = useState('');
  const [rough, setRough] = useState(false);
  const [err, setErr] = useState('');
  const pending = !!useCombat().session?.pending;

  const build = (): Node[] => {
    const hit: Node[] = [];
    if (dice.trim()) hit.push({ kind: 'damage', id: 'z', dice: dice.trim(), type });
    if (cond) hit.push({ kind: 'applyEffect', template: `XPHB:condition:${cond}` });
    if (!abil) return hit;
    return [{
      kind: 'save', ability: abil as 'dex', dc: String(Number(dc) || 10), onFail: hit,
      onSuccess: dice.trim() && onSave === 'half' ? [{ kind: 'damage', ref: 'z', scale: 0.5 }] : [],
    }];
  };
  const create = () => {
    if (pending) { setErr('还有一个决定没做完，先处理它'); return; }
    if (!name.trim()) { setErr('写个名字'); return; }
    const hits = !!(dice.trim() || cond);
    if (dice.trim() && !/^[\d\s+\-d]+$/i.test(dice.trim())) { setErr('伤害写成 2d6、1d10+3 这样'); return; }
    if (!hits && !rough) { setErr('伤害、状态、困难地形至少要一个'); return; }
    if (hits && !on.length) { setErr('至少选一个生效时机'); return; }
    combat.dispatch({
      type: 'createZone',
      zone: {
        name: name.trim(), cells, tpl, on: hits ? on : [], do: hits ? build() : [], affects: 'all', oncePerTurn: once, confirm: confirmEach,
        ...(rough ? { difficult: true } : {}),
        ...(Number(rounds) > 0 ? { rounds: Number(rounds) } : {}),
      },
    });
    onDone();
  };
  const toggle = (w: ZoneWhen) => setOn(on.includes(w) ? on.filter((x) => x !== w) : [...on, w]);

  return (
    <Dialog title="设为区域" onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>取消</button>
      <button className="btn primary" onClick={create}>放上地图</button>
    </>}>
      <div className="optrows">
        <label className="optrow"><span>名字</span><input value={name} onChange={(e) => setName(e.target.value)} /></label>
        <div className="optrow"><span>什么时候生效</span>
          <span className="row" style={{ gap: 10 }}>
            {WHEN.map(([w, l]) => <label key={w} className="tiny"><input type="checkbox" checked={on.includes(w)} onChange={() => toggle(w)} /> {l}</label>)}
          </span>
        </div>
        <label className="optrow"><span>伤害</span>
          <span className="row" style={{ gap: 6 }}>
            <input value={dice} onChange={(e) => setDice(e.target.value)} placeholder="不造成伤害就空着" style={{ width: 110 }} />
            <select value={type} onChange={(e) => setType(e.target.value)}>{DAMAGE_TYPES.map((t) => <option key={t}>{t}</option>)}</select>
          </span>
        </label>
        <label className="optrow"><span>豁免</span>
          <span className="row" style={{ gap: 6 }}>
            <select value={abil} onChange={(e) => setAbil(e.target.value)}>{ABILS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
            {abil && <>DC <input type="number" value={dc} onChange={(e) => setDc(e.target.value)} style={{ width: 56 }} />
              <select value={onSave} onChange={(e) => setOnSave(e.target.value as 'half')}>
                <option value="half">成功减半</option><option value="none">成功不受影响</option>
              </select></>}
          </span>
        </label>
        <label className="optrow"><span>{abil ? '失败时附加状态' : '附加状态'}</span>
          <select value={cond} onChange={(e) => setCond(e.target.value)}>
            <option value="">无</option>{CONDITIONS.map((c) => <option key={c}>{c}</option>)}
          </select>
        </label>
        <label className="optrow"><span>困难地形</span>
          <span className="row" style={{ gap: 6 }}>
            <input type="checkbox" checked={rough} onChange={(e) => setRough(e.target.checked)} />
            <span className="tiny faint">走进去每格多花 5 尺移动（只要地形的话，伤害清空、状态选无）</span>
          </span>
        </label>
        <label className="optrow"><span>每回合最多一次</span><input type="checkbox" checked={once} onChange={(e) => setOnce(e.target.checked)} /></label>
        <label className="optrow"><span>结算</span>
          <select value={confirmEach ? 'ask' : 'auto'} onChange={(e) => setConfirmEach(e.target.value === 'ask')}>
            <option value="ask">每次先问我</option><option value="auto">自动</option>
          </select>
        </label>
        <label className="optrow"><span>持续几轮</span><input type="number" min={0} value={rounds} onChange={(e) => setRounds(e.target.value)} placeholder="空着 = 一直在" style={{ width: 110 }} /></label>
      </div>
      {cond && <div className="tiny faint">附加的状态不会自己结束，要手动移除。</div>}
      {err && <div className="dangerline tiny">{err}</div>}
    </Dialog>
  );
}
