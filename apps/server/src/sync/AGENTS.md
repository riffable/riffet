---
module: server.sync
verify:
  - npx vitest run apps/server/src/sync
co-change:
  - when: ingest.ts#TranscriptIngest
    with:
      - apps/server/src/journal/ingest.ts#TranscriptSource
      - apps/server/src/backends/plugin-backend.ts#PluginLaneSource
    reason: endTurn 经 TranscriptSource.settleTurnEnd 保持单一写入方（D2），改动外部结束逻辑须同步插件适配器与跨层读链路校验
---

## 职责

同步协议 v3 的服务端：一条 SSE 流发送 `hello`、增量或快照、之后的每次变化，并在有人读取时让会话的转写保持最新。规格见 `docs/SYNC-V3.md`。

## 入口

- `service.ts#SyncService`：打开一条流，订阅并生成 `hello`、`delta`、`snapshot`。
- `connection.ts#SyncConnection`：SSE 写出、两条队列、背压与断开。
- `ingest.ts#TranscriptIngest`：被持有的会话的转写拉取、退避与释放。

## 不变量

- `hello` 与它之后的行必须在同一个同步 tick 里生成：先订阅，再读取，中间不能有 `await`（`service.ts#SyncService`）。在这段里加异步会让变化落进 `hello` 和后续帧之间的缝。
- 首屏不等 provider 读取：`hello` 只等 journal 已有行折叠完成，读取在后台进行，结束后发 `caughtUp`（`service.ts#SyncService`）。不要把 `pull` 或 `drain` 放进 `open` 的等待路径。
- 控制帧先于排队的转写帧写出，历史补齐不得阻塞状态与交互（`connection.ts#SyncConnection`）；客户端用 `headSeq` 而不是到达顺序判断追平。
- 状态、交互、Run、上下文这类整场会话的帧只发主车道，子 Agent 车道只有自己的行、大纲和活动（`service.ts#SyncService`）。
- 读者跟不上就断开：连接积压超过 `slowBacklog` 持续两个心跳，或超过 `maxBacklog`（`connection.ts#SyncConnectionOptions`），数值来自 `packages/contracts/src/sync.ts#SYNC_BUDGET`。
- 同一会话同一时刻只有一次读取，期间的唤醒合并成再读一次；最后一个持有者离开后保留 `lingerMs`（`ingest.ts#TranscriptIngest`）。
- 插件重载后，被跟随会话的转写源要换成新激活的那一个，保留持有者和 writer（`ingest.ts#TranscriptIngest` 的 `reopen`）；否则对话停止收新行，下一条消息按「可能未送达」超时。

## 外部行为

- 客户端是 Web、Mac、iOS、Android，请求带 `generation` 与 `after`，generation 相同且缺口在预算内才发增量，否则发快照（`service.ts#SyncRequest`）。
- 契约在 `packages/contracts/src/sync.ts`；Kotlin 解码器的共享数据由 `pnpm gen:timeline-fixtures` 生成。
- 压测与探测脚本：`scripts/bench-sync-v3.ts`、`scripts/probe-sync-v3.ts`；真实 CLI 的端到端用 `scripts/probe-sync-e2e-lib.ts`。

## 排障

- 打开会话后一直转圈：`riffet logs --scope sync`，`opening <session> <lane> failed` 是 `attach` 抛错，`reading the transcript of <session> failed` 是转写读取失败，ingest 会按 2、10、60 秒退避重试。
- 客户端反复重连或收到 reset：看 `timeline_heads.generation` 是否变化（见 `apps/server/src/timeline/AGENTS.md`）。
- 慢客户端被断开：`connection.ts#SyncConnection` 的积压阈值，日志里有 `reading a snapshot failed` 时先看快照分片读取。
- 新会话 history 显示 loading 而非错误：原生转写尚未生成，属正常，见 `docs/SYNC-V3.md` 的续传一节。
