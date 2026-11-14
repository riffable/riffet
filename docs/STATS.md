# Riffet 数据统计

本文是统计能力的方案契约，与 `docs/WEB.md`、`docs/MOBILE.md` 并列：服务端负责采集与聚合，web 与 app
只渲染。

状态：**第一至三期已实现**，第四期中的导出已实现，费用未做。与方案不同的地方和剩余缺口见 §9。
§2 是动工前的现状，保留作背景。

输出速度按已测模型响应时间计算。最近 180 秒仅筛选底部速度的样本，分母不固定为 180 秒。
Codex 的绝对输出时间与生成时长分别保留，工具和审批暂停不进入流式生成时长；只有整轮运行耗时的记录不参与 TPS 分位数。
`usage_steps.duration_ms` 保存独立响应时长，`native_message_id` 关联原生触发消息，已测的 CLI 回合可在重连后恢复。
速度分位数只使用有计时的主智能体响应；未计时输出和子智能体用量仍计入 token 总量，不加入该速度的分子或分母。
Claude 按精确消息身份补录历史指标，补录保留原 run 时间；旧实时行只补缺失身份字段，既有 token 数和现场计时仍保留。
原生后端还可上报 `agent-turn` 范围的 provider 总量；完整总量替代相同执行归属的估算，整轮耗时不作为请求测速样本。

已定的决策（2026-10-08）：

| 项 | 决定 |
| --- | --- |
| Web 图表 | d3 子模块（`d3-scale` / `d3-shape` / `d3-interpolate`）+ 自绘 SVG 组件，不引整包图表库 |
| App 图表 | Compose `Canvas` 自绘，不引三方图表库 |
| 统计范围 | 只统计 Riffet 管理的会话；Riffet 之外直接跑的 CLI 会话不纳入 |
| 费用 | 第四期再做，用户自配单价，不内置价格表 |

---

## 1. 判据

1. **不把没测到说成零**：缺失的维度显示「不可用」，图上是缺口而不是 0。沿用 `RunMetrics` 的约定：
   absent means "this turn was not measured", never "zero"（`packages/contracts/src/index.ts:81-86`）。
2. **估算永远标明**：没有完整 provider 证据时保留输出估算，与 provider 上报的数字分开显示，并可一键排除。
3. **同一件事只算一次**：同一次 provider 请求被实时写入、补录、重读多少次，都只留一行；子 agent 不与父级重复计。
4. **统计不能打扰会话**：采集与补录绝不启动 agent、不阻塞流、失败不影响任何会话功能。

---

## 2. 现状

### 2.1 已有的

- **每轮输出速度**：四个后端都把 step 汇入 `RunMetricsTracker`（`apps/server/src/metrics/turn-metrics.ts`），
  settled 的汇总经 `host.saveRunMetrics` 写进 run JSON 的 `native.metrics`（`apps/server/src/backends/service.ts:138-143`）。
  只有 `outputTokens`、`durationMs`、来源与窗口。
- **每轮时间戳**：`native.timings` 已有 `prepareAt`、`dispatchAt`、`inputSentAt`、`observedAt`、`busyAt`、
  `firstOutputAt`、`completedAt`、`interruptedAt`、`promotedAt`（`apps/server/src/native/dispatch.ts`）。
  排队耗时、首字延迟、整轮耗时都能从这里算。
- **模型**：`native.config.model` 是请求快照，`native.resolvedConfig.model` 是 CLI 归一后的实际选择
  （`packages/contracts/src/index.ts:62-66`）。
- **后台读 transcript 的先例**：搜索补录对没有索引的会话只读地读 transcript，限流、失败重试、空会话打标记
  （`apps/server/src/app.ts:659-671`、`apps/server/src/store.ts:505-520`）。统计补录照抄这套。

### 2.2 缺的

1. **没有可查询的统计存储**。数据散在 `runs.json` 的 JSON 里，按时间、模型分组只能全表 `json_extract`。
2. **输入与缓存 token 被丢掉**。三个后端都报了，但只取了输出：
   - Codex：`thread/tokenUsage/updated` 的 `tokenUsage.last` 带 `inputTokens`、`cachedInputTokens`、
     `outputTokens`、`reasoningOutputTokens`、`totalTokens`（`apps/server/src/backends/codex/index.test.ts:475`），
     `noteTurnUsage` 只留输出与推理（`apps/server/src/backends/codex/index.ts:1439-1445`）。
   - DSH：`usage` 带 `inputTokens`、`cacheReadTokens`、`cacheWriteTokens`，目前只用于上下文环
     （`apps/server/src/backends/dsh/context.ts:63-75`）。
   - Claude：JSONL 的 `message.usage` 带 `input_tokens`、`cache_creation_input_tokens`、
     `cache_read_input_tokens`（**待用真实 JSONL 核对**），`usageOf` 只取输出（`apps/server/src/backends/claude/history.ts:356-362`）。
