---
module: server
verify:
  - pnpm check:layers
---

## 职责

服务端的根模块：没有自己模块文档的目录和根目录下的文件归这里，并承载对整个服务端都成立的约束。

## 入口

- `app.ts#createApp`：组装全部服务；需要上层能力的模块由这里注入，不自己导入。
- `scripts/check-layers.mjs#LAYERS`：各目录所在的层，是层级的唯一声明（`pnpm aif modules` 由它得出模块的层）。
- `native/session-input.ts#resolveNativeSessionInput`：页面发来的会话请求都经它解析。

## 不变量

- 按层组织，导入只能指向下层（`docs/guide/architecture.md`「服务端分层」）。`pnpm check:layers` 拦下新增的越层导入；需要上层的东西时由 `app.ts#createApp` 传进来，或者把公共部分下沉。
- 预热的进程只交给启动配置与预热键完全一致的新会话，不一致时静默冷启动，不报错（`docs/PLUGIN_ARCHITECTURE.md`「预热」）。页面的请求一律经 `native/session-input.ts#resolveNativeSessionInput` 解析，会话一侧读存储的会话。
- 给会话加了影响启动或工具列表的字段，加进 `backends/shared/launch-input.ts#SessionLaunchInput`，各后端的预热键在类型检查时会要求处理它；Cursor 插件的 `resourceKey` 在仓库外，要自己跟上；影响 Riffet MCP 工具的还要让 `riffet-mcp/service.ts#draftOf` 跟上。

## 外部行为

- 本模块不直接解析外部输入：Agent CLI 归 `backends/` 下各模块，tmux 归 `terminal/`，HTTP 与 WebSocket 契约归 `routes/`。
- 持久状态在数据目录（默认 `~/.local/share/riffet`）的 SQLite 文件里，打开方式在 `sqlite-storage.ts`。

## 排障

- 新会话没有用上预热的进程：服务日志里出现 `prewarm: a new session did not match the warm one`（`packages/plugin-api/src/kit/warm-pool.ts`），日志里带着持有的键和想要的键，对比二者即可知道哪个字段不同。
- 环境与依赖问题：`riffet doctor --json` 逐项列出 Node、tmux、各 CLI、端口和数据目录。
- 数据库疑似损坏：服务启动一分钟后在 worker 里对 `workbench.db`、`journal.db` 各跑一次只读 `quick_check`（`storage/integrity.ts`），失败只写一条 `[riffet] <库>.db failed its integrity check` 错误日志，不删不改；`riffet doctor` 的 Storage 一节另做跨库一致性（缺失的大块数据、孤儿块、没有会话的日志、derived 超前于日志）。恢复用 `riffet restore --backup <dir> --state-dir <空目录>`。
- 越层导入：`node scripts/check-layers.mjs --list` 按模块对列出每个越层导入及所在文件。
