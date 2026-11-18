# Riffet 能力与设备

日期：2026-11-04，2026-11-10 修订。状态：§2 Riffet MCP、按对话的工具组、会话快照与一次性唤醒已在服务端实现（R1，见 §2「实现（R1）」）；§3 设备通道已实现（R2）；T1 主屏操控与 §5 的设备侧安全规则已实现（R3，见 §3「协议（R3，T1）」、§4「实现（R3，T1）」、§5「实现（R3）」）。Web 与 Android 输入框的「技能与工具」、Web「设置 › 设备管理」、Android 无障碍引导、iOS 输入框的「技能与工具」已做；唤醒 / 操作记录的客户端展示、按 App 的知识与 skill、虚拟屏与 T2（R4）仍为设计稿。Android 真机 2026-11-10 跑通：T0 通知与剪贴板，T1 打开计算器、读屏、批量点按算出结果；系统「信息」里点发送被判为 `send`、在手机上弹确认、允许后才执行（`authorizedBy: owner`；测试机无 SIM 卡，没有实际发出）。触摸即停止、自愈重启、经电脑开启、定位与拍照尚未在真机上验证。移动端的定位与分期见 [MOBILE.md](MOBILE.md)「路线」。

Agent 会话除了读写代码，还可以调用 Riffet 自身的能力（定时唤醒、通知）和已连接设备的能力（读屏、点击、输入、打开 App、定位、拍照）。典型例子：在手机或 Web 上说“打开微信给 X 发一条消息”，同一个会话里的 Agent 操作手机完成；R4 起可以定时执行（“20 分钟后……”），那时手机多半已锁屏，需要后台屏或解锁。

## 1. 三个角色

```
入口（任意端）              大脑（服务端会话）            设备（能力提供方）
手机 / Web / Mac      →   Claude Code / Codex …   →   手机：读屏、手势、输入、传感器
定时 / 唤醒 / 触发器        经 Riffet MCP 调用           Mac：通知、剪贴板（后续）
```

- **入口**只把一句话送进某个会话。手机、Web、Mac、自动化与设备触发器地位相同。
- **大脑**始终是服务端上的 Agent。手机不运行模型与 Agent 循环。
- **设备**按能力清单接入，手机是能力最多的一台；其他设备复用同一协议。

**服务端优先**：手机只做必须在手机上发生的事——采集（屏幕、传感器）、执行（手势、输入）、本人确认（生物识别、不可逆操作）与按时唤醒自己。MCP 网关、工具定义、调用队列与审计、定时与触发规则、设备注册与预约、adb 引导、App 知识与 skill、画面转发都在服务端，所有端共用一份实现，iOS 只需实现其中的子集。

## 2. Riffet MCP

### 注入

Riffet MCP **只在每次启动 CLI 时注入**，不写入各后端的全局配置文件（`~/.claude.json` 等）。扩展管理（[EXTENSIONS.md](EXTENSIONS.md)）改的是全局配置，会影响所有会话；按次注入才能按会话区分。

- 每个会话签发独立凭据，配一个 stdio shim 转发到服务端受限路由。凭据与 shim 的做法沿用已下线的空间（提交 e1d8578，旧文档 `git show e1d8578^:docs/SPACES.md`）。
- Claude 经启动覆盖文件注入 `mcpServers`；Codex 经 config override 注入。Cursor、Droid、TRAE、DSH 逐个确认是否支持按次注入；不支持的后端显示该能力不可用，**不回落到写全局配置**。
- 空间当年用 shell CLI，Codex/TRAE 需要打开沙箱网络；MCP server 由 CLI 自己拉起，预计不受命令沙箱限制，需实测确认。

### 工具组：按对话选择

Riffet 自己的基础工具在支持按次注入的后端里**始终带上**（快速对话除外）：`read_context`（会话引用）、`schedule_wakeup` / `cancel_wakeup` / `list_wakeups`、`schedule_task`、`notify_user`、`list_devices`（只列本对话可用的设备）。它们很小，不让用户选。

插件也可以提供工具组（`<pluginId>/<name>`，如浏览器 `riffet.browser/browser`，见 [BROWSER.md](BROWSER.md) §2）：同样在「技能与工具」里按对话勾选，排在设备之前；插件关闭时已选的组保留在快照里但不注入，调用得 `TOOL_NOT_AVAILABLE`。

设备同样**每个对话自己选**，在输入框的「技能与工具」里勾「控制 <设备名>」（工具组 `device:<设备>`，能力见 §4）。只列出在线且设备侧已允许被操作的设备；已选上但离线的仍列出并标「离线」，以便取消。新对话沿用上次的选择，但只带上此刻在线的那些。一台都没有、对话里也没选过时，这个入口不出现。想让它不出现，就在手机上关掉「允许 Agent 操作这台设备」，或在「设置 › 设备管理」里移除那台设备。2026-11-10 起；此前的按端配置与 `riffet.core` 组已删除（旧客户端发来的 `riffet.core` 直接忽略）。

- 没勾设备就没有设备工具，不占上下文。
- 「技能与工具」是通用入口：用户自己装的 MCP 与 skill 按对话开关也放在这里（会话字段 `extensionsOff`，见 [EXTENSIONS.md](EXTENSIONS.md)「按对话开关 MCP 与 Skill」）。
- 开启的组控制体积：手机操控收敛到约 8 个工具加一个批量工具，详细用法放进 skill 由 Agent 按需读取。不依赖各 CLI 是否延迟加载 MCP 工具定义。
- 工具列表保持稳定：设备上下线不改工具清单，用 `device` 参数寻址；设备离线时在截止前等待重连，到期返回 `DEVICE_UNREACHABLE`。这样也不打乱 CLI 的提示缓存，不依赖 `list_changed`。

### 会话快照

1. 新对话的初始选择沿用这台客户端上一次的选择（存在本机）；创建请求带上选择，写入会话（`toolGroups`）。
2. 之后从其他端继续该会话沿用快照：CLI 启动时才加载 MCP，中途变更需要重启，也会打乱提示缓存。
3. 没有端的入口（定时唤醒、设备触发器）继承所属会话的快照。
4. 已有会话在「技能与工具」里改动，下次启动 CLI 时生效。

### 两层开关

| 开关 | 管什么 | 位置 |
| --- | --- | --- |
| 对话侧：带哪些设备 | 上下文成本，Agent 是否知道这台设备 | 输入框「技能与工具」，写入会话快照 |
| 设备侧：允许被操控 | 安全，这台设备能否被任何会话调用 | 设备本机，开启需生物识别 |

设备侧开关不能挪到服务端或 Web：本机的 Agent 有 shell，能改服务端的任何设置，只有设备上的开关它碰不到。

两者都开才生效。只开会话侧时调用返回 `DEVICE_NOT_ALLOWED`。

### 一次性唤醒

现有自动化是 cron + 模板（[ORCHESTRATION.md](ORCHESTRATION.md) §5），不能表达“20 分钟后在这个会话里继续”。`schedule_wakeup` 补的是一次性、绑定当前会话的唤醒：到点在同一会话发起新回合，带上创建时的说明；会话已归档或已交接则记为失败并通知。复用现有调度器的“先记账再派发、同一时间点最多一次”规则。

