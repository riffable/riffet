# Riffet iPhone 原生方案

2026-10-16 测试维护更新：遵循 [AGENTS.md](../AGENTS.md#测试与验证)，非必要不增加测试。UI 展示与 XCUITest 目标已移除，当前只保留关键草稿耐久、配置与 origin 隔离、真实 Keychain 和 WebKit 安全隔离测试。现行命令见[正式工程 README](../apps/mobile/iosApp/README.md#自动化验证)；下文 UI 自动化结果均为历史验收记录。

日期：2026-10-15。状态：原生正式客户端已实现，工程为 `apps/mobile/iosApp/Riffet.xcodeproj`，bundle ID 为 `io.github.riffable.iphone`。版本号自 0.5.0 起与其他端统一，见[版本与发布](guide/operations.md#版本与发布)。通过共享 RiffetKit 连接现有 HTTP/SSE/WebSocket 协议，正式 App 不引用 Demo 数据。签名模拟器测试与真实 Mac / iOS 18 验收分别记录，不从 Demo 安装结果推定正式版设备验收。V1/V2 交互 Demo 保留，V2 仍可与正式 App 并存。

## 1. 决策

**iPhone 用 SwiftUI / UIKit 原生界面，业务与状态继续共享 KMP；界面的结构、密度、字号层级和组件形态与 Android 的 iOS 配方对齐。**
2026-11 起，iPhone 不再单独设计信息架构和版式：四个 Tab、会话列表行、时间线、输入栏和设置分组都以 Android（`shared/…/ui/design/ThemePresets.kt` 的 `IosPreset` 及各页面实现）为准，两端一起演进。iOS 保留的是平台层：系统 TabView / NavigationStack / sheet / Menu、返回手势、Dynamic Type、VoiceOver，以及系统材质——Android 用手绘磨砂模仿的悬浮层，在 iPhone 上直接用 Liquid Glass。设计 token 与共享组件在 `iosApp/Riffet/Design/RiffetDesign.swift`；其中的字号、尺寸、动效由 `pnpm gen:tokens` 从 `packages/contracts/src/mobile-styles.ts` 的 ios 风格生成，iPhone 自己的差异写在同一文件的 `IOS_NATIVE_OVERRIDES`。

正式客户端与第一、二版 Demo 均最低 iOS 18.0。iOS 26 上悬浮层（底栏、输入栏、回到最新、顶栏按钮）用 Liquid Glass，顶栏下用系统软滚动边缘；iOS 18 回退到系统材质。导航栏和 Tab 栏不设自定义背景，否则会盖掉这两种效果。不维护手绘的仿 Liquid Glass 控件。

Android 的 MD3 对应整套设计系统；Apple 一侧应区分三个层次：

- **规范：HIG**，定义导航、布局、控件、交互和无障碍。
- **实现：SwiftUI / UIKit**，用系统 List、TabView、NavigationStack、Form、sheet、Menu 等落实规范。
- **视觉材料：Liquid Glass**，用于导航与控制层。它不替代 HIG，也不要求给消息、代码块和列表内容全部加玻璃。

Apple 明确建议将 Liquid Glass 限于导航和控件，系统组件会采用相应外观；内容层优先保证阅读。
参见 [Materials](https://developer.apple.com/design/human-interface-guidelines/materials) 和
[Adopting Liquid Glass](https://developer.apple.com/documentation/technologyoverviews/adopting-liquid-glass)。

## 2. 从现有产品继承什么

这次参考了仓库当前代码，而非仅根据平台印象设计：

| 平台 | 现有实现 | 对 iPhone 的启发 |
| --- | --- | --- |
| macOS | `WorkbenchView.swift` 的 NavigationSplitView、原生侧栏、统一工具栏、底部终端与右检查器 | 保留原生控件与阅读优先；在手机上重新安排空间 |
| Web | `Workbench.tsx` 的自定义侧栏、圆角主区域、文件/变更检查器；窄屏改 Dialog | 保留任务对象与状态，不照搬桌面分栏或移动 Web 抽屉 |
| Android | Compose，shared 模块承载 UI 与一套可换配方的设计层，client 提供共享规则 | 共享逻辑；版式与组件形态按其 iOS 配方对齐，控件仍用 SwiftUI 实现 |

macOS 的 `RiffetTheme.swift` 从 Web CSS 生成，iOS 用同一份调色板：页面底色、卡片、分隔线、四级文字色和强调色都取主题角色（`palette.bg / bgSubtle / line / fg…fg4 / accent`），不再混用系统语义色。

产品不变：Agent、CLI、项目文件和终端运行在 Mac，iPhone 是远端控制端。新会话的目录选择明确标注“Mac 上的项目”。

## 3. iPhone 信息架构与交互

### 设计评审结论

以下是对第一版 Demo 的历史评审，以及据此确定的第二版决策。第二版据此验证单栈导航、一次输入开始任务、草稿/阅读恢复与上下文审批，正式客户端沿用这些取舍并接入共享业务状态。实际使用、大字体与辅助功能的逐项验收仍需单独记录。

以“离开电脑后，继续查看和推进已有工作，同时能方便地发起新任务”为首版的使用假设。审批需要容易找到，但不把整款应用缩减为审批工具，也不另设数据仪表盘作为首页。该假设仍需在真实使用中验证。

| 第一版行为与证据 | 判断 | 第二版决策 |
| --- | --- | --- |
| `RiffetRootView.swift` 三个 Tab；项目页仅进入 `SessionListView(projectID:)` | 项目与会话访问同一类内容，设置缺少独立顶级目的地的使用频率依据；并非 TabView 本身违反 HIG | 一个主导航栈，项目作为范围选择，设置保留在可见工具栏入口 |
| `SessionListView.swift` 顶部叠加筛选和设备卡；行内只有标题、项目、Agent、状态 | 页面先展示控制和元数据，缺少帮助选择会话的最近事件、时间和具体等待原因 | 压缩正常连接信息；列表以任务标题、变化与下一步为主要信息 |
| `NewSessionView` 的“想完成什么”传给 `DemoStore.create(title:)`，未进入首条用户消息 | 输入的语义与提交结果不一致；即使是 mock 也应验证正确流程 | 输入一次任务即可开始，项目与 Agent 使用可见且可修改的默认值 |
| `ConversationView` 草稿仅在本地 `@State`；消息数变化无条件滚底 | 返回会丢失上下文，追加内容会打断历史阅读 | 按会话保存草稿与阅读锚点；区分主动发送和后台追加 |
| 审批固定插在第二条消息后，待处理入口没有定位参数 | 用户知道有审批，但不一定能直接找到当前请求 | 待处理入口定位请求；滚动离开后提供回到请求的状态入口 |
| `Button("拒绝", role: .destructive)` | 当前拒绝行为不删除内容，破坏性样式与实际后果不一致 | 普通拒绝用中性样式；只对确有破坏性后果的操作使用 destructive 角色 |

系统控件、返回手势、安全区和 Dynamic Type 是需要保留的实现基础。导航权重、摘要内容与任务流程属于 Riffet 自己的设计责任。Apple 的 [Design principles](https://developer.apple.com/design/human-interface-guidelines/design-principles) 强调目的、层级和使用者的控制权；本表中的具体导航取舍是本产品判断，并非 Apple 要求所有工具应用采用单栈。

### 导航决策

```text
NavigationStack
└─ 会话（默认所有项目；可切换范围、搜索、筛选）
   ├─ 会话详情 → 变更 / 文件 / 子 Agent
   ├─ 新任务编辑页 → 发送后成为会话详情
   └─ 设置 → Agent 配置与用量 / 连接设备 / 外观（显示模式、应用图标） / 通知设置 / 关于

项目范围：列表顶部有标签的选择器；项目较多时使用可搜索的 sheet
会话信息：右上角菜单中的会话详情 → 简短信息 sheet
变更/文件：会话工具栏菜单 → push；不经过信息 sheet 再跳转
终端：显式入口打开独立全屏页面
```

> 2026-11 更新：上图的单栈结构已被替换。现在与 Android 一致，底部四个只有图标的 Tab：**新会话 / 助理 / 任务 / 设置**，默认停在新会话（可在 设置 → 交互与输入 改），待处理数挂在任务上；推入会话等页面时底栏随系统收起。新会话 Tab 的根页面就是任务编辑页（大输入框 + 项目切换 + 文件/变更/终端），发出后在同一栈内推入会话。下文第一、二版的评审记录保留作历史。

> 宽窗口（2026-11）：同时支持 iPhone 与 iPad（`TARGETED_DEVICE_FAMILY 1,2`，iPad 四个方向都支持，以便参与分屏和台前调度）。布局只看窗口的尺寸类别，不看设备：水平和垂直都是 regular 时（iPad、展开的 iPhone Duo）「任务」改为列表在左、会话在右，列表宽 32%，限 320～420pt；compact（iPhone、Duo 外屏、窄分屏、手机横屏）保持单栈。两种宽度共用同一个 `NavigationStack(path:)`，列表只是挪到栈的旁边，所以折叠、展开或调整窗口时，打开的会话不会被重新挂载。宽窗口下会话页不隐藏 Tab 栏；正文与输入框限宽 `RiffetMetrics.readingWidth`（760pt）居中，窗口宽于此时调整大小不需要重新测量各行。硬件键盘：⌘N 新会话，⌘↩ 发送；两个输入框都能接收从其他 App 拖入的文件和图片。
>
> iPhone Duo：只有用 Xcode 27.1 / iOS 27.1 SDK 构建，才会在内屏铺满并改用竖排栏；更早的 SDK 构建都只在内屏中央显示一个兼容窗口。它没有单独的 Info.plist 开关。按 Apple 说明，内屏是 regular/regular，外屏是 compact，因此直接沿用上面的规则。铰链与 reserved regions（`onHingeChange`、`GeometryProxy.reservedRegions`）需要 iOS 27.1 SDK，尚未接入；半折时列表与会话的分界跟随折痕，留待工具链升级后再做。

### 会话首页

- 使用紧凑导航标题与系统搜索，把内容空间留给会话。项目范围在列表顶部明确显示；普通字号使用「全部 / 进行中 / 待处理 / 归档」分段控件，大辅助字号改用菜单。工具栏提供按时间/项目分组与标签筛选，选择按服务器保存。
- 采用连续的内容列表，以标题和轻分隔区分组；设置仍用 inset grouped Form。具体列表样式是视觉选择，不把 grouped List 判定为不符合 HIG。
- 有当前请求时，显示“需要你处理”分组；其余为“最近”，默认不重复展示同一会话。没有待处理内容时不显示空组或庆祝卡。置顶是排序偏好，不建立第三套同级导航。
- 第一行展示任务标题和更新时间；第二行显示真实运行状态、项目、标签与未发送草稿。首页不逐行读取完整会话历史来拼摘要，避免列表出现几十次历史请求和解码；后续若增加最近回复摘要，应由已有索引或服务端列表字段提供。
- 项目是较弱上下文；项目范围已确定时不在每行重复。Agent 可在需要区分执行者时保留为次级信息，不能挤掉最近变化。完成态弱化，待处理和失败保留文字与符号。
- 正常连接状态作为简短设备信息，连接管理由设置进入；断线、重连、需要配对时再显示明确的原因和动作。低风险的正常状态不持续占用一整张卡片。
- 置顶、归档通过 swipeActions 和 contextMenu 补充，并保留可发现的等价操作。列表不因每个流式 token 重新排序。
- 断线保留缓存内容，标注最后同步时间与连接状态；空列表区分“无会话”和“搜索无结果”。

### 开始新任务

- 点击新建进入完整的编辑页面，使用系统 TextEditor；沿用会话的草稿和提交语义，给初始任务更多写作空间。用户直接写任务，不先填写标题。
- 项目与短模型名在输入页直接可见，Agent、服务商、模式和权限在配置面板中调整。无障碍字号允许标题换行，横屏导航栏保留模型入口；每个控件只创建一次，避免自适应候选产生重复辅助功能节点。默认沿用服务器保存的 Agent / 服务商 / 模型，仅在同一服务商范围应用模型与权限默认值。首次没有项目时先选项目，不读取无效模型目录。
- 点击“发送/开始”后，刚才的文本成为首条用户消息；标题后续从任务形成。发送失败保留正文和选择，并提供重试。
- 新建草稿与已存在会话的回复草稿都保留。返回、切换会话和进入设置不会隐式丢弃输入；取消请求与清除草稿分别处理。
- 项目选择与附件选择适合短暂 sheet；主要写作过程沿用完整页面，避免要求在表单和聊天框中重复表达同一任务。这里是本产品对 [Modality](https://developer.apple.com/design/human-interface-guidelines/modality) 的应用取舍。

### 会话阅读与输入

- 正文是页面主要内容。用户消息为轻背景气泡，助手长文在平整背景上阅读；同一轮不反复加入“Agent”标签或装饰图标。
- 工具执行、原始 thinking 和子 Agent 默认摘要，点开读取细节；narration 继续作为完整的淡色正文显示。原始 thinking 的折叠预览仅一行；正常工具用轻分隔或紧凑记录表达，避免每项都包成大卡片。失败和需要操作的项目保持明显入口。
- 代码和 diff 采用等宽字体。iPhone 默认单列 diff，长代码独立横向滚动；不把整个页面横向撑开。
- 输入区通过安全区布局，在键盘上方；正文滚动可交互式收键盘。输入栏左侧为附件，右侧依次为上下文图标、短模型名和发送/停止；模型参数、模式、权限与上下文用量进入模型面板。上下文图标使用 44 点触区，区分真实上报与未知状态。点击标题显示 Agent、服务商、完整模型参数、工作目录和会话信息，标题栏不重复显示工作目录和变更图标。项目变更保留在会话菜单中。
- 用户位于底部时跟随追加；回看历史时保留锚点，以“有新内容”入口提示。主动发送可带用户到自己的新消息；审批状态变化优先原位更新，不触发滚底。
- 按会话恢复草稿；普通打开和退出重进会话都默认显示最新内容，不应用旧持久化阅读锚点。从搜索和待处理入口进入时保留显式定位。回到最新使用输入区上方独立的 44 点圆形按钮，不占据整行。
- 输入区状态遵循真实能力：运行中仍可编辑补充内容；空草稿时显示明确的停止图标，有内容时显示加入队列动作，并可长按选择打断并发送。完成回答的复制与 TPS 共用一行。

### 审批

- 从“需要你处理”进入时直接定位当前请求，展示原因、命令/影响文件、设备与项目。滚动离开该请求后，在输入区上方保留紧凑的“等待确认 · 查看”入口；这里不提供脱离上下文的一键批准。
- 卡片中使用“允许本次”“不执行”等明确对应后果的文案，并保持后端支持的动作语义。普通拒绝不删除数据，采用中性样式；危险命令需依据具体影响决定强调方式，不把所有批准都默认设计成最醒目的推荐选项。
- 点击后进入提交中状态，以服务端响应为准；失效或已被其他客户端处理时展示真实结果。
- 处理完成后原位显示“已允许/已拒绝”，而不是立即把用户带离卡片。允许执行、执行中和执行成功是不同状态。
- 不通过滑动手势批准操作；不将本地按钮状态当作执行成功。Apple 将 destructive 角色用于数据破坏或不可逆操作，不能根据“拒绝”这个否定词来赋予角色。[Buttons](https://developer.apple.com/design/human-interface-guidelines/buttons)
- 正式版通过共享 `SessionStore` 提交请求，持久保存提交 ID，支持未知结果原请求重试和 409 后重新同步；完成结果写入当前时间线的交互记录。独立 Demo 继续使用本地一次性样例状态。

### 视觉与无障碍

- 品牌延续 Riffet 的低饱和中性色与蓝色交互强调。标题、正文和状态以排版层级区分，避免设备卡、工具卡、审批卡同时争夺注意力。
- 蓝色主要标记可操作内容；橙色用于需要注意的状态；红色用于错误或确有破坏性的操作。正常完成不铺满绿色，圆角与背景用于区分真实的操作单元。
- 字体使用系统 `.largeTitle / .headline / .body / .caption` 等语义样式和 Dynamic Type，不复刻桌面 11–13px 密集工具栏。
- 图标使用 SF Symbols；主要触控区域按至少 44 × 44pt 设计；标签足够长时允许换行。
- 颜色取主题角色（`palette`），不用系统语义色；现行的组件、取值与页面规则见 [iOS 设计规范](design/system/ios.md)。
- 支持浅/深色、增大文字、VoiceOver、Reduce Motion 与 Reduce Transparency；没有颜色也能识别状态。
- 原生导航提供返回与边缘返回手势；页面遵循安全区，避免键盘和底部栏遮挡输入或最后一条消息。

这些选择依据 [Designing for iOS](https://developer.apple.com/design/human-interface-guidelines/designing-for-ios)、
[Layout](https://developer.apple.com/design/human-interface-guidelines/layout) 和
[Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility)。44pt 是本项目采用的主要触控区域标准。

## 4. 实现架构

```text
SwiftUI / UIKit（iPhone UI 与平台能力）
         ↓ Commands     ↑ @MainActor 可观察状态
iOS host façade + Swift 状态订阅（薄适配层）
         ↓ RiffetKit.framework / SKIE
:client（SessionStore、缓存、outbox、连接、展示分组、页面 controller）
         ↓
:core（时间线投影） + :contracts（协议）
         ↓ HTTP / SSE / WebSocket
已有 Riffet 服务端（Mac）
```

复用 `apps/macos/Riffet/Bridge/Flows.swift` 的订阅模式与 `Workbench.swift` 的命令映射思路。Swift 负责页面状态与系统能力，不解析 NativeStreamMessage，不再写一份时间线投影。`:shared` 中的 Compose UI 不进入 iPhone 主界面。

`:client` 里的 `GitPanelController`、`SettingsController`、`StatsController` 是 Android 页面的读写层。iPhone 的项目变更、提供商与统计页仍直接调用 `RiffetApi`：它们的分页、提示文案和写入字段与 Android 不同，改用这些 controller 会改变现有行为，迁移时需逐页对齐。

现成依赖足够支撑首版：SwiftUI/UIKit、Observation、KMP、SKIE、Ktor Darwin、现有缓存/契约模块。工程沿用 XcodeGen。先使用已有组件与官方 SDK，按真实需要再引入第三方库。

### 已落地的装配与平台实现

| 位置 | 实现 | 约束 |
| --- | --- | --- |
| `client/build.gradle.kts` | iosArm64 / iosSimulatorArm64 导出静态 `RiffetKit`，包含 core/contracts，沿用 SKIE | 只支持 arm64 真机与 Apple Silicon 模拟器 |
| `client/src/iosMain/.../IOSHost.kt` | 装配连接、SessionStore、TimelinePresenter，管理 scope、前台轮询与生命周期 | 不包含 Mac 本机服务托管逻辑；iPhone 只远程操作 |
| `Platform.ios.kt` | Security Keychain 保存令牌/源/地址；LocalAuthentication 使用本人验证策略并允许设备密码回退 | 身份验证取消或不可用时不提交受保护请求；Keychain 必须在具备应用身份的签名进程验收 |
| iOS preferences、LocalFiles、TranscriptIndex、Outbox | UserDefaults、Application Support 原子文件、持久化搜索索引与按服务端分区 outbox | 本机写入先于发送；未知结果重试保留原 commandId，服务器切换不串数据 |
| Swift `AppModel` / `Workbench` / `DraftStore` | 薄 host adapter、StateFlow 观察、按服务器/会话保留文字、附件、引用与上下文选择；普通进入显示最新，搜索/审批显式定位 | 时间线投影与命令状态仍由 Kotlin 共享层计算 |
| Swift `Platform/` | Bonjour、相机扫码、照片/文件导入、Quick Look、分享、UserNotifications | 权限按用户操作请求；拒绝权限后保留手动连接和可解释的失败状态 |
| Swift Inspector / Terminal | 文件、Git、检查点、Worktree、SwiftTerm 远程终端 | 写操作调用现有服务端 API；终端退出页面断开观察，不结束远端进程 |

`AppModel.swift` 使用 iOS 生命周期与远端连接；macOS 的 AppKit 与本机服务管理仍留在 macOS。共享 Compose 目录中的旧 iOS UI stub 不构成正式 iPhone 的入口或能力边界。

### iOS 生命周期和通知

进入后台时保存草稿、阅读位置、缓存与 outbox，结束无须持续运行的订阅；回到前台先显示缓存，再用共享协议恢复、去重和对齐状态。401 进入重新配对状态，不能无限重连。

常驻 SSE 不作为锁屏实时提醒的保证。iOS 会暂停一般后台应用，短期后台执行只用于完成必要工作；系统提供的后台任务也不是持续连接替代品。参见 [Preparing your UI to run in the background](https://developer.apple.com/documentation/uikit/preparing-your-ui-to-run-in-the-background)。

App 在前台时，`Workbench` 观察真实任务变化，在用户授权后发送本地通知，并按服务器/会话/事件去重；点击通知只在对应服务器源匹配时打开目标会话。

App 挂起或退出后的提醒走 APNs，由服务器直接发给 Apple，不经中继，内容不另加密，因此没有 Notification Service Extension。只有主人配置了 APNs 密钥的服务器会推送，其余服务器照旧只在前台提醒。APNs 不保证送达，也不用 BGTask 或静默推送模拟常驻连接。参见 [User Notifications](https://developer.apple.com/documentation/usernotifications)。

- **注册**：允许通知后注册远程通知（`aps-environment`：Debug 为 development，Release 为 production）。`RiffetPush` 把 `push: {token, topic, environment, activityStartToken?, activityToken?}` 随 `PUT /api/devices/me` 报给每台已配对的服务器；topic 是 bundle ID，environment 按签名描述文件判断（无描述文件的 App Store/TestFlight 包为 production）。实时活动的两个令牌只报给当前打开的服务器，其余服务器收到的报告不带它们；切换服务器或活动结束后重报。未允许通知时报 `push: null` 注销。令牌或授权变化、配对新服务器、回到前台时重报，内容未变的不重复发送。服务器回 `DeviceInfo.push`（`direct` / `none` 与原因），显示在「设置 → 通知」。
- **助理外观设置**：用户可以在「设置 → 已授权设备」开启本机外观权限。权限绑定配对记录，随当前已登录的 Riffet 连接在前台提供 `riffet.appearance`。客户端用同一套主题设置读写内置主题和显示模式，读回保存值后才回执。切换服务器、进入后台或关闭权限会结束设备调用流。iOS 提供主题和显示模式两项。
- **识别服务器**：推送的 `userInfo.server` 是服务器持久的 `serverId`；每次上报同时读取 `/health` 记下 `serverId`（旧服务器为 `instanceId`）对应的源。找不到时，只有一台已配对服务器才用它，否则提示到对应设备查看。
- **通知按钮**：分类在启动时注册——`riffet.permission`（`riffet.allow` / `riffet.deny`）、`riffet.plan`（`riffet.approve` / 打开）、`riffet.question`（打开）、`riffet.question.reply`（`riffet.reply` / 打开）、`riffet.finished`（`riffet.reply`）。允许、批准、回复要求设备解锁。按钮在后台用一个只为这台服务器开的短连接处理，不切换当前服务器。请求类推送带 `interactionId`、`revision`、`interactionKind` 和按按钮 ID 列出的 `answers`（`{action, selectedIds?, text?: true}`）：先读当前对话框，ID 与修订号都与通知一致、且对话框确有该动作时，才提交 `POST /api/sessions/:id/native/interaction`（新的 `requestId`；`text: true` 时输入作为 `otherText`）。完成通知的回复按推送带的 `configRevision` 发送为下一条消息。结果未确认、对话框已变化或请求失败时，另发一条本地通知，点开即进入该会话。开启「确认操作前验证本人」时，权限、计划与确认不在通知里提交。没有正文的推送用 App 内的 `push.waiting`、`push.finished`、`push.failed`、`push.interrupted` 文案，开始实时活动的提醒用 `push.activity.title` / `push.activity.body`。设备令牌存在 Keychain，首次解锁后后台可读。
- **去重与撤回**：App 在前台时，当前服务器的推送不显示，由本地通知负责；其他服务器的照常显示。打开会话即撤回该会话（`thread-id`）的通知；会话列表刷新后，不再等待的会话的请求类推送也会撤回。
- **实时活动**：Widget Extension `RiffetWidgets` 提供 `RiffetSummaryAttributes`（无属性字段，ContentState 为 `waiting`、`running`、`unseen` 三个整数），锁屏与灵动岛只显示三个计数和静态符号，点按回到任务列表。App 取得 `pushToStartTokenUpdates` 与每个活动的 `pushTokenUpdates`，作为 `activityStartToken` / `activityToken` 上报；活动由服务器推送开始、更新和结束。不需要 App Group。

## 5. 正式版功能矩阵与验收

“已实现”表示页面和真实请求路径已经存在；它不表示每项系统能力都已在 iOS 18 实机验收。功能会根据服务端/Agent 的 catalog 能力显示，不硬编码所有后端都支持同一组操作。

| 范围 | 正式版实现 | 验收依据与剩余检查 |
| --- | --- | --- |
| 连接与身份 | Bonjour / 扫码 / 手动配对、Keychain 冷启动恢复、源绑定授权、连接其他服务器、设备列表与撤销、401 返回配对 | App-hosted 测试验证真实 Keychain 和失败配对不覆盖；网络 UI 测试覆盖撤销后停止轮询；相机/局域网权限需真机 |
| 项目与首页 | 项目范围、任务摘要、待处理/最近、状态筛选、搜索、缓存全文检索、置顶/归档恢复/重命名/标签、远端目录添加项目、首页项目操作菜单直达文件/Git/检查点/Worktree/终端 | 列表从共享 store 读取，断线保留缓存；多项目与大数据量触控继续验收 |
| 新任务与输入 | 完整首条消息，Agent/配置/模型参数/模式/审批，照片/文件、项目文件引用、命令与技能；新建与回复草稿持久化 | UI 测试覆盖首条消息、冷启动草稿、丢失创建响应后复用原创建与首条命令；真实上传和多模态按后端验收 |
| 发送与运行控制 | 发送/排队、立即发送、取消队列、移回草稿、打断并发送、停止、未确认发送的原请求重试、恢复 CLI | commandId/outbox 由共享层保证；fixture 核对唯一服务器命令；真实 CLI 停止/恢复仍需验证 |
| 时间线与阅读 | Kotlin 投影、原生 Markdown/代码/工具/思考/计划、图片、待办/目标、子 Agent、历史分页、锚点恢复、回看新内容入口 | golden fixture 经真实 SSE 到原生 UI；长历史、大字体、横屏和中文输入法需设备检查 |
| 操作确认 | 审批、单/多选、其他文本、提交状态、原位结果、未知请求重试、409 同步修订、可选本人验证、终端兜底 | UI 测试核对相同请求 ID 重试与新修订同步；Face ID/密码和多客户端真实并发需设备与服务验证 |
| 文件与资源 | 目录分页、文件名/内容搜索、文本行定位、图片、静态 HTML、单文件/ZIP 下载、Quick Look/系统分享 | 请求与下载复用源绑定认证；真实大文件和系统分享验收独立记录 |
| Git 工作区 | 单列 diff、暂存/取消、全部操作、提交、检查点创建/查看/指纹校验恢复、Worktree 列表/创建/添加项目/移除 | 写入真实 Mac 工作区，需在可丢弃测试项目完成实际验收 |
| 终端 | SwiftTerm 原生页面、多终端、新 Shell、WebSocket、接管/释放、键盘、Ctrl+C、结束 Shell、重新连接、历史只读快照 | 与共享 TerminalConnection 接通；fixture 不提供终端能力，不作为真实 PTY/租约/输入法验收 |
| 使用统计 | 今天、7/30/90 天、一年、全部及自定义日期；项目/Agent/模型多选与主子 Agent 筛选、估算/归档开关、七项趋势指标与三种分组、每日/时段热力图、模型排行、延迟分位数、轮次分页、CSV/JSON 分享 | 管理真实 API 补强验证统计读取与 CSV；设备 UI 读取和系统导出分别验收 |
| Agent 与提供商 | Provider 增删改、Key 三态、默认 Agent/提供商、模型目录与探测、模型启用列表、CLI 设置、Cursor 网关 | API 补强覆盖 CRUD 与 Key 保留/更新/清除，Key 不回显；配置生效遵从 Mac 服务与 CLI 重启条件 |
| Rules 与扩展 | Agent/提供商/项目范围，Rules/Skills/Commands/MCP/Hook/插件清单与运行状态、创建、文档编辑、内容 hash 校验、能力允许的插件动作 | API 补强验证创建与 hash 409；冲突需显式重新读取，不能静默覆盖；真实扩展执行依服务端能力 |
| 系统能力 | 外观、备用应用图标（6 色，`setAlternateIconName`，系统会弹出确认）、通知权限/系统设置、本地任务提醒、APNs 后台推送与通知按钮、摘要实时活动、打开通知定位、深链、准备任务快捷指令 | 前台由实际观察的事件触发本地通知；后台推送需要服务器配置 APNs 密钥，送达、按钮与实时活动仍需真机验收 |
| 网页隔离 | 普通 HTML 禁脚本；可视化 opaque iframe、可信 CSP、受限资源 allowlist、禁止 API/表单/外部导航；公开 KaTeX 页保留 HTTP CSP | 3 项 App-hosted WKWebView 测试通过，实际验证本地交互可用与越界请求被拒绝，不依赖外部 CDN |

统计与管理模块位于 `Features/Management`，从「设置 → Agent 配置与用量」进入，接入真实 API。统计的日期语义、多选参数、指标和粒度遵循 Web；iPhone 使用原生表单、Swift Charts 和可查看准确值的热力图。自定义结束日包含在范围中，以当前时区下一日零点作为 API 排他终点，正确处理夏令时。筛选与同筛选刷新都有独立请求身份，分页和导出绑定已应用的筛选快照。桌面菜单与全局热键使用各平台入口。

### 构建和测试分层

详细命令见 [正式 App README](../apps/mobile/iosApp/README.md)。工程使用 XcodeGen，Xcode pre-build 自动构建 RiffetKit；最低系统 18.0 不要求手机升级到模拟器所用的系统版本。开发团队、设备 UDID 与签名身份使用本机变量传入。

1. **共享逻辑测试**：JVM / Kotlin/Native 验证契约、投影、缓存、outbox 与幂等状态；不能替代系统能力验证。
2. **App-hosted XCTest**：运行在正式 App 身份中，验证 Keychain、Swift 草稿/源规则与实际 WKWebView 隔离。模拟器也需要签名和正确 entitlement；无签名编译成功不能证明 Keychain 可用。
3. **隔离 fixture UI 测试**：`iosApp/scripts/e2e-server.mjs` 监听 loopback，通过 HTTP/SSE 发送真实 golden 契约并模拟丢失响应、审批未知结果、409、401。它不运行真实 Agent、不提供真实 Git/PTY；UI 测试会重置 fixture，应串行运行。
4. **真实服务与实机验收**：独立连接 Mac Riffet 与可丢弃测试项目，验证实际 CLI、附件、Git、PTY 和系统权限。opt-in `RealServerConnectionUITests` 不调用 fixture reset；已在 iPhone 真机 / iOS 18 验证一次性配对、首页项目操作读取真实 README、冷启动 Keychain 恢复、真实 Provider/统计/扩展页面读取，并在选择真实项目、准备草稿后检查最大辅助字号与横屏下的操作可达。草稿未发送并在测试结束清空，仅设置真实地址、配对码、项目变量时运行。

0.3 与统一服务阶段的历史验证记录（2026-10-15）；0.4 本轮结果单独记录在下节：

| 验证层 | 结果 |
| --- | --- |
| iOS 26.5 签名模拟器正式 App | 9 项 App-hosted + 7 项网络 UI 全部通过 |
| 共享 JVM / iOS Native | JVM 244 项通过；Native 248 项中 247 项通过、1 项 standalone Keychain 跳过；真实 Keychain 另在 App-hosted 验证 |
| 独立真实服务 API | 基础 25 组、终端补强 9 组、管理补强 16 组全部通过 |
| macOS 回归 | 完整 Debug App 编译通过，不等同 macOS 全部 UI 验收 |
| 统一 Server 连接 | 13 个文件、159 项定向回归通过；6 项 CLI wrapper 测试通过；生产 Web/Server 构建通过。真实服务 20 项连接检查通过，覆盖一次码 Web/native 登录、CSRF、共享项目、旧数据保留与撤销关闭现有 SSE |
| iPhone 真机 / iOS 18 | 正式版安装启动及 1 项真实服务综合 UI 验收通过，0 失败 |

最终验收记录必须注明测试系统、通过/失败/跳过数以及 backend 是 fixture 还是真实服务。V2 的 8 项数据、4 项 UI 测试属于 Demo 历史记录，不计入正式版结果。相机、Face ID/密码、通知/分享、VoiceOver、中文输入法、长历史与切网/锁屏恢复的完整系统验收仍应逐项记录。

另外仅创建一次隔离 Cursor/default 的真实只读任务，HTTP 提交为 202、Native SSE 为 200；CLI 停在 `Log in`，模型完成与回复未验证。120 秒观察后已停止这个验收任务，README 未变化；那次隔离验收没有修改原有 Mac 服务。该限制属于隔离 CLI 的登录配置，不能将 fixture 的通过记录替代为真实模型调用成功。

设备检查中曾发现最大辅助字号下的新任务操作文案裁切，以及未选项目时提前调用模型目录。实现已改为大字号分行显示项目/Agent，保留完整操作文字；横屏将操作放到导航栏，为正文和键盘留出空间。模型目录在明确选择项目后读取，提供商设置页也显式选择模型目录的项目上下文。

最后的新任务调整后，首条消息与丢失创建响应恢复的 2 项定向回归再次通过。开发签名到期需重新签名安装；构建配置不硬编码个人账号或设备标识。此后已停止独立验收服务，并将手机切换回主服务。单独的 `RealServicePairingUITests` 1 项通过、0 失败，验证已有连接切换、Keychain 冷启动、真实项目与服务器 origin；不创建任务或删除草稿。服务切换保留原有会话、项目和 tmux pane。新设备通过 `riffet pair` 取得一次性码或二维码，完整服务连接方式见 [运行、部署与维护](guide/operations.md#手机和另一台电脑)。

### 0.4 产品化改造

以当前 Web 的任务、模型配置、执行状态和 Markdown 语义为基准，将日常操作放回 iPhone 的单列导航、原生表单与输入区。

- 首页压缩导航标题和连接信息，提供全部、进行中、待处理和归档范围，按时间或项目分组，保留项目和标签筛选。筛选按服务器保存；会话行显示标题、时间、状态、项目和草稿标记。显示列表行不会启动对应会话的历史读取，沿用共享客户端最多八个近期会话的预取预算。
- 新任务页直接展示项目、Agent、服务商与模型，模型可搜索并按服务商分组。切换模型同时保存其配置身份；模式、思考参数、权限与完整正文共同进入创建请求。默认值按所属服务商应用，目录加载以项目、后端和版本为上下文，并丢弃过期响应。
- 已有会话提供直接的模型、运行模式与操作确认入口，使用服务端保存回执更新显示。输入中可以查看配置，原有草稿保留；输入框支持多行与展开编辑，运行中补充消息进入共享队列，并保留停止和打断发送语义。
- 会话采用轻背景用户消息和连续的助手正文，处理过程按共享状态折叠或展开。轮次目录可搜索和跳转，代码变更有直接入口。回看历史与主动发送分别处理滚动，阅读锚点只观察可见内容，不反向驱动滚动位置；“回到最新”浮在输入区上方，不改变正文可视高度。
- Markdown 解析在串行后台处理，流式更新按 100 ms 节流发布；代码高亮复用既有 Prism 语法资源，代码支持换行、横向滚动、复制与展开。表格使用统一列宽和按内容增长的行高，长中文单元格可以换行并横向滚动。
- 普通正文继续使用 SwiftUI Text，含行内公式的段落使用原生 TextKit 附件。公式图片由单个共享 WebKit 渲染器和有容量上限的缓存提供；文字尺寸用独立 TextKit 布局测量，同一内容与宽度复用附件。公式块等待字体完成并按实际宽度更新高度。图片在后台缩小解码，聊天与文件共用缩放查看器。
- 草稿采用原生不可变快照和串行后台持久化，同一个主线程执行回合内的连续编辑合并写入；发送、创建请求和前后台切换使用立即保存边界。持久化包含正文、附件、待上传文件、引用、模型及创建恢复 ID；成功发送仅清除那次已提交的内容。
- 针对 iOS 18 真机修正首页项目选择的完整触摸区域；大辅助字号将新任务上下文分行，横屏将关键动作移入导航栏。模型与项目加载错误均保留可操作的重试入口。
- 模型和运行模式弹窗以目标枚举直接驱动呈现，避免首次点击读到旧目标。统计补齐自定义日期与多选筛选、七项趋势指标、每日/时段热力图、模型排行及延迟分位数，使用原生图表并保留完整数值、分页和系统导出。图表刻度采用系统语言的紧凑数字与短日期/小时，避免科学计数法和日期裁切。


0.4 本轮已完成的回归记录如下。模型弹窗的组合回归曾发现首次呈现目标不一致，修正为单一目标状态后，相关两项用例各连续执行两轮通过；不把早期含失败的组合报告记为全部通过。

| 验证层 | 最新结果与证据 |
| --- | --- |
| iOS 26.5 签名模拟器 App-hosted | 原有 38 项全部通过，涵盖真实 Keychain、WKWebView 隔离、模型默认值、草稿合并/冷恢复、表格及行内公式像素/实际窗口布局；新增统计 8 项全部通过，0 失败、0 跳过，覆盖日期/DST、多选参数、粒度和过期响应。 |
| HTTP/SSE 网络 UI | 7 项通过、0 失败、0 跳过，验证唯一发送、完整首条消息、冷启动草稿、创建响应丢失恢复、审批未知结果/409 及 401 停止轮询 |
| 产品 UI | 5 个不同场景的最后执行均通过：80 行首页预取上限、浅深色富文本、120 轮长会话、完整模型参数创建、已有会话配置回执后发送。后两项各重复两轮，共 4 次运行通过、0 失败、0 跳过。 |
| 共享 bootstrap 回归 | JVM 23 项与 Kotlin/Native 4 项定向用例通过，Native framework 编译通过；验证首次加载、缓存后刷新、轮询及前后台恢复 |
| macOS 回归 | 当前源码完整 Debug target 编译通过，0 Swift 编译错误。不启动或部署 macOS App，不重启现有服务 |
| iPhone 真机 / iOS 18，真实 4337 服务 | 四个不同只读场景全部通过、0 失败、0 跳过：首页冷恢复与 README 阅读/源码，真实模型目录，最大辅助字号与横屏操作，统计筛选/趋势/每日热图。共 3 份通过报告（1、2、1 项）；最新横屏完整屏幕截图另取自一份旧报告的通过用例，不把该旧报告整体记为通过 |

长会话场景包含 120 轮、480 个事件和 18 行中文草稿，实际执行滚动手势，检查草稿不变、“回到最新”可点击且不遮住输入框、返回最后正文，并核对未产生发送命令。XCTest 三轮采集的峰值物理内存最大约 133 MB；该值属于 Debug 模拟器中的这个场景，不代表真机帧率或所有项目的内存上限。

最终 App 为 0.4.0（build 4），`MinimumOSVersion` 为 18.0，已原位安装到 iOS 18。手机继续使用原 Mac 的 4337 服务。已停止旧验收服务和本轮 loopback fixture；正式服务与原 pane 保留。最终已仅移除临时 UI runner，保留 Riffet 与 Riffet 2，正式 App 按普通参数恢复竖屏启动，独立设备进程查询确认运行。开发签名到期需重签。截图位于 `apps/mobile/iosApp/build/acceptance/product-0.4/`，分别标注真实设备与模拟器。

本轮真机验证保持现有草稿和真实会话，不发送真实 Agent 任务、不执行 Git 写操作。发送、配置回执、审批与恢复的客户端行为由独立 HTTP/SSE fixture 验证；真实 CLI 长任务、终端输入/租约、Git 写入、完整 VoiceOver 与切网/锁屏仍须分别做系统验收。前台本地通知没有后台常驻保证；后台提醒依赖服务器配置的 APNs 密钥，送达需真机验收。

### 0.4.1–0.4.3 会话细节与滚动

这一版将有限的输入空间留给正文，上下文图标、短模型名和发送/停止靠右排列，完整配置集中在模型面板、可点击标题的信息面板中。模型和上下文入口均打开同一个原生模型面板。模型面板读取共享 `NativeContext`，展示真实 token 总数、窗口、比例和后端上报的分解；未上报时明确显示未知，不生成虚构的 0%。

工具标题、参数、输出和 diff 的容器均显式左对齐；narration 保留完整正文，只有原始 thinking 默认一行预览。完成回答的复制与吞吐速度在同一个操作行。思考预览每次只检查首尾有界窗口，解析前候选限制为 1,536 个字符；流式过程中复用完成段落，并取消过期任务。完整展开和复制继续使用原始文本。

普通打开会话默认到最新，搜索、轮次目录与审批仍采用显式定位。移除了滚动可见行变化触发的持久化与整个 transcript 重整；跨 KMP 的行、间距与速度集合按更新读取。工具 presentation 依据不可变 item 身份缓存，代码块复用行数和预览快照，明暗主题的高亮 attributed strings 在后台生成后复用。缓存有容量上限；没有添加新 UI 或解析依赖。

0.4.1 的签名模拟器回归中，59 项 App-hosted 与 7 项网络 UI 通过，0 失败、0 跳过。7 个产品 UI 场景各自最后一次执行通过，覆盖上下文、完整 narration、单行 thinking、工具左对齐、复制/TPS 同行、配置回执以及长会话重进到最新；组合报告中早期失败用例有独立修正报告，不把原组合报告整体计作通过。0.4.2 的首屏结构随后仍被用户与真机重复回归证实存在空白，不能把这些旧结果推定为正文稳定性通过。

性能对照使用同一个 72 次工具调用、长输出与 diff 场景及相同手势：0.4.0 基线的平均峰值物理内存约 182.5 MB，0.4.1 候选约 156.8 MB，降低约 14%；CPU 时间约 2.04 秒对 1.98 秒，约 3% 差异仍在基线波动内。该数据来自 Debug 模拟器，不代表真机帧率；没有取得有效的 FPS 或 hitch 数字，不能宣称滚动已完全流畅。历史 0.4 的 133 MB 来自不同场景，不用于本次性能对照。

0.4.3 将主会话正文容器替换为 UIKit `UICollectionView`，每个过程标题、内部项目和 footer 独立复用。Markdown、工具、思考等 SwiftUI 组件继续使用既有投影；按实际原生布局处理首次定位、内容尺寸变化和静止 offset 边界，用户拖动立即退出跟随。diffable 对内容变化的既有 ID 执行 reconfigure，由 UIKit 更新已准备的 cell，包含尚未可见的预取项；搜索、目录与审批使用稳定 row ID，历史插入按仍存在的可见项和偏移保持位置，不再依赖 SwiftUI 初始 bottom anchor 或不可见占位视图的位置估算。

2026-11-25 起，回答正文和普通代码块不再由 SwiftUI 渲染：列表在后台队列上解析 Markdown、生成富文本、用与 Mac 共用的 `TextLayout`（TextKit 1）排版并量高（`TranscriptProse`），格子（`TranscriptProseCell`）只摆放排好的片段、直接画字形，只为可见区附近的片段建视图；长按时一块原地换成 `UITextView` 选择，「引用」照旧。能预览的代码块、表格、公式和图片仍各由一个小的 SwiftUI 片段承载。回答下方的菜单点开时才构建；图表与 HTML 预览由共用的离屏渲染器出图。规则与实测见 [iPhone 流畅度规范](guide/ios-performance.md) §2.16–2.19。

工具摘要使用 12pt 图标、18pt 图标槽和单行文字，保留 44pt 点击范围。展开后完整摘要、文本、命令与 diff 可读，长内容在最多 300pt 的区域内滚动，并随实际可用视口收紧，保留最小阅读高度；复制继续使用完整源码。主动展开、收起和切换换行在 native Controller 中同步退出自动贴底，随后再改变内容高度，避免刚展开的位置被拉走。展开、换行与代码预览等小型阅读状态归当前会话所有，cell 离屏复用后仍保留，不保存 View 或复制正文；普通文件页继续使用自身的局部状态。过程标题保持“处理过程”；只有当前 busy 会话在消息底部显示唯一的“正在处理”，step 为次级说明，attention 审批阶段不显示忙碌指示。

原始空白问题的诊断只证明客户端数据已加载、路由匹配，而正文布局在动态增高和贴底期间可能失效；没有证据将其归因于服务器缺失数据，也不将其泛称为已确认的 iOS 系统缺陷。此前“已到结尾”的几何值曾与零个正文控件同时出现，单看几何不足以验收。新验收要求真实内容持续可见，并覆盖随后增高、缓存恢复与交互。真机下线后停止真机操作，本版最终验证以模拟器为限；iOS 18 的复验另行记录。大辅助字号下，会话信息默认使用全高面板，Agent、配置与工作目录仍在可滚动的原生列表中；普通字号保留半屏与全屏两档。

0.4.3 的模拟器验收采用 iPhone 17 Pro / iOS 26.5，签名产物最低版本为 iOS 18.0。范围为 69 个 App-hosted、7 个 HTTP/SSE 网络 UI、7 个产品 UI、2 个工具输出、4 个正文布局用例，以及 1 个滚动测量。长会话与工具密集会话在冷/暖缓存进入后各不触摸持续观察 8 秒；流式场景由真实 HTTP/SSE fixture 分三批增长 narration，核对最新正文与唯一底部处理状态，再完成到 idle。工具展开、换行选择经过离屏滚至第 30 个工具再返回；文件链接同时要求实际文件内容、带鉴权 GET 与返回会话。

横屏检查要求 420 行输出的内部 viewport 实际可见、内部滚动使源码位置变化，且输入框和收起操作可用。短视口按注入的正文可用高度收紧；“回到最新”使用右下方 40pt 视觉尺寸、44pt 触区，避免盖住居中的代码操作。测试定位采用小步低速拖动并保持触点，避免 XCTest 固定距离带动量手势反复越过目标；保留完整屏幕截图。此前只检查区域存在、高度或裁切后的 App 截图，不足以验证横屏操作。

本版固定 72 工具 fixture、每个文本输出 420 行，从工具 36 的真实输出开始测量四轮。平均 App CPU 时间 2.0466 秒/每批四次外层手势，平均峰值物理内存 171,932.288 kB（约 171.9 MB）；没有有效 FPS/hitch 数值。新执行的 0.4.0 对照未通过测量前输出就绪检查，不能将本版与历史不同起点的结果计算百分比。完整截图、原始 CSV、报告范围与失败后的定向执行见 [0.4.3 模拟器验收](../apps/mobile/iosApp/build/acceptance/product-0.4.3/README.md)。模拟器 fixture 不等同真实 Agent，旧版 iOS 18 通过记录不代表本版真机通过。

## 6. 本次原生 Demo

位置：[`apps/mobile/iosApp/Demo`](../apps/mobile/iosApp/Demo/README.md)。第二版显示为 **Riffet 2**，bundle ID 为 `io.github.riffable.iphone.demo.v2`，可与正式 App 独立安装；V1/V2 源码都保留。使用独立 SwiftUI fixture App 实现本方案的核心交互，不依赖 Kotlin 构建或真实服务。

已经实现：单个 NavigationStack、项目范围选择、需要处理/最近分组、搜索与筛选、一次输入开始任务、独立草稿、阅读锚点恢复、回看时新内容提示、上下文审批及原位结果、归档恢复、外观设置与演示数据重置。所有样例保存在 Demo 专属本机快照中，重启不会自动清空；冷启动从列表进入，打开具体会话后恢复其草稿和锚点。

```sh
cd apps/mobile/iosApp/Demo
xcodegen generate
xcodebuild -project RiffetDemo.xcodeproj -scheme RiffetDemo \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath <构建目录> \
  CODE_SIGNING_ALLOWED=NO build
```

最低系统为 iOS 18.0。Xcode 26.5 已完成真机签名构建，生成 App 的最低版本和 iPhone 设备范围已核对；安装到 iPhone 真机 / iOS 18 后成功启动，并再次查询进程确认仍在运行。开发团队和设备标识只通过本地命令传入，不写入共享配置。

在 iPhone 17 Pro / iOS 26.5 模拟器运行的 8 项数据测试、4 项界面测试全部通过，覆盖新建及继续发送、草稿往返、审批定位及原位结果、回看追加及导航恢复。已检查对应模拟器截图；iOS 18 真机的全流程交互、大字体、VoiceOver、横屏和中文输入法仍需实际验收。详细命令、测试报告路径与开发签名有效期见 Demo README。

Demo 中所有项目、连接、工具、回复和审批均为本地样例。正式版在独立 `Riffet/` 工程中实现服务端同步、认证、审批状态、网络失败恢复、停止任务、附件与 diff 等路径，Demo 不切换成正式网络模式。仅有示例变更的会话展示样例 diff，其他会话明确显示暂无示例变更。早期浏览器预览用于讨论布局，最终系统控件外观以本原生 Demo 和对应系统版本为准。

## 7. 与原设计契约的关系

本次已同步 `docs/MOBILE.md` 与 `docs/MACOS.md` 中早期“iOS 复用 Compose UI”的描述：iPhone 采用原生 SwiftUI/UIKit，Android 保持 Compose Material 3，macOS 保持 SwiftUI/AppKit，三者共享 client/core/contracts。共享协议、投影与命令语义保持一致；平台 UI、系统能力、生命周期和验收分别负责。

共享 `:shared` 里的 iOS Compose target 与旧平台 stub 可继续保留用于库兼容，但不是正式 iPhone App 的构建入口。正式工程由 Xcode 构建，Gradle 仅导出 RiffetKit。V1/V2 Demo 继续作为设计比较与回归参考保留。
