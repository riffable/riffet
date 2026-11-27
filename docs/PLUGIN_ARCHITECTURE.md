# Riffet 插件架构

Riffet 插件可以提供模型源、分享目标、Agent 后端、视图、命令、任务和外观资源。内置插件、本地开发包和独立安装包使用同一套声明与生命周期接口，宿主按来源及版本安装记录决定执行位置和权限。各 Agent 自身的 Skills、MCP 和插件配置由 [扩展管理](EXTENSIONS.md) 管理。开发与安装方法见 [插件开发指南](PLUGINS.md)。

## 命名与兼容

源码统一使用 Plugin：服务端 SDK 为 `@riffet/plugin-api`，内置插件在 `plugins/`，注册表为 `PluginRegistry`，管理契约在 `packages/contracts/src/plugin-management.ts`。源码目录和内置资源产物 `dist/plugins/` 与用户状态目录分别管理。

以下旧名称是现有兼容契约，重命名不改变其值：

- HTTP 路由 `/api/integrations` 及其子路由，列表响应字段 `integrations`。
- 协议特性 `integrations-v1`、SSE 事件 `integrations` 和已有 `INTEGRATION_*` / `INTEGRATIONS_*` 错误码。
- doctor 诊断 ID `integration:<id>`、Web 缓存键 `riffet.integrations.v1:`、设置页身份 `integrations`，以及已有插件和声明 ID。

本次命名调整不改变 manifest、消息桥或子进程协议，`apiVersion` 仍为 1。引用旧 SDK 源码的开发包需将导入改为 `@riffet/plugin-api`，更新 `Plugin`、`PluginManifest`、`PluginHost` 与 `PLUGIN_API_VERSION` 等符号后重新构建；已经打包并自带依赖的安装包无需因重命名重新安装。安装包与版本记录保持原位；本地设置与插件业务数据按下面的规则迁移。

### 本地存储迁移

配置使用 `<stateDir>/plugins.json`，插件业务数据和数据版本备份使用 `<stateDir>/plugin-data/`。已安装包仍在 `<stateDir>/plugins/<id>/<version>/`。

首次启动新服务时，在创建业务服务之前将 `integrations.json` 原子重命名为 `plugins.json`，再将整个 `integrations/` 目录原子重命名为 `plugin-data/`。配置内容、密钥、文件权限和备份随原文件保留。两个移动之间中断时，下次启动完成剩余移动；完成后运行代码只使用新路径。

迁移前检查两个目标。任一新旧路径同时存在、旧路径类型不符或为符号链接时，迁移报错并保留两边，处理冲突后再启动。迁移复用服务状态锁：离线插件命令和 doctor 可以迁移，但不会移动另一运行中服务的数据。Cursor 的 hook 和配置备份仍定位到服务根目录，不跟随插件数据目录移动。

旧版本不认识新路径。需要降级时先停止服务，确认旧目标不存在，再将这两个路径移回；不要同时运行读写两套路径的版本。

## 目录

```
packages/plugin-api/src/index.ts   插件可用的全部接口（@riffet/plugin-api）
packages/contracts/src/plugins.ts       静态声明（视图、命令）、声明 ID 规则
plugins/index.ts                   内置插件清单，按优先级排列
plugins/riffet/<name>/             随应用构建的插件（cursor、antigravity、canvas、browser、avatars、translate）
official/<name>/                   官方的可选插件，不随应用构建，发布到公共插件源（android、appearance-paper）
examples/plugins/<name>/           最小样例，发布到公共插件源
<外部插件仓库>/<name>/           独立分发的插件，每个目录一个 manifest
apps/server/src/plugins/           注册与生命周期、声明校验、本地开发包、存储与路由
```

服务端插件只能导入 `@riffet/plugin-api`（含子路径）、`@contracts`、Node 内置模块、package.json 中的依赖，以及本包目录（`plugins/<vendor>/<name>/`、`official/<name>/`）下的文件，不含同一 `<vendor>` 下其他包的文件；外部模型源作为独立包构建。客户端入口（`plugins/<vendor>/<name>/web/**`）只能导入 `@riffet/plugin-web`、`@contracts`、package.json 中的依赖和本包内的文件。核心只有 `apps/server/src/plugins/registry.ts` 导入 `plugins/index.ts`，Web 一侧只有 `apps/web/src/plugins/registry.ts` 导入 `plugins/web.ts`，所以替换这一处即可得到不含插件的构建。`pnpm check:plugins`（CI 同样执行）检查这些边界。

## 对外构建

`RIFFET_EXCLUDED_VENDORS=acme pnpm build` 在打包时用一份生成的清单替换 `plugins/index.ts` 的入口：被排除厂商的模块不会进入 bundle，外部插件及其附属进程均不再由应用构建。多个厂商用逗号分隔；主仓库内置的插件都在 `plugins/riffet/` 下，清单见 `plugins/index.ts`。

构建后运行 `pnpm check:public-artifacts` 扫描 `dist/`，命中被排除厂商的标识、内部域名或对应的 source map 路径即失败。`RIFFET_ARTIFACT_DENYLIST` 可以补充要拒绝的字符串（逗号分隔，按正则转义后的字面量匹配）。

## 接口与版本

一个插件导出 `Plugin`：`manifest`（`id` 为 `<vendor>.<name>`、`vendor`、`name`、`apiVersion`、`defaultEnabled`、可选 `settings`）、可选 `detect(host)`，以及 `activate(host, scope)` 返回的 `Contributions`（可以是 Promise）：

用词：`Contributions` 的每个字段是一个**扩展点**，`activate` 返回的是插件对这些扩展点的**实现**；manifest 的 `contributes`（类型 `PluginDeclarations`）是**静态声明**，其中每一项的 ID（`<插件 id>/<名称>`）叫**声明 ID**。

| 扩展点 | 作用 |
| --- | --- |
| `modelSources` | 档案可选的模型源：默认地址、凭据（静态 key 或命令）、请求头、模型目录。`id` 即档案里保存的 `modelSource`。`protocols` 声明所提供的网关协议（`anthropic-messages`、`openai-responses`、`openai-chat`，开放字符串），解析结果在 `endpoints` 里按协议给出 `baseUrl` 与 `headers`，目录由 `catalog(backend, overrides, protocol)` 按协议返回（`backend` 是该协议的旧名字，只有前两种协议有；读标准目录可用 `host.gateway.fetchModels({ protocol })`）；Agent 在 traits 里声明 `consumesProtocols`，源与后端按协议交集匹配，与 Agent ID 无关。只设 `backends`（`claude`、`codex`）、`claudeBaseUrl`、`codexBaseUrl`、`headers` 的源照常工作，映射见 `kit/gateway.ts`；描述符同时带 `protocols` 与按它计算的 `backends`。`overridable` 声明档案可覆盖的地址或 Key，`loginAction` 指向本插件的登录操作，`hint` 是编辑档案时的提示；客户端只按这些字段渲染，不认识具体模型源。驱动只读解析结果（`ResolvedSource`），凭据类型决定注入方式：静态 key 走 Riffet 的 key 通道，命令交给 CLI 每次调用（Claude Code 的 `apiKeyHelper`、Codex 的 `auth.command`） |
| `sharePublisher` | 会话分享的发布目标。分享记录发布它的插件 id，之后核对、更新、取消总是找这个插件；它未启用时返回 409 `SHARE_PUBLISHER_UNAVAILABLE`。新分享用默认发布目标（见下），没有发布目标时只能生成本地预览 |
| `runtimeHooks` | 绑定到某个后端原生进程的附属进程，例如模型请求代理；每个后端至多一个。身份以 `{ hook: <插件 id>, id }` 存在会话的 `nativeRuntime.attachment`，服务重启后交回同一插件恢复。附件可选提供会话控件：`control({ model })` 同步返回提示（`neutral` / `progress` / `danger`，文案为 `LocalizedText`）和更多菜单里的操作，宿主加上 `owner` 作为 `NativeStatus.runtimeControl` 下发，各端照原样显示；`onChange()` 通知宿主重读。客户端经 `POST /api/sessions/:id/native/runtime-control`（`{ action, revision }`）把操作交回 `act()`；`revision` 过期时插件以 `RUNTIME_CONTROL_CHANGED` 拒绝 |
| `taskProviders` | 项目任务：识别项目、列出操作、构造命令、解析日志。由宿主运行任务，见 [TASKS.md](TASKS.md)；`id` 须在 manifest 的 `contributes.tasks` 中声明 |
| `agentBackends` | 实验性。Agent 后端（`AgentBackend`，见 `packages/plugin-api/src/agent.ts`）：探测、档案、会话打开与恢复、发送、停止、交互响应、历史与事件观察。插件只拿到受限的异步 `AgentHost`，没有 store、Fastify 和终端服务；commandId、排队、投递记录、journal 与会话归属留在核心。`id` 须在 `contributes.agentBackends` 声明：官方 `riffet` 插件可用内置 ID（Cursor 仍是 `cursor`），其余只能是 `<插件 ID>` 或 `<插件 ID>.<名称>`（小写、至多 64 字符，见下「Agent 身份」）。启用时注册、停用时撤销：新会话与新投递返回 503 `NATIVE_BACKEND_UNAVAILABLE` 并带原因，历史与 journal 照常可读，运行中的原生进程只断开观察、不被终止 |
| `avatarStyles` | 个人资料的随机头像风格（[OWNER.md](OWNER.md)「随机头像」）：`generate({ seed, size, ink, paper, name? })` 返回 SVG，同样的参数必须得到同样的图；`id` 须在 `contributes.avatarStyles` 声明，`needsName` 的风格才会收到昵称。核心校验 SVG 后栅格化并存储，插件的输出不会原样交给客户端 |
| `agentTools` | 经 Riffet MCP 交给 Agent 的工具组（[BROWSER.md](BROWSER.md) §2）：`{ tools, call(context, name, args) }`，键是 `contributes.agentTools` 声明的组 ID，工具名须以声明的 `toolPrefix` 开头。会话在「技能与工具」里选了这个组（`toolGroups`）才注入；插件关闭时调用得 `TOOL_NOT_AVAILABLE`。只给进程内的包 |
| `channels` | 每个会话一条 WebSocket，`PLUGIN_CHANNEL_ROUTE(pluginId, name)?sessionId=`，键是 `contributes.channels` 声明的 ID。宿主核对登录、会话和插件开启后调用 `open(context, socket)`；插件关闭或登录被撤销时断开。只给进程内的包 |
| `imChannels` | IM 平台（[通道方案](design/channels.md)「插件化」）：`ImChannelProvider`，键是 `contributes.imChannels` 声明的 ID，也是这个平台账号的 `ChannelKind`。核心通道层负责账号、门禁、绑定、会话跟随与持久化，调用 `connect(account, context)` 拿到连接，再经连接渲染回合卡与交互卡；插件不碰会话。插件开启时核心为它的已启用账号建连，关闭或换代时断开，账号与绑定保留。只给进程内的包 |
| `page` | 插件自己的页（见下「插件详情」）：`read({ locale })` 返回分组和条目，`run(context, action, item?)` 处理按钮。`contributes.page` 声明它（可带页签名 `title`）。独立包也能提供：页面是数据，经子进程协议的 `page.read` / `page.run` 传回 |
| `actions` | 设置页里的操作；`device-flow` 类操作由服务端保管设备码，客户端只拿到 flowId |
| `status`、`doctorChecks` | 设置页状态与 `riffet doctor` 检查项 |

模型源还可声明 `role: "adapter"`，表示给提供商已存的 API 连接增加网关适配；未声明或 `"source"` 仍是连接与登录来源。客户端分别放在「网关类型」和「接入方式」，均复用 `modelSource`、`resolve/catalog/usage`。`usage: true` 可在 manifest 中静态声明，按需插件尚未激活时也能展示额度入口。普通 API 与 adapter 互换保留档案、连接与模型；未保存的模型探测只在地址相同且两端均为 API/adapter 时沿用已存 Key，切换独立来源、跨地址或显式清空不复用。额度读取失败与模型请求分开处理。适配器停用或卸载后，档案若有自己的地址，就按普通 API 连接继续使用，只是没有额度；连接来源仍报不可用。插件设置视图可声明 `settingsCategory: "agent" | "providers"` 来区分两个设置入口，未声明时保留旧视图的可达性。

