# Riffet 终端：全维度 SOTA 优化方案

日期：2026-11-23。状态：M1–M5 核心能力已落地（服务端 `protocol=4` / 现代 tmux / Shell Integration / Profiles、Web + Kotlin/Android + macOS 渲染与保活池、全端搜索/智能链接/OSC 133 导航、Web 分屏与 macOS 独立终端窗口）。承接 `docs/TERMINAL.md`（tmux control mode 与 `protocol=3` 原始 pane 流）与 `docs/MOBILE-TERMINAL.md`，面向服务端、Web、macOS、iOS 与 Android，从性能、稳定性、生产力与自定义四个方向全量对齐开源 SOTA（Ghostty、WezTerm、VS Code Terminal、iTerm2、Blink）。

## 0. 结论与执行顺序

目标不是挑几个点做局部修补，而是把四端终端推向 SOTA 状态；排期的唯一依据是**工程依赖与零返工**：

1. **M1 · 服务端内核、tmux 现代能力与 `protocol=4`**：先把传输协议、tmux 特性、元数据同步、Shell Integration 注入与 Shell Profiles 定型，四端连接层只升级一次。
2. **M2 · 四端渲染引擎定型与性能拉满**：先完成 macOS 引擎 Spike（`libghostty` / Metal vs SwiftTerm）并定稿，同时补齐 Web Unicode/WebGL 与 Android 行级缓存/脏行复用；引擎先定，上层功能不返工。
3. **M3 · 零闪烁稳态基建与全量自定义体系**：Keep-Alive 保活池、iOS 后台宽限期、Resize 保持回看位置、OSC 52 三态安全策略、全量 C 类本地自定义项与统一快捷键穿透表。
4. **M4 · 核心生产力闭环**：全端搜索、智能链接与项目文件路径直达文件面板、Shell Integration（OSC 133/7）前端消费、Android/iOS 交互短板补齐。
5. **M5 · 多窗格工作区与封板验证**：Web + macOS 分屏与独立窗口、全端对拍与生产构建帧率/内存验收、清理历史债务。

## 1. macOS / iOS 渲染引擎选型：`libghostty` vs SwiftTerm

Riffet macOS 客户端目标为纯 `arm64` + `macOS 15.0`（见 `apps/macos/project.yml`），已具备 `xcodegen`、`RiffetKit.xcframework` 与 `scripts/sign-frameworks.sh` 的二进制 framework 打包签名链路。

### 1.1 本质差异

| 维度 | 方案 1：`libghostty`（Ghostty 内核） | 方案 2：SwiftTerm 深度优化 |
| --- | --- | --- |
| 渲染管线 | Metal GPU + 原生字形图集，4K 120Hz 满屏滚屏轻松稳帧 | CoreText / CoreGraphics CPU 绘制，大屏高吞吐易掉帧且主线程 CPU 高 |
| 排版与字体 | 原生支持连字、精准基线、框线/Powerline/块元素像素级自绘、Unicode 15/Grapheme | 连字弱、宽字符/复杂 Emoji 边界偶有错位、框线依赖字体 |
| 协议完备度 | 完整 Kitty 键盘协议、Kitty 图形协议、DECSET 2026 同步帧、OSC 8/133/52、波浪/彩色下划线 | 现代协议支持不完整，部分特性需 fork 补丁 |
| 远程流接入方式 | **`GhosttyKit` 完整版自带 PTY，接远程 WS 需经本地 `openpty()` 桥接或自定义 IO**；纯 **`libghostty-vt`** 只含 VT 解析器、不含渲染器 | 直接 `view.feed(text:)`，原生契合远程流 |
| 工程与构建代价 | 需引入预编译 `GhosttyKit.xcframework`（避免全员装 Zig 工具链）、C ABI 桥接层、处理中文 IME 与 AppKit 事件路由 | 零新构建链，纯 SwiftPM 依赖 |

### 1.2 真实代价与可接受判定线

