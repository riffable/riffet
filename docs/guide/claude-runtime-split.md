# Claude 驱动拆分方案

[AI 友好工程机制](aif.md) §6 的 P1 项，做法沿用 [Codex 驱动拆分方案](codex-runtime-split.md)。本文定拆分的顺序、边界和验收；每一步可以单独回退。六步已全部完成，结果见 §7；§1、§2 是拆分前的状态。

## 1. 拆分前

| 文件 | 行数 | 说明 |
|---|---|---|
| `apps/server/src/backends/claude/runtime.ts` | 2756 | `ClaudeSessionRuntime`，每个会话一个；75 个字段、104 个方法 |
| `apps/server/src/backends/claude/history.ts` | 1916 | 转录行到事件，不在本方案范围 |

已经拆出的协作对象：`ComposerDriver`、`ClaudeHookOverlay`、`LaunchCrashGuard`、`ReadyGate`、`TranscriptAdoption`、`DeferredSteerInputs`、`ClaudeStepMetering`。它们的接线方式是本方案沿用的约定：构造参数是一个依赖对象，成员全是取值函数和回调，不传 `this`。

与 Codex 拆分前不同的一点：阶段已经是推导值。`session-state.ts` 持有转移（`reduce`、`replay`），`setStatus` 从状态取阶段，调用方传不进阶段。所以这里没有「先把状态改成推导」那一步。

`runtime.ts` 按字段的读写关系分成 8 组：

| 组 | 内容 | 方法数 / 行数 | `setStatus` / `dispatchSignal` 调用 |
|---|---|---|---|
| H 枢纽 | `state`、`current`、`setStatus`、`dispatchSignal`、转移的副作用（`onTurnStarted`、`onTurnEnded`、`onProcess`、`onQueue`） | 留在主类 | — |
| I 交互 | 审批、提问、hook 侧创建与确认、工具回报（`respond`、`createPending`、`confirmHookInteraction`、`cancelPending`） | 20 / 443 | 6 / 2 |
| S 发送 | 发送、回执、CLI 自己的队列、行的认领（`send`、`awaitReceipt`、`claimables`、`bindWebTurn`） | 15 / 317 | 0 / 0 |
| P 停止 | 中断、停后台任务、清输入框（`interrupt`、`stopMainTurn`、`stopBackground`、`stopActivity`） | 9 / 244 | 2 / 1 |
| L 启动 | 启动、终端绑定、配置切换（`start`、`startTui`、`attachTerminal`、`applyPendingConfig`） | 15 / 224 | 1 / 3 |
| R 转录 | 读取、生命周期、活动（`refreshTranscript`、`readTranscript`、`applyLifecycle`） | 8 / 134 | 5 / 3 |
| T 屏幕 | 终端与屏幕轮询、后台任务收敛（`schedulePolling`、`refreshTerminalStatus`、`refreshScreenState`、`convergeBackground`） | 11 / 222 | 3 / 8 |
| K hook | `handleHook`（185 行的分支链）与引导 | 6 / 216 | 3 / 5 |

## 2. 阻碍拆分的耦合

