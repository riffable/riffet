# Riffet 接入 TRAE CLI（traex）

本文是 traex 后端的方案契约，与 `docs/STATS.md` 同类：先定判据和决策，再给协议事实、差异清单与改动面。

状态：**一至三期已实现**（2026-10-12）。调研基于本机 `traecli 0.209.1`（`~/.local/bin/traex`）与
`codex-cli 0.160.0`。文中「实测」均指对真实 traex app-server 的端到端调用，不是读帮助文本的推断。
与方案不同的地方见 §9，真实 CLI 回归见 `scripts/probe-traex-e2e.ts`。

2026-10-16 更新：TRAE CLI 原生支持工具边界引导；Riffet 已在 0.210.1 接入专用严格引导路径，目标过期即拒绝，使用持久输入元数据确认归属，详见 §11 及 [会话引导](STEER.md)。本文早期按正文认领的方案仅描述普通发送兼容路径，不作为专用引导的回执依据。

同日增加原生 Standard / Max 上下文模式，能力与容量由模型目录声明，复用现有模型选择器，见 §12。

已定的决策：

| 项 | 决定 |
| --- | --- |
| 驱动形态 | 复用 Codex app-server 驱动，按 flavor 参数化；不新写第六个驱动，不走 ACP、`exec --json` 或共享 daemon |
| 后端 id | `traex`，标签 `TRAE CLI`，与 `codex` 并列出现在所有后端列表 |
| 原生 TUI 通道 | loopback WebSocket（`ws://127.0.0.1:<随机端口>`）+ capability token；Codex 继续用 Unix socket |
| 安全边界 | 与 Codex 的 0700 Unix socket 等价：同一用户可达，其他用户被 401 拒绝 |
| 独有能力 | 只接 riffet 已有落点的：排队位置、上下文分项、Plan 模式、模型回退提示；其余列入后续 |

---

## 1. 判据

1. **与 Codex 后端同等**：网页与手机发消息、流式草稿、审批与提问卡片、模型 / 权限 / effort 切换、历史分页、
   子 Agent 页、统计与上下文环，以及原生 TUI 面板与网页**共享同一个 thread runtime**（两边互相看见对方的输入）。
2. **不扩大暴露面**：任何能驱动 agent 的端点，可达范围不超过 Codex 现有的 Unix socket；token 不进 argv、
   不进 HTTP 响应、不写进 tmux 元数据之外的地方。
3. **Codex 行为不变**：共享代码只做参数化，`codex/index.test.ts` 等现有测试原样通过。
4. **漂移可见**：traex 迭代很快，能力靠探测而不是版本号判断；探测失败降级为「无 TUI」而不是报错。

---

## 2. traex 是什么

traex 是 Codex CLI 的 fork：二进制内 crate 名仍是 `codex_core` / `codex_app_server_transport`，`initialize`
返回 `userAgent: "Codex Desktop/0.209.1 …"`，配置在 `~/.trae/traecli.toml`，会话 rollout 的命名与目录结构和
Codex 相同。模型走 TRAE 网关（`model_provider = "trae"`，用户自己的 TRAE 登录），目录里有 23 个模型，分两种
harness：gpt 系列是 `codex`，Doubao / DeepSeek / Gemini / openrouter 是 `claudecode`（Claude Code 式工具集：
`Bash` / `Read` / `Edit` / `Grep` / `TaskCreate` / `TaskUpdate`）。实际使用中后者居多。

### 2.1 实测通过的部分

| 项 | 结果 |
| --- | --- |
| `initialize`、`model/list`、`thread/loaded/list`、`thread/start`、`thread/resume`、`thread/read`、`thread/name/set` | 与 Codex 同形 |
| `thread/turns/list` | 可用（稳定版 schema 漏导出，`--experimental` 里有）；未落盘时的报错与 Codex 一致 |
| 通知流 | `turn/started`、`item/started|completed`、`item/agentMessage/delta`、`item/reasoning/textDelta`、`item/plan/delta`、`turn/plan/updated`、`thread/tokenUsage/updated`、`thread/status/changed`、`turn/completed` |
| 服务端请求 | 10 种与 Codex 完全一致；`item/commandExecution/requestApproval` → `decline` → `serverRequest/resolved` 往返实测通过 |
| 审批决策词表 | `accept / acceptForSession / acceptWithExecpolicyAmendment / applyNetworkPolicyAmendment / decline / cancel`，与 Codex 相同 |
| 目录与 hook 信任 | 目录信任同为 `projects."<cwd>".trust_level`；hook 信任由 CLI 按定义哈希记录，定义变化时重新审核 |
| 进程生命周期 | SIGTERM 后整组退出，满足 `stopProcess`（`backends/shared/codex-app-server.ts:326`） |
| loopback ws 鉴权 | `--listen ws://127.0.0.1:0 --ws-auth capability-token --ws-token-file F`：无 token / 错 token 均 401，Bearer token 通过；端口从启动横幅读出 |
| 共享 runtime | app-server 走 ws，TUI 以 `--remote ws://… --remote-auth-token-env VAR resume <id>` 接入：TUI 显示既有历史；网页发的回合出现在 TUI；TUI 里输入的回合被 riffet 收到 |

### 2.2 与 Codex 的差异（实测）

| 差异 | 现状代码的后果 |
| --- | --- |
| TUI `--remote` 只接受 `ws://`/`wss://`，`unix://` 报 `invalid remote address` | Codex 的 TUI 接法（`codex/index.ts:1066`）和探测（`:3060` 要求帮助里有 `unix://`）都不成立，`available()` 会判为不可用 |
| `turn/start` 用 `userMessageId` 关联，回显在 user item 的 **`id`**；`clientUserMessageId` 被静默忽略 | riffet 从 `item.clientId` 取 commandId（`:1890`、`:2089`、`:2214`、`:2468`、`:2503`），网页发出的消息全部对不上 run |
| `turn/steer` 返回 `{ turnId }`（Codex 是 `{ turn: { id } }`），且不接受任何消息 id；被 steer 的 user item 拿到服务端生成的 `msg_…` | `:1301-1302` 读 `response.turn?.id`，取不到即抛 “did not acknowledge”——每次中途追加都会失败 |
| `thread/read` 未落盘时报 `…; includeTurns is unavailable…` | `isUnmaterializedThreadError`（`:3080`）只认 `thread/(turns/list|read)`，冷启动读新线程会被当成真错误 |
| 家目录：`TRAE_HOME`（配置根，默认 `~/.trae`）+ `TRAECLI_HOME`（状态与会话，默认 `$TRAE_HOME/cli`）；`CODEX_HOME` 被忽略 | `:418`、`:1712`、`:1832` 按 `CODEX_HOME ?? ~/.codex` 找 rollout，永远找不到 |
| `thread/start|resume` 直接返回 rollout 绝对路径 `thread.path` | 可以不再扫目录（`rollout-usage.ts:164`） |
| rollout 不再写 `response_item` / `token_usage_record`，改为 `history_mutation { operation: append|replace, items[] }` 包着同形的 response item | 用量统计会退回 `token_count`（`rollout-usage.ts:93`），可用；计划回放（`rollout-plan.ts:49` 只读 `response_item` 里的 `update_plan`）全丢；`replace` 没有语义处理 |
| claudecode harness 的计划工具是 `TaskCreate` / `TaskUpdate`；`turn/plan/updated` 条目多出 `activeForm / taskId / description`，状态是 `inProgress` | 实时计划可用（`planStatus` 已认 `inProgress`），历史回放不认 Task 工具 |
| claudecode harness 的内置工具投影为 `commandExecution`，`command: "Read"`，真正语义在 `commandActions[].type`（`read` / `listFiles` / `search`）与 `input.type: "builtin"` | `projectToolItem`（`:2856-2889`）不看 `commandActions`，`Read` 会显示成一条 “Command: Read” |
| `tokenUsage` 多报 `cacheCreationInputTokens` | Codex 不报 cache write，现有映射不取，统计少一个维度 |
| 新 item 类型：`taskNotification`、`sessionPeerMessage`、`terminalInteraction`、`worktreeSessionEntered|Exited` | 落到 `projectItem` 末尾的 `return []`（`:2138`），静默丢弃 |
| 正在进行、尚未落盘的回合，`thread/turns/list` 已经返回它已完成的前几个 item，但 id 是位置占位：`item-1`、`item-2`（从打开这个回合的消息之后算起）；回合落盘后同一批 item 换成长期 id（`msg_…` / `rs_…` / `fc_…` 等），多次读取都稳定 | 同一段回答被投影两次：按 id 去重挡不住，回答连同它的「Processed」各出现一行（见 §10） |
| 鉴权、计费、模型：无 OpenAI API key / Fast service tier（`serviceTiers` 全空） | `providerArgs` / `providerEnvOverrides`（`:3005-3038`）与 Fast 开关对 traex 无意义 |

