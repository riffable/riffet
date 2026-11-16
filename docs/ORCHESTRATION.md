# Riffet 审阅发布与会话编排

日期：2026-10-17。状态：服务端能力、API 与 Web 界面已接入。交互探索稿保留在 [design/orchestration-demo.html](design/orchestration-demo.html)，实际行为以本文和当前界面为准。

这一组能力补齐「agent 写完之后」的工作流：把审阅意见交回 agent、发布改动、按回合回退、分叉或交接会话、多个后端并行尝试同一任务，以及模板与自动化。实现复用已有的 Git 服务、worktree 项目、检查点、原生提交（`createNativeSubmission` / `acceptNativeRun`）与调度器，没有新增依赖；并行尝试保存在设置键 `orchestration:attempt-groups`，自动化与运行记录存在 SQLite（见 §5）。

## 1. 审阅与发布

| API | 作用 |
| --- | --- |
| `POST /api/sessions/:id/review` | `{commandId, comments:[{path, line?, endLine?, quote?, body}], note?}`，把逐行意见整理成一条普通消息发给该会话，沿用会话当前模型与模式 |
| `GET /api/projects/:id/git/branch` | 当前分支、upstream、ahead/behind |
| `POST /api/projects/:id/git/push` | `{remote?}`，首次推送设置 upstream；从不强推 |
| `GET /api/projects/:id/git/pull-request` | 当前分支的 PR 与 CI 检查汇总；没有 PR 时 `pullRequest: null` |
| `POST /api/projects/:id/git/pull-request` | `{title?, body?, base?, draft?, remote?}`，需要时先推送；无标题时用 `gh pr create --fill` |
| `POST /api/projects/:id/worktree/merge` | `{strategy?: merge\|squash, message?, commitPending?, removeWorktree?}`，把 worktree 项目合回来源项目 |

- 审阅意见是一条普通发送而不是新通道：任何后端都能接收，也进入时间线、搜索和幂等重试。
- PR 与 CI 通过本机 `gh` 及其登录账号完成。`gh` 缺失或未登录返回 `GH_UNAVAILABLE`，其它失败返回 `GH_OPERATION_FAILED`；进程以非交互环境运行，不会卡在凭证提示上。
- 合并写入的是用户正在使用的检出，因此只接受干净结果：目标有已跟踪改动时拒绝（`MERGE_TARGET_DIRTY`）；worktree 有未提交改动时，只有给出 `commitPending` 才自动提交，否则 `WORKTREE_DIRTY`；冲突时立即中止并返回 `MERGE_CONFLICT` 及冲突路径，恢复失败明确报错。已有 merge/rebase 等操作、目标被忽略文件可能被覆盖、子项目范围外文件可能被自动提交时均拒绝。squash 后分支保留，作为逐个提交的记录；`removeWorktree` 删除目录后对应项目自动归档。

## 2. 按回合检查点、回退与分叉

- 每个原生回合（斜杠命令除外）开始前，调度器调用 `beforeTurn` 钩子自动建立检查点，记录 `sessionId` 与 `runId`。同一回合只尝试采集一次，重试或服务重启不会改写起点。钩子最多等待 10 秒，失败或超时不阻塞回合；超时或取消后才完成的检查点会自行删除。每个项目保留最近 50 个回合检查点。
- `GET /api/sessions/:id/checkpoints`：该会话的回合检查点，最新在前。回退沿用已有的 `/api/projects/:id/checkpoints/:checkpointId/changes`（预览）与 `/restore`（带 `expectedChanges` 校验），不另设接口。
- `POST /api/sessions/:id/fork`：`{clientSessionId, commandId, runId?, target?, isolate?, note?}`。新会话以一份简报开始（各回合的请求、回复结尾与动过的文件和命令、当前 Git 状态，约 24k 字符，超出时先丢最早的回合）。`runId` 截止到指定回合，`target` 换后端/模型，`isolate` 在新 worktree 中继续。
- 分叉从不回退代码。撤销某个回合的改动是检查点恢复，单独预览、单独确认，分叉不会悄悄改文件。
- 恢复检查点、合并和采纳尝试会预留对应工作目录及其中的子项目；已有活动回合时拒绝操作。预留期间新接收的普通消息保留在队列中，文件操作完成后才执行。外部终端中的 Git 命令和人工文件写入不受服务内预留机制管理。
- 上下文以文本摘要传递，而不是复制各后端的原生会话文件：六个后端的会话格式互不兼容，摘要是唯一通用的形式。

## 3. 多后端并行尝试

