# Riffet 团队与成员

日期：2026-11-25。状态：设计草案，演进替代 [ASSISTANT.md](ASSISTANT.md) 的单例「个人助理」。

将单例「个人助理」泛化为一组可自由创建、按需搭配能力的常驻成员（`AgentMember`）：个人领域专家（如投资理财）与项目专职岗位（如 QA、发版、SCM 打包）共用同一套底座，各自拥有独立的职责边界、经验记忆、模型与工具隔离。

## 1. 问题与定位

### 1.1 为什么演进掉单例个人助理

单例个人助理在高频、跨领域使用中会遇到三个结构性瓶颈：

1. **注意力与立场互相稀释**。在同一条主对话与同一份 `memory/` 里同时处理投资复盘、代码审阅和日常琐事，上下文噪音和思维定式会互相污染；工程里需要独立挑错的 QA 角色，也不能和追求交付的开发共享同一种「听话执行」心智。
2. **重复作业被迫依赖腐烂的长会话**。像跨环境打包（SCM / 发版）这类既要复用环境事实和踩坑经验、又需要临场判断的工作，用户往往被迫长期留着一条普通会话反复续聊——上下文越滚越脏、越跑越贵，压缩后反而丢掉关键参数。
3. **权限与记忆无法按岗位收窄**。全能助理同时持有个人记忆、所有项目视图、外部 MCP 和工作台设置能力；只要增加高风险外部工具，爆炸半径就是全局。

### 1.2 三层正交模型

团队不替代自动化，也不替代 IM 机器人。三者是正交的职责层，可自由交叉搭配：

| 层次 | 隐喻 | 职责 | 界面称呼 | 代码实体 |
| --- | --- | --- | --- | --- |
| 入口 | 谁来找 | Web、Mac、手机、飞书 / Telegram 渠道 | 端 / 机器人 | `Channel` |
| 触发 | 闹钟 | 定时（cron）、手动模板、后续、外部信号（Webhook 等） | 自动化 | `Automation` |
| 常驻角色 | 管家 | 固定职责、独立长期记忆、默认模型与能力边界 | **团队 / 成员** | `AgentMember` |

- 一个机器人（飞书 / Telegram 账号或群）可以绑定到任意项目或任意成员，不限制组合。
- 自动化（闹钟）保留其轻量价值；本期不改动自动化，远期可将自动化的执行目标扩展为唤醒指定成员（含 Webhook 等外部信号），见 §4.4。
- 原「个人助理」不再是硬编码特例，而是初始化或迁移后默认自带的第一个成员，可改名、调整配置或归档。

### 1.3 术语约定

`docs/GLOSSARY.md` 中，`Agent` 已指代 Claude Code / Codex / Cursor 等底层 CLI，`机器人 / Bot` 已指代飞书 / Telegram 通道，`档案 / Profile` 已指代后端配置档案。为避免出现「为这个 Agent 选择 Agent」的歧义：

| 位置 | 中文 | English | 说明 |
| --- | --- | --- | --- |
| 侧栏分组、移动端导航 | 团队 | Team | 替代原「个人助理」入口 |
| 单个常驻角色 | 成员 | Member | 界面不带 `Agent` 前缀 |
| 代码与协议类型 | — | `AgentMember` | 统一带 `agent` 前缀，与人类用户（`Owner`）区分 |

### 1.4 外部产品参考与取舍

| 范式 / 产品 | 取 | 不取 |
| --- | --- | --- |
| Claude Code Agent Teams | 独立上下文与独立 worktree；围绕共享任务单协作 | 任务级短命编队，结束后不沉淀项目级长期记忆 |
| OpenClaw / Hermes | 独立目录、受 git 管理的 Markdown 记忆、按身份隔离 MCP 与渠道 | 默认定时心跳空转烧 token；缺乏工程工单闭环 |
| CrewAI / Paperclip | 角色级运行预算上限与审批升级机制 | 拟人化群聊互相寒暄；人工维护冗长的静态 SOP 流水线 |
| Cursor Bugbot / Linear Agents | 极窄且独立的目标函数（挑错而非代写）；静默运行，有实锤才打扰 | 云端黑盒无状态，无法利用本机多端环境与可随时接管的实时终端 |

