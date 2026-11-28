# Agent CLI 升级适配与确定性验证架构

返回 [中文 README](../../README.zh-CN.md) · 关联：[AI 友好工程机制](aif.md) · [插件架构](../PLUGIN_ARCHITECTURE.md)。

本文定义 Riffet 如何持续保障对多个异构 Agent CLI（含仓外插件后端）的升级兼容性：在**不碰用户日常环境、不消耗线上模型额度、不按版本盲目膨胀录制文件**的前提下，用可控假 LLM + 统一契约测试套件对候选版本做确定性全流程验证，并把实测结果绑定到 `testedThrough` 与运行时安全降级门控。

## 1. 背景与核心矛盾

Riffet 接入的 Agent CLI 跨越四类完全不同的脆弱面：

1. **结构化协议型**（Codex、TRAE CLI、Pi、DSH、Droid）：容易随版本改变握手冷启动耗时、新增通知或队列归属字段、改变能力探测输出。
2. **TUI 屏幕 + Hook / 转写混合型**（Claude Code、Antigravity）：最容易静默退化，审批按钮文案、单/多后台任务界面跳转、按键语义（如 `Esc` 与 `C-c`）、扩展发现目录随小版本即可能变化。
3. **本地数据库 + 预加载型**（Cursor Agent）：依赖启动参数、预加载钩子与 SQLite 表结构，后端通信走私有协议。
4. **仓外插件型**：核心只提供通用扩展点（`packages/plugin-api/src/agent.ts`），不能在主仓写死专用逻辑，验证体系必须能被仓外插件平等复用。

单靠两类常见手段都不够：

- **仅靠离线录制回放**（`apps/server/src/backends/codex/recordings.test.ts`、`apps/server/src/backends/claude/recordings.test.ts`）只能证明今天的代码没有改坏昨天已录过的版本，无法预知上游新版 CLI 实际发出了什么；
- **仅靠真实线上模型跑 E2E** 成本高且高度不可控：真模型不保证按要求触发特定工具或审批、无法精确卡在“首字前 / 流式输出一半 / 工具执行中”测试 `steer` 与 `interrupt`，也无法按需复现流中途 TCP 断连、429 限流或畸形工具 JSON。

## 2. 社区实践借鉴与本方案定位

调研开源社区现有实践后，提炼了以下可借鉴设计与空白点：

| 方向 | 借鉴的设计 | 社区方案的空白（本方案补齐之处） |
|---|---|---|
| 多协议假 LLM 服务（如 `mock-llm-server`、`llmposter`、`tokenless`、`LLMSim`、`mockagents`） | 统一剧本翻译到多套线协议；状态机剧本与真 TCP 断流；异常/畸形工具参数注入；完整请求审计日志 | 缺少与外部宿主双向同步的 **Barrier/Gate 栅栏原语**，无法确定性测试 `steer`、运行中打断与运行中重启 |
| 单一 CLI 自测桩（如 Codex `responses.rs` / WebSocket 桩、Goose `acp_fixtures`） | 同时覆盖 HTTP SSE 与 WebSocket 传输；未命中剧本时返回各协议原生 **417 错配错误** 而非静默兜底 | 绑定单一 CLI 内部实现，无法跨 CLI 驱动工作台 HTTP、Sync v3 与 TUI 终端 |
| 协议兼容套件（如 ACP TCK） | 基于能力声明输出 **四态判定**（`pass` / `fail` / `not-applicable` / `not-exercised`），同时覆盖正常路径与负向错误路径 | 仅覆盖单一协议，不含跨版本续聊、选择性录制与运行时能力降级 |

Riffet 仓库已自带 Node.js 与 `ws`，本架构在 `scripts/cli-compat/` 下以零新增依赖实现核心引擎，避免引入外部语言二进制分发成本。

## 3. 五大支柱架构

```text
上游新版本（npm / GitHub / 官方清单 / 候选二进制）
        │
        ▼
┌─────────────────────────────────────────────────────────────┐
│  1. 隔离沙盒 (scripts/cli-compat/sandbox.ts)                 │
│     独立临时二进制 + 独立 CLI Home + 独立 Riffet stateDir    │
│     独立 tmux socket + 临时 Git 项目（绝不碰生产数据与配置）  │
└──────────────┬───────────────────────────┬──────────────────┘
               │ HTTP + Sync v3            │ 5 线协议 (HTTP SSE / WS)
               ▼                           ▼
┌──────────────────────────────┐ ┌────────────────────────────┐
│  2. 统一 TCK 套件 (tck.ts)    │◄┼►│ 3. 可控假 LLM (MockLlmHub) │
│  按能力声明跑全流程契约场景    │ │   同步栅栏 Barrier/Gate    │
│  验状态 / 磁盘 / Sync v3 / 进程│ │   语义路由 + 417 严错配    │
└──────────────┬───────────────┘ └────────────────────────────┘
               │
       ┌───────┴────────┐
       ▼                ▼
┌─────────────┐  ┌────────────────────────────────────────────┐
│ 4. 漂移与录制│  │ 5. 兼容凭据 + 运行时安全降级                │
│ 无变化→不重录│  │ 产出 version × scenario 四态清单绑定至      │
│ 有变化→只录  │  │ testedThrough；未测版本 L1 放行、L2 保守降级 │
│ 失败场景入库 │  │                                            │
└─────────────┘  └────────────────────────────────────────────┘
```

