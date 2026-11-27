---
module: server.backends.shared
verify:
  - npx vitest run apps/server/src/backends/shared
---

## 职责

各 Agent 驱动共用的零件：子进程与 App Server 连接、hook 端点、条件等待、预热键、模型源、工作区观察、终端对话框。

## 入口

- `launch-input.ts#SessionLaunchInput`：影响启动或工具列表的会话字段，只在这里列一次。
- `wait-for.ts#waitFor`：等另一个进程做完某件事的统一原语，约定见 docs/DELIVERY.md。
- `codex-app-server.ts#CodexAppServer`：App Server 进程、socket 与 JSON-RPC。
- `workspace-observer.ts#WorkspaceObserver`：shell 命令改了哪些文件（`--raw -z` 与 `--numstat -z` 解耦统计与 patch，覆盖二进制与超长文件）。
- `file-snapshots.ts#SessionFileSnapshots`：编辑工具与观测命令的单文件前后快照账本，正文复用 `journal` 的 `session_blobs` 并受 `OUTPUT_BUDGET` 约束（docs/SESSION-OUTPUTS.md）。
- `command-actions.ts#commandActions`：只读的 shell 命令读了、搜了什么，形状同 Codex 的 `commandActions`；词法在 `shell-words.ts#shellSegments`，与 `readsOnly` 共用。
- `model-source.ts#prepareSource`：把已存的模型源名称加上配置覆盖解析成启动所需的事实。
- `trace-requests.ts#TraceRequestsBuilder`：各驱动读请求内容（docs/TRACE.md §2.1）的公共部分：按内容去重、按预算截断、流式只解析含关键字的行。
- `hook-server.ts`、`turn-tracker.ts`、`deferred-steer.ts` 只是对 `packages/plugin-api/src/kit/` 的再导出，改行为到那里改。

## 不变量

- `launch-input.ts#LaunchKeyParts` 对 `SessionLaunchInput` 的每个字段都要求写出用法或 `notKeyed(原因)`，新增字段先让各后端的预热键编译不过；预热的进程只交给键完全一致的新会话。
- `wait-for.ts#waitFor` 在期限之后再探测一次，并按轮询迟到的时间顺延期限（上限 `maxStallAllowanceMs`）；事件循环停顿后 Node 先跑到期的定时器再读 I/O，没有这两条会输掉停顿决定的每次竞争。
- `workspace-observer.ts#WorkspaceObserver` 的差异是整个工作树的，可能含其他进程的写入；并行命令按区间归属：只有一个窗口覆盖就归它，否则归命令行里点名该文件的窗口，只读命令不开窗口（`readsOnly`）。
- `app-server-daemons.ts` 只认本工作台自己起的 App Server（`cw-cx-*` 临时目录里的 Unix socket，或凭据目录里有 token 文件的回环监听），用户自己运行的永远不匹配。
- 判断两个进程是否同一个，不能只比 pid：用 `process-identity.ts#sameStart` 比启动时间；`ps` 不可用时返回 `undefined`，调用方按「进程仍在」处理。
- `cli-trust.ts#ensureClaudeWorkspaceTrust` 写的是 CLI 自己的配置，键用内核解析过的 cwd（`canonicalCwd`）；`RIFFET_CLI_TRUST=0` 关闭。hook 信任始终由 CLI 自己决定。
- `command-actions.ts#commandActions` 要么整条命令都认得，要么返回 undefined：有一段不是读取、搜索或列目录（写文件、未知程序、替换、heredoc），整条按原样显示，不把写操作标成「读取」。
- `installed-env.ts` 拒绝能改变 shell 启动方式的环境变量（`SHELLOPTS`、`BASHOPTS`、`PS4`），它们会在命令之前执行代码。
- `terminal-dialogs.ts` 只在没有协议层交互时补位，且只在有浏览器订阅时轮询；协议交互优先。

## 外部行为

- 终端屏幕（启动信任、hook 审核、计划审批等对话框）由 `terminal-dialogs.ts#TerminalDialogObserver` 读 `tmux capture-pane`；Claude 的对话框录制见 `apps/server/src/backends/claude/fixtures/screens/`，其余尚无录制。
- App Server JSON-RPC 的录制在 `apps/server/src/backends/codex/fixtures/app-server/`；`ps` 输出（`process-identity.ts`、`app-server-daemons.ts`）尚无录制。
- 档案存的网关适配器（`role: "adapter"`）没有插件提供时（停用或卸载），`model-source.ts#modelSourceOf` 让档案按自己的 `apiEndpoint`/`apiKey` 当普通 API 连接用，额度不显示；声明为连接来源的源仍然报不可用。卸载后读不到声明的类型，未知类型按适配器处理。驱动一律经 `modelSourceOf` 判断，只有额度读 `savedModelSourceOf`。
- Claude 的全局配置与 Codex 的 `trust_level`：见 `cli-trust.ts` 顶部说明，格式随 CLI 版本可能变，尚无录制。

## 排障

- Agent 被标记为未安装：`packages/plugin-api/src/kit/cli-resolve.ts#isCliMissing` 会逐个核对已搜索的路径，文件权限或损坏的符号链接会保留为运行故障。
- 预热命中率低，服务日志持续出现 `prewarm: a new session did not match`：比较两侧的键，看 `launch-input.ts#sessionLaunchInput` 与各后端的 `warmKey` 派生。
- 等待在服务繁忙时偶发超时：先确认调用走的是 `wait-for.ts#waitFor` 而不是裸 `setTimeout`。
- 残留的 App Server 进程：`app-server-daemons.ts` 列出的就是本工作台的，用它而不是 `ps | grep` 判断归属。
- 并行命令的文件改动归错会话：`workspace-observer.ts` 的 `attribute` 与 `noteEdit`。
