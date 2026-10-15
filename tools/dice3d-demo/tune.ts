import { configureDice, DEFAULT_DICE_OPTIONS, type DiceOptions } from '../../app/lib/dice3d';

// demo 用的参数面板：每个控件改一个参数，立刻 configureDice，并把改过的参数整理成 JSON 显示出来

type Group = 'camera' | 'lighting' | 'look' | 'timing' | 'physics';

interface Ctl {
  group: Group;
  key: string;
  label: string;
  kind: 'range' | 'check' | 'select';
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
  /** 会改变滚法：多人同步时各端要一致 */
  sync?: boolean;
  /** 默认值（DEFAULT_DICE_OPTIONS 里没有直接对应的，比如 shadowOpacity、dieScale） */
  def?: number | boolean | string;
}

const CONTROLS: Ctl[] = [
  { group: 'camera', key: 'fov', label: '视场角 °', kind: 'range', min: 1, max: 90, step: 1 },
  { group: 'camera', key: 'tilt', label: '倾斜 °', kind: 'range', min: 0, max: 80, step: 1 },
  { group: 'camera', key: 'fill', label: '占屏比例', kind: 'range', min: 0.2, max: 1, step: 0.01 },
  { group: 'lighting', key: 'ambient', label: '环境光', kind: 'range', min: 0, max: 5, step: 0.1 },
  { group: 'lighting', key: 'sun', label: '主光', kind: 'range', min: 0, max: 6, step: 0.1 },
  { group: 'lighting', key: 'shadowOpacity', label: '影子浓度', kind: 'range', min: 0, max: 1, step: 0.01, def: 0.28 },
  { group: 'look', key: 'roughness', label: '粗糙度', kind: 'range', min: 0, max: 1, step: 0.01 },
  { group: 'look', key: 'droppedBrightness', label: '弃骰亮度', kind: 'range', min: 0, max: 1, step: 0.01 },
  { group: 'look', key: 'droppedOpacity', label: '弃骰不透明', kind: 'range', min: 0, max: 1, step: 0.01 },
  { group: 'look', key: 'maxPixelRatio', label: '分辨率上限', kind: 'range', min: 0.5, max: 4, step: 0.25 },
  {
    group: 'look',
    key: 'labelPosition',
    label: 'label 位置',
    kind: 'select',
    options: ['top-left', 'top-right', 'bottom-left', 'bottom-right'],
  },
  { group: 'timing', key: 'maxRollMs', label: '最长滚动 ms', kind: 'range', min: 500, max: 6000, step: 100 },
  { group: 'timing', key: 'holdMs', label: '停留 ms', kind: 'range', min: 0, max: 5000, step: 100 },
  { group: 'timing', key: 'skipHoldMs', label: '跳过后停留', kind: 'range', min: 0, max: 3000, step: 50 },
  { group: 'timing', key: 'dimMs', label: '变暗 ms', kind: 'range', min: 0, max: 2000, step: 50 },
  { group: 'timing', key: 'fadeMs', label: '淡出 ms', kind: 'range', min: 0, max: 2000, step: 50 },
  { group: 'physics', key: 'tableWidth', label: '桌面宽', kind: 'range', min: 6, max: 60, step: 0.5, sync: true },
  { group: 'physics', key: 'tableDepth', label: '桌面纵深', kind: 'range', min: 4, max: 40, step: 0.5, sync: true },
  { group: 'physics', key: 'tableGrow', label: '桌面随数量放大', kind: 'check', sync: true },
  { group: 'physics', key: 'dieScale', label: '骰子大小', kind: 'range', min: 0.3, max: 3, step: 0.05, sync: true, def: 1 },
  { group: 'physics', key: 'layFlat', label: '最后放平', kind: 'check', sync: true },
  { group: 'physics', key: 'maxDice', label: '最多颗数', kind: 'range', min: 1, max: 60, step: 1 },
];

const TITLES: Record<Group, string> = {
  camera: '镜头',
  lighting: '灯光',
  look: '外观',
  timing: '时长',
  physics: '物理（⚠ 改变滚法，多人时各端要一致）',
};

function defaultOf(c: Ctl): number | boolean | string {
  if (c.def !== undefined) return c.def;
  return (DEFAULT_DICE_OPTIONS[c.group] as unknown as Record<string, number | boolean | string>)[c.key];
}

/** 改过的参数（只记和默认值不同的） */
let patch: Record<string, Record<string, unknown>> = {};

export function setupTuning(onChange: () => void) {
  const body = document.getElementById('tuneBody')!;
  const out = document.getElementById('tuneOut') as HTMLTextAreaElement;
  const inputs = new Map<Ctl, { input: HTMLInputElement | HTMLSelectElement; value: HTMLElement }>();

  const render = () => {
    out.value = Object.keys(patch).length ? JSON.stringify(patch, null, 2) : '{}';
  };

  const set = (c: Ctl, v: number | boolean | string) => {
    const g = (patch[c.group] ??= {});
    if (v === defaultOf(c)) delete g[c.key];
    else g[c.key] = v;
    if (!Object.keys(g).length) delete patch[c.group];
    configureDice({ [c.group]: { [c.key]: v } } as DiceOptions);
    render();
    onChange();
  };

  let lastGroup: Group | null = null;
  for (const c of CONTROLS) {
    if (c.group !== lastGroup) {
      const h = document.createElement('h2');
      h.textContent = TITLES[c.group];
      body.appendChild(h);
      lastGroup = c.group;
    }
    const row = document.createElement('label');
    row.className = 'ctl';
    const name = document.createElement('span');
    name.textContent = c.label;
    const value = document.createElement('span');
    let input: HTMLInputElement | HTMLSelectElement;
    if (c.kind === 'select') {
      const sel = document.createElement('select');
      for (const o of c.options!) sel.add(new Option(o, o));
      sel.addEventListener('change', () => set(c, sel.value));
      input = sel;
    } else {
      const inp = document.createElement('input');
      inp.type = c.kind === 'check' ? 'checkbox' : 'range';
      if (c.kind === 'range') Object.assign(inp, { min: String(c.min), max: String(c.max), step: String(c.step) });
      inp.addEventListener('input', () => {
        const v = c.kind === 'check' ? inp.checked : Number(inp.value);
        value.textContent = String(v === true ? '开' : v === false ? '关' : v);
        set(c, v);
      });
      input = inp;
    }
    row.append(name, input, value);
    body.appendChild(row);
    inputs.set(c, { input, value });
  }

  const reset = () => {
    patch = {};
    for (const [c, { input, value }] of inputs) {
      const d = defaultOf(c);
      if (input instanceof HTMLInputElement && input.type === 'checkbox') input.checked = d as boolean;
      else input.value = String(d);
      value.textContent = typeof d === 'boolean' ? (d ? '开' : '关') : c.kind === 'select' ? '' : String(d);
    }
    render();
  };
  reset();

  document.getElementById('tuneReset')!.addEventListener('click', () => {
    reset();
    onChange();
  });
}

/** 当前改过的参数，用来重新挂载时带上 */
export function tunedOptions(): DiceOptions {
  return JSON.parse(JSON.stringify(patch));
}
