# 原生会话绑定方案

状态：已确认，P0 已实施（2026-11-26）。

一个 Riffet 会话（`Session`）在任一时刻对应 CLI 里的一个原生会话（`Session.nativeSessionId`：Codex 的 thread、Claude Code 的 session、Cursor 的 chat、Antigravity 的 conversation）。本方案把「这个对应关系何时建立、何时改变、改变时旧的去哪里、无法确认时怎么办」从各驱动收回到核心，并规定与之相关的界面反馈。

## 1 问题

触发案例：Cursor 成员的主对话里发送 `/new`，页面出现两条英文 toast 和一条横幅「无法确认这条新对话属于哪个终端，已暂停自动跟随」。

拆开是三个问题：

1. **身份靠猜**。`/new` 重启 CLI 时已经指定了新 chat id（`--resume <新 uuid>`），但 CLI 在首条输入前不建存储，`plugins/riffet/cursor/native/service.ts#scan` 找不到它，退回「工作区里最近修改的 chat」。工作区按目录分桶，修改时间不能说明是哪个终端写的：同项目有别的 Cursor 会话时停止跟随并出横幅；没有时会把刚归档的旧 chat 认回来，`/new` 被静默撤销。
2. **各驱动各写一套**。同样是「原生会话换了」，四个驱动的处理不同（§2），归档 `previousNativeSessionIds` 的代码在 Claude、Codex、Cursor 里各写一遍，Cursor 终端内切换时还漏了归档。
3. **反馈不按规范**。终端被替换期间，Web 终端面板的后台 resize、自动认领打到正在停止或已退出的旧终端，服务端回 `TERMINAL_INTERACTION_BUSY`、`TERMINAL_NOT_RUNNING`，`TerminalView` 把英文原文当 toast 弹出。横幅文字是插件里写死的中文，描述内部机制，没有下一步。

Antigravity 会遇到同一类问题，而且更明显：它的 conversation id 在首条输入前为空（[ANTIGRAVITY.md](ANTIGRAVITY.md) §2 实测），只能先绑定终端、后确认身份；终端里的 `/clear`、`/new` 目前按冲突冻结（`plugins/riffet/antigravity/poll.ts`，提示是英文字面量）；它还没有实现新话题，所以不能作为成员的后端。

## 2 现状

| 驱动 | 新会话首次身份 | Riffet `/new`（成员主对话） | 终端里切换（`/clear`、`/resume` 等） | 无法确认时 |
|---|---|---|---|---|
| Codex | app-server 协议返回 thread id | 同一 app-server 上换 thread，旧 thread 归档；旧 thread 无回合时不动作（`backends/codex/index.ts#newTopic`） | 未核实 | 不存在（协议给出） |
| Claude Code | 启动时指定 `--session-id` | 向同一 CLI 发 `/clear`；`SessionStart(source=clear)` 带新 id，hook 带 `--owner` 归属，跟随并归档（`claude/hook-routes.ts`、`claude/index.ts`） | 同左 | 不存在（hook 带归属） |
| Cursor | 启动时指定 `--resume <uuid>` | 停止终端，清空 id，用新 uuid 重启，旧 chat 归档（`cursor/backend.ts#newTopic`） | 进程打开的存储（lsof，按 pane）→ 跟随，**不归档**；失败时按工作区修改时间猜 | 猜，或停止跟随并出横幅 |
| Antigravity | 首条输入后由 hook/status 确认 | 未实现 | 冻结发送、审批和停止，显示冲突 | 冲突 |

hook 归属的差别：Claude 每次启动的 hook 带 `--owner <会话>`，能把一个陌生的新 id 归到本会话；Cursor 所有启动共用一个 hook 插件目录、没有 owner，只能按 `conversation_id` 反查（`native/service.ts#sessionForChat`），陌生 id 无法归属；Antigravity 按会话一个稳定的 bridge 目录，加 launch descriptor 核验进程。

## 3 不变量

写入 `apps/server/src/backends/AGENTS.md`：

1. **绑定只因可归属的证据改变**。可归属指能对应到本会话当前这次启动（终端 id 与 epoch）：Riffet 自己指定的 id、协议返回的 id、带本次启动归属的 CLI 信号（hook、status）、本次启动的进程打开的存储。按工作区、目录或修改时间推断的候选不是证据，接口不提供表达它的方式。
2. **没有证据就保持原绑定**，不猜，也不把「无法确认」作为状态报给用户。待确认期间不读任何其他原生会话。
3. **旧 id 由核心归档**。绑定从 A 改为 B 时，核心在同一次写入里把 A 追加到 `previousNativeSessionIds`；驱动不再自己拼这个数组。
4. **来自旧启动的信号丢弃**。终端 epoch 或 launch 不匹配的观察直接忽略，只记调试日志。

## 4 设计

### 4.1 绑定状态

核心为每个会话维护绑定状态，替代驱动直接调用 `setNativeSessionId`：