插件需要的核心能力只经 `PluginHost` 取得：子进程、CLI 定位、网关模型目录、私有状态目录（`<stateDir>/plugin-data/<id>/`）、密钥、刷新模型目录、`AppError`；声明了 `agentTools` 或 `channels` 的进程内插件另有 `sessions`（读会话与项目目录、往会话发一轮、发通知）。进程内插件另有 `models.complete`：做一次单轮补全，插件不保管密钥。带 `use` 时用用户为这项模型用途选的模型（见下「模型用途」），不带时用「快速对话」的默认模型（`auxiliaryModels.chat`）；都在每次调用时读取。没有可用模型时以 409 `PLUGIN_MODEL_NOT_CHOSEN` 拒绝，`maxOutputTokens` 至多 16000，超时缺省 60 秒、至多 120 秒，输出因长度截断时报错。插件交给它的文本会发给该模型的提供商；隔离安装的包没有这一项。

`PLUGIN_API_VERSION` 是宿主提供的插件 API 版本，当前为 1，只做可加性变更：新增可选成员不升版本，任何会让既有插件出错的改动都要升版本。`PLUGIN_API_MIN_VERSION`（当前为 1）是宿主仍然加载的最旧版本。manifest 的 `apiVersion` 落在 [`PLUGIN_API_MIN_VERSION`, `PLUGIN_API_VERSION`] 内即被接受，区间之外的插件不会加载，在插件管理页和 doctor 中显示原因：比宿主新的写明宿主最高提供的版本，比下限旧的写明宿主不再加载该版本。提高下限是唯一的破坏性步骤，与新增版本分开进行。区间判断集中在 `apiVersionProblem`（`packages/plugin-api/src/manifest.ts`），注册表、安装和打包共用。`hostApi.server` 仍是对 `PLUGIN_API_VERSION` 求值的 semver 范围，与此区间无关。

可加性由发布基线检查：`packages/plugin-api/released/<版本>/`（`@riffet/plugin-web` 的桥协议在 `packages/plugin-web/released/<版本>/`）是该 SDK 版本发布时根入口生成的 `.d.ts`，对 `@riffet/contracts` 的引用不动（契约有自己的快照）。`src/released-compat.ts` 在 `pnpm typecheck` 内逐项比较，不另设 CI 步骤，分两个方向：宿主提供给插件的类型（`PluginHost`、各 `*Context` 等），当前类型必须可赋给基线类型，即宿主仍给出承诺过的全部成员；插件提供给宿主的类型（`Plugin`、`Contributions`、`ModelSourceProvider` 等），基线类型必须可赋给当前类型，即新成员只能是可选的。`PluginHost.runProcess`、`resolveCli`、`secrets`、`gateway.fetchModels` 等常用方法另按参数和返回值逐一比较，因为方法简写的参数是双变的。拟议成员不在承诺内，由 `PROPOSED_CONTRIBUTIONS`（`agentBackends`、`runtimeHooks`、`services`、`channels`、`agentTools`、`speechRecognizer`、`imChannels`、`approvals`）和 `PROPOSED_HOST_MEMBERS`（`agentProfiles`、`services`、`sessions`、`approvals`、`agents`）两份清单排除：它们只给进程内的包（内置、开发、受信任安装），不升 API 版本也可能变化，出现第二个独立使用方后再纳入承诺。桥协议按方法比较：旧视图的参数仍被接受、结果仍是旧视图所期望的，已发布的方法和事件不得消失。升 SDK 版本时运行 `pnpm gen:plugin-api` 写入新版本的基线；`pnpm gen:plugin-api:check` 只确认当前版本有基线，不会重写已发布版本。

入口与稳定性：

| 入口 | 内容 | 稳定性 |
| --- | --- | --- |
| `@riffet/plugin-api` | 插件接口：manifest 类型、`Plugin`、`PluginHost`、`Contributions` 及各扩展点的接口 | 同一 API 版本内只做可加性变更 |
| `@riffet/plugin-api/kit` | 与核心共用的工具包 | 供官方包使用，不承诺兼容 |
| `@riffet/plugin-api/experimental/agent` | Agent 协议 | 实验性 |
| `@riffet/plugin-api/manifest`、`/tooling`、`/package-files`、`/schema` | manifest 校验、构建与打包、包文件、JSON Schema | 工具 |

已安装的包自带构建时的 SDK，不受入口拆分影响；包在下次升级 SDK 归档时再改导入。

## Agent 协议

`AgentBackend` 与 `AgentHost`（`packages/plugin-api/src/agent.ts`，经 `@riffet/plugin-api/experimental/agent` 导入，`AGENT_PROTOCOL_VERSION` 为 1，实验性，只做可加性变更）。Cursor 是第一个用它实现的官方插件（`plugins/riffet/cursor/`）；核心里没有 Cursor 的代码，只留兼容身份（`session-identity.ts`、`cursor-cli.json`、`AppSettings.cursorCli`、`/api/cursor/*`）。除上表的探测、会话、发送、历史外：

- 同步读 `host.view`：本 Agent 的会话、项目、终端、首条消息与某一轮的 run。`updateSession`、`setNativeSessionId`、`recordActivity` 在调用返回时即对 `view` 可见，promise 只报告失败。
- 状态补丁：`AgentSessionPatch` 另含 `state`、`error`，只有声明 `traits.ownsSessionObservation` 的后端可写，其余得 403 `AGENT_PATCH_REFUSED`。`observe(host, context, report)` 的 `report` 只发给当前订阅者（首次回放），`host.emit` 广播；`host.stats.observeEvents` 把读到的事件交给统计。
- 终端：`AgentLaunchSpec` 带 `kind`（`native`，或旧值 `cursor`）和 `reuseLive`（会话已有活终端则复用，并发启动合并）。`host.terminals` 另有 `interact`（独占读屏与按键）、`observe`、`panePid` 和预留池（`reserve`/`claim`/`extendReservation`/`reservations`/`releaseReservation`，`POST /api/native/prewarm` 驱动 `AgentBackend.prewarm`，同一请求续租；`POST /api/native/prewarm/release` 驱动 `releasePrewarm`，新会话已认领的不受影响）。`AgentBackend.terminal`（默认标题、就绪判断、启动失败提示）、`launchEnv`（交给 pane 与不许泄漏进 tmux 服务端的环境名）、`loginLaunch`（终端登录）。
- 对话框：`host.dialogs` 识别并应答终端上的信任、提问类对话框；`settledScreen` 判断应答后 Agent 是否已回到自己的提示符。
- 转录：除批量的 `transcript.read`，可实现 `transcriptSource`（`identity`/`pull`/`watch`/`drain`），写入 `AgentLaneWriter`（草稿、撤回、重投影、轮次起止、活动账本、子 Agent 车道、scratch 窗口），journal 直接承载；hook 驱动的写入走 `host.transcript.withSource`。
- 工具包：核心与插件共用的纯函数在 `packages/plugin-api/src/kit/`，经 `@riffet/plugin-api/kit` 导出，核心旧路径只留转出；`AppError` 是同一个类。
- 档案与配置：`describeProfile`（档案列表显示的实际启动值）、`validateProfileConfig`（保存前校验）、`projectConfigs`（项目配置文件）。`capabilityReport`、`runCommand`、`runtimeStats` 是 `/api/cursor/capabilities`、`/api/cursor/command`、`/api/native/runtime/stats` 的转发目标，没有驱动得 503，驱动没有该操作得 409。
- 其他可选成员：`usage`、`usageTranscript`、`canReleaseInput`、`canReleaseAfterLaterTurn`、`runtimeAction`、`stopActivity`、`extendInteraction`、`relaunchForAppearance`、`rename`、`invalidateModels`、`endorsesScreenDialog`、`status`，以及扩展管理（`extensionLayout`、`extensionRuntime`、`skillStates`、`setSkillEnabled`、`reloadExtensions`、`authorizeMcp`、`manageExtension`）。
- 登录状态：`AgentAvailability.needsLogin` 表示已安装但未登录，`/api/backends` 的条目带 `needsLogin`，客户端对任何后端显示同一个提示，不读 Agent 专有的能力报告。机器的 tmux 与 Tailscale 状态不属于某个 Agent：`GET /api/system/machine` 返回 `MachineReport`（`tmux`、`tailscale`、`warnings`、`checkedAt`），Agent 插件关闭时照常回答。

- 不可用：后端未注册（插件关闭或不在构建里）时，新会话、启动和上述转发返回 503 `NATIVE_BACKEND_UNAVAILABLE`，`details` 带 `backendId`，原因已知时带 `reason`；已排队的发送在派发时失败并写明原因；会话列表、历史和 journal 照常可读，原生进程与终端不被终止，后端回来后接着用。项目配置在没有后端保存它们时：列表为空，读、写、创建都是同一个 503（原因是哪个插件关着）。预热对关闭或不预热的后端先于工作区检查答 `skipped`/`backend_unsupported`。
- 启动与等待：服务启动时插件可能还在评估或激活（`refreshWithin` 只等 1.5 秒），此时它声明的 Agent 记为“将到”（`PluginRegistry.agentBackendPending`，激活本身受 30 秒超时约束，未评估的受 45 秒启动宽限约束），派发器不处理这个后端的排队发送，既不失败也不丢；激活失败或超时后按原因照常失败。`AgentBackend.start(host, profile)` 在后端注册后由核心调用一次（每次激活一次），用来启动无人使用时也要运行的东西（Cursor 的状态巡检）。
- 重新启用与撤销：后端被撤回时 `watchControl` 的读者（同步流、派发器）留在原处，后端回来时 `attachBackend` 把它们接到新驱动；插件的激活被释放（含 `dispose`）后，交给它的 `AgentHost` 被撤销，之后每次调用都得 `AGENT_HOST_REVOKED`，上一次激活遗留的定时器写不进任何东西。`host.stats.saveRunMetrics`、`isRunCancelled`、`recordUsage` 只认本 Agent 会话的 run，`readAttachment` 只认正在投递的输入里的附件，其余得 403 `AGENT_SESSION_FOREIGN`。

### 预热

新会话页显示一个 `supportsPrewarm` 的 Agent 时，为它的下一条新会话先起好进程，发送时交给新会话。Cursor 和 Claude Code 是预留终端里的 CLI，Codex 是已经建好新线程的 app-server。

- 分工：`WarmPool`（`@riffet/plugin-api/kit`）决定何时起、留多久、何时结束、交给谁；Agent 只提供怎么起（就绪才返回，被中止时收拾自己起的东西）、怎么结束、会话怎么接手。终端类的用 `reserveWarmTerminal`（预留终端，按输出驱动读屏判断就绪）和 `terminalWarmOptions`；核心内置的 Agent 经 `backends/shared/warm-terminals.ts` 拿到同样形状的预留终端。
- 请求：页面在显示选择 `PREWARM_BUDGET.startDelayMs` 后请求，每 `renewMs` 续租，关闭或改选时释放（`POST /api/native/prewarm`、`/release`）。同一页面的续租带 `claimId`，不会抢走别的页面的；内存紧张或工作区在恢复时只续租不新起（`memory_pressure`、`renew_only`）。
- 匹配：每个 Agent 至多一个，按键交出。键是 Agent 对一次启动的身份：项目、档案、模型、权限、终端配色，加上 Riffet MCP 的工具签名（`NativeRiffetMcpHost.signature`）和关掉的扩展。预热时会话还不存在，Riffet MCP 用临时凭据（`provisional`），工具按该项目从输入框新建的会话算；接手时凭据转给会话（`adopt`），文件路径不变，CLI 不用重启。Agent 解析后的键（规范化的模型名、实际工具签名）用 `alias` 补上。键不同的会话不拿，留给它的页面；还在启动的同键资源，会话最多等 `takeWaitMs`，过了就自己起。
- 结束：未续租满 `leaseMs`、释放、被别的配置替换、启动失败或 `readyTimeoutMs` 内未就绪即结束；失败的键退避 `failureBackoffMs`，期间答 `skipped` 和原因。空闲时进程自己退出的，Agent 调 `lost()`（`reserveWarmTerminal` 已代为观察），池立即放掉并按失败退避；接手失败也结束它，会话照常自己起。服务关闭时池结束自己的；上一个进程留下的预留终端由 `TerminalService.endPreviousWarmupsOnce` 在服务启动时统一结束，Agent 不各自清理。
- 接手：终端类经 `claimWarmup` 把终端和启动时的会话 id 记到会话上，runtime 按接管现成 CLI 的路径接手。Claude Code 的 hook 在接手前由 `ClaudeHookBridge.hold` 收着，SessionStart 交给之后注册这个 id 的 runtime（转录文件从它得知）；预热 CLI 的 hook owner 是它自己的首个会话 id；runtime 注册时把会话用过的每个 id（当前的和 `previousNativeSessionIds`）都登记为 owner，所以多次 `/clear` 后、服务重启并重新打开会话后，仍回到这个会话（与普通启动的 CLI 一样）。Codex 的 runtime 在既无线程也无进程时取预热的 app-server，首个线程就用预热建好的那个，模型或权限在此期间变了就另建。Codex 在首轮之前不写 rollout，没被用掉的线程不留记录。
- 统计：`WarmPool.stats()`（hits、misses、mismatched、ready、failed、skipped、wasted、readyMs）。会话来取时池里有一个、但键不同，记为 mismatched 并在服务日志写一行 `prewarm: a new session did not match the warm one`，带两边的键：偶尔出现是页面刚改了选择，持续出现就是两边算键的方式偏了，预热不再起作用。