| API | 作用 |
| --- | --- |
| `POST /api/projects/:id/attempts` | `{prompt, targets:[LaunchTarget×2–4], base?, requestId?}`；同一后端可用不同模型重复 |
| `GET /api/projects/:id/attempts` | 该项目的尝试组，最新在前（全局保留最近 100 组） |
| `GET /api/attempts/:id` | 各尝试的会话状态与相对公共起点的改动统计 |
| `POST /api/attempts/:id/attempts` | `{target}`，向未采纳的组追加一个尝试（同起点、同提示词，含已丢弃至多 4 个在册） |
| `POST /api/attempts/:id/discard` | `{sessionId, removeWorktree?}`，归档该尝试的会话并标记 `discardedAt`；worktree 仅在不丢失未提交改动时删除，否则保留其项目并在 `warnings` 说明 |
| `POST /api/attempts/:id/adopt` | `{sessionId, strategy?, message?, commitPending?, removeWorktree?, cleanup?}`，把选中的尝试合回来源项目；`cleanup` 为 `keep`（默认）/ `archive` / `remove`，决定其余尝试的去留，客户端默认 `remove` |

- 每个尝试是从同一提交切出的 worktree 项目加一个会话。所有目标先校验完再创建任何东西，选错后端不会留下半组 worktree；相同 `requestId` 的并发重试返回同一组，中途失败后只补齐剩余尝试。复用 `requestId` 修改项目、提示词、目标或起点会被拒绝。
- 不在 Git 仓库里的目录也能并行尝试：服务在 `<stateDir>/shadow-repos/` 为它建一个私有裸仓库，以该目录为工作树，把磁盘上的当前内容提交为起点（遵循目录自己的 `.gitignore`，另排除 `node_modules/` 等依赖与缓存目录，超过 20000 个文件时拒绝）。目录里不写入 `.git`，状态、改动面板和检查点仍视它为非仓库。这类目录不接受 `base`；采纳前先把目录的最新内容再提交一次，再三方合并，期间的人工修改不会被覆盖，冲突时整体放弃。
- 项目里未提交的改动不在起点内，响应的 `warnings` 会说明。
- 采纳走与 worktree 合并相同的安全规则；仍在运行的尝试不能采纳。失败重试由客户端组合「追加 + 丢弃旧尝试」完成，不另设接口。
- 客户端（Web 与 macOS 同构）：发起后进入尝试组对比页（卡片为默认视图，文件矩阵在其次），会话顶部条只作组进度入口；项目首页列出该项目的尝试组历史。

## 4. 会话交接

在同一检出里由所选后端接手，分两步。目标可以是来源会话的同一个后端：新会话只带交接摘要，等于用同一 Agent 重置上下文；客户端默认仍选另一个后端，同后端只是可选项。

| API | 作用 |
| --- | --- |
| `POST /api/sessions/:id/handoff/draft` | `{target, goal?}`，返回 `HandoffDraft {text, generatedBy?, fallbackReason?}`，供用户编辑；客户端断开时停止生成 |
| `POST /api/sessions/:id/handoff` | `{clientSessionId, commandId, target, text?, note?}`；给了 `text` 就原样作为新会话的第一条消息，否则由服务端写简报并附上 `note` |

- 草稿由辅助模型里的「交接摘要」模型（`auxiliaryModels.handoff`）写：服务端直连该模型所在 profile 的网关，与来源会话用的模型无关，后者正是交接时可能已不可用的那个。模型读到的材料比简报详细得多（约 15 万字符）：逐轮的用户原文、各轮全部回复与工具调用、带增删行数的改动文件，放不下时从最早的轮次开始压缩。输出按固定分节：目标与约束、已完成与结论、关键决策、未完成与待处理、关键文件。
- 没有设置该模型、或模型失败时，草稿退回确定性的简报（与分叉相同），失败原因放在 `fallbackReason`。交接从不依赖模型成功。
- 来源本身是交接或分叉出来的会话时，它第一条消息里的上一份简报单独保留（首尾各留一部分），不会因为是最早的一轮被先丢掉。简报中每轮的回复保留结尾，并列出该轮动过的文件和命令。
- 来源会话必须空闲（两个 agent 同时改一棵树正是要避免的情况），草稿和交接时都检查。交接后来源会话记录 `handedOffTo`，新会话记录 `origin: {kind: 'handoff', sessionId}`，客户端可以据此互相跳转。

## 5. 自动化（Automation）

模板、定时计划和 agent 的一次性唤醒是同一种记录 `Automation`（`packages/contracts`）：做什么（提示词、`LaunchTarget`、项目、`isolate`）、何时自己运行（`triggers`）、每次运行去哪（`delivery` 或 `followUp`）。没有触发器的就是过去的模板，只能手动运行。

