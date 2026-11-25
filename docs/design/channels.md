# IM 通道方案（首个：飞书机器人）

日期：2026-11-11；2026-11-18 改为插件扩展点（见「插件化」）。范围：服务端、Web 设置页、插件 API。状态：通道层、飞书与插件化均已实现。

在飞书里和 Riffet 的会话对话：私聊或群里发消息，服务按聊天选定的项目新建或继续会话，把思考、工具和回答实时写回一张卡片，审批和提问也能在飞书里直接回答。飞书就是又一个客户端，和 Web、Mac、手机看到的是同一批会话、同一个交互。

通道层放在服务端核心，与具体 IM 无关；具体 IM 是插件实现的 `imChannels` 扩展点，飞书和 Telegram 是首批内置实现（`riffet.channel-feishu`、`riffet.channel-telegram`），后续 Slack、Discord 等只新增插件。卡片、流式与过程消息的做法沿用已在生产环境验证过的飞书机器人实践；但不把平台调用写进会话主流程，平台细节都留在适配器里。

## 已定决策

| 问题 | 决定 |
| --- | --- |
| 部署 | Riffet 可能在任意服务器上；只要求服务能主动连出飞书，不要求公网入口 |
| 代码位置 | 通道层在服务端核心 `apps/server/src/channels/`；具体 IM 是插件扩展点 `imChannels`，飞书与 Telegram 为内置插件 `riffet.channel-feishu`、`riffet.channel-telegram`（2026-11-18 修改，原为「不做插件扩展点」） |
| 聊天范围 | 私聊、群聊、话题群都支持 |
| 谁能使用 | 只有绑定过的飞书账号；群里其他人的消息忽略。按群授权全部成员以后再做 |
| 会话粒度 | 默认一个话题一个会话，群里新的 @ 消息开新会话；可把某个群设为整群共用一个会话 |
| 项目 | 以聊天为单位绑定项目，首次使用时选择，`/project` 切换；飞书里不新建项目 |
| 审批 | 不区分端，任一端先回答者生效 |
| 双向同步 | 飞书发起的会话，在其他端继续时的回合也同步显示到飞书 |
| 主动推送 | `notify_user`、自动化与 wake-up 结果、待确认提醒推到绑定用户的私聊（P2） |
| 多应用 | 数据结构按一个服务接多个飞书应用设计，第一版设置页只配一个；支持飞书与 Lark 两个域名 |
| 配置入口 | 第一版只做 Web 设置页；扫码创建为主，手动填写兜底 |

## 架构

```
ImChannelProvider（插件 plugins/riffet/channel-feishu、plugins/riffet/channel-telegram 等）
   │ 入站消息 · 卡片回调                 ▲ 渲染 TurnView · 交互卡 · 通知
   ▼                                     │
ChannelService（channels/，与 IM 无关）
   ├ 身份：账号绑定与门禁
   ├ 绑定：聊天 → 项目，会话地址 → sessionId
   ├ 入站：去重 → 命令 / 新建会话 / 续聊
   ├ 投影：timeline 行 + 控制状态 → TurnView
   ├ 交互：status.interaction → 交互卡；回调 → respondInteraction
   └ 收口：回合结束出最终视图；重启后补收口
   │
store · dispatch · timeline · nativeBackends · notices（已有）
```

`ChannelService` 只依赖已有服务，和 `OrchestrationService` 一样在 `createApp` 里组装（`apps/server/src/app.ts:208` 之后），关闭顺序排在 `dispatch` 之前。

### 目录

```
apps/server/src/channels/
  types.ts        ChannelProvider / TurnSurface / TurnView / 入站消息类型
  service.ts      ChannelService：生命周期、入站管线、回合跟随
  bindings.ts     聊天与会话绑定、出站消息记录（store settings 表）
  identity.ts     账号绑定码与已绑定身份
  follow.ts       会话跟随：timeline、控制状态、回合变化
  projector.ts    TimelineRow → TurnView
  commands.ts     /new /stop /project /status /bind …
  routes.ts       /api/channels/*（设置页用）

plugins/riffet/channel-feishu/   飞书内置插件（插件化之后；之前在 apps/server/src/channels/feishu/）
plugins/riffet/channel-telegram/ Telegram 内置插件
  index.ts        清单：contributes.imChannels
  activate.ts     返回 Contributions.imChannels
  provider.ts     ImChannelProvider 实现
  connection.ts 长连接与事件归一化
  openapi.ts    tenant token、fetch、错误分类
  cards.ts      回合卡、交互卡、项目选择卡、简卡
  markdown.ts   Markdown → 卡片元素
  cot.ts        原生 COT 消息：创建、追加事件、收口
  surface.ts    一个回合的 COT 与答案卡：节流、更新、降级与拆卡
```