## Agent 身份

`NativeBackendId` 是内置 ID（`NATIVE_BACKEND_IDS`）或插件 Agent ID（`PluginAgentId`，匹配 `PLUGIN_AGENT_ID`，至多 64 字符，等于所属插件 ID 或以 `<插件 ID>.` 开头；契约包的 `isNativeBackendId`、`isPluginAgentId`、`isAgentOfPlugin`）。内置 ID 不含点，两者不会冲突，且只有官方 `riffet` 插件可声明内置 ID。格式合法与已安装分开判断：读历史只要求格式合法，新会话与新投递由注册表判断，缺失时 503。

- 模型源：`AgentHost.modelSources.resolve(profileId, protocol)` 返回档案（只限本 Agent 自己的，别家的 403 `AGENT_PROFILE_FOREIGN`）所选模型源在该协议下的 `{ baseUrl, headers?, credential? }`（`sourceEndpoint` 的映射）；档案没有选源、源不可用或不提供该协议时为 `undefined`，源的凭据是命令时只给地址，不交出密钥（命令在 Riffet 之外执行）。`AgentHost.modelSources.models(profileId, protocol)` 返回同一档案在该协议下的模型目录：选了源时是源的 `catalog`，填了 `apiEndpoint` 时由宿主读该协议的标准目录，两者都没有时为 `undefined`。
- 协商：协议特性 `plugin-agents`（`ProtocolFeature`、`PROTOCOL_INFO`）。客户端在 `X-Riffet-Features` 声明后，才会收到带插件 Agent ID 的会话、运行、目录条目、事件、统计行、搜索命中，以及设置里的 `defaultBackendId`、`nativeBackendDefaults`、`auxiliaryModels` 引用；未声明的客户端（移动端从不声明）看到的与以前一样，其中被隐藏的默认值换成可见的后端。规则与 `pi-agent` 共用 `native/client-features.ts`，按形式（带点）判断，不枚举 ID。契约快照里 `NativeBackendIdSchema` 仍是枚举，`negotiatedPattern` 记录可能额外出现的字符串，兼容检查不视为破坏。
- 默认后端：`AppSettings.defaultBackendId` 保存用户的选择，没选过时不存；服务端返回的是生效值（`native/client-features.ts#defaultBackendForClient`）：保存的后端已注册且客户端能解码就用它，否则取标准 Agent 顺序（`NATIVE_BACKEND_IDS`：claude、codex、antigravity、cursor、pi、traex、droid、dsh，其后是插件 Agent，`chat` 最后；`NativeBackendRegistry.list()` 与后端目录都按此顺序）中第一个已安装（`BackendCatalog.availableBackendIds`，复用 30 秒的可用性缓存）且客户端能解码的，都没有时用 Claude；保存的值不变，插件回来后恢复。新会话没指定后端时用同一个值。后端不可用时保存设置不校验它的默认值（原样保留的通过，修改则 503）。
- 名称与图标：客户端从 `GET /api/backends`（已启用）或插件描述的 `declared.agentBackends`（启用与否）取名称；`icon.svg`（包内路径，至多 64 KB）由 `GET /api/agent-icons/<ID>`（`AGENT_ICON_ROUTE`）按 Agent ID 提供，不论插件是否启用，只提供声明的那个文件，带 `ETag` 与限制脚本的 CSP，客户端只能当图片画；`icon.sfSymbol` 给 Mac。内置 ID 保持 `gen:marks` 生成的图标，未知 ID 用通用图标和中性色。

## 插件详情

插件详情有三个页签：

- **介绍**：包目录里的 `README.<语言>.md`（如 `README.zh-Hans.md`），没有则用 `README.md`，经 `GET /api/integrations/:id/readme?locale=` 读取，不执行插件代码。首个标题只是重复插件名时省略。内置包放在 `plugins/<vendor>/<name>/`，构建时与 `assets/` 一起复制到 `dist/plugins/`。没有 README 时显示 `description`。下方列出插件提供的 Agent、模型源、任务、视图、命令和操作入口。
- **插件自己的页**：页签名取 `contributes.page.title`，缺省为「设置」。声明了 `page` 时显示插件构建的页面；否则显示 `settings` 表单和 `locations` 含 `settings` 的自定义视图。都没有时不显示这个页签。
  页面分三层：宿主画的状态（`status()`、缺的依赖、登录动作）；宿主按扩展点画的区块（模型源对应提供商与额度，Agent 对应配置，任务对应最近运行，分享发布对应已发布的分享），读数与宿主设置共用缓存；最后是插件构建的区块，不重复前两层的信息。布局、条目和怎样增加条目种类，见 [插件界面](design/system/plugins.md) §6。
- **管理**：启停策略、版本、来源、权限、卸载；下方是诊断（状态说明、运行诊断、日志、重载、兼容性）。

插件页（`packages/contracts/src/plugin-page.ts`）由插件在运行时构建，各端用自己的原生控件绘制，插件不写界面代码。分组有可选标题和一行脚注。条目包括：

- 设置类：`choice`（单选，每个选项可带检测结果 `detail` 和一个按钮）、`toggle`、`text`（可为密钥）、`list`。这类条目的 `key` 必须是 manifest `settings` 里声明的键。修改即时保存到同一份设置，插件仍从 `host.settings()` 读取；`toggle` 存为 `true`/`false`，`list` 存为 JSON 数组，用 `listSetting()` 读取，它也兼容逗号分隔的旧值。
- 展示类：`row`（只读的名称、值和说明，可带按钮）、`buttons`。按钮可带 `confirm` / `confirmDetail`，客户端先确认再执行。

宿主在服务端校验每次读取：格式不对时整页报错；引用未声明的键时拒绝；密钥条目的值一律去掉，只保留 `set`。`refreshMs` 让客户端在显示期间定时重读，用于下载这类自己会变化的状态。

条目 `meter`（有上限的量或进度，带进度条）已实现：客户端读取和修改页面时带 `?kinds=meter`，没带的客户端收到同内容的 `row`。规范已经确定、尚未实现的扩展（[插件界面](design/system/plugins.md) §6.4、§6.5）：条目 `link`（`page`、`view` 或 `url`）；`row` 的 `tone`、`badges`、`time`、`copy`、`ref`（引用项目、会话、任务、提供商或分享，宿主解析名称、检查能否访问）；区块的 `refresh`、`pending`、`error`、`empty`；按钮的 `flow`；读取时带 `path` 打开子页，`PluginPage.title` 是子页的标题。客户端读取页面时带上自己能画的条目种类，服务端把不支持的条目降级成 `row`、去掉不支持的附加项再返回，插件始终按最新的规范构建页面。

接口：`GET /api/integrations/:id/page?locale=` 读取；`POST /api/integrations/:id/page` 带 `{ locale, set: { key, value } }` 或 `{ locale, run: { action, item? } }` 修改，返回重读后的页面和可选的 `message`。插件关闭时返回 409。按需激活的插件（`view`、`command`）在读取页面时激活。

## Manifest 与静态声明

`PluginManifest` 的可选成员，不执行插件代码即可读取，所以关闭的插件仍显示它们：

- `version`：包版本（semver），不参与声明 ID。
- `title`、`description`：`LocalizedText`（BCP-47 标签到文本）。客户端依次取完全匹配、语言前缀、`zh-Hans`、`en`、第一项，都没有则用 `name`。
- `contributes`：`PluginDeclarations`，目前有 `views`、`commands`、`queries`、`tasks`、`agentBackends`、`avatarStyles`、`agentTools`、`channels`、`imChannels`、`page`、`modelSources`、`sharePublisher` 和 `appearance`（类型在 `packages/contracts/src/plugins.ts`；外观见 [THEMES.md](THEMES.md) §7）。声明 ID 是 `<插件 id>/<名称>`；视图声明 `locations`（`session-view`、`sidebar`、`panel`、`main`、`navigation`、`settings`、`file`；`file` 另须声明 `files.extensions`）、`clients`（`web`、`macos`）、`instances`；`when` 是结构化条件（`hasProject`、`hasSession`、`projectType`、`projectSystem`、`capability`），不是表达式。不认识的键被忽略。
- `requires`：`[{ id, optional? }]`。

校验分两侧，使用同一个函数 `checkManifest`，以模式区分。加载时（`load`），宿主不认识的值只跳过那一项并写一条说明：视图 `locations`、`clients` 中的未知值被去掉，去空的视图被跳过；`renderer.kind` 未知的视图被跳过；视图或命令的 `when` 含未知条件键时该视图或命令被跳过（宿主无法判断何时可见，所以保持隐藏）；`activation` 中的未知事件被去掉，都未知时插件不按启动激活，也不退回 `startup`。被跳过的项不出现在 `declared`，不占用声明 ID，不能被命令路由执行，也不触发按需激活；说明在插件的诊断和 `riffet doctor` 中以警告显示。打包与检查（`check`、`pack`）使用严格模式，未知值一律报错，因为作者时工具与 SDK 同版本，未知值只会是笔误。`capabilities` 中的未知名称在两侧都拒绝整个包：宿主无法约束的权限不能授予。已知成员的格式错误（类型、ID 格式、命名空间、重复、semver 等）也仍然拒绝。不合格的插件进入 `rejected`，在插件管理页和 doctor 中显示原因，不会激活。`PluginDescriptor` 相应增加 `version`、`title`、`description`、`source`（`builtin`、`development` 或 `installed`）、`declared`（静态声明，只含本版本认识的种类和成员）、`requires`、`rejected`（未加载的条目，没有启用控件）、`compatibility`、`installed`（独立包的版本、授权与数据）。

视图位置与客户端的承载情况（`locations` 的七个值，截至当前实现）：

| 位置 | Web | macOS | 移动端 |
|---|---|---|---|
| `session-view` | 承载 | 无 | 无 |
| `sidebar` | 承载 | 承载 | 无 |
| `settings` | 仅内置入口绘制 | 仅原生注册的渲染器 | 无 |
| `file` | 承载：文件视图「更多操作」里的另一种看法，按扩展名匹配 | 无 | 无 |
| `panel`、`main`、`navigation` | 保留，无客户端承载 | 保留，无客户端承载 | 无 |

### 冲突规则

多个已启用插件争用同一对象时，结果在加载时按注册顺序决定，每次启动相同。注册顺序为：内置（`plugins/index.ts` 的顺序）、开发包、已安装包。

| 对象 | 规则 | 后注册者 |
| --- | --- | --- |
| 声明 ID、模型源 ID、Agent 工具前缀（`toolPrefix`） | 加载时判定，先注册者持有 | 被拒绝，原因显示在插件管理页和 doctor |
| 分享发布者 | 单选，用户选择默认项 | 不涉及 |
| 运行时钩子（`runtimeHooks`） | 有序链：按注册顺序尝试，第一个 `prepare` 返回附件的钩子服务该进程 | 保留，diagnostics 注明排在谁之后 |

模型源 ID 若未在 `contributes.modelSources` 中静态声明，激活时仍按已激活者先得；被其他插件静态声明的 ID 一律归声明者，不论其是否已激活。

## 生命周期

每次开启是一次激活，有自己的代次、`ActivationScope`（`generation`、`signal`、`onDispose(fn)`）和 disposer。

