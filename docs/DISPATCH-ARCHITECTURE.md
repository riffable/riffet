# 会话调度与控制面架构设计（Dispatch v2）

日期：2026-11-19。状态：M1–M4 已全部落地并通过核心验证。

本文定义 Riffet 会话调度、多后端执行适配、权威控制投影以及客户端过程块/队列展示的目标架构。本次升级**不保留旧客户端兼容约束**（同步升级 Web、macOS、KMP/iOS/Android 并提升契约大版本），以换取单一权威数据源、清晰领域边界和可证明的状态机收口。

---

## 1. 背景与结构性病灶

近期集中暴露的两类线上问题（新建会话首条消息下显示「停止并发送」；Cursor 会话重启后丢失 steer、点击「停止并发送」缓慢且未走 `deliverNow`、停止后排队消息卡死 60 秒、工具调用块被自动折叠并显示「已处理」），根源并非零散边界 bug，而是现行架构的 4 个结构性裂缝：

1. **三实体混装与 `Journal ↔ Dispatcher` 环形状态机**
   - `Run` 同时承载「队列输入项」「至多一次投递围栏」「执行回合」三种不同生命周期的实体，靠十余个无类型 `stage` 字符串和全仓 40+ 处 `intent !== 'steer'` 区分语义。
   - `Journal` 另有一套 `meta.turn_started / meta.turn_ended`，`DispatchFeed` 将其翻译成伪 `run_*` 事件回灌给 `NativeDispatcher` 改写 `Run.state`，`TimelineService` 与前端再把 `Run.state` 拼回时间线行。任一环节脱节（如用户 Stop 未写 `meta.turn_ended` 或 `stopTargets` 漏匹配），前后端立即分裂。
2. **缺少每会话单邮箱状态机（Per-Session Actor）**
   - `apps/server/src/native/dispatch.ts`（1625 行）以全局 500 ms `kick()` 轮询全库未完结 Run，并用 18 个并行内存 Map/Set 维护锁、重试、停机、引导和超时态；`lane.ts#admission` 只是被动查询函数而非状态跃迁权威。
3. **身份混用与传输层细节侵入核心调度器**
   - `stopTargets` 把浏览器控制租约 `terminalEpoch`（开关终端抽屉、重连 tmux 均会递增）混作进程身份，且要求 `native.nativeTurnId === stop.turnId`（重启后纯内存 `activeTurn` 丢失导致 `turnId = undefined`，直接把活跃 Run 过滤为空）。
   - 核心调度器堆叠了 18 个 `NativeBackendTraits` 开关，硬编码 PTY/argv/回显匹配逻辑；targeted stop 的 `!stop` 判断把 Cursor 的 `deliverNow`（`sendsNow = true`）彻底架空为死代码。
4. **控制面与内容面异步撕裂，客户端各自猜状态**
   - `status`、`runs`、`rows` 三路异步到达且缺少统一权威裁决；Web / macOS / KMP 各自维护 `inQueue`、`messagePlace`、`causallyBusy`、`canSteerQueued` 与 `TurnProcess` 的副作用 `fold()`。一旦 `phase: idle` 早于 `run.state: interrupted`（或 `run` 漏结算），前端立即把被中断的回合误判为正常完成并收起工具调用。

---

## 2. 核心不变量

### 2.1 继承的安全与活性不变量（`docs/DELIVERY.md`）

- **S1 至多一次写入**：任何消息写入外部 CLI/协议端点至多一次，超时、重启、收敛绝不重写。
- **S2 写前前置条件**：PTY 回车仅在输入框确认持有本条消息时发送。
- **S3 回合隔离**：前序前台回合未确认结束前，不向同一会话派发下一条普通消息。
- **L1–L4 活性保证**：所有非终态有界前进、阻塞原因可见、推断按观测收敛、外部等待统一走带终检与阻塞补偿的 `waitFor`。

### 2.2 新增架构不变量

- **A1 单向权威流（Single Source of Truth）**：会话控制态（前台回合、队列项、阻塞原因、可用动作）由服务端 `SessionActor` 唯一裁决并作为不可变快照下发；回合终态由服务端单向写入 `Journal`（`meta.turn_ended`），不再经 `DispatchFeed` 回环改写。
- **A2 身份三正交（Orthogonal Identities）**：
  - **进程身份**：`(terminalId, pid, startedAt)`（复用 `process-identity.ts`），决定「是不是同一个存活 CLI 进程」；
  - **终端写租约**：`terminalEpoch`，仅用于 `TerminalService` 防浏览器与服务端并发写 PTY，**禁止参与业务目标匹配**；
  - **回合身份**：`(nativeSessionId, nativeTurnId)`，持久保存并在服务重启后由驱动 `hydrate()` 主动恢复。
