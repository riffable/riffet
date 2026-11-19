# 同步协议 v3：实施规格

状态：已切换（2026-10-26）。目标架构、不变量与存储见 [SESSION-JOURNAL.md](SESSION-JOURNAL.md)；本文是各实施单元共同遵守的契约。v3 一次切换，v2 删除。

## 现状

- 只有 Codex / TraeX 写日志（`codex/index.ts` 的 `journaled`），其子 Agent 仍在内存里按 `index+1` 编号。
- Claude 没有写日志：按 `mapped.length+1` 重映射（`claude/history.ts`），只把活动全文写成 blob。
- Cursor 用 `position*STRIDE`、随机 generation（`native/transcript.ts`）；Droid、DSH 用 `*STRIDE`；三者的活动编号都由 `ActivitySequences` 现造。
- 服务端进程内的消费者也读这条流：dispatcher 回执、搜索索引、统计。

## 传输

保留 SSE（服务端 → 客户端）加 HTTP 请求，不改 WebSocket：SSE 的 gzip 已在三端验证，WebSocket 压缩在 Apple 端未验证；翻页与 blob 走 HTTP 可并行、取消、缓存，并沿用现有错误处理。

- 连接数：每个标签页只开 lists 流、1 条 sync 和已打开的子 Agent 车道；页面隐藏 60s 关闭 sync，回来续传。局域网 TLS 落地后开 HTTP/2。
- 控制通道独立：单连接内双队列写入，控制帧优先；转写帧每帧 ≤256KB，快照分块惰性生成，状态帧最多等一块。订阅与取快照在同一同步 tick 内完成（SQLite 同步读），不需要缓冲去重。

```
GET /api/v3/sessions/:id/sync?lane=main|sub:<toolCallId>&generation=&after=&budget=&rows=   SSE；也认 Last-Event-ID: <generation>:<seq>
GET /api/v3/sessions/:id/timeline?lane&generation&(before|from|around)=<pos>&budget&rows   → TimelinePage
GET /api/v3/sessions/:id/timeline/changes?lane&generation&after&budget                    → TimelineChanges（预取、补洞）
GET /api/v3/sessions/:id/outline?lane&generation
GET /api/v3/sessions/:id/find?lane&generation&q=<查询>                                   → LaneFind（会话内查找：整条车道按 pos 排序的命中行；客户端以 around=<pos> 翻到未加载的命中）
GET /api/sessions/:id/blobs/:hash                                                          不变
```

发送、引导、交互、停止活动等控制请求不变。

## 消息（`packages/contracts/src/sync.ts`）

```ts
export type SyncLane = 'main' | `sub:${string}`;
export interface RowEvent { type: string; data: Record<string, unknown>; createdAt: string; lastAt: string; runId?: string; nativeId?: string; nativeTurnId?: string; sourceIds: string[] }
interface RowBase { key: string; pos: number; turn: string; seq: number; rev: number; runId?: string; event: RowEvent; truncated?: { blobRef: string; bytes: number } }
export type TimelineRow = RowBase & (
  | { kind: 'user'; text: string; attachments: UserAttachment[]; pending?: 'queued' | 'preparing' | 'unconfirmed' | 'failed' }
  | { kind: 'assistant'; text: string; phase?: 'commentary' | 'final_answer' }
  | { kind: 'thought'; text: string; channel: ReasoningChannel }
  | { kind: 'tool'; job?: NativeJob; activity?: NativeActivity; subagent?: { lane: SyncLane; agentId: string; running: boolean; title?: string; subagentType?: string; model?: string; rows: number; turnId?: string; status?: TurnOutlineV3['status']; startedAt?: string; endedAt?: string } }
  | { kind: 'plan'; entries: Record<string, unknown>[] }
  | { kind: 'image'; src: string }
  | { kind: 'status'; tone: 'danger' | 'muted'; text: string }
  | { kind: 'task_notification' /* 字段同 web session/model.ts */ }
  | { kind: 'activity'; activity: NativeActivity });
export interface TurnOutlineV3 { turn: string; turnId: string; startPos: number; endPos?: number; status: 'running' | 'completed' | 'failed' | 'cancelled'; at: string; endedAt?: string; preview?: string; hasUserMessage?: boolean; hasAttachments?: boolean; rows: number; runId?: string }
export type SyncFrame =
  | { type: 'hello'; protocol: 3; lane: SyncLane; generation: string; headSeq: number; mode: 'delta' | 'snapshot'; session: Session; status: NativeStatus;
      interaction: NativeInteraction | null; runs: Run[]; activities: NativeActivity[]; context?: NativeContext; outline: { turnCount: number; turns: TurnOutlineV3[] }; catchingUp?: boolean }
  | { type: 'caughtUp'; generation: string; headSeq: number }
  | { type: 'snapshot'; generation: string; asOfSeq: number; part: number; final: boolean; rows: TimelineRow[]; hasBefore: boolean }
  | { type: 'rows'; generation: string; from: number; to: number; upserts: TimelineRow[]; deletes?: string[] }
  | { type: 'reset'; generation: string; reason: 'rebuilt' | 'promoted' | 'fold' }
  | { type: 'status'; status: NativeStatus } | { type: 'interaction'; interaction: NativeInteraction | null }
  | { type: 'runs'; runs: Run[] } | { type: 'run'; run: Run } | { type: 'activities'; live: NativeActivity[] }
  | { type: 'outline'; turnCount: number; turns: TurnOutlineV3[] } | { type: 'context'; context?: NativeContext }
  | { type: 'metrics'; metrics: StepMetrics; run?: RunMetrics; runId?: string; nativeMessageId?: string } | { type: 'session'; session: Session }
  | { type: 'error'; code: string; message: string; retryable: boolean };
export interface TimelinePage { generation: string; rows: TimelineRow[]; hasBefore: boolean; hasAfter: boolean }
export interface TimelineChanges { generation: string; headSeq: number; mode: 'delta' | 'snapshot'; from?: number; to?: number; rows: TimelineRow[]; deletes?: string[]; hasBefore?: boolean }
```