3. **没人看的轮次测不到**。测速挂在会话 watch 上，没有客户端打开时不产生 metrics。
4. **每次请求的模型没记**。只有 run 级的请求/归一模型；Claude 每条回复有 `message.model`，子 agent 可能用别的模型。
5. **工具调用没有结构化记录**。transcript 来自 CLI 本地存储，`message_index` 只有工具名拼成的检索文本。

### 2.3 各后端能拿到什么

| 后端 | 输出 token | 输入 / 缓存 token | 推理 token | 每请求模型 | 补录来源 |
| --- | --- | --- | --- | --- | --- |
| Cursor | 仅估算 | 无 | 无 | 无（只有 run 级） | 不补录（见 §9） |
| Codex | provider | 有（`inputTokens` **含**缓存部分） | 有 | 每轮（rollout 的 `turn_context`） | rollout 文件 |
| Claude | provider | 有（输入**不含**缓存，缓存读/写分列） | 有 | 有 | `~/.claude` JSONL |
| DSH | provider | 有（输入**不含**缓存，缓存读/写分列） | 有 | 有 | 不补录（见 §9） |

**口径归一**：账本里的 `input_tokens` 一律指**未命中缓存的输入**。Codex 写入时做
`input = inputTokens - cachedInputTokens`、`cache_read = cachedInputTokens`；Codex 不报缓存写入，记为缺失而不是 0。

---

## 3. 服务端

代码放 `apps/server/src/stats/`。

### 3.1 账本

**只加表，不改 `user_version`**，与 `message_index` 同理（`apps/server/src/store.ts:118-127`）：旧版本打开数据库时忽略
新增表，数据库仍可降级打开（`Store` 对 `user_version > 2` 直接拒绝打开，`store.ts:106`）。旧核心不识别 `suppressed_by`，降级后的统计可能同时计入保留估算和回合总量；准确统计需要使用支持观察账本的核心。时间一律存 epoch 毫秒（UTC）。

**`usage_steps`**：每次 provider 请求一行；另容纳完整原生回合总量的投影，通过 `observation_id` 区分。

| 列 | 说明 |
| --- | --- |
| `step_key` PK | `backendId:sessionId:stepId`；重复写入即替换，语义同 `RunMetricsTracker.update` |
| `session_id` / `run_id` / `project_id` | `run_id` 可空（补录时对不上 run 的旧轮次） |
| `backend_id` / `profile_id` | profile 缺省表示默认 profile |
| `model` / `requested_model` | 请求行依次取每请求模型、`resolvedConfig.model`、`config.model`；整轮投影的实际模型只取 provider 报告值 |
| `agent_kind` / `subagent_type` / `parent_step_key` | `main` 或 `subagent` |
| `started_at` / `ended_at` | 可空：起点观察不到时为空 |
| `input_tokens` / `cache_read_tokens` / `cache_write_tokens` / `output_tokens` / `reasoning_tokens` | 全部可空，空即「不可用」 |
| `token_source` | `provider` / `estimated` |
| `window` | `stream` / `transcript` / `observed`，同 `MetricsWindow` |
| `ingest` | `live` / `backfill` / `migration` |
| `native_session_id` | 原生 agent 身份，用于区分同一 run 下的不同子 agent |
| `observation_id` | 非空时为整轮 provider 总量投影，不计入请求数、响应速度或重连测速帧 |
| `suppressed_by` | 覆盖该估算的完整 observation；非空行不参与统计，原行保留用于冲突恢复 |

**`usage_observations`**：原生回合观察事实，与以上表共用现有 SQLite 数据库。身份为
`(backend_id, native_session_id, native_turn_id)`，不随 Riffet 会话重新导入而改变。JSON 仅保存白名单中的
原生身份、请求身份、时间、主/子 agent 归属、请求/实际模型、终态、归一后计数和可选原始计数，不保存 provider 响应正文。

