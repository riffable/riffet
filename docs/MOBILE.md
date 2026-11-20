# Riffet 移动客户端

面向 Android 与 iPhone 的客户端。Android 采用 Compose Material 3；iPhone 采用 SwiftUI / UIKit 原生界面（最低 iOS 18.0），两端共享 KMP client/core/contracts。
服务端、Agent CLI、文件与终端全部运行在 Mac 上。手机有三个角色：

- **遥控器**：查看进度、回复消息、批准操作（已实现）。
- **随身在场**：通知里处理、状态栏胶囊与厂商岛、生物识别确认、保活。
- **能力端与助理入口**：作为设备被服务端 Agent 调用（读屏、操作 App、定位、拍照），并随手把事情交给 Agent。设计见 [DEVICES.md](DEVICES.md)。

能力尽量放在服务端：手机只做必须在手机上发生的采集、执行、本人确认与按时唤醒。

测试维护遵循 [AGENTS.md](../AGENTS.md#测试与验证)：非必要不增加测试。当前自动化只保留协议兼容、鉴权、Outbox、持久化、并发与恢复等核心行为；UI 展示、格式化、布局和重复映射测试已精简移除。终端 ANSI/Unicode 状态机仍属协议核心。下文历史验收数量记录当时执行情况，不代表当前测试清单。

本文是共享协议与 Android 实现的设计契约。iPhone 的原生布局、功能矩阵、构建与验收以 [IOS.md](IOS.md) 和 [正式工程 README](../apps/mobile/iosApp/README.md) 为准；2026-10-15 已将早期“同一份 Compose UI”路线改为共享逻辑、分别实现平台 UI。下文 Compose 控件、Android 前台服务、下载中心和设置分类仍描述 Android。`apps/web` 的实现不因本项目改变，服务端改动全部是增量的新端点、新字段与新文件。

## 目标与非目标

**目标**

- 手机扫码即可连接 Riffet 服务器（Mac 或 Linux 上均可），不需要手输 IP 和访问令牌；也可输入地址和配对码，并保存多台服务器随时切换，见 [远程访问](guide/remote-access.md)。
- 对话时间线的内容与排序与 web 一致，包括思考、工具行、子 Agent、diff 与审批卡片。
- 锁屏、切网络、换 Wi-Fi 后重新打开，位置不丢、内容不错乱。
- Android / iPhone / macOS 共用契约、时间线投影和客户端状态；各平台使用自己的原生导航、控件与系统能力。
- 发挥移动端特性：保活、生物识别、状态栏胶囊与厂商岛、系统入口，以及经 Riffet MCP 向 Agent 提供手机能力。见「路线」。

**非目标**

- 不在 Android/iOS 上运行服务端、tmux、Agent CLI 或模型。手机作为能力端时，规划与决策仍由服务端会话里的 Agent 完成。
- 不做公网推送中继（FCM / Firebase Functions，或替用户转发 APNs 的中转服务）。iOS 的后台通知由持有 APNs 密钥的服务端直接发给 Apple，Android 仍靠前台服务。见「通知」；可预知的设备调用由预约唤醒覆盖（DEVICES.md §3）。
- 不自建 TLS 与证书指纹固定。见「网络接入」。
- 不做多用户、多租户或共享访问。Riffet 是单用户的。
- 不把时间线投影下沉到服务端。见「时间线的第二实现」。

## 架构

```
┌─ Mac ─────────────────────────────────────────┐
│  riffet server (Fastify + SQLite)             │
│    ├─ tmux/PTY → cursor-agent/codex/claude/dsh│
│    ├─ devices.json        设备令牌（0600）     │
│    ├─ 配对码 + 二维码                          │
│    └─ mDNS: _riffet._tcp                      │
└───────────────────────────────────────────────┘
        ▲  HTTP + SSE + WebSocket
        │  Authorization: Bearer <device token>
        │  经 mDNS 名或 Tailscale（HTTPS）
        │
┌─ apps/mobile (Kotlin Multiplatform) ──────────┐
│  contracts/   DTO + kotlinx.serialization     │  零平台依赖
│  core/        时间线投影、模型解析             │  零平台依赖
│  client/      会话状态、缓存、Ktor 网络、      │  不依赖 Compose；
│               分组与展示规则                   │  macOS App 经 SKIE 复用
│  shared/      Android Compose UI + 设计系统   │
│  androidApp/  Android 宿主                    │
│  iosApp/      SwiftUI / UIKit + RiffetKit     │
└───────────────────────────────────────────────┘
```

`contracts/` 与 `core/` 的代码全部写在 `commonMain`，不依赖 Android 或任何平台 API。
`client/` 是从 `shared/` 拆出的不依赖 Compose 的一半：`SessionStore`、`TranscriptCache`、`RiffetApi`
与 SSE/终端连接，以及时间线分组（`TimelineRows.kt`）、侧栏、模型参数、输入框 dock、会话状态徽标
（`ConversationStatus.kt`）这些纯规则；收藏的接口与已显示会话的收藏状态（`SessionMarks`）目前只有 Mac 接入，手机未使用。
页面的读写也在这里：`SettingsController`、`SessionDetailController`、`StatsController` 与 Git 面板的
`GitPanelController` 只依赖协程，用一个 `StateFlow<…State>` 暴露状态；Compose 只 `collectAsState()`
渲染、把点击转成方法调用，输入框草稿这类纯界面状态仍留在 Compose。`RiffetApi` 类只保留传输与配对端点，
其余端点按领域写成同一类的扩展函数（`RiffetApiSessions.kt`、`RiffetApiGit.kt`、`RiffetApiSettings.kt` 等）：
Swift 经 SKIE 看到的仍是 `RiffetApi` 的方法，调用不变；`riffet.shared` 包外的 Kotlin 需按名 import。
包名没有变，`shared` 以 `api(project(":client"))` 依赖它；macOS 原生客户端经 SKIE 导出的 `RiffetKit`
复用同一份代码（`docs/MACOS.md`）。
iPhone 也经 SKIE 导出的 `RiffetKit` 复用 `:client`，并已配置 iosArm64 / iosSimulatorArm64 framework 与独立 iOS host。原生界面位于 `iosApp/Riffet`；不把 `:shared` 的 Compose UI 嵌入主应用。

## 服务端改动

| 编号 | 文件 | 改动 |
| --- | --- | --- |
| S1 | `apps/server/src/auth.ts` | `require()` 接受 `Authorization: Bearer`；Bearer 路径跳过 CSRF；设备令牌存 `devices.json`（`0600`），只存 SHA-256 |
| S2 | `apps/server/src/app.ts` | `POST /api/devices/pair`、`POST /api/devices/prove`、`GET/DELETE /api/devices`、`POST /api/pairing/code`；`/api/auth/status` 支持 Bearer |
| S3 | `apps/server/src/system.ts` | 备份清单加入 `devices.json`，标记为可选，旧备份恢复时不报错 |
| S4 | `apps/server/src/discovery.ts` | mDNS 广播 `_riffet._tcp`，仅在非 loopback 监听时启用，可关闭 |
| S5 | `scripts/riffet.mjs`、`apps/server/src/cli.ts` | `riffet pair` 打印地址、一次性码和配对二维码；`riffet doctor` 检测 Tailscale；`--mdns` / `--no-mdns` |
| S6 | `package.json` | `qrcode-terminal`、`bonjour-service` |
| S7 | `tsconfig.json` | `"exclude": ["apps/mobile"]` |
| S8 | `.gitignore` | Gradle 产物与签名密钥；仅统一 debug key `apps/mobile/androidApp/signing/debug.keystore` 纳入版本控制 |
| S9 | transcript-window.ts（已随 sync v3 删除）、`apps/server/src/app.ts` | 原生流与历史接口接受 `window`（字节预算，夹在 320 KiB–4 MiB）；流接受 `generation` + `after` 从锚点续传；新增 `GET /api/sessions/:id/native/snapshot`。见「设备上的会话副本」 |

### Mac 换地址

二维码的 `host` 是首选地址，`hosts` 按同样的顺序列出监听端口上的全部地址（多块网卡、mDNS 名）。
公司网络常把一块网卡隔开（无线客户端互相不通），另一块仍能到达，所以扫码配对时手机同时请求每个地址的
`GET /api/auth/status`，按列表顺序取第一个应答的配对，其余地址存进这个配对的 `alternates`。旧服务端
只给 `host`，旧客户端忽略 `hosts`。Mac 换网络或 DHCP 换 IP 后，手机连原地址只会超时：

- 服务端：`allowedHosts` 按需重读网卡（带短缓存），新 IP 不用重启服务就能通过 `checkOrigin`；
  mDNS 名 `<hostname>.local` 和 `--allow-host` 加入的 Tailscale 名一直有效。
- 手机端：读取失败、网络又是通的时候（每分钟最多一次），在局域网里重新发现 `_riffet._tcp`，加上配对时
  的原地址和 `alternates` 一起作为候选。每个候选先回答 `POST /api/devices/prove {device, nonce}`：服务端用这台设备记录里
  保存的令牌哈希对 nonce 做 HMAC-SHA256。只有持有该记录的服务端答得出来，令牌本身不会发出去，伪造的
  广播也拿不到令牌。当前地址仍能证明时，什么都不改。
- 证明通过的地址记成这个配对的 `route`。配对的源保持不变，令牌绑定、设备副本、草稿、通知和快捷方式
  都按源存放，所以都不受影响；只有发送时由 `ServerRouting` 改写 host 和 port（`ServerRoutes.kt`）。
  回到原网络后，原地址重新证明通过，`route` 随之清空。
- 局域网不允许组播（常见于公司网络）时发现不到新候选，只能试 `alternates`；都不通时仍需重新扫码。
  目前只有 Android 会自动换地址。

### 为什么 Bearer 跳过 CSRF 是正确的

CSRF 防的是浏览器自动携带的 ambient credential。Bearer 令牌是显式凭据：能带上它的攻击者本来就能直接发起请求，CSRF 在这一路径上不成立。这是协议层的正解，不是为省事。

### 令牌与配对

- 设备令牌格式 `wkn_<deviceId>_<32 字节 base64url>`，服务端只保存 SHA-256，明文仅在配对响应里返回一次。
- 配对码是 5 分钟有效、单次使用的一次性凭据，由已认证的会话生成，用于换取长期设备令牌。
- 二维码里放的是**配对码，不是访问令牌**，避免长期凭据进入相册或截图。
- 配对接口单独限流，避免局域网内暴力尝试。
- 客户端把令牌和签发它的源（scheme + host + port）一起保存，只给这个源的请求带令牌。探测手输地址、
  点选局域网发现的服务、扫码和兑换配对码都用不带令牌的请求，且在配对成功前不改变当前连接——
  伪造的 `_riffet._tcp` 广播或别的应用塞进来的地址拿不到令牌。旧版本只存了令牌和服务器地址的，
  视为绑定到那个服务器。
- 服务端回 401（设备被撤销）后客户端不再重连或轮询，停掉前台保活，并打开重新配对页。终端 WebSocket 握手拿不到 HTTP 状态码，所以连接失败后会用 `GET /api/terminals/:id` 确认令牌是否已失效，失效就停止重连。

## 客户端

### 契约：手写 DTO + golden fixture

不使用代码生成。原因：TS 契约是手写 interface 而非 zod schema，从 TS 生成需要经过编译器 API、JSON Schema 与代码生成器，工程量真实；而「生成」只能捕捉生成来源的结构漂移，「fixture 往返」才能捕捉真实会发生的序列化不匹配（可空性、字段改名、可选字段、未知字段）。

三条配套措施：

1. `Json { ignoreUnknownKeys = true }`，前向兼容新字段。
2. `scripts/gen-timeline-fixtures.ts` 把 `NativeStreamMessage` 各类消息写成 `satisfies` 契约类型的 TS 值，导出为 `contracts/src/commonTest/.../StreamContractFixtures.kt`；契约改名或新增必填字段时 `pnpm typecheck` 先失败。
3. `StreamContractFixtureTest` 解析这批 JSON 再编码回去，TS 有而 Kotlin 丢掉的字段即失败；客户端有意不读的字段登记在测试里。

### 只连原生流

客户端只需要 `/api/sessions/:id/native/stream`，不需要 `/api/sessions/:id/stream`。
原生流已经包含 `reset`、`append`、`runs`、`context`、`metrics`、`status`、`session`、`job`、`subagent` 九类消息，覆盖对话视图的全部输入。

`append` 带 `previous`：这条连接自上一个 `reset` 以来写出的最大事件序号（native/streamSequence.ts，已随 sync v3 删除；未知时省略）。
客户端在传输层按同样规则累计自己收到的帧（app 的 `SequenceTally`，web 的 `sequenceTally`），对不上就说明有帧丢了
或没解析出来，立即重连让服务端补发。序号本身不连续，没有这个字段客户端无从发现缺帧，只能等下一次重连碰巧补上。
旧服务端不带 `previous`，客户端只在字段存在时比较。

服务端在**每次建立连接时都重放完整的 `reset` 快照**，因此重连即全量对齐，客户端不需要增量补偿逻辑。

### 目录选择器：手机也能新建目录

手机必须能自己把会话开在电脑上的任意目录里，否则「项目列表里没有的目录」这件唯一需要回到电脑前才能做的事，
就永远挡在第一步。因此客户端接入服务端已有的两个端点（不是为手机新增的）：

- `POST /api/browse`：列目录。响应带 `path`、`parent`、`home`，手机据此显示面包屑、上级与 `~` 折叠路径 ——
  手机不知道电脑的家目录在哪，只有服务端报的 `home` 能决定这件事。
- `POST /api/projects`：绑定目录，按 canonical path 幂等，已注册的目录返回原项目而不是报错；
  已归档的项目由 `PATCH /api/projects/:id` 的 `archived: false` 恢复（选一个目录的目的就是要在里面开会话）。

选目录本身不创建任何东西：绑定成功后才切到该项目，和 web 的 `Workbench.startSessionInDirectory` 是同一条路径。
浏览接口只返回目录、不返回文件（文件是文件面板的事）；隐藏目录默认折叠，可切换显示。

### 模型参数：Fast / Max / 思考档位

模型名之外的参数（Cursor 的 `fast`、`thinking`、思考档位 `effort`、上下文窗口 `context`）全部来自
CLI 自己的目录（`ModelInfo.configOptions`，由 `nativeModelCatalogFromVariants` 从变体后缀生成），
两端都不硬编码。三条规则是这套控件成立的前提，改动任何一条都要同时改 web 与手机：

1. **变体 id 必须先归到家（family）**。CLI 回给客户端的 id 是变体（`claude-opus-5-5-high`、
   `…-fast`、`…-max`），目录按 family（`claude-opus-5-5`）分组。不归家就查不到任何 configOptions，
   Fast / Max / 思考档位会**根本不显示**。web 走 `backendSelection → nativeCatalogSelection → matchFamily`，
   手机走 `PickerOptions.resolveModelSelection`。
2. **扁平 id 装不下的维度要用参数化写法**。变体 id 只能用后缀表达 effort / thinking / fast，
   上下文窗口只能写进方括号。因此当用户选了 `context`（含 Max）时，选择必须变成 CLI 文档里的
   `claude-opus-5-5[context=1m,effort=high,fast=false]`；继续返回扁平 id 会让 Max 开关「看起来开了、
   CLI 从没收到」。其余情况仍用 CLI 列出的精确 id。
3. **Max 是 `context=max` 这个上下文窗口，不是「只有两个取值的 select」**。它按 Cursor 的形态做成开关
   （模型名旁显示 `MAX`），300K / 1M 仍留在开关下方的 Context 里可选，关掉 Max 回到关之前的那一档，
   不会丢掉已选的窗口。思考档位最多 9 级，手机上是「一行 + 打开列表」，不做等宽分段——
   分段会把每格压到约 40dp，标签全被省略，恰好看不出当前是哪一级。

漂移由两个测试挡住：`apps/web/src/lib/models.test.ts` 与
`apps/mobile/client/src/commonTest/.../PickerOptionsTest.kt`，两边断言同一批规则。
（`core/` 的 `paramsFromOptions` 是同一条链路的第三份实现，只有时间线投影需要它。）

### 会话列表的两种排布：按项目分组 / 按时间平铺

Android 的会话列表是底栏「任务」页的全屏列表（`riffet.ui.sessionlist.SessionList`，原左抽屉 `Sidebar`
迁来），对齐 iPhone 的 `SessionHomeView`。顶栏右侧的筛选菜单（`Sliders` 图标）里的排列方式是 web 的两套规则
（`Sidebar.tsx` 的 `groups` 与 `timeline` 两个 memo），手机必须给出同样的选择，否则手机上永远只有项目分组这一种看法：

- **按项目分组**（默认）：项目可折叠，搜索命中项目名或 cwd 时该项目展开并显示其**全部**会话。
- **按时间平铺**：没有项目行，一条扁平列表按 `进行中 / 今天 / 昨天 / 近 7 天 / 近 30 天 / 更早`
  切成连续的时间带。

两种排布之上，列表页多了三层（`SessionListModel.kt` 的 `sessionListContent`，只在 `visibleGroups` /
`timeBuckets` 的结果上再筛，不改它们的搜索与归档口径）：

- **大标题、搜索框和筛选是列表的前三项**：「任务」大标题随滚动缩小淡出、顶栏标题接着淡入；搜索框聚焦时大标题与筛选
  收起（顶栏显示自己的标题），清空并失焦后回来，浏览位置在搜索期间保存、结束后恢复。
- **会话行两行**：左侧 44dp `AgentAvatar`（agent 色的圆底上放品牌标，运行中是一圈转动的强调色弧，等你确认是右下角
  warning 圆点，失败是 danger 圆点）；第一行标题与相对时间，第二行先是带颜色的状态词（等待你 / 运行中 / 失败），
  再是项目名（在项目分组里换成 agent 名，失败时是错误的第一行）。行间发丝线从文字起点开始。
- **筛选**：全部 / 运行中 / 待处理 / 已归档，一排 `ChipRow`（`ui/design/Controls.kt`：一个选中指示器在各项之间滑动）。「已归档」就是原来的「显示已归档」：只列出
  常规列表藏起来的会话（归档会话、归档项目下的会话），不再是叠加开关。
- **项目范围**：同一个筛选菜单里的「项目」一节（全部项目 + 未归档项目），选中后顶栏标题换成项目名，
  这个项目同时成为「新会话」的项目；worktree 会话算在原项目里。项目从一次确认过的服务端列表里
  消失才会回落到全部，离线副本里暂时缺席不算。范围存在 `RiffetNavigation.scope`。
- **待处理、置顶分区**：等待确认的会话、再是置顶会话，提到最上面两节；某个项目的会话全被提走时这个项目
  不再留一个空分组。只有一个会话都没有的项目（仅「全部」且无搜索词时）保留「暂无会话」行与 +。

三条规则改动时必须两处同改：

1. **时间带按「本地今天 0 点」算，不是「最近 24 小时」**。手机没有日历依赖，`riffet.ui.timeline.localDayStart`
   用已有的 `platformUtcOffsetMillis` 换算本地 0 点，`timeBucketLabel` 只接收 `dayStartMillis` 做比较——
   因此时间带规则可以脱机断言，不需要跑测试的机器处在某个固定时区。web 用的是
   `new Date(y, m, d)`，两端之后都减固定 24 小时，DST 当天的偏差两边一致。
2. **两种排布的搜索口径不同，这是 web 的既有行为**：时间平铺把「项目名」拼进每条会话的命中串，
   但**不搜 cwd**；项目分组搜 cwd。因此一个只被路径命中的项目，在时间平铺里一条会话都不显示。
3. **归档项目连同它的会话一起消失**，时间平铺里没有「空项目 → 暂无会话」的行；它们只在「已归档」里出现。

`sidebarLayout` 读保存下来的排布名，读不懂（旧版本的值、标签文案）就落回按项目分组：打不开列表这件事
不该由一个偏好值引发。排布是设备偏好（`PreferenceKeys.SIDEBAR_LAYOUT`）；筛选与搜索词只随页面状态保存，
条件一变列表回到顶部。外观与主题只在设置里（原抽屉底部的快捷菜单已去掉）。

Android 的连接声明 `pi-agent`、`antigravity-agent` 与 `projectless-tasks`；不声明 `quick-chat`，服务端不下发快速对话的会话与项目（Android 不做快速对话，2026-11-20 移除）。无项目任务仍有服务端内部的
`task-workspace` 项目；列表将这些任务合并到「未关联项目」，项目分组与时间平铺都保留它们。
这个汇总分组只用于筛选，不作为新会话的项目，也不显示在指定项目内新建的 + 操作。
内部任务目录不会自动成为新会话默认项目。Android 界面仍按内置 Agent 枚举处理，不声明 `plugin-agents`。

### 首页导航：底栏四个 tab

`Workbench`（`RiffetApp.kt`）是根页面，`HomeShell`（`HomeTabs.kt`）给它套上 M3 `NavigationBar`：
**新会话 / 助理 / 任务 / 设置**，只有图标（文字是 contentDescription），选中背景读取 `rowRadius`（默认 12dp）；
按压与焦点反馈限制在同一背景内，外层仅承担点击范围，不再绘制第二层矩形。「任务」带等待确认的会话数角标
（`BadgedBox`，`waitingCount`）。启动时打开的 tab 是设备偏好（`DisplaySettings.launchTab`，设置 → 通用 → 启动时打开），默认「新会话」（2026-11-21 起；之前选过的保持）；助理页直接在 tab 里画主对话（`Project.mainSessionId` 指向的会话），没有时是新会话页的输入框加 记忆 / 规则 / 能力 卡片（`ProjectHome.kt` 的 `AssistantHome`）。各 tab 的状态由
`rememberSaveableStateHolder` 保留，切换时按 M3 的 fade-through 过渡（旧页 90ms 淡出，新页 210ms 淡入并从 96% 放大）。
再点当前 tab 回到列表顶部（`TabChrome.reselected`；离顶部很远时先跳近再滑）。系统返回在「新会话」「设置」上先回到「任务」（`TabBackTarget`）。

**底栏只在四个 tab 的根页上出现**：工作台推出的页面（下载、统计、Git、文件、会话……）本来就盖住它；
tab 里面推进去的页面（设置的各个分区）由 `PageHost` 报给 `TabChrome`，有一层就藏起底栏/侧边栏。是一条规则，不按页面各写。
推入的页面从第一帧就按满高布局，底栏叠在上面向下滑走；返回后底栏再滑上来，页面不跟着重排。
底栏用主题色：容器与页面、顶栏同色（`pageColor()`，无分隔线），指示器 `accentSoft`，选中图标 `accent`，未选 `fg2`；
侧边栏同样。

**键盘按聊天应用的方式盖住底栏**：底栏从不为键盘让开（让开再回来，布局就会算两次，收起键盘时内容跳一下）。
键盘的避让不在根上做，而是每页自己做（`keyboardPadding`）：推出的页面和会话页让出整个键盘高度；tab 内容区先
`consumeWindowInsets` 掉底栏的高度，只让出键盘高出底栏的那一截。内容逐帧跟着键盘动画（API 30+），收起后落回底栏
上方，没有二次跳动。`RiffetActivity` 是 `enableEdgeToEdge()` + `adjustResize`，由 inset 驱动，不会双重缩放。

- **新会话**是现有起始页 `ProjectHome`，只有新建任务一个目标：配置（`HomeConfigs`）由 `Workbench` 持有，离开再回到这个 tab
  不发请求；目录只在服务商变化（`backendRevision`）、保存的默认值变化或手动重试时重读，斜杠命令按「项目 + agent + profile」缓存。
  - 一份草稿（`HOME_DRAFT_ID`，web 的 `new:home`）。
  - 输入框像聊天应用一样贴在底部：底栏正上方 12dp，键盘弹出时在键盘正上方。上方固定 48dp 高的一格放项目/目录按钮；
    输入框高过页面时从下沿开始滚动。
  - 内容区右滑交给左抽屉。抽屉的手势遇到「当前返回目标不是页面」时让路（弹层开着时不抢）；回到「任务」的那个目标是
    `TabBackTarget`，不算弹层——之前它被当成弹层，「新会话」「设置」上右滑一直打不开抽屉。
  - 没有标题句、没有右上角筛选。Android 起始页原本没有终端、并行尝试入口。
- **任务**见上一节；创建会话、点开会话、通知与消息搜索命中都盖一层会话页在 tab 上，底栏随之隐藏，
  返回（标题栏箭头、全屏右滑、系统返回与预测性返回）回到原来的 tab。外部打开的会话（通知、消息命中）先切到「任务」。
- **设置**直接放 `SettingsScreen`；作为 tab 根页面时 `PageTopBar`（看到 `LocalTabMenu`）就是三个 tab 共用的
  `TabTopBar`，没有页内大标题。设置里推进去的分区仍先逐层返回。
- **三个 tab 共用一套外壳**：同一个 `TabTopBar`（`ui/design/LargeTitle.kt` 的 `LargeTitleBar`：菜单按钮、`barTitle`
  标题、56dp 高）。tab 根页以 `LargeTitle` 开头，滚走时顶栏标题淡入、底部出现发丝线。推进来的页面用 `PageTopBar`。
- **设置是分组卡片**：分组页底（`groupedPage`）上的圆角卡片（`Group`），每行前面一个彩色 `IconTile`（颜色取调色板的
  语义色、图表色与 agent 色，`SettingsSection.tint`），尾部 chevron；开关整行可点。
- **底栏**是 `RiffetTabBar`：图标加 11sp 标签，一个强调色胶囊在三项之间弹性滑动，选中的图标轻弹一下；顶部一根发丝线。
- **左抽屉**放上下文与次级入口，不放会话列表和项目目录（`WorkbenchDrawer.kt`）：当前服务器（有其他已配对服务器时
  展开即可切换，失效的走重新配对）、主机的文件夹收藏（点一个就在那个目录开新会话）、下载、统计。
  从顶层页顶栏的菜单按钮打开；有底栏时只有「新会话」上右滑打开，侧边导航栏时任意顶层页右滑打开（能横向滚动的子控件先拿手势）；
  会话页里不开。
- **外部入口**：`RiffetNavigation.request(sessionId, sequence)` 打开会话；`requestStart(text)`（`riffet://new?prompt=`）
  打开新建任务并把文字写进那份草稿；`openStart(projectId)` 打开「新会话」的新建任务。
- **宽屏**：按当前窗口约束决定布局，宽度 ≥ 600dp 且高度 ≥ 400dp 使用侧边导航；宽度 ≥ 840dp 且高度 ≥ 480dp 时任务列表与会话并排。列表宽度随内容区域变化，限制为 320～420dp；内层按实际剩余宽度判定，不重复使用包含导航栏的 840dp 阈值。真实铰链由 AndroidX WindowManager 提供；book／tabletop 的列表与会话分布在独立屏段，空间不足时使用较大的安全屏段。折叠、展开、分屏调整窗口和接入物理键盘都不会重建 Activity：`configChanges` 包含 `smallestScreenSize|screenLayout|keyboard|navigation`，由 Compose 按新的约束重新排版。宽屏单栏时，会话正文和输入框限宽 `contentMaxWidth`。实现与验收见 THEMES.md §15。

### 会话详情是右抽屉，不是底部弹层

「会话信息与操作」（会话页头点标题打开的那一屏）原本是底部弹层。弹层是「一层」：打开就盖住对话，
它自己再打开的东西（变更 / 文件 / 子 Agent的页面）必须先关掉它，否则就是层上叠层。

现在它是工作台的**右抽屉**，是左侧导航抽屉的镜像：

- **和左抽屉同一套外观**：从右边缘滑入、与对话页面保持水平相邻，同样 304dp 宽、同样的
  `ModalDrawerSheet`。页面跟随侧栏完整平移，宽度不变；拖回去或按返回键关闭。
- **滑动热区**：有底栏时，tab 根页上的左右滑动切到相邻的 tab：四个 tab 是 `RiffetTabPager` 的四页，拖动按手指的像素滚动，松手按速度和距离落到相邻一页（`TabSwipe`，手势由 `SideDrawers` 统一仲裁）：甩向拖动的方向就翻页，反向甩回取消，慢放过半才翻。每次松手当场定下要落的 tab（`TabSwipe.heading`），回弹途中再滑从这一页接着算，连续快滑一次一页，不等页面停稳；回弹途中点底栏也当场接管，不会被回弹吞掉（没有这一步时，第三下快滑还从上一页的回弹位置量起，被 pager 的吸附限在原页）。底栏的选中底和助理页的收折都读同一个滚动位置，跟着页面走；选中的图标、哪一页接收触摸、新会话页右滑开抽屉都取 `heading`，松手就变。滑动中露出来的 tab 也开着玻璃源（`LocalPageInView` / `pageShowsGlass`），底栏透出的已经是滑进来的页面，不在停稳后才补上模糊。点底栏相邻的 tab 滑过去，隔一个以上直接切换。四个 tab 在启动后 600ms 起一直保持组合（`beyondViewportPageCount`），滑动的第一帧不再现组合整页（实测 230 个会话时首帧主线程 74–129ms → 15ms 内）；看不见的页 `LocalPageActive` 为假，循环动效（`visualWorkActive`，含首页的动态标志）停在当前帧。「新会话」左边没有 tab，右滑打开左抽屉；tab 里推进了页面或开着面板、菜单时不切换。侧边导航栏时顶层页任意位置右滑打开左抽屉。会话内容区任意位置左滑打开右抽屉（没有打开的会话时不响应），
  右滑是会话页自己的整页返回（`PageSwipeMode.FULL`，子节点先看到拖动），会话页里左抽屉不开。
  抽屉开着时，任意位置的水平拖动都拖这个抽屉。子控件的横向和竖向滚动仍优先。会话页标题仍然能点开右抽屉。
- **两个抽屉是自己写的 `SideDrawers`，不是 M3 的 `ModalNavigationDrawer`**：M3 的抽屉在整屏
  监听拖动，且拖动状态（`AnchoredDraggableState`）是 internal 的——它既没法与第二个抽屉分屏，
  也没法从外面驱动。`SideDrawers` 用一个手势检测按滑动方向分派，各自的进度是 0..1 的
  连续进度；松手按速度（400dp/s）或位置（过半）决定开合，结果回写 `RiffetNavigation`。拖动直接写进度，收尾按剩余距离和松手速度计算有限时长，避免弹簧在边缘被裁切后出现慢尾巴；抽屉打开时页面同步平移一个完整抽屉宽度，两者的边缘始终贴合。
  手势挂在父节点的 Main pass 上，子节点（转录的竖向滚动、代码块的横向滚动、起始页的模式切换）先消费的拖动不会被抢。
  左抽屉内容用 M3 `NavigationDrawerItem`。
- 两者互斥：打开任一侧都会先关另一侧。
- **它自己取数**：会话（`store.selected`）与子 Agent行（对时间线做一次增量投影，再并上
  `store.subagents` 里父转录尚未写到的子会话——Cursor 的前台 Task 跑完才进父转录）在
  `SessionDetailsPane` 内部读；只有 `SessionDetailController`（模型目录 + 四种写入）由
  `Workbench` 持有并同时交给 `SessionScreen` 与它——两份控制器意味着模型目录抓两次，而且
  「是否有写入在飞」会有两个答案。`detailWriteBlocked` / `detailModelLabel` /
  `detailApprovalLabel` 因此抽成了共用函数。
- 页面按打开顺序逐层返回，页面内的详情先退回列表；选择器和侧栏优先关闭。
  切换或关闭会话会一并关掉右抽屉。

### 目标（goal）与待办一样浮在输入框上方

待办（`plan`）与**目标**都不是消息，所以两者都放在输入卡上方的 dock 里，顺序是
**目标 → 待办 → 队列**：目标是这个会话「为了什么」，待办是为它服务的清单，队列是还没发出去的话。

目标由服务端统一给出：`Session.goal`（`objective`、`status`、`reason`、用量），客户端只读快照，
不再从时间线推断。来源按后端：

1. **Claude Code `/goal`**：转录里 `type: "attachment"`、`attachment.type: "goal_status"` 的行
   （`backends/claude/goal.ts`）。设定是 `met: false` + `sentinel`；检查未通过是 `met: false` + `reason`，
   仍为进行中、`reason` 是最新判定；达成是 `met: true`（带 `iterations` / `durationMs` / `tokens`）；
   `/goal clear` 是 `met: true` + `sentinel`。旧版本只有 `Goal set:` / `Goal cleared:` 的命令输出，同样识别。
   设定时给模型的 `isMeta` 行（"A session-scoped Stop hook is now active…"）照旧不显示。
2. **Codex 线程目标**：app-server 的 `thread/goal/updated` / `thread/goal/cleared`，接上线程时再
   `thread/goal/get` 一次（`backends/codex/goal.ts`）；不改用户的 `[features] goals` 配置。
3. **DeepSeek Harness**：目标留在 harness 一侧，只能从 `create_goal` / `update_goal` 的参数里读
   （`backends/dsh/goal.ts`）。`pause` / `resume` / `complete` / `blocked` 不带 objective，沿用上一次的。

已完成的目标与已完成的待办相同：**出现下一个用户回合之后就不再占位**，这条也在服务端做。dock 保持一行，
状态词各端走 i18n；只有 `usage_limited` / `budget_limited` 时在状态后附 token 用量；时间线不加提示行。

### DSH 的工具行必须有文件名

`read` / `edit` 这类行只有一个动词是 bug，不是 harness 的风格：DSH 的调用参数一直在事件里，
只是投影没读它。服务端 `backends/dsh/events.ts:describeDshToolCall` 现在从参数里取 `path`
（别名 `file_path` / `target_file`）、`offset` 与 `old_string` / `new_string`，产出
`Read app.ts` / `Edit app.ts`、`locations` 与内联 diff —— 与 Cursor 路径
（`native/chat-store.ts:describeToolCall`）同一套结果。加新的工具名时要同时看这两处。

### 与 web 一致的输入框 dock 和可选中文字

手机与 web 用同一套「消息只显示一次」的规则：Agent 的待办列表（`plan`）与**排队中**的消息都不进正文，
只出现在输入框上方的 dock 里（待办在队列之上，默认收起），一条 run 真正进入
`preparing`/`dispatching`/`input_sent`/`observed` 时才回到转录。dock 读的是队列卡片读的同一个 flow，
过滤读的是同一份 timeline，所以两处不可能漂移。

长按选中复制**不是被开关关掉的**：Compose 的 `Text` 默认不可选中，必须由 `SelectionContainer` 包起来。
因此转录里每一处文本（用户消息、助手回答及其 Markdown/代码、思考、工具输出、diff、状态行、文件预览）
各自包一层 `riffet.ui.focus.SelectableText`，容器不放在 `LazyColumn` 之上，虚拟化与 item 复用不受影响；
与既有手势冲突的地方（折叠表头的整行展开/收起）选择保留手势。

**选择性触觉反馈被有意关掉**：Compose 的 `SelectionManager` 在**每次选区变化**时都打
`HapticFeedbackType.TextHandleMove`（长按建立选区一次、点空白清除再一次），读起来是「选中震一下、
取消又震一下」，而选区本身已经画在屏幕上了，这个反馈不承载信息。`riffet.ui.haptics.WithoutSelectionHaptics`
只丢这一个类型、其余照常转发，由 `SelectableText` 自带；**不**装到输入框上，那里的同一类型对应光标与
手柄移动，是另一回事。

### 焦点：输入框、选区与「谁都不持有」

一个窗口只有一个焦点持有者，而 `SelectionContainer` 的选区**依附于焦点**：长按建立选区时它抢走焦点
（输入框因此失焦、键盘收起），复制菜单只在它持有焦点时显示，一旦失焦就清掉选区和菜单。所以任何一次
`clearFocus()` 都等于「取消选区」。规则集中在 `riffet.ui.focus`（`FocusCoordinator.kt` 顶部有完整说明），
页面不再各自写点击失焦：

| 规则 | 实现 |
| --- | --- |
| 只有真正的点击才失焦：单指、长按超时前抬起、没超出 touch slop；一旦变成长按、拖动或多指，直到所有手指抬起都不再重判 | `Modifier.blurOnTap()`，装在会话页、子代理页、项目首页、文件预览、Git diff 的根上 |
| 点在输入区自己身上不失焦 | `Modifier.keepsFocusOnTap()`：输入框 dock（含待办/队列）、首页输入卡片、提问卡片的回答框 |
| 手指按住期间键盘占的高度不回收，松手后缓出 | `Modifier.keyboardPadding()`，替代根上的 `imePadding()` |
| 有选区时转录不跟随底部 | `FocusCoordinator.selecting`，`Timeline` 读它；选区结束后补跟一次 |
| 转录是否跟随底部由会话页持有 | `TimelineFollow`：只有读者自己的滚动、定位跳转和 `resume()` 改变它；离开底部时右下角显示「回到最新」圆形按钮（有新内容时带点），点它或发送消息都恢复跟随，与 iOS、web 一致 |
| 菜单里点「复制」后释放焦点 | `SelectableText` 包一层 `TextToolbar` |

此前的 `onAnyTap` 有两个导致「长按后松手菜单消失」的缺陷：长按超时后它跳出判断、立刻把**同一次按压**后续
的移动事件当成新的按下（真实手指按住不动也会持续上报亚像素移动），于是松手被判为点击并 `clearFocus()`；
另外它以每次重组都新建的 lambda 作为 `pointerInput` 的 key，流式输出时每一帧都在重启检测，效果相同。
第三个现象来自键盘：输入框有焦点时长按，键盘在手指还没抬起时收起，贴底的转录随之下移，选区被拖着变形。

### 重连必须自己写

- Ktor 的 `SSE` 插件自带重连，但 `maxReconnectionAttempts` 有次数上限，手机需要无限重连。
- 用 `client.sse(...)` 包在 `try/catch` 与指数退避循环里，不使用插件的自动重连。
- 服务端每 15 秒发一个 `event: ping` 命名事件用来判定死流，客户端同样需要自己的静默超时。

### `reset` 不能无脑替换

2026-10-09：App 与 Web 均支持 `reset.replaceFrom`（含该序号的权威尾部边界）。同一 `chatId` 与
`history.generation` 下，只替换该范围，保留更早的已加载消息和游标；草稿结算会移除被替代的全部分片，
同 ID 的正文更新也会生效。ResidentTranscript.kt（已删除）是主会话、子 Agent 和后台预取共用的规则。
`NativeTimelineModel.reconcile` 保留任务状态与未变化行的引用；现有 LazyColumn、稳定 key、上翻预取和
阅读／贴底模式继续使用，不因普通尾部校正重建整个列表。

缺口在画面外补齐后一次发布，后续流帧按顺序处理。失败或超时保留旧画面和缓存，通过已有连接错误入口重试；
切换会话会取消旧请求。子 Agent 的分页提交还核对其身份、代次和当前头部；后台预取遇到期间的会话切换放弃写入。
新协议路径不以“最多 6 页”为丢弃历史的理由，而使用总计 40 秒的可取消请求预算。

尾部校正会标记缓存需要重写，避免首尾 ID 未变但正文已改时误走只追加路径；后续 append 合并到同一次
延迟写入也不能清掉这个标记。写入成功后才清理对应版本，失败保留标记，普通流式追加仍使用增量日志。

未声明 `replaceFrom` 的旧服务端仍走 `continuedBy` 与旧补页逻辑；完整保证需要新服务端和新 App 配套使用。

本轮验证：完整 JVM 测试集 333 项通过；最后补充待同步期间保存的回归后，相关 48 项定向测试通过，Android
`assembleDebug` 通过。覆盖草稿结算、同 ID 改文与重读缓存、超过 6 页的缺口、补齐失败／超时／切换取消、
后续帧顺序、子 Agent 与后台预取。未安装到真机验证阅读位置；Linux 上未验证 iOS 编译。

### 设备上的会话副本

早期 320 KiB 窗口可能被一个长回合占满。当前服务端按消息／轮次分页，传输预算仅用于保护单次请求；
App 仍显式请求 3 MiB 预算，并把**看过的会话全部存在本机**，服务端只补差量。

- **存储**：`riffet.cache.TranscriptCache`，按服务端地址分区（`servers/<地址>-<哈希>/`），每个会话
  一个只追加的 JSONL 事件日志加一个元数据文件（`chatId`、`history`、上下文用量、活动时间戳、首尾事件
  id）。尾部续接时只追加新行，换了会话或对不上时整体重写；元数据在日志之后写，进程中途被杀时读取会按
  日志修复，断掉的半行被丢弃。总量 256 MiB / 300 个会话，按最近访问淘汰。项目与会话列表存在 `list.json`。
  缓存是可丢弃的：读坏了就当没有。Android 放在 `noBackupFilesDir/riffet-cache`（不进云备份），
  桌面 JVM 放在 `~/.riffet-mobile/cache`；iOS 使用 Application Support 下的原子文件持久化并按服务器分区。
- **先画本机副本，再连流**：打开会话时先读盘、立即渲染（顶栏显示「同步中」），然后才拨号。
  服务端确认前，连不上时顶栏显示「离线 · X 前」；列表同理，启动时先显示存下的列表，取不到时提示
  「离线 · 显示 X 前保存的列表」。
- **从锚点续传**：每次拨号（含重连）都带上 `window=3 MiB` 和本机尾部 `generation` + `after=<nativeId>`。
  `generation` 一致且锚点之后的事件不超过 4 MiB 时，服务端的 `reset` 从锚点（含）开始，
  `history.cursor` 指向锚点之前；客户端按 `replaceFrom` 合并尾部，旧服务端回退 `continuedBy`。锚点认不出、代次不同或
  落后太多时，服务端退回最新窗口。
- **补缺口**：退回的窗口与本机副本属于同一会话（`chatId` 与代次不变）、且整个窗口都比本机最后一条新时，
  新协议下先在画面外向前翻页，直到与本机副本相接，再保留本机更早部分和对应游标。补齐失败不发布
  不完整尾部。重叠部分的草稿或内容变化按权威范围校正，不因此丢弃范围外历史。
- **预取**：每次刷新列表后，对最近活跃的 8 个原生会话（跳过正在看的），活动时间戳变了才用
  `GET native/snapshot`（同样带锚点）取差量并合并进本机副本。Android 前台服务每 5 分钟刷新一次，
  切到后台时立即落盘。
- **不缓存的**：子代理的转录、终端输出。服务端重启后若事件序号变化，续传会退回替换，不会拼错。

### 全文搜索

「任务」页的搜索框除了匹配会话标题、项目和标签，还搜**本机存下的所有消息**（提问、回答、工具调用标题）。
命中的消息排在会话结果之后，单独一节「消息 · N」（最多 60 条，到上限显示 `60+`），每条是所属会话、谁说的、
多久前，以及高亮了命中词的片段。打字停 150ms 后才读索引。aaf6a05 移除的入口在这里恢复；当时的
`NativeFeature.MESSAGE_SEARCH` 开关没有恢复，消息搜索总是开启。iPhone 在 `ProjectPicker.swift` 的 `CachedSearchView` 使用同一个接口。

- **索引**：`riffet.cache.TranscriptIndex`。Android 用系统自带 SQLite 的 FTS4（`simple` 分词器，
  文件 `noBackupFilesDir/riffet-cache/search-<哈希>.db`），桌面 JVM 保持内存实现；iOS 使用持久化 `FileTranscriptIndex`。
  `simple` 不懂中文，所以中文连续段在写入前切成重叠的二字词（「本地缓存」→ 本地 / 地缓 / 缓存），
  每段末字另存一份，单字查询才能命中词尾；拉丁字母与数字按词小写。查询按空格分词，每个词是一个短语，
  最后一个拉丁词或单个汉字按前缀匹配，打字时就有结果。
- **维护**：索引是派生数据。落盘内容有变、淘汰、清空时，`TranscriptCache` 只在自己的锁里把会话记为
  待更新；副本静止 3 秒后，`indexPending()` 才逐个会话重新投影并整段替换条目，只拿索引自己的锁，读日志
  时才短暂拿一下缓存锁。不能在缓存锁里建索引：长会话投影加写库要好几秒，打开会话要先 `load`
  本机副本再拨号，会一起卡住，表现为一直「正在处理」却不出内容。索引写失败只影响搜索。启动时
  `indexMissing()` 把还没进索引的会话（比如升级前存下的）记为待更新。
- **轮询不预取**：列表读取（推送触发，或兜底轮询，见 [LIST-SYNC.md](LIST-SYNC.md)）只预取刚变化状态的会话（通知要用），其余照旧只在完整刷新时预取。
- **打开命中**：点结果打开会话，转录滚到那条消息并短暂高亮；消息在折叠的回合里时先展开。2.5 秒内还没
  加载到这条，就停在序号不超过它的最近一条。

### 压缩与传输

- 服务端只在客户端声明接受 gzip 时才为长连接启用 gzip 编码器（`encodingFor`），
  显式发送 `Accept-Encoding: identity` 即可关闭。客户端把它做成开关，默认开启（服务端注释说明这是为手机链路优化的），异常时可立即关闭。
- 请求体上限 36 MiB，附件原始上限 24 MiB 且以 base64 上传。客户端必须先降采样（长边 2048px），否则低端机解析大图会内存溢出。
- Android 附件选择器接受所有普通文件（`*/*`），包含 ZIP、CSV、Office 文档与未知格式；每条消息最多 20 个附件。读取单文件时限制原始字节数，超限或不可读会明确报错并拒绝整批，不再静默跳过。整批上传成功后才添加到草稿。已发送的普通附件可点击下载，沿用下载列表的进度、取消、重试与持久化；iOS 选择器仍属于未实现的 P4 能力。
- 左侧导航栏的右侧两个角、右侧会话详情栏的左侧两个角统一为 28dp 圆角，圆角覆盖栏背景及其内容。

### 数学公式：服务端 KaTeX 页 + 平台 WebView

客户端复用**服务端**的 KaTeX 页面，避免各平台维护不同的 TeX 渲染规则：

- 服务端 `apps/server/src/math-assets.ts` 提供 `GET /math`（一个固定页面，用与 web 同一份 KaTeX 构建渲染）与 `GET /katex/*`（katex dist 里的 js/css/字体，路径解析限制在该目录内）。公式走 URL **fragment**，浏览器不会把它发给服务器，因此页面是常量、可缓存，公式不进请求日志；页面自带 `script-src 'self'` 的严格 CSP，且不在 `/api/` 之下，WebView 做文档导航时不需要设备令牌。
- 客户端 `MathFormula.kt` 拼出 `…/math#tex=…&d=…&c=…` 并交给 `expect PlatformMathView`。块级公式由 `splitBlockMath`（`MarkdownRender.kt`）从 ` ```math ` 围栏与 `$$…$$` 块切出，接进已有的 segment 管线；**未闭合的 `$$` 保持原文**（流式半截公式不该弹 KaTeX 错误页），代码围栏里的 `$` 不动，句子中间的 `$…$` 目前仍按原文显示（Compose 的 markdown 段落没有内联占位符，硬拆会切断句子）。
- Android actual 是 `WebView`：透明背景、关闭文件与内容访问，按页面里 `#formula` 的实际高度测量并重测几次（KaTeX 字体到达后高度会变）。JVM 测试宿主与旧 Compose iOS actual 仍显示原文；正式 iPhone 使用 Swift `ConversationMath` / 非持久化 WKWebView 加载公开 `/math` 页面，保留服务端 CSP 并限制导航，不经过旧 Compose stub。

### 平台层

| 能力 | Android | iOS |
| --- | --- | --- |
| 令牌存储 | SharedPreferences，令牌用 Android Keystore 的 AES-GCM 密钥加密；该文件不进备份与设备迁移 | Keychain：令牌、签发源与服务器地址同项存储，ThisDeviceOnly |
| 生物识别 | 「交互与输入 › 确认操作前验证本人」，本机保存，开启需验证一次（`ApprovalVerification`）。`BiometricPrompt` 允许锁屏密码回退（API 30+ 弱生物识别或设备凭据，API 29 设备凭据，API 28 仅生物识别）。只拦权限、计划与确认三类，问题和选项不拦；失败或期间请求变化则不提交。开启后通知不再带审批按钮，点开在 App 内验证；开启前发出的按钮会改为提示到 App 处理 | `LocalAuthentication` 本人验证，允许设备密码回退；失败不提交 |
| 通知 | 前台服务 | 前台：App 观察到真实变化后发本地通知。后台：服务端持有 APNs 密钥时直接推送（DEVICES.md §3「后台推送」），没有密钥则挂起后收不到 |
| 数学公式 | `WebView` 加载服务端 KaTeX 页 | 原生页面中的非持久化 `WKWebView` 加载公开 KaTeX 页 |
| 文件与分享 | 既有下载中心与系统分享；分享进 App 接受文本与任意文件（`SEND` / `SEND_MULTIPLE`，沿用输入框的附件数量与大小上限，一个读不了整批不加） | 原生文件/照片导入、下载、Quick Look 与系统分享 |
| 持久化与生命周期 | Android 既有实现 | UserDefaults + Application Support 缓存/索引/outbox；进入后台保存并暂停订阅，前台恢复 |
| 系统入口 | `riffet://session?id=<id>`（或 `/<id>`）打开会话，`riffet://new?prompt=<text>` 打开新建任务并填入文字、不发送，路由同通知点按；长按图标列出最近活动的 3 个会话（`ShortcutManagerCompat`，列表变化时更新，被限频则回前台时重试，断开配对时清除） | `onOpenURL`：`session` 打开会话，`new` 打开新任务页并填入文字 |
| 崩溃记录 | `UncaughtExceptionHandler` 先把队列中的日志刷盘，再把堆栈同步追加到 `AppLog`，然后交给系统处理；导出与上传时脱敏（`Bearer`、`wkn_` 令牌只留设备 id、Cookie 与常见密钥参数） | — |

共享业务中的令牌、本人验证、文件和持久化接口使用 `expect/actual`；iPhone 相机、Bonjour、通知、分享与 UI 生命周期由 Swift adapter 承接。旧 `shared/src/iosMain` UI stub 不代表正式 iPhone 能力。

## 设计系统

以下描述 Android Compose 设计系统。iPhone 使用 iOS 语义色、系统字体与原生控件，品牌与信息语义延续 Riffet，不复制 MD3 控件尺寸。

`apps/web/src/styles/index.css` 是 Android 设计变量的来源（约 40 个变量、亮暗两套，以及字号行高与圆角）。
`scripts/gen-mobile-theme.ts` 把它解析成 `RiffetTheme.kt`：

- 生成结果提交进仓库，Gradle 构建不依赖 Node；
- CI 重新生成并比对，不一致即失败，杜绝漂移。

不手工誊抄。手工誊抄一定会漂。

### 设置分类

设置行按实际字体下的标题宽度与控件测量宽度决定排布：能同时容纳时左右排列，否则控件移到标题下方。
模型、配置和权限选项不能挤掉用途标签；长模型 ID 与名称、路由统计与路由名分别上下排列，页面可随内容增高。
辅助模型的「会话标题」「交接摘要」复用现有标签，不用说明文案补偿布局缺失。

设置首页按「通用」「外观」「行为」「模型」「连接」「支持」分组，没有独立的“通用设置”页。
通用下包含语言、扩展管理和能力与设备；外观包含界面风格、主题、排版、图标和动效；行为包含手势与触觉、输入、通知、文件与编辑器。
语言提供「跟随系统 / 简体中文 / English」，只作用于本机界面和应用生成的提示，用户内容与外部原始详情保留原文。
Android 13+ 与系统应用语言设置共用选择；Android 8–12 用 AppCompat 和本机偏好恢复。跟随系统选择语言列表中第一个支持的
中文或英文，无匹配时用中文。三个 Compose Activity 处理 locale/layoutDirection 配置更新，切换保留页面、草稿和正在进行的操作。
`AppLanguages` 统一原生、Compose 和 client/core 语言；`L10n.changes` 使存量时间线投影重新解析提示，通知按原 ID 静默刷新。
原生 `values-zh` 由构建任务从默认中文资源生成，避免系统英语回退覆盖中文选择，也避免维护重复翻译。
动效、手势与触觉、主题和排版等本机偏好在服务端加载失败时也可使用。
服务端设置、提供商和诊断按需读取，各自显示加载错误并可重试。提供商编辑是独立页面，未保存或保存中时，
标题返回、系统返回与右滑返回共用保护。保存成功会同步首页的新会话默认设置，提供商变化会刷新模型目录并保留输入草稿。
「Agent 与模型 → 新会话」可设置当前默认 Agent 的审批模式；各 Agent 详情页也可分别设置。选项读取服务端能力，
选择后立即保存，仅影响新会话；「沿用 CLI 默认」清除覆盖值，并保留默认提供商、模型与其他 Agent 的配置。

### 视觉语言（`ui/design/`）

Android 端不再用 Material 的默认外观，`material3` 只作为部分组件的内部实现。组件集中在 `ui/design/`：

- **表面层级**（`Surfaces.kt`）全部由当前主题的角色推导，不新增色值：普通页 `bg`；分组页底浅色是 `bgSubtle`
  与 `bgMuted` 之间、深色就是 `bg`；卡片浅色 `bg`、深色 `bgElevated`；浮层 `bgPopover` 配两层柔和阴影
  （`Modifier.floatingShadow`，阴影用主题的正文色调，暖色主题投暖影）。卡片边缘是 0.5dp 发丝线加 1px 接触阴影。
- **按压反馈**（`PressIndication.kt`）：`RiffetTheme` 把 `LocalIndication` 换成柔和高亮（按下即出现，抬起 250ms 淡出），
  取代水波纹；仍画 Material 水波纹的组件被调到很淡。按钮、chip 另有 `pressScale`（按下缩到 97%，弹回）。
- **字号阶梯**（`RiffetTypography` 新增 `largeTitle` 30 / `barTitle` 18 / `headline` 16 / `subhead` 14 / `footnote` 13），
  Material 的 Typography 映射到同一套，残留的 M3 组件不会跳出另一套字号。
- **控件**：`RiffetSwitch`（拇指弹簧滑动、按下拉长）、`SegmentedControl`（凸起滑块）、`ChipRow`、`Group` / `GroupRow` /
  `IconTile`、`LargeTitle`、`RiffetTabBar`、`AgentAvatar`。
- **图标**是 Lucide 线性图标（描边沿用 Web：任何尺寸下都是 1.25 像素，Android 按渲染尺寸折算），由 `pnpm gen:icons` 从 `lucide-react` 生成到 `LucideIcons.generated.kt`，
  `RiffetIcons` 保留原名字；`pnpm gen:icons:check` 校验生成结果未被手改。

### 原生交互

通知与后台开关位于设置 → 行为 → 通知；滑动返回、系统返回预览与触觉位于设置 → 行为 → 手势与触觉；
页面动效和新内容淡入位于设置 → 外观 → 动效。
页面动效由本机显示偏好（`riffet.shared.DisplaySettings`）保存。
下表中的原生功能开关（`riffet.shared.NativeFeature`）独立存在本机，不经过服务端；默认触觉反馈关闭，其余开启。

| 开关 | 关闭后 |
| --- | --- |
| 会话提醒 | 不发完成 / 失败 / 中断 / 等待确认通知（已发的确认通知仍会在会话离开等待时撤掉） |
| 后台跟进运行中的会话 | 只在会话连接打开期间留在后台，常驻通知不显示进度，后台轮询按空闲间隔 |
| 搜索消息内容 | 侧栏只搜会话标题与项目 |
| 滑动返回 | 不响应 App 内右滑；标题栏和系统返回仍可用 |
| 系统返回预览 | 系统返回手势不跟手，完成手势后执行页面返回 |
| 新内容淡入 | 只有展开回合时的行淡入，流式文字直接显示 |
| 触觉反馈 | 应用自己的震动全部静音；系统的（长按、文字选择手柄）不受影响 |

- **页面动效**：设置 → 外观 → 动效提供淡入淡出、滑动、缩放和无动效，默认淡入淡出；已有手动选择继续保留。
  选择保存在本机并立即应用于整页导航、底部标签、Git 页签、选择面板子页及页面主体切换。
  延迟挂载的主体只做一次短淡入，避免重复整页位移或缩放；无动效时直接显示，系统关闭动画时同样跳过。
  App 内返回拖动和 Android 预测返回保留跟手反馈，新内容淡入与折叠等控件反馈继续由各自设置控制。
- **整页滑动返回**：`PageHost` 保留每次页面访问的真实实例，页面与标题栏一起平移，露出上一页；被盖住的页
  （会话之下的三个 tab 也一样）左移四分之一屏宽并压一层浅遮罩，随上层页的进出同步回位。松手后用带初速度的
  弹簧收尾，不是固定时长。
  松手超过屏宽 33%，或已移动 5% 且向右速度超过 500dp/s 时返回；向左回拉或距离不足则回弹。
  取消不改历史、输入草稿或滚动位置。手机上的整页二级页全区域可起手；非边缘区域的横向控件先处理拖动，
  左侧 24dp 的返回手势优先。竖向滚动和子控件已消费的拖动优先。被覆盖的页面移出可访问性树，
  不持有输入焦点，露出的底页不接收触摸。底部选择面板的下钻页也接受右滑返回上一层。
- **进入动画的帧预算**：会话及子代理在页面进入后才布局时间线；统计图、文件列表与预览、Git diff、终端画布和下载列表
  先保留标题栏，进入动画结束后挂载内容。设置页先启动需要的请求，再显示较重的控件。HTTP 响应的 JSON 与
  首次 Markdown 解析在后台执行；滚动回旧消息复用已解析的结果。这些是主线程工作路径的调整，实际掉帧仍需设备测量。
- **预测性返回**：`enableOnBackInvokedCallback` 打开，`RiffetActivity` 用 `PredictiveBackHandler`
  驱动同一个 `PageBackDispatcher`，手势从开始到结束绑定到当时最深的可见页面；中途导航不会误关新页面。
  预览按 Android 的样式：页面缩到 90%、向手势一侧略移、四角变圆，下层页同时回位；完成后缩小的页面滑出。
  App 内右滑仍是跟手平移。抽屉仍跟手收回。系统取消会回弹，标题栏、系统键和 App 右滑共用未保存/保存中保护。
- **新内容的出现**：转录里新到的行（流式新行、展开的回合、翻到的更早一页）淡入，首屏已有的行不动，也
  不做位移动画，免得行在阅读时滑动。唯一的例外是读者自己折叠/展开回合后的 400ms：这段时间里行带位移与淡出，
  折叠读起来是收起而不是瞬间消失；流式输出与跟随滚动从不带位移。流式回答最后一段里新到的每一块文字各自淡入（220 ms），减弱动效时关闭。
- **触觉**：发送成功、提交确认是 `Confirm`；正在看的会话跑完是 `Confirm`，失败是 `Reject`，进入等待确认是
  `GestureThresholdActivate`；引用是 `ContextClick`。转录文字选择的 `TextHandleMove` 仍然屏蔽。
- **消息菜单**：回答下方是一个「⋯」按钮，菜单里有「复制」和「引用」（`MessageMenuButton`，以后的消息操作
  也加在这里）。「引用」把这条回答的纯文本摘要（最多 200 字）以 `>` 引用块放进输入框并聚焦；子代理页没有
  输入框，菜单里只有复制。提问保留单独的复制按钮，放在气泡下方送达状态与时间的左边。没有做左右滑动引用：横向滑动已经用来拉开两侧抽屉，长按已经用来选择文字。
  「⋯」的触控区是 22×32dp（窄而高：方形触控区左右各 9dp 的空白会把时间戳推远），整行左移
  `MessageMenuInkInset`（5dp：图标两侧 4dp 加 lucide 圆点自身约 2dp 的留白，减去正文字形约 1dp 的侧边距），
  让圆点与上方正文左对齐；时间戳与圆点相距约 8dp。

### 文字大小与会话间距

设置 → 外观里除了主题，还有「文字大小」（小 0.9 / 标准 / 大 1.1 / 特大 1.2）和「会话间距」（紧凑 0.75 /
标准 / 宽松 1.25），存在本机（`riffet.shared.DisplaySettings`）。

- 文字大小在 `RiffetApp` 根部乘到 `LocalDensity.fontScale` 上，叠加在系统字号之上，所有 `sp` 一起变，
  菜单、对话框也跟着变。
- 会话间距缩放转录的 `TimelineRhythm`（行距、紧凑行距、段距、块距、缩进、两侧留白）和回合内子行的
  10dp 间距；最小触控区和 2–4dp 的细缝不变。行距在布局阶段写进 `TimelineEntry`，所以两个转录页把当前
  比例作为布局的 `remember` 键，改了立刻重排。

### 单页多 tab：横滑容器

`RiffetTabPager`（`ui/pager/RiffetTabPager.kt`）是单页多 tab 的容器。tab 条仍然是各页面自己的
`SettingsSegmented`，容器只接管页面区，所以页头、错误/提示横幅、「有差异打开时 tab 消失」这些状态都留在
原处。两个方向都接上：

- 横滑并在**停稳之后**才回调选中页：拖过一格又松手回弹，不该触发一个从没展示过的页去加载；
- 从 tab 条切页时把 pager 滚过去（减弱动效时直接跳，不做补间）。

今天只有 Git 面板（改动 / 检查点 / Worktree）用它。`beyondViewportPageCount` 保持 0：相邻页只在被拖入视野
时才组合，检查点 / Worktree 的拉取仍由「切到那个 tab」触发。被滑走的页会离开组合，滚动位置随之丢掉——这与
以前 `when (tab)` 的行为一致，不是 pager 带来的回退。页内的横向手势现在归 pager，因此也不会再漏给工作台的
抽屉手势。其他 `SettingsSegmented`（文件搜索的 文件名/内容、后端来源的 CLI/自定义）是同一页里的模式开关，
不是 tab，仍留在原处。

### 图片查看页

- 预览窗口由工作台或独立快捷聊天窗口统一持有，缩略图只提交 URL、文件信息与下载操作。聊天列表因键盘收起、
  跟随新消息滚动而回收来源图片行时，预览继续显示；切换会话、页面或服务时清除预览。
- 全屏铺满：查看页是自己的窗口，**关掉平台 inset**。Android 的 dialog 用 `decorFitsSystemWindows=false`，
  skiko 两个平台（desktop / iOS）用 `usePlatformInsets=false`，两边参数名不通用，所以有
  `viewerDialogProperties()` 这个 expect/actual 接缝。黑底一直铺到状态栏和手势条，不再出现上下两条背景色
  「灰条」。
- 图片占满整屏、不裁切（`ContentScale.Fit`），顶部没有任何控件。文件名、路径（等宽小字）和操作都在底部一条
  轻量渐变信息条里（底部黑色最高 38%，顶部留白 20dp）：`下载`（只有带路径的项目文件才有，实心白胶囊）与
  `关闭`（半透明胶囊）。手势条那条 inset 由信息条自己用 `WindowInsets.safeDrawing` 让开。
- 底栏之外点击仍然退出查看；底栏里的两个按钮自己吃掉点击，所以瞄准 `下载` / `关闭` 不会误退出（这与以前顶部
  工具栏的行为一致）。捏合缩放、放大后拖动、失败态与加载态都不变。

### 下载页

下载不再走通知栏，进度和管理都在应用内（`DownloadCenter` + `DownloadsScreen`）：

- 入口：侧栏底部设置左边的下载按钮（有下载在进行时带一个小圆点）。开始、完成、失败时顶部弹 3 秒的
  提示条，点它进入下载页。
- 每一行显示文件名、状态（百分比与大小 / 大小、完成时间、保存位置 / 失败原因）、项目与路径，进行中有
  进度条（服务端没给长度时是不确定进度条）。操作：进行中可取消；失败或取消的可重试；已保存的点一下
  用系统打开（`ACTION_VIEW` + 选择器），菜单里有打开、移出列表、删除文件（MediaStore 删除，需确认）。
  标题栏「清除记录」移除所有已结束的行，不删文件。
- 排版与设置页同一套语汇：一叠卡片（`RiffetRadius.xl` 圆角、1dp `line` 细边、8dp 间距、12dp 内边距），
  失败的行边线染 `danger`（35% 透明度），行首是 38dp 的状态色块。项目与路径用 `monoSmall`，和正文分开。
- 进行中的卡片把进度条单独放一行：条占满整行，百分比写在条右侧（40dp 定宽、右对齐，位数变化时不左右
  抖动），条高 5dp、两端圆角，百分比变化用 420ms 补间滑过去（服务端的进度本来就按整数百分比节流，
  直接跳会显得一跳一跳；减弱动效时为 0）。状态行只留字节数，不再重复百分比。
- 行尾的操作按钮统一 34dp 圆形，并且**只画当前状态真正有的按钮**，不为「更多」预留等宽占位：进行中只有
  ✕，失败/取消是重试 + ⋯，已保存是打开 + ⋯。以前进行中那行会留一个 40dp 的空位给永远不会出现的 ⋯，
  ✕ 因此离右缘很远、右侧看着空一块。
- 列表上方固定一行统计（`共 N 项 · N 项进行中` ＋ 右侧文件夹图标与 `下载/Riffet`），列表在它下面滚动，
  所以保存位置始终可见；顶部提示条复用设置页的 `SettingsMessageBanner`。
- 下载跑在 `DownloadCenter` 自己的 scope 上，离开发起的页面不会中断；历史（最多 100 条）存在本机偏好里，
  进程被杀时还在跑的那条下次启动显示为「下载被中断」，可重试。同一项目同一路径再次下载复用那一行。
- Android 的 MediaStore 同名编号用尽时，保留已有文件，并为这次下载追加唯一后缀重试；实际保存名称仍从 MediaStore 读取。
- 进度更新经 `DownloadProgressGate` 节流（新的整数百分比或未知长度时又过了 512KB，且距上次至少
  250ms）。旧版本建的通知渠道 `riffet.downloads` 在启动时删除。
- 旧 Compose iOS 的 `downloadsSupported = false` stub 继续保留；正式 iPhone 使用独立原生下载、Quick Look 和系统分享，不显示 Android 下载中心。

### 日志与导出

排查问题靠设备上的日志，不靠猜：`AppLog`（`shared/AppLog.kt`）把每行带毫秒时间排队，写协程每 300ms 批量
追加到私有目录的 `logs/current.log`，超过 2MB 滚到 `logs/previous.log`，两份封顶。设置 →「诊断与日志」→「日志」
里的「导出日志」把两份合并存进 下载/Riffet 并弹出系统分享；「清空」删掉两份。「上传日志到服务端」把同样的内容
POST 到 `/api/client-logs`，服务端存进状态目录下的 `client-logs/`（默认 `~/.local/share/riffet/client-logs`，
文件名以上传时间开头，保留最近 20 份），排查的人直接在那台电脑上读，不必再经手机转发文件。

记录的环节（标签）：

- `stream`：每次拨号（尝试次数、路径）、响应状态与编码、**每个原始事件**（含 15 秒心跳 `ping`）的
  名字、字节数和解出的消息类型、看门狗超时、缺帧（`gap: server previous=… received=…`）、服务端关闭、异常、退避时长。
- `store`：每帧到达时一行摘要（Append 的序号范围与事件类型、Runs 里最后三条 run 的状态 / 投递 / 阶段 /
  是否已有 `nativeMessageId`、Session 状态与 `updatedAt`、Status 阶段）和处理完的耗时、时间线条数、末条；
  过期订阅丢弃的帧；`syncPending`；`openStream` / `select` / `retry` / `wake` / `clear`；连接状态；从设备
  恢复；列表轮询（以及它替换当前会话状态的时刻）；`working`（CLI 状态为 busy / attention，输入框停止
  按钮跟随它，与 web 一致；点停止调用 `/api/sessions/:id/cancel` 中断会话）；发送 / 接受 / 失败及耗时；
  取消与中断。
- `ui`：会话页每次布局变化（时间线、可见、行、条目数、末条目、「正在处理」是否显示、会话状态、运行中的
  run）；列表实际布局（总数、末个可见下标、能否下滚）；跟随到底的开关与触发。
- `app`：启动（版本、系统、机型）、前后台、保活、store 安装、轮询失败。

## 通知

移动端最难的环节。Android 退到后台后 SSE 连接会被挂起。

Riffet 的选择：**前台服务常驻 SSE 连接 + 本地通知**，不引入公网推送中继。

- 无云端依赖，符合 local-first 定位。Tailscale 是稳定的私有网络，比公网可靠。
- 代价：耗电，且需要 `FOREGROUND_SERVICE_SPECIAL_USE`（Android 14+）与 `POST_NOTIFICATIONS`（Android 13+）。
- **界面上必须诚实标注「常驻连接期间才有通知」**，不能描述成后台推送。这与 Riffet 既有的「精确与估算分得清」「读不到存储会明说」是同一条原则。

FCM 中转被明确排除：它需要一个公网可达的中继服务和 Google 服务，与本地优先的定位冲突。

**iOS 例外：服务端直连 APNs。** iOS 挂起后台 App，前台服务这条路不存在。Riffet 发布官方 iOS App（一个 Apple 团队），服务端的主人在「设置 › 设备管理 › 推送」放入该团队的 APNs 密钥（`.p8`）后，服务端用它直接向 Apple 发推送，中间没有 Riffet 的中继；没放密钥的服务端不推送，iOS 照旧只在前台发本地通知。自己签名构建的 App 同理：设备上报自己的 bundle id 作为 topic，主人放自己团队的密钥。推送内容只发给 Apple，不另做加密。规则与载荷见 DEVICES.md §3「后台推送」。Android 不变：没有 FCM，仍是前台服务。

因此常驻连接的可靠性就是通知与设备能力的可靠性。路线 R0 的保活（Android）：

- **前台服务类型改为 `specialUse`**：`dataSync` 在 Android 15+ 每天上限 6 小时，到点 `onTimeout` 只能停掉服务，
  与「后台 24 小时不掉线」冲突。App 侧载分发，不经 Play 审核，`specialUse` 只需声明权限与
  `PROPERTY_SPECIAL_USE_FGS_SUBTYPE`。Manifest 同时声明 `dataSync|specialUse`：Android 14+ 用 `specialUse`，
  更早的系统没有该类型，仍用 `dataSync`（那里也没有时长上限）。`onTimeout` 保留，记日志后立即停止。
- **设置 › 通知与后台 › 后台运行**：「忽略电池优化」显示状态，未允许时用系统对话框申请
  （`REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`）；「允许后台运行」打开厂商页，并写明该打开哪个开关；有独立
  自启动页的厂商（OPPO / realme / 一加、小米、vivo）再给「自启动」。厂商页按顺序逐个尝试，只启动能解析、
  已导出且无需额外权限的那个，都不行就打开本应用的系统详情页；包名列在 Manifest 的 `<queries>`。
  ColorOS 与 One UI 的后台开关在应用详情（ColorOS：耗电管理 › 允许后台行为），所以「允许后台运行」
  直接去详情页。参考 dsh-go 的 `VendorSettings` 设计，不复用代码。
- **后台被断网的提示**：前台服务在跑、App 在后台时，系统报告本应用网络被拦截（`onBlockedStatusChanged`），
  或在有网的情况下连续 2 次读列表失败，回到前台时记下；后者还要等回前台后第一次读取成功（排除 Mac 本身不可达）。
  记下后设置首页「通知与后台」的摘要和该页底部各显示一行，点开任一保活设置即消失。只在本进程内记住。
  它只说「离开 App 后连接曾中断」，不猜原因。

具体行为（Android，`RiffetHost` / `RiffetNotifier` / `RiffetNotificationReceiver`）：

- **状态轮询与 web 一致**：和 web 一样读 `/api/sessions`，按 `Session.state` 的变化提醒：运行中 → 空闲
  是「完成」，进入 `waiting` 是「等待确认」，进入 `failed` 是「失败」，运行中被中断是「已中断」。
  第一次看到的会话和归档会话不提醒。轮询间隔：前台 5 秒，有会话在跑 10 秒，其余 30 秒；后台且没有
  活跃会话也没有打开的流时不轮询。正在看的那个会话不发通知，改为触觉反馈。
- **前台服务**：有打开的流**或**任一会话在运行/等待时常驻，常驻通知（渠道「运行状态」）显示正在跑的
  会话、当前步骤和计时；Android 16 上申请升级为状态栏胶囊（`requestPromotedOngoing`）。
- **在通知里处理**：等待确认的通知带最多 3 个按钮（审批的操作，或单选问题的选项，选项更多时只能点开
  处理），提交后若还有下一个问题就接着显示；完成通知带「回复」输入框，发送走与输入框相同的
  outbox。点通知打开对应会话。会话离开 `waiting`（比如在别的设备上处理了）时撤掉它的确认通知。

## 网络接入

推荐 Tailscale，不自建 TLS。

服务端只监听 loopback，由 `tailscale serve` 终结 TLS 并注入身份头，得到 HTTPS、跨网段访问和稳定主机名。
自签证书加指纹固定虽然可行，但要求客户端实现证书 pinning，并让服务端承担证书生命周期，收益不抵成本。

**绝不要 `tailscale funnel`**：那会把端口暴露到公网，而 `serve` 只对私有 tailnet 开放。

局域网直连（`--host 0.0.0.0`）仍然支持，此时令牌在局域网内是明文传输，这是需要机主知情接受的取舍。

### scheme 由服务端决定，不由客户端假设

客户端**不假设**用 http 还是 https，因为只有服务端知道。服务端自己没有证书，TLS 由前置的那一层提供，
而那一层是唯一知道手机将使用 HTTPS 的一方。

`POST /api/pairing/code` 因此返回一个 `scheme` 字段，并把它写进二维码载荷
（`{"v":1,"scheme":"https","host":…,"port":…,"code":…,"name":…}`）。判定顺序：

1. 请求本身就是 TLS（`request.protocol === 'https'`）；
2. `X-Forwarded-Proto: https` —— `tailscale serve` 与反向代理用它转发原始 scheme；
3. 其余一律 `http`。

只有在 `Host` 已通过 `checkOrigin`（即机主显式允许过的名字）时才会走到这里，所以不需要打开 Fastify 的
`trustProxy`：伪造该头最多让二维码写上一个本机并不提供的 scheme，结果是连不上，而不是泄露什么。

客户端侧：`PairingPayload.scheme` 只接受 `http` 与 `https` 两个值，其余一律回落 `http`，因此服务端
返回的内容无法被拼进 URL 变成别的东西；二维码里没有这个字段时（旧服务端）也照样能配对。
手输地址时 `https://` 会被保留，裸地址仍是 http。


## 时间线的第二实现

`apps/web/src/app/session/buildTimeline.ts` 的 `buildTimeline` 约 200 行，加上 `timelineTurns.ts`、`nativeTimeline.ts`、`subagents.ts`、`speed.ts`，
是需要手工移植到 `core/` 的逻辑。这是本项目最大的单点漂移风险：web 侧规则一改，客户端不会跟着变，而且不会有测试报错。

处理方式：

- `scripts/gen-timeline-fixtures.ts` 用 web 的 `projectEvents`、`buildTimeline`、`timelineTurns` 跑一组代表场景，期望结果写进 `core/src/commonTest/.../TimelineFixtures.kt`；`TimelineFixtureParityTest` 用 `core` 跑同一批输入，逐行比对行、顺序、key、所属回合与进行中的回合。改了任一端的规则后执行 `pnpm gen:timeline-fixtures`，CI 的 `gen:timeline-fixtures:check` 拦下过期的 fixture；
- 在本文与代码注释里明确标注 `core/` 是 `buildTimeline.ts` 的第二实现，修改时间线规则时必须同时改两处。

每一端内部原本还有一层漂移：流式 `append` 走增量插行（只改动变化的行），重连与 runs 变化走 `buildTimeline` 全量重建。
两条路径一旦算得不同，增量路径的错误就会一直留在屏幕上，直到下一次重建。曾经出现过两例，web 与客户端都有：
`buildTimeline` 改为把已结束的斜杠命令按时间归位后，增量路径仍把它当作插入锚点，整轮流式内容都插进了历史中间；
另一例是待配对的用户消息按 run id 回显时没有及时配对，同一条消息短暂显示两次。

现在只有一条路径（`nativeTimeline.ts` 与 `NativeTimeline.kt` 相同，做法参考 opencode）：事件仍然增量投影，
时间线行则每次都由 `buildTimeline` 完整算出，未变的行复用原对象，渲染层据此跳过它们。751 行一次约 6ms。

把投影下沉到服务端可以彻底消除这个问题，但参考项目没有这样做的，且会波及 `apps/web`，因此不采纳。

## 参考项目

| 项目 | 客户端 | 服务端 | 借鉴点 |
| --- | --- | --- | --- |
| [AltanS/collie](https://github.com/AltanS/collie) | PWA | Bun bridge | 设备配对作为写凭证、Tailscale 部署、轮询快照 |
| [K9i-0/ccpocket](https://github.com/K9i-0/ccpocket) | Flutter | Node bridge | 二维码配对、mDNS、离线消息队列、断线补流 |
| [dzianisv/opencode-mobile](https://github.com/dzianisv/opencode-mobile) | React Native | 复用自带 server | 生物识别、Keystore、三渠道分发 |
| [termux/termux-app](https://github.com/termux/termux-app) `terminal-emulator` | Android（Java） | — | VT 引擎，移植为 `apps/mobile/terminal`（Apache-2.0，见其 `NOTICE`） |
| [farlume/termish](https://github.com/farlume/termish) | Compose Multiplatform | — | 终端输入法管线与 resize 的设计参考 |
| [ccch1mneyyy/dsh-go](https://github.com/ccch1mneyyy/dsh-go) | Flutter（AGPL-3.0） | DSH 引擎 | 厂商保活设置直达与后台断网检测、通知审批与锁屏处理、小米焦点通知等厂商岛、动态快捷方式与 deep link、崩溃分类与诊断脱敏、应用内更新的签名预检；只参考设计，不复用代码 |
| [wangzan101/Mika](https://github.com/wangzan101/Mika) | Kotlin + Compose | 无（端上模型） | 无障碍与 shell 辅助进程、后台虚拟屏、唯一执行入口、精确闹钟与恢复；见 [DEVICES.md](DEVICES.md) §8 |

终端的设计、选型理由与进度在 `docs/MOBILE-TERMINAL.md`：引擎是 Termux `terminal-emulator` 的 Kotlin `commonMain` 移植，
以 tmux 自己的 `capture-pane` 为准逐格对拍；渲染与输入是自写的 Compose 实现。

## 分期与验收

| 阶段 | 内容 | 验收标准 |
| --- | --- | --- |
| P0 | 服务端 S1–S5；客户端 Gradle 骨架、`contracts`、认证层 | 手机扫码配对拿到设备令牌并读到真实项目列表；`curl -H "Authorization: Bearer …" /api/bootstrap` 同样通过 |
| P1 | SSE、`reset`/`append`、重连；`core` 时间线投影；设计系统；会话列表与时间线 | 实时看到 Mac 上运行的会话；锁屏 5 分钟回来位置不错乱 |
| P2 | 输入、发送、排队、打断；审批与提问卡片；模型与权限 | 手机上发的消息 Mac 上的 CLI 真的收到并回复；点批准 CLI 真的放行 |
| P3 | 终端（`docs/MOBILE-TERMINAL.md`）；文件与 Git 面板；设置；通知 | 手机上按 Esc 与方向键在 TUI 中真的生效 |
| P4 | 原生 `iosApp/Riffet`、RiffetKit、Keychain、系统能力与远端工作流 | SwiftUI/UIKit 界面共享 client/core/contracts；签名模拟器自动化与真实 Mac / iOS 18 验收分开记录，详见 `IOS.md` |

## 路线

2026-11-04 确定，2026-11-10 修订验收。R0 与 R1 互不依赖，可以并行；R2 起依赖 R1 的 Riffet MCP。设备相关设计见 [DEVICES.md](DEVICES.md)。

进度（2026-11-10）：R0–R3 代码已合入（R0 缺厂商岛）。真机上跑通了 T0 通知、剪贴板，T1 的读屏、点按，以及发送前在手机上确认（系统「信息」，测试机无 SIM 卡未实际发出）；其余验收标准（24 小时不掉线、20 分钟后提醒、拍照回传）还没在真机上跑过；R4、R5 未开始。

| 阶段 | 内容 | 验收标准 |
| --- | --- | --- |
| R0 地基 | 保活引导（见「通知」）；接入生物识别；厂商岛（小米焦点通知、ColorOS 流体云等）；崩溃记录与诊断脱敏；动态快捷方式、`riffet://` deep link、多文件分享进 App；首页导航改版（见下） | 主流国产 ROM 后台连续 24 小时不掉线；会话可在全屏列表中搜索到 |
| R1 Riffet MCP + 会话唤醒 | 按次启动注入 MCP（先 Claude、Codex）；基础工具（一次性唤醒、通知）始终带上；按对话选择可操作的设备（输入框「技能与工具」）与会话快照 | 任意端说“20 分钟后提醒我 X”可完成；不选设备的对话不含设备工具 |
| R2 设备通道 + T0 | 设备能力与在线状态、定向调用队列、预约唤醒；定位、剪贴板、拍照、通知、Intent | Agent 能请求手机拍照并收到图片；定时调用到点时手机在线 |
| R3 T1 无障碍操控 | AccessibilityService、观察与动作工具、`ActionGate`、预授权、按 App 授权、接管；App 知识与 skill 下发给服务端 Agent | 手机解锁亮屏时，“打开微信给 X 发一条消息”立即执行端到端完成，发送前在手机上确认 |
| R4 T2 特权 + 后台屏 | 特权后端：服务端 adb 引导 → Shizuku → App 内配对；Android 14+ 后台虚拟屏；画面推流到手机画中画与 Web 右侧区；锁屏解锁（可选，默认关） | Agent 操作时用户照常使用手机；到点手机已锁屏时，“20 分钟后打开微信发一条消息”按预授权完成（锁屏下后台屏是否可用需实测，不可用则依赖可选的解锁） |
| R5 助理形态 | 悬浮胶囊（双击发送当前屏、长按说话）、语音、设备触发器（到达某地、充电、收到某类通知）唤起会话；iOS 对齐 AppIntents 与 Live Activities | 不打开 App 也能把事情交给 Agent |

### 首页导航（R0）

已完成，设计见上文「首页导航：底栏三个 tab」与「会话列表的两种排布」。

- 底栏三个 tab：**新会话 / 任务 / 设置**（`RiffetTabBar`，图标加短标签），只在三个根页上出现，「任务」显示待处理数量角标，记住上次的 tab。
- 「新会话」是起始页 `ProjectHome`：只有新建任务，输入框位置不变。
- 「任务」是全屏列表：搜索（会话名、项目、标签与本机消息全文）、筛选（全部 / 运行中 / 待处理 / 已归档）、
  筛选菜单里的排列方式与项目范围、待处理与置顶分区。复用 `SessionRow`、两种排布与归档规则（原 `Sidebar.kt` 迁为 `SessionList.kt`）。
- 左抽屉只放服务器切换、收藏、下载、统计；会话详情右抽屉保留。进入会话后隐藏底栏。
- 第四个 tab 等 R1/R2 有内容后再加，承载定时与唤醒、设备能力开关、按 App 授权、操作记录与后台屏画面；不放占位页。
- 平板按窗口宽高选择侧边导航与列表／会话双栏；折叠屏按真实铰链划分可用屏段，模型面板与确认弹窗落在来源所在屏段。分屏缩小时回到单栏。

## 风险

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| `buildTimeline` 双实现漂移 | 客户端与 web 不一致，且无测试报错 | `TimelineFixtureParityTest` 对拍 web 生成的 fixture，CI 检查 fixture 是否过期 |
| 终端引擎移植引入缺陷 | 终端画面错乱 | Termux 原有单元测试全部移植；`TmuxParityTest` 用录制的真实流与 tmux 的屏幕逐格对拍 |
| `allowedHosts` 启动时固定 | 换网后连接被拒 | 使用 mDNS 名或 Tailscale 名；`riffet doctor` 主动检测 |
| 长连接 gzip | 移动网络下解压异常 | 开关化，默认开启 |
| 附件 base64 与 24 MiB 上限 | 低端机内存溢出 | 客户端降采样与分片 |
| Android 前台服务限制 | 通知不可靠 | 界面明确标注限制；R0 保活引导；设备调用用预约唤醒 |
| 手机能力被会话滥用或被屏幕内容诱导 | 误发消息、误操作 | 设备侧唯一执行入口、不可逆操作预授权或现场确认、花钱交给用户；见 DEVICES.md §5 |
| 无障碍自动化不符合 Google Play 政策 | 无法上架 Play | 仅侧载分发 |

## 如何验证

服务端与设计 token：

```bash
pnpm typecheck                                   # 含服务端、web、scripts
pnpm test                                        # 全量 vitest
pnpm gen:theme:check                             # 设计 token 是否与 index.css 同步
```

移动端（在 `apps/mobile` 内，需要 JDK 21+ 与 Android SDK；iOS 还需要 macOS 与 Xcode）：

```bash
cd apps/mobile
./gradlew :contracts:jvmTest :core:jvmTest :client:jvmTest :shared:jvmTest :terminal:jvmTest  # 共享逻辑与离屏交互
./gradlew :androidApp:assembleDebug              # 产出 androidApp/build/outputs/apk/debug/*.apk
```

Debug 构建默认使用仓库中的 `apps/mobile/androidApp/signing/debug.keystore`。相同 application ID 下，
不同开发机出包后可覆盖安装；新 checkout 无需个人签名配置，也不依赖各机器自动生成的
`~/.android/debug.keystore`。证书指纹为：

| 算法 | 指纹 |
| --- | --- |
| SHA-1 | `38:86:E5:31:F2:8C:4D:FA:07:BA:E3:30:0F:25:42:6F:AA:95:CD:B4` |
| SHA-256 | `C6:69:DF:6C:19:15:C7:80:AB:11:ED:0C:11:99:7E:F1:DC:72:DC:C1:52:7B:9B:3A:FD:00:41:D2:CB:39:DA:8B` |

该 keystore 的 alias 为 `androiddebugkey`，store password 和 key password 均为 `android`，属于公开测试
配置。仓库读者可以制作覆盖已有 debug 版的 APK，这把 key 不再作为秘密，也不用于正式发布。
Release 使用独立、保存在仓库外的签名 key 与配置。`.gitignore` 只对上述 debug keystore 开例外，
其他 keystore 仍忽略。

正式应用 ID 为 `io.github.riffable.android`，release 证书 subject 为 `CN=Riffet, O=riffable`。
GitHub Actions 从仓库 secrets `ANDROID_KEYSTORE_BASE64`、`ANDROID_KEYSTORE_PASSWORD`、
`ANDROID_KEY_ALIAS`、`ANDROID_KEY_PASSWORD` 读取签名材料；发布工作流会核对 APK 的证书 subject。

已配置发布签名的 Mac 使用 `~/.config/riffet/android-signing/riffable-release.jks`，alias 为
`riffet-release`，口令保存在登录钥匙串的 `io.github.riffable.android.release-signing` service 中，
account 与 alias 相同。手动构建 release 时，在 `apps/mobile` 下执行：

```bash
(
  set -e
  export RIFFET_SIGNING_STORE_FILE="$HOME/.config/riffet/android-signing/riffable-release.jks"
  export RIFFET_SIGNING_KEY_ALIAS=riffet-release
  RIFFET_SIGNING_STORE_PASSWORD="$(security find-generic-password -s io.github.riffable.android.release-signing -a "$RIFFET_SIGNING_KEY_ALIAS" -w)"
  test -n "$RIFFET_SIGNING_STORE_PASSWORD"
  export RIFFET_SIGNING_STORE_PASSWORD
  export RIFFET_SIGNING_KEY_PASSWORD="$RIFFET_SIGNING_STORE_PASSWORD"
  ./gradlew :androidApp:assembleRelease
)
```

需要覆盖 debug keystore 路径时，可在个人 `GRADLE_USER_HOME/gradle.properties`
（未设置 `GRADLE_USER_HOME` 时为 `~/.gradle/gradle.properties`）中指定：

```properties
riffet.debugSigning.storeFile=/absolute/path/to/riffet-debug.keystore
```

也可通过 `RIFFET_DEBUG_SIGNING_STORE_FILE` 环境变量指定；`riffet.debugSigning.storeFile` property 优先。
该设置仅覆盖 debug 的 keystore 路径，沿用上述 alias 与 debug 凭据，不改变 release 签名配置；未设置时
使用仓库中的统一 debug key。出包前可在 `apps/mobile` 下运行 `./gradlew :androidApp:signingReport`，
出包后用 `apksigner verify --print-certs <APK路径>` 核对证书。指纹不匹配时，优先核对仓库 key 及个人
property、环境变量覆盖，不将卸载重装作为默认处理，避免丢失设备配对和本地数据。

`contracts`、`core` 与 `shared` 都声明了 `jvm()` target，所以网络层与时间线投影这类逻辑可以在
没有 Android SDK 的机器上编译和测试。`assembleDebug` 会连带编译三个库模块的 Android target，
因此它同时验证 `Platform.android.kt`、`RiffetSystemBars.android.kt`、`TimelineClock.android.kt`
这些只在 Android 上存在的实现——只跑 `jvmTest` 是看不到它们的。

`:shared:jvmTest` 包含离屏图标渲染与真实指针事件测试；测试源集通过 `compose.desktop.currentOs`
自动引入当前主机的 Skiko 原生库，无需额外 init script。`PageHostTest` 覆盖整页位移、回拉取消、父页草稿与滚动保留、
横向/竖向滚动仲裁、边缘热区、嵌套系统返回和未保存保护。`:client` 的 `SettingsControllerTest` 覆盖独立加载、失败重试和保存回执。
这些是共享逻辑与 Android Compose 交互验证；Android 系统手势手感与厂商行为仍需真机检查。iPhone 正式工程另用 Xcode 构建，App-hosted XCTest / 网络 UI 测试与真机步骤见 [iosApp README](../apps/mobile/iosApp/README.md)。Keychain 验收必须使用具备应用身份的签名测试进程，无签名 build 不能替代。

### 三个会骗人的绿灯

1. **iOS 目标在非 macOS 主机会被静默跳过。** `:shared:compileKotlinIosSimulatorArm64` 在 Linux 上
   打印 `SKIPPED` 并返回 `BUILD SUCCESSFUL`，产物是 0 个 klib。**`SKIPPED` 不是通过。**
   iOS 是否可编译只能在 macOS 上判断，或用 `find apps/mobile -name '*.klib'` 检查产物存在。
2. **AGP 9.3.1 需要 SDK 平台 `android-37` 与 build-tools 36.0.0。** SDK 已接受许可时 AGP 会在首次构建时
   自动下载；离线或许可未接受时得到 `Failed to find …`，而这个错误在配置阶段才出现，看起来像依赖问题。
   在本机 Android Studio 的 SDK Manager 里装上即可；`apps/mobile/local.properties`
   （未纳入版本控制）可以指向别的 SDK。
3. **`dev/` 里过期的探针会让整个 `:shared:jvmTest` 编译不过。**
   `jvmTest/kotlin/riffet/ui/dev/`（在 `apps/mobile/shared/src` 下）是本地私有的探索性测试，由
   `.git/info/exclude` 排除，不在仓库里也不进 CI——但它仍在 `jvmTest` 源集里，只要其中一个文件
   引用了已经不存在的符号（例如 0a6033c 删掉的 `riffet.ui.timeline.onAnyTap`），
   `:shared:compileTestKotlinJvm` 就会失败，整个 `:shared` 的测试一个都跑不起来，看起来像代码坏了。
   报错全部落在这个目录里就是它；`git check-ignore -v <文件>` 可以确认该目录只是被本地排除。

### 工具链与模块结构

版本全部在 `apps/mobile/gradle/libs.versions.toml`，文件头写了取新版本前要核对的两条：库的 `.module` 里
`kotlin-stdlib` 不高于本项目的 Kotlin，JVM/Android 构件的 class 文件版本不高于构建所用 JDK（17）。
当前是 Kotlin 2.4.20、Compose Multiplatform 1.12.1、AGP 9.3.1、Gradle 9.7.0。

- CMP 1.12 在 Android 上依赖的 androidx Compose 1.12 要求 AGP ≥ 9.1、compileSdk ≥ 37，所以 AGP 9 是被动要求。
- AGP 9 不允许同一模块同时用 `org.jetbrains.kotlin.multiplatform` 与 `com.android.library` /
  `com.android.application`：`contracts`、`core`、`shared` 用 `com.android.kotlin.multiplatform.library`
  （Android 配置写在 `kotlin { android { … } }` 里，没有顶层 `android {}`；`shared` 打开了
  `androidResources` 以放通知图标），`androidApp` 是纯 Android 模块，源码在 `src/main`，Kotlin 由 AGP 内置编译。
- CMP 1.11 起不再支持 `iosX64`（Intel Mac 模拟器），模块只声明 `iosArm64` 与 `iosSimulatorArm64`。
- markdown 渲染器停在 0.39.2：0.40 起是 Java 21 字节码，升级它要先把构建 JDK 换成 21。
- `targetSdk` 仍是 35：提高它会让应用接受 Android 16/17 的新运行时行为，需要真机验证后单独改。

配对与发现：

```bash
riffet start --host 0.0.0.0 --auth               # 局域网监听（自动要求令牌）
riffet pair                                      # 打印地址、一次性码和配对二维码
riffet doctor                                    # 检查 tmux、CLI 与 Tailscale
```

`riffet status` 在监听地址是 loopback 时**不会**打印二维码 —— 手机根本无法连接到
`127.0.0.1`，生成一个连不上的码只是在骗人。此时它会提示改用 `--host 0.0.0.0` 或
`tailscale serve`。



### 2026-10-09 下载页：安装 APK 与删除文件

- `.apk` 文件在保存和打开时统一使用 APK MIME 类型，兼容之前按二进制或 ZIP 类型保存的记录。点击进入
  非导出的 `InstallDownloadActivity`，先检查安装来源权限；需要时打开系统授权页，返回后继续交给系统安装器。
  拒绝授权、文件不存在或安装器不可用会明确提示；最终安装确认仍由系统负责。流程依据
  [Android 安装来源权限说明](https://developer.android.com/reference/android/content/pm/PackageManager#canRequestPackageInstalls())。
- Android 10 以前的私有下载通过只覆盖 `Download/Riffet/` 的 FileProvider 交给外部应用，避免 `file://`；
  新下载同名文件使用独立路径，防止删除旧记录误删新文件。
- 已完成下载右侧「⋯ → 删除文件」保留确认后删除文件和记录；「移出列表」「清除记录」只清记录。
  删除失败保留记录并显示错误。删除任务与同一条目的重新下载互斥，过期确认不会删除新的下载。
- Android 10+ 通过 MediaStore 删除本应用创建的下载。权限失效或旧文件句柄不可用时，打开系统文件选择器，
  用户选中对应文件后通过 `DocumentsContract.deleteDocument` 继续删除；取消授权保留文件和下载记录。
  只请求所选文件的访问权，依据 [Android 文件访问说明](https://developer.android.com/training/data-storage/shared/documents-files)。
  删除结果使用平台接口返回值，不再要求内容 URI 的文件描述符满足原生文件系统的链接计数变化。
- 验证覆盖 APK 类型识别、删除成功／失败与重试竞争；Android 构建及合并清单校验通过。当前无连接设备，
  尚未实机验证厂商安装器和授权页返回行为。