hello 的 `outline.turns` 为最近 50 个回合；`outline` 帧只带变化的回合，`rows: 0` 表示该回合已不存在（排队消息被撤回或被引导取代），客户端从大纲移除；`activities.live` ≤200。SSE `event:` 为帧类型，`id:` 只加在 rows 帧和最后一块 snapshot 上，每 15s 一次 `ping`。

大纲保留全部执行回合；提示词导航只使用 `hasUserMessage` 为真的回合，纯附件输入由 `hasAttachments` 标识，不把输出或任务通知回合命名为“附件”。两字段可选，旧服务端可按已加载用户行或非空 preview 回退。

Kotlin 侧 `kind`、`pending`、帧 `type` 一律宽松解码：未知值跳过该行或该帧，不让整条流失败。

### seq 与 generation

- `journal_events.seq` 只属于写入侧。同步使用**车道 seq**：`timeline_rows` 中某行内容摘要变化或被删除即得到 `seq = last+1`，按 `(session, lane)` 严格连续、持久化、跨重启不变。
- 不直接用日志 seq：draft、tombstone、meta 行对客户端不可见；Run 的变化不在日志里；折叠规则升级需要重折叠。
- `generation = sha1(journalGeneration + FOLD_VERSION)`，只在日志因身份变化重建、scratch→real 提升、折叠规则版本变化时更换。

### 续传与缺口

- generation 相同、`after ≥ floor`、变更行数 ≤ 2×budget 时，hello 为 `mode:'delta'` 后接 rows 帧；否则发 snapshot。
- 打开流时立即使用已有 journal 生成 hello 和快照／增量，provider 读取在后台进行，不把 pull 或 drain 放入首屏等待路径。
- 该读取进行中时 hello 带 `catchingUp: true`；读取结束（追平或失败）且折叠完成后发一次 `caughtUp`，`headSeq` 为当时的车道 head。控制帧先于排队的 rows 帧写出，客户端以 `held ≥ headSeq` 判定追平，不依赖到达顺序；没有 `catchingUp` 的 hello 在收齐自身的 delta／snapshot 后即视为追平。追平前到达的行是读者错过的历史：Web 不播入场和折叠动画，追平前挂载的末尾工具组与没有回答的过程组先收起，追平后再按实时规则决定是否展开。
- `rows.from ≠ held+1` 时带 `after=held` 重连；`to ≤ held` 丢弃；收到 `reset` 丢弃窗口外旧缓存、等待快照。客户端不再向前补齐。
- 新会话尚未生成原生转写是 `history.state='loading'`，不是读取失败。可重试的 `TRANSCRIPT_READ_FAILED` 在 history 恢复 ready 或有效快照／rows 到达后清除；其他错误仍按各自恢复条件处理。

### 错误归属与完成通知

- `NativeStatus.connection` 承载连接与写入归属冲突，`history` 承载原生记录读取结果；恢复只更新对应状态，不把同一诊断再写入 `notice`。
- `notice` 是当前会话提示，由生产端按条件清除；线程错误只由线程恢复或新回合启动清除，连接重连和历史读取成功不代表线程恢复。客户端把它放在会话反馈区，不追加为历史消息。
- 失败原因保存在 `meta.turn_ended.error`，时间线从该标记投影该回合唯一的错误状态行，覆盖没有 Riffet Run 的 CLI 自主回合；旧 `run_failed` 保留结算用途，展示服从已确认的回合结果。结束标记修订或作废时同步更新或移除状态行。
- Web 完成通知要求主车道大纲的 `status='completed'` 且有有效 `endedAt`；`phase='idle'` 仅表示当前不忙。首次 hello 建立历史基线，线程替换后由新 generation 确认的大纲重新建立基线；后续按原生线程与 `turnId` 去重，只有明确重开的回合恢复通知资格，重连或折叠 generation 变化不重发。未先观察到 running 的快回合用结束时间过滤旧历史导入，这条回退依赖客户端与服务端时钟；已观察到 running 的回合不依赖时钟比较。

### 预算

