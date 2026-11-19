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
- `runtime.ts#CodexSessionRuntime`：每个会话一个，持有 App Server 连接、回合簿记、审批与子 agent。
- `transcript-source.ts#CodexTranscriptSource`：线程进入 journal 的唯一路径，合并实时通知与 `thread/turns/list`。
- `apps/server/src/backends/shared/codex-app-server.ts#CodexAppServer`：进程、socket 与 JSON-RPC。
- `recording.ts#replayFactory`：录制数据的回放，测试在 `recordings.test.ts`。

## 不变量

- App Server 是线程唯一的读取来源。日志实体按 item 自己的 id 命名（`project-item.ts`），实时通知、重读和重启写的是同一个实体。
- 回合读到定稿副本才算结束。历史读取暂时返回 `interrupted` 时，`transcript-source.ts#turnReopened` 撤销结束标记，但只恢复最后一个已结算的回合，更早的不回填。
- 运行时必须在宿主提供 `host.transcript` 之后创建。否则 `runtime.ts#journalRead` 为 false，草稿流把片段写进转写源写的同一个实体。
- 预热的 App Server 只交给预热键完全一致的新会话（`launch.ts#warmKey`）；不一致时静默冷启动，不报错。会话一侧的键由 `launch.ts#sessionWarmKey` 从 `apps/server/src/backends/shared/launch-input.ts#SessionLaunchInput` 派生，新增启动字段时类型检查会要求在这里处理。
- 能力按 `config.ts#probeAppServer` 的结果和 `initialize` 返回的 userAgent 判断（如 `config.ts#supportsSteerVersion`），不按命令路径缓存。

## 外部行为

- App Server JSON-RPC：入口是 `runtime.ts#onNotification` 和 `runtime.ts#onServerRequest`。录制数据按 CLI 版本存放在 `fixtures/app-server/` 下，场景见 `recording.ts#CODEX_SCENARIOS`。
- rollout JSONL（`$CODEX_HOME/sessions/`）：用量、计划与分享读取，解析入口 `rollout-records.ts#rolloutRows`。尚无录制。
- hook（PreToolUse / PostToolUse，只处理 Bash）：`observation.ts#CodexObservation`，记录命令改动的文件。尚无录制。
- CLI 升级后先运行 `pnpm record codex all`，再运行 `npx vitest run apps/server/src/backends/codex/recordings.test.ts -u`，在代码评审中检查行的差异。

## 排障

- 流式回答的最后一行轮流闪现片段：查该会话 `journal_events` 中 `kind='draft'` 的行。nativeId 以 `-draft:<n>` 结尾的是运行时写的片段，以 `:assistant` 结尾的是转写源写的累积版本；前者出现，说明有运行时在没有 `host.transcript` 的路径上被创建。
- 回合正文缺失或回合不结束：`riffet logs --scope codex-history,codex-journal`，确认是否读到了定稿副本。
- 线程归属冲突、启动或恢复失败：`riffet logs --scope codex-recovery`。
- 协议层的问题：`pnpm record codex <场景>` 在临时项目里复现，录制数据包含运行时与 CLI 之间的每一条消息。