- 暂存：`activate` 返回（或 Promise 完成）后，只有这次激活仍是被需要的才提交；抛错、停用或被新的选择取代时，已登记的 disposer 和 `Contributions.dispose` 照常运行，这次的实现丢弃。晚到的结果不会提交。
- 停用的顺序：查询不再返回它提供的功能；未完成的登录被丢弃；`signal` 中止；disposer 后登记者先运行，`Contributions.dispose` 最先，各自最多等约 5 秒。失败记为该插件的 `problem`，在状态和 doctor 中可查，不显示成「未安装」。
- 同一插件的生命周期变更串行：`update()` 与 `refresh()` 不会交叠。查询（`modelSources()`、`runtimeHooks()` 等）仍是同步的，只读已提交状态。
- 长存活资源：`runtimeHooks` 交出的附属进程由会话的运行时持有，不由插件持有。插件停用只停止观察（`detach()`），不终止原生进程和它的附属进程；`stop()` 只在会话自己结束时调用。插件在 `scope.onDispose` 里 `detach()` 它交出的全部附件，停用后拒绝会话控件的操作。
- 依赖：按 `requires` 的顺序激活；必需的插件缺失或未启用时本插件保持关闭，原因为 `requires <id>`；依赖停用时依赖它的插件随之停用，并且先于它停用（离被依赖者最远的先走）；依赖环在加载时整体拒绝。可选依赖只影响激活顺序。
- 服务关闭时 `registry.close()` 结束所有激活，同样依赖它的先于被依赖的。
- 激活期限：`activate` 约 30 秒仍没有结果，这次激活以问题结束（`activation failed: did not finish within 30s`），已登记的 disposer 运行，之后才到的结果照常释放，同一插件的队列不会被它占住。取代、失败和迟到的激活清理不掉的东西被等待并记为该插件的诊断（doctor 可查）。
- 调用期限：实现被提交时由注册表包一层，消费方无需改动。进程内插件的这些调用有等待上限，超时以「插件 id、操作、上限」的错误结束（代码本身无法取消）：模型源 `prepare` 30 秒、`catalog` 60 秒、`usage` 30 秒；运行时钩子 `prepare` / `recover` 各 30 秒，附件 `bindNative` / `stop` 各 10 秒、`act` 30 秒；分享发布器 `capability` 30 秒、`find` / `remove` / `verify` 各 60 秒、`deploy` 10 分钟。`resolve`、`publicUrl` 同步，不设上限；智能体工具 `call` 可能在等用户，也不设上限。隔离进程的调用由 `remote.ts` 的 `TIMEOUTS` 限时，这里只记录失败。所有这些调用的失败都写入该插件自己的日志（低于 500 的 `AppError` 是业务答复，记为 debug），错误原样交给调用方。
- 快速失败：同一次激活连续三次调用超时（普通错误不计，成功或抛错都清零）后，60 秒内其调用立即以 503 `PLUGIN_NOT_RESPONDING` 拒绝；之后放行第一次调用，成功则恢复，再超时则再关 60 秒。状态写在该次激活上，重载或重新启用从头计。期间插件的 `note` 显示「not responding … until <时间>」，进入状态与 doctor，调用恢复后清除。
- 进程重启：隔离进程在激活提交后退出或违反协议时，撤下它提供的功能（同上），随后在 2 秒、10 秒、60 秒后各自动重试一次，走与刷新相同的评估，依赖它的插件随之重新评估。重启后的进程稳定运行 10 分钟，次数清零。三次都失败后保持关闭，`problem` 附「automatic restarts stopped」，直到手动刷新、启用或重载。注册表关闭、插件被关闭或卸载、替换、恢复模式开启时不重启；激活阶段的失败仍按原处理（含版本回退），不自动重启。
- 登录：`runAction` 返回时插件已被关闭，则不登记设备码流程（409 `INTEGRATION_DISABLED`）；`pollFlow` 也核对插件仍在开启。

## Web 视图

插件在 manifest 的 `contributes.views` 声明视图；Web 入口 `plugins/<vendor>/<name>/web/index.ts` 默认导出 `defineWebPlugin({ views: { '<声明 ID>': 组件 }, icons? })`（`@riffet/plugin-web`），在 `plugins/web.ts` 登记为懒加载。入口要小，视图本身再用 `lazy()` 分块：插件开启后入口即被读取，视图在首次显示时才加载（画布即如此）。

- 目录：`apps/web/src/plugins/registry.ts` 把宿主自己的视图（会话视图 `chat`、`terminal`，侧栏视图 `files`、`changes`）与插件视图合成目录。插件视图须同时满足：插件已启用、声明了 `web` 客户端、有渲染器（已加载的入口登记了它，或其 `renderer: { kind }` 有宿主注册的渲染器，见 `registerDeclarativeRenderer`）。布局、切换器和设置页只读目录，增加视图不改布局分支。
- 实例：视图收到 `ViewContext`（`serviceId`、`projectId?`、`sessionId?`、`instanceId`、`visible`、`signal`），宿主服务经 `usePluginHost()` 取得：会话与订阅、导航、通知、UI 套件、`locale`。宿主按上下文给实例定 key，换会话或项目是新实例，旧实例的 `signal` 先中止；读请求都应带上它。
- 输入框槽：会话视图（非隔离，且会话未归档、不是快速对话）的 `ViewProps.composer` 是对话自己的输入框，卡片自带表面、宽度跟随容器，视图只负责摆放；草稿、发送、补充、排队、附件、斜杠命令与选择器同聊天视图（同一 `draftKey`）。组件身份在 NativeSession 重渲染间不变（经 context 取最新属性），`onSent(text)` 在对话接收消息后调用；Esc 由视图自己的浮层处理（输入框内的菜单先吃掉 Esc），草稿留在输入框里。
- 首帧与同步：最近一次的插件列表按服务缓存在 `localStorage["riffet.integrations.v1:<origin>"]`（退出登录时清除），首帧即知道哪些插件视图开着，切换器的点数与 ⌥⇧n 不再在请求返回后位移；网络返回只做修正。入口尚未加载的视图在目录里保留位置、不绘制内容，入口加载失败则暂时不列出，下一次插件列表刷新时重试一次。`/api/lists/stream` 在插件启停时发 `integrations` 事件（无内容），各客户端重读插件列表与外观目录，一处关掉画布，另一处不用刷新。
- 偏好：会话视图的顺序与隐藏存在 `riffet.sessionViews.v1`，按视图 ID；旧值 `canvas` 读作 `riffet.canvas/canvas`；当前不可用的 ID 原样保留，插件回来时视图回到原位。`chat` 不可隐藏。
- 文案：插件界面文字放在插件自己的 `messages.ts`（`zh-Hans` 与 `en`），用 `useMessages` 按 `host.locale` 取，不进宿主的 `.po`。
- 样式：Web 入口用与应用相同的 Tailwind 类，`apps/web/src/styles/index.css` 的 `@source` 已包含 `plugins/`。
- 设置页：`locations` 含 `settings` 的视图由「插件」详情弹窗里插件自己的页签承载（见上「插件详情」），仅在插件开启时加载；`BackendProfilesSection` 为所选 Agent 列出其插件（`declared.agentBackends` 含该 Agent）的设置页链接。页面用 `host.settingsPage.setDirty/setBusy` 向插件页面报告未保存与保存中，卸载时复位。
- 访问：入口在 `defineWebPlugin` 里用 `access: { requests, settings }` 声明视图可调用的服务端路径前缀（以 `/api/` 开头）和可读写的 `/api/settings` 键；`host.request.get/post`、`host.settings.get/subscribe/update`（`useSettings()`）只放行已声明的部分，其余拒绝。内置入口是可信代码，这是安全带与清单，不是沙箱。`isUnavailable(error)` 识别插件关闭时的 503 `NATIVE_BACKEND_UNAVAILABLE`。

## 自定义视图

非内置包（本地开发包和独立安装包）的 Web 视图不进入应用页面，在隔离的框架里运行，只经消息桥访问应用；内置包（画布、Cursor 设置页）仍用上面的应用内 SDK。包用 `entries.web` 给出一个打包好的单文件经典脚本（IIFE，不依赖任何外部加载），描述符的 `webEntry`（`{ path, integrity? }`，`integrity` 为 `sha256-<hex>`）和 `capabilities`（独立包取所选版本的授权，开发包取 manifest 所请求的，不需授权）交给客户端。

- 入口：与其他插件视图同一套门槛：插件已启用、视图声明 `web`、`compatibility.web.ok` 不为 false；位置为 `session-view`、`sidebar`、`file` 或单实例的 `main`（`settings` 位置只能由内置入口绘制）；没有 `webEntry` 的非内置包没有 Web 视图。实例按上下文定 key，换会话、项目或（`file` 位置的）文件是新框架，旧通道随之关闭。
- 框架：宿主用用户的会话经 `GET /api/integrations/:id/files/<path>` 取脚本（至多 8 MB），有 `integrity` 先校验，不符或写法不认识都拒绝；再经一次性通道交给加载 `/plugin-view` 的沙箱 iframe。引导页的 HTTP 响应单独设置 CSP，允许执行已校验的脚本。iframe 仅启用 `allow-scripts`，没有 `allow-same-origin`，页面的源不透明：没有 cookie、存储，读不到应用页面。`csp` 属性与页面 CSP 相同（嵌入式强制），支持它的浏览器还会拒绝框架被导航到不声明接受该策略的页面，其余浏览器忽略它。页面 CSP：`default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'`；包持有 `network` 时 `connect-src https:`。已知缺口（Web）：在不支持嵌入式强制的浏览器里，CSP 拦不住脚本把自己的框架导航到别处（实测请求照常发出），也拦不住 WebRTC；宿主只能在框架第二次加载时丢弃该视图，拦不住那次请求，也发现不了页面加载中途的导航。所以 Web 上的 `network` 不是对 `sessions.read` 的真实防线：持有 `sessions.read` 的包能读到什么就能送出什么。Mac 的 WebView 拒绝除引导页外的所有导航。
- 基础样式（`[data-pointer-focus]:focus-visible` 一条不在 `:where()` 里，特异性高于视图自己的 `:focus-visible`，见下文焦点环策略）：引导页的 `<style>` 在颜色变量之后带一份带版本的基础样式（`packages/plugin-web/src/base-style.ts` 的 `PLUGIN_BASE_STYLE`，版本常量 `PLUGIN_BASE_STYLE_VERSION`，现为 3）。Web 的 `document.ts` 直接引用它；Mac 的 `PluginPageDocument.swift` 里是 `pnpm gen:plugin-style` 生成的同一份文本，`gen:plugin-style:check` 在 CI 中核对。内容分两层：`--riffet-*` 自定义属性（间距 4/8/12/16/24、圆角 8/10/12、界面与等宽字体栈、阅读/界面/次要三档字号与行高、控件高度 32、边框宽度 1px、焦点环），数值取自应用自己的控件与 `docs/design/riffet-style.md`；以及只针对原生元素的规则（`body`、`a`、`button`、`input`/`textarea`/`select`、`code`/`pre`/`kbd`、`hr`、`table`、`:focus-visible`、`::selection`、禁用态、细滚动条），全部包在 `:where()` 里，特异性为零，包自己的 CSS 不需要 `!important` 即可覆盖。没有类名组件和工具类。唯一的脚本是焦点环策略 `PLUGIN_FOCUS_SCRIPT`（同文件），与应用的 `lib/focus-ring.ts` 同一规则：两端都在视图脚本之前运行它，Mac 的那份由 `gen:plugin-style` 生成为 `focusScript`；CSP 不变（内联 `<style>` 已被 `style-src 'unsafe-inline'` 允许）。`BRIDGE_VERSION` 不变，`host.info` 暂不报告样式版本。
- 通道：请求通道的是宿主生成的引导页自己，不是视图：引导页的第一段脚本（由服务端的 `plugins/view-frame.ts` 提供）先挂上 `riffet-plugin:init` 的监听、把端口的 `Promise` 放在 `window.__riffetPort`，再向父窗口发 `riffet-plugin:ready`，此后才注入视图的脚本；`connect()` 只取这个 `Promise`，不再自己发请求，页面不是宿主生成的则以 `unsupported` 失败。宿主只回应它自己嵌入的那个窗口（以 `event.source` 为准），只回应第一次：同一窗口的消息按序到达，所以第一个请求必然是引导页发的，之后任何请求（包括框架被导航到的页面发的）都被忽略，握手也无法重置通道的限流。不以框架的第一次 `load` 为界：Chrome 实测在页面加载中发出的消息晚于 `load` 才送达（`load,message:ready`），按 `load` 判界会拒绝引导页自己的请求。宿主在框架渲染前就挂好监听（Web 用 layout effect），框架第二次 `load` 仍丢弃该视图。宿主创建 `MessageChannel`，把一个端口随 `riffet-plugin:init` 交给框架。之后所有请求都在这个端口上，包的身份、能力、项目都绑在端口上，载荷里的自报字段不读。请求 `{ id, method, params }`，回复 `{ id, result }` 或 `{ id, error: { code, message } }`，推送 `{ event, data }`。
- 校验顺序：频率与并发、大小、方法是否已知、包是否持有该方法的能力、参数 schema（多余的键也拒绝），最后才到服务。限制：请求 64 KB、结果 1 MB、同时 16 个、令牌桶 60 个突发每秒补 30 个、文本 500 字符、时间线至多 200 行。视图卸载或上下文变化时通道关闭，未完成的请求中止，之后不再回复。

