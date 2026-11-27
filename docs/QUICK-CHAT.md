# Riffet 模型对话（原快速对话）

日期：2026-10-31；2026-11-27 重构为「模型对话（Model Chat）」。状态：服务端与 Web 已实现完整白盒消息树、参数/上下文/Wire 控制台与多模型并排对比；Mac App 同步兼容线性投影会话；iPhone 与 Android 未声明该特性（见第 6 节）。

Mac：W 类，会话列表与基础对话经现有线性投影同步；参数/上下文/Wire 控制台先在 Web 实现，后续按需在原生补齐或跳转 Web。

模型对话是不绑定项目、不运行 Agent CLI 的直连 LLM 工作台：直接调用模型网关，由用户完全掌控 System Prompt（含零污染裸模式）、思考深度与采样参数、上下文编排（Pin/Mute/摘要/单轮/Prompt Caching）、消息树分叉、同轮多模型并排对比与脱敏 Wire 请求透视；聊透后可一键「转为 Agent 任务」带入新建任务草稿。凭据继续复用已配置的 Claude Code、DeepSeek Harness 或 Codex 接入方，不另存密钥。

## 1 数据与双轨架构

| 概念 | 代码 | 说明 |
| --- | --- | --- |
| 后端 | `backendId: 'chat'`，`apps/server/src/backends/chat/` | 保持既有后端 ID 兼容旧端；同时提供 `/api/sessions/:id/chat/*` 树级与白盒接口 |
| 项目 | `Project.system: 'quick-chat'`，默认名称「模型对话」 | 服务端首次启动时创建，目录为 `<数据目录>/quick-chat`，始终为空；在主侧栏按项目视图中归为「模型对话」分组 |
| 记录 | `<数据目录>/chat/<sessionId>.jsonl` | 只追加的消息树。每条记录带 `parentId`，支持 `user`（含 `editedFrom`）、`assistant`（含 `modelSelection`、`compareGroupId`、`wireBlobRef`、`metrics`）、`clear`、`summary`（含 `manual`），以及元记录 `branch_select`、`turn_flag`、`assistant_edit`、`config_patch`、`pinned_docs` |
| Wire 快照 | `<数据目录>/chat/wire/<sessionId>/<assistantId>.json` | 仅存脱敏后的请求端点、header 名（鉴权头替换为 `[REDACTED]`）、二进制截断后的请求体与指标，受 `MODEL_CHAT_BUDGET.maxWireBytes` 约束并按会话保留最近 50 份，随会话清理 |
| Journal 投影 | `ChatTranscriptSource` | 只把**当前活动分支**投射进 `Journal`（切换分支或编辑助手回复时重建投影），保证全局消息搜索、收藏夹、统计、分享与旧客户端自动兼容 |
| 模型 | `<backend>:<profile>:<model>[effort=…,fast=…,search=…]` | 列表即 `GET /api/auxiliary-models`，显示为「接入方 · 模型」；单轮最多同时向 `MODEL_CHAT_BUDGET.maxCompareModels`（3）个模型并行发送 |

## 2 一轮对话与网关协议

1. `auxiliary/gateway.ts` 的 `streamChat` 统一 Anthropic Messages、OpenAI Chat、OpenAI Responses 三种协议，扩展支持：
   - 思考控制：`effort`（`off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max` / `adaptive`）与自定义 `thinkingBudget`；
   - 采样与预算：`temperature`、`topP`、`maxOutputTokens`（默认 16,384，可调）、`seed`、`stop`；Anthropic 启用思考或 Responses 启用推理时自动省略 `temperature`/`top_p` 避免协议 400；
   - 结构化输出：`responseFormat`（`text` / `json_object` / `json_schema`）；
   - Prompt Caching：Anthropic 开启后自动在 `system` 与稳定历史前缀标记 `cache_control: { type: 'ephemeral' }`，三协议统一解析 `cacheReadTokens` / `cacheWriteTokens` / `stopReason`；
   - Wire 脱敏回调：请求发出前脱敏鉴权头、去除 URL query 凭据、截断大体积 base64 载荷。