### 2.3 排除的路线

| 路线 | 排除理由 |
| --- | --- |
| `traex acp serve` | riffet 已于 2026-10-03 删除 ACP 后端，理由是它是终端 CLI 的功能子集 |
| `traex exec --json` | 非交互，没有审批 / 提问回传，也接不上原生 TUI |
| 共享 daemon（`app-server daemon start`，控制 socket `~/.trae/cli/app-server-control/app-server-control.sock`） | riffet 能连上，但实测开了 `daemon_auto_start` 的 TUI 仍在进程内跑 runtime，daemon 的 `thread/loaded/list` 看不到它；TUI 的 `--remote` 又不接受 Unix socket，所以接不进 daemon。且 daemon 是全用户共享、`daemon update` 会打断运行中的工作，生命周期不归 riffet |
| `~/workspace/traex-bridge`（把 traex 模型翻译成 OpenAI / Anthropic 协议） | 只拿到模型，丢掉 traex 的 agent 本体（claudecode harness、Task 工具、hooks、skills、plugins、memory）。作为 Codex 后端的「API endpoint」仍可用，与本方案正交 |

---

## 3. 架构

### 3.1 Flavor 参数化

`CodexBackendAdapter` 增加一个构造参数 `flavor`，`app.ts` 注册两次：`new CodexBackendAdapter(codexFlavor)` 与
`new CodexBackendAdapter(traexFlavor)`。flavor 只描述差异，驱动逻辑仍只有一份：

```ts
interface CodexFlavor {
  id: 'codex' | 'traex';
  label: string;
  /** Env var naming the executable, and the bare command used when it is unset. */
  executableEnv: string; command: string;
  /** Where rollouts live when the thread did not report `path`. */
  stateHome(profile: NativeBackendProfileConfig): string;
  homeEnv(profile: NativeBackendProfileConfig): Record<string, string>;
  transport: 'unix' | 'loopback-ws';
  /** Request field that tags a submitted user message, and how the echo is read back. */
  messageTag: { request: 'clientUserMessageId' | 'userMessageId'; echo: 'clientId' | 'id' };
  probe(executable: string): Promise<FlavorProbe>;
  providerArgs(profile: NativeBackendProfileConfig): string[];
  modes: NativeBackendOption[];
}
```

| 字段 | codex | traex |
| --- | --- | --- |
| `executableEnv` / `command` | `CODEX_CLI` / `codex` | `TRAEX_CLI` / `traex` |
| `stateHome` | `configDir ?? CODEX_HOME ?? ~/.codex` | `TRAECLI_HOME ?? (configDir ?? TRAE_HOME ?? ~/.trae)/cli` |
| `homeEnv` | `CODEX_HOME=configDir` | `TRAE_HOME=configDir` |
| `transport` | `unix` | `loopback-ws` |
| `messageTag` | `clientUserMessageId` → `item.clientId` | `userMessageId` → `item.id` |
| `providerArgs` | 现有 API endpoint / key 逻辑 | 空；profile 只支持 `executable`、`configDir`、`defaultModel` |
| `modes` | `[]` | `default`、`plan`（见 §4.2） |

模块级缓存要随之收进实例：`fastTierIds`（`codex/index.ts:72`）以模型 slug 为键，traex 与 Codex 都有 `gpt-5.5`，
共用会串；`probes` 以可执行文件路径为键，可以保留。

写死 `'codex'` 的地方改为按 flavor 或能力判断：

- `terminal/service.ts:250`、`:726`、`:735`：`backendId !== 'codex'` → 「backendId 属于 app-server 家族」。
- `backends/codex/endpoint.ts`（原 `terminal/codex-endpoint.ts`）：`looksLikeCodex` 认 `traex`；端点校验对 traex 接受 `ws://127.0.0.1:<port>`。
- `backends/service.ts:926`：Codex 关闭时跳过 `dispose` 以保留可复用的 app-server，traex 同理，改为按驱动声明判断。

### 3.2 传输：loopback WebSocket + capability token

`backends/shared/codex-app-server.ts` 增加 ws 分支，`CodexAppServerClient` 接口不变，上层无感：

1. **准备凭据**：`~/.riffet/traex/endpoints/`（0700）下为每个 app-server 生成 32 字节随机 token，写成
   `<随机名>.token`（0600）。
2. **启动**：riffet 先在 127.0.0.1 上挑一个空闲端口，再起
   `traex <trust args> app-server --listen ws://127.0.0.1:<port> --ws-auth capability-token --ws-token-file <file>`，
   `detached` 且 `stdio: 'ignore'`，带 `Authorization: Bearer <token>` 重试连接。子进程在拿到端口前退出
   （端口被抢）就换端口重试，最多三次。不从横幅读端口：那要把子进程的 stdout 接到 riffet 的管道上，
   riffet 重启后管道断开，app-server 下一次写日志就可能因 EPIPE 退出，而它恰恰应该活过 riffet 重启。
3. **自检**：连上之后先发一次**不带** token 的握手，必须得到 401。帮助文本说 `--ws-auth` 是给「非 loopback
   监听」用的，0.209.1 实测在 loopback 上也生效；如果哪天不生效，立即降级为 Unix socket + 无 TUI（§5），
   而不是继续开放一个无鉴权端口。
4. **绑定**：`remoteAddress = ws://127.0.0.1:<port>`，照旧写进 `Session.nativeRuntime.address`。不额外持久化
   凭据：恢复时 token 文件路径直接取自监听进程自己的 argv（见第 6 步），这对从 TUI 命令行读到的端点同样成立。
5. **TUI**：token 经 `launchPty` 的 `secretEnv` 交给终端服务。它放进 tmux 客户端进程自己的环境，再由 tmux 的
   `update-environment` 带进新会话，`CURSOR_API_KEY` 走的也是这条路。参数为
   `<trust args> -c check_for_update_on_startup=false --remote ws://127.0.0.1:<port> --remote-auth-token-env RIFFET_APP_SERVER_TOKEN --cd <cwd> resume <id>`。
   token 不出现在 TUI 或 tmux 任何进程的 argv 里。
6. **重启恢复**：候选端点仍按现有顺序取（TUI 进程 argv → 持久绑定）。连接前先确认监听者身份：
   `lsof -nP -iTCP@127.0.0.1:<port> -sTCP:LISTEN -Fpu` 得到 pid 与 uid，uid 必须是当前用户，argv 必须含
   `app-server --ws-auth capability-token --ws-token-file <file>`，且 `<file>` 的真实路径在凭据目录内、属于当前
   用户、权限不宽于 0600，才读 token 连接。任何一条不符都按「端点不可达」处理，走现有的重新拉起分支，
   绝不把 token 发给一个刚好占了这个端口的进程。
7. **释放**：`dispose` 结束进程组并删除 token 文件；`detach`（riffet 自身重启）保留进程与文件。重新接入的
   app-server 也能被 `dispose` 结束：它的身份在第 6 步已经确认是本机这个 riffet 拉起的。Codex 的 Unix socket
   接入后只能断开、不能结束，这一点 traex 比 Codex 更干净。

安全对照：

| | Codex（现状） | traex（本方案） |
| --- | --- | --- |
| 端点 | 0700 临时目录里的 Unix socket | loopback TCP 端口 |
| 其他用户 | 无权访问目录 | 能连端口，401 |
| 同一用户 | 能连 | 能读 0600 token 文件，能连 |
| 凭据位置 | 无 | token 文件 + TUI 进程环境 + tmux 会话环境（同一用户可读），每个 app-server 一枚 |
| 端口复用风险 | 无 | 恢复前校验监听进程（第 6 步） |