| 对象 | 上限 |
| --- | --- |
| 快照 | 默认 512KB / 300 行，可请求 [128KB, 2MB] / [50, 1000] |
| 翻页 | 默认 256KB / 100 行，最多 1MB / 500 |
| 单帧 | 256KB |
| 单行 | 64KB：文本超过 32KB 截为 16KB 预览加 `truncated.blobRef`；工具输出、diff 各 16KB；内联图片改为 blob URL |
| 连接积压 | 超过 8MB 持续一个心跳即断开；超过 32MB 立即断开 |
| 客户端窗口 | Web 2000 行 / 8MB；Mac 1500 / 6MB；手机 800 / 4MB。超出时让出离读者较远的一端，读者位置由界面告知；在底部时预取的更早一页放不下就丢弃，不让出末尾 |
| 客户端缓存 | Web 只存窗口尾部 500 行 / 1MB，最多 8 个会话；Mac / 手机等于窗口；Kotlin 总量 64MB，LRU |

## 时间线由服务端折叠

- `apps/web/src/app/session` 的 `projectEvents.ts`、`buildTimeline.ts`、`timelineTurns.ts` 原样搬到 `packages/timeline/`（纯 TS），服务端在 `apps/server/src/timeline/` 运行。
- 表 `timeline_rows(session_id, lane, key, pos, turn, seq, rev, run_id, deleted, payload)`，主键 `(session_id, lane, key)`，索引 `seq`、`pos`；另有 `timeline_heads`。
- 活跃车道用 `IncrementalTimeline` 增量折叠；冷启动只重折叠未结束的回合，pass 状态从已持久化行的 `run_id` 补齐。输入为车道日志、`store.listRuns` 与 jobs；Run 或 job 变化后合并 50ms 再重折叠尾部。
- 服务端下发的行：kind 与现有 TimelineItem 一致，带回合键与 runId；job 并入工具行；子 Agent 摘要；大纲。未被转写回显的 Run 作为 `pending` 用户行，`pos = 2^52`，键为 `user:<commandId>`，回显到达后原地移到真实位置，客户端不再按文本配对。
- 子 Agent 摘要以车道最新的首次 `turn_started` 为当前轮次，迟到的旧轮记录或任务通知不覆盖明确的当前状态；只有开始标记变化也会更新父工具行。冻结行及冷启动恢复同样保留这条关联。
- 后台 Agent 的 Activity 以 `toolCallId` 并入工具行，保留原 ID、耗时和停止能力。客户端只在已加载的工具携带同 ID、同发起调用的 Activity 时合并展示，分页窗口里缺少工具时仍显示独立 Activity；原活动行与停止协议不变。工具保留原始活动关联，耗时和停止入口只使用与当前轮状态一致且尚未过期的活动。冷启动只从每个 Activity 的最新版本恢复关联：同一 Agent ID 被新的工具调用复用后，旧工具行重启后不再带 `activity`（热折叠仍保留），摘要与独立 Activity 行不受影响。
- 客户端保留：渲染与平台自己的分组（`transcriptRows.ts`、`TimelineRows.kt`）、toolView / lineDiff 解析、按 runId 显示 Run 状态、本地 outbox 行（同键，服务端行到达后去掉）、覆盖所有回合的虚拟化与按需取 blob。
- Kotlin 保留 `TimelineItem`（`core/Model.kt`）作为 UI 接口，改为由 `TimelineRow` 构造；Swift 与 Compose 不变。
- 测试：`gen-timeline-fixtures.ts` 的逻辑对齐部分改为 `packages/timeline` 的投影契约测试（场景 → 期望 `TimelineRow[]`）；Kotlin 只做 `SyncFrame` / `TimelineRow` 的 max / min / future 解码测试；删除 `TimelineFixtures.kt` 与 `TimelineFixtureParityTest`。

## 写入契约（`apps/server/src/journal/ingest.ts`）

```ts
export interface LaneWriter {
  readonly lane: SyncLane; readonly generation: string; readonly cursor: string | null;
  commit(b: { events: NativeWorkbenchEvent[]; drafts?: { finalId: string; event: NativeWorkbenchEvent }[]; retire?: string[]; cursor: string | null }): void;
  turnStarted(turnId: string, at: string, runId?: string): void;
  turnEnded(turnId: string, status: 'completed' | 'failed' | 'cancelled' | 'interrupted', at: string): void;
  readonly activities: ActivityLedger; child(toolCallId: string, agentId: string): LaneWriter; rebuild(reason: 'identity-changed'): void;
}
export interface TranscriptSource {
  identity(): string | undefined;
  pull(w: LaneWriter, signal: AbortSignal): Promise<{ caughtUp: boolean }>;
  watch?(w: LaneWriter, wake: () => void): () => void;
  drain(w: LaneWriter): Promise<void>;
}
```

`NativeBackendDriver` 新增 `transcript(host, session, profile): TranscriptSource`，删除 `snapshot().events`、`history()`、`journalHistory()` 与 `subscribe` 中的 reset / append / subagent / job。每个后端必须满足：

