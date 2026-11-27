---
module: server.backends.codex
recordings: fixtures
verify:
  - npx vitest run apps/server/src/backends/codex
---

## 职责

Codex 与 TRAE CLI（同一套 App Server 协议，`flavors.ts`）的驱动：启动或连接 App Server，把工作台的输入变成回合，把线程读进会话日志。

## 入口

- `index.ts#CodexBackendAdapter`：驱动接口的实现，发送、打断、状态、预热。
- `runtime.ts#CodexSessionRuntime`：每个会话一个，协调下面几个对象，分发通知，推导状态（`refreshStatus`，phase 只在 `livePhase` 计算）。
- `connection.ts#CodexConnection`：传输、端点归属、启动与重启、配置切换。
- `terminal.ts#CodexTerminal`：TUI 启动与端点确认。
- `turns.ts#CodexTurns`：当前回合与回合、命令、Run 的对应，只能经它的方法改。
- `thread.ts#CodexThread`：打开或恢复线程、常驻配置、已加载线程的归属。
- `pending.ts#CodexInteractions`：审批、提问、异步问题与模式变更请求。
- `settings.ts#CodexSettings`：权限、协作模式、模型、目标、标题。
- `dispatch.ts#CodexDispatch`：发送、插话、打断、斜杠命令及其围栏。
- `notifications.ts#CodexNotifications`：通知分发表，按方法名交给负责的对象；顺序由连接的 `NotificationGate` 保证。
- `event-log.ts#CodexEventLog`：会话事件的常驻窗口、编号与 item 的投影。
- `history-sync.ts#CodexHistorySync`：读线程、导入历史、轮询。
- `transcript-source.ts#CodexTranscriptSource`：线程进入 journal 的唯一路径，合并实时通知与 `thread/turns/list`。
- `apps/server/src/backends/shared/codex-app-server.ts#CodexAppServer`：进程、socket 与 JSON-RPC。
- `recording.ts#replayFactory`：录制数据的回放，测试在 `recordings.test.ts`。
- `request-records.ts#readCodexRequests`：会话追踪的请求内容（docs/TRACE.md §2.1），读 rollout 的 `session_meta`、`additional_tools`、`turn_context` 和 developer 消息。

## 不变量

- App Server 是线程唯一的读取来源。日志实体按 item 自己的 id 命名（`project-item.ts`），实时通知、重读和重启写的是同一个实体。
- 回合读到定稿副本才算结束。历史读取暂时返回 `interrupted` 时，`transcript-source.ts#turnReopened` 撤销结束标记，但只恢复最后一个已结算的回合，更早的不回填。
- 运行时必须在宿主提供 `host.transcript` 之后创建。否则 `event-log.ts#CodexEventLog` 的 `journalRead` 为 false，草稿流把片段写进转写源写的同一个实体。
- 预热的 App Server 只交给预热键完全一致的新会话（`launch.ts#warmKey`）；不一致时静默冷启动，不报错。会话一侧的键由 `launch.ts#sessionWarmKey` 从 `apps/server/src/backends/shared/launch-input.ts#SessionLaunchInput` 派生，新增启动字段时类型检查会要求在这里处理。
- 能力按 `config.ts#probeAppServer` 的结果和 `initialize` 返回的 userAgent 判断（如 `config.ts#supportsSteerVersion`），不按命令路径缓存。

## 外部行为

