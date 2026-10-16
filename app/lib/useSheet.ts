/**
 * 角色 → 算出来的 SHEET。在副本上算（计算会往角色上挂 _resolved / _derived），
 * 计算本身改了的建卡字段（子职不足 3 级被摘、起源专长默认值）写回卡库。
 */
import { useEffect, useState } from 'react';
import type { CharData, Json } from '../../src/sheet';
import { loadEngine, type Engine } from './engine';
import { loadLibrary, tagCampaign, useLibraryVersion } from './library';
import { actions, getApp, stripDerived } from './store';

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
  // 战役资料（启用的书、本团家规）或我自己的库变了都要重算
  const hubV = useLibraryVersion();
  useEffect(() => {
    if (!engine || !char || !id) { setOut(null); return; }
    let alive = true;
    (async () => {
      const work = structuredClone(stripDerived(char));
      // 我自己的资料库是卡面的第 3 层，算之前先确保取到了
      await loadLibrary();
      await tagCampaign(work, getApp().cards[id]?.campaignId);
      let sheet = await engine.env.compute(work);
      if (engine.env.applyOriginFeatDefault(work)) sheet = await engine.env.compute(work);
      delete (work as { _campaign?: string })._campaign;
      if (!alive) return;
      const before = JSON.stringify(stripDerived(char));
      const after = JSON.stringify(stripDerived(work));
      if (before !== after) actions.replace(id, work);   // 会再触发一次计算，结果相同就停下
      setOut({ char: work, sheet });
    })().catch((e) => console.error('计算失败', e));
    return () => { alive = false; };
  }, [engine, id, char, hubV]);
  return out;
}