### 实现（R1）

**模块**

| 文件 | 作用 |
| --- | --- |
| `apps/server/src/riffet-mcp/credentials.ts` | 每会话凭据。文件 `<stateDir>/riffet-mcp/<sessionId>/credential.json`（0600，目录 0700）含服务地址、凭据与会话 ID，服务端只在设置表 `riffet-mcp:credentials` 存哈希。每次监听时重写地址；归档即作废并删除文件，启动时清掉会话已不存在或已归档的凭据。每个支持的会话都有凭据，因为基础工具始终带上 |
| `apps/server/src/riffet-mcp/riffet-mcp.mjs` | stdio shim，构建时拷到 `dist/riffet-mcp.mjs`。本地应答 `initialize` / `ping`，把 `tools/list`、`tools/call` 转发到 `POST /api/riffet-mcp`；每次请求重读凭据文件，服务重启换端口后 CLI 不用重启。只在连接被拒时重试 `tools/call`，避免重复执行 |
| `apps/server/src/riffet-mcp/service.ts` | 受限路由：凭据→会话，只按该会话的 `toolGroups` 列出和执行工具 |
| `apps/server/src/riffet-mcp/groups.ts` | 工具组校验 |
| `apps/server/src/riffet-mcp/notices.ts` | `notify_user` 的通知记录与推送 |
| `apps/server/src/orchestration/service.ts` | 一次性唤醒，与 cron 自动化共用调度器 |

**契约与接口**

- `ToolGroupId` 实际只用 `device:<id>`（`riffet.core` 已退役，服务端收到即丢弃）。2026-11-10 删除了按端默认（`AppSettings.riffetTools.byClient`）。
- `Session.toolGroups?: ToolGroupId[]`：`resolveNativeSessionInput` 只从创建请求的 `toolGroups` 取（输入框的选择，缺省或空数组即不带），写入会话（不计入 `creationFingerprint`）。已撤销的设备在创建时直接去掉、不报错：创建请求会从 outbox 重放，不能因此丢掉第一条消息。服务端内部的创建不认这个字段。分叉、交接继承来源会话；模板、自动化、并行尝试没有端，不带工具；快速对话不带。
- `PATCH /api/sessions/:id { toolGroups }`：按会话覆盖，下次启动 CLI 时生效。去掉的设备立即拒绝调用。
- `NativeBackendCapabilities.supportsRiffetTools`：该后端能按次注入（下表）。
- `POST /api/riffet-mcp`：只供 shim。只认会话凭据，不认 cookie 与设备令牌；凭据也打不开其他接口。
- `GET /api/sessions/:id/wakeups`、`POST /api/sessions/:id/wakeups/:wakeupId/cancel`、`GET /api/sessions/:id/notices`。

**基础工具**（始终带上）

| 工具 | 说明 |
| --- | --- |
| `schedule_wakeup({at \| inMinutes, note})` | `at` 须带时区；`inMinutes` 0.5–43200；最远 30 天，每会话最多 20 个待触发 |
| `cancel_wakeup({id})`、`list_wakeups()` | 只作用于本会话的唤醒 |
| `notify_user({title?, body})` | `body` 最多 2000 字 |
| `list_devices()` | 本会话快照里仍配对的设备的 `DeviceInfo`（§3）；没选设备时为空 |

不做 `ask_user`：普通提问用各 CLI 自带的提问工具，已走 Riffet 的等待确认、通知与通知内回答；定时执行前的授权由 `device_authorize` 在手机上确认（§3「协议（R3，T1）」）。

**一次性唤醒**：`RiffetWakeup {id, sessionId, dueAt, note, createdAt, status: pending | fired | cancelled | failed | missed, firedAt?, runId?, error?}` 是 agent 后续（`Automation.followUp.by = 'agent'`，id 即唤醒 id，存在 SQLite `automations` 表，docs/ORCHESTRATION.md §5）的视图：待运行为 `pending`，成功为 `fired`，被取消为 `cancelled`（未运行过就停用），会话不可用等为 `failed`。调度器除 30 秒一次的检查外，按最近的到期时间另设定时器。到期先写下一次时间（后续随即停用）再发送，回合的 `commandId` 为 `wakeup-<id>`，即使重试也只有一个回合。会话忙时与输入框发送相同，排在当前回合之后。会话已归档或已交接记为 `failed`，错过超过 1 小时记为 `missed`，二者都写一条 `source: 'wakeup'` 的通知。已结束的唤醒保留 7 天。

**通知事件**：`/api/lists/stream` 增加 SSE 事件 `event: notice`，`data` 为 `RiffetNotice {id, sessionId, title?, body, createdAt, source: 'agent' | 'wakeup'}`，按会话可见性过滤；只监听 `changed` 的旧客户端不受影响。服务端保留最近 200 条。客户端展示是后续任务。

**按次注入**（均不写各后端的全局或项目配置）

| 后端 | 方式 | 验证 |
| --- | --- | --- |
| Claude Code | 启动临时目录里的 `mcp.json`，以 `--mcp-config` 传入；`--settings` 覆盖文件加 `permissions.allow: ["mcp__riffet"]`，Riffet 工具不逐次确认 | 2.1.302 真实回合 |
| Codex | `thread/start` / `thread/resume` 的 `config["mcp_servers.riffet"]`。点号键只加这一项，不替换用户已有的 MCP；附 `default_tools_approval_mode: "approve"`、`omit_tools_from: ["deferred"]`、`startup_readiness: "catalog"` | 0.160.0 真实回合 |
| TRAE CLI | 同 Codex | 0.213.1：线程内 MCP 启动为 `ready`，未跑完整回合（需登录 TRAE） |
| Droid | 进程级 `--settings` 文件加 `mcp.mcpServers`（`droid.add_mcp_server` 会写 `~/.factory/mcp.json`，不用） | 0.249.0 `--list-tools` 列出；调用仍走 Droid 自己的工具确认 |
| Pi | 生成 `-e` 扩展，调用 `pi.registerMcpServer`（只对该进程有效） | 1.4.0 RPC 模式下 MCP 进程被拉起并收到 `tools/list` |
| Cursor | 不支持：只有共享的 `--plugin-dir`，预热终端启动时还不知道会话；不回落到 `~/.cursor/mcp.json` | — |
| DSH | 不支持：需要 bridge 在 `agents.create/resume` 的 `setup` 里挂载 `@deepseek-ai/dsh-mcp-client`，本轮未改 bridge | — |

Codex 的两条实测结论：

- **沙箱**：MCP server 由 app-server 自己拉起，不在命令沙箱内。`read-only` 沙箱的会话里 shim 能正常访问本机服务，同一端口用 `codex sandbox -- curl` 访问被拦截（`Couldn't connect to server`）。因此不需要像空间那样为会话打开 `networkAccess`。
- **工具延迟加载**：模型目录声明 `supports_search_tool` 时，Codex 把 MCP 工具只放进 `tool_search`。某些网关的模型目录就是这样声明的，但模型拿不到 `tool_search`，结果看不到任何 Riffet 工具。`omit_tools_from: ["deferred"]` 让这几个工具直接列出。