| 方法 | 参数 | 结果 | 要求 |
| --- | --- | --- | --- |
| `context.get` | 无 | `serviceId`、`projectId?`、`sessionId?`、`path?`（`file` 位置的视图所看的文件）、`instanceId`、`visible`、`locale` | 无；变化时推送 `context` |
| `theme.get` | 无 | `{ scheme, vars }`，`vars` 是 `THEME_ROLES` 的 `--<role>` 到颜色 | 无；变化时推送 `theme` |
| `sessions.get` | `{ sessionId }` | 会话的 id、项目、标题、状态、后端、模型、模式、标签与时间 | `sessions.read`，限视图所属项目 |
| `sessions.outline` | `{ sessionId, lane? }` | `{ turns }`（`TurnOutlineV3`） | 同上 |
| `sessions.turnSummary` | `{ sessionId, turn }`（`turn` 为大纲里的键） | `{ summary? }`：已结束一轮的一句话结论，由「画布摘要」辅助模型首次请求时写出并保存；未选模型、该轮未结束或无答案时为空 | 同上；仅 Web 宿主 |
| `sessions.turnSummaries` | 无 | `{ enabled }`：是否已选「画布摘要」模型 | 同上；仅 Web 宿主 |
| `sessions.timeline` | `{ sessionId, lane?, from, rows? }` | 一页时间线行（含工具输入输出） | 同上 |
| `files.read` | `{ path?, offset?, length? }`（`path` 缺省为上下文的文件，`length` 至多 512 KB） | `{ path, size, offset, data }`，`data` 为 base64；到文件末尾后为空 | 视图自己的文件不需要能力，项目里的其他文件要 `projects.read`；按用户自己的读取规则（项目外、凭据文件同样受限），经 `GET /api/projects/:id/file/raw` 的 Range 请求读取 |
| `navigation.openSession` | `{ sessionId }` | `null` | 限视图所属项目；仅在用户操作过该视图之后（Web：`document.activeElement` 是该框架；Mac：视图可见且是或包含第一响应者），否则 `denied` |
| `navigation.openPath` | `{ path }`（相对项目根，不含 `..`） | `null` | 同上 |
| `navigation.openExternal` | `{ url }`（`http:` 或 `https:`，至多 2000 字符，不带用户名密码） | `null` | 视图的 `requires` 列出 `bridge.navigation.openExternal`，否则 `forbidden`；同样要求用户操作过该视图。Web 在新标签页打开（`noopener,noreferrer`，依赖用户在框架里的点击让浏览器放行），Mac 用默认浏览器。不在 `host.info.methods` 里的宿主视为不支持 |
| `navigation.openView` | `{ viewId }` | `null` | Web，在用户操作后打开本包可用的主页面或侧栏视图 |
| `navigation.openAssistant` | 无 | `null` | Web，在用户操作后打开入口服务器的个人助理 |
| `plugin.query` | `{ id, params? }` | JSON 值 | Web，仅调用本包声明的查询；`plugin.data` 推送可选的 `topic`，视图据此重读 |
| `notify.info` / `notify.error` | `{ text }` | `null` | 无；提示前加包名 |
| `commands.execute` | `{ id, args? }`（`args` 为名称到文本、数字或布尔值） | 服务端的 `CommandResult`（`done`、`open` 或 `task`） | 只限本包 `contributes.commands` 声明的命令（`id` 以 `<包 id>/` 开头）；宿主以视图的项目与会话经 `POST /api/integrations/:id/commands/:name` 执行，宿主不据结果自行跳转，由视图决定（可再调 `navigation.*`） |

错误码：`invalid_request`、`unknown_method`、`invalid_params`、`denied`（缺能力）、`forbidden`、`not_found`（含别的项目的会话）、`rate_limited`、`too_large`、`unsupported`、`failed`。`sessions.read` 授予读取视图所属项目里会话的时间线行，行里有对话与工具输入输出，授权时按这个分量看。

- 客户端：`packages/plugin-web/src/bridge-client.ts` 无依赖，随视图一起打包：`connect()` 返回连接，`call(method, params)` 带类型地调用，`on('context' | 'theme', fn)` 监听推送，主题变量默认写到文档根上，视图的 CSS 直接用 `var(--fg)`。协议类型（`BridgeMethods`、`BridgeEvents`、`BRIDGE_LIMITS`）从 `@riffet/plugin-web` 导出。样例：`examples/plugins/session-stats/`。
- Mac：非内置包、声明 `web` 客户端、有 `webEntry`、侧栏位置的视图，在没有原生渲染器时用 `WKWebView` 承接（Mac 没有会话视图注册，只有侧栏）；内置的仅 Web 视图仍不可用。页面由 `riffet-plugin://<插件 id>/index.html` 的 scheme handler 提供，脚本经带令牌的客户端取回并校验 `integrity`；数据存储是非持久的，内容规则列表在没有 `network` 时拦截所有网络请求，除引导页外的导航一律拒绝。页内的垫片在文档开始时提供同样的端口语义（`MessageChannel` 一端留在页内，经 `WKScriptMessageHandler` 与 `evaluateJavaScript` 往返），所以同一个客户端不改就能用；引导页遵循与 Web 相同的握手协议，垫片只回应第一次，之后的握手不新建桥，限流与未完成计数不会被重置。请求的校验用 Swift 再实现一遍，调色板用同一套角色名推送。`navigation.*` 要求视图可见且是或包含窗口的第一响应者，否则 `denied`；长按链接预览关闭；`commands.execute` 经带令牌的客户端 POST 到命令路由。入口脚本的地址带 `?v=<入口 integrity，没有则包版本>`，升级后不会命中旧缓存。Mac 另按自己的桥协议版本（1）核对 `compatibility.web.range`（范围匹配与服务端的 `satisfies` 相同），不兼容的视图不提供，与服务端判 `ok: false` 同。

## 助理扩展点

插件有两个面向个人助理的扩展点，细节见 [助理](ASSISTANT.md) §7.3、§8.2，声明字段见 [插件](PLUGINS.md)「声明」。

- 事件（`contributes.assistantEvents`）：进程内的包调用 `host.assistant?.emit(topic, payload?, { key? })`，核心把它交给订阅了该主题的委托（`assistant/delegations.ts#pluginEvent`），每条委托入队一次 `delegation` 后台运行，受 `ASSISTANT_BUDGET` 的每日运行数与并发限制。事件只在内存里经过：服务器关着或还没启动完时发生的事件不补发，插件重启后重新发出即可（同一 `key` 不会重复起运行）。
- 能力包（`contributes.assistantPack`）：`assistant/plugin-packs.ts#syncPluginPacks` 让助理的 `packs/` 与已启用插件的声明一致（懒启动、尚未启动的插件也算启用），在服务启动后和每次插件变化后运行。只装进程内的包（内置、开发、受信任安装）的能力包：包里的 hooks 和 MCP 服务器以用户身份运行，隔离安装的包不能借此越过沙箱；装好的文件夹带 `.riffet-plugin.json`（插件 id、版本、内容摘要），只有带它的文件夹才会被同步替换或删除。变化后主对话的 CLI 在空闲时重启（`restartWhenRested`）。

## 收件箱审批

插件要用户确认一次待执行的写操作时，不自己做界面，而是请求一条审批，用户在收件箱里点按钮（目前只有 Web 的收件箱，iOS 只收到推送提醒）（[任务看板](TASK-BOARD.md) §7，要你回答的一个来源）。只给进程内的包（内置、开发、受信任安装），隔离安装的包没有；宿主没有这项能力时 `host.approvals` 缺省。没有清单声明，也不需要权限。

- 请求：`host.approvals?.request({ id, title, body, actions: [{ id, label, tone? }], expiresAt?, sessionId? })`。`id` 在插件内唯一，已打开的 `id` 再请求什么都不改，所以插件重启后可以放心再发。`body` 是短 Markdown；`tone` 为 `primary`、`danger`、`neutral`，缺省 `neutral`。字段与条数上限在 `PLUGIN_APPROVAL_BUDGET`（每个插件同时打开 20 条、至多 4 个按钮）：超出、字段不合法或 `expiresAt` 已过时抛 `AppError`，已满时是 429 `PLUGIN_APPROVAL_LIMIT`。
- 撤回：`host.approvals?.withdraw(id)`，不存在的 `id` 不报错。到 `expiresAt` 的条目由服务端移除；插件被停用或卸载时，它的全部条目随之撤回（`app.ts` 在插件变化后清理，`PluginRegistry.offPlugins`）。
- 决定：用户点按钮后，核心找到插件（懒启动的插件先启动）并调用 `Contributions.approvals.decide(id, actionId, { signal })`。返回即成功，条目移除，`message`（本地化文字）显示给用户；抛 `host.error(...)` 即拒绝，错误显示给用户，条目保留可以再点。同一条同时只处理一个决定。条目在重启后仍在，所以 `decide` 要能容忍重复执行。
- 保存：`plugin_approvals` 表（`plugins/approvals.ts#PluginApprovals`），不经插件自己的状态目录。
- 作用范围：`global`（[多服务器](guide/multi-server.md) §3.5）。
- 手机推送：新条目（不是重复请求）经 `PushService.approval` 推给不在前台的 iOS 设备，不属于任何会话。

## 模型用途

插件在静态声明里写它要在模型上做的事：`contributes.modelUses: [{ id, title, fallback? }]`，`id` 是声明 ID（`<插件 id>/<名称>`），`title` 是这件事的名称（如「翻译」），`fallback` 可为 `default`（辅助模型的「默认模型」）或 `chat`（快速对话的默认模型）。参考实现是 `riffet.translate`（`fallback: 'default'`）。

- 设置：插件启用时，各客户端的「设置 › 辅助模型」在核心用途下面多一组「插件」，每项用途一行，选项与核心用途相同（已有密钥的网关模型，列表标出 `http` 与较慢的 `cli-process` 路径）。选择存在 `AppSettings.pluginModels`，按声明 ID 保存，所有客户端同一份；插件停用或卸载时这一行不显示，选择保留，再启用时还在。更新时只改给出的用途，`null` 清除；`pluginModels` 至多 64 项。
- 调用：`host.models.complete({ use, … })` 与流式 `host.models.stream({ use, …, onDelta })`。`use` 只能是本插件声明的用途，别的得 403 `PLUGIN_MODEL_USE_FOREIGN`。宿主先取用户为它选的模型，没有就按 `fallback` 取「辅助模型 › 默认模型」或「快速对话」的默认模型；都没有时 409 `PLUGIN_MODEL_NOT_CHOSEN`，`details.use` 是这项用途，客户端的「选择模型」直接打开「辅助模型」。
- 核心用途（`AUXILIARY_MODEL_PURPOSES`）不随插件增加：核心不认识任何插件的用途，宿主只按声明画行、按声明 ID 取值。隔离安装的包暂时没有 `models.complete`；开放时会配一项授权能力，安装时列出「会把内容发给你选择的模型」。

## 消息菜单

命令可以列在宿主的菜单里：`CommandDeclaration.menus` 取自 `COMMAND_MENUS`，目前有 `message`（回答的更多菜单）和 `selection`（在回答里选中文字时出现的工具条）。列在菜单里的命令只在菜单里出现，命令面板与快捷键不列它，因为那里没有它要处理的消息。界面规则见 [插件界面](design/system/plugins.md) §2.1，参考实现是内置插件 `riffet.translate`（`plugins/riffet/translate/`）。

