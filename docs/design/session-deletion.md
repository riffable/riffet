# 会话删除方案

日期：2026-11-11。范围：服务端、Web、macOS、Android 和 iOS。

会话菜单增加删除，保留现有归档。删除从同一服务移除会话记录、所属子 Agent 历史和侧边聊天，连接该服务的新版本客户端同步关闭页面和清理缓存。项目文件、worktree、CLI 原生历史、已发布的分享、独立分叉与交接会话继续保留。

删除需要确认，不提供恢复或回收站。只接受空闲会话；运行、排队、审批、后台任务或分享操作进行中时返回繁忙，先处理对应任务。新增能力通过协议 feature 声明，旧客户端继续使用归档。

## 产品语义

| 动作 | 结果 | 恢复方式 |
| --- | --- | --- |
| 关闭页面或标签页 | 结束当前展示，会话继续存在 | 从会话列表重新打开 |
| 归档 | 从活动列表移除，保留历史 | 从归档列表恢复 |
| 删除 | 移除本方案规定的会话数据 | 无 |

空闲会话和已归档会话都可以直接删除，快速对话沿用相同规则。删除主会话时一并删除其全部侧边聊天（含已归档）；单独删除侧边聊天只影响该聊天。侧边聊天的发现入口依赖主会话，保留会让它们失去入口。

不按所有 `origin.sessionId` 关系级联。分叉、交接和编排尝试是独立会话，保留记录；来源已删除时关闭原文跳转。子 Agent lane 属于会话日志，随所属会话删除。

已发布的分享与本地会话没有生命周期关联：分享保存了自己的标题与发布包，取消、核对和重试都按分享 ID 进行，不读取会话（`shares/service.ts` 的 `remove` / `reconcile` / `retry`）。删除会话不撤销分享，用户继续在设置 → 分享中管理。

## 删除范围

| 对象 | 处理 |
| --- | --- |
| Session、Run、事件、消息索引与索引水位 | 同一事务删除 |
| 主日志、子 Agent 日志与导入临时日志 | 枚举 `Journal.keysOf` 后全部删除 |
| 时间线、大纲、截断内容归属与回合摘要 | 删除；迟到写入被丢弃（见下文） |
| 快速对话和侧边聊天 JSONL、`<stateDir>/contexts/<sessionId>/` | 删除文件 |
| 被删会话接收的引用快照、共享 blob 与附件 | 解除归属后按现有 `sweepBlobs` 与附件规则回收 |
| 一次性唤醒、通知、会话 MCP 凭证 | 删除并取消设备唤醒租约，撤销凭证 |
| 周期计划 | 保留计划，清除指向被删会话的 `lastSessionId`；下次执行创建新会话 |
| 原生 Agent 终端 | 停止并删除记录；独立 Shell 和登录终端保留，解除 `sessionId` 关联 |
| 分享记录与发布包 | 保留，不撤销；未发布的本地预览草稿由现有 `sweepDrafts` 回收 |
| 收藏、已交付给其他会话的引用快照 | 保留，原文显示会话已删除 |
| 用量统计 | 保留不含正文的事实，移除 `stats_cursor` |
| 项目、worktree、分支与代码修改、CLI 原生历史 | 保留 |

不承诺对备份、第三方副本或磁盘执行安全擦除。独立 CLI 仍可恢复自己保存的历史，并以新的工作台会话再次接入。

## 交互

桌面会话列表的右键或更多菜单，以及会话页更多菜单增加「删除…」，放在归档之后，使用现有危险操作样式。手机使用长按和详情菜单，保留滑动归档手势。侧边聊天菜单使用同一操作。

点击后请求预检，再打开确认：

> 删除会话？
>
> 所有设备都会移除，无法恢复。项目文件和 CLI 历史保留。
>
> 同时删除 2 个侧边聊天。
>
> 1 个定时计划继续运行。
>
> 取消　删除

后两句只在有对应对象时出现。确认复用现有 Dialog / AlertDialog，默认聚焦取消；提交期间禁用重复确认，失败留在原弹窗，成功后直接关闭并退出页面，不追加 toast。只在服务端确认后移除列表项，不做乐观移除。

## 接口

新增 `session-delete-v1` 到 `ProtocolInfo.features`，协议主版本不变。契约在 TypeScript、Zod 与 Kotlin 生成产物中一致维护。