## 2. 核心模型

### 2.1 `AgentMember`

一个成员是一份持久化配置加一个独立目录。创建时只要求填写最小集合，其余能力在详情页按需开启：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | `string` | UUID；由原个人助理迁移而来的保留稳定 id（如 `default`） |
| `name` | `string` | 显示名称，如「个人助理」「投资理财」「Riffet QA」「SCM 打包」 |
| `scope` | `{ kind: 'global' \| 'personal' \| 'project'; projectIds?: string[] }` | 作用范围：`global` 可跨项目；`personal` 无代码项目；`project` 绑定 1 个或多个项目 |
| `sessionMode` | `'continuous' \| 'fresh'` | 会话方式：`continuous` 维护一条长期主对话（支持 `/new`）；`fresh` 每次发起开一条干净的新会话 |
| `target` | `{ backendId; profileId?; model?; permissionMode? }` | 默认使用的底层 Agent（限支持隔离的后端 `ASSISTANT_BACKENDS`）、Provider、模型与权限档位 |
| `capabilities` | `AgentMemberCapabilities` | 按需开关的 Riffet 能力集合（§4.1），自动受 `scope` 约束 |
| `memory` | `{ consolidation: boolean }` | 是否参与每晚自动记忆整理，默认开 |
| `budget` | `{ dailyRuns: number }` | 任意 24 小时内后台运行次数上限，受 `TEAM_BUDGET` 约束 |
| `mainSessionId?` | `string` | 仅 `continuous` 模式：当前主对话 id |
| `pinned?` | `boolean` | 侧栏置顶标记 |
| `archivedAt?` | `number` | 归档时间；归档后停止后台触发并移出默认列表，记忆与历史会话保留 |
| `createdAt`、`updatedAt` | `number` | 创建与修改时间 |

成员对应的底层会话在 `Session` 上记录 `agentMemberId`；后台运行的会话沿用 `origin: { kind: 'agent-member', memberId, job, runId }`（兼容旧 `{ kind: 'assistant', ... }`）。

### 2.2 成员与普通会话的边界

- **普通项目会话**：一次性需求、临时探索、常规编码开发。用完归档，不维护独立身份和账本。
- **成员**：需要**长期积累专属记忆**、**保持独立立场**（如 QA 挑错、理财风控），或**反复复用固定配置与经验**（如发版、SCM 打包）的长期岗位。
- **零摩擦转化**：在任意本地交互式会话中，可直接让 Agent 调用 `agent_member` MCP 工具总结当前会话沉淀并创建/更新成员（§5.3），无需另起独立提炼接口或手工填表。

## 3. 目录、文件与记忆规则

不发明新的配置格式，直接复用业界与现有助理已验证的 `AGENTS.md`、`USER.md`、`memory/`、`.claude/skills/`、`packs/`、`.mcp.json`、`files/`，重点明确多成员与项目绑定后的职责划分和更新机制。

### 3.1 目录布局

```text
<stateDir>/team/
  USER.md                        # 全局极简主人档案（跨成员只读共享）
  <memberId>/                    # 独立 git 仓库，权限 0700
    AGENTS.md                    # 该成员的岗位职责、验收标准与红线
    CLAUDE.md                    # 服务端生成，引入 AGENTS.md 与全局 USER.md
    memory/
      MEMORY.md                  # 成员私有记忆索引（≤150 行）
      <主题>.md                  # 按主题细分的经验账本、踩坑记录、基准水位
    .claude/
      skills/<名称>/SKILL.md     # 成员专属 skill
      settings.json              # 成员局部设置
    packs/<packId>/              # 安装给该成员的能力包
    files/                       # 成员产出的长期文件（研报、检查报告等）
    .mcp.json                    # 成员专属 MCP 声明
```

