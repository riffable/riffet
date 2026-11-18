# 列表同步

侧栏的会话、终端与项目列表如何从服务端到达各端。会话内容的同步见 [SYNC-V3.md](SYNC-V3.md)。

## 原则

- 推送只说「哪一类变了、到了哪个修订」，不带数据；数据由客户端按需读取。
- 会话列表按修订增量读取：一次状态变化只传变化的那几条，不重传整表。
- 每类数据各有修订，互不连带：会话变化不重读终端和项目。
- 轮询只兜底：推送连着时 30 s 一次条件读，断开时回到原来的间隔。

## 修订

服务端 `store.ts` 在内存里维护以下修订，进程启动时以 `Date.now()` 为起点，之后单调递增。

| 修订 | 何时前进 | 列表的 ETag |
| --- | --- | --- |
| `sessions` | 会话的增、删、改；项目的分类（`system`）变化时，该项目下的会话也算变化（对旧客户端的可见性随之改变） | `GET /api/sessions` |
| `terminals` | 终端的增、删、改；项目的分类变化 | `GET /api/terminals` |
| `projects` | 项目的增、删、改 | `GET /api/projects` |
| `marks`、`workItems`、`favorites` | 各自的写入 | 各自的接口 |

ETag 为 `W/"<修订>"`，`If-None-Match` 命中回 304。

## 接口

```
GET /api/bootstrap               → {…, workItemSummaries, revisions: {sessions, terminals, projects, workItems}}
GET /api/sessions                → Session[]（全量，不变）
GET /api/sessions?since=<修订>    → SessionListDelta
GET /api/lists/stream            SSE 或 WebSocket；连上立即发一帧 changed，之后去抖 250 ms 发送
```

Web 在服务声明 `list-stream-ws` 时使用 WebSocket。HTTP/1.1 下，多个标签页的侧栏订阅因而不会占用聊天请求所需的 HTTP 连接。WebSocket 帧是 `{event, data}`。旧服务或代理不支持升级时沿用 SSE。

`changed` 的 `data`：`{revision, terminals, projects, marks, workItems, favorites}`。`revision` 是会话修订（沿用旧字段名）。

`SessionListDelta`（`packages/contracts/src/schema/session.ts`）：

```ts
{ revision: number; full?: true; sessions: Session[]; removed?: string[] }
```

- 服务端为每个会话记下最后一次变化时的修订（内存，进程级）。`since` 不早于本进程的起始修订、也不晚于当前修订时，返回修订大于 `since` 的会话；否则返回 `full: true` 和全量。
- 变化过、但已删除或对这个客户端不可见的会话进 `removed`。`removed` 只表示「不再在你的列表里」，是否已删除仍以 `410 SESSION_DELETED` 为准。
- 回答同样带 `ETag: W/"<revision>"`。

能力由协议特性 `list-delta` 声明；不支持的服务端上，客户端照旧做全量条件读。

## 客户端

各端持有每类数据最后应用的修订。

1. 冷启动：先画本地缓存，再读 bootstrap，用它的 `revisions` 作为起点。凡是工作台壳层（侧栏、导航、会话信息）首屏直接渲染的状态，都需要把轻量摘要和对应修订放进 `bootstrap` 与本地缓存，重详情按需拉取，不在挂载后的副作用里串行补拉首屏视觉状态。
2. 收到 `changed`：逐类比较，只读修订不同的那一类。会话用 `since=<已持有修订>`，终端和项目用条件读。连上时的那一帧补上断线期间的变化，不再无条件重读。
3. 合并增量：按 id 替换；本地已有更新的副本（`updatedAt` 更大，来自打开会话的流）时保留本地；删除 `removed` 中的 id；再按 `lastActivityAt ?? createdAt` 倒序，与全量的顺序一致。
4. 读取被本地写入打断而丢弃时，立即再读一次，不等下一次推送。

| 端 | 推送 | 兜底轮询 |
| --- | --- | --- |
| Web（`apps/web/src/app/state/listsStore.ts`） | 常连 | 推送连着 30 s；断开 5 s；标签页隐藏 15 s |
| Mac（`MacHost.kt`） | 常连 | 前台同 iPhone；后台有运行中会话 10 s，否则 30 s，推送连着时至少 30 s |
| iPhone（`IOSHost.kt`） | 只在前台 | 推送连着 30 s；断开 5 s（打开的会话流覆盖时 30 s） |
| Android（`RiffetHost.kt`、`RiffetDevice.kt`） | 与通知共用一条流，随已安装的 store 常连；后台不保活时不读 | 同 iPhone；后台保活时 10 s / 30 s |

Kotlin 三端共用 `ListsFeed`（`apps/mobile/client/.../ui/state/ListsFeed.kt`）：它连接 `/api/lists/stream`，把 `changed` 交给 `SessionStore.listsChanged`，`marks` 修订变化时读收藏，`notice` 交给宿主。

## 没有做的

- **侧栏默认不带归档会话、列表瘦身字段**：增量之后，全量只在冷启动、服务端重启和长时间离开后发生，这两项只缩小这几次读取；而归档列表要各端改成按需分页，字段瘦身要逐端确认没有代码从列表读运行时字段。等全量读取成为瓶颈再做。
- **打开的会话在列表和会话流两条路径上都更新**：增量后列表那一份约 1 KB，保留它，作为会话流断开时的兜底。