- **A3 Stop-Settles-Turn 原子性**：任何已确认的 `stopTurn` / `replaceTurn` 在返回前的同一个串行步内，必须原子完成：① 结算被中断的前台回合与关联 Run；② 向 `Journal` 写入 `meta.turn_ended(status: 'interrupted')`；③ 释放队列阻塞并推进后继消息；④ 广播最新控制快照。外部 CLI 迟到的 `stop` hook 仅作幂等补充，不再是解除阻塞的唯一生命线。
- **A4 直发与排队模型隔离**：`placement === 'sending'`（新建会话首条消息或空闲直发消息）与 `placement === 'queued'`（被前序回合或条件阻塞的排队消息）在模型层彻底分离；正文中的 `UserMessage` 永不渲染「停止并发送」，该操作只属于队列项且受服务端 `actions` 门控。
- **A5 纯派生过程块折叠（对齐 DeepSeek Harness）**：`TurnProcess` 不再因 `running: true -> false` 的瞬时跳变在副作用中 `fold()`；自动折叠的充要条件是：`turn.status === 'completed' && hasFinalAnswer && !hasIncompleteTools`。运行中、已停止、失败、结果未知或含未完成工具调用的回合，默认保持展开。

---

## 3. 领域模型与协议契约（v4 / 破坏性升级）

### 3.1 服务端内部三实体

| 实体 | 职责 | 持久化位置 | 是否直接暴露给客户端 |
|---|---|---|---|
| **InboxItem** | 用户提交的待发/待确认输入（普通消息或引导），含正文、附件、引用、顺序、`commandId` | `workbench.db`（由原 `runs` 队列态演化/迁移） | 投影为 `InboxEntry` |
| **DeliveryFence** | S1 至多一次写入围栏、进程身份 `(terminalId, pid, startedAt)`、写前基线 `baselineSequence`、`StopReceipt` | `workbench.db`（服务端私有） | 否（仅在 `uncertain` 诊断中暴露脱敏原因） |
| **Turn** | 一次模型执行回合，拥有唯一 `turnId`、`nativeTurnId`、终态（`running / completed / interrupted / failed / outcome_unknown`）与耗时/速率指标 | `journal.db`（`meta.turn_started` / `meta.turn_ended` 为唯一真理）+ 历史统计归档 | 投影为 `ActiveTurnState` 与 `TurnOutlineV3` |

### 3.2 统一控制面契约（`packages/contracts`）

在 `packages/contracts/src/control.ts`（并在 `sync.ts` 的 `SyncFrame` 中以 `control` 帧下发，同时随 `hello` 携带初始快照）定义唯一权威控制视图：

```ts
export type InboxAction =
  | 'send_now'
  | 'steer'
  | 'edit'
  | 'cancel'
  | 'retry'
  | 'check'
  | 'continue'
  | 'restore';

export interface InboxEntry {
  id: string;
  commandId: string;
  kind: 'message' | 'steer';
  /** 'sending'：正在直发进入正文，不进 QueueDock；'queued'：被阻塞等待中，展示在 QueueDock */
  placement: 'sending' | 'queued';
  status: 'queued' | 'preparing' | 'sending' | 'uncertain' | 'failed';
  prompt: NativeRunInput;
  contextSnapshots?: CapturedSessionReference[];
  createdAt: string;
  updatedAt: string;
  error?: string;
  diagnostic?: { code?: string; message: string; stage?: string; at: string };
  /** 服务端根据当前会话状态、后端能力与目标绑定唯一裁决的可执行动作 */
  actions: readonly InboxAction[];
}

export interface ActiveTurnState {
  /** 与 Journal / TurnOutline 一致的回合键或原生 turnId */
  turnId?: string;
  ownerRunId?: string;
  nativeSessionId?: string;
  nativeTurnId?: string;
  phase: 'starting' | 'running' | 'stopping' | 'attention';
  startedAt?: string;
  canStop: boolean;
  canSteer: boolean;
}

export interface SessionControlSnapshot {
  /** 会话内单调递增的控制版本号，客户端丢弃乱序旧帧 */
  revision: number;
  runtime: 'offline' | 'starting' | 'ready' | 'conflict' | 'failed';
  /** null 表示前台空闲；非 null 表示存在活跃前台回合 */
  activeTurn: ActiveTurnState | null;
  /** 按调度优先级排序的未完结输入（直发项 + 排队项 + 待恢复项） */
  inbox: readonly InboxEntry[];
  /** 队列阻塞原因（与调度器 100% 同源） */
  held?: NativeQueue['held'];
  /** 面向输入框与全局工具栏的顶层动作权限 */
  capabilities: {
    canStop: boolean;
    canSteer: boolean;
    canSendNow: boolean;
  };
  interaction: NativeInteraction | null;
  activity: { compacting: boolean; background: number };
  outputRate?: OutputRate;
  connection?: NativeStatus['connection'];
  history?: NativeStatus['history'];
  runtimeControl?: NativeStatus['runtimeControl'];
  notice?: string;
  noticeLevel?: 'info' | 'warning' | 'error';
  model?: string;
  permission?: string;
  approval?: string;
  profilePending?: boolean;
  transcript?: NativeStatus['transcript'];
}
```

