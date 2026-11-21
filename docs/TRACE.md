# 会话追踪

会话追踪按日志原样读一个会话：每一行、每一次修订、对话里隐藏的行（`meta.*`、草稿、tombstone），统计账本记下的每次模型请求和运行的派发时间，以及 Agent 在自己的转写里记下的请求内容：系统提示词、工具定义、请求参数和它注入的消息。它面向排查：为什么慢、哪一步失败、Agent 实际收到和返回了什么。

状态：**服务端与 Web 已实现**；Mac 与手机不做（见「各端」）。

## 1. 组成

| 部分 | 位置 | 职责 |
| --- | --- | --- |
| 只读接口 | `apps/server/src/routes/trace.ts` | 三个 GET，按车道读 `journal.db` 与 `workbench.db`，不折叠、不缓存 |
| 行索引 | `apps/server/src/journal/trace.ts` | 只用行的内联列生成索引行，不读 blob |
| 用量 | `apps/server/src/stats/query.ts#sessionUsageSteps` | 一个会话的 `usage_steps`，去掉被另一观测取代的步 |
| 请求内容 | `NativeDriverStored.requests`：`backends/claude/request-records.ts`、`backends/codex/request-records.ts`，公共部分在 `backends/shared/trace-requests.ts` | 读 Agent 自己的转写文件，不经日志库 |
| 契约 | `packages/contracts/src/trace.ts` | `TraceSummary`、`TracePage`、`TraceRow`、`TraceRowDetail` |
| 视图 | `plugins/riffet/trace`（内置插件 `riffet.trace`） | 会话视图 Trace：时间轴、调用 / 日志两种读法、检查器 |

数据由核心提供，界面放在内置插件里：插件不能注册路由，也读不到日志库；做成插件的视图可以整体关掉，核心不多一个页面。插件经 `WebPlugin.access.requests` 声明只请求 `/api/sessions/*/trace`（`*` 匹配一段路径）。

## 2. 接口

都在 `/api/sessions/:id` 下，由会话可见性钩子统一过滤（`apps/server/src/routes/AGENTS.md`）。回答大于 16 KB 且客户端接受时用 gzip。

| 路由 | 回答 | 说明 |
| --- | --- | --- |
| `GET /trace` | `TraceSummary` | 各车道的 generation、`lastSeq`、行数、子代理标题与模型；最近 `TRACE_BUDGET.usageSteps` 次模型请求 |
| `GET /trace/rows?lane&generation&after&limit` | `TracePage` | 按 seq 的索引页，默认 `pageRows`、至多 `maxPageRows` 行；`next` 缺省表示读到头 |
| `GET /trace/rows/:seq?lane&generation` | `TraceRowDetail` | 一行的完整载荷，blob 已解析；超过 `detailBytes` 时给 JSON 文本的开头并标 `truncated` |
| `GET /trace/requests?lane` | `TraceRequests` | 车道的请求内容（§2.1），每次调用整份读一遍 |

- `generation` 与车道当前的不一致时回答 409 `TRACE_GENERATION_CHANGED`，视图从头重读。
- 索引行的 `type`、`status`、`name`、`text` 等取自内联列。溢出到 blob 的行，内联列是 `previewOf` 留下的摘要，所以一页索引不读 blob。
- `cleared` 表示后台整理已把这一版本清空为 `{}`（`compactSuperseded`），时间和摘要仍在。
- `missing` 表示存储里已没有这份 blob，详情只能给内联摘要。

上限都在 `packages/contracts/src/budgets.ts#TRACE_BUDGET`。

### 2.1 请求内容

Agent 在自己的转写里记下了每次请求带了什么，服务端按需从这些文件读出来，不复制进日志库：内容大、每次请求重复，而且文件本来就在会话所在的服务器上。驱动通过 `NativeDriverStored.requests` 提供，只读文件、不启动进程；没有实现的驱动回答 `unsupported`。