- **G1** 不自行编号：不用 STRIDE、`length+1`、`ActivitySequences`。
- **G2** nativeId 由原生数据确定（uuid、item id、行号+part），重读与重启不变；更新是同一 id 的新版本。
- **G3** 每个可见事件带 turnId；每个回合（含在终端里直接输入的）都写 turn_started / turn_ended。
- **G4** 车道内按转写顺序追加；大会话首次导入走 scratch 尾窗再 promote，generation 只换一次。
- **G5** 不写 raw；超过 64KB 的 payload 由日志转为 blob。
- **G6** 写 turn_ended 前先 drain，读尽已落盘的尾部；`interrupted` 可能来自尚未落定的历史读取，原生数据恢复执行或给出其他终态时用 `turnReopened` 作废它并把游标退回该回合重读，已提交的完成 / 失败 / 取消不退回。
- **G7** 游标与行在同一事务提交；从任意已提交游标重放写入 0 行。
- **G8** 只有原生会话身份变化才 rebuild。
- **G9** 子 Agent 写入子车道。
- **G10** 活动只经 `ActivityLedger`。

状态、交互、context、metrics 走控制路径，不入日志。

已实现（`journal/ingest.ts`、`journal/ingest-contract.ts`）：

- `JournalLaneWriter.open(journal, sessionId)` 返回主车道 writer，每个会话一个；另有 `bindIdentity()`（G8）、`caughtUp()`、`identity`。为满足 G4 增加 `scratch`、`openScratch()`、`promote()`：车道已有游标后 `openScratch()` 抛错，保证 generation 只换一次。
- `pullLane(source, writer, signal)`：核对身份（变化则重建车道）、拉取，追上后提升所有 scratch。`servingKey()` 告诉投影与同步层哪份日志在为某车道供数。
- 车道是派生的日志键：主车道为 `sessionId`，子车道为 `sessionId#sub:<编码后的 toolCallId>`，scratch 为 `<键>#tail`（即 Codex 现有格式），不加列、不重写已有数据；`journal_heads` 增加可空的 `identity` 列。`child(toolCallId, agentId, info?)` 在父日志写入 `meta.subagent {toolCallId, agentId, lane, title?, subagentType?, model?}`，之后知道得更少的调用保留已记录的字段。
- 车道的 `ActivityLedger` 首次使用时从日志里仍在运行的活动恢复（部分索引 `journal_session_updates`），服务重启后后台命令照样能结束、能停止。`turnEnded(turnId, status, at, error?)` 把失败原因记在标记里，供 Run 结算。
- 结束标记的读取方一律看当前有效版本：`turnEndStatus()` / `hasTurnEnded()` 认 tombstone 为「未结束」；`turnReopened(turnId, at, cursor?)` 把原结束行写成 tombstone，并在同一事务里推进游标。时间线折叠与投影按 tombstone 恢复回合的 running 状态和草稿；dispatcher 按结束行版本（`outcomeRevision`）丢弃同批中过期的结果，只在最新修正不是取消时把 `provider_cancelled` 的 Run 改回运行（版本栅栏不持久化，重启后重放仍为取消的结束行不改动 Run）。
- `journal.onAppend(listener)` 在事务提交后报告 `{sessionId, lane, scratch, generation?, fromSeq, toSeq, reset?: 'rebuilt' | 'dropped'}`，回滚不报告；同一事务内对同一日志的追加合并为一个区间。
- 后端适配器的规则：每次 `pull` 都从 `w.cursor` 开始读；在 `commit` 之外的写入（回合标记、活动、`child`）之前先 commit；控制路径的写入写到 `w.scratch ?? w`。
- 契约测试：`runIngestContract(fixture, { openLastTurn?, watchMs?, maxPulls? })`，fixture 提供 `source()`（新实例即模拟重启）、`append`、`update`、`terminalTurn`，可选 `subagent`、`changeIdentity`、`order`，首次导入走尾窗时设 `scratch: true`。每一步之后与同一原生数据的全新导入比对；单项检查（`assertContiguous`、`checkLane`、`checkSession` 等）也可单独调用。

## 下线 v2

- v2 路由（`.../native/stream`、`.../native/snapshot`、`.../native/history`）直接删除，与未知路由一样返回 404；不支持旧客户端，新客户端通过 `/health` 的 `protocol.version < 3` 或 `/api/v3` 404 判断服务端过旧。
- `PROTOCOL_INFO = { version: 3, features: ['list-etag', 'sync-v3', 'integrations-v1'] }`。

已删除（约 1.9 万行）：服务端 v2 流与窗口（`routes/native.ts` 流部分、`streamSequence.ts`、`transcript-window.ts`、`ActivitySequences`、`withRevision`、各后端游标与 STRIDE）；Web 的 `nativeStream`、`reconcileSnapshot`、`sequenceTally`、`streamResume`、`nativeHistoryLoad`、`nativeTimeline`、`subagents`；Kotlin 的 `ProjectEvents.kt`、`NativeTimeline.kt`、`ResidentTranscript.kt`、`Subagents.kt`、`Model.kt` 的时间线部分、`NativeStream.kt`、`SessionStore.kt` 的同步部分、`TranscriptCache.kt`、`SessionSubagents.kt`；契约里的 `run-delta`、`reset-tail`、`NativeHistoryPage` 与 v2 `NativeStreamMessage`。