### 3.3 协议差异的处理

| 差异（§2.2） | 处理 |
| --- | --- |
| 消息关联 | `send` 按 `flavor.messageTag.request` 填字段；五处 `str(item.clientId)` 收敛为 `commandIdOf(item)`，按 `echo` 取 `clientId` 或 `id`。traex 的 `id` 只有在等于我们发出的 commandId 时才算关联上 |
| `turn/steer` 回执 | 同时接受 `{ turn: { id } }` 与 `{ turnId }`。被 steer 的消息没有可回显的 id：在 runtime 里按回合维护一个待确认的 steer 队列，同一活跃回合里下一条文本相同的 user item 认领队首 |
| 未落盘报错 | 正则放宽为 `thread\/(?:turns\/list|read)|includeTurns`，补对应单测 |
| 探测 | traex 的 `probe` 改为检查 `resume --help` 里有 `--remote <ADDR>` 和 `--remote-auth-token-env`、`app-server --help` 里有 `--ws-auth` 与 `ws://`；三项任一缺失就 `supportsTerminal: false`，但后端仍可用 |
| rollout 路径 | 优先用 `thread/start|resume` 回来的 `thread.path`，记进 runtime；只有缺失时才按 `flavor.stateHome` 扫目录 |
| rollout 格式 | 在 `rollout-usage.ts` / `rollout-plan.ts` 前加一层记录迭代器：`history_mutation` 的 `append` 和 `replace` 都展开为逐条 `response_item`。实测 `replace` 都是上下文压缩，换入的只是摘要，所以不清空之前累计的计划状态，这和 Codex 对 `compacted` 的处理一致；`update_plan` 之外认 `TaskCreate` / `TaskUpdate` / `TaskList`（参数映射为同一套 `entries`） |
| 内置工具 | `projectToolItem` 优先看 `commandActions[0].type`：`read` → kind `read`，标题用 `path`；`listFiles` / `search` → kind `search`；`input.type === 'builtin'` 时不按 shell 命令渲染。Codex 也会发 `commandActions`，一并受益 |
| 计划条目 | `normalizePlanEntries` 接受 `activeForm` 作为进行中的显示文本，`taskId` 作为稳定 key |
| cache write | `turnUsage` 读 `cacheCreationInputTokens` 填 `cacheWriteTokens`；Codex 不报时保持缺省，不写 0 |
| 新 item 类型 | `taskNotification` → 系统提示行；`terminalInteraction` → 并入对应 `commandExecution` 的输出；`sessionPeerMessage` → 带发件线程的消息行；`worktreeSessionEntered|Exited` → 状态提示（会话 cwd 不随之改变，只提示） |
| 信任 | app-server 与 TUI 都复用 `codexTrustArgs` 提供目录信任，不跳过 hook 审核。CLI 对精确 hook 定义的哈希保存信任；新增或修改后重新提示。TUI 的「Hooks need review」由 `TerminalDialogObserver` 转成网页卡片，回答仍通过 CLI 自身的按键完成。traex 的选项与说明文字缩进相同，`interaction-choice.ts` 因此只向上收编号行。审核弹窗只挡 TUI 画面，不挡网页发起的回合 |

---

## 4. traex 独有能力

只接 riffet 已经有落点的；协议形状都已从 `generate-json-schema --experimental` 导出确认。

### 4.1 一期就要的

- **排队位置**：`queue/status { state, position, message, turnId }` → `NativeStatus.notice`（如「TRAE 网关排队中，第 335 位」）。
  调研时默认模型 `openrouter-4o` 排在第 335 位，一个简单回合等了几分钟都没有输出；不显示这个，用户只会看到
  「卡住了」。
- **模型回退**：`model/fallback`（`attemptStarted` … `committed` / `exhausted`）与 `model/loopDetectedRecovering`
  → 同一个 notice 通道，`committed` 时更新会话当前模型。
- **上下文环**：运行时容量取 `thread/tokenUsage/updated` 中的 `tokenUsage.modelContextWindow`；占用取同一通知的 `last` prompt 侧
  （`inputTokens + cachedInputTokens + cacheCreationInputTokens`）；分项调 `thread/contextUsage`，实测返回
  `systemPrompt / toolDefinitions / developerMessages / userMessages / assistantMessages` 五类，直接填
  `NativeContext.breakdown`（`packages/contracts/src/index.ts:160`）。只在回合结束和打开会话时各调一次，不轮询。

### 4.2 Plan 模式

- 能力：`modes: [{ id: 'default', label: 'Agent' }, { id: 'plan', label: 'Plan' }]`，`supportsModeSelection: true`。
  Codex flavor 保持现状（`codex/index.ts:363` 继续拒绝 mode）。
- 切换：`configure({ mode })` → `thread/settings/update { collaborationMode: { mode, settings: { model } } }`，
  更新后续回合的设置，不中断当前回合。实测切到 `plan` 后模型产出 `item/plan/delta`
  和 `plan` item，现有「Proposed plan」工具行（`:2130`）直接可用。
- 退出 Plan：`mode/changeRequested { requestId, targetMode, reason, allowedPrompts }` 是**通知**不是服务端请求，
  投影为一张 `transport: 'protocol'` 的交互卡（批准 / 拒绝），回答走 `mode/change/respond { decision }`，
  `mode/changeResolved` 关卡片。TUI 先回答时同样靠 `mode/changeResolved` 关闭网页卡片。

### 4.3 审批模式

以本机 TRAE CLI 0.211.1 的生成类型和隔离 app-server 探针为准。Riffet 保留原有会话 ID，显示 CLI 自己的档位名称：

| Riffet ID | 显示名称 | `approvalPolicy` | 请求 `approvalsReviewer` | `permissions.id` |
| --- | --- | --- | --- | --- |
| `on-request` | Workspace Edit | `on-request` | `user` | `:workspace` |
| `auto-review` | Auto Mode | `on-request` | `auto_review` | `:workspace` |
| `danger-full-access` | Full Access | `never` | `user` | `:danger-full-access` |
| `read-only` | Read Only | `on-request` | `user` | `:read-only` |

原生 Shift+Tab 循环前三档；Read Only 是另一个可用的原生权限配置。Auto Mode 的 reviewer 返回值会被规范化为
`guardian_subagent`，读取时同时识别它与 `auto_review`。切回其他档位必须显式传 `user`，否则会保留自动审查。
TRAE 的 `:workspace` 自带网络访问，不能用 Codex 默认关闭网络的 `workspaceWrite` 代替。

创建线程和明确切换审批时发送命名 `permissions`，不同时发送互斥的 `sandbox` / `sandboxPolicy`。
`thread/start`、`thread/resume` 的有效权限字段在响应顶层；`thread/settings/update` 的响应和
`thread/settings/updated` 通知放在 `threadSettings`。终端侧变更通过这些字段同步到会话，并递增配置版本。
旧服务器没有 `threadSettings` 响应字段时仍可处理。

显式切换期间也保留原生通知；同一请求等待期间若终端再次切换，以最新观察到的权限作为有效配置返回并持久化。
恢复线程的旧响应和发送回执同样不能覆盖较新的通知。派发前在最后一次异步读取之后取当前审批，使持久 fence 与实际请求一致。

普通发送和只改模型、协作模式时沿用实际 native 权限，保留附加可写目录和自定义限制。恢复现有线程时同样不隐式
替换权限；离线时明确选择的新审批通过现有 `configPending` 保存，应用成功后清除，避免恢复时被旧 native 状态覆盖。
没有命名 profile 的兼容响应只有完整匹配原生 sandbox 时才识别为内置档位。

隔离探针使用临时 `TRAE_HOME` / `TRAECLI_HOME` 和本机返回错误的 HTTP provider，验证了创建、设置更新、
通知、`turn/start` 和恢复回读，没有请求外部模型。`config.permission_mode` 在此环境确实能设置初始原生档位；
运行中的切换使用已验证的 `thread/settings/update`。

### 4.4 后续再议