| Agent | 记录 | 粒度 |
| --- | --- | --- |
| Claude Code | 转写里的 `api-request-shape`（系统提示词各块、工具定义，按 `shapeHash` 只记一次）、`api-request`（参数、用的 shape、消息为上一请求的前 `keep` 条加 `tail` 的哈希）、`api-request-blob`（`tail` 里非对话消息的正文：system-reminder、环境、指令文件）。`tail` 里没有 blob 的哈希是对话消息 | 每次请求 |
| Codex | rollout 的 `session_meta.base_instructions`（系统提示词）、`additional_tools`（工具定义，按 namespace 分组）、每个回合的 `turn_context`（模型、effort、沙箱、审批）、developer 消息与 Codex 自己写的 user 部分（AGENTS.md、`<environment_context>`） | 每个回合 |

- 一份 `TraceRequests` 里，提示词（系统块加工具）和参数按内容各存一次，请求引用它们的 id；注入的消息按 id 存一次，请求的 `added` 按顺序列出 id，对话消息记为 `null`。
- 子代理车道读子代理自己的转写：Claude 是 `<会话>/subagents/agent-<agentId>.jsonl`，Codex 是子线程的 rollout；`agentId` 取自日志里的 `meta:subagent:<toolCallId>`。会话换过话题（`previousNativeSessionIds`）时按先后读所有话题的文件。
- 模型请求与记录的对应：Claude 按时间，取请求开始前后 5 秒内最近的一条（两者都在请求发出时记时间）；Codex 按回合。
- 每次都整份读文件，所以视图不定时重读：打开视图时读一次，Reload 时再读；会话运行中选中的步比已读到的最新请求还新时重读，至多 10 秒一次。注入的消息合计超过 `requestContextChars` 时，较早的只留标签和长度。
- 这些记录是 Agent 的私有格式，没有文档承诺。认不出时回答 `unrecognized`，视图显示原因，不报错。
- 不包括 HTTP 头和 Cursor：Cursor 的本地存储没有查到对应记录。

## 3. 视图

头部是概览面，列表和检查器是阅读面（[基础](design/system/foundations.md) §12，[设计决定](design/DECISIONS.md)「会话追踪的头部是概览面」）。整块界面用英文。

- **数字区**：活跃时长（会话运行中时显示 Live）、回合、工具调用、模型请求、失败，以及 token 的堆叠条：缓存读、输入、缓存写、输出。
- **时间轴**：canvas 画出整条车道。轨道依次是刻度、回合、模型请求、文字（消息与思考）、工具调用（重叠时按高度分行）；底部是全景缩略条。回合之间的空闲压成固定间隔。
  - 滚轮以指针为中心缩放，Shift + 滚轮或横向滚动平移，拖动缩略条也能平移。右上角的按钮放大、缩小、回到全景。
  - 在轨道上拖动选时间范围，列表只留这段时间；点击选中，双击一项放大到它，双击空白回到全景。
  - 选出的范围两端各有一个提手，拖动调整这一端；刻度上的条显示范围长度，拖动它平移整段。提手和条都能用 ← → 移动（Shift 移得更多），Esc 清除范围。
  - 拖动底边调高度，范围 140–440 px，存在本机（`localStorage`）。
  - 颜色按类别：模型请求、工具、思考、消息各一个降饱和的色相，失败用 `danger`。列表的耗时条与类别按钮上的色点用同一套颜色。
  - 指向时间轴上的一项，列表里对应的行同时高亮；反过来也一样。
- **调用**：按回合分组的实体。一个工具调用和它的更新是一项，一条消息的各个修订是一项；模型请求按时间插在回合里。每行右侧的条表示它在回合里的位置和长度。
- **日志**：按 seq 列出每一行，含每次修订。
- **筛选**：文字（标题、名称、kind、nativeId、toolCallId）、类别（消息、思考、工具、模型请求、系统、草稿；草稿默认隐藏）、仅失败、时间范围。
- **提示词**：工具栏的 Prompt 打开当前车道最新的提示词：系统提示词各块、工具（展开看说明和参数格式）、与上一版的差别（工具增删改、系统提示词 diff）。提示词变过的地方在时间轴刻度下标一个菱形，点击打开那一版。
- **检查器**：
  - 回合：运行的请求配置与实际配置、投递、尝试、`Run.native.timings` 的派发时间线、诊断、本回合的模型请求，以及本回合请求注入的消息（Codex 显示这个回合的设置）。
  - 调用：输入参数、输出、每个修订的载荷与摘要。
  - 模型请求：输入、缓存读写、输出、推理 token；Request 一节是这次请求的记录：发出时间、来源、消息数、所用提示词、注入的消息和请求参数。
  - 日志行：存储字段与载荷。