## 插件化

2026-11-18：具体 IM 是插件扩展点 `imChannels`，飞书是首个内置插件（现命名 `riffet.channel-feishu`，默认启用；同期新增 `riffet.channel-telegram`）。通道层（入站管线、门禁、绑定、会话跟随、投影、命令、交互、收口、持久化、路由）留在核心，作为这个扩展点的宿主实现；插件只实现平台适配器，不碰会话、绑定与身份，因此不需要扩大 `host.sessions`。

### 扩展点

| 项 | 定义 |
| --- | --- |
| 清单 | `contributes.imChannels: [{ id: '<plugin>/<name>', title }]`，最多 16 个。不用 `channels`：它已是会话级 socket（`PluginChannelHandler`，浏览器插件在用） |
| 实现 | `Contributions.imChannels: Record<string, ImChannelProvider>`，按声明 ID 取；注册表校验每个实现都已声明并带 `connect` 与 `links` |
| 类型 | `packages/plugin-api/src/im-channel.ts`：`ImChannelProvider`、`ChannelConnection`、`ChannelContext`、`TurnSurface`、`TurnView`、`InteractionView` 等；核心 `channels/types.ts` 从插件 API 导入，只另加 `ChannelProvider`（实现加上它的声明 ID） |
| 范围 | 拟议成员（`PROPOSED_CONTRIBUTIONS`），只给进程内插件 |
| 生命周期 | 核心每次从注册表读当前的实现；注册表 `onChange` 时，平台出现、消失或换了实现的已启用账号重新连接。插件关闭时连接断开、状态显示「提供这个通道的插件没有启用」，账号与绑定保留；重新开启后照常建连，并接管重启前未收口的回合卡 |

### 契约与数据

- `ChannelKind` 是声明 ID（如 `riffet.channel-feishu/feishu`、`riffet.channel-telegram/telegram`）。`ChannelsState.providers` 列出当前可用平台的 `id`、`title`、`register`、`fields`、`capabilities`、`card` 与 `hints`。
- 存量数据不改写：账号读取时把旧 `kind: 'feishu'` 与 `'riffet.feishu/feishu'` 视为 `riffet.channel-feishu/feishu`，把旧的顶层 `appId`/`domain` 归入 `config`，把旧的纯文本 `.secret` 文件视为 `{ appSecret }`；创建与更新接口同时接受新字段（`config`/`secrets`）和旧字段（`appId`/`appSecret`/`domain`），返回体保留兼容的 `appId`/`domain`，旧版 Mac 客户端照常可用。新账号 ID 用声明名的最后一段（如 `feishu-1a2b3c4d`、`telegram-1a2b3c4d`），保持为一个 URL 段。
- 表单字段与平台提示由各插件的 `ImChannelProvider.meta` 声明，核心按字段定义做校验与存储，不再写死飞书的 `appId`/`appSecret`/`domain` 或长连接检查步骤。

### 设置页

- Web 的「机器人」页按 `providers` 渲染平台选择、扫码或字段表单、卡片能力开关、检查清单和平台文案；没有可用平台时空状态提示在插件中启用机器人通道，不显示添加。

### 现状

- Mac 的「机器人」设置（`ChannelsSettings.swift`、`ChannelsModel.swift`）已冻结（M 类），仍发送旧格式字段，靠服务端的兼容读取和兼容响应字段工作。

## 核心模型

**适配器契约**

