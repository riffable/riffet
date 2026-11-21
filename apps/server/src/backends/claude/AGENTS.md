---
module: server.backends.claude
recordings: fixtures
verify:
  - npx vitest run apps/server/src/backends/claude
---

## 职责

Claude Code 的驱动：在终端里运行真实 TUI，回合状态来自 hook 与转写文件，屏幕只用来确认输入框、对话框和流式草稿。

## 入口

- `index.ts#ClaudeBackendAdapter`：驱动接口的实现，预热池、hook 桥的启动与重试。
- `runtime.ts#ClaudeSessionRuntime`：每个会话一个，状态枢纽。持有状态与发布的状态，执行转移的副作用，组装下面七组；适配器与测试只经它访问各组。
- `interactions.ts#ClaudeInteractions`：审批与提问的待答请求、应答与确认。
- `sends.ts#ClaudeSends`：发送、回执、CLI 自己的队列、转录行的认领。
- `stops.ts#ClaudeStops`：停止当前回合、后台任务与单个活动。
- `binding.ts#ClaudeTerminalBinding`：启动、接管已有终端、观察退出、为配置变更重启。
- `transcript-reads.ts#ClaudeTranscriptReads`：转录读取（同一时刻只有一次）与随之而来的标题、活动。
- `screen-watch.ts#ClaudeScreenWatch`：轮询节奏、CLI 自己画的对话框、拿空闲屏幕核对记录。
- `hook-routes.ts#ClaudeHookRoutes`：hook 按事件名分发，每个事件一个方法。
- `session-state.ts#reduce`：会话状态的事件归约，输入是转写行与 hook，不含屏幕。
- `transcript-source.ts#ClaudeTranscriptSource`：转写 JSONL 进入 journal 的唯一路径，子 agent 各占一条车道；一条车道的一次读取在 `lane-read.ts#LaneRead`。
- `rows.ts#claudeRowSignals`、`row-mapper.ts#mapRow`：一行转录分别给状态机的信号和给时间线的事件。两处读同一行，改一处的行类型判断时看另一处；`rows.ts` 不导入 `row-mapper.ts`、`step-meter.ts`、`history.ts`。
- `hook-bridge.ts#ClaudeHookBridge`：本服务所有 CLI 共用的一个回环端点，按 `session_id` 路由。
- `live/screen.ts#CLAUDE_SCREEN_LAYOUT`：屏幕读取所依赖的版面约定。
- `request-records.ts#readClaudeRequests`：会话追踪的请求内容（docs/TRACE.md §2.1），读转写里的 `api-request*` 行。

## 不变量