| 状态 | 含义 | 转换 |
|---|---|---|
| `unbound` | 没有原生会话，也没有启动 | 启动 → `pending` |
| `pending` | 已为某次启动（terminal + epoch）开出，等待确认；可带 `expected`（Riffet 指定的 id） | 本次启动的观察 → `bound` |
| `bound(A)` | 已确认 | 本次启动观察到 B → 见 4.3；新话题 → `pending` |
| `conflict(A, B)` | 本次启动切到了一个不能接管的会话（B 已属于别的 Riffet 会话） | 用户返回 A 或打开 B → `bound` |

`pending` 和 `conflict` 进入 `Session` 契约（`packages/contracts/src/session.ts`，可选字段，旧客户端忽略）。读转写、跟随存储的代码只读 `bound` 的 id；`pending` 时不跟随任何存储。

### 4.2 观察接口

`NativeBackendHost`（`backends/types.ts`）和插件的 `AgentHost`（`packages/plugin-api/src/agent.ts`）增加：

```ts
binding.observe(sessionId, {
  nativeSessionId: string;
  launch: { terminalId: string; epoch: number };   // 或协议驱动的 runtime 代次
  source: 'assigned' | 'protocol' | 'launch-signal' | 'pane-process';
}): BindingResult;
binding.open(sessionId, launch, { expected?: string }): void;   // 启动时开出 pending
```

核心校验 launch 是当前那次，再按 4.1 转换。`setNativeSessionId` 保留给导入、交还等由用户操作直接决定绑定的路径，不再给观察代码用。

各驱动的证据来源：

| 驱动 | `assigned` | `protocol` | `launch-signal` | `pane-process` |
|---|---|---|---|---|
| Codex | — | thread/start、thread 通知 | — | — |
| Claude Code | `--session-id` | — | hook（`--owner`） | — |
| Cursor | `--resume <uuid>` | — | hook（补上归属，见 4.5） | 进程打开的 `store.db` |
| Antigravity | — | RPC `conversation_id` | hook、status（launch descriptor） | — |

### 4.3 终端里切换到另一个原生会话

统一为**跟随并归档**，与 Claude Code 现行行为一致：本次启动观察到 B，且 B 没有绑定到别的 Riffet 会话，则 A 归档、绑定改为 B，时间线在 A 的历史之后接上 B。B 已属于别的会话（存储层报 `NATIVE_SESSION_ID_IN_USE`）时进入 `conflict`，保持 A。

这条推翻 [ANTIGRAVITY.md](ANTIGRAVITY.md) §6.3 的「A→B 冻结」。当时冻结是为了不让发送、审批、MCP 调用落到错的会话；4.2 的启动校验已经保证 B 来自本会话的进程，MCP 每次调用按当前绑定授权（§7.2 已是逐调用核验），绑定原子切换后不会串会话。采纳后在 ANTIGRAVITY.md §6.3 和 `docs/design/DECISIONS.md` 各记一条。

A 上还有未结束的运行时，该运行按现有「运行时退出」路径结算为结果未确认，不并入 B。

### 4.4 新话题由核心执行

`/new` 的识别、提交 fence、归档、开出 `pending` 移到核心（`backends/service.ts` 的发送路径），三个驱动里重复的 `standing.newTopic` 判断删除。驱动只实现一个扩展点：

```ts
resetContext(session): Promise<
  | { kind: 'protocol'; nativeSessionId: string }        // Codex：新 thread
  | { kind: 'relaunch'; launch; expected?: string }      // Cursor：指定 uuid 重启；Antigravity：不带 --conversation 重启
  | { kind: 'command'; launch }                           // Claude Code：向同一 CLI 发 /clear
>
```

核心统一处理「当前会话还没有任何已提交回合时不动作」（取自 Codex 现行规则，按 journal 判断，不再各驱动各查）。

成员可选的后端改为由能力推出：实现了 `resetContext` 且能提供 `launch-signal` 或 `protocol` 证据的驱动才可作为成员后端。`packages/contracts/src/assistant-choice.ts#ASSISTANT_BACKENDS` 与 KMP 的同名常量改为读后端目录里的能力声明，Antigravity 实现 `resetContext` 后自动可选，不再改四端常量。

### 4.5 Cursor hook 补上归属

Cursor 的 hook 插件改为按会话一个稳定目录（与 Antigravity 已验证的做法一致：恢复时原生会继续调用旧路径，所以按会话稳定、不按启动换），hook 命令带 `--owner <会话 id>`，launch 由 descriptor 核验。这样终端里 `/clear`、`/resume`、`/fork` 后的第一条 `beforeSubmitPrompt` 就能归属，部分网关不发 `beforeSubmitPrompt` 时仍有 `pane-process`。

`native/service.ts#scan` 只保留进程打开存储这一条，作为 `pane-process` 观察上报；删除工作区修改时间的退路、`sharedWorkspace` 判断和横幅文字。