### 3.1 可控假 LLM 引擎（`scripts/cli-compat/mock-llm/`）

拆成 **1 个协议无关的剧本核心 + 4 个协议模块（覆盖 5 种传输）**，监听单个本地回环端口 `127.0.0.1:0`：

| 协议模块 | 端点与传输 | 覆盖的 Agent |
|---|---|---|
| `scripts/cli-compat/mock-llm/protocols/anthropic.ts` | `POST /v1/messages`（SSE / JSON）、`POST /v1/messages/count_tokens`、`GET /v1/models` | Claude Code、Pi（Anthropic）、Droid（BYOK） |
| `scripts/cli-compat/mock-llm/protocols/openai-responses.ts` | `POST /v1/responses`（SSE / JSON）、`WS /v1/responses`（WebSocket）、`GET /v1/models` | Codex、Pi（Responses）、隔离配置下的 TRAE CLI |
| `scripts/cli-compat/mock-llm/protocols/openai-chat.ts` | `POST /v1/chat/completions`（SSE / JSON）、`GET /v1/models` | DSH、Pi（Chat）、Droid（BYOK）、兼容 OpenAI 的仓外插件 |
| `scripts/cli-compat/mock-llm/protocols/gemini.ts` | `POST /v1beta/models/:model:streamGenerateContent` / `:generateContent`、`GET /v1beta/models` | Antigravity、Pi（Gemini） |

核心引擎（`scripts/cli-compat/mock-llm/hub.ts`、`scripts/cli-compat/mock-llm/gates.ts`）提供 6 个控制原语：

1. **双向同步栅栏（Barrier / Gate）**：剧本在 `beforeFirstToken`、`afterChunk(n)`、`beforeToolUse`、`afterToolResult` 处暂停并触发 `gate.reached`；TCK 确认 Riffet 进入目标状态并执行 `steer`、`cancel` 或重启服务端后，再调用 `gate.release()` 放行。
2. **语义路由与并发隔离**：将各协议请求归一化为 `NormalizedRequest`，按 `system` 特征、工具集、最新用户消息标签和 `toolResults` 路由，避免并发的标题生成、Subagent、`/compact` 摘要与主回合互相抢占序号。
3. **严格 417 错配**：未命中任何路由的意外请求返回对应协议原生格式的 HTTP `417` 与差异说明，防止 CLI 请求形态变化被默认回复掩盖。
4. **Tool-Result 感知**：自动读取上一轮工具执行结果（含批准、拒绝、报错或 `AskUserQuestion` 回答），将其结构化回显到最终答复，验证闭环。
5. **故障与富内容注入**：支持真 TCP 断流（`socket.destroy()` 模拟 `truncatedAfterOutput`）、SSE 异常帧、原生 `401`/`429`/`500`/`503`、畸形工具 JSON 参数、普通 `thinking` 与带 `narration` 签名的旁白、宽 Markdown 表格与精确 `usage`。
6. **请求审计（Request Journal）**：保留每次请求的归一化摘要与原始载荷，支持断言图片未静默降级、MCP 工具按权限裁剪、`/clear` 无旧上下文泄漏。

### 3.2 统一契约测试套件（`scripts/cli-compat/tck.ts`）

所有场景通过进程内真实 Riffet 服务（`apps/server/src/app.ts`）的 HTTP API 与 Sync v3 订阅驱动（复用 `scripts/probe-sync-e2e-lib.ts`），根据后端在 `/api/backends/:id/catalog` 公布的 `capabilities` 与 `traits` 自动计算四态结果：

- `pass`：执行并通过全部断言与全局不变量；
- `fail`：执行失败或违背全局不变量；
- `not-applicable`：该后端未声明依赖能力（如不支持 `supportsSteer` 或无交互式审批）；
- `not-exercised`：该后端具备能力，但当前运行模式未覆盖（如封闭协议后端跳过离线模式、缺少旧版二进制跳过跨版本续聊）。

**场景矩阵（8 大类 + 4 条全局不变量）**：

