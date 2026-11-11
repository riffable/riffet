# 会话日志（Session Journal）与同步协议 v3

本文是会话数据从各 CLI 后端到 Web / Android / iOS / Mac 的目标架构，以及分阶段落地计划。

## 为什么要改

2026-10-18 的端到端探针与真实故障复盘指向同一个根：**Riffet 没有一份由服务端持有、序号在写入时分配的会话日志。**

- 转写不入库：`workbench.db` 只存 session / run 事件，转写由各后端在内存里现算。
- 序号各算各的：Claude 用重映射后的下标，合成事件用 `allEvents().length+1`，与随后读到的转写行撞号，客户端按 `sequence > lastSequence` 丢掉了回合的最后一条回答；Codex 按进程内首次出现顺序编号，服务重启后整体重排、generation 更换。
- 读取是全量的：Claude 每 300ms 重映射整份转写（>128MB 直接不解析）；Codex 每次轮询读取约 38MB、投影 1.67 万条目。
- 同步靠 reset 与补页：generation 一变，Mac 要把历史补到缓存里最老的事件（约 40MB、≥14 页、40s 预算、不可续传），补页期间状态帧排在同一串行队列后面，界面卡在「同步中」。
- 客户端无界：Web 超过 5000 事件就静默不缓存，Kotlin 缓存无单会话上限（实测单会话 40MB、Mac 内存 0.9–1.8GB），最后一个回合不虚拟化。

压力样本：「跑通 Arch Lab 并运行抖音 App」（Codex，rollout 428MB / 64057 行 / 20963 条目；最大单回合 13 小时、6844 条目、128MB、21 次 compaction；单条目最大 5.2MB）。

## 不变量

1. 每个会话一份日志；`seq` 在写入时分配，从 1 起严格连续，**跨服务重启不变**。
2. `generation` 标识一份日志的身份，只在日志被重建时更换。
3. 日志只追加。条目的更新（工具结果落定、流式消息定稿）是追加一条「同一 `nativeId` 的新版本」，不改写旧行，因此不存在「改写历史导致整段 reset」。
4. 服务端合成的事件（回合开始/结束、Run 终态、压缩边界）与转写事件写入同一份日志，共享同一编号空间。
5. 状态是日志的投影：会话状态、Run、回合大纲由服务端从日志折叠得出，带 `asOfSeq` 水位。投影可缓存；缓存可以落后、不能超前，校验失败从日志重建。
6. 控制信息（状态、交互、Run）与历史分离投递，**任何历史补齐都不得阻塞控制信息**。
7. 任何一帧、任何一处缓存都有字节上限；超限是显式降级（截断并提供按需加载），不是静默跳过。

## 存储（SQLite，`workbench.db`）

- `journal_events(session_id, seq, kind, native_id, rev, turn_id, at, payload, blob_ref)`，主键 `(session_id, seq)`，索引 `(session_id, native_id)`、`(session_id, turn_id)`。`payload` 有上限（默认 64KB）。
- `journal_heads(session_id, generation, last_seq, ingest_cursor, projection, projection_seq, updated_at)`：`ingest_cursor` 是后端特定的增量读取位置（文件偏移、RPC 游标等）。
- `blobs(hash, size, bytes, created_at)`：超过 `payload` 上限的工具输出、diff、图片等按内容哈希去重存放；事件里只留预览与 `blob_ref`。引用计数或周期性清扫回收。
- 写入在事务内完成：一批转写行 → 若干日志事件 + 新 `ingest_cursor`，原子提交，崩溃后从 `ingest_cursor` 继续，不重复不遗漏。

## 写入（各后端适配器）

适配器只做一件事：**从 `ingest_cursor` 增量读取原生数据，归一化后追加到日志**。

- Claude：转写 JSONL 按字节偏移增量读；hook 事件作为低延迟信号写入同一日志；回合结束前先读尽已落盘的转写尾部。不再全量重映射，去掉 128MB 上限。
- Codex / TraeX：以 app-server 通知为主，条目按 id 增量拉取；`thread/turns/list` 只用于修复，且分页、限量。
- Cursor：chat store 按行号增量扫描。store 每步只在 checkpoint 落一次，进行中的步骤（含新回合尚未落盘的 prompt）由注入 CLI 的 live tap（`plugins/riffet/cursor/assets/live-tap.cjs`）从 agent 流读出，作为草稿写在 store 将来给它的 id 下，store 记录后原位替换；store 一直没记录的回合以 interrupted 结束。
- Droid、DSH：通知 + 分页读取，补齐无进程时的文件追踪。
- 已有会话首次打开：后台分批把原生历史导入日志，完成前先以尾部窗口提供服务。