**安全边界**：凭据文件在用户自己的状态目录里，本机同一用户的 shell 能读到其他会话的凭据文件。和空间一样，这是能力边界，不是沙箱。

## 3. 设备通道

- **设备记录**：`DeviceRecord` 现在只有 `{id, name, hash, createdAt, lastSeenAt}`，增加平台、能力清单、在线状态与权限档位。iOS 设备另存 APNs 注册（见「后台推送」）。
- **调用队列**：调用先落盘，`callId` 幂等，带截止时间；重试返回第一次的结果。
- **定向下发**：设备开一条自己的事件流（拟定 `/api/devices/me/stream`），结果用 HTTP 回传。会话的 SSE 保持只读广播，不改。
- **预约唤醒**：没有 FCM 时，后台手机只有前台服务常驻才收得到请求。凡是能预知“T 时刻要用设备 X”的调用（`schedule_wakeup`、自动化），服务端提前把预约下发到设备；设备用 `setExactAndAllowWhileIdle` 设闹钟，T−60s 拉起前台服务并连上。临时调用仍要求设备当时在线，因此保活是前提（MOBILE.md「路线」R0）。

### 协议（R2）

服务端与设备两侧按此实现；字段名以 `packages/contracts` 为准，Kotlin DTO 与之对齐。

**设备自报**：`PUT /api/devices/me`（只认设备令牌，`Authorization: Bearer wkn_…`）`DeviceReport {platform: 'android'|'ios'|'mac', appVersion, capabilities: DeviceCapability[], allowControl: boolean}`，返回本机的 `DeviceInfo`。每次连上设备流前发送一次，能力或开关变化时再发。服务端合并进 `DeviceRecord`（存 `devices.json`），不认识的能力 id 丢弃。`GET /api/devices` 返回 `{devices: DeviceInfo[]}`，`DeviceInfo {id, name, platform?, appVersion?, createdAt, lastSeenAt?, online, capabilities, allowControl}`；从未自报的设备（含配对的浏览器）`capabilities: []`、`allowControl: false`。

**能力 id**（`DeviceCapability`）：T0 为 `notify`、`clipboard.read`、`clipboard.write`、`location`、`photo`、`open_url`、`alarm`；T1 起追加 `screen.observe`、`screen.act`、`app.launch`。设备只上报本机当前真正可用的能力（权限已授予、系统支持）。

**设备流**：`GET /api/devices/me/stream`（SSE，只认设备令牌）。连接即在线，断开即离线；撤销设备时立即断开。每个事件都带 `data`（JSON）：

| 事件 | data | 说明 |
| --- | --- | --- |
| `call` | `DeviceCall {callId, sessionId, capability, args, deadline, createdAt}` | 连上时先重放所有未完成、未过期的调用；同一 `callId` 可能重复到达，设备按 `callId` 去重 |
| `cancel` | `{callId}` | 调用已超时或被撤销 |
| `lease` | `DeviceLease {id, sessionId, at, reason}` | 预约：设备在 `at` 前约 60 秒拉起前台服务并连上；连上时重放未来的预约。`id` 即唤醒 id |
| `lease-cancel` | `{id}` | 预约已取消或已触发 |
| `ping` | `{}` | 15 秒心跳 |

**调用参数与结果**（`args` / `result` 都是 JSON 对象）：

| 能力 | `args` | `result` |
| --- | --- | --- |
| `notify` | `{title?, body}` | `{}` |
| `clipboard.read` | `{}` | `{text?}`，剪贴板为空或不是文本时省略 |
| `clipboard.write` | `{text}` | `{}` |
| `location` | `{}` | `{latitude, longitude, accuracyMeters?, capturedAt?}` |
| `photo` | `{source?: 'camera' \| 'gallery'}`，缺省 `camera` | `{fileIds: string[]}` |
| `open_url` | `{url}` | `{}` |
| `alarm` | `{hour: 0–23, minute: 0–59, label?}` | `{}` |

**回传**：`POST /api/devices/me/calls/:callId/result`，body `DeviceCallOutcome = {ok: true, result} | {ok: false, code, message?}`，返回 `DeviceCallReceipt {callId, outcome, receivedAt}`。按 `callId` 幂等：重复回传返回第一次的回执。其他设备的调用或不存在的调用返回 404 `DEVICE_CALL_NOT_FOUND`；已超时或已撤销的返回 409 `DEVICE_CALL_CLOSED`，设备丢弃即可。文件类结果（照片）先 `POST /api/devices/me/calls/:callId/files` 上传，body 与 `POST /api/attachments` 相同 `{name, mimeType, dataBase64, width?, height?}`（单个最大 24 MB，每次调用最多 10 个），返回 `DeviceFile {fileId, name, mimeType, size}`，再在 `result.fileIds` 里引用。服务端把文件存为附件（会话的 Agent 可按路径读取），MCP 结果给出路径和缩小后的图片内容块。

**MCP 工具**：会话快照含任一 `device:<id>` 组时注入；`device` 参数取值限定为快照里仍存在的设备，只有一台时可省略。工具名稳定，按能力映射：`device_notify`、`device_clipboard_read`、`device_clipboard_write`、`device_location`、`device_take_photo`、`device_open_url`、`device_set_alarm`；T1 起追加 `device_observe`、`device_act`、`device_launch_app`。工具清单不随设备上下线或能力变化而变。

**等待与错误码**：调用默认等待 30 秒（拍照默认 120 秒）；工具可传 `timeoutSeconds`，上限 120，拍照上限 300。设备离线时在截止前等待重连，到期返回 `DEVICE_UNREACHABLE`。其余：`DEVICE_NOT_ALLOWED`（设备最后上报的 `allowControl` 不是 `true`，或会话快照不含该设备）、`DEVICE_CAPABILITY_MISSING`（设备最后上报的能力不含此项）、`DEVICE_TIMEOUT`（调用已送达设备但未在截止前回传）、`DEVICE_DENIED`（用户在设备上拒绝）、`DEVICE_FAILED`（设备尝试过但做不到：参数不合法、取不到定位、没有能处理的 App，`message` 说明原因）。设备回传的 `code` 原样交给 Agent；设备侧只用上述 `DEVICE_*` 码。

**预约的来源**：`schedule_wakeup` 所在会话的快照含 `device:<id>` 组时，为这些设备各下发一个预约，唤醒取消或触发后撤销。自动化的预约在 R5 处理。

**设备侧开关**：「允许被调用」以设备本机为准，开启需本人验证；关闭时设备拒绝一切调用并上报 `allowControl: false`。服务端的 `allowControl` 只用于提前报错与界面显示，不替代设备侧判断。

### 实现（R2）

**模块**

