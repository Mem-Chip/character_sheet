# 3D 骰子模块需求

给一个 D&D 网页工具（React 19 + Vite + TypeScript）做 3D 掷骰动画。做成独立模块，不依赖项目里的其他代码；我们这边只通过下面的接口调用它。

## 要做什么

收到一个掷骰请求 → 在屏幕上把骰子掷出来 → 停稳后返回每颗骰子的点数。

**结果由谁决定：两种模式都要支持**
1. **指定结果**（主要用法）：请求里已经带了每颗骰子的点数（服务器掷好的，所有玩家必须看到同一个结果），动画只负责「掷出来并且正好停在这个面」。
2. **物理决定**：请求里没带点数，由物理模拟掷出来，停稳后读出朝上的面，作为结果返回。

## 接口

```ts
export interface DiceGroup {
  faces: 4 | 6 | 8 | 10 | 12 | 20 | 100;   // d100 = 一颗十位 d10（00–90）+ 一颗个位 d10
  count: number;                            // 1–20 左右
  /** 指定结果：长度 = count，每颗 1..faces。不给 = 物理决定 */
  values?: number[];
  /** 这一组的颜色（不给用默认）；用来区分优势的两颗、伤害骰等 */
  color?: string;
}

export interface DiceRollRequest {
  groups: DiceGroup[];
  /** 显示在旁边的一行字，比如「F5 的攻击检定（长剑）」，可以不做 */
  label?: string;
}

export interface DiceRollResult {
  /** 和 groups 一一对应，每组每颗的点数 */
  values: number[][];
}

export interface Dice3D {
  /** 掷一次；动画结束（骰子停稳）后 resolve。同时只会有一个请求，新的请求来了可以直接打断旧的 */
  roll(req: DiceRollRequest): Promise<DiceRollResult>;
  /** 立刻清掉桌上的骰子 */
  clear(): void;
  /** 卸载：释放 WebGL 资源、移除监听 */
  destroy(): void;
}

/** 挂到一个容器上（我们会给一个铺满屏幕、pointer-events: none 的透明层） */
export function createDice3D(container: HTMLElement, options?: {
  /** 停稳后骰子留在桌上多久再淡出（毫秒），默认 1500 */
  linger?: number;
  /** 整体速度倍率，1 = 正常 */
  speed?: number;
  /** 关掉音效 */
  muted?: boolean;
}): Dice3D;
```

## 要求

- **指定结果必须准**：返回的 `values` 必须和请求里的 `values` 完全一样，画面上朝上的面也必须是这个数。这是硬要求。（常见做法：先模拟一遍，看自然会停在哪个面，再把骰子的面重新贴图或旋转，使停下的那面就是要的数。）
- d100 要能显示成两颗 d10，读成 1–100（00 + 0 = 100）。
- 一次掷 20 颗以内要流畅；整段动画控制在 1.5–3 秒，太长影响跑团节奏。
- 透明背景，叠在地图上不挡操作（容器本身 `pointer-events: none`，骰子不需要能点）。
- 深色、浅色背景上都看得清。颜色走参数，不要写死在模块里。
- 包体积尽量小。可以用 three.js / cannon-es / 现成的 dice 库（比如 @3d-dice/dice-box），但许可证要允许商用和改，并在文档里写明用了什么。
- 没有 WebGL 的时候：`roll` 直接 resolve（指定结果就原样返回，物理决定就用随机数），不要报错。

## 交付

- 一个目录 `dice3d/`：源码 + `index.ts` 导出上面的 `createDice3D` 和类型。依赖写清楚（npm 包名和版本）。
- 一个独立的演示页（`dice3d/demo.html` 或 Vite 页面）：几个按钮，分别掷 1d20、2d20 指定 [17, 4]、8d6 物理决定、1d100 指定 [37]，能直接看效果。
- 简短说明：怎么接、用了哪些库、已知问题。

## 我们这边怎么用（供参考，不用实现）

- 战斗引擎要掷骰时，服务器先掷好点数，所有人的页面都调用 `roll({ groups: [{ faces: 20, count: 2, values: [17, 4] }] })` 播同一段动画。
- 「实体骰 / 让玩家自己点掷」时，用物理决定模式，把返回的点数交给引擎。
- 日志、结算不等动画，动画只是表现；所以 `roll` 慢一点、被打断都没关系。
