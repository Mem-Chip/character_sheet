/**
 * 3D 掷骰动画的设置：一行一个参数，空着 = 默认。
 * - 播谁的、镜头、灯光、外观、时长、一次最多几颗：只影响自己的屏幕，存在本机。
 * - 骰子颜色：战役里存在遭遇上（别人看到你的骰子也是这个颜色）。
 * - 物理（会改变滚法）：战役里只有 DM 能改，大家共用；本地遭遇存在本机。
 * 参数的含义和副作用见 app/lib/dice3d/README.md。
 */
import { useState, type ReactNode } from 'react';
import { combat, type CombatUi } from '../../lib/combat';
import {
  diceColor, diceDarkShow, setDiceDarkShow, type DarkShow, diceFxScope, diceLocal, diceLocalColor, diceLocalPhys, previewDice, setDiceFxScope, setDiceLocal,
  type DiceFxScope, type DiceLocal, type DicePhysics,
} from '../../lib/dicefx';
import { DEFAULT_DICE_OPTIONS as D } from '../../lib/dice3d/options';

type Group = 'camera' | 'lighting' | 'look' | 'timing';

export function DiceSettings({ ui }: { ui: CombatUi }) {
  const r = ui.remote;
  const dm = !r || r.role === 'dm';
  const [scope, setScope] = useState<DiceFxScope>(diceFxScope);
  const [loc, setLoc] = useState<DiceLocal>(diceLocal);
  const [dark, setDark] = useState<DarkShow>(diceDarkShow);
  const phys: DicePhysics = r ? r.dicePhys : diceLocalPhys();
  const myColor = r ? r.diceColors[String(r.me)] ?? '' : diceLocalColor() ?? '';
  const shownColor = myColor || diceColor(r ? r.me : 0);
  const canPhys = dm;

  const putLocal = (g: Group | 'physics', k: string, v: unknown) => {
    const next = { ...loc, [g]: { ...(loc[g] as Record<string, unknown> | undefined), [k]: v } } as DiceLocal;
    if (v === undefined) delete (next[g] as Record<string, unknown>)[k];
    setLoc(next);
    setDiceLocal(next);
  };
  const lnum = (g: Group, k: string, label: string, min: number, max: number, step: number, hint?: string, def?: string) => (
    <NumRow
      key={g + k} label={label} hint={hint} min={min} max={max} step={step}
      def={def ?? String((D[g] as Record<string, unknown>)[k])}
      value={(loc[g] as Record<string, number> | undefined)?.[k]}
      onChange={(v) => putLocal(g, k, v)}
    />
  );
  const pnum = (k: 'tableWidth' | 'tableDepth' | 'dieScale', label: string, min: number, max: number, step: number, def: string, hint?: string) => (
    <NumRow
      key={k} label={label} hint={hint} min={min} max={max} step={step} def={def} value={phys[k]} disabled={!canPhys}
      onChange={(v) => combat.setDicePhys({ ...phys, [k]: v })}
    />
  );
  const pbool = (k: 'tableGrow' | 'layFlat', label: string, yes: string, no: string, hint?: string) => (
    <Row key={k} label={label} hint={hint}>
      <select disabled={!canPhys} value={phys[k] === false ? 'n' : 'y'} onChange={(e) => combat.setDicePhys({ ...phys, [k]: e.target.value === 'y' })}>
        <option value="y">{yes}（默认）</option>
        <option value="n">{no}</option>
      </select>
    </Row>
  );

  return (
    <div className="optrows">
      <h4>播放</h4>
      <Row label="播谁的骰子" hint="只影响你自己的屏幕">
        <select value={scope} onChange={(e) => { const v = e.target.value as DiceFxScope; setScope(v); setDiceFxScope(v); }}>
          <option value="all">所有人的</option>
          <option value="mine">只播我的</option>
          <option value="off">不播</option>
        </select>
      </Row>
      <Row label="别人的暗骰" hint="/pr、DM 的暗骰、怪物的骰子">
        <select value={dark} onChange={(e) => { const v = e.target.value as DarkShow; setDark(v); setDiceDarkShow(v); }}>
          <option value="blank">显示空白骰子</option>
          <option value="none">不显示</option>
        </select>
      </Row>
      {r && dm && (
        <Row label="怪物 / NPC 的骰子" hint="玩家那边的 3D 骰子显不显示点数（日志照旧不给玩家看明细）；掷骰小窗里也可以每次单独选">
          <select value={r.diceOpen ? 'open' : 'dark'} onChange={(e) => combat.setDiceOpen(e.target.value === 'open')}>
            <option value="dark">暗骰（默认）</option>
            <option value="open">明骰</option>
          </select>
        </Row>
      )}
      <Row label="我的骰子颜色" hint={r ? '别人看到你的骰子也是这个颜色' : undefined}>
        <i className="hex-dot" style={{ background: shownColor }} />
        <HexBox value={myColor} placeholder={shownColor} onChange={(v) => combat.setDiceColor(v)} />
        <button className="btn sm" onClick={() => previewDice(shownColor, phys)}>试掷一下</button>
      </Row>
      {lnum('timing', 'maxRollMs', '滚动最长（毫秒）', 200, 10000, 100, '物理过程更长就加速播放；太小会像快进')}
      {lnum('timing', 'holdMs', '停稳后停留（毫秒）', 0, 20000, 100)}
      {lnum('timing', 'skipHoldMs', '跳过后停留（毫秒）', 0, 20000, 50)}
      {lnum('timing', 'dimMs', '没取的骰子变暗用时（毫秒）', 0, 5000, 50)}
      {lnum('timing', 'fadeMs', '淡出用时（毫秒）', 0, 5000, 50)}
      <NumRow label="一次最多几颗" hint="d100 算两颗；多的不播" min={1} max={100} step={1} def={String(D.physics.maxDice)}
        value={loc.physics?.maxDice} onChange={(v) => putLocal('physics', 'maxDice', v)} />

      <h4>镜头</h4>
      {lnum('camera', 'fov', '视场角（度）', 1, 90, 1, '越小越像正俯视、立体感越弱；太大边缘变形')}
      {lnum('camera', 'tilt', '倾斜角（度）', 0, 80, 1, '0 = 正上方往下看；太大数字会被压扁')}
      {lnum('camera', 'fill', '桌面占屏幕比例', 0.2, 1, 0.05, '接近 1 时弹得高的骰子会短暂出屏')}

      <h4>灯光</h4>
      {lnum('lighting', 'ambient', '环境光', 0, 10, 0.1, '太低背光面看不清')}
      {lnum('lighting', 'sun', '主光', 0, 10, 0.1, '太高浅色骰子会过曝')}
      {lnum('lighting', 'shadowOpacity', '影子浓度', 0, 1, 0.05, undefined, '按主题（浅 0.28 / 深 0.5）')}

      <h4>外观</h4>
      {lnum('look', 'roughness', '表面粗糙度', 0, 1, 0.02, '太低高光会盖住数字')}
      {lnum('look', 'droppedBrightness', '没取的骰子亮度', 0, 1, 0.05, '1 = 不变暗')}
      {lnum('look', 'droppedOpacity', '没取的骰子不透明度', 0, 1, 0.05, '1 = 不透明')}
      <Row label="标签位置" hint="角落里写「谁在掷什么」">
        <select value={loc.look?.labelPosition ?? ''} onChange={(e) => putLocal('look', 'labelPosition', e.target.value || undefined)}>
          <option value="">左上（默认）</option>
          <option value="top-right">右上</option>
          <option value="bottom-left">左下</option>
          <option value="bottom-right">右下</option>
        </select>
      </Row>
      {lnum('look', 'maxPixelRatio', '渲染分辨率上限', 0.5, 4, 0.25, '高分屏上调高更清楚，但更吃显卡')}

      <h4>物理 <span className="tiny faint">（会改变骰子怎么滚{r ? '；所有人共用，只有 DM 能改' : ''}）</span></h4>
      {pnum('tableWidth', '桌面宽', 4, 200, 0.5, String(D.physics.tableWidth), '骰子直径约 1.7')}
      {pnum('tableDepth', '桌面纵深', 4, 200, 0.5, String(D.physics.tableDepth))}
      {pbool('tableGrow', '骰子多时放大桌面', '超过 9 颗就放大', '不放大', '不放大时骰子多了会挤成一堆')}
      {pnum('dieScale', '骰子大小倍数', 0.2, 5, 0.1, '1', '大了像慢动作，小了数字看不清')}
      {pbool('layFlat', '停下后放平斜靠的骰子', '放平', '不放平', '不放平时斜靠的骰子保持斜着')}
      <div className="tiny faint">不管参数怎么设，停下来的点数都是已经掷好的结果。空着 = 默认。播放时点一下屏幕或按 Esc 跳过。</div>
    </div>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="optrow">
      <span className="k">{label}</span>
      <span className="v">{children}</span>
      <span className="h tiny faint">{hint}</span>
    </div>
  );
}

