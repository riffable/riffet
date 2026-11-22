---
module: server.routes
verify:
  - npx vitest run apps/server/src/routes
---

## 职责

HTTP 与 WebSocket 接口：把请求翻译成对内核服务的调用。只做协议转换、参数校验和按客户端能力过滤，不放业务规则。

## 入口

- `deps.ts#RouteDeps`：每组路由拿到的服务与共用的请求辅助；新路由从这里取依赖，不自己构造服务。
- `native.ts`、`sessions.ts`：会话创建、消息、预热与停止。
- `sync.ts`：同步协议 v3 的 SSE 与按位置、seq、回合读取（docs/SYNC-V3.md）。
- `trace.ts`：会话追踪的只读接口，按车道读日志原样的行与用量（docs/TRACE.md）。
- `terminals.ts`：终端 WebSocket 与终端附件。
- 契约在 `packages/contracts/src/`，类型与校验不在这里重写。

## 不变量

- 兼容性靠请求头 `CLIENT_FEATURES_HEADER` 的能力声明，不靠版本号。路径里带会话或项目的请求由 `apps/server/src/native/client-features.ts#registerSessionVisibilityHook` 与 `registerProjectVisibilityHook` 统一拦截；新增按 id 取资源的路由必须落在这两个前缀之下，否则旧客户端能读到它看不到的会话。唯一的例外是 `/api/file-sites/*`（`apps/server/src/auth.ts#FILE_SITE_ROUTE`）：它按路径里的令牌取文件，令牌只能经 `/api/projects/:id/file/raw?render=site` 签发，签发时已过可见性检查；预览页面发出的请求带不了能力声明，也不带 Cookie，来源检查对这条只读路由放行跨站和 `Origin: null`。
- 返回给客户端的枚举要按能力过滤：Android 与 iOS 把 Agent id 当严格枚举解码，一个插件 Agent 会让整页解码失败（`apps/server/src/native/client-features.ts#hidesPluginAgents`，监控接口与 bootstrap 都要过滤）。
- 新建会话的所有路径经 `apps/server/src/native/session-input.ts#resolveNativeSessionInput`；预热路由与创建路由必须用同一个函数，否则默认值不同使预热键对不上，预热的进程静默冷启动。
- 免令牌模式下，反向代理或 `tailscale serve` 也是从回环连入，所以还要求没有转发头且 Host 是回环名（`apps/server/src/auth.ts#proxiedRequest`）。判断「是否被转发」只用这一个函数。
- 终端 WebSocket 的积压上限只对 protocol 3 放宽到 `terminals.ts#TERMINAL_SOCKET_BUFFER_LIMIT`；超限关闭连接 1013，由客户端重连后重新种状态。`ack` 在路由里同步生效，不排在 claim、paste、resize 之后。
- 预热路由按内存压力放行，压力读数最多每 5 s 取一次，因为每个打开的页面每 30 s 都会请求（`native.ts#prewarmPressure`）。
- 停止是一个请求：活动先变 `stopping`，只有驱动证据到达才变 `stopped`（`native.ts` 的 stop 路由）。不要在路由里直接写 `stopped`。
- 重启前的暂停派发由调用方各自持有租约（`service.ts#registerServiceRoutes`），解除只撤销自己的。

## 外部行为

- 外部输入是 Web、Mac、iOS、Android 客户端的 HTTP、SSE 与 WebSocket 请求，以及带 `?features=` 的 EventSource（不能设头）。
- 契约来源是 `packages/contracts/src/`。`pnpm gen:contracts` 生成 JSON Schema 快照到 `packages/contracts/schema/released/<版本>.json`，`pnpm gen:contracts:check` 在 CI 里要求相对最新快照只增不破；破坏性变更需要 `pnpm version:bump` 后重新生成。
- 服务端忽略未知的输入字段，所以新增可选字段对旧客户端是安全的；删字段或改类型不是。
- 没有 HTTP 层的录制；用 `apps/server/src/app.test.ts` 与本目录的 `*.test.ts` 经 `app.inject` 验证。

## 排障

- 旧客户端整页报错或看不到会话：确认请求头 `CLIENT_FEATURES_HEADER`，再看 `apps/server/src/native/client-features.ts#sessionVisibleToClient`；多半是新 Agent 没进过滤。
- 令牌模式下被拒、反向代理后无法登录：`apps/server/src/auth.ts#proxiedRequest` 与 `apps/server/src/routes/auth.ts` 里的 Host 校验，错误码在响应体的 `code` 上。
- 手机换地址后找不到服务：`POST /api/devices/prove`（`apps/server/src/routes/devices.ts`），以及配对二维码里的 `hosts`（`apps/server/src/routes/auth.ts`）。
- 文件面板的 HTML 预览里样式、脚本或链接返回 401：令牌已过期（约 13 小时，页面导航时面板会自动换新）或签发它的登录已退出，重新打开文件即重新签发（`apps/server/src/auth.ts#issueFileSite`）；返回 404 先看路径是否以 `.` 开头或跳出了页面所在文件夹（`apps/server/src/workspace/index.ts#siteFile`）。
- 自动化页「最近运行」出现找不到名字的记录：`/api/automation-runs` 与 `/api/automations` 共用 `orchestration.ts` 里的 `listedAutomations` 过滤；已执行的唤醒和稍后发送不在列表里，它们的运行记录也不能返回。
- 浏览器崩溃报告：服务日志 `[riffet] browser crash report received`（`browser-diagnostics.ts`）。
- 终端交互归因：服务日志 `[riffet] native interaction` / `[riffet] native interaction failed` 记录会话、交互 id、动作、来源与设备（`native.ts`）。
- 列表更新滞后：`sessions.ts` 里 SSE 与 WebSocket 两条通道发同一组 revision，先确认客户端协商了哪条。
