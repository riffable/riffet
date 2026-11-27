# 用户输入与回合生命周期：单一事实来源

日期：2026-11-27。状态：方案已确认；P0、P1 已实施，P2–P4 未实施。

本文补齐 [SESSION-JOURNAL.md](SESSION-JOURNAL.md) 不变量 4、5 和 [DISPATCH-ARCHITECTURE.md](DISPATCH-ARCHITECTURE.md) A1 在实现上留下的缺口：经 Riffet 发出的用户输入不在日志里，回合终态可以绕过日志直接写进 Run。两份文档的其余约定不变，[DELIVERY.md](DELIVERY.md) 的 S1–S3、L1–L4 不变。

## 1. 样本故障（2026-11-27，Cursor 会话）

用户发出 a，紧接着把排队的 b「直接发送」。结果 a 从时间线上消失；b 在 Cursor 还在执行时被结算为已完成，这一轮显示「已处理」，其下的工具调用继续增长。

| 时间 | 事件 | 来源 |
|---|---|---|
| 09:34:48.1 | a 写入终端 | dispatch 日志 |
| 09:34:49.4 | b 进入队列 | dispatch 日志 |
| 09:34:52.1 | 「直接发送」中断 a，a 记为 `interrupted` | dispatch 日志 |
| 09:34:52.4 | b 写入终端 | dispatch 日志 |
| 09:34:52.8 | 画面为忙，记为 b 的 `busyAt` | `runs` 表 |
| 09:34:59.6 | Cursor 开始执行 b（request `ea6a…`） | live tap |
| 09:35:00.0 | store 写入 b 的提示；时间戳取自 `<timestamp>`，精确到分钟 | chat store、journal |
| 09:35:00.1 | b 收到回执，`observed` | dispatch 日志 |
| 09:35:00.9 | 画面无忙碌提示（b 留在输入栏、没有 `ctrl+c to stop`），b 记为 `completed` | dispatch 日志 |
| 09:35:21 起 | Cursor 继续输出约 10 分钟 | journal |

两个直接原因：

1. **a 消失。** Cursor 中断时没有把 a 写进 store 和 transcript（只在 `prompt_history.json`）。a 没有回显，只能由 `packages/timeline/src/buildTimeline.ts#placeRunRows` 用 Run 补一行；该函数把「创建时间早于窗口第一条事件」的 Run 当作窗口之外的旧消息丢弃。窗口第一条是 b，其 Cursor 时间 09:35:00.000 晚于 a 的 09:34:48，a 被丢弃。
2. **b 提前结算。** `apps/server/src/native/actor-observations.ts#applyObservation` 的通用规则：已回执、见过忙或输出、画面空闲，就把 Run 记为 `completed`。b 的 `busyAt` 来自 a 停止期间的画面，b 开始后 Cursor 的画面没有忙碌提示。Cursor 自己的结束判定（`backend/steer.ts#answered`，要求 store 已答完）没有被等待；日志里没有 b 的 `meta.turn_ended`，Run 与日志从此不一致。

## 2. 为什么反复出现

这类问题不是个别条件写错，而是三处结构让新的边界情况不断出现，每次修复只能再加条件。

### 2.1 用户输入不在日志里

经 Riffet 发出的消息，Riffet 持有完整记录（`runs` 表），日志里却只有 CLI 的回显。时间线把回显当正本，Run 只在回显缺失时补位，补位的位置在折叠时现算：回执定位、压缩、排队、引导、按时间插入，加上 `echoedRuns`、`echoedPrompts`、文本匹配和 `oldestVisibleAt`。其中按时间插入比较的是两个时钟：Riffet 的毫秒时间和 CLI 记录的时间（Cursor 精确到分钟）。CLI 不回显的情况（中断、斜杠命令、压缩、CLI 自己丢弃）每多一种，补位规则就多一条。

这违反 SESSION-JOURNAL 不变量 4（服务端合成的事件与转写写入同一份日志），只是一直没有被当成缺口。

### 2.2 回合终态有两个写入方

日志的 `meta.turn_ended` 和 `runs` 表各自记录回合是否结束。各后端的转写读取写前者，`DispatchFeed` 把它翻译成 `run_completed` 等事件结算 Run；同时调度器还会根据画面状态直接改写 Run：