| 文件 | 作用 |
| --- | --- |
| `apps/server/src/auth.ts` | `DeviceRecord` 合并 `DeviceReport`，存 `devices.json`；`reportDevice`、`device(id)`、`onDeviceRevoked` |
| `apps/server/src/riffet-mcp/devices.ts` | `DeviceChannel`：在线状态、调用队列、回传与文件、由唤醒推导的预约 |
| `apps/server/src/routes/devices.ts` | `PUT /api/devices/me`、`GET /api/devices/me/stream`、`POST /api/devices/me/calls/:callId/{result,files}`，只认设备令牌（Cookie 返回 403 `DEVICE_TOKEN_REQUIRED`） |
| `apps/server/src/riffet-mcp/service.ts` | `device_*` 工具与结果格式（含图片内容块） |
| `packages/contracts/src/index.ts`、`schema/devices.ts` | `Device*` 类型与 zod 契约，`pnpm gen:contracts` 生成快照与夹具 |

**调用队列**：存在设置表 `riffet-mcp:device-calls`，`{…DeviceCall, deviceId, status: pending | answered | expired | cancelled, deliveredAt?, fileIds?, receipt?, error?}`。先写入再下发；服务启动时为未结束的调用重新设截止定时器，重启后设备连上照样收到重放，结果没人等就只留记录。截止时写过 `deliveredAt` 的记 `DEVICE_TIMEOUT`，否则 `DEVICE_UNREACHABLE`，两者都给设备流发 `cancel`。Agent 的请求中断（shim 连接断开）时调用记为 `cancelled` 并发 `cancel`。撤销设备时它的待处理调用立即以 `DEVICE_UNREACHABLE` 结束。已结束的保留 24 小时、最多 500 条。

**预约**：不另存，由待触发的唤醒推导：会话未归档、快照含 `device:<id>`、`dueAt` 在未来。调度器在唤醒创建与离开 `pending`（取消、触发、失败、错过）时通知 `DeviceChannel`，后者向快照里的设备发 `lease` / `lease-cancel`。会话中途改了工具组不补发撤销，设备到点连上即可。

**工具组**：`PATCH /api/sessions/:id` 拒绝未配对的 `device:<id>`（400 `UNKNOWN_DEVICE`）。会话快照里已撤销的设备不再列入 `device` 枚举，一台都不剩时不注入设备工具。

**等待**：shim 对 `tools/call` 改用 `node:http`、单次 330 秒（`fetch` 等响应头最多 300 秒）；Codex/TRAE 注入 `tool_timeout_sec: 330`（默认 60 秒）。Claude Code 的 MCP 调用默认不在这个量级超时。Droid、Pi 的 MCP 调用超时未确认。

**文件**：上传存为普通附件（`<stateDir>/attachments`，与输入框附件同一套校验与 30 天清理），MCP 结果给出带原文件名的副本路径（`attachments/materialized/<id>/<name>`）；图片另用 sharp 缩到长边 1024 的 JPEG 作为 `image` 内容块，解码失败时原图不超过 1 MB 才附上。

### 后台推送（iOS，APNs 直连）

iOS 会挂起后台 App，设备流和前台服务都靠不住。Riffet 发布官方 iOS App（bundle `io.github.riffable.iphone`，一个 Apple 团队），**不设中继**：服务端的主人持有该团队的 APNs 密钥（`.p8`）时，服务端直接向 Apple 推送；没有密钥的服务端不推送，iOS 照旧只在前台发本地通知。自己签名的 App 同理，设备把自己的 bundle id 报作 topic，主人放自己团队的密钥。载荷只发给 Apple，不另加密。Android 不变：没有 FCM，仍是前台服务与设备流。

**密钥**：`GET /api/settings/push` 返回 `PushKeyStatus {configured, keyId?, teamId?, status?: 'ok' | 'invalid', detail?}`；`PUT` `{keyId, teamId, key}`（`key` 为 `.p8` 文本，须是 P-256 私钥，400 `INVALID_PUSH_KEY`）；`DELETE` 移除。存于 `<stateDir>/apns-key.json`（0600），任何接口都不返回、日志不记。APNs 以 `InvalidProviderToken` 等拒绝时状态记为 `invalid`，换密钥后清除。Web 在「设置 › 设备管理 › 推送」配置。

**设备注册**：`DeviceReport.push = DevicePushRegistration {token, topic, environment: 'production' | 'sandbox', activityStartToken?, activityToken?}`；省略表示不变，`null` 表示注销。同一 APNs 令牌只归最新上报的那条设备记录。注册存在 `devices.json`，不出现在任何接口里。`DeviceInfo.push = DevicePushRoute {route: 'direct' | 'none', reason?: 'no_key' | 'no_token' | 'failed', detail?}`，iOS 设备与已注册的设备才有；`failed` 是重试后仍失败的最后一次原因，下次成功即清除。

**发送**：`node:http2` 连 `api.push.apple.com` / `api.sandbox.push.apple.com`（按设备的 `environment`），ES256 JWT 提供方令牌（50 分钟内复用），头部 `apns-topic`（活动为 `<topic>.push-type.liveactivity`）、`apns-push-type`、`apns-priority`、`apns-collapse-id`、`apns-expiration`。网络错误、429、5xx 在 1 秒、4 秒后各重试一次；410、`BadDeviceToken`、`Unregistered` 时清掉该令牌（仅当设备仍持有同一令牌；设备令牌失效则整条注册清除）。载荷超过 4 KB 时截短正文。

**提醒规则**：服务端移植客户端的 `sessionAlerts`：状态**变为** `waiting`、`failed`、运行后 `interrupted`、运行后 `idle`（完成）才提醒，第一次看到不提醒，同一状态重复写入不再提醒。

| 类型 | 时机 | category | 按钮所需 |
| --- | --- | --- | --- |
| 等待确认 | 立即，`interruption-level: time-sensitive` | `riffet.permission`（`riffet.allow` / `riffet.deny`）、`riffet.plan`（`riffet.approve`）、`riffet.question.reply`（`riffet.reply`，单个可填文本的问题）、其余 `riffet.question`（只能打开） | `interactionId`、`revision`、`interactionKind`、`answers` |
| 完成 / 失败 / 中断 | 60 秒后；届时已读（`seenActivityAt ≥ lastActivityAt`）、状态已变或已归档则不发 | 完成为 `riffet.finished`（`riffet.reply` 发下一条消息） | 完成带 `configRevision` |

载荷顶层（即 `userInfo`）：`server`（`/health` 的 `serverId`，存于 `<stateDir>/server-id`，重启不变）、`sessionId`、`kind`（`waiting` / `finished` / `failed` / `interrupted`）及上表字段。`answers` 以按钮 id 为键，值为 `{action, selectedIds?, text?: true}`：设备补上自己的 `requestId` 提交 `POST /api/sessions/:id/native/interaction`，`text` 表示把输入的文字作为 `otherText`。完成的回复走 `POST /api/sessions/:id/native/send {commandId, text, expectedConfigRevision}`。`thread-id` 为会话 id，`apns-collapse-id` 为 `<sessionId>:<kind>`。标题为会话标题、副标题为项目名；没有正文时用 `loc-key: push.<kind>` 由 App 本地化。设备流开着的设备（在前台）不推送提醒，由它自己发本地通知。对话框在别处答复、会话被读过后不撤回已发的推送（v1 不做撤回推送）。