- 声明：`menus` 含 `message` 或 `selection` 都要求 `scope: 'session'`；`icon` 取自 `COMMAND_ICONS`（如 `languages`），客户端按名字画自己的图标，不认识的画拼图。加载时宿主不认识的菜单值被去掉并写一条说明，全部不认识时整条命令被跳过，不会改为出现在命令面板；不认识的 `icon` 被去掉。`pack`、`check` 对两者严格报错。
- 执行：客户端照常 `POST /api/integrations/:id/commands/:name`，另带 `message: { role, text, runId? }` 和客户端语言 `locale`。`text` 是客户端显示的 Markdown，至多 `PLUGIN_COMMAND_BUDGET.messageChars`（超过时客户端不列插件项）。列在 `message` 菜单的命令没有 `message` 时得 400 `COMMAND_ARGS_INVALID`，其他命令带了 `message` 同样拒绝；`message` 与 `locale` 计入同一 `requestId` 的幂等比较；在消息上运行的命令只在运行期间共享同一次执行，答复后不保留，避免长结果在服务端常驻十分钟。处理函数从 `CommandContext.message`、`locale` 读取，支持流式的插件可通过 `CommandContext.onTextDelta(delta, title?)` 增量输出（客户端携带 `Accept: text/event-stream` 时从首段增量起按 SSE `delta` / `result` / `error` 返回，未增量输出或首字前报错仍按 JSON 返回）；隔离安装的包经子进程协议的 `command.run` 收到 `message`、`locale`。
- 选区菜单：请求改带 `selection: { text, runId? }`（`text` 是选中的文字，至多 `PLUGIN_COMMAND_BUDGET.messageChars`，`runId` 同 `message`），规则与 `message` 对称：一次请求至多带 `message`、`selection` 之一，两者都带得 400 `COMMAND_ARGS_INVALID`；`selection` 只给列在 `selection` 菜单的命令，`message` 只给列在 `message` 菜单的命令，列在菜单里的命令必须收到它所列菜单对应的那一项，没有菜单的命令两者都拒绝；`selection` 计入同一 `requestId` 的幂等比较，在选区上运行的命令与在消息上运行的一样，答复后不保留。处理函数读取 `CommandContext.selection`，隔离安装的包经 `command.run` 收到同一字段。
- 结果：除 `done`、`open`、`task` 外，在消息或选区上运行的命令可以返回 `{ kind: 'text', text, title? }`：`text` 是 Markdown，1 到 `PLUGIN_COMMAND_BUDGET.resultChars` 个字符；`title` 是至多 16 种语言、各 40 字的标题。不是在消息或选区上运行的命令返回 `text` 是无效结果（502 `COMMAND_FAILED`）。客户端把它显示在那条回答下方，只在内存里保留（`keptResults`），不写进会话、不同步。
- 承载：`message` 菜单 Web 与 Mac 已实现，结果在回答页脚下方；iOS、Android 尚未列出插件项。`selection` 菜单目前只有 Web，结果显示在锚定于选区的卡片里；Mac、iOS、Android 尚未实现。

## 启用

依次判定，先命中者为准：

1. 本构建不含该插件：不出现。
2. `plugins.json` 中明确的 `on` / `off`。
3. `auto`（默认）：取 `manifest.defaultEnabled`；它也是 `auto` 时调用 `detect()`。`detect()` 只能做轻量的本机检查。提供模型源的插件可用 `host.modelSourceInUse(id)` 把「已有档案在用」算作检测命中，使既有档案不因本机信号变化而失效。

再加上必需依赖：被依赖者未启用时，即使上面判定为开启也保持关闭。

检测不在每次读取列表时运行。启动时（`refreshWithin`）、`update()` 之后和 `POST /api/integrations/refresh` 才重新判定，`GET /api/integrations` 返回上一次的结果。Web 与 Mac 打开插件管理页只读取列表；用户选择「重新检测」才调用 refresh。Mac 页面显示期间每十秒读取一次列表。

关闭插件会撤下它提供的功能，并丢弃未完成的登录。模型源启用状态变化后刷新模型目录；档案里保存的模型源若无插件提供，原样保留，解析为不可用。

## 本地开发包

常用入口是 `riffet plugin dev <源码目录>`：共享工具完成构建与校验，然后经 `POST /api/integrations/development` 注册包目录并在源码修改后重载。关联保存在已有 `plugins.json` 的 `development: { [id]: 绝对包目录 }`；服务停止时 CLI 取得状态目录锁后登记，下次启动生效。`riffet plugin unlink <id>` 经 DELETE 同一路径解除关联、停止作用域并保留设置和数据。持久关联核对原 ID，manifest 身份变化会拒绝加载；显式 registry developmentPackages 选项仍覆写默认发现。

注册与解除接口只允许本机回环、无代理头的请求，沿用全局认证和 CSRF；注册前检查 manifest、身份和声明冲突，不能接管内置或已安装的 ID。同路径重复注册按重载处理；其他目录的同 ID 先 unlink。运行任务阻止重载或解除关联。退出 watcher 不删除持久关联，服务也不会由开发命令自动启动。

环境变量 `RIFFET_DEV_PLUGINS` 仍兼容：它是冒号分隔的目录列表，每个目录含 `riffet-plugin.json`：与 manifest 相同的字段，再加 `entries: { server?, web? }`（相对路径）。这是可信的本地开发入口：服务端在探测或激活时把入口当应用代码 `import()`，所以列出一个目录等于信任它。

- 先校验 manifest，再用 realpath 确认入口文件在包目录之内；入口默认导出 `{ detect?, activate }`（也可以是完整的 `Plugin`，其 `manifest.id` 须与 JSON 一致）。没有服务端入口的包只有静态声明。
- 以 `source: 'development'` 注册。与内置插件同 ID 的开发包被拒绝，不能覆盖。
- `GET /api/integrations/:id/files/*` 服务开发包与已安装包交给客户端的文件，不服务内置包：realpath 限定在包目录内；只给 Web 入口 `entries.web`（按脚本服务，扩展名可以是 `.mjs`）、声明引用的文件（图标、外观资产）和 `assets/`、`web/` 下的文件，类型限 js、css、json、svg、png、woff2；服务端入口和其他服务端代码（包括 `server/` 下的 `.js`）一律 404，客户端永远拿不到。`Cache-Control: no-cache`，沿用现有鉴权；Web 与 Mac 取 Web 入口时地址带 `?v=<入口 integrity，没有则包版本>`（服务端忽略它），升级后缓存里的旧入口不会被复用。Web 入口在隔离框架里运行，见「自定义视图」。

## 独立包

独立包是用户安装的固定版本预构建包：一个目录或 `.tgz` / `.tar.gz` / `.zip` / `.tar`，根部有 `riffet-plugin.json`（字段同本地开发包，npm 风格的单层 `package/` 前缀会被去掉）。安装不运行任何脚本，也没有 npm install；包自带所需依赖，或只用宿主 API。manifest 另有四个可选成员：

- `hostApi`：`{ server?, web?, agent? }`，semver 范围，分别对照 `PLUGIN_API_VERSION`、Web 插件 SDK 版本（`PLUGIN_WEB_API_VERSION`）、`AGENT_PROTOCOL_VERSION`。描述符的 `compatibility` 给出每个入口的 `{ range, ok }`。服务端入口不兼容时不激活，状态里写明原因，声明照常列出；Web 不兼容的入口由 Web 目录跳过，插件管理页显示「客户端版本不兼容」。范围只支持 `>= > <= < = ^ ~ x *`、空格（并）和 `||`。
- `dataVersion`：包保存在状态目录里的数据格式版本。
- `capabilities`：包要求的能力，取自 `PLUGIN_CAPABILITIES`（`models.provide`、`tasks.run`、`projects.read`、`sessions.read`、`network`、`process.exec`），不认识的名字使安装被拒绝。
- `executables`：与 `process.exec` 一起出现的命令名列表，见下文「权限由宿主按调用检查」。

### 安装与版本

`<stateDir>/plugins/<id>/<版本>/` 存文件，`<stateDir>/plugins/installed.json`（0600，原子写入）记录 `{ id, versions: [{ version, source, integrity, installedAt, capabilities }], selected }`。安装串行执行：先解到 `<stateDir>/plugins/.staging/` 的临时目录（路径限定在包内，链接、设备、重复条目、`..`、绝对路径一律拒绝；归档 32 MB、解包 96 MB、4000 个文件上限），再校验 manifest、入口与声明引用的资源、兼容性，对全部文件内容计算 `integrity`（`sha256-…`，只证明内容未变，不证明作者可信），然后移到版本目录并写记录。每次启动读取时重新核对 integrity，文件被改动的版本不加载并显示原因。

- 同一版本、同样内容再次安装是幂等的；同一版本、不同内容得 409 `PLUGIN_VERSION_CONFLICT`。内置或开发包的 ID、`riffet.` 命名空间得 409，替换来源不在本阶段。
- 授权：请求的 `grant` 必须等于包要求的 `capabilities`，否则 409 `PLUGIN_GRANT_REQUIRED`，`details` 带 `{ id, version, capabilities }`，客户端据此显示确认。授权按版本记录，新版本增加能力就需要新的授权。
- 已安装的插件装入新版本后自动选中它：先关闭、换版本、再激活；新版本没有启动，就回到之前的版本，失败原因保留在该行（状态 `attention`，也在 doctor 中），请求得 409 `PLUGIN_ACTIVATION_FAILED`，新版本仍是已安装、可再选。依赖它的插件先关闭、换好后重新判定。
- 卸载一个版本只删包文件：选中的版本在还有别的版本时不能卸载；最后一个版本带走整个插件。仍被使用的文件（有未结束的任务是用该版本启动的）等到不再被使用时才清理，启动 5 秒后会扫一遍，仍有文件在等待时每分钟再扫一遍（与安装、卸载互斥）；不在记录里的目录也在这时清掉。设置、密钥和数据都不动。
- 外观资产：声明了 `appearance` 的版本，其配色、字体、背景要通过与 `GET /api/appearance` 相同的检查（路径、类型与文件头、大小、配色是合法主题），否则整个版本以 422 被拒绝，而不是让目录悄悄少一项，也就不会用一个坏掉的新版本顶掉可用的旧版本。共享打包工具用同一套资源校验，打包时就报出。
- 旧版本的资产地址：目录里的资产地址带内容哈希。升级后，只要旧版本的文件还在，`/api/appearance/assets/:pluginId/:sha256` 仍然服务它的地址（持有旧目录的客户端不会 404），卸载那个版本后才失效；插件停用后所有地址都 404。
- 数据在 `<stateDir>/plugin-data/<id>/`，与版本分开。`DELETE /api/integrations/:id/data` 是唯一删除它（连同备份）的操作，插件在删除期间关闭、之后按启用状态重新启动；插件已卸载而数据还在时同样可删。

### 数据版本

声明了 `dataVersion` 的版本在每次激活前由宿主处理：数据目录里的 `.riffet-data-version` 记录当前格式（没有标记而目录非空，当作 0）。声明的版本更高时，先把整个目录复制为 `<id>.backup-v<旧版本>`（复制完成才改名，最多保留两份）再写新版本号；更低时拒绝激活，错误里写出应该恢复的备份（把它移回数据目录再选择该版本），没有可用备份时说明这一点。恢复旧代码不等于数据可回滚，所以回滚到格式更旧的版本需要这一步。例外是新版本自己没能启动：它已经备份并迁移了数据，宿主在让上一个版本重新启动之前，把这次升级做的备份（`<id>.backup-v<上一个版本留下的格式>`）放回数据目录、丢弃迁移后的数据，上一个版本才能在自己的格式上启动；备份用掉了，下次升级再做。格式没有变化或没有这份备份时不动数据，上一个版本照旧报告格式更新。

### 执行位置

内置包、开发包和本机显式可信安装包在服务进程里执行。默认隔离安装包在单独的 Node 进程里执行，信任由宿主记录，包无法自称受信。隔离进程有两层约束（`apps/server/src/plugins-host/process.ts`、`sandbox.ts`）：macOS 上的操作系统沙箱在外，Node 的权限模型在内。

**操作系统沙箱（macOS）**：进程经 `/usr/bin/sandbox-exec` 在 Seatbelt 配置下启动，配置从 `(deny default)` 起，只放行下面这些；路径都以 `-D` 参数传入，配置文本里没有任何用户可控的内容。`sandbox-exec` 在应用配置后变成 Node 本身，所以 pid、IPC 通道和信号语义不变。

```scheme
(version 1)
(deny default)
(allow process-exec* (literal (param "NODE")))                        ; 只能执行解释器；没有 process-fork
(allow file-read-data (literal "/") (literal "/dev/null"))             ; dyld 启动要打开 "/"；/dev/null 是 OpenSSL 的空配置
(allow file-read* (subpath (param "READ0")) (subpath (param "READ1")) (subpath (param "READ2")))   ; 运行时 child.mjs、包目录、自己的状态目录
(allow file-read-metadata (literal (param "ABOVE0")) …)               ; 上面三处的各级父目录，只答 lstat（Node 的 realpath 要走一遍）
(allow file-write* (subpath (param "WRITE0")))                        ; 只写自己的状态目录
(allow signal (target self))                                          ; 只能给自己发信号
(allow sysctl-read (sysctl-name "hw.ncpu" "hw.memsize" "kern.osrelease" …))   ; 16 个静态信息，Node 启动和 os.* 要用
; 仅当授予 network：
(allow network-outbound (remote ip "*:*") (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))
(allow file-read-metadata (literal "/var") (literal "/private/var/run/mDNSResponder"))
(deny network-outbound (remote ip "*:<服务端口>"))                     ; 服务自己的端口始终关闭，任何地址上（localhost 不匹配 ::ffff:127.0.0.1）
```