/** 数字：空着 = 默认（占位符写默认值）；回车或离开输入框生效，超出范围截到范围内 */
function NumRow({ label, hint, value, def, min, max, step, disabled, onChange }: {
  label: string; hint?: string; value?: number; def: string; min: number; max: number; step: number; disabled?: boolean;
  onChange: (v: number | undefined) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft == null) return;
    const t = draft.trim();
    setDraft(null);
    if (t === '') { if (value !== undefined) onChange(undefined); return; }
    const n = Number(t);
    if (!Number.isFinite(n)) return;
    const v = Math.min(max, Math.max(min, n));
    if (v !== value) onChange(v);
  };
  return (
    <Row label={label} hint={[hint, `${min}–${max}`].filter(Boolean).join('；')}>
      <input
        type="number" min={min} max={max} step={step} placeholder={`默认 ${def}`} disabled={disabled}
        value={draft ?? (value ?? '')} onChange={(e) => setDraft(e.target.value)} onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') commit(); }}
      />
    </Row>
  );
}

function HexBox({ value, placeholder, onChange }: { value: string; placeholder: string; onChange: (v: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft == null) return;
    let v = draft.trim();
    setDraft(null);
    if (v && !v.startsWith('#')) v = '#' + v;
    if (v === '' || /^#[0-9a-f]{6}$/i.test(v)) { if (v !== value) onChange(v); }
    else combat.toast('颜色要写成 #rrggbb');
  };
  return (
    <input
      className="hex" value={draft ?? value} placeholder={placeholder} size={9} spellCheck={false}
      onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') commit(); }}
    />
  );
}
