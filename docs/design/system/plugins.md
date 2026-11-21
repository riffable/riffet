# 插件界面

本文给写插件的人：插件的界面怎么选呈现方式、能出现在哪里、能拿到什么取值和组件，怎样才与宿主一致。协议与权限见 [plugin-system.md](../plugin-system.md)（§4 工作台界面扩展、§6 外观资源协议）和 [PLUGIN_ARCHITECTURE.md](../../PLUGIN_ARCHITECTURE.md)；取值的含义见[基础](foundations.md)，组合规则见[模式](patterns.md)。页面上的对应章节是「扩展与工程 · 插件界面」。

每节末尾的「现状」是 2026-11-14 盘点时与规则不符的实现，改完后删掉对应条目。

## 1. 三种呈现方式

| | 声明式描述 | 应用内模块 | 隔离视图 |
|---|---|---|---|
| 谁绘制 | 宿主组件，按插件给出的结构 | 插件的 React 组件，用 `UiKit` | 插件自带的页面，在 iframe 或 `WKWebView` 里 |
| 平台 | Web、Mac、手机 | Web | Web、Mac |
| 样式来源 | 宿主组件 | `UiKit` 与应用相同的 Tailwind 类 | 颜色角色变量、`--riffet-*`、元素规则 |
| 可用位置 | `settings`、`sidebar`、`session-view` | 全部 | `session-view`、`sidebar`、`file`、单实例 `main` |
| 谁能用 | 所有插件 | 内置插件（画布、Cursor 设置页） | 本地开发包与独立安装包 |

选择顺序：

1. 内容是状态、设置、检测结果、数据列表、动作：用声明式描述。插件详情的第二个页签（插件页，见 §6）和侧栏的 `list`、`form`、`detail`、`tasks` 渲染器都属此类。三个平台一份描述，不为每端写界面（DECISIONS「插件详情：介绍、插件自己的页、管理」否决了以自定义网页为主要形式）。
2. 需要宿主没有的交互（画布、时间线、拖拽），且是内置插件：应用内模块，只用 `UiKit` 和宿主服务。
3. 需要宿主没有的交互，且是第三方包：隔离视图。它拿不到主应用的 DOM 和凭据，所有能力经消息桥，见 PLUGIN_ARCHITECTURE「自定义视图」。

Mac 对没有原生渲染器的仅 Web 视图显示「不可用」，不承诺动态加载 SwiftUI 代码。

## 2. 位置与尺寸

`VIEW_LOCATIONS`（`packages/contracts/src/plugins.ts`）是语义位置，不是像素位置。视图声明 `locations` 与 `defaultLocation`；尺寸、排序、分屏、焦点、关闭和状态恢复归工作台。用户可以排序、隐藏、固定视图。

| 位置 | 承载 | 尺寸 | 来源 |
|---|---|---|---|
| `navigation` | 主导航入口 | 图标与名称，宿主决定 | plugin-system §4.1 |
| `main` | 工作台级页面（统计、任务、插件页） | 页面骨架的内容列档位，文档类 768（[模式](patterns.md) §1） | 同上 |
| `session-view` | 同一会话的替代呈现，与对话、终端并列 | 填满主区，随窗口 | 同上 |
| `sidebar` | 辅助侧栏的页签：文件、变更、插件视图 | 宽 320–720，默认 380，可停靠、悬浮、全屏 | `uiStore.ts`、`WorkbenchPanels.tsx` |
| `panel` | 底部面板 | 宽随主区，高由用户拖动 | 同上 |
| `file` | 文件视图里一个文件的另一种看法，在「更多操作」里与「以十六进制查看」并列，按 `files.extensions` 匹配 | 填满文件视图的内容区，随面板停靠、悬浮、全屏 | `app/panels/FilesPanel.tsx` |
| `settings` | 「插件」详情弹窗里插件自己的页签 | 弹窗 `size="content"` 768，高 `min(42rem, 100dvh − 32px)`，手机全屏 | `app/plugins/PluginsPage.tsx:369` |

- 视图按容器宽度排版，不假定 380：悬浮或全屏时宽度会变，手机上侧栏与设置是全屏。
- 视图的内边距、标题、关闭按钮由宿主绘制，视图内容从容器边缘开始。声明式页面的内边距由宿主给出。
- Web 隔离视图可出现在 `session-view`、`sidebar`、`file` 与单实例 `main`。顶层页面出现在侧栏「更多」中，可在侧栏设置里固定和排序；`settings` 位置只能由内置入口绘制（PLUGIN_ARCHITECTURE「自定义视图」）。
- 视图实例按 `serviceId`、`projectId`、`sessionId`、`instanceId` 定 key；`ViewContext.visible` 为 false 时暂停轮询和动画。

### 2.1 宿主菜单里的命令

