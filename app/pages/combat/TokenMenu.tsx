/**
 * 右键菜单（地图棋子、先攻条、参与者列表都用这个）：设为目标、选中、状态（DM）、拿下地图、藏起 / 亮出（DM）。
 * 选目标模式里右键不开菜单，还是「去掉一个」。
 */
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Session } from '../../../src/combat';
import { combat, type CombatUi } from '../../lib/combat';
import type { Engine } from '../../lib/engine';
import { getApp, actions } from '../../lib/store';
import { termOfKey } from '../../lib/terms';
import { Term } from '../../components/Term';
import { avatarOf, cropAvatarFile, effectLabel, type Namer } from './shared';

let open: { id: string; x: number; y: number } | null = null;
const subs = new Set<() => void>();
const emit = () => { for (const f of subs) f(); };

/** 在 (x, y) 给参与者 id 开菜单；选目标模式里改成去掉一个 */
export function tokenMenu(e: React.MouseEvent, id: string, ui: CombatUi): void {
  e.preventDefault();
  e.stopPropagation();
  if (ui.aim) { combat.aimUnpick(id); return; }
  open = { id, x: e.clientX, y: e.clientY };
  emit();
}
const close = () => { if (open) { open = null; emit(); } };

export function TokenMenu({ s, ui, engine, name }: { s: Session; ui: CombatUi; engine: Engine; name: Namer }) {
  const m = useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => open);
  const el = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [conds, setConds] = useState(false);

  useEffect(() => {
    if (!m) return;
    setConds(false);
    const down = (e: MouseEvent) => { if (!el.current?.contains(e.target as Node)) close(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('mousedown', down, true);
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('mousedown', down, true); window.removeEventListener('keydown', key); };
  }, [m]);
  // 放在鼠标处；超出屏幕就往回收
  useLayoutEffect(() => {
    if (!m || !el.current) return;
    const b = el.current.getBoundingClientRect();
    setPos({ x: Math.min(m.x, window.innerWidth - b.width - 8), y: Math.min(m.y, window.innerHeight - b.height - 8) });
  }, [m, conds]);

  if (!m) return null;
  const c = s.state.combatants[m.id];
  if (!c) return null;
  const r = ui.remote;
  const dm = !r || r.role === 'dm';
  const onMap = !!r?.map.tokens[m.id];
  const mine = combat.canControl(m.id);
  const effects = Object.values(s.state.effects).filter((e) => e.bearer === m.id);
  const conditions = engine.rules.keys().filter((k) => k.startsWith('XPHB:condition:'));
  // 身上已有的状态：手动加的按模板认，法术 / 特性带来的按名字认
  const label = (k: string) => k.split(':').pop()!;
  const has = (k: string) => effects.find((e) => e.origin?.ref === k || effectLabel(e.name).cond === label(k));
  const isCond = (e: (typeof effects)[number]) => conditions.some((k) => e.origin?.ref === k || effectLabel(e.name).cond === label(k));
  const act = (f: () => void) => () => { f(); close(); };

  const curAvatar = avatarOf(s, ui, m.id);
  const ctl = c.controller;
  const curOwner = r ? r.owners[ctl] : undefined;
  const linkedCardId = ui.links[m.id];
  const linkedCard = linkedCardId ? getApp().cards[linkedCardId] : undefined;

  return (
    <div ref={el} className="panel menu-pop ctx-menu" style={{ left: pos?.x ?? m.x, top: pos?.y ?? m.y, visibility: pos ? 'visible' : 'hidden' }} onContextMenu={(e) => e.preventDefault()}>
      <div className="menu-head"><b className="serif">{name(m.id)}</b></div>
      <button onClick={act(() => combat.select(m.id))}>选中</button>
      <button onClick={act(() => combat.toggleTarget(m.id))}>{ui.targets.includes(m.id) ? '取消目标' : '设为目标'}</button>
      {(dm || mine) && (
        <>
          <button onClick={() => fileRef.current?.click()}>{curAvatar ? '更换立绘…' : '上传立绘…'}</button>
          <input
            ref={fileRef} type="file" accept="image/*" hidden
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (!f) return;
              const targetId = m.id;
              close();
              try {
                const dataUrl = await cropAvatarFile(f);
                combat.setAvatar(targetId, dataUrl);
              } catch { combat.toast('无法读取该图片'); }
            }}
          />
          {curAvatar && <button onClick={act(() => combat.setAvatar(m.id, null))}>清除立绘</button>}
        </>
      )}
      {r && dm && c.kind === 'pc' && curOwner != null && (
        <button onClick={act(() => {
          combat.setOwner(ctl, null);
          if (linkedCardId && getApp().cards[linkedCardId]) actions.update(linkedCardId, (ch) => { ch.dmControlled = true; });
        })} title="将该角色绑定给 DM 控制，不用每次点 DM 代答">绑定 DM（常驻接管）</button>
      )}
      {r && dm && c.kind === 'pc' && curOwner == null && linkedCard?.owner && linkedCard.owner.id !== r.me && (
        <button onClick={act(() => {
          combat.setOwner(ctl, linkedCard.owner!.id);
          actions.update(linkedCardId!, (ch) => { ch.dmControlled = false; });
        })}>交还 {linkedCard.owner.name} 操控</button>
      )}
      {dm && <button onClick={() => setConds(!conds)}>状态{effects.length ? `（${effects.length}）` : ''} {conds ? '▴' : '▾'}</button>}
      {dm && conds && (
        <div className="ctx-conds">
          {effects.filter((e) => !isCond(e)).map((e) => (
            <button key={e.id} className="on" title="移除" onClick={() => combat.dispatch(e.key === 'concentration' ? { type: 'endConcentration', id: m.id } : { type: 'removeEffect', id: e.id })}>
              {e.key === 'concentration' ? `专注·${e.name}` : e.name} ✕
            </button>
          ))}
          {conditions.map((k) => {
            const e = has(k);
            const t = termOfKey(k);
            return (
              <button key={k} className={e ? 'on' : ''} onClick={() => combat.dispatch(e ? { type: 'removeEffect', id: e.id } : { type: 'applyEffect', to: m.id, template: k })}>
                {t ? <Term {...t} inButton>{label(k)}</Term> : label(k)}{e ? ' ✕' : ''}
              </button>
            );
          })}
        </div>
      )}
      {r && onMap && (dm || mine) && (
        <button onClick={act(() => {
          if (!confirm(`把 ${name(m.id)} 拿下地图？（人还在遭遇里，之后可以再放上来）`)) return;
          combat.patchMap((mp) => { delete mp.tokens[m.id]; });
          void combat.map({ action: 'token', id: m.id, x: null });
        })}>拿下地图</button>
      )}
      {r && dm && <button onClick={act(() => combat.setHidden(m.id, !r.hidden.includes(m.id)))}>{r.hidden.includes(m.id) ? '亮出来（玩家看得到）' : '藏起来（玩家看不到）'}</button>}
    </div>
  );
}