### 3.3 `TurnOutlineV3` 与 `TimelineRow` 终态扩展

- `TurnOutlineV3.status` 扩展为：`'running' | 'completed' | 'interrupted' | 'failed' | 'outcome_unknown'`（保留 `cancelled` 归并映射到 `interrupted`，区分「正常完成」与「用户停止 / 结果未知」）。
- `TimelineService` 在折叠 `meta.turn_ended` 时直接记录该终态，随 `outline` 帧与 `hello` 帧同步下发。
- 前端无需再把 `Run.state` 反向拼到 `TimelineRow` 上猜测是否被中断；`TurnProcess` 直接读取所在 turn 的权威 `status`。

### 3.4 `NativeStopRequest` 契约收敛

```ts
export interface NativeStopRequest {
  requestId: string;
  nativeSessionId: string;
  /** 有明确活跃回合时携带；回合尚未拿到原生 ID 或重启未带 ID 时可省略，按同进程级停止处理 */
  turnId?: string;
  /** 目标终端标识（仅用于确认是同一会话终端，不再携带/比对 terminalEpoch） */
  terminalId?: string;
}
```

> 移除 `terminalEpoch` 出停止目标匹配逻辑；终端租约变更不再导致 Stop 失效。

---

## 4. 服务端执行架构

### 4.1 总体分层

```text
HTTP Routes (/native/send, /steer, /cancel, /send-now, /configure)
                         │
                         ▼
         SessionCoordinator（进程级轻量路由器）
          · 管理 Map<sessionId, SessionActor>（懒创建、空闲自动回收）
          · 管理全局约束：workspaceReservations、prewarmHolds、drainLeases、restartability
                         │
                         ▼
          SessionActor（每活跃会话一个，单邮箱串行 FSM）
          · 单串行队列处理所有命令与外部观测事件
          · 拥有单会话状态：phase / activeTurn / inbox / timers / pendingStop
          · 每次状态变化产出不可变 SessionControlSnapshot 并广播
                         │
          ┌──────────────┴──────────────┐
          ▼                             ▼
  ExecutionAdapter（传输层）      Journal / Store（持久层）
  · hydrate(session)            · Inbox & DeliveryFence 事务
  · startTurn(req)              · 单向写 meta.turn_started / meta.turn_ended
  · steerTurn(req)              · 历史统计与检查点记录
  · replaceTurn(req)
  · stopTurn(req)
```

### 4.2 `SessionActor` 有限状态机

每条活跃会话内部只存在以下 5 个显式主状态：

```text
             ┌─────────────────────────────────────────────┐
             ▼                                             │
          [Idle] ──(Dispatch/Argv)──▶ [Starting] ──(Echo/Live)──▶ [Running(turn)]
             ▲                            │                        │   ▲     │
             │                       (Fail/Stop)       (Dialog)    ▼   │     │ (Stop / Replace)
             │                            │                  [Attention]     ▼
             └────────────────────────────┴────────────────────── [Stopping(turn)]
```

