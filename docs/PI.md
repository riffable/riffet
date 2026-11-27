# pi Agent RPC 接入

日期：2026-11-02。状态：已实现 RPC 后端及多端入口；基线为 pi 1.4.0，已用真实 pi 与隔离本地模型服务完成 Riffet 端到端验证。

## 1 目标与决策

将 pi 作为独立的 `backendId: 'pi'` 接入。一个受管会话对应一个 `pi --mode rpc` 子进程；项目、Session、Run、Journal、时间线、附件、统计和多端同步沿用现有实现。

- 接入方式已确定为 RPC，不嵌入 pi SDK，不引入 Pi Durable 或另一套会话数据库。
- 首个兼容基线为 `@earendil-works/pi-coding-agent@1.4.0`。启动时检查真实 executable 的版本及 RPC 能力，旧版本明确不可用；新版本沿用现有 `cliVersions` 机制报告验证范围，不凭版本号自动打开尚未验证的能力。
- pi CLI 与 Riffet 独立安装、独立更新。Riffet 不自动更新用户的 pi，也不修改用户的模型凭证。
- RPC 是 `{type, id, ...}` JSONL，不是 JSON-RPC 2.0。复用现有进程管理、会话锁、TurnTracker、附件读取和 Journal；单独实现 pi 的协议适配。
- 已检查官方 `RpcClient`：它按 `node + cliPath` 启动，未公开 extension UI response 写入接口。首版使用 Riffet 自有子进程控制和小型 JSONL transport，避免为此把整套 SDK 加入生产依赖。

### 首版能力

| 能力 | 首版行为 |
| --- | --- |
| 新建、恢复 | 新建受管 pi 会话；恢复 Riffet 已绑定的原生会话 |
| 发送、停止 | 普通发送；Riffet 管理待发送队列；停止先清 pi 队列再 abort |
| 时间线 | 文本、thinking、工具调用、工具结果、失败与停止状态 |
| 模型 | pi 本机配置或 Riffet provider；自定义 API 协议、地址、Key、模型及输入/上下文设置；沿现有 model 参数表达 thinking level |
| 附件 | JPEG/PNG/GIF/WebP 通过 RPC image 传递；其他附件写入私有临时文件，交给 pi 原生工具读取 |
| 历史、分享、搜索、统计 | 从 pi 原生 JSONL 只读投影，复用现有消费者 |
| 扩展交互 | `confirm/select/input/editor` 接入现有 NativeInteraction |
| 多端 | Web、macOS、Android、iOS 通过现有 KMP 和时间线接入 |

首版不开放 `supportsSteer`、TUI 接管、plan/permission 选择器和扩展 subagent 专属展示。pi 原生支持 steer，但 Riffet 的 steer 还要求准确的目标与持久输入回执；不能用一次 `queued` 响应代替。pi 默认没有内置审批/沙箱系统，标准确认弹窗与工具审批是两种能力。

已有 pi TUI 历史可以只读导入。运行中 TUI 的 stdin/stdout 不可被另一个进程附着，首版不直接接管；任何受管会话都要求单一写入者，不能同时由 RPC 和 TUI 写同一原生会话。

## 2 模块与配置

新增 `apps/server/src/backends/pi/`，按职责分为 adapter、runtime、transport、history/transcript、projection、model selection；文件数量随实际职责确定，避免一个公共工具只为 pi 抽出框架。

| 现有入口 | 修改目的 |
| --- | --- |
| `apps/server/src/app.ts` | 注册 `PiBackendAdapter` |
| `apps/server/src/backends/types.ts`、`service.ts` | 接入驱动；持久化下文的原生输入基线 |
| `packages/contracts/src/index.ts`、`schema/run.ts` | pi ID、特性协商、可选输入基线、契约快照 |
| `apps/server/src/settings/index.ts` | 复用共享后端枚举处理 pi profiles/defaults，无新增存储格式 |
| `apps/server/src/native/session-input.ts` | mode 固定 `agent`；按能力拒绝 unsupported approval/mode；旧端默认后端降级 |
| `apps/server/src/routes/`、`stats/routes.ts`、`store.ts` | 对未协商客户端完整过滤 pi 数据 |
| `apps/mobile/contracts/src/commonMain/kotlin/riffet/contracts/Models.kt`、`Settings.kt` | pi 枚举、Run 可选字段、profile 协议与设置解码 |
| `apps/mobile/client/src/commonMain/kotlin/riffet/shared/RiffetApi.kt` | wire、协议特性；macOS/iOS 复用 RiffetKit |
| Web/macOS/Android/iOS 的 backend 列表、统计、图标 | 使用现有组件和生成器接入 pi |

