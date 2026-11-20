# Riffet macOS 客户端

测试维护遵循 [AGENTS.md](../AGENTS.md#测试与验证)：非必要不增加测试。原生 UI 展示与布局测试已移除，macOS XCTest 仅保留凭据作用域隔离，协议、持久化和恢复由共享层及服务端核心测试覆盖。下文测试数量与 UI 验收结果均为历史记录。

原生 macOS 客户端（SwiftUI + AppKit），支持 macOS 15 及以上与 Apple Silicon；系统界面跟随运行的系统，
自定义的玻璃表面在 macOS 26 以前退为材质（见「窗口与布局」）。它与 Android / iPhone 远端客户端最大的不同：
**它和服务端在同一台 Mac 上**，所以既是一个客户端，也是本机服务的托管者。它也可以连接任意机器（Mac 或 Linux）上的服务器，
并记住多台服务器、随时切换，网络层与手机是同一套；见 [远程访问](guide/remote-access.md)。iPhone 已采用 SwiftUI / UIKit + 同一 RiffetKit 共享逻辑，最低 iOS 18.0；平台布局与验收见 [IOS.md](IOS.md)，不影响本文 macOS 的系统基线与本机服务托管职责。

本文是设计契约，是 `docs/MOBILE.md` 的姊妹篇。M0–M4 已在 2026-10-12 实现，与设计不同的地方在正文里改正，
验证范围与未验证项见文末「实现记录」。调研日期 2026-10-12；文中版本号、星数和发布时间均在当日从
GitHub API 与官方文档取回核对，取不到或只有二手来源的写明「未验证」。`apps/web` 与 `apps/mobile` 的现有行为
不因本项目改变；服务端与 Gradle 的改动都是增量的。

## 0. 结论

1. **界面用 SwiftUI + AppKit 原生实现，不复用 Compose 界面。** Compose Multiplatform 在 macOS 上只有 JVM
   桌面一条路（Skia 自绘，包体与冷启动都是 JVM 量级），没有 macOS 原生界面目标；现有 Compose 界面也是按手机
   布局写的（抽屉、触摸手势、304dp 侧栏），桌面端本来就要换布局。
2. **逻辑复用 KMP，不在 Swift 里重写。** 时间线投影已经有 web 与 Kotlin 两份实现，`docs/MOBILE.md` 把它列为
   最大的漂移风险；Swift 再写一份就是三份。`contracts`、`core` 与从 `shared` 拆出的 `:client`（会话状态、
   缓存、网络、SSE、终端连接）增加 `macosArm64` target，经 **SKIE** 导出给 Swift。
3. **SKIE 而不是 Swift Export。** Swift Export 在 Kotlin 官方文档中仍是 Alpha，只支持 direct integration，
   泛型会被擦除到上界；SKIE 0.10.15（2026-09-25）已支持 Kotlin 2.4.20，提供 `sealed` → Swift `enum`、
   `Flow` → `AsyncSequence`、`suspend` → `async`，正好覆盖 `SessionStore` 的 `StateFlow` 状态面。
4. **客户端托管本机服务。** 通过 `SMAppService.agent` 注册 App 内置的 LaunchAgent，关窗口不影响 Agent 运行；
   发现已有的 `riffet` 守护进程或 `local.riffet` 登录服务时直接接管，不起第二个。
5. **本机免配对，不改服务端协议。** 同一用户可以读取状态目录里 `0600` 的 `access-token`（或在免令牌模式下直接
   拿到 cookie），走现有的 `/api/pairing/code` + `/api/devices/pair` 换设备令牌，存进 Keychain。
6. **终端第一期用 SwiftTerm，libghostty 作为升级路线。** SwiftTerm 的输入法、选区、无障碍都是原生的；cmux
   已经证明 libghostty 可以嵌入第三方 App，但需要 Zig 工具链且接口未稳定。
7. **内嵌官方 `node` 可执行文件 + 服务产物 + `node-pty`，不做单文件编译。** 单文件（Node SEA / Bun）是之后的
   体积优化，不是第一期的前提。
8. **工程用 XcodeGen 生成，Sparkle 更新，Developer ID 签名公证，Homebrew cask 分发。** 不开 App Sandbox。

## 目标与非目标

**目标**

- 打开即用：本机服务没跑就托管起来，已经在跑就接上；不扫码、不输令牌。
- 对话时间线的内容与排序与 web、手机一致，复用同一份投影代码与 fixture。
- 像一个 Mac 应用：菜单栏常驻、可操作通知、全局快捷提问、⌘K、多窗口、拖放、Quick Look、Spotlight、快捷指令、小组件、共享扩展。
- 长转录（上千行富文本）滚动不掉帧，流式输出只重绘变化的行。
- 一条命令出 Release：构建、签名、公证、DMG，以及 Sparkle 更新包和签名后的 appcast 条目（appcast 本身见 [RELEASE.md](RELEASE.md)）。

**非目标**

- 不在 App 里重写服务端；服务端仍是 `apps/server` 的 Node 进程。
- 不做 App Store 版本：沙盒下无法调用 tmux 与各家 CLI、读写任意项目目录。
- 不支持 Intel Mac 与 macOS 15 以前的系统。
- 不把 Compose 界面嵌进 AppKit：macOS 上没有 iOS `ComposeUIViewController` 那样的官方桥接。
- 不为 Mac 新增独立的服务端协议；需要的只是少量增量字段（见「服务端改动」）。
- 不逐项复刻 Web（2026-11-20）：哪些原生实现、哪些转到 Web、已有页面怎么对待，见 [Mac 客户端范围规范](guide/mac-scope.md)。

## 选型

| 方案 | 原生程度 | 复用 | 结论 |
| --- | --- | --- | --- |
| Compose Desktop（JVM）跑现有界面 | 低：Skia 自绘、Material 外观，带 JVM 运行时；Liquid Glass、可操作通知、App Intents 都够不着 | 界面与逻辑全复用 | 不采用 |
| **SwiftUI/AppKit 界面 + KMP 逻辑（SKIE）** | 高 | 逻辑复用，界面重写 | **采用** |
| 纯 Swift 重写 | 高 | 只复用协议 | 时间线规则出现第三份实现，不采用 |
| 原生外壳 + `WKWebView` 嵌 web | 中 | web 全复用 | 只用于数学公式这类局部 |
| Tauri / Electron | 低 | web 全复用 | 与目标相反 |

macOS 上 Compose 的现状：Compose Multiplatform 官方只提供基于 JVM 的桌面目标；早期的 macOS native 实验开关
不是公开支持的路线（二手来源：[compose-multiplatform#4580](https://github.com/JetBrains/compose-multiplatform/issues/4580)，未逐条核对）。

## 架构

```
┌─ Riffet.app (macOS 15+, arm64) ──────────────────────────────────────┐
│  SwiftUI + AppKit                                                    │
│    ├─ 主窗口：侧栏 / 对话 / 检查器（变更·文件·终端）                  │
│    ├─ MenuBarExtra、全局快捷键、通知、App Intents、Spotlight         │
│    ├─ Timeline：NSTableView + SwiftUI 行                              │
│    └─ Terminal：SwiftTerm.TerminalView                                │
│  RiffetKit.framework   ← Gradle + SKIE（direct integration）          │
│    └─ :client  ⊃  :core  ⊃  :contracts                                │
│  Contents/Resources/server/  node + dist + node_modules(node-pty)     │
│  Contents/Library/LaunchAgents/<label>.plist  ← SMAppService.agent    │
└──────────────────────────────────────────────────────────────────────┘
        │ HTTP + SSE + WebSocket，Authorization: Bearer <device token>
        ▼
┌─ riffet server（本机 LaunchAgent / 已有守护进程 / 另一台机器）────────┐
│  Fastify + node:sqlite，tmux/PTY → cursor-agent/codex/claude/dsh/droid │
└──────────────────────────────────────────────────────────────────────┘
```

边界规则：**Swift 不解析协议、不投影时间线、不维护会话状态机**。这些都在 `:client`/`:core` 里，Swift 只订阅
状态、发命令、做平台能力。如果某个功能迫使 Swift 去读原始 `NativeStreamMessage`，说明边界漂了。

## Kotlin 侧改动

| 编号 | 位置 | 改动 |
| --- | --- | --- |
| G1 | `apps/mobile/client`（新模块） | 从 `shared` 移入不依赖 Compose 的逻辑：`ui/state/*`、`cache/*`、`stats/*`，`shared/` 下的 `RiffetApi`、`RiffetClient`、`RiffetConnection`、`NativeStream`、`TerminalConnection`、`StatsStream`、`Pairing`、`Dtos`、`Errors`、`Platform`、`AppPreferences`、`ServerDiscovery`、`RepairTranscript`、`AppLog`，`ui/composer/Outbox.kt`、`ClientIds.kt`、`ui/interaction/InteractionDraft.kt`。包名不变，`shared` 以 `api(project(":client"))` 依赖它，Android 与 iOS 代码不改。带 `expect` 的文件连同 android/ios/jvm 的 `actual` 一起移动，并补 `macosMain` 的 `actual` |
| G2 | 纯规则一并下沉 | 同样不依赖 Compose、Mac 端需要同一份规则的：`TimelineClock`、`TimelineFormat`、时间线分组 `TimelineRows.kt`（`rowGap` 用 `Dp`，留在 `shared` 的 `TimelineRowSpacing.kt`）、`SidebarModel`、`PickerOptions`、`DirectoryPaths`、`FileFormat`、`FileCache`，输入框 dock 的 `visibleTimeline` / `latestTodoEntries` / `latestGoal`（`ComposerDocks.kt`），Markdown 的公式与独立图片切分（`MarkdownSegments.kt`）。对应的纯逻辑测试一起移到 `client/src/commonTest`，在 JVM 与 Kotlin/Native 上各跑一遍 |
| G3 | 拆开的两个文件 | `AppLog` 的 `expect fun shareSavedFile` 依赖 `Downloads` 的 `SavedDownload`，这一个声明移到 `shared` 的 `Downloads.kt`；`PickedAttachment` 带 Compose 的 `ImageBitmap`，留在 `shared` 并实现 `:client` 的 `UploadableAttachment` 接口，`SessionStore` 收这个接口。`createNotifier()` 的 Android 实现用到 `shared` 的图标资源，`expect` 与三个 `actual` 留在 `shared` |
| G3a | 可见性 | 移入 `:client` 的 `internal` 声明改为 `public`：`shared` 的界面仍在调用它们。这是拆分中唯一的语义外改动 |
| G4 | `contracts`、`core`、`:client` | 增加 `macosArm64()`；Apple 两端共用 `appleMain`（时钟、ktor darwin 引擎）。`iosMain` 的时钟实现此前从未编译过，用 macOS 构建改正了 `NSDate` 的绑定 |
| G5 | `apps/mobile/client` | SKIE 0.10.15，`macosArm64` 产出静态 `RiffetKit.framework`，导出 `:core`、`:contracts` |
| G6 | `apps/mobile/gradle/libs.versions.toml` | 新增 `skie` |
| G7 | Swift 会调用的 `suspend` 函数 | `RiffetApi`、`SessionStore`、`RiffetConnection`、`MacHost` 的公开 `suspend` 函数加 `@Throws(Exception::class)`。没有声明时，Kotlin/Native 把服务端返回的错误当作未处理异常直接终止进程（实测：项目不是 Git 仓库时打开「变更」面板即崩溃）。在 JVM 与 Android 上只多一个 Java `throws` 声明 |
| G7a | `ui/timeline/TimelinePresenter.kt` | 转录的行、dock、「正在处理」与行间距标记在 `Dispatchers.Default` 上一起算（`presentTimeline` 是纯函数），来不及处理的帧合并（`conflate`），流式输出时主线程只收结果。`latestGoal` 先看 `data.kind` 再解析整条工具调用，避免每帧对所有工具行做 JSON 解析 |
| G8 | `client/src/macosMain/kotlin/riffet/mac` | `MacHost`（连接、`SessionStore` 与设备副本、会话列表轮询、终端连接工厂）、`SecretStore` / `ServerTokenStore`（按服务端分开保存设备令牌）、`byteArrayFromData`（附件一次拷贝）。`MacHost` 的协程作用域带异常处理器，后台失败只记日志 |

`:client` 的 `macosMain` 只放薄的 `actual`：文件（`~/Library/Caches/Riffet`、`~/Library/Logs/Riffet`）、
`NSUserDefaults` 偏好、outbox（`~/Library/Application Support/Riffet/outbox`，每条一个原子写入的文件）。
密钥由 Swift 实现 Kotlin 的 `SecretStore` 后注入。这个接口刻意是同步的：Swift 去实现带 `suspend` 方法的
Kotlin 接口要桥接完成回调，`DeviceTokenStore` 因此由 Kotlin 的 `ServerTokenStore` 包在 `SecretStore` 外面。

这次拆分也支撑 `iosApp`：iPhone 正式 App 使用 SwiftUI/UIKit 界面，iosArm64 / iosSimulatorArm64 导出同一 `RiffetKit`，由独立 IOSHost 装配 `:client`。Android 继续使用 Compose，平台 UI 不共享；协议、投影、缓存、outbox 与命令规则继续共享。详见 [iPhone 实现与验收](IOS.md)。

## 服务端改动

| 编号 | 文件 | 改动 |
| --- | --- | --- |
| S1 | `apps/macos/scripts/build-server-payload.sh`（新） | 产出 App 内置的服务载荷：校验过 SHASUMS256 的官方 Node（版本取自仓库根的 `.node-version`）、`dist/`（含 `dist/public`、`bridge-runtime`、`hook-cli.mjs`）、`dist/runtime-package.json` 列出的生产依赖（含 `node-pty` 的 darwin-arm64 预编译产物与 `katex`），其他平台的预编译产物删掉。该清单由 `pnpm build` 从打包结果推导，引用了未在 `dependencies` 声明的包时构建失败 |
| S2 | `apps/server/src/environment.ts` | 设置 `RIFFET_BUNDLED_NODE=1` 时，`nodeDirectories()` 不再把内置 node 的目录追加到终端与 Agent 的 `PATH`。它目前追加在末尾，不会遮住用户自己的 node，但用户没装 node 时 Agent 会用到 App 里的那份，这不是用户能预期的 |
| S3 | `apps/server/src/app.ts`、`version.ts` | `/health` 增加 `managedBy`（`cli` / `launchd` / `app`，来自启动器设置的 `RIFFET_MANAGED_BY`，读后从环境删除，子进程不继承）；`version` 改读 package.json |
| S4 | `apps/server/src/cli/` | `start` 与 `service install` 写入各自的 `RIFFET_MANAGED_BY`；App 的 LaunchAgent 已加载时 `service install` 拒绝再装 `local.riffet`；`status` 显示托管方；`stop` 遇到 App 托管的服务提示去 App 里停止（它本来就会因进程命令行不含 `dist/cli.js` 而拒绝发信号） |

本机免配对**不需要**服务端改动，见下一节。

## 本机免配对

`cli.ts` 打印配对二维码时走的就是这条路径，App 照做：

1. 读 `~/.local/share/riffet/daemon.json` 拿到 `host`/`port`/`instanceId`，`GET /health` 核对 `instanceId`；
2. 免令牌模式（`riffet` 快捷命令的默认，只监听 loopback）：`GET /api/auth/status` 直接下发 cookie 与 CSRF；
   需要令牌时读同目录 `0600` 的 `access-token`，`POST /api/auth/login`；
3. 带 cookie 与 CSRF `POST /api/pairing/code`，再 `POST /api/devices/pair` 换长期设备令牌；
4. 设备令牌存 Keychain（按服务端 `instanceId` 区分），之后所有请求只带 Bearer，与手机同一条认证路径。

主令牌只在内存里用一次，不落 App 自己的存储。设备出现在「设置 → 连接」的设备列表里，可以像手机一样撤销。

### 连接其他服务器

「设置 → 连接」列出「本机」和已配对的服务器（`SavedServers`，按添加顺序，保存在 `UserDefaults`；设备令牌按地址分开存 Keychain）：

- 当前服务器打勾，其他的点「连接」切换；切换时先关闭正在显示的服务器，本机服务继续运行。
- 已配对的服务器可以「忘记」：删除这台 Mac 上的设备令牌，并从列表移除。忘记的恰好是当前服务器时回到本机服务，并清掉 Spotlight 里的会话索引。「本机」不在列表里，地址跟随正在运行的服务，令牌在本机生成。
- 「连接服务器…」输入地址和 `riffet pair` 给出的配对码。把配对载荷（`{"v":1,"scheme":…,"host":…,"port":…,"code":…}`，即二维码内容）粘贴到地址框，地址、配对码和服务器名称一并填好。裸地址按 `http` 处理，`https://` 保留。配对成功后记住并切换到该服务器。
- 当前是远程服务器且不是 `https` 时，页面提示连接未加密，仅在可信网络中使用。

「设置 → 连接 → 设备 → 配对新设备」对**当前**服务器调用 `POST /api/pairing/code`，显示一次性配对码、二维码和地址，等价于在该服务器上执行 `riffet pair`；切换服务器会丢弃上一台的配对码。服务器只监听 loopback 时二维码只含本机地址，并提示其他设备无法连接。
地址取自这次连接实际使用的 `Host`：通过允许的域名或 HTTPS 前门连接时，二维码带的是该域名、scheme 和端口。

## 服务托管

### 启动时的判定

| 现场 | App 的行为 |
| --- | --- |
| `daemon.json` 指向的进程存活且 `/health` 的 `instanceId` 一致 | 接管：只做客户端，界面标出托管方（`riffet start` 守护进程或 `local.riffet` 登录服务） |
| 没有运行中的服务，`~/Library/LaunchAgents/local.riffet.plist` 存在 | 不注册第二个；提示「登录服务未运行」，提供「启动」（`launchctl kickstart`）与「改由 App 托管」 |
| 没有运行中的服务，也没有登录服务 | 引导用户开启「由 Riffet.app 托管」 |

主窗口在任何一种现场下都是真正的工作台（`AppModel.shell`），服务器的有无只决定它里面的内容：没有服务器时侧栏、新会话页、设置照常显示，
新会话页在输入框的位置放设置卡片（`SetupCard`：服务器、Agent、项目），其余需要服务器的页面显示 `NeedsServerView`。
上表里的「提示」「引导」都由设置卡片承担；只有这台 Mac 从未走过引导、没有保存的服务器、也没有在用的本机服务时，才先出现全屏引导
（`OnboardingView`，本机记一项 `riffet.onboarding.completed`，不写进服务器设置）。

**同一个状态目录只能有一个托管方。** 两个 `KeepAlive` 的 LaunchAgent 抢同一把 `server.lock`，结果是一个不停被
launchd 拉起又退出。「改由 App 托管」先做 `riffet service uninstall` 的等价动作（`bootout` 加删 plist），再注册
App 的 agent；反向切换同理。

### App 托管

- plist 放在 `Contents/Library/LaunchAgents/`，用 `BundleProgram` 指向内置 node，参数是
  `serve --state-dir … --host 127.0.0.1 --port 4337 --no-auth`（与 `cli/service.ts` 的 `serviceArgs` 一致），
  `KeepAlive` 与 `RunAtLoad` 打开，日志写状态目录的 `server.log`。
- `SMAppService.agent(plistName:).register()` 之后读 `status`；`.requiresApproval` 时引导用户去
  「系统设置 → 通用 → 登录项」放行，界面不能假装已经在跑。
- **环境变量**：`service install` 会把当时的环境快照写进 plist，App 内的 plist 是静态文件，做不到。这里依赖
  服务端自己的环境解析（`applyProcessEnvironment`），CI 的「The daemon starts with a bare PATH」已经覆盖
  裸 `PATH` 启动；M4 要在一台全新的 Mac 上实测 nvm/mise 安装的 CLI 能否被找到。
- 菜单栏与设置页提供启动、停止、重启、打开日志、`riffet doctor` 报告（`GET /api/doctor`）。

### 版本兼容

App 内置的服务端版本是确定的；接管的外部服务可能更旧或更新。App 读取 S3 的版本字段，低于最低兼容版本时
只读连接并提示升级，不尝试猜测协议。

## 客户端

### Swift 与 Kotlin 的边界

- SKIE 把 `StateFlow` 转成 `AsyncSequence`；每个 Kotlin store 在 Swift 侧对应一个 `@MainActor @Observable`
  适配器，在一个 `Task` 里收集并赋值。视图只读适配器，不直接持有 Kotlin 对象。
- 异步元素只当「有变化」的信号，赋值一律读 `flow.value`（`FlowSubscriptions`），排队晚到的旧值不会覆盖新值。
  属于当前会话的状态不各自订阅：`Workbench` 只观察 `store.openSession`（由 Kotlin 单一状态投影的原子快照），
  `apply(_:)` 逐项比较后写入各窄属性；`open()` 在 `store.select` 之后同步读 `store.openSession.value` 应用，切换会话
  不会出现新标题配旧交互卡或旧队列。转录（`timeline`）与 presenter 输出是快照之外的两个 flow，按实例比较；
  输出速度 `outputRate` 是单独的 flow，Swift 只经 `TimelinePresentation.sessionSpeed` 读取。后台任务与子 Agent
  摘要直接读 `TimelinePresentation.jobs/subagents`（已排序），Swift 不再自行遍历时间线。
  会话列表只有轮询，走 KMP 带 `If-None-Match` 的路径（未变化回 304）；macOS 不订阅 lists SSE，无需调用 `listsChanged`。
  收藏同理：`MacHost` 的同一轮询顺带调用 `:client` 的 `SessionMarks.poll()`，以 marks 修订号的 ETag 条件读取，变化时重读正在显示的会话。
  会话页的状态标志与标题徽标由 `:client` 的 `conversationStatus` 计算（规则对照 web `NativeSession.tsx`），Swift 只补页面文案。
  命令读 Kotlin 的 `.value`，视图读镜像。异步结果用 `RequestContext` 判断发起时的上下文是否仍然有效。
- 命令（发送、审批、打断、选模型）是 Kotlin 的 `suspend` 函数，Swift 侧 `await`；失败按 `Errors.kt` 的错误码
  显示，与手机文案一致。
- Kotlin 侧的工作在 `Dispatchers.Default`，结果经 `StateFlow` 回到主线程；不在 Swift 主线程上同步调用重活。
- 多窗口：`SessionStore` 仍只有一个 `selected`，所以「在新窗口中打开」（⌥⌘O、会话菜单、侧栏右键）为每个会话窗口
  另建一份 store：`MacHost.openWindowStore()` 共享连接与 `TranscriptCache`（内部 `Mutex` 串行），各有自己的协程作用域与
  `TimelinePresenter`，不轮询列表。窗口里的 `Workbench`（`role: .window`）从主 store 读会话列表与设置，不发通知、不写
  Spotlight 与上次会话；首页、统计、任务、扩展等页面回到主窗口打开。`Workbench` 自己能做的（预览文件、打开面板）直接调用；
  只有视图状态（侧栏、输入框焦点、子 Agent 与可视化弹层）走 `NotificationCenter`，事件必须带上所属 `Workbench`，接收方只处理
  自己窗口的，不带 `Workbench` 的事件不处理（`Features/Window/WindowScope.swift`）。输入框把滚轮交给转录、调试导出时，按事件所在
  窗口找转录（`TranscriptController.active(in:)`），不取「最后出现的那个」。会话窗口固定在自己的会话上：窗口里打开别的会话（分叉、交接、模板运行）去另一个窗口；主窗口打开已在窗口里的会话时
  聚焦那个窗口。通知抑制也认可见的会话窗口。已知限制：主窗口回到首页时不会停止原会话的流，移走后到新窗口接手前两份 store 会短暂同时接收它。

### 窗口与布局

布局以 **web 桌面版** 为参照，行为规则以 Kotlin 端为准：

- `NavigationSplitView` 两栏（侧栏、对话）加一个自己实现的右侧面板（变更 / 文件，对应 web 右上角「更多操作」
  里的面板）。不用系统的 `.inspector`：它打开时尝试加宽窗口，加不了也不压缩中间内容，结果侧栏被挤出窗口左侧。自研面板
  可拖动调宽（宽度记在本机），中间内容保持至少 420pt，放不下时自动收起侧栏。`LayoutTests` 断言输入框、新会话页、
  面板与侧栏的最小宽度，挡住再引入固定宽度控件导致的溢出。
- 面板里的「变更」与「文件」是列表铺满整个面板、点进去整版看 diff 或预览（带返回）；文件页顶部是可点击的路径栏，
  查找结果带所在目录，预览带行号。
- 控件统一用 `Theme/Controls.swift` 的几种样式：中性的选择器（悬停才有底色）、图标按钮、发送/停止的圆形主按钮
  （禁用态有足够对比度）、对话框里的主次按钮。强调色只留给屏幕上那一个主要动作。
- 转录与输入框共用一列居中宽度（780pt）；消息底栏按时间、复制排列，两者常驻。发送中或异常状态放在时间前，
  发送确认后不再显示「已发送」；过程块与工具行悬停高亮。
- 过程块里连续两个以上的工具调用折叠成一行（web 的 `ToolRun`）：标题是调用的动作类别（`toolRunKinds`，只认服务端给的
  `kind` 与 Codex 的 `commandActions`），失败数居右；有调用在跑或从未结束时展开且不可收起，结束后后面有叙述或回答就收起，
  读者的选择（`TranscriptUIStore.toolRunChoice`）优先；搜索或收藏定位到折叠中的调用时自动展开。
- 消息下方的时间、速度、复制与 ⋯ 只在悬停的行和最新一行显示（`FooterView.revealed`），发送状态与任务计时一直显示；
  隐藏时仍占位，悬停不改变行高。正文加粗用 medium：PingFang 的 semibold 会把整句压成一条黑块。
- 新建会话的首条消息使用创建回执直接进入转录，启动期间原位显示发送状态；后续等待上一轮的输入才显示在底部排队区。
  消息放在排队区还是转录由 `:client` 的 `SendPhase.kt`（web `delivery.ts` 的移植）决定：会话运行中发出、服务端还没应答的
  消息直接进排队区（应答前立即发送、编辑、移出都禁用），空闲时仍先进转录。
- 工具栏放会话标题、Git 分支、「对话 / 终端」切换、后端与模型；⌘K 命令面板对应 web 的 `CommandPalette`。
  会话状态紧跟标题，同步、启动和重连共用这一处 loading；输入框上方只保留需要处理的错误与恢复操作。
- Liquid Glass 只用在导航层：系统的侧栏、工具栏、sheet 自动获得；工具栏项去掉玻璃胶囊经
  `hideSharedToolbarBackground()`（`Theme/Controls.swift`）。macOS 26 以前系统界面是该系统的样子，胶囊本来就没有。
  转录正文不上玻璃。
- 窗口材质（外观与显示 →「材质」，本机偏好）：不透明 / 磨砂（`NSVisualEffectView` behind-window）/ 玻璃
  （`NSGlassEffectView`，仅 macOS 26，也是那里的默认）。`WindowBackdrop` 铺在工作台最底层，非不透明时窗口改为
  `isOpaque = false`；侧栏铺 `bgSidebar`、详情栏铺 `bg`，两者按「侧栏 / 主区透明度」降低不透明度，主区最多 30%
  且默认 0——深色下背后的亮色会把画布抬亮，与气泡、代码块等表面撞色。详情栏的页面（统计、任务、扩展、收藏、并行尝试）
  不再各自铺底，由工作台统一铺；检查器、终端和弹层仍是不透明的 `bg`。系统开启「降低透明度」时一律按不透明处理。
  窗口一旦不是不透明，系统会给工具栏单独垫一层标题栏底色，和主区之间出现一条色带；非不透明时隐藏 `.windowToolbar` 背景，
  让画布一直铺到顶部。
  玻璃的 `.clear` 风格铺满整窗时几乎不模糊，背后窗口的文字会透进正文，所以只用 `.regular`。
- 快捷键：⌘N 新会话，⌘Enter 发送（Enter 行为跟随服务端的「Enter 键」账号设置），⌃\` 切换终端（与 web 相同），
  ⌘1…⌘9 按侧栏当前显示的顺序打开会话（收起的项目和未展开的历史不计），⌘. 打断，⇧⌘F 聚焦侧栏搜索（会话与全部消息；
  侧栏隐藏时先显示，会话窗口里回到主窗口搜索）。

### 时间线

- 行与 dock 由 Kotlin 的 `TimelinePresenter` 在后台算好，Swift 只渲染；工具行的展示结果按 Kotlin 条目实例弱引用缓存，
  运行中的过程块不会在每个流式片段上重复解析 JSON。
- 转录是 AppKit 写的（`Features/Transcript/`），连同回合导航轨、悬停预览（最多两行，超出截断）、回到底部按钮和正文
  宽度把手（`TranscriptChrome.swift`）。
  2026-10-14 之前用的是 SwiftUI `List`：每行都是自己算高度的 `NSHostingView`，行一滚进来就要在主线程上
  建视图树、排 TextKit、测高，滚动和点击因此卡顿（基线见「性能预算」）。
- 管线：`TranscriptController` 用 `withObservationTracking` 读 `TranscriptFeed`（主会话读 `TimelinePresenter`
  的帧，子 Agent 读 `TimelinePresenter.subagent` 的子车道帧）。Kotlin 行的读取、Markdown 解析和 TextKit 1 排版都在后台串行队列
  （`RowBuilder`）上做，产出每行带坐标的片段（`Fragment`：文字、折叠标题、页脚、代码块、Diff、表格、图片、公式、
  卡片、路径标签、按钮）。主线程只按 key 差量更新 `NSTableView`（行高由 `heightOfRow` 直接给，关掉自动行高），
  再把片段摆成复用的视图。
- 一行的布局按「Kotlin 行实例、宽度、样式、这一行的展开状态版本、资源版本」缓存，流式输出只重排被追加的那一行。
  会话是否在运行只进单独工具行的缓存键（未完成的调用在会话停止后显示为已停止），回合开始或结束不重排其他行。
  后台每趟有 30ms 预算，屏幕上的行先排；打开长会话时从底部往上排，排满一屏半就先显示。点开或收起一行在主线程
  当场重排这一行，并以它为锚点保持滚动位置。
- 文字由 `TextLayoutView` 直接画已经排好的字形，自带选择（双击选词、三击选段、Shift 扩选）、⌘C、链接和右键菜单；
  内容没变的块不重画。光标与悬停由列表上唯一的跟踪区域分发，行内没有跟踪区域，也不用光标区域：系统指针被自定义
  （放大或改色）时，每次设置光标都要重新渲染指针图像。
- 贴底与阅读两种模式、上翻加载更早消息时保持阅读位置、跳到某一轮或搜索命中并高亮，都在 `TranscriptController` 里。
- Markdown：先经 Kotlin 的 `splitBlockMath` / `splitStandaloneImages` 切出公式与独立图片（与手机同一份规则），
  其余交给 Apple 的 swift-markdown 解析成 `MarkdownBlock`（`MarkdownModel`），再在后台转成
  `NSAttributedString`。代码块用与 web 相同的高亮器在后台着色；长代码块和 Diff 不折叠，限高后在块内上下
  滚动（`ScrollStrip`，即系统的 `NSScrollView`：速度、惯性、越界回弹都是原生的；运行中的命令输出停在末尾）；一次手势从哪里开始就归谁，块滚到头不会把同一次手势交给转录。
- 数学公式：行内与块级公式都由一个离屏 `WKWebView` 加载服务端的 `/math#tex=…` 页面后截图，按公式、主题与外观缓存；
  截图回来之前按记住的尺寸（`~/Library/Caches/Riffet/` 下的尺寸表）或估算留出空白，到了淡入并只重排用到它的行；
  渲染失败才显示 TeX 原文。Mermaid 图同样记住尺寸，图片记住加载过的尺寸，重开时直接按最终尺寸排版。
- Markdown 先按 web `markdownBlocks.ts` 的规则切成顶层块（`MarkdownBlocks`，分开与合起来解析结果相同；围栏、可能在
  列表或引用里的围栏、HTML 块之后不再切，含定义或脚注的文本整篇一块），每块的解析结果按原文缓存，流式回答只重新解析
  最后一块。仍在输出的行（未结束的单行、运行中的过程块）不把增长中的最后一块和整篇写进共享缓存，结束后才写最终版本。
- 转录之外需要 Markdown 的地方（交互卡片里的计划）用同一套布局的 `MarkdownView`。
- 图片和下载共用 `ProjectDownloads.authorized`：只向当前服务器相同 HTTP(S) 协议、主机、有效端口及基础路径内的请求附设备令牌；用户信息、相似域名和路径前缀碰撞均不授权。导出的原图在后台原子写入各自的私有临时目录（目录 0700、文件 0600），保留原文件名，同名图片互不覆盖，写入失败不返回无效文件。
- 图片：点击直接把当前视图持有的缩略图和项目身份交给应用内 `ImageViewer`，不依赖图片缓存再次命中；原图在后台加载并替换，缩放位置保持不变。正文、工具输出、附件、文件预览和独立 Markdown 共用这一入口，可直接拖到 Finder。
- 大图从点击时的缩略图位置展开，关闭时从当前缩放位置收回到仍在原窗口里的缩略图；裁剪缩略图和部分滚出视口的图片保留各自的可见区域。来源离开视口或开启「减少动态效果」时淡出，不移动转录布局。预览只显示在图片所属窗口，子 Agent 窗口不会同时触发主窗口的预览。

- 模型目录按后端、配置、项目缓存；首次连接及故障恢复后的 Live 连接标记旧缓存过期，下次读取刷新，成功前继续显示当前目录。首页与会话页都跟随连接代次，切换会话不重复强刷；旧连接和已取消请求不能覆盖新目录；同样的连接代次用于首页与会话的 slash 目录，刷新失败仍保留旧目录。

### 输入框

- 模型及审批设置失败显示在当前会话的输入框上方；设置成功或切换会话后清除，旧会话请求不会把错误带到新会话。原生模型切换成功与保存新会话默认值分开处理。

- 文本区是自己封装的 `NSTextView`（`ComposerTextView`）：默认三行（新会话页四行），随内容增高到上限，可展开编辑；
  输入法组合期间不发送；粘贴时文件与图片作为附件、同时带来的文字照常粘贴（从 Finder 复制的文件不粘贴文件名）。
- 只有一个动作按钮：有内容时发送（运行中则排队，右键可「打断并立即发送」），空且在运行时变为停止。
- 模型、模式（仅新会话页）、审批是中性的选择器，同时显示图标与文字；输入框变窄时（`ViewThatFits`）只留图标，模型名截短。
- 模式、审批、模型参数和终端管理菜单复用 `MenuAnchor`，点击时构建独立的原生 `NSMenu`，关闭后才应用选择；
  若宿主离开原窗口则丢弃选择。首页目录菜单同样使用独立原生菜单。展开期间不由 SwiftUI 重建带副标题的菜单项，
  避免菜单跟踪异常后输入区失去响应。
- 会话输入框不提供模式选择（与 web 一致），模式只在新会话页与任务里选。会话内的审批和模型切换显式携带会话 ID，执行前核对当前会话；审批控件随会话身份重建，避免旧菜单选择误改新会话。
- 规则与 web 一致：附件单个 24 MiB、单条 20 个、超限整批拒绝并指出是哪一个；同一文件重复拖入只算一个；
- 普通文件选择器不设格式限制，包含压缩包、Office 文档和未知格式。转录里的普通附件可点击保存；只有 id 的旧回显会先读取元数据，恢复原文件名并按真实 MIME 区分文件与图片。
  输入法组合期间的 Enter 只用于选词。
- 拖放：文件、图片、Finder 里的目录（作为引用路径）；粘贴同时收图和文字。图片按长边 2048px 降采样后上传，
  与手机相同。
- 排队、立即发送、打断、草稿按项目 + 后端 + 配置保存，都来自 `:client` 的 `Outbox` 与 `SessionStore`。
- 菜单栏「快速对话」、全局快捷键、服务菜单与无项目的分享链接统一打开主 App 的快速对话页并预填文本，复用页面草稿与发送流程；不再创建独立悬浮窗，也不提供打开方式设置。旧服务端没有快速对话项目时回退到任务输入页。

### 终端

- 项目终端停靠在会话输入框下方，铺满会话这一栏，可与右侧文件 / 变更面板同时显示。初始高度 240pt，拖动分隔线调整并保存。
  「⋯ → 打开终端」、首页 Shell 卡片、命令面板和 ⌃\` 都进入这个底部分栏，顶部工具栏不增加终端按钮。
- 标题栏左侧用「终端名称 ···」打开管理菜单，右侧下箭头收起面板，X 关闭当前 Shell（沿用关闭确认）；Agent 终端只显示收起。
  收起只断开显示连接，关闭 Shell 才调用关闭接口。新建、历史输出、控制权和中断保留在菜单中。
  各项目记住终端选择，重复打开优先复用原 Shell。Agent 的整页终端视图仍由 ⇧⌘T 切换，
  自动等待操作提示不能替换用户手动打开的 Shell。
- 管理菜单展开后保持连接状态和选项快照，关闭菜单后再切换终端、呈现确认框或执行控制操作；控制操作执行前重新核对连接状态。
- `SwiftTerm.TerminalView`（不是自带进程的 `LocalProcessTerminalView`）接到 `:client` 的 `TerminalConnection`：
  `/api/terminals/:id/ws` 收到的字节 `feed` 给 SwiftTerm，SwiftTerm 的输入回调交给连接发送；控制权、只读查看、
  尺寸同步的协议沿用手机的实现（`docs/MOBILE-TERMINAL.md` 5.1）。
- 终端表面、默认文字、选区与光标使用当前主题的明确浅色 / 深色值；ANSI 色表保留主题色，256 色使用 xterm 色立方。
  `TerminalRetint.configure` 按文字实际背景修正低对比前景，保留彩色背景、Powerline 分隔符和绘图字符。
  历史保留原始 ANSI，切主题时重新渲染；实时画面从最近快照本地重放，屏蔽重放时的旧查询回复。原始流缓存上限
  2 MiB，超出后切主题会重新获取终端快照，不结束 Shell。
- 回看沿用第一期协议（`/history`），通过原生 `NSScrollView` 把历史与实时画面接成一个滚动区域；滚轮不向 tmux
  发送方向键。历史也由 SwiftTerm 渲染 ANSI 与中文，渲染视图保持可视区大小。从实时画面上滑时按版本读取历史，
  不随输出轮询；阅读期间固定历史快照，回到实时后再次上滑才更新，避免 2 万行上限滚出旧行时跳动。
  调整面板高度复用已解析缓冲区，不重放历史；网格列数改变或重连后，下次读取使用全量。
  输入或「回到实时」返回底部。模拟器自动回复走 `sendReply`，只有用户输入会接管控制权。`docs/MOBILE-TERMINAL.md` 的
  第二期（tmux control mode）落地后同样受益。
- 这意味着手机用 Termux 移植引擎、Mac 用 SwiftTerm，是两个 VT 引擎。用 `apps/mobile/terminal/fixtures/tmux`
  录下的真实流对 SwiftTerm 做同样的逐格对拍（Swift 测试），把差异挡在 CI。
- 升级路线：libghostty（`GhosttyKit.xcframework`），cmux 在 CI 里用 Zig 编出来并在生产使用。上游未承诺稳定
  的嵌入接口，需要自己维护构建脚本。

### 缓存与搜索

- `TranscriptCache` 随 `:client` 复用，Mac 放在 `~/Library/Caches/Riffet/`，同样按服务端地址分区。
- 全文索引：目前用 `MemoryTranscriptIndex`，启动时由 `indexMissing()` 对设备副本重建，搜索覆盖全部已缓存的
  会话。换成持久的 SQLite FTS5 是后续优化，接口不变。
- 会话标题与首条提问另外写入 Core Spotlight，在系统搜索里直接打开会话（`riffet://session/<id>`）。

### 收藏

方案契约见 `docs/MARKS.md`。

- 消息右键菜单「收藏回复 / 取消收藏」，有选区时「高亮所选文字」（四色子菜单）；在高亮上右键可改颜色、编辑备注、删除。生成中的回答（id 含 `:run:`）不提供。
- 高亮画在 `TextLayoutView.highlights` 上，不改存储的富文本；引文与区间换算在 `Transcript/TranscriptMarks.swift`。被收藏的回答在行左侧显示书签。
- 模型、接口与状态都在 KMP：`Mark` 在 `:contracts`，读写在 `RiffetApi`，正在显示的会话的收藏是 `:client` 的 `SessionMarks.bySession`（`StateFlow`，按安装的连接各建一份，随会话列表轮询以 ETag 检查修订号）。`Marks/Marks.swift` 的 `MarksStore` 只镜像它并重放观察中的会话；收藏图片原图与其他图片一样经 `ProjectDownloads.authorized` 读取。`Marks/MarksPage.swift` 是侧边栏「收藏夹」页（⇧⌘L），显示期间关注修订号并在变化时重读。
- 跳转：`TranscriptFocus` 同时带消息 id、序号与引文，`exact` 时逐页读取更早的历史（至多 30 页），仍找不到在输入框上方提示。落点由 `settle(on:item:quote:)` 在约 1.5 秒内逐帧校正：高亮滚到文字本身，过程块内的图片或工具调用先展开块再定位（`RowLayout.items` 记录每项的片段）。
- 图片与文件：过程块片段的右键菜单「收藏图片 / 收藏文件」（`TranscriptCell.fragmentMenu`）；图片以 PNG 上传，收藏页显示服务端副本，文件卡片可「打开文件」。

### 画布

内置画布插件（`plugins/riffet/canvas`）在 Mac 上原生绘制，不嵌 web。2026-11-12 的探针用两份真实会话（362 / 274 个节点）
和三倍压测（1086 个节点）验证了做法：120Hz 下帧间隔 p95 / p99 均为 8.33ms，主线程每帧 p95 不超过 2.7ms。

- **布局与 web 共用一份代码**：`flow.ts`、`detail.ts`、`shell-writes.ts` 及其依赖的 `toolView`、`lineDiff` 用 esbuild
  打成经典脚本 `Resources/canvas-layout.js`（`scripts/build-canvas-layout.sh`），在专属线程的 `JSContext` 里折叠与布局，
  结果解码成 Swift 结构。布局只依赖数据（卡片尺寸按字符估算，不读实测尺寸），所以两端几何相同。需要 `allow-jit`。
- **绘制**：一个 layer-hosting 视图里的世界层，相机只改它的 transform。每张卡片一个图层，内容在后台按缩放档位
  （0.25 / 0.5 / 1 / 2 × 屏幕倍率）画成位图，大卡片切成 512px 分块；远景（k < 0.36）不用位图，只画色块。
  连线、框、轨道线用形状图层，线宽随缩放保持 1px。视口外的卡片释放位图，命中测试按模型矩形算，不走图层树。
- **位图换代**：卡片换版本（悬停、内容增长、摘要↔详细）时，旧位图按原尺寸贴顶留着，新版本屏幕内的分块全部画好后同一帧换上，
  不会一半新一半旧；层级切换先在后台画好可见的新位图再变形，卡片只平移不拉伸。屏幕上的位图不受内存预算回收；
  调度器不再记账的位图绝不上屏（否则会成为永远撤不掉的残影）。
- **与 web 对齐是验收标准**：颜色与圆角取自 `index.css` 生成的主题，图标画 Lucide 的同一套路径，动效沿用 web 的时长与曲线。
  同一份数据、同一相机位置下，原生截图与离屏 WebKit 渲染的 web 画布叠图比对：偏移不超过 1px、颜色值一致。
- 文字可编辑的地方（分支草稿、继续对话）在屏幕坐标里盖不缩放的真实文本视图：父层带 transform 时 macOS 26 的文本控件会发糊。

### 设计变量

`scripts/gen-mobile-theme.ts` 已经把 `apps/web/src/styles/index.css` 生成为 `RiffetTheme.kt`。扩展它同时生成
`apps/macos/Riffet/Theme/RiffetTheme.swift`，提交进仓库，`pnpm gen:theme:check` 一并比对。不手工誊抄。
主题明暗跟随系统外观；配色主题的选择是否跨端同步，沿用 web「主题偏好保存在本机」的现状。

### 界面语言

String Catalog，源语言 `zh-Hans`，键就是中文原文。每个 target 一份 `Localizable.xcstrings`（App 在 `Riffet/Resources/`，
小组件、共享扩展各在自己的目录）；`InfoPlist.xcstrings`（权限说明、显示名）与 `ServicesMenu.xcstrings`（服务菜单项）手动维护。

- 默认中文：`RiffetApp.init` 最先调用 `AppLanguage.applyDefault()`，App 自己的 defaults 域里没有 `AppleLanguages` 时写入
  `["zh-Hans"]`。设置 → 外观与显示 →「语言」与系统设置「语言与地区 → 应用」写同一个键，两边一致；在系统设置里选「系统默认」
  等于删掉它，下次启动回到中文。
- 切换在 App 重启后生效：bundle 只在启动时选一次语言。「重启 Riffet」在 `applicationWillTerminate` 里留一个等待进程，App
  退出后重新打开同一个 bundle；服务端是独立的 LaunchAgent，不受影响。小组件与共享扩展是独立进程，跟随系统语言。
- 写法：`Text`、`Button`、`Label`、`Toggle`、`.help` 等 SwiftUI API 收到的字面量自动提取；`String` 类型的 API 用
  `String(localized:)`；自己组件的文字参数用 `LocalizedStringResource`，另留一个 `@_disfavoredOverload` 的 `String` 重载原样显示
  变量（见 `SettingsComponents.swift`）。`Text(变量)` 不查表，变量要在产生处本地化。整句成文，插值不拼片段。同一句中文只有一种
  译法，需要不同英文时换中文说法。
- 日期与数字用 `AppLocale.current`（界面语言 + 本机地区），不写死 `zh_CN`；日期格式用模板（`setLocalizedDateFormatFromTemplate`）。
- 迁移一个区域：改写其中的 `String` API，`build.sh test` 之后 `node scripts/check-i18n.mjs --sync` 写入新键（命令行构建不回写
  目录，这一步代替 Xcode 的同步），在 `Localizable.xcstrings` 补英文，把文件加进 `i18n-baseline.json` 的 `migrated`，再
  `--update-baseline` 下调其余文件的计数。中文界面逐字不变。
- `scripts/check-i18n.mjs`（`build.sh test` 在构建后运行）读编译器为每个源文件记录的 `.stringsdata`（`SWIFT_EMIT_LOC_STRINGS`，
  含键与位置）：目录与代码用到的键一致，不缺、不过期；`migrated` 里的文件每个键都有英文，且没有绕过本地化 API 的中文字面量；
  其余文件这类字面量不超过 `literals` 的计数，只降不升，非界面文字在行尾或上一行加 `// i18n-ignore`；构建出的 Info.plist 里的
  中文值与服务菜单项都有英文。
- 已迁移：设置窗口（分区标题、搜索）、外观与显示、设置通用组件、主题与图标名称。Kotlin 共享层的文案与错误自己读
  `NSBundle.mainBundle.preferredLocalizations`，与 App 同一语言，Swift 不另传。

## 原生能力

| 能力 | API | 行为 |
| --- | --- | --- |
| 菜单栏常驻 | `MenuBarExtra(.window)` | 图标为单色标识（有会话等待确认时换成气泡），显示运行中 / 等待确认的数量；可选在图标旁显示进度（「N 待确认」，或唯一运行会话的标题与计时，多个时「N 个运行中」）；面板列出运行中的会话（当前步骤与计时，对应 Android 的常驻通知）、待确认项（内联按钮，开启 Touch ID 时同样先验证）、服务状态与告警 |
| 只留菜单栏 | `NSApp.setActivationPolicy(.accessory)` | 设置项：关闭最后一个主窗口后才隐藏 Dock 图标，主窗口再次出现时恢复 |
| Dock 角标 | `NSDockTile.badgeLabel` | 等待确认的会话数 |
| 应用图标颜色 | `NSApp.applicationIconImage` | 设置 → 外观里 6 选 1，只在运行时生效；退出后 Dock、Finder 与启动台显示 bundle 自带的蓝色图标 |
| 可操作通知 | `UNNotificationCategory`、`UNNotificationAction`、`UNTextInputNotificationAction` | 完成 / 失败 / 中断 / 等待确认，规则与 Android 相同；确认通知带审批按钮或单选项（权限类在开启 Touch ID 时先验证，失败另发一条说明），完成通知带回复框，回复走同一条 outbox；会话离开 `waiting` 时撤回并移除它的 category；正在看的会话不发通知 |
| 专注模式 | `SetFocusFilterIntent` | 专注过滤器「提醒范围」：全部提醒 / 只提醒等待确认 / 静音完成通知；Dock 角标不受影响 |
| 全局快捷提问 | `KeyboardShortcuts` 3.1.0 | 任意应用里打开主 App 的快速对话页（默认 ⌃⌥Space，避开 Finder 的 ⌥⌘Space）；已有自定义快捷键保持不变 |
| 快捷指令 | App Intents | 「新建 Riffet 会话」（项目为 `ProjectEntity`，带建议与搜索）、「打开 Riffet 会话」（`SessionEntity`）、「列出运行中的会话」；App 刚被拉起时等待连接就绪（15 秒）；审批不暴露给快捷指令 |
| 系统搜索 | Core Spotlight | 索引会话标题、项目、标签与模型（会话列表不带首条提问）；忘记或更换服务器时清空 |
| URL scheme | `riffet://` | `session/<id>`、`new?project=…&prompt=…`；命令行与其他应用可直接拉起；冷启动时排队到连接就绪（`AppModel.whenReady`），`panel=` 直接写入该会话的面板状态 |
| 服务菜单 | `NSServices` | 「发送到 Riffet」（选中文字）、「在 Riffet 中新建会话」（Finder 右键「快速操作」，目录或文件，文件取所在目录） |
| 共享 | Share Extension（`RiffetShare`，沙盒） | 共享菜单里的文字、链接与最多 10 个文件拼成提示词，经 `riffet://new?prompt=` 打开主 App 的快速对话页并预填文本 |
| 小组件 | WidgetKit（`RiffetWidgets`，沙盒） | 小 / 中尺寸：待确认与运行中数量和最多 3 个会话，点击打开会话。App 把快照写到 `~/Library/Application Support/Riffet/widget-snapshot.json`，小组件凭只读临时例外读取（不用 App Group：ad-hoc 签名下不可靠） |
| 文件 | Quick Look、拖出、`NSWorkspace` | 预览附件与文件面板；本机服务时「在编辑器中打开」直接调用本机应用，远程服务时隐藏 |
| 审批前验证 | `LocalAuthentication` | 可选：危险操作前要求 Touch ID，对应 Android 的 `BiometricGate` |
| 设备能力（T0） | `ScreenCaptureKit`、`NSPasteboard`、`NSWorkspace`、`UNUserNotificationCenter` | 开关「允许 Agent 操作这台 Mac」开启后，Agent 可列出并截取窗口（不激活）、读写剪贴板文本、打开 http(s) 链接、发通知；连接期间始终服务，只剩菜单栏时也在线；见 [DEVICES.md](DEVICES.md)「实现（Mac，T0）」 |
| 令牌存储 | Keychain / 0600 文件 | 每个服务端一个设备令牌。带 Team ID 签名的构建用钥匙串；ad-hoc 构建的签名每次构建都变，钥匙串会反复询问授权，改存 `~/Library/Application Support/Riffet/secrets.json`（0600），与服务端保护 `access-token` 的方式相同 |
| 自动更新 | Sparkle 2 | 见「签名、公证与分发」 |

通知的来源与 Android 相同：`:client` 轮询 `/api/sessions` 并比较 `Session.state`。Mac 不受后台挂起限制，
所以不需要前台服务，菜单栏常驻期间始终有效；界面上仍按实际情况说明「App 退出后没有通知」。

## 工程与构建

### 目录

```
apps/macos/
  project.yml                 XcodeGen；生成的 Riffet.xcodeproj 不提交
  i18n-baseline.json          界面语言：已迁移的文件与其余文件的中文字面量计数（check-i18n.mjs）
  Riffet/
    App/                      @main 与 Scene、AppDelegate、AppModel（连接与配对）、Workbench（SessionStore 的镜像与协调），
                              及其分出的 WorkbenchSidebar（侧栏分组、筛选、消息搜索）、InspectorPanels（面板状态持久化）、
                              TerminalDock（终端停靠栏）、CatalogCache（模型与 slash 目录缓存）
    Bridge/                   Flow 订阅、密钥存储
    Server/                   ServerHost（发现、接管、SMAppService）、LocalPairing
    Features/                 Workbench、Sidebar、Conversation、Transcript（AppKit 转录）、Composer、Home、Inspector、
                              MenuBar、Settings、CommandPalette、QuickPrompt、Onboarding
    Services/                 通知、打开文件与编辑器、URL / 服务菜单 / Sparkle / Spotlight / App Intents、
                              Performance（性能监测、悬浮读数、基准）
    Theme/                    RiffetTheme.swift（`pnpm gen:theme` 生成）与 Theme.swift
    Resources/                Assets、entitlements、LaunchAgents/io.github.riffable.mac.server.plist、String Catalogs
  RiffetTests/
  scripts/
    build.sh                  debug | release | dev | test
    build-server-payload.sh   官方 Node + dist/ + 生产依赖 → build/server-payload
    bundle-server.sh          Xcode 构建阶段：拷贝载荷、写启动器、由内向外签名
    sign-frameworks.sh        Xcode 构建阶段：用本次构建的身份重签 Sparkle，再密封 App
    release.sh                归档 → 签名 → 公证 → staple → DMG → Sparkle zip 与 appcast 条目（输出到 build/dist）
    check-i18n.mjs            界面语言检查，build.sh test 在构建后运行
    node.entitlements         内置 node 的 hardened runtime 权限
  packaging/homebrew/riffet.rb
```

### 依赖

版本在 2026-10-12 从 GitHub Releases 取得：

| 依赖 | 版本 | 用途 |
| --- | --- | --- |
| SKIE | 0.10.15 | Kotlin → Swift 互操作（Gradle 插件） |
| SwiftTerm | 1.99.0 | 终端 |
| Sparkle | 2.10.0 | 自动更新 |
| KeyboardShortcuts | 3.1.0 | 全局快捷键 |
| XcodeGen | 2.46.0 | 生成工程 |
| swift-markdown | 0.9.0 | Markdown 解析 |

### Kotlin 的接入方式

用 direct integration：Xcode 的 Run Script 调 `./gradlew :client:embedAndSignAppleFrameworkForXcode`，Debug 与
Release 是同一条路径，Gradle 负责增量。不额外维护 XCFramework 与本地 SwiftPM 包；需要把 `RiffetKit`
给别的工程用时再引入。

### 服务载荷

`build-server-payload.sh`（S1）产出 `build/server-payload/`，Release 构建时由 `bundle-server.sh` 拷进
`Contents/Resources/server/`，并写入启动器 `riffet-server`：它读数据目录里的 `app-server.env`（App 从被替换的
守护进程参数继承 host、port 与是否要求令牌），把输出追加到 `server.log`，再 `exec` 内置 node。Debug 构建不带载荷，
启动器指向本仓库的 `dist/cli.js` 与本机 node，足以试「由 Riffet 托管」。

体积：载荷 148MB（Node 116MB、`dist/` 6MB、依赖 26MB），Release 版 App 181MB，DMG 65MB。服务端使用 Node 内置的
`node:sqlite`，原生模块是 `node-pty` 与 `sharp`（自带 libvips）。以后做单文件可以参考 vibetunnel：服务端编成单个可执行文件、`pty.node`
放在旁边，Release 用裁剪过的 Node（约 68MB）。

## 签名、公证与分发

- **不开 App Sandbox**。Hardened Runtime 只在 Developer ID 签名时开启（`release.sh` 传 `ENABLE_HARDENED_RUNTIME=YES`）：
  它是公证的要求，而在它之下进程只能加载同一 Team ID 签名的库；ad-hoc 签名没有 Team ID，开着它的 ad-hoc 包连
  Sparkle 都加载不了（实测：启动即被 dyld 拒绝）。
- Sparkle 带着作者的 Team ID 签名，`sign-frameworks.sh` 在构建阶段用本次构建的身份重签它及其 XPC 服务（保留
  entitlements），再重新密封 App：Xcode 在增量构建里会跳过 App 自身的签名步骤。
- 由内向外签：`bundle-server.sh` 在 Xcode 签 App 之前签 `pty.node`、`spawn-helper` 与内置 `node`；`release.sh` 用
  Developer ID 时再签 Sparkle 的 XPC 服务与 helper，最后签 App。内置 `node` 用 `scripts/node.entitlements`：官方
  Node 二进制自带的 `allow-jit`、`allow-unsigned-executable-memory`、`disable-library-validation`（加载 `node-pty`
  这类原生模块需要），去掉 `get-task-allow` 与 dyld 环境变量两项。
- App 自身只有 `allow-jit`：进程内的 JavaScriptCore（代码高亮、画布布局）没有它就只能解释执行，不论是否开
  Hardened Runtime。2026-11-12 实测画布布局慢 5–15 倍，加上后与 Node 持平。
- `xcrun notarytool submit --wait`，`xcrun stapler staple`，打 DMG。
- Sparkle 用 EdDSA 签名的 appcast，版本不低于 2.9.3：低于它的 helper 在 macOS 26 上会被系统策略杀掉，
  cmux 为此升级过（[manaflow-ai/cmux#6678](https://github.com/manaflow-ai/cmux/pull/6678)，2026-06-23 合并）。
- 自建 Homebrew tap 发布 cask，CI 在发版后更新 `sha256`。
- **安装位置必须固定**。Claude hook 的命令是 `process.execPath` 加 `hook-cli.mjs` 的绝对路径
  （`backends/claude/index.ts`），App 托管时这条路径指向 `/Applications/Riffet.app/…`。从「下载」目录直接运行会被
  App Translocation 放到随机路径，因此首次启动检测到 translocation 时要求移到「应用程序」。Sparkle 原地替换
  不改变路径。

## 性能预算

| 项目 | 目标 |
| --- | --- |
| 冷启动到显示本机缓存的会话列表 | < 500 ms |
| 打开一个已缓存的长会话到首屏 | < 300 ms |
| 滚动、甩动、跳到两端 | 每秒卡顿 < 5 ms，p99 帧时间不超过一帧 |
| 点开或收起一行到下一帧上屏 | p95 < 16 ms |
| 点侧栏一行到它画成选中 | 下一帧 |
| 再次进入一级页面、侧边面板标签、设置分区 | 直接显示上次的内容，不转圈 |
| 打开不在内存里的会话（读设备缓存）到首屏 | < 200 ms |
| 流式输出时的主线程占用 | 每帧 < 4 ms，滚动不掉帧 |
| 常驻内存（菜单栏、无打开窗口） | 单独测量后定预算 |

### 监测与基准

设置 →「诊断与性能」→「性能监测」打开记录（默认关闭，关闭时不运行任何东西）：

- 用 `CADisplayLink` 记录帧间隔，按页面（转录、首页、统计、终端）和场景（滚动、流式、交互、空闲）分别统计
  p50/p95/p99、每秒卡顿毫秒数和掉帧数；用 runloop 观察者记录主线程阻塞（超过 50 ms 记一次）；记录从点击或按键到
  下一帧上屏的延迟；`Perf.measure` 的阶段耗时同时出现在 Instruments（subsystem `io.github.riffable.mac`）里。
- 悬浮读数显示帧率、每秒卡顿、最差帧、主线程占用和最近一次点击到上屏的延迟。
- 报告导出到 `~/Library/Application Support/Riffet/perf/`，带构建类型（Debug/Release）、机型、系统和屏幕刷新率。

基准对一个会话依次做：从首页打开、匀速滚动（3000 pt/s 上下各 6 秒）、快速甩动（12000 pt/s）、跳到两端、
展开再收起 8 个折叠行、模拟一段约 7 KB 的流式回答（每帧 24 个字符），每一段记成报告里的一页（`bench.*`）：

`riffet://perf/*` 链接会操作窗口、写文件，任何网页都能打开链接，所以默认不响应，要先在本机打开
（`scripts/perf-bench.sh` 会自动做这一步）：

```bash
defaults write io.github.riffable.mac riffet.perf.links -bool true
open -a apps/macos/build/Release/Riffet.app "riffet://perf/bench?session=<会话 id>"
# 结果：~/Library/Application Support/Riffet/perf/latest-bench.json
```

其他调试链接：`riffet://perf/hud?on=1`、`riffet://perf/enable?on=1`、`riffet://perf/reset`、`riffet://perf/report`、
`riffet://perf/settings`（打开设置窗口、把每个分区走两遍）、`riffet://perf/switch?session=<id>[&other=<id>]`（首页与会话、或两个会话之间来回切）、`riffet://perf/pages?session=<id>`（从会话进入每个一级页面再回来，走两遍）、`riffet://perf/inspector?session=<id>`（侧边面板每个标签打开、来回切换两遍）、`riffet://perf/cold?session=<id>[&other=<id>]`（先让会话离开内存，再从设备缓存打开三次）、`riffet://perf/preview?path=<项目内路径>[&session=<id>]`（在文件面板预览并上下、左右滚动）、`riffet://perf/dump`（把当前转录最后几行的行高、位置与片段写到 `/tmp/transcript-dump.txt`，行视图与表格位置不一致的行标 `!!`）、`riffet://perf/toggle?index=<n>`（从底部数第 n 个折叠行）、`riffet://perf/snapshot?name=<名字>[&window=settings]`（把主窗口或设置窗口画成 perf 目录下的 `snapshot-<名字>.png`，
不需要屏幕录制权限）。

### 2026-10-14 实测

`build.sh dev` 包，MacBook Pro（Mac16,7），外接 60 Hz 屏，系统指针放大 1.5 倍并改了颜色。旧实现是 SwiftUI `List`：

| 项目 | 48 轮会话：旧 → 新 | 3.4 MB 会话：旧 → 新 |
| --- | --- | --- |
| 打开 | 783 → 492 ms | 626 → 483 ms |
| 匀速滚动：每秒卡顿 / p99 帧 | 108 / 42.6 → 0 / 16.7 ms | 71 / 33.3 → 0 / 16.7 ms |
| 快速甩动：每秒卡顿 | 222 → 0 ms | 241 → 0 ms |
| 跳到两端：每秒卡顿 | 33 → 0 ms | 41 → 8 ms |
| 点开或收起一行：p50 / p95 | — → 9 / 26 ms | — → 7 / 34 ms |
| 流式输出：主线程每帧 p95 / 每秒卡顿 | — → 0.35 / 0 ms | — → 1.1 / 0 ms |

- 空闲时主线程占用从每秒 300 ms 以上降到 1–5 ms。原因是侧栏里运行中会话的 SwiftUI `ProgressView` 让宿主每帧重新
  布局，每次布局又会重设光标，而这台机器的指针是自定义的，重设一次就要重新渲染一次指针图像。所有小转圈都已换成
  在独立线程上动画的 `Spinner`。
- 真实流式输出时主线程每秒最多忙 23 ms（之前单次尖峰就有 130 ms）：只是时间戳变了的会话帧不再替换
  `Workbench.selected`；设置和项目列表单独观察；侧栏重新分组合并到同一帧；Spotlight 索引 5 秒防抖；
  dock（目标、待办）和后台任务只在变化时写入。
- 「讨论 facets 接入 arch agent」（一个跑了两小时、310 个工具调用的过程块，多张图片，持续流式）：匀速滚动每秒卡顿
  370 → 5 ms，甩动 454 → 0 ms。三处原因：一行有几百个片段，行视图被回收再配置时全部重画，现在行内也只为可见区域附近
  的片段建视图；代码块里的 `NSScrollView` 和各视图的 `toolTip` 都是跟踪区域，随列表移动就会让 AppKit 重设光标，
  现在横向滚动是自己实现的视图，提示由列表统一显示；单行文字改用 Core Text 截断，SF Symbol 按外观缓存位图，
  图片作为 layer 内容交给 GPU 缩放。
- 页面切换（在 App 内切换，计时到新页面上屏，`riffet://perf/switch?session=<id>[&other=<id>]`）：会话之间
  196 → 约 105 ms，首页与会话之间约 120 ms。做法：
  - 会话页跨会话复用，只有转录按会话重建，以前输入框和各种 dock 每次切换都从零重建；
  - 工具栏项在首页和会话之间保持不变，只换内容：右侧只有一个工具栏项，首页上只放「面板」按钮，会话页再加上计数和
    「更多」菜单；「更多」菜单改成点开时才用 AppKit 现场构建。SwiftUI 的 `Menu` 在工具栏里会随任何变化重建整个菜单和
    所有图标，增删工具栏项会重建宿主视图并重排整个工具栏。隐藏的工具栏项会留下空的玻璃胶囊，所以只能换内容，不能隐藏；
  - 侧栏的行按显示内容比较（相对时间按文字比较，不按时钟比较），右键菜单不参与比较，列表重算时只重新测量变化的行。
- 系统指针自定义时，AppKit 在跟踪区域变化后（滚动带悬停的列表、切换页面）都会重设光标，每次都要重新渲染指针图像。
  `CursorGuard` 让同一个光标在 250 ms 内的重复设置直接跳过；App 重新激活、窗口变为主窗口后，第一次设置照常生效。
  `defaults write io.github.riffable.mac riffet.cursor-guard-off -bool YES` 可以关掉它做对比。
- 文件预览：着色、段落样式和行号起点都在后台构建，内容判断用长度加首、中、尾采样，不再对全文求哈希。
  「变更」「文件」面板翻页去掉了滑动动画：动画的每一帧都要重新布局整个窗口。

### 2026-10-23 实测

`build.sh dev` 包，同一台机器，外接 60 Hz 屏，31 行的会话。页面切换类的数字分两种：到新页面画出的第二帧（「上屏」），
和到页面上没有加载转圈（「内容」）。`scripts/perf-bench.sh <会话 id> --settings --pages --inspector --cold`：

| 项目 | 改之前 | 改之后 |
| --- | --- | --- |
| 打开不在内存里的会话：到内容 p95 | 227 ms | 151 ms |
| 其中读设备缓存（`client.cache.load`） | 195 ms，约 130 ms 在排队 | 68 ms，排队 0 |
| 再次进入一级页面：到内容 p95 | 4.6 s（扩展管理每次重读） | 201 ms |
| 从一级页面回到会话 p95 | 231–245 ms | 149 ms |
| 侧边面板来回切换标签 | 111–146 ms | 60–83 ms |
| 关闭侧边面板 | 138–148 ms | 77 ms |
| 切到会话 p95 | 153–253 ms | 117 ms |
| 设置：再次进入分区 p95 | 104–132 ms | 92 ms |

主线程采样（`sample` 能看到阻塞，Time Profiler 只看到在跑的时间）找到的原因与做法：

- 侧栏的选中高亮跟随打开后的状态，要等整段切换做完才画出来。现在点击先把行画成选中，下一帧再打开；
  悬停卡片的内容到要显示时才算（之前每次切换都为每一行调 Kotlin 算模型名和时间）。指针在一行上停 150 ms，
  就把那段会话从设备缓存读出、投影好，点下去走已在内存里的路径。
- 首页和一级页面盖住会话时，会话页不再销毁（`covered` 环境值：不抢焦点、回车和 ⌘↓ 不响应）；转录按会话保留
  排好的行，重建时直接复用。
- 一级页面、首页数据、侧边面板、设置分区的数据都保留在 `Workbench.pageModels` 或各自的缓存里：再进入先显示上次的
  内容，后台再读，没变就不写。扩展管理每个来源到达都在主线程重建全部条目，20 次切换合计约 1 s，现在每次读取
  只重建一次，且放在后台；侧边面板各标签常驻，git 状态和工具栏菜单共用一份。
- 设置的「通知」「服务」在主线程同步调 `SMAppService.status`（一次 40–80 ms），现在放到后台并缓存。
- 打开会话要排在刚离开会话的写盘、预取和索引之后才能读缓存。现在打开的读取插到这些后台操作前面，离开的会话
  等新会话读完再写，单纯读取不再写 meta。
- 仍然留着的：一级页面之间工具栏项增减带来的重新排版（每次约 30 ms）。页面的按钮位置取决于有没有居中项，
  统一成同一组工具栏项会挪动按钮，所以没有改。输入框拿到焦点时输入法的同步调用、光标重设也各占几毫秒到十几毫秒。

## 性能规范

目标：滚动、点击、切换和流式输出与 web 一样跟手，并且不随迭代变差。下面的规则来自 2026-10-14 的实测与修复，
每一条背后都有一次卡顿（见「性能预算」的实测记录）。

### 规则

1. **转录只在 AppKit 里画。** 行的布局（Markdown 解析、TextKit 排版、测高）在后台队列 `RowBuilder` 上做，主线程只摆放
   片段。后台代码不能读主线程状态（`S()`、`DisplayPreferences`、`AppModel`），需要的东西放进 `TranscriptStyle`。
2. **一行只画看得见的部分。** 行内只为可见区域附近的片段建视图（`TranscriptCell.show`）；内容没变的片段不重画
   （`TextLayoutView`、`DisclosureView`、`FooterView` 都会比较新旧内容）。新增片段类型同样要做到。
3. **转录里不放跟踪区域、光标区域、`toolTip` 和 `NSScrollView`。** 系统指针被自定义时，每次 AppKit 重设光标都要重新
   渲染指针图像，而跟踪区域一移动就会重设。悬停与光标由 `TranscriptController` 用列表上唯一的跟踪区域分发，提示用
   `FragmentView.help`。块内滚动只用 `ScrollStrip`（系统滚动视图，手势在开始时决定归块还是归转录），它的
   滚动条带来的重复光标设置由 `CursorGuard` 去重。
4. **SwiftUI 不做每帧动画。** 不用 `.repeatForever`（用 Core Animation，见 `applyShimmer`），不用 `ProgressView` 小转圈
   （用 `Spinner`），页面和面板之间不加 `.animation`：动画的每一帧都会重新布局整个窗口。
   预期内的尺寸变化仍要过渡（布局稳定性，见 [WEB.md](WEB.md) 2026-11-02 一节），做法按代价选：侧边检查器与终端坞
   先一次留出位置，面板作为覆盖层滑入滑出（`.transaction`，转录宽度只变一次）；左侧栏仍是一次切换，内容淡入；
   输入框上方的卡片与输入框高度用一次性的 `ComposerMotion.resize`（0.18s），转录在这期间逐帧跟随底部。
   刷新时保留上一份值（模型目录、额度、diff），不先清空再加载。开启「减少动态效果」时位移动画关闭，只保留淡入淡出。
   切换会话是一次组装（`Workbench.assembledSession`）：转录行与实时状态都到达，或等满 400ms，才算组装完成。完成前转录列
   （来源条、常驻提示、转录）和输入框上方按会话出现的横幅透明、其间的变化不做动画；完成后的下一次更新只让透明度淡入一次
   （0.18s），之后的变化照常过渡。输入框的模型与上下文控件按会话换身份直接替换，不交叉淡变；「正在加载对话…」同样等满
   400ms 才出现。Kotlin 展示器从同一份 store 快照读会话、`loaded` 与行，不会出现「已加载、没有行」的一帧。
5. **观察要窄。** 视图只读它显示的东西：会话帧里只有时间戳变化时不替换 `Workbench.selected`；设置和项目单独观察；
   dock、后台任务只在变化时写入。新加的 `Workbench` 属性，如果会随流式输出变化，就不要让工具栏、侧栏、输入框读它。
   `Workbench.status` 只含页面用到的字段（不含实时吞吐）；`backendRevision` 单独镜像；模型目录按 key 各自一个可观察槽位；
   工具栏的后台任务与子 Agent 摘要在 timeline 变化时于后台合并计算，`body` 只读结果。
6. **列表行按显示内容比较。** SwiftUI 列表里的行要么 `Equatable`（比较显示的值，不比较闭包和时钟），要么不重建；
   每一行都是自己算高度的宿主视图，重建一次就要全部重新测量。
7. **工具栏结构不变。** 工具栏项不随页面增删，只换内容；不在工具栏里放 SwiftUI `Menu`（用 `ToolbarMenuButton`，
   点开时才构建菜单）；隐藏的工具栏项会留下空的玻璃胶囊，所以只能换内容，不能隐藏。
8. **窗口最小尺寸是常量。** 根视图用 `WindowContentLayout` 给定最小尺寸，不让 `.contentMinSize` 或带最小尺寸的
   `.frame` 在每次布局时测量整个窗口（主窗口和设置窗口都是）。设置窗口的分区各自放在 `sizingOptions = []` 的
   `NSHostingView` 里，看过的分区隐藏保留、不移出窗口（移出再放回会整页重建）；会设置窗口标题或工具栏的分区
   （扩展页的 `NavigationStack`）不能隐藏保留。
9. **主线程不做重活。** 文件内容着色、行号、diff、大字符串哈希都放到后台；Kotlin 的投影、分组在 `TimelinePresenter`
   或布局队列上调用，不在 SwiftUI 的 `body` 里调用。
10. **再次进入不重来。** 一级页面、侧边面板标签、设置分区的数据放在比视图活得久的地方（`Workbench.pageModels`、
    各面板的缓存），再进入时先显示上次的内容，后台刷新时不清空、不转圈，值没变就不写。点击的反馈先于切换：侧栏
    先画选中，下一帧再打开。

### 检查

- `scripts/perf-lint.sh`：上面能用文本匹配的规则（P1–P10），`build.sh test` 每次都会跑。确实需要例外的行加
  `perf-lint: allow <原因>`。
- 同一脚本的 C1：`.glassEffect(`、`.sharedBackgroundVisibility(` 只在 `Theme/Controls.swift` 的回退 helper 里出现。
- `scripts/perf-bench.sh <会话 id> [--sidebar] [--settings]`（或 `build.sh perf <会话 id>`）：在运行中的 dev 包上跑基准，超出预算时
  自动重跑一次，仍超出就失败（机器上的其他负载会让个别帧迟到）。改动转录、工具栏、侧栏、`Workbench` 观察或页面切换之后都要跑一次，用一个有几十轮对话、工具调用和图片的会话。

| 项目 | 预算 |
| --- | --- |
| 匀速滚动、甩动、跳到两端、流式输出的每秒卡顿 | 60 Hz 屏 ≤ 15 ms/s，120 Hz 屏 ≤ 60 ms/s |
| 上述场景的 p99 帧时间 | ≤ 2.2 帧 |
| 流式输出时主线程每次应用 p95 | ≤ 4 ms |
| 点开或收起一行到上屏 p95 | ≤ 50 ms |
| 切到会话、切到首页 p95 | ≤ 220 ms、≤ 200 ms |
| 打开会话（含读取缓存） | ≤ 800 ms |
| 设置窗口打开、首次进入分区 p95、再次切回分区 p95（`--settings`） | ≤ 300 ms、≤ 180 ms、≤ 120 ms |
| 侧栏开合的每秒卡顿 | ≤ 150 ms/s（目前约 35–110，系统分栏动画加 SwiftUI 重排；目标是换成 AppKit 分栏后 ≤ 30） |

- 卡顿的定位方法：设置 →「诊断与性能」→「性能监测」看各页面的数字；`xcrun xctrace record --template 'Time Profiler'
  --attach Riffet` 抓主线程，再看超过一帧的连续忙碌片段里是谁。
- Codex 输出延迟：启动服务端前设置 `RIFFET_CODEX_STREAM_TIMING=1`，服务日志会输出
  `[codex-stream-timing]`。每批只记录单调时钟、上游 delta 数量、UTF-16 字符数、到达跨度和
  flush 延迟，不记录正文。`timerLateMs` 高说明 flush 晚于 50ms 预算；若它接近零，而批次间隔
  很长且每批只有一个 delta，则继续检查 Codex 上游。此开关默认关闭，不改变发送节奏；
  客户端已有的 `stream recv`、`store frame` 日志及 `transcript.build/apply` 性能指标用于核对后续延迟。

## 测试与验证

```bash
pnpm typecheck && pnpm test && pnpm gen:theme:check          # 服务端、web、设计变量（含 Swift 主题）
cd apps/mobile
./gradlew :contracts:jvmTest :core:jvmTest :client:jvmTest :shared:jvmTest :terminal:jvmTest
./gradlew :client:macosArm64Test                             # 同一批 :client 测试在 Kotlin/Native 上跑
./gradlew :androidApp:assembleDebug                          # 拆分不能破坏 Android
cd ../macos
./scripts/build.sh test                                      # xcodegen + Debug 构建 + 单元测试 + perf-lint + check-i18n
./scripts/build.sh release                                   # 带内置服务的 Release 包
./scripts/build.sh dev                                       # 日常迭代：Release 逐文件编译，装到 build/Release 并重启
./scripts/build.sh dev --fast-kotlin                         # 同上，Kotlin 框架用 debug 链接（改 Kotlin 后约 20 秒，App 运行较慢）
./scripts/release.sh [--skip-build]                          # DMG；设置 RIFFET_SIGN_IDENTITY 后签名并公证
```

- `:client:macosArm64Test` 必须真的产出测试报告；Kotlin/Native 目标在非 macOS 主机上会被静默跳过，`SKIPPED` 不是通过。
- Kotlin/Native 的测试名不能含逗号（JVM 可以），移过来的测试已改名；新写的测试同样注意。
- 命令行构建需要 `-skipPackagePluginValidation`（SwiftTerm 带 SwiftPM 构建插件），`build.sh` 已带上。
- 构建耗时：整模块优化（WMO）改一个文件也要重编整个 App，约 50 秒；`build.sh dev` 用逐文件编译，改一个文件约 12 秒，什么都没改约 6 秒（2026-10-19 实测）。`dev` 只在本机用，所以不打包内置服务（服务指纹含提交号，过去每次提交后都要 `pnpm build` 并拷贝、签名 150 MB；现在启动器像 Debug 一样指向本仓库的 `dist/` 与本机 node），不生成 dSYM，安装用 rsync 只拷变化的文件。Kotlin 框架没改时 Gradle 几秒内跳过，改了要重新链接 Release 框架（80–100 秒），`--fast-kotlin` 改用 debug 框架（约 20 秒，Kotlin 侧运行慢数倍，只用于迭代 Kotlin）。发版仍用 `release.sh` 的 WMO 与内置服务。
- 时间线投影与分组只在 Kotlin 里实现并测试，Swift 不重新投影，所以没有第三套时间线断言。
- `build/Release`（`build.sh release`）与发版目录必须不同名：macOS 文件系统不区分大小写，`build/release` 就是同一个目录。
- 签名校验通过不等于能启动：每次改签名相关的东西，都直接运行一次 `Riffet.app/Contents/MacOS/Riffet` 看 dyld 是否拒绝。
- 打开设置、新会话页、某个会话的某个面板可以用 `open "riffet://home"`、 `open "riffet://settings"`、`open "riffet://session/<id>?panel=changes"`。

## 参考项目

2026-10-12 从 GitHub API 取得星数与最近发布：

| 项目 | 技术栈 | 借鉴点 |
| --- | --- | --- |
| [steipete/CodexBar](https://github.com/steipete/CodexBar)（约 22k 星，v0.74.1） | Swift，`MenuBarExtra` | 菜单栏形态、Sparkle、签名公证打包脚本 |
| [manaflow-ai/cmux](https://github.com/manaflow-ai/cmux)（约 28k 星，v0.65.0） | Swift/AppKit，libghostty | 嵌入 libghostty、Agent 需要处理时的提醒、多套 entitlements、Sparkle 在 macOS 26 上的坑 |
| [amantus-ai/vibetunnel](https://github.com/amantus-ai/vibetunnel)（约 4.7k 星，最近推送 2026-08） | SwiftUI 菜单栏 + Node 服务 | 与 Riffet 形态最接近：App 内置并托管 Node 服务、`pty.node` 打包、裁剪 Node 体积 |
| [vivy-company/aizen](https://github.com/vivy-company/aizen)（约 300 星，v1.0.83） | SwiftUI + AppKit，libghostty | Agent 工作区、tmux 持久会话 |
| [CodeEditApp/CodeEdit](https://github.com/CodeEditApp/CodeEdit) | SwiftUI + AppKit | 用 SwiftTerm 嵌入终端 |
| [migueldeicaza/SwiftTerm](https://github.com/migueldeicaza/SwiftTerm)（v1.99.0，2026-10-08） | Swift | 终端引擎本身 |
| [Dimillian/CodexMonitor](https://github.com/Dimillian/CodexMonitor)、[winfunc/opcode](https://github.com/winfunc/opcode) | Tauri | 反例：功能完整，界面不是原生的 |

## 需要拍板的决策

| 决策 | 选项 | 倾向 |
| --- | --- | --- |
| 签名身份 | Developer ID（年费，可公证、可给别人用） / ad-hoc（只给自己用，Gatekeeper 需手动放行，Sparkle 更新受限） | 先 ad-hoc 跑通 M0–M3，M4 前确定 |
| Markdown 渲染 | 基于 cmark-gfm 的解析器 + 自建 SwiftUI 渲染；或第三方 SwiftUI Markdown 库 | 已定：Apple swift-markdown + 自建渲染 |
| 服务载荷的依赖 | 带生产 `node_modules` / 为载荷单独打一份内联 bundle（只外置 `node-pty`） | 已定：只装 `dist/` 运行时加载的生产依赖（清单由构建推导），不改服务端的构建方式 |
| 默认托管方 | 首次启动主动接管为 App 托管 / 只在没有服务时才托管 | 已定：只在没有服务时托管 |
| 多窗口 | M2 后改 `SessionStore` 支持多份会话视图 / 维持单窗口 | 2026-10-19：每个会话窗口一份 store（见「Swift 与 Kotlin 的边界」） |
| 命令行工具 | App 提供「安装 `riffet` 命令」指向内置脚本 / 不提供 | 不提供，避免与开发 checkout 的符号链接冲突 |

## 分期与验收

| 阶段 | 内容 | 验收标准 |
| --- | --- | --- |
| M0 | G1–G6；`apps/macos` 的 XcodeGen 骨架；`ServerHost` 接管已有服务；本机免配对 | Swift 端拿到真实的项目与会话列表；Android `assembleDebug` 与全部 jvmTest 仍然通过；`:client:macosArm64Test` 有报告 |
| M1 | 三栏布局、侧栏两种排布、只读时间线与实时流、本机缓存 | 与 web 并排打开同一个会话，内容与排序一致；流式输出时滚动不掉帧 |
| M2 | 输入、排队、打断、审批与提问、模型与权限；通知；菜单栏；⌘K | 在 Mac 客户端点批准，CLI 真的放行；通知里的回复真的送达 |
| M3 | SwiftTerm 终端、变更与文件面板、Quick Look、快速提问面板、Spotlight、App Intents | TUI 里的 Esc、方向键、中文输入正确生效；SwiftTerm 通过 tmux fixture 对拍 |
| M4 | S1–S4；App 托管服务；签名、公证、Sparkle、Homebrew cask | 在一台没装过 riffet 的 Mac 上 `brew install --cask` 后打开即可新建会话，nvm/mise 安装的 CLI 能被找到 |

## 风险

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| SKIE 导出某些类型不顺（泛型、深层 `sealed`、默认参数） | Swift 侧出现大量手写胶水 | M0 先导出 `SessionStore` 全部公开面并写一个最小页面；不顺的类型在 `:client` 加 Swift 友好的外观层 |
| Kotlin/Native 的性能与内存和 JVM 不同 | 长会话卡顿 | M1 对 750 行以上的真实会话做 Instruments 采样；投影仍在后台调度器上 |
| 两个 VT 引擎行为不一致 | Mac 与手机的终端画面不同 | SwiftTerm 对拍同一批 tmux fixture |
| 两个托管方抢同一个状态目录 | launchd 反复拉起、服务时有时无 | 「服务托管」的判定表；S4 让 CLI 识别 App 托管 |
| launchd 下环境变量不足 | 找不到 Agent CLI | 依赖服务端环境解析；M4 在全新机器上验证；`/api/doctor` 在设置里可见 |
| App 被移动或删除 | Claude hook 指向不存在的路径 | 强制安装到「应用程序」；卸载说明里写明先在 App 里停止托管 |
| Sparkle 与 macOS 26 的系统策略 | 自动更新时 helper 被杀 | Sparkle ≥ 2.9.3（当前 2.10.0） |
| `shared` 拆分波及 Android | 移动端回归 | G1 只移文件、不改包名与行为；拆分单独提交，CI 跑完整 jvmTest 与 `assembleDebug` |

## 实现记录

2026-10-12 实现 M0–M4。以下是本机（macOS 26.4、Xcode 26.5、JDK 23）上实际跑过的检查：

| 检查 | 结果 |
| --- | --- |
| Kotlin 测试 | `:client` 157 项在 JVM 与 macosArm64 上各跑一遍全部通过；`shared` 100、`core` 77、`terminal` 150、`contracts` 28 项通过 |
| Android | `:androidApp:assembleDebug` 通过 |
| 服务端与 web | `pnpm typecheck`、`gen:theme:check`、`gen:fixtures:check` 通过；vitest 1198 项通过（新增 `version.test.ts` 与 bundled-node 用例） |
| Mac 单元测试 | 5 项通过（地址规范化、图片降采样、公式切分与手机一致、令牌按服务端区分、各页面最小宽度） |
| 本机免配对 | 连上正在运行的 `riffet start` 服务（`--host 0.0.0.0`、需要令牌），读 `access-token` 换到设备令牌，服务端设备列表出现这台 Mac |
| 界面 | 会话列表、新会话页（按目录读取模型与参数）、会话转录（过程块、工具行、Markdown、代码块、图片附件）、变更与文件面板、设置窗口均截图核对 |
| 内置服务 | 用临时数据目录和 4999 端口直接运行 Release 包里的启动器：`/health` 返回 `managedBy: "app"`，经 hardened runtime 签名的内置 node 正常创建 Shell 终端 |
| 发版 | `release.sh --skip-build`（ad-hoc）产出 65MB DMG 与 cask 所需的 sha256，`codesign --verify --deep --strict` 通过 |

2026-10-12 第二轮（按使用反馈）：

| 问题 | 处理 |
| --- | --- |
| 没选会话（以及打开面板）时侧栏被挤出窗口 | 系统 `.inspector` 打开时不压缩中间内容；改为自研右侧面板，加 `LayoutTests` |
| 面板列表只占一小块、预览空间小、文件无路径 | 列表铺满、点进去整版看 diff / 预览、路径栏与相对路径 |
| 输入框只有一行高、选项全是蓝色、发送按钮看不清、停止与发送同时出现 | `NSTextView` 输入框；中性选择器；单一动作按钮 |
| 操作不连贯 | 时间线展示移到 Kotlin 后台并合并帧；`latestGoal` 快速路径；工具行展示缓存；侧栏分组缓存；共用分钟时钟；Debug 也链接优化过的 Kotlin 产物。Release 版打开超长会话后稳定状态 CPU 平均 0.5% |
| 上次关掉主窗口后重新启动没有窗口，链接也打不开 | 主窗口 `defaultLaunchBehavior(.presented)` |
| Release 包启动即崩（Sparkle 库校验） | 见「签名、公证与分发」；此前 ad-hoc DMG 无法启动，已重新生成 |

未验证，需要后续在真实条件下检查：

- **公证**：需要 Developer ID 证书与 notarytool 凭据，本机没有；`release.sh` 的 Developer ID 分支未实际跑过。
- **SMAppService 托管**：本机已有 `riffet start` 守护进程在跑，按「只在没有服务时托管」没有注册 App 的 LaunchAgent，
  只单独验证了启动器。全新机器上的「由 Riffet 托管」、登录项授权与 nvm/mise 安装的 CLI 能否被找到，仍按 M4 验收。
- **终端**：SwiftTerm 的连接与输入只在代码层接好，没有对你正在用的 Agent 终端做交互测试，避免抢走控制权或改变 tmux 尺寸；
  也还没有用 `terminal/fixtures/tmux` 对 SwiftTerm 做逐格对拍。
- **通知、菜单栏、快速提问、快捷指令、Spotlight、服务菜单**：代码已接入并编译，没有逐项手动点验。
- **CI**：新增的 `macos-app` job 依赖 GitHub 的 `macos-26` 镜像，尚未在 CI 上跑过。
- **macOS 15**：2026-10-25 起最低系统为 15.0，只在 macOS 26 上编译与测试，未在 15 上实机运行。按 26 调过、要在 15 上核对的：
  浮动侧栏下转录的水平内容内边距（见第三轮）、`ChoiceMenu` 取代 `Menu` 的前提（`Theme/Controls.swift`）、工具栏
  「只换内容不隐藏」的玻璃胶囊规则（性能规范第 7 条）、`riffetGlass(in:)` 的材质回退。
- **多窗口**：2026-10-19 起会话可在独立窗口打开（每窗口一份 store），编译与测试通过，未做多窗口同时流式的 perf-bench。
- **2026-10-19 批次**（右侧面板按会话与全屏、转录切换占位与状态记忆、服务告警与恢复、任务 / 扩展页、发布与审阅、编排、小组件与共享扩展）：编译、单元测试与 perf-lint 通过，未实机点验；小组件与共享扩展在 ad-hoc 签名下能否被系统加载未验证。

2026-10-13 第三轮（对齐清单全部实现）：

| 检查 | 结果 |
| --- | --- |
| Kotlin 测试 | `:client` 176（新增 `TerminalRetintTest` 10 项，移植自 Web 的 `terminal-palette.test.ts`）、`shared` 91、`core` 77、`contracts` 28 项通过；`:client:macosArm64Test` 通过 |
| Android | `:androidApp:assembleDebug` 通过 |
| 服务端与 web | `pnpm typecheck`、`gen:theme:check` 通过；vitest 1210 项通过 |
| Mac 单元测试 | 15 项通过（新增 `ComposerRulesTests`：`@` / `/` 触发与 UTF-16 偏移、文件链接解析、行内公式切分、TUI 命令规则、围栏与路径语言、内置高亮分词） |
| 界面 | 用 `riffet://` 链接驱动 Debug 包截图核对：新会话页与 `/` 菜单、会话转录（回到底部、回合导航轨、tok/s、上下文环、文件链接、代码块工具条）、文件面板与高亮预览、变更面板三页、统计页、设置窗口 |
| 发版 | `release.sh`（ad-hoc）产出 71MB DMG，`codesign --verify --deep --strict` 通过；从 DMG 拷出的 App 启动正常、无崩溃报告 |

截图核对中发现并修掉的问题：hero 输入框的菜单盖住输入框；转录在浮动侧栏下水平偏移（macOS 26 的滚动视图有水平内容内边距，
滚动时不能把 x 归零）；`NSRulerView` 在 macOS 14 起默认不裁剪，填充背景时盖住整个窗口；列表测量行高被误判为用户上滑。
代码评审修掉的问题：发送期间的新输入在成功后被清空（改为只清掉本次提交的文本、附件与引用）；新会话页换项目时带着旧项目的附件；
行内公式离屏 WebView 的导航竞态；文件列表与搜索的旧结果覆盖新结果；选文件与缩图在主线程；断开时未释放防休眠。

新增深链：`riffet://session/<id>?path=<文件>&line=<行>` 打开文件预览，`riffet://stats`，`riffet://settings?section=<分区>`。

2026-10-14 第四轮（性能）：转录改为 AppKit（见「时间线」），新增性能监测与基准（见「性能预算」）。右侧「变更」面板的
整文件 Diff 改为后台计算、只画可见行的原生视图；`Palette` 的颜色按主题和角色缓存，同一角色始终是同一个对象；
输入框草稿 0.5 秒防抖写入。Mac 单元测试 39 项通过。

2026-10-27 移植 web 的转录稳定性修复（web 见 WEB.md「2026-10-27 流式输出闪烁、回合结束上跳与发送后不贴底」）：

- **回合页脚**：`TimelineRows.kt` 的每行带 `TurnFooter`（none / held / shown），规则同 web 的 `carries`；呈现层给出
  `heldFooter`。Mac 上 held 的行预留与结算页脚等高的位置（回答 8+20pt，过程块 4+20pt），「正在处理」画在里面，
  行布局不随它变；没有行持有页脚时才在末尾单独成行。工具结束、没有可复制文字的回合，过程块也显示时间与操作。
- **phase**：`TimelineItem.Assistant` 带上 `phase`；`commentary` 进过程块，`final_answer` 留在外面并持有页脚，
  没有 phase 才按位置规则。
- **发送后贴底**：发送前若最新一轮的首行不在视口之下，`TranscriptController.followSent(in:)` 转为跟随。
- 回合结束时位于回答之上的过程块折叠：跟随中锚点是底部，末尾不动；内容不足一屏时（没有滚动）回答会随之上移。
- 会话输入框去掉模式选择。

验证：`:client:jvmTest`、`:shared:jvmTest`、`:contracts:jvmTest`、`:androidApp:compileDebugKotlin`、
`:client:linkDebugFrameworkIosSimulatorArm64`、iOS 模拟器无签名编译、Mac Debug 编译、perf-lint、check-i18n 通过；未实机点验。

## 与 Web 的功能对齐清单

2026-10-12 按 `apps/web/src` 逐文件盘点，2026-10-13 全部实现。状态：✅ 已对齐，◐ 部分支持，✗ 未支持。
2026-11-20 起，本清单只跟踪 [Mac 客户端范围规范](guide/mac-scope.md) 的 W 类（工作路径）。下文的设置各分区、统计、扩展页、任务页属于 M 类，是历史记录：这些页面已冻结，不再随 Web 更新。

优先级：**P0** 影响日常主流程，**P1** 常用但有替代路径，**P2** 低频或管理类。Mac 独有的能力（菜单栏、可操作通知、
快速提问、Spotlight、快捷指令、本机免配对与服务托管）不在表内。

### 输入框

| 功能 | Web 位置 | Mac | 优先级 |
| --- | --- | --- | --- |
| 发送、排队、立即发送（打断）、停止 | `Composer.tsx:755` | ✅ | — |
| 附件：拖放、图文混合粘贴、24 MiB / 20 个上限、整批拒绝、去重 | `composerAttachmentIntake.ts` | ✅ | — |
| 草稿按会话保存 | `Composer.tsx:272` | ✅ 会话按会话保存；新会话页按后端 + 配置分开（`home.<backend>.<profile>`） | — |
| 排队消息移回草稿（含附件） | `Composer.tsx:234` | ✅ | — |
| 待办、目标、排队、未确认 dock | `ComposerDock.tsx` | ✅ | — |
| **斜杠命令菜单**（命令与 Skills、句中 Skills、未知命令透传、60 秒缓存） | `slashMenu.ts`、`useSlashCatalog.ts` | ✅ `ComposerMenu.swift`：命令与 Skills 分组、句中 Skills、未知命令「发送给 …」、打开时刷新目录；规则是 `SlashRules.kt` | — |
| **@ 引用文件**（搜索项目文件，生成上下文引用） | `Composer.tsx:620` | ✅ `@` 搜索项目文件（140ms 防抖、前 10 个），选中生成引用标签，随消息或新会话首条消息发出 | — |
| **Enter 键行为设置**（Enter 发送 / ⌘↩ 发送，按钮提示跟随） | `composerKeyboard.ts:107` | ✅ 读服务端 `composerEnterBehavior`；`send` 时 ↩ 发送、⇧↩ / ⌥↩ 换行，按钮提示跟随 | — |
| **上下文用量环**（颜色分档、分项明细、费用） | `Composer.tsx:46` | ✅ `ContextMeter`：90% / 75% 分档着色，点开看分项 token（原生会话不传费用，Web 在原生会话里同样不显示） | — |
| 模型选择器的账号用量与配额 | `ModelPicker.tsx:212` | ✅ 菜单打开时读 `backendUsage`：账号窗口摘要、每个模型的负载与配额（`ModelUsageRules.kt`） | — |
| 模型目录加载失败的重试提示 | `NativeSession.tsx:672` | ✅ 加载中、失败原因、空目录三种状态，各带「重试」 | — |
| 全屏编辑 | `ComposerFullscreen.tsx` | ✅ 覆盖整个会话区，转录隐藏，esc 退出 | — |
| 引用回答（消息菜单「引用」） | 移动端 `MessageMenuButton` | ✅ 消息右键与回答页脚「⋯」是同一个菜单（`TranscriptCell.messageMenu`）：复制、引用回复、收藏回复、导出为图片、从这里分叉、回退代码；选项在菜单关闭后才执行 | — |
| 输入框滚到头后滚轮穿透到转录 | `Composer.tsx:450` | ✅ `PassthroughScrollView`：草稿到顶 / 到底后把滚轮交给转录 | — |

### 转录

| 功能 | Web 位置 | Mac | 优先级 |
| --- | --- | --- | --- |
| 过程块、思考、工具行、diff、任务通知、计划、图片 | `Timeline.tsx` | ✅（规则与手机同一份 Kotlin） | — |
| 过程块有报错时保持展开 | `TurnProcess.tsx:23` | ✅ 运行中或有失败步骤时默认展开 | — |
| **代码块语法高亮**（45 种语言，进入视口后分词） | `Markdown.tsx:80`、`lib/highlight.ts` | ✅ `CodeHighlighter`：打包同一份 refractor 与 45 种语法，JavaScriptCore 后台分词并缓存，配色取主题 token | — |
| 代码块自动换行开关 | `Markdown.tsx` | ✅ | — |
| `markdown` 围栏「源码 ⇄ 渲染」切换 | `Markdown.tsx:114` | ✅ | — |
| **行内公式 `$…$`** | `Markdown.tsx:48`（remark-math） | ✅ 服务端 KaTeX 页离屏渲染成图片嵌入文字，按公式与主题缓存；`$5 and $10` 这类金额保持原文；` ```math ` 围栏渲染为块级公式 | — |
| **正文里的文件路径可点击**（`src/app.ts:42` → 打开预览并定位行） | `Markdown.tsx:180` | ✅ 链接与行内代码路径（`src/app.ts:42`、`#L12`）打开右侧预览并定位行，⌘ 点击在编辑器中打开 | — |
| 本地 / 相对路径图片 | `Markdown.tsx:172` | ✅ | — |
| **回到底部按钮**、脱离贴底后不再跟随 | `TranscriptView.tsx:476,525` | ✅ `TranscriptController`：只在用户滚动时切换跟随，离底出现按钮（`BackToBottomView`，⌘↓） | — |
| **视口外待确认提醒**（「X 项待确认 · 查看」） | `TranscriptView.tsx:513` | ✅ 不需要：Mac 的交互卡片固定在输入框上方，不随转录滚出视口 | — |
| 加载更早消息时保持阅读位置 | `readingAnchor.ts:8` | ✅ 加载前记下距底部的距离，内容增高后恢复 | — |
| 搜索命中定位并高亮 | `TranscriptView.tsx:232` | ✅ | — |
| **回合导航轨 TurnRail**（右侧刻度、悬停预览、点击定位） | `TurnRail.tsx:65` | ✅ `TurnRailView`：刻度、当前回合加长、悬停预览（最多两行）、点击定位（数据来自 `TimelinePresenter.turns`） | — |
| **输出速度 tok/s**（精确 / 估算 `~`） | `Timeline.tsx:90` | ✅ 回答页脚显示，估算值带 `~`，悬停看说明（`TimelinePresenter.speeds`） | — |
| 正文宽度拖拽调节（640–1600，双击复位） | `ContentWidthHandle.tsx` | ✅ 正文右侧把手，640–1600，双击复位；设置里也可调 | — |
| 用户消息投递状态（排队中 / 已收到 / 未确定） | `Timeline.tsx:41` | ✅ 移植 `nativeDeliveryLabel`：发送中、即将发送、正在准备 CLI、等待 CLI 确认、CLI 已收到等 | — |
| 子 Agent 页 | `SubagentSession.tsx` | ✅ 多级嵌套（最多 8 层、可返回上一层）、父会话待确认卡片穿透、派生提示词注入（`SubagentEvents.kt`） | — |

### 交互卡片

| 功能 | Web 位置 | Mac | 优先级 |
| --- | --- | --- | --- |
| 审批 / 单选多选 / 其他文本 / 计划 Markdown / 题号 | `NativeInteractionCard.tsx` | ✅ | — |
| **409 题目已变化、网络未知结果的幂等重试与「同步」** | `NativeInteractionCard.tsx:174-177` | ✅ 提交中 / 未知（同一请求重试）/ 未确认 / 已变化（409）/ 成功五态，「同步」与「终端」按钮 | — |
| 「在终端处理」兜底按钮 | `NativeInteractionCard.tsx:325` | ✅ | — |
| 选择草稿暂存（切走再回来不丢） | `NativeInteractionCard.tsx:112` | ✅ 按会话 + 交互保存，题目改版时提示「旧草稿未提交」 | — |
| 超时倒计时与「延长」、1–9 选择、Esc 拒绝 | `NativeInteractionCard.tsx:16,260` | ✅ 按 `expiresAt` 显示「m:ss 后自动拒绝」（最后两分钟警示色），`extendableUntil` 晚于截止时间时显示「延长」；卡片获得焦点时 1–9 选第 n 个选项或动作；只有键盘进入卡片（Tab 或程序聚焦）时 Esc 才按 deny / decline / reject / cancel 顺序拒绝并在标题旁显示提示，点卡片空白处后 Esc 交给页面（例如子 Agent 页返回）；输入框里打字不受影响 | — |
| **「等待终端操作」横幅**（CLI 在等但解析不出卡片） | `NativeSession.tsx:509` | ✅ 横幅 + 标题徽标；支持终端的后端 0.7 秒后自动打开终端抽屉，识别出卡片后收起 | — |

### 会话页头与会话操作

| 功能 | Web 位置 | Mac | 优先级 |
| --- | --- | --- | --- |
| 运行状态徽标（连接中、运行中、等待确认、冲突） | `Header.tsx:210` | ✅ 重连中 / 连接失败 / 连接冲突 / 启动中 / 同步中 / 等待确认 / 等待终端操作，否则显示运行中 / 出错；规则在 `:client` 的 `conversationStatus` | — |
| **Git 分支显示** | `Header.tsx:135` | ✅ ⋯ 菜单顶部显示当前分支与改动统计，点击复制 | — |
| 点标题重命名 | `Header.tsx:201` | ✅ | — |
| 置顶、归档、重命名 | `Header.tsx:154` | ✅（侧栏右键） | — |
| **编辑标签**（会话与项目）、按标签筛选 | `Sidebar.tsx:202,304` | ✅ 会话与项目标签编辑器（含已有标签建议），侧栏按标签筛选 | — |
| Worktree 徽标 | `Header.tsx:265` | ✅ 标题与侧栏项目头显示分支与「Worktree」 | — |
| **子 Agent 与后台任务计数和弹层** | `SessionWorkActions.tsx` | ✅ 工具栏计数（运行中带点），弹层列出并可打开子 Agent | — |
| **对话 ⇄ 终端整页切换**、对话下方半屏终端抽屉 | `NativeSession.tsx:414,562` | ✅ ⇧⌘T 整页切换；对话下方终端抽屉 | — |
| 发送 `/summarize` 这类只在 TUI 输出的命令后自动打开终端 | `NativeSession.tsx:664` | ✅ 移植 `commandNeedsTerminal`；Claude Code 的命令总是打开 | — |
| **重新打开 / 恢复 CLI**（进程退出或参数陈旧时） | `NativeSession.tsx:338` | ✅ 离线横幅「恢复会话」与终端页「重新打开」（`POST /api/sessions/:id/start`） | — |
| 运行中防止休眠（Wake Lock） | `NativeSession.tsx:206` | ✅ `ProcessInfo.beginActivity` | — |

### 侧栏、新会话页、命令面板

| 功能 | Web 位置 | Mac | 优先级 |
| --- | --- | --- | --- |
| 两种排布、搜索会话与消息、显示已归档、置顶 | `Sidebar.tsx` | ✅ | — |
| **添加项目**（侧栏 + 号、无项目引导） | `Sidebar.tsx:322`、`ProjectHome.tsx:284` | ✅ 侧栏工具栏「添加项目」，无项目时引导；远程服务器用目录浏览器 | — |
| 项目重命名、归档 / 恢复 | `Sidebar.tsx:363` | ✅ 项目右键：重命名、编辑标签、归档 / 恢复、删除（只从 Riffet 移除） | — |
| CLI 缺失或未登录时的侧栏警告 | `Sidebar.tsx:220` | ✅ 侧栏底部：默认 Agent 不可用或 Cursor 未登录 | — |
| 新会话页：项目、后端、配置、模型、模式、审批、最近会话 | `ProjectHome.tsx` | ✅ | — |
| **新建 Worktree 作为会话目录** | `DirectoryMenu.tsx:57` | ✅ 目录菜单「新建 Worktree」，Worktree 嵌套在原项目下 | — |
| 「继续历史会话」（Cursor 恢复器）、「Shell 终端」快捷卡片 | `ProjectHome.tsx:257` | ✅ | — |
| 命令面板：新会话、会话、项目 | `CommandPalette.tsx` | ✅ | — |
| 命令面板：打开统计、切换侧栏 / 终端、直达各设置分类 | `Workbench.tsx:1064-1068` | ✅ 另加切换对话 / 终端视图 | — |
| ⌘B 切换侧栏 | `Workbench.tsx:477` | ✅ | — |

### 右侧面板

| 功能 | Web 位置 | Mac | 优先级 |
| --- | --- | --- | --- |
| 文件浏览、路径栏、按文件名查找、预览（行号、图片、二进制） | `ContextPanel.tsx` | ✅ | — |
| **按内容搜索**（命中行预览、跳到对应行） | `ContextPanel.tsx:345` | ✅ 文件名 / 内容两种模式，命中行可打开并定位、引用、在编辑器中打开 | — |
| **预览语法高亮**；大文件虚拟滚动（>64KB / 500 行） | `ContextPanel.tsx:327`、`LargeFilePreview.tsx` | ✅ `CodeTextView`（NSTextView，只排版可见部分）+ 同一份高亮；跳到行并闪烁 | — |
| **点行号把那一行引用到对话**；文件「引用到对话」 | `ContextPanel.tsx:28,327` | ✅ 点行号引用该行；列表悬停「+」与预览头部「引用整个文件」 | — |
| HTML 沙箱渲染 ⇄ 源码 | `ContextPanel.tsx:307` | ✅ 非持久化 WKWebView 渲染，可切回源码 | — |
| 下载单文件 / 打包下载 ZIP | `ContextPanel.tsx:210` | ✅ 存储面板选择位置，ZIP 先校验大小上限 | — |
| 目录分页加载（每页 100 项） | `ContextPanel.tsx:219` | ✅ | — |
| 变更：列表、单文件暂存 / 取消、提交、diff | `GitPanel.tsx` | ✅ | — |
| 全部暂存 / 全部取消 | `GitPanel.tsx:174` | ✅ | — |
| **检查点**（创建、查看改动、带指纹校验的恢复） | `GitPanel.tsx:213-128` | ✅ `GitCheckpoints.swift`：创建、查看改动；恢复前列出改动与指纹，确认后以 `expectedChanges` 提交，409 时重新拉取再确认 | — |
| **Worktree 管理**（列表、新建、在此开始会话、删除） | `GitPanel.tsx:251-262` | ✅ `GitWorktrees.swift`：列表（分支、短 hash、`~` 路径、当前）、新建（分支 + 基准）、在此开始会话、移除确认 | — |
| 终端：多终端切换、新建 Shell、接管 | `TerminalDock.tsx`、`TerminalView.tsx` | ✅ | — |
| **终端历史回看**（向上滚动拉取 `/history`、回到实时） | `TerminalView.tsx:448` | ✅ 「历史输出」读 `/history` 全文，可选择复制，再点回到实时 | — |
| 中断进程（SIGINT）、关闭终端、释放控制权、手动重连 | `TerminalView.tsx:327-400` | ✅ 中断（确认）、关闭 Shell、释放控制权、重新连接 | — |
| 浅色主题下改写 TUI 深色背景 | （原 `lib/terminal-palette.ts`） | ✅ 移植为 `TerminalRetint.kt`（含 Web 的全部测试用例）；ANSI 色板按主题与明暗取 Web 同一套 | — |

### 设置

| 分类 | Web | Mac | 优先级 |
| --- | --- | --- | --- |
| 外观：6 套内置主题，色卡预览 | ✅ | ✅ 设置内色卡网格，含自定义主题 | — |
| 外观：明暗手动切换（跟随系统 / 浅色 / 深色） | `PreferencesSections.tsx:61` | ✅ 设置与侧栏底部菜单 | — |
| 外观：文字大小、会话间距、终端字号 | `PreferencesSections.tsx:64-70` | ✅ | — |
| 通知 | ✅ | ✅（系统通知，更完整） | — |
| 交互：Enter 键、任务运行时的排队 / 引导 | `PreferencesSections.tsx:144` | ✅ 设置 → 交互与输入 | — |
| **Agent 与模型**：默认后端、默认审批、提供商增删改、API Key、模型探测与模态、默认模型参数、Cursor 网关 | `BackendProfilesSection.tsx` | ✅ `AgentSettings.swift`：默认后端、提供商增删改、API Key、模型探测与勾选、默认模型与参数、Cursor 网关；默认审批按 Agent 设置 | — |
| **辅助模型**：会话标题、交接摘要（可输入试用）、画布摘要（不可试用） | `AuxiliaryModelsSection.tsx` | ✅ `AuxiliaryModelSettings.swift` | — |
| CLI 与命令：快捷命令与允许列表内的自定义命令 | `SettingsDialog.tsx:209` | ✅ Agent 与模型 → Cursor 弹窗；能力检查与 status / models / about / team / mcp / 插件市场 / update | — |
| 项目配置：Rules / Skills / Commands / MCP / Hooks 的查看、新建、带指纹的编辑 | `SettingsDialog.tsx:319-341` | ✅ 按项目查看、新建、等宽编辑，带 `expectedHash` 保存，冲突时提示重新读取 | — |
| 文件与编辑器：允许读项目外路径、服务端编辑器命令 | `PreferencesSections.tsx:188-193` | ✅ 本机编辑器 + 服务端 `allowOutsideRead`、`editorCommand` | — |
| 诊断与性能：能力检测、警告、模型、性能监测、导出 JSON | `SupportSections.tsx:29-45` | ✅ 能力、警告、模型列表，导出 JSON（不含 API Key） | — |
| 备份：创建在线备份、恢复说明 | `SupportSections.tsx:63` | ✅ `api.backup()` 保存为文件，附恢复命令 | — |
| 关于 Riffet | ✅ | ✅ 应用信息、更新与源码 | — |

### 统计

✅ `Features/Stats/*`（Swift Charts）：时间预设与自定义日期、按 Agent / 模型 / 项目多选、含估算开关；8 张 KPI 与环比；
用量面积图（指标切换、按 Agent / 模型 / 项目堆叠、断档不补 0、拖拽改时间窗，悬停读数与十字线浮在图内）；
Agent 占比环图；星期 × 小时与日历热力；
模型排行；延迟与速度分位；可靠性与工具分布；明细表按会话聚合（一行一个会话，展开看每一轮；游标「加载更多」，每页 50 轮）；
CSV / JSON 导出；页面可见时订阅
`/api/stats/stream`，2 秒节流刷新。与 Web 的差异只在动效：没有 KPI 数字滚动、路径形变动画和独立的迷你框选条。

### 汇总

2026-10-19 补齐 10-13 之后 Web 新增的部分：

| 功能 | Web 位置 | Mac |
| --- | --- | --- |
| 任务页：任务模板与自动化（cron 预设、启停、立即运行、每次新 Worktree） | `automations/AutomationsPage.tsx` | ✅ `Features/Tasks/`；模板目标是完整的 Agent / 配置 / 模型 / 模式 / 审批 |
| 独立扩展页：跨 Agent 与配置聚合、概览、多选批量启停、筛选 | `extensions/*` | ✅ `Features/Extensions/`，与设置页共用详情、文档编辑、安装与动作规则 |
| 右侧面板全屏 | `WorkbenchPanels.tsx` | ✅ 盖住对话区（对话不重排），⌥⌘F；面板开关、标签、全屏按会话记忆 |
| 发布区：推送、PR 状态与 CI、让 Agent 修复 CI；合并 Worktree | `panels/PublishSection.tsx` | ✅ `Inspector/PublishSection.swift` |
| Diff 行级审阅评论发给 Agent | `GitPanel.tsx` | ✅ 点行号（Shift 扩选）写评论，可编辑，附总体备注 |
| 回合分叉、回退代码到本回合前 | `Timeline.tsx`、`NativeSession.tsx` | ✅ 回答页脚「⋯」菜单 |
| 交接会话（可交回同一 Agent）、存为任务模板、导出会话、来源提示 | `SessionHandoff.tsx` | ✅ 会话菜单；转录首行「分叉自 / 交接自」、末行「已交接给」，随历史滚动 |
| 并行尝试与采用 | `session/Attempts.tsx` | ✅ 首页「并行尝试」，会话顶部对比条 |
| 新会话预热、服务端消息搜索 | `ProjectHome.tsx`、`use-message-search.ts` | ✅ 搜索先出本机命中，再合并服务端命中 |

表内 P0、P1、P2 全部对齐。刻意保留的差异：

- 统计页没有 KPI 数字滚动、路径形变动画与独立迷你框选条；明细表用「加载更多」代替翻页。
- 设置：终端字号是 11–16 滑块（Web 为四档），主题使用色卡网格；切换设置分区时不拦截未保存的草稿；
  「Agent 与模型 → Cursor」的 CLI 面板只有检查与更新，没有「安装 CLI」。
- 变更面板的 diff 是整页下钻而不是对话框。
- 交互卡片固定在输入框上方，因此不需要「视口外待确认」提醒。

### 2026-11-12 盘点：待补齐

按 `apps/web/src` 重新盘点。画布与「对话 / 终端 / 画布」视图切换（含插件的会话视图位置）见「画布」一节，不在此列。

| 阶段 | 功能 | Web 位置 | Mac 现状 | 做法 |
| --- | --- | --- | --- | --- |
| 进行中 | 会话标签页：临时标签、置顶分区、右键菜单、关闭其他 / 右侧、重新打开、溢出菜单、未读点；设置「标签样式」「打开会话时」与快捷键 | `tabs/*`、`settings/TabsSection.tsx` | 仅 Riffet 风格，最多 12 个，只能点击与关闭 | 标签状态移出视图，按服务器存在本机；快捷键用 Mac 惯例：⌘1–9、⌃Tab / ⇧⌘[ ]、⌘W、⇧⌘T。不做「独立一行」 |
| 一 | 会话概览栏：计划、章节导航、子 Agent 与后台任务、产出文件 | `session/SessionAside.tsx` | 无；计划在输入框上方 | Riffet 风格配方 `rightPanel: outline` 的落地：正文右侧 248pt 一栏；设置「会话右侧：概览 / 仅导航条」，只在 Riffet 风格出现，默认概览；宽度不够或检查器放不下时退回导航条，空栏也保留；显示时隐藏输入框上方计划与右侧刻线；`sessionOutputs` 移到 `apps/mobile/core` 共用 |
| 一 | 技能与工具选择器：手机控制、MCP、Skill 按会话开关 | `session/ToolsPicker.tsx` | `toolGroups` / `extensionsOff` 固定传 nil | 新会话页输入框左侧工具按钮；已有会话走 `SessionUpdate` |
| 一 | 插件快捷键生效 | `app/pluginKeybindings.ts` | 只显示文字 | 注册为菜单命令，与 App 快捷键冲突时 App 优先，插件页标出冲突；在标签页之后做 |
| 二 | 文件面板代码导航：⌘ 点击跳到定义、查找用法、最近查看、⌘P 快速打开 | `panels/FilesPanel.tsx`、`panels/QuickOpen.tsx` | 只有按名称 / 内容搜索 | 走服务端 `code-nav`；`CodeTextView` 点击位置换算成字符偏移；⌘P 独立于命令面板 |
| 二 | 会话信息：本会话收藏、模型与权限 | `session/marks.tsx`、`SessionInfo.tsx` | 只有目录、分支、创建时间 | 补到现有会话信息弹层 |
| 二 | 导航条样式：线 / 圆点 | `settings/ViewsSection.tsx` | 只有刻线 | 和「会话右侧」放在同一组 |
| 二 | 侧栏收起后悬停浮出与「固定侧边栏」 | `use-sidebar-peek.ts` | 无 | 只做自绘风格（Riffet、线条），浮出时盖在内容上不挤正文 |
| 三 | 机器人（飞书）设置页 | `settings/ChannelsSection.tsx`、`settings/channels/*` | 无 | 现有表单组件 |
| 三 | 分享管理：全部分享、复制、核对、重试、取消、默认发布目标 | `shares/SharesSection.tsx` | 只有单会话分享 | 设置页列表 |
| 三 | 设备管理：在线状态、最后在线、Agent 操作与无障碍状态、清理 7 天未用 | `settings/DevicesSection.tsx` | 只有名称、配对时间、撤销 | 补到现有设备列表 |

每项交给写入范围互不重叠的 worker，主 agent 审查与整合；每项过 Debug 构建与 `check-i18n`，改到 Kotlin core 时再编 `:core`。

2026-11-12 以上全部实现（未经人工界面验收）。与表中做法不同或暂缓的：

- 标签页：不做拖拽排序、标签悬停卡片和「独立一行」；⇧⌘T 在标签栏开启时改为重新打开标签，「切换对话/终端视图」此时没有快捷键；⌘W 替换系统「关闭」，没有当前标签时关闭窗口。
- 会话概览：导航区是回合列表（Web 的 `TurnOutline`），回答内章节仍由章节导航负责；计划折叠后不单列「已完成 N 项」。
- 技能与工具：已有会话改动后下次启动生效，保存失败时静默回退，没有错误提示。
- 插件快捷键：App 占用的组合是 `PluginKeybindings.swift` 里的手写表，新增 App 快捷键时同步更新。
- 代码导航：不做 Web 的跳转返回历史，最近查看标签代替。
- 侧栏浮出：不做悬停「显示侧栏」按钮触发。
- 机器人：RiffetKit 还没有 `/api/channels`，暂由 `Services/ServerJSON.swift` 直连，之后移入 Kotlin 客户端供手机端复用；不做斜杠命令说明、卡片实时预览和 `channels` 推送（操作后与添加期间轮询）。
- 设备：RiffetKit 不提供当前设备 id，没有「这台设备」标记；7 天未用的设备用一行批量撤销，不做折叠分组。