- reasoning 是旁白还是思考看内容，不看字段（`drafts.ts#reasoningChannel`）：OpenAI 的 summary 每段以粗体标题开头，算旁白平铺；兼容 Responses 的网关会把别家模型（DeepSeek）的原始思维链放进 `summary_text`，没有标题，按思考折叠。
- App Server JSON-RPC：入口是 `runtime.ts#onNotification` 和 `runtime.ts#onServerRequest`。录制数据按 CLI 版本存放在 `fixtures/app-server/` 下，场景见 `recording.ts#CODEX_SCENARIOS`；TRAE CLI（`traex`）录制 answer 与 command，放在 `fixtures/traex/`，不含 hook，用 `pnpm record traex <场景>`。
- Codex 0.172.0 和 TRAE CLI 0.217.0 的录制使用真实 CLI 和回环模型服务。Codex 场景包括命令、审批、中断和 App Server 重连，TRAE 包括回复和 Bash。两者都用新版继续过上一版本写入的线程，历史条目 id 保留。
- rollout JSONL（`$CODEX_HOME/sessions/`）：用量、计划与分享读取，解析入口 `rollout-records.ts#rolloutRows`。录制数据在 `fixtures/rollout/`，只保留解析器读取的记录类型。
- `imageGeneration`（rollout 中为 `Extension` + `kind: 'image_gen.generation'`，app-server 提升为顶层 `ThreadItem`）：按 `kind: 'image_generation'` 工具项投影，优先引用 `savedPath`，在 `raw` 与分享 rollout 中剥离超大内联 `result` base64；计入 `metering.ts` 的工具等待，完成通知补写 `title`/`rawInput`/`locations` 与实时项对齐。
- 打断后，未完成的回答不在 CLI 的定稿副本里（`thread/turns/list` 只返回用户消息），会话日志里也就没有这段回答。
- hook（PreToolUse / PostToolUse，只处理 Bash）：`observation.ts#CodexObservation`，记录命令改动的文件。hook 载荷与 App Server 消息录在同一份录制里；回放不投递它们（算改动需要真实的工作区），由 `recording.ts#hookProblems` 检查观察依赖的约定：每条命令有一对 hook，`tool_use_id` 是 item id，`session_id` 是线程，PreToolUse 先于 item 完成。
- 录制会按 Riffet 的方式确认 hook 信任，这会写用户 `config.toml` 里与正在运行的 Riffet 同名的信任项；`scripts/record.ts` 运行前记下、结束后写回。
- `pnpm record codex all --check` 用本机 CLI 跑一遍场景并与录制比较，不写入仓库；有漂移时再重录。CLI 升级后先运行 `pnpm record codex all`，再运行 `npx vitest run apps/server/src/backends/codex/recordings.test.ts -u`，在代码评审中检查行的差异。
- 测速（`metering.ts`）：`subAgentActivity` 的所有状态变更都属于等待事件（尽管只有 `kind: 'started'` 投影为时间线行），无 `item/started` 的子代理完成通知不得把子代理等待时间计入父模型生成耗时；当请求在短流式 delta 后继续生成未流式工具参数或隐藏推理时，请求窗口扩展为 `observed` 全程耗时。
- rollout 只按回合记请求内容：`turn_context` 先于这个回合的消息写入，首个回合之前写下的 developer 消息和 AGENTS.md、`<environment_context>` 归第一个回合；第一条 developer 消息重复 `base_instructions`，追踪把它算作提示词而不是注入的消息。
- 历史读取顺序（`transcript-source.ts#writeTurn`）：`thread/turns/list` 按 item 完成序返回，而实时通知 `item/started` 按开始序落盘。并行或跨旁白消息的长耗时 `tool_call` 以及合并到原卡片的 `tool_call_update` 在两者间交错属于正常现象，不触发 lane 重建；只有跨回合落位、非工具行逆序或临时 id（TRAE `item-*`）重命名越位时才 `rebuild`。

## 排障

- 新会话菜单里找不到 Codex 或 TRAE CLI：`availability.ts#availabilityOf` 会在启动探测收到 `ENOENT` 后核对可执行文件是否存在。文件存在但缺少解释器时仍会列出 Agent。
- CLI 升级后首次探测超时：`config.ts#probeAppServer` 只重跑撞到 5 秒时限的命令。再次超时会单独报告，并释放按可执行文件缓存的探测结果。检查提示和 CLI 的 `app-server --help`，即可区分启动超时与协议能力缺失。
- 流式回答的最后一行轮流闪现片段：查该会话 `journal_events` 中 `kind='draft'` 的行。nativeId 以 `-draft:<n>` 结尾的是运行时写的片段，以 `:assistant` 结尾的是转写源写的累积版本；前者出现，说明有运行时在没有 `host.transcript` 的路径上被创建。
- 回合正文缺失或回合不结束：`riffet logs --scope codex-history,codex-journal`，确认是否读到了定稿副本。
- 线程归属冲突、启动或恢复失败：`riffet logs --scope codex-recovery`。
- 协议层的问题：`pnpm record codex <场景>` 在临时项目里复现，录制数据包含运行时与 CLI 之间的每一条消息。