`coverage` 为 `complete`、`partial` 或 `conflict`。输入、输出、缓存读、缓存写四项均为非负安全整数才完整；
推理数可缺失，报告时必须为非负安全整数且不超过输出。输出包含推理，合计不重复加推理数；未报告的值不补零。
缺失字段可后补，同一身份的请求或已知数值等事实不一致时保留冲突证据并撤销准确投影，后续重复读取不自动消除冲突。
采集队列只在事务提交且 WAL 检查点完整落盘后确认删除；读事务阻止检查点完成时保留文件并后台重试，不等待读者释放锁。

**`run_facts`**：每轮一行，run 进入终态时写入。

| 列 | 说明 |
| --- | --- |
| `run_id` PK、`session_id`、`project_id`、`backend_id`、`profile_id` | |
| `model_requested` / `model_resolved` / `mode` / `approval` | |
| `state` | `completed` / `failed` / `cancelled` / `interrupted`；另记 `delivery`，用于统计 `uncertain` |
| `created_at` / `queue_ms` / `ttft_ms` / `duration_ms` | `queue_ms = dispatchAt - createdAt`；`ttft_ms = firstOutputAt - inputSentAt`；`duration_ms = completedAt - inputSentAt`；缺任一端即为空 |
| token 汇总五列 | 由 `usage_steps` 汇总，含子 agent 与否分两组 |
| `steps` / `tool_calls` / `subagents` / `interactions` / `attachments` / `prompt_chars` | |
| `error_code` | 失败时的归类 |

**`tool_calls`**：`(session_id, tool_call_id)` 主键，`run_id`、`tool_name`、`failed`、`at`。按调用存而不是按
`(run, tool)` 汇总，因为同一调用的开始与结束分两次到达，失败标记要能后补。

**`stats_cursor`**：`(session_id)` 主键，记 `generation` 与已读位置，避免补录重复读整个 transcript。

**索引**：`usage_steps(started_at)`、`(backend_id, started_at)`、`(model, started_at)`、`(project_id, started_at)`；
`run_facts(created_at)`、`(backend_id, created_at)`。

本地单用户在万到十万行量级，按索引实时 `GROUP BY` 足够，**暂不做预聚合**。`usage_steps` 超过百万行时再加按小时
增量维护的汇总表。

### 3.2 写入：三条路径，都按主键幂等

1. **实时**。host 接口加 `recordUsage(sessionId, runId, record)`，挂在已有的四个上报点上：
   Codex `noteTurnUsage`、Claude `ClaudeStepMeter`、DSH attempt usage、Cursor `CursorTranscriptMeter`。
   只写 settled step（`live: false`），并带上 §2.2 里丢掉的输入/缓存/模型字段。
2. **终态**。所有 run 状态变更都经 `Store.transitionNativeRun` / `updateRun`，在这里统一 upsert `run_facts`，
   不在四个后端各写一份。
3. **补录**。照搬搜索补录：后台轮转原生会话，调用各 driver 新增的只读 `usageTranscript()`，
   用 `stats_cursor` 里的文件签名跳过没变的 transcript。限流、空闲时跑；读到空也写游标，读失败保留旧签名
   留待重试。覆盖范围见 §9。
4. **一次性迁移**。首次启动把已有 run 里的 `native.metrics` 与 `timings` 迁入，`ingest = migration`，
   用 settings 标记保证只做一次，写法同 `session-last-activity-backfill-v1`（`store.ts:134-140`）。

原生回合总量通过可选的 `AgentHost.stats.recordObservation` 写入；只有数据库事务已提交才返回 `true`，
部分或冲突事实也会持久化并确认。`readObservations` 和 `subscribeObservations` 只暴露当前后端的事实，
沿用会话归属校验与停用后的 host 撤销规则；插件停用会释放订阅。

完整回合总量只覆盖相同会话、相同 run、相同主/子 agent 范围的估算；子 agent 还必须匹配原生会话身份。
估算后续重读仍受覆盖，完整事实发生冲突时恢复原估算。没有 run 的事实不按时间猜归属，之后可按原生回合或
精确请求 receipt 绑定；总量仍保留，绑定前不覆盖已有 run 的估算。整轮投影不改变原有请求级计量行为。

**子 agent**：Claude 的 `<usage>` 带 `subagent_tokens` 与 `duration_ms`（`claude/history.ts:150-152`），Codex/DSH 读子 agent
transcript。一律记 `agent_kind = subagent` 挂父 run；若某 provider 的父级 usage 已包含子 agent 用量，只记子 agent 明细、
父级扣除，**实现时逐后端核对，并各配一条防重复计的测试**。

### 3.3 时间分桶