| 能力 | 协议 | 前提 |
| --- | --- | --- |
| 撤销最后 N 轮 | `thread/rollback { numTurns }`（实测可用） | riffet 先有「编辑并重发」或「撤销」入口 |
| 旁路提问 | `turn/btw` + `turn/btw/delta` | 需要一个不进正文的临时答复面板 |
| 后台回合 / 子 Agent 控制 | `turn/moveToBackground`、`thread/agent/close`、`thread/agent/transitionToBackground` | 先验证 traex 子 Agent 与 `collabAgentToolCall` 的实际形状 |
| Workflow、memory dream、worktree 会话 | `workflow/*`、`memory/dream`、`thread/worktreeSession/*` | 均为 traex 的 under-development 特性，不追 |

`turn/removePendingInput` 不需要：riffet 的排队消息在派发前就留在 riffet 侧。

---

## 5. 降级矩阵

| 情况 | 行为 |
| --- | --- |
| 探测缺 ws 相关能力，或第 3 步自检发现 loopback 不要求 token | app-server 改走 Unix socket，`supportsTerminal: false`，其余功能照常 |
| `thread/contextUsage` 失败 | 环只画整条，不画分项（与 DSH 的规则相同） |
| `thread.path` 缺失且按 `stateHome` 扫不到 | 统计与计划回放按「不可用」显示，不报错 |
| 网关排队 / 回退 | 只出 notice，不影响 run 状态机 |

---

## 6. 改动面

服务端：

- `backends/codex/index.ts`：flavor 化；`commandIdOf`、steer 回执与认领队列、错误正则、`thread.path`、
  `commandActions`、cache write、新 item 类型、`queue/status` / `model/fallback` / `mode/*`、上下文分项。
- `backends/codex/flavors.ts`（新）：`codexFlavor`、`traexFlavor` 与各自的 `probe`。
- `backends/shared/codex-app-server.ts`：ws 传输、横幅解析、`/readyz`、鉴权自检。
- `backends/codex/rollout-records.ts`（新）：`history_mutation` 展开；`rollout-plan.ts` 改为消费它。`rollout-usage.ts` 只读 `event_msg`，不需要改。
- `backends/codex/endpoint.ts`（原 `terminal/codex-endpoint.ts`）、`terminal/service.ts`：识别 traex，校验 ws 端点与监听进程。
- `backends/service.ts:926`、`app.ts`（注册）、`settings/index.ts`、`stats/query.ts`、`store.ts`：后端 id 名单。

契约：`NATIVE_BACKEND_IDS` 加 `traex`（`packages/contracts/src/index.ts:3`）。

Web / 手机：后端名单与标签，照 Droid 那次的落点（`apps/web/src/lib/backends.ts`、`Sidebar.tsx`、
`BackendProfilesSection.tsx`、`stats/FilterBar.tsx`、`stats-query.ts`、`stats-series.ts`；手机
`Models.kt`、`RiffetApi.kt`、`StatsMath.kt`、`SessionDetailsPane.kt`、`BackendsSection.kt`、`StatsCharts.kt`）。

脚本：`scripts/probe-traex-e2e.ts`，经完整服务端驱动真实 traex，作为 traex 升级后的回归检查。

---

## 7. 分期与验收

| 期 | 内容 | 验收 |
| --- | --- | --- |
| 一 | flavor 化 + §3.3 全部差异 + §4.1；传输先用 Unix socket，`supportsTerminal: false` | Codex 测试全绿；traex 网页端发消息、流式、审批、提问、中途追加、切模型 / 权限 / effort、冷启动读历史、统计、上下文环、排队提示全部可用 |
| 二 | §3.2 ws 传输与原生 TUI 面板 | 三向可见（TUI 显示历史、网页回合进 TUI、TUI 回合进网页）；riffet 重启后 TUI 与 app-server 都保留并重新接上；无 token / 错 token 401；伪造监听者时不发送 token |
| 三 | §4.2 Plan 模式 | 网页切 Plan → 产出计划 → 退出请求卡片 → 批准后进入执行；TUI 侧回答时网页卡片关闭 |

每期单测随差异点补齐：`commandIdOf`、steer 认领（同文本两次、乱序）、错误正则、`history_mutation` 的
`append` / `replace`、Task 工具计划回放、`commandActions` 投影、端点校验（ws 与监听进程）。

---

## 8. 风险与未验证项

- **协议漂移**：traex 频繁自动更新（`~/.trae/cli/log/traex-auto-update.log`），而其稳定版 schema 已经漏掉过
  `thread/turns/list`。回归脚本后续可以同时比对 `generate-json-schema --experimental` 的方法与通知
  名单，新增或消失时提示。
- **hook 耗时**：用户装的 hook 在 traex 里同样运行（实测一个做记忆同步的 SessionStart hook 跑了两分钟以上），
  `hook/started` / `hook/completed` 应进状态提示，否则又是一段「看起来卡住」。
- **未实测**：traex 子 Agent（`collabAgentToolCall` / `subAgentActivity`）的实际字段；图片输入；`auto` 权限 preset；
  rollout 里 `replace` 在压缩与回滚时各自的语义；`turn/start` 带 `collaborationMode` 与 `thread/settings/update` 的优先级；
  Windows。

---

## 附录：调研用的探测

脚本在 `/tmp/traex-probe/`，均以 riffet 的 `ws` 依赖直连 app-server：

| 脚本 | 覆盖 |
| --- | --- |
| `probe.mjs` | 基本握手、模型目录、线程生命周期、一次完整回合（`MODEL=gpt-5.5`） |
| `probe-ws.mjs` | loopback ws + token 鉴权（401 / 通过）、tmux 里的 TUI 接入与三向可见 |
| `probe-daemon.mjs` | 共享 daemon 与 `daemon_auto_start` TUI 不共享 runtime |
| `probe-home.mjs` | `TRAE_HOME` / `TRAECLI_HOME` / `CODEX_HOME` 的作用与 `thread.path` |
| `probe-features.mjs` | `userMessageId` 回显、`thread/contextUsage`、Plan 模式、`thread/rollback` |
| `probe-approval.mjs` | 命令审批往返 |
| `probe-steer.mjs` | `turn/steer` 回执形状与被 steer 消息的 id |
| `probe-tools.mjs` | 两种 harness 的工具 item 与计划条目形状 |

---

## 9. 实现记录（2026-10-12）

与上文方案不同、或方案没写到的地方：

- **端口与凭据**：端口由 riffet 预先挑选，`stdio` 保持 `ignore`；凭据不进 `Session`，恢复时从监听进程 argv 取（§3.2）。
- **消息 id 加前缀**：发给 traex 的是 `userMessageId = "riffet-<commandId>"`，回显时只认这个前缀，TUI 里输入的
  `msg_…` 不会被当成 riffet 的 run。
- **中途追加**：dispatch 层本来就把运行中再发的消息排进 riffet 自己的队列，上一轮结束才发，所以网页端平时走不到
  `turn/steer`。这是 2026-10-12 时普通发送的行为；2026-10-16 增加独立引导入口，见 §11。旧普通发送的回执兼容与按正文认领不承担严格引导的输入确认。
- **状态去重**：`setStatus` 原先用 `JSON.stringify` 判断变化，两条路径以不同键序构造同一个状态时，每 1.5 秒的轮询
  会成对重发。有提示文案（排队、hook）时这很明显，现改为按键排序后比较。
- **内置工具在历史里变形**：实时通知里 `commandActions[].input` 是 `{ type: 'builtin', name, arguments }`，
  `thread/turns/list` 返回的同一个 item 却退化成 `{ type: 'shell', command: ['Read'] }`。识别规则因此补了一条：
  `command` 是单个首字母大写的词，且与 `commandActions[0].command` 相同。参数取不到时用 `path` 补成 `file_path`。
- **正在驱动的回合不按历史里的 interrupted 结算**：真实 E2E 里首轮出现过刚发出 9ms 就被记成「已中断」，而 traex
  那一轮其实还在跑。历史读取恰好落在回合已开始、rollout 还没写 `task_started` 的窗口里，traex 会把这一轮报成
  `interrupted`。本客户端仍在派发或线程仍真实 active 时，不把这一历史副本当作中断完成；
  `completed`/`failed` 照旧采信。真正的中断优先由实时 `turn/completed` 结算；2026-10-31 增加同目标
  interrupted 历史与已验证 owner 的 idle / systemError 回读恢复，见 §14。