没有 `mach-lookup`、共享内存、`network-bind`、其他 unix socket。解释器链接的动态库不在系统共享缓存里时（Homebrew 的 Node），宿主解析它的 Mach-O 加载命令（含 `@rpath`、符号链接链），逐个列入读取与映射权限，不放开整个安装前缀；官方构建没有这样的库。第一次激活前宿主用同一份配置实际跑一次 `node -e`，`sandbox-exec` 缺失、配置被拒绝、服务本身已在沙箱里等情况都在这里暴露，按「不可用」处理。

**没有操作系统沙箱时**（非 macOS，或上面的自检失败）：安装包拒绝激活，状态写明原因（`PLUGIN_ISOLATION_UNAVAILABLE`，提示 `RIFFET_UNSAFE_PLUGIN_PROCESS=1`）。操作员设置 `RIFFET_UNSAFE_PLUGIN_PROCESS=1`（必须是 `1`）才允许只靠 Node 的权限模型运行：状态为 `attention` 并一直显示警告，包自己的状态附在后面，`riffet doctor` 多一条 warn。内置和开发包不受影响。已安装的包仍可安装、列出、选择和卸载，只是不运行。

**Node 权限模型**（始终开启，第二层）：

```
node --permission --no-experimental-sqlite
     --allow-fs-read=<运行时 child.mjs> --allow-fs-read=<包目录> --allow-fs-read=<自己的状态目录>
     --allow-fs-write=<自己的状态目录> --max-old-space-size=256
```

环境变量只有 `NODE_ENV`、`LANG`、`TZ` 和 `OPENSSL_CONF=/dev/null`（不读任何 OpenSSL 配置文件）。没有 `--allow-child-process`、`--allow-worker`、`--allow-addons`、`--allow-wasi`、`--allow-inspector`。

**两层各限制什么**（Node 24.19、macOS 26；`plugins-host/install.test.ts` 与 `acceptance.test.ts` 逐项断言）：

| | macOS（沙箱 + 权限模型） | 其他平台（只有权限模型，需 `RIFFET_UNSAFE_PLUGIN_PROCESS=1`） |
| --- | --- | --- |
| 文件 | 读取三处之外、写入状态目录之外的任何路径，连 `stat` 都 `EPERM`（`~/.ssh`、别的项目目录）；包目录只读 | 读取三处之外、写入状态目录之外 → `ERR_ACCESS_DENIED`；创建符号链接、硬链接被拒 |
| 进程 | 只能执行 Node，不能 `fork`；Worker、原生扩展（`ERR_DLOPEN_DISABLED`）、WASI、Inspector 被权限模型拒绝；`node:sqlite` 已从进程移除 | 权限模型拒绝子进程、Worker、原生扩展、WASI、Inspector |
| 信号 | 只能发给自己：`process.kill(ppid, 0)`、向服务进程发 `SIGTERM`/`SIGKILL`/`SIGUSR1` 都是 `EPERM` | **不受限**：包可以杀死服务进程。向服务发 `SIGUSR1` 会使 Node 打开 Inspector 端口，服务在启动第一个包进程时装一个监听挡住它（Node 24.19，测试覆盖），`--disable-sigusr1` 同样有效；`SIGKILL` 等无法阻止 |
| 网络 | 默认全部拒绝（`fetch`、`net.connect`、监听、UDP）。持有 `network` 才允许对外 IP 连接和名称解析；连接其他 unix socket（tmux、ssh-agent、Docker）和服务自己的端口始终 `EPERM` | Node 24 **不受限**：`network` 只约束经宿主代理的 `gateway.fetchModels`；Node 25+ 由权限模型默认拒绝，授权 `network` 后传入 `--allow-net`，仍无服务端口隔离 |
| 环境 | 服务进程的环境变量（令牌、PATH）不传入 | 同左 |
| `process.exec` | 例外：声明的命令在沙箱外以用户的身份运行（`host.exec`，见下） | 同左 |

**仍然没有约束的**（两个平台）：CPU 与磁盘占用（内存只限制 V8 堆为 256 MB）；包经授权合法读到的东西，持有 `network` 的包都能送出去——自己的包和状态目录、宿主通过协议交给它的内容（`projects.read` 读到的项目文件、模型源的 `overrides`、它自己的密钥）；回环上的其他服务：`network` 包含 `127.0.0.1`，除服务自己的端口外本机的其他服务（模型服务器、数据库）它都连得上，服务自己的端口只在启动时已知的 `--port`（及监听后的实际端口）上关闭，同一台机器上另一个 Riffet 实例或前端开发服务器的端口不在其内；Node 文档列出的权限模型绕过方式（`v8.setFlagsFromString`、使用已有的文件描述符等）在内层仍然存在，外层沙箱是为此而设。Seatbelt 的 `sandbox-exec` 已标为弃用，但仍随系统提供，Linux 上的等价物（用户命名空间、Landlock）尚未实现。

**权限由宿主按调用检查**，不信包自己说了什么。协议是逐行 JSON 的 RPC，走子进程的 stdin/stdout，不用 Node 的 IPC 通道（它的解析器把一行坏数据抛到服务的顶层）；一条消息至多 8 MB，坏行或超长都只让该插件失败（`packages/plugin-api/src/runtime/protocol.ts`，子进程一侧是 `child.mjs`，构建时复制为 `dist/plugin-runtime.mjs`）：子进程里的入口得到一个代理 `PluginHost`，调用回到服务端，每次按该版本被授予的能力检查：

- 扩展点按种类检查：模型源需要 `models.provide`，任务提供方需要 `tasks.run`，缺少则激活失败并写明。
- `gateway.fetchModels` 需要 `network`（请求字段逐项校验，`select` 与 `signal` 不能跨进程）；`invalidateModelCatalogs` 需要 `models.provide`；`secrets.set` 只写自己的密钥。`agentProfiles` 不提供。
- `host.exec`（`host.runProcess` 的跨进程形式）需要 `process.exec`：`command` 须与包声明的某个 `executables` 逐字相等，宿主用进程内插件同一个 `resolveCli` 解析为绝对路径（未安装 404；落在包目录或包状态目录之内的文件 403），`args` 至多 64 项、每项至多 8192 字符、不含 NUL，工作目录恒为包的状态目录（子进程传来的 `cwd` 不用），环境是服务的环境加上 `env` 里通过任务计划同一判定（`backends/shared/installed-env.ts`）的变量，超时默认 30 秒、至多 120 秒，输出默认 256 KB、至多 1 MB，每包同时至多 4 个（429），没有标准输入；底层是进程内宿主用的同一个 `runProcess`。这是同意的边界，不是隔离：命令在沙箱外以运行 Riffet 的用户的身份运行，参数由包决定，声明解释器的包可执行任意代码。日志只记命令名、参数个数、耗时和退出码。
- `host.tasks.start` 需要 `tasks.run`，由进程内包得到的同一个实现服务：只能启动包自己的任务提供方，任务服务仍对每条新计划确认，`confirm` 原样传入；包没有声明任务提供方时宿主没有 `tasks`，答 501 `PLUGIN_HOST_UNSUPPORTED`。
- 同步成员的预载事实：随 `load` 与 `state` 送给子进程（每次调用前，只要设置、密钥或下列内容变了就重送）：`executables: { [名字]: 是否已安装 }`（只有持有 `process.exec` 时非空）和 `modelSourcesInUse`（包自己声明的模型源 id 中被已保存档案使用的）。子进程里 `resolveCli(name)` 在该名字为真时返回 `name` 本身（包看不到宿主路径），`modelSourceInUse(id)` 查这份列表，`tasks` 只在被授予 `tasks.run` 时存在（`load` 带 `granted`）。这些是协议的可加性增加，缺省时子进程按空处理，所以 `RUNTIME_PROTOCOL_VERSION` 不变。
- 命令凭据：模型源 `resolve()` 的 `credential: { kind: 'command', command, args }` 在持有 `process.exec` 且 `command` 是声明的名字、`args` 合乎上述限制时被接受，宿主把 `command` 解析为绝对路径再交给驱动；该命令之后由 Agent CLI 自己运行（Claude Code 的 `apiKeyHelper`、Codex 的 `auth.command`），在沙箱外。
- 项目只以句柄出现：宿主为一次任务调用（`detect`、`actions`、`plan`）发一个随机句柄，绑定那次调用的 `ProjectContext`，调用结束即失效；`project.exists/readText/list` 需要 `projects.read`，句柄无效、过期或不属于本包的一律 403 `PLUGIN_HANDLE_INVALID`。路径限定、符号链接检查仍由宿主的 `ProjectContext` 完成，包看不到绝对路径。
- 任务计划（`TaskPlan`）只由宿主的任务服务在用户发起任务后执行，并照常校验。
- 子进程发来的请求同时不超过 64 个，未知方法得 404 `PLUGIN_UNKNOWN_HOST_CALL`。

**进程生命周期**：激活时启动，停用时先对子进程发 `dispose`（执行包登记的清理，至多约 5 秒），再结束进程。每个调用都有期限（激活 30 秒，模型目录 60 秒，状态 8 秒等），进程退出、协议错误或调用超时都使该插件失败：撤下它提供的功能，状态显示原因，依赖它的插件先关闭，管理功能不受影响，服务不受影响。已提交的激活失败后自动重启（2 / 10 / 60 秒，见「生命周期」），三次都失败则保持关闭，直到下一次显式开启或刷新。

**本阶段支持的扩展点**：模型源、任务提供方、操作（含设备码登录）、命令（`Contributions.commands`）、头像风格（`Contributions.avatarStyles`）、状态、doctor 检查，以及静态声明（视图、外观、任务声明）。不支持的有：Agent 后端（声明了 `contributes.agentBackends` 的包在安装时被拒绝：「agent backends need a trusted package in this version」）、分享发布目标、运行时钩子。

- 模型源的 `resolve()` 是同步的，跨进程做不到，所以代理保存「每组 overrides 最近一次的结果」：`ModelSourceProvider` 增加可选的异步 `prepare(overrides)`，激活后对默认值预取，目录读取（`sourceCatalog`）前核心先 `await prepare`，缓存超过 60 秒的 `resolve` 在后台刷新。没有预取过的 overrides 先返回 `reason`「尚未准备好」，并触发一次预取。子进程返回的结果逐字段校验：地址只能是 http(s)，凭据只能是静态密钥，或持有 `process.exec` 时指向声明的可执行文件的 `command` 凭据（它会在沙箱外执行：Claude Code 的 `apiKeyHelper`、Codex 的 `auth.command`）；其他 `command` 凭据使该源返回 `reason`。声明了 `contributes.modelSources[].hosts` 的源另受地址限制：`endpoints[*].baseUrl`、`claudeBaseUrl`、`codexBaseUrl` 和描述里的 `defaultEndpoint` 的主机必须匹配声明，或是用户输入的地址（该次调用的档案 `apiEndpoint`、本包 `text` 设置中的 http(s) 地址），否则 `resolve` 返回 `reason`，地址不交给驱动；`defaultEndpoint` 不符时激活失败。未声明 `hosts` 的源保持原行为。`host.gateway.fetchModels` 由服务进程发起，不在沙箱内，所以宿主在请求前按字面主机名检查（不做 DNS 解析）：目标是回环或未指定地址上的服务自己的端口时一律拒绝；链路本地地址（169.254.0.0/16、fe80::/10）除非是用户输入的地址也拒绝；包声明了 `hosts` 时目标须匹配声明或为用户输入的地址。该请求只在原 origin 内跟随重定向，重定向不改变主机。
- 模型源的可选 `usage(overrides)` 通过 `modelSource.usage` RPC 返回 `NativeBackendUsage`。激活描述只在提供该方法时声明能力，宿主校验并投影账号窗口、余额和模型状态，不透传包的其他字段。额度使用 profile 自己的地址和凭据，与 CLI 登录账号分开；旧包省略此方法仍可正常提供模型。
- 命令：子进程在激活结果里列出命令 ID，宿主对每个生成代理，由命令路由（`POST /api/integrations/:id/commands/:name`，声明、范围、`when`、参数的检查都在路由里）调用；调用带 `projectId`、`sessionId`、已校验的 `args` 和 `timeoutMs`，子进程在期限前 5 秒中止 `signal`（60 秒的调用期限同其他调用，超过使该插件失败），插件关闭时也中止。返回的 `CommandResult` 逐字段校验（`done` 的消息至多 16 种语言、各 500 字；`open` 至少有 `view`、`sessionId`、`path` 之一，`path` 为项目内相对路径；`task` 要有 `taskId`），不合格是协议错误。持有 `tasks.run` 的已安装包有 `host.tasks.start`，命令可以启动自己提供方的任务。
- 头像风格：子进程在激活结果里列出风格 ID，宿主对每个生成代理，调用 `avatar.generate` 取回 SVG（调用期限 10 秒，核心自己另有 5 秒的等待，超过使该插件失败）；返回值必须是字符串，之后同在进程内的风格一样由核心校验、栅格化。
- 子进程回复的错误只保留 400、404、409、422 四种状态，其余（含 401、403、5xx 和没有状态）一律 502：状态由包自选，不能冒充服务端自己的结论（401 会被当作登录失效，403 当作权限不足）；错误码限 `^[A-Z][A-Z0-9_]{0,63}$`，否则取 `INTEGRATION_ACTION_FAILED`，消息至多 2000 字。
- 模型源 ID：已安装的包只能提供 `<插件 id>.<名称>`（名称为小写字母、数字、连字符，全长至多 64），激活时检查，不合格激活失败并写明。模型源 ID 存在档案里、档案带 API Key，若允许任意 ID，包可以在内置源（ID 不含点，插件 ID 一定含点所以不会撞）未启用时占用它的 ID 并收到档案的密钥；名称不含点，使 `a.b` 的 `c.d` 与 `a.b.c` 的 `d` 不会重名。
- 任务提供方的 `diagnostics` 可以是异步的（任务服务 `await` 它）。子进程不知道项目的位置，`relativize` 在子进程里是恒等函数，宿主把返回的每个 `file` 再交给真正的 `relativize`，项目之外的路径连同行列一起被丢弃。
- `agentProfiles` 对所有插件收窄：只回答该插件自己 `contributes.agentBackends` 声明的 Agent，其他后端返回空（档案配置里有 API Key），没有声明时没有这个成员；已安装的包完全没有。

