# 代码结构与前端约定

返回 [中文 README](../../README.zh-CN.md)。

## 代码结构

`apps/server/src/backends` 定义共享 native driver、注册表、profile 和调度接缝，包含 Codex/Claude/DSH/Droid 等适配器（TRAE CLI 是 Codex 驱动的一个 flavor，见 `backends/codex/flavors.ts`），并把插件提供的 Agent 后端挂入同一注册表（`plugin-backend.ts`）；Cursor 是官方插件 `plugins/riffet/cursor/`，转录、交互、模型目录与标题回填都在其中；`apps/server/src/native` 保留跨后端的持久投递调度，`terminal` 管理 tmux 与 PTY（`observe()` 是服务端的终端输出观察接口），`workspace` 处理文件与附件，`git` 处理 Diff、Checkpoint 和 worktree，`settings` 处理配置及 CLI 管理。`store.ts` 保存工作台状态并负责数据库迁移，`app.ts` 组装受认证保护的 API。

### 服务端分层

`apps/server/src` 的模块（顶层目录或文件）分六层，文件只导入本模块和更低的层：

| 层 | 模块 | 职责 |
| --- | --- | --- |
| base | `errors`、`environment`、`auth`、`metrics`、`prompts` 等 | 不知道会话 |
| kernel | `store`、`native`（投递）、`journal`、`timeline`、`sync`、`backends/*.ts`（驱动接缝）、`terminal`、`settings` | 会话与 Run 的读写主干，不出现具体后端 |
| kit | `backends/shared`、`adapters` | 驱动共用的机制：子进程、hook、等待 |
| drivers / features | `backends/<name>`；`git`、`workspace`、`orchestration`、`shares`、`stats`、`plugins` 等 | 同属一层，互不导入 |
| surfaces | `routes`、`channels` | 协议翻译 |
| root | `app.ts`、`cli*.ts` | 唯一认识所有模块的地方 |

base、kernel、kit、root 层内的模块可以互相导入；驱动、功能和表面不导入同层的其他模块，彼此需要的东西由 `app.ts` 传入。服务端与 `apps/web` 不互相导入，公共代码放 `packages/`。

`pnpm check:layers`（CI 运行）按模块对统计越层导入了对方多少个文件，与 `scripts/layers-baseline.json` 比较：已有的只许减少，不许出现新的模块对。按文件而不是按 import 语句计数，所以把一个文件拆成两个不会被算作新增依赖。`--list` 列出每一处，`--update` 在清理后下调基线。层的归属写在 `scripts/check-layers.mjs` 的 `LAYERS` 里，新模块必须先登记。

`apps/web` 提供 React 工作台。`packages/contracts` 是共享契约，`src/index.ts` 只做导出，类型按领域放在 `session.ts`、`run.ts`、`native.ts`、`backends.ts`、`git.ts`、`settings.ts` 等文件里，新类型加到所属领域的文件。`src/schema/` 是其中进入兼容性快照和客户端 fixture 的那部分的 zod 定义；`schema/parity.ts` 在类型层面把每个 schema 与同名 interface 绑在一起，两边不一致时 `pnpm typecheck` 报出契约名和字段路径。服务接口见 `apps/server/src/` 下各路由与契约。

驱动接口（`backends/types.ts` 的 `NativeBackendDriver`）里成组的可选能力放在可选对象上：`extensions`（厂商自己的 Skill、MCP、插件）、`external`（导入与交还终端）、`stored`（不启动运行时的存档读取）、`admin`（会话之外的 CLI 管理）、`projectConfigs`。后端不提供某一组就不设这个属性。`NativeBackendService` 只管与具体会话有关的事；与会话无关的后端、档案与模型目录在 `backends/catalog.ts`（`nativeBackends.catalog`），登录、能力报告与项目配置在 `backends/admin.ts`（`nativeBackends.admin`）。