**实时活动**：每台设备一个摘要活动，`content-state` 只有 `{waiting, running, unseen}`（`needsYou`、`isRunningSession`、`isDoneUnseen`，不含标题）。计数由全零变为非零且设备有 `activityStartToken`、没有在用的 `activityToken` 时推 `event: start`（`attributes-type: RiffetSummaryAttributes`，`attributes: {}`）；之后计数变化向 `activityToken` 推 `event: update`（同一设备至少间隔 5 秒，带 `timestamp`）；全零持续 10 分钟推 `event: end`（`dismissal-date` 为当时）。结束过的 `activityToken` 不再更新，下一次由全零变为非零时重新 push-to-start。

| 文件 | 作用 |
| --- | --- |
| `apps/server/src/push/apns.ts` | 密钥存取与校验、JWT、HTTP/2 发送、重试与载荷截短 |
| `apps/server/src/push/service.ts` | 状态转换、提醒载荷与按钮映射、延迟发送、实时活动、`DevicePushRoute` |
| `apps/server/src/push/routes.ts` | `/api/settings/push` |
| `apps/server/src/server-id.ts` | 持久的 `serverId` |

### 协议（R3，T1）

T1 只操作主屏（虚拟屏是 R4）。设备在无障碍服务已开启、且「允许被调用」开着时才上报 `screen.observe`、`screen.act`、`app.launch`。

**观察**（`screen.observe`）

| `args` | `result` |
| --- | --- |
| `{since?: snapshotId, includeScreenshot?: boolean}` | `{untrusted: true, snapshotId, package?, app?, keyboard?, secure?, blocked?, windows?: Window[], base?, diff?: {added: Node[], changed: Node[], removed: ref[]}, fileIds?}` |

- `Window {id, type: 'app' \| 'ime' \| 'system' \| 'overlay' \| 'other', package?, title?, active?, nodes: Node[]}`，按层级从上到下。`package` / `app` 是前台 App 的包名与显示名。
- `Node {ref: '@eN', role, text?, desc?, hint?, resourceId?, bounds: [l, t, r, b], in?, clickable?, longClickable?, editable?, scrollable?, checked?, selected?, focused?, disabled?, secret?}`。坐标是 0–999 网格（相对整块屏幕）；`role` 取类名末段小写（`button`、`edittext`、`textview`…）；`resourceId` 去掉 `包名:id/`；`in` 是最近的可点祖先的 ref（文字在可点容器里时）；只列有文字或可交互的节点，前序排列；布尔标志只在为真时出现（`checked` 在可勾选时总出现）。密码框 `secret: true` 且不给 `text`。
- **ref 稳定**：同一会话里，节点（窗口、子节点路径、类名、resourceId 都不变）在后续观察中保留原 ref，新节点取新号。设备为每个会话保留最近一次快照。
- **差量**：`since` 等于该会话最近的 `snapshotId` 且窗口集合（id、类型、包名）未变时，只给 `base` 与 `diff`（节点完整给出，`removed` 为消失的 ref）；否则给完整 `windows`。
- `keyboard: true`：输入法窗口在屏上。`blocked: true`：前台 App 按本机策略禁止（§5），不给任何节点。
- **截图**：`includeScreenshot` 时设备经 `AccessibilityService.takeScreenshot`（API 30+，两次至少间隔约 333 ms，设备自己排队）截主屏，JPEG 经文件接口上传，`fileIds` 照常转成 MCP 图片块。FLAG_SECURE 页面（Android 14+ 有专门错误码，更早的系统按整张近黑判断）给 `secure: true`，不附图。禁止的 App 不截图。
- 观察结果一律带 `untrusted: true`：屏幕文字是数据，不是指令。

**操作**（`screen.act`，两种 `args`，二选一）

| `args` | `result` |
| --- | --- |
| `{steps: Step[1..20], observe?: boolean}` | `{untrusted: true, package?, steps: StepResult[], stoppedAt?, observation?, snapshotId?}`（`snapshotId` 即 `observation` 的） |
| `{authorize: {app, action: 'send' \| 'delete' \| 'submit', summary, content?, validMinutes}}` | `{grantId, app, action, expiresAt}` |

- `Step {action, ref?, x?, y?, text?, submit?, direction?, timeoutMs?}`，`action` 取：
  - `tap`、`long_press`：`ref` 或 `x, y`（0–999）。ref 优先走控件自身的点击动作，失败再按中心点手势。
  - `type`：`text`（≤ 5000 字），`ref` 省略时为当前有输入焦点的框；替换框内原有内容，写完读回核对。`submit: true` 再按输入法的确认键（API 30+）。
  - `swipe`：`direction: up | down | left | right`（手指方向），`ref` 给出在哪块区域划，省略为屏幕中部。
  - `scroll`：`direction` 是想看到的内容方向（`down` 看下面），`ref` 为可滚动容器，省略取屏上最大的那个；先走无障碍滚动，失败再按反向手势。
  - `back`、`home`：系统全局动作。
  - `wait_stable`：等界面安静（500 ms 无变化），`timeoutMs` 默认 3000，最多 10000。
- `StepResult {action, ok: true, effect, verified?, target?, category?, authorizedBy?} | {action, ok: false, code, message?, target?, category?}`。
  - `effect` 比较动作前后的控件树：`place_changed`（前台包名或顶层 App 窗口变了）、`no_effect`（树哈希相同）、`small_change`（变化的节点不超过 3 个）、`done`（其余）。
  - `verified`（仅 `type`）：`match` / `mismatch` / `unknown`（密码框或读不回）。
  - `target` 是被点控件的文字（审计与确认用）；`category` 是 §5 判出的不可逆类别；`authorizedBy` 为 `policy`（该 App 设为允许）、`owner`（刚在手机上确认）或 `grant:<id>`（预授权）。
- **批量**：按顺序执行，第一个失败即停，`stoppedAt` 为其序号（从 0 起，即 `steps` 里最后一项），后面的不执行。每步之后等界面安静（最多 1.5 秒）再读树。`observe: true` 时 `observation` 是执行后相对执行前的观察（规则同上）。
- **预授权**：`authorize` 立即在手机上请求确认（与不可逆确认同一张确认页，开启「确认操作前验证本人」时要生物识别）。`app` 为包名，`validMinutes` 1–1440，`content` 可选（给了就按内容哈希匹配）。结果的 `grantId` 只是记录；之后同一包名、同一类别、内容哈希一致（若给了）、在有效期内的不可逆步骤直接放行，默认用一次即作废。拒绝为 `DEVICE_DENIED`。

**打开 App**（`app.launch`）

| `args` | `result` |
| --- | --- |
| `{package?, name?}`（给一个；`name` 按显示名匹配） | `{package, app, foreground: boolean}` |
| `{list: true, query?}` | `{apps: [{package, app, blocked?}]}` |

打开后等目标 App 到前台（最多 5 秒）再等界面安静；`foreground` 表示是否已到前台。禁止的 App 返回 `DEVICE_NOT_ALLOWED`。

