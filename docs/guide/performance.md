# 性能与资源规范

返回 [中文 README](../../README.zh-CN.md)。

本文规定各端（服务端、Web、Mac、iOS、Android）在内存、CPU、网络和存储上的预算与写法。Android 与 iPhone 的帧预算与主线程规则另见 [Android 流畅度规范](android-performance.md)、[iPhone 流畅度规范](ios-performance.md) 与 [Web 流畅度规范](web-performance.md)。规则来自 2026-11-16 的一次全端排查：Mac 客户端运行 2.7 天后占用 857 MB、峰值 1.2 GB；服务端启动 5 分钟 RSS 774 MB；`workbench.db` 6.5 GB。各端的问题属于同几类，因此统一写在这里。

## 1. 原则

- **每份常驻数据都有预算**：上限写在 `packages/contracts/src/budgets.ts`，不在业务代码里另写数字。
- **每份常驻数据都有释放时机**：内存压力、进入后台、页面关闭、会话变冷。只有上限、没有释放时机的缓存，在压力到来前会一直占满上限。
- **按变化处理，不按全量处理**：流里的一帧只改动它涉及的行；列表只更新变化的会话。
- **可观测**：每端用同一组指标上报（§4），预算能被验证。

## 2. 预算

数值的唯一定义是 [`packages/contracts/src/budgets.ts`](../../packages/contracts/src/budgets.ts)。Web 和服务端直接导入；`pnpm gen:budgets` 把同一份数值写进 Kotlin 的 `Budgets.kt`，Android、iOS 和 Mac 通过 RiffetKit 读取。改预算只改这一个文件，然后运行 `pnpm gen:budgets`。

| 预算 | 含义 |
|---|---|
| `LANE_WINDOW` | 一条车道在内存里保留的转录行数与字节数 |
| `IMAGE_CACHE` | 解码后的图片与原始字节各自的缓存上限 |
| `IMAGE_DISPLAY_EDGE_PX` | 行内图片解码的长边像素；查看器另行解码原图 |
| `TEXT_CACHE_BYTES` | markdown、代码高亮、行排版等文本缓存的总和 |
| `TERMINAL_KEPT_ROWS` | 客户端终端保留的回滚行数；服务端种子仍带 `TERMINAL_SCROLLBACK_ROWS` |
| `STREAM_QUEUE_FRAMES`、`STREAM_QUEUE_BYTES` | 流与应用代码之间的帧队列上限，按帧数和字节数 |
| `WORKBENCH_APPEARANCE_BUDGET` | 工作台外观通道的连接、消息绑定、页面凭据和回执的上限及超时。连接关闭时清除绑定，回合结束后释放其目标 |
| `LIST_POLL_MS` | 会话列表轮询间隔：推送在线、推送断开、后台 |
| `STEADY_FOOTPRINT_BYTES` | 正常使用一天后的稳定占用；峰值不超过 1.5 倍 |
| `SERVER_BUDGET` | 冷会话时间线保留天数、后台任务单次读取上限、解析后转录缓存上限、事件循环阻塞阈值 |
| `STORAGE_BUDGET` | 日志内联与包络上限、Zstd 压缩阈值与 Tier-2 外部文件分流阈值、工具全文索引上限、在线增量页回收阈值、截断行按需展开 LRU 上限、归档冷输出裁剪策略 |
| `AGENT_PROCESS_BUDGET` | 会话 CLI 的空闲阈值与内存预算、内存压力下的缩短倍数、最短存活时间、Droid/Pi/DSH 的空闲停止时间、临时实例的空闲退出时间、扫除的宽限时间 |
| `PLUGIN_MARKET_BUDGET` | 可添加的插件源个数、单个索引大小上限、索引（含读取失败）缓存时长、同时读取的索引数、单次读取和整次列出的时限 |

各端的占用口径：Mac 用活动监视器的「内存」（`footprint` 的 phys_footprint），Web 用 JS 堆，iOS 用 phys_footprint，Android 用总 PSS，服务端用 RSS。