成员会话的 CLI 历史与用户自己的会话一样，写在 CLI 原生目录（或提供商显式选择的配置目录）：Claude Code 在 `~/.claude/projects/<成员目录>/`，Codex 在 `~/.codex/sessions/`。只有 CLI 无法在单次启动里注入会话所需的配置时，才为成员换一套配置根，历史随之移动；目前只有 Cursor，否则 `~/.cursor` 的全局编码规则会进入成员的提示，它的成员会话在 `<stateDir>/cursor-standing/`。换配置根的代价是成员要单独登录、拿不到用户装的 skill 和 MCP，用量工具也统计不到，所以不作为默认。

系统提示与 Riffet 自带 skill 仍放在 `<stateDir>/team-runtime/`（成员目录之外），每次服务端启动重写，不进成员的 git 历史，成员的文件工具无法改写。

### 3.2 各文件的职责、读写权限与更新机制

| 文件 | 承担作用 | 谁可写 | 何时更新 |
| --- | --- | --- | --- |
| 全局 `USER.md` | 所有成员共知的基础背景：称呼、沟通风格、全局禁忌（硬限 ≤1000 字符） | **仅用户可写**（或成员提议、用户确认后写入） | 低频；禁止成员静默覆盖，避免跨领域记忆串味与并发冲突 |
| 成员 `AGENTS.md` | 岗位说明书：管什么、目标函数、输出约定、红线 | **仅用户可写**（沿用现有写保护；成员只能在回复里提议修改） | 创建或从会话提炼时生成；职责调整时人工修改 |
| 成员 `memory/` | 专业经验账本：环境指纹、踩过的坑、历史回归点、持仓复盘、已核查水位 | **成员可写**，用户可在界面删改 | 见 §3.4 双模式闭环；每轮结束 5 秒后自动 git commit（同 [ASSISTANT.md](ASSISTANT.md) §2） |
| `.claude/skills/`、`.mcp.json` | 成员独占技能与外部数据源 | 用户在成员配置页管理 | 按需增删，互不干扰 |
| `files/` | 面向用户的持久化交付物 | 成员可写，用户只读下载 | 运行过程中产出，不进成员 git 历史 |

### 3.3 绑定项目时的双 `AGENTS.md` 规则

当成员绑定了代码项目（`scope.kind === 'project'`，例如 `Riffet QA`、`SCM 打包`）时，CLI 的工作目录 `cwd` 必须落在**项目目录或从中切出的 worktree**，而不是 `<stateDir>/team/<memberId>/`。此时会同时存在两份 `AGENTS.md`：

1. **项目仓库的 `AGENTS.md` / `CLAUDE.md`**：由 CLI 按工作目录自然读取，负责仓库架构、编码约定、校验命令。
2. **成员自己的 `AGENTS.md` + 全局 `USER.md` + 成员 `<stateDir>/team/<memberId>/memory/MEMORY.md`**：由服务端通过隔离启动参数注入系统 / developer 指令层，同时把 `autoMemoryDirectory` 指向 `<stateDir>/team/<memberId>/memory/`。

冲突优先级明确写入成员系统提示：
- 涉及**代码风格、目录边界、仓库命令** → 服从项目仓库的 `AGENTS.md`；
- 涉及**岗位职责、权限红线、输出结构**（例如 QA 不得直接修改业务代码、发版必须走预检清单）→ 成员的 `AGENTS.md` 优先。
- **提交和推送分支**是项目工作的一部分，不用另外问用户：按项目仓库和成员 `AGENTS.md` 的规定做，二者禁止或要求先确认时照做。

系统提示分三层拼接（`assistant/home.ts#memberSystemPrompt`）：所有成员共用的工作方式与默认权限（`prompts/assistant-system.md`）；只描述环境、不定义身份的环境段（`prompts/member-environment.md`：成员目录与用户资料的路径、工作目录、用户资料是否可写、连续或每次新对话）；按能力追加的段落（`workbenchAdmin` 加 `prompts/workbench-admin.md`）。成员的身份和职责只来自成员 `AGENTS.md`，默认成员也一样，系统提示不给它单独的角色；它可以放宽或收紧「直接做」「先问再做」两级默认权限，「由用户决定」一级不受影响：改成员自己的 `AGENTS.md`、配置和权限，只在用户在对话里亲自要求时经 `agent_member` 做。每个成员一个系统提示文件（`assistant-runtime/system-prompt-<memberId>.md`）。