把代价拆成三类看：
- **构建与 CI 代价（可消除）**：不把 Zig 编译器塞进日常开发与 CI 构建流程；采用独立脚本/发布产物预编译带版本号与校验和的 `GhosttyKit.xcframework`（与现有 `RiffetKit.xcframework` 同模式），日常 `xcodegen` 零感知。
- **架构适配代价（Spike 验证重点）**：Riffet 终端是远端 WS 字节流而非本地子进程。若走 `GhosttyKit` + 本地 `openpty()` 桥接，需验证：① 无多余 shell 进程（仅用一对内核 PTY fd 喂字节）；② `resize`、OSC 52、中文 IME、选区复制、滚动位置、主题热切换全部可控；③ 内存与 App 增量体积可控（单 `arm64` 静态库通常 3–8 MB）。
- **iOS 复用代价**：iOS 若同样用 Metal 视图，需确认触摸滚动、选择手柄与系统键盘接入成熟度；若 iOS 侧不够成熟，可仅 macOS 切 `GhosttyKit`、iOS 保留 SwiftTerm（两者实现同一套 `TerminalSurfaceBackend` 协议）。

**M2 Spike 退出门禁（限时 3 天）**：在独立分支跑通 `GhosttyKit` 接入 `protocol=4` 远程流，满足「中文 IME 正常 + 10000 行回看选区复制正常 + 4K 滚屏稳定 120fps + App 体积增量 ≤10 MB + 无需开发者装 Zig」即正式采用；任一硬项不满足则无缝回落至 SwiftTerm 优化路径，业务层因面向 `TerminalSurfaceBackend` 编程而零返工。

## 2. 架构归类与平台范围

- **多服务器归类**（`docs/guide/multi-server.md`）：
  - **A 类（工作对象）**：终端实例（`TerminalInfo`）、会话关联与租约，id 为全局 UUID，跨互联服务器只经按服务器选目标的请求层访问，不硬编码 `/api/` 路径。
  - **B 类（环境与配置）**：服务器本机的默认 Shell、Shell Profiles（启动预设）、Shell Integration 注入开关。只在对应服务器的设置页修改，不做远程跨端改配置。
  - **C 类（人的偏好）**：字号、字体族、行高、字距、连字、边距、光标样式、Option-as-Meta、选中即复制、独立配色方案、渲染器模式、OSC 52 策略、快捷键与穿透表、移动端键栏布局。仅保存在本机设备。
- **Mac 客户端范围**（`docs/guide/mac-scope.md`）：
  - 终端本体、搜索、链接跳转、分屏、本地外观与快捷键属于 **W 类（工作路径）** 与 **L 类（本机偏好）**，原生实现并与 Web 同步。
  - 独立终端窗口拆出、原生 Metal 渲染与系统通知属于 **S 类（系统能力）**。
  - 服务器端 Shell Profiles 的批量管理属于 **M 类**，Mac 设置提供入口跳转对应服务器的 Web 设置页，新建终端菜单只读消费已配置的 Profiles。

## 3. M1 · 服务端内核、tmux 现代能力与 `protocol=4`

### 3.1 tmux 现代能力与健壮性（`apps/server/src/terminal/`）

- **现代 tmux 配置**（在私有 tmux server 初始化与会话创建时按能力探测生效，仅影响 Riffet 私有 socket）：
  - `set-option -s escape-time 10`：消除默认的 500 ms `Esc` 延迟。
  - `set-option -s extended-keys on` 与 `set-option -s extended-keys-format csi-u`（tmux ≥ 3.2 支持时启用）：透传 `Shift+Enter` 等现代组合键。
  - `set-option -g focus-events on`：透传焦点进出事件（`?1004`）。
  - `set-option -as terminal-features 'xterm*:RGB:strikethrough:usstyle:overline:sync:extkeys:hyperlinks'`（按 tmux 版本探测可用特性集）。
- **`ControlClient` 优化**（`apps/server/src/terminal/control.ts`）：
  - 行前缀匹配改为字节比较，减少高频 `%output` 下的临时字符串与数组分配。
  - 监听 `%window-renamed` 并在 seed 与状态推送中同步 `pane_title`、`pane_current_path`、`pane_current_command`。
- **`OuterTerminalState` 防呆**（`apps/server/src/terminal/protocol-state.ts`）：
  - `pending` 未闭合序列缓冲设置 4 KiB 硬上限，超出即清空未闭合片段，避免畸形输出卡死模式跟踪。
- **空闲普通 Shell 自动 detach**（`apps/server/src/terminal/service.ts`）：
  - 无 viewer 且无 server-side observer 的普通 `shell` 终端，在空闲超过 `TERMINAL_IDLE_DETACH_MS`（收口在 `packages/contracts/src/budgets.ts`，默认 60 s）后主动关闭 `ControlClient` 释放子进程与内存；下次 `subscribe` / `input` / `get` 时按需 `attach`（tmux 会话本身持续运行）。Agent CLI 终端因需要 observer 维持实时状态，不触发空闲 detach。

