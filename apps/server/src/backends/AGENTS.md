---
module: server.backends
verify:
  - npx vitest run apps/server/src/backends/dispatch-feed.test.ts apps/server/src/backends/plugin-backend.test.ts apps/server/src/backends/service-config.test.ts apps/server/src/backends/service-dialogs.test.ts apps/server/src/backends/service-watch.test.ts apps/server/src/backends/stats-observe.test.ts apps/server/src/backends/no-cursor.test.ts
---

## 职责

各 Agent 驱动之上的公共一层：驱动注册、会话的发送与观察、模型与命令目录、插件提供的驱动适配，以及把转写接到调度器。

## 入口

- `types.ts#NativeBackendDriver`：驱动要实现的接口；可选成员缺省即表示不支持，服务按有无决定提供什么。
- `service.ts#NativeBackendService`：一切请求经此找到驱动、写会话状态、挂观察。
- `registry.ts#NativeBackendRegistry`：驱动注册表；未注册的后端在 `require` 时报 `NATIVE_BACKEND_UNAVAILABLE`。
- `plugin-backend.ts#PluginBackendDriver`：把插件的 `AgentBackend` 包成核心驱动，插件只见到 `AgentHost`。
- `plugin-backends.ts#PluginBackends`：随插件启停注册与撤回驱动。
- `dispatch-feed.ts#DispatchFeed`：调度器听到的会话事件与状态。
- `catalog.ts#BackendCatalog`：模型、斜杠命令、可用性探测的缓存。

## 不变量

- 会话的运行状态只由 `service.ts#deriveSessionState` 根据证据推出；插件传来的状态不能直接写入，否则会与核心的证据竞争（`plugin-backend.ts#PluginBackendDriver` 的 `host.view` 写入处）。
- 日志里的事件号以第一行为准，围栏的 `baselineSequence` 用同一套编号（`service.ts#journalBaseline`）。
- 回合的结束就是它那次运行的结果：`dispatch-feed.ts#DispatchFeed` 先读并发出转写里记下的结局，再处理指名下一回合的状态，使前一回合自己的结局先于较新的回合把它判为未确认。
- Claude Code 的结束行成批写入而 hook 立即到达，所以状态指向下一回合时要再读一小段时间（`dispatch-feed.ts#TURN_END_WAIT_MS`）。
- 插件被关闭后，它的 host 在激活释放前仍可被调用，之后一律拒绝；已关闭的驱动不会再注册，新激活建新驱动（`plugin-backend.ts#PluginBackendDriver`）。
- 驱动不在时，等它的工作按插件激活的时限排队而不是立即失败（`registry.ts#NativeBackendRegistry` 的 `pending`）；撤回后新请求立刻失败。
- 核心不带 Cursor 插件也必须能启动：它留下的会话、历史与存储的配置保留，需要 CLI 的操作被拒并写明后端（`no-cursor.test.ts`）。
- 探测后端可用性之前先让模型源完成 `prepare`（`catalog.ts#prepareSource`）：自带进程的模型源在此之前只回答未就绪，结果会被缓存 30 秒，刚启动时提供方会显示为不可用（b6108c7）。

## 外部行为

- 侧边聊天沿用主会话的 profile。直接跑 CLI 的驱动通过 `streamDiscussion` 执行无工具的独立文本请求；同一 profile 可连接多个提供方时，用 `discussionModelScope` 约束模型切换。

- Agent 列表的 `cliMissing` 表示所有提供商都已确认找不到 CLI。`GET /api/backends?recheckMissing=1` 会重新探测缓存中缺失的 CLI，已安装的仍沿用正常的缓存时限。
- 没有外部输入：消费的是各驱动经 `types.ts#NativeBackendHost` 回报的状态、转写批和事件，以及插件进程经 `AgentHost` 传来的普通数据。各驱动的 CLI 录制放在各自目录。

## 排障

- 请求报 `NATIVE_BACKEND_UNAVAILABLE`：看原因文本，来自 `registry.ts#NativeBackendRegistry` 的 `describeUnavailable`；插件关闭或激活失败时 `riffet logs --scope riffet` 里有 `agent backend <id> of <owner> was not registered`。
- 运行一直不结束或被判为未确认：先看该会话的 journal 里 `turn_ended` 是否已写，再看 `dispatch-feed.ts` 的 `outcomeType` 映射。
- 插件驱动没有观察到会话：日志里 `observing <id> failed` 或 `readers were not re-attached`，对应 `plugin-backend.ts`、`plugin-backends.ts`。
- 模型列表陈旧或为空：`catalog.ts#BackendCatalog` 的缓存先返回旧值再后台刷新，失败时保留上一次读到的值；先确认探测本身能跑通。