```ts
interface ChannelProvider {
  kind: string;                                    // 'feishu'
  capabilities: {
    edit: boolean;                                 // 能原地更新已发消息
    actions: 'forms' | 'buttons' | 'none';
    threads: boolean;
  };
  connect(account: ChannelAccount, ctx: ChannelContext): Promise<ChannelConnection>;
}
interface ChannelConnection {
  status(): ChannelConnectionStatus;               // 设置页与 doctor 读取
  openTurn(addr: ChannelAddress, view: TurnView, at?: ReplyAnchor): Promise<TurnSurface>;
  showInteraction(addr: ChannelAddress, it: NativeInteraction): Promise<SentRef>;
  closeInteraction(ref: SentRef, outcome: InteractionOutcome): Promise<void>;
  pickProject(addr: ChannelAddress, projects: ProjectChoice[], at: ReplyAnchor): Promise<void>;
  send(addr: ChannelAddress, text: string, at?: ReplyAnchor): Promise<SentRef>;
  close(): Promise<void>;
}
interface TurnSurface {
  update(view: TurnView): void;                    // 适配器自行节流与合并，不抛异常
  finish(view: TurnView): Promise<void>;           // 每条终态路径都必须调用
  ref(): SentRef;                                  // 持久化用于重启后接管
}
interface ChannelContext {
  inbound(message: InboundMessage): void;
  action(action: InboundAction): Promise<ActionReply>;   // 同步回卡片的结果
  signal: AbortSignal;
}
```

`ChannelContext` 只暴露这两个入口，适配器拿不到 store 或会话服务。

**入站消息**（各平台归一化后）

```ts
interface InboundMessage {
  account: string;                     // 通道账号 id（一个飞书应用一个）
  messageId: string;                   // 平台消息 id，作为去重键与 commandId
  address: ChannelAddress;             // { chatId, chatType: 'p2p'|'group', threadKey }
  sender: { id: string; name?: string };
  text: string;
  attachments: InboundAttachment[];    // 平台文件句柄，按需下载
  mentionsBot: boolean;
  inThread: boolean;
}
```

**TurnView**：核心输出的唯一渲染输入，与平台无关。

```ts
interface TurnView {
  status: 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  source: 'channel' | 'other-client';  // 其他端发起的回合要标出来
  prompt?: string;                     // 其他端发起时随卡展示
  steps: TurnStep[];                   // thought / tool / plan / narration，按出现顺序
  answer: string;                      // Markdown
  error?: string;
  footer: { model?: string; backend?: string; elapsedMs?: number };
}
```

`projector.ts` 从 `TimelineService.subscribe(sessionId, 'main')` 的行折叠出 `TurnView`：`thought` 和 `assistant(phase: commentary)` 进入 `steps`；`tool` 用工具标题与状态；`assistant(final_answer)` 是答案，没有时取最后一条非 commentary 的 assistant；`status` 行写进 `error`。工具标题现在只在 Web 端生成（`apps/web/src/app/session/toolView.ts:75`，依赖 lingui），先把不含文案的部分下沉到 `packages/timeline`，Web 和通道共用。

## 会话映射

| 键 | 组成 | 用途 |
| --- | --- | --- |
| 聊天键 | `account:chatId` | 项目绑定、整群共用开关 |
| 会话地址 | 话题：`account:chatId:threadKey`；共用：`account:chatId:*` | → sessionId |

飞书的 `threadKey = root_id ?? parent_id ?? thread_id ?? message_id`。话题群首条消息只有 `thread_id`、后续才有 `root_id`，所以同一个会话按两个键都写入绑定，命中一个就补写另一个。`thread_id` 不能拿 `root_id` 兜底，否则引用回复会被当成话题。

- 群里顶层 @ 消息：开新会话，回复用 `reply_in_thread` 开出话题。
- 已绑定会话的话题里，绑定用户的消息不需要 @。
- 私聊：默认每条顶层消息开新会话、在话题里续聊；`/new` 之外不额外区分。
- 聊天还没有项目时，先回一张项目选择卡并暂存这条消息，选完直接发出，不需要重发。暂存只保留最近一条，10 分钟过期。
- 会话由通道新建时 `origin = { kind: 'channel', channel: { kind, account, chatId } }`。`SessionOriginKindSchema` 是开放枚举（`packages/contracts/src/schema/session.ts:19`），TS 联合类型与移动端解码一起补上。

## 入站流程