已知代价：既没有 `/proc`、`lsof`，网关又不发 hook 的机器上，终端里手动切换后绑定不跟随，直到下一个可归属信号到来。按不变量 2，这时保持原绑定。

### 4.6 终端替换

驱动停止旧终端、启动新终端（换模型、新话题、恢复）时，核心给旧终端的 `exit` 带 `reason: 'replaced'`，随后会话的 `terminalId` 指向新终端。

- 服务端（`routes/terminals.ts`）：WebSocket 的 `error` 回复带上它回应的消息类型和客户端给的 `ref`；对正在停止或已退出的终端，`resize` 直接丢弃不回错误。
- 客户端（`apps/web/src/app/terminal/TerminalView.tsx`，Mac、手机端同理）：只有回应用户动作（输入、粘贴、点「获取控制权」）的错误才提示，文字经 `lib/errors.ts#errorMessage` 按错误码取当前语言；后台的 resize、连接时的自动认领、重连失败只改状态标记。收到 `replaced` 不提示，跟到新终端。
- `i18n/errors/terminal.json` 补 `TERMINAL_INTERACTION_BUSY` 等缺的码。

## 5 界面反馈

规范已有对应规则，本方案按规则改代码，并补两条更明确的写法：

- patterns §5.1 增加：**不是用户操作触发的请求失败不弹 `toast`**；能自动恢复的只改控件状态。「现状」列出其他把后台请求错误接到 `toast` 的位置，按次迁移。
- content §4 增加：**不向用户描述内部机制**（跟随、绑定、epoch、租约）。

用户可见的变化只剩一处：`conflict` 时会话里显示一条 `Notice`，正文一句「终端已切换到另一个对话」，操作「回到原对话」（向 CLI 恢复 A）和「打开那个对话」（跳到 B 所属的会话）。四端都显示（Mac 按 [mac-scope](guide/mac-scope.md) 属 W 类）。`pending` 不显示任何东西。

## 6 多服务器

绑定是会话（A 类工作对象）的状态，随会话在拥有它的服务器上维护；经链接查看时只读显示 `conflict` 的 Notice，两个操作经按服务器选目标的请求层发往拥有者。新增的冲突处理路由在链接策略表登记为 `serve`。

## 7 实施顺序

| 阶段 | 内容 | 解决 |
|---|---|---|
| P0 | Cursor：删除工作区猜测和横幅，`pending` 期间不跟随；`newTopic` 加「无回合不动作」。终端：WS 错误带 `ref`，后台请求不报错，`replaced` 不提示，错误码本地化；补规范两条 | 本次截图里的三条提示；Cursor `/new` 被撤销的风险 |
| P1 | 核心绑定状态与 `binding.observe`；归档收回核心；Claude、Codex、Cursor 迁到观察接口；契约加 `pending`/`conflict`，四端渲染冲突 Notice | 三个驱动行为一致，归档只有一处 |
| P2 | 核心执行新话题与 `resetContext` 扩展点；成员后端由能力推出；Cursor 按会话的 hook 目录与 `--owner` | 新驱动接入成员只需实现扩展点 |
| P3 | Antigravity：实现 `resetContext`（重启、不带 `--conversation`），`poll.ts` 的冲突冻结改为 `binding.observe`；改 ANTIGRAVITY.md §6.3 并记决定 | Antigravity 可作为成员后端，`/new` 与终端切换与其他驱动一致 |

P0 可以先单独提交；P1 之后每个阶段都不改变用户能看到的行为，除了 P3 的冲突策略。

## 8 验证

- 自动化测试只覆盖核心行为（仓库规则）：绑定状态转换、旧启动的观察被丢弃、归档幂等（同一 A 不重复追加）、B 已被占用时进入 `conflict`、并发的新话题与观察。放在核心绑定服务的单元测试，各驱动不重复。
- 实测：隔离服务（4317/4327）上，Claude、Codex、Cursor、Antigravity 各建一个成员，`/new` 后确认无提示、绑定指向新会话、旧历史在前；终端里手动 `/clear` 后跟随并归档；两个同项目 Cursor 会话互不认领。
- `pnpm verify` 覆盖到的检查照常跑。

## 9 已定与待定

1. 终端里切换的策略：跟随并归档（4.3），替换 Antigravity 现行的冻结。2026-11-26 确认；P3 时同步改 ANTIGRAVITY.md §6.3 并在 DECISIONS.md 记一条。
2. Cursor hook 归属：按会话的稳定 hook 目录加 `--owner`（4.5），与 Antigravity 同样的验证路径。2026-11-26 确认。
3. 待定：Codex 在终端 TUI 里切换 thread 的行为本方案未核实，P1 迁移时补上。
4. P0 未做的一项：「旧 chat 没有回合时 `/new` 不动作」。实施时 `cursor/backend.ts#newTopic` 正被另一项改动修改，留到 P2 由核心统一处理。