命令声明 `menus`（`COMMAND_MENUS`）后出现在宿主菜单里，不再出现在命令面板和快捷键里。`message` 是回答的更多菜单（Web 的页脚「⋯」，Mac 的右键与页脚「⋯」共用一个菜单）；`selection` 是选中回答里文字时的工具栏（只有 Web，见[界面](surfaces.md) §1.3）。协议见 PLUGIN_ARCHITECTURE「消息菜单」。参考实现是内置插件 `riffet.translate`（`plugins/riffet/translate/`）。

- 位置：插件项排在「导出为图片」之后、「从此处另开会话」前的分隔线之前，按插件顺序。宿主决定位置，插件不能排到内置项前面。
- 标题：一个动词或动词短语，与内置项同一种写法（「翻译」「解释」），不带插件名、不带省略号。
- 图标：`icon` 取 `COMMAND_ICONS` 里的名字，各端画自己的图标（Web 用 Lucide，Mac 用 SF Symbols）；不声明或不认识时画拼图。插件不自带图标文件。
- 结果：`text` 结果显示在这条回答的页脚下方，属于这条回答、不是新的一条消息：浅底块，标题行是图标、`title`（如「译文」）、复制和关闭，下面是 Markdown。运行中同一块显示转圈，不另起提示；关闭即取消请求。失败时结果块留在原位，下方用 `role="alert"`、`text-danger` 写明原因，标题行右侧在关闭前给出「重试」（错误码为 `PLUGIN_MODEL_NOT_CHOSEN` 时一并给出「选择模型」直达设置）。`done` 结果没有结果块，用提示条。
- 结果只在内存里保留（`PLUGIN_COMMAND_BUDGET.keptResults`），不写进会话、不同步；同一条回答在结果仍有效时再选同一项不重复请求，失败或插件设置变化后重选会重新运行。
- `selection`：插件项排在高亮之后、复制之前，按插件顺序，只放图标，`title` 作为悬停名称。`text` 结果显示在选区旁的卡片里，样式、加载与失败重试同回答下方的结果块；卡片关闭后取消进行中的请求且结果不保留。卡片是锚定在选区上的浮层，因为选区是一段临时的文字，结果不属于整条回答。
- 不做：弹窗、替换或改写原消息、在菜单里放二级菜单或开关、在结果块里放插件自己的按钮。

## 3. 视图拿到的取值

### 3.1 颜色

宿主把调色板的全部角色（`THEME_ROLES`，`--bg`、`--fg`、`--accent`、`--line` 等）作为 `--<role>` 变量写进隔离页面的 `:root`，并在切换主题、配色、深浅或字号时经 `theme` 事件重新推送（`apps/web/src/plugins/isolated/document.ts` 的 `readTheme`、`IsolatedView.tsx`）。`color-scheme` 随之设置。同一份变量里有 `--text-scale`（宿主字号设置，基础 §10），基础样式的字号与行高按它缩放，未推送时取 1。

- 视图的颜色一律写 `var(--<role>)`。不写色值，不写固定的深色或浅色。
- 语义同[基础](foundations.md) §1：文字用 `fg` 到 `fg-4`，面用 `bg`、`bg-subtle`、`bg-elevated`，线用 `line`、`line-strong`，状态用 `success`、`warning`、`danger` 及其 `-soft`。
- 应用内模块直接用与应用相同的 Tailwind 类（`text-fg`、`bg-elevated`），`@source` 已包含 `plugins/`。
- `main` 位置的工作台类视图（总览、看板、统计）是概览面，可以用 `--chart-1` 作数据色，只画在图形上；面用同一个中性底色，一屏至多一处渐变。条件和数值见[基础](foundations.md) §12。`sidebar`、`panel` 位置的视图，以及视图里的详情、正文、diff，按阅读面做：不染色，不用渐变。
- 金融类视图的涨跌：数字和箭头可以用 `danger` / `success`，带正负号和文字，默认红涨绿跌，用户可切换；面和图形不着色（[设计决定](../DECISIONS.md)「金融类视图的涨跌色」）。

### 3.2 `--riffet-*` 与元素规则

`PLUGIN_BASE_STYLE`（`packages/plugin-web/src/base-style.ts`，版本 `PLUGIN_BASE_STYLE_VERSION`）写进每个隔离页面，Mac 由 `pnpm gen:plugin-style` 生成同一份文本到 `PluginPageDocument.swift`，`gen:plugin-style:check` 核对。

| 类别 | 变量 |
|---|---|
| 间距 | `--riffet-space-1…5`：4、8、12、16、24 |
| 圆角 | `--riffet-radius-control` 8、`-container` 10、`-card` 12 |
| 字体 | `--riffet-font-sans`、`--riffet-font-mono` |
| 字号与行高 | `--riffet-text-reading` 14/23、`-ui` 13/20、`-small` 12/16 |
| 其他 | `--riffet-control-height` 32、`--riffet-border-width` 1px、`--riffet-focus-ring`（与宿主的 `--focus-ring` 同值，`--accent` 50%，随推送的 `--accent` 变化） |