1. **去重**：以 `messageId` 在 store 中原子登记，已处理或已拒绝过的直接丢弃；进程内另有 60 秒窗口。
2. **门禁**：发送者不是已绑定身份 → 丢弃，不回复。群消息未 @ 且不在已绑定会话的话题里 → 丢弃。唯一例外是私聊里的绑定码。
3. **命令**：`/new`、`/stop`、`/project`、`/status`、`/flat on|off`（群）、`/bind <码>`。其余 `/` 开头的原样交给会话，保留各 CLI 自己的斜杠命令。
4. **项目**：聊天未绑定项目 → 项目选择卡（见上）。
5. **附件**：图片与文件先经飞书 API 下载，再 `workspace.upload()`，得到的 id 放进 `NativeRunInput.attachmentIds`（上限 20、单个 24 MB）。
6. **提交**：
   - 无绑定会话：`resolveNativeSessionInput(deps, { projectId })`（`native/session-input.ts:30`）取项目与 Riffet 的默认后端、模型、模式和审批；再 `store.createNativeSubmission(uuid, input, commandId = messageId, run)`、`dispatch.kick()`，写入地址绑定。
   - 已有会话：`sessionCommands.admit`、`nativeBackends.assertAvailable`、`store.acceptNativeRun(sessionId, messageId, run)`、`dispatch.kick()`。回合进行中由已有队列排队，卡片显示排队中。
7. 在用户消息上加表情回应表示已收到（飞书 `Typing`），回合结束后换成完成。

## 出站

### 跟随会话

通道对每个已绑定、有未结束回合的会话持有三份订阅，回合全部结束后释放：

- `timeline.subscribe(id, 'main')`：行变化 → `projector` → `surface.update`。
- `nativeBackends.watchControl(id, …)`：状态、排队与 `status.interaction`。必须持有它，provider 的监听才保持开启。
- `store.onRunChanged`：回合开始与结束。

另外常驻一个 `store.onRunChanged` 监听：已绑定会话出现新回合时开始跟随。这个回合的 `commandId` 不是通道发出的，就是其他端发起的，卡片带上 `source: 'other-client'` 与提问原文，发在该会话的话题里。

`SyncService.attach`（`sync/service.ts:91`）也组合了这几份订阅，但逻辑围绕 SSE 帧（hello、快照、去重重发），共用部分只有几行订阅调用，所以通道在 `channels/follow.ts` 里自己组合，不重构 sync。

### 回合收口

- `completed`：答案取 `timeline.turnText()`（`timeline/service.ts:205`），与流式累积的答案不一致时以它为准。
- `failed`、`cancelled`、`interrupted`：`turnText` 不返回，保留已流出的答案，加状态与错误说明。
- 中断后的正文只用答案部分，不拿思考内容充当正文（曾有实现在中断时把几十万字的思考内容当正文发出）。

### 交互

`status.interaction` 出现时，发一张独立的交互卡回复到会话话题：

- `permission`、`confirmation`、`plan`：按 `actions` 生成按钮。
- `question`、`choice`：每题一个下拉选择，`allowOther` 时加一个输入框，加提交。
- 回调用 `respondInteraction(session, { interactionId, revision, requestId: 回调事件 id, action, selectedIds, otherText })`，在 `sessionLock.withSession` 内执行。
- 交互结束（任一端回答、过期或回合结束）时，把卡片改成结果状态；revision 不匹配的点击回 toast「已在其他端处理」。

### 主动推送（P2）

订阅 `notices`（`riffet-mcp/notices.ts`）并转发到绑定用户的私聊；未绑定会话出现待确认交互时，在私聊里发交互卡，可直接作答。

## 飞书适配器

### 连接

- 用 `@larksuiteoapi/node-sdk` 的 `WSClient` 加 `EventDispatcher` 收事件。长连接帧是 protobuf，自己用现有的 `ws` 重写协议不划算，这是唯一新增依赖。其余 OpenAPI 一律走自己的 `fetch`：tenant token 按应用缓存、到期前 60 秒刷新、并发合并；错误按码分类（审核 `230028`、限流 `429`/`230020`、卡片超限 `230099`/`11310`、构建失败 `200800`、图片 key 无效 `200570`）。
- 订阅 `im.message.receive_v1`、`card.action.trigger`。收消息的处理不等待；卡片回调必须 `return await`，把新卡片作为同步响应返回，只靠异步 PATCH 刷新的卡片会闪回旧状态。
- 启动先 `GET /bot/v3/info` 取机器人 `open_id`（判断 @ 用），建好连接后再做恢复。SDK 的 `start()` 在真正连上前就返回，就绪要另行判断（SDK 日志出现 ready 或内部 `readyState === 1`）。
- **同一个应用只能有一个 Riffet 实例连接**，多个连接会被飞书随机分发事件，表现为丢消息。设置页写明这一点，并显示连接状态和最近一次收到事件的时间。
- 域名：飞书 `open.feishu.cn`，Lark `open.larksuite.com`，按账号配置。