## 实施单元

| 单元 | 写入范围 | 依赖 | 验收 |
| --- | --- | --- | --- |
| U0 契约 | `contracts/src/sync.ts`、`mobile/contracts/.../Sync.kt`、fixture 生成 | — | typecheck；Kotlin 解码 future fixture，未知 kind 的行被跳过 |
| U1 写入契约 | `journal/ingest.ts`、`backends/types.ts`、`journal.onAppend` | — | fake source 跑通 G1–G10 |
| U2 投影 | `packages/timeline/**`、`server/src/timeline/**` | U1 | 现有 Web 时间线测试全绿；6844 条目的回合上单次追加 p99 < 20ms；压力样本离线折叠耗时与行表体积 |
| U3 同步服务 | `routes/sync.ts`、`server/src/sync/**` | U0、U2 | 4MB 快照写出期间状态帧延迟 ≤1 块；重启后只发 delta |
| U4a–e 后端写入 | Claude、Cursor（含 `native/transcript.ts`、`native/service.ts`）、Droid、DSH、Codex·TraeX 子车道，各自的 `backends/<x>/**` | U1 | G 契约测试；真实 CLI 探针检查 seq 唯一连续、每回合最后一条回答送达、重启后 seq 不变、状态与 CLI 一致；Claude 去掉 128MB 上限 |
| U5a 服务端接线 | `backends/service.ts`、`journal/feed.ts`、dispatch / 搜索 / 统计改读日志、各后端的回合结束路径 | U3、全部 U4 | v2 流照常；进程内消费者不再读 v2 推送泵；单步阻塞主线程 ≤ ~100ms |
| U5b 切换与删除 | 两端切换点、v2 路由与推送泵 | U5a、U6、U7 | 搜不到 `STRIDE`、`ActivitySequences`、`windowView`；全后端探针通过 |
| U6 Web 同步引擎 | `web/src/sync/**`、`useNativeSession`、`TranscriptView` | U0（先对 mock）、U3 | 状态 ≤1s、首屏 ≤2s；最后一回合也虚拟化；重开会话只走 delta |
| U7 Kotlin 同步引擎 | `client` 的 `SyncStream.kt`、`SessionSync.kt`、`TimelineCache.kt`，清理 `core` | U0、U3 | 编译与单测通过；Mac 打开压力样本内存 ≤400MB，不卡「同步中」 |
| U8–U10 Mac / iPhone / Android | 各自 app 目录 | U7 | 升级提示、大纲跳转、截断内容展开取 blob |
| U11 探针与基准 | `scripts/probe-sync-v3.ts`、`scripts/bench-sync-v3.ts` | U3 | 作为其他单元的验收工具 |

发布顺序：手机版本先提审并挂起；发布 Mac 与服务端（含 Web）；随即放出手机版本。

## 风险

1. 巨型回合的折叠开销：增量折叠、活跃车道 LRU、`worker_threads`。
2. 规则漂移：时间线代码先原样搬运；录制真实会话，对比 v2 Web 渲染的行与 v3 服务端行，之后再改规则。
3. Claude 适配器工作量最大：nativeId 由消息 uuid + part 推导，不用重映射下标。
4. scratch 提升与 `FOLD_VERSION` 升级都会换 generation，不得循环。
5. `timeline_rows` 约复制一份转写；冷会话的行可丢弃（代价是换 generation），纳入存储保留策略。
6. 发布窗口内旧 App 无法连接新服务端，更新后才能使用。

## 进度与切换前待办

| 单元 | 状态 |
| --- | --- |
| U0 契约、U1 写入契约 | 已完成 |
| U2 投影 | 已完成；6844 条目的回合上追加 p99 约 10ms |
| U3 同步服务、U11 探针与基准 | 已完成；热打开到 hello 约 9ms，服务重启后续传约 75ms |
| U6 Web 同步引擎 | 已完成 |
| U7 Kotlin 同步引擎 | 已完成；Mac 构建与单测通过 |
| U4a–U4e 全部后端 | 已完成；本机真实会话只读导入通过契约检查（Claude 30 个共 750MB、Codex 9 个含 420MB 压力样本、Cursor 107 个、Droid 47 个、DSH 195 个） |
| U5a 服务端接线 | 已完成，见下 |
| U5b 切换与删除 | 已完成（2026-10-26），见下；真实 CLI 探针已逐个后端运行，结果见遗留 |

### U5a 已完成