元素规则全部包在 `:where()` 里（特异性为零，只有 `[data-pointer-focus]:focus-visible` 一条例外），插件自己的 CSS 无需 `!important` 即可覆盖：`body`、`a`、`button` 与 `input[type=button|submit|reset]`、文本类 `input`、`textarea`、`select`、`code`/`pre`/`kbd`、`hr`、`table`、`:focus-visible`、`::selection`、禁用态、细滚动条，以及 `prefers-reduced-motion` 下把过渡与动画压到近零。焦点环与应用同一规则（[基础](foundations.md) 焦点一节）：宿主在视图脚本之前运行 `PLUGIN_FOCUS_SCRIPT`，点击、脚本和非导航键得到的焦点带 `data-pointer-focus`，基础样式对它不画环；视图自己写的 `:focus-visible` 规则加 `:not([data-pointer-focus])`，用自定义按键（如 j/k）移动焦点后去掉目标上的这个属性。`host.info` 返回 `baseStyleVersion`（即 `PLUGIN_BASE_STYLE_VERSION`），插件据此判断拿到的是哪一版。用原生元素写的界面因此与宿主的按钮、输入框同形。没有类名组件和工具类。

### 3.3 现状

- 没有阴影、层级和动效变量：视图不能画与宿主一致的浮层（`shadow-pop`），`--duration-*`、`--ease-*` 也不存在，基础样式里的 `.15s` 是手写值。
- 没有内容宽度变量：视图不知道所在位置是 380 的侧栏还是全屏，只能用容器查询或自己量。
- 没有数据色的派生变量：降饱和由视图按[基础](foundations.md) §12.1 的式子自己混。

## 4. 组件

应用内模块经 `usePluginHost().ui` 取 `UiKit`（`packages/plugin-web/src/index.ts`），都是宿主自己的组件，因此状态、尺寸和键盘行为与应用一致：

| 组件 | 用途 | 对应宿主组件 |
|---|---|---|
| `Button` | 操作；`variant` 含 `primary`、`secondary`、`ghost`、`quiet`、`danger`、`danger-ghost`、`link`，`accent` 已弃用，仍被接受并按 `primary` 绘制 | `components/ui/button.tsx` |
| `Input`、`Switch` | 文本、开关 | `components/ui/controls.tsx` |
| `Select`、`Segmented` | 多个值用选择菜单，三个以内的短值用分段控件 | `controls.tsx` |
| `Field` | 控件上方的标签，可带一行提示 | `controls.tsx` |
| `Notice` | 视图内常驻的提示（降级、结果过期） | `components/ui/notice.tsx` |
| `EmptyState` | 没有内容：标题、可选一句说明、至多一个下一步 | `controls.tsx` |
| `SettingsGroup`、`SettingsRow` | 带标题的卡片与行；控件在行尾 | `app/settings/SettingsLayout.tsx` |
| `StatusDot`、`Badge`、`Spinner` | 状态、标签、加载 | `controls.tsx` |
| `Tip` | 悬停提示，可带 `kbd` | `components/ui/tooltip.tsx` |
| `Markdown`、`DiffView` | 正文与差异 | `app/session/` |
| `ModelField` | 选模型及其选项 | `plugins/ModelField.tsx` |
| `icon(name)`、`toolIcon(kind)`、`copy(text)` | 图标、工具图标、复制并提示 | |

- `Select`、`Segmented`、`Field`、`Notice`、`EmptyState` 与 `Button` 的 `busy` 是 web API 1 之后加的，没有升版本号（升号会让声明 `^1` 的现有插件全部不兼容）。2026-11 之前的宿主没有这些成员：`UiKit` 里它们是可选的，SDK 的同名包装在旧宿主上退回成无样式的文字或不渲染，插件直接用 `ui.*` 时先判断是否存在。
- 选用规则同[组件](components/TEMPLATE.md)与[模式](patterns.md)：几个并列的值用 `Segmented`、更多用选择菜单。`UiKit` 没有 `Dialog`，视图需要弹窗时先看能否改成声明式页面。
- 隔离视图没有组件。用原生元素，靠基础样式获得宿主外观；需要弹窗、确认、通知时，经桥调 `notify.info`、`notify.error` 或 `commands.execute`，由宿主绘制。

### 4.1 现状

- 手机没有应用内模块与隔离视图的渲染器：手机上插件界面只有声明式页面。

## 5. 图标