- `applyObservation` 的通用规则：画面空闲即 `completed`。声明了 `completesOnTurnEvent` 的后端（Codex、pi、chat、Antigravity）跳过；`reportsTurnOutcome` 的后端（Claude、Cursor）只在回合已被 hook 或活跃回合命名时跳过；Droid、DSH 始终适用。
- `reconcileIdleRun`：空闲满 `IDLE_RECONCILE_MS` / `IDLE_OUTCOME_GRACE_MS` 记为结果未确认。
- 停止确认、进程退出、换到后续回合时的结算。

画面空闲不说明是哪一轮空闲，`busyAt` 不说明是谁在忙，却可以改写某一条具体的 Run。为了减少误判，长出了后端特性开关（`completesOnTurnEvent`、`reportsTurnOutcome`、`untaggedEcho`）和多个时间窗（500 ms、3 s、15 s、60 s），通用规则一个判断有 8 个条件。

Dispatch v2 的 A1 规定回合终态由服务端单向写入日志，M1 落实了停止路径（停止确认后写 `meta.turn_ended`），回合的自然结束仍允许从画面推断并直接写 Run。

### 2.3 观测证据不分回合

`busyAt`、`firstOutputAt`、`paneBusyAt`、`idleSince`、`stoppedLiveSteps` 挂在 Run 或会话上，没有标明属于哪一次投递、哪一个回合。「直接发送」跨两个回合，前一回合的证据自然落到后一条消息上。现在的隔离靠在特定时刻重置时间戳（`native/service.ts#interrupt` 结束时把 `paneBusyAt` 设为当前时间），Dispatch v2 §4.4 第 3 条要求去掉这次重置，实现里保留了。

### 2.4 排障信息不足

dispatch 日志只记 `cause: observation`，不记是哪条观测、来自哪个信号源、指向哪个回合。本次故障只能从 `runs` 表的时间戳反推。

## 3. 不变量

在 SESSION-JOURNAL、DISPATCH-ARCHITECTURE、DELIVERY 的不变量之上增加：

- **T1 输入入日志。** 经 Riffet 发出的每条消息，在写入栅栏提交（`commitDispatchFence`）的同一步写一条 `meta.input` 到主车道日志。它在日志里的序号就是这条消息在时间线上的位置。写入栅栏之前取消的消息不写。
- **T2 回显是回执。** CLI 的用户消息事件与 `meta.input` 按 `commandId`（或回执里的原生消息 ID）合并成一行，行键为 `user:<commandId>`；回显带来的回合 ID 挂到这一行上。只有无法关联的回显（终端里直接输入的消息）单独成行。时间线不再用时间戳或文本决定用户消息的位置；无命令 ID 的后端用文本匹配建立关联（`packages/contracts/src/prompt-match.ts#samePromptText`），只用于关联，不用于定位。
- **T3 终态只有一条写入路径。** Run 的执行结果（完成、失败、中断、结果未知）只由日志里带回合 ID 的 `meta.turn_ended` 投影得出。调度器自己裁决的结束（停止确认、空闲收敛、进程退出、被后续回合取代）也先写 `meta.turn_ended`，再由同一条投影路径结算 Run。调度器不直接把 Run 改成终态。
- **T4 无身份的信号不产生「完成」。** 画面空闲、进程空闲这类不指明回合的观测，最多触发空闲收敛，结果是 `outcome_unknown`；完成只来自指明回合的结束信号。
- **T5 证据按投递尝试隔离。** 每次写入栅栏提交分配一个尝试号；忙、输出、空闲起点等证据记在尝试上，只接受写入之后、并能归属到该尝试回合的证据。
- **T6 替换回合是一个操作。** 「直接发送」在 `SessionActor` 里是一个操作：停止当前回合，等到它的结局（`meta.turn_ended`，或确认 CLI 未记录该输入），再写入下一条。下一条的证据从它自己的写入开始收集。

## 4. 设计

### 4.1 `meta.input` 事件（P1 已实施）

主车道日志里的一条 `meta.input`，`nativeId` 为 `meta:input:<runId>`，载荷只有 `runId`、`commandId`。正文、附件、引导目标仍在 Run 上，日志只记位置。