**核心运行机制**：
1. **单邮箱全序串行**：
   - 用户命令（`Enqueue`、`Steer`、`Stop`、`SendNow`、`CancelInbox`、`Configure`、`Recover`）与外部观测（`DriverEvent`、`DriverStatus`、`TimerExpired`）全部封装为事件入该 Actor 的串行邮箱，彻底取代原先散落在 18 个 Map 间的跨函数竞态。
   - 长耗时 I/O（PTY 交互、RPC 请求、停止等待）仅在状态已迁入 `Starting` / `Stopping` 后异步执行，其完成结果作为新事件回到同一邮箱结算；期间新到达的 `Enqueue` / `CancelInbox` 仍可立即安全入队或取消，不会被长锁卡死。
2. **事件驱动 + 按需定时器（取消 500 ms 全局扫表）**：
   - 仅当存在 `input_sent` 回执窗口、`idle` 宽限窗口、或 `CLI_BUSY` 退避重试时，由该 `SessionActor` 挂载单条局部 timer；状态离开该阶段立即 `clearTimeout`。
   - 进程启动时扫描 `store.listUnfinishedNativeRuns()` 仅为真正有未完结工作的会话拉起 Actor 并执行 `hydrate()`；空闲且无观察者的 Actor 在短暂宽限后自动卸载释放内存。
3. **统一 `computeControlSnapshot()`**：
   - 每次状态跃迁同步重算 `SessionControlSnapshot`（`revision++`）：
     - `activeTurn` 非空时，`canStop = supportsInterrupt && supportsTargetedStop && phase !== 'stopping'`；
     - `placement` 规则：`activeTurn === null && !held && item === nextToDispatch` → `'sending'`，其余等待项 → `'queued'`；
     - 每条 `InboxEntry.actions` 直接按当前状态生成：
       - `'sending'` 项：**绝不含 `'send_now'`**，仅在未过写围栏前含 `'cancel'`；
       - `'queued'` 项：仅当 `activeTurn?.canStop` 时含 `'send_now'`，仅当 `activeTurn?.canSteer` 且支持 steer 时含 `'steer'`，常规含 `'edit' | 'cancel'`；
       - `'uncertain'` 项：含 `'check' | 'continue' | 'restore'`（按恢复检查结果）。

### 4.3 `ExecutionAdapter` 统一传输接口

将 `NativeBackendTraits` 中与传输机制耦合的开关全部下沉到两套共享适配器基座中，核心 `SessionActor` 只面对统一接口：

```ts
export interface ExecutionStopTarget {
  nativeSessionId: string;
  turnId?: string;
  terminalId?: string;
  /** 进程级兜底时用于验证是同一进程而非复用的 PID */
  processIdentity?: { pid: number; startedAt: string };
}

export interface ExecutionAdapter {
  /** 重启或首次订阅时主动水合存活进程与正在执行的 activeTurn */
  hydrate(session: Session): Promise<{ activeTurn?: ActiveTurnHint; status: NativeStatus }>;

  /** 启动一个新回合（内部自主决定走 argv 启动、PTY paste 还是协议 RPC，并在写前回调 fence） */
  startTurn(req: StartTurnRequest): Promise<StartTurnResult>;

  /** 向当前活跃回合注入引导输入 */
  steerTurn?(req: SteerTurnRequest): Promise<{ deferred?: true }>;

  /** 原子替换当前回合（Cursor 走带目标守卫的 deliverNow，其他后端默认组合 stopTurn + startTurn） */
  replaceTurn(req: ReplaceTurnRequest): Promise<ReplaceTurnResult>;

  /** 确认停止当前前台执行（成功返回即保证进程已回到空闲或已退出） */
  stopTurn(session: Session, target: ExecutionStopTarget, options?: { clearPrompt?: boolean }): Promise<StopTurnResult>;
}
```

- **`PtyExecutionAdapter`（Claude / Cursor 共享）**：封装 `waitFor`、写前 `commitDispatchFence`、tmux 进程身份检查（`pid + startedAt`）、输入框清理与回显确认、`terminalEpoch` 写锁保护、Ctrl+C 安全停止与 `deliverNow`。
- **`ProtocolExecutionAdapter`（Codex / DSH / Traex 共享）**：直接对接 App-Server / JSON-RPC，零 PTY 概念泄露。
- 精简后的后端声明只保留高层产品能力（`supportsSteer`、`supportsTargetedStop`、`survivesRestart`、`supportsInitialPromptArgs`、`supportsSessionReferences` 等）。

### 4.4 Cursor 后端专项闭环