- 视图和命令的图标用包内 SVG（`icon.svg`，包内路径），可附带供 Mac 使用的 `icon.sfSymbol`；两者都缺时宿主用通用图标。Agent 的 `icon.svg` 至多 64 KB，只当图片画，不执行脚本。
- 应用内模块从 `PluginIconName`（39 个 Lucide 图标）里选，用 `ui.icon(name)` 取，不引入第二套图标库。`WebPlugin.icons` 给宿主在视图标题旁画的图标。
- 尺寸与描边按[基础](foundations.md) §8：Web 按钮、页签 16，行内 14，元信息 12，描边 1.25 且不随尺寸变；颜色跟随所在行的文字，不写固定色。
- SVG 用 `currentColor` 描边或填充，不带固定色值。
- 图标不套底板、不加外圈、不着色。同类条目的列表行首不重复同一个图标；标签页和分区标题不配图标（[基础](foundations.md) §12.5）。

## 6. 插件页

插件详情的第二个页签，展示插件运行起来以后的情况。和「介绍」的分工是：「介绍」列出插件提供什么，内容是静态的，不执行插件代码；插件页展示这些东西在这台服务器上用得怎样。用户打开插件页，应该不用去别处就能回答三个问题：

1. **能不能用**：没有缺登录、缺命令行工具、缺设置，或者缺的是什么、下一步怎么做。
2. **用在哪里**：插件在为哪些对象工作，例如提供商、Agent 配置、项目、任务、分享。
3. **有没有要处理的事**：额度快用完、凭据快过期、任务失败、占用的空间太多。

除此之外，插件页还放插件自己的设置和操作。三端都用原生控件绘制，插件不写界面代码；在手机上，插件页是插件唯一的界面（§4.1），所以要用它把事情做完。

### 6.1 三层

| 层 | 内容 | 谁画 |
|---|---|---|
| 通用 | 状态：`status()`、`requirements` 缺的东西、要登录的动作 | 宿主，所有插件同一种写法（§6.2） |
| 扩展点 | 插件实现的每个扩展点在服务器上的运行情况：用在哪里、读数、最近的记录 | 宿主，每个扩展点固定一组（§6.3） |
| 插件 | 接口表达不了的设置、检测结果、数据和操作 | 插件，用 `PluginPage`（§6.4） |

版本、来源、权限、日志和诊断仍放在「管理」页签。

- 接口已经能表达的信息，由宿主来画。插件不在自己的区块里列宿主对象（提供商、项目、任务、分享），也不重画宿主区块里已有的读数：插件拿不到完整的对象列表，自己画出来也会和别处的读数不一致。要提到宿主对象时，用 `ref`（§6.4）。插件按项目保存的数据属于插件自己，可以列，每行用 `ref` 指向对应的项目。
- 同一份数据可以从两个角度看：宿主设置从对象看（提供商编辑里显示这个提供商的额度），插件页从插件看（这个插件服务的所有提供商）。两处读同一份缓存、用同一组件，不算重复。
- 插件有状态、任一扩展点区块，或者声明了 `page`、`settings` 或设置视图，就显示这个页签。

### 6.2 页面结构

从上到下的顺序固定：**状态 → 扩展点区块（按 §6.3 表中的顺序）→ 插件的区块**。

- **状态**：一行。前面是 `StatusDot`（`ready` 用 `success`，`attention` 用 `warning`，`unavailable` 用 `danger`），后面是 `status().message` 和可选的 `time`（写法同 §6.4），行尾最多放一个按钮：缺登录时是登录动作，缺命令行工具时是安装说明（`hint`）。按下后由 `PluginFlowDialog` 完成（§7）。没有任何状态可说时，不画这一组。
- **插件的区块**按插件给的顺序排列，建议按「事实与检测 → 设置 → 数据与清除」的次序，危险操作放在最后一组。
- 分组都用 `SettingsGroup`，组间距和卡片与设置页相同。页面不加标题和导语；内容宽度跟随容器（§2），不假定 768。

### 6.3 扩展点区块

一个扩展点（`Contributions` 的字段，见 PLUGIN_ARCHITECTURE「接口与版本」）要由宿主画成一组，需要同时满足三个条件：宿主手里有这个扩展点在整台服务器上的运行数据；这些数据能按插件分开；用户会拿这些数据来判断插件是否在正常工作。不满足的扩展点只在「介绍」里列出。

每组的写法相同：一个对象一行；行尾一个摘要，写最需要注意的那一项；详情放在展开内容或子页里；行（或展开内容里的按钮）能跳到宿主管理这个对象的地方。