- **TUI 自己的计划确认**：Plan 模式结束后，traex TUI 会画「Implement this plan?」，由 `TerminalDialogObserver`
  转成 plan 卡片。协议层的 `mode/changeRequested` 只在模型主动调用切换模式工具时才出现，两条路径并存。
- **代码审查后修掉的四处**：
  - 预选端口在释放后、子进程绑定前可能被别人抢走。现在先用 `lsof` 确认监听者就是刚起的子进程（或者在它的进程组里），
    才发 token。每次重试都换新 token。匿名自检只认明确的 401/403，连接失败不再算作鉴权生效。
    主机上没法确认监听者时（例如没有 `lsof`），退回 Unix socket，并且不接 TUI。
  - token 原先经 `tmux new-session -e KEY=VALUE` 传入，会出现在 tmux 客户端的 argv 里。现改走 `secretEnv`（见 §3.2 第 5 步）。
  - 一个回合只结算一次：先到的终态为准。在 `turn/completed` 之前发起、之后才返回的历史读取，不能再把已完成的 run 改成已中断。
  - `turn/steer` 失败时删掉它的认领项，免得之后 TUI 里同样文本的消息被算到这个失败的 run 上。
- **未做**：§4.3 全部，以及 `auto` 权限 preset。traex 子 Agent 沿用 Codex 的 `collabAgentToolCall` 路径，尚未用真实
  traex 子 Agent 验证。

## 10. 回合进行中的位置 item id（2026-10-13）

首次真实会话里「回答显示两遍」的原因，是 §2.2 最后一行那个差异。会话 `01a1343c` 只有一个 run（库里一条 run 记录），
CLI 的 rollout 里也只有一条 `msg_4`，所以重复出在 riffet 这一侧：同一批 item 被投影了两次。

复现和判据（对同一个 app-server 用 `thread/turns/list`，`itemsView: full`）：

| 时刻 | 回合状态 | 同一个回合返回的 item |
| --- | --- | --- |
| 回合跑着、已经完成前几个 item | `inProgress` | `userMessage:riffet-…`、`reasoning:item-1`、`agentMessage:item-2` |
| 回合结束约 0.4 秒后 | `completed` | 同一批 item，id 变成 `reasoning:rs_14`、`agentMessage:msg_13` |

同时抓到的实时通知（`item/started`、`item/reasoning/textDelta`、`item/completed`）自始至终用长期 id（`rs_71` / `msg_70`）。
也就是说：位置 id 只出现在「回合还没落盘」的历史读取里，而 riffet 每 1.5 秒轮询一次历史，正好会读到它。两套 id 各投影
一行，`seenEvents` / nativeId 去重对不上，于是回答和它的推理各显示两遍。附带的证据是本机 50 个 rollout 里 1432 个 item
id 没有一个是 `item-<数字>` 形状（`msg_` / `rs_` / `fc_` / `fco_` / `tei_` / `ctc_` / `riffet-`），所以这个形状可以
直接当作「位置 id」的判据。

最初的 runtime 处理（`backends/codex/runtime.ts`、`transcript.ts` 的 `isProvisionalItemId`）：

- 位置 id 的 item 只在「这个回合还没有正式副本」时投影：同一回合里已有同类同文本的行，就跳过它。工具行不参与比较
  （同一个回合里重复跑同一条命令是正常的）。
- 本次读取新加的位置行按回合记下来；下一次读取如果看到这个回合的 item 都换成长期 id（`renamed`）或某个正式副本的
  文本与它相同，就把这些行从转录里删掉，并清掉它们的 `seenEvents` / 序号占用。所以中途接上（riffet 重启、刷新页面）
  仍能看到正在跑的回合已经产出的内容，正式副本到达时由正式副本替代，而不是并列。
- 位置 id 的形状是 traex 特有的，Codex 不受影响；子 Agent 的转录每次整体重建，本来就不会累积。

当前 sync v3 实现在 `transcript-source.ts`：位置行、永久行的一对一关联随现有 cursor 持久化，同一批提交前也移除
已退休的位置行。`completed` / `failed` / `interrupted` 仍含位置 ID 时，保留回读边界及关联，等永久副本写入后再记录
journal 的结束标记，避免重启后留下重复内容或在结束标记之后补写正文。工具不按命令内容匹配：只有位置 ID 的工具及
子 Agent lane 等待实时通知或历史提供永久 ID 后发布，因此仅历史可见的临时工具会稍晚显示。

**验证**：`tsc --noEmit`；全量 vitest 1286 项通过，其中 `index.test.ts` 的 `TRAE CLI flavor` 新增两项
（位置行不重复、位置行被正式副本替代）。另外在 `/tmp` 起了独立的 riffet（`--state-dir` 另开、端口 4399）驱动真实
traex 跑完整回合：修复前快照里是 `rs_7:thinking` + `msg_6:assistant` 与 `item-1:thinking` + `item-2:assistant` 各一行，
修复后只剩 4 行（用户、推理、回答、run_completed）；订阅 `/api/sessions/:id/native/stream` 重跑一轮，位置行没有再进过
任何一帧。

## 11. 专用会话引导（2026-10-16）

CLI 里的 `Send after tool call` 对应工具边界引导：当前工具完成后，让同一活动回合接收补充消息。`Esc to interrupt and send` 是独立的中断发送动作；不能据后者反推前者也是中断。此前关闭的是 Riffet 的专用接入入口，不是 TRAE CLI 缺少该能力。

当前 0.210.1 导出的 `TurnSteerParams` 要求 `threadId + expectedTurnId + input`，不匹配的活动目标会拒绝，回执是 `{ turnId }`。该方法没有 `userMessageId/clientUserMessageId`，但输入的 `text_elements` 元数据在真实通知、历史与 rollout 中完整保留。因此复用 Codex runtime 的专用 `steer()`，在原正文上携带唯一 commandId 的零长度元素，并按同一原生目标、完整正文及持久 fence 精确认领。原文、技能和附件继续沿现有输入处理，接口不带模型、权限或模式覆盖，也不回退到 `turn/start`。

CLI 可执行文件和实际连接的 app-server 都要求至少 0.210.1；后者从 `initialize.userAgent` 获取，防止 CLI 已升级但活动进程仍是旧版本。`--version` 的 `installation: internal` 尾行不能覆盖实际版本。未知或较旧进程保持关闭，不为开放入口重启原任务。

默认仍为排队。用户在“设置 → 交互与输入”中选择引导后，原发送按钮只对具备能力和可写活动目标的会话使用该接口；队列已有消息的显式引导沿用同一能力条件。没有新增独立常驻按钮或修改图标。

最终零长度实现已通过真实 CLI 协议、本地模型桩驱动的 Riffet HTTP 和原生 TUI 验证：同 turn、稳定 owner、唯一回执、工具执行一次、重试不重复投递、旧目标 409，TUI 正文保留且内部标记不显示。另使用真实 TRAE 网关和 DeepSeek-V4-Flash 完成原生同回合改变回答的验证；该次使用全正文 span，后续零长度的真实模型尝试未取得完整成功，因此没有把模型桩 HTTP 检查描述为真实网关全链路。完整证据、失败边界及临时目录见 [STEER.md](STEER.md)。

## 12. Standard / Max 上下文模式（2026-10-16）

TRAE CLI 的 Max 是同一模型的后端变体，不是新模型，也不是 Codex 的 Fast 服务等级。`model/list` 的每个分页条目中，只有 `businessMetadata.variants.standard_key` 和 `max_key` 都为非空字符串时，Riffet 才为该模型发布 `id: context`、`category: model_config` 的选择项，值分别是 `standard` 和 `max`。Web、macOS 与移动端复用已有的上下文开关；Codex 不发布或发送这项 TRAE 专属配置。