### 回合卡（Card JSON 2.0）

```
header     会话标题 · 副标题为模型
[来自其他端] 提问原文（只在其他端发起时出现）
答案        按块拆成 markdown / table 元素
过程条      进行中：loading + 中断按钮；结束后换成 footer（耗时 · 模型）
```

- 过程（思考、工具、旁白）只走飞书原生 COT 消息：`POST /im/v1/message_cot` 创建，`PUT` 追加 AG-UI 事件，`POST /im/v1/message_cot/complete/{cot_id}` 收口，需要 `im:message_cot` 权限。它不占卡片预算，客户端自带折叠、展开与停止。卡片里不做过程面板；COT 创建失败时这一回合不显示过程，只出答案卡。
- COT 规则（不需要单独申请权限）：`RUN_STARTED` 必须是第一条事件；每条终态路径（完成、失败、中断、进程退出、重启恢复）都要 `RUN_FINISHED`/`RUN_ERROR` 再 complete，否则客户端一直转圈；每批不超过 50 个事件、content 按 UTF-8 字节不超过 4096；`reply_in_thread` 时带上 `origin_message_id`；约 300ms 或攒满 40 个事件批量发送，连续失败熔断后只停追加、不停收口。
- 思考分组不跨工具调用：工具开始前结束当前思考组，之后的思考换新 id。
- 答案卡在出现第一段答案时才创建，避免过程阶段挂一张空卡。
- 进行中的卡片不放更多菜单，管理类动作只放在最终卡上。
- 图标用飞书 `standard_icon` 官方白名单；无效 token 放在 header 或按钮上会让整卡发送失败（`200621`）。

### 流式更新

- 默认整卡 PATCH。触发条件是「新增字数达阈值 **且** 距上次更新超过间隔」，同一时间只有一个请求在途，期间的变化合并到下一次。阈值随长度增长：2K 字以内每 15 字，2K 以上 64 字，8K 以上 128 字；间隔起点 500ms，按预算自适应到 3s；300ms 兜底刷出尾巴。
- 全进程 PATCH 预算约每 2 分钟 60 次，单个聊天不超过 45；遇到 `230020` 指数退避。
- 空内容不推送，否则会洗掉进行中的状态。
- CardKit 元素级 PUT（打字机效果）作为 P2 优化：sequence 按卡片和元素严格递增，连续失败降级回 PATCH，降级时卡片去掉 `streaming_mode`。

### 卡片体系

除流式回复卡外，所有卡片（命令、模型、项目选择、交互、通知、错误）都由 `channel-feishu/kit.ts` 的基础组件拼出，不在各处手写 JSON。

**结构**：标题栏 → 主内容 → 次内容（可选）→ 操作（可选）→ 提示（可选）。主内容不省略，哪怕只有一行也包一个色块；只有一类信息时不硬拆次内容。

**颜色**：只用一个灰色家族，不跟随任何彩色主题。

| 令牌 | 值 | 用途 |
| --- | --- | --- |
| 标题栏 | `template: 'default'` | 所有卡片，可带一行副标题；不随状态变色 |
| `HERO` | `grey-100` | 主内容色块 |
| `SUB` | `grey-50` | 次内容色块，多组时与 `HERO` 交替 |
| `STRONG` | `grey-200` | 出错或需确认的主内容，整卡至多一块 |
| 强调 | 加粗 | 不用彩色字；状态的成败只在流式卡页脚的增删行用绿 / 红 |

危险操作用飞书按钮自带的 `danger` 类型，这是按钮局部颜色，不算换色。

**排版**：命令类列表一行命令（加粗）、下一行两个全角空格缩进的灰色说明，窄屏折行也对得齐。选择控件放在色块里，上方一行加粗标签，控件占满宽度；会改变卡片结构的下拉框不放进表单（表单内下拉不触发回调）。

**反馈**：按钮或下拉的即时回执用 toast（12 字内，从不写"失败"）；同一意图的状态变化以回调同步返回的新卡片原地重画；新结果、所有失败发新卡（`STRONG` 简卡）。

**图标**：不用装饰性 emoji；需要符号时用飞书 `standard_icon` 白名单内的图标。

### 体积与拆卡