| 扩展点 | 组 | 每行 | 行尾摘要 | 展开或进入 |
|---|---|---|---|---|
| `modelSources` | 提供商 | 使用这个来源的提供商 | 剩余最少的额度；没有 `usage` 时写模型数 | 额度条、模型子页、编辑（§6.3.1） |
| `agentBackends` | Agent 配置 | 这个 Agent 的各项配置 | 命令行工具和登录状态 | 跳到「设置 › 模型提供商」里这个配置；空状态的按钮打开同一页 |
| `taskProviders` | 最近任务 | 各项目最近的运行，条数取自 `budgets.ts` | 状态和时间 | 跳到这个任务 |
| `sharePublisher` | 分享 | 经它发布、仍然有效的分享 | 到期时间 | 打开；撤下（先确认） |
| `imChannels` | 机器人 | 这个插件服务的平台上的机器人 | 连接状态：已连接、连接中、已停用、连接失败 | 跳到「设置 › 机器人」；空状态的按钮打开同一页 |

- `agentTools`、`views`、`commands`、`keybindings`、`avatarStyles`、外观资源、`services`、`runtimeHooks`：没有区块。哪些对话开了某个工具，属于对话本身；视图和命令的入口在「介绍」；外观和头像在各自的设置里选。
- 新增扩展点时，先判断它是否满足上面三条。满足的，在这张表里加一行，宿主实现，三端同时画。
- 一组超过 5 行时，只显示前 5 行，最后加一行「全部 n 个」进入子页（§6.5）。
- 读数一律先显示缓存，再在后台更新；不定时轮询。刷新时原内容留在原位、颜色变淡；失败时保留上次的读数，在组里写明原因（`role="alert"`）和「重试」。读不到的值写「—」，不写 0，也不写「不限」。
- 空状态写一句话，后面跟一个下一步按钮。例如「还没有提供商使用 <名称>」+「添加提供商」，按下后进入新建，接入方式已预先选好这个来源。

#### 6.3.1 提供商

- 行：名称，默认提供商后面带 `Badge`「默认」。说明写 `Agent 名 · 地址的主机名`。行尾写剩余最少的账号窗口，如「剩余 62%」：剩余低于 20% 用 `warning`，用完用 `danger` 并写「已用尽」。整行是展开按钮，带 `aria-expanded`。
- 展开后：内容放在行下方一个只描边、不填底色的圆角框里（`border-line`，圆角 `lg`）。每个账号窗口一行 `meter`，名称沿用提供商编辑里的叫法（5 小时、每日、每周）；有专属上限的模型每个一行 `meter`；「模型」一行 `link`，进入模型子页；最后一行是读取时间、刷新和「编辑」。「编辑」跳到「设置 › 模型提供商」里这个提供商的编辑内容。
- 和提供商编辑、模型菜单共用按连接保存的缓存（[DECISIONS](../DECISIONS.md) 2026-11-13「额度栏保留缓存」）。几个提供商用同一个地址和 Key 时，只读一次。
- 模型子页：每个模型一行。说明写 `ID · 上下文 200K · 推理 low–xhigh`，ID 可以复制；行尾的标签写「已启用」、专属额度剩余，以及负载超过 100% 时的「排队中」。

### 6.4 条目

| 项 | 用途 | 绘制 | 保存 |
|---|---|---|---|
| `choice` | 单选；选项可带 `detail`（检测结果）和 `button` | 单选组 | 立即 |
| `toggle` | 开关 | `SettingsRow` + `Switch` | 立即 |
| `text` | 文本；`secret` 时是密码框，值不回传，只回 `set` | `SettingsRow` + `Input` | 回车或失焦 |
| `list` | 字符串列表 | 标签列表 + 输入框 | 整个列表一起 |
| `row` | 只读的事实或对象，见下 | `SettingsRow` | 无 |
| `meter` | 有上限的量或进度：额度、空间、下载 | 名称、数值，下方一条进度条 | 无 |
| `link` | 进入子页（`page`）、插件的视图（`view`）或外部地址（`url`，只能是 https） | `SettingsLinkRow`，外部地址带外链图标和域名 | 无 |
| `buttons` | 一排按钮 | `xs` `secondary` | 无 |

`row` 可选的附加项：

- `tone`：`ok`、`warning`、`danger`、`neutral`，在值的前面画 `StatusDot`，只用来表示状态。
- `badges`：最多 3 个短标签。
- `time`：`{ at, role }`。`at` 是 UTC ISO 时间，`role` 取 `resets`、`expires`、`checked`、`updated`、`started`。客户端按自己的语言和时区写成「周一 09:00 重置」「12月14日到期」「2 分钟前检查」（[文案](content.md) §7）。插件不在服务端格式化时间：服务器所在的时区不一定是用户的时区。
- `copy`：行尾放一个复制按钮，复制 `value`。密钥不能设 `copy`。
- `ref`：`{ kind, id }`，`kind` 取 `project`、`session`、`task`、`provider`、`share`。宿主用这个对象现在的名称代替 `label`（找不到时用插件给的 `label`），并让整行可以点开去这个对象。宿主会检查对象是否存在、当前客户端能否看到它；不满足时，这一行只显示文字。插件只能引用自己已经知道 id 的对象。
- `buttons`：同原来的写法。