| 类别 | 场景 ID | 验证内容与关键断言 |
|---|---|---|
| 1. 探测与生命周期 | `probe-basic`、`probe-timeout-recovery`、`prewarm-hit-miss` | `--version` 与目录可用；忽略 `SIGTERM` 的假启动器在时限内回收子进程组并重试一次；预热命中与参数变更冷启动 |
| 2. 基础与富对话 | `basic-turn`、`multi-turn`、`multiline-boundary`、`image-attachment`、`rich-stream` | `commandId` 认领、用户消息精确一次、含 `───` 横线多行粘贴不误判边界、假 LLM 审计图片以真实 image block 发出、草稿转正不重复、宽表格与 thinking/narration 分流 |
| 3. 工具与审批闭环 | `tool-read-bash`、`tool-parallel-ooo`、`tool-malformed-recovery`、`approval-deny`、`approval-allow`、`approval-cancel`、`question-answer`、`mode-switch` | 实时输出与 `runId` 一致；后发先至多工具不误触发 lane rebuild；畸形工具参数可恢复；**磁盘真实校验**（拒绝与审批中取消均不创建文件，允许后文件落盘）；提问选项与自由文本回传模型 |
| 4. Steer、排队与打断 | `steer-valid`、`steer-stale`、`busy-queue`、`interrupt-before-first-token`、`interrupt-mid-stream`、`interrupt-during-tool`、`interrupt-and-send` | Barrier 精确卡点；排队消息准确派发一次；首字前打断不留孤立占位回复；停止实际发出控制键/RPC 且后续可续聊；区分 `supportsTargetedStop` 真/假契约 |
| 5. Subagent 与后台任务 | `subagent-sync`、`subagent-bg-unblocked`、`bg-stop-single-and-multi`、`bg-shell-stop` | 子车道独立可读且测速不串算；后台运行期间主会话回 `idle` 且前台发送立即派发；同时覆盖 **1 个 vs 2 个并行后台任务** 的停止路径 |
| 6. 斜杠、压缩与动态配置 | `slash-compact`、`slash-clear`、`configure-idle`、`configure-while-bg` | `/compact` 保留指令、`/clear` 后请求审计无旧话题；后台运行时切配置触发 `configPending` 与 `runtimeControl` 并可应用 |
| 7. 重启、故障与跨版本 | `restart-idle`、`restart-mid-turn`、`cli-sigkill-recovery`、`stream-disconnect`、`http-error-recovery`、`cross-version-resume` | 持久目录停服保留终端并接管；运行中重启不丢结局且 Sync v3 `seq`/`generation` 不变；真 TCP 断流后草稿保留/转正；**旧版建会话 → 新版续聊** 保留 `nativeSessionId` 与历史条目 ID |
| 8. 扩展、MCP 与辅助对话 | `skills-discovery`、`mcp-tools-audit`、`side-chat` | 隔离 `~/.agents/skills` 与项目技能在扩展页与 `/` 菜单一致；假 LLM 审计 MCP 工具挂载与裁剪；`streamDiscussion` 流式问答与取消 |

**全局自动不变量（每个执行到的场景自动校验）**：

1. Sync v3 主车道与子车道 `seq` 严格连续唯一、每轮最终答案到达实时流；
2. 结束后无孤儿 CLI 进程、无残留隔离 `tmux` socket；
3. 沙盒守卫拒绝任何指向 `~/.local/share/riffet` 的读写；
4. 记录当次运行观察到的协议/事件词汇表，供漂移检查使用。

### 3.3 后端三档分层与仓外插件复用

| 档位 | 后端 | 接入策略 |
|---|---|---|
| **A 档（全量假 LLM）** | Claude Code、Codex、Pi、DSH、Antigravity、Droid（BYOK）、标准协议仓外插件 | 100% 离线假 LLM 跑全套适用场景与跨版本续聊；大版本发版前另补 1～2 轮真实网关抽检 |
| **B 档（混合模式）** | TRAE CLI（`traex`） | 探测、超时回收、App Server 握手与断连走本地桩；隔离配置可接本地 Responses 时升为 A 档，否则真实回合走最小抽检 |
| **C 档（存储 + 预加载 + 最小抽检）** | Cursor Agent | 不逆向私有协议；离线校验启动参数、预加载与 SQLite 读写，升级时配合 `--live` 跑最小真实账号抽检 |

仓外插件无需在主仓注册任何代码：运行 `pnpm cli:compat run <plugin.agentId> --plugin-dir <插件目录>` 即可复用同一套 `MockLlmHub` 与 TCK 场景集。

### 3.4 零膨胀录制与漂移闭环（每版全跑，有变才录）

