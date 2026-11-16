# iOS

本文把[基础](foundations.md)、[模式](patterns.md)、[移动端页面](mobile.md)和组件落到 iPhone 与 iPad：每条语义在 iOS 上用哪个系统控件或 `Design/` 里的组件、取什么值、哪里跟平台而与 Android 不同。数值与 Android 的 ios 风格同源（`packages/contracts/src/mobile-styles.ts`，iOS 自己的差异在 `IOS_NATIVE_OVERRIDES`）；页面怎么组织见 [移动端页面](mobile.md)，本文不重复。架构、协议与验收记录见 [iPhone 原生方案](../../IOS.md)。

每节末尾的「现状」是 2026-11-15 盘点时与规则不符的实现，迁移后删掉对应条目；页面、浮层与场景的现状记在 [移动端页面](mobile.md) §7.4。路径相对 `apps/mobile/iosApp/Riffet/`。

## 1. 分工

行为跟 [HIG](https://developer.apple.com/design/human-interface-guidelines/) 与系统控件，外观跟 Riffet 的颜色角色和 ios 风格的取值。

| 跟平台 | 跟共用的规范 |
|---|---|
| `TabView`、`NavigationStack`、边缘右滑返回、sheet 下拉关闭 | 颜色角色、文字角色、动效档位 |
| 系统控件：`Toggle`、`Picker`、`Menu`、`Slider`、`DatePicker`、`.searchable`、`.refreshable`、`.alert`、`.confirmationDialog`、`ContentUnavailableView` | 页面类型、行、顶栏、反馈（[移动端页面](mobile.md)） |
| 导航与控制层的 Liquid Glass（iOS 26），iOS 18 回退到系统材质 | 组件的种类、状态与无障碍名称 |
| 列表行的左右滑动操作、长按的 `contextMenu` | 选择控件的选用（[模式](patterns.md) §3，本文 §5） |
| 点击区至少 44pt | 确认、撤销、空状态的时机与文案（[文案](content.md)） |
| Dynamic Type、VoiceOver、减弱动态效果、降低透明度、增强对比度、系统触感开关 | |
| 硬件键盘、拖放、分享、文件与照片选择、相机与通知权限 | |

- **系统控件优先。** 系统有的（开关、菜单、分段、搜索、下拉刷新、弹窗、空状态、分享）直接用，颜色和字体由 `Design/` 统一设置；系统没有的（胶囊、提示条、短暂反馈、页签、头像、发送按钮）在 `Design/` 里画一份，业务代码不再画第二份。
- **只有一种外观。** iOS 不读 Android 的五种界面风格；Android 的 `IosPreset` 与本文同源，同一页面两端一起改。
- **材质只给浮在内容上的东西**（§2.3）。系统导航栏、Tab 栏不设自定义背景，否则盖掉 Liquid Glass 和软滚动边缘。

## 2. 基础的 iOS 写法

| 类别 | API | 规则 |
|---|---|---|
| 颜色 | `@Environment(\.palette)`（`Theme/Theme.swift`；角色由 `pnpm gen:theme` 生成到 `Theme/RiffetTheme.swift`） | 业务代码不写 `.red`、`.orange`、`.green`、`.blue`、`.secondary`、`.primary`、`Color.accentColor`、系统语义色。错误 `danger`，注意 `warning`，成功 `success`，次要文字 `fg2` / `fg3`，强调 `accent`，diff `diffAdd` / `diffDel`，图表 `chart1`–`chart8`。例外：二维码的白底、相机的黑底、应用图标的品牌色 |
| 表面 | `palette.bg`（页面）、`bgSubtle`（分组卡片）、`groupedRow`、`selected`、`press` | 列表与表单的底色由 `RiffetList` / `RiffetForm` 设好，页面不再单独设 `listRowBackground` |
| 文字 | `.riffetFont(_:)`（§2.1） | 业务代码不写 `.font(.caption)` 这类系统文字样式，也不写 `.font(.system(size:))`；系统控件（导航栏、Tab 栏、菜单、弹窗、`Picker`）的文字由系统画 |
| 尺寸、间距、圆角 | `RiffetMetrics`（§2.2） | `check:design` 按文件记 iPhone 的数字内边距、圆角、字号，只降不升 |
| 材质与阴影 | `riffetGlass(in:)`、`riffetComposerSurface()`、`RiffetBarScrim`、`riffetSoftEdges()` | §2.3；阴影只来自生成的 `floatingShadow*`，`check:design` 拦截手写阴影 |
| 动效 | `RiffetMotion` 的 `spatial`、`effects`、`release`、`chevron`（弹簧由 Compose 的刚度换算，[基础](foundations.md) §7.2） | 不写 `.easeInOut(duration:)` 之类的数值曲线；减弱动效见 §7 |
| 按压 | `RiffetRowPressStyle`（自绘的行）、`RiffetDimPressStyle`（图标按钮、胶囊） | 系统 `List` 的行用系统高亮 |
| 图标 | SF Symbols；尺寸跟所在文字的角色，装饰性图标 `accessibilityHidden(true)`；Agent 用 `AgentMarkView` | 颜色跟随所在行的文字；实心只表示状态（[决定](../DECISIONS.md) 2026-11-12） |

### 2.0 主线程的栈

SwiftUI 在主线程上解析页面的视图类型、计算 body。iOS 的主线程栈只有 1 MB。2026-11-15 在 iOS 27 测试版的真机上，有三条原因各自把它用完，表现都是打开页面即崩：

- **类型太深**：页面第一次显示时，运行时递归解析整棵视图类型，每层泛型（`ModifiedContent`、`VStack<TupleView<…>>`、`some View` 的底层类型）压一次栈。
- **视图值太大**：Debug 包里 body 的每个中间值都占一份栈。视图存着大的值类型时，一个函数的栈帧能到几百 KB。当时 `Palette` 内联了整套主题的取值（约 7 KB），146 个视图各存一份，会话详情的一个函数用了 394 KB。
- **在 `viewWillAppear` 里同步布局**：`setTabBarHidden` 当场让 SwiftUI 渲染还没拿到环境的新页面，读 `@Environment(AppModel.self)` 时直接陷入断言。

规则：

- 设计层里用得多的修饰符返回具体类型（`ModifiedContent<Self, …>`），不返回 `some View`。
- `RiffetList`、`RiffetForm` 把内容放在类型边界后面。页面里其他的大块内容（输入框卡片、十几项的菜单、一整块工具区）用 `riffetTypeBoundary()` 断开。列表的行不用，那里会影响比较和刷新。
- 视图和环境里只存小的值。几 KB 的数据（主题取值、大的配置）放进引用类型，`Palette` 只有一个指针宽。
- UIKit 的出现回调（`viewWillAppear` 等）和 SwiftUI 的更新里，不调会当场布局的 UIKit 方法。随转场的改动用 `animate(alongsideTransition:)`，其余推到下一轮 run loop（见 `TabBarVisibility`）。
- 主线程的栈在链接时设为 8 MB（`project.yml` 的 `-stack_size`），和 macOS、模拟器一致。这只是余量：上面几条修完后，用 1 MB 的栈在真机上逐页打开过一遍，没有崩溃。

改了页面结构或设计层后，用 Debug 构建跑 `python3 apps/mobile/iosApp/scripts/stack-report.py <Riffet.app/Riffet>`，脚本列出最大的栈帧和最深的类型，超出限度（视图函数 64 KB，类型 26 层）时退出码为 1。2026-11-16 的结果：视图函数的栈帧最大 20 KB，类型最深 22 层。

**现状**（2026-11-15 迁移后）：

- 时间线的工具行、过程组、思考和活动行（`Features/Conversation/ConversationTool.swift`、`ConversationTimeline.swift`、`ConversationActivity.swift`、`ConversationRenderPlan.swift`、`ConversationComposer.swift`）还有 19 处 `.font(.system(size:))`：12 号的行图标、10 号的展开箭头、20 号的加号没有对应的文字角色，这些行的高度又被布局记忆依赖，等时间线的展开头（§6）一起收。

### 2.1 文字角色

角色在 `Design/RiffetDesign.swift` 的 `RiffetText`，字号与字重由 `pnpm gen:tokens` 从 ios 风格生成，经 `@ScaledMetric` 随 Dynamic Type 缩放。

| [基础](foundations.md) §2 的角色 | `RiffetText` | 取值 | 跟随的系统文字样式 |
|---|---|---|---|
| 正文 | `body` | 16，400 | `.body` |
| 正文 · 强调（行标题） | `headline` | 16，500 | `.body` |
| 界面（胶囊、分段、按钮、分组标题、工具行） | `label` | 15，500 | `.subheadline` |
| 次要 | `caption` | 13，400 | `.footnote` |
| 标题 · 导航栏 | `barTitle` | 17，600 | `.headline` |
| 代码 | `mono` | 14 | `.body` |
| 代码 · 小（工具行的命令与路径） | `monoSmall` | 13 | `.footnote` |

- 导航栏标题、弹窗标题、菜单、工具栏按钮由系统画，不另设字体。自己画的标题（会话页顶栏中间的标题按钮、面板头部）用 `barTitle`，与系统导航栏同为 600（`IOS_NATIVE_OVERRIDES.barTitleWeight`）。
- 所有页面用 inline 标题，不用大标题。
- 会变化的数字用 `.monospacedDigit()`。
- iPhone 没有自己的「文字大小」设置，跟系统 Dynamic Type。辅助功能字号（`dynamicTypeSize.isAccessibilitySize`）下：一行放不下的胶囊和分段改成菜单，行标题可以折行，装文字的容器不写死高度。
- 终端是字形网格，字号固定，不跟 Dynamic Type。

### 2.2 尺寸

| [基础](foundations.md) §4 | iOS | 字段 |
|---|---|---|
| 点击区 44 | 图形小于 44 时外面套一层 `frame(minWidth:minHeight:)` | `hitTarget` |
| 设置行 52 | `RiffetForm` / `RiffetList` 的 `defaultMinListRowHeight`；行不自己写高度，随 Dynamic Type 长高 | `settingsRowHeight`（生成） |
| 行图标方块 30，圆角 8 | `SettingsIcon`，随 Dynamic Type 放大 | `iconSlot`、`iconTileRadius`（生成） |
| 会话行 68，头像 44 | 任务列表 | `rowMinHeight`、`avatar` |
| 胶囊可见 34，点击区 44 | `RiffetChipBar`、`RiffetMenuChip` | `chipHeight` |
| 发送按钮可见 36，点击区 44 | `RiffetSendButton` | `sendButton`（生成） |
| 分组圆角 16，输入框圆角 24 | 比 ios 风格（12、14）圆：Liquid Glass 的形状与屏幕圆角同心 | `groupRadius`、`composerRadius`（生成，`IOS_NATIVE_OVERRIDES`） |
| 阅读列 760 | 宽窗口里会话正文和输入框限宽居中 | `readingWidth` |
| 代码块最高 448，工具的命令与输出最高 288 | 块内上下左右滚动，长行不折行；同时不超过可见高度的 65%（[移动端页面](mobile.md) §9.1）。文件页的代码不限高，随页面滚动，只横向滚动 | `codeBlockMaxHeight`、`codeOutputMaxHeight` |
| 导航栏、Tab 栏、分段控件、开关、滑块 | 系统尺寸，不改 | — |

- 时间线里连续的工具行、过程组、思考是例外：可见行高 36，行间距 0，与 Android 相同；整行可点。
- `groupInset`、`controlRadius`、`rowRadius`、`selectionRadius`、`menuRadius`、`iconSlot`、`iconTileRadius` 由 ios 风格生成（`pnpm gen:tokens`）；`chipInset`、`floatingGap` 是 iOS 自有的。缺的档位不在调用处写数字：ios 风格有的加进 `gen-design-tokens.ts` 生成，没有的补进 `mobile-styles.ts` 或写成 iOS 自有字段。

**现状**：

- `check:design` 记下的 iPhone 存量（2026-11-15 迁移后）：内边距 29 个文件 134 处，圆角 15 个文件 33 处，字号 6 个文件 20 处。
- 卡片圆角仍有几种写死的值：新会话页的工具卡、配对二维码、主题与界面风格的预览、会话页里的代码块与表格。

### 2.3 材质

| 层 | 写法 |
|---|---|
| 导航栏、Tab 栏、工具栏按钮 | 系统（iOS 26 自带 Liquid Glass），不设背景 |
| 顶层滚动页（会话、任务、设置）的顶边 | `RiffetBarScrim` 加 `riffetSoftEdges()` |
| 浮在内容上的控件：会话页输入框、回到最新、查找条 | `riffetGlass(in:)`；会话页输入框是 `riffetComposerSurface()`，框内磨砂加玻璃（[决定](../DECISIONS.md) 2026-11-11、2026-11-14） |
| 新会话页的输入框 | 实底卡片（`bgSubtle`），后面没有滚动的内容（[移动端页面](mobile.md) §1.1） |
| 短暂反馈（`RiffetToastCenter`） | `toast` 实底胶囊，与 Web 相同：玻璃上的一句话在花哨的背景上读不清 |
| 内容：消息、代码块、卡片、列表行 | 实底，不加玻璃 |

- 不画仿 Liquid Glass。iOS 18 回退到 `regularMaterial` 加生成的悬浮阴影（`riffetFloatingShadow()`，唯一的投影）。
- 降低透明度时系统材质自己变实；自绘的遮罩同样用系统材质，不用手调的半透明色。

## 3. 页面与导航

二级页面、浮层和面板的内容怎么组织，见 [移动端页面](mobile.md)；本节只讲 iOS 的导航结构和页面骨架。

### 3.1 结构

| 区域 | iOS | 来源 |
|---|---|---|
| Tab 栏 | 新会话、助理、任务、设置四个目的地，只有图标，启动时停在「设置 → 通用 → 启动时打开」选的一项（默认助理，仅存本机），待处理数是任务上的系统 `.badge`；助理页是会话页，没有主对话时是新会话页的输入框加 记忆 / 规则 / 能力 三张卡片；每个 Tab 一个 `NavigationStack(path:)` | `Features/Home/HomeView.swift` 的 `RiffetRootView` |
| 页面栈 | 会话、子 Agent、Git、文件、终端、设置的下一级都压栈打开；压栈后 Tab 栏收起，宽窗口不收 | `navigationDestination` |
| 宽窗口 | 水平与垂直都是 regular 时，任务 Tab 改为列表在左（宽 32%，限 320–420pt）、会话在右，与单栏共用一个 path，折叠、展开或调整窗口时会话不重新挂载 | `HomeView.swift` |
| 会话详情 | 点会话页标题打开的 sheet（`.medium` / `.large`），对应 Android 的右侧栏，内容按 [移动端页面](mobile.md) §2.7 | `Features/Conversation/ConversationView.swift` 的 `ConversationInformation` |
| 侧栏 | 没有。Android 左侧栏里的内容在 iPhone 上各有归处：服务器和统计在设置，收藏的文件夹在目录选择和文件页 | — |

- 返回：系统返回按钮与边缘右滑，不隐藏返回按钮。会被未保存改动拦住的编辑页是 sheet，不在压栈页里拦返回（§3.2）。
- 滑动：列表行的 `swipeActions` 是 iOS 的约定，可以用（Android 不用）。每个滑动操作在长按菜单或详情页里也有，滑动只是捷径；危险操作 `allowsFullSwipe: false`，能撤销的除外。
- 转场用系统的压栈和 sheet，不自定义。

### 3.2 页面骨架

[移动端页面](mobile.md) §2 的页面类型在 iOS 上的写法：

| 页面类型 | 容器 | 顶栏 |
|---|---|---|
| 目录页 | `RiffetList`。范围条和筛选条是列表的第一行（`SettingsChipRow` 里放 `RiffetMenuChip`、`RiffetChipBar`），不进卡片 | `.riffetSearchable`（默认收起，下拉露出；只写 `.navigationBarDrawer(displayMode: .automatic)` 时，第一次布局后是收是开不一定）；`.primaryAction` 放添加（`+`，几种添加方式时是 `Menu`）；低频工具收进 ⋯ `Menu`；`.refreshable` |
| 详情页 | `RiffetForm`。头部是第一个 Section，`listRowBackground(.clear)`：图标、名称、类型 · 范围 | 进行中时顶栏放 `ProgressView()`，页面禁用 |
| 编辑页、新建页 | `RiffetEditPage`（`Design/RiffetPages.swift`）放在 sheet 里：自带 `NavigationStack`、`RiffetForm`、两侧按钮和未保存保护；字段用 `RiffetField`（§6） | `.cancellationAction` 是「取消」，`.confirmationAction` 是保存的动词（「保存」「创建」「安装」），没有改动时不可用；保存中按钮换成转圈，宽度不变 |
| 设置分类页 | `RiffetForm`，行只有四种（§3.3） | — |
| 选择面板 | `RiffetPickerSheet`：sheet，`.medium` / `.large`，当前值行尾 `accent` 勾，选了就关，超过 8 项加搜索；设置里打开它的行是 `RiffetPickerRow`，范围条里是 `RiffetChipButton` | 不放「完成」 |
| 弹窗 | `.confirmationDialog` 或 `.alert`（§4.2） | — |
| 面板 | 会话详情的 sheet（§3.1）：`RiffetPaneActionBar`（二到四格，图标在上、一个词在下）、`RiffetSectionTitle(_:figure:)`（标题右侧写数量）、`RiffetValueRow`（事实，等宽的截断开头，长按复制） | 中间是 `RiffetBarTitle(title:status:)`，标题下一行状态 |

- **一页一个滚动区。** `List` 里不再套纵向 `ScrollView`。
- **一种页面一种容器。** `RiffetForm` 给有字段、开关、选择的页面，`RiffetList` 给对象目录；两者底色、行高相同。不用裸 `Form`、`List`。
- **未保存保护**：编辑页有改动时 `.interactiveDismissDisabled(true)`；点取消先弹 `.confirmationDialog`「放弃未保存的修改？」，答案只有「放弃」（destructive）和「继续编辑」。下拉关闭被拦下时同样弹这个确认：SwiftUI 没有对应的 API，由 `Design/` 里的修饰符经 UIKit 的 `presentationControllerDidAttemptToDismiss` 实现，各页不自己写。
- **左上角是「取消」。** 「完成」只给没有取消语义的 sheet（只读的、改动即时生效的，如任务选项）。
- 只有一个字段的编辑页，键盘的完成键（`.submitLabel(.done)`）同样保存；不靠失焦保存。

**现状**：Git 的四个视图、文件、项目选择、导入终端会话、工具选择仍用裸 `List` / `Form`（颜色和文字已换成角色），没有用 `RiffetList` / `RiffetForm`。任务列表和转录是连续的内容列表，不算在内。

### 3.3 设置

- 首页的分类与 Android 相同，不重新分组（[决定](../DECISIONS.md) 2026-11-12）。
- 行只有四种（[移动端页面](mobile.md) §2.4）：

| 行 | iOS |
|---|---|
| 导航行 | `NavigationLink(value:)` 加 `SettingsRowLabel(title:symbol:value:)`，箭头由系统画，不手画 `chevron.right` |
| 开关行 | `Toggle` |
| 选择行 | 2–4 个就近的选项用 `Picker` 的 `.menu` 样式，行尾是当前值；5 个以上是导航行，打开选择面板 |
| 操作行 | `RiffetActionRow`，标题是 `accent` 色的动词，进行中行尾转圈；删除类 `destructive: true`，单独一个 Section 放在最底下 |

- 详情页和面板里的只读事实用 `LabeledContent`：标签在左，值在右（`fg3`）；路径、分支用等宽并截断开头，长按可复制。
- 分组标题是 `label`、`fg3`、不转大写（`RiffetSectionHeader` 的字样）；页面只有一组同类内容时 Section 不写标题。说明写在 Section 的 footer，只写推断不出的。
- 行图标用 `SettingsIcon`（30pt 方块、`fg2` 符号），同一组要么都有要么都没有。


## 4. 浮层

### 4.1 选哪一种

| 需要（[模式](patterns.md) §2.1） | iOS |
|---|---|
| 只有图标的按钮的名称 | `Button(_:systemImage:)` 配 `.labelStyle(.iconOnly)`，或 `accessibilityLabel`；不画提示气泡 |
| 对一项内容执行操作 | 长按 `contextMenu`，或 ⋯ `Menu` |
| 在一组值里选一个 | 选择面板；2–4 个且就在触发处时用 `Menu` / `Picker(.menu)` |
| 集中处理、有提交和取消的任务 | 编辑页（§3.2） |
| 确认一次操作 | `.confirmationDialog`；要一两个字段，或不是由某个按钮直接引起时用 `.alert`（§4.2） |
| 报告一次操作的结果 | `RiffetToastCenter`（§4.4） |
| 一个持续存在的状态 | `RiffetNotice`（§4.4） |
| 列表或页面没有内容 | `ContentUnavailableView`（§4.4） |
| 分享、预览文件、选照片和文件 | 系统的分享面板（`Platform/FilePresentation.swift` 的 `NativeShareSheet`）、QuickLook、`PhotosPicker`、`fileImporter` |

### 4.2 弹窗

- **确认用 `.confirmationDialog`**（iPhone 上从底部升起，iPad 上指向触发的控件）：`titleVisibility: .visible`；标题写动作和对象（「删除会话「x」？」「结束进程 1234？」）；`message` 只写推断不出的后果（不可恢复、连带删除什么）；确认按钮就是那个动词，危险时 `role: .destructive`；取消由系统加。
- **`.alert`** 用于要一两个字段（重命名、新分支名），或与当前操作无直接关系的打断（继续发送排队的消息）。标题同样写动作和对象，确认按钮写动词，取消 `role: .cancel`。
- **不用弹窗报告错误。** 只有一个「好」的错误弹窗，改为 `RiffetToastCenter`（操作失败）或就地的 `RiffetNotice`（加载失败、持续的状态）。
- 超过两个字段、需要滚动或有分组的内容，用编辑页。
- 拒绝一次审批不删除任何东西，不用 `.destructive`（[iPhone 原生方案](../../IOS.md) §3「审批」）。


### 4.3 菜单与 sheet

- 菜单只用系统 `Menu`。当前值用 `Picker` 放进 `Menu`，由系统画勾；危险项 `role: .destructive`，放在最后，前面用 `Divider` 隔开。胶囊打开的菜单用 `RiffetMenuChip`。
- sheet：选择面板 `.medium` / `.large`，编辑页 `.large`；辅助功能字号下只给 `.large`。sheet 需要标题栏就套 `NavigationStack`，不手画标题行。
- 同一时刻只开一个 sheet；sheet 上最多再叠一层（编辑页上的选择面板）。


### 4.4 反馈

iOS 没有系统的 Snackbar 和提示条，这两个在 `Design/` 里画；空状态、加载、骨架用系统的。

- **短暂反馈**（`RiffetToastCenter.shared.show(_:kind:actionTitle:action:)`，`Design/RiffetFeedback.swift`）：报告一次操作的结果。一句话，`toast` 底色的胶囊、白字，成功和失败的图标分别是 `toastSuccess`、`toastDanger`；从底部升起，停在 Tab 栏上方，会话页里停在输入框上方（页面用 `riffetToastClearance(_:)` 报告输入框高度）；整个应用一个队列，每个 Tab 的栈挂一个 `riffetToastHost()`；4 秒，带一个操作（「撤销」「重试」）时 6 秒，点一下即收起；出现时发 VoiceOver 公告。操作失败用 `.error(_:)`。
- **`RiffetNotice`**（`Design/RiffetFeedback.swift`）：页面或对象上的一件事（[移动端页面](mobile.md) §5）：种类图标（信息、成功、警告、错误；图标着色，文字仍是 `fg`）、可选标题、一句话、最多一个操作。列表里是独立的一个 Section（`RiffetNotice.section(_:_:)`），其他地方 `boxed: true` 自带卡片；一页同时最多一条，取最严重的。
- **空状态**：`ContentUnavailableView`，图标 `fg3`，标题一句话，下一步放在 `actions` 里。搜索无结果用系统的 `ContentUnavailableView.search(text:)`，它自带放大镜和固定文案，iOS 上以系统为准（与 [移动端页面](mobile.md) §5「不放图标」不同）。
- **加载**：整页是居中的 `ProgressView()`，不带文字；一行、一个值在原处用 `.controlSize(.small)`；操作进行中放在顶栏。
- **骨架**：用真实的行结构配占位内容，加 `.redacted(reason: .placeholder)`，尺寸与真实内容一致；明暗变化在减弱动效时停下。
- **下拉刷新**：目录页都有 `.refreshable`，离线时立即结束。
- 「已恢复」是 `RiffetNotice` 的成功种类，短暂显示后消失。

**现状**：

- 统计页各节没有数据时仍是一行小字（`Features/Management/NativeStatsView.swift`），没有用 `ContentUnavailableView`：一节一个空状态太重。
- 任务选项保存中的「正在保存配置…」带文字（`Features/Home/TaskOptions.swift`）。
- 没有骨架。

## 5. 选择控件

选用规则与 [模式](patterns.md) §3 相同，iOS 的对应如下：

| Web | iOS | 规则 |
|---|---|---|
| `Segmented` | `Picker` 加 `.pickerStyle(.segmented)` | 二到三个短选项：一个值（浅色、深色、跟随系统）、一个筛选（当前分支 / 全部），或两个视图（预览 / 源码，[移动端页面](mobile.md) §9.3） |
| `UnderlineTabs` | `RiffetViewTabs` | 四个以上的视图，或标签放不下（Git 的变更、历史、检查点、工作树）：顶栏下一行可横滚的文字页签，选中是 `fg` 加滑动的指示条，其余 `fg2`，标签永远完整 |
| `Select` | 选择面板；2–4 个就近的选项用 `Picker(.menu)` / `Menu` | 当前值行尾 `accent` 勾 |
| `Switch` | `Toggle`，`tint` 为 `accent` | |
| `RadioGroup` | 行尾的勾（`SettingsCheckRow`） | 不画单选圆点 |
| `Checkbox` | 多选列表：行首的 `checkmark.circle.fill` / `circle`，与系统编辑模式的多选一致；表单里的单个布尔值用 `Toggle` | iOS 没有方框勾选，不画 |
| `Slider` | `Slider` | |
| 胶囊 | `RiffetChipBar`（筛选）、`RiffetMenuChip`（打开菜单）、`RiffetChipButton`（打开选择面板）、`RiffetToggleChip`（开关） | 同高、同圆角、同字号（[移动端页面](mobile.md) §1.1） |
| 日期 | `DatePicker`，`.compact` | |

- 改动即时生效的选择不配保存按钮；属于表单的随表单保存。
- 选中只用一种标记：列表里只打勾、不填充；胶囊和分段只填充、不加勾；缩略图卡片（主题、应用图标）用 `accent` 描边。

**现状**：

- 自画的胶囊：附件与待发送胶囊（`NewTaskView.swift`、`ConversationComposer.swift`，带移除按钮，设计层没有对应的部件）、文件与会话引用胶囊（`ConversationTimeline.swift`）、Git 引用胶囊（`ProjectHistoryView.swift`）。

## 6. 组件对照

| Web（`components/ui/`） | Android（`ui/design/` 等） | iOS（`Design/` 或系统） | 现状 |
|---|---|---|---|
| `Button` `primary` / `secondary` / `danger` | `RiffetButton` | `.borderedProminent`（一屏最多一个）、`.bordered`、`role: .destructive`；列表里用操作行，不放按钮 |  |
| `Button` `ghost` / `quiet` / `link` | `RiffetTextButton`、`RiffetInlineAction` | `.borderless` 文字按钮，`accent` | |
| 图标按钮 | `RiffetIconButton` | `Button(_:systemImage:)` 加 `.labelStyle(.iconOnly)`、`RiffetDimPressStyle`，点击区 44 | |
| 胶囊 | `ChipRow`、`ChipButton`、`ToggleChip` | `RiffetChipBar`、`RiffetMenuChip`、`RiffetToggleChip`（`Design/RiffetControls.swift`） | 见 §5 |
| `Input` / `Textarea` / `Field` | `RiffetTextField`、`GroupField` | `TextField`、`TextEditor`；表单里用 `RiffetField`（`Design/RiffetGroups.swift`）：分组卡片里一行，不画边框；几个字段时标签在字段内、文字上方（`caption`、`fg3`），只有一个字段时不写标签；占位符 `fg3`；路径、命令用 `mono: true` |  |
| `SearchField` | `RiffetSearchField` | 页面里 `.riffetSearchable`；选择面板里 `.searchable(placement: .navigationBarDrawer(displayMode: .always))` | |
| `Switch` · `Checkbox` · `Slider` · `Segmented` | 见 Android §5 | 见 §5 | |
| `ListRow` · `SettingsGroup` / `SettingsRow` | `GroupRow` · `Group` | `RiffetList` / `RiffetForm` 的行：`SettingsRowLabel`、`SettingsCheckRow`、`LabeledContent` |  |
| `CopyButton` | `CopyTextButton` | `RiffetCopyButton`（`Design/RiffetFeedback.swift`）：复制后图标换成勾，`sensoryFeedback(.success)`；并排的两个用 `symbol` 区分 | 在终端恢复的命令行另有一个：复制前要先让 Riffet 交出会话，`RiffetCopyButton` 没有复制前的钩子 |
| `Skeleton` | `SkeletonBlock`、`SkeletonRows` | `.redacted(reason: .placeholder)` | 没有用 |
| `Spinner` · `Progress` | `RiffetProgressIndicator` | `ProgressView` | 带文字的整页转圈见 §4.4 |
| `Tip` | 无 | 无，用无障碍名称 | |
| `toast` | `RiffetSnackbar` | `RiffetToastCenter`（`Design/RiffetFeedback.swift`） |  |
| `Notice` | `Notice` | `RiffetNotice`（`Design/RiffetFeedback.swift`） | 见 §4.4 |
| `EmptyState` | `EmptyState` | `ContentUnavailableView` | 只写一行字的空状态见 §4.4；宽窗口右栏没有选中会话时只画品牌标志（`Features/Home/TaskDetailPlaceholder.swift`），不算空状态 |
| `Dialog` · `confirmDialog` · `promptDialog` | `ConfirmDialog`、`AlertDialog` | `.confirmationDialog`、`.alert`（§4.2） | |
| `UnderlineTabs` | `ViewTabs` | `RiffetViewTabs`（`Design/RiffetControls.swift`） |  |
| `RadioGroup` | `OptionRow`、`SelectionMark` | 行尾勾 |  |
| `Avatar` | `OwnerAvatar`、`AgentAvatar` | `OwnerAvatarView`、`AgentAvatar` | `OwnerAvatarView` 在 `Platform/OwnerAvatar.swift`，移进 `Design/` |
| `Badge` | 不用 | 不用；Tab 栏的待处理数用系统 `.badge` | |
| `Collapse` | 无 | 表单里的「高级」用 `DisclosureGroup`；时间线的可展开行共用一个展开头（待建） | 6 份几乎一样的「图标、文字、旋转箭头」：`ConversationTool.swift`、`ConversationRenderPlan.swift`、`ConversationTimeline.swift` 4 处、`ConversationActivity.swift` |
| `DropdownMenu` | `RiffetDropdownMenu` | `Menu` | |
| `Popover` | 不用 | 不用 | |
| `StatusDot` · `StatusPill` | `StatusDot` | `RiffetStatusDot`（`Design/RiffetFeedback.swift`）；会话的运行状态画在 `AgentAvatar` 上 |  |
| 代码块 · diff（[界面](surfaces.md) §1.5） | `timeline/DiffBlock.kt`、`timeline/TimelinePrimitives.kt` | `ConversationCode`、`ConversationToolDiff` | Inspector 另有 `UnifiedDiffView`、`PatchDiffView` 两套 diff（颜色已用 diff 角色） |
| Git 状态字母 | `git/GitPanel.kt` | `GitFileLabel`（`Features/Inspector/ProjectHistoryView.swift`），`monoSmall`、固定宽度，颜色是 `diffAddMarker`、`diffDelMarker`、`accent`、`warning` |  |
| 分隔线 | `hairline` | 系统 `List` 的分隔线；自绘处用 `Divider()` | |
| `PageScaffold` | `RiffetPageScaffold` | `RiffetList` / `RiffetForm` 加导航栏（§3.2） | |
| `Kbd` | 无 | 无 | |

新组件按 [架构](architecture.md)「改动的顺序」：先写规范，再实现，再迁移调用点，最后删掉旧写法。

## 7. 手势、触感、键盘与无障碍

- **长按**：会话行、消息（用户消息和回答）、文件、Git 条目、收藏、设备长按打开 `contextMenu`，菜单里是这一行的全部操作，危险操作在最后；单击总是打开。
- **排序**：顶栏「编辑」（`EditButton`）进入编辑模式，`.onMove` 拖动，完成后退出；不用「上移 / 下移」。
- **触感**：只用 `.sensoryFeedback`，跟系统的触感开关，应用里不另设开关（Android 默认关闭并在设置里打开）。用于发送、审批的允许与拒绝、操作成功或失败、复制、越过手势阈值；普通点击不加。
- **减弱动效**：读 `accessibilityReduceMotion`。滑动的选中块（`matchedGeometryEffect`）、弹簧位移、展开箭头的旋转改为淡入淡出或直接切换；循环动画（运行中的弧、骨架的明暗）停下，并按 `check:design` 的要求写 `motion-loop` 注释。在 `Design/` 里给一个按减弱动效换动画的辅助，业务代码不逐处判断。
- **Dynamic Type**：§2.1。自绘图形的尺寸用 `@ScaledMetric`。
- **VoiceOver**：只有图标的按钮必须有名称；装饰图标隐藏；一行合成一句（`accessibilityElement(children: .combine)`），状态写在 `accessibilityValue`，当前值加 `.isSelected`；长按菜单里的操作同时给 `accessibilityAction`。`AgentAvatar` 自己隐藏，状态由所在行说出。
- **硬件键盘**：⌘N 新会话，⌘↩ 发送，⌘F 会话内查找；sheet 的确认按钮 `.keyboardShortcut(.defaultAction)`，危险的确认不设默认。
- **软键盘**：转录 `scrollDismissesKeyboard(.interactively)`；表单里 `.submitLabel(.next)` 依次跳到下一个字段，最后一个字段 `.done`。
- **拖放**：两个输入框接收从其他 App 拖入的文件和图片，终端接收拖入的文本。

**现状**：

- 触感只在发送、等待处理与结束、复制、终端响铃；审批的允许与拒绝、长按没有。
- 回答没有长按菜单，只有脚注的 ⋯（`ConversationTimeline.swift`）。
- `check:design` 还不检查 iPhone 的数值动画曲线、颜色字面量和系统文字样式（§9 第 4 步）。

## 8. 设计规范页

- Web 设计规范页还没有 iOS 部分。按 Android 部分（[Android](android.md) §8）的结构加 `?platform=ios`：平台分工、文字角色与 Dynamic Type 的对应、尺寸与 `IOS_NATIVE_OVERRIDES`、材质分层、组件对照、页面类型的 iOS 写法、浮层。取值读 `mobile-styles.ts` 的 ios 风格加覆盖。
- 系统控件、Liquid Glass、Dynamic Type 和 VoiceOver 以模拟器和真机为准；不加 UI 展示测试（[AGENTS.md](../../../AGENTS.md)）。

## 9. 落地顺序

按影响面从大到小排。每一步完成后删掉本文与 [移动端页面](mobile.md) §7.4 对应的「现状」条目。

1. ~~**设计层**~~（2026-11-15）：`Design/RiffetPages.swift`（`RiffetEditPage`、`RiffetPickerSheet`、`RiffetPickerRow`、`RiffetBarTitle`、`RiffetPaneActionBar`、`RiffetValueRow`）、`Design/RiffetFeedback.swift`（`RiffetNotice`、`RiffetToastCenter`、`RiffetCopyButton`、`RiffetStatusDot`）、`Design/RiffetControls.swift`（`RiffetViewTabs`、`RiffetToggleChip`、`riffetUnsavedGuard`、减弱动效的 `riffetAnimation` 与 `RiffetMotion.unlessReduced`）、`Design/RiffetGroups.swift`（`RiffetForm`、`RiffetList`、设置部件、`RiffetSectionTitle`、`RiffetField`）；`RiffetMetrics` 补生成了 7 个字段。还差时间线的展开头，`OwnerAvatarView` 仍在 `Platform/`。
2. ~~**反馈**~~（2026-11-15）：提示条、只有「好」的错误弹窗、带文字的转圈、只写一行字的空状态已换掉；编辑 sheet 统一为「取消」和 `riffetUnsavedGuard`；确认的标题写明对象。余下见 §4.4 的「现状」。
3. ~~**页面**~~（2026-11-15）：[移动端页面](mobile.md) §7.4 的 3 级与 2 级页面已按页面类型重做，余下与待在真机上核对的列在那里。
4. **颜色与文字**：系统色、系统文字样式已换成角色（2026-11-15），余下见 §2 的「现状」。还要给 `check:design` 加上 iPhone 的颜色字面量、系统文字样式和数值动画曲线，按文件记基线，只降不升。
5. **交互与无障碍**：减弱动效与 44pt 点击区已在第 2 步一并改了；还剩触感、回答的长按菜单、收藏的编辑模式排序。
6. **设计规范页**：加 iOS 部分（§8）。
