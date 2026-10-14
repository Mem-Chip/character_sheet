/** 顶栏的账户入口：没登录 = 登录 / 注册；登录了 = 同步状态、改密码、退出 */
import { useState } from 'react';
import { changePassword, login, logout, unsyncedLocalCards, uploadLocal, useSync } from '../lib/sync';
import { Dialog, Field } from './ui';

export function AccountButton() {
  const sync = useSync();
  // 打开时是哪个对话框就一直是哪个：登录成功后还要在同一个对话框里问「本机的卡要不要传」
  const [open, setOpen] = useState<null | 'login' | 'account'>(null);
  if (sync.checking) return null;
  const dot = sync.status === 'error' ? '同步出错' : sync.status === 'syncing' ? '同步中…' : '';
  return (
    <>
      <button className={'btn sm' + (sync.user ? '' : ' primary')} onClick={() => setOpen(sync.user ? 'account' : 'login')} title={sync.message || undefined}>
        {sync.user ? sync.user.name : '登录'}
        {dot && <span className={sync.status === 'error' ? 'dangerline' : 'faint'} style={{ marginLeft: 6 }}>{dot}</span>}
      </button>
      {open === 'account' && sync.user && <AccountDialog onClose={() => setOpen(null)} />}
      {open === 'login' && <LoginDialog onClose={() => setOpen(null)} />}
    </>
  );
}

function LoginDialog({ onClose }: { onClose: () => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [name, setName] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [ask, setAsk] = useState<string[] | null>(null);

  const submit = async () => {
    if (mode === 'register' && pw !== pw2) { setErr('两次密码不一样'); return; }
    setBusy(true); setErr('');
    try {
      await login(name.trim(), pw, mode === 'register');
      const local = unsyncedLocalCards();
      if (local.length) setAsk(local.map((c) => c.id));
      else onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(false); }
  };

  if (ask) {
    return (
      <Dialog title="本机的卡" onClose={() => { uploadLocal(ask, false); onClose(); }} footer={<>
        <button className="btn" onClick={() => { uploadLocal(ask, false); onClose(); }}>先不传</button>
        <button className="btn primary" onClick={() => { uploadLocal(ask, true); onClose(); }}>传到我的账户</button>
      </>}>
        <p style={{ marginTop: 0 }}>这台设备上有 {ask.length} 张卡还没传到账户里。传上去之后，换设备登录也能看到，也能带进战役。</p>
        <p className="small muted" style={{ marginBottom: 0 }}>选「先不传」的卡会留在本机，之后在卡片库里还可以一张张传。</p>
      </Dialog>
    );
  }

  return (
    <Dialog title={mode === 'login' ? '登录' : '注册'} onClose={onClose} footer={<>
      <button className="btn ghost" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setErr(''); }}>
        {mode === 'login' ? '没有账户？注册' : '已有账户？登录'}
      </button>
      <span style={{ flex: 1 }} />
      <button className="btn primary" disabled={busy || !name.trim() || !pw} onClick={() => void submit()}>{mode === 'login' ? '登录' : '注册并登录'}</button>
    </>}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <Field label="名字"><input autoFocus value={name} onChange={(e) => setName(e.target.value)} autoComplete="username" /></Field>
        <Field label="密码"><input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} /></Field>
        {mode === 'register' && <Field label="再输一次"><input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" /></Field>}
        {mode === 'register' && <div className="small muted">不用邮箱，名字就是账户。忘了密码找管理员重置。</div>}
        {err && <div className="dangerline small">{err}</div>}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

function AccountDialog({ onClose }: { onClose: () => void }) {
  const sync = useSync();
  const [old, setOld] = useState('');
  const [pw, setPw] = useState('');
  const [msg, setMsg] = useState('');
  return (
    <Dialog title={sync.user!.name} onClose={onClose} footer={<>
      <button className="btn danger" onClick={() => {
        if (confirm('退出登录？\n服务器上的卡会从这台设备上拿掉（下次登录回来）；只在本机的卡留着。')) void logout().then(onClose);
      }}>退出登录</button>
    </>}>
      <div className="stack">
        <div className="small">
          同步：{sync.status === 'syncing' ? '正在同步…' : sync.status === 'error' ? <span className="dangerline">出错了（{sync.message}），稍后自动重试</span> : '已同步'}
        </div>
        {sync.message && sync.status !== 'error' && <div className="small muted">{sync.message}</div>}
        <details>
          <summary className="small">改密码</summary>
          <div className="stack" style={{ marginTop: 8 }}>
            <Field label="旧密码"><input type="password" value={old} onChange={(e) => setOld(e.target.value)} autoComplete="current-password" /></Field>
            <Field label="新密码"><input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" /></Field>
            <div className="row">
              <button className="btn sm" disabled={!old || pw.length < 4} onClick={() => {
                changePassword(old, pw).then(() => { setMsg('改好了'); setOld(''); setPw(''); }, (e: Error) => setMsg(e.message));
              }}>改密码</button>
              {msg && <span className="small muted">{msg}</span>}
            </div>
          </div>
        </details>
      </div>
    </Dialog>
  );
}