| 限制 | 值 |
| --- | --- |
| 顶层元素 | 约 50，最终卡按 45 拆 |
| 递归元素数 | 160 起有风险，实测 202 失败 |
| 原生表格 | 每卡 5 个，管道表格也计入 |
| 表格列 | 最多 10，超出静默丢弃 |
| 元素 `name` | ≤100 字符 |

- 流式阶段不拆卡：表格超限转成代码块；元素超限改为单个 markdown 元素；超长时显示稳定前缀加最后 2000 字。同一个 `11310` 要按消息文本区分是表格还是元素超限。
- 最终阶段重新渲染并按表格数、序列化长度、元素数拆分：第一张更新原卡，其余作为回复追加。
- 审核拦截先遮蔽敏感片段重试，仍失败则整段替换为提示。

### Markdown

先解析再映射，不靠正则修补：段落、标题、列表、引用 → markdown 元素；每个代码块单独一个元素并保证围栏闭合；表格 → 原生 table，流式阶段先用管道表格文本。段落后接列表要拆成两个元素；列表里嵌套的代码块提到顶层；`<font>` 不跨行。模型写出的本地图片路径不发到飞书；会话产出的图片经 `SessionMedia` 读取后上传为 `image_key`（P2）。

Riffet 已有 `remark-gfm` 等依赖，解析用现有的 remark 管线产出 mdast，再映射到卡片元素，不自写解析器。

### 卡片回调

- 每个回调值带 `{ v: 1, kind, account, ref }`，`ref` 指向服务端记录（会话地址、交互 id、revision），不把长数据塞进卡片。
- 表单提交时飞书会清空按钮的 value，路由信息放进 `action.name`。
- 回调同样走门禁：操作人 `open_id` 必须是已绑定身份，旧卡片按当前绑定重新校验。
- 需要网络请求的动作先同步返回过渡状态，后台完成后再更新，按单调递增的版本号丢弃过时结果。

### 飞书后台配置

事件接收选长连接；事件 `im.message.receive_v1`、`card.action.trigger`；权限至少包括收发消息、读取私聊消息、读取群里 @ 机器人的消息、读取消息中的资源文件。已绑定话题里不 @ 也能继续，需要读取群内全部消息的敏感权限，没有这项权限时话题里也要 @。权限名称以开放平台后台为准，设置页和文档给出清单。

## 身份与安全

agent 在服务器上有 shell，飞书消息等同 owner 本人操作，所以只接受绑定过的账号：

1. Web 设置页生成一次性绑定码（5 分钟、单次）。
2. 用户在飞书里私聊机器人发 `/bind <码>`。
3. 服务记下该应用下的 `open_id`（`open_id` 按应用区分，换应用要重新绑定）。

- 绑定码复用 `pairing.ts` 的生成与比较，但改成按用途隔离的码池，设备配对码不能拿来绑定飞书，反之亦然。
- 应用凭据（App Secret）写入 0600 私有文件（`settings/private-file.ts`），从不返回给客户端；设置页只显示是否已配置。
- 被门禁拒绝的消息 id 也记入去重，改了绑定后不会重放旧消息。
- 设置页可以查看和解绑已绑定账号；解绑立即生效，旧卡片上的按钮随之失效。

## 持久化与恢复

全部放在 store 的 settings 表，按 `channels:*` 分键，不新增表，不改 `SettingsService` 契约：

| 键 | 内容 |
| --- | --- |
| `channels:accounts` | 账号：kind、appId、domain、启用状态 |
| `channels:identities` | 已绑定身份 |
| `channels:chats` | 聊天 → 项目、整群共用开关 |
| `channels:conversations` | 会话地址（含别名）→ sessionId |
| `channels:surfaces` | 未收口的回合卡：sessionId、runId、messageId、交互卡引用 |
| `channels:seen` | 已处理消息 id，按时间裁剪 |

重启后：连接建好，逐条检查 `channels:surfaces`。回合仍在进行就重新跟随并接着更新原卡；已经结束就按结果收口；会话不存在了就标为中断。

## 接入与管理（Web）

设置「连接」组新增「机器人」页，一个服务可接多个机器人。主路径是飞书官方的扫码创建（SDK `registerApp`，OAuth 设备授权）：扫码确认后服务直接拿到 App ID、App Secret、扫码人的 `open_id` 与租户（飞书 / Lark），不需要用户进开发者后台复制粘贴；手动填写凭据只作兜底。同类开源项目（AstrBot、LangBot、OpenClaw、Hermes）都以扫码为主路径。

