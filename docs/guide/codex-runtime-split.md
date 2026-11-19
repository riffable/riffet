# Codex 驱动拆分方案

[AI 友好工程机制](aif.md) §6 的 P0 项。本文只定拆分的顺序、边界和验收，评审通过后按步骤实施；每一步单独提交，可以单独回退。

## 1. 现状

| 文件 | 行数 | 90 天提交 | 说明 |
|---|---|---|---|
| `apps/server/src/backends/codex/runtime.ts` | 3934 | 74 | `CodexSessionRuntime`，每个会话一个，约 120 个字段 |
| `apps/server/src/backends/codex/index.ts` | 1515 | — | `CodexBackendAdapter`，驱动接口的实现 |

上一次拆分（ab3a291）已经把无状态的计算移成函数，把只被自己方法访问的两组字段移成对象（`CodexContextMeter`、`CodexHistoryReader`），宿主能力用注入的取值函数传入。本方案沿用这个做法。

`runtime.ts` 按字段的读写关系分成以下几组（行号为当前版本）：

| 组 | 内容 | 约行数 | 近 40 次提交的改动块 |
|---|---|---|---|
| A 连接 | 启动、连接、重启、端点归属、切换配置（`start`、`restartBackend`、`syncSessionBinding`、`onExit`） | 700 | 最热：0–1000 行区间合计 137 个改动块 |
| B 线程 | 打开或恢复线程、常驻配置、已加载线程的归属（`openOrResume`、`attachLoadedOwner`） | 330 | 同上 |
| C 终端 | TUI 启动与端点确认（`ensureTui`、`terminalEndpointState`） | 290 | 43 |
| D 回合 | 发送、插话、打断、斜杠命令、回合结局（`send`、`steer`、`interrupt`、`emitTurnOutcome`） | 700 | 较冷：约 24 |
| E 通知分发 | `onNotification`（单个约 250 行的分支链）、`onChildNotification` | 330 | 52（与 G 合计） |
| F 交互 | 审批、提问、异步问题、模式变更请求（`respond`、`onServerRequest`） | 600 | 冷：13 |
| G 历史与日志 | 读取历史、导入、写日志、事件编号、轮询 | 1000 | 与 E 合计 52 |
| H 状态 | `setStatus`、提示、线程错误 | 250 | — |
| I 设置 | 审批、模式、模型、目标、标题 | 350 | 冷：约 18 |

## 2. 阻碍拆分的耦合

- **状态由各处手工拼出**。`setStatus(` 有 37 处调用，分布在 A、B、C、D、E、F、H、I 各组。其中 `phase: this.interaction ? 'attention' : this.activeTurnId ? 'busy' : 'idle'` 这个表达式手写了 7 次，另有 6 处 `setStatus({ ...this.status })` 只是为了触发重算。状态本来可以从各组持有的事实推出：连接是否在线、当前回合、待答的交互、设置、提示。现在各组却各自写一份完整的状态，任何一组被拆出去都要带走对其他组字段的读取。
- **当前回合散在三组**。`activeTurnId` 有 8 处直接赋值，分布在 D、E、G；与它同义的 `dispatchCommandId`、`foregroundEndedTurnId` 还有约 20 处写入。
- **待答交互**。`interaction`、`pending` 由 F 写入，但在 E（`settleServerRequest`）、D（回合结束清理）、A（`onExit`、`dispose`）里也被改写。
- **适配器替运行时编排生命周期**。`index.ts` 的 `applyProfileSwitch`（410–480）自己创建替换用的运行时，并编排启动、释放、恢复、重新挂终端和失败回退；`ensureRuntime`（1354–1426）直接读运行时的 `transport`、`status`、`activeTurnId` 来决定复用还是重建。这些都属于 A 组，却放在适配器里，因此两个文件总是一起改。

变更耦合的数字要按提交类型看：

- `index.ts` 与 `backends/service.ts` 共同修改的提交大多是 `feat`。这说明新功能要穿过驱动接口改到每个后端，接口过宽本身不是缺陷。
- Codex 与 droid、dsh 的 runtime 同改，多数是跨后端的功能和改名（同步 v3 切换、目标、标题、空间下线），而不是一套漏抽的公共机制。

所以本方案不动驱动接口，也不和其他后端合并实现。驱动接口留给 §6 的 P1「后端公共层」。

## 3. 目标形态

```
CodexSessionRuntime（协调者：持有各组对象，分发通知，推导状态）
├─ CodexConnection     A：传输、端点、启动与重启、配置切换       ≤ 800 行
├─ CodexTerminal       C：TUI 启动与端点确认                     ≤ 400 行
├─ CodexThread         B：打开或恢复线程、常驻配置、归属         ≤ 400 行
├─ CodexTurns          D：发送、插话、打断、命令、回合结局       ≤ 800 行
├─ CodexInteractions   F：审批、提问、模式变更请求               ≤ 700 行
├─ CodexHistoryReader  G：已存在；读取、导入、编号移入           ≤ 800 行
└─ 已有：CodexContextMeter、CodexSubagents、CodexDraftStream、CodexActivities、CodexTurnMetering
```