SQLite 处理不了时区。客户端在请求中带 IANA 时区 `tz`，服务端用 `Intl` 先算出该时区下每个桶的边界，按索引取范围内的行，
在 JS 里分桶。夏令时切换日的桶长度因此是对的。粒度：`hour` / `day` / `week`（周一起） / `month`。

### 3.4 API

参数用 zod 校验，类型放 `packages/contracts`，路径加进 `API` 常量。

公共过滤参数：`from`、`to`、`tz`、`backend[]`、`model[]`、`project[]`、`profile[]`、`agentKind`、
`includeArchived`（默认 true）、`includeEstimated`（默认 true）。

| 接口 | 返回 |
| --- | --- |
| `GET /api/stats/dashboard` | 首屏一次给全：KPI + 上一周期对比 + 默认趋势 + 分布。手机端只需一次请求 |
| `GET /api/stats/series` | `metric` × `granularity` × `split`（`backend` / `model` / `project`）的时间序列 |
| `GET /api/stats/breakdown` | `dimension`（`backend` / `model` / `profile` / `project` / `mode` / `tool`）的分布 |
| `GET /api/stats/latency` | 按模型的首字延迟、整轮耗时、输出速度 p50 / p90 / p99，带样本数与窗口 |
| `GET /api/stats/heatmap` | 星期 × 小时分布；近一年按日日历 |
| `GET /api/stats/runs` | 下钻明细，分页；行里带 `sessionId` 以便直接打开 |
| `GET /api/stats/export` | CSV / JSON |

- **实时**：run 进入终态时推一条 `stats_changed { at }`；客户端节流后重拉，图表以过渡动画接住新数据。
- **隐私**：数据只在本机，接口不返回 prompt 原文，只返回会话标题；鉴权与其余接口相同。

### 3.5 指标

| 类 | 指标 |
| --- | --- |
| 用量 | 会话数、轮次数、活跃天数、连续使用天数；按 agent / profile / 模型 / 项目 / mode 拆分 |
| Token | 输入、缓存读、缓存写、输出、推理分列；缓存命中率 = 缓存读 /（输入 + 缓存读）；provider 与估算占比 |
| 性能 | 首字延迟、整轮耗时、输出速度（分位数）、排队耗时；每个速度数字标注其窗口 |
| 可靠性 | 完成 / 失败 / 取消 / 中断比例；`uncertain` 次数；失败归类 Top |
| 行为 | 工具调用分布、子 agent 使用、交互弹窗次数、附件使用 |
| 费用（第四期） | 用户自配每模型单价，结果标为估算 |

---

## 4. Web

- **入口**：侧栏底部、命令面板、地址 `/stats`。统计页占满主区域，与 `ProjectHome` 同级。
- **布局**（自上而下）：
  1. 过滤栏：时间范围分段（今天 / 7 天 / 30 天 / 90 天 / 全部 / 自定义），agent 与模型 chip 多选，项目选择。
  2. KPI 卡：数字滚动、迷你趋势线、与上一周期的差值。
  3. 主图：token 堆叠面积，可切按 agent / 按模型，可拖选区间。
  4. 环形图：agent → 模型占比。
  5. 模型排行横向条：按用量 / 轮次 / 速度排序。
  6. 延迟：每模型一条 p50–p90 区间条，标出 p99。
  7. 热力图：星期 × 小时；近一年日历。
  8. 工具分布、可靠性 100% 堆叠条、下钻明细表。
- **动效**：首次进入依次入场；切换过滤时路径插值过渡而不是重画；悬停时所有图共享十字线、联动高亮；
  `prefers-reduced-motion` 下保留状态变化、去掉位移。
- **实现**：`d3-scale` / `d3-shape` / `d3-interpolate` 只做数学，渲染是自写的 React SVG 组件，放 `apps/web/src/app/stats/`。
  配色走现有 CSS 变量（`apps/web/src/styles/index.css`），深浅主题自动适配。
- **系列配色**作为主题 token 加进 `scripts/gen-mobile-theme.ts`，两端由同一份定义生成。

### 4.1 界面修订（2026-10-09，第二轮）

第一轮实现只做过代码级验证（"Web 页面没有在浏览器里看过"，见 §9）。这一轮按渲染结果逐屏校对，
改的是画法与信息密度，判据不变：

