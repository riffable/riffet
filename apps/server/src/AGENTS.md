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

- 协作席位的首次设定取当前格式的 `brief`，回看历史发言则按保存的 `runId` 读取 `Run.prompt` 并核对会话的讨论归属。结构化记录是另一个回合，用 `recordRunId` 定位；旧记录缺少关联时不按时间猜测。
- 中途停止或重启后，已完成的发言保留，恢复时只重跑被打断的席位。裁判等席位仍在生成结构化记录时，发言也属于进行中。补跑的辩手也要遵守同轮互不可见；到下一轮再把这条发言加入它已听过的记录。
- 新发言加入列表就要落库，再等席位拉起 Agent。否则在拉起期间重启，库里没有这条发言，讨论恢复成没有可继续步骤的「暂停」（审阅会卡在禁用的「生成修订稿」）。
- 结构化记录先按整段或最外层花括号解析 JSON，失败才取代码围栏：审阅的修改建议字段里常带 ```，先取围栏会截到字符串内部。记录回合失败写 `recordError`，读者可用 `continue` 的 `record` 单独重跑。
- 一场讨论持有的会话是席位当前的会话，加上各发言的 `runId`、`recordRunId` 所在的会话（`sessionsOf`）：换模型、会话被归档后重开，旧会话里还有此前发言的过程和输入，只随讨论删除。启动时清理的是不被任何讨论持有的席位会话（`council.holds`），首次发送时会话已建好、席位还没记下它就重启的那种也在其中。

- 首次启动生成服务器链接证书时报 OpenSSL `illegal padding`：检查 `links/identity.ts` 的证书序列号。DER 要求正整数采用最短编码，随机首字节清除符号位后可能为零。

- 新会话没有用上预热的进程：服务日志里出现 `prewarm: a new session did not match the warm one`（`packages/plugin-api/src/kit/warm-pool.ts`），日志里带着持有的键和想要的键，对比二者即可知道哪个字段不同。
- `riffet start` / `restart` 报启动失败或等得久：服务在监听前写 `server.log` 的 `[riffet] starting: <阶段>`，就绪时写一行 `ready in …`，括号里是各阶段耗时，启动慢先看哪段最长。CLI 跟随这些行等待（`cli/startup.ts#waitForStartup`），只在进程退出或 `SERVER_BUDGET.startupStallMs` 内没有新日志时报错；卡住的进程不结束，`riffet stop` 会结束它。持有 `server.lock` 但还没写 `<stateDir>/daemon.json` 的 `serve` 进程算作启动中（`startingServer`）：`start`、`restart`、`stop`、`status` 都等它或报告它，不再拉起第二个去撞锁。
- `riffet update` 报 `Could not tell which source CLI process <pid> uses`：`cli/source-update.ts#assertSourceProcessesStopped` 读不到该进程的 cwd，没法判断它命令行里的相对路径 `dist/cli.js` 或 `apps/server/src/cli.ts` 是不是本仓库的入口。看 `ps -p <pid> -o command=` 和 `lsof -a -p <pid> -d cwd`；相对路径从 cwd 解析后不存在的进程不算。
- 环境与依赖问题：`riffet doctor --json` 逐项列出 Node、tmux、各 CLI、端口和数据目录。
- 数据库疑似损坏：服务启动一分钟后在 worker 里对 `workbench.db`、`journal.db` 各跑一次只读 `quick_check`（`storage/integrity.ts`），失败只写一条 `[riffet] <库>.db failed its integrity check` 错误日志，不删不改；`riffet doctor` 的 Storage 一节另做跨库一致性（缺失的大块数据、孤儿块、没有会话的日志、derived 超前于日志）。恢复用 `riffet restore --backup <dir> --state-dir <空目录>`。
- 跨会话搜索两个字符的词（如「部署」）漏掉很久以前的消息：不足 3 个字符或含通配符的查询用不上 trigram 索引，按 `message_index_at` 索引从新到旧读，最多读 `MESSAGE_SEARCH_BUDGET.scanRows` 条（`store.ts#searchIndexedMessages`），索引超过这个行数时更早的消息搜不到，接口不告诉调用方结果被截断；按会话搜索不受限。
- 越层导入：`node scripts/check-layers.mjs --list` 按模块对列出每个越层导入及所在文件。
