# 会话产出（Session Outputs）

右侧栏「产出」汇总整场会话最终对文件系统造成的**净变更**，并保证列表统计与点击打开的 Diff 视图口径一致。

> Mac：W 类（工作路径，会话中用到），原生消费 Sync v3 下发的 `outputs` 帧，移除客户端本地扫时间线的重复实现。

## 1. 口径定义

「产出」回答的问题是：**这场会话整体上最终改变了哪些文件、净增删多少行、具体改动是什么。**

- **覆盖范围**：本会话主车道 + 任意层级子 Agent 车道（递归聚合）+ 观测到的 Shell 命令改动；覆盖整场会话，不受 Sync v3 首屏快照（300 行）或客户端内存窗口截断影响。
- **终态过滤**：只计入终态生效的工具调用（`completed` 或已落盘的 `observed: true`）；`in_progress`、`pending`、`running`、`queued`、`cancelled`、`rejected` 与非 `observed` 的 `failed` 不计入。
- **状态分类**：
  - `created`：会话首次触碰前文件不存在，末次触碰后存在。
  - `modified`：前后均存在且内容发生变化。
  - `deleted`：首次触碰前存在，末次触碰后不存在。
  - `binary: true`：二进制文件，不报告虚假行数。
- **净变更抵消**：同一文件反复修改只计净增删；先新建后删除、或先改后完全改回原样（净变更为 0）不出现在产出列表。
- **外部编辑防串味**：基于连续段检测（§3.1），用户或其他进程在两次 Agent 编辑之间手工修改同一文件时，不会把外部改动的行数误算成 Agent 产出。
- **点击一致**：点击产出项默认展示**本会话的净 Diff**（`GET /api/v3/sessions/:id/outputs/diff`），即使会话内已经 `git commit` 或工作区混有其他会话改动，仍与列表统计完全一致；Web 端弹窗顶栏同时支持切换「当前工作区 Git 改动」。

## 2. 两级口径与平滑降级

| 等级 | `accuracy` | 数据来源 | 行为 |
| --- | --- | --- | --- |
| 精确态（主路径） | `exact` | 工具前后单文件快照 / `WorkspaceObserver` shadow repo OID，正文存于 `journal` CAS `session_blobs` | 净增删精确抵消；`created`/`modified`/`deleted`/`binary` 精确判定；点击默认直出本会话净 Diff |
| 兼容兜底 | `estimated` | 服务端 `TimelineService` 在 `fitRow` 16KB/64KB 截断前从完整 `RowContent` diff 块提取（历史旧会话、导入会话、超大文件超配额、未接快照的插件） | 不受分页与 `fitRow` 截断影响；遵循显式 `status`/`created`/`binary`；点击时无快照则自动退回工作区 Git Diff |

## 3. 服务端架构与数据流

严格遵守服务端分层（`scripts/check-layers.mjs`），不引入新存储引擎：

```text
drivers (claude / codex / cursor / dsh / plugin)
  │  编辑工具前后单文件快照 + 补齐 MultiEdit / NotebookEdit / Delete / structuredPatch
  │  Shell 命令经 WorkspaceObserver (--raw -z + --numstat -z)
  ▼
kit (backends/shared/file-snapshots.ts, workspace-observer.ts)
  │  正文写入 journal CAS session_blobs（SHA-256 去重、Zstd、>=128KB Tier-2 外置）
  │  轻量元数据 FileSnapshotRecord 附在 tool_call_update.data.fileSnapshots 入 journal
  ▼
kernel-fact (journal.db + session_blobs)
  ▼
kernel-engine (timeline/outputs.ts, timeline/fold.ts, timeline/tables.ts, timeline/service.ts)
  │  LaneFold.write 在 fitRow 截断前提取未截断变更写入 derived.db.timeline_row_outputs
  │  递归汇总子 Agent 产出（冷清理时随 timeline_heads.summary 持久化）
  │  按项目 root 统一规范化路径，按连续段合并净变更
  ▼
surfaces (Sync v3 hello.outputs + outputs 帧；GET /api/v3/sessions/:id/outputs/diff)
  ▼
Web / Mac / Mobile 客户端（O(1) 渲染，不再扫时间线跑 LCS）
```