默认 profile 为本机 pi。executable 默认从 PATH 解析，可通过已有可信 profile 配置或 `PI_CLI` 指定；不从普通会话请求接受任意 executable。

设置页可添加或编辑 pi 的自定义 LLM provider；`apiEndpoint/apiKey/defaultModel/enabledModels` 沿用既有私有 profile 存储，新增可选 `apiProtocol`：

| 设置页协议 | pi API | 请求路径 |
| --- | --- | --- |
| OpenAI Chat Completions | `openai-completions` | `/v1/chat/completions` |
| OpenAI Responses | `openai-responses` | `/v1/responses` |
| Anthropic Messages | `anthropic-messages` | `/v1/messages` |
| Google Gemini | `google-generative-ai` | `/v1beta/models/{model}:streamGenerateContent` |

不设置自定义 API 时沿用 pi 本机 providers。pi 原生另外内置 Azure OpenAI Responses、OpenAI Codex Responses、AWS Bedrock、Google Vertex、Mistral Conversations、Pi Messages 等适配器，可通过 pi 本机配置或扩展使用。

自定义 provider 在 pi 子进程中通过官方 `registerProvider` API 注册到该 Riffet profile 的独立命名空间。原有 `~/.pi/agent/models.json/auth.json` 不被改写；生成扩展只包含非秘密配置，Key 通过子进程环境传递，HTTP 响应仅返回 `hasApiKey`。模型 ID 保留上游原文，内部 provider 前缀不出现在设置的模型选择中。

保存协议、地址或 Key 后，下一条消息启动时重新读取 profile，空闲进程按配置指纹重新启动并恢复相同原生会话。正在进行的模型调用不被切换。目录不提供模型列表时，可在已有模型编辑器手填 ID。

本机配置目录默认继续使用 `~/.pi/agent`；如果配置了其他 agent directory，使用 `PI_CODING_AGENT_DIR`。沿用 pi 的模型、凭证、skills、prompts、extensions 和 MCP 配置。受管新会话采用稳定的原生 session ID，首次启动后读取 `get_state` 的 `sessionId/sessionFile`；恢复时使用已验证的确定引用，不使用模糊的 `--continue` 或 UUID 前缀。

HTTP 接口只接受受限的原生 ID。服务端在允许的 session 根目录内定位文件，核验真实路径、header ID 与项目 cwd；不能把请求中的字符串直接当作 `--session` 文件路径。原生 ID 不要求只能是 UUID，仍需拒绝路径分隔符和穿越片段。

`available()` 只检查 executable、版本与协议选项。模型、slash 和扩展发现优先使用已有 RPC 连接或缓存；没有目录时保留 pi 默认模型入口。设置页、搜索和统计不能为了枚举能力偷偷启动真实会话或 MCP。后续如果需要冷启动目录刷新，单独做用户显式触发的管理操作。

`configure()` 保存下一轮选择；运行中不向 pi 发送会改变当前工具循环的 `set_model`。在下一次 send 前应用模型和 thinking，读取实际值后写入 `resolvedConfig`。模型字符串复用 `provider/modelId[effort=high]` 和 `parseNativeModelSelection/nativeModelEffort`，再映射到 `set_model/set_thinking_level`；options 以 pi 当前模型实际支持的 levels 为准。

## 3 RPC 进程与状态机

启动不给 prompt 参数，只建立 RPC 端点、读取 session identity，再配置和发送。所有监听器必须先于 prompt 注册。

| pi 记录/结果 | Riffet 处理 |
| --- | --- |
| `prompt` 的 `started` | 已接收；继续等待 user entry 与运行结果 |
| `prompt` 的 `queued` | 保留送达状态；普通发送不应走这条路径，需核查运行状态 |
| `prompt` 的 `handled` | 扩展/命令处理完输入；没有运行则结算命令，不等待不存在的 settled |
| `agent_start/turn_start` | 运行/步骤活动；不能单凭它们确认原始输入归属 |
| `message_update` | 按 contentIndex 拼接 delta，发布 draft；不是累积快照 |
| `message_end` | 用最终消息替换 draft，并唤醒原生文件读取 |
| `tool_execution_*` | 关联 toolCallId，报告工具活动和结果 |
| `agent_end/turn_end` | 只关闭内部步骤；可能继续工具循环、重试、压缩或排队工作 |
| `agent_settled` | 当前受管运行的最终空闲信号；先 drain 原生尾部，再写 turn end |
| `compaction_* / auto_retry_*` | 系统活动与状态；最终用量去重后记账 |

