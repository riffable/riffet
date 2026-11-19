# Riffet 仓库指南

写给在本仓库工作的人和 agent。这里只放容易做错的规则；目录结构、数据流读代码就能知道，不写在这里。

子目录的 AGENTS.md 补充该目录的规则，改那里的文件前先读：

| 目录 | 内容 | 补充规则 |
|---|---|---|
| `apps/server/` | 服务端（Node） | 本文「服务端」 |
| `apps/web/` | Web 客户端（React、Tailwind、Lingui） | [apps/web/AGENTS.md](apps/web/AGENTS.md) |
| `apps/macos/` | Mac 客户端（SwiftUI、AppKit） | [apps/macos/AGENTS.md](apps/macos/AGENTS.md) |
| `apps/mobile/` | Android 与 iOS（Kotlin Multiplatform、Compose、SwiftUI） | [apps/mobile/AGENTS.md](apps/mobile/AGENTS.md) |
| `packages/` | 各端共用的契约、插件 API 与 SDK、时间线 | — |
| `docs/design/` | 设计规范与设计决定 | 本文「改界面」 |

## 原则

- 如无必要，勿增实体。
- 保持组件模块化，关注点分离。
- 先复用项目里已有的依赖、组件和工具函数，再考虑自己实现或新增依赖。
- 没查官方文档和类型定义之前，不假定某个库没有对应能力。
- 架构决策按长期来定。
- 内部专用的能力不进本仓库：核心只提供通用扩展点，具体逻辑写成插件放在仓库外。

## 命令

需要 Node.js >= 24.19 和 pnpm。

```bash
pnpm install
pnpm dev                # 服务端
pnpm dev:web            # Web，热更新
pnpm typecheck          # 全仓类型检查
pnpm test               # vitest；单个目录：npx vitest run apps/web
```

开工前和提交前各跑一条命令（[AI 友好工程机制](docs/guide/aif.md)）：

```bash
pnpm aif context [路径...]   # 范围内模块的规则、同改项、录制数据和验证命令
pnpm verify [路径...]        # 按改动路径选出检查、模块验证和受影响的测试
```

不传路径时取工作区的全部改动，可能混入其他会话的修改。改动路径到检查的对应关系在 `scripts/aif.ts` 的 `GLOBAL_CHECKS`，生成物检查从各生成脚本推导，CI 跑全量（`.github/workflows/verify.yml`）。`verify` 只做检查，生成要自己跑：Web 文案先 `pnpm i18n:extract` 并补齐英文；生成物过期时（`verify` 里某个 `gen:*:check` 失败）跑对应的 `pnpm gen:<名字>`。

`AGENTS.md` 头部声明了 `module:` 的目录是一个模块，规则见 [AI 友好工程机制](docs/guide/aif.md) §5。修复模块里非显然的问题时，在同一个提交里给模块文档的「外部行为」或「排障」补一条；修改 Agent CLI 输出解析的修复，用 `pnpm record` 补录制数据。

## 改界面

新页面、新功能和对现有界面的改动，都按设计规范做。规范在 `docs/design/system/`，每端还有一页设计规范页，用真实组件画出所有取值和状态（Web 的地址是 `/design`）。

**动手前**

1. 读 [设计决定](docs/design/DECISIONS.md)。里面否决过的做法不再做；要推翻一条，就追加一条新的决定，写明原因。
2. 在 [设计体系](docs/design/system/README.md) §1 的分层里找到改动所属的章节，读对应文档：取值在 [基础](docs/design/system/foundations.md)，部件在 [组件](docs/design/system/components/)，页面结构、浮层、反馈、确认、表单、列表、搜索、键盘在 [模式](docs/design/system/patterns.md)，会话和侧边面板在 [界面](docs/design/system/surfaces.md)，用词在 [文案](docs/design/system/content.md)，插件视图在 [插件界面](docs/design/system/plugins.md)。

**实现时**

- 从大到小套用：先选页面类型和浮层（模式），再用已有组件，最后才落到取值。不要在业务代码里写一次性的按钮、输入框、列表行、弹窗。
- 取值只用设计变量：颜色、字号、圆角、间距、阴影、层级、动效时长和曲线。`pnpm check:design` 会拦下手写值；确实要破例的，在该行或上一行写 `design-rules: allow <原因>`。
- 规范里没有合适的组件或模式时，先补规范再写代码：组件按 [模板](docs/design/system/components/TEMPLATE.md) 在对应组的文档里加一节，然后实现，在设计规范页加样张，最后迁移已有的同类写法。只建组件不迁移，新旧写法会长期并存。
- 要和规范不一致，就先改规范（必要时在 DECISIONS.md 追加决定），不在代码里悄悄偏离。
- 规范各节末尾的「现状」列着与规则不符的现有代码。迁移了哪条就删哪条；新留下的不一致，也记进去。
- 文案只写读者推断不出的信息（存储位置、能否撤销、权限、费用、下一步），不复述界面，不写操作说明，不用感叹号。细则在 [文案](docs/design/system/content.md)。
- 键盘可达、焦点可见、对比度、减弱动效按 [基础](docs/design/system/foundations.md) 的无障碍一节做。

