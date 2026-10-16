/**
 * 动作栏里不显示的资源（每个参与者一份，存在这台浏览器上）。默认全显示；在动作栏上 ✕ 掉，去「详情」的资源表里加回来。
 */
import { useEffect, useState } from 'react';

const KEY = 'dnd2024-engine:hotres-hidden';
const EV = 'hotres-hidden';

function load(): Record<string, string[]> {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}') as Record<string, string[]>; } catch { return {}; }
}

export function hiddenRes(id: string): string[] {
  return load()[id] ?? [];
}

export function setResHidden(id: string, res: string, hidden: boolean): void {
  const all = load();
  const cur = new Set(all[id] ?? []);
  if (hidden) cur.add(res); else cur.delete(res);
  all[id] = [...cur];
  try { localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* 存不了就只在这次有效 */ }
  window.dispatchEvent(new Event(EV));
}

/** 组件里用：变了会重画 */
export function useHiddenRes(id: string): string[] {
  const [v, setV] = useState(() => hiddenRes(id));
  useEffect(() => {
    setV(hiddenRes(id));
    const on = () => setV(hiddenRes(id));
    window.addEventListener(EV, on);
    return () => window.removeEventListener(EV, on);
  }, [id]);
  return v;
}