- **键盘**：列表获得焦点后，↑↓ 或 j/k 移动，← → 折叠和展开回合，Home/End 跳到首尾，Enter 切换折叠。

### 数据怎么读

- 视图先读首页，得到 `lastSeq` 后其余页 4 路并发读。车道的 seq 从 1 连续编号，各页起点可以算出；页有重叠时按 seq 去掉重复行。
- 行每 8 页交给折叠一次，不按页重折。6.5 万行的会话：读完约 0.8 s，折叠约 60 ms。
- 列表定高 28 px 窗口化，只渲染可见行和上下各 20 行。
- 载荷按行读取，按条数和字节放进 LRU（`webDetailEntries`、`webDetailBytes`），换 generation 时清空。
- 会话运行中且视图可见时，每 `livePollMs` 读一次上次之后写下的行，每 5 次轮询刷新一次摘要。
- 一条车道最多保留 `webRows` 行，超出后停止读取并提示。

### 工具调用的耗时

行的 `at` 是这一版本写入的时间。日志被重新导入过时，同一调用会同时有 Agent 的粗时间（如 Codex rollout 给的回合时间）和实时写入时间，首末 `at` 可能相差一小时。所以每个结果行只与它之前最近写下的调用行配对（同一次写入），取最长的一对作为耗时。没有配对的调用不画时长；早于回合开始的行不显示偏移。回合里的顺序按 seq，不按时间。

## 4. 各端

- Mac：M，不做原生页面。视图声明 `clients: ['web']`，Mac 的视图切换里没有它。
- 手机：插件视图不在手机上运行，手机不做。
- Web 窄屏：应用在窄屏只显示对话，没有视图切换。

## 5. 多服务器

1. 类别：A（会话的数据）。
2. 数据只在会话所在的服务器上。视图是 `session-view`，按对象归属，请求发给会话的服务器；索引不带 `serverId`，因为它只属于一个会话。对端离线时请求失败，视图显示读取失败和重读按钮。
3. 路由：在 `/api/sessions` 前缀下，按策略表是 `serve`，只回答本机日志和本机 Agent 的转写文件。
4. 客户端请求经插件宿主的 `request`，与会话页的其他读取走同一个请求层。
5. 没有新的对象 id；行用 `(lane, generation, seq)` 定位。
6. 没有新扩展点；`access.requests` 增加了单段 `*` 写法。
7. 不涉及助理与 Riffet MCP。

## 6. 明确不做

- 不保存原始 HTTP 请求与响应，也不抓包。系统提示词、工具定义和注入的消息从 Agent 自己的转写读（§2.1），HTTP 头看不到。`official/request-recorder` 不属于追踪。
- 不记录派发与排队的历史事件。追踪只显示运行最终的 `timings`，过程只在服务日志 `riffet logs --scope dispatch`。
- 不导出 OTLP。日志不是请求 / 响应式的 span 模型，转换放到确实需要对接外部平台时再做。

## 7. 排障

- 某个调用显示的耗时明显偏长或偏短：在「日志」里看它各修订的 `at`。同一 toolCallId 的调用行与结果行按写入顺序配对，导入时被改写的时间会影响结果。
- 详情显示「存储里已没有这份载荷」：blob 被清理或冷裁剪（`archivedTrimDays`、`inactiveTrimDays`），`riffet doctor` 的 Storage 一节会列出缺失的 blob。
- 视图反复从头读取：车道在重建（`rebuild`），每次重建 generation 都会变，看 `riffet logs --scope journal`。
- 模型请求的 Request 一节显示「has no request records」：Agent 升级后改了记录格式。看转写里还有没有 `api-request`（Claude）或 `turn_context`（Codex）行，改对应的 `request-records.ts` 并补测试 `backends/shared/trace-requests.test.ts`。
- 显示「No recorded request matches this one」：这一步的开始时间与任何请求记录相差超过 5 秒，多见于从统计回填、没有 `api-request` 时间的旧步。