**新增错误码**：`DEVICE_LOCKED`（锁屏或屏幕关闭，请用户解锁）、`DEVICE_HANDOFF_REQUIRED`（付款等必须由本人完成，设备已发通知把屏幕交给用户）、`DEVICE_STOPPED`（用户按了急停，60 秒内拒绝操作）。前置检查（锁屏、急停、无障碍未开）失败时整个调用返回 `{ok: false, code}`；单步失败（拒绝、交接、禁止、ref 不在屏上等）写在 `StepResult` 里，调用本身 `ok: true`，MCP 结果标为错误。

**MCP 工具**（会话快照里有 Android 设备、或上报了任一 T1 能力的设备时注入，与能力是否开启无关，工具清单因此稳定）：

| 工具 | 能力 | 默认 / 最长等待 |
| --- | --- | --- |
| `device_observe({since?, includeScreenshot?})` | `screen.observe` | 30 / 120 秒 |
| `device_act({steps, observe?})` | `screen.act` | 90 / 300 秒（可能等本人确认） |
| `device_authorize({app, action, summary, content?, validMinutes})` | `screen.act` | 120 / 300 秒 |
| `device_launch_app({package?, name?})` | `app.launch` | 30 / 120 秒 |
| `device_list_apps({query?})` | `app.launch` | 30 / 120 秒 |
| `device_help({topic?})` | — | 不访问设备，返回操控指南 |

服务端只把每个工具声明过的字段转给设备（`steps` 里也只认上表字段），Agent 塞进的其他字段一律丢弃；`authorize.action` 不接受 `pay`。

**审计**：每次进入调用队列的 `screen.act` / `app.launch`（不含列表；参数校验或前置检查就被拒的不算）调用结束，服务端写一条 `RiffetDeviceAction {id, sessionId, deviceId, createdAt, kind: 'act' | 'launch' | 'authorize', package?, steps: [{action, target?, effect?, code?}], category?, authorizedBy?, ok, code?}`，存设置表 `riffet-mcp:device-actions`（最近 500 条），`GET /api/sessions/:id/device-actions` 按时间倒序返回。时间线与 Web 的展示是后续任务。

### 实现（R3，服务端）

- `apps/server/src/riffet-mcp/screen.ts`：T1 工具表（参数白名单与校验、等待时长）、`device_help` 的指南（`observe` / `steps` / `flow` / `errors`）、`stoppedLine`。`service.ts` 只负责注入与调用：快照里的设备按 `isScreenDevice`（平台 `android` 或带 T1 能力）判断是否列出 T1 工具；`device` 枚举与 T0 工具相同。
- 结果：T1 工具的 JSON 不缩进（控件树大、读得频繁），`untrusted` 原样保留；`screen.act` 结果带 `stoppedAt` 时 `isError: true`，首行是失败步骤的 `CODE: message`。截图沿用 `fileIds` → 路径 + 图片块。
- `apps/server/src/riffet-mcp/audit.ts`：`DeviceAuditLog`，由 `DeviceChannel` 构造（`devices.audit`）。`steps` 取设备回传的 `StepResult`（`action`、`target`、`effect`、失败步的 `code`）；没有回传时只列请求的 `action`。`category` / `authorizedBy` 取第一个带该字段的步骤，`authorize` 的 `category` 为其 `action`；`ok` 为调用成功且未中途停止，`code` 依次取未回传的错误、设备的 `code`、失败步的 `code`。
- `GET /api/sessions/:id/device-actions` 在 `routes/devices.ts`，与 `/notices` 一样走普通登录，不在设备令牌路由之下。契约 `RiffetDeviceAction`（`packages/contracts`，已登记生成夹具）。

## 4. 设备执行端（Android）

能力按所需权限分三档，逐级叠加：

| 档位 | 权限来源 | 能力 |
| --- | --- | --- |
| T0 普通权限 | App 自身 | 通知、剪贴板、定位、拍照 / 选图回传、打开链接或 Intent、闹钟与日程 Intent、分享 |
| T1 无障碍 | AccessibilityService | 读控件树、点击 / 滑动 / 输入 / 返回、打开 App、截图（API 30+）、发送当前屏幕、悬浮胶囊 |
| T2 shell 特权 | 可插拔后端 | 精确注入输入、后台虚拟屏、在指定屏启动 App、锁屏解锁（可选）、自动补权限与省电白名单 |

T2 后端按顺序接入：

1. **服务端 adb 引导**：手机经 USB 或无线调试连到电脑时，服务端执行 `adb` 用 `app_process` 拉起辅助进程（scrcpy 推送 server 的做法）。电脑本来就在旁边，这是 Riffet 最顺的路径。
2. **Shizuku**：用户已安装时经 UserService 获得 shell 身份。
3. **App 内无线调试配对**：参照 Mika 的 `core/adb` 与 libadb-android，不需要电脑。

后台虚拟屏只在 Android 14+ 且系统允许 TRUSTED + `OWN_FOCUS` 时启用，否则退回主屏执行。

### 实现（R3，T1）

- **服务**：`RiffetAccessibilityService`（清单声明，配置 `res/xml/accessibility_service.xml`：`typeAllMask`、`flagRetrieveInteractiveWindows | flagReportViewIds | flagIncludeNotImportantViews`、可做手势、可截图）只提供读窗口、手势、截图，事件只用来记「屏幕最后一次变化」的时刻。服务连上或断开时设置页与上报跟着刷新；T1 能力只在服务已连上且「允许被调用」开着时上报。
- **唯一入口**：`ScreenActionGate`（androidApp）是读屏和操作的唯一调用方，前面是 `DeviceGate`（本机开关、能力、急停、锁屏）。纯规则在 client commonMain：`DeviceScreen.kt`（节点展平、稳定 ref、差量、effect）、`DeviceSafety.kt`（风险词表、预授权、按 App 策略、急停）。
- **读屏**：`getWindows()` 只含主屏窗口，按层级从上到下；节点上限 4000、深度 80；只列有文字或可交互的节点。会话的 ref 表与最近一次发给 Agent 的快照在内存里（最多 8 个会话），进程重启后从完整观察重来。
- **动作**：ref 走控件或最近可点祖先的 `ACTION_CLICK` / `ACTION_LONG_CLICK`，失败按中心点手势；坐标直接手势。`type` 先聚焦再 `ACTION_SET_TEXT`，不行就经剪贴板粘贴，150 ms 后 `refresh()` 读回。`submit` 用 `ACTION_IME_ENTER`（API 30+）。`scroll` 先用方向滚动动作，再退到反向手势。每步后先等 120 ms，再等 300 ms 无事件（最多 1.5 秒）。
- **ref 过期**：ref 指向的节点文字与 Agent 上次看到的不同（列表复用了这一格），该步失败并要求重新观察；输入框不比文字。
- **打开 App**：经已绑定的无障碍服务启动（Android 允许它从后台启动 Activity），清单 `<queries>` 声明 LAUNCHER 以列出 App。

### 无障碍引导（2026-11-10）

手动开启是主路径，不要求连电脑；电脑只是可选的快捷方式。参考 GKD（手动开启 + `WRITE_SECURE_SETTINGS` 自启）与 Mika（先 adb、再由 App 自己开无障碍）。Shizuku 不做：用户身边已有装着服务端的 Mac，多装一个 App、每次重启后再启动它不划算。

