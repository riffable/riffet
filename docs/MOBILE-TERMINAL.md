# Riffet 移动端终端视图：设计方案

本文是 `apps/mobile` 终端视图的设计契约，是 `docs/MOBILE.md` 中 P3「终端」一项的展开。
调研日期 2026-10；文中版本号、星数、文件路径均在当日从 GitHub API、`raw.githubusercontent.com`
与 Maven Central 实际取回核对过，取不到的写明「未验证」。

2026-11 终端修复更新：现有客户端使用 `ws?protocol=2` 的显式快照协议，仍由 tmux attach 输出驱动；
这与本文远期讨论的原始 pane 流方案不同。Web 历史已改用 xterm 解析，背景不再按深浅模式改写。

## 0. 结论

1. **不用 WebView 套 xterm.js，做原生 Compose 终端。** web 终端的问题大多来自它的拼装方式（见第 1 节），
   把同一套东西塞进 WebView 只会把问题连同移动端 WebView 的输入法与触摸缺陷一起带过来。
2. **不采用调研推荐的 `kmp-terminal-emulator`。** 根本原因是质量：
   每个单元格是一个只存单个 `Char`（UTF-16 码元）的 data class，装不下 BMP 以外的 emoji 与组合字符，
   内存也按对象计；核心模块里没有宽字符处理，中文只占 1 格，而 tmux 按 2 格排版，带中文的行都会错位；仓库 2026-07 创建，2 星，只有一位真人提交者。另外它的 0.3.11 用 Kotlin 2.4.20 +
   Compose 1.11.1 编译，`connectbot/termlib` 同为 Kotlin 2.4.20，本项目原先的 Kotlin 2.1.21 + CMP 1.8.2
   读不了——这是工具链落后的问题，已经单独修掉（见第 12 节），修好之后上面的质量结论不变。
   `docs/MOBILE.md` 的「参考项目」与「风险」两处需要随本方案改写。
3. **VT 引擎：把 Termux 的 `terminal-emulator`（Apache-2.0，纯 Java）移植成 Kotlin `commonMain`，
   放进新模块 `:terminal`，连同它的单元测试一起移植。** 它是 Android 上用户量最大、测试最全的终端引擎，
   单元格用每行 `char[]` + `long[]` 打包存储，支持组合字符与宽字符。
4. **渲染器自己写**，三条硬要求：只在绘制阶段读状态（不触发重组）；制表符与块元素用代码画、不用字体
   （web 上框线断裂的根因）；宽字符与回退字体逐格定位（不让一行文字横向漂移）。
5. **输入管线照搬 `farlume/termish` 的设计**（MIT，Kotlin 2.1.21 + CMP 1.8）：隐藏
   `BasicTextField` 接输入法、组合态绝不上线、只对已提交文本做前缀 diff，另加一个「整行输入」模式。
6. **第一期不改协议**：沿用现有 `/api/terminals/:id/ws` 与 `/history`。服务端只做三处增量
   （提高 `history-limit`、增量历史、开启 tmux 的同步输出），都对 web 兼容。
   **第二期（可选）** 换成 tmux control mode 的原始 pane 流，回看由客户端引擎原生持有，同时惠及 web。

## 1. web 终端为什么差：按代码定位的根因

| 现象 | 根因 | 位置 |
| --- | --- | --- |
| 框线（`╭─╮│╰╯`）上下断开，Ink 绘制的面板像虚线 | xterm 用的是 DOM 渲染器（只装了 `addon-fit`，没有 `addon-webgl`），框线字符用字体字形画；`lineHeight: 1.3` 让每行之间留出空隙。WebGL 渲染器的 `customGlyphs` 才会把这类字符按像素画满整格 | `package.json`、`lib/terminal-theme.ts` |
| 回看卡顿、滑动掉帧 | 实时区是 tmux 客户端（tmux 在外层终端进入备用屏），xterm 里没有回看。历史靠 `GET /history` 每次拉回**全量** `capture-pane -S -` 文本，`parseAnsi` 后为每行每段生成 `<div>/<span>`，内容一变就整体重建；没有虚拟化 | `TerminalView.tsx` `refreshHistory`、`TerminalHistory.tsx` |
| 历史与实时区之间有一道「缝」，字号、行高、颜色对不齐 | 两套渲染器：上面是 DOM 文本，下面是 xterm 网格，靠 `--terminal-row` 变量勉强对齐；历史和屏幕取自不同时刻，偶尔丢行或重复 | 同上 |
| 回看只有约 2000 行 | 服务端从没设置 `history-limit`，用的是 tmux 默认值；xterm 的 `scrollback: 12000` 对 tmux 客户端无效 | `terminal/service.ts` |
| 只读查看时画面错位 | `fit()` 总是把本地 xterm 调成容器尺寸，但只有持有控制权时才把尺寸发给服务端；只读设备拿控制者尺寸的字节流，在自己的尺寸上解释 | `TerminalView.tsx` `fit` |
| 浅色主题下颜色发灰、偶有黑块 | Cursor CLI 按深色终端绘制面板背景，web 在字节流上改写 SGR 背景色（`terminal-palette.ts`，已移除），历史区再改一遍；切换主题必须重连才能重放 | <!-- doc-paths:off -->`lib/terminal-palette.ts`<!-- doc-paths:on --> |
| 手机上输入中文、滑动都别扭 | xterm.js 用隐藏 `textarea` 接输入法，移动浏览器的组合事件不稳定；xterm.js 没有触摸处理，只能 `pointer-events: none` 把触摸让给外层滚动容器 | `TerminalView.tsx` |

这些问题里只有「DOM 渲染器」一项属于 xterm.js 本身，其余都是架构问题：tmux 客户端流没有回看、
单一 PTY 尺寸、主题在字节层处理。原生实现要从结构上绕开它们，而不是逐个打补丁。

## 2. 参考项目

### 2.1 核对过的候选