`apps/mobile` 是移动客户端：Android 界面用 Compose（`shared`），iPhone 界面是 `iosApp` 里的 SwiftUI / UIKit（见 `docs/IOS.md`），两端共用 `client` 模块的会话状态、缓存、网络与时间线规则；`docs/MOBILE.md` 是它的设计契约：设备令牌与配对、mDNS 发现、时间线第二实现、分期与验收标准。手机自己就能添加目录并发起会话：首页的目录菜单里有「选择其他目录…」，在服务端的文件系统里浏览并绑定（`POST /api/browse` + `POST /api/projects`，都已注册的目录按路径幂等返回原项目），不必先在电脑上建好项目。与 web 一致，Agent 的待办列表和排队中的消息都只显示在输入框上方的 dock 里（待办默认收起，排队消息执行时才进入正文），转录里的文字可以长按选中复制，文件浏览页搜索框右侧的 ✕ 直接退出整个页面。`contracts/` 与 `core/` 两个模块不依赖任何平台 API，可以只用 JDK 编译与测试（`./gradlew :contracts:jvmTest :core:jvmTest`），不需要 Android SDK。设计变量由 `pnpm gen:theme` 从 `apps/web/src/styles/index.css` 生成，不手工誊抄。

`apps/macos` 是 macOS 原生客户端（SwiftUI + AppKit，macOS 15+、Apple Silicon），`docs/MACOS.md` 是它的设计契约与实现记录：界面原生实现，会话状态、缓存、网络与时间线规则经 SKIE 复用 `apps/mobile/client`；打开即免配对连上本机服务，本机没有服务时可由 App 用自带的 LaunchAgent 托管。另有菜单栏、可操作通知、全局快速对话（默认 ⌃⌥Space，直接打开 App 页面）、⌘K、Spotlight、快捷指令与 `riffet://` 链接。`apps/macos/scripts/build.sh` 构建 Debug，`build.sh release` 构建带内置服务的 Release，`release.sh` 打 DMG（设置签名身份后公证）。

