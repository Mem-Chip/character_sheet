import { AccountButton } from './components/Account';
import { TermLayer, setTermEngine } from './components/Term';
import { CampaignsPage } from './pages/Campaigns';
import { CombatPage } from './pages/Combat';
import { Library } from './pages/Library';
import { SheetPage } from './pages/Sheet';
import { PALETTES, TERM_DELAYS, WIDTHS, actions, useApp, type Page, type PageWidth, type Palette } from './lib/store';
import { useEngine } from './lib/useSheet';

const NAV: Array<[Page, string]> = [['library', '卡片库'], ['sheet', '人物卡'], ['combat', '战斗'], ['campaigns', '战役']];

export function App() {
  const app = useApp();
  const { engine, error } = useEngine();
  if (engine) setTermEngine(engine);
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">DnD 2024<small>人物卡 · 战斗</small></div>
        <nav className="nav">
          {NAV.map(([k, label]) => (
            <button key={k} aria-current={app.page === k ? 'page' : undefined} onClick={() => actions.go(k)}>{label}</button>
          ))}
        </nav>
        <div className="spacer" />
        {engine?.problems.length ? <span className="warnline" title={engine.problems.join('\n')}>数据有 {engine.problems.length} 处问题</span> : null}
        <select
          className="palette-sel"
          value={TERM_DELAYS.some(([d]) => d === app.termDelay) ? app.termDelay : 'custom'}
          onChange={(e) => {
            if (e.target.value === 'custom') {
              const res = window.prompt('设置鼠标悬停提示延迟（毫秒）：\n- 填 0 为即时\n- 填 -1 为关闭悬停\n- 推荐 200–800 毫秒', String(app.termDelay >= 0 ? app.termDelay : 400));
              if (res !== null) {
                const n = Math.round(Number(res.trim()));
                if (!isNaN(n)) actions.setTermDelay(n);
              }
            } else {
              actions.setTermDelay(Number(e.target.value));
            }
          }}
          aria-label="词条悬浮提示延迟"
          title="鼠标放在词条上多久后显示悬浮窗"
        >
          {TERM_DELAYS.map(([d, label]) => (
            <option key={d} value={d}>
              提示：{label}
            </option>
          ))}
          {!TERM_DELAYS.some(([d]) => d === app.termDelay) && (
            <option value="custom">提示：{app.termDelay}ms (自定义)</option>
          )}
          <option value="custom">自定义时间…</option>
        </select>
        <select className="palette-sel" value={app.width} onChange={(e) => actions.setWidth(e.target.value as PageWidth)} aria-label="页面宽度" title="页面宽度">
          {WIDTHS.map(([k, label]) => <option key={k} value={k}>宽度：{label}</option>)}
        </select>
        <select className="palette-sel" value={app.palette} onChange={(e) => actions.setPalette(e.target.value as Palette)} aria-label="配色" title="配色">
          {PALETTES.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
        </select>
        <button className="btn sm" onClick={() => actions.setTheme(app.theme === 'dark' ? 'light' : 'dark')}>
          {app.theme === 'dark' ? '浅色' : '深色'}
        </button>
        <AccountButton />
      </header>
      <main className="main">
        {error ? <div className="page dangerline">规则数据装载失败：{error}</div>
          : !engine ? <div className="page empty">正在装载规则数据…</div>
            : app.page === 'library' ? <Library />
              : app.page === 'sheet' ? <SheetPage engine={engine} />
                : app.page === 'campaigns' ? <CampaignsPage />
                  : <CombatPage engine={engine} />}
      </main>
      <TermLayer />
    </div>
  );
}
