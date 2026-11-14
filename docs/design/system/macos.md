# macOS

本文把[基础](foundations.md)、[模式](patterns.md)和组件落到 Mac：每条语义在 Mac 上用哪个组件或 API、取什么值、哪里按平台而与 Web 不同。视觉取值来自风格配方：Riffet 风格见 [Riffet 风格](../riffet-style.md)，原生风格见 [macOS 原生](../macos-native.md)。本文规定三种风格共同遵守的结构与行为。

每节末尾的「现状」是 2026-11-14 盘点时与规则不符的实现，迁移后删掉对应条目。路径相对 `apps/macos/Riffet/`。

## 1. 分工

行为跟 [HIG](https://developer.apple.com/design/human-interface-guidelines/)，外观跟风格配方。桌面的数值 Mac 与 Web 相同（Mac 为 pt，Web 为 px）。

| 跟平台 | 跟 Web |
|---|---|
| 设置是独立窗口，⌘, 打开 | 文字、间距、圆角、阴影、动效的档位 |
| 弹窗是附着在窗口上的 sheet | 弹窗的四档宽度、页脚按钮的顺序与文案 |
| 右键菜单、设置表单里的选择用系统控件 | 应用菜单的浮层（绘制风格下） |
| 提示气泡用系统的 `.help` | 页面骨架的内容列档位与内边距 |
| 每个工具栏命令在菜单栏都有对应项，带 ⌘ 快捷键 | 选择控件的选用规则（[模式](patterns.md) §3） |
| 窗口失焦时选中态变淡（`appearsActive`） | 状态集合（[基础](foundations.md) §9） |

- 代码读配方字段（`style.menu`、`style.form`、`style.tabs`……），不判断风格名。配方由 `packages/contracts/src/interface-styles.ts` 定义，`pnpm gen:styles` 生成 `Theme/InterfaceStyles.swift`。
- `style.backend == .native` 只用于选择整套外壳：系统的 `NavigationSplitView` 与工具栏，或者绘制的侧栏与页头。单个组件的画法改读具体字段。

**现状**：`backend == .native` 另被 `Theme.swift` 的 `markRole` 和 `TranscriptStyle.swift` 用来决定颜色与排版，应改读 `style.ink` 等字段。

## 2. 基础的 Mac 写法

| 类别 | API | 规则 |
|---|---|---|
| 颜色 | `palette.*`（`pnpm gen:theme` 生成） | 业务代码不写颜色字面量。我们自己画的标记（勾选、进行中的步骤、选中的卡片）用 `palette.mark` |
| 文字 | `RiffetFont` 的角色（§2.1） | 调用处不写字号 |
| 间距 | `Space.xxs`（2）· `xs`（4）· `sm`（8）· `md`（12）· `lg`（16）· `xl`（24）· `xxl`（32） | 28 只用于 `Column.gutter` |
| 圆角 | `Radius.control` · `container` · `card` · `floating` · `menu`，取自 `style.radii` | 一律 `.continuous`；嵌套时内圆角 = 外圆角 − 内边距，最小 4 |
| 阴影 | `.elevation(.raised / .float / .floatFocus / .pop / .peek)`；AppKit 图层用 `Elevation.apply(to:dark:)` | 只有浮在内容上的东西有阴影 |
| 动效 | `Motion.fast` · `standard` · `expressive` | 页面与会话切换用 `ColumnCrossfade`（`CATransition`），见 [macOS 原生](../macos-native.md) §3.2 |
| 图标 | `Image(icon:)`：SF Symbol 名，经 `IconPack` 换成所选图标包 | 尺寸按 [基础](foundations.md) §8 的 Mac 一列：主导航 12.5、按钮与页签 13、行内 12、元信息 11 |
| 字号缩放 | `S(_:)` | 角色内部已经乘过，调用处不再乘 |

### 2.1 文字角色

角色名沿用 `RiffetFont`（`Theme/Theme.swift`），在现有的 `body`、`label`、`caption` 之外补上缺的几档。

| [基础](foundations.md) §2 的角色 | `RiffetFont` | Riffet 取值 | 来源 |
|---|---|---|---|
| 正文 | `.body` | 14 / 23 | `RiffetTextSize.base`；行高取 `style.text.readingLine` |
| 界面 | `.label` | 13 / 20 | `style.text.body` |
| 次要 | `.caption` | 12 / 16 | `style.text.secondary` |
| 注脚 | `.footnote`（新增） | 11 / 16 | `RiffetTextSize.x2xs` |
| 标题 · 弹窗 | `.dialogTitle`（新增） | 16 / 24，500 | `RiffetTextSize.lg` |
| 标题 · 栏 | `.barTitle`（新增） | 13 / 20，500 | `style.text.body` |
| 代码 | `.code` | 13 / 20 | `RiffetTextSize.sm`，等宽 |

- 字重只用 `.regular` 与 `.medium`。`.semibold` 只给品牌名。
- 没有半档字号。11.5 并入 12，12.5 并入 13，10.5 并入 11；10 以下只用于图形尺寸（下拉箭头、角标），不用于文字。
- 会变化的数字加 `.monospacedDigit()`。
- 直接写 `.riffet(size:)` 只允许出现在主题层（`Theme/`）和画内容的文件（主题预览、导出图片）里，与 `check:design` 的豁免范围相同。

**现状**：

- 调用处写字号的 `.riffet(size:)` / `.system(size:)` 约 1100 处，用 `RiffetFont` 的只有 42 处；`check:design` 的基线记着 93 个文件 1077 处。
- 半档字号约 150 处；`SolidButtonStyle`、`SegmentedTrack` 内部写死了 12.5，`RiffetFont.code` 是 12.5。
- `.semibold` 152 处、`.bold` 20 处，包括弹窗标题（16 semibold）。
- `packages/contracts/src/design-tokens.ts` 的 `SPACE` 缺 [基础](foundations.md) §3 列出的 20。补进源再生成，弹窗的内边距（§4.2）才有档位可用。
- 内边距写数字的约 235 处，常见的 5、6、10 不在档位里；`check:design` 的基线记着 54 个文件 229 处。

### 2.2 尺寸

| [基础](foundations.md) §4 | Mac |
|---|---|
| 图标按钮 28 × 28 | `IconButtonStyle(size:)` |
| 胶囊高 26 | `ChipButtonStyle` / `ChipLabel` |
| 列表行 30 | `style.layout.sidebarRow` |
| 菜单行 32 | `DrawnMenu` 的 `MenuMetric.row` |
| 分段控件 32 | `SegmentedTrack` |
| 导航栏 / 卡片头 44 | `style.layout.header` |

**现状**：`IconButtonStyle` 默认 26；`SegmentedTrack` 的选项最小高 24，加轨道内边距不到 32。

## 3. 窗口与页面

### 3.1 工作台

| 区域 | Mac | 来源 |
|---|---|---|
| 侧栏 | 210–400，默认 `style.layout.sidebarWidth`（Riffet 236）；窗口放不下侧栏 + 主区 420 + 面板时自动收起，宽度够了再展开；双击边缘恢复默认宽度 | `Features/Workbench/WorkbenchView.swift`、`CustomWorkbench.swift` |
| 主区 | `style.window == .insetCard` 时是内缩 8 的卡片，其余满铺（[决定](../DECISIONS.md) 2026-11-04） | `Features/Workbench/CustomWorkbench.swift` 的 `CustomCard` |
| 右侧面板 | 300 到窗口宽 − 420，默认 `style.layout.rightPanel`（Riffet 320）；停靠、悬浮、全屏由用户切换 | `WorkbenchView.swift`、`InspectorFloat` |
| 终端 | 140 到 min(详情高 × 0.6，详情高 − 240)，默认 240 | `WorkbenchView.swift` |
| 阅读列 | 640–1600，默认 760（[决定](../DECISIONS.md) 2026-11-13） | `Column.width`、`Preferences.swift` |

**现状**：Web 的右侧面板是 320–720、默认 380，终端 160–560、默认 280，这两处与 Mac 不同，也没有决定说明原因。宽度归入配方 `layout` 后，两端读同一个值；Web 目前还没有接入配方。

### 3.2 页面骨架

非会话的页面（定时任务、收藏、插件、统计、扩展、并行尝试）都用 `PageScaffold`（新增，放在 `Features/Workbench/`）。它与 Web 的 `PageScaffold` 对应：

```swift
PageScaffold(title: "定时任务", column: .document, search: $query) {
    // 页面内容：只放内容，不再自己写宽度、内边距和 ScrollView
} actions: {
    PageActionButton(…)
}
```

- **页头**交给现有的 `pageChrome`。原生风格下标题在窗口工具栏，操作是 `.primaryAction` 里各自独立的 `ToolbarItem`，页面搜索用工具栏的 `.searchable`。自绘风格下是 `CustomPageBar`，高 `style.layout.header`。操作排在右侧，图标按钮在前，主操作在最后。
- **内容列**的档位与 Web 相同：`.document` 768，`.board` 1200，`.none` 由页面自己排。
- **内边距**左右 32，顶部 40，底部 64（底部给最后一项留出滚动余量）；内容列宽度不含内边距。
- 一页只有一个 `ScrollView`。
- **一级视图**（2–5 个）：原生风格放在工具栏中间，用系统分段控件；自绘风格按 `style.tabs` 画页签，放在内容列顶部。视图内的筛选用 `SegmentedTrack`。
- **例外**与 Web 相同：扩展管理是目录加检查器的双栏页，只用 `pageChrome`，宽度上限 1080；新会话主页的输入框居中，宽度跟输入框走。

**现状**：每页自己写宽度和内边距。

| 页面 | 文件 | 现在 | 目标 |
|---|---|---|---|
| 定时任务 | `Features/Tasks/TasksPage.swift` | 760，左右 16、上 16、下 32 | `.document` |
| 收藏 | `Features/Marks/MarksPage.swift` | 760，左右 24、上 16、下 64 | `.document` |
| 插件 | `Features/Plugins/PluginsPage.swift` | 720，`Form` | `.document` |
| 统计 | `Features/Stats/StatsView.swift` | 1180，左右 16、上 12、下 32 | `.board` |
| 扩展概览 | `Features/Extensions/ExtensionsOverview.swift` | 1180 | `.board` |
| 并行尝试 | `Features/Orchestration/AttemptGroupView.swift` | 1080，左右 32、上下 24 | `.board` |
| 新会话主页 | `Features/Home/HomeView.swift` | 720（停靠时 744） | 例外 |

### 3.3 设置窗口

- 设置在所有风格下都是独立窗口（`Settings` 场景），⌘, 打开。配方的 `settings` 字段只对 Web 生效：Web 的 Riffet 风格把设置做成大弹窗，Mac 不读这个字段。
- 结构：`NavigationSplitView`，左侧分类 200–270（默认 228），窗口最小 820 × 600、默认 880 × 780，顶部的搜索按分类和设置项筛选。分类保持原样（[决定](../DECISIONS.md) 2026-11-12）。
- 表单用 `.riffetForm()`：分组式（`style.form == .grouped`）用系统的 grouped `Form`，线条式（`.lined`）用 `LinedFormStyle`。行用 `Features/Settings/SettingsComponents.swift` 里的 `SettingsRow`、`SettingsFieldRow`、`SettingsStatusRow`，空状态用 `SettingsEmptyState`，保存反馈用 `SettingsFeedback`。
- 设置窗口里的控件跟平台：开关用 `.switch`，分组列表里用 `.controlSize(.mini)`；选择用 `.formPicker()`；分段用 `FormSegmented`。

## 4. 浮层

### 4.1 选哪一种

| 需要（[模式](patterns.md) §2.1） | Mac |
|---|---|
| 纯图标按钮的名称和快捷键 | `.help("名称")`，同时写 `accessibilityLabel` |
| 从一个触发点执行操作，或在一组命令里选一个 | 工作台里的控件（工具栏、胶囊、行尾按钮）弹出的菜单经 `NSMenu.popUpStyled(at:in:)`：`style.menu == .drawn` 时画成应用的浮层，否则是系统菜单。SwiftUI 里用 `ChoiceMenu`、`PageMenuButton`、`ToolbarMenuButton` |
| 右键菜单 | `.contextMenu`，所有风格都用系统菜单 |
| 锚定在触发点旁、改动即时生效的小块内容 | `StylePopover`（`Theme/AnchoredPopup.swift`）；原生风格用 `.popover` |
| 需要集中处理、有提交和取消的任务 | `.sheet` 加 `SheetScaffold`（§4.2） |
| 确认一次不可逆的操作 | `.confirmationDialog`；需要等待请求结果、在弹窗里显示错误的确认用 `SheetScaffold` 的确认档 |
| 报告一次操作的结果 | `Toast`（新增，§4.4） |
| 一个持续存在的状态 | `NoticeBar`（[决定](../DECISIONS.md) 2026-11-13） |
| 列表或页面没有内容 | `ContentUnavailableView`；设置里用 `SettingsEmptyState` |

- 一次操作只出现一个浮层：菜单里的命令需要更多输入时，先关菜单再开 sheet。
- `NSAlert` 只用于没有 SwiftUI 场景可附着的地方，比如菜单栏面板和纯 AppKit 的流程。

### 4.2 弹窗（sheet）

`SheetScaffold`（新增，放在 `Theme/`）统一给出标题、正文、页脚和键盘操作，调用处只填内容和按钮。

- **宽度**与 Web 四档相同：确认 420，表单 448（默认），内容 768，工作区 1080。高度随内容，不超过窗口高减 64，超出时正文滚动。
- **结构**：
  - 标题用 `RiffetFont.dialogTitle`，可以带一句说明，用 `.caption` 和 `fg3`；
  - 左右内边距 20；页头上 20、下 12；页脚上 16、下 20。
- **页脚**：按钮靠右，主操作在最右，取消紧挨在它左边，两者同高。主操作的文字是动词加对象，标题陈述要发生的事，与 Web 相同。
- **键盘**：
  - 主操作是 `.keyboardShortcut(.defaultAction)`；
  - Esc 由 `SheetScaffold` 的 `onExitCommand` 关闭，所以取消按钮不必占用 `.cancelAction`；
  - 不可逆的确认里，危险按钮不响应 Return，Return 落在取消上（HIG：破坏性操作不做默认按钮）；
  - 打开时焦点落在第一个输入框，没有输入框时落在默认按钮。
- 点 sheet 外部不关闭。浏览类的 sheet 可以用 `SheetOutsideClick` 例外，比如插件和扩展的详情。

**现状**：

- 没有共用容器。41 处 `.sheet` 各自写 `VStack` 加 `HStack { Spacer; 取消; 主操作 }` 加 `.padding(Space.xl)`。
- 宽度约 15 种：400、420、440、460、480、500、520、560，以及 620–960 之间的若干档。
- `.defaultAction` 有的放在主操作上（`ChannelSheets.swift`），有的放在取消上（`SessionDeletion.swift`）。
- 确认的写法有三种，并存：`.confirmationDialog` 36 处、`.alert` 22 处、`NSAlert` 9 处。

### 4.3 菜单与弹出层

- 绘制风格下的菜单就是 `DrawnMenu`，取值与 Web 的菜单浮层一致：
  - 内边距 4、行高 32（带副标题的行 44）、分组标题 28；
  - 圆角 `style.radii.menu`，行圆角按嵌套规则取；
  - 宽 176–360，阴影 `.pop`，子菜单延迟 0.2 秒。
- 菜单项的规则同 Web：命令以动词开头；选项用名词，当前项打勾；危险项放在最后，前面加分隔线，文字用 `danger`。
- 设置窗口和表单里的 `Picker`、`Menu` 保持系统控件。

**现状**：

- 工作台里的 SwiftUI `Menu` 在绘制风格下仍画成系统菜单。`Menu` 共 133 处、分布在 37 个文件，经 `popUpStyled` 的只有 3 个文件；哪些属于工作台、哪些属于设置，还没有逐个区分。
- `DrawnMenu` 的行内图标是 14，按 [基础](foundations.md) §8 应为 13。

### 4.4 提示与通知

- 提示气泡统一用 `.help`。只有图标的按钮必须带 `.help`，文字按钮不写。
- `Toast` 的浮层用 `PopoverSurface`，与菜单相同（[决定](../DECISIONS.md) 2026-11-13：提示条跟随主题）。成功和失败只体现在图标颜色上。停留时间与 Web 相同：成功 2.8 秒、信息 3.5 秒、错误 6.5 秒，悬停时暂停。
- 播报：`FeedbackRegion` 负责 VoiceOver 的即时播报，`Toast` 和 `NoticeBar` 都经过它。

**现状**：没有共用的 `Toast`。`Features/Share/ShareSheet.swift` 里有一个私有的 `ToastFeedback`，输入框的状态提示也是单独写的。

## 5. 选择控件

选用规则与 [模式](patterns.md) §3 相同，Mac 的对应如下：

| Web | 工作台（绘制风格） | 设置窗口与表单 |
|---|---|---|
| `Segmented` | `SegmentedTrack` | `FormSegmented`（分组式表单下是系统分段控件） |
| `Select` | `ChoiceMenu`，经 `popUpStyled` | `.formPicker()`（`Picker` 的菜单样式） |
| 标题式 `Select` | `ChoiceMenu` 的标题外观（新增参数）：对象名用 `.barTitle`，无边框，后跟下拉箭头 | 同左 |
| `Switch` | `Toggle` 加 `.switch`；`style.ink == .quiet` 时是墨色 | 同左；分组列表里用 `.controlSize(.mini)` |
| `UnderlineTabs` | 按 `style.tabs` 画的页签（§3.2） | 不用 |

- 系统的 `.pickerStyle(.segmented)` 只用在设置窗口和工具栏里（[macOS 原生](../macos-native.md) §2.1）。
- 不用 `.radioGroup`。选项需要看描述或预览才能选时，用带缩略图的单选卡片。

**现状**：模型设置里切换「配置哪个 Agent」的控件，Web 已经改成标题式选择（[决定](../DECISIONS.md) 2026-11-14），Mac 还要核对并跟上。

## 6. 组件对照

| Web（`components/ui/`） | Mac（`Theme/`） | 现状 |
|---|---|---|
| `Button` `primary` | `SolidButtonStyle(kind: .primary)` | 字号 12.5、semibold，改为 `.label`、500 |
| `Button` `secondary` | `SolidButtonStyle(kind: .secondary)` | 是 `bgElevated` 加描边，改为 7% 墨色浅底、无描边（[决定](../DECISIONS.md) 2026-11-14） |
| `Button` `ghost` / `quiet` | `SolidButtonStyle(kind: .quiet)`（新增）；行内用 `HoverRowStyle` | 弹窗的取消按钮现在用 `.secondary` |
| `Button` `danger` | `SolidButtonStyle(kind: .danger)` | 是红色实心白字，改为红色浅底红字 |
| 图标按钮 | `IconButtonStyle` | 默认 26，改为 28 |
| 胶囊 | `ChipButtonStyle`、`ChipLabel` | |
| `Input` / `Textarea` | `.formField()` 的 `TextField`、`TextEditor` | |
| `Switch` | `Toggle` 加 `.switch` | |
| `Segmented` | `SegmentedTrack` | 高度不足 32 |
| `Select` | `ChoiceMenu` | 缺标题外观 |
| `DropdownMenu` | `popUpStyled` / `DrawnMenu` | 见 §4.3 |
| `Popover` | `StylePopover` | |
| `Dialog` | `SheetScaffold` | 新增 |
| `confirmDialog` | `.confirmationDialog` | |
| `Tip` | `.help` | |
| `toast` | `Toast` | 新增 |
| `Notice` | `NoticeBar` | |
| `Spinner` | `Spinner` | |
| `PageScaffold` | `PageScaffold` | 新增 |
| `SettingsGroup` / `SettingsRow` | `.riffetForm()`、`SettingsRow` | |

新组件按 [架构](architecture.md)「改动的顺序」：先写规范，再实现，再迁移调用点，最后删掉旧写法。

## 7. 键盘、窗口与无障碍

- 快捷键：⌘, 打开设置；⌘K 打开搜索；⌘W 关闭标签或窗口。Esc 关闭最上层的浮层，焦点回到打开它的控件。Return 触发默认按钮。
- 菜单栏：工具栏和 ⋯ 菜单里的每个命令在菜单栏都有对应项，快捷键写在菜单项上，定义在 `Features/Workbench/WorkbenchView.swift` 的 `RiffetCommands`。
- 窗口失焦时，侧栏选中态退到悬停色，状态胶囊褪色，呼吸标记停住（[macOS 原生](../macos-native.md) §2.1）。
- 只有图标的按钮必须有 `accessibilityLabel`；装饰性的图形加 `accessibilityHidden`。
- 系统「减弱动态效果」开启时，循环动画停下，位移和缩放换成淡入淡出。

**现状**：`accessibilityLabel` 107 处，而 `Image(icon:)` 有 357 处，只有图标的按钮缺多少名称还没有逐个核对。

## 8. 设计规范页

Mac 的规范分两处看，内容不重复：

- **Web 设计规范页的 macOS 部分**（`/design?platform=macos`，代码在 `apps/web/src/app/design/mac/`）讲规范：平台分工、各风格的数值与配方、文字角色、组件对照、窗口与页面、浮层。数值和配方直接读 `DESKTOP_STYLES`，每种风格一节，并按它的配方用网页画一个窗口缩样。
- **Mac 原生的设计规范页**用来验收组件。它是一个 SwiftUI 窗口，入口在设置的「外观」组：
  - 只放组件和它们的状态（默认、悬停、按下、选中、禁用、加载），每个组件旁标出读到的字号、圆角、高度；
  - 顶部三个切换：风格、明暗、字号缩放；
  - 原则和基础不画，链接到文档；
  - 随第 9 节的迁移逐节加入：每迁完一种组件，加一节。

新增一种风格：在 `packages/contracts/src/interface-styles.ts` 加一条，运行 `pnpm gen:styles`，Web 页面会自动出现它的数值、配方和缩样。再在 `apps/web/src/app/design/mac/notes.ts` 的 `useStyleNote` 里补上名称、一句说明、规则文档和规则要点；没有补的风格显示 id 和数值。新增配方取值时，在同一个文件的 `useFamilyNotes` 里补上取值的名称，并在 `StyleMiniature.tsx` 里画出它；没有画的取值按同类里最朴素的画法显示。

## 9. 落地顺序

按影响面从大到小排。每一步完成后，运行 `node scripts/check-design-rules.mjs --update` 降低基线，再删掉本文对应的「现状」条目。

1. **字号与字重**：在 `RiffetFont` 补上缺的角色；按文件把 `.riffet(size:)` 换成角色，同时收掉半档字号和 `.semibold`。先改调用最多的文件：`ConversationView`、`PublishSection`、`ExtensionsCatalog`、`ExtensionsSettingsComponents`、`FilesPanel`。
2. **按钮**：调整 `SolidButtonStyle` 的 `secondary` 和 `danger` 画法，新增 `.quiet`；`IconButtonStyle` 默认改为 28。
3. **弹窗**：先在 `design-tokens.ts` 补上 20 的间距档；再建 `SheetScaffold`，迁移 41 处 sheet，宽度归入四档，统一键盘操作。
4. **页面**：建 `PageScaffold`，迁移 §3.2 表里的六个页面。
5. **菜单**：工作台里的 SwiftUI `Menu` 改走 `popUpStyled`，设置窗口里的保持系统控件。
6. **通知**：建 `Toast`，替换 `ShareSheet` 和输入框里的单独写法。
7. **设计规范页**：Mac 原生页随第 1–6 步逐节加入（§8）。
8. **尺寸归入配方**：右侧面板与终端的宽高归入配方 `layout`，Web 改读配方。