- **状态**：`OFF`、`RESTRICTED`（Android 13+ 受限设置：`access_restricted_settings` 不是 `ALLOWED`，且安装来源是本地文件或下载文件）、`NOT_RUNNING`（已在系统列表里但服务没连上，多半被系统杀掉）、`RUNNING`。另记是否持有 `WRITE_SECURE_SETTINGS`。监听 `ENABLED_ACCESSIBILITY_SERVICES`，状态随系统设置自动刷新。
- **手动**：受限时先到应用信息「允许受限制的设置」（ColorOS 上找不到时，用系统文件管理器重新安装一次），再到无障碍详情打开 Riffet；回到 App 自动重新检测。
- **通过电脑**：服务端检测到这台手机经 adb 连着（读手机写在 `Android/data/<包名>/files/riffet-installation-id` 的安装 ID 比对，不按型号猜）时才出现。服务端只执行两条固定命令：`pm grant <包名> android.permission.WRITE_SECURE_SETTINGS` 与 `appops set <包名> ACCESS_RESTRICTED_SETTINGS allow`（后者不支持时跳过）。之后 App 自己写入无障碍列表并等服务连上。ColorOS「权限监控」、小米「USB 调试（安全设置）」导致的授权失败按原始错误给出对应的一句修法。接口：`GET /api/devices/me/adb`、`POST /api/devices/me/adb/grant`，只认设备令牌。
- **自愈**：持有 `WRITE_SECURE_SETTINGS` 时，读屏 / 操作 / 打开 App 的调用遇到 `NOT_RUNNING` 先自行重启服务（移除、约 1 秒后加回、最多等 2.5 秒），再执行；因此这种状态下照常上报 T1 能力。
- **安全**：adb 已授权时 Mac 本就能对手机做任何事，一键授权不扩大 Agent 的能力；服务端只认白名单里的 Riffet 包（`io.github.riffable.android`），请求里的包名不在其中直接拒绝。

### 实现（R2，T0）

- **开关与连接**：「设置 › 能力与设备 › 允许 Agent 调用这台设备」只存在本机，开启需本人验证。开启期间 `RiffetHost` 保持前台服务并持有当前服务的设备流（`DeviceChannel`，每次拨号前 `PUT /api/devices/me`，权限或开关变化时重报）；关闭时上报一次 `allowControl: false`、清掉预约。开启时从最近任务划掉 App 不再停止前台服务。
- **唯一入口**：`DeviceGate`（client commonMain）：截止时间 → 按 `callId` 去重（已回答的重放直接重发第一次的结果，记录保留 100 条/1 天）→ 本机开关 → 能力当前可用 → 执行 → 记录 → 回传（失败重试到截止后 1 分钟，4xx 放弃）。`cancel` 与截止时间取消执行。
- **能力**（`AndroidDeviceExecutor`）：`notify` 走「Agent 通知」渠道；`clipboard.write` 直接写；`clipboard.read` 只在 App 在前台且有焦点时直接读。Android 10+ 禁止后台读剪贴板、后台启动 Activity，因此后台的 `clipboard.read`、`photo`、`open_url`、`alarm` 发一条高优先级通知，点按后由透明的 `DeviceActionActivity` 完成，划掉通知即 `DEVICE_DENIED`；通知关闭时返回 `DEVICE_FAILED`。`location` 用平台 `LocationManager`（新鲜的上次定位，否则 20 秒内取一次）；没有「始终允许」时，后台只在前台服务带 `location` 类型时可用（App 在前台时启动服务才拿得到该类型），否则 `DEVICE_FAILED`。`photo` 用系统相机（`TakePicture` + FileProvider）或照片选择器（`source: 'gallery'`，不需权限），超过 4096 px 或 12 MB 时重新压缩后上传。
- **预约**：`lease` 存本机并设 `setExactAndAllowWhileIdle`（未获「闹钟和提醒」授权时退回不精确闹钟，设置页注明），`at` 前 60 秒拉起前台服务并重连；连上后到第一个 `ping` 之前没有重放的预约视为已撤销。重启与更新后（`BOOT_COMPLETED` / `MY_PACKAGE_REPLACED`）重新设定。
- **通知事件**：`/api/lists/stream` 的 `notice` 由 `RiffetNotifier` 发到「Agent 通知」渠道，点按打开会话；正在看的会话不发。

#### Riffet 外观设置

- 设备报告 `riffet.appearance` 后，已经为本会话授权的在线设备可以接收本机 Riffet 外观请求。空参数读取当前选择和可用选项，写入携带 `themeId`、`mode` 或 `interfaceStyle`。设备只写入本次指定的字段。
- Android 通过现有本机控制开关和调用去重门禁执行。已配对的 Riffet 界面挂载时提供能力，工作台切换服务器或卸载后旧连接无法改动偏好。设备回读保存值后返回结果。

### 工具与观察

- 工具粒度参照 mobile-mcp 的批量命令：动作合并进 `device_act` 的 `steps`，工具清单见 §3「协议（R3，T1）」。
- 观察以控件树为主、截图为辅（Mika 的格式）：按窗口分组，节点以 `@eN` 引用，坐标为 0–999 网格，之后只给变化部分。
- 每个动作返回 effect：`done` / `small_change` / `no_effect` / `place_changed`，并经读回核对后才算完成。
- FLAG_SECURE 页面截图为黑屏，此时交给用户接管。
- App 知识与操作 skill 下发给服务端 Agent，不注入手机端；格式参照 Mika 的 `APP.md` / `SKILL.md`。现在只有 `device_help` 的通用指南，按 App 的知识未做。

## 5. 安全

本机有 shell 的 Agent 可以绕过本地任何令牌边界，真正的边界放在设备上。

- **唯一执行入口**：所有改变外部世界的动作经 `ActionGate`：守卫 → 锁屏检查 → 风险判定与授权 → 执行 → 读回核对 → 审计。构造受限，从编译层面防止绕过。
- **风险分级**：读自动放行；可撤销的写记录在会话；不可逆（发送、删除、提交）需要授权；花钱**永远交给用户亲手完成**。
- **预授权**：定时执行时用户通常不在场。Agent 在创建唤醒时调 `device_authorize`，用户在手机上确认（生物识别）后生成授权，绑定 App、类别、内容哈希与时间窗。执行时完全匹配才放行，否则在手机上重新请求确认。
- **按 App 授权**：允许 / 每次询问 / 禁止；银行与支付类默认禁止。
- **屏幕内容不可信**：读屏结果标记为不可信数据，不可逆操作的确认只在设备上做，不由 Agent 判定。
- **急停**：通知上的停止（已做）；胶囊（R5）；主屏模式下用户触摸屏幕即停止（已做，见下「实现（R3）」）。
- **审计**：每个设备动作写一条记录（已做，文字，见 §3「实现（R3，服务端）」）；前后截图缩略图、进入会话时间线与 Web 右侧区回放未做，随 R4 的画面转发一起做。
- **锁屏解锁**需要 T2 并在本机保存 PIN，敏感度高，作为可选项默认关闭；其余情况遇锁屏通知用户解锁。

