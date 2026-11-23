---
module: server.terminal
verify:
  - npx vitest run apps/server/src/terminal
---

## 职责

Riffet 私有 tmux 服务器上的终端：创建与回收 pane，经 control mode 读原始字节，给每个客户端种一次完整状态再转发输出，接收输入、尺寸与外观。

## 入口

- `service.ts#TerminalService`：所有终端操作；Agent CLI、shell 与预热终端共用。
- `control.ts#ControlClient`：每个 tmux 会话一条 `tmux -C` 连接，命令回复与 `%output` 严格有序。
- `seed.ts#seedCommands`：新连接的快照由 tmux 生成，客户端不回放历史，并同步 `pane_current_path`、`pane_current_command`、`pane_title`。
- `wire.ts#encodeSnapshotFrame`：`protocol=4` 二进制帧编解码（输出、raw deflate 大快照压缩、原始输入、应用层心跳）。
- `shell-integration.ts#prepareShellLaunch`：zsh/bash/fish 的非侵入式 OSC 133/7 注入（脚本留在私有 `stateDir`，不改 `$HOME`）。
- `orphans.ts#claimTmuxServerCommands`：tmux 服务器的归属标记，回收规则见 docs/guide/performance.md §3.10。

## 不变量

- 快照与流的边界必须精确，否则历史重复或丢行：种状态的命令与 `%output` 在同一条有序流里（`seed.ts#seedLine`），回复对齐靠带随机 token 的 `display-message`，不依赖 `%begin` 的 flags。设计取舍见 docs/TERMINAL.md §9。
- control 客户端必须持续读 stdout。它不读，tmux 就停止读 pane，CLI 会卡在自己的写上（`control.ts#ControlClient`）。
- `window-size manual` 设在窗口上，不用 `-g`：tmux 3.6b 在全局设置下创建第二个会话时服务器会直接退出（docs/TERMINAL.md §9）。最低 tmux 版本见 `control.ts#TMUX_MIN_VERSION`，没有旧的 attach 路径。
- protocol 3 的积压上限是 `service.ts#MAX_UNACKED_CHARS` 加上该 viewer 最近一次快照的长度。不加快照长度，大回看的种状态本身就会超限，下一条输出又触发重新种状态，形成循环。
- 种状态按行以 `ESC[0m` 收尾并重述延续的样式（`seed.ts#assembleSeed`）；bracketed paste 与光标形状 tmux 没有格式变量，来自原始流（`protocol-state.ts#OuterTerminalState`）。
- 启动命令的整条 `new-session` 经一条不超过 16 KiB 的 tmux 消息发送，参数按 UTF-8 字节量并留余量；换行安全，以 `;` 结尾的参数必须转义（`launch-args.ts#tmuxArgument`）。派发器用同一规则（`launch-args.ts#launchArgAccepted`）判断能否作为参数，不能的改为粘贴。
- 没有 viewer 的 CLI 按 100x40 渲染，对话框才不会被裁剪；有 viewer 后延迟恢复（`service.ts#restoreBackgroundSize`）。
- 多个轮询方共享一次 120 ms 内的 `capture-pane`，任何写入或输出提前作废（`service.ts#SCREEN_CACHE_MS`）。要读最新画面传 `fresh`。
- 所有外部命令走 `apps/server/src/exec.ts` 的 worker，不在主线程 `execFile`；主线程 spawn 曾造成 0.8 至 3.5 s 的事件循环阻塞，使投递证据「迟到」变成「没看到」。
- 终端的 CLI 启动失败时，在销毁保留的 pane 前读它最后的行，用驱动的 `TerminalBehaviour` 判断，pane 已显示就绪的不算失败启动（`service.ts#finishExit`）。

## 外部行为

- 外部输入是 tmux（至少 3.2）的 control 流与 `capture-pane`、`list-panes` 输出，以及 WebSocket 客户端的 `protocol` 1 至 3 帧（`apps/server/src/routes/terminals.ts`）。
- 录制：移动端 VT 引擎的 tmux 流录制由 `scripts/record-terminal-fixtures.ts` 生成，位于 `apps/mobile/terminal/fixtures/tmux/`，与本模块用同一套 tmux 环境。服务端没有独立的录制回放，`history.test.ts` 对拍 tmux 的网格。
- 各 Agent 的启动失败文案与就绪判断由驱动给出（`service.ts#TerminalBehaviourSource`），本模块不认识具体 Agent。

## 排障

- 终端创建报 `TMUX_COMMAND_FAILED` 或 `TMUX_TOO_OLD`：先看 `service.ts#assertTmuxVersion` 的版本，缺任务目录会先报目录不存在，再看 tmux。
- 重连后历史重复或错位：检查 `service.ts#sendSnapshot` 的 `sequence`、`streamId` 与客户端 ack，再看是否触发了 `MAX_UNACKED_CHARS` 重新种状态。
- 孤儿 tmux 服务器或残留终端：`orphans.ts#listRiffetTmuxServers`，回收日志 `reaped stray terminal sessions`、`ended unreachable tmux servers`（无 scope，按文本过滤 `riffet logs`）。
- Codex 终端被报连接冲突：端点验证先看启动记录与 `service.ts#inspectPane` 的共享 `list-panes -a`，进程扫描只是回退；未验证只读为重连，只有证明用了别的 app-server 才是冲突。
- 终端状态在 `terminals` 表（`apps/server/src/store.ts`），`epoch` 在退出与被预热认领时递增。