终态同时检查 `agent_settled.aborted`、最后 assistant 的 `stopReason`、最终 retry 结果和 Riffet 停止原因。正常完成为 `completed`，最终 provider failure 为 `failed`，原生 abort 的 turn status 为 `cancelled`，Riffet Run 沿用 `interrupted`；进程退出而回复不完整时 turn status 同样为 `interrupted`。普通 `idle`、ACK 和临时断线不能制造完成结果。

`send()` 的会话锁只覆盖配置、边界捕获、fence 和 stdin 写入。pi 的 input hook 可以在 ACK 前请求用户确认，因此写入成功即释放发送锁；ACK 在后台检查，attention 状态等待用户答复，不能与交互响应共用一把长期占用的锁。stdout 持续读取；按 LF 分帧，接受 CRLF，不使用会把 U+2028/U+2029 当换行的 `readline`。stdin 尊重 backpressure，协议帧设上限；stderr 限长，仅进入诊断，不写入 timeline 或作为协议解析。

停止流程为：拒绝本会话新投递 → `clear_queue` → `abort` → drain/settled → 发布最终状态。清队列失败仍尝试 abort；RPC 无法确认时关闭子进程，防止残留队列再次启动，并返回未确认的 RPC 中断结果。清掉的原生排队内容不丢失已有 Riffet Run；Riffet 自己的队列按现有取消、归档和“立即发送”语义处理。优雅关闭随后关闭 stdin；超时才终止子进程。断线/超时后的不明投递沿用 `uncertain` 和不重放规则。

Traits 首版：`acceptsInputWhileBusy=false`、`untaggedEcho=false`（回合只由适配器的最终 turn end 结算，所有后端都如此）、`offlineMayBeRunning=true`；没有 TUI/子代理专属 traits。下节确认后给用户事件补可信 `commandId`，因此不依赖通用文本推断路径。

## 4 Run 与原生 entry 的可靠归属

pi 的 RPC request ID 只用于匹配 response。普通消息、turn、settled 事件没有 commandId；持久 SessionEntry 才有稳定的 `id/parentId`。1.4.0 的 prompt disposition 也不包含 entry ID。

现有 `baselineSequence` 是 Journal 坐标，Journal cursor 是读取位置，两者都不能直接代替 pi 的原生 leaf。首版需要在现有 Run 增加一个可选、无秘密的 `nativeInputBoundary` 字符串，由驱动产生版本化 JSON，例如 `{"v":1,"lastEntryId":"...","leafId":"..."}`。它与已有 `nativeSessionId/baselineSequence/resolvedConfig` 在 `commitDispatchFence()` 同一事务内保存；不新建关联表。契约/schema/KMP 按可选字段同步，不能把它作为 HTTP 用户可写的运行参数。

完整写入路径必须同时扩展 `NativeDispatchBinding.nativeInputBoundary`、`NativeRunDetails`、`schema/run.ts` 和 KMP `NativeRunDetails`，并在 `backends/service.ts::commitDispatchFence()` 的 transition 白名单中复制该字段。仅增加接口字段不会落库；验收应直接读取保存后的 Run，再重启核对基线。

投递与确认顺序：

1. 读取当前 `get_entries` 的尾 entry 和 leaf；Riffet dispatcher 限制每会话只有一个受管输入，未知投递继续阻止后续发送。
2. 应用下一轮模型配置；在第一次 prompt 写入前提交上述 fence。持久化后再写 stdin。
3. `started` 只表示接受。收集 pi 的 finalized user message，以及基线之后新增的原生 user entries；按原生分支关系和最终消息内容/时间戳确认唯一候选，不能按 FIFO 或原始文本单独猜测。
4. 确认 user entry 后，补发可信 `native_input_receipt`，由现有 dispatcher 保存 `nativeMessageId`；转写事件和 `turnStarted` 在已知关联时带真实 runId。历史读取可能先于 RPC 回执，因此 late receipt 也能补全同一持久关联。稳定 turn ID 使用原生 session 与 user entry ID，后续 assistant/tool entries 按这条分支归属。
5. 恢复时先使用已持久 `nativeMessageId` 和 `findRunIdByNativeMessage`；未确认输入按其原生基线重新核对。多个候选、跨分支、输入被扩展重写而无法唯一对应、ACK 丢失时保留 `uncertain`，不重发。

