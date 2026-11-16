# Android

本文把[基础](foundations.md)、[模式](patterns.md)和组件落到 Android：每条语义在 Android 上用哪个组件或取值、哪里跟平台而与桌面不同。五种界面风格的数值在 `packages/contracts/src/mobile-styles.ts`，组件配方在 `ui/design/ThemePresets.kt`；主题如何覆盖它们见 [主题契约](../../THEMES.md) §9。本文规定五种风格共同遵守的结构与行为。

每节末尾的「现状」是 2026-11-14 盘点时与规则不符的实现，迁移后删掉对应条目。路径相对 `apps/mobile/shared/src/commonMain/kotlin/riffet/`。

## 1. 分工

行为跟 [Material 3](https://m3.material.io/) 与 Android 系统，外观跟风格配方。移动的数值以 material3 风格为准（[基础](foundations.md) 的「移动 · material3」一列），其余风格只改配方里写到的字段。

| 跟平台 | 跟共用的规范 |
|---|---|
| 系统返回与预测式返回；页面右滑返回 | 颜色角色、文字角色、动效档位 |
| 全面屏：内容画到系统栏下，按 inset 让位 | 组件的种类、状态与无障碍名称 |
| 长按代替右键与悬停：长按打开操作菜单 | 选择控件的选用规则（[模式](patterns.md) §3） |
| 点击区至少 48dp | 确认与撤销、反馈的时机、空状态（[模式](patterns.md)） |
| 短暂反馈用 Snackbar，宿主进程外用系统 Toast | 文案（[文案](content.md)） |
| 系统字体倍率、动画时长缩放、触感 | |
| 权限、文件选择、分享用系统界面 | |

- **风格是配方，不是分支。** 五种风格（`shared/DisplaySettings.kt` 的 `InterfaceStyle`：material3、ios、expressive、miuix、fluent）只在 `ThemePresets.kt` 的 `themePreset()` 里按名字分派一次；组件读 `LocalInterfaceStyle.current` 的 `metrics`（尺寸）、`components`（配方）、`variants`（外观变体）和 `motion`，不判断风格名。
- **新风格**：数值写进 `mobile-styles.ts` 的 `MOBILE_STYLE_DIMENSIONS`，运行 `pnpm gen:tokens`；配方在 `ThemePresets.kt` 加一个 preset，只改与 material3 不同的字段。需要新形态时，先在 `ComponentRecipes.kt` 加字段并在共享组件里实现，再让 preset 选用。
- **覆盖顺序**：风格默认值 → 主题的 `design.tokens` → 主题的 `design.styles.<风格>` → 系统与本机设置（字体倍率、动画缩放、安全区）。主题只改取值，不改交互、授权和业务回调。
- iOS 原生端（`apps/mobile/iosApp`）跟 ios 风格取同样的值，差异写在 `IOS_NATIVE_OVERRIDES`，不在本文范围内。

## 2. 基础的 Android 写法

| 类别 | API | 规则 |
|---|---|---|
| 颜色 | `LocalRiffetColors`（`pnpm gen:theme` 从 Web 样式表生成 `theme/RiffetTheme.kt`） | 业务代码不写 `Color(0x…)` |
| 表面 | `LocalRiffetSurfaces`（`ui/design/Surfaces.kt`） | 页面、分组、卡片、浮层、输入、导航各取各的表面，不自己混色 |
| 文字 | `LocalRiffetTypography` 的角色（§2.1） | 调用处不写 `.sp` |
| 尺寸、间距、圆角 | `LocalInterfaceStyle.current.metrics`（`ui/design/DesignTokens.kt` 的 `DesignMetrics`） | 页面边距 `pageInset`，卡片内 `groupInset`，控件内 `controlInset`；圆角按层级取 `groupRadius` / `controlRadius` / `rowRadius` / `selectionRadius` |
| 阴影 | `Modifier.floatingShadow`（`ui/design/Surfaces.kt`） | 只有浮在内容上的东西有阴影：菜单、浮动底栏、输入框 |
| 线 | `hairline` 色、`hairlineWidth`；焦点 `focus` 色、`focusWidth` | 按下靠背景反馈，不加框 |
| 动效 | `LocalRiffetMotion`（`ui/theme/Motion.kt`） | 系统的动画时长缩放已乘进去，调用处不再乘 |
| 按压 | `RiffetPressIndication`、`Modifier.pressScale`（`ui/design/PressIndication.kt`） | material3 与 expressive 用 ripple，其余风格用表面高亮 |
| 图标 | `RiffetIcons`，经图标包换图形（`pnpm gen:icons` 生成 Lucide） | 尺寸 `iconSize` / `smallIconSize` / `buttonIconSize`；描边 1.25 按渲染尺寸折算 |

### 2.1 文字角色

角色在 `ui/theme/RiffetTheme.kt` 的 `RiffetTypography`，每种风格从自己的字阶映射（`ThemePresets.kt` 的 `typographyDefaults`）。主题可以按角色覆盖。

| [基础](foundations.md) §2 的角色 | `RiffetTypography` | material3 | expressive | miuix | fluent | ios |
|---|---|---|---|---|---|---|
| 正文 | `body` | 16 / 24 | 同左 | 同左 | 同左 | 16 / 22 |
| 界面 | `label`、`button`、`menu` | 14 / 20，500 | 同左 | 同左；菜单 16 | 同左 | 15 / 20，500；菜单 16 |
| 次要 | `caption` | 12 / 16 | 同左 | 同左 | 同左 | 13 / 18 |
| 标题 · 导航栏 | `barTitle` | 22 / 28，500 | 24 / 30，600 | 18 / 28，600 | 20 / 28，600 | 17 / 24，500 |
| 标题 · 大标题 | `largeTitle` | 32 / 40，500 | 32 / 40，700 | 32 / 40，700 | 28 / 40，600 | 34 / 41，700 |
| 标题 · 弹窗 | `dialogTitle` | 24 / 32 | 同左 | 20 / 28，600 | 20 / 28，600 | 17 / 24，500 |
| 代码 | `mono` | 14 / 22 | 同左 | 同左 | 同左 | 同左 |

- 字距一律为 0：Material 字阶的拉丁字距会把中文标签撑开。
- 设置用紧凑的导航栏标题；大标题只用于滚动时会收起的页面。
- 会变化的数字用 `fontFeatureSettings = "tnum"`。
- 用户的「文字大小」（0.9–1.2）乘进 `LocalDensity.fontScale`，与系统字体倍率叠加；终端固定为 1。

**现状**：

- 业务代码里有 7 处 `.sp`（`timeline/TimelinePrimitives.kt` 3、`terminal/TerminalCanvas.kt` 2、`timeline/MarkdownRender.kt`、`sessionlist/SessionList.kt` 各 1）。终端画布是字形网格，可以保留；其余改用角色。
- 生成的 `theme/RiffetTheme.kt` 另有一套 `RiffetText`（Web 的字阶）、`RiffetProse` 和 `RiffetRadius`，只有 `timeline/MarkdownRender.kt` 在用，与 `RiffetTypography`、`DesignMetrics` 是两套取值。

### 2.2 尺寸

| [基础](foundations.md) §4 | Android（material3） | 字段 |
|---|---|---|
| 点击区 48 | 控件把 `LocalMinimumInteractiveComponentSize` 设为 `controlHeight` | `controlHeight`，解析时不低于 48 |
| 按钮可见高 40 | `RiffetButton` | `buttonHeight`（`controlHeight` − 8） |
| 列表行 52，带副标题 64 | `GroupRow` | `rowHeight`、`rowSubtitleHeight` |
| 输入框 48 | `RiffetTextField` | `inputMinHeight` |
| 分段控件 40 | `SegmentedControl` | `segmentedHeight` |
| 菜单行 48 | `RiffetMenuItem` | `menuRowHeight` |
| 导航栏 64，底栏 64 | `PageTopBar`、`RiffetTabBar` | `barHeight`、`tabBarHeight` |
| 发送按钮可见 40，点击区 48 | 输入框 | `sendButtonSize` |

- 图形可以比点击区小（开关、细轨道、小图标），点击区不缩。整行可点的设置项只有一个点击目标，行里的开关和勾选不再单独接收点击。
- 时间线里连续的工具行是例外：可见行高 36，行间距 0。

**现状**：业务代码有约 1000 个 `.dp` 字面量（不含 `ui/design/`、`ui/theme/` 与生成文件），多在 `git/GitPanel.kt`（73）、`interaction/InteractionCard.kt`（48）、`session/SessionDetailsPane.kt`（43）、`settings/ServiceStatusSection.kt`（40）、`settings/BackendsSection.kt`（38）、`composer/Composer.kt`（38）、`files/FilesPanel.kt`（37）、`stats/StatsCharts.kt`（36）。约 24 处可见尺寸 20–47dp 的按钮没有核对点击区。

## 3. 页面与导航

二级页面、浮层和面板的内容怎么组织（页面类型、行、顶栏、反馈），见 [移动端页面](mobile.md)；本节只讲 Android 的导航结构和页面骨架。

### 3.1 结构

| 区域 | Android | 来源 |
|---|---|---|
| 底栏 | 新会话、任务、设置三个目的地，只有图标；宽屏换成侧边导航栏。`variants.navigation` 决定平铺（贴底、表面延伸到手势区）或浮动（胶囊外壳、四周留白） | `ui/app/HomeTabs.kt`、`ui/design/TabBar.kt` |
| 页面栈 | 统计、下载、Git、文件、子 Agent、终端等压栈打开，二级页隐藏底栏；会话页是工作台上的一层 | `ui/app/PageStack.kt`、`PageHost` |
| 左侧栏 | 头部是你的头像和名字；服务器卡片（点开在选择面板里切换）、下载和统计磁贴、收藏的文件夹 | `ui/app/SideDrawers.kt`、`WorkbenchDrawer`；部件在 `ui/app/PaneParts.kt` |
| 右侧栏 | 会话详情：变更、文件、终端、查找磁贴，正在进行的子 Agent 与后台任务，紧凑的详情，一行操作，删除；宽 `drawerWidth`（304），与屏幕边至少留 `drawerMinGap`；结构见 [移动端页面](mobile.md) §2.7 | `ui/app/SideDrawers.kt`、`session/SessionDetailsPane.kt` |

- 返回：系统返回、预测式返回（页面缩到 0.9 并带圆角）和页面右滑返回走同一个分发（`PageBackDispatcher`）。右滑超过屏宽 33%，或超过 5% 且速度超过 500dp/s 时返回；下层页面随之移回。设置里可以关掉右滑或只留边缘。
- 横向滑动留给侧栏和返回，列表行不做左滑操作。
- 页面转场由「动效」设置选：淡入、滑动、缩放或无；时长读 `pageEnter` / `pageExit`。

### 3.2 页面骨架

页面主体都放进 `RiffetPageScaffold`（`ui/app/RiffetPageScaffold.kt`），它对应 Web 的 `PageScaffold`：

- **顶栏**是 `PageTopBar`，在底栏的根页上换成 `TabTopBar`；可展开的页面用 `LargeTitleBar`。顶栏和底栏的表面按 `variants.navigation` 画，滚动后底色不变。
- **正文**包在 `PageBody` 里：转场结束后再组合，然后淡入。页面不自己写 `LocalPageContentReady` 判断。
- **边距**：左右 `pageInset`（16），宽屏内容不超过 `contentMaxWidth`（840），标题与正文之间 `pageTitleGap`。
- **一页一个滚动区**。只滚动设置项的页面用 `ScrollablePage`（设置里是包了它的 `SettingsPage`）。
- **顶栏操作**：`ScrollablePage` / `SettingsPage` 的 `actions` 放最多两个 `PageBarAction`，再多的收进 `PageMoreAction`（⋯）；`search` 传 `PageSearch` 后顶栏多一个搜索图标，点开顶栏变成搜索框，返回收起；根页传 `PageSearch(drawer = true)`，搜索框在内容上方，下拉露出（[移动端页面](mobile.md) §4）；`onRefresh` 打开下拉刷新；操作进行中放 `PageBarProgress`。页面里不再放搜索框、刷新按钮和添加按钮（[移动端页面](mobile.md) §4）。
- **编辑页**：`EditPage`（`settings/SettingsScreen.kt`），顶栏左侧 ✕ 取消、右侧保存动词，没有改动时保存不可用；自带未保存保护。
- **页面下面还有页面**（目录 → 详情 → 编辑）：页面内建一个 `PageStack` 交给 `PageHost`，每一层是自己的 `SettingsPage`，不在同一页里切换状态。
- **一级视图**（2–5 个）：首页的模式切换按 `variants.homeTabs` 画成下划线页签或分段控件；页面内的筛选用 `SegmentedControl`。

**现状**：`git/GitPanel.kt` 和 `pairing/PairingScreen.kt` 自己拼 `PageTopBar` 与 `PageBody`，没有用 `RiffetPageScaffold`。

### 3.3 设置

- 首页按 通用、外观、行为、模型、连接、支持 分组（[决定](../DECISIONS.md) 2026-11-12：分类保持原样），二级页压栈打开并隐藏底栏。
- 分组用 `Group` / `GroupRow` / `GroupTitle` / `GroupFootnote`（`ui/design/Groups.kt`），图标用 `IconTile`，按 `variants.settingsIcons` 画成裸图标或彩色底板。
- 行只有四种（[移动端页面](mobile.md) §2.4）：导航 `SettingsNavigationRow` / `SettingsLinkRow`，开关 `SettingsSwitchRow`，选择 `SettingsChoiceRow`（行尾当前值，点开菜单），操作 `SettingsActionRow`（标题是强调色的动词，删除类用 `danger` 并单独成组放最底下）。`SettingsRow { SettingsButton }` 和 `SettingsButtonsRow` 不再新增，`pnpm check:compose` 会拦下。
- 表单有未保存的改动时，返回（取消、系统返回、右滑）先确认「放弃未保存的修改？」，只有放弃和继续编辑两个答案；保存是页面顶栏的按钮（`settings/UnsavedSettingsGuard.kt`）。

**现状**：ios 风格浅色下，分组卡片与页面底色几乎分不出（2026-11-15 在设置首页和各子页看到），卡片看起来像无底色的平铺列表。

## 4. 浮层

### 4.1 选哪一种

| 需要（[模式](patterns.md) §2.1） | Android |
|---|---|
| 只有图标的按钮的名称 | `contentDescription`；不另画提示气泡 |
| 对一项内容执行操作 | 长按或 ⋯ 打开 `RiffetDropdownMenu` |
| 在一组值里选一个 | `PickerSheet`（底部面板）；选项少且就在触发点旁时用菜单 |
| 需要集中处理、有提交和取消的任务 | 压栈的新页面；内容不多时用 `PickerSheet` |
| 确认一次不可逆的操作 | `ConfirmDialog`（`ui/design/Dialogs.kt`） |
| 报告一次操作的结果 | `RiffetSnackbar` |
| 一个持续存在的状态 | 页面顶部的提示条（§4.4） |
| 列表或页面没有内容 | 空状态（§4.4） |

### 4.2 弹窗

- 只有一个弹窗组件：`ui/design/Dialogs.kt` 的 `AlertDialog` 和 `RiffetDialogContent`。material3 与 expressive 用 Material 的弹窗；其余风格用共享实现，宽度 `alertWidth`，按配方竖排或并排操作。
- 确认一律用 `ConfirmDialog(title, confirmLabel, …, danger)`：标题写动作和对象（「删除会话「x」？」），正文只写推断不出的后果，主操作写动作本身，危险操作用 `danger` 色；取消在主操作之前。超大字体时操作改为竖排。
- 弹窗只放确认和一两个字段；更长的表单压栈成页面，顶部放取消和保存。

### 4.3 菜单与底部面板

- 菜单：`RiffetDropdownMenu`、`RiffetMenuItem`、`RiffetMenuLabel`、`RiffetMenuSeparator`（`ui/pickers/RiffetMenu.kt`）。行高 `menuRowHeight`，宽 `menuMinWidth`–`menuMaxWidth`，圆角 `menuRadius`；最高为屏高的 70%，超出时内容在固定的外壳里滚动。
- 底部面板：`PickerSheetFrame` / `PickerSheet`（`ui/pickers/PickerUi.kt`）。最高为屏高的 70%，宽屏不超过 `sheetMaxWidth`；遮罩挂在窗口层，盖住顶栏和底栏。ios 风格的简单操作面板把取消单独放在下方。
- 侧栏（§3.1）不是浮层：固定标题与关闭按钮，正文独立滚动，点遮罩关闭。

**现状**：`quickchat/QuickChatSheet.kt` 直接用 Material 的 `ModalBottomSheet`；`ui/pickers/PickerUi.kt` 里还有第二个自定义 `Popup`。

### 4.4 反馈

- **Snackbar**：`LocalRiffetSnackbar` 的 `show()`，整个应用一个队列，由外壳托管（`ui/app/RiffetSnackbar.kt`）。带操作的停留更久；页面用 `bottomBar()` 报告底部栏高度，Snackbar 不压在底栏上。Compose 之外（通知回调、安装下载）才用系统 `Toast`。
- **进行中**：`RiffetProgressIndicator`（`ui/design/Progress.kt`）。material3 是弧形进度，ios 风格是辐条；确定进度画数据比例。
- **下拉刷新**：会话列表，以及传了 `onRefresh` 的 `ScrollablePage` / `SettingsPage`。

**现状**：

- 没有共用的空状态和提示条：空状态散在 `HomeEmptyState`、`EmptyDownloads`、`EmptyChart`、`EmptySubagent`、`StatsEmpty`、`EmptyPane`；提示条有 `SettingsMessageBanner`、`PageBanner`、`SheetNotice` 三种，都不在 `ui/design/`。
- 直接调用 `CircularProgressIndicator` 18 处（`composer/Composer.kt`、`session/SessionScreen.kt`、`pairing/PairingScreen.kt`、`timeline/TimelineImages.kt` 等 11 个文件），`downloads/DownloadsScreen.kt` 直接用 `LinearProgressIndicator`。
- 没有骨架屏组件，只有 `stats/StatsPages.kt` 的 `StatsSkeleton`。

## 5. 选择控件

选用规则与 [模式](patterns.md) §3 相同，Android 的对应如下：

| Web | Android | 各风格的画法 |
|---|---|---|
| `Segmented` | `SegmentedControl` | `controls.segments`：相连（material3）、滑块（ios、miuix）、胶囊（expressive）、下划线（fluent） |
| `Select` | `PickerSheet`；就近的少量选项用 `RiffetDropdownMenu` | 选中项在行尾打勾（`lists.selectionAtEnd`） |
| `Switch` | `RiffetSwitch` | material3 与 expressive 用 Material 开关，miuix 用 Miuix 组件，ios 与 fluent 用共享实现 |
| `Checkbox` | `RiffetCheckbox` | |
| `RadioGroup` | 行尾的 `SelectionMark`；`RiffetRadioButton` 只在必须显示圆点时用 | |
| `Slider` | `RiffetSlider` | 轨道高 `sliderTrackHeight`，滑块 `sliderThumbSize` |
| `UnderlineTabs` | 首页模式切换（`variants.homeTabs`） | |

- 设置里整行可点：点行就切换或打开选择，不只点控件。
- 改动即时生效的选择不配保存按钮；属于表单的选择随表单保存。

## 6. 组件对照

| Web（`components/ui/`） | Android（`ui/design/` 等） | 现状 |
|---|---|---|
| `Button` `primary` / `secondary` / `danger` | `RiffetButton` | 次要按钮按 `variants.secondaryButtons` 画成浅底或透明 |
| `Button` `ghost` / `quiet` / `link` | `RiffetTextButton`、`RiffetInlineAction` | |
| 图标按钮 | `RiffetIconButton` | |
| 胶囊 | `ChipRow`（筛选）、`ChipButton`（菜单）、`ToggleChip`（开关），同一尺寸（[移动端页面](mobile.md) §1.1） | 输入框里的模型胶囊按 [界面](surfaces.md) §1.8 另画，高 28 |
| `Input` / `Textarea` / `Field` | `RiffetTextField`（`Inputs.kt`）；分组卡片里的字段用 `GroupField`（无边框，卡片即容器）；占位符一律 `fg3` | 输入框、终端输入、会话内查找、问答卡片里还有 5 处 `BasicTextField`，有的是有意为之，未逐个核对 |
| `SearchField` | `RiffetSearchField`；根页下拉露出的放在 `SearchReveal` 里 | — |
| `Switch` · `Checkbox` · `Slider` · `Segmented` | 见 §5 | |
| `ListRow` · `SettingsGroup` / `SettingsRow` | `GroupRow` · `Group` | 两个文件仍用 Material 的 `ListItem` |
| `CopyButton` | `CopyTextButton`（`ui/timeline/TimelinePrimitives.kt`） | 不在 `ui/design/` |
| `Skeleton` | `SkeletonBlock`、`SkeletonRows`（`design/Feedback.kt`） | |
| `Spinner` · `Progress` | `RiffetProgressIndicator` | `timeline/TimelinePrimitives.kt` 另有 `Spinner`；下载页手画进度条 |
| `Tip` | 无，用 `contentDescription` | `session/WorkingIndicator.kt` 用了 Material 的 `TooltipBox` |
| `toast` | `RiffetSnackbar`（`ui/app/RiffetSnackbar.kt`） | |
| `Notice` | `Notice`（`design/Feedback.kt`）；`PageBanner`、`SettingsMessageBanner`、`SheetNotice` 是它的薄封装 | |
| `EmptyState` | `EmptyState`（`design/Feedback.kt`） | 平板右栏没有选中会话时只画动态标志（`app/HomeTabs.kt` `EmptyPane`），不算空状态 |
| `Dialog` · `confirmDialog` · `promptDialog` | `ConfirmDialog`、`AlertDialog`、`RiffetDialogContent` | |
| `UnderlineTabs` | `ViewTabs`（`design/ViewTabs.kt`） | 新会话页的 `HomeModeTabs` 手写 |
| `RadioGroup` | 选择面板的 `OptionRow`、问答卡片的 `SelectionMark` | 当前值只打勾、不填充（[移动端页面](mobile.md) §1.1） |
| `Avatar` | `OwnerAvatar`、`AgentAvatar`（`design/`） | |
| `Badge` | 不用：状态写成颜色和字（[移动端页面](mobile.md) §1.1）；底栏的未读数用 Material `Badge` | `session/TurnRail.kt` 的 `HistoryPill` 私有 |
| `Collapse` | 无 | 新增；「高级」折叠组（[移动端页面](mobile.md) §2.3）各页自己写 |
| `DropdownMenu` | `RiffetDropdownMenu`、`RiffetMenuItem(selected, showCheck)` | 没有勾选框项和子菜单 |
| `Popover` | 不用：触摸屏上改用菜单或底部面板 | |
| `StatusDot` · `StatusPill` | `StatusDot`（`ui/timeline/TimelinePrimitives.kt`） | 会话页的 `ConnectionPill` 是私有实现 |
| 分隔线 | `hairline` 与 `hairlineWidth` | 10 个文件直接用 Material 的 `HorizontalDivider` |
| `PageScaffold` | `RiffetPageScaffold` | 见 §3.2 |
| `Kbd` | 无（终端快捷键行除外） | |

新组件按 [架构](architecture.md)「改动的顺序」：先写规范，再实现，再迁移调用点，最后删掉旧写法。

## 7. 手势、触感与无障碍

- **长按**：会话行、消息、文件和 Git 条目长按打开操作菜单；长按与单击做的事不同，单击总是打开。
- **触感**：经 `rememberAppHaptics()`（`ui/haptics/AppHaptics.kt`），默认关闭，在设置的「手势与触觉」里打开。用于确认、拒绝、越过手势阈值和长按；不给普通点击加触感。
- **减弱动效**：系统动画时长缩放为 0 时（`rememberReducedMotion()`），循环动画停下，位移和缩放换成淡入淡出。
- **名称**：只有图标的按钮必须有 `contentDescription`；装饰性的图标设为 `null`。状态写在 `stateDescription`，合并成一句的行用 `clearAndSetSemantics`。
- **键盘**：输入框用 `Modifier.keyboardPadding()` 让出键盘高度，手指按住时保持布局；底栏不随键盘上移。

**现状**：`Icon(` 178 行，`contentDescription` 133 行，其中显式为 `null` 的 82 行；只有图标的按钮缺多少名称还没有逐个核对。

## 8. 设计规范页

- **Web 设计规范页的 Android 部分**（`/design?platform=android`，代码在 `apps/web/src/app/design/android/`）讲规范：平台分工、五种风格的数值与配方、文字角色、组件对照、页面与导航、浮层。尺寸和动效直接读 `MOBILE_BASE_DIMENSIONS` 与 `MOBILE_STYLE_DIMENSIONS`，每种风格画一张手机缩样；配方在 Kotlin 里，页面上的配方表按 `ThemePresets.kt` 誊写，改 preset 时同步改 `apps/web/src/app/design/android/values.ts`。
- Android 上验收组件用 JVM 离屏渲染生产组件（[主题契约](../../THEMES.md) §8.5），系统键盘、手势和安全区以真机为准。

## 9. 落地顺序

按影响面从大到小排。每一步完成后删掉本文对应的「现状」条目。页面的重做排在组件之前，顺序见 [移动端页面](mobile.md) §8；下面是组件与取值的部分。

1. **反馈组件**：在 `ui/design/` 建 `EmptyState` 和 `Notice`，迁移六处空状态和三种提示条；直接调用的进度指示改用 `RiffetProgressIndicator`。
2. **页面**：`GitPanel`、`PairingScreen` 改用 `RiffetPageScaffold`。
3. **间距**：从 §2.2 列出的文件开始，把 `.dp` 字面量换成 `DesignMetrics` 的字段；缺的档位先补进 `mobile-styles.ts`。之后给 `check:design` 加上 Android 的按文件基线，只降不升。
4. **线与文字**：`HorizontalDivider` 换成读 `hairline` 的分隔线；收掉业务代码里的 `.sp`；`RiffetText`、`RiffetProse`、`RiffetRadius` 并入角色或删除。
5. **浮层**：`QuickChatSheet` 和 `PickerUi` 里的第二个 `Popup` 归入 `PickerSheetFrame` 和 `RiffetDropdownMenu`，做不到的在本文写明例外。
6. **无障碍**：逐个核对只有图标的按钮的 `contentDescription`，以及 20–47dp 按钮的点击区。
7. **设计规范页**：Android 部分随上面各步更新组件对照。
