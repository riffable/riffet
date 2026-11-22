---
module: server.journal
verify:
  - npx vitest run apps/server/src/journal
co-change:
  - when: ingest.ts#eventOrder
    with:
      - apps/server/src/backends/codex/transcript-source.ts#CodexTranscriptSource
    reason: eventOrder 决定转写源是否把已有实体（含活跃 draft）误判为新行并触发全量 rebuild
  - when: ingest.ts#rebuild
    with:
      - apps/server/src/timeline/service.ts#TimelineService
    reason: rebuild 先清空日志再异步重导，TimelineService 需配合延迟折叠与多步 pendingReset 避免客户端闪现空快照
---

## 职责

会话日志：每个会话每条车道一份只追加的 SQLite 日志，后端的转写经写入契约进入，时间线、搜索、统计从它读。设计见 `docs/SESSION-JOURNAL.md` 与 `docs/SYNC-V3.md`。

## 入口

- `journal.ts#Journal`：日志、head、blob、投影缓存和后台整理（`maintainAll`）。
- `ingest.ts#JournalLaneWriter`：后端写日志的唯一接口，每个会话一个并常驻。
- `ingest.ts#TranscriptSource`：后端要实现的转写读取接口。
- `ingest-contract.ts#runIngestContract`：新后端用自己的夹具跑 G1–G10。
- `feed.ts#JournalFeed`：把日志读回原生事件，给回执、搜索和统计用。
- `journal.ts#storedRange`、`storedRow` 与 `trace.ts`：按存储原样读行，给会话追踪（docs/TRACE.md）；索引只读内联列，不读 blob。

## 不变量

- 日志只追加。更新是同一 `nativeId` 的新版本，不改旧行；`nativeId` 必须由原生数据确定（uuid、item id、行号加 part），否则重读会写出重复实体，`ingest-contract.ts#runIngestContract` 以「等于全新导入」检查这一点。
- 游标与行在同一事务提交（`ingest.ts#JournalLaneWriter`），从任意已提交游标重放写 0 行。新增写入路径不能在事务外推进游标。
- 写 `turn_ended` 前先 `drain`，读尽已落盘的尾部。历史读取暂时给出 `interrupted` 时用 `ingest.ts#JournalLaneWriter` 的 `turnReopened` 写 tombstone 作废结束标记并退回游标，已提交的完成、失败、取消不退回。
- 大会话首次导入先写 `#tail` scratch 日志再 `promote`，generation 只换一次；读者通过 `ingest.ts#servingKey` 取当前服务的日志，不要自己拼 key（`journal.ts#laneKey`）。
- 只有原生会话身份变化才 `rebuild`（`journal.ts#Journal`）。轻率重建会让所有客户端收到 reset。
- 草稿（`draft`）、tombstone、`meta.*` 对客户端不可见（`journal.ts#isHiddenKind`）；同一个流式回答只能有一个草稿写入方，双写会让末行轮流闪现片段。
- 内联 payload 上限是 `journal.ts#JOURNAL_PAYLOAD_LIMIT`（2 KiB），超出落 blob；投影缓存可落后不可超前，`projection.ts#projectionCheck` 失败就从日志重建。

## 外部行为

- 存储在 `journal.db`（`journal_heads`、`journal_events`、`blobs`、`session_blobs`）与同级的 blobs 目录，上限取自 `packages/contracts/src/budgets.ts#STORAGE_BUDGET`；`<= blobDictMaxBytes` 的 JSON 对象用静态字典 `zstd-d1` 压缩，更大载荷用 `zstd`，`journal_turn` 为排除 `{}` 空壳的部分索引；旧库升级由 `storage-migration.ts#migrateStorageLayout` 完成，磁盘空间不足时拒绝迁移。
- 后台整理（`journal.ts#compactSuperseded`、`sweepBlobs`、`recompressSmallBlobs`）会剥掉旧修订、将历史中小 JSON blob 升级到字典压缩并清理无引用 blob，只剥超过最小年龄的旧修订；在线备份期间由 `holdBlobGc()` 持有屏障推迟外部文件清理。
- 契约测试夹具由各后端自带：`apps/server/src/backends/` 下各 `transcript-source` 测试调用 `ingest-contract.ts`。

## 排障

- 会话页行重复或顺序错乱：查该会话 `journal_events` 中同一 `native_id` 是否有多个 `seq` 且 `rev` 不递增，以及后端是否在新实体落到已有实体之前、改名/扩充 part 或复活已 tombstone 槽位时未调用 `rebuild('identity-changed')`（`Journal` 按 `rev=1` 的 `seq` 永久固定 `identity` 排序）。
- 回合不结束或被误判结束：查 `kind='meta.turn_ended'` 行与随后的 tombstone，对照 `ingest.ts#hasTurnEnded`。
- 读回日志失败：`riffet logs --scope journal`（`reading <key> back failed`）；排查异常高频重建：`riffet logs --scope journal` 搜 `"event":"rebuild"`（`ingest.ts#JournalLaneWriter`）。
- 存储迁移或整理问题：`riffet logs --scope storage`；`riffet doctor --compact` 整理数据库。
