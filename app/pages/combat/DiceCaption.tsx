/** 3D 骰子播放时顶上的提示条：在掷什么（对应的那行日志）。和动画一起消失，也可以手动关 */
import { useSyncExternalStore } from 'react';
import { closeCaption, diceCaption, subscribeCaption } from '../../lib/dicefx';

export function DiceCaption() {
  const c = useSyncExternalStore(subscribeCaption, diceCaption);
  if (!c) return null;
  return (
    <div className="dice-cap" data-dice-noskip>
      <div className="t">{c.title}{c.settled && c.result && <b> → {c.result}</b>}</div>
      {c.settled && c.detail && <div className="d">{c.detail}</div>}
      <button className="tag-x" onClick={closeCaption} title="关掉提示（骰子照样播）">✕</button>
    </div>
  );
}