```http
GET /api/sessions/:id/deletion
```

```ts
interface SessionDeletionPreview {
  sessionIds: string[];          // 主会话 + 所属侧边聊天
  blocker?: { code: string; message: string; params?: TextParams };  // 繁忙时的原因，按错误码本地化
  effects: { discussions: number; schedules: number };
}
```

```http
DELETE /api/sessions/:id
{ "sessionIds": ["..."] }        // 用户确认时看到的集合
```

```ts
interface SessionDeletionReceipt { sessionIds: string[]; deletedAt: string }
```

| 状态 | 含义 |
| --- | --- |
| `200` | 已删除，返回实际删除的集合 |
| `409 SESSION_DELETE_BLOCKED` | `reason=running`：运行、排队、审批、后台活动、配置切换或归档进行中；`reason=share`：分享操作进行中 |
| `409 SESSION_DELETE_SCOPE_CHANGED` | 服务端算出的集合与请求不同（如期间新开了侧边聊天），重新预检 |
| `409 SESSION_DELETING` | 同一会话的删除正在进行；删除期间新的发送也返回它 |
| `410 SESSION_DELETED` | 读取、写入、旧创建请求或重复删除命中已删除 ID；客户端对 DELETE 的 410 按删除成功处理 |
| `404` | 不存在或不可见；不能据此清理本地副本 |

不需要内容级的强校验值：会话空闲时，新内容只能来自新运行（被繁忙检查拒绝），或用户在外部 CLI 中继续对话（内容仍在 CLI 历史中，删除的只是 Riffet 的镜像）。

## 服务端流程

删除协调放在会话生命周期模块，路由只做输入输出转换。复用 `SessionCommands` 屏障、`SessionLock`、`store.transaction`，不新增任务队列或 `deleting` 状态。

1. 为整组 ID 建立操作屏障（`SessionCommands.beginDelete`，与 `beginArchive` 同类），按 ID 排序取得会话锁。屏障期间新发送被拒绝；屏障前已通过准入的发送由事务内的再次核对兜住。
2. 锁内重读集合并检查繁忙：dispatcher 任务与 reservation、未完成 Run、已加载 runtime 的 active turn / interaction / background / compacting，以及 `ShareService` 对该会话的锁。集合不一致或繁忙时拒绝。
3. 停止数据来源：`nativeBackends.dispose(id)`、停止原生终端、`ingest.forget`、`timeline.drop` 的内存部分、按当前记录取消设备唤醒租约、撤销 MCP 凭证。这些步骤需要读取会话记录，必须在事务前完成。
4. 一个 `store.transaction` 内再次核对集合与未完成 Run，写入 tombstone，并删除全部数据库内容。所有 lane 和侧边聊天一起提交，失败整体回滚。
5. 提交后发出列表、收藏和统计 revision 变化，执行文件回收，释放屏障和锁。

### 迟到写入

Journal、时间线、摘要都使用 `store.db` 与 `store.transaction`（`BEGIN IMMEDIATE`，写入串行）。在这些写入点的事务内检查 tombstone，删除提交后到达的 ingest、timeline fold、摘要、标题写入直接丢弃，不需要逐个等待后台任务收敛。文件写入（chat JSONL、引用 Markdown）在落盘后重检 tombstone，命中则删除自己写出的文件。

### Tombstone 与防重建

`createNativeSubmission` 在 `clientSessionId` 不存在时会新建会话，删除 Session 和 Run 后，另一设备重试原创建请求会重建同一 ID 并重发初始消息。因此每个被删 ID 保留最小记录：

```ts
// settings key: session-deleted:<sessionId>
interface DeletedSession {
  rootId: string;
  deletedAt: string;
  sessionIds?: string[];     // 仅根记录，用于重复 DELETE 的回执
  cleanupPending: boolean;
}
```

- 与数据库删除同一事务提交，不设 TTL。
- 所有创建路径在最终事务内拒绝 tombstone ID：普通会话、快速对话、侧边聊天、无项目任务、分叉、交接、模板与计划。无项目任务和隔离分叉在分配目录或 worktree 前再检查一次。
- 读取和变更接口在会话查询处统一返回 `410 SESSION_DELETED`。
- `SCHEMA_VERSION` 加一。旧版服务已有 `DATABASE_VERSION_NEWER` 拒绝打开新库，降级后不会绕过 tombstone 重建会话。

