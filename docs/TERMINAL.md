# Riffet 终端：原始 pane 流方案

日期：2026-11-05。状态：方案已定；服务端 P0+P1 已实施（见文末「服务端实施偏差」）。适用于 Web、macOS、iOS、Android 全部终端，以及服务端
`apps/server/src/terminal/`。它取代 `docs/MOBILE-TERMINAL.md` §6 的「T4 协议 v2（可选）」，
并把它从可选改为必做。

## 0. 结论

1. **根因**：客户端拿到的不是 CLI 的输出，而是 `tmux attach` 客户端在 alternate screen 上的重绘。
   回看因此不存在，只能用 `capture-pane` 轮询，再用第二套渲染器拼到实时屏上方。滚动卡顿、拼缝、
   颜色和宽字符错位、历史重复或丢行、滚轮归属，都是这一层的派生问题，局部修不收敛。
2. **方案**：服务端用 tmux control mode（`tmux -C`）读取每个 pane 的**原始字节**。客户端新连接时，
   在同一条有序的 control 流里用 `capture-pane` 种一次完整状态（历史、屏幕、光标、模式），之后
   只转发 `%output`。**每个客户端只有一个终端模拟器，回看由它自己持有**，原生滚动、选区、查找。
3. **快照由 tmux 生成，服务端不另跑模拟器。** tmux 本来就持有权威网格和宽度表；每个 pane 再跑一个
   `@xterm/headless` 会给上百个后台 CLI 加一份解析 CPU 和回看内存（VS Code 的做法，见 §2）。
   iTerm2、WezTerm 的 tmux 集成都是这条路。
4. **不换终端引擎**：Web 留在 xterm.js 6.0.0，加 `@xterm/addon-webgl`；macOS/iOS 留 SwiftTerm；
   Android 留 Termux 移植引擎。三端删掉各自的「历史视图」。
5. **tmux 最低 3.2**（`pause-after`、`refresh-client -A`、公平输出调度），不再保留 attach 旧路径。

## 1. 已在本机验证的前提（tmux 3.6b）

一次性脚本验证，未入库。Phase 0 改写成正式的对拍测试。

| 前提 | 结果 |
| --- | --- |
| `%output` 与命令回复（`%begin…%end`）严格有序 | 输出中途插入 `capture-pane`：块前最后一条 `%output` 是第 77 行，块后第一条是第 78 行，无缺口、无重复 |
| `refresh-client -f pause-after=N` | 生效，输出改为 `%extended-output %pane <age> : data` |
| alternate screen 上的捕获 | `-S - -E -1` 仍是 normal 屏的历史；`-a` 是保存的 normal 屏；默认捕获是 alt 屏 |
| control client 不影响窗口尺寸 | attach 后仍为 100x40；`window-size manual` 下 `resize-window` 改为 120x30 |
| `send-keys -H` 输入保真 | `a ESC[A 中 ESC[200~p ESC[201~ CR` 共 21 字节，pane 收到的逐字节相同 |
| 模式格式变量 | `alternate_on`、`cursor_flag`、`keypad_cursor_flag`、`mouse_any_flag`、`mouse_sgr_flag`、`wrap_flag`、`insert_flag`、`scroll_region_*`、`alternate_saved_*` 都有值；**没有 bracketed paste 的格式变量** |
| UTF-8 跨 `%output` 行 | 本机 673 行未出现，但 tmux 源码按字节预算切分（`control.c`），WezTerm #6769 实际踩过，**按会切分处理** |

## 2. 参考项目