- **转移的副作用扇出到每一组。** `dispatchSignal` 之后的 `onTurnEnded` 要取消待答交互（I）、结算当前发送（S）、收尾压缩（R）；`onProcess` 要清空 CLI 队列（S）、放弃活动（R）、撤下屏幕对话框标记（T）。这些调用留在主类，各组只提供被调用的方法。
- **`setStatus` 反过来读交互组。** 发布状态时要确认状态里的卡片仍有对应的待答请求（读 `pending`）。改成交互组提供的 `has(id)`。
- **I 与 T 互相调用。** 屏幕读取确认一次应答（T 调 I）；工具回报后读一次屏幕、屏幕对话框的应答写 `screenAttention`（I 调 T）。`screenAttention` 决定发布的阶段，归主类持有，各组经 `setScreenAttention` 写；待到的提问 hook 归 T，经 `questionAnnounced`、`questionAsked` 两个方法写。`respondScreenDialog` 归 T。
- **S 与 P 互相调用。** 认领迟到的回合时要停掉它（S 调 P）；停止时要读可认领的发送、清自己的输入（P 调 S）。`clearOwnInput` 随 S，`assertExpectedStop` 以回调注入（`ComposerDriver` 已经这样接）。
- **`PendingSend` 被 R、K 就地修改。** 改成 S 的方法（记回执、记压缩开始、标记提示已见）。
- **`applyLifecycle` 直接写 `state`。** 首次读取要整体重放，不走 `dispatchSignal`。它留在主类。
- **绑定事实被 25 处以上读取。** `terminalId`、`started`、`terminalExited`、`profile` 归 L 持有，其余各组经取值函数读。`refreshTerminalStatus` 是这四项除启动外唯一的写者，随 L 走，不归 T。
- **测试访问私有成员。** `index.test.ts` 经适配器的 `runtimes` 取到运行时后，直接调用或替换 8 个私有成员：`refreshTranscript`、`refreshScreenState`、`screenDialogTask`、`convergeBackground`、`screenConvergenceSupported`、`refreshTerminalStatus`、`pendingSend`、`started`，并读 `state.background`、`state.cliQueue`。`recording.ts` 也调 `refreshTranscript`。对应的组搬出时，主类保留同名成员转给新对象；`screenConvergenceSupported` 必须仍是主类实例上可被替换的方法。

## 3. 目标形态

```
ClaudeSessionRuntime（状态枢纽：状态、发布、转移的副作用、发布的回合）
├─ ClaudeInteractions    I：待答请求、应答、确认            interactions.ts
├─ ClaudeSends           S：发送、回执、队列、认领          sends.ts
├─ ClaudeStops           P：中断与停止                      stops.ts
├─ ClaudeTerminalBinding L：启动、终端绑定、配置切换        binding.ts
├─ ClaudeTranscriptReads R：转录读取与活动                  transcript-reads.ts
├─ ClaudeScreenWatch     T：轮询、屏幕状态、后台收敛        screen-watch.ts
├─ ClaudeHookRoutes      K：hook 按事件名分发               hook-routes.ts
└─ 已有：ComposerDriver、ClaudeHookOverlay、LaunchCrashGuard、ReadyGate、TranscriptAdoption、DeferredSteerInputs、ClaudeStepMetering
```

- 各组持有自己的字段。需要主类的东西以取值函数和回调传入：`status()`、`processOf()`、`mainTurn()`、`session()`、`setStatus`、`dispatchSignal`、`emit`、`noteActivity`、`refreshTranscript`。完整清单在分析记录里，实施每一步时只传该组用到的成员。
- 只有主类改 `state`。各组发信号，不改状态。
- 各组可以持有别的组的引用并读它的字段，改动一律经对方的方法：例如 `PendingSend` 的回执、压缩开始、提示已见只由 S 的方法写。
- `handleHook` 改成按事件名分发的表。原定留在主类；实际留下后主类 935 行，超过 800 行的上限，所以连同各事件的处理一起抽成 `ClaudeHookRoutes`。对所有 hook 都成立的步骤（会话标识核对、活动标记、进程存活）留在分发入口，顺序不变；`matchesTurn` 在分发前取值，因为工具 hook 自己可能开出它所属的回合。

## 4. 步骤

每一步先移动、后整理：移动时函数体除必要的标识符外不改，便于逐行对照。