## 3. 规则

每条规则后面写明怎么检查。`pnpm check:perf` 能从源码文本识别的，由它拦截；确需破例的，在该行或上一行写 `perf-rules: allow <原因>`。

### 3.1 缓存有预算、有登记、有释放

- 新缓存的上限取自 §2 的预算。`NSCache`、`LruCache`、Coil、Web 的 `Map` 缓存都一样。
- 缓存登记到本端的缓存登记表（Mac `CacheRegistry`、iOS 同名类型、Android `CacheRegistry`、Web `cacheRegistry`），登记时给出名字、当前大小和清空方法。登记表统一响应：
  - 系统内存压力：Mac `DispatchSource.makeMemoryPressureSource`，iOS `didReceiveMemoryWarningNotification`，Android `onTrimMemory`；
  - 进入后台（手机）、窗口全部关闭（Mac）；
  - §4 的上报读取各缓存的大小。
- 模块级、静态的字典不能无上限地按会话、按项目、按公式累积；要么用有上限的 LRU，要么在会话删除或页面关闭时清理。
- 检查：`check:perf` 拦截没有上限的 `NSCache`，以及超过预算的上限。

### 3.2 流与缓冲有界

- 流到应用之间的队列不超过 `STREAM_QUEUE_FRAMES` 帧、`STREAM_QUEUE_BYTES` 字节。超出时丢掉队列，从最后应用的 seq 重新请求增量或快照。不用 `Channel.UNLIMITED`、不设上限的数组队列。
- 服务端给慢客户端的积压已有上限（`sync/connection.ts` 的 `slowBacklog` / `maxBacklog`），新的推送通道照此处理。
- 检查：`check:perf` 拦截 `Channel.UNLIMITED`。

### 3.3 按变化处理

- 推送优先于轮询：列表推送在线时轮询间隔不小于 `LIST_POLL_MS.pushed`。
- 增量优先于全量：列表用 `?since=` 增量；车道用 seq 增量。
- 一帧只更新它改动的行。不在每帧重建整份列表再整份交给界面层（Kotlin → Swift 桥接、React 的整窗口遍历）。
- 服务端热路径（每个请求、每个定时器周期）不整表读取再 `JSON.parse`；需要全量时缓存解析结果，按修订号失效。

### 3.4 长列表回收行

- 行数可能超过 200 的列表必须回收行视图：Web 用 `virtualRows` 一类的窗口化，Mac 用 `NSTableView` 或 SwiftUI `List`，iOS 用 `UICollectionView` 或 `List`，Android 用 `LazyColumn`。
- `ScrollView { LazyVStack }` 只延迟创建，不回收，不能用于会话列表这类可无限增长的列表。
- 「显示全部」同样走窗口化，不一次挂载全部行。

### 3.5 看不见的就释放

- 离屏渲染器（Mermaid、公式的 WKWebView）空闲后释放，下次使用再创建。
- 设置页等按需打开的面板，离开后释放视图，不按分区常驻。
- 手机进入后台时暂停流和轮询；Android 回合进行中的保活是例外，但保活期间同样受 §3.1 的释放约束。

### 3.6 图片按显示尺寸解码

- 行内图片按 `IMAGE_DISPLAY_EDGE_PX` 或实际显示尺寸（取较小者）解码，不解码原图。
- 原始字节不常驻内存；查看器和保存从磁盘缓存或服务端读取。

### 3.7 持久化数据有保留策略

