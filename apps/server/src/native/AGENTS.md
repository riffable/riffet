---
module: server.native
verify:
  - npx vitest run apps/server/src/native
---

## 职责

把工作台的消息投递到各 Agent 的 CLI 并收敛结果：派发与排队、空闲 CLI 回收、交给终端的会话、外部会话导入、按客户端能力过滤可见内容。

## 入口

- `dispatch.ts#NativeDispatcher`：消息从 `queued` 到终态的唯一推进方，也负责暂停派发与重启判断。
- `session-actor.ts#SessionActor`：一个会话的调度状态与在途操作。外部来的三类消息（唤醒、后端观测、命令结束）都经 `mailbox.ts#Mailbox` 逐条处理。
- `lane.ts#admission`：下一条该谁启动、被什么挡住；客户端看到的队列状态与调度器用同一份结果（`lane.ts#queueOf`）。`lane.ts#nextLook` 给出该会话下一次需要再看的时刻。
- `reclaim.ts#AgentReclaimer`：按上次使用时间与内存预算停掉空闲 CLI。
- `terminal-hold.ts#TerminalHolds`：会话交给终端（`riffet resume`）期间的单写入方约束。
- `client-features.ts#clientSupportsFeature`：旧客户端看不到它解不了的 Agent、项目和行。

## 不变量

- 一条消息写入 CLI 至多一次，超时、重启、收敛都不重写；不确定的投递记为 `uncertain` 并占住队列（`lane.ts#holdsUnconfirmed`），由用户确认后才继续。契约见 docs/DELIVERY.md §2。
- CLI 不在提示符、也没有在跑回合时，消息只允许反复被拒 `session-actor.ts#CLI_BUSY_LIMIT_MS`；排在活跃回合后面不计时。只有待处理的设置重启可以暂停这个计时，后台任务不行。
- 画面空闲不指明回合，不结算任何 Run：完成、失败、取消只来自带 `commandId` 或回合 ID 的结束事件（docs/TURN-LIFECYCLE.md T4）。只能看画面判断结束的后端，在驱动里判断并指明回合后再报。
- 证据按回合归属（docs/TURN-LIFECYCLE.md T5）：`busyAt`、`firstOutputAt` 只认写入之后、属于本回合的状态和输出（`actor-observations.ts#ownTurn`）；状态点名我们更早一条消息的回合时，它落后于那一回合的结束，不触发「被后续回合取代」（`actor-observations.ts#earlierTurn`）。「直接发送」紧跟在停止之后，前一回合的尾部输出和滞后的状态都会出现。
- 空闲收敛只有一档 `actor-observations.ts#IDLE_RECONCILE_MS`（60 s），把丢了结束事件的回合记为「结果未确认」，迟到的真实结局仍可更正。它要盖过 Stop hook 链和转写的批量落盘，缩短会先显示「结果未确认」再自我更正。
- 「状态点名了另一个回合」只对状态点名过本回合的 Run 生效（`actor-observations.ts#ActorObservationDeps` 的 `namedTurns`），否则回合 ID 不属于同一套编号的后端会在一开始就被判为结果未确认。
- 回合的 checkpoint 与消息同时发出，不等待它；checkpoint 只保留能证明早于回合认领时间的内容，宁可拒绝恢复也不还原回合自己的改动（`dispatch.ts#NativeDispatcher` 内的 `beforeTurn`）。
- `SessionActor` 的处理函数不嵌套：处理一条消息期间到达的消息排在它后面。处理函数内部要应用自己读到的观测时调 `apply`，不调 `observe`，否则会被排到当前消息之后。
- 会话所处阶段（`trace.ts#SessionPhase`）由未完结的 run 与在途操作推导，不单独存储：`runs` 表是跨重启的唯一依据。
- 客户端看到的位置（`control.ts#placementOf`）与调度（`lane.ts#admission`）回答的是两件事：后者是「现在能不能派发」，前者是「这条消息是不是排在别的东西后面」。下一条消息被服务端接手后，挡住它的只是它自己的进展（worker 已接手在等会话锁、被 CLI 拒绝后的退避、为它拉起的 CLI 仍在 `starting`）时，它留在内容区（docs/DISPATCH-ARCHITECTURE.md A6）。不要为了改显示去改 `admission` 的 `held`：`heldByProvider` 靠不带 `runId` 的 `turn_running` 决定是否按间隔重读状态。
- 队列只被后端状态挡住时（不是我们发起的回合、对话框），调度器按 `intervalMs` 自己再读状态（`lane.ts#heldByProvider`），不依赖后端一定会推送「空闲」。
- 同一会话的启动、配置、发送、中断都在 `apps/server/src/agent-host/session-lock.ts#SessionLock` 下串行；修改配置要先同步 `dispatch.ts#reserveSessionStart` 再等锁（`configure.ts#configureNative`）。
- 回收判断依赖持久化的 `reclaim.ts#UsageRecord`（agent-usage.json）：没有上次抓屏的 pane 记为 `unobserved` 并保留，在会话锁下读不到的 pane 也保留。比较前要先过 `reclaim.ts#settledScreen`，否则 spinner 与时钟让空闲规则永不触发。
- 交给终端的会话只有终端 CLI 一个写入方：发送、启动、回收都拒绝或跳过。CLI 用 pid 加启动时间识别，pid 被复用不算同一进程（`terminal-hold.ts#TerminalHolds`）。
- 新建会话的所有入口（输入框、尝试、交接、定时）都经 `session-input.ts#resolveNativeSessionInput`，预热键才会一致。