| 步 | 内容 | 主要风险 | 锁定行为的验证 |
|---|---|---|---|
| 1 | 抽出 `ClaudeInteractions`；`setStatus` 改读 `has(id)`；其他组读 `pending` 的 11 处改成它的查询方法 | 应答与回合结束的先后；`announcedToolUses` 的写者在 hook 分支里 | `approval` 录制场景；`index.test.ts` 的审批与提问用例 |
| 2 | 抽出 `ClaudeSends`，`PendingSend` 的就地修改改成方法 | 行的认领（`claimedRows` 不能丢项）；CLI 队列的回合归属 | `answer`、`tool`、`resume` 场景；`pendingSend` 的两处断言 |
| 3 | 抽出 `ClaudeStops` | `stopMainTurn` 先撤下发布的回合再比对回合标识，顺序不能变 | `interrupt`、`stop-failure` 场景 |
| 4 | 抽出 `ClaudeTerminalBinding`，绑定事实改成只读访问 | 重启后的接管；配置切换的失败回退 | `resume`、`clear` 场景；`index.test.ts` 的切换用例 |
| 5 | 抽出 `ClaudeTranscriptReads` 与 `ClaudeScreenWatch` | 轮询的休眠与唤醒；后台任务收敛 | `subagent`、`compact` 场景；屏幕录制 |
| 6 | `handleHook` 改为分发表，抽出 `ClaudeHookRoutes` | hook 的处理顺序 | 全部场景 |

每步结束时：

- 录制回放与 `index.test.ts` 不改断言就能通过。必须改的只有 §2 列出的私有成员访问，改成访问同名的转发成员。
- `scripts/aif-baseline.json` 里 `runtime.ts` 的数字只降不升。

## 5. 验收

- `runtime.ts` 不超过 800 行，从 `aif-baseline.json` 移除。
- `setStatus` 与 `dispatchSignal` 只在主类定义；各组经注入的回调调用。
- 只有主类写 `state`。

## 6. 不做

- 不改对 Claude Code 的读取与写入行为。录制数据的行在整个过程中保持不变。
- 不改驱动接口（`backends/types.ts`），不和其他后端的运行时合并实现。
- 不拆 `index.test.ts`（3087 行）、`history.ts`、`transcript-source.ts`。

## 7. 进展

每一步之后 `npx vitest run apps/server/src/backends/claude`（13 个文件、325 个用例，含录制回放）不改断言通过；搬出的方法与搬之前逐行对照，差异只有下表列出的几处。

| 步 | 结果 |
|---|---|
| 1 | `ClaudeInteractions`（`interactions.ts`，523 行）；`runtime.ts` 2756 → 2311 |
| 2 | `ClaudeSends`（`sends.ts`，582 行）；发布回合的归属经 `ownPublishedTurn` 写；→ 1873 |
| 3 | `ClaudeStops`（`stops.ts`，361 行）；撤下发布的回合收成 `withdrawPublishedTurn`，仍在比对回合标识之前；→ 1607 |
| 4 | `ClaudeTerminalBinding`（`binding.ts`，437 行），含 `refreshTerminalStatus`；会话记录经 `setSession` 写；→ 1267 |
| 5 | `ClaudeTranscriptReads`（`transcript-reads.ts`，160 行）、`ClaudeScreenWatch`（`screen-watch.ts`，382 行）；→ 879 |
| 6 | `ClaudeHookRoutes`（`hook-routes.ts`，344 行），11 个事件一张表；→ 665，移出基线 |

验收三条都满足：`runtime.ts` 665 行；`setStatus`、`dispatchSignal` 只在主类定义；`state` 只在主类赋值（构造、`dispatchSignal`、`applyLifecycle`）。

留下的：

- `untestedVersion`、`screenConvergenceSupported`、`quiet`、`idleForRelaunch` 留在主类。前两个只读配置，本该随 L，但测试替换的是运行时实例上的 `screenConvergenceSupported`；后两个只读状态。
- 测试与录制器访问的成员（`refreshTranscript`、`refreshScreenState`、`screenDialogTask`、`convergeBackground`、`refreshTerminalStatus`、`pendingSend`、`started`）在主类上是同名转发，测试没有改动。
- 各组的依赖对象里有整组引用（如 P 拿到 S 和 I），不全是取值函数。写入已经收到方法上，读取没有再收窄。
