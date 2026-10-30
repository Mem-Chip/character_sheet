/** 战役遭遇顶栏的音乐条：DM 共享 / 停止；玩家调音量、静音、（浏览器挡住时）点一下开始听 */
import { Tag } from '../../components/ui';
import { music, useMusic } from '../../lib/music';

export function MusicBar(p: { dm: boolean }) {
  const m = useMusic();
  return (
    <span className="music-bar">
      {p.dm && !m.hosting && (
        <button className="btn sm" onClick={() => void music.start()} title="选一个标签页（勾上「同时共享标签页音频」），那个标签页放的声音大家都能听到">
          ♪ 共享音乐
        </button>
      )}
      {m.hosting && (
        <>
          <Tag tone="accent">♪ 共享中 · {m.listeners} 人在听</Tag>
          <button className="btn sm" onClick={() => music.stop()}>停止共享</button>
        </>
      )}
      {!m.hosting && m.from && (
        m.blocked
          ? <button className="btn sm" onClick={() => music.resume()}>♪ {m.from} 在放音乐，点这里开始听</button>
          : (
            <>
              <button className="btn ghost sm" onClick={() => music.setMuted(!m.muted)} title={m.muted ? '打开声音' : '静音'}>
                ♪ {m.muted ? '已静音' : m.from}
              </button>
              <input
                type="range" min={0} max={1} step={0.05} value={m.volume} aria-label="音乐音量"
                onChange={(e) => music.setVolume(Number(e.target.value))}
              />
            </>
          )
      )}
      {m.error && <Tag tone="warn" onRemove={() => music.clearError()}>{m.error}</Tag>}
    </span>
  );
}