### 实现（R3）

T1 的设备侧规则，全部在手机上判定，不信任 Agent 的任何参数：

- **流程**：`DeviceGate`（截止、去重、本机开关、能力、急停、锁屏）→ `ScreenActionGate` 每步：按 App 策略 → 风险判定 → 授权（策略 / 预授权 / 本人确认 / 交接）→ 执行 → 读回与 effect → 结果里带 `target`、`category`、`authorizedBy`，服务端据此写审计。
- **锁屏**：`KeyguardManager.isKeyguardLocked` 或屏幕未亮时返回 `DEVICE_LOCKED`，并发「请先解锁」通知（每分钟最多一次）。
- **风险判定**（`RiskClassifier`，词表取自 Mika 的 `IrreversibleDetector`）：点按看控件自身文字、其内文字、resourceId 单词；弹窗里的「确定 / 确认 / OK」看同一窗口的其他文字。类别 `send`、`pay`、`delete`、`order`、`submit`；中英文词表，「待付款」「付款成功」「支付宝」这类状态和选项不算。输入框按回车（`submit: true`）除搜索框外都算 `send`。长按与滑动不判（滑动删除留待后续）。
- **授权**：`pay` 一律 `DEVICE_HANDOFF_REQUIRED` 并发通知（点开即回到该 App），App 设为允许也一样；`order` 每次都要本人确认，不可预授权、不随 App 允许放行；其余类别在 App 设为允许时直接放行（`policy`），否则先找预授权（`grant:<id>`），没有就请本人确认（`owner`）。
- **本人确认**：直接拉起 `DeviceActionActivity` 的确认页（无障碍服务已绑定，允许后台启动），同时发高优先级通知。页面显示 App、类别、读到的按钮文字，发送时显示输入框里的内容（优先刚输入的那段）；预授权另显示 Agent 的说明与有效期。开启「确认操作前验证本人」时允许前要生物识别。拒绝、划掉通知为 `DEVICE_DENIED`。确认页关闭后等原 App 回到前台，再按 ref 重新找到目标并核对文字，才执行。
- **预授权**（`DeviceGrants`）：存本机，`{包名, 类别, 内容哈希?, 到期}`，匹配一次即删；内容按去首尾空白后的 64 位 FNV-1a 比较。
- **按 App 策略**（`DeviceAppPolicies`）：允许 / 询问（默认）/ 禁止，存本机。默认禁止：支付宝、云闪付、工行、建行、农行、中行、招行、交行、邮储、京东金融、PayPal；微信支付在微信里，靠 `pay` 类别拦。禁止的 App：观察只给 `blocked: true`，不给节点、不截图，修改类步骤与打开均为 `DEVICE_NOT_ALLOWED`（返回、回桌面、等待不受限）。设置页列出被操作过的 App（最近 40 个），逐个选择。
- **急停**：`screen.act` / `app.launch` 执行期间常驻「Agent 正在操作手机」通知，带「停止」；按下后当前调用在下一处等待点中止（结果里该步为 `DEVICE_STOPPED`），之后 60 秒内的操作调用直接 `DEVICE_STOPPED`，读屏不受影响。操作期间用户触摸屏幕等同按下停止：无障碍服务放一个 1 像素浮层（`FLAG_WATCH_OUTSIDE_TOUCH`）接收屏幕上的每次触摸，Agent 自己的手势进行中（及结束后 150 ms）和用户回答确认页期间（及之后 500 ms）的触摸不算。真机待验证。
- **不可信**：观察与操作结果都带 `untrusted: true`；确认内容只取设备自己读到的文字。

## 6. 各端分工

| 端 | 入口 | 能力端 | 随身在场 |
| --- | --- | --- | --- |
| Android | 胶囊、语音、分享、磁贴、快捷方式 | T0–T2 | 通知审批、状态栏胶囊与厂商岛、生物识别 |
| iOS | AppIntents / 快捷指令、分享 | T0 子集 | Live Activities、Face ID |
| Web | 输入框 | — | 右侧常驻区显示设备实时画面、操作记录与待确认项 |
| Mac | 菜单栏、全局快捷键 | 后续可提供 AX 操控与通知 | 原生通知 |

## 7. 约束与风险

| 约束 | 处理 |
| --- | --- |
| Android 13+ 侧载 App 开无障碍需“允许受限设置”；ColorOS 上可能找不到该项或开关无反应 | 设置页按状态引导（§4「无障碍引导」）；连着电脑时经 adb 授权后由 App 自己开启 |
| ColorOS 等系统会杀掉无障碍服务 | 持有 `WRITE_SECURE_SETTINGS` 时调用前自愈重启；否则提示在系统里关掉再打开 |
| Google Play 禁止用无障碍做 Agent 自主操作 | 仅侧载分发 |
| `OWN_FOCUS` 需要 TRUSTED 虚拟屏，部分 ROM、模拟器不支持 | 退回主屏执行 |
| 服务端离线时入口与设备能力都不可用；出门依赖 Tailscale | 界面如实标注；预约唤醒只覆盖可预知的调用 |
| 自动操作第三方 App 的平台规则 | 只面向个人使用，不做批量功能 |

## 8. 参考

| 项目 | 许可 | 借鉴点 |
| --- | --- | --- |
| [Mika](https://github.com/wangzan101/Mika) | Apache-2.0 | 端上无障碍与 shell 辅助进程、后台虚拟屏、`ActionExecutor`、观察格式、精确闹钟与恢复、无模型的 `McpToolSession` |
| [mobile-mcp](https://github.com/mobile-next/mobile-mcp) | Apache-2.0 | 工具 schema、批量命令 |
| [Maestro](https://github.com/mobile-dev-inc/Maestro) | Apache-2.0 | 可重放 flow |
| [scrcpy](https://github.com/Genymobile/scrcpy) | Apache-2.0 | `app_process` 辅助进程、`--new-display`、输入注入 |
| [Shizuku-API](https://github.com/RikkaApps/Shizuku-API) | MIT | UserService |
| [libadb-android](https://github.com/MuntashirAkon/libadb-android) | Apache-2.0（双授权） | 端上无线调试配对 |
| [Mobilerun Portal](https://github.com/droidrun/droidrun-portal) | AGPL-3.0 | 只参考接口形态，不复用代码 |
| [ADBKeyBoard](https://github.com/senzhk/ADBKeyBoard) | GPL-2.0 | 只参考 IME 输入思路，不复用代码 |

## 个人助理读取和修改配对客户端的外观

个人助理主对话的 `device_riffet_appearance` 通过 `riffet.appearance` 能力投递。用户先在该实例配对的目标设备上启用本机控制，再把设备工具组给助理会话。每次调用必须指定设备 ID 并提供本次用户消息的来源。空变更读取目标端支持的主题、明暗和界面风格。写入按该端的可选值校验并回读，只影响目标设备上的 Riffet。离线、授权撤销、切换实例或断开连接时结束本次调用，重新连接不会补做旧的设置命令。[工作台设置](ASSISTANT-CAPABILITIES.md)
