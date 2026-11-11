# Riffet 快速对话

日期：2026-10-31。状态：服务端、Android、Web 与 Mac App 已实现；iPhone 尚无入口，也收不到快速对话的数据（见第 5 节）。

快速对话是不绑定项目、不运行 Agent CLI 的多轮对话，用于翻译、解释、查资料这类一问一答。服务端直接调用模型网关，凭据复用已配置的 Claude Code、DeepSeek Harness 或 Codex 接入方，不另存密钥。

## 1 数据

| 概念 | 代码 | 说明 |
| --- | --- | --- |
| 后端 | `backendId: 'chat'`，`apps/server/src/backends/chat/` | 与其他后端走同一套会话、运行、journal 与时间线 |
| 项目 | `Project.system: 'quick-chat'` | 服务端首次启动时创建，目录为 `<数据目录>/quick-chat`，始终为空；不作为普通项目列出 |
| 记录 | `<数据目录>/chat/<sessionId>.jsonl` | 只追加。每条记录带 `parentId`，文件本身是一棵消息树；目前只沿最新分支继续，分叉另开会话 |
| 模型 | `<backend>:<profile>:<model>[effort=high,search=true]` | 列表即 `GET /api/auxiliary-models`，显示为「接入方 · 模型」；Web 与 Mac 优先用 `auxiliaryModels.chat` 并恢复该模型最近会话的参数，未设置时沿用最近会话，再回退到第一个可用模型 |

记录类型：`user`（含 `attachments`）、`assistant`（含 `status`、`error`、`dropped`）、`clear`（`/clear`，此后上下文从空开始）、`summary`（不属于任何回合，代替 `upTo` 及之前的回合，界面不显示）。

Web 在新会话页用「新建任务 / 快速会话」两个 Tab 切换，共用一个 Composer 实例及 `new:home` 草稿。文字和附件随 Tab 保留；文件引用保留所属任务项目，快速会话中不显示、不发送。旧的 `quick-chat:home` 草稿在成功合并保存后删除。标题和目录栏保留布局空间，切换时只替换控件及下方工具、历史区域。Mac 使用同样的 Tab 与原生输入框结构，草稿按服务端保存为 `new-session|<baseURL>`，首次打开时合并当前任务配置与旧 `quick-chat` 草稿；其他旧任务草稿保留，再次进入新会话页时迁移当前配置的旧草稿。

## 2 一轮对话

1. `send` 先过派发围栏，再写 `user` 记录，然后以流式请求网关；三种协议（Anthropic Messages、OpenAI Chat、OpenAI Responses）由 `auxiliary/gateway.ts` 的 `streamChat` 统一。
2. 流式文本每 150ms 作为 draft 写入 journal，回答结束写 `assistant` 记录并结束回合；停止生成保留已写出的部分，记为 `cancelled`。
3. 服务重启时仍未结束的回合，在下次读取时补一条 `interrupted` 记录，不会重发。
4. 用量写入统计：网关报告 token 时记为 `provider`，否则估算。
5. 附件在派发前读取：图片（PNG、JPEG、GIF、WebP）按图片发送；PDF 作为文档发送，只有 Anthropic 与 Responses 协议支持；能解码为文本的文件内联发送，超过 20 万字符截断；其他类型拒绝发送并提示。附件只随提出它的那一轮发送，之后的回合只带文件名。

## 3 上下文

- 发给模型的是最近一次 `/clear` 之后的回合，从新到旧放入，直到约 48k token；放不下的旧回合本轮不发，记在 `dropped`。
- 有回合被丢弃时，回答结束后在后台把旧回合连同上一份摘要压缩成新的 `summary`；之后各轮从摘要开始，摘要放在系统提示里。压缩失败只是少了摘要，不影响对话。
- Web 与 Mac 新会话固定使用 `agent`，不提供翻译、解释、润色等模式入口或预设管理。后端仍兼容旧会话与其他客户端的 `preset:<id>`：在系统提示后附加 `quickChat.presets` 中对应的提示词；已有会话的模式不自动改写。
- 联网搜索是模型参数 `search`，只有 Anthropic 与 Responses 协议的网关提供（由网关自己执行搜索），其余模型不显示该参数。

## 4 保留

- 每小时检查一次：最后一条消息超过 `quickChat.retentionDays`（默认 7，0 为永不）天的快速对话被归档。
- 置顶、含收藏、正在回答的对话不归档。取消置顶或删掉最后一条收藏后，天数从那一刻重新计算。
- 归档只是隐藏，内容、搜索与收藏都保留，可以恢复。

## 5 兼容

`chat` 是新增的 `NativeBackendId`，旧版手机解析会话列表会失败，所以按协商下发：

- 服务端 `ProtocolInfo.features` 含 `quick-chat`；客户端在请求头 `X-Riffet-Features` 中声明 `quick-chat` 才会看到快速对话会话及其项目。
- 未声明的客户端，会话列表、项目列表、bootstrap、消息搜索与统计都不含快速对话数据；`GET /api/backends` 对所有客户端都不列出 `chat`。
- 契约快照用 `negotiated: ['chat']` 标记该枚举值，兼容检查不把它算作破坏。
- Android、Web 与 Mac App 声明该特性；iPhone 未声明。

## 6 Android 入口

- 抽屉里「快速对话」是与「新建会话」并列的入口；快速对话不出现在任何会话列表里，它们的记录在快速对话页内按时间分组列出。
- 系统入口：选中文字后的菜单、分享、桌面图标长按快捷方式、快捷设置磁贴。打开方式由 `quickChat.openMode` 决定：`sheet`（默认）在当前应用上弹出浮层并在其中显示回答，`page` 打开完整应用。选中文字进入时默认使用「翻译」预设。
- 回复长按菜单「收藏回复」。

## 7 Web 与 Mac App 入口

- 侧栏通过新建会话进入「新建任务 / 快速会话」Tab，不再单独提供快速对话入口。快速会话下方按时间分组列出历史，可重命名、置顶、归档和显示已归档；这些记录不出现在普通项目会话列表里。
- 会话页隐藏审批、终端、文件与 Git、工作树、交接等只属于 Agent 的操作，保留模型及参数、停止、收藏、重命名、置顶、归档。
- 设置「快速对话」：默认模型、自动归档；Mac App 另有打开方式。
- Mac App 的全局快速提问（⌃⌥Space）以快速对话为默认目标：`sheet` 在浮窗中显示回答并可继续追问，`page` 打开主窗口。

## 8 不做

- 工具调用循环、文件读写、代码执行：需要这些就用 Agent 会话。
- 同一会话内切换分支。
- 临时对话（关闭即删除）。