`meter`：带 `id`，可带 `detail` 和与 `row` 相同的 `buttons`（下载时放「取消」）。`percent` 取 0–100；`sense` 为 `quota` 时，`percent` 表示已用的比例，数值写「剩余 n%」，条画剩余的比例，剩余低于 20% 用 `warning`，用完用 `danger`；为 `progress` 时，`percent` 表示已完成的比例，数值写「n%」，不着色。`value` 可以替换默认数值（「1.2 GB / 5 GB」）；`time` 写重置时间。

区块可选的附加项：`refresh`（一个动作名，在组标题右侧画刷新按钮，只重读这一组）、`pending`（数据还没准备好，宿主在组内画 `Spinner`，页面同时要给出 `refreshMs`）、`error`（这一组读取失败的原因，画成 `role="alert"`）、`empty`（这一组没有条目时显示的一句话）。

按钮可选的附加项：`flow: true` 表示 `action` 是 manifest `contributes.actions` 里的一个动作，宿主用 `PluginFlowDialog` 执行它。

- 一次只处理一个改动，期间禁用控件；每次改动后按返回值重画页面。按钮的 `confirm` 由宿主弹出确认框，`destructive` 画成危险样式。
- 与区块标题相同的 `choice` 标签不再重复显示。`footer` 只写从条目里看不出来的信息，一句话。文字由插件按请求里的 `locale` 给出（§10）。

**怎样增加条目种类**

- 新的条目种类要同时满足三条：至少两个插件需要它；手机能画；能退化成一行 `row`（名称加一段文字）。图表、时间线、日志、编辑器这类内容不做成条目，放进插件的视图，插件页用 `link` 指过去。
- 兼容：客户端读取页面时带上它能画的条目种类和附加项。对不支持的，服务端改成 `row` 再返回；附加项则直接去掉。插件始终按最新的规范返回，不需要判断客户端是哪个版本。

### 6.5 子页、视图与任务

- **子页**放一类对象的完整列表，或者一个对象的详情；主页只放摘要，再加一个 `link` 进入子页。打开子页时，读取请求带上 `path`，子页的标题取 `PluginPage.title`。返回按钮由宿主画在页签内容的顶部，最多嵌套两层。切换页签后再回来，仍停在原来的子页；关闭插件详情后，下次回到主页。一组超过 12 行时，宿主加筛选框，在本地按名称、值和标签过滤。一页的条目数有上限，取自 `budgets.ts`。
- **视图**：需要持续操作的工作界面，比如画布、构建输出、图表，放在插件的视图里（`main` 或 `sidebar`）。插件页只放视图的摘要和一个 `link`（`view`）。客户端画不出这个视图时（手机，或者 Mac 上只有 Web 版的视图），这一行不显示，所以页面上必须用得到的信息，不能只放在视图里。
- **任务**：超过一次请求就结束不了、需要日志或可以取消的工作，用宿主的任务来跑（`host.tasks.start`）。页面显示状态，并用 `ref: task` 指向这个任务。只有下载这类既不需要日志、也不需要取消的工作，才用 `refreshMs` 由页面自己定时重读。

### 6.6 范围与隐私

- 插件页是服务器级的：连接这台服务器的所有客户端看到同一页，所有项目的数据都在这一页上，不按当前打开的项目过滤。按项目保存的数据，每个项目一行，用 `ref: project`。
- 只显示名称、数量、状态和时间，不显示会话内容、文件内容或日志正文。日志放在「管理」里。
- 不显示密钥或令牌的任何片段，也不显示插件内部的常量（请求头、目录选择器、客户端 ID）。

### 6.7 写什么

- 主页按 §6 开头的三个问题来组织，其余的放进子页。
- 写进页面的值，应该是用户会拿去比较、复制或判断的东西：地址、到期时间、数量、占用、检测结果。不写协议名和内部字段名；用户要输入的命令和路径保留原样（§10）。
- 一个设置只在一个地方修改。属于宿主对象的设置（提供商的地址和 Key、Agent 的启动参数），只在宿主设置里改；插件页只放插件级的默认值，并在 `footer` 写明它在什么情况下生效。
- 不重复「管理」里的版本、权限，也不重复「介绍」里的功能列表。

### 6.8 范例

网关适配器（模型源，`role: 'adapter'`，有 `usage`）：