2. 流式文本经 SSE（`GET /api/sessions/:id/chat/stream`）实时推送单路或多路并排 `delta`，回答结束写入 `assistant` 记录与统计；单模型失败或单独中断不影响同轮其他并行模型。
3. 附件在派发前读取：图片（PNG、JPEG、GIF、WebP）按图片发送；PDF 仅 Anthropic 与 Responses 协议支持；可解码文本内联发送（超 20 万字符截断）；其余类型拒绝。

## 3 上下文编排与消息树

- **四种策略**：`summary`（默认，超预算后后台压缩并支持手改摘要）、`window`（滑动截断）、`full`（尽量全量保留）、`stateless`（无状态单轮，每轮不带历史）。
- **逐轮控制**：每轮支持 `Pin`（裁剪时优先保留）与 `Mute`（从后续上下文排除，原记录保留在树中）。
- **钉住只读材料**：支持附加最多 `MODEL_CHAT_BUDGET.maxPinnedDocs`（16）份文本材料，每轮自动注入上下文并配合 Prompt Caching 复用。
- **System Prompt 与裸模式**：支持自由编辑、切换预设模板，或开启「裸模式」清空一切系统提示词。
- **消息树操作**：支持编辑任意用户消息并从该节点分叉、原地重生成、换模型重跑并排对比、收束分支，以及直接编辑助手回复用于 few-shot 或纠偏。

## 4 差异化 Web 会话页与共用组件

- Web 在 `<SessionFrame>` 处按 `session.backendId === 'chat'` 分流至独立的 `<ModelChatSession />`（`apps/web/src/app/model-chat/`），`NativeSession.tsx` 保持纯粹的 Agent 运行页。
- 原子展示与输入能力 100% 复用会话公用组件：`UserMessage`、`AssistantMessage`、`ThoughtRow`、`MessageFooter`、`WorkingIndicator`、`MarkLayer`、`Composer`、`ContentColumn`、`ContentWidthHandle`、`ResizeHandle` 与 `@/components/ui/*`。
- 右侧直接复用原生侧边面板宿主 `PanelHost` + `FloatingPanelFrame`（同一张独立圆角卡、8px 缝隙、拖拽调宽、悬浮、全屏、窄屏抽屉与页头原生侧板开关），内部展示 **参数 / 上下文 / Wire** 三页签。
- 页头「转为 Agent 任务」将当前分支结论与钉住材料带入 `new:home` 草稿并切到「新建任务」页签。

## 5 保留策略与主侧栏

- 模型对话进入主侧栏：按时间视图与普通会话混排；按项目视图归入「模型对话」分组。新会话页保留「新建任务 / 模型对话」双 Tab 共用同一输入框草稿。
- `DEFAULT_QUICK_CHAT_RETENTION_DAYS` 默认改为 `0`（永不自动归档）；用户仍可在「设置 › 模型对话」按需配置自动归档天数（置顶、含收藏、进行中的对话不归档）。

## 6 兼容与多服务器

- **能力协商**：服务端 `ProtocolInfo.features` 含 `quick-chat`；未声明的客户端（旧版或移动端）过滤 `chat` 会话与项目，契约快照仍以 `negotiated: ['chat']` 标记 `chat`。
- **多服务器（`docs/guide/multi-server.md`）**：
  - 归类：**A 类（工作对象）**。会话与树历史留在所在服务器；所有 `/api/sessions/:id/chat/*` 挂载在 `/api/sessions` 前缀下，命中 `links/policy.ts` 的 `serve` 与 `capabilities.ts` 的 `read` / `chat` 策略，客户端经 `serverOfObject(sessionId)` 自动路由。
  - 「设置 › 模型对话」的默认模型、预设与归档天数属 **B 类（环境与配置）**，仅在本机设置页修改。
  - Wire 快照绝不持久化凭据，跨服只读透视同样脱敏。

## 7 不做

- 工具调用循环、文件写入、代码执行：需要执行操作时点击页头「转为 Agent 任务」交给 Agent 会话。
- 临时对话（关闭即删除）。