- **缺口就是缺口，单点就是单点**。堆叠面积按「连续有测量的样本段」分段绘制（`bandSegments`），
  段与段之间画一条虚线提示有洞，而不是把两点连成一条没人测过的斜线；只有一个样本的段画成一条水平短划
  （`flatDashPath`）。带子薄于 1px 时向下加粗到 1px，加粗以自身下沿为参照，不会浮到带宽之外。
  底部的拖选条改为同数据的迷你柱，空区间一眼可见；x 轴只标首尾两个刻度。
- **切换维度是过渡，不是闪一下**。指标 / 拆分变化走 `useMorph`：按 key 对齐图层、插值 `y0`/`y1` 与 `yMax`
  （460ms），只有图层集合本身变了才退回交叉淡入。环形图按 slice 做角度 ramp，排名条做宽度过渡，
  延迟条做位置过渡。
- **明细表读成一张表**。表头在筛选栏正下方吸顶（筛选栏把自身高度写进 `--stats-filter-height`），
  分隔用行内细线而不是每行一条边，数字列统一右对齐，时间列只在跨天时写日期（今天只写时刻，
  昨天写「昨天」），整行可点且 Enter / Space 都可达，表尾给「已加载 N 轮」。
- **少说废话**。缺口说明、速度窗口、未测量模型数从正文挪进悬浮提示；「新增」不再逐卡重复；
  KPI 的单位挪到标签行；没有对比周期就不占那一行。移动端删掉 agent 彩色胶囊那一行，四个维度各自一个下拉。
- **未验证**：仍无跨浏览器核对（只在 Chromium headless 里看过），真实触摸设备上的拖选与热力图手感未测。

## 5. App（Compose Multiplatform）

- **入口**：侧栏底部，新增全屏 `Overlay.Stats`（`apps/mobile/shared/src/commonMain/kotlin/riffet/ui/app/RiffetApp.kt:645`）。
  页内用 `RiffetTabPager` 横滑：概览 / Agent 与模型 / 时间 / 性能。
- **图表**：Compose `Canvas` 自绘，`Animatable` 驱动过渡；按住滑动逐点读数，配合 `SelectionHaptics` 给触感。
  不引三方图表库：`apps/mobile/gradle/libs.versions.toml` 要求依赖的 class 文件不高于 JDK 17、kotlin-stdlib 不高于本工程版本。
- **契约**：`apps/mobile/contracts` 手写 DTO + golden fixture，同 `docs/MOBILE.md`「契约：手写 DTO + golden fixture」。
- **离线**：缓存上一次 `dashboard` 响应，离线可看，并标明数据时间。

## 6. 明确不做

- 不统计 Riffet 之外直接跑的 CLI 会话。
- 不内置模型价格表。
- 不上报任何数据到本机以外。
- 不引入整包图表库（ECharts / Recharts / Vico 等）。

---

## 7. 分期与验收

### 第一期：服务端基础

- 建 `usage_steps`、`run_facts`、`tool_facts`、`stats_cursor` 及索引。
- 四个后端实时写入，补上输入/缓存 token 与每请求模型；终态写 `run_facts`；一次性迁移历史数据。
- `dashboard` / `series` / `breakdown` 接口 + contracts。
- 验收：同一 step 写入多次只留一行；Codex 输入口径归一有测试；缺失字段返回 `null` 而不是 0；
  夏令时切换日的日桶正确；`pnpm test` 与 `pnpm typecheck` 通过。

### 第二期：Web 统计页

- 概览、按 agent / 模型、时间趋势，含动效与联动十字线。
- 验收：深浅主题与减弱动效下都可读；估算数据有标识且可排除；下钻能打开会话。

### 第三期：App 统计页，同时补齐服务端

- 后台补录没人看的轮次；`latency` / `heatmap` / `runs` 接口；工具与可靠性统计；`stats_changed` 推送。
- App 四个 tab、离线缓存、golden fixture。
- 验收：关掉所有客户端跑完的一轮，之后在统计里能看到；补录不会启动 agent。

### 第四期：扩展

- 费用（用户自配单价）、导出、子 agent 精细归属。

---

## 8. 风险

| 风险 | 应对 |
| --- | --- |
| 原生回合没有完整 provider 证据 | 估算单独标识、可排除；未报告的输入列显示「不可用」 |
| 重复计 | step 主键幂等；子 agent 与父级逐后端核对；Claude 同一回复多行取最大累计值（现有 `ClaudeStepMeter` 已这样做） |
| 三家输入口径不同 | 写入时归一为「未命中缓存的输入」，Codex 单独换算并有测试 |
| Claude 字段名未在仓库内验证 | 实现时用真实 JSONL 核对，补 fixture |
| 补录读大 transcript 拖慢服务 | 游标续读、限流、空闲执行，单会话单次读取设上限 |