## 外部行为

- 输入：各驱动的 `AgentBackend` 回传的事件与状态（`dispatch.ts#DispatchObservation`），以及终端画面。画面录制在 `apps/server/src/backends/claude/fixtures/screens/`，CLI 升级后的重录见 docs/guide/aif.md §5.4；dispatch 本身没有独立录制，用 `dispatch.test.ts` 的场景，以及 `dispatch.property.test.ts`：模拟的 CLI 加随机交错（命令、CLI 事件、迟到或缺失的状态推送、异步步骤的完成与失败、时钟、重启），检查至多一次写入、回合隔离、停止后必结算、静止后无残留。改调度逻辑后用 `RIFFET_PROPERTY_RUNS=5000 RIFFET_PROPERTY_SEED=<n>` 多跑几个种子。
- 无命令 ID 的 CLI 回执用 `packages/contracts/src/prompt-match.ts#samePromptText` 匹配发出的提示词。规整空白后，只有 `U+FFFD` 所在位置允许字符差异，且模糊匹配至少需要一个相同的非空白字符。服务端和时间线共用此规则。
- 客户端能力来自请求头 `CLIENT_FEATURES_HEADER`；EventSource 与 WebSocket 不能带头，只有 GET 流接受 `?features=`（`client-features.ts#registerSessionVisibilityHook`）。
- 内存与压力读取 `ps`、`sysctl kern.memorystatus_vm_pressure_level`、`/proc/pressure/memory`（`agent-processes.ts#memoryPressure`），读不到按 `normal`。

## 排障

