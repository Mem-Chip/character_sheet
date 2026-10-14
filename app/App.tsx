import { AccountButton } from './components/Account';
import { CampaignsPage } from './pages/Campaigns';
import { CombatPage } from './pages/Combat';
import { Library } from './pages/Library';
import { SheetPage } from './pages/Sheet';
import { actions, useApp, type Page } from './lib/store';
import { useEngine } from './lib/useSheet';

const NAV: Array<[Page, string]> = [['library', '卡片库'], ['sheet', '人物卡'], ['combat', '战斗'], ['campaigns', '战役']];

export function App() {
  const app = useApp();
  const { engine, error } = useEngine();
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
    </div>
  );
}