### 3.1 单文件快照与分段防串味（`backends/shared/file-snapshots.ts`）

- 内存按 `(sessionId, canonicalPath)` 维护 `{ lastPostHash: string | null | undefined }` 与该会话已消耗的快照字节计数。
- **工具前（`captureBefore`）**：读取目标路径（异步 `fs/promises`），超过 `OUTPUT_BUDGET.snapshotMaxFileBytes` 不读全文。若 `preHash === lastPostHash`，直接复用哈希、零重复落盘；否则写入 `session_blobs`。
- **工具后（`captureAfter`）**：读取最新文件算 `postHash`（被删为 `null`），落 `session_blobs`；若被拒绝或失败（非 `observed`），丢弃未生效的待决快照。
- **连续段合并（`timeline/outputs.ts`）**：
  - 同一路径按时间顺序处理快照 `(preHash, postHash)`：
  - 若 `preHash === 上一段.postHash`，直接将上一段延伸为 `(上一段.preHash, postHash)`（同一连续编辑段内多次修改自然抵消）。
  - 若 `preHash !== 上一段.postHash`，说明期间发生外部编辑，开启新段，防止把外部修改计入本会话行数。
  - 若仅有单段且 `preHash === postHash`（净无变更），该路径从产出列表移除。

### 3.2 `WorkspaceObserver` 解耦统计与 Patch

- `diff-tree -r -z --raw --no-renames` 与 `--numstat -z`（NUL 分隔）替代正则切 `diff --git` header：
  - 彻底修复含非 ASCII / 特殊字符引号转义路径被跳过的问题；
  - 保留二进制文件（`-\t-\tpath`）、删除文件（`D`）与超 64KB 文件的精确状态和行数；
  - 从 `--raw` 的 `A`/`M`/`D` 直接得到 `status`，不再靠 `!oldText` 猜测新建；
  - 从 shadow repo 读取变更文件的前后 OID 内容（受 `OUTPUT_BUDGET` 限制）生成 `FileSnapshotRecord`，不再把大段 patch 文本重复灌入日志。

### 3.3 各后端补齐

- **Claude**：补齐 `MultiEdit`（遍历 `edits[]`）、`NotebookEdit`（`notebook_path` + `new_source`）；结果映射读取 `toolUseResult.structuredPatch` 与 `toolUseResult.type`（区分 `create` 与 `update` 覆写）；编辑工具 `PreToolUse` / `PostToolUse` 接入 `SessionFileSnapshots`。
- **Codex**：`changeHunks` 携带显式 `status`（`created`/`modified`/`deleted`），消除多 hunk 纯插入误判新建；`commandExecution` 透传 `WorkspaceObserver` 生成的 `fileSnapshots`。
- **Cursor**：补齐 `Delete` 工具 diff 块；结果超 `FILE_LIMIT` 且含 `diffString` 时解析 unified diff 而不是降级成纯文本丢失；根据 `beforeFullFileContent` 是否为 `undefined` 精确区分新建与修改。

### 3.4 Sync v3 与 HTTP 契约

- `SyncFrame`:
  - `hello` 新增可选字段 `outputs?: SessionOutputsSummary`（主车道下发）。
  - 新增控制帧 `{ type: 'outputs'; outputs: SessionOutputsSummary }`，仅在产出集合或计数真实变化时推送。
- `GET /api/v3/sessions/:id/outputs/diff?path=<规范路径>`:
  - 返回 `SessionOutputDiff`（`path`、`before`、`after`、`binary`、`truncated`、`status`、`source: 'session'`、`externalEdits?`）。
  - 无快照时返回 404（`OUTPUT_SNAPSHOT_UNAVAILABLE`），前端平滑退回工作区 Git Diff。
- 向后兼容：新字段与新帧均为可选新增；旧客户端忽略未知帧，旧服务端下客户端回退至本地计算（同时修复了 Web 缓存缺 `root` 与 Mac 传 `root = null` 的问题）。