- [x] 日志：车道的 `ActivityLedger` 首次使用时从日志里仍在运行的活动恢复（`activityEntities`，部分索引）；`meta.subagent` 记录 `title`/`subagentType`/`model`；`releaseSessionBlobs` 释放被取代的截断行 blob（行换版本、删除、车道重建、`timeline.drop`）。服务停机期间的 Run 变化在车道下次打开时带回已折叠的回合；时间线只折叠有人持有或订阅的车道，其余在下次读取时折叠。
- [x] 回合结束：服务把 ingest 交给后端（`host.transcript`：`drain`/`endTurn`/`withSource`/`wake`），写到 `w.scratch ?? w`，且都先 drain。Claude：CLI 退出由 `exited()` 交给 source，在读尽之后结束回合与遗留活动，Stop hook 不写 `turn_ended`，`settleActivities` 已移入 source（子 Agent meta、任务输出文件）；Cursor：hook 与回答落定路径调用 `source.endTurn`；Droid：进程在回合中退出时 `endOpenTurns`；DSH：进程崩溃后 `endOpenTurn`，DSH 恢复会话时写的收尾记录不再重复。Codex 的回合起止由 source 自己从线程读到。
- [x] 跟随：provider watch 存在且有人监听、有未结束的 Run 或 provider 在运行时，服务端 `ingest.follow` 该会话，与是否开着 v3 流无关。dispatcher 回执（`backends/dispatch-feed.ts`）、搜索索引（`LiveTranscriptIndex.observeEntities`）、统计（`NativeBackendService.readJournal`）都改读 `journal/feed.ts`；回执的 baseline 取服务车道日志的末行，Run 结果取自回合起止标记（失败原因在 `turn_ended.error`）。
- [x] Codex：服务挂上 ingest 后，v2 运行时不再写日志（只读的 `CodexJournalSpace`，内存编号），也不再导入历史；v2 客户端的转写由 codex/journal-view.ts（已随 v2 删除）从 v3 写的日志供给（新实体追加、活动新状态按行号追加、草稿按块下发、其余变化发 reset；历史翻页读同一份日志），编号与 generation 跨重启不变。后台终端轮询在有 v3 reader 跟随时继续。失败回合的原因写进结束标记。
- [x] 其余接线：jobs 接入 TimelineService（`listJobs`/`onJobChanged`）；`watchControl` 只收控制消息，不再挂在 v2 转写监听者上；DSH 的 `stopActivity` 走车道 ledger；DSH 只有子会话或 DSH 自己界面写入时，由 bridge 的 `session/changed`（旧宿主忽略）与会话目录监视唤醒 source。服务端目前没有删除会话的路径（只有归档），因此没有接 `timeline.drop` + `ingest.forget`；将来加删除时一并调用。
- [x] 主线程：各后端读取按时间片让出事件循环（Claude 25ms、Cursor 40ms、Droid/DSH/Codex 20ms），DSH 跳过前缀时也会让出、导入期间复用同一份已读日志；时间线折叠每步最多 1000 行日志（首次折叠、导入时分多步，`ready()` 等到折完）；Codex 活动对账改走活动索引而不是整份 projection。实测（真实会话副本与合成样本，含 JournalFeed、搜索索引与 v3 时间线订阅）单次事件循环最长：Claude 54ms、Cursor 80ms、Droid 49ms、DSH 40ms、Codex 82ms。
- [x] 新错误码已进入 `i18n/errors/sync.json`（zh/en）。

### U5b 已完成