### 文件回收

路径只从受控目录与校验过的 ID 派生，不跟随符号链接。回收成功清除 `cleanupPending`；失败记入服务诊断，启动和现有维护周期按 `cleanupPending` 重试。文件回收失败不影响删除结果。

## 客户端

新客户端只在服务端声明 `session-delete-v1` 时展示入口。

本端删除成功后，按回执中的 ID 集合关闭流和预取，清除全部 lane、搜索索引、草稿、待创建记录和窗口状态；不能调用会清空整个工作台的 `SessionStore.clear()`。缓存写入按服务和会话检查失效，避免旧流或保存任务把数据写回。

其他设备在以下任一情况清理：

- 轮询成功返回的新列表中缺少该 ID，且预检确认返回 `410 SESSION_DELETED`。列表随新结果更新；本地副本只在服务端确认后清理（服务端恢复备份等情况下，缺失不等于删除）。缓存恢复、离线、请求失败不算。
- 打开的会话读取或流收到 `410 SESSION_DELETED`。

普通 `404`、网络失败不触发清理，也不自动重发旧消息。

Web 关闭普通标签页和侧边聊天面板，当前会话被删时沿用相邻会话回退。共享 Kotlin 层统一处理 selected、流、缓存和列表（`SessionLists` 在成功轮询的路径比较缺失 ID，`SessionStore.removedSessions` 通知各端关闭页面）；macOS 另外关闭独立窗口，Android 与 iOS 移除导航栈中的对应路由。

旧客户端可能保留已打开的页面和离线缓存，服务端拒绝其读写；完整的本地回收需要升级后的客户端。

## 实施范围与顺序

| 模块 | 改动 |
| --- | --- |
| `packages/contracts`、生成契约与错误目录 | 预检、回执、feature、`SESSION_BUSY` / `SESSION_DELETE_SCOPE_CHANGED` / `SESSION_DELETED` |
| `routes/sessions.ts`、会话生命周期模块 | 两条接口与删除协调 |
| `store.ts`、`SessionCommands`、dispatcher | tombstone、删除事务、创建边界、屏障与繁忙判断、`SCHEMA_VERSION` |
| journal、timeline、turn-summary、标题、ingest | 写入点 tombstone 检查、停止来源 |
| orchestration、MCP、devices、context references、chat | 唤醒、租约、凭证、计划引用、文件回收 |
| Web API、session actions、lists、tabs、sync cache | 确认、回执处理、其他设备收尾 |
| Kotlin API、SessionStore、SessionLists、TimelineCache | 原生三端共享的删除与缺失收尾 |
| macOS、Android、iOS 界面 | 复用现有菜单与确认组件，处理窗口或导航 |

顺序：服务端契约、tombstone、事务与写入点检查 → 文件回收与重启重试 → Web 与 Kotlin 共享状态 → 三端菜单与导航。服务端与客户端回收都完成后才声明 `session-delete-v1`。

批量删除、回收站、worktree 清理和 CLI 原生历史删除不进入第一版。以后接入原生删除时逐后端核对官方接口（如 Codex 的 `codex delete`）与最低版本。

## 验收

| 行为边界 | 必须成立的结果 |
| --- | --- |
| 权限与范围 | 不可见对象不可预检或删除；集合变化返回 `409`，不扩大删除范围 |
| 繁忙与并发 | 运行、排队、审批、后台活动和分享操作均阻塞；屏障建立后新发送与侧边聊天创建不能提交 |
| 数据完整性 | 主会话与侧边聊天原子删除；全部 lane、摘要、索引和凭证不可再读；分叉、项目、分享和收藏保留 |
| 迟到写入 | 删除提交后到达的 journal、timeline、摘要和文件写入不留下数据 |
| 幂等与恢复 | 重复 DELETE 返回 `410`，客户端按已删除处理；重启前后旧创建请求都不能重建 ID；文件回收失败重启后完成 |
| 多端 | 另一设备删除当前会话后正确退出；离线与请求失败不误清 |
| 兼容 | 新客户端连旧服务只有归档；旧服务端拒绝打开新库 |

扩展已有 Store、路由、dispatcher 与共享状态的核心测试，覆盖上述幂等、并发、持久化与恢复；菜单和弹窗只做编译与按需界面检查，不增加 UI 展示测试。不对真实用户会话执行删除验证。