- 写入方：`apps/server/src/sync/sent-input.ts#journalSentInputs`。所有发送路径都以 Run 进入 `dispatching` 作为写入栅栏，store 在提交后同步通知 Run 变化，所以记录发生在写入 CLI 之前，五条发送路径（启动参数、`sendRun`、插件的 `commitDispatchFence`、终端粘贴、引导）不需要各自改动。
- 写到哪份日志：`apps/server/src/journal/ingest.ts#JournalLaneWriter` 的 `inputSent`，写进当前服务主车道的那份日志（长会话首次导入期间是导入窗口）。Run 记下 `NativeRunDetails.inputEntry`：日志的 generation 和这条记录的 seq。
- 失效：导入窗口被提升、日志重建后 generation 变化，`inputEntry` 不再成立，该 Run 按旧规则放置（§7）。
- 写入失败只记日志警告，不拦下发送：失去的只是位置，Run 按旧规则放置。为一次日志写入失败拒绝发送，代价比位置不准大。
- 写入栅栏之前的消息（`queued`、`preparing`）不进日志，由控制快照的 `inbox` 显示：`placement: 'queued'` 在输入框上方，`placement: 'sending'` 在内容区末尾（DISPATCH-ARCHITECTURE A6）。行键都是 `user:<commandId>`，进入日志后不重新挂载。

### 4.2 时间线折叠（P1 已实施）

- `TimelineSeed.log`（`packages/timeline/src/buildTimeline.ts#TimelineLog`）告诉时间线：事件来自哪份日志、窗口从哪个 seq 开始。服务端折叠（`apps/server/src/timeline/fold.ts`）每次建窗口时传入。
- 位置规则：
  - 有回显的 Run：行在回显的位置（不变）。引导消息的回执落在本回合首条输出之后时，行在回执位置。
  - 没有回显、`inputEntry` 属于这份日志的 Run：行在日志里 `meta.input` 的位置，按 seq 比较，不比较任何时钟。seq 早于窗口起点的跳过：它的行在已冻结的回合里。
  - 没有 `inputEntry`（或 generation 不符）的 Run：沿用 `placeRunRows` 原有规则。
- CLI 未记录的输入（样本中的 a）：行保留，状态取自 Run（如「已中断」）。是否已进入模型上下文无法确认，文案不做断言。
- 折叠规则变化加大了 `FOLD_VERSION`（17）。

### 4.3 回合终态

- 删除 `applyObservation` 的通用空闲完成规则和 `completesOnTurnEvent` 开关：所有后端都按回合结束事件完成。
- `reconcileIdleRun` 改为写 `meta.turn_ended(outcome_unknown)`，经投影结算 Run。界面上「待核对」期间仍显示进行中，收敛后才显示结果未确认（DELIVERY §6 规则 1 的方向不变）。
- 后端驱动的契约：每个回合必须产出带回合 ID 的 `meta.turn_ended`。来源可以是实时信号（hook、协议事件），也可以是对账（服务重启后读到 store 里该回合已答完）。只能看画面判断结束的后端，在驱动内部完成判断并指明回合，核心不接受无身份的结束。
- 投影：`DispatchFeed` 把 `meta.turn_ended` 翻译为 Run 结算，这是唯一路径；Run 上的 `expectsTurnOutcome`、`hookedTurns` 等「是否等结束事件」的判断随之删除。

### 4.4 证据隔离

- 尝试号在 `commitDispatchFence` 时分配，写进 Run 的投递记录。
- `busyAt`、`firstOutputAt`、空闲起点改记在尝试上；状态观测带 `activeTurn` 时，只有回合 ID 与本尝试一致才计入，不带回合 ID 的观测只计入写入时刻之后的。
- 删除 Cursor `interrupt` 结束时对 `paneBusyAt` 的重置（DISPATCH-ARCHITECTURE §4.4 第 3 条）。

### 4.5 替换回合

`replaceTurn` 的步骤与每步的结局：

| 步骤 | 前进条件 | 失败去向 |
|---|---|---|
| 停止 a | a 的 `meta.turn_ended(interrupted)` 已写，或确认 a 未被 CLI 记录 | `NATIVE_STOP_UNCONFIRMED`，b 回到队列 |
| 写入 b | 写入栅栏提交（同时写 `meta.input`） | 按 DELIVERY §3 |
| 等待 b 的回执 | 回执带新回合 ID | `uncertain` |

a「未被 CLI 记录」的判定由后端驱动给出（Cursor：store 和 live tap 都没有 a 的 request id，而下一个回合已开始）。

### 4.6 Cursor 的回合信号

现在的判定依次看画面、store 和 live tap，画面权重最大。改为按回合 ID 分层：

1. **协议流结束**：live tap 从 agent 流读到 request id（回合开始）和 `InteractionUpdate.turn_ended`（字段 14，回合结束），写入 live 文件。现在 turn_ended 只用于记用量（`usage_observations`）和封口。
2. **协议流中断与 CLI 报错**：流关闭而没有字段 14 时，live tap 记下该 request id 的流已中断；画面上的 CLI 错误文本（`watch.cliError`，已按 store 回合归属）给出失败原因。两者合起来结束为失败。
3. **store**：该回合已答完（`Transcript.turnState` 为 `answered` 或 `superseded`），用于服务重启后的对账和 live tap 缺失时（CLI 不是由 Riffet 启动、未注入 tap）。
4. **画面**：只用于对话框识别和进程存活，不参与回合开始和结束。