## 同步协议 v3（四端共用）

所有客户端同时切换，不保留 v2；未升级的旧版客户端收到明确的“需要升级”错误。

- 订阅：`subscribe { sessionId, generation?, afterSeq?, budget }`。服务端**先订阅再生成快照**并缓冲，衔接处按 `seq` 去重。
- 握手：`hello { generation, headSeq, projection(asOfSeq), outline }`。
  - `generation` 相同且 `afterSeq` 在保留范围内：只发 `afterSeq+1 … headSeq` 的增量（按字节预算分帧）。
  - 否则：发尾部快照 `snapshot { fromSeq, events }`，同时受字节与条目数上限约束；客户端丢弃窗口外的旧缓存，不再向前补齐。
- 实时：`append { seq, event }`，必须满足 `seq == last + 1`；出现缺口按区间请求 `range { fromSeq, toSeq }`。
- 历史：`page { beforeSeq, budget }` 向上翻页；`outline` 用于跳转到未加载的回合。
- 控制通道：`status` / `interaction` / `runs` 独立于历史通道下发，不依赖历史是否补齐。
- 大块内容：`GET /api/sessions/:id/blobs/:hash` 按需获取。
- 传输：单帧字节上限；所有客户端启用压缩。

## 客户端

Web 一套同步引擎；Kotlin 共享层一套，覆盖 Android、iOS、Mac。

- 常驻窗口有上限（条目数与字节双上限），超出从顶部淘汰，回翻时按页加载。
- 本地缓存：`generation + lastSeq + 窗口`，单会话与总量均有上限，LRU 淘汰；冷启动先显示缓存，再以 `afterSeq` 续传。
- 虚拟化覆盖所有回合（包括最后一个）并细到条目；大块内容默认折叠，展开时按需取 blob。
- 状态只来自控制通道与投影，不由客户端从历史重算。

## 指标（压力样本上验收）

- 打开会话到状态出现 ≤ 1s；首屏内容 ≤ 2s。
- 服务重启后重新打开：只走增量续传，无整段补页。
- Mac 打开压力样本时内存 ≤ 400MB；服务端空闲时无持续全量读取。
- 端到端探针（所有后端）每个场景都检查：`seq` 唯一且连续、每回合最后一条回答送达、状态与 CLI 一致。

## 分阶段