### 列表页

```
机器人                                              [+ 添加]
┌──────────────────────────────────────────────────────────┐
│ (头像) Riffet              ● 已连接 · 2 分钟前         ›  │
│ (头像) 研发助手      Lark   ● 待完成 2 项              ›  │
└──────────────────────────────────────────────────────────┘
```

- 每行：机器人头像与名称（来自 `bot/v3/info`）、Lark 才显示的域名标记、状态点加一句状态；点进详情。
- 状态只有三种说法：已连接（附最近收到消息的时间）、待完成 N 项（检查清单未全过）、连接失败 / 已停用。
- 没有机器人时是空状态：一个主按钮「添加飞书机器人」。

### 添加（对话框）

```
添加飞书机器人
        ┌─────────────┐
        │  ▣ 二维码    │        用飞书扫码
        └─────────────┘        在浏览器中打开 ↗
        10:42 前有效 · 重新生成

手动填写                                          [取消]
```

1. 打开即请求 `registerApp`（不设 `createOnly`，扫码页里可新建也可选已有应用），二维码由服务端用现有 `qrcode` 依赖生成；「在浏览器中打开」给已登录飞书网页版的人。
2. 预填：名称 `Riffet`，头像用仓库公开的品牌头像，描述一句。默认模板已含收发消息、资源、表情、卡片回调与长连接事件；原生过程消息不需要额外权限。
3. 扫码确认后对话框原位切换为进度清单，逐项打勾：创建应用 → 连接飞书 → 绑定你的飞书账号（扫码人的 `open_id` 自动成为该机器人的绑定身份，名字取 Riffet 的 owner 昵称）。
4. 全部完成后只剩两个按钮：「在飞书中打开」（`applink.feishu.cn/client/bot/open?appId=`，Lark 用 `applink.larksuite.com`）与「完成」。
5. 链接过期（10 分钟）二维码变淡，按钮变为「重新生成」；关闭对话框即取消轮询。
6. 「手动填写」切到表单：App ID、App Secret、飞书 / Lark 分段选择。保存后同样进入清单，多出一项「把事件订阅改为长连接」并附「打开开发者后台」——飞书要求长连接在线时才能保存这个设置，所以这一项排在「已连接」之后。手动添加没有扫码人，绑定身份走绑定码。

### 详情页（子页面，带返回）

```
(头像) Riffet                          [在飞书中打开]  [⋯]
cli_a1b2c3 ⧉ · 飞书

待完成                                   （全部通过后整组隐藏）
  ✓ 连接飞书
  ✓ 启用机器人
  ✗ 开通权限   im:message_cot                     [去申请 ↗]
  ○ 收到第一条消息           在飞书私聊机器人发一条消息

                                                 [启用 ◉]
可以使用的人                                         [添加]
  (头像) 何某                 2026-11-11            解绑
聊天
  ◎ 私聊 · 何某               项目 [riffet ▾]          ⋯
  ◎ 研发群                    项目 [riffet ▾] 整群一个会话 ○  ⋯
```

- 检查清单由服务端实时自检：长连接在线；`GET /bot/v3/info` 的 `activate_status`；`GET /application/v6/scopes` 对照所需权限，缺的权限用 `open.feishu.cn/app/{appId}/auth?q=…&token_type=tenant` 一键跳到申请页；首条消息以 `lastEventAt` 判断。结果缓存 60 秒，页面打开时刷新。
- 「⋯」菜单：重新扫码授权（`registerApp({ appId })`，用于补权限或换 Secret）、手动更换凭据、打开开发者后台、删除。删除确认只说一句「飞书里的应用不会被删除」。
- 「添加」可以使用的人：弹出绑定码（码、有效期、`/bind <码>` 一句说明）。
- 聊天行：私聊 / 群图标、聊天名、项目下拉直接改、群才有「整群一个会话」开关；「⋯」里是「在飞书中打开」（`client/chat/open?openChatId=`）与「移除」。

### 卡片配置

详情页有一行「卡片」，进入后上方是飞书回复卡片的实时预览（可切换进行中 / 已完成），下方是开关，改动从下一条回复生效：