- **状态改为推导**。各组只维护自己的事实（例如连接组的 `online`、`connection`，回合组的 `activeTurnId`，交互组的 `current`）。运行时的 `refreshStatus()` 从这些事实算出 `NativeStatus`，由一处计算 phase，各组需要更新状态时只调用 `refreshStatus()`。这和 `backends/` 模块「会话状态只由证据推出」的不变量是同一个原则，落到驱动内部。提示（notice）是唯一需要显式写入的部分，保留 `showNotice(text, level, source)`。
- **当前回合只有一个所有者**。`activeTurnId`、`dispatchCommandId`、`foregroundEndedTurnId` 归 `CodexTurns`，其他组通过它的方法改变回合，不直接赋值。
- **通知分发变成表**。`onNotification` 按方法名转给各组的处理函数，自身只保留排序（`NotificationGate`）和分发。
- **生命周期回到运行时一侧**。`applyProfileSwitch`、`ensureRuntime` 的判断移进 `CodexConnection`，适配器只调用。
- 各组按 ab3a291 的方式构造：类持有自己的字段，需要的运行时能力以取值函数和回调传入，不传 `this`。

## 4. 步骤

每一步先移动、后整理：移动时函数体除必要的标识符外不改，便于评审逐行对照；整理放在同一步的第二个提交里。

| 步 | 内容 | 主要风险 | 锁定行为的验证 |
|---|---|---|---|
| 0 | 补录制：恢复（第二次启动同一线程）、切换配置后继续、App Server 退出后重连 | 场景需要宿主能重启运行时 | `recordings.test.ts` |
| 1 | 状态推导：引入各组事实与 `refreshStatus()`，37 处调用改为更新事实再刷新 | 提示的来源与清除时机（`noticeSource`） | 录制回放的行不变；`index.test.ts` 不改断言 |
| 2 | 抽出 `CodexTurns`，收拢当前回合的三个字段 | 斜杠命令的回合归属 | 同上，外加 `interrupt`、`two-turns` 场景 |
| 3 | 抽出 `CodexConnection` 与 `CodexTerminal`，把适配器里的生命周期编排移入 | 最热的区域，切换配置的失败回退 | 第 0 步的场景；`index.test.ts` 的切换与恢复用例 |
| 4 | 抽出 `CodexThread`、`CodexInteractions` | 审批答复与回合结束的先后 | `approval` 场景 |
| 5 | `onNotification` 改为分发表；G 组剩余部分移入 `CodexHistoryReader` | 通知顺序 | 全部场景 |

每步结束时：

- 录制回放与 `index.test.ts` 不更新快照、不改断言就能通过；如果必须改，说明行为变了，要单独说明原因。
- `aif-baseline.json` 里对应文件的数字只降不升，降到 800 以下就删掉这一项。

## 5. 验收

- `codex/` 下没有超过 800 行的非测试文件，`aif-baseline.json` 里 Codex 的三项（`runtime.ts`、`index.ts`、`transcript-source.ts`）都删除。`transcript-source.ts` 不在本方案范围内，单独评估。
- `setStatus` 之外不再有拼完整状态的调用；phase 只在一处计算。
- 拆分完成后 30 天，`codex` 模块的返工率低于拆分前的 44%（81 个提交中 36 个是 fix）。

## 6. 不做

- 不改 App Server 协议的处理逻辑和对外行为。录制数据的行在整个过程中保持不变。
- 不改驱动接口（`backends/types.ts`），不和 Claude、droid、dsh 的运行时合并实现。
- 不拆测试文件。`index.test.ts`（5508 行）随实现迁移时再按组分文件。

## 7. 评审结论（2026-11-19）

1. 先做第 1 步（状态推导），再拆连接组。后面每一步因此更小。
2. 终端（C）单独成组 `CodexTerminal`：它只在有 TUI 的会话里存在，生命周期与连接不同。
3. 第 0 步先做：录制工具支持在一次录制中重启运行时，补齐恢复、切换配置、重连三个场景后再动代码。

## 8. 进展

| 步 | 提交 | 结果 |
|---|---|---|
| 0 | 01278ec | 录制可跨多次连接；补恢复、重连、切换模型三个场景 |
| 1 | 30972e5 | 状态由 `refreshStatus` 从事实推导，phase 只在 `livePhase` 计算 |
| 2 | 8af558c | `CodexTurns`（`turns.ts`，378 行）独占当前回合；`runtime.ts` 3933 → 3770 行 |
| 3 | 6031ab6 | `CodexConnection`（576 行）、`CodexTerminal`（262 行）；适配器的配置切换与复用判断移入运行时（`switchProfile`、`probeEndpoint`、`reuseVerdict`）；`runtime.ts` 3770 → 3275，`index.ts` 1515 → 1470 |
| 4 | 3c35f09 | `CodexThread`（`thread.ts`，421 行）、`CodexInteractions`（`pending.ts`，509 行）；`runtime.ts` 3275 → 2592 |
| 5 | （本提交） | 通知改为分发表 `CodexNotifications`；历史与日志拆为 `CodexEventLog`、`CodexHistorySync`；设置为 `CodexSettings`；发送、插话、打断为 `CodexDispatch`；`runtime.ts` 2592 → 776，移出基线 |

剩余：`index.ts`（1470 行）仍超限，下一步把适配器里按功能划分的部分（辅助模型、外部会话、斜杠命令与扩展）拆出；`transcript-source.ts`（1068 行）不在本方案范围，单独评估。返工率在拆分完成 30 天后对比（§5）。