- [x] 两端只走 v3：Web 去掉 localStorage 开关与 `sessionConnection.ts`，Kotlin 去掉 `SyncProtocol`；`PROTOCOL_INFO.version = 3`。
- [x] 服务端删除 v2：`routes/native.ts` 的 stream/snapshot/history 路由、`streamSequence.ts`、`transcript-window.ts`、`ActivitySequences`、`withRevision`、`STRIDE`、各后端 `snapshot()`/`history()`/`journalHistory()`、`paged`/`full` 转写泵与 `windows`。驱动的 `subscribe` 只发控制消息（`NativeControlMessage`：status、context、metrics、job、session、subagent 运行态），转写只经 `transcript()`（现为必需）进日志；Run 结束等转写之外的事件走 `host.emitEvent`。
- [x] dispatcher 有自己的观察形状（`DispatchObservation`），不再依赖 v2 消息；DSH 等不报活动摘要的后端，状态里的活动摘要由服务从车道 ledger 补上。
- [x] Codex：删除 `journal-view.ts`、只读 space 的历史分页、`event-diff.ts` 的 diff 部分、`index.ts` 的 `journaled`/`journalHistory`/`history`/`snapshot`；`subagents.ts` 不再编号。Claude：`emitRunTerminal` 只在转写不记录结束时经 `host.emitEvent` 报告。Cursor/Droid/DSH 去掉 v2 ledger、`DshActivities`、STRIDE 与分页游标。
- [x] 契约删除 `run-delta`、`reset-tail`、`NativeHistoryPage` 与 v2 `NativeStreamMessage` 的转写变体；搜索索引去掉 v2 的 `observe`。
- [x] Web：删除 `useNativeSession`、`nativeStream`、`reconcileSnapshot`、`sequenceTally`、`streamResume`、`nativeTimeline`、`nativeHistoryLoad`、`prefetch`（v3 打开是一次有界的服务端折叠快照，最近 8 个会话缓存后重开只走 delta，预取没有收益）及其测试、`SubagentSession` 与 `subagents.ts` 的 v2 分支、`nativeOutbox` 的文本配对与 `heldSequence`；`connectionNoticeState`、`transcriptLoadView` 移到 `app/session/transcriptLoad.ts`。回合导航改用引擎：大纲取 `loadOutline()`，未加载的回合经 `jump()` 载入后定位。
- [x] Kotlin：删除 core 的 `ProjectEvents.kt`（`ProjectedEvent` 已移出）、`NativeTimeline.kt`、`ResidentTranscript.kt`、`Model.kt` 的 `buildTimeline`、`Subagents.kt` 的 v2 部分；client 的 `NativeStream.kt`（`StreamConnection`、`isUnauthorized` 移到 `StreamConnection.kt`）、`RepairTranscript.kt`、`SessionSubagents.kt`、`TranscriptCache.kt`（列表缓存移到 `ListCache.kt`）、v2 API 调用、`SessionStore` 的 v2 部分、`prefetchOne`、`indexEntries`；对齐 fixture 与流驱动的 `SessionStore*Test`。`scripts/gen-timeline-fixtures.ts` 只生成 v3 同步 fixture。
- [x] 探针：`scripts/probe-sync-e2e-lib.ts` 在临时状态目录起进程内服务，经 `/api/v3/.../sync`、`/timeline/changes`、`/outline` 检查每条车道 seq 连续且唯一、每回合最后一条回答送达、重启后 seq 与 generation 不变且续传为空 delta、Run/状态/大纲与 CLI 一致。`probe-claude-e2e.ts`（`--source <模型源 ID>`）、`probe-droid-e2e.ts`、`probe-traex-e2e.ts` 改读 v3，新增 `probe-codex-e2e.ts`、`probe-cursor-e2e.ts`、`probe-dsh-e2e.ts`；CLI 不存在时以退出码 2 立即结束。`probe-codex-recovery.ts`、`probe-codex-subagents.ts` 只测 CLI 协议，不涉及同步。
- [x] 搜不到 `STRIDE`、`ActivitySequences`、`windowView`、`reset-tail`、`run-delta`。
- [x] 切换后补齐：Mac 的子 Agent 面板与 iPhone、Android 一样读 `TimelinePresenter.subagent`（子车道），删除只返回空的 `subagentTimeline`；`SubagentPresentation` 带上车道的 `loaded`/`hasBefore`/`error`，「加载更早的执行记录」按 `hasBefore` 显示。打开会话时的回合速度：主车道 `hello` 之后紧跟 `StatsLedger.sessionMetrics` 的每回合 `metrics` 帧，`metrics` 帧新增可选的 `nativeMessageId`（终端里直接输入的回合没有 Run，客户端以 `native:<id>` 记），实时帧也带上；Web 与 Kotlin 按它记录，Kotlin 剪枝 run 列表时保留 `native:` 键。

遗留：

- 真实 CLI 探针（2026-10-26）：Codex、Cursor（需 `--cursor-cli` 带上服务的网关设置）、Droid、TraeX 通过；DSH 默认路由缺 `DEEPSEEK_API_KEY`、Claude 的模型源目录里唯一可用模型返回 403，两者以环境跳过（退出码 2）结束。据此修正：Droid 把回合的 runId 标到该回合每个事件上；dispatcher 先读完转写再接受点名新回合的状态，免得上一回合的结束晚到而被判为未确认；`dispose` 先 drain 再停止读取，不再经已关闭的 app-server 读。
- Claude 真实 CLI 探针（deepseek-v4.1-flash）的后续修正：
  - 发起后台任务的回合被判为「结果未确认」（场景 5、13）：Claude Code 先发下一回合（任务通知）的 UserPromptSubmit hook，上一回合的 `turn_duration` 稍后才成批落盘，dispatcher 那次读日志时上一回合还开着。`dispatch-feed` 在状态点名新回合、而日志里上一回合仍未结束时，最多 2s 内每 50ms 再读一次。Stop hook 之后到 `turn_duration` 之前（其他 Stop hook 未跑完，本机插件 hook 超时 10s）phase 已 idle、Run 仍在运行。已修正：正在等待回合结果的 Run 用 60s 的对账宽限（`IDLE_OUTCOME_GRACE_MS`），不再在 15s 时先判未确认再改正；仍未收到结果时依旧按未确认收尾。
  - 后台任务的 `stopping` 只进了运行时的状态摘要，没进日志（v2 由流下发），客户端从 running 直接跳到 stopped（场景 13）。现在同时写入车道 ledger，CLI 没停下的改回 running。
  - Monitor 的第一条事件可能早于它的启动结果进入 CLI 队列，活动的首个状态没有 `toolCallId`（切换前已存在）；现在取尚未返回结果、描述相同的 Monitor 调用。
  - 探针：场景 11 在较慢模型上超出 300s 预算，改为再加 300s；场景 5 的 CLI 结束发起回合后立刻处理子 Agent 的通知时，改为检查状态随之为 busy。