前端是自有的 React 组件，视觉上参考 [ZCode](https://github.com/zai-org/ZCode) 与 [DeepSeek harness](https://github.com/deepseek-ai/deepseek-harness)。DSH 后端桥接复用其 MIT 许可的原生接口；相应来源和许可随桥接代码保留。基础控件基于 Radix，设计变量集中在 `apps/web/src/styles/index.css`。内置 6 套主题（Riffet / Solarized / Catppuccin / Rosé Pine / Claude / Everforest），在设置 → 外观与显示或侧栏的「主题」菜单里切换；`.dark` 决定明暗、`data-theme` 决定配色，两者独立，所以「跟随系统」在任何主题下都成立。**加主题或改主题前先读 `docs/THEMES.md`**：它列出必须保持的不变量、加一套主题的步骤，以及所有已知取舍。运行时参考了本地 AgentDock 与 Mirage Cursor；对话事件的处理只依赖 CLI 实际返回的内容。

图标统一从 `apps/web/src/components/icons.tsx` 导入（`Icon*` 命名，默认线宽 1.75，尺寸仍由调用处的 Tailwind 类决定），源码中不再直接引用 `lucide-react`，将来整体换图标只需改这一个文件。

结构性动画（侧栏收起、右侧上下文面板、终端坞升降）统一由 `apps/web/src/components/ui/collapse.tsx` 和宽度过渡实现：折叠区始终用 `grid-template-rows` / 宽度过渡而非 `display` 切换，隐藏时保留 DOM 但加 `inert` 阻止焦点进入，终端坞在动画结束后才卸载以避免空跑 WebSocket。全局 `prefers-reduced-motion` 会去掉位移与缩放（`transform` / `translate` / `scale` 不再参与过渡），只给纯 `opacity` 与颜色保留 100ms linear 的过渡，并把 `shimmer` 换成静态文本。

界面分隔线优先使用 `apps/web/src/styles/index.css` 中的 `edge-t` / `edge-b` / `edge-l` / `edge-r` 工具类：它们用 `inset` 阴影画一条 `--line-soft` 细线，不占布局盒子，比真实 `border` 更轻。仅在需要裁切轮廓的盒子（卡片、输入框、弹层）上保留 `border`。

## 提示与反馈

提示按当前影响、归属和消失条件选择展示位置。普通状态、轻提醒、警告与错误分别表达；操作前确认按实际后果决定。

| 场景 | 展示位置与生命周期 |
| --- | --- |
| 待恢复、启动、同步、自动重连、线路状态 | 标题或相关控件旁，随状态更新；不长期占输入框上方 |
| 结果已经明确可见的成功操作 | 依靠内容或控件变化；需要撤销、打开结果或说明目的地时才追加一次反馈 |
| 字段、附件、文件、模型目录读取失败 | 留在对应对象附近，保留恢复动作；有旧数据时保留内容并说明状态 |
| 历史读取、解析、原文定位问题 | 阅读区域，不能代替发送状态 |
| 草稿无法持久化、投递结果未知、待确认操作 | 输入或请求附近的持久提示，跟随风险解除；不靠 toast 超时隐藏 |
| 删除、覆盖、回退、丢弃修改及权限变更 | 沿用已有确认流程，说明真实后果；原请求身份、文件指纹与交互 revision 保护保持不变 |

同一原因只有一个主要解释和处理位置。错误必须属于发起它的服务端、窗口、会话或操作对象；异步返回不能写进后来打开的页面。去重只针对当前页面已经实际呈现的内容，不能因另一个字段存在就隐藏唯一原因。发送未确认时不自动重发；全屏编辑时，原请求重试、核对与解除等待的操作随输入区一起展示。

普通提示不默认使用警告图标或警告底色。Web 的 `Notice` 默认中性，真实风险显式指定 `warning`，操作失败用 `danger`；Compose 的 `SettingsMessageBanner` 与 `SheetNotice` 通过必填的语义参数选择图标，调用处不以颜色暗示级别。复用现有主题、组件与反馈渠道。

`NativeStatus.noticeLevel` 由产生提示的后端填写 `info`、`warning` 或 `error`，与 `notice` 一起替换、保留和清除。客户端不从提示文字猜测级别；旧服务端缺少字段或收到未知级别时按 warning 处理。级别不代表是否阻断，位置仍由信息归属决定。排队、恢复、模型切换与自动压缩是 info，投递不确定与所有权冲突是 warning，启动或回合失败是 error。该字段是可选的协议增量，TS、Zod、Kotlin DTO 和合同 fixtures 一起维护。

### 提示入口清单

按触发状态和处理位置登记，同一动态错误的不同返回文本归为一个入口。检查范围包含正文、横幅、toast、弹窗、表单校验、空状态、禁用原因、tooltip、系统通知和扩展；不把关键词命中数当作独立提示数。下表记录处理规则与已经实施的迁移，不代表每条既有字符串都已重写。

| 功能与入口 | 处理规则 | 已实施或保留的行为 |
| --- | --- | --- |
| 启动、配对、鉴权：Web `App/Workbench`；Mac `AppModel/ServerSetupView`；移动 `PairingView/PairingScreen` | 初载失败在页面，凭证失效在连接入口；配对码时效、凭证位置、手动备用路径保留 | 保留必要的配对和隐私信息；普通服务版本提醒移出 Mac 主窗口，菜单栏保留重启与稍后 |
| 会话与线路：各端 `ConversationView/NativeSession/SessionScreen`、`WorkbenchView` | 自动恢复、启动、重连归标题；连接失败保留明确原因和恢复动作 | Web/Mac/iOS 普通离线不占输入区；Mac info 在标题详情，iOS info 在会话信息，Web info 在阅读区；真实错误不按字段存在误去重 |
| 历史与定位：`TranscriptView`、历史加载状态、收藏原文定位 | 归阅读区；读取失败、解析失败、原文已变化分开 | 保留历史重试及无法定位的事实，不把历史问题写成发送失败 |
| 输入、草稿、附件：各端 Composer、`nativeRunCommands/SessionComposer` | 输入错误归附件或控件；草稿存储失败与未知投递持续到风险解除 | Web 草稿写入失败持久；Web/Mac 全屏有投递恢复操作；确认后请求条消失；Mac 系统提问入口复用 App 页面的投递与恢复流程 |
| 模型、权限与参数：`ModelPicker/ConfigPickers/SessionControls` | 普通禁用原因中性，加载失败错误，高权限风险警告 | 目录有缓存时不常驻加载进度；Compose sheet 的普通禁用原因使用 Info；权限影响说明保留 |
| 审批与交互：各端 InteractionCard、身份验证、等待通知 | 跟随原请求；核对、撤回、题目变化与鉴权失败不能变成短 toast | 保留请求 ID、revision、原请求重试与前台通知去重；不自动重发未知请求 |
| 搜索与导航：Web `SessionSearchDialog/DirectoryPicker`；Mac `SearchDialog/WorkbenchSidebar`；移动项目与目录选择 | 无匹配、没有目录与搜索失败分开；缓存结果说明范围 | Mac 远端搜索失败保留缓存结果、错误与重试；iOS 项目编辑失败仅由发起表单显示 |
| 终端：`TerminalView/TerminalPanel/TerminalScreen/TerminalPage` | 连接、进程退出、控制权与协议失败分别处理 | 共享终端错误在新连接或新的用户操作时清理；自动输出与尺寸同步不掩盖错误，iOS 也能消费清除状态 |
| 文件、预览、下载：`FilesPanel/ContentPreview/DownloadsScreen/ProjectFilePage` | 失败归对象；只读、截断与保存位置作为事实保留 | Compose 只读和截断中性、读取与打开失败为错误；保留重试和系统预览路径 |
| Git、检查点、Worktree、发布与审阅 | 冲突、覆盖、移除及回退确认保留具体后果；已成功的变更由结果表达 | 保留工作区保护、不可逆确认、同请求重试与指纹校验；普通截断说明中性 |
| 设置、提供商、集成与扩展 | 字段错误就地；授权命令、安装输出、生效时机可以持续查看 | Web 集成动作复用授权对话框；关闭后刷新状态；删除自明的保存、添加、删除、设默认成功 toast；iOS 提供商成功由控件状态表达，扩展只保留 applyEffect |
| 任务与编排：`TasksPage/TasksModel/Attempts` | 失败、跳过、清理结果分开；运行输出归具体任务 | 保留 Cron 校验、删除计划对已有任务的影响和必要限制；持久失败不按成功计时器清除 |
| 收藏、分享、媒体与统计：`MarksPage/ShareSheet/StatsScreen` | 加载、分页与操作失败各自归属；撤销反馈保留生命周期 | Mac 收藏刷新失败保留旧内容与重试，分页失败可重试；分享失败持久且可关闭；缓存统计说明中性 |
| 系统通知、菜单栏、Widget、Services 与 Share extension | 权限和后台能力说明保留；通知跟随任务状态；过期快照不推断服务已停止 | Widget 使用“状态未更新”；iOS 通知操作错误由显式关闭消费，不再依赖懒加载表单行消失 |
| 基础文案：EmptyState、Field hint、Row description、placeholder、Tip、确认弹窗 | 空态只在下一步不明显时给行动；不复述控件名；图标按钮的可访问名称和必要禁用原因保留 | 各入口按同一规则复查，不通过批量删除 tooltip 或缩短错误文本追求数量 |

### 后续专项核验

以下是入口审计中发现的外围问题，尚未包含在本轮会话提示迁移中；需要在对应模块内处理，不能据此标记全量完成：

| 入口 | 需要核验或调整的边界 |
| --- | --- |
| Mac `AttemptGroupView`、扩展批量操作 | 多条清理结果和部分成功需完整查看，不能只保留第一条 warning 或统一用 success 表示 |
| Web 扩展的局部列表请求 | 请求失败后清空列表的路径需区分“没有内容”和“读取失败”，并保留可用旧内容 |
| Mac `ServicesProvider` 与 Share extension | 打开目录、部分附件读取失败的静默路径需明确归属和失败反馈，避免丢项后仍被当作完整成功 |
| 文件、媒体、统计等旧局部错误 | 仍有行数截断和模态反馈；逐项改为可查看全文、就近重试，保留无所属窗口时的系统级错误入口 |

验收时至少覆盖正常恢复、真实失败、重复原因、全屏发送结果未知、收据确认、恢复请求晚返回、A→B→A 切换、保留旧数据后的刷新失败和下一页失败。纯展示调整使用类型检查、编译与按需界面检查；合同、幂等和恢复行为复用既有核心测试，不新增文案、颜色或快照测试。

文案只保留用户无法推断的事实：存储位置、跨设备影响、生效时机、权限、隐私、计费、持续风险和不可逆后果。空状态在下一步不明显时提供一句行动提示。图标按钮的可访问名称、快捷键和必要禁用原因保留；技术细节可以展开或滚动查看。新增与保留文案逐条检查：删掉后，用户会误判什么或做错什么。

## 界面语言

Web 界面用 [Lingui](https://lingui.dev)：源码里的中文就是消息（源语言 `zh-Hans`），其他语言在 `apps/web/src/locales/{locale}/{area}.po` 里翻译，区域与目录的对应见 `apps/web/lingui.config.ts` 的 `areas`。语言按设备保存在 `riffet.locale`，切换即时生效并同步到其他标签页；`pseudo` 只供 QA，手动写入该键启用。

- 组件里用 `@lingui/react/macro` 的 `useLingui()` 取 `` t`…` ``，正文用 `<Trans>`；`React.memo` 组件只有这样订阅才会随切换更新。组件外的函数在调用时用 `@lingui/core/macro` 的 `t`。模块顶层不翻译：用 `msg` 描述，显示处再 `i18n._(descriptor)`。
- 整句成文，不拼片段：变量用插值，数量用 `plural`，不拿译文做 `===` 比较。
- 数字、日期、相对时间都走 `@/lib/i18n/format`（`formatNumber`、`formatDate`、`compareText`、`relativeTime`、`timeAgo`），不写死 `'zh-CN'`。这个模块不能有任何 import：服务端经 `lib/utils.ts` 把它打进了包。
- 迁移一个区域：包裹该区域的中文字面量，`pnpm i18n:extract`，只在 `locales/en/{area}.po` 填英文，再 `pnpm i18n:check --update-baseline` 下调基线。中文界面必须逐字不变。
- `pnpm i18n:check`（CI 运行）检查：消息外的中文字面量不超过 `apps/web/i18n/baseline.json`（只降不升；非界面文字用 `// i18n-ignore` 标注）、模块顶层没有翻译、每个源文件恰好属于一个区域、目录与提取结果一致、英文没有缺译。

服务端的错误不带界面文字：响应是 `{ error: { code, message, params?, details? } }`，`message` 是给开发者和日志的英文，客户端按 `code` 查目录、用 `params` 填空。持久化或推送的提示字段（`Run.error` 等）旁边的 `TextRef`（`{ code, params? }`）同理，原字符串字段留作英文后备，旧记录里的中文照旧显示。

- 文字只写在 `i18n/errors/<领域>.json`：`"CODE": { "zh": "…", "en": "…" }`，ICU 语法限 `{name}`、`select`、`plural`（`=N`/`one`/`other`）。`pnpm gen:i18n` 生成 Web 的 `errors` 目录（消息 `error.<CODE>`）和 Kotlin 的 `riffet/i18n/ErrorText.kt`；`pnpm gen:i18n:check`（CI 运行）检查产物是最新的、每个 code 在 `apps/server/src` 或 `plugins/` 里确有抛出。
- 一个 code 对应一段文字：同一失败的不同说法用 `select` 参数区分（如 `{ subject: 'skill' }`），原因不同就换新 code（先确认客户端没有按旧 code 分支）。把 code 写进目录前，看清它所有抛出点都配得上这段文字。
- 新增或迁移：`throw new AppError(code, '英文', status, details, params)`，在 json 里写中文（迁移时逐字照搬原文）和英文，再 `pnpm gen:i18n`。外部工具原样输出的 code（如 `GIT_OPERATION_FAILED`）文字写 `{message}`。
- Web 的 `errorMessage(error, fallback?)` 依次取：服务端自己写的中文（未迁移，扣除参数值后仍含汉字）原样显示 → 目录文字 → 服务端原文（code 尚未进目录时，保留具体原因） → 调用方的后备 → 「操作失败」。Kotlin 的 `RiffetHttpException.message` 走同一套（`L10n.serverError`，最后退回服务端原文），语言取自 `L10n.locale`：Apple 平台读 App 的首选本地化，Android 暂为 `zh-Hans`。