针对本次定位到的 4 处 Cursor 根因，在 `plugins/riffet/cursor/` 同步改造：

1. **`activeTurn` 全生命周期覆盖与重启自愈**（`plugins/riffet/cursor/backend/steer.ts`）：
   - `beforeSubmitPrompt` 携带 `conversation_id` + `generation_id`，校验存活终端后即刻建立 `entry.active`（不再等到第一个 `preToolUse`）；
   - 新增 `hydrate(session)`：服务重启或重新 `observe` 时，若会话终端仍在运行且持久存储存在该 `(nativeSessionId, terminalId)` 下状态为 `running / observed` 且带 `nativeTurnId` 的 Run，核对 `chat-store` 中该 turn 仍为 `'open'`（且未记录结束），立即恢复 `entry.active` 并广播 `status`。
2. **打通带目标校验的 `deliverNow`（`replaceTurn`）**：
   - 移除 `dispatch.ts:1530` 的 `!stop` 封锁；
   - `replaceTurn` 先校验目标并持久化 `StopReceipt(pending)`，再把 `beforeWrite: () => checkStopTarget()` 传入 `native.deliverNow`；
   - 若 `deliverNow` 在写入前因 CLI 不可接管返回 `CLI_BUSY`，自动回退到 `stopTurn + startTurn`；写入一旦越过围栏，由 `SessionActor` 立即原子结算旧回合并写 `meta.turn_ended(interrupted)`。
3. **`native.interrupt` 迁移 `waitFor` 并修复假忙残留**（`plugins/riffet/cursor/native/service.ts`）：
   - 替换裸 `while (Date.now() < deadline)` 为共享 `waitFor` 原语（带终检与事件循环阻塞补偿）；
   - 确认停止回到 `idle` 后，清除当前回合的 `liveStep` 活跃判定并**不再错误刷新 `watch.paneBusyAt = Date.now()`**（避免 `hiddenTurn` / `ANSWERED_SETTLE_MS` 拖延空闲收敛）。
4. **Stop 主动闭合 Journal**：
   - `stopTurn` / `replaceTurn` 确认完成后，直接通过 `host.transcript.endTurn(sessionId, turnId, 'interrupted', nowIso)` 写入 `meta.turn_ended(interrupted)`，不再依赖 Cursor CLI 是否在工具中断时补发 `stop` hook 或等待 `chat.answered()`。

---

## 5. 前端与时间线架构（四端统一）

### 5.1 打破 `Journal ↔ Dispatcher` 回环

- `SessionActor` 成为回合终态（尤其是用户停止、超时收敛、进程退出）的主动写入方，通过 `transcript.endTurn(...)` 直接写 `meta.turn_ended`；
- `TimelineService` 折叠 `meta.turn_ended` 产出带 `status: 'running' | 'completed' | 'interrupted' | 'failed' | 'outcome_unknown'` 的 `TurnOutlineV3`；
- `DispatchFeed` 只负责把外部协议/日志中**新发现的**原生回显与终态（如用户直接在 tmux 里发的消息或 CLI 自主结束）上送给 `SessionActor`，不再做“改完 Run 再回拼 Journal”的双向乒乓。

### 5.2 `TurnProcess` 纯派生折叠状态机

对照 DeepSeek Harness（`turn-process.ts` + `contract/turn-process.ts#turnProcessAlwaysOpen`）：

```ts
// 每一轮是否满足「正常完成可自动折叠」的纯派生判定
const canAutoFold =
  !row.running &&
  row.turnStatus === 'completed' &&
  !row.interrupted &&
  row.issueCount === 0 &&
  row.followedByAnswer &&
  !row.hasIncompleteTools;
```

- **删除 `useLayoutEffect` 中按 `previousRunning -> !running` 触发 `fold()` 的竞态逻辑**；
- `TurnProcess` 的默认展开态直接由 `open = manualChoice ?? (defaultOpen || detailOpen || !canAutoFold)` 派生；
- 当 `row.turnStatus === 'interrupted' || row.turnStatus === 'outcome_unknown'` 或 `row.hasIncompleteTools` 时：
  - 绝不自动收起；
  - 标题在 `interrupted` 时明确展示「已停止」，不再误标「已处理」。

### 5.3 `UserMessage` 与 `QueueDock` 职责彻底切分