- 一条消息或一个会话经历了什么：`riffet logs --scope dispatch`。`event=run` 是某条消息的投递状态或阶段变了（`from`、`to`、`attempt`、`code`；`turn` 是它绑定的回合，`source` 是当时在处理什么：`status`、`echo`、`turn_end`、`events`、`wake`、`settle`），`event=phase` 是会话阶段变了，`ms` 是在上一个阶段停了多久（`trace.ts#DispatchTrace`）。两条消息之间由在途操作造成的多步变化合并成一行。
- 消息停在 `queued` 且队列有 `held`：看 `lane.ts#admission` 的返回，再看该会话 `runs` 表里 json 的 `native.delivery` 与 `native.stage`。
- 消息一直是 `running` 而 CLI 早已空闲：回合在回执到达前就结束、期间没有收到过 busy 状态时出现过，原因是只对见过输出或 busy 的消息读状态。现在有回执就读（`session-actor.ts#SessionActor` 的 `watchDeliveries`），空闲满 `session-actor.ts#IDLE_RECONCILE_MS` 后按「结果未确认」关闭。
- 补充消息（hook steer）一直停在 `input_sent` 且前端看起来像已送达：hook 返回 `additional_context` 但 CLI 未写入 transcript 时，父轮次原本就处于 `busy`，不能用 `busy`/`attention` 跳过 `confirmationMs` 超时（仅带 `providerAcceptedAt` 的直接 RPC steer 豁免），且客户端判定 steer `received` 时不能采信父轮次的 `hasTurnOutput` 或 `running`。
- 上一轮早已结束但后续消息卡在「等待上一条消息确认」或终端离线后不再拉起：旧的未确认 steer（`steer_stopped` 或回执超时）若未在目标回合结束时持久化 `queueReleasedAt`，CLI 在线 `idle` 时会被 `steerTurnEnded` 暂时放行，但 CLI 退出/服务重启进入 `offline` 后会重新触发 `unconfirmed` 死锁；同时 `lane.ts` 对 `queueReleasedAt` 历史记录的放行判断需允许 `offline` 状态下放行拉起终端。现已在 `session-actor.ts#SessionActor` 与 `apps/server/src/store.ts#Store` 的重启恢复中按 `isSteerTargetTurnEnded` 持久化释放，且空闲回收、终端接管、编排忙碌与删除校验均忽略已释放的历史记录。
- 普通的 `uncertain` 消息（回执超时、CLI 退出或重启恢复）在之后已有更晚回合正常完成且 CLI 回到空闲时，不会再永久阻塞队列：调度器通过后端的 `canReleaseAfterLaterTurn`（如 Cursor 校验存在严格晚于该发送时刻的独立已完成回合、store root 一致、提示符空闲且无浏览器草稿/未决排队）自动写入 `queueReleasedAt` 释放队列，同时浏览器释放终端控制权或终端重连时也会唤醒派发器；已释放记录的迟到带标回执仍经全局事件通道纠正历史，但不再参与无标签文本回显匹配。
- 第一次停止未确认（`NATIVE_STOP_UNCONFIRMED`）后，再点停止仍然无效：客户端会带同一个 `requestId` 重试，服务端看到回执就只核对旧回合结束没有（`actor-interrupt.ts#recoverStop`），不再动 CLI。只有声明了 `repeatableStop` 的后端（Claude）在回执带 `error`、是纯停止、目标回合仍在运行时才再发一次（`actor-interrupt.ts#beginInterrupt` 的 `pressAgain`）。其他后端结果不明的停止仍然绝不重发（`dispatch.test.ts` 的 `never repeats a stop whose provider response was lost`）。
- 原子替换回合（`replaceTurn` / 立即发送）必须观察到新回合回执与新 `nativeTurnId` 才可结算旧回合，否则抛 `NATIVE_STOP_UNCONFIRMED` 保持失败封闭，不会在未确认替换时把仍在运行的旧回合误标为已中断。
- 没恢复的会话里发消息，先进内容区、跳到排队栏、恢复后又回内容区：快照的 `placement` 曾直接取 `admission` 的 `held`，worker 接手到 arm 之间的 `sending`、`CLI_BUSY` 后的 `retrying`、CLI 冷启动的 `turn_running` 都会把它算成排队。现在按 `control.ts#ownProgress` 区分；仍跳时看快照里 `held.reason` 与 `dispatch.ts#NativeDispatcher` 的 `taken`。
- 新会话的第一条消息显示「暂时无法确认是否已发送」，CLI 却从没起来过：argv 路径的 fence 在拉起进程之前提交，终端服务校验启动参数时就拒绝（例如单个参数超过 8 KiB）也曾被记成 `uncertain`。现在这几种拒绝（`session-actor.ts#LAUNCH_REFUSED`）记为可恢复的失败；仍出现时看 `riffet logs --scope dispatch` 里那条 run 的 `code`。
- 重启被拒或一直等待：`GET /api/service/restartable`，对应 `dispatch.ts#restartability`；暂停派发是 30 s 租约（`dispatch.ts#DRAIN_LEASE_MS`），等待方不续期会自行失效。
- 空闲 CLI 不被回收或被误回收：监控接口 `agentProcesses` 给出每个 CLI 的 `AgentRetention` 与预计停止时间；回收日志无 scope，按消息文本过滤 `riffet logs`，如 `reclaimed idle agent CLIs`、`agent reclaim pass failed`。生命周期见 docs/guide/performance.md §3.10。
- 终端持有的会话无法发送：日志 `releasing a terminal hold failed`、`following a terminal-held conversation failed`；持有的 token 存在会话旁的 `terminal-hold:` 密钥里（`terminal-hold.ts#SECRET_PREFIX`）。
- `input_sent` 回执超时偶发被推迟一整段 `intervalMs`：定时器提前 1ms 醒来时，若 `watchDeliveries` 读到的 `now()` 刚未超过 `confirmationMs`，紧随其后的 `scheduleTimer` 跨毫秒后再读 `now()` 会使 `lane.ts#nextLook` 误以为已过窗口被 `busy` 豁免而改排 `intervalMs`。现 `SessionActor.wake()` 把同一次 `now()` 快照同时传给 `watchDeliveries` 与 `scheduleTimer`，消除跨毫秒裂缝。
- 立即替换发送（`replaceTurn`）回退到「先停再发」后仍被旧的 `CLI_BUSY` 退避挡住 1.5s：`execution-adapter.ts#replaceTurn` 在 `recover` 将消息退回 `queued` 时返回 `skipped`，`actor-interrupt.ts#performInterrupt` 原先只在 `delivered` 分支清理 `nextAttempt`。现回退分支同步清理 `accepted.id` 的 `nextAttempt`，停完回合即可立刻派发。
