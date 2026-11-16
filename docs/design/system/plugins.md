# 插件界面

本文给写插件的人：插件的界面怎么选呈现方式、能出现在哪里、能拿到什么取值和组件，怎样才与宿主一致。协议与权限见 [plugin-system.md](../plugin-system.md)（§4 工作台界面扩展、§6 外观资源协议）和 [PLUGIN_ARCHITECTURE.md](../../PLUGIN_ARCHITECTURE.md)；取值的含义见[基础](foundations.md)，组合规则见[模式](patterns.md)。页面上的对应章节是「扩展与工程 · 插件界面」。

每节末尾的「现状」是 2026-11-14 盘点时与规则不符的实现，改完后删掉对应条目。

## 1. 三种呈现方式

| | 声明式描述 | 应用内模块 | 隔离视图 |
|---|---|---|---|
| 谁绘制 | 宿主组件，按插件给出的结构 | 插件的 React 组件，用 `UiKit` | 插件自带的页面，在 iframe 或 `WKWebView` 里 |
| 平台 | Web、Mac、手机 | Web | Web、Mac |
| 样式来源 | 宿主组件 | `UiKit` 与应用相同的 Tailwind 类 | 颜色角色变量、`--riffet-*`、元素规则 |
| 可用位置 | `settings`、`sidebar`、`session-view` | 全部 | `session-view`、`sidebar` |
| 谁能用 | 所有插件 | 内置插件（画布、Cursor 设置页） | 本地开发包与独立安装包 |

选择顺序：

1. 内容是设置、检测结果、数据列表、动作：用声明式描述。插件详情的第二个页签（`PluginPage`，见 §6）和侧栏的 `list`、`form`、`detail`、`tasks` 渲染器都属此类。三个平台一份描述，不为每端写界面（DECISIONS「插件详情：介绍、插件自己的页、管理」否决了以自定义网页为主要形式）。
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
| `settings` | 「插件」详情弹窗里插件自己的页签 | 弹窗 `size="content"` 768，高 `min(42rem, 100dvh − 32px)`，手机全屏 | `app/plugins/PluginsPage.tsx:369` |

- 视图按容器宽度排版，不假定 380：悬浮或全屏时宽度会变，手机上侧栏与设置是全屏。
- 视图的内边距、标题、关闭按钮由宿主绘制，视图内容从容器边缘开始。声明式页面的内边距由宿主给出。
- 隔离视图当前只能出现在 `session-view` 与 `sidebar`；`settings` 位置只能由内置入口绘制（PLUGIN_ARCHITECTURE「自定义视图」）。
- 视图实例按 `serviceId`、`projectId`、`sessionId`、`instanceId` 定 key；`ViewContext.visible` 为 false 时暂停轮询和动画。

## 3. 视图拿到的取值

### 3.1 颜色

宿主把调色板的全部角色（`THEME_ROLES`，`--bg`、`--fg`、`--accent`、`--line` 等）作为 `--<role>` 变量写进隔离页面的 `:root`，并在切换主题、配色、深浅或字号时经 `theme` 事件重新推送（`apps/web/src/plugins/isolated/document.ts` 的 `readTheme`、`IsolatedView.tsx`）。`color-scheme` 随之设置。同一份变量里有 `--text-scale`（宿主字号设置，基础 §10），基础样式的字号与行高按它缩放，未推送时取 1。

- 视图的颜色一律写 `var(--<role>)`。不写色值，不写固定的深色或浅色。
- 语义同[基础](foundations.md) §1：文字用 `fg` 到 `fg-4`，面用 `bg`、`bg-subtle`、`bg-elevated`，线用 `line`、`line-strong`，状态用 `success`、`warning`、`danger` 及其 `-soft`。
- 应用内模块直接用与应用相同的 Tailwind 类（`text-fg`、`bg-elevated`），`@source` 已包含 `plugins/`。

### 3.2 `--riffet-*` 与元素规则

`PLUGIN_BASE_STYLE`（`packages/plugin-web/src/base-style.ts`，版本 `PLUGIN_BASE_STYLE_VERSION`）写进每个隔离页面，Mac 由 `pnpm gen:plugin-style` 生成同一份文本到 `PluginPageDocument.swift`，`gen:plugin-style:check` 核对。

