/**
 * 自动填写起始装备弹窗：
 * - 按照 2024 (XPHB) 规则，让玩家选择职业（A/B/C）与背景（A/B）的起始装备包
 * - 支持自选工具/乐器/赌具的下拉选取
 * - 实时预览包含物品与金币，支持「追加」或「清空覆盖」
 */
import { useEffect, useState } from 'react';
import type { CharData } from '../../src/sheet';
import {
  applyStartingEquipment,
  getStartingEquipmentOptions,
  type StartingEquipmentPackage,
  type StartingEquipmentResult,
} from '../../src/sheet';
import type { Engine } from '../lib/engine';
import { actions } from '../lib/store';
import { Dialog, Tag } from './ui';
import { Term } from './Term';

interface Props {
  engine: Engine;
  id: string;
  char: CharData;
  onClose: () => void;
  onApplied?: (msg: string) => void;
}

export function StartingEquipmentDialog({ engine, id, char, onClose, onApplied }: Props) {
  const className = char.startingClass || char.classes?.[0]?.name;
  const bgName = char.background;

  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<StartingEquipmentResult | null>(null);

  const [classOpt, setClassOpt] = useState('A');
  const [bgOpt, setBgOpt] = useState('A');
  const [classPicks, setClassPicks] = useState<Record<number, string>>({});
  const [bgPicks, setBgPicks] = useState<Record<number, string>>({});
  const [mode, setMode] = useState<'append' | 'replace'>('append');

  useEffect(() => {
    let alive = true;
    setLoading(true);
    getStartingEquipmentOptions(engine.env, className, bgName)
      .then((res) => {
        if (!alive) return;
        setData(res);
        // 初始化自选项默认值
        const curClassPkg = res.classPackages[0];
        if (curClassPkg) {
          const cp: Record<number, string> = {};
          curClassPkg.items.forEach((it, idx) => {
            if (it.placeholder && it.options?.length) cp[idx] = it.options[0];
          });
          setClassPicks(cp);
        }
        const curBgPkg = res.backgroundPackages[0];
        if (curBgPkg) {
          const bp: Record<number, string> = {};
          curBgPkg.items.forEach((it, idx) => {
            if (it.placeholder && it.options?.length) {
              // 优先匹配已有的工具熟练
              const toolMatch = it.options.find((o) => (char.tools || []).includes(o));
              bp[idx] = toolMatch || it.options[0];
            }
          });
          setBgPicks(bp);
        }
        setLoading(false);
      })
      .catch(() => alive && setLoading(false));

    return () => { alive = false; };
  }, [engine, className, bgName]);

  const curClassPkg = data?.classPackages.find((p) => p.opt === classOpt) ?? null;
  const curBgPkg = data?.backgroundPackages.find((p) => p.opt === bgOpt) ?? null;

  const totalGold = (curClassPkg?.gold || 0) + (curBgPkg?.gold || 0);
  const totalItemsCount = (curClassPkg?.items.length || 0) + (curBgPkg?.items.length || 0);

  const handleClassOptChange = (opt: string) => {
    setClassOpt(opt);
    const pkg = data?.classPackages.find((p) => p.opt === opt);
    if (pkg) {
      const cp: Record<number, string> = {};
      pkg.items.forEach((it, idx) => {
        if (it.placeholder && it.options?.length) cp[idx] = it.options[0];
      });
      setClassPicks(cp);
    }
  };

  const handleBgOptChange = (opt: string) => {
    setBgOpt(opt);
    const pkg = data?.backgroundPackages.find((p) => p.opt === opt);
    if (pkg) {
      const bp: Record<number, string> = {};
      pkg.items.forEach((it, idx) => {
        if (it.placeholder && it.options?.length) {
          const toolMatch = it.options.find((o) => (char.tools || []).includes(o));
          bp[idx] = toolMatch || it.options[0];
        }
      });
      setBgPicks(bp);
    }
  };

  const apply = () => {
    let resultNote = '';
    actions.update(id, (c) => {
      const res = applyStartingEquipment(c, curClassPkg, classPicks, curBgPkg, bgPicks, mode);
      resultNote = res.note;
    });
    onApplied?.(resultNote);
    onClose();
  };

  const renderPackagePreview = (
    pkg: StartingEquipmentPackage | null,
    picks: Record<number, string>,
    onPickChange: (idx: number, val: string) => void
  ) => {
    if (!pkg) return null;
    return (
      <div className="pkg-preview" style={{ marginTop: 8, padding: '8px 10px', background: 'var(--panel-2, rgba(0,0,0,0.03))', borderRadius: 4 }}>
        <div className="row" style={{ flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          {pkg.items.map((it, idx) => {
            if (it.placeholder && it.options?.length) {
              return (
                <span key={idx} className="chip" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <span>{it.name}：</span>
                  <select
                    value={picks[idx] ?? it.options[0]}
                    onChange={(e) => onPickChange(idx, e.target.value)}
                    style={{ fontSize: 12, padding: '1px 4px' }}
                  >
                    {it.options.map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                </span>
              );
            }
            return (
              <span key={idx} className="chip">
                <Term kind="item" name={it.name} inButton>{it.name}</Term>
                {it.qty > 1 && <b className="tiny"> ×{it.qty}</b>}
                {it.equipped && <small className="faint"> (装备)</small>}
              </span>
            );
          })}
          {pkg.gold > 0 && <Tag tone="accent">+{pkg.gold} GP</Tag>}
          {!pkg.items.length && pkg.gold > 0 && <span className="small faint">（全金币方案，不带装备）</span>}
        </div>
      </div>
    );
  };

  return (
    <Dialog
      title="一键填写起始装备 (2024 XPHB)"
      onClose={onClose}
      footer={<>
        <span className="small" style={{ marginRight: 'auto' }}>
          合计：<b>{totalItemsCount}</b> 样物品，<b>+{totalGold}</b> 金币 (GP)
        </span>
        <button className="btn" onClick={onClose}>取消</button>
        <button className="btn primary" disabled={loading || (!curClassPkg && !curBgPkg)} onClick={apply}>
          确认填入
        </button>
      </>}
    >
      <div className="stack" style={{ gap: 14 }}>
        {loading && <div className="empty">正在读取起始装备规则数据…</div>}

        {!loading && (
          <>
            {/* 职业起始装备 */}
            <section>
              <div className="spread" style={{ marginBottom: 6 }}>
                <b>职业：{className || '未选择'}</b>
                {!className && <span className="warnline tiny">请先在「职业」中选定起始职业</span>}
              </div>
              {data?.classPackages.length ? (
                <>
                  <div className="row" style={{ gap: 6 }}>
                    {data.classPackages.map((p) => (
                      <button
                        key={p.opt}
                        type="button"
                        className={'btn sm' + (classOpt === p.opt ? ' on' : '')}
                        onClick={() => handleClassOptChange(p.opt)}
                      >
                        {p.label} {p.gold > 0 && `(+${p.gold}GP)`}
                      </button>
                    ))}
                  </div>
                  {curClassPkg?.entries && <div className="tiny faint" style={{ marginTop: 4 }}>{curClassPkg.entries}</div>}
                  {renderPackagePreview(curClassPkg, classPicks, (idx, val) => setClassPicks({ ...classPicks, [idx]: val }))}
                </>
              ) : className ? (
                <div className="small faint">该职业没有可用的 2024 起始装备选项。</div>
              ) : null}
            </section>

            {/* 背景起始装备 */}
            <section style={{ borderTop: '1px solid var(--line)', paddingTop: 10 }}>
              <div className="spread" style={{ marginBottom: 6 }}>
                <b>背景：{bgName || '未选择'}</b>
                {!bgName && <span className="warnline tiny">请先在「身份与出身」中选定背景</span>}
              </div>
              {data?.backgroundPackages.length ? (
                <>
                  <div className="row" style={{ gap: 6 }}>
                    {data.backgroundPackages.map((p) => (
                      <button
                        key={p.opt}
                        type="button"
                        className={'btn sm' + (bgOpt === p.opt ? ' on' : '')}
                        onClick={() => handleBgOptChange(p.opt)}
                      >
                        {p.label} {p.gold > 0 && `(+${p.gold}GP)`}
                      </button>
                    ))}
                  </div>
                  {renderPackagePreview(curBgPkg, bgPicks, (idx, val) => setBgPicks({ ...bgPicks, [idx]: val }))}
                </>
              ) : bgName ? (
                <div className="small faint">该背景没有可用的 2024 起始装备选项。</div>
              ) : null}
            </section>

            {/* 填入模式 */}
            <section style={{ borderTop: '1px solid var(--line)', paddingTop: 10 }}>
              <div className="small faint" style={{ marginBottom: 4 }}>填入模式</div>
              <div className="row" style={{ gap: 14 }}>
                <label className="small" style={{ cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name="eq-mode"
                    value="append"
                    checked={mode === 'append'}
                    onChange={() => setMode('append')}
                  /> 追加到当前背包（保留已有物品，同名自动累加）
                </label>
                <label className="small" style={{ cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name="eq-mode"
                    value="replace"
                    checked={mode === 'replace'}
                    onChange={() => setMode('replace')}
                  /> 清空并重设背包（覆盖已有物品）
                </label>
              </div>
            </section>
          </>
        )}
      </div>
    </Dialog>
  );
}
