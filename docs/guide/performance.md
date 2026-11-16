# 性能与资源规范

返回 [中文 README](../../README.zh-CN.md)。

本文规定各端（服务端、Web、Mac、iOS、Android）在内存、CPU、网络和存储上的预算与写法。规则来自 2026-11-16 的一次全端排查：Mac 客户端运行 2.7 天后占用 857 MB、峰值 1.2 GB；服务端启动 5 分钟 RSS 774 MB；`workbench.db` 6.5 GB。各端的问题属于同几类，因此统一写在这里。

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
| `LIST_POLL_MS` | 会话列表轮询间隔：推送在线、推送断开、后台 |
| `STEADY_FOOTPRINT_BYTES` | 正常使用一天后的稳定占用；峰值不超过 1.5 倍 |
| `SERVER_BUDGET` | 冷会话时间线保留天数、后台任务单次读取上限、事件循环阻塞阈值 |

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

- 派生数据可以丢弃、按需重建：冷会话（空闲超过 `SERVER_BUDGET.coldTimelineDays` 且无人打开）的 `timeline_rows` 被丢弃，下次打开时从日志重新折叠，代际随之更换，客户端收到 reset 后重新取快照。
- 日志（`journal_events`）是历史的来源，随会话删除而删除，不按时间清理。
- blob 按引用回收（`releaseSessionBlobs`）。
- SQLite 文件不会因删除而变小（`auto_vacuum` 只对新建的库生效）；回收的页由后续写入复用。压缩文件用离线的 `riffet doctor --compact`。

### 3.8 大文件流式读取，后台任务限量

- 后台任务（用量补算、标题、索引）单次读取不超过 `SERVER_BUDGET.backgroundReadBytes`；超出的跳过或分段读取，不整读进内存。
- 启动后的后台任务错峰执行，并在事件循环繁忙时让出（`eventLoopBusy()`）。
- 事件循环一次阻塞超过 `SERVER_BUDGET.loopBlockMs` 视为缺陷，`loop-health.ts` 记录并抓取 CPU profile。

### 3.9 运行时配置

- Kotlin/Native：`kotlin.native.binary` 的 GC 与分配器选项在 `apps/mobile/client/build.gradle.kts` 里集中设置，改动前后用 §5 的场景测 Kotlin 堆（vmmap 的 "Memory Tag 246"）。
- Node：不设 `--max-old-space-size` 之外的 V8 参数；插件子进程的上限见 `plugins-host/process.ts`。

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

- §3.7：冷会话的 `timeline_rows` 不丢弃。2026-11-16 本机 748 个会话，`timeline_rows` 1.7 GB，其中空闲 7 天以上的 505 个会话占 968 MB。
- §3.8：用量补算整读转录文件（`stats/backfill.ts` → `backends/claude/history.ts` 的 `readFile`），没有大小上限。
- §3.3：`store.allSessions()` 每次整表 `JSON.parse`，会话列表请求与调度器多处调用。
- §3.1：`sync/ingest.ts` 的 `writers` 按会话常驻到进程结束。

### Kotlin 共享客户端（Mac、iOS、Android）

- §3.3：每次发布整份重建 `TimelineItem` 列表并整份交给 Swift（`ui/state/SessionSync.kt` 的 `publish`）。未改的行复用原对象，但列表与桥接仍随窗口行数增长；先用 §5 的场景量出每次发布的耗时再改。
- §3.9：`pagedAllocator=false`、`latin1Strings=true` 尚未在 Mac 上做对照测量。2026-11-16 Mac 上 Kotlin 堆常驻 210 MB，抽样只有约 14% 的字节非零。iOS 已开 `appStateTracking`。

### Mac

- §3.4：侧栏 `ScrollView { LazyVStack }`（`Features/Sidebar/CustomSidebar.swift`），运行中实例化了 630 行。改成可回收的列表需要在运行的 App 上核对样式、悬停卡、右键菜单与键盘导航。
- §3.6：`ImageLoader` 的原图缓存仍在内存里（32 MB）；查看器与保存能否改为从磁盘缓存读取，取决于带设备令牌的请求能否命中 `URLCache`。

### Web

- §3.4：侧栏「按时间」布局与「展开其余」一次挂载全部会话（`app/Sidebar.tsx`）。
- §3.3：每次发布对整个窗口做 `transcriptTurns` 与 `flatMap`（`app/session/TranscriptView.tsx`、`app/session/useSessionSync.ts`）。增量做法：`timelineItems` 报告首个变化下标，转录分组从该下标续算，并只替换变化的尾部回合；同样先量再改。
