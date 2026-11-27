---
module: server.timeline
verify:
  - npx vitest run apps/server/src/timeline
  - npx vitest run packages/timeline
  - npx vitest run apps/server/src/sync/pipeline-contract.test.ts
co-change:
  - when: fold.ts#LaneFold
    with:
      - apps/server/src/journal/ingest.ts#TranscriptSource
      - apps/server/src/sync/pipeline-contract.ts#runReadPipelineContract
    reason: LaneFold 在 meta.turn_ended 丢弃活跃 draft 并靠 rebase 冻结旧回合，改写草稿或结束逻辑须同步核对写入接口与跨层读链路校验（P1–P6）
---

## 职责

把每条车道的 journal 日志、Run 与后台任务折叠成 `timeline_rows`，给同步协议按 seq、位置、回合读取。折叠规则本身在 `packages/timeline`，这里只负责增量、持久化和预算。

## 入口

- `service.ts#TimelineService`：折叠调度、读取（`changes`、`page`、`snapshot`、`outline`）和冷会话清理。
- `fold.ts#LaneFold`：一条车道的折叠窗口，只持有未结束回合的尾部。
- `tables.ts#TimelineTables`：`timeline_rows`、`timeline_heads`、`timeline_turns` 三张表的读写。
- `budget.ts#fitRow`：单行预算的截断，截断行带 `truncated.blobRef`；assistant、thought 行不截断。
- `find.ts#LaneFinder`：车道内查找，按 head 计数。

## 不变量

- 折叠规则变了必须同时加大 `fold.ts#FOLD_VERSION`：它进入 `fold.ts#generationOf`，所有车道因此换 generation，客户端收到快照而不是错位的增量。
- 折叠不在调用方的栈上执行，journal 提交只排下一轮事件循环（`service.ts#TimelineService`）；读取方等 `service.ts#ready`，不要在提交回调里同步读行表。
- 车道 seq 只在行摘要变化或行被删除时加一，摘要取自截断之前的行（`tables.ts#RowState`）；改了截断规则不会让 seq 空转，但会让已发出的行与表里不一致，需要升 `FOLD_VERSION`。
- 没有回显的 Run 按 `NativeRunDetails.inputEntry` 在日志里的 seq 放置，只在它的 generation 与窗口所读日志一致时（`fold.ts#LaneFold` 传入 `TimelineSeed.log`）；不一致或没有的，走 `packages/timeline/src/buildTimeline.ts` 里按时间放置的旧规则。不要给有 `inputEntry` 的 Run 再加时间比较（docs/TURN-LIFECYCLE.md §4.2）。
- 只折叠窗口尾部。已结束回合里的实体出新版本、工具更新、迟到输出或 Run 变化，要经 `fold.ts#LaneFold` 的 `unfreeze` 退回到那个回合的开头重折叠；新增会改写旧回合的输入时，要确认它走了这条路。
- 冷会话清理（`service.ts#sweepCold`）删行但保留 head 并换 `epoch`，子 Agent 车道先把行数和文件改动存进 `timeline_heads.summary`，否则父工具行重折叠后摘要会变。内存里的后台任务不在日志里，行上带任务的会话不会被清理。
- 迟到的旧回合记录不能覆盖子 Agent 当前轮次的状态；回合结束标记被撤销（tombstone）后，错误状态行要同步移除（`fold.ts#LaneFold`）。
- `journal.rebuild` 产生的空日志通知短暂延迟折叠（`REBUILD_SETTLE_MS`）以等待源重新导入，多步重折叠的 `reset` 推迟到 `caughtUp` 后再发出，避免客户端闪现空时间线或半截历史。

## 外部行为

- 读 `journal.db` 的日志与 blob，写 `derived.db` 的 `timeline_*` 表（测试里与 journal 同库）。空闲超过 `SERVER_BUDGET.coldTimelineDays` 且无人打开的会话，行被丢弃，下次打开从 journal 重折叠；预算见 `packages/contracts/src/budgets.ts#SERVER_BUDGET`。
- 折叠结果的契约是 `packages/contracts/src/sync.ts#SYNC_BUDGET` 与 `TimelineRow`；Kotlin 解码器的共享数据由 `pnpm gen:timeline-fixtures`（`scripts/gen-timeline-fixtures.ts`）生成，Web 转写的回放用 `scripts/replay-transcript.ts`。
- 折叠规则的场景测试在 `packages/timeline/src/projectEvents.test.ts`；性能基线 `scripts/bench-timeline.ts`。
- CLI 只回传附件名称或路径时，已关联的消息按 `Run.native.input.attachmentIds` 的上传顺序显示附件。回执中的名称、类型按上传 ID 匹配；直接在 CLI 发送的附件沿用原生记录。

## 排障

- 行显示不更新或某条车道停住：`riffet logs --scope timeline`，`[timeline] fold of <session> <lane> failed` 是折叠抛错（`service.ts#TimelineService`）。
- 客户端反复收到快照、不走增量：比较 `timeline_heads` 的 `generation`、`epoch` 与 `fold_version`，常见原因是 `FOLD_VERSION` 变化、日志重建或冷清理。
- 冷清理失败或磁盘不回收：`riffet logs --scope timeline`（`cold sweep failed`），`riffet doctor --compact` 在服务停止后整理数据库。
- 大纲里多出重复的提示、刷新后消失：客户端没有按 `outline` 帧里 `rows: 0` 移除回合（`fold.ts` 删除回合时这样宣告）；服务端 `GET /api/v3/sessions/:id/outline` 是准的。
- 长回答停在半句、下面出现「显示全部」：旧版本把超过 32KB 的 assistant 行也截成了 16KB 预览；现在模型输出整行下发（`budget.ts#MODEL_KINDS`），仍有截断说明折叠版本没更新，看 `timeline_heads.fold_version`。
- 补充引导（steer）跑到本回合首条输出上方：核对 `journal_events` 对应工具结果处是否已写入 `native_input_receipt`（若仍为 `cursor_tool_context` 或未命中回执，会退化到 `placeRunRows` 按时间戳插队，在 Cursor 批量落盘 `seenAt > dispatchAt` 时跳到前面）；未送达的 `queued`/`preparing` steer 由 `packages/timeline/src/buildTimeline.ts` 的 `targetTurnEndIndex` 锚定在目标回合既有输出之后。
- 打开旧会话慢：首次折叠要读完整日志，看 `timeline_heads.folded_through` 与 `journal_seq` 的差距。
