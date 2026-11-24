---
module: server.agent-host
verify:
  - npx vitest run apps/server/src/agent-host
---

## 职责

内核提供给所有 Agent 驱动的共享宿主服务：按会话的锁，以及对前台 CLI 对话框的识别与应答。不含任何具体 Agent 的逻辑。

## 入口

- `session-lock.ts#SessionLock`：派发器、路由和各驱动共用的一个实例。
- `interactions.ts#NativeInteractions`：把终端里的对话框变成可应答的交互，并在写入前复核。
- `interaction-screen.ts#parseDialog`：从画面文本识别一个完整的前台对话框。
- `interaction-choice.ts#parseChoiceDialog`：选项类对话框（权限、提问）的解析。

## 不变量

- 锁可重入，且只认仍然活跃的作用域；定时器继承了外层的异步上下文，从定时器进入必须用 `session-lock.ts#SessionLock` 的 `withDetachedSession`，否则会跳过队列。
- 第一个持锁者同步进入，这样它能先把会话标成 `starting`，另一个请求才会做工作区可用性检查；改成先 await 再进入会让两个启动竞争。
- 只识别完整的前台对话框：带边框、边框后无其他内容、每行都在竖线内（`interaction-screen.ts#dialogLines`）。转写文本和被截断的画面不是控件，不能被当作对话框应答。
- 对话框的 id 每次观察用服务进程内的盐加随机数重发，对外不暴露 CLI 原始 id（`interactions.ts#NativeInteractions`）。应答在终端锁内复核 id 与 revision，不一致抛 `NATIVE_INTERACTION_STALE`；策略或协议变化不拿终端锁，由 `NativeInteractionGuard` 在写入边界再判一次。
- 「Other」类输入按每个可见字符比较，只有终端折行处的空白允许歧义（`interaction-screen.ts#matchesOtherValue`）。放宽会让答案写进错的选项。
- 画面里没有对话框是否等于 CLI 回到提示符，由驱动通过 `interactions.ts#NativeInteractionsOptions` 的 `settledScreen` 声明；不声明就等对话框连续消失几次读数。核心不要再套用某个 Agent 的页脚规则。
- 权限类对话框里纯 Yes 标为主要、No 标为危险，客户端据此显示批准与拒绝（`interaction-choice.ts#parseChoiceDialog`）；记住规则的选项留在详情里。

## 外部行为

- 输入是终端服务的画面文本（`interactions.ts#DialogTerminal`）：Claude Code 与 Codex 的 TUI 对话框、Cursor 的批准卡。这里没有自己的录制；Claude 画面夹具在 `apps/server/src/backends/claude/fixtures/screens/`，测试在 `interaction-choice.test.ts`、`interaction-screen.test.ts`。
- 提问卡的「Other」编辑框只有在 `otherValue` 非空时才分步发 `End` 和 `C-u` 并等其清空再粘贴（`interactions.ts#NativeInteractions`）：空框时发出的 `C-u`（`\x15`）会在 CLI 瞬间卡顿时与紧跟的 bracketed paste 合并进同一个 stdin chunk，被以 `startsWith("\u0015")` 处理 Ctrl+U 的 CLI 整包吞掉。
- CLI 升级后对话框样式变化时，先补夹具再改解析；标题白名单在 `interaction-choice.ts#isKnownBlockingTitle`。

## 排障

- 应答返回 `NATIVE_INTERACTION_STALE`：画面在两次读取之间变了，看 `interactions.ts#NativeInteractions` 里 id 与 revision 的复核；先同步再重试是预期行为。
- 对话框没有出现在客户端：对该终端的画面跑 `interaction-screen.ts#parseDialog`，多半是边框后残留内容或页脚没被排除。
- Cursor 批准卡缺失：`interaction-choice.ts#cursorApprovalNeedsHistory` 为真时要读 scrollback 才能还原标题，由 `NativeInteractionsOptions` 的 `recoverCursorApprovals` 控制。
- 同一会话的操作互相卡住：`session-lock.ts#SessionLock` 的 `settled` 可以等当前队列结束；锁没有超时，长时间持锁的操作要自己有截止。
