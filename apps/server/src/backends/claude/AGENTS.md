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
- `runtime.ts#ClaudeSessionRuntime`：每个会话一个，管理发送、打断、排队、预热接管与终端重启。
- `session-state.ts#reduce`：会话状态的事件归约，输入是转写行与 hook，不含屏幕。
- `transcript-source.ts#ClaudeTranscriptSource`：转写 JSONL 进入 journal 的唯一路径，子 agent 各占一条车道。
- `hook-bridge.ts#ClaudeHookBridge`：本服务所有 CLI 共用的一个回环端点，按 `session_id` 路由。
- `live/screen.ts#CLAUDE_SCREEN_LAYOUT`：屏幕读取所依赖的版面约定。

## 不变量

- 回合的开始和结束以先到的一路为准，第二次报告同一事实是空操作；已见过的 prompt 记在 `seen` 里，晚读到的转写行不能重开或重关回合。`session-state.ts#reduce` 不读屏幕。
- 转写只追加：游标是字节偏移加文件身份，`transcript-source.ts#ClaudeTranscriptSource` 按行自带的 `uuid` 与内容分段命名实体，重读不写新行（G2、G7、G8）。
- 流式草稿只是转写的占位：`live/drafts.ts` 宁可判为「已写入」而少一会儿流式，也不能让答案出现两份；重启之后不为已开始的回合起草。
- 自动压缩的 PreCompact hook 可能先于该 prompt 的转写行到达，要按 hook 的 `prompt_id` 压住，等 prompt 行读到后并入同一回合，否则会写成上一回合的尾巴并开出第二个压缩。
- 新启动的 CLI 在 SessionStart 之后还要看到输入框才算就绪（`ready-gate.ts#ReadyGate`）；超时只接受 hook，所以不会比只看 hook 更慢。
- 停止当前回合时，`runtime.ts#stopMainTurn` 先撤下发布的回合，此后按键前的复核拿被停的回合与客户端给的 `turnId` 比对，且仅当它仍是在跑的 prompt 时才算数；否则每次带 `turnId` 的停止都会返回 `NATIVE_STOP_TARGET_CHANGED`，不发任何按键。`recordings.test.ts` 的 `interrupt` 场景按客户端的方式停止并检查结果。
- 30 秒内连续退出两次，下一次启动去掉 `--resume` 新开会话（`launch-guard.ts#QUICK_EXIT_LIMIT`）；计数存在会话上，重启服务不清零。
- 恢复会话会启动新的 CLI，此时旧终端的退出观察或在途的状态轮询可能晚到，不能把新进程记成已退出（`runtime.ts#ClaudeSessionRuntime`，修复 1a06647）。
- 预热键由 `warm.ts#sessionClaudeWarmKey` 从 `apps/server/src/backends/shared/launch-input.ts#SessionLaunchInput` 派生；键与启动不一致时静默冷启动。
- 屏幕读取的版面约定属于 CLI，随时可能变；读不出时一律退化为不画草稿，不能影响转写读取。

## 外部行为

- 屏幕：输入框、页脚 agent 列表与任务入口见 `apps/server/src/adapters/cli/claude-code.ts#claudeComposer`，对话框见 `screen-dialog.ts`。录制在 `fixtures/screens/2.1.302` 与 `2.1.322`，测试 `screen-fixtures.test.ts`。
- 新版本验证：`node --import tsx scripts/probe-claude-e2e.ts --capture apps/server/src/backends/claude/fixtures/screens`，让 `screen-fixtures.test.ts` 在新录制上通过，再提高 `launch.ts#CLAUDE_CLI_VERSIONS` 的 `testedThrough`。多键走屏只在该版本以内进行。
- 转写 JSONL（`<projects>/<dir>/<sessionId>.jsonl`，子 agent 在 `subagents/agent-<id>.jsonl`）：CLI 成批写入，hook 即时到达，所以 hook 报告的新回合可能早于上一回合的结束行。录制在 `fixtures/transcript-hooks/<版本>`（与 hook 同一条时间线），测试 `recordings.test.ts`，重录用 `pnpm record claude <场景|all>`，漂移检查加 `--check`。场景含 `resume`、`compact`、`clear`、`stop-failure`；`/clear` 之后的新会话转写以 `2:` 为文件名前缀。
- hook（UserPromptSubmit、Stop、StopFailure、PermissionRequest、PreToolUse、PreCompact 等）：入口 `hook-bridge.ts#ClaudeHookBridge`，改变回合状态的 hook 在会话未就绪时要等其运行时拉起。录制与转写同在 `fixtures/transcript-hooks/<版本>`，重录方式同上。
- 权限对话框先在屏幕上读出（`claude-screen:` 卡），PermissionRequest hook 随后到达并取代它；此时回答屏幕卡返回 `NATIVE_INTERACTION_STALE`，客户端等协议卡到达后再答，自动化脚本要等 `transport === 'protocol'`。
- 状态描述文件由 `hook-cli.mjs` 每次 hook 时重读，所以比服务活得更久的 CLI 能找到重启后的服务。

## 排障

- 回合一直忙、模型或服务商切换被拒：看 `session-state.ts` 的 `cliQueue` 是否残留，`riffet logs --scope claude` 中有 `cli queue converged from screen` 或 `background converged from screen` 说明靠屏幕才收敛。
- 流式草稿与最终答案不一致或出现两份：日志 `live draft differs from its transcript text` 是版面漂移信号，按 `live/screen.ts` 顶部的步骤补录新版本屏幕。
- 发送长期显示等待确认：`riffet logs --scope claude` 中的 `paste not shown within the window` 与 `first prompt after dispatch does not read as the message sent`，对应 `composer.ts`、`runtime.ts` 的粘贴回执等待。
- hook 全部没有反应：`riffet logs --scope claude` 中的 `hook descriptor could not be written` 或 `hook bridge could not start`。
- 屏幕解析在新版 CLI 上失效：`npx vitest run apps/server/src/backends/claude/screen-fixtures.test.ts`，再用 `scripts/probe-claude-e2e.ts --capture` 录制现场。