| 项目 | 许可 | 形态 | 结论 |
| --- | --- | --- | --- |
| [JohNan/kmp-terminal-emulator](https://github.com/JohNan/kmp-terminal-emulator) | Apache-2.0 | KMP 引擎 + Compose 渲染，Maven Central `io.github.johnan:terminal-core/ui` | **不采用**：`TerminalCell` 是 `data class(val char: Char, …)`，一格一个对象、只能放一个 UTF-16 码元；核心模块（`AnsiParser`、`ScreenBuffer`、`TerminalEmulator`、`TerminalRow`）里没有任何宽字符处理（无 wcwidth、无代理对），中文按 1 格排，与 tmux 的 2 格排版必然错位；2026-07-12 创建，2 星，提交者为作者本人与 dependabot。框线有自绘（`drawBoxDrawing`），可作参考。0.3.11 的 `.module` 声明 kotlin-stdlib 2.4.20、Compose 1.11.1 |
| [connectbot/termlib](https://github.com/connectbot/termlib) | Apache-2.0 | libvterm + JNI + Jetpack Compose，仅 Android | **工具链不兼容**（Kotlin 2.4.20、androidx Compose 1.11），且没有 iOS |
| [termux/termux-app](https://github.com/termux/termux-app) `terminal-emulator` / `terminal-view` | 这两个模块是 Apache-2.0（仓库其余部分 GPLv3，见其 `LICENSE.md`） | 纯 Java 引擎 + Android View 渲染 | **引擎采用**（移植为 Kotlin）。引擎约 18 个文件，`TerminalEmulator.java` 175 KB；单元测试 19 个文件约 130 KB |
| [farlume/termish](https://github.com/farlume/termish) | MIT | KMP 应用，纯 Kotlin 引擎（约 2.8k 行）+ Compose 渲染，Android/iOS 已上架 | **借设计不借引擎**。Kotlin 2.1.21、CMP 1.8.1；但每个单元格是一个对象（含 `link: String?`），不支持组合字符，`wcwidth` 是简化实现。它的 <!-- doc-paths:off -->`docs/input-pipeline.md` 与 `docs/terminal-emulator.md`<!-- doc-paths:on --> 是输入法与 resize 的现成规格 |
| [befrvnk/composetty](https://github.com/befrvnk/composetty) | Apache-2.0 | CMP + `libghostty-vt` | 0 星，未发布到 Maven Central，自述「initial development」。架构参考 |
| [xtermjs/xterm.js](https://github.com/xtermjs/xterm.js) | MIT | 浏览器终端 | 渲染参考：`addons/addon-webgl/src/customGlyphs/`（框线/块元素按像素绘制）、`TextureAtlas.ts`（字形图集） |
| [ghostty-org/ghostty](https://github.com/ghostty-org/ghostty) | MIT | 桌面终端，`libghostty-vt` 可作 C 库 | 远期备选引擎：需要在 Gradle 构建里引入 Zig 工具链与 JNI/cinterop，第一期不值得 |
| [migueldeicaza/SwiftTerm](https://github.com/migueldeicaza/SwiftTerm) | MIT | iOS/macOS 原生终端 | iOS 侧行为参考（输入法、选择），不进入 KMP 代码 |
| [blinksh/blink](https://github.com/blinksh/blink) | GPL-3.0 | iOS 终端 | README 写明用 Chromium 的 hterm 渲染。说明「WebView 渲染」能做好，但 Blink 为此投入了整套原生外壳；不可复用代码 |

### 2.2 渲染与协议上的关键参考点

- **Termux `TerminalRenderer.java`**：按样式切段调用 `drawTextRun`；当某个码点的实测宽度与
  `wcwidth × 单格宽` 相差超过 1% 时单独成段，并用 `canvas.scale(runWidthColumns / measured, 1)` 横向
  压进应占的格数。这是「回退字体不漂移」的成熟做法，本方案沿用。
- **termish `TerminalView.kt`**：行级 `TextLayoutResult` LRU 缓存（256 行），未变的行只回放布局；
  输入法弹出时不改 PTY 尺寸，用 `graphicsLayer` 平移画布让光标行可见。
- **tmux control mode**（[wiki](https://github.com/tmux/tmux/wiki/Control-Mode)）：`%output %<pane> <转义后的原始字节>`
  逐 pane 推送原始输出；`refresh-client -C` 设置客户端尺寸；`refresh-client -f pause-after=N` 开启流控，
  落后时发 `%pause`，客户端可用 `capture-pane` 重新同步。这是第二期协议的基础，iTerm2 的 tmux 集成用的就是它。

## 3. 选型

| 方案 | 渲染质量 | 性能 | 输入法/触摸 | 与 app 其余部分的融合 | 工期 | 结论 |
| --- | --- | --- | --- | --- | --- | --- |
| A. WebView + xterm.js（+WebGL） | 与 web 相同（加 WebGL 后框线与性能可修好） | Chromium 启动 300 ms 以上；需要 WebView 池 | xterm.js 无触摸处理，移动 WebView 的组合输入要自己兜底 | 差：WebView 不参与 `BackPreview` 的缩放预览、`FocusCoordinator`、Compose 主题；iOS 要走 `UIKitView` 嵌 `WKWebView` | 短 | 否 |
| B. 升级工具链后用 `kmp-terminal-emulator` | 低（中文按 1 格排导致错位；无组合字符、非 BMP emoji 占不进一格） | 每格一个对象 | 有基础实现 | 好 | 短，但要先做第 12 节的升级 | 否：工具链升级本身要做，但引擎质量不够 |
| C. 用 termish 的引擎 | 中 | 每格一个对象，2 万行回看约 240 万个对象 | 好（设计可直接借） | 好 | 中 | 只借设计 |
| **D. 移植 Termux 引擎 + 自写 Compose 渲染 + termish 输入设计** | 高（渲染完全可控） | 高（打包存储，绘制阶段失效） | 好 | 好 | 中 | **采用** |

D 的额外收益：浅色主题在绘制时映射颜色（不改字节、切主题不重连）；终端里的文件路径可以直接打开
app 的文件面板；回看与实时屏用同一个渲染器，消除那道「缝」。

## 4. 总体架构

```
 Mac: tmux pane ──(tmux attach, node-pty)──► TerminalService ──► WS /api/terminals/:id/ws
                         capture-pane ──────► GET /api/terminals/:id/history
                                                   │ JSON 文本帧 {type, data, sequence}
 ─────────────────────────────────────────────────┼──────────────────────────────────────
 apps/mobile                                       ▼
 ┌─ :terminal (纯 Kotlin commonMain，无 Compose、无平台 API) ───────────────────────┐
 │  VtParser + TerminalEmulator (移植自 Termux)   Screen / Row (char[] + long[])     │
 │  WcWidth (Unicode 15)   KeyEncoder (DECCKM/修饰键)   Selection   LinkDetector      │
 │  ColorResolver (主题 + 浅色背景映射 + 粗体提亮)   HistoryParser (SGR → 打包行)      │
 └──────────────────────────────────────────────────────────────────────────────────┘
 ┌─ :client  riffet/shared/ ────────────────────────────────────────────────────────┐
 │  TerminalConnection   WS、lease/epoch、重连；在调用方给的 scope 上运行             │
 └──────────────────────────────────────────────────────────────────────────────────┘
 ┌─ :shared  riffet/ui/terminal/ ───────────────────────────────────────────────────┐
 │  终端工作线程         收帧、解码、解析、回看重建         (Default 限并行度 1)    │
 │  TerminalSurfaceState 合帧、发布不可变快照 TerminalFrame (同一工作线程)          │
 │  TerminalCanvas       Canvas 绘制、行缓存、自绘字形        (主线程，只在 draw 阶段)│
 │  TerminalInput        隐藏 BasicTextField、硬件键盘、整行输入                     │
 │  TerminalKeyBar       两行功能键、粘性 Ctrl/Alt、长按连发                         │
 │  TerminalScreen       页面：顶栏、画布、键栏、手势、选择菜单                      │
 └──────────────────────────────────────────────────────────────────────────────────┘
```

新模块 `:terminal` 与 `contracts`、`core` 一样只有 `commonMain`，声明 `jvm()` target，引擎与编码器
可以在没有 Android SDK 的机器上测试。`shared` 依赖它，渲染与输入在 `shared` 里。

## 5. 详细设计

### 5.1 连接与控制权（`TerminalConnection`）

- **传输**：Ktor WebSocket（`HttpClient` 安装 `WebSockets`；Ktor 3.1.3 的 core 已依赖
  `ktor-websocket-serialization`，OkHttp 与 Darwin 引擎都支持 WebSocket——落地前在 T0 用真机确认，不行再加
  `io.ktor:ktor-client-websockets:3.1.3`，Maven Central 上存在）。带 `Authorization: Bearer`，不带 `Origin`，
  服务端 `checkOrigin` 对无 Origin 的请求放行。帧格式沿用 `contracts/Stream.kt` 已有的
  `TerminalClientMessage` / `TerminalServerMessage` 与 `TerminalFrameTest`。
- **REST**：`RiffetApi` 增加 `terminals()`、`terminal(id)`、`createTerminal(projectId, kind=shell)`、
  `terminalHistory(id, known)`、`interruptTerminal(id)`、`closeTerminal(id)`。
- **控制权规则**（与 web 有一处有意的差别，见第 9 节决策 2）：
  1. 首次连接发 `claim`，**不带** `takeover`：无人控制时直接拿到；Mac 正在控制时保持只读，不抢。
  2. 第一次用户输入时若没有控制权，先 `claim(takeover=true)`，拿到后把缓冲的输入补发（与 web 的
     `pendingInputRef` 相同）。
  3. **终端自动应答（DA、DSR、OSC 10/11 查询等）只在已持有控制权时发送，永远不触发接管。**
     引擎的应答通道与用户输入通道在类型上分开，避免把一次光标位置应答变成抢控制权。
  4. 只有控制者发 `resize`；重连不带 `takeover`；离开页面时若持有控制权发 `release`。
- **重连**：指数退避 1 s 起、上限 20 s，无限次（与 `docs/MOBILE.md`「重连必须自己写」一致）。回到前台时，
  若离开超过 20 s 直接丢弃旧 socket 立即重连（web 的 `SOCKET_AWAY_MS` 同一规则）。新连接使用
  `ws?protocol=2`，等待 `snapshot { data, cols, rows, sequence, streamId }`，先设置网格再 reset/feed。
  后续只处理同 streamId 且 sequence 更新的 output；自动恢复产生新 streamId。旧客户端仍收到 output 形式的快照。
- **线程**：`TerminalConnection` 的公开方法只把命令放进队列，可在任意线程调用；socket 循环独占连接状态，
  在调用方给的 scope 上运行并在那里回调 `onOutput`。Android 终端页给它一个单线程后台 scope
  （`Dispatchers.Default.limitedParallelism(1)`），收帧、JSON 解码、`emulator.append` 与回看重建都在这个线程，
  主线程只画快照；iOS/macOS 把输出交给主线程上的 SwiftTerm，仍传主线程 scope。循环每收一帧 `yield` 一次，
  输出洪峰时同一线程上的输入、合帧发布不会被饿死。
- **背压**：客户端没有解析队列：工作线程解析完一帧才读下一帧，读得慢时积压留在 socket 与服务端。服务端在
  socket 缓冲超过 4 MiB 时以 1013 关闭，客户端按普通断线处理，重连后拿到新快照（与 web 的
  `MAX_PENDING_TERMINAL_CHARS` 效果相同：落后太多就丢弃中间输出、从快照重来）。
- **后台**：终端连接不进前台服务；页面离开组合或应用进入后台 20 s 后关闭 socket，回来重连。终端输出
  不缓存到本机（与 `docs/MOBILE.md`「不缓存的」一致）。

### 5.2 VT 引擎（`:terminal`）

**来源与移植方式**

- 从 `termux-app/terminal-emulator/src/main/java/com/termux/terminal/` 移植：`TerminalEmulator`、
  `TerminalBuffer`、`TerminalRow`、`TextStyle`、`WcWidth`、`KeyHandler`、`TerminalColors`、
  `TerminalColorScheme`、`TerminalOutput`。不移植 `JNI`、`TerminalSession`（本地 fork PTY）、
  `TerminalBitmap`/`TerminalSixel`/`ITermImage`（图片协议）、`ByteQueue`。
- 用 IntelliJ 的 Java→Kotlin 转换起步，再手工去掉 `java.*` 依赖（`Arrays` → Kotlin 集合函数，
  `android.util.Base64` → `kotlin.io.encoding.Base64`，日志改为回调）。文件头保留 Apache-2.0 声明，
  模块根放 `NOTICE` 写明来源与修改。
- 测试同步移植到 `commonTest`：`ControlSequenceIntroducerTest`、`CursorAndScreenTest`、`DecSetTest`、
  `HistoryTest`、`ResizeTest`、`ScrollRegionTest`、`TerminalRowTest`、`TerminalTest`、`UnicodeInputTest`、
  `WcWidthTest`、`KeyHandlerTest`、`OperatingSystemControlTest` 等。**移植完成的标准是这些测试全部通过。**

**改动（全部是增量）**

- 输入接口改成 `feed(bytes: ByteArray, offset, length)`，内部增量 UTF-8 解码；WS 帧里的 `data` 是字符串，
  直接按 UTF-16 走一条 `feed(text: String)` 的快路径，免去一次编码。（快路径未做：现在仍是 `encodeToByteArray`
  后 `append`，在终端工作线程上。）
- 每行增加 `version: Long`（单元格被改写时递增），引擎维护「自上次快照以来的脏行集合」，渲染器据此只重画脏行。
- OSC 8 超链接：行内存一个稀疏的 `列区间 → linkId` 表，链接文本放引擎级的去重表，不进单元格。
- DECSET 2026（同步输出）：开启期间只累积不发布快照，结束或超时 150 ms 才发布，避免 tmux 整屏重绘时
  画到一半的「撕裂帧」。配合服务端 T3（5.9 节）。
- 应答回调拆成 `onReply(bytes)`（自动应答）与 `onTitle`、`onClipboard`、`onBell`，见 5.1 规则 3。

**历史行的存储**

- 回看行一旦离开屏幕就不再修改，转存为紧凑格式：`CharArray` + 样式游程表（`IntArray` 起始列 + `LongArray` 样式）。
  多数行只有几段样式，2 万行 × 120 列约 6 MB；若按每格一个 `long` 存则约 24 MB。

### 5.3 渲染器（`TerminalCanvas`）

**只在绘制阶段读状态**

- 引擎只在终端工作线程上被修改。`TerminalSurfaceState.invalidate()` 在该线程把可见行复制成不可变的
  `TerminalFrame`（行副本 + 光标 + 画面与按键模式 + 递增的 `frame`）发布出去；画布与输入只读快照，滚轮等
  需要碰引擎的操作经 `post` 回到工作线程。
- 画布是一个 `Modifier.drawBehind`/`Canvas`，只在绘制 lambda 里读快照；输出到达只触发 draw，不触发重组与
  测量。发布节流到每 16 ms 最多一次：静默后的第一处变化立即发布，连续输出按帧合并，100×40 的一次复制
  约 4 千格，可以忽略。

**单元格几何**

- 字体：随包带 **JetBrains Mono** Regular + Bold（OFL-1.1，两个 TTF 合计约 0.5 MB，经
  `compose.components.resources` 加载；需要新增这个与 CMP 同版本的依赖）。两端度量一致，不受各家 Android
  系统等宽字体差异影响。中文、日文回退到系统字体（Android Noto Sans CJK，iOS PingFang SC）。
- 单格宽用 `TextMeasurer` 量 32 个 `M` 取平均（保留小数）；**行高取整到整像素**，背景矩形上下不留缝。
  行高系数 1.2，可在设置里调。

**每帧绘制顺序**（只画可见行）

1. 背景：同色相邻单元格合并成一个 `drawRect`。
2. 文本：按样式切段。段的切分条件 = 样式变化 ∪ 光标/选择边界 ∪ 「实测宽度 ≠ wcwidth × 单格宽」
   （Termux 规则）。宽度不符的段单独绘制并横向缩放进应占格数，宽字符（CJK、emoji）逐格定位。
3. **自绘字形**：U+2500–257F 框线、U+2580–259F 块元素、U+2800–28FF 盲文、Powerline U+E0B0–E0B3，
   用 `drawLine`/`drawRect`/`drawPath` 按单元格像素画满，不经字体。几何定义参照
   xterm.js <!-- doc-paths:off -->`customGlyphs/CustomGlyphDefinitions.ts`<!-- doc-paths:on -->。这是框线在任意行高下连续的唯一可靠做法。
4. 装饰：下划线（含 `4:3` 波浪线）、删除线、OSC 8 链接下划线。
5. 光标（块/下划线/竖线，DECSCUSR 2/4/6 常亮、1/3/5 按 530 ms 闪烁；块光标下字符反色重画）与选择高亮。

**缓存与性能退路**

- 文本段布局缓存：键 = 行内容哈希（码点 + 样式）+ 单格宽 + 主题，LRU 512 行。用内容哈希而不是行身份做键，
  是因为 tmux 外层流经常用整屏重绘表达滚动，内容不变而行对象变了。
- 文本绘制放在接口 `GlyphPainter` 后面。默认实现用 Compose `TextMeasurer` + `drawText(TextLayoutResult)`；
  若 T0 实测中端机 p95 帧时间超标，Android 换成 `drawIntoCanvas { it.nativeCanvas.drawTextRun(...) }`
  （Termux 每帧不缓存、直接 `drawTextRun` 也能流畅，已被大量设备验证），iOS 换成 Skia `TextBlob` 逐字形定位。

**颜色**（`ColorResolver`，在 `:terminal` 里，可单测）

- 16 色与默认前景/背景来自设计变量（5.8 节），256 色立方与灰阶按 xterm 公式计算，真彩色直通。
- 显式背景保留原色，默认前景/背景和 ANSI 16 色随主题。对有效前景做最低对比度修正：普通文字 4.5:1、
  dim 文字 2.25:1；反色先求有效前景/背景，绘图色块保留颜色。不要改写原始流中的背景 SGR。
- 粗体 + 基本 8 色提亮到 8–15（xterm 惯例，可关）。
- 切换主题只是重画，不重连。

**CLI 启动配色与客户端显示**

- 创建、发送和重新打开请求用 `x-riffet-terminal-appearance: #rrggbb;#rrggbb` 提供当前界面的实际前景、背景。服务端将它记录为会话的下一次启动偏好；当前进程的配色另存于 `TerminalInfo.appearance`。
- `new-session` 与设置 pane 的 `window-style`、`window-active-style` 位于同一个 tmux 命令列表。后台 CLI 即使没有 viewer，也能在首次 OSC 10/11 查询时取得正确颜色。预热资源匹配包含配色，不能把深色预热进程交给浅色会话。
- 实时区和历史区共同采用当前进程记录的前景、背景，并据此选择 ANSI 明暗；应用主题的变化只决定下一次启动。旧进程没有记录时使用深色回退，避免浅色底与已输出的深色 truecolor 混搭。
- 这一生命周期约束来自实际 CLI 能力：Codex 0.160.0 在 Unix 缓存首次颜色探测，运行中不重查；已写入 tmux 历史的显式 RGB 也不能靠修改默认色重新着色。Riffet 不自动执行 `/theme`、不改用户 CLI 配置、不通过重启中断任务。重新打开会话后采用当时的应用配色。

### 5.4 回看与滚动

**第一期：历史 + 实时屏放进同一个虚拟画布**

- 显示行序列 = 历史显示行 + 实时屏的 `rows` 行。画布按像素偏移只画可见的那些行，不用 `LazyColumn`。
- 历史来源是 `GET /history`：支持 `-N` 的 tmux 使用 `capture-pane -p -e -N`，保留物理行、连续 SGR 和行尾背景单元格。
  响应 `cols` 是捕获列数，客户端按此网格绘制；本地视口较窄时横向滚动，不再次折行。version 包含格式与列数，旧文本缓存或异宽缓存必须全量替换。
  独立捕获的追加边界可以重置 SGR，同一捕获内不能逐行重置。`-J` 隐含 `-T`，会丢掉 `EL` 产生的无字符背景，不能与 `-N` 混用来恢复矩形。
  tmux < 3.1 继续使用标记为 `text-v1` 的旧文本格式；该降级无法无损恢复已裁掉的背景。捕获前后校验历史版本与列数，移动的增量起点转为全量读取。
- 拉取时机：输出后静默 1 s 预取，最多每 3 s 一次（web 的 `HISTORY_QUIET_MS` / `HISTORY_REFRESH_MS`）；
  手指开始上滑时立即拉一次。服务端 T2 提供增量后，每次只传新增行。
- 惯性滚动用 Compose `scrollable` + `rememberSplineBasedDecay()`；右缘可拖动滚动条；离开底部时显示
  「回到实时」胶囊（与 web 同款文案）。在底部时新输出跟随，不在底部时保持位置；有选区时不跟随
  （复用 `FocusCoordinator.selecting`）。
- 第一期里外层流始终是 tmux 客户端（处于备用屏），客户端看不出内层程序是否在全屏模式，所以竖向滑动
  **一律滚回看**，不转成方向键或鼠标滚轮。这与 web 现状一致。

**第二期（协议 v2）**：原始 pane 流让客户端引擎自己积累回看，`/history` 与公共前缀比较都不再需要；
内层程序进入备用屏时，竖滑才按 DECSET 1007 转成方向键。

### 5.5 尺寸、缩放与软键盘

- **引擎尺寸永远等于 pane 尺寸**（取自最新的 `state.terminal.cols/rows`），不等于本地画布尺寸。这一条修掉
  web 的「只读错位」。
- **控制者**：画布尺寸 ÷ 单格尺寸 = 目标列行数，变化后去抖 250 ms 发 `resize`；先在本地把引擎调到新尺寸，
  等服务端的 resize 快照覆盖整屏。
- **只读者**：按 pane 列数反算字号让整行放下；字号低于 8 sp 时固定 8 sp，允许横向拖动。顶栏给出
  「接管并适配手机宽度」。
- **软键盘弹出不改 PTY 尺寸**：画布用 `graphicsLayer { translationY }` 上移，保证光标行在键盘上方可见
  （termish 的做法）。否则每次弹收键盘，全屏 TUI 都要整体重排一次。横竖屏切换照常 resize。
- **双指捏合**改字号：手势过程中只缩放画布（`graphicsLayer` 的 scale），松手后才定字号并按控制者规则 resize。
  字号存在本机 `DisplaySettings`。
- 离开后由服务端在 3 s 后把 Cursor/原生会话的 pane 恢复到 100×40（`restoreBackgroundSize`，已有）。

### 5.6 输入

**输入法通道**（规格取自 termish <!-- doc-paths:off -->`docs/input-pipeline.md`<!-- doc-paths:on -->）

- 一个 1 dp、透明的 `BasicTextField` 作为输入法入口，不显示任何内容，屏幕上以远端回显为准。
  `KeyboardType.Text`（保留中文候选栏）、关闭自动纠错与首字母大写、`singleLine = false`（捕获回车）。
- **组合中的拼音不发往远端**；只对「已提交文本」与基线做最长公共前缀比较：发
  `旧长度 − 前缀` 个 `0x7f`，再发新增部分。`\n` 发 `\r`。缓冲超过 64 字符或含换行时清空基线。
- 退格三段式：组合中交给输入法；输入框有已提交内容时交给 diff；输入框为空时拦截 Backspace 直接发 `0x7f`。
- 点击画布或键栏的 ⌨ 键时 `requestFocus()`，延迟 150 ms 再 `show()`（输入连接建立是异步的）。

**硬件键盘**：`onPreviewKeyEvent` 交给 `KeyEncoder`：方向键按 DECCKM 切 `CSI` / `SS3`，Ctrl+字母 → `& 0x1f`，
Alt → `ESC` 前缀，`Shift+Tab` → `CSI Z`，F1–F12、Home/End/PgUp/PgDn 按 xterm 编码。编码规则移植自
Termux `KeyHandler`，测试随之移植。

**功能键栏**（两行，可在设置里调整顺序；按下即发送、不抢焦点，键盘不会因此弹出或收起）

```
第一行：Esc   Tab   ⇧Tab   Ctrl   ↑    ^C   ⏎    ⌨
第二行：/     ^R    ^O     Alt    ←    ↓    →    更多
```

- 选键依据是 Riffet 实际驱动的 CLI：`⇧Tab` 切换 Claude Code 的权限模式、`Esc` 中断、`^O` 展开转录、
  `^R` 搜索历史、`/` 斜杠命令、方向键与回车选择交互项。
- `Ctrl`/`Alt` 粘性，任何一个键发出后立即复位（termish 规则，防止残留把下一个字母变成 `^D`）。
- 方向键长按 400 ms 后每 80 ms 连发（web 的 `KEY_REPEAT_DELAY_MS` / `KEY_REPEAT_MS`）。
- 「更多」展开一层：`^D` `^L` `^Z` `Home` `End` `PgUp` `PgDn` `F1–F12` `|` `~` `-`。
- 触觉反馈走 `AppHaptics`，受「触觉反馈」开关控制。

**整行输入模式**：键栏上方一个可见的多行输入框，正常显示输入内容、支持语音输入与输入法联想；点发送时
作为一次 bracketed paste 送出（远端开启 DECSET 2004 时包 `ESC[200~ … ESC[201~`），可选是否追加回车。
给长提示词和不擅长逐字回显的输入法用。单次输入上限 128 KiB（服务端 `MAX_INPUT_CHARS`），超过时提示。

**粘贴**：多行或超过 1 KiB 时先确认；远端开启 2004 时包裹。

### 5.7 选择、复制与链接

图片与文件粘贴复用现有附件上传，随后请求 `POST /api/terminals/:id/paste-attachments`，提交
`clientId / epoch / requestId / attachmentIds` 和可选混合文本。服务端生成持久文件路径，按原租约在交互事务中
粘贴，不追加 Enter。客户端绑定视图、连接和用户输入版本；上传期间切换目标或继续输入会取消延迟插入。
上传和准备可重新执行，已尝试写入的请求按持久收据去重；`unknown` 表示执行结果不确定，不自动补发。
图片副本存放在服务端附件目录，普通终端粘贴不创建聊天 Run。

- 长按选中一个词（按空白与常见分隔符切分），出现两端手柄，可跨回看与实时屏拖动；菜单提供复制、粘贴、
  打开链接、在文件中打开。复制时去掉每行尾部空格、把软折行接回一行。
- 链接来源：OSC 8，加上正则识别的 URL 与**项目内文件路径**（`src/app.ts:42`、`./foo/bar.kt:10:5`）。
  路径点开后进入 app 的文件面板并定位到行（已有 `FileTarget(path, line)`）。路径是否存在由文件面板判定，
  不在终端里预先请求服务端。
- 顶栏菜单：「复制屏幕」「复制全部回看」。
- OSC 52 剪贴板写入：默认「询问」，设置里可改「总是允许 / 总是拒绝」。
- 选择相关的焦点与触觉规则复用 `riffet.ui.focus`（`SelectableText` 屏蔽 `TextHandleMove` 的同一套约定）。

### 5.8 主题与设计变量

- 终端的 16 色、默认前景/背景、光标与选择色目前写在 `apps/web/src/lib/terminal-theme.ts`。把它们挪进
  `apps/web/src/styles/index.css` 的设计变量（`--term-*`，亮暗两套），由 `scripts/gen-mobile-theme.ts`
  一并生成到 `RiffetTheme.kt`，web 的 `terminal-theme.ts` 改为读 CSS 变量。理由与 `docs/MOBILE.md`
  「不手工誊抄」相同。
- 终端背景跟随 app 的 `bg`，顶栏与键栏用 `bgElevated` 与 `line` 细边，与设置页、下载页同一套语汇。

### 5.9 入口与页面

**入口**

1. 右抽屉 `SessionDetailsPane`：会话有 `terminalId` 时，在「变更」「文件」旁显示「终端」入口（已做）。
   最初设计放在会话页头，试用后改到抽屉，页头不再占位。
2. `InteractionCard.kt` 的 `TerminalFallbackCard`：会话有终端时，「在终端中回答」直接打开终端；
   没有终端的后端仍展开说明（已做，经 `LocalTerminalOpen` 由会话页提供）。
3. 会话进入「等待终端操作」但识别不出交互时，转录底部的提示条带「打开终端」（待做）。
4. 抽屉列出本项目的 Shell 终端并提供「新建 Shell」（待做；`RiffetApi.createShellTerminal` 已有）。

**页面**：新增 `Overlay.Terminal`，与 Git、文件面板同级的全屏页，接入 `BackPreview` 的返回手势预览。

```
┌───────────────────────────────────────────┐
│ ←  Cursor Agent    ● 已连接 · 可输入   ⋯  │  顶栏：状态点 + 控制权状态；⋯ 菜单
├───────────────────────────────────────────┤
│                                           │
│            终端画布（历史 + 实时）          │
│                                [回到实时]  │
├───────────────────────────────────────────┤
│ Esc  Tab  ⇧Tab  Ctrl  ↑   ^C   ⏎   ⌨     │  功能键栏
│ /    ^R   ^O    Alt   ←   ↓    →   更多   │
└───────────────────────────────────────────┘
```

- 顶栏按钮：只读时「接管」、持有时「释放」；中断（发 SIGINT，先确认，文案与 web 相同）；
  `⋯` 菜单：重连、整行输入、字号、复制屏幕、复制全部、关闭终端（Shell 终端才有）。
- 状态文案与 web 一致：连接中 / 已连接 / 重连中 / 已退出；可输入 / 其他设备正在控制 / 只读。
- 进程退出时画布末尾写一行灰色「[进程已退出，退出码 N]」，键栏变灰。
- 横屏时键栏合并成一行。

### 5.10 日志与诊断

`AppLog` 新增标签 `term`：每次拨号与关闭原因、控制权变化（epoch、owner）、resize 请求与生效、每 5 秒一行
吞吐摘要（收到字节数、解析耗时 p50/p95、发布帧数、丢帧数）、背压断开。设置 →「排查」里加一个开关，
在终端页角落叠加实时帧时间与解析吞吐，用于真机调优。

## 6. 服务端改动

全部增量，web 不改也能工作。

| 编号 | 改动 | 说明 |
| --- | --- | --- |
| T1 | 在 `createTerminal` 的 tmux 命令列表里、`new-session` 之前加 `set-option -g history-limit 20000` | pane 的回看上限在创建时确定，所以必须在 `new-session` 之前设置；`-g` 只影响 Riffet 自己的 tmux socket。已存在的会话不变。内存成本在 Mac 端，按 pane 计 |
| T2 | `GET /api/terminals/:id/history?known=<version>&mode=tail` 返回增量 | `history_size` 增长且未到上限时，用 `capture-pane -S -<新增行数> -E -1` 只取新增行，响应带 `append: true`；到上限或版本对不上时退回全量。web 不传 `mode` 时行为不变 |
| T3 | 新建会话前 `set-option -sa terminal-features 'xterm*:RGB:strikethrough:usstyle:overline:sync'` | T0 录制时实测（tmux 3.3a，客户端 `TERM=xterm-256color`、`COLORTERM=truecolor`，与服务端现在的启动方式相同）：**不加 `RGB` 时 tmux 把 24 位颜色降成最接近的 256 色索引**（`#ff8000` 变成 208），`COLORTERM` 不起作用；不加 `strikethrough` 时删除线被丢掉。也就是说 web 现在看到的 Cursor CLI 面板颜色本身就是近似色。`sync` 让 tmux 用 `CSI ? 2026 h/l` 包裹重绘，客户端可以只在一帧画完后发布。这条对 web 同样生效；Mac 上按实际 tmux 版本确认这些特性名都被接受 |
| T4 | 协议 v2：tmux control mode 原始 pane 流 | 已定稿为必做，以 `docs/TERMINAL.md` 为准；下文为早期草案 |

**协议 v2（第二期，可选）**

- 服务端改用 `tmux -C attach` 读取 `%output`，按 pane 转发原始字节；初次订阅先发 `capture-pane -e -p -S -<N>`
  的历史 + 屏幕 + 光标 + 模式（`#{alternate_on}`、`#{cursor_flag}`、`#{keypad_cursor_flag}`、`#{mouse_any_flag}`）。
  tmux 把命令回复与 `%output` 写进同一个有序队列，因此快照之前的输出与之后的输出能分开（要在 spike 里用
  真实 tmux 验证这一点再动手）。
- 收益：客户端拿到的是 CLI 自己的字节，回看由引擎原生积累，不再需要 `/history` 轮询与拼缝；内层程序的
  全屏/鼠标模式对客户端可见；`pause-after` 提供真正的流控。
- 帧改成二进制：首字节为类型（参照 ttyd 的 `INPUT '0'` / `OUTPUT '0'` 单字节前缀），输出直接是 UTF-8 字节。
- 新旧并存：新路径 `/api/terminals/:id/stream`，旧 `/ws` 保留到 web 迁移完成。web 迁移时同时装上
  `addon-webgl`、删掉 `TerminalHistory.tsx` 与 `terminal-palette.ts` 的字节改写。

## 7. 性能预算

| 指标 | 目标 | 测法 |
| --- | --- | --- |
| 解析吞吐 | JVM ≥ 30 MB/s；中端 Android ≥ 10 MB/s | `:terminal` 的 jvmTest 基准 + 真机诊断叠层，输入为录制的真实流 |
| 单帧绘制 | 中端机 120×45 网格整屏重绘 p95 ≤ 8 ms；只有光标行变化时 ≤ 2 ms | 诊断叠层（`withFrameNanos` 间隔 + 绘制耗时） |
| 打开到首屏 | 局域网下 WS 建立后 ≤ 300 ms 画出快照 | `term` 日志时间戳 |
| 回看滚动 | 2 万行回看惯性滚动不掉帧 | 真机目测 + 叠层 |
| 内存 | 2 万行 × 120 列回看 ≤ 10 MB | 历史行用紧凑格式（5.2） |
| 大量输出 | `cat` 一个 10 MB 文件不卡死主线程，必要时由背压断开重连（解码与解析已在工作线程，主线程每帧只读一次快照） | 手动，真机未测 |

「中端机」在 T0 时定成一台具体型号写进本文。

## 8. 测试

遵循 [AGENTS.md](../AGENTS.md#测试与验证)：非必要不增加测试。终端引擎的 ANSI、Unicode、resize 与输入编码属于外部协议契约，复用现有核心测试；颜色、样式、选区和渲染快照不维护自动化测试。

1. **引擎协议**：保留 `:terminal` commonTest 中关键的状态机、历史恢复和控制序列测试，不逐个补 getter 或样式位字段断言。
2. **tmux 对拍**：复用既有 JVM parity 检查。只有新增协议行为缺少可靠验证时，才增加最小输入流与期望，不为每个 CLI 或显示场景另建 fixture 与生成脚本。
3. **连接与控制权**：保留首次输入接管、重连不抢、epoch 过期与背压断开的核心检查，避免 UI 层重复验证相同状态机。
4. **界面与设备**：使用必要的编译检查，按实际改动选择设备、输入法与外接键盘进行手动体验，不建立截图或布局测试矩阵。
   iOS 随 P4。

## 9. 需要拍板的决策

1. **第二期协议 v2 做不做、何时做。** 建议先做完第一期再决定：第一期已经能在手机上得到比 web 更好的体验，
   v2 的主要额外收益是回看无缝与 web 一起变好，但要重写服务端终端传输，工作量最大。
2. **手机首次打开时是否抢控制权。** 已定：首连只在无人控制时拿控制权，首次输入才接管（web 仍是打开即接管）。
   理由是在手机上「看一眼」不应该把 Mac 上正在用的 CLI 缩成手机宽度。
3. **随包字体。** JetBrains Mono 两个字重约 0.5 MB；若要中文与西文严格 2:1 等宽，可换更纱黑体 Mono
   （Sarasa Mono SC，SIL OFL），但每个字重约 20 MB 以上，不建议。
4. **手机持有控制权时是否把 pane 改成手机尺寸。** 建议是（与 web 一致，否则 100 列在手机上不可读）；
   只读时按 pane 尺寸缩放显示。

## 10. 分期与验收

| 阶段 | 内容 | 验收标准 | 粗估 |
| --- | --- | --- | --- |
| 前置 | 移动端工具链升级（第 12 节），单独提交 | 已完成，见第 12 节 | — |
| T0 spike | 引擎核心移植到能跑；Canvas 渲染一段录制的 Cursor CLI 流；测吞吐与帧时间；真机确认 Ktor WebSocket | 录制流的最终屏幕与 tmux `capture-pane` 逐行一致；中端机整屏重绘 p95 达标或已选定 `GlyphPainter` 退路 | 3 天 |
| T1 引擎 | `:terminal` 完整移植与测试；`ColorResolver`、`KeyEncoder`、`HistoryParser`；tmux 对拍 fixture | 移植的 Termux 测试与对拍 fixture 全部通过 | 6 天 |
| T2 只读终端 | `TerminalConnection`、`RiffetApi` 终端接口、完整渲染器（自绘字形、CJK、主题）、统一回看、入口与页面 | 手机能实时看到 Mac 上 Cursor CLI 的终端；框线连续；浅色主题无黑块；切主题不重连；只读时不错位 | 5 天 |
| T3 交互 | 输入法通道、硬件键盘、功能键栏、整行输入、粘贴；控制权接管/释放；resize、捏合缩放、键盘平移；选择、复制、链接与文件路径；中断 | 在 Claude Code 中用 `⇧Tab` 切模式、`Esc` 中断、方向键与回车选择选项都真实生效（即 `docs/MOBILE.md` P3 的验收）；搜狗/讯飞输入中文不出现拼音残留 | 7 天 |
| T4 服务端与打磨 | T1–T3 服务端改动；`term` 日志与诊断叠层；设计变量迁移；更新 `docs/MOBILE.md` | `pnpm test`、`pnpm gen:theme:check`、`./gradlew :terminal:jvmTest :shared:jvmTest :androidApp:assembleDebug` 通过；性能预算逐项有实测数 | 4 天 |
| T5（可选） | 协议 v2 + web 迁移 | 另行评审 | 2–3 周 |

粗估按一人全职计，T0 结束后按实测重估。iOS 跟随 `docs/MOBILE.md` 的 P4：终端代码除输入法焦点的少量
`expect/actual` 外都在 `commonMain`，届时只补平台层。

### T0 结果

- **引擎**：`apps/mobile/terminal`（`:terminal`），Termux `terminal-emulator` 在 commit `8629e63` 的 Kotlin 移植，
  图片协议未移植。Termux 原有单元测试移植后全部通过。对上游的修正（都写在 `terminal/NOTICE`）：宽字符的两格共用一个
  样式（上游只设第一格，第二格保留旧颜色，背景会露出半格旧色）；宽字符覆盖相邻一格时连同那一格的组合字符一起移除；
  整行擦除与整行复制走一次性的快速路径（上游逐格 `setChar`，一行出现过中文后每格都从行首扫描，整行操作是
  O(列数²)）。快速路径由 `RowShortcutsTest` 用随机行对照逐格结果。
- **以 tmux 为准的对拍**：`scripts/record-terminal-fixtures.ts` 录制 10 段真实流：shell 颜色/中文/emoji/组合字符/框线、
  光标定位重绘、vim、less、Claude Code 信任对话框，以及 **Claude Code 与 Codex 各一轮真实对话**（100×40 与 45×30，
  经 Riffet 设置里的模型源配置、按服务端 `backends/claude` / `backends/codex` 的方式启动，模型
  `deepseek-v4.1-flash`；读文件的工具调用、流式中文、Markdown、代码块、状态行与 spinner 重绘都在里面）。
  `TmuxParityTest` 要求逐行文本、光标与 **逐格前景/背景/属性** 全部与 `capture-pane` 一致，现全部通过。
  Cursor CLI 未录：在 Riffet 的启动配置之外它处于未登录状态。
- **解析吞吐**（JVM）：移植后 5.3 MB/s；整行擦除/复制的快速路径后约 35 MB/s；加入真实对话样本后降到 10 MB/s，
  热点是逐字符查宽度表的二分查找，改为预先算好整个 BMP 的宽度表（`WcWidth`，64 KB）后回到约 35 MB/s。
- **渲染**：`shared/.../ui/terminal/`（`TerminalCanvas`、`BoxDrawing`、`TerminalPalette`）。JVM 软件渲染整屏重绘
  2–11 ms（45×30 到 100×40），只说明代码路径可行，不代表手机 GPU 上的表现。真机数据由设置 → 诊断与日志 → 高级诊断 →
  「终端渲染测试」测量，每 5 秒写入日志的 `term` 标签。
- **未完成**：真机帧时间、Ktor WebSocket 真机验证。

### T0 之后的进度

- **真机测量**（OnePlus PLZ110，120 Hz，设置 → 排查 → 终端渲染测试）：每帧绘制 p50 1.8–3.4 ms、p95 2.3–5.3 ms，帧间隔
  稳定在 8.2 ms。保留 Compose 文字绘制，不换原生绘制；中端机若不够，再做逐行绘制缓存。测量同时发现终端字号被系统字号与
  「文字大小」放大约 1.67 倍，13sp 只有 30 列：终端页改为使用 `fontScale = 1` 的独立字号，默认 12sp 约 54 列。
- **T2a 只读终端**：入口在右侧栏「终端」格（与变更、文件并列，会话有终端时才显示）。`TerminalConnection` 负责
  WebSocket、无限重连、首连不抢控制权；持有控制权时按手机尺寸请求 pane，只读时按 pane 宽度缩小字号（最小 8sp）并允许横向拖动。
- **T2b 回看**：tmux 客户端在外层终端用备用屏，实时流里没有可回看的行（对录制样本验证过），因此用 `/history` 喂给第二个
  引擎，与实时屏画在同一个可惯性滚动的画布上；增量拉取见服务端 T2。
- **T3 输入**：隐藏输入框 + 已提交文本差分、硬件键盘、两行功能键（粘性 Ctrl/Alt、方向键连发）、更多（F 键、粘贴、整行输入、
  释放控制权）、页头中断；软键盘弹出时不改 pane 行数。尚未做：选择复制、链接与文件路径、捏合缩放。
- **服务端**：T1（`history-limit 20000`）、T2（`mode=tail` 增量历史，`history.test.ts` 用真实 tmux 验证）、T3（客户端终端特性
  `terminal-features[90]`）已完成，需要重启服务端后生效。

## 11. 风险

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| Termux 引擎移植引入缺陷 | 画面错乱 | 原测试全部移植；以 tmux 为准的对拍覆盖 Riffet 实际驱动的 CLI |
| Compose 文本绘制在低端机不够快 | 掉帧 | `GlyphPainter` 接口留出原生绘制退路，T0 就测 |
| 客户端与 Mac 上 tmux 的字符宽度表不一致 | emoji/CJK 行错位 | tmux 的外层重绘按行绝对定位，误差不跨行累积；fixture 覆盖 emoji 与 CJK；必要时让宽度表跟随 tmux 版本 |
| 国产输入法行为各异 | 中文输入异常 | 真机矩阵；整行输入模式作为兜底 |
| 手机与 Mac 争夺控制权、改动 pane 尺寸 | 打断 Mac 上的使用 | 决策 2 的首连策略；服务端 3 s 后恢复 100×40（已有） |
| 工具链升级与终端开发交错 | 终端代码写在旧 Compose API 上，升级后要再验一遍 | 先做第 12 节的升级，再开 T0；`:terminal` 是纯 Kotlin，不受 Compose 版本影响 |
| 许可 | 合规 | Termux 模块 Apache-2.0：保留文件头与 `NOTICE`；termish 只借设计，若复制代码则保留 MIT 声明；JetBrains Mono 为 OFL-1.1，随包附许可文本 |

## 12. 前置任务：移动端工具链升级（已完成）

调研中发现移动端的 Kotlin/CMP 版本落后，这不是模块分层的问题，而是依赖管理的问题：

- `apps/mobile/gradle/libs.versions.toml` 的全部版本在项目初始化提交 `3703154`（2026-10-05）中一次写定，
  此后没有改过。文件头只说是「known-good Kotlin 2.1.x / CMP 1.8.x pairing」，没有说明为什么基线是
  Kotlin 2.1.21；markdown 渲染器与 Coil 的注释记录的都是「为了配合 Kotlin 2.1.21 只能用旧版」，是结果而不是原因。
  Coil 一节还写着「CMP 1.7.3 pairing」，与实际的 1.8.2 不符。
- 环境不构成限制：本机 JDK 17，Android SDK 已有 `android-36.1` 平台与 build-tools 36.1.0、37.0.0。

| 依赖 | 升级前 | 最新稳定（2026-10-06 查询 Maven Central / Google Maven） |
| --- | --- | --- |
| Kotlin | 2.1.21 | 2.4.20 |
| Compose Multiplatform | 1.8.2 | 1.12.1（foundation 1.12.0 要求 kotlin-stdlib ≥ 2.2.20） |
| AGP | 8.7.3 | 9.4.1 |
| Gradle | 8.11.1 | — |
| Ktor | 3.1.3 | 3.6.0（kotlin-stdlib 2.3.21） |
| multiplatform-markdown-renderer | 0.35.0 | 0.45.0（kotlin-stdlib 2.4.10） |
| Coil | 3.1.0 | 3.6.3（kotlin-stdlib 2.4.10，Compose foundation 1.12.0） |

不升级的代价会持续累积：新发布的 KMP 库大多用 Kotlin 2.2 以上编译，旧编译器读不了；Compose 在 iOS 文本输入与
性能上的修复拿不到。

**结果**（单独提交，先于 T0）：Kotlin 2.4.20、CMP 1.12.1（material3 1.9.0）、AGP 9.3.1、Gradle 9.7.0、
compileSdk 37、Ktor 3.6.0、Coil 3.6.3、markdown 渲染器 0.39.2；`:core` 改用标准库的 `kotlin.time.Instant`，
去掉了 `kotlinx-datetime`。升级中发现并处理的约束：

- androidx Compose 1.12（CMP 1.12 的 Android 依赖）要求 AGP ≥ 9.1、compileSdk ≥ 37；AGP 9 不允许 KMP 插件与
  `com.android.library`/`application` 同模块，因此库模块改用 `com.android.kotlin.multiplatform.library`，
  `androidApp` 改为纯 Android 模块（源码移到 `src/main`）。Kotlin 2.4.20 支持的 AGP 上限是 9.3.1。
- CMP 1.11 起去掉 `iosX64`，模块只保留 `iosArm64`、`iosSimulatorArm64`。
- markdown 渲染器 0.40 起是 Java 21 字节码，构建仍在 JDK 17，所以停在 0.39.2（Java 17 字节码）；它删掉了
  旧的颜色/排版槽位与 `MarkdownElement(skipLinkDefinition)`，`MarkdownRender.kt` 已相应调整。
- `targetSdk` 仍为 35，提高它要另做真机验证。

验收：`:contracts:jvmTest :core:jvmTest :shared:jvmTest` 共 71 个套件 270 个测试全部通过（与升级前相同），
`:androidApp:assembleDebug` 成功；本地截图探针重新生成的 25 张图里 24 张与升级前逐像素相同，1 张只在卡片圆角的
抗锯齿上有 18 个像素差异。未做真机验证（Markdown、图片、抽屉、预测性返回、输入框焦点仍需在手机上走一遍）。
留下的弃用警告（`BackHandler` → `NavigationEventHandler`、`LocalClipboardManager` → `LocalClipboard`、
`rememberTransformableState` 旧签名）不在本次处理，迁移会改变行为语义，单独做。