- 回合的开始和结束以先到的一路为准，第二次报告同一事实是空操作；已见过的 prompt 记在 `seen` 里，晚读到的转写行不能重开或重关回合。`session-state.ts#reduce` 不读屏幕。
- 转写只追加：游标是字节偏移加文件身份，`transcript-source.ts#ClaudeTranscriptSource` 按行自带的 `uuid` 与内容分段命名实体，重读不写新行（G2、G7、G8）。
- 流式草稿只是转写的占位：`live/drafts.ts` 宁可判为「已写入」而少一会儿流式，也不能让答案出现两份；重启之后不为已开始的回合起草。唯一的例外是以 failed 结束的回合：草稿按原 id 转正为这一回合的正文（`live/drafts.ts#plan`），之后转写里又写出同一段时收回转正的那份。转正的正文只在 journal 里，车道按转写重建后就没有了。
- 自动压缩的 PreCompact hook 可能先于该 prompt 的转写行到达，要按 hook 的 `prompt_id` 压住，等 prompt 行读到后并入同一回合，否则会写成上一回合的尾巴并开出第二个压缩。
- 新启动的 CLI 在 SessionStart 之后还要看到输入框才算就绪（`ready-gate.ts#ReadyGate`）；超时只接受 hook，所以不会比只看 hook 更慢。
- 停止当前回合时，`stops.ts#stopMainTurn` 先撤下发布的回合（`runtime.ts#withdrawPublishedTurn`），此后按键前的复核拿被停的回合与客户端给的 `turnId` 比对，且仅当它仍是在跑的 prompt 时才算数；否则每次带 `turnId` 的停止都会返回 `NATIVE_STOP_TARGET_CHANGED`，不发任何按键。`recordings.test.ts` 的 `interrupt` 场景按客户端的方式停止并检查结果。
- 30 秒内连续退出两次，下一次启动去掉 `--resume` 新开会话（`launch-guard.ts#QUICK_EXIT_LIMIT`）；计数存在会话上，重启服务不清零。
- 发布新的会话 id（`setNativeSessionId`）会同步重绑服务端已有的监听，所以 `index.ts#ClaudeBackendAdapter` 先登记本次启动的运行时再发布 id，否则监听会另起一个 CLI；启动失败且终端没换时撤回这个 id，重试才不会去 `--resume` 一个从未写下的对话。
- 恢复会话会启动新的 CLI，此时旧终端的退出观察或在途的状态轮询可能晚到，不能把新进程记成已退出（`binding.ts#refreshTerminalStatus` 用启动计数 `launches` 丢弃启动之前开始的检查，修复 1a06647）。
- 只有 `runtime.ts#ClaudeSessionRuntime` 给 `state` 赋值，`setStatus` 与 `dispatchSignal` 只在它上面定义；各组拿到的是取值函数和回调（各自的 `…Deps` 接口），不拿运行时本身。一组要改另一组的数据时调对方的方法，不就地改字段。
- 对所有 hook 都成立的步骤在 `hook-routes.ts#handleHook` 里按固定顺序先做，`matchesTurn` 在分发前取值：工具 hook 自己可能开出它所属的回合（`noteToolHook`），分发后再取，开出回合的那个 hook 就会被算作属于已发布的回合，引导会在它身上被取走。
- `index.test.ts` 与 `recording.ts` 经适配器的 `runtimes` 直接调用运行时上的 `refreshTranscript`、`refreshScreenState`、`convergeBackground`、`refreshTerminalStatus`，读 `screenDialogTask`、`pendingSend`、`state`，写 `started`，并替换实例上的 `screenConvergenceSupported`。这些成员在运行时上是转发，不能删；`screenConvergenceSupported` 必须留在运行时实例上并经回调传给 `screen-watch.ts#ClaudeScreenWatch`，搬进别的组后测试的替换不再生效。
- 预热键由 `warm.ts#sessionClaudeWarmKey` 从 `apps/server/src/backends/shared/launch-input.ts#SessionLaunchInput` 派生；键与启动不一致时静默冷启动。
- 屏幕读取的版面约定属于 CLI，随时可能变；读不出时一律退化为不画草稿，不能影响转写读取。

## 外部行为