当成员为 `personal` 或 `global`（无特定项目）时，`cwd` 直接落在 `<stateDir>/team/<memberId>/`，与现有助理一致。

### 3.4 双会话模式的记忆更新闭环

记忆必须随执行自然沉淀，不依赖用户手工维护规则：

- **连续对话（`continuous`）**：沿用 [ASSISTANT.md](ASSISTANT.md) §5.4 与 §7.4。对话中当轮写入新结论（明确区分 `Said` 与 `Inferred` 并标出处日期），每晚 4 点（用户时区）及主对话压缩前自动整理去重、压回体积上限。
- **按次新建（`fresh`）**：
  1. **运行收尾自记**：系统提示要求成员在结束本轮前，将新发现的环境事实、踩坑规避方法、最新基准水位（如 `lastVerifiedCommit`、最新版本号）写入自己的 `memory/`；
  2. **夜间兜底整理**：每晚 4 点，如果该成员过去 24 小时有新完成的独立会话且启用了 `memory.consolidation`，整理任务读取这些会话的最终摘要与改动，补记漏掉的经验并清理过期条目。过去 24 小时无运行的成员直接跳过，零消耗。

## 4. 能力拼装、隔离与协作

### 4.1 能力积木（拆解原个人助理特权）

不再将看板、工作台设置等权限硬编码给某一个特殊实体，而是拆为 6 项可按需开关的能力，且自动受 `scope` 收窄：

| 能力键 | 包含工具与行为 | 作用域约束 | 典型成员 |
| --- | --- | --- | --- |
| `workspace` | 读文件、跑命令、在独立 worktree 中改动（受权限档位控制） | `project` 限绑定项目；`personal` 仅限成员自己目录 | QA（只读 / 独立 worktree）、打包 / 发版 |
| `taskBoard` | `task_list`、`task_get`、`task_create`、`task_start`、`task_comment`、后台跟进（`supervision`） | `project` **仅可读写所属项目的任务与会话**；`global` 可跨项目 | 默认总管（全局）、QA（仅限本项目的建单与返工） |
| `delegations` | `delegation_*`（定时、网页变化、GitHub 发版、任务状态、插件事件） | 任务类订阅受 `scope` 限制 | 投资理财、QA、默认总管 |
| `memberCalls` | 调用其他已授权成员（扩展 `agent_call`） | 只可调用显式允许的目标成员，深度上限 1 | 默认总管、Release（可咨询 QA） |
| `externalTools` | Riffet 浏览器、已授权的配对设备、成员专属 MCP 与 Skill | 按成员目录物理隔离 | 投资理财（行情 MCP + 浏览器）、QA（浏览器 E2E） |
| `workbenchAdmin` | `server_status`、`capability_read`、`setting_set`、外观与默认模型调整 | 仅限本机且仅在真实用户回合生效 | 默认只给初始化生成的默认成员开启 |

权限分级（直接做 / 先问用户 / 无此能力）沿用 [ASSISTANT.md](ASSISTANT.md) §6 的规则；后台运行统一以 `dontAsk` 启动，审批与高危发布确认只能交由用户在收件箱处理。

### 4.2 运行时隔离与不变量

底层支持与 [ASSISTANT.md](ASSISTANT.md) §4 一致，限定在实现了配置隔离的后端（`ASSISTANT_BACKENDS`：Claude Code、Codex、Cursor）：