#### 实测：字段 14 的到达率（2026-11-27）

数据：生产库 `usage_observations` 与 `runs` 对照。范围是 2026-11-13（第一条用量观测）至 2026-11-27 的 Cursor 普通消息，共 994 条，均经 tmates 网关。

| 回合结局 | 条数 | 收到字段 14 |
|---|---|---|
| 正常完成 | 975 | 973（99.8%） |
| CLI 报错失败（网络错误、连接卡住、鉴权失败、服务端错误） | 9 | 0 |
| 中断（用户停止、被取代、结果未确认） | 9 | 2 |

- 正常完成的回合，字段 14 是可靠信号。未收到的 2 条属于同一会话的相邻两轮，推测当时的 CLI 进程没有注入 tap，由第 3 层兜住。
- 失败的回合不会收到字段 14，必须靠第 2 层。
- 中断由 Riffet 自己的停止路径写结束（DISPATCH-ARCHITECTURE A3），不依赖字段 14。

拿协议流的结束时间和 Riffet 当时的结算时间相比（973 条）：

- 中位数上，协议流比 Riffet 早 4 s（Riffet 要等画面空闲加 3 s 静默）。
- Riffet 比协议流早结算超过 10 s 的有 6 次（37 s 到 659 s，含样本故障）：这一轮还在跑就显示了「已处理」。
- Riffet 比协议流晚结算超过 30 s 的有 5 次（531 s 到 992 s）：这一轮早已结束，界面还在转圈。

两类错误在两周里共 11 次，都由「结束看画面」造成，改用第 1 层后都会消失。

### 4.7 可观测性

dispatch 日志的 `event=run` 增加 `source`（`hook`、`protocol`、`store`、`screen`、`reconcile`、`stop`）和 `turn`。时间线折叠在合并回执失败时记一行（`commandId`、回显的 nativeId）。

## 5. 各后端现状与改动

| 后端 | 结束信号 | 指明回合 | 回显关联 | 服务重启 | 是否受通用空闲规则影响 | 需要的改动 |
|---|---|---|---|---|---|---|
| Claude | Stop / StopFailure hook；转写的 `turn_duration`、Stop 汇总、中断标记（`claude/rows.ts`） | hook 的 `promptId` 可缺省；转写结束带回合 | 回显带 `commandId` | CLI 继续运行；hook 记忆丢失，靠转写结束行，否则空闲收敛 | 否（`reportsTurnOutcome` 命名回合后设 `expectsTurnOutcome`）；回合未被命名时是 | hook 缺 `promptId` 时由转写结束补出带回合的 `meta.turn_ended` |
| Codex / TraeX | app-server `turn/completed`；读历史时 `settleOutcome` | 是，RPC 回合 ID | 带标记的消息 ID | app-server 独立运行，重读线程补出结束 | 否（`completesOnTurnEvent`） | 无 |
| pi | 自身会话 JSONL 的回合结束；进程退出由 `finishDelivery` 结束 | 转写结束是；`finishDelivery` 用的是 `commandId` | 带 `commandId` | 不跨重启，重启前须无在途回合 | 否 | `finishDelivery` 改为指明原生回合 |
| chat | 自己写的回答记录带状态 | 是 | 带 `commandId` | 进程内；启动时把未结束回合记为中断 | 否 | 无 |
| Droid | JSONL `agent_turn_outcome`、实时 `agent_turn_completed` | 是，回合 ID 为发起它的用户消息 ID | `commandId` 在 `nativeAliases` | 不跨重启 | **是**（未声明 `completesOnTurnEvent`） | 只需删除通用规则，信号已具备 |
| DSH | 会话记录 `turn/end`（`reason.kind`） | **否**：事件带 `commandId` 和回合序号，没有 `nativeTurnId`（`dsh/events.ts#projectTurnEnd`） | 带 `commandId` | 不跨重启 | **是** | 结束事件和用户消息设 `nativeTurnId`（取会话记录的回合序号） |
| Cursor | hook（经网关时只有本地工具 hook）；`answered`：画面空闲 + store 答完 + 静默 3 s | hook 是；`answered` 的回合取 store 的最后回合，画面部分无身份 | 文本匹配（`untaggedEcho`） | CLI 继续运行；无 hook 记忆时从前台 Run 推断活跃回合 | 是（回合未被命名时） | §4.6；`answered` 只结束 store 指明且已答完的回合 |
| Antigravity | 守护进程轨迹步骤的终态（`_DONE`、`_ERROR`、`_CANCELED`） | 是，`executionId` | 服务端写的回执带 `commandId` 和回合 | 守护进程独立运行，重读轨迹补出结束 | 否（`completesOnTurnEvent`） | 无 |