- 触发器：`{kind: 'once', at, timeZone?}` 只运行一次；`{kind: 'cron', cron, timeZone}` 按创建者的 IANA 时区重复，与服务器所在时区无关（Riffet 可以部署在任意服务器上）。每条最多 4 个触发器，下次时间取最早的一个。有触发器时必须有 `projectId`。
- cron 为五段格式（分 时 日 月 周），支持 `*`、范围、列表、步长和 `@hourly`/`@daily`/`@weekly`/`@monthly`。日与周都不以 `*` 开头时任一匹配即运行；任一以 `*` 开头（包括 `*/2`）时两者都需匹配，遵循 [Cronie 的 Vixie cron 兼容规则](https://github.com/cronie-crond/cronie/blob/master/src/cron.c)。夏令时跳过的时刻不运行，重复的时刻只运行一次。解析器在本地实现，没有新增依赖。
- `delivery`：`new` 每次开新会话（`origin: {kind: 'automation', automationId}`）；`same` 在上次运行的会话里继续，那个会话归档、交接或删除后再开新会话。`{{date}}`、`{{project}}` 在运行时按触发器的时区填入，没有时区时用服务器时区。
- `followUp: {sessionId, by}` 是某个会话的后续：只有一个 `once` 触发器，不能编辑或手动运行，运行时是该会话里的一轮，不会开新会话，会话不可用时记为失败。`by: 'agent'` 来自 `schedule_wakeup`，消息带唤醒说明，`commandId` 为 `wakeup-<id>`；`by: 'user'` 是输入框的「稍后发送」（设置 `composerSendLater` 打开后才显示），原样发送 `prompt` 与 `input` 里的附件、文件引用和会话引用，`commandId` 为 `follow-up-<id>`；会话引用在安排时冻结，附件在运行前不会被清理。运行过或取消的后续不再出现在列表里，保留 7 天供 `list_wakeups` 查看后删除；删除 agent 后续等同取消。上限沿用唤醒：每会话 20 个待运行、全部 500 个、agent 最远 30 天。其他自动化最多 250 个。
- 调度：到期记录先写入下一次时间再启动，同一时间点最多运行一次。上一次的会话仍在运行时本次记为 `skipped`（`reason: 'busy'`），不排队。停机错过的时间点：`catchUp: 'latest'`（自动化默认）在 7 天内补跑最近一次，`skip`（后续默认）超过 1 小时记为 `missed`。项目不可用记为 `skipped`（`reason: 'project-unavailable'`）；后续的会话不可用记为 `failed`（`reason: 'session-unavailable'`）。已经到点的用户后续不能再取消（409）。
- 运行记录 `AutomationRun` 存在 SQLite，每条自动化保留最近 50 次；`lastRunAt`、`lastResult`、`lastSessionId`、`lastError` 是最近一次的摘要。后续失败或错过时仍写入会话通知（`NoticeLog`）。
- 0.7 之前保存在设置键 `orchestration:templates`、`orchestration:schedules`、`orchestration:wakeups` 的数据在启动时迁移一次：未被计划引用的模板成为手动自动化；每个计划连同它的模板内容成为一条自动化，时区取服务器本地时区；唤醒保留原 id 成为 agent 后续。

| 接口 | 说明 |
|---|---|
| `GET /api/automations` | 当前客户端可见的全部自动化，包括后续。项目不存在时照常返回 |
| `POST /api/automations` | `{name, prompt, target?, projectId?, isolate?, triggers?, delivery?, catchUp?, enabled?}`；或 `{id?, prompt, followUp: {sessionId}, triggers: [{kind: 'once', at}], attachments?, context?, references?}` 建一条用户后续，后三项与发送消息的请求相同；`id` 由客户端生成，同一 `id` 重试返回第一次建的那条，内容不同返回 409 |
| `PATCH /api/automations/:id` / `DELETE /api/automations/:id` | 部分更新 / 删除 |
| `POST /api/automations/:id/run` | `{projectId?, clientSessionId?, commandId?}` 立即运行一次，不改变下次时间；没有 `projectId` 的自动化必须给出。返回 `AutomationRun` |
| `GET /api/automations/:id/runs`、`GET /api/automation-runs?limit=` | 一条 / 全部可见自动化的运行记录，新的在前 |
| `GET /api/sessions/:id/wakeups`、`POST .../wakeups/:wakeupId/cancel` | agent 后续的 `RiffetWakeup` 视图，供 MCP 与设备预约 |

Agent 通过 Riffet MCP 的 `schedule_wakeup` 给当前会话安排后续，通过 `schedule_task` 在当前项目建自动化（沿用当前会话的后端、模型、模式与审批，记录 `createdBySessionId`；重复间隔至少 15 分钟，每个会话最多 10 条，由自动化开出的会话不能再建）。工具说明要求先向用户复述时间。

## 会话来源

由编排创建的会话带 `origin`：`{kind: 'fork' | 'handoff' | 'attempt' | 'automation', sessionId?, runId?, groupId?, automationId?}`；0.7 之前的会话可能带 `template` / `schedule` 与对应 id。所有启动接口以 `clientSessionId + commandId` 幂等，重试返回第一次创建的会话与 run。

## 验证

核心测试覆盖本地 bare remote 的推送范围、worktree 合并与冲突恢复、文件操作的工作区预留、同回合检查点幂等、启动取消、编排并发重试、交接与分叉摘要；自动化覆盖旧数据迁移（含唤醒 id）、带时区与夏令时的 cron、错过后补跑与跳过、后续只发送一次。其余能力以类型检查和现有 app/store/dispatch 测试回归为主。真实 GitHub 发布和原生 CLI 交互仍需在对应环境中验证。