- `NativeStandingHost` 从单例改为按 `agentMemberId` 解析：`launch(project, session)` 返回该成员独立的 `systemPromptFile`、`memoryDir`、`mcpConfigFiles`、`pluginDirs`、`protectedFiles`、`instructionFiles`、`skillsDir`。
- **预热键与工具列表不变量**（见 `apps/server/src/AGENTS.md`）：将 `agentMemberId` 纳入 `backends/shared/launch-input.ts#SessionLaunchInput`，各后端预热池按成员隔离键匹配，避免不同成员误复用彼此的 CLI 进程；同步更新 `riffet-mcp/service.ts#draftOf`，按该成员的 `capabilities` 与 `scope` 精确裁剪暴露给 CLI 的 MCP 工具集。

### 4.3 跨成员协作：围绕工件，禁止自由群聊

成员之间不提供自由多轮群聊，避免烧 token 空转与上下文漂移。协作只走两条受控路径：

1. **按需点名咨询 / 委派**：扩展 [AGENT-CALLS.md](AGENT-CALLS.md)，允许用户在任意会话中 `@成员名`（排在 `@Claude` / `@Codex` 之前），用户显式 `@` 一律视为当场授权；拥有 `memberCalls` 能力的成员则可在 `agent_list` 中看到团队成员并自主发起调用。被调用方仍是一条带 `agentMemberId` 且可点开查看、可随时插话的独立真实会话（深度上限 1，不与主对话混跑并发），并在被调用成员自己的页面左侧会话列表里集中展示；消息气泡右侧标出发送者头像与名称，来信气泡克制使用低饱和度色彩与用户本人消息区分。
2. **项目看板闭环**：同一项目下的开发会话、QA 成员与发版成员共享项目看板（[TASK-BOARD.md](TASK-BOARD.md)）：
   - QA 核查发现问题时，关联原任务则打回返工（沿用最多 2 轮上限，推不动进收件箱），发现主分支增量回归则直接在看板建单；
   - 打包 / 发版成员在门禁中发现旧测试断言过时等仓库债务时，除记录本次构建结果外，顺手在看板建单跟踪，不再让问题埋在聊天历史里。

### 4.4 与自动化（闹钟）的衔接（远期规划，本期不实现）

现有 `Automation`（[ORCHESTRATION.md](ORCHESTRATION.md) §5）保持不动。后续演进时，`Automation` 保持「触发条件 → 执行目标」的定位，只需做两项增量扩展即可与团队无缝打通：
- **执行目标**支持指向指定 `agentMemberId`（使用该成员的记忆、模型、能力与会话模式，而不只是无状态的 `projectId + target`）；
- **触发条件**扩展支持外部信号（如 Webhook、Git 分支新提交事件），作为唤醒成员的统一外部闹钟。

## 5. 界面与交互

### 5.1 侧栏入口

- 原侧栏顶部的「个人助理」行演化为可展开/收起的 **「团队 / Team」** 分组（手机底栏对应「团队」标签）。
- 初期所有未归档成员统一列在「团队」分组下，减少层级跳转；绑定了项目的成员在行尾以次级标签标出项目名，支持置顶排序。运行中、等确认、未读状态标记沿用现有会话行规则。
- 分组标题行尾提供「新建」快捷操作；归档成员收在管理页中，不占日常侧栏。
- *待观察*：当用户创建超过约 6–8 个成员后，再评估是否把 `project` 作用域成员同时折叠展示在各自项目树下。

### 5.2 成员主页（双模式共用骨架）

点开任意成员进入成员主页。页头固定显示成员名称、作用域标记（无项目时不显示）与右侧三个标准图标（成员信息、侧边面板、更多操作）：

- **`continuous` 模式（连续对话）**：直接呈现当前主对话，支持 `/new` 开启新话题，交互与原个人助理页一致；绑定项目的成员保留与项目相关的路径预览与变更侧板，无项目成员按 [ASSISTANT.md](ASSISTANT.md) §3.1 隐藏代码专属控件。
- **`fresh` 模式（按次新建）**：主区域直接是干净的新会话输入框（可附 2–3 条常用快捷提示词），每次发送创建一条属于该成员的新独立会话；下方或可切换列表展示该成员历次运行记录（时间、标题/摘要、状态），点开任意一条可查看完整转录或继续追问。