要点：

- 删除通用空闲规则后，Droid 不需要额外工作；DSH 要先补回合 ID，否则 `turnOutcomeScope` 不接受它的结束事件。
- Claude 和 Cursor 是两个依赖「回合已被命名」才不走通用规则的后端，P2 之前它们在回合未被命名时（重启后、经网关、替换回合时）都会被画面空闲提前结算。样本故障就是 Cursor 的这一情形。
- 回显关联只有 Cursor 用文本匹配。T2 下文本匹配只建立关联；匹配失败时用户行仍在，只是缺回合 ID，与样本中 a 的处理一致。

## 6. 客户端

- 行全部由服务端折叠下发，四端不再自行放置用户行。
- 写入栅栏之前的本地占位行使用 `user:<commandId>`，与日志行同键。
- 回合状态读 `TurnOutlineV3.status`，不再从 Run 状态推断「已处理」。

## 7. 迁移

| 阶段 | 内容 | 删除 | 验收 |
|---|---|---|---|
| P0 | 样本故障写成用例，以 `it.fails` 标为已知缺陷：`dispatch.property.test.ts` 的模拟 CLI 加「画面不显示忙」，检查「Run 不早于本回合结束完成」（该性质同时加进原有性质，原有调度下成立）；`timeline/service.test.ts` 检查「写入过栅栏的消息不从时间线消失」 | — | 两个用例在当前代码上失败；修好的阶段把 `it.fails` 改回 `it` |
| P1（已实施） | `meta.input` 写入与 `inputEntry`；有 `inputEntry` 的 Run 按日志位置放置；客户端占位行键已是 `user:<commandId>`，无需改动 | 对有 `inputEntry` 的 Run 不再使用时间比较；旧规则只服务旧 Run | P0 时间线用例改为 `it` 并通过；`sync/sent-input.test.ts` 检查记录先于回显、只记一次 |
| P2 | dispatch 日志加 `source`、`turn`（§4.7）；终态单一路径；空闲收敛写 `meta.turn_ended`；按 §5 补齐：DSH 回合 ID、pi `finishDelivery`、Claude 缺 `promptId` 时的转写结束、Cursor `answered` 只认 store 指明的回合 | 通用空闲完成规则、`completesOnTurnEvent`、`reportsTurnOutcome`、`expectsTurnOutcome`、`hookedTurns` | P0 调度用例通过；各后端 `transcript-source` 测试 |
| P3 | 尝试号与证据隔离；`replaceTurn` 按 §4.5 | `paneBusyAt` 重置 | 「中断后立刻发送」「回合开始前画面空闲」两种时序的属性测试 |
| P4 | Cursor 按 §4.6 分层；live tap 记录流中断 | 画面参与回合判定的路径 | 重跑 §4.6 的对照：提前或滞后结算 0 次；`pnpm record` 补录制 |

每个阶段删除对应的旧规则，不与新规则并存。

已有会话的日志里没有 `meta.input`。日志只追加，无法在旧位置补写。切换之前创建的 Run 继续用现有的放置规则，切换之后创建的 Run 只走 `meta.input`；判断依据是 Run 有没有对应的 `meta.input`，不按时间。旧规则只服务旧数据，不再修改。

## 8. 范围之外

- 多服务器：行由会话所在服务器折叠，经链接只读，不新增路由。
- Mac：W 类，随同步协议生效，无单独改动。
- 性能：每条消息多一条日志事件；正文超过 `STORAGE_BUDGET.journalInlineBytes` 按 blob 存。

## 9. 已定事项（2026-11-27）

1. 旧会话的 Run 沿用现有放置规则，只对切换之前的 Run 生效（§7）。
2. Cursor 在四层信号都缺失时（store 解码失败、CLI 格式变化且没有 tap），等空闲收敛记为结果未确认，不再按画面空闲记为完成。
3. CLI 未记录的输入显示为「已中断」，不断言模型是否收到。
4. 字段 14 经网关可靠，见 §4.6 实测；P4 不需要另做前置验证。