- **`UserMessage`（对话流正文）**：
  - 彻底移除「停止并发送」按钮；
  - 只展示直发中状态（`Sending` / `Resuming`）、失败/不确定恢复动作（`重试发送` / `检查状态` / `继续对话` / `恢复到输入框`）以及写入前的「取消」。
- **`QueueDock`（输入框上方队列卡）**：
  - 唯一渲染 `control.inbox.filter(e => e.placement === 'queued')`；
  - 操作按钮（`补充到当前任务`、`停止并发送`、`编辑`、`删除`）严格按 `entry.actions` 驱动，Web / macOS / iOS / Android 四端逻辑完全一致。

---

## 6. 分阶段落地计划与验收标准

整套方案拆为 4 个可独立编译、测试、灰度验证的里程碑，**每步均朝最终架构单向收敛，不写临时过渡代码**：

### M1：止血闭环 + 契约地基（核心故障一次性根治）
- **契约**：`packages/contracts` 新增 `SessionControlSnapshot` / `InboxEntry` / `ActiveTurnState`，扩展 `TurnOutlineV3.status`，收敛 `NativeStopRequest`（停止匹配不再依赖 `terminalEpoch`）。
- **服务端**：
  - 修复 `stopTargets`（去掉 `terminalEpoch` 校验；无 `turnId` 时按同 `(nativeSessionId, terminalId)` 匹配全部未完结前台 Run）；
  - Stop 确认后原子结算 Run 并主动写 `Journal` 的 `meta.turn_ended(interrupted)`，立即 `kick()` 派发后继；
  - Cursor 后端：`beforeSubmitPrompt` 建立 `activeTurn`、重启 `hydrate` 恢复 `activeTurn`、打通带 `stop` 目标校验的 `deliverNow`、`interrupt` 迁 `waitFor` 并修复 `paneBusyAt` / `liveStep`。
- **Web 前端**：
  - `UserMessage` 彻底移除「停止并发送」；
  - `TurnProcess` + `transcriptRows` 切到纯派生折叠（接入 `TurnOutlineV3.status` + `hasIncompleteTools` + `followedByAnswer`）。
- **验收**：覆盖本次全部复现路径（新建会话、重启后 steer、停止并发送秒切、工具调用不收起且标「已停止」、排队消息立即发出）及核心单测（`dispatch.test.ts`、`steering.test.ts`、`cursor` 单测、`pnpm typecheck`）。

### M2：服务端 `SessionActor` + `SessionCoordinator` 重构
- 将 1625 行的 `NativeDispatcher` 拆分为 `SessionCoordinator`（全局路由、工作区保留、重启 drain）+ 单会话 `SessionActor`（单邮箱串行 FSM、按需局部定时器、空闲回收）；
- 移除 500 ms 全表轮询 `kick()` 与 18 个并行散落 Map；
- `SessionActor` 每次跃迁原子产出 `SessionControlSnapshot`，接入 Sync v3 SSE（`hello` + `control` 帧）。
- **验收**：`apps/server/src/native/` 全套单测通过，确认无全局轮询、空闲 Actor 正常回收、并发 stop/steer/send/configure 零竞态。

### M3：传输层 `ExecutionAdapter` 下沉 + 打破 `DispatchFeed` 回环
- 抽出 `PtyExecutionAdapter`（Claude / Cursor 共享）与 `ProtocolExecutionAdapter`（Codex / DSH / Traex 共享），统一实现 `hydrate / startTurn / steerTurn / replaceTurn / stopTurn`；
- 将 `NativeBackendTraits` 精简至高层能力声明；
- 消除 `DispatchFeed` 回环，统一由 `SessionActor` 单向写入 `Journal` Turn 终态。
- **验收**：全后端集成测试通过、`pnpm check:layers` 通过。

### M4：全端切齐 `SessionControlSnapshot` + 契约固化与旧代码清理
- Web 全面切换消费 `control` 帧，删除本地重复推导（`inQueue`、`messagePlace`、`causallyBusy`、`canSteerQueued`）；
- 同步升级 `apps/macos`（SwiftUI）与 `apps/mobile`（KMP `SessionStore` / `SessionComposer` + iOS / Android UI）消费新 `SessionControlSnapshot`；
- 清理 `client-features` 中旧协议兜底、旧 `Run` 兼容字段，执行 `pnpm version:bump`、`pnpm gen:contracts`、`pnpm gen:timeline-fixtures`，运行全仓 `pnpm verify`。