扩展可以消费或注入输入。`handled` 后不凭附近的其他 user entry认领此 Run；如果扩展独立启动模型工作，应只按能够证实的关联展示。所有入场前检查和实际写入之间都要重查停止/归档/会话换绑。

此关联是首版验收门槛。若探针证实某类扩展无法提供唯一归属，关闭相应高级能力；不能为了“支持全部扩展”退回文本配对。

## 5 原生历史、draft 与统计

实现 `PiTranscriptSource`，满足 `docs/SYNC-V3.md` 的 G1–G10。原生 JSONL 是 append-only entry 树：

- 用 header/session ID 表示 conversation identity，用 entry ID 加 content part 表示最终 nativeId；不使用导入时的数组下标或 Riffet 自增序号。
- source cursor 保存版本、读取偏移、尾 entry 和 active leaf 等续读状态。游标与可见行在同一事务提交，重放相同输入不增加行。
- 读取 active leaf 到 root 的完整原生分支。`get_messages` 是压缩/编辑后的有效模型上下文，不是完整 timeline。
- `system`、配置、custom 状态和 `context_edit` 不当成普通用户消息；压缩是活动/上下文事件，不删掉实际发生的历史。
- 同一 session 内切换分支时 reconcile/retire 离开分支的行；原生身份没变就不 `rebuild`。文件迁移、截断或重写先按 ID 重扫，不能仅因 inode/size 变化重置 conversation identity。
- 先用稳定的受管 Run/step 标识承载 live draft；原生最终 entry 到达后，在同一提交里用 alias/retire 合并，避免最终回答重复。pi delta 帧不含累积 partial，按块重建并以最终 message 覆盖。
- 大会话导入复用 scratch 尾窗与 promote。外部终态写入前调用 drain，防止终态越过尚未摄取的最后消息。

分享、搜索索引和 `usageTranscript` 只读已落盘文件。启用 `readOnlyTranscript` 之前验证这些读取绝不会拉起 RPC 进程。token/费用使用原生 entry/usage 的稳定 ID 去重；流式 usage 是累积值，不能每个 delta 再加一次。统计累计 tokens/cost 与 `contextUsage` 分开，压缩后的未知 context token 保持 null，不显示成 0。

## 6 扩展交互

技能和模板仅作为行首命令提供，pi 自己展开；生成扩展将展开后的 prompt 通知 runtime，仍以原生输入边界与唯一候选绑定回执。消息中间不提供 pi 技能补全。

标准弹窗按 pi request ID 转成现有 `NativeInteraction`：confirm→confirmation；select→choice；input/editor→question。响应转换回 `extension_ui_response`。复用 interaction revision 和 `NativeInteractionReceipt` 保证重试只回写一次；process/session 换绑后旧 dialog 失效。Pi 的 timeout 只作为真实 expiresAt，不能自行延长或自动确认。notify 可呈现为现有 notice；自定义 TUI、footer/header/editor component 不宣称兼容。

## 7 多端协商与界面

在 `ProtocolFeature/PROTOCOL_INFO.features` 新增 `pi-agent`，保留 protocol version 3。`schema/native.ts` 明确使用 `negotiated: ['chat', 'pi']`，其中是枚举值；支持 pi 的客户端在 `X-Riffet-Features` 声明 feature 名 `pi-agent`。特性检查使用共享 helper，不能只在 backend picker 过滤。

| 下发入口 | 未声明 pi-agent 时的行为 |
| --- | --- |
| `/api/backends`、doctor、catalog/profile | 不返回 pi backend/capability；pi 专属请求明确拒绝 |
| bootstrap、sessions、settings | 不下发 pi 会话或会触发严格枚举解码的 pi 字段；普通项目保留 |
| 搜索、统计、CSV 导出 | 在查询和 LIMIT 前排除 pi；不能先取结果再过滤 |
| v3 sync、直接会话查询、运行列表 | 校验该客户端可识别此会话，避免缓存 ID 绕过列表过滤 |
| 编排等嵌套会话响应 | 同样过滤或明确拒绝，不能在嵌套 backendId 处漏出 pi |

搜索 SQL 使用 excludedBackendIds 集合，同时隐藏 chat/pi，并在 LIMIT 前过滤；统计复用已有 hiddenBackends。

