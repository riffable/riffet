---
module: server.native
verify:
  - npx vitest run apps/server/src/native
---

## 职责

把工作台的消息投递到各 Agent 的 CLI 并收敛结果：派发与排队、空闲 CLI 回收、交给终端的会话、外部会话导入、按客户端能力过滤可见内容。

## 入口

- `dispatch.ts#NativeDispatcher`：消息从 `queued` 到终态的唯一推进方，也负责暂停派发与重启判断。
- `lane.ts#admission`：下一条该谁启动、被什么挡住；客户端看到的队列状态与调度器用同一份结果（`lane.ts#queueOf`）。
- `reclaim.ts#AgentReclaimer`：按上次使用时间与内存预算停掉空闲 CLI。
- `terminal-hold.ts#TerminalHolds`：会话交给终端（`riffet resume`）期间的单写入方约束。
- `client-features.ts#clientSupportsFeature`：旧客户端看不到它解不了的 Agent、项目和行。

## 不变量

- 一条消息写入 CLI 至多一次，超时、重启、收敛都不重写；不确定的投递记为 `uncertain` 并占住队列（`lane.ts#holdsUnconfirmed`），由用户确认后才继续。契约见 docs/DELIVERY.md §2。
- CLI 不在提示符、也没有在跑回合时，消息只允许反复被拒 `dispatch.ts#CLI_BUSY_LIMIT_MS`；排在活跃回合后面不计时。只有待处理的设置重启可以暂停这个计时，后台任务不行。
- 空闲收敛有两档：`dispatch.ts#IDLE_RECONCILE_MS` 关闭丢了完成事件的回合，`dispatch.ts#IDLE_OUTCOME_GRACE_MS` 给 Stop hook 链留时间。缩短后者会先显示「结果未确认」再自我更正。
- 回合的 checkpoint 与消息同时发出，不等待它；checkpoint 只保留能证明早于回合认领时间的内容，宁可拒绝恢复也不还原回合自己的改动（`dispatch.ts#NativeDispatcher` 内的 `beforeTurn`）。
- 同一会话的启动、配置、发送、中断都在 `apps/server/src/agent-host/session-lock.ts#SessionLock` 下串行；修改配置要先同步 `dispatch.ts#reserveSessionStart` 再等锁（`configure.ts#configureNative`）。
- 回收判断依赖持久化的 `reclaim.ts#UsageRecord`（agent-usage.json）：没有上次抓屏的 pane 记为 `unobserved` 并保留，在会话锁下读不到的 pane 也保留。比较前要先过 `reclaim.ts#settledScreen`，否则 spinner 与时钟让空闲规则永不触发。
- 交给终端的会话只有终端 CLI 一个写入方：发送、启动、回收都拒绝或跳过。CLI 用 pid 加启动时间识别，pid 被复用不算同一进程（`terminal-hold.ts#TerminalHolds`）。
- 新建会话的所有入口（输入框、尝试、交接、定时）都经 `session-input.ts#resolveNativeSessionInput`，预热键才会一致。

## 外部行为

- 输入：各驱动的 `AgentBackend` 回传的事件与状态（`dispatch.ts#DispatchObservation`），以及终端画面。画面录制在 `apps/server/src/backends/claude/fixtures/screens/`，CLI 升级后的重录见 docs/guide/aif.md §5.4；dispatch 本身没有独立录制，用 `dispatch.test.ts` 的场景。
- 客户端能力来自请求头 `CLIENT_FEATURES_HEADER`；EventSource 与 WebSocket 不能带头，只有 GET 流接受 `?features=`（`client-features.ts#registerSessionVisibilityHook`）。
- 内存与压力读取 `ps`、`sysctl kern.memorystatus_vm_pressure_level`、`/proc/pressure/memory`（`agent-processes.ts#memoryPressure`），读不到按 `normal`。

## 排障

- 消息停在 `queued` 且队列有 `held`：看 `lane.ts#admission` 的返回，再看该会话 `runs` 表里 json 的 `native.delivery` 与 `native.stage`。
- 重启被拒或一直等待：`GET /api/service/restartable`，对应 `dispatch.ts#restartability`；暂停派发是 30 s 租约（`dispatch.ts#DRAIN_LEASE_MS`），等待方不续期会自行失效。
- 空闲 CLI 不被回收或被误回收：监控接口 `agentProcesses` 给出每个 CLI 的 `AgentRetention` 与预计停止时间；回收日志无 scope，按消息文本过滤 `riffet logs`，如 `reclaimed idle agent CLIs`、`agent reclaim pass failed`。生命周期见 docs/guide/performance.md §3.10。
- 终端持有的会话无法发送：日志 `releasing a terminal hold failed`、`following a terminal-held conversation failed`；持有的 token 存在会话旁的 `terminal-hold:` 密钥里（`terminal-hold.ts#SECRET_PREFIX`）。