**交付前**

- 打开设计规范页的对应章节，和自己的改动对照一遍：间距、字号、状态（悬停、按下、焦点、禁用、加载、空、错误）、深浅色、窄屏。
- 列出新增的用户可见文字，逐条问：删掉它，用户会做错什么？答不上来就删。
- 新组件或新模式落地时，规范文档和设计规范页在同一次改动里更新。

## 性能

- 缓存、流缓冲、轮询、长列表、持久化数据、服务拉起的长期子进程按 [性能与资源规范](docs/guide/performance.md) 做：上限取自 `packages/contracts/src/budgets.ts`，不在业务代码里另写数字；每份常驻数据要有释放时机，每个子进程要有所有者和回收条件。
- 规范 §6「现状」列着不符合规则的现有代码。迁移了哪条就删哪条；新留下的不一致也记进去。

## 服务端

- 按层组织，导入只能指向下层（[架构](docs/guide/architecture.md)「服务端分层」）。`pnpm check:layers` 会拦下新增的越层导入；需要上层的东西时由 `app.ts` 传进来，或者把公共部分下沉。
- 预热的进程只交给启动配置与预热键完全一致的新会话，不一致时静默冷启动，没有报错（[插件架构](docs/PLUGIN_ARCHITECTURE.md)「预热」）。页面的请求一律经 `resolveNativeSessionInput` 解析，会话一侧读存储的会话；给会话加了影响启动或工具列表的字段，要同时加进各 Agent 的键（Cursor `resourceKey`、Codex `warmKey`、Claude `claudeWarmKey`），影响 Riffet MCP 工具的还要让 `RiffetMcpService.draftOf` 跟上。服务日志里持续出现 `prewarm: a new session did not match` 就是键算偏了。

## 测试与验证

- 非必要不加测试。新功能、修复和重构不自动要求新测试；先用已有测试、类型检查、构建和针对性验证。
- 自动化测试只保留核心行为：鉴权与数据隔离、外部协议契约、幂等与副作用次数、持久化、并发一致性、故障恢复。
- 不加、也不维护 UI 展示测试，包括布局、样式、颜色、图标、文案、动画、快照，以及由 UI 驱动、与业务测试重复的用例。简单 getter、格式化函数，以及和实现逐分支对应的断言，也不补测试。
- 只有现有验证覆盖不住关键风险时，才补最少的代表用例：优先扩展已有的核心测试，在离行为边界最近的一层验证。
- 不为覆盖率或测试数量加测试，不为方便测试引入生产代码里不需要的接口、抽象或依赖。
- 改完跑受影响的测试和检查。纯 UI 改动以类型检查、编译和实际界面检查为主；没有新风险时不重复整套平台构建。
- 汇报时写明实际跑了哪些验证、覆盖到哪里。

## 提交

- 提交信息用 `type(scope): 小写开头的英文摘要`，例如 `feat(web): …`、`fix(tabs): …`、`docs(design): …`。
- 有 AI 参与编写的提交，带上实际模型的 `Co-authored-by` 署名。
- 使用者能感知的 `feat`、`fix`、`perf`，在同一个提交里给 `CHANGELOG.md` 和 `CHANGELOG.zh-CN.md` 的未发布节各加一条，两份一一对应，写使用者看到的变化而不是实现。CI 对漏写的提交只给警告。
- `fix` 提交在尾注写 `Missed: <类型>`，说明缺了什么：`context`、`co-change`、`external`、`invariant`、`cross-platform`、`logic`（[§5.6](docs/guide/aif.md)）。CI 对漏写的提交只给警告。
- 仓库会公开。代码、文档、提交信息里不写凭据、个人信息、内部系统的地址和内部数据。
- PR 按 [模板](.github/pull_request_template.md) 填写；涉及界面的，勾选设计规范的自查项。

## 协作方式

- 与外部站点交互优先用 API 或 MCP；只有明确要求时才用浏览器控制。
- 简单任务自己做。边界清楚的工作可以委派 subagent：explorer 只读定位、收集证据，返回文件、行号和结论；worker 在明确范围内实现并做局部验证。
- 并行的 worker 写入范围互不重叠，由主 agent 审查和整合。委派的目的是更快拿到证据、改得更稳，不是为了委派而委派。

## 维护本文件

- 规则写「要避开的坑」，不写目录地图：后者读代码就能知道，而且很快过时。
- 新规则要同时满足三条：不明显，熟悉代码的人也会做错；反复出现过；具体到能照做。
- 只适用于一个子目录的规则，写进那个目录的 AGENTS.md。
- 能从源码文本识别的规则，同时写进对应的 `check:*` 脚本，让 CI 拦截。