设置也会直接触发严格枚举解码：KMP 的 `defaultBackendId` 是 NativeBackendId，`nativeBackendDefaults` 是以该枚举为 key 的 Map。`effectiveSettings(headers)` 必须在旧端响应中移除 pi 默认配置，并在服务器默认后端为 pi 时返回兼容的默认值。旧端不指定 backendId 的新建请求采用同一个兼容回退，显式请求 pi 则拒绝；不能在创建响应里突然返回未知枚举。旧端 PATCH 设置时保留其看不到的 pi 配置，避免一次保存把其他客户端的设置擦掉。

任何 `auxiliaryModels.*.backendId` 为 pi 的引用同样不能送给旧端，包括快速对话实际使用的 `auxiliaryModels.chat`；按现有可空字段返回空或兼容值并保留服务器存储。首版不把 pi 加入辅助模型列表，但过滤规则仍覆盖所有后端引用。

新客户端增加 backend 标签、顺序、默认配置、统计筛选和 agent mark；图标走 `scripts/gen-agent-marks.ts`，不分别维护多套形状。iOS/macOS 的 wire 解码通过 KMP 更新，原生 UI 仅接既有 picker、会话和 timeline。只展示 capabilities 已验证的控件，用户文案保持现有最小风格。

## 8 实施顺序与验收

| 阶段 | 工作 | 完成条件 |
| --- | --- | --- |
| A 契约与进程 | pi ID/协商/可选基线；注册、profile、version、transport、子进程生命周期 | 新旧客户端均可读取；启动/断线/关闭可控；不在发现阶段启动任务 |
| B 核心运行与历史 | dispatch fence、Run↔entry、send/stop、source、draft、终态 | 核心协议/幂等/恢复验收全部通过，才合入可用 backend |
| C 可用产品 | 模型/附件、标准 interaction、分享/索引/统计、Web/KMP/原生 UI | 四端最小工作流可用；旧端完全过滤；没有虚假能力入口 |
| D Riffet 集成 | 编排目标/交接/并行任务；gateway profile | 复用已有服务完成真实端到端验收，不自动把 pi 加入辅助模型后端 |
| E 高级能力 | steer、扩展管理、特定 subagent 协议、TUI 桥接 | 各自有明确原生证据与能力门控后再开放 |

A–C 已实现；D 中编排目标已接入，gateway 配置既可使用 pi 本机配置，也可在 Riffet profiles 中管理。E 保留能力门控，不开放 steer、自定义 TUI 或扩展安装管理。

验证遵循仓库“先复用、只测核心风险”的规则：

- 复用 `runIngestContract` 验证稳定 nativeId、重放、cursor、scratch、身份/分支变化、断尾 JSONL、draft→final 和结束前 drain。
- 在 adapter/runtime 的协议边界验证同 commandId 只写一次、不同 commandId 的重复文本各自归属、输入变换/handled、ACK 丢失、停止/归档竞态、pipe/process exit、重启恢复；出现歧义不重放。
- 验证 tool loop 和自动重试不会被 turn_end/agent_end 提前结算；验证 final failure 与 aborted，不只测正常回答。
- 复用核心 HTTP/契约测试覆盖旧客户端 bootstrap/backend/search/stats/sync/嵌套响应，包含 LIMIT 前过滤。交互响应重复、过期和跨进程回放只回写一次或明确拒绝。
- 必要检查：`npm run typecheck`、契约/图标生成及检查、受影响的核心测试、Web/server build；原生枚举/界面改动后做相应 KMP、macOS/iOS、Android 编译。仅有新变化或失败才重复平台构建。
- 实际界面检查最小流程：选四端 pi→新建→读写临时文件→流式回复→确认→停止→恢复→分享/搜索。鉴权和真实 provider 需另做一次端到端验证。
- 不新增布局、文案、图标、快照或重复业务 UI 测试，不为提高覆盖率新增用例。

## 9 已验证行为与边界

对 pi 1.4.0（需要 Node >=22.19.0）的真实验证使用独立配置、临时目录和本地 OpenAI / Anthropic / Google 兼容的 SSE 模型服务，不依赖真实模型凭证：

| 已执行 | 结果 |
| --- | --- |
| prompt disposition | 普通输入 started，扩展命令 handled，follow-up queued |
| 流式与完成 | 收到 text_delta 和 agent_settled(aborted=false) |
| 工具循环 | 实际 read 临时文件成功，收到 tool_execution_start/end |
| 用量 | 返回 input、output；contextUsage 带窗口大小 |
| 扩展确认 | confirm→confirmed=true→notify 闭环成功 |
| 指令层注入 | 系统提示包含注入上下文，user 原文不变 |
| 停止 | clear_queue 移除 follow-up；abort 后 streaming=false、pending=0；没有为被清消息新增模型请求 |
| 持久恢复 | session ID、所有 entry ID、leaf ID 均保持一致 |
| 输入身份 | 流式消息仍没有 commandId；原生 entry 提供稳定 ID |

