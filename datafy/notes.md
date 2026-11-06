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

4. **`damage` 节点校验遗漏 `ignoreResist` / `ignoreImmunity` 字段**：
   - `types.ts` 中 `Node.damage` 定义包含 `ignoreResist` 和 `ignoreImmunity`，但 `src/factory/lint.ts` 的 `NODE_KEYS.damage` 中仅列出 `['dice', 'type', 'id', 'ref', 'scale', 'to']`（而 `NODE_KEYS.addDamage` 包含这两个字段）。这导致在 `damage` 节点直接书写 `ignoreResist: true` 时会被 linter 报错。目前通过在 `text` 中声明人工处理绕过。

5. **偷袭未写入 `action.marks` 且 `minDie` 作用于整包伤害**：
   - `XPHB:游荡者:偷袭:1` 触发时未向 `action.marks` 写入偷袭标记，后续特性（如 R096 恐怖化身「投掷偷袭伤害骰时 1 和 2 视为 3」）无法通过 `action.marks` 无感检测偷袭；且 `minDie` 机制是针对整个伤害包的所有骰子生效，无法单独只对偷袭骰保底。

6. **缺少 `enterReach`（进入近战触及）触发时机**：
   - 引擎目前支持 `leftReach`（离开触及范围借机攻击），但尚无敌人「进入触及范围」的时机（如长柄武器大师、战技「警戒」Brace 等）。目前以主动动作开启反应/附赠动作状态并在下一次攻击触发进行处理。

7. **`allocate` 节点 `total` 字段仅接受 `NUM` 类型**：（**已做**，2026-11-06，见 spec 第 4 节）
   - `src/combat/audit.ts` 中对 `allocate.total` 使用了 `NUM` 类型校验，而未放宽到 `DICE`（如 `heal` / `tempHp` 的 `DICE`）。这导致规则原文中带掷骰的点数池（如圣武士鼓舞斩「合计 2d8 + 圣武士等级点临时生命值分配给多名生物」）在数据化为 `allocate` 时会报错 `这里需要数字，表达式的结果是骰子`。建议将 `audit.ts` 中 `allocate.total` 的期望类型扩展为 `[NUM, DICE]`。

8. **表达式语言缺少字符串子串匹配**：（**已做**，2026-11-06，见 spec 第 4 节）
   - 表达式内置函数 `includes` 仅接受列表（`[T.list(T.any), T.any]`），无法用于字符串包含子串判定（如 `includes(action.name, '吐息')` 会报错）。建议将 `includes` 扩展为支持字符串或提供 `contains(str, substr)`。

9. **`choose` 的法术池仅限已知/已准备法术**：
   - `choose.pool.from` 目前仅支持 `'ownSpells' | 'ownCantrips'`。涉及「从全职业法术列表中临时选择未知法术施展」（如巫术帽）或外部法术书时引擎无法提供动态候选项。

10. **缺少反应反击发动武器攻击机制（`reactionAttack`）**：
    - 如应答之剑（受到伤害后反应对攻击者发动一次具有优势且忽略抗性免疫的近战攻击），引擎目前无法在触发器或反应节点中直接唤起一次完整的武器攻击流程。

11. **豁免动作上下文缺少目标状态信息（`action.save.condition`）**：
    - 针对「避免或结束某状态（如中毒）的豁免具有优势」（如抗毒剂），引擎目前未在 `action` 中暴露豁免针对的 condition 标记，必须通过 `ask(...)` 弹窗向用户确认。

12. **缺少直接设定 d20 结果的修改机制（`setD20`）**：（**已做**，2026-11-06，见 spec 第 4 节）
    - 某些特性或魔法物品（如时计护符）规定「无需投骰，d20 结果直接取 10」，目前窗口 `modify` 仅支持 `reroll`、`addToRoll`、`succeed`、`cancel`，无法直接强制定值。





13. **`resource.delta` 节点仅接受数值类型（NUM）**：（**已做**，2026-11-06，见 spec 第 4 节）
    - 规则中出现「重获 1d4 术法点」等动态骰子恢复资源时，`delta: "1d4"` 会被 linter 判定为 `这里需要数字，表达式的结果是骰子`。目前通过先使用 `number` 节点输入掷骰点数存入变量再赋给 `delta: "vars.pts"` 解决。建议引擎允许 `resource.delta` 接受骰子表达式并自动掷骰。

14. **`rollMods` 检定修正的 `when` 作用域不包含 `damage` 变量**：（**已做**，2026-11-06，见 spec 第 4 节）
    - 在伤害掷骰修正（`on: { kind: 'damage' }`）中，上下文未暴露 `damage` 对象，使用 `damage.type` 会报未定义；必须使用 `action.damage.type` 访问。

15. **缺少「伤害是否来自攻击」的免弹窗判定字段**：（**已做**，2026-11-06，见 spec 第 4 节）
    - 在 `damageIncoming` 窗口中，若直接在 `when` 里写 `attack != null`，在非攻击伤害（如法术豁免伤害）结算时会因缺少上下文报错。建议在 `damage` 对象中挂载 `isAttack: boolean` 字段，避免必须使用 `ask('这次伤害来自一次攻击吗？')` 弹窗。

16. **缺少施法召唤生物参数修改与拦截机制（`modifySummon`）**：
    - 某些职业特性（如「裂分召唤」一化为二生命减半、「强韧召唤」召唤时赋予虚血与抗性、「不死坚韧」增加召唤物生命上限），由于召唤物是由具体法术节点直接实例化的，外部特性无法在法术施展时注入拦截并修改召唤生物的面板数据。

17. **缺少「拦截强制位移」触发窗口（`forcedMove`）**：
    - 规则如「新锻臂铠：比肩而立」要求反应阻止 5 尺内盟友被推离或拉近，但引擎目前在执行 `move` 节点时直接位移目标，缺少在位移生效前触发的 `forcedMove` / `beforeMove` 拦截窗口。