- **三库物理隔离 + Tier-2 对象池 + 引擎参数调优**（`sqlite-storage.ts`、`journal/storage-migration.ts`）：状态目录下拆分为三个独立锁的 SQLite 数据库与一个外部大对象池，按角色配置 `PRAGMA cache_size`、`mmap_size`、`temp_store=MEMORY`、`auto_vacuum=INCREMENTAL`，并在后台维护与关闭前执行 `PRAGMA optimize`：
  - `workbench.db`（L0 权威控制库）：会话、项目、Run、任务、设置与统计事实，控制面写锁不受历史导入或索引触发器阻塞；`events` 表每个会话只保留最近 `STORAGE_BUDGET.sessionSnapshotsKept`（5）份完整快照；
  - `journal.db` + `blobs/`（L1 事实日志与 CAS 对象层）：`journal_events` 单行内联上限 `STORAGE_BUDGET.journalInlineBytes`（2 KiB，定长列前置、零溢出页）；超限载荷在锁外透明压缩，`hash`/`size` 保持明文语义——`<= STORAGE_BUDGET.blobDictMaxBytes`（16 KiB）的 JSON 对象使用内置静态共享字典（`zstd-d1`），更大对象使用标准 Zstd（`zstd`，level 3）；压缩后 `< STORAGE_BUDGET.blobExternalBytes`（128 KiB）存 `blobs` 表，更大的不可变对象分片落盘至 `blobs/<前2位>/<hash>.<codec>`；
  - `derived.db`（L2 纯派生缓存库）：`timeline_*` 与 `message_index` / FTS5，不包含任何唯一业务状态，启动打开时自动执行 `PRAGMA quick_check(1)`，损坏或升级时自动重建，在线备份跳过。
- **头尾分段保序去壳 + 部分索引减负**（`journal/journal.ts` 的 `compactSuperseded`）：每条车道维护单调水位 `compacted_seq`，只扫描新增 `rev > 1` 的行，将已滞后超过 `STORAGE_BUDGET.supersededLagMs` 且被新版本取代的旧 `draft`、`tool_call`、`tool_call_update`、`agent_message_chunk`、`agent_thought_chunk`、`session/update` 行清空 `payload='{}'` 并解除 `blob_ref`，保留 `seq`/`rev`/`digest` 不变；`user_message_chunk`、`meta.*` 与 `tombstone` 不去壳。`journal_turn` 等非唯一索引通过 `WHERE payload<>'{}'` 排除空壳行，不随历史压实膨胀。
- **派生数据 TTL + 容量 LRU 双约束回收与零写放大展开**：
  - 截断行（`timeline/budget.ts` 的 `fitRow`）对可从日志还原的行不再往 `blobs` 写重复的 `RowContent` JSON 拷贝，客户端请求 `/api/sessions/:id/blobs/:hash` 时由 `TimelineService.expandTruncatedBlob` 按需从 `journal.db` 重建，辅以受 `STORAGE_BUDGET.expandedRowCacheEntries` / `expandedRowCacheBytes` 约束的进程内 LRU；
  - 子 Agent 车道的汇总摘要（`rows`、`changes`）持久化在 `timeline_heads.summary`；冷清扫采用 **TTL（`SERVER_BUDGET.coldTimelineDays`）+ 总容量 LRU 上限（`STORAGE_BUDGET.timelineMaxBytes`，淘汰至 80% 滞回水位）** 双约束，将非活跃会话的**主车道与全部子 Agent 车道** `timeline_rows` 分块丢弃，下次打开按需从日志重折叠；
  - `message_index` 的工具行按 `STORAGE_BUDGET.toolIndexChars`（256 字符）非对称精简，维护期间增量回填旧超长行并合并 FTS5 段碎片（`merge` / 离线 `optimize`）；
  - 归档超过 `STORAGE_BUDGET.archivedTrimDays`（30 天）、未归档但长期沉睡超过 `STORAGE_BUDGET.inactiveTrimDays`（90 天）的非热非运行会话，以及个人助理主对话超过 `STORAGE_BUDGET.assistantTrimDays`（14 天，启用记忆整理时不超过 `assistant-consolidated-through`）的旧回合，后台维护对其超大工具纯文本输出执行首尾裁剪（保留全部对话、思考、diff 与文件路径）。