| 阶段 | 内容 | 验收 | 状态 |
|---|---|---|---|
| P0 | Mac / Kotlin：状态帧不被补页阻塞；generation 变化时丢弃窗口外旧缓存而非向前补齐；单会话缓存上限 | 压力样本在 Mac 上不再卡「同步中」 | 已完成 |
| P1 | 日志层（表、写入事务、投影、blob）；Codex 与 Claude 适配器改为增量写入日志，现有流改由日志供数（`seq`、`generation` 稳定）；随后接入 Cursor、Droid、DSH | 单测；压力样本离线导入的耗时与体积；全量探针 PASS；服务重启后 `seq` 不变 | 已完成 |
| P2 | 协议 v3 服务端 + Web 客户端；删除 v2 的 reset-tail / 窗口代码 | 探针改走 v3；压力样本指标 | 已完成 |
| P3 | Kotlin 共享层（Android / iOS / Mac）接入 v3，窗口与缓存上限 | 压力样本指标；Kotlin 编译与现有单测 | 已完成 |
| P4 | 删除残余旧路径；压力样本与全后端探针纳入常规回归 | 全部通过 | 旧路径已删除（2026-10-26，见 [SYNC-V3.md](SYNC-V3.md#u5b-已完成)）；全后端探针已改走 v3，尚未运行 |

## 系统活动（Activity）

CLI 自己发起的活动——上下文压缩、后台任务、本地命令输出——是会话里的一等事件，不是用户消息，也不只是一行工具调用。它们写入同一份日志（同一 `id` 的更新追加新版本），由投影得出「正在进行的活动」，并以一条独立于主回合的轴推送给客户端。

### 契约

```ts
type NativeActivityKind = 'compaction' | 'background_task' | 'local_command';
type NativeActivityStatus = 'running' | 'stopping' | 'completed' | 'failed' | 'stopped' | 'unknown';

interface NativeActivity {
  id: string;                 // 稳定：`${backend}:${nativeId}`
  kind: NativeActivityKind;
  status: NativeActivityStatus;
  title: string;              // 一行标题，如「上下文压缩」「npm test」
  detail?: string;            // 预览（≤ 2KB），已去 ANSI 与 CLI 标签
  blobRef?: string;           // 全文：GET /api/sessions/:id/blobs/:hash
  toolCallId?: string;        // 发起它的工具行，用于在时间线上定位
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  stop?: { via: 'protocol' | 'session' };  // 缺省 = 不可停止；'session' = 只能停止全部后台（Claude）
  compaction?: { trigger: 'manual' | 'auto'; preTokens?: number; postTokens?: number };
  task?: { kind: 'shell' | 'monitor' | 'agent' | 'workflow' | 'terminal'; command?: string; exitCode?: number };
  command?: { name: string };  // local_command：命令名，如 `compact`
}
```

- 事件：`type: 'session/update'`、`data: { sessionUpdate: 'activity', activity: NativeActivity }`，`nativeId` 为 `activity.id`；同一 `id` 的后续状态是新事件，客户端在首个事件的位置原地更新。类型定义见 `packages/contracts/src/index.ts` 的 `NativeActivity`。
- 续传：快照里每个活动只在首个位置、带最新内容；按锚点续传（及窗口截断）时，若活动首位置早于窗口起点而其最新状态晚于窗口起点，服务端额外下发该状态，`sequence` 取该状态自身的号（日志行 seq / 实时推送所用的新号），与实时推送一致，客户端按 id 原地更新（`transcript-window.ts` 的 `cut`，标记见 `journal/activity.ts` 的 `withRevision`）。
- 状态：`NativeStatus.activity?: { compacting: boolean; background: number }`，由投影得出；`compacting` 期间主回合视为忙碌，但客户端显示「正在压缩上下文」而不是笼统的「运行中」。
- 停止：`POST /api/sessions/:id/native/activities/:activityId/stop`。停止是请求：状态先变为 `stopping`，只有原生证据（Codex `thread/backgroundTerminals/terminate`、DSH `job.kill`、Claude `agents_killed` / task-notification 的 `killed|stopped`）到达才变为 `stopped`。`via:'session'` 的活动停止时会停止该会话的全部后台任务，客户端须如实提示。
- 全文：`GET /api/sessions/:id/blobs/:hash`，按需获取，客户端不预取。

### 呈现（四端一致，样式各自遵循平台）

- 进行中：时间线上一行（图标 + 标题 + 已用时长），压缩为「正在压缩上下文 · 0:45」；输入框上方「后台 N 个」入口，展开列出各任务，可停止的带停止按钮。
- 完成：默认折叠一行，压缩为「上下文已压缩 · 43.5 万 → 1.3 万 · 1 分 50 秒」；展开显示预览，再展开按需拉取全文；后台任务显示结果与退出码，展开显示输出尾部。
- 本地命令输出：一行低调的系统提示。
- 系统活动不是用户气泡，不触发「本轮由通知触发」的头部；发送 `/compact` 不再自动打开终端。

### 各后端映射

- Claude：后台 Bash（含超时转后台）、Monitor、后台 Agent、Workflow 按 `toolUseResult` 的任务 id 与 task-notification 的 `status` 映射（补 `killed`，修正通知被误标为子 Agent）；`PreCompact` hook（后台运行，stdout 不进摘要指令）→ 运行中的 compaction，`compact_boundary` + 压缩摘要行在原位完成为同一条（2.1.322 起 `/compact` 的命令行写在边界之后，过程中只有这个 hook）；`local-command-stdout` → local_command（`Compacted…` 并入 compaction）；`!` 命令的 `<bash-input>` 与随后的 `<bash-stdout>/<bash-stderr>` → 同一条 local_command（`task: { kind: 'shell', command }`，输入时 running、输出到达后 completed，detail 为输出尾部；CLI 不记退出码，stderr 不算失败；输出前来了新提示则记 unknown）；`/compact` 只保留一个用户气泡。停止：`via:'session'`。
- Codex / TraeX：`compacted` 记录与 `contextCompaction` item → compaction；后台终端经 `thread/backgroundTerminals/list|terminate`，`via:'protocol'`。
- DSH：`ctx.jobs` 事件 → background_task；`job.kill`，`via:'protocol'`。
- Droid：`Execute` 的 `fireAndForget`、`Task` 后台判定按 CLI 规则；`compacting_conversation` → compaction。
- Cursor：现有 job 映射为 background_task（`kind:'shell'`）；chat store 的每份压缩归档 → 一条已完成的 compaction，放在被压缩前缀的最后一条消息之后，摘要正文作 `detail` 预览（存储不记时间、触发方式与 token 数，均不声称）；`preCompact` hook → 运行中的 compaction（带 `trigger` 与压缩前 token），其归档落地后在原位置完成为同一条。
