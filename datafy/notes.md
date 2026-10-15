# 数据化注意事项与引擎改进建议 (notes.md)

## 1. 测试运行超时注意事项

- **`tests/bridge/integration.test.ts` 默认超时**：
  - 测试用例「每条动态数据的键都对得上站点数据里真实的法术 / 特性 / 专长 / 种族（名字写错就永远不会生效）」会异步遍历校验所有 698 条动态数据键。
  - 在生成完全量法术（`data/dyn/ai/spells.json` 278 条）后，条目总量由原来的约 400 条增至 698 条，耗时约为 6.5s ~ 7.8s，略超过 vitest 默认的 5000ms 超时阈值。
  - 使用 `npx vitest run --testTimeout 15000` 运行，全套 156 个单元测试全部通过（156 passed, 0 failed）。
  - **建议**：在 `tests/bridge/integration.test.ts` 的该用例后加上超时配置 `{ timeout: 15000 }` 或在 `vite.config.ts` 中将测试全局超时设置为 15s。

## 2. 规则引擎能力与写法细节记录

1. **`turnStarted` 时机上下文无 `target`**：
   - 在 `turnStarted` 触发器中，执行上下文是回合主人（`self`），不存在 `target`。因此不能在该时机下直接挂载默认作用于目标的 `save` 节点。
   - 解决方案：使用 `Duration.saveEnds: { ability: '...', dc: 'self.spell.dc', at: 'turnStart' | 'turnEnd' }`，引擎会通过 `saveEndsCheck` 正确读取并结算摆脱豁免。

2. **多阶段/多回合主动动作（`use`）在沙盒测试中的处理**：
   - 战斗试算（`smoke.ts`）在初次遍历所有主动 action 时会以 `force: true` 运行，此时可能尚未施放 `cast` 动作，因此 `self.effect(...)` 实例可能尚未挂载。
   - 针对 `use` 类二次攻击动作的骰数，建议基数写直接数值（如 `3d6`、`5d8`），在 `text` 中说明升环加骰规则，避免读取不存在的 `effect.state` 抛出 undefined。

3. **区域与空间移动机制**：
   - 涉及复杂空间几何、穿过墙体判定、持续地形推拉（如火墙术、浓酸球、刃障等）的法术，标准采用 `automation: "partial"` 并通过 `note` 或 `text` 给出明确的人工指引，保证模拟战斗沙盒与实际对战零崩溃。