- **在线备份一致性与增量去重**（`system.ts`）：`createBackup` 在拍下 `workbench.db` / `journal.db` 快照前持有 `Journal.holdBlobGc()` 屏障，禁止备份窗口内删除被引用的 Tier-2 文件，若磁盘缺失被引用外部文件则显式报错而非静默产出残缺备份；不可变文件（`blobs/`、`attachments/`、`checkpoints/*/blob-*`）在单次备份内和跨备份间通过硬链接复用，不重复占盘。
- **在线微步缩容、离线重建与库外治理**：三个 SQLite 库均以 `auto_vacuum=INCREMENTAL` 运行，后台维护与冷清扫在事件循环空闲时分片执行 `PRAGMA incremental_vacuum`（`reclaimFreePages`）自动归还空闲页；需要整文件重建与全量字典重压时可使用停服 `riffet doctor --compact` 或设置页「存储空间」的下次启动重建（`storage/compaction.ts`），期间写 `maintenance.json`，Mac 客户端据此继续等待。在线与离线维护同时对同项目 Git checkpoints 做硬链接去重（`checkpoints/<projectHash>/.objects/`）并对 `workspace-observer/` 清理孤儿 diff 日志与已失效仓库的 shadow repo。
- 「存储空间」页的分项统计在 worker 线程里并行汇总三个数据库与 `blobs/` 目录（`storage/inspector.ts`），结果缓存为 `storage-scan.json`，超过一天才在后台重扫。

### 3.8 大文件流式读取，后台任务限量

- 后台任务（用量补算、标题、索引）单次读取不超过 `SERVER_BUDGET.backgroundReadBytes`；超出的跳过或分段读取，不整读进内存。
- 启动后的后台任务错峰执行，并在事件循环繁忙时让出（`eventLoopBusy()`）。
- 事件循环一次阻塞超过 `SERVER_BUDGET.loopBlockMs` 视为缺陷，`loop-health.ts` 记录并抓取 CPU profile。

### 3.9 运行时配置

- Kotlin/Native：`kotlin.native.binary` 的 GC 与分配器选项在 `apps/mobile/client/build.gradle.kts` 里集中设置，改动前后用 §5 的场景测 Kotlin 堆（vmmap 的 "Memory Tag 246"）。
- Node：不设 `--max-old-space-size` 之外的 V8 参数；插件子进程的上限见 `plugins-host/process.ts`。

### 3.10 子进程有所有者、有最后使用时间、有内存预算

服务为会话拉起的长期进程（会话的 CLI、tmux 服务、Codex app-server，以及 CLI 自己启动的 MCP 子进程）由 `native/reclaim.ts` 统一回收。Droid、Pi 是无终端的子进程，是否忙碌只有各自的 runtime 知道，所以由 runtime 自己在空闲后停止；DSH 的桥接进程由所有 DSH 会话共用，也自己停止。这三者的阈值同样取自 §2 的 `AGENT_PROCESS_BUDGET`。

**所有者**

- tmux 服务带两个标记：它服务的状态目录（`@riffet-state-dir`）和它的所有者进程（`@riffet-owner-pid`），见 `terminal/orphans.ts`。拉起时写在命令行里；接管了旧实例 tmux 服务的服务，每轮巡检把这两个选项重写成自己。CLI 与它的 MCP 子进程在 tmux 面板里，随面板或 tmux 服务一起结束。app-server 的所有者标识在它的 socket 目录名或 token 文件名里（`backends/shared/app-server-daemons.ts`）。
- 巡检按可达性扫除。以下几种情况说明 tmux 服务还有主人，一律保留：有存活进程的 control client 连着它；所有者进程还活着；持有状态目录 `server.lock` 的服务还活着。其余的满足下列任一条件，连同其中的 CLI 一起结束：
  - socket 已不存在；
  - 状态目录已不存在；
  - 状态目录在系统临时目录下。

  状态目录在别处的 tmux 服务，只要 socket 还在就保留，服务重启后会接管它。会话记录引用不到的 tmux 会话和 app-server 照旧扫除。
