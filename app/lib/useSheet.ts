/**
 * 角色 → 算出来的 SHEET。在副本上算（计算会往角色上挂 _resolved / _derived），
 * 计算本身改了的建卡字段（子职不足 3 级被摘、起源专长默认值）写回卡库。
 */
import { useEffect, useState } from 'react';
import type { CharData, Json } from '../../src/sheet';
import { loadEngine, type Engine } from './engine';
import { actions, stripDerived } from './store';

export interface Computed {
  char: CharData;
  sheet: Record<string, Json>;
}

export function useEngine(): { engine: Engine | null; error: string | null } {
  const [engine, setEngine] = useState<Engine | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    loadEngine().then((e) => alive && setEngine(e), (e: Error) => alive && setError(e.message));
    return () => { alive = false; };
  }, []);
  return { engine, error };
}

export function useComputed(engine: Engine | null, id: string | null, char: CharData | null): Computed | null {
  const [out, setOut] = useState<Computed | null>(null);
  useEffect(() => {
    if (!engine || !char || !id) { setOut(null); return; }
    let alive = true;
    (async () => {
      const work = structuredClone(stripDerived(char));
      let sheet = await engine.env.compute(work);
      if (engine.env.applyOriginFeatDefault(work)) sheet = await engine.env.compute(work);
      if (!alive) return;
      const before = JSON.stringify(stripDerived(char));
      const after = JSON.stringify(stripDerived(work));
      if (before !== after) actions.replace(id, work);   // 会再触发一次计算，结果相同就停下
      setOut({ char: work, sheet });
    })().catch((e) => console.error('计算失败', e));
    return () => { alive = false; };
  }, [engine, id, char]);
  return out;
}
