import { configureDice, mountDice, rollDice, type DieSpec, type RollRequest } from '../../app/lib/dice3d';
import { setupTuning, tunedOptions } from './tune';

// 这里模拟「服务器」：随机出结果，再交给动画去演
const r = (faces: number) => 1 + Math.floor(Math.random() * faces);

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const logEl = $<HTMLPreElement>('#log');
const colorEl = $<HTMLInputElement>('#color');
const useSeedEl = $<HTMLInputElement>('#useSeed');
const seedEl = $<HTMLInputElement>('#seed');

let theme: 'light' | 'dark' = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
let unmount = () => {};
function remount() {
  document.documentElement.dataset.theme = theme;
  unmount();
  unmount = mountDice(document.body, { ...tunedOptions(), theme });
}
remount();
// 「恢复默认」时整个重新挂载，参数回到默认值
setupTuning(() => {
  if (!Object.keys(tunedOptions()).length) remount();
});

function log(text: string) {
  logEl.textContent = `${text}\n${logEl.textContent}`.split('\n').slice(0, 30).join('\n');
}

/** 按点数从高到低取 keep 颗，其余标 dropped */
function keepHighest(faces: DieSpec['faces'], count: number, keep: number, color: string): DieSpec[] {
  const dice: DieSpec[] = Array.from({ length: count }, () => ({ faces, value: r(faces), color }));
  const order = dice.map((_, i) => i).sort((a, b) => dice[b].value - dice[a].value);
  order.slice(keep).forEach((i) => (dice[i].dropped = true));
  return dice;
}

function build(kind: string): RollRequest[] {
  const color = colorEl.value;
  switch (kind) {
    case 'd20':
      return [{ dice: [{ faces: 20, value: r(20), color }], label: 'F5 的攻击' }];
    case 'adv':
      return [{ dice: keepHighest(20, 2, 1, color), label: '优势检定' }];
    case '8d6':
      return [{ dice: Array.from({ length: 8 }, () => ({ faces: 6 as const, value: r(6), color })), label: '火球术伤害' }];
    case '4d6':
      return [{ dice: keepHighest(6, 4, 3, color), label: '属性：4d6 取高 3' }];
    case 'd100':
      return [{ dice: [{ faces: 100, value: r(100), color }], label: '百分骰' }];
    case 'all':
      return [
        {
          dice: ([4, 6, 8, 10, 12, 20, 100] as const).map((faces, i) => ({
            faces,
            value: r(faces),
            color: ['#c0392b', '#e67e22', '#f1c40f', '#27ae60', '#2980b9', '#8e44ad', '#ecf0f1'][i],
          })),
          label: '全部种类',
        },
      ];
    case '20d20':
      return [{ dice: Array.from({ length: 20 }, () => ({ faces: 20 as const, value: r(20), color })), label: '20d20' }];
    case 'queue':
      return [
        { dice: [{ faces: 20, value: r(20), color: '#c0392b' }], label: '玩家 A' },
        { dice: [{ faces: 20, value: r(20), color: '#27ae60' }], label: '玩家 B' },
        { dice: [{ faces: 20, value: r(20), color: '#2980b9' }], label: '玩家 C' },
      ];
  }
  return [];
}

const describe = (d: DieSpec) => `d${d.faces}=${d.value}${d.dropped ? '(弃)' : ''}`;

document.querySelectorAll<HTMLButtonElement>('[data-roll]').forEach((btn) =>
  btn.addEventListener('click', () => {
    for (const req of build(btn.dataset.roll!)) {
      if (useSeedEl.checked) req.seed = Number(seedEl.value) || 0;
      log(`${req.label ?? ''}: ${req.dice.map(describe).join(' ')}`);
      const t = performance.now();
      rollDice(req).then(() => log(`  ↳ ${req.label} 播完 (${Math.round(performance.now() - t)}ms，含排队)`));
    }
  }),
);

$('#theme').addEventListener('click', () => {
  theme = theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  configureDice({ theme });
});

document.querySelectorAll<HTMLElement>('.token').forEach((t) =>
  t.addEventListener('click', () => log(`点到了棋子 ${t.textContent}（覆盖层没挡住）`)),
);

// 方便在控制台里手动调
Object.assign(window, { rollDice, configureDice });