- 状态目录在系统临时目录下的实例（测试、探针、演示）：
  - 服务连续 `tempInstanceIdleMinutes` 没有请求、没有打开的连接、也没有进行中的回合时，自行退出；
  - 关闭时同时结束自己的 tmux 服务（`TerminalService` 的 `ephemeral`）；
  - vitest 跑完后，`tests/global-teardown.ts` 按同样的规则结束测试留下的 tmux 服务。

**预热进程**

为下一条新会话提前起的 CLI 或 app-server（`WarmPool`，docs/PLUGIN_ARCHITECTURE.md「预热」）不属于任何会话，不进上面的巡检，由池自己回收：每个 Agent 至多一个，页面不再续租满 `PREWARM_BUDGET.leaseMs`、页面释放、换了配置、启动失败、`readyTimeoutMs` 内没就绪，或空闲时自己退出，都立即结束；内存压力下不新起。服务关闭时池结束自己的；上一个服务进程留下的预留终端在服务启动时统一结束（`TerminalService.endPreviousWarmupsOnce`），预热的 app-server 没有会话绑定，按上面的所有者规则扫除。被会话接手后，它就是那个会话的进程。

**最后使用时间**

- 每个会话进程有一个 `lastUsedAt`，持久化在状态目录的 `agent-usage.json`，服务重启后保留。以下三种情况算作使用：
  - 回合开始或结束（会话的 `lastActivityAt`）；
  - 每次巡检时会话事件流或终端 WebSocket 上有订阅（终端输入只能经由订阅，因此一并覆盖）；
  - 面板文字相比上一次截取有变化。
- 面板文字先去掉自己会动的部分（`settledScreen`），再取摘要与上一次比较；摘要也持久化。还没有可比较的上一次截取时，这个面板处于 `unobserved`，本轮不回收。tmux 的 `window_activity` 只用来判断要不要重新截取，不能单独作为使用依据：tmux 会周期性地把所有窗口一起标为有绘制。

**保留条件**

满足任一条件的进程不回收；条件记在巡检结果里：

| 条件 | 判定 |
|---|---|
| `turn` | 有未结束的回合或 run |
| `interaction` | 在等待权限确认或用户回复，或会话处于失败状态 |
| `background` | 有后台任务，或正在压缩上下文 |
| `subscribed` | 会话事件流或终端 WebSocket 至少有一个订阅 |
| `terminal-held` | 终端已转交给外部终端程序（`terminalHold`） |
| `launching` | 启动未满 `minLaunchAgeMinutes` |
| `unobserved` | 面板还没有可比较的上一次截取 |
| `not-resumable` | 后端不能按原生会话 ID 恢复，或会话还没有可恢复的转录 |

**回收**

- 没有保留条件、并且 `now - lastUsedAt` 超过空闲阈值的进程被回收。回收时保留原生会话 ID，下一条消息在同一个线程上重新拉起。
- 各会话进程树（面板进程及其子孙，加上 app-server 的进程组）的 RSS 总和超出内存预算时，从 `lastUsedAt` 最早、没有保留条件、且至少 `memoryMinIdleMinutes` 没用过的会话开始回收，直到回到预算以内。
- 系统报告内存压力（macOS 的 `kern.memorystatus_vm_pressure_level`，Linux 的 PSI）时，空闲阈值除以 `pressureIdleDivisor`。
- 空闲阈值与内存预算的默认值取自 `AGENT_PROCESS_BUDGET`；设置里的 `idleReclaimMinutes`、`maxAgentMemoryMb` 只作为用户覆盖值。

**可观测**

- `GET /api/system/monitor` 的 `agentProcesses` 是上一轮巡检的结果：
  - 本轮实际用的空闲阈值和内存预算、内存压力、合计 RSS；
  - 按会话列出 RSS、`lastUsedAt`、保留条件和预计回收时间。
- 各端设置页的进程列表在会话行上显示保留条件或预计停止时间，列表头显示合计 RSS 与预算。