---

## 9. 实现记录

### 代码位置

| 部分 | 位置 |
| --- | --- |
| 账本、迁移、终态汇总 | `apps/server/src/stats/ledger.ts`、`schema.ts` |
| 时区分桶 | `apps/server/src/stats/buckets.ts` |
| 查询与接口 | `apps/server/src/stats/query.ts`、`routes.ts`（另有 `GET /api/stats/stream` SSE，节流 1 秒） |
| 补录 | `apps/server/src/stats/backfill.ts`；driver 的 `usageTranscript()`：Claude 在 `backends/claude/index.ts`，Codex 在 `backends/codex/rollout-usage.ts` |
| 实时写入 | 各后端 `host.stats`；工具调用由 `NativeBackendService` 与 Cursor watch 从事件流里取 |
| Web | `apps/web/src/app/stats/`、`apps/web/src/lib/stats-*.ts`；入口为侧栏、命令面板、`/stats` |
| App | `apps/mobile/shared/src/commonMain/kotlin/riffet/ui/stats/`、`riffet/stats/`；契约 `apps/mobile/contracts/.../Stats.kt` |

### 与方案不同的地方

- **补录只覆盖 Codex 与 Claude**。
  - Cursor 的 chat store 不带时间戳，时间只在 watch 观察时才有；补录只能把没人看的轮次记在读取那一刻，
    时间是错的，所以不补。
  - DSH 的 `session.v4.jsonl.zstd` 只有第一帧是标准 zstd，后面是 DSH 私有分帧，不去逆向。DSH 由 Riffet
    自己的 bridge 驱动，watch 在就有实时数据，缺口只在服务停掉的那段时间。
- **补录的游标是文件签名，不是读取位置**。`stats_cursor.generation` 存「大小:修改时间:是否静默」，没变就
  不解析。Claude 本来就整文件重解析，Codex rollout 单文件上限 64 MB。
- **补录保留实时测量**。实时行的 token 数和计时不被覆盖，缺失的原生消息身份可通过精确 receipt 补齐；
  其他补录只能新增，或更新之前补录、迁移写入的行。最后一轮要等文件 60 秒没有写入才算结束。
- **没有 run 的轮次不挂到旧 run 上**。没人看时在终端里直接输入的轮次没有 Riffet run。按时间回落时，只接受
  进行中的 run，或结束后 2 分钟内的步骤；否则 `run_id` 为空，token 仍计入总量，但不计入任何 run。
- **迁移把 `mixed` 记为估算**。旧 `native.metrics.tokens` 为 `mixed` 时含有估算部分，按保守口径标为 `estimated`。
- **输出速度剔除测不准的样本**。`stream` 窗口只覆盖可见文本增量，provider 的输出数却还包含工具调用参数和
  隐藏推理，短窗口会算出每秒上万 token。窗口不足 2 秒或速度超过 1000 token/s 的轮次不进速度分位数，
  token 总量不受影响。

### 验证

- 服务端单测覆盖：幂等写入、NULL 不当 0、Codex 输入归一、夏令时日桶、迁移、节流、补录不覆盖实时、
  rollout 解析、补录游标与失败重试。
- 原生回合观察使用合成数据验证：数据库重启与跨会话去重、部分计数补齐、冲突撤销、主/子 agent 覆盖隔离、
  估算重放与恢复、后到 run 绑定、事务与检查点确认，以及 host 后端隔离和停用时的订阅与异步读取。
- 用本机真实数据库副本与真实 `~/.codex`、`~/.claude` 跑过：迁移约 40 ms，仪表盘接口约 10 ms；补录首轮
  写入 18 行约 30 ms，第二轮因签名未变写入 0 行约 3 ms。
- Web 页面：第一轮没有在浏览器里看过。2026-10-09 用 Chromium headless 对真实数据副本逐屏看过一遍
  （桌面 1440 宽与手机 390 宽，含滚动后的明细表），据此做了 §4.1 的修订；仍是单一浏览器，不是跨浏览器核对。
- 未验证：App 只跑了 JVM 单测和 Android debug 构建，iOS 未构建。

### 剩余缺口

- App：没有下钻明细列表；只有时间范围过滤，没有模型、项目、profile 过滤和自定义区间。
- 费用（第四期）未做。
- 工具调用只有实时数据：迁移和补录都不产生 `tool_calls`。