「成员信息」抽屉沿用现有助理页结构，提供四项入口：
1. **记忆**：查看全局 `USER.md`（只读跳转编辑）与本成员 `memory/` 主题文件（可删除）；
2. **职责与配置**：编辑 `AGENTS.md`、默认底层 Agent/模型/权限、会话模式、作用域与每日运行上限；
3. **能力**：开关 6 项 Riffet 能力，管理本成员的 Skill、能力包与 MCP；
4. **文件与委托**：沿用现有弹窗，分别管理 `files/` 产出与本成员的委托。

### 5.3 创建与演进

提供低成本创建与维护路径：

1. **极简新建**：表单只暴露常用项——头像、名称、职责说明（`AGENTS.md`）、工作范围（个人领域 / 绑定项目 / 全局）、底层 Agent 与会话模式；其余能力使用按作用域推导的合理默认值（例如个人领域默认开委托与浏览器、关工作区与看板；项目成员默认开工作区只读与本项目看板）。
2. **对话内通过 `agent_member` MCP 工具沉淀**：在任意本地交互式会话中，用户可以直接要求当前 Agent 基于本次对话上下文调用 `agent_member` 工具（`list` / `get` / `create` / `update`）创建新成员或迭代既有成员的 `AGENTS.md` 与配置，替代早期的菜单「提炼为成员」入口。
3. **从已有成员拆分**：在成员的记忆弹窗中，允许选中某主题文件（如 `<memberDir>/memory/investing.md`）一键迁出为独立新成员，连同相关委托一起转移，原记忆移出。

### 5.4 统一收件箱与 IM 通道

- **单收件箱**：所有成员产生的审批、提问、推不动的返工、以及需要拍板的 `ask` 报告，全部汇入同一个收件箱，条目附来源成员名称。
- **IM 通道交叉绑定**：[channels.md](design/channels.md) 的聊天绑定从「项目 / 唯一助理」扩展为「项目 / 任意成员」。一个飞书私聊或独立 Telegram 机器人可以直接绑定某个成员（例如专属投资理财 Bot、项目发版群 Bot）；群聊按成员自己的 `scope` 与 `capabilities` 生效，不会越权泄露其他成员记忆。

## 6. 典型场景走查

| 场景 | 名称 | 作用域 | 会话模式 | 能力搭配 | 记忆与运作方式 |
| --- | --- | --- | --- | --- | --- |
| 个人深聊专家 | 投资理财 | `personal` | `continuous` | `delegations`、`externalTools`（行情 MCP + 浏览器） | 独立持仓逻辑、标的复盘与风控纪律；网页/定时委托盯财报与异动，完全不碰代码与工作台 |
| 高速迭代质量守门 | Riffet QA | `project: [riffet]` | `fresh` | `workspace`（只读或独立 worktree）、`taskBoard`（仅 `riffet`）、`externalTools`（浏览器） | 记账 `lastVerifiedCommit` 与历史高频回归区；独立上下文跑 `pnpm verify` 与跨端核对，发现实锤建单或打回返工，全绿静默 |
| 经验型发版 / 打包 | SCM 打包 | `project: [arch_agent]` | `fresh` | `workspace`、`taskBoard`（仅 `arch_agent`） | 从旧打包长会话一键提炼；每次一句话起干净会话跑全套构建、上传与回读验收，遇过时测试顺手建单，关键发布动作进收件箱确认 |
| 跨项目总管 | 个人助理（默认） | `global` | `continuous` | 全量按需开启（含 `memberCalls`、`workbenchAdmin`） | 负责跨项目统筹、日程提醒、不知道找谁时的统一入口，必要时通过 `@成员` 咨询专职成员 |

## 7. 从现有「个人助理」的迁移

升级必须无损，不丢失任何记忆、对话或通道绑定：