### 命令行

`riffet plugin install <路径> [--yes | --grant a,b]`、`list`、`select <id> <版本>`、`uninstall <id> <版本>`、`delete-data <id>`。服务在运行时通过接口执行（登录方式同 `riffet pair`），安装路径只接受来自本机的请求；服务没有运行时直接改文件与记录，下次启动生效，安装时同样拒绝保留的 `riffet.` 命名空间和内置插件的 ID（开发包的 ID 离线时不可知，下次启动时冲突者被拒绝）。不带 `--yes` 或 `--grant` 时只列出包要求的能力，不安装。

## plugins.json

位于数据目录，权限 0600，原子写入：

```json
{ "version": 1, "items": { "<id>": { "enablement": "auto", "settings": {}, "secrets": {} } }, "defaultSharePublisher": "<id>" }
```

`defaultSharePublisher` 可省略：新分享用哪个发布目标，存在这里是因为它属于插件而不是某个 Agent 或设置项，settings.json 也拒绝未知字段。未设置，或所选插件未启用时，用第一个启用的发布目标。已有分享不受影响，总是用记录里的发布方。启用了多个发布目标时，Web 的「会话分享」设置和 Mac 的分享窗口显示选择器，只有一个时不显示。

与 settings.json 分开，因为后者拒绝未知字段。本构建不认识的条目原样保留。文件无法解析时，所有插件视为关闭，且不会被覆盖，doctor 会提示修复或删除。密钥只在服务端读取，接口只返回是否已设置。

## 接口

协议特性 `integrations-v1`：

- `GET /api/integrations`：`{ integrations: PluginDescriptor[], recovery?: boolean }`，上一次的判定结果
- POST /api/integrations/recovery：{ enabled: boolean }，暂停外部插件或恢复原启用策略，返回列表与 recovery
- POST /api/integrations/:id/reload：重建该插件及依赖它的运行时；相关插件仍有任务时返回 409 PLUGIN_TASKS_RUNNING
- POST /api/integrations/:id/diagnostics：只检查该插件，返回 { id, label, status, detail, fix? } 数组；运行时检查上限三十秒，不隐式检测其他插件
- `POST /api/integrations/refresh`：重新判定后返回同样的列表
- `PATCH /api/integrations`：`{ defaultSharePublisher?: id | null }`，返回列表
- `PATCH /api/integrations/:id`：`{ enablement?, settings?, configRevision?, force? }`，`null` 或空串清除
- `POST /api/integrations/:id/actions/:action`：返回 `ActionStep`
- `POST /api/integrations/:id/flows/:flowId/poll`：设备码登录的一次轮询
- `POST /api/integrations/development`：本机 `{ path }` 注册或重载可信开发目录，返回描述符；`DELETE /api/integrations/development/:id` 解除持久关联，返回列表
- `POST /api/integrations/install`：安装。`multipart/form-data`（`package` 是 .tgz，`grant` 是能力名的 JSON 数组或逗号分隔），或 `{ path, grant }`（本机路径，只接受来自本机的请求）；返回描述符
- `POST /api/integrations/:id/versions/:version/select`：选择版本，返回描述符；新版本启动失败得 409 `PLUGIN_ACTIVATION_FAILED`，原版本继续运行
- `DELETE /api/integrations/:id/versions/:version`：卸载一个版本，返回列表
- `DELETE /api/integrations/:id/data`：删除插件的数据目录与备份，返回列表
- `GET /api/integrations/:id/files/*`：开发包与已安装包交给客户端的文件（Web 入口、声明引用的文件、`assets/` 与 `web/`），不含服务端代码
- `GET /api/shares/capability?publisher=<id>`：指定发布方的能力，未启用时回到默认发布方；多个发布目标启用时，响应带 `publishers`

## 插件管理产品（2026-11-07）

Web 和 macOS 在工作台侧栏提供独立「插件」入口，命令面板也可打开；无项目时同样可用。Agent 的 skills、MCP 等原有管理入口标为「扩展管理」。插件入口位于「收藏夹」下方，页面按静态声明分为「Agent 与模型」「工作台」「服务与分享」，停用不改变分组。每行直接启停，功能与配置就地展开；低频的权限与诊断操作折叠。搜索、状态筛选、安装授权、版本、卸载与数据删除、重载和恢复模式均保留。模型、外观等业务选择器保留在各自页面；插件视图的宿主标题栏提供返回所属插件的入口。内置包、开发包和安装包都在同一列表，版本操作只适用于安装包。

配置草稿捕获描述符的 configRevision，保存时带回；服务端在写入前比较，不一致返回 409 PLUGIN_CONFIG_CONFLICT。revision 为随机标识，与密钥内容无关；密钥从不回传，空白未编辑不覆盖已有密钥。Web 离开页面或换插件时确认未保存修改；Mac 的工作台模型保留草稿，换插件和重新读取前确认。连接不同服务时清除 Mac 草稿，旧连接迟到的结果不会更新当前页面。

恢复模式持久化在 plugins.json 的 recovery 字段，先于外部插件的 detect 执行；内置包不暂停，每个插件原本的 on/off/auto 保持不变，服务重启后仍有效。运行任务沿用现有等待停用规则。命令行 riffet plugin recovery on/off 可在服务停止时修改恢复状态，并取得状态目录锁；reload <id> 和 diagnostics <id> 需要正在运行的服务。

安装渠道是本地 TGZ/ZIP/TAR 上传、本机 CLI 目录安装和按 ID 从静态索引安装；索引可以有多个源（内置的公共源加用户添加的源），已装的包固定在它安装时的源，只从该源更新，换源要先卸载（见 [插件市场](PLUGINS.md#插件市场)）。更新由用户显式执行（`riffet plugin update` 或客户端的更新入口），没有后台自动更新，也不做作者签名认证；`riffet plugin index build` 可以为任意静态主机生成索引。完整性哈希用于发现内容变化，不代表作者身份认证。


## 独立分发与后续改进（2026-11-09）

除 Cursor、Canvas 外的插件源码位于独立的外部插件仓库；每个插件独立声明、构建、打包和安装。默认隔离安装维持原边界，本机 `--trusted` 安装通过版本记录显式获得同进程执行权限，承接命令凭据、分享发布器、运行时钩子及构建命令。完整行为以 [插件开发指南](PLUGINS.md) 的信任级别与格式表为准；本文此前“已安装包不支持”的描述均指默认隔离安装。

同类产品的可参考设计与 Riffet 的下一步：

| 优先级 | 改进 | 当前实现 | 官方参考 |
| --- | --- | --- | --- |
| P0 | SDK 固定版本与 manifest JSON Schema | 已交付独立 JS/类型 SDK 归档、固定版本依赖、统一 manifest 校验与 JSON Schema；每个插件可以脱离相邻 checkout 构建 | [VS Code manifest](https://code.visualstudio.com/api/references/extension-manifest)、[Raycast publishing](https://developers.raycast.com/basics/publish-an-extension) |
| P0 | 分开表示来源、完整性和执行信任 | 每个版本分别记录来源、内容摘要和可信选择；客户端展示实际执行位置。发布方签名仍属 P2 | [Raycast security](https://developers.raycast.com/information/security)、[Obsidian security](https://obsidian.md/help/plugin-security) |
| P1 | 按需激活 | 已实现模型源、命令/登录、任务、视图的按需激活，静态目录不执行代码，缺省旧包仍启动激活，懒升级失败也恢复最近成功版本 | [VS Code activation events](https://code.visualstudio.com/api/references/activation-events) |
| P1 | 声明式跨端界面与能力协商 | Web/Mac 共同承接 tasks/list/form/detail，客户端独立验证版本与所需能力；桥扩展当前项目分页、请求取消和数据失效订阅 | [Raycast manifest](https://developers.raycast.com/information/manifest)、[VS Code extension host](https://code.visualstudio.com/api/advanced-topics/extension-host) |
| P1 | 可归因的运行日志与开发重载 | 已实现按 ID/版本/代次归属的有限持久日志、阶段耗时、脱敏、CLI/Web/Mac 查看和内容快照开发重载 | [Raycast debugging](https://developers.raycast.com/basics/debug-an-extension)、[Obsidian lifecycle](https://docs.obsidian.md/plugins/guides/lifecycle-management) |
| P2 | 更新源和发布认证 | 复用已有固定版本、授权差异、备份和失败回退，先做显式检查与更新（已做：多源索引、按源固定、`plugin update`）；后台自动更新和发布签名排后 | [Raycast publishing](https://developers.raycast.com/basics/publish-an-extension) |

P0、P1 项已按上述范围实现；P2 中，多源市场与显式更新已实现；后台自动更新和发布签名尚未实施。竞品对比依据官方文档，没有运行竞品进行性能或安全实测。完整接口与开发命令见 [插件开发指南](PLUGINS.md)。

### 开发与打包的统一入口

`riffet plugin pack [源码目录]` 自动构建、校验并原子写入插件自己的 `dist/package/` 和归档。`riffet plugin dev [源码目录]` 使用同一构建器；纯资源包不需要 Node 工程。多入口仅在插件自己的 `package.json.riffetPlugin.build.entries` 声明一次。高级 SDK build/check 与旧源码脚本均复用公共工具，不再维护第二套打包逻辑；低层 `packPlugin` 仍只归档调用方准备好的目录。

CLI 的编译器由宿主运行依赖提供，不查找插件私有编译器；生产 runtime manifest 包含 esbuild 及其本机 optional binary。macOS payload 沿用忽略安装脚本的策略，给 binary 加入应用签名，许可随第三方 notices 收集。详细命令、失败保留与开发关联生命周期见 [插件开发指南](PLUGINS.md#开发配置与-sdk)。

### 页面安装信任与整插件移除

本机 Web/Mac 上传与 CLI 路径安装使用相同的版本信任记录；multipart `trusted=true` 必须来自 loopback、无代理头、`Host` 为回环名，且通过认证/CSRF。隔离校验遇到需要宿主能力的包，返回结构化 `PLUGIN_TRUST_REQUIRED`，客户端显式确认后重传；`requiresTrustedHost` 只描述需求，不授予执行权限。保留旧模型源 ID 等兼容包使用同一确认流程。

整插件 DELETE 在管理队列中处理 `source` 和开发目录 `path`，以描述符的 `developmentPath` 精确定位同 ID 的不同来源和目录。安装包一次移除所有版本，开发包持久排除自动发现；均保留设置和数据，检查运行任务，先保存移除记录再停止匹配的作用域。坏包或目录暂时不存在时仍保留管理目标，不能借用同 ID 健康插件的身份。描述符 `developmentLinked` 仍只表示保存的关联，原 unlink 接口保留。dev 首次成功构建建立关联，后续仅重载，已解除的关联不会被 watcher 恢复。