选项名称来自同一 metadata 的 `standard_context_window` / `max_context_window`，例如 `Standard · 200K`、`Max · 1M`；缺少有效数字时只显示 `Standard` / `Max`。不根据模型名、固定模型清单或 `effective_context_window_percent` 推算标称容量。实际上下文环继续以 CLI 的用量通知为准：本次实测标称 200K / 1M 对应运行时 190K / 950K，CLI 已扣除余量，Riffet 不重复打折。

模型选择沿用现有序列化格式，例如 `openrouter-4o[context=max]`。创建与恢复线程通过 `thread/start` / `thread/resume` 的 `config.model_backend_variant` 传值；发送与切换通过 `turn/start` / `thread/settings/update` 的 `modelBackendVariant` 传值，均使用原生 `standard` / `max` 字面量。选中明确模型但没有 `context` 参数时发送 `standard`，这样从 Max 模型切到不提供 Max 的模型时，旧变体会被清除。显式传入其他上下文值会返回 `INVALID_NATIVE_MODEL`，不会悄悄切成另一模式。

已连接的线程直接调用 `thread/settings/update`，传递模型、变体、思考强度与 Agent/Plan 模式，只有明确切换审批时才替换权限。新线程在首轮之前可能尚未生成 rollout；此时先调用 `thread/resume` 会返回 `no rollout found`，不能把恢复历史作为修改当前线程设置的前置条件。忙碌线程的更新用于后续回合，不中断当前回合。

选择 Agent/Plan 时，`collaborationMode.settings.reasoning_effort` 与顶层 `effort` 一起传递；原生模式设置会覆盖顶层思考强度，省略此字段会把已选的强度清空。真实 CLI 0.210.1 的隔离 runtime 验证已确认 Max 创建、Standard / Max / 无 Max 模型切换、思考强度设置与清除、Plan 及只读权限均正确生效；该验证没有发起模型回合。

思考强度仍使用目录现有的 `supportedReasoningEfforts` / `defaultReasoningEffort`。本次实测的九个 Max 模型，两种变体的思考选项相同；协议允许按变体分别声明选项，若后续出现差异，需要再扩展按变体切换思考目录的逻辑。

## 13. 运行时钩子（2026-10-22）

插件可以通过运行时钩子给 traex 的原生进程挂一个附属进程（例如模型请求代理），见 [PLUGIN_ARCHITECTURE.md](PLUGIN_ARCHITECTURE.md) 的 `runtimeHooks`。原生 app-server 继续负责登录、上下文、工具、审批和原生 TUI；Riffet 不转换模型协议，也不替附属进程重新提交用户消息。附属进程要在会话里显示状态或提供操作时，通过通用的 `NativeStatus.runtimeControl` 与 `POST /api/sessions/:id/native/runtime-control`，核心不解释其含义。没有插件提供钩子时，traex 按原样启动，不出现会话控件。

钩子只作用于新启动的原生进程：`prepare` 返回的 `launchEnv` 并入启动环境，失败时进程照常直连启动。已有直连原生进程继续使用原端点，重新启动该 backend 后才接入；不能为挂接附属进程中断活动回合。附属进程的身份写入会话的 `nativeRuntime.attachment`（`{ hook: <插件 id>, id }`）；服务重启后，只有同一会话、profile 指纹与原生端点下，由同一插件 `recover`。退出 Riffet 只断开控制，显式结束原生 backend 后回收。

## 14. 前台回合与后台活动分离（2026-10-31）

本次现场的 TRAE CLI 0.207.1 两个前台回合均已 `completed`，但 `thread/read.status` 仍为
`{ type: "active", activeFlags: [] }`；`thread/backgroundTerminals/list` 只列出预览 shell `52007`。
因此 TRAE 的线程级 `active` 是聚合活动证据，不等于前台回合仍在执行。Codex 原来的线程级 `active` → busy 语义保留。

- **前台结束**：实时 `turn/completed`，或最新历史回合的 `completed` / `failed`，可以确认前台已结束；原生 TUI
  回合没有 Riffet command / run 映射也有效。不以回答正文或 `final_answer` phase 推断结束。TRAE 前台明确结束且
  没有更新的前台执行或在途派发时保持 idle，后台终端和子 Agent 仍独立保留运行态。
- **读取边界**：只从最新回合判断新活动。已观察到的前台结束是按回合 ID 的边界，旧 `inProgress` 副本不能复活它，
  停在更旧回合的读取也不能把边界退回。`turn/started` 清除旧的结束观察；异步读取的状态、目标和结束观察 fence，
  加上在途派发保护，阻止旧读取清除新目标。仅当前 `activeTurnId` 自己的终态可清除该目标，窗口遗漏它不是结束证据。
- **中断恢复**：仍在执行的最新回合可能在 rollout 尚未跟上时读成 `interrupted`。真实线程 active 时保留 busy；
  同目标的 interrupted 历史加上已验证 owner 的 idle / systemError 回读，才能恢复漏掉的中断完成并清理旧目标。
  快速结束先于 `turn/start` 回执时，回执只补归属，不恢复活动回合；下一条普通消息走新 `turn/start`。
- **后台终端**：官方 `CommandExecutionStatus` 包含 `backgrounded`。现场预览命令返回这个状态并带 `exitCode: 0`，
  该 0 是工具返回的合成值，不是进程退出。显式 backgrounded 加上一次列出即确认后台活动；普通 Codex completed
  且无 exitCode 的命令仍需第二次列出确认。只有真实终态命令的退出码，或终端从列表消失，才结束进程活动。
  停止仍复用幂等请求与 ActivityLedger 的首终态保护，迟到的 running / backgrounded 副本不能撤销 stopped。
- **子 Agent**：实时终态绑定当前子回合边界。同一回合的旧运行副本不能复活它；按历史顺序越过边界的新回合、
  或不同的实时 follow-up claim，可以开始新的工作。最新回合结束时，更旧的 inProgress 回合不影响其收敛。

验证复用现有服务端协议、转录来源、服务 watch 与 dispatch 核心测试，覆盖上述后台状态的两种到达顺序、TUI 结束、
遗漏完成的恢复、旧读取与新 started 的竞态以及子 Agent 边界。未部署、重启或操作现场任务。

## 15. 模式与权限交互恢复（2026-10-31）

本节记录首次模式/权限修复的依据：现场版本 **TRAE CLI 0.207.1** 的官方实验生成类型、隔离 stdio app-server 和
localhost Responses 桩，与前文较新版本的历史验收分开。本节的 direct 回合由本地脚本返回，不是外部模型全链路验收；
后续整体 review 修复与用户授权的真实 DeepSeek V4.1 Flash 验证见 §16。

### 15.1 模式不是普通审批回执

- `mode/changeRequested` 是通知。回答发送 `mode/change/respond { threadId, requestId, decision }`，decision 是
  `approved | rejected | cancelled`；只有匹配 thread、turn、request、target 和有效 decision 的 `mode/changeResolved`
  才确认处理。provider 的 decision 与提交选择不一致时撤卡，但回执保留 `uncertain`，不谎报选择生效。
- 实际协作模式来自 `thread/resume.collaborationMode`、settings 响应或 `thread/settings/updated` 的
  `threadSettings.collaborationMode.mode`，以及匹配的 approved resolution。`thread/read` 不返回该设置，不能用它恢复模式。
  重复同值的有效观察同样建立异步读边界，但不是 provider 事件版本号：候选提交前刷新基线，提交后设置与 resolution
  顺序有歧义时用无 override 的 settings-update 读回实际值；下一条发送等待读回。configure 返回实际观察值，避免旧 intent
  覆盖原生终端在请求期间作出的更新。
- 隔离 direct 桩在 `--session-source cli` 和 `vscode` 下都观察到：Enter requested 后自动工具返回，无 Enter resolved，
  客户端答复 Enter 得到 NoPending；Exit 则等待答复，依次发出 resolved、turn/completed，之后 RPC 才成功。
  两个序列均无 settings/updated 通知。因此不能仅切换 source，或把 requested.targetMode 当作实际设置来修复。