```
提供商      工作            Claude Code · gate.example.com        剩余 62%  ›
            个人  默认      Codex · gate.example.com              已用尽    ⌄
              5 小时      ▓▓▓▓▓▓▓▓▓▓  剩余 0%       18:00 重置
              每周        ▓▓▓▓░░░░░░  剩余 64%      周一 09:00 重置
              模型                                     41  ›
              1 分钟前读取                          ⟳   编辑
默认连接    网关地址   [https://…]
            API Key    [已设置]  清除
            ─ 提供商没填地址和 Key 时使用
```

项目构建（任务与视图，按项目保存设备和产物）：

```
状态        ▲ 未找到构建工具                               [安装说明]
最近任务    app-android    构建 debug              ● 成功 · 10 分钟前   ›
            app-android    构建 release            ● 失败 · 昨天        ›
设备        Pixel 9        已连接 · Android 17                       ⧉
产物        app-android    ▓▓▓▓░░░░  1.2 GB / 5 GB                 [清除]
            构建输出                                                 ›   （视图，手机上不显示）
```

浏览器（Agent 工具，按项目保存数据）：

```
浏览器      ○ Chromium（由 Riffet 下载）   已下载
            ○ Google Chrome                已安装
网站        无需确认   example.com ×   [输入框]
浏览数据    riffet       84 MB   使用中                              [清除]
            docs-site    12 MB                                       [清除]
            ─ 按项目分开保存在服务器上
```

### 6.9 现状

- Web 已画 §6.3 的 `agentBackends`、`taskProviders`、`sharePublisher`、`imChannels` 区块（2026-11-20，`app/plugins/Plugin*Block.tsx`）；Mac 与手机尚未跟进。「最近任务」只列最近 `summaryRows` 条，没有「全部 n 个」；其余三组的「全部 n 个」在组内切换，没有按 §6.5 做成子页；`agentBackends` 每个配置单独读一次目录来取登录状态；`imChannels` 空状态的按钮只打开「设置 › 机器人」，不直接开始添加。
- `status()` 拿不到客户端语言，`PluginStatus.message` 只能是一种语言：Android 构建和 TRAE 排队加速的状态只带 `state`，原因写在插件页里。
- Android 构建的插件页（`official/android/page.ts`）只有缺失的工具和设备，没有 §6.8 的「产物」：插件页读不到项目目录（`PluginHost` 没有列出项目、读写项目目录的接口）。
- 以下内容都还没有实现（2026-11-16 写入规范）：§6.4 新增的 `link`、`row` 附加项（含 `ref`）、区块附加项、`flow` 按钮，以及 `meter` 的 `time`；§6.5 的插件自定义子页。
- Web 已实现 §6.2 状态行、§6.3.1 的 `modelSources` 提供商与额度区块（含展开额度条、模型子页、超过 5 行的全部提供商子页和筛选，以及直达「设置 › 模型提供商」编辑/添加），并与提供商编辑、模型菜单共用额度缓存；网关适配器的 `settings` 按 §6.8 呈现为带回退说明的「默认连接」组。Mac 与手机尚未跟进。
- `meter` 与按客户端能力降级已实现（2026-11-17）：客户端在读取和修改页面时带 `?kinds=meter`（`PLUGIN_PAGE_KINDS_PARAM`），没带的客户端收到一行 `row`，数值是「n%」或带 `value`。Web（`app/plugins/PluginPageView.tsx`）画 `meter`；Mac（`Features/Plugins/PluginPageForm.swift`）和手机仍只画原有的六种条目。
- 手机端客户端已有接口（`apps/mobile/client/src/commonMain/kotlin/riffet/shared/RiffetApiPlugins.kt`），但没有绘制，手机上看不到插件页。
- 浏览器的插件页（`plugins/riffet/browser/page.ts`）用目录名代替项目名，「使用中」写在 `detail` 里，没有数据时用一行 `row` 占位。应分别改成 `ref: project`、`badges` 和区块的 `empty`。
- `PluginStatus`（`packages/contracts/src/plugin-management.ts`）还没有 `time`。`NativeBackendUsage` 没有字段说明「读取成功但没有额度」的原因。`PLUGIN_PAGE_BUDGET` 已在 `budgets.ts` 定义扩展点摘要行数与子页筛选阈值，插件自定义页的条目上限尚未加入。

## 7. 授权与流程

- 动作的步骤（`ActionStep`）由 `PluginFlowDialog` 绘制：`show-code`（二维码、用户码、授权链接、「等待授权…」），`hint`（说明与可复制命令），`failed`（`role="alert"` 的错误加「重试」），`done` 关闭弹窗。轮询由弹窗驱动，间隔遇 `slow_down` 加 5 秒，到 `expiresAt` 报过期。
- 安装授权由 `PluginGrantDialog` 绘制：能力清单（`capabilityLabel`）、是否信任、安装目标。能力名称由宿主翻译，插件不自写授权文案。
- 两者都是 `form` 尺寸的弹窗，页脚取消在左、确认在右（[模式](patterns.md) §2）。插件只返回步骤，不绘制弹窗。