### 3.2 传输协议 `protocol=4`（二进制帧 + 压缩 + 心跳）

沿用 `/api/terminals/:id/ws?protocol=4`，与 `protocol=3` 共存（遵循 `apps/server/src/routes/AGENTS.md` 只增不破）：

- **控制消息仍走 Text Frame（JSON）**：`claim`、`release`、`resize`、`paste`、`ack`、`state`、`error`、`exit`，完全复用既有契约。
- **数据与心跳走 Binary Frame**（<!-- doc-paths:off -->`apps/server/src/terminal/wire.ts`<!-- doc-paths:on -->）：
  - `0x01 OUTPUT`：`[type:u8][seq:u32be][streamIdLen:u8][streamId:utf8][payload:utf8]`
  - `0x02 SNAPSHOT_RAW`：`[type:u8][seq:u32be][cols:u16be][rows:u16be][streamIdLen:u8][streamId:utf8][payload:utf8]`
  - `0x03 SNAPSHOT_DEFLATE`：同上，payload 经 raw deflate 压缩（仅当快照字节数 ≥ 4 KiB 且压缩后确实更小时使用）
  - `0x04 INPUT`（C→S）：`[type:u8][epoch:u32be][clientIdLen:u8][clientId:utf8][payload:utf8]`
  - `0x05 PING` / `0x06 PONG`：`[type:u8][ts:u64be]`（服务端按心跳间隔发 Ping，超时无 Pong 主动断开，客户端同理触发快连）
- **流控**：继续使用 `ack` 字符计数（按解压后的 UTF-8/UTF-16 长度计数），保留 `MAX_UNACKED_CHARS + seedChars` 防死循环不变量。

### 3.3 Shell Integration（默认开启）与 Shell Profiles

- **默认策略**：对 Riffet 新建的 `shell` 终端默认注入轻量 Shell Integration（支持 `zsh`、`bash`、`fish`），在服务器设置页提供全局开关（B 类，默认 `true`），绝不修改用户主目录下的 `~/.zshrc` / `~/.bashrc`。
- **注入机制**：利用 Shell 原生启动钩子（`zsh` 使用私有 `ZDOTDIR` 包装并转发加载用户原 `$ZDOTDIR/.zshrc`；`bash` 使用 `--rcfile` 包装脚本；`fish` 注入 `XDG_DATA_DIRS` vendor conf），发出标准 **OSC 133**（`A` 提示符开始、`B` 命令输入开始、`C` 命令开始执行、`D;<exitCode>` 命令结束）与 **OSC 7**（`file://host/path` 当前目录）。
- **Shell Profiles（B 类）**：在 `AppSettings` 中新增可选的 `terminal` 字段（`defaultShell`、`shellIntegration`、`profiles[]`，每个 profile 含 `id`、`name`、`command`、`args`、`cwd`、`env`），创建终端时按 `profileId` 解析（保持「服务端绝不从客户端直接执行任意未登记 launchSpec」的安全不变量，仅引用服务端配置里的 profile 或默认 shell）。

## 4. M2 · 四端渲染引擎与性能预算

- **Web**：接入 `protocol=4` 二进制帧与浏览器原生 `DecompressionStream('deflate-raw')` 解压；接入 `@xterm/addon-unicode11` 并与 tmux 宽度表对拍；WebGL 改为能力探测 + `onContextLoss` 降级（解除对 Firefox / 桌面 Safari 的硬编码屏蔽）；修复 `apps/web/src/app/terminal/smooth-scroll.ts` 半行静止底边空隙。
- **macOS**：完成 `TerminalSurfaceBackend` 抽象与 §1.2 的 `GhosttyKit` Spike；无论最终选定 `GhosttyKit` 还是 SwiftTerm，均消除 2 MiB `originalOutput` 副本并按帧边界批处理输出。
- **共享 Kotlin + Android**：`apps/mobile/client/src/commonMain/kotlin/riffet/shared/TerminalConnection.kt` 升级 `protocol=4` + 心跳；`:terminal` 补 `feed(String)` 快路径、`TerminalFrame` 按行版本号写时复用、`apps/mobile/shared/src/commonMain/kotlin/riffet/ui/terminal/TerminalScrollView.kt` 恢复 `TextMeasurer` 缓存并落行内容哈希 LRU 512 缓存 + 历史行紧凑游程编码。
- **性能预算**（常量统一收口在 `packages/contracts/src/budgets.ts`）：
  - 10000 行彩色 seed 压缩率 ≥ 70%，局域网首屏 ≤ 150 ms；
  - Web Chrome/Safari 10000 行滚屏无掉帧；
  - Android 中端机 benchmark 单帧绘制 p95 ≤ 5 ms，20000 行回看内存 ≤ 10 MB；
  - `yes` 洪峰下 `Ctrl+C` ≤ 500 ms 生效，慢 viewer 只重种自身。