端到端覆盖：同 commandId 幂等；工具 read 循环；时间线和后台搜索索引；confirm/select 与回答重试只写一次；行首模板与技能展开后仍确认回执；连续排队的同文本命令拥有不同 entry；分享和 usage 只读读取；服务关闭后恢复原生 ID；首轮原生文件尚不存在时即可显示流式文本，落盘后最终回答不重复。真实 provider 鉴权、reasoning 模型、多图片和自动压缩/重试需要按用户实际 pi 配置继续验收。未开放的 steer/TUI/扩展安装能力不在范围内。

使用：新建会话时选择 pi，模型为 `provider/modelId`；默认读取本机 `~/.pi/agent` 配置，也可在后端 profiles 设置自定义 API、协议、Key、模型、executable/configDir。

官方依据锁定 [v1.4.0](https://github.com/earendil-works/pi/releases/tag/v1.4.0)：[RPC](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/rpc.md)、[RPC commands](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/rpc-commands.md)、[JSON events](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/json.md)、[Session format](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/session-format.md)、[Extension UI](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/rpc-extension-ui.md)。provider 的官方依据：[自定义模型](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/models.md)、[registerProvider 扩展接口](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/extensions.md)、[模型 API 类型](https://github.com/earendil-works/pi/blob/v1.4.0/packages/ai/src/types.ts)。

### 自定义 provider

- 通过 HTTP 设置接口保存四种协议的 provider 后，下一条消息切换生效，原生会话 identity 保持，Key 不回显、不写入生成的扩展，原 pi 配置不变。
- 多端模型目录在协议、地址或 Key 变化后失效，已发出的旧探测结果不能覆盖当前选择。
- 网关模型目录优先使用 Bearer 认证，仅在 401 后用同一 Key、同一服务重试原生 Anthropic 的 x-api-key；跨域跳转不触发凭证回退。
- 目录没有声明某模型的 reasoning ladder 时，缺省目录可补 off/low/medium/high 四档；目录已有声明时以声明为准，不为未知模型补能力。provider 使用 pi 官方 `compat.forceAdaptiveThinking` 将档位传成 `output_config.effort`，同一会话切换档位通过 RPC 生效并保持原生 ID。
- 生成 registerProvider 定义时，maxTokens 同时受目录声明的输出上限、现有输出预算和上下文窗口约束，避免超出服务端上限而收到 400。
- 目录请求显式处理重定向：只跟随同 origin 地址、最多 5 次，沿用同一超时信号并取消跳转或失败响应的 body。默认 fetch 会在跨 origin 跳转时保留 x-goog-api-key 等自定义认证头，仅检查最终 response.url 无法保护已转发的凭证。

### Web 订阅

浏览器 `EventSource` 不能携带 `X-Riffet-Features`，会话 SSE 路由曾被兼容门控返回 404，表现为页面空白。Web 现在使用统一 `CLIENT_FEATURES` 常量，在订阅 URL 显式声明 `features=quick-chat,pi-agent`。服务端仅在已通过鉴权的两个 GET SSE 路由、且没有 features header 时接受该 query 声明；普通 API 和 header 优先级保持原契约。首条已接受的提交回执沿用现有 seed 和 `withLocalOutbox` 放在时间线中，原生 `user:<commandId>` 到达后合并；后续排队仍在 composer dock，失败首条保留错误。

### 超时与自动重试

pi 1.4.0 默认 HTTP 闲置超时为 300000 ms（`httpIdleTimeoutMs`），同时用于 undici 的 headersTimeout 和 bodyTimeout；RPC 启动前也会应用该设置。bodyTimeout 按数据块之间的空闲时间计算，并非整轮请求的总时长。Agent 自动重试开启、最多 3 次，首次退避为 2000 ms；provider 级重试默认 0 次。`terminated` 属于 pi 可重试错误，恢复时失败 attempt 会从模型上下文投影中剔除。

undici 将底层错误包装为 `TypeError('terminated', { cause: reason })`，而 pi-ai 的 Anthropic 适配只保存 `error.message`，没有保留 `error.cause`。因此原生记录无法区分 BodyTimeoutError 与上游或代理断连；要定因果，需要底层 cause 或最后一个 SSE 数据块的时间。不基于空 thinking/signature 猜测修改兼容参数。