## 8. 状态

视图里的加载、空和错误用宿主的写法，不自创：

| 状态 | 写法 |
|---|---|
| 加载 | 居中的 `Spinner`；视图未就绪时宿主已画一个，不再叠第二个。按钮内加载是原位换成 `Spinner`，宽度不变 |
| 空 | 一句话说明接下来做什么；不用插画 |
| 错误 | 局部错误用 `text-danger` 加原因，`role="alert"`；常驻的降级用 `Notice`；操作结果用宿主通知（桥的 `notify.error`） |
| 不可用 | 插件关闭或服务端 503 时用 `isUnavailable(error)` 识别，显示宿主的不可用视图 |

- 视图抛出的异常由宿主的 `ErrorBoundary` 兜住，不要让它白屏。
- 状态规则全集见[基础](foundations.md) §9。

## 9. 无障碍

- 每个交互元素有名称；纯图标按钮写 `aria-label`（[基础](foundations.md) §10）。声明式页面里 `label` 即名称。
- 键盘可达全部操作，Tab 顺序与视觉顺序一致；焦点环只在键盘操作时显示，隔离页面用基础样式的 `:focus-visible`（含 `data-pointer-focus` 规则），不要 `outline: none` 而不补替代。
- 隔离页面的 `lang` 取应用语言；文字对比度按所在角色，不用 `fg-4` 写正文。
- 状态不只靠颜色：错误同时有文字或图标。
- 桥的 `navigation.*` 需要视图持有焦点且用户操作过，否则 `denied`；视图要让这类操作由可聚焦的按钮触发。

## 10. 文案

文字规则见 [content.md](content.md)（另行编写）；插件界面的补充：

- 文字放在插件自己的 `messages.ts`（`zh-Hans`、`en`），按 `host.locale` 取，不进宿主的 `.po`。声明式页面直接按 `locale` 返回。
- 中文界面下技术名词（命令、路径、字段名）保留原样。
- 按钮写动词，标题写名词，不写「点击」「请」；说明一句，只写用户推断不出的信息（存储位置、是否可撤销、是否需要网络）。

## 11. 插件不要做的事

- 不画窗口外壳：标题栏、关闭按钮、边框、阴影、侧栏页签由工作台提供。
- 不覆盖宿主快捷键：插件声明的默认快捷键与宿主或用户的冲突时不生效（plugin-system §4.3），视图内也不拦截 `⌘K`、`⌘B`、`⌥1-9` 等全局键（`app/use-global-shortcuts.ts`）。
- 不写固定颜色，不假定浅色或深色背景；一律取 `--<role>`。
- 不把渐变、光晕和阴影当装饰铺开：概览面一屏一处渐变，其余的面是平的；阅读面不用（[基础](foundations.md) §12）。
- 不自带字体和第二套图标库；字体用 `--riffet-font-*`。
- 不在隐藏时继续轮询或动画；`ViewContext.visible` 为 false 时暂停。
- 不直接请求宿主 API 或读取登录凭据；经 `PluginHost` 或消息桥，`access` 声明读写范围。
- 不在插件页的主页堆列表：完整列表放子页（§6.5）；`refreshMs` 只用于下载这类慢变化的状态，不用来轮询额度。
- 不在插件页重复宿主已画的信息，也不自己列宿主对象（提供商、项目、任务、分享）的清单；要提到某个宿主对象，用 `ref`（§6.1、§6.4）。
- 菜单命令不弹窗、不改写原消息；结果只经 `text`、`done` 交给宿主显示（§2.1）。
- 不在插件页自己画模型选择器：要用模型就声明 `modelUses`，选择在「设置 › 辅助模型」的「插件」组里，由宿主画。插件页需要提到它时，写一句说明去哪里选。

## 12. 模型提供商适配

- `modelSources` 的可选 `role` 区分 `source` 与 `adapter`，未声明时按 `source`。来源提供连接、凭据与登录；适配器使用提供商已存的地址与凭据，出现在 API 的「网关类型」。
- 复用 `resolve`、`catalog`、`usage`，由宿主绘制连接字段与额度，不为网关自建设置网页。具体协议路径与响应解析留在插件。
- 普通 API 与 adapter 互换只改变适配关系，保留 profile 身份、连接及模型选择。停用后保留已选值并显示不可用，不静默替换来源。
- 额度只使用当前提供商的连接，失败不得返回零或无限；刷新保留同一连接的上次成功读数。

- 插件自己的设置视图可声明 `settingsCategory: "agent" | "providers"`，分别从「Agent」或「模型提供商」进入；未声明的旧视图仍从两处可达。连接字段与启动字段分页面保存，各页只提交自己管理的字段。