## 5. M3 · 零闪烁稳态基建与全量自定义体系

- **Keep-Alive 保活池**：Web `apps/web/src/app/terminal/TerminalDock.tsx` 与 macOS `apps/macos/Riffet/Features/Inspector/TerminalPanel.swift` 切换终端时保活实例（上限收口进 `budgets.ts`，默认 6 个），0 ms 瞬切不重连。
- **iOS 后台宽限期**：`apps/mobile/iosApp/Riffet/Features/Inspector/TerminalPage.swift` 退后台延迟 20 s 再断连，与 Web `SOCKET_AWAY_MS` 对齐。
- **Resize 保留回看位置**：非贴底状态下 resize 触发 reseed 时，按行指纹/距底偏移恢复可见区位置。
- **统一 OSC 52 安全策略**：四端统一「询问 / 总是允许 / 总是拒绝」三态设置。
- **全量 C 类本地自定义项**（遵循 `docs/design/DECISIONS.md` 与 `docs/design/system/`，同步更新 `/design` 设计规范页）：
  - 排版与渲染：字体族 + CJK 回退字体、连续字号（10–24 pt，支持 `Cmd/Ctrl + =/-/0` 缩放）、行高（1.0–1.6）、字距、字体连字、最小对比度、粗体提亮 ANSI 0–7、渲染器模式（自动 / DOM）。
  - 光标与交互：光标形状（方块 / 下划线 / 竖线）与闪烁、macOS `Option-as-Meta`（None / Left / Right / Both）、选中即复制、右键粘贴、输入/输出自动滚底、平滑滚动开关、回看行数档位、多行粘贴确认、铃声策略、长耗时命令通知阈值。
  - 主题与快捷键：独立终端配色方案（默认跟随工作台）+ `.itermcolors` / Ghostty 主题导入；`packages/contracts/src/shortcuts.ts` 新增 `terminal` scope 与快捷键穿透配置（Send Keys to Terminal）。

## 6. M4 · 核心生产力闭环

- **终端内搜索**：Web 接入 `@xterm/addon-search`，macOS/iOS 与 Android 提供同等正则/大小写/全词/计数/上下跳转浮层。
- **智能链接与文件直达**：统一识别 OSC 8、URL、项目内 `path:line:col`，点击直达 Riffet 文件面板并定位行号。
- **Shell Integration 前端消费**：标签页实时显示 CWD 与运行中命令；新建 Shell 继承当前 CWD；`Cmd+↑/↓` 命令块跳转；一键复制上一条命令完整输出；后台长命令完成触发系统通知与退出码标记。
- **移动端交互补齐**：Android 补齐长按选词+跨回看复制、双指捏合缩放、链接/路径点击；iOS 补齐两行 Agent 功能键栏与整行输入模式；双端支持功能键栏自定义与预设。

## 7. M5 · 多窗格工作区与封板验收

- **分屏（Split Panes）**：Web 与 macOS 支持水平/垂直分屏、拖拽比例、焦点切换、单窗格 Zoom；每个窗格绑定独立 `terminalId`，复用既有单 pane 租约与多服务器路由模型。
- **快捷交互与独立窗口**：`Cmd+K` 清屏、已退出 Shell 一键重新运行、`Option+Click` 命令行移光标；macOS 支持拆出独立终端窗口。
- **封板清理**：全端迁完 `protocol>=3/4` 后移除 `protocol=1/2` 与 `/history` 轮询路径；扩展 `scripts/record-terminal-fixtures.ts` 覆盖真彩色/CSI-u/Unicode 15/OSC 133；跑通四端生产性能验收并更新 `docs/TERMINAL.md`、`docs/MOBILE-TERMINAL.md` 与 `CHANGELOG`。