- 后端内部仍保留只为控制路径服务的 v2 时代读取。逐个看过，都不是小改动，暂不改（不改协议，以后单独收窄）：
  - Cursor `NativeService` 在内存中映射 chat store：同一份映射还供标题、输出速度（`CursorTranscriptMeter`）、子 Agent 发现、后台任务、活动时间、`turnObserver` 与 Cursor 自己的工具统计（`ownsSessionObservation`）使用，压缩活动的结束也靠它的 `append`。改读日志要把这些消费者一起迁到 `journal/feed.ts`，并处理日志只在会话被跟随时才写入的时间差。
  - Claude 运行时的 `ClaudeTranscript`（`history.ts`）：回合状态由 Stop hook、`turn_duration` 行、中断标记、排队操作与发送中的 Run 共同决定，日志的回合起止只是其中一部分输入；`injectActivity` 的 `mapped.length+1` 只在这份内存映射里编号，不进日志。改读日志等于重写状态机。
  - Codex 运行时的常驻事件与 `CodexJournalSpace`：常驻事件还承担草稿与已提交条目的对照、TRAE 位置 id 的去重、计划、标题、回合结果与命令归属；没有挂 ingest 的宿主（单测、工具）里运行时仍自己写日志（`journalRead === false`）。删掉需要把这些判断改为读 `transcript-source.ts` 写的日志并改写对应测试。
  - Droid 的 `state.events`：用于标题、子 Agent 登记、`fireAndForget` 的调用参数与「回合结束前是否见过提问」，打开时 `loadTranscript` 读会话文件也为了 Droid 自己的消息 `seq`（实时工具结果的 id 依赖它），日志里没有这个数。DSH 的 `state.events` 只剩去重集合的作用，子 Agent 的运行态仍由 RPC 读子会话页判断；两者都与实时通知交织，不是单点替换。
- 删除的 v2 测试（2026-10-26 补齐）：在 v3 路径上重写了控制行为——Codex 的 context 窗口三条（provider 给出的窗口、从 rollout 补窗口、`thread/contextUsage` 的分项与缓存写入）、审批映射（含失败回合的原因经 `transcript()` 写入 `turn_ended` 并脱敏）、异步提问在别处回答与随回合结束清除、取消提问等待 `turn/completed` 且不编造答案（`codex/index.test.ts`）；同步服务的 `interaction` 帧（`sync/sync.test.ts`）；`StatsLedger.sessionMetrics` 的断言（`stats/ledger.test.ts`）。有意不移植：
  - 只验证 v2 机制的：单调 seq 与 generation（换连接、重启、重读同一线程）、常驻上限之外的历史分页、Codex session journal 四条、草稿在中途快照里的保留与位置、子 Agent 的分页与「首个快照之后只发增量」、DSH/Codex 活动「锚点之前出现、离开期间结束」的续传、Droid/Cursor 的流式文本编号与分页游标、`service-history` 的历史加载失败与 `prefetch` 的 watch 续租。v3 的对应不变量由 `journal/ingest-contract.ts` 的 G1–G10 契约测试、各后端 `transcript-source` 测试与 `sync/sync.test.ts` 覆盖。
  - 断言 v2 流里 `run_completed`/`run_failed`/`native_input_receipt` 事件的（Claude 的 Stop 与回执、Droid 的预算耗尽 `run_failed` 与 provider 通知行）：Run 现在由 dispatcher 读日志的回合标记结算，这些事件不再出现在流里；回合结束本身由各后端的 transcript-source 测试与 `dispatch-feed.test.ts` 覆盖。
  - 以 `snapshot()`/`reset` 驱动的 Codex 连接归属与重连（换 profile 时不复用待建运行时、冷读历史不占写者、观察者需新的 loaded 证据、快照或发送后重连并重新挂上监听者）：行为仍在，但这些测试的入口与断言都是 v2 快照和 `append`。2026-10-26 已在 v3 路径上补写（`codex/index.test.ts` 的 “Codex reconnects”：回合中掉线、子进程崩溃但线程未落定、发送中掉线与 fence、重连后重挂监听者、换 profile 建新运行时、冷读不占写者、观察者需新的 loaded 证据）；其余归属规则仍由「Codex native protocol controls」中保留的测试覆盖。
- Codex app-server 在回合中崩溃且线程从未落定时，回合靠 dispatcher 的空闲对账结束，日志里一直开着；Cursor 旧版以压缩后根位置为键的回执没有别名；Claude、Cursor 的日志行仍沿用 24KB 文本截断；服务端生成的行文本（如 `status` 行）仍是中文，需随错误码契约改为 code + 参数。
- `RiffetConnectionState` 没有专门的「服务端过旧」状态；`RunState` 等仍为严格枚举（Swift 与 Compose 穷举 switch，v3 的 run 列表跳过无法解析的 run）。
- 规格补充：可重试的 `error` 帧是流不中断的提示，下一批 rows 或 hello 即视为清除；截断行的 blob 是去掉 `seq`/`rev` 的整行 JSON；`TimelinePage` 没有 `headSeq`，客户端按行 `seq` 处理；回显后的 pending 行保持 `user:<commandId>` 键；`/outline` 的响应形状、不带游标的 `/timeline/changes`、snapshot 模式的 `asOfSeq`、「最新一页」锚点，以及多个 pending 行同处 2^52 时的次序（客户端按 `createdAt`）都要写明；`TimelineItem` 没有位置容纳 assistant phase、task-notification 的附加字段和 `row.turn`。