## 4. 度量

各端按同一组指标名上报，汇总到服务端 `GET /api/system/monitor` 的 `clients`，设置页的服务监控里能看到所有设备。

| 指标 | 含义 |
|---|---|
| `footprintBytes` | 本端口径的进程占用（§2） |
| `managedHeapBytes` | 托管堆：V8、Kotlin/Native、JS 堆 |
| `caches` | 缓存登记表里每个缓存的名字、大小、上限 |
| `streams` | 打开的推送连接数 |
| `hitches` | 上一个周期里超过 100 ms 的主线程卡顿次数 |

- 客户端每 5 分钟上报一次，进入后台时补报一次；服务端每台设备保留最近 6 小时。
- 采集只含数字和缓存名，不含会话内容、路径或标识。
- 已有的采集照旧：Mac `PerfMonitor`（帧与交互耗时）、Web `main-thread-monitor`（长帧）、服务端 `ServiceMonitor` 与 `loop-health`。

## 5. 验证

- **场景基准**：固定数据（3000 个会话、120 轮的长会话、含图片与长工具输出），各端用已有工具跑：Mac `PerfBenchmark`，Web `pnpm replay:transcript`，iOS 的 XCTest 内存场景（docs/IOS.md），服务端 `scripts/bench-sync-v3.ts` 与 `scripts/bench-timeline.ts`。结果记在对应端的文档里，逐版比较。
- **浸泡**：发版前让 Mac 客户端与服务端连续运行 24 小时，每小时记录 §4 的指标；GC 之后的占用不应持续上升。
- 以上不进每个 PR 的 CI（见根目录 AGENTS.md「测试与验证」）；CI 只跑 `pnpm check:perf` 与 `pnpm gen:budgets:check`。

## 6. 现状

与规则不符的现有代码。迁移了哪条就删哪条；新留下的不一致也记在这里。

### 服务端

- §3.7：统计分析明细表（`usage_steps`、`tool_calls`、`auxiliary_calls`）目前仍与控制面同处 `workbench.db`（L0），长期重度使用后会随历史线性累积；待统计口径稳定后可独立成分析库或按日汇总归档旧明细。
- §3.10：旧版本拉起的 tmux 服务没有所有者标记。socket 不在临时状态目录里的（`<临时目录>/riffet-<uid>-<hash>/tmux.sock`，状态目录路径过长时的位置）无法判断所有者，只在 socket 消失后扫除。这类服务只会越来越少，不另做迁移。

### Kotlin 共享客户端（Mac、iOS、Android）

- §3.3：每次发布整份重建 `TimelineItem` 列表并整份交给 Swift（`ui/state/SessionSync.kt` 的 `publish`）。未改的行复用原对象，但列表与桥接仍随窗口行数增长；先用 §5 的场景量出每次发布的耗时再改。
- §3.9：`pagedAllocator=false`、`latin1Strings=true` 尚未在 Mac 上做对照测量。2026-11-16 Mac 上 Kotlin 堆常驻 210 MB，抽样只有约 14% 的字节非零。iOS 已开 `appStateTracking`。

### Mac

- §3.4：侧栏 `ScrollView { LazyVStack }`（`Features/Sidebar/CustomSidebar.swift`），运行中实例化了 630 行。改成可回收的列表需要在运行的 App 上核对样式、悬停卡、右键菜单与键盘导航。
- §3.6：`ImageLoader` 的原图缓存仍在内存里（32 MB）；查看器与保存能否改为从磁盘缓存读取，取决于带设备令牌的请求能否命中 `URLCache`。

### Web

- §3.3：每次发布对整个窗口做 `transcriptTurns` 与 `flatMap`（`app/session/TranscriptView.tsx`、`app/session/useSessionSync.ts`）。增量做法：`timelineItems` 报告首个变化下标，转录分组从该下标续算，并只替换变化的尾部回合；同样先量再改。