1. **目录与数据**：首次启动检测到旧 `<stateDir>/assistant/` 且无 `<stateDir>/team/` 时，执行一次性幂等迁移：
   - 将原 `USER.md` 复制到 `<stateDir>/team/USER.md`（若超过全局上限，保留副本并在通知中提示整理）；
   - 将 `<stateDir>/assistant/` 迁为 `<stateDir>/team/default/`（保留完整 git 历史、`AGENTS.md`、`memory/`、`.claude/skills/`、`packs/`、`files/`、`.mcp.json`）；
   - 创建默认 `AgentMember`（`id: 'default'`，`name: '个人助理'`，`scope: { kind: 'global' }`，`sessionMode: 'continuous'`，沿用 `AppSettings.assistant` 的后端/模型/开关设置并开启原全量能力）。
2. **数据库关联**：
   - 原系统项目 `Project.system === 'assistant'` 与 `mainSessionId` 绑定至 `default` 成员；
   - `assistant_runs`、`delegations`、`pending_notices` 增加 `agent_member_id` 列，存量行回填 `'default'`；
   - IM 通道中绑定到「个人助理」的聊天记录自动映射到 `member: 'default'`。
3. **能力包（Packs）**：原全局助理能力包机制保留，变为可安装到任意成员的 `packs/`；同时支持在「新建成员」时直接从能力包生成独立成员（如基于理财包创建「投资理财」成员）。
4. **旧客户端兼容**：通过 `ProtocolFeature` 声明团队能力；未升级的旧客户端继续读写 `default` 成员对应的兼容接口（`/api/assistant/*` 转发到 `default` 成员），不中断使用。

## 8. 接口、预算、多服务器与客户端范围