- NoPending 的真实错误为 `-32600`，message 包含 `No pending mode change found for request_id:`，无 error.data、无 resolved。
  同码也用于配置错误，所以必须同时匹配明确消息。该请求失效后撤销本地 pending、发布当前交互及 warning，回执是
  `uncertain` 而非 `completed`。回合结束本身也不能确认 mode decision；超时/断线不解开已发送候选的重复副作用保护。
- 未知 target 不映射成退出 Plan，也不提供 Web 批准动作，保留 native terminal 落点；allowedPrompts 同时显示 tool 与 prompt，
  不能只显示 prompt 而隐去授权工具。

### 15.2 权限识别与回答范围

- 命名内置 profile 只有 `modifications: []` 才可识别为预设；附加可写目录、未知或不完整 profile 均不冒认为 Workspace Edit。
  实际状态显示 `custom`，会话仍保留有效配置意图作为继承边界；普通发送不因此重置自定义 native 权限。
- 命令审批仅提供 `availableDecisions` 实际允许的动作；缺省/null 兼容旧默认，显式空或非法列表不扩大授权。
  execpolicy / network amendment 使用原生完整对象回传，显示记忆规则影响；展示完整命令/argv、cwd、grantRoot 和权限范围。
  额外权限响应省略顶层 null 字段，不把空字段当作有效授权。
- `requestUserInput` 按 `multiSelect`、`isOther` 校验选项与文本，拒绝未知/重复选项和单选多答案。
  `isSecret` 问题不通过普通 Web 文本输入/草稿收集，回退原生终端。可识别的秘密回答投影为 `[REDACTED]`，
  混合回复只要含秘密，相关投影全部省略 event.raw，防其他答案的 raw 副本泄漏它。
- 终端卡只补协议缺口。在 session fence 内重新检查当前协议请求和 driver endorsement，失效 screen 不按键、不转交协议驱动。
  已有终端回执先按原幂等键重放，即使 screen 已消失也不产生第二次按键；同键不同答案仍拒绝。
- GET、POST 回执与 SSE 走同一交互状态入口，旧 GET 或 POST 不能覆盖较新请求；completed 只清除实际提交的 revision。
  fence 按完整交互内容变化推进，而不是把重复同内容的重连 hello 当作新请求；相同 id/revision 下权限范围等字段变化仍会建立边界。
  thread、generation 变化和 reset 同样使旧回执失效。回执被 fence 拒绝而旧卡仍可见时不把卡冻结为 success，保留同步恢复入口。
  终端答复后的缓存刷新显式发布 status，避免下一轮观察因缓存已更新而漏掉撤卡通知；刷新失败仍不能假定屏幕消失。
  GET 仍读到同一 protocol id/revision 不代表 uncertain 回答未发送，不能据此解冻并允许新副作用。

### 15.3 验证边界

首次修复的核心验证复用现有协议、转录、终端路由和同步测试，不添加 UI 展示测试。当时 direct 桩仅验证上述原生事件顺序，
没有把它外推为 `code-mode-nested` 验收；后续已取得真实嵌套协议与 Riffet API 证据，见 §16。
秘密脱敏依赖同 call id 的原问题 metadata 或明确 isSecret 回复字段；输出-only 历史、任意原生正文和终端日志无法保证全量脱敏。
首次验证未操作现场审批或后台预览。之后按用户请求构建并重启 Riffet，原 native daemon 和持久终端保留；本轮追加修复未自动
部署或重启生产，源码改动未提交。

## 16. 整体 review 修复与真实模型验收（2026-10-31）

用户明确授权用真实 TRAE CLI 持续验证，模型固定 **DeepSeek V4.1 Flash**。本机 `model/list` 和 `debug models` 确认
目录/configName 为 `deepseek-v4.1-flash`，CLI selector 为 `DeepSeek-V4.1-Flash`，provider 为 `trae`，harness 为
`claudecode / claude_legacy / deferred_code_mode`；`prompt_model_id: claude-opus-5` 是 harness 元数据，不是改用了另一模型。

### 16.1 本轮追加修复

- 前台结束 fence 落出三回合 routine window 时针对性补读到边界，使用原生历史顺序恢复漏通知的新回合；恢复后回到三回合轮询，
  不把窗口遗漏 fence 当成永久 idle，也不每轮全量回放。普通发送在最后一个 preparation await 后选择当前 turn/start；显式 steer
  仍拒绝失效的用户目标。可靠历史终态完成 interruption waiter，unknown/active provisional interrupted 不伪造停止确认。
- 父历史终态恢复 unreadable child 时同时绑定原生执行边界。旧终态重复不能改绑新的 C2 执行，也不能在随后读取故障时结束 C2；
  新 live claim 和可证明的新历史 turn 使旧证据失效。
- 已知子 Agent 的请求按精确 child thread 归属路由，交互 requestId 以 thread scope 隔离，但 native RPC id 和 thread/turn 目标不改写。
  子 Agent 的模式、权限、用量和正文不采纳为父线程状态；子回合完成与取消只清理对应 child 的交互和 interruption waiter。
  live child 新 turn 即使已 running 也建立读取 fence，防旧回合在途终态覆盖它；重复同 turn start 不重新打开已结束执行。
  新目标尚未出现在旧/空历史窗口时，保留运行与现有转录，不发布空 reset；只有对应终态或可证明的有序新执行边界才收敛。
- 仅已知、首次运行 child 的明确 empty-rollout 使用最多 60 秒 materialization grace；精确 child flush-not-found 先重试同页，
  头部才允许回退实际非空 committed legacy history。父/foreign、其他错误、无法转换的 opaque cursor 与持久历史丢失仍报错，
  空 legacy 不伪装成历史恢复。
- observer resume 同样采纳真实顶层 collaborationMode/model；未显式选模型时，mode-only configure 使用原生默认模型。
  candidate 提交前已有的同值 settings 不压过其后 approved resolution；提交后无 provider 版本的歧义用当前 settings 读回裁决。
- 多题初始 revision 为 `<RPC id>:0`，随后 `<RPC id>:1…`，包括 id=0/1 都不会让旧题卡回答下一题。已发送候选的新答案同样先验证，
  非法选项/表单不落 receipt，不产生第二次 native 回答。MCP form 使用已安装的 Zod 验证公开 schema 子集、required/enum/oneOf/
  items 及约束， unsupported schema 明确 native fallback；decline/cancel 不受阻。
- 秘密 metadata 不依赖 question/header 文案非空。完整回复的 IDE 包装、多 text part、image/localImage、skill/mention 仍识别秘密，
  相关 item 的所有 raw 副本剔除；保留非答案普通文本和附件。known-child 原生请求按 thread+call/question 身份记住秘密元数据，
  独立 v3 转录源在每次 main/child page 投影前取得 metadata-only 副本，包括请求先于 reader 建立的情况；不复制答案或 run 状态。
  因此原问题暂未写入 history、仅有对应工具结果时，也不会因元数据传递缺口将已知秘密写入 journal 正文。
  不从无身份的任意原生正文猜测秘密；未采样真实秘密输入，使用合成 canary 验证脱敏与线程隔离。
- 终端每次 keys/paste 前重核 driver protocol/status、绑定与 endorsement，包括异步取得 control 后；未按键时拒绝 stale，已部分修改
  时返回 uncertain 并幂等重放，停止继续按键。
- Web 同一 canonical Agent 共用摘要水位；alias 改绑不同 Agent 时不覆盖旧 Agent 或继承其历史。raw upserts 与 hydration 使用同一
  thread/generation 门禁，reset 后 panel 订阅随当前 alias/lane 重绑定。Kotlin 用独立 interaction observation fence，内容/ABA/thread/
  generation/reset 都能拒绝旧 GET/POST，但不使现有 stream epoch/dial 失效；拒收 completed 时不把仍可见卡片冻结为 success。

### 16.2 已取得的真实协议与 API 证据

验证使用自有 app-server/Riffet 状态目录、临时 git 工作区与独立 HOME/TRAE_HOME/TRAECLI_HOME。仅将已有单份 auth.json 复制为
0600 私有副本供 CLI 使用，结束后删除；原文件哈希不变。不连接现有生产 daemon、不答复用户原会话的审批、不停止已有后台预览。
模型 fallback、插件、记忆、搜索和自动更新在自有配置中关闭。协议证据及脚本仅留在临时目录，不作为永久 UI 测试。