- 屏幕：输入框、页脚 agent 列表与任务入口见 `apps/server/src/adapters/cli/claude-code.ts#claudeComposer`，对话框见 `screen-dialog.ts`。录制在 `fixtures/screens/2.1.302` 与 `2.1.322`，测试 `screen-fixtures.test.ts`。
- 表格在屏幕上有两种画法（2.1.322 渲染器）：放得下时是框线表，表头居中、单元格按列折行并在行内上下居中；比窗格宽或单元格折行超过 4 行时改成逐条记录，每行 `列名: 值`，续行缩进 2 格，记录间是一行 `─`。流式中途从框线表改成记录时，已滚出的框线行留在上方。`live/markdown.ts#drawnTables` 把两种画法及这种拼接还原成 Markdown 表格，读不出就仍放代码块。
- 新版本验证：`node --import tsx scripts/probe-claude-e2e.ts --capture apps/server/src/backends/claude/fixtures/screens`，让 `screen-fixtures.test.ts` 在新录制上通过，再提高 `launch.ts#CLAUDE_CLI_VERSIONS` 的 `testedThrough`。多键走屏只在该版本以内进行。
- 转写 JSONL（`<projects>/<dir>/<sessionId>.jsonl`，子 agent 在 `subagents/agent-<id>.jsonl`）：CLI 成批写入，hook 即时到达，所以 hook 报告的新回合可能早于上一回合的结束行。录制在 `fixtures/transcript-hooks/<版本>`（与 hook 同一条时间线），测试 `recordings.test.ts`，重录用 `pnpm record claude <场景|all>`，漂移检查加 `--check`。场景含 `resume`、`compact`、`clear`、`stop-failure`；`/clear` 之后的新会话转写以 `2:` 为文件名前缀。
- hook（UserPromptSubmit、Stop、StopFailure、PermissionRequest、PreToolUse、PreCompact 等）：入口 `hook-bridge.ts#ClaudeHookBridge`，改变回合状态的 hook 在会话未就绪时要等其运行时拉起。录制与转写同在 `fixtures/transcript-hooks/<版本>`，重录方式同上。
- 权限对话框先在屏幕上读出（`claude-screen:` 卡），PermissionRequest hook 随后到达并取代它；此时回答屏幕卡返回 `NATIVE_INTERACTION_STALE`，客户端等协议卡到达后再答，自动化脚本要等 `transport === 'protocol'`。
- 状态描述文件由 `hook-cli.mjs` 每次 hook 时重读，所以比服务活得更久的 CLI 能找到重启后的服务。
- 流在输出中途断开时（`isApiErrorMessage`、`truncatedAfterOutput: true`，2.1.322 的 `API Error: Connection lost mid-response`），CLI 只写这条错误行，已经画到屏幕上的正文不进转写。错误在屏幕上是回答下面单独的一个 `⏺` 块（`fixtures/transcript-hooks/2.1.322/stop-failure.jsonl`），会接替草稿的 id，所以要记住它接替的那一块；StopFailure hook 先于错误行到达。草稿若按普通的回合结束收回，这段回答会从时间线上消失，阅读中的视图也会落在空白处。
- 子 agent 的后台任务（例如 Bash 超时后被转入后台）完成时，CLI 也会在主转写里写一条 `queue-operation` enqueue/remove，`<tool-use-id>` 指向子 agent 的调用，随后由子 agent 取走。主会话既没发起也没挂着这个调用的报告不建活动（`activity.ts#notified`），否则它会作为孤立的一行出现在主时间线末尾。
- CLI 重启后会补报上一进程遗留的后台任务：先写 `queue-operation` enqueue/dequeue，再写一条 `queueTranscriptOnly: true` 的 task-notification 行，这一行不开回合。回执扫描（`transcript-source.ts#suffixPrompts`）照样要让它消耗队列里取出的那一项，而且通知只配对通知、消息只配对消息；否则紧跟其后发出的消息会被配给这条通知，回执永远找不到，run 一直停在「等待上一条消息确认」。
- 转写 JSONL 里的异步辅助行（`attachment`、`queue-operation`、`file-history-delta` 等）可能乱序写入、时间戳早于或晚于紧邻的 `assistant` 行；`step-meter.ts#ClaudeStepMeter` 测速时只认 `api-request`、`user`、`assistant` 三类对话边界且优先取紧邻的 `api-request`，忽略辅助行，避免耗时归零、倒挂或虚高。
- 转写里的 `api-request-shape` / `api-request` / `api-request-blob` 是 Claude Code 的私有记录（2.1.322 起见到），没有文档承诺；`api-request` 的消息是上一请求的前 `keep` 条加 `tail` 哈希，`tail` 里只有非对话消息有 blob。格式变了追踪显示 `unrecognized`，改 `request-records.ts` 并补 `backends/shared/trace-requests.test.ts`。

## 排障

- 回合一直忙、模型或服务商切换被拒：看 `session-state.ts` 的 `cliQueue` 是否残留，`riffet logs --scope claude` 中有 `cli queue converged from screen` 或 `background converged from screen` 说明靠屏幕才收敛。
- 切换模型或服务商后消息一直排队、会话却空闲：切换要重启 CLI 才生效（`configPending`），重启等主回合和后台任务都结束，期间排队消息被 `apps/server/src/native/lane.ts#admission` 以 `turn_running` 挡住。后台跑着开发服务这类不会自己结束的任务时，`runtime.ts#relaunchControl` 发布「新设置在后台任务结束后生效」和「结束后台任务并应用」（`runtimeControl`），由使用者决定是否结束它们。
- 流式草稿与最终答案不一致或出现两份：日志 `live draft differs from its transcript text` 是版面漂移信号，按 `live/screen.ts` 顶部的步骤补录新版本屏幕。
- 发送长期显示等待确认：`riffet logs --scope claude` 中的 `paste not shown within the window` 与 `first prompt after dispatch does not read as the message sent`，对应 `composer.ts`、`sends.ts#awaitReceipt` 的粘贴回执等待。
- hook 全部没有反应：`riffet logs --scope claude` 中的 `hook descriptor could not be written` 或 `hook bridge could not start`。
- 服务重启后引导一直补充不进当前回合、每次都变成下一条消息：引导只看 `runtime.ts#steerTarget`，没有 `started`（本服务没启动这个 CLI）时要求这一回合的工具 hook 已到达本服务（`outputPromptId`）；状态里有 `activeTurn` 而这里不认，就会在 `enqueue` 抛 `STEER_TARGET_CHANGED` 并由 `requeueSteer` 转成排队消息。
- 屏幕解析在新版 CLI 上失效：`npx vitest run apps/server/src/backends/claude/screen-fixtures.test.ts`，再用 `scripts/probe-claude-e2e.ts --capture` 录制现场。