### 8.1 HTTP 接口概览

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/team/members` | 列出全部成员（含默认与归档过滤参数）及最近状态摘要 |
| `POST /api/team/members` | 新建成员（生成独立目录与初始 `AGENTS.md`） |
| `PATCH /api/team/members/:id` / `DELETE /api/team/members/:id` | 更新配置、归档或删除成员 |
| `GET/PUT /api/team/user-profile` | 读写全局共享 `USER.md` |
| `GET/PUT /api/team/members/:id/instructions` | 读写该成员 `AGENTS.md` |
| `GET /api/team/members/:id/memory`、`DELETE .../memory/:name` | 查看与删除成员私有记忆主题文件 |
| `GET /api/team/members/:id/files`、`GET .../file` | 列出与下载成员 `files/` 产出 |
| `GET /api/team/members/:id/runs` | 成员历次独立运行与后台运行记录 |
| `POST /api/team/members/:id/sessions` | 为该成员发起新会话（`fresh` 模式新建；`continuous` 模式返回或初始化主对话） |

原有 `/api/assistant/*` 接口作为兼容别名保留一个过渡周期，默认指向 `default` 成员。

### 8.2 资源预算

上限统一声明在 `packages/contracts/src/budgets.ts` 的 `TEAM_BUDGET`（替代或扩展 `ASSISTANT_BUDGET`）：
- 单台服务器活跃成员上限（如 24 个）；
- 全局 `USER.md` 字符上限（1,000 字符）；
- 成员级与全服务器级并发后台运行上限（如全局并发 3、单成员并发 1）及 24 小时总运行次数上限，避免多个成员叠加导致失控扣费；
- 每个成员的 `memory/` 读取、主题文件数量与运行历史保留策略沿用 `ASSISTANT_BUDGET` 上限，成员删除时一并回收记录与目录。

### 8.3 多服务器

按 [多服务器适配规范](guide/multi-server.md) §2 逐条核对：

1. **归类**：`personal` 与 `global` 作用域成员属于 **C 类**（属于用户本人的偏好与工具，只用入口服务器本机）；绑定特定项目的 `project` 成员依附于对应项目机器，**第一期统一按本机（C 类边界）处理**——只在项目所在服务器创建与使用，跨服务器查看对端项目成员在支持跨服务器派活后再扩展。
2. **A 类合并与离线**：第一期成员不跨服务器合并列表；与项目关联的普通执行会话仍按 A 类照常出现在会话列表，带所在服务器标识，对端离线时只读灰显。
3. **路由链接策略**：`/api/team/*` 全部在链接策略表登记为 `deny`（返回 403 `LINK_FORBIDDEN`）；成员下普通项目会话沿用 `/api/sessions` 前缀的 `serve`。
4. **客户端请求**：各端一律经按服务器选目标的请求层发往本机入口（`lib/server-routing.ts`），业务代码不手拼 `/api/team/...`。
5. **对象标识**：成员 `id` 使用 UUID（默认迁移成员为 `default`），跨服务器不会产生编号歧义；不引入服务器内自增序号。
6. **插件扩展点范围**：现有 `assistantEvents`、`assistantPack` 继续归为 `global`（仅作用于本机成员）；不新增 `object` 级扩展点。
7. **Riffet MCP 工具**：沿用 `defineRead` 的 `servers` 声明；只有开启跨项目 `global` 作用域且工具本身标为 `linked` 时才跨服务器查询，其他成员的工具一律 `local`。
8. **入口缓存**：无跨服务器成员副本缓存；本机成员列表随 bootstrap 与列表流同步。
9. **提醒与推送**：由成员所在服务器发出，入口代推时按 `(serverId, memberId, runId)` 去重。
10. **协议兼容**：在 `packages/contracts/src/protocol.ts` 新增 `ProtocolFeature`（如 `team-members`）；对端或旧客户端无此能力时回退到旧单助理视图（映射 `default` 成员）。
11. **控制权保护**：`/api/team/*` 经链接拒绝，对端无法借链接读取、修改本机成员记忆、MCP 凭据或工作台设置。

### 8.4 客户端范围

- **Web**：完整实现（侧栏团队列表、成员双模式主页、新建与从会话提炼、成员配置与记忆管理、通道绑定）。
- **Mac**：`Mac：W 类（侧栏团队入口、成员对话与按次发起、统一收件箱），M 类（创建成员、编辑职责/能力/记忆/预算、提炼配置）`。W 类随主线做原生实现，M 类通过 `WebHandoff.open(_:in:)` 一步直达 Web 对应成员配置页，不新增原生管理表单。
- **Android / iOS**：底栏「团队」标签是成员列表（[移动端页面](design/system/mobile.md) §9.12）：连续对话的成员直接进主对话，每次新建的成员进它的会话列表；会话详情面板里看记忆、规则、能力、文件与委托；可新建（头像、名称、职责、范围、会话方式、Agent）、置顶、归档、删除成员；会话页输入框支持 `@` 成员与 Agent。能力开关、每日运行上限与其余配置在 Web 上改。

## 9. 分期规划与待定项

### 9.1 建议分期

- **Phase 1（多成员底座与迁移）**：实现 `AgentMember` 存储与 `<stateDir>/team/` 目录管理、旧个人助理无损迁移、`continuous` / `fresh` 双会话模式、侧栏可折叠「团队」列表，以及通过 `agent_member` MCP 工具在会话中创建与迭代成员。
- **Phase 2（项目绑定、能力拼装与协作）**：落地绑定项目时的双 `AGENTS.md` 注入、`6` 项能力按作用域裁剪、项目看板闭环（建单/返工）、扩展 `@成员` 调用，以及 IM 机器人绑定到指定成员。
- **Phase 3（外部闹钟与仓库共享）**：自动化（`Automation`）支持将执行目标指向成员并接入 Webhook / Git 提交信号；探索项目成员职责随仓库 `.riffet/team/` 共享（本机私有账本与凭据仍留在 `<stateDir>`）；统计页增加按成员维度的 token 用量与产出视图。

### 9.2 待定项

- **侧栏多成员收纳**：当用户创建大量绑定项目的成员后，是否在项目树下同步展示该项目成员，留待 Phase 1 实际使用后决定。
- **全局 `USER.md` 的更新体验**：是否允许 `default` 成员在对话中发起「更新全局档案」的结构化确认卡片，还是完全由用户在设置页手动编辑。
- **成员默认头像 / 视觉区分**：遵循 `DECISIONS.md`「侧栏保持克制、不堆砌花哨图标」的原则，侧栏成员行使用统一中性图标还是轻量自定义标识（如首字/Lucide 图标），实现界面前在 `/design` 页对照确认。