| 类别 | 变量 |
|---|---|
| 间距 | `--riffet-space-1…5`：4、8、12、16、24 |
| 圆角 | `--riffet-radius-control` 8、`-container` 10、`-card` 12 |
| 字体 | `--riffet-font-sans`、`--riffet-font-mono` |
| 字号与行高 | `--riffet-text-reading` 14/23、`-ui` 13/20、`-small` 12/16 |
| 其他 | `--riffet-control-height` 32、`--riffet-border-width` 1px、`--riffet-focus-ring`（与宿主的 `--focus-ring` 同值，`--accent` 50%，随推送的 `--accent` 变化） |

元素规则全部包在 `:where()` 里（特异性为零），插件自己的 CSS 无需 `!important` 即可覆盖：`body`、`a`、`button` 与 `input[type=button|submit|reset]`、文本类 `input`、`textarea`、`select`、`code`/`pre`/`kbd`、`hr`、`table`、`:focus-visible`、`::selection`、禁用态、细滚动条，以及 `prefers-reduced-motion` 下把过渡与动画压到近零。`host.info` 返回 `baseStyleVersion`（即 `PLUGIN_BASE_STYLE_VERSION`），插件据此判断拿到的是哪一版。用原生元素写的界面因此与宿主的按钮、输入框同形。没有类名组件和工具类。

### 3.3 现状

- 没有阴影、层级和动效变量：视图不能画与宿主一致的浮层（`shadow-pop`），`--duration-*`、`--ease-*` 也不存在，基础样式里的 `.15s` 是手写值。
- 没有内容宽度变量：视图不知道所在位置是 380 的侧栏还是全屏，只能用容器查询或自己量。

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

## 6. 声明式页面

插件详情的第二个页签由 `PluginPage` 描述（`packages/contracts/src/plugin-page.ts`），Web 的 `PluginPageView` 用设置的控件绘制，Mac 与手机各自绘制。

| 项 | 绘制 | 保存 |
|---|---|---|
| `choice` | 单选组；选项可带 `detail`（检测结果）与 `button`（如下载） | 立即 |
| `toggle` | `SettingsRow` + `Switch` | 立即 |
| `text` | `SettingsRow` + `Input`，`secret` 时为密码框，值不回传，只回 `set` | 回车或失焦 |
| `list` | 标签列表 + 输入框 | 整个列表一起 |
| `row` | 只读的值，行尾可带按钮 | 无 |
| `buttons` | 一排 `xs` `secondary` 按钮 | 无 |

- 一次只处理一个改动，期间控件禁用；每次改动后页面按返回值重画。`refreshMs` 用于会自己变化的状态（下载进度）。
- 与区块标题相同的 `choice` 标签不重复显示。`footer` 只写从条目里看不出的信息，一句。
- 按钮的 `confirm` 触发宿主的确认弹窗，`destructive` 画成危险样式；插件不自己画确认。
- 文字由插件按请求的 `locale` 给出。写法见[文案](foundations.md)与 content.md（文案规则）。

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
- 键盘可达全部操作，Tab 顺序与视觉顺序一致；焦点环只在键盘操作时显示，隔离页面用基础样式的 `:focus-visible`，不要 `outline: none` 而不补替代。
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
- 不自带字体和第二套图标库；字体用 `--riffet-font-*`。
- 不在隐藏时继续轮询或动画；`ViewContext.visible` 为 false 时暂停。
- 不直接请求宿主 API 或读取登录凭据；经 `PluginHost` 或消息桥，`access` 声明读写范围。
- 不用声明式页面承载大量数据或频繁刷新；`refreshMs` 只用于下载这类慢变化的状态。

## 12. 模型提供商适配

- `modelSources` 的可选 `role` 区分 `source` 与 `adapter`，未声明时按 `source`。来源提供连接、凭据与登录；适配器使用提供商已存的地址与凭据，出现在 API 的「网关类型」。
- 复用 `resolve`、`catalog`、`usage`，由宿主绘制连接字段与额度，不为网关自建设置网页。具体协议路径与响应解析留在插件。
- 普通 API 与 adapter 互换只改变适配关系，保留 profile 身份、连接及模型选择。停用后保留已选值并显示不可用，不静默替换来源。
- 额度只使用当前提供商的连接，失败不得返回零或无限；刷新保留同一连接的上次成功读数。

- 插件自己的设置视图可声明 `settingsCategory: "agent" | "providers"`，分别从「Agent」或「模型提供商」进入；未声明的旧视图仍从两处可达。连接字段与启动字段分页面保存，各页只提交自己管理的字段。