## 4. 性能与资源预算

所有上限集中定义在 `packages/contracts/src/budgets.ts#OUTPUT_BUDGET`（并通过 `pnpm gen:budgets` 同步到各端）：

| 项 | 取值 | 说明 |
| --- | --- | --- |
| `snapshotMaxFileBytes` | 2 MiB | 单文件超过此大小不存全文 blob，仅记状态与行数统计 |
| `sessionSnapshotTotalBytes` | 32 MiB（`lite`: 8 MiB） | 单会话快照 blob 总配额，超限后停存新全文但继续保留统计 |
| `maxOutputs` | 500 | Sync v3 下发产出条数上限，超出携带 `total` |
| `diffCacheEntries` | 256（`lite`: 64） | 服务端 `(preHash, postHash)` 净行数 LRU 缓存 |
| `maxObservedFiles` | 200 | 单条 Shell 命令观测文件上限 |

**生命周期与回收**：
- 快照正文复用 `journal` 的 `session_blobs`：删除会话时随 `journal.deleteSession` 自动清理；在线备份受 `holdBlobGc()` 保护。
- `timeline_row_outputs` 存放在 `derived.db`，随行删除、重建和冷清理同步清理；子 Agent 车道冷清理时将汇总后的产出持久化进 `timeline_heads.summary.changes`。
- 客户端不再对全窗口时间线逐行跑 LCS，右侧栏渲染成本降为 O(1)。

## 5. 多服务器

按 [多服务器适配规范](guide/multi-server.md) §2 清单逐项确认：

1. **归类**：**A 类（工作对象）**，依附于单个会话存在。
2. **A 类路由与展示**：产出数据随会话所在的 Sync v3 流返回，不跨服务器合并；点击拉取 Diff 发往该会话所在的服务器。对端离线时按会话离线状态展示最后缓存或离线提示。
3. **链接策略表**：新路由 `GET /api/v3/sessions/:id/outputs/diff` 落在 `/api/v3/sessions` 前缀下，继承 `apps/server/src/links/policy.ts` 的 `serve` 与 `apps/server/src/access/capabilities.ts` 的 `read`。
4. **客户端请求层**：Web 经 `api.sessionOutputDiff(sessionId, path)`（走 `server-routing.ts` 按 `sessionId` 选服务器），不在业务代码里直拼 `/api/`。
5. **对象标识**：复用会话的全局唯一 UUID，无服务器内递增编号。
6. **插件扩展点**：不新增扩展点；复用现有 `host.workspaceChanges`（`object` 作用域）。
7. **助理与 Riffet MCP**：不新增工具；个人助理页按既有规则隐藏产出区。
8. **入口缓存**：入口服务器不持久保存对端产出副本；Web 客户端仅在当前打开会话的内存状态中持有最多 `OUTPUT_BUDGET.maxOutputs` 条，切换或关闭会话时释放。
9. **提醒**：不适用（不发通知）。
10. **旧版本对端兼容**：`hello.outputs` 与 `outputs` 帧均为可选；对端为旧版本时不带该字段，客户端平滑回退到本地计算，点开 Diff 回退到项目 Git Diff。
11. **对端控制权**：只读会话产出，不触碰任何配置、令牌或链接管理，无越权风险。

## 6. 演进路线

- **Phase 1 & 2（本次落地）**：服务端未截断全量聚合、递归子 Agent 汇总、Sync v3 `outputs` 帧、后端采集补齐（Claude/Codex/Cursor/`WorkspaceObserver`）、单文件快照账本与连续段防串味、`GET /api/v3/sessions/:id/outputs/diff`、Web 与 Mac 原生对接。
- **Phase 3（后续按需）**：
  - 独立 Git Worktree 会话直通 `baseCommit..worktree` 净产出（免除逐命令 shadow snapshot 开销，覆盖后台任务与 MCP 写入）。
  - 同工作区大仓借助 OS 文件事件（FSEvents / inotify）缩小 `WorkspaceObserver` 脏路径集，消除大仓 1500ms 超时熔断。