| 分组 | 开关 | 作用 |
| --- | --- | --- |
| 消息 | 思考过程 | 单独一条飞书原生过程消息（思考与工具调用），在卡片之前；关掉则只有回复卡片 |
| 卡片 | 标题栏 | 会话标题；飞书默认样式，不加颜色，不放副标题 |
| | 中断按钮 | 进行中的卡片底部 |
| 页脚 | 模型 | 左侧：显示名加标记，如 `Opus 5.5 · fast · high`，从不显示原始的 `model[参数]` 串 |
| | 改动行数 | 右侧：本回合编辑工具的 `+12 −3`，绿 / 红 |
| | 上下文占用 | 右侧：`上下文 42%` |
| | 耗时 | 右侧：`17s` |

页脚是左右两栏的 `column_set`，左侧模型、右侧右对齐的统计，都用灰色小字；一侧为空时只留一栏，全空时连分隔线一起不出。配置按机器人存储，修改不重连。

### 视觉

沿用设置页现有的 `SettingsGroup` / `SettingsRow`、状态点、对话框与二维码样式（与「配对新设备」一致：白底圆角二维码、等宽字、过期变淡）。机器人头像是页面里唯一的强视觉元素；不画平台 Logo，不加说明性副标题。页面文案只保留：长连接限制（同一个应用只能连一个 Riffet 服务）、删除不影响飞书里的应用、绑定码用法。

### 接口

| 接口 | 作用 |
| --- | --- |
| `POST /api/channels/registrations` `{ kind, appId? }` | 开始扫码创建或重新授权，返回 `{ id, url, qr, expiresAt }` |
| `GET /api/channels/registrations/:id` | `{ state: waiting \| done \| expired \| failed \| cancelled, accountId?, error? }`，前端 2 秒轮询 |
| `DELETE /api/channels/registrations/:id` | 取消 |
| `GET /api/channels/accounts/:id/health` | 检查清单：`connected`、`activated`、`missingScopes[]`、`lastEventAt`，以及 `botName`、`avatarUrl` |

扫码进行中的注册只在内存里，重启即失效；凭据只在服务端落盘，从不返回前端。

## 分期

**P0：私聊与群聊的闭环**

- `channels/` 核心：契约、入站管线、去重、门禁、绑定、`/new` `/stop` `/project` `/bind` `/status`
- `follow.ts` 会话跟随；`projector`；工具标题下沉到 `packages/timeline`
- 飞书：长连接、ID 归一化、私聊/群/话题映射、项目选择卡、原生 COT 过程消息、答案卡（节流 PATCH、中断、最终卡）
- `SessionOrigin` 增加 `channel`
- `pairing.ts` 按用途隔离码池
- Web「机器人」页：扫码创建、手动兜底、检查清单、多机器人管理（见「接入与管理」）
- 新依赖 `@larksuiteoapi/node-sdk`

**P1：完整客户端体验**

- 交互卡（审批、提问、多题）与其他端同步收卡
- 其他端发起的回合同步到飞书
- 重启接管与收口
- 图片与文件入站
- 最终拆卡、审核拦截处理
- 整群共用会话 `/flat`

**P2：增强**

- `notify_user`、自动化、wake-up、待确认提醒推到私聊
- CardKit 打字机效果
- 会话产出的图片出站
- `/model`、`/backend`
- 群授权全部成员

**P3**：接第二个通道（Telegram 有可编辑消息和按钮，适合验证）。不改 `channels/` 核心即接入，才算抽象成立。

## 验证

按仓库测试约定，只为核心行为补测试：门禁与身份隔离（未绑定、解绑后、旧卡片回调）、入站幂等（同一 `message_id` 只提交一次）、交互回答的 revision 与幂等、重启后收口。卡片样式与文案不写测试，用飞书真机对照检查。

## 风险与未核实

- 原生 COT 在外部租户的可用性按理可行但未实测，P0 联调时先验证。
- 终端抓屏得到的交互（Cursor、部分 Claude 界面）能否经 `watchControl` 及时推出，需要逐个后端验证。
- 话题内免 @ 依赖读取群内全部消息的敏感权限，企业管理员可能不批。
- 同一应用被两个实例连接时只能从现象判断（丢消息），无法直接检测。

## 依据

`orchestration/service.ts:177,185`（代发会话）、`native/session-input.ts:30`、`native/dispatch.ts:231,575,1139`、`timeline/service.ts:205,244`、`backends/service.ts:1205,1602,1613`、`sync/service.ts:91`、`packages/contracts/src/index.ts:576,593`、`riffet-mcp/notices.ts:14`、`pairing.ts`、`workspace/index.ts:587`