- **PR CI（纯离线）**：继续只跑 `apps/server/src/backends/conformance.test.ts` 与既有 `fixtures/` 回放测试，守住已验证历史版本不退化。
- **新版预检（`scripts/cli-compat/drift.ts`）**：跑完 TCK 后，比对本次运行采集的输入词汇表（JSON-RPC method / item type、hook event、transcript row type）与 `apps/server/src/backends/*/fixtures/` 中最新录制：
  - **全绿且无新增未知签名**：不写入重复录制，直接更新兼容清单与 `testedThrough`；
  - **出现未知签名或场景失败**：只针对漂移/失败场景调用 `pnpm record` 或导出脱敏样本入库，修复适配并通过回放测试后再合入。

### 3.5 兼容凭据与运行时安全降级

1. **兼容清单（`apps/server/src/backends/compat-manifest.json`）**：记录每个仓内 CLI 后端最近一次验证的 `version`、`testedAt`、`os`、`mode` 及每个场景的四态结果。`pnpm cli:compat check-manifest` 校验源码中的 `cliVersions.testedThrough` 与清单版本严格一致且不含 `fail` 项。
2. **能力分级门控（`packages/plugin-api/src/kit/cli-version.ts#cliCapabilityMode`）**：
   - `blocked`：低于 `minimum`，按适配器规则拒绝启动；
   - `full`：处于 `[minimum, testedThrough]` 区间，启用全部能力；
   - `conservative`：高于 `testedThrough` 或版本不可读——**L1 基础通路**（发消息、收回复、读历史）照常放行并提示 `untested`；**L2 脆弱自动化**（多步 TUI 走屏、屏幕版面推断）自动退回保守模式，避免在未验证的新界面上误操作。
3. **上游哨兵（`scripts/cli-compat/upstream.ts`）**：查询各仓内 CLI 官方渠道的最新版本，对照本机安装版与 `testedThrough` 输出差异表，供「AIF 每周检查」定期调用；只产出报告，不自动改代码或覆盖本机 CLI。

## 4. 目录布局与命令

```text
scripts/cli-compat/
├── cli.ts                    # 统一命令行入口（pnpm cli:compat）
├── sandbox.ts                # 隔离目录、候选二进制、持久重启目录与进程清理
├── tck.ts                    # 统一 HTTP + Sync v3 场景执行器与全局不变量
├── drift.ts                  # 词汇表漂移对比与候选样本导出
├── manifest.ts               # compat-manifest.json 读写与一致性校验
├── upstream.ts               # 上游发布渠道最新版本检查
├── backends/                 # 各仓内后端及仓外插件的薄接入配置
└── mock-llm/
    ├── types.ts              # 归一化请求/剧本/故障/审计类型
    ├── gates.ts              # Barrier/Gate 双向同步栅栏
    ├── hub.ts                # HTTP + WebSocket 假 LLM 引擎与语义路由
    ├── scripts.ts            # 标准 TCK 场景剧本库
    └── protocols/            # anthropic / openai-responses(+ws) / openai-chat / gemini
```

常用命令：

```bash
pnpm cli:compat list                                        # 列出全部场景与后端接入档位
pnpm cli:compat check-manifest                              # 校验源码 testedThrough 与 compat-manifest.json 一致
pnpm cli:compat upstream [backend|all]                      # 检查官方渠道最新 CLI 版本（只读）
pnpm cli:compat run <backend|all> [--scenario id1,id2]      # 沙盒 + 假 LLM 跑 TCK
pnpm cli:compat run claude --bin /tmp/claude-new --prev-bin /usr/local/bin/claude --scenario cross-version-resume
pnpm cli:compat run <backend> --write-manifest              # 将本次实测结果写回 compat-manifest.json
```

## 5. 决定记录

| 日期 | 决定 | 原因 |
|---|---|---|
| 2026-11-28 | 假 LLM 引擎在仓库内基于 Node `http` + `ws` 零新增依赖实现，不引入外部 Go/Rust 二进制 | 开源 mock 工具缺少与宿主同步的 Barrier 原语，且跨平台二进制分发增加维护成本；Node 24 与 `ws` 已在仓库内 |
| 2026-11-28 | 未命中剧本的请求返回协议原生 417 错误，不做静默文本兜底 | 静默兜底会掩盖 CLI 升级后新增或改形的请求（借鉴 Goose `acp_fixtures`） |
| 2026-11-28 | 每版必跑 TCK、仅发生词汇表/行为漂移时落盘新录制 | 避免每个上游小版本复制整套 fixture 导致仓库膨胀与评审失焦 |
| 2026-11-28 | 未验证新版默认 L1 放行、L2 保守降级（`cliCapabilityMode`） | 不阻断用户升级 CLI，同时阻止多步按键或脆弱屏幕解析在未知版本上误操作 |
| 2026-11-28 | Cursor 与 TRAE 封闭路径不硬逆向伪造，采用 B/C 档混合验证 | 维护私有协议逆向 mock 的脆弱度高于适配本身，保留最小真实抽检更可靠 |