- 真实 `code-mode-nested` Enter 自动返回且 respond NoPending；Exit 等待答复，native `mode/changeResolved approved` 可先于 RPC。
  Exit 原 exec 结果文本 `Script error: mode change approved` 不是拒绝。隔离 Riffet API 实际收到两种 mode 卡，过期 Enter 回执 uncertain，
  Exit approved completed，重试重放原 receipt，最终 Session.mode=default。
- mode-only configure 在 Session.model 省略时实际将原生默认 DeepSeek 切到 Plan；独立 Riffet 重启后复用同地址、同 native PID，
  observer resume 恢复 Plan，无新模型回合或隐式重新选择默认模型。
- 真实 command approval 的 availableDecisions 为 accept、execpolicy amendment、cancel，不存在的 deny/session grant 没有伪造。
  read-only 下单次批准后实际写入并回读自有标记文件，重复 HTTP requestId 没有第二次 native 副作用。
- 真实双题 requestUserInput 经 Riffet 展示两种 revision，单选 advanced 后多选 completed，真实模型回显选中答案。
- 真实后台 sleep25：原 main completed 时 phase=idle、native background processIds 非空且 activity.background=1；后台自然结束后
  CLI 发出全新的 task-notification turn，正确暂时 busy。等待该新回合自然 completed 后最终 idle、无 active target、background=0。
  首次探针在通知新回合仍 busy 时进入清理并 interrupt 自有 turn，不计为自然终态通过；追加探针才完成收敛。
- 真实后台子 Agent 的 command approval 经父会话 Riffet API 展示为 scoped child 请求，批准 completed、同幂等键重试重放，
  原生回答目标仍为 child thread/turn。最终父线程 idle，child running=false/completed；数据库复核确认 child 的 `REAL_CHILD_DONE`
  正文及完成 cursor 已持久化，父线程也保留 `REAL_MAIN_DONE` 与通知回合的 `REAL_CHILD_NOTICE`。
  首次 API 验收在 child materialization 和完成卸载时各触发一次 retryable `TRANSCRIPT_READ_FAILED`，之后自动退避读取成功。
  追加窄恢复后的真实验收仍观察到 empty-rollout 两次、flush-not-found 五次，但该次客户端 error frame 为零；main/child 正文、
  ready/settled cursor 均已落库且无 open。进一步拒收空 legacy 的最终整合验收仍可能出现 retryable 读取提示，不把未恢复的
  provider 错误改成空成功。最终整合探针确有一个 retryable error frame，随后 main/child 均恢复 ready/settled、无 open，
  child 的 `REAL_CHILD_DONE` 与 main 两条正文仍在 journal/timeline；不承诺整个运行期间没有短暂错误提示。

临时证据索引：`/tmp/riffet-trae-real-evidence-huygens{,-summary}.json`；Riffet API 成功报告包括
`/tmp/riffet-real-trae-integration-Ld2Ou8/report.json`（两轮 Plan/权限与重启）、`…-bq6OVw/report.json`（后台及自然通知终态）、
`…-awsQP6/report.json`（真实双题）、`…-acgbBJ/report.json`、`…-nrkaf0/report.json` 与 `…-3iJIRl/report.json`（真实后台子 Agent
审批、窄恢复与自然终态）。child 持久化复核见
`/tmp/riffet-lifecycle-review.jGDDF4/{real-child-recovery-evidence,frozen-real-child-evidence,final-real-child-evidence}.json`。
主 API 探针共显式提交八个 turn/start（包含不计自然终态成功的首次后台探针）；子回合和自动通知回合另算。用量通知数不是上游
HTTP 调用次数，不据此推算模型重试数量。

### 16.3 验证边界

协议故障恢复与并发核心通过现有测试及最小代表性回归验证；临时反例反向验收涵盖三回合 fence、准备后 target、历史 interruption、
child 新旧执行边界、alias 改绑、panel reset、空问题 secret 和候选前校验。Kotlin 已执行 JVM 编译及 36 项指定的现有核心
state/sync/交互测试；最终整合运行 14 个服务端/Web 核心测试文件、356 项通过，根 TypeScript 检查与 diff 检查通过。
临时生命周期反向验收 11 项通过；子秘密的已连接/晚建 source 原反例均已反向验收，跨 thread/call 公开答案保留。
Web、share 与服务端在临时目录构建通过，仍有既有 CSS highlight、chunk-size 和混合导入警告。
本轮不新增 UI 展示测试，不重复所有平台构建；未自动部署本轮追加修复，也未重启生产 Riffet 或原生 daemon。
真实 command/file approval 已采样；额外权限 grant 与 MCP schema 目前主要由官方类型、隔离协议及核心测试验证，不能假称每种外部
MCP 服务和全部权限组合均已真实模型端到端覆盖。部分原生 Read 工具在嵌套隔离环境中的路径视图仍不一致；本轮通过获批命令的
实际写入和回读验证文件副作用，不外推为全部 Read 工具形状通过。原生终端任意文本、无 metadata 的历史仍不能承诺全量秘密脱敏。

## 17. 模型身份与额度

TRAE CLI 的 `model/list` 同时报告稳定的 `id` / `configName` 和当前的 `model` / `displayName`。模型的
显示名可能随时间改变而 `id` 不变。Riffet 保留当前 selector，并把 provider 声明的旧身份放进
`ModelInfo.aliases`；模型选择、参数恢复和实时状态使用同一身份关联，避免目录缓存中的旧名字漏掉负载或额度。
dispatch fence 的实际配置记录解析后的 selector，并保留模型参数；接受请求时的选择快照不改写。

周额度与 0.213.1 新增的每日软额度分开表达。`ModelStatus.quota` 仍是原来的周额度，`quotaLimited=true` 且没有
snapshot 表示额度暂不可用，周额度金额维持旧客户端使用的整数协议。`dailyQuotaKey` 来自原生目录声明的每日额度键，`dailyQuota` 保留余额小数和重置窗口；
没有明确绑定时不根据 GPT 型号推测额度包。每日软额度耗尽表示请求优先级降低，排队通知的
`modelQuotaLowPriority` 也表达这一原因，不把它解释为模型已不可使用。

额度由原生 CLI 的额度接口提供。运行时钩子挂接了请求代理时，代理应把它作为辅助 API 原样转发到上游网关，保留原生认证与
查询内容。诊断时应明确区分直连和 `TRAE_API_BASE_URL` 指向的代理：代理本地返回的
`404 invalid_path` 不能归因于上游网关。协议和额度读取验证不等于完整模型回合 E2E，验证版本标记按实际覆盖更新。

0.213.1 在 `TRAE_API_BASE_URL` 指向会话代理时可以返回每日额度包，但 `model/list` 的每日绑定仍为空。额度查询因此复用
既有短生 transport，启动同 profile 的独立只读 CLI；不借用 live runtime 的代理注入，并保留正常 profile/global 配置。
服务端仍使用既有 30 秒合并缓存，不重启旧会话，也不按模型名补造绑定。

本轮实测 0.213.1 的 Riffet adapter 读到 20 个模型、OpenRouter 共享周额度 300，以及 `gpt_56_sol` / `gpt_6` / `gpt_6_1`
三个明确每日绑定，各上限 58；每日余额小数、重置时间及 `openrouter-4o` → `Orange-O55` 身份关联均保留。代理的真实额度
POST 返回成功，独立只读 CLI 在查询结束后关闭，原凭据文件未改变。本轮未执行完整模型回合，因此全量 `testedThrough` 仍为 0.211.1。

## 18. 0.217.0 升级验证

0.217.0 在 macOS 的首次启动曾超过帮助探测的 5 秒时限。Riffet 只重试超时的命令，再次超时时单独报告，下一次探测可重新运行。
该版本通过回环模型服务录制回复和 Bash 场景，并从 0.213.1 的持久历史续聊，原生线程、首轮及条目 id 保留。
鉴权 WebSocket、Plan 切换和当前回合的严格追加均通过。追加到过期回合会被拒绝，接受的追加仍可从历史读回输入标记。
额度仍以用户实际使用的 TRAE 模型源验证。