| 项目 | 做法 | 借鉴 |
| --- | --- | --- |
| [iTerm2 tmux 集成](https://gitlab.com/gnachman/iterm2/-/raw/openQuickly/TmuxWindowOpener.m) | control mode；每个 pane 用一个命令列表种状态：`capture-pane -peqJ -S -N` 取历史与屏幕，`-a` 取 alt 网格，`list-panes -F` 取光标与模式，`capture-pane -P` 取未解析完的转义序列。初始化命令完成前丢弃 `%output`；按字节解码 `%output` | 种状态的命令组合、`-P`、初始化门控、字节级解码 |
| [WezTerm](https://raw.githubusercontent.com/wezterm/wezterm/main/mux/src/tmux_commands.rs) | control mode；`send-keys -H -t %N 0x..`；`resize-window` + `resize-pane` 定尺寸；首次 attach 时 `capture-pane -e -C -S -<limit>` | 输入编码、尺寸控制；它踩过的 UTF-8 切分（#6769）和 `%config-error`（#6763） |
| [VS Code ptyHost](https://github.com/microsoft/vscode/blob/main/src/vs/platform/terminal/node/ptyService.ts) | 自己持有 PTY；服务端 `@xterm/headless` + `SerializeAddon` 生成重连快照；客户端按快照尺寸写入后再交还布局；字符 ack 流控（高 100000 / 低 5000 / 每 5000 ack） | 快照的尺寸顺序、流控常量 |
| [Wave Terminal #2770](https://github.com/wavetermdev/waveterm/pull/2770) | 快照带 PTY 偏移，只回放偏移之后的字节 | 教训：快照与流的边界必须精确，否则历史重复 |
| [web-tmux-cc](https://github.com/adrianleb/web-tmux-cc) | Node，control mode + `pause-after`；暂停或重连后重新种状态 | `%pause` 直接当作「重新种状态」 |
| [xterm.js 流控指南](https://xtermjs.org/docs/guides/flowcontrol/) | `write` 回调水位；输入缓冲约 50 MB 硬上限，超出丢数据 | 客户端 ack |

不采用的：`pipe-pane -O`（每个 pane fork 一个 sh、占用用户可能在用的 pipe、无流控、快照与输出不在同一通道）；
服务端 headless + serialize（快照会丢 SGR 1006 鼠标编码、光标形状、字符集，6.0 稳定版还丢光标可见性和
滚动区域，见 xterm.js #6165、#6230–#6233；上百个 pane 的常驻成本也高）；npm 上现有的 control mode 解析库
（[`@promptctl/tmux-control-mode-js`](https://github.com/promptctl/tmux-control-mode-js) 等，2 星、未发版，
自写约 200 行更可控）。

## 3. 总体架构

```
CLI ──pty──▶ tmux pane ──%output──▶ ControlClient（每个终端会话一个，child_process 管道，不用 PTY）
                                         │ 字节行 → 八进制解码 → 每 pane 流式 UTF-8 解码
                                         ▼
                                   TerminalService
                         ┌───────────────┼────────────────────┐
                         ▼               ▼                    ▼
                 OutputTail / observe   viewer A：seed→live   viewer B：seed→live
                 （启动错误、标题、      （WS，ack 流控）       （WS，ack 流控）
                  就绪检测）
客户端：一个模拟器（xterm.js / SwiftTerm / Termux），scrollback 自持
输入：客户端字节 ──WS input──▶ send-keys -H -t %pane   粘贴 ──WS paste──▶ paste-buffer -p
```

## 4. 服务端

### 4.1 ControlClient（新文件 `apps/server/src/terminal/control.ts`）

- `spawn('tmux', ['-S', sock, '-C', 'attach-session', '-t', name])`，stdio 管道。**stdout 只按 Buffer 读**，
  按 `0x0A` 切行（payload 里的换行已被转义为 `\012`），不调用 `setEncoding`。
- 解析：`%begin/%end/%error` 按 FIFO 对应发出的命令；`%output`、`%extended-output`、`%pause`、`%continue`、
  `%exit`；其余 `%` 行忽略（`%config-error` 3.4 才有，不能因未知行中断）。
- 八进制解码成字节，再用每 pane 一个 `TextDecoder('utf-8', { stream: true })` 解码。转义序列都是 ASCII，
  切在序列中间不影响文本传输。
- **stdout 必须持续读空。** 所有 client 都读不动时 tmux 会停止读 pane，CLI 会阻塞在写上。
  viewer 的背压只作用于各自的发送队列（见 4.4），不回传到 ControlClient。
- 启动时：`refresh-client -f pause-after=10`。不对后台 pane 使用 `%N:off`，原因同上。

### 4.2 替换 attach（`service.ts`）

| 现在 | 改为 |
| --- | --- |
| `pty.spawn('tmux', ['attach-session', …])`（1306） | `new ControlClient(name)`；生命周期、退避重连沿用 `onAttachExit` |
| attach 客户端的 PTY 尺寸决定窗口 | 创建前 `set -g window-size manual`；`resize()`、`restoreBackgroundSize()` 改为 `resize-window -t name -x -y` |
| 用户输入 `pty.write`（749） | `send-keys -H -t %pane 0x..`，每条命令最多 512 字节，同一连接内保持顺序 |
| `interrupt()` 写 `\x03` | `send-keys -H 0x03` |
| `scheduleInitialSnapshot` 的两条路径、`refreshRuntime` 的 `refresh-client` 重绘 | 删除，改为 4.3 的种状态 |
| `OuterTerminalState` 跟踪外层 tmux 客户端的模式 | 改为跟踪 **pane 原始流**中的 2004/1004 等没有 tmux 格式变量的模式，只用来补种状态；服务端重启后没观察到的，按默认值处理 |
| `OutputTail`、`ResumeTitleWatcher`、Cursor 就绪与启动错误 | 输入改为解码后的原始输出，逻辑不变，读到的文本也更干净 |
| `screen()` 缓存键里的 `runtime.sequence` | 不变，sequence 改为按 pane 输出递增 |

`capture-pane` 的各类读屏（`plugins/riffet/cursor/native/screen.ts`、`terminal-dialogs.ts`、`adapters/cli/claude-code.ts` 等）
不依赖 attach 输出，**不受影响**。

### 4.3 种状态（seed）

viewer 订阅、`%pause`、窗口尺寸变化（静默 150 ms 后）时，向 control 流发**一行**命令列表：

```
display-message -p -t %P '<尺寸/光标/模式格式变量，见 §1>' ;
capture-pane -p -e -C -N -S -<SEED_ROWS> -E -1 -t %P ;   # 历史
capture-pane -p -e -C -N -a -q -t %P ;                    # 保存的 normal 屏（alt 关闭时为空）
capture-pane -p -e -C -N -t %P ;                          # 可见屏
capture-pane -p -P -C -t %P                               # 未解析完的转义序列
```

- **门控**：这个 viewer 在 seed 的第一个 `%begin` 之前收到的该 pane `%output` 全部丢弃（已包含在捕获里），
  最后一个 `%end` 之后的转发。这是 §1 验证过的顺序保证，也是 iTerm2 的 `isInitial` 做法。其他 viewer 不受影响。
- 用 `-N`（物理行，保留背景单元格），不用 `-J`。2026-11-03 review 已确认 `-J` 会丢掉整行背景。
  代价是历史不能随客户端宽度重排，所以尺寸变化一律重新种状态（多数时间所有 viewer 都在同一个 pane 网格上）。
- 拼装（服务端完成，客户端只 `write`）：`RIS` → 历史行与 normal 屏行（`\r\n` 连接，**不用 ED2**：
  xterm 的 `scrollOnEraseInDisplay` 会把擦除的屏幕推进回看）→ alt 开着时 CUP 到 `alternate_saved_*`、
  `CSI ?1049h`、alt 行 → DECSTBM、`?1`、keypad、`4h`、`?7`、`?6`、鼠标模式与 `?1006`、`?25`、2004（4.2 的跟踪值）
  → CUP 到光标 → `-P` 字节。
- 恢复不了的：当前 SGR 画笔、normal 屏的 DECSC、G0/G1 字符集、标题。TUI 下一次重绘会覆盖；shell 场景影响很小。
- `SEED_ROWS` 与客户端 scrollback、tmux `history-limit` 统一为一个常量，初值 10000（现在是 20000）。
  Phase 0 实测 10000 行的种状态字节数与手机解析耗时后定稿；已有 pane 的 limit 不变，多出的行不下发。

### 4.4 协议与流控

- 沿用 `/api/terminals/:id/ws` 和现有 JSON 消息（`snapshot`、`output`、`state`、`error`、`exit`），升到 `protocol=3`：
  - `snapshot.data` 是 4.3 的完整种状态，**含回看**；`output.data` 是 pane 原始输出。
  - 客户端新增 `{ type: 'ack', chars }`（每写完 5000 字符发一次）和 `{ type: 'paste', clientId, epoch, text }`。
  - 服务端每个 viewer 记未确认字符：超过 2 M 时**丢弃该 viewer 的队列并重新种状态**，不再关闭连接（现在是 1013 断开）。
- `protocol=2`（已安装的旧版移动端）同一条原始流也能正确显示：快照不含回看，`/history` 保留到各端迁移完成。
- 粘贴统一走服务端 `paste-buffer -p`：pane 是否开启 bracketed paste 由 tmux 判断，这样就不用把 2004
  状态可靠地同步到客户端。附件粘贴已经是这条路径。
- 终端类型目前不在 `packages/contracts` 的 zod schema 里，只改 `src/index.ts` 的类型和 Kotlin `Stream.kt` 的镜像。

### 4.5 版本

- 服务端启动 tmux 时检查版本：低于 3.2 时 `doctor` 和终端创建都报明确的错误，不再降级。
  macOS Homebrew 当前是 3.6b；Ubuntu 22.04 是 3.2a，Debian 12 是 3.3a。
- 3.8 的 control mode 修复（退出时挂起、回复无上限缓冲、丢弃标志与 bracketed paste 冲突 #5622）未发版前，
  靠 4.1 的持续读空和 viewer 侧限额兜住。

## 5. 客户端

### 5.1 Web（`apps/web/src/app/terminal/`）

- `TerminalView.tsx`：`scrollback: SEED_ROWS`，去掉外层滚动容器，xterm 自己滚动；`snapshot` 先 `resize` 到快照尺寸再
  `write`，写完回调里再 `fit` 并在持有控制权时上报尺寸（VS Code `handleReplay` 的顺序）。
- 删除：`TerminalHistory.tsx`、`/history` 轮询与缓存、`wheelToApp`、wheel capture 分流、
  合成 wheel 的触摸逻辑、<!-- doc-paths:off -->`lib/ansi.ts`<!-- doc-paths:on --> 的 `appendScrollback` 和只剩测试在用的 `parseAnsi`。滚轮归属交还 xterm：
  应用开了鼠标就上报，alt 屏发方向键，否则滚回看。
- 渲染：Chromium 桌面加载 `@xterm/addon-webgl@0.19.0`。`onContextLoss` 时 dispose 并回落 DOM，此后整个会话
  不再尝试；Safari、WKWebView 和移动浏览器默认 DOM（xterm.js #5816）。框线字符由 WebGL 的 `customGlyphs` 画满整格。
- 滚动（`smooth-scroll.ts`）：xterm 6 的视口按整行定位（`Viewport._handleScroll` 把偏移取整到行），而且把触控板的
  像素增量放大十倍以上。实测一次 4px 的滚轮事件移动 38–57px，即 2–3 行，文字成段跳动，不跟手。改为在 host 上捕获滚轮，自己按像素记录位置：
  xterm 滚到整行，余下不足一行的部分用 `.xterm-screen` 的 `translateY` 补上，与 xterm 重绘落在同一帧。同一输入实测为
  1:1 的 4px。代价是读历史时停在两行之间，底边会留一条不足一行高的空白，因为视口下面那一行没有绘制。
  触摸（xterm 6.0.0 不支持，#5489）走同一套位置，加松手后的惯性。程序读鼠标或处在 alt 屏时，滚轮与滑动仍交给 xterm，
  以鼠标事件或方向键发给程序。
- 宽度：Phase 0 用 fixture 对比 xterm 默认（Unicode 6）、`addon-unicode11` 与 tmux 的结果，选与 tmux 一致的那个；
  个别不一致的码位用 tmux 3.6 的 `codepoint-widths` 对齐。
- 粘贴改发 WS `paste`，不再调用 `term.paste`。`onUserInput` 内部接口的适配保留。

### 5.2 macOS / iOS（SwiftTerm）

- 删除 `TerminalScrollView.swift` 的双 SwiftTerm 拼接和离开底部时的历史拉取，一个 `TerminalView` 直接 `feed`，
  scrollback 自持；iOS 删除 `TerminalHistoryPage` 弹层。
- `TerminalOutputInbox` 批处理和主题重放上限（2 MiB）保留；重放改为请求一次新的种状态，不再保留原始输出副本。

### 5.3 Android / 共享 Kotlin

- `TerminalConnection.kt` 升 `protocol=3`，加 ack、`paste`；`TerminalScreen.kt` 删除历史循环，`TerminalScrollback.kt` 删除，
  回看由 `:terminal` 引擎的 transcript 持有。
- `TerminalRetint` 的字节改写不在本方案内，输入从 tmux 重绘换成 CLI 原始输出，行为不变。

## 6. 分期

| 阶段 | 内容 | 退出条件 |
| --- | --- | --- |
| P0 验证（约 2 天） | `control.ts` 解析器；用 `scripts/record-terminal-fixtures.ts` 改录 `%output` 原始流（Claude Code、Codex、Cursor、vim、less、shell）；对拍：seed + 后续流喂给 `@xterm/headless`（devDependency，只在测试里用），与 tmux 结束时的 `capture-pane` 逐格比较；实测 10000 行种状态的字节数与解析耗时；验证 SGR 鼠标和 CSI-u 扩展键经 `send-keys -H` 不被改写 | 全部 fixture 逐格一致，或差异只出在 §4.3 列明的不可恢复项；不满足则停在这里重新评估 |
| P1 服务端 | ControlClient 接入 `service.ts`；`window-size manual`；seed、门控、ack、重新种状态；`protocol=3` 与 `protocol=2` 并存；版本检查 | `history.test.ts` 中仍适用的真实 tmux 用例改写后通过（快照网格、退出码、错误输出先于退出、守护进程重启、租约） |
| P2 Web | 5.1 全部；删除历史与拼接代码 | 类型检查、构建；实际界面按 §7 预算验收 |
| P3 原生端 | 5.2、5.3，共享 `TerminalConnection` 一次改完 | macOS、iOS、Android 构建；`TmuxParityTest` 改用新 fixture |
| P4 清理 | 各端发版后删除 `/history`、`protocol=2` 分支、历史版本号（`cells-v1`）与相关类型和测试；更新 `MOBILE-TERMINAL.md`、`MACOS.md` 的终端章节 | `rg "terminalHistory|cells-v1|TerminalScrollback"` 无结果 |

测试按仓库规范只保留协议与行为：种状态与流的对拍（无缺口、无重复）、重连与重新种状态、ack 流控、
输入字节保真、退出结果。不加 UI 测试。

## 7. 验收预算

- 10000 行回看：桌面 Chrome 滚动不掉帧；手机端在 Android 真机上流畅滚动。
- `yes` 持续输出时 Ctrl-C 1 秒内生效，不断线；慢 viewer 只会让自己重新种状态，不拖慢 CLI 和其他 viewer。
- 中英文混排、框线、diff 整行背景与 tmux 捕获逐格一致（P0 对拍）。
- 重连、切换标签、尺寸变化后回看不重复、不丢行。

## 8. 风险

| 风险 | 对策 |
| --- | --- |
| 客户端宽度表与 tmux、CLI 不一致。以前 tmux 每行绝对定位，误差不跨行；现在由客户端自己解析，误差会累积 | P0 对拍选宽度表；tmux `codepoint-widths` 对齐个别码位；「重新连接」即重新种状态，可作兜底 |
| 种状态丢失 SGR 画笔、DECSC、字符集 | TUI 重绘后自愈；对拍会给出实际影响面 |
| control client 停读会阻塞 CLI | 4.1 的持续读空；viewer 背压只在服务端队列里处理 |
| Claude Code 等 Ink 界面整屏重绘会在回看里留下重复内容 | 与 iTerm2 等原生终端的表现一致，是 CLI 自身的输出；不在服务端改写 |
| 窗口尺寸变化后要重新种状态，回看位置会跳回底部 | 尺寸变化只在持有控制权的设备调整窗口时发生；静默 150 ms 后才种一次 |
| tmux 3.8 之前的 control mode 缺陷 | 版本检查；私有 tmux socket 不受用户配置影响；跟进 3.8 发版 |

## 9. 服务端实施偏差（P1）

- **`window-size manual` 设在窗口上，不用 `-g`。** tmux 3.6b 在全局 `window-size manual` 下创建第二个会话时 server 直接退出
  （`server exited unexpectedly`，可复现）。创建时 `new-session -x C -y R` 后对该窗口 `set-option -w window-size manual`，
  `attach` 时 `resize-window` 本身也会把该窗口设为 manual（旧会话因此被迁移）。
- **种状态没有「seed 命令」之外的第二条路径**：`completeExit` 的最终快照对已死 pane 用同一组 `seedCommands` 分条 `execFile` 读取
  （control 客户端此时已断开），拼装复用 `assembleSeed`；只在有 viewer 时读。
- **ack 计数**：protocol 3 的 `unacked` 累加每条 `output.data.length` 与每个 `snapshot.data.length`；`ack.chars` 递减并下限为 0。
  超过「2 000 000 + 最近一次快照长度」字符时丢弃该 viewer 的后续输出并重新种状态，种状态完成时 `unacked` 重置为该快照长度。
  阈值包含快照长度，是因为 1 万行彩色回看的种状态本身就可能超过 2 M；否则快照之后的第一条输出就会再次触发种状态，形成循环。
  Web 客户端的本地积压保护同样不计快照字符。重新种状态之前已发出的数据客户端仍会 ack，因此重置后的计数可能略偏小，下限 0 保证不会为负。
- **ack 不进消息串行链**：路由同步解析每条消息，`ack` 立即生效，不排在 claim/paste/resize 之后。
- **种状态按行收尾**：`capture-pane -e` 的样式会跨行延续，行尾 LF 滚屏时会用当前背景填满新行。每行以 `ESC[0m\r\n` 结束，
  下一行开头重申延续的样式。对拍测试逐格比较字符、前景/背景与粗体、反显、下划线。
- **`%pause` 一律恢复**：无 viewer 时单独发 `refresh-client -A '%P:continue'`，有 viewer 时与种状态同一行。
  本机 3.6b 无法触发真实 `%pause`，这条路径没有被测试覆盖。
- **回复对齐**：spawn 后先发一条带随机 token 的 `display-message`，收到它之前的回复块全部丢弃，不依赖各版本 `%begin` flags 的含义。
- **尺寸变化后的种状态**：输出静默 150 ms 后发出，持续输出时最晚 1 s。
- **粘贴换行**：WS `paste` 在 `load-buffer` 前把 `\r\n` 与单独的 `\r` 规范为 `\n`（`paste-buffer` 会把 LF 换成 CR，CRLF 否则变成两次回车）。
- **protocol 3 的 socket 缓冲上限为 32 MiB**（超过关闭 1013）：重新种状态本身要排队一份快照，停读的 TCP 连接需要一个硬上限；
  protocol 2 仍是 4 MiB。
- **输出合并**：一次 control 流读取里的多条 `%output` 合成一条 `output` 消息（微任务里发出，seed 完成前强制先发出），
  `sequence` 按合并后的消息递增。
- **粘贴 / 输入**：`paste` 消息的文本字段是 `data`（与契约一致），走 `pasteAttachmentsWithLease`（租约校验，不带 Enter）。
- **服务端重启后** `?2004`、`?1004` 与光标形状按默认值种入（没有 tmux 格式变量可读），程序下一次设置后即恢复。
- **版本**：`tmux -V` 低于 3.2 时创建与 attach 抛 `TMUX_TOO_OLD`（503）；`doctor` 与设置页能力检查报告同一信息。

