# iPhone 流畅度规范

返回 [中文 README](../../README.zh-CN.md)。

本文规定 iPhone 客户端的主线程预算、SwiftUI 与 UIKit 里哪些写法会拖慢主线程、怎么测，以及每次改动要跑的场景。内存、缓存、流队列这类资源预算在 [性能与资源规范](performance.md)，本文不重复；Android 的对应规范是 [Android 流畅度规范](android-performance.md)，两端的场景清单一一对应。

规则来自 2026-11-21 的一次排查：用 `pnpm perf:ios seed` 造了 3000 个会话（其中一个 491 行、带图表与表格的长会话，大编辑、6000 行输出、成组截图），在模拟器上走遍任务列表、转录、输入与附件、终端、文件、Git、图片、设置、统计和断网恢复，并往转录文件里持续追加行，模拟进行中的会话；同日第二轮修完了第一轮留下的问题，并补测了在页内打开会话和不经 XCTest 的打字；2026-11-22 第三轮去掉了从列表打开会话和进行中会话每次更新的整表开销，补测了冷打开，并用真实的 Claude Code 跑通了发送；2026-11-25 第四轮查清了长会话上下滑动的掉帧：卡顿发生在一行第一次进屏的那一帧，一整条长回答的 SwiftUI 视图树、每段一个 `UITextView` 的排版、回答下方的菜单和图表预览的 WKWebView 都在这一帧里建好，格子复用时还要再建一遍；转录正文因此改为在后台排版（§2.16）。每条规则下面记着找到的问题和改法。

## 1. 预算

主线程时间按「一段不被打断的主线程工作」计：run loop 两次活动之间的间隔，不含休眠（`StallMonitor`，§3）。滑动的帧按显示刷新的间隔计（`PerfProbe`）。

| 场景 | 主线程 | 说明 |
|---|---|---|
| 滑动与拖动（列表、转录、面板、图片平移） | 不丢帧；单段不超过一个刷新间隔（60 Hz 为 16.7 ms，ProMotion 的 120 Hz 为 8.3 ms） | 滑动途中不建 WKWebView、不解析、不排版、不解码；一行进屏只摆放已排好的内容 |
| 一次点击引起的变化（展开、切页、打开面板、弹出页） | 单段不超过 50 ms | 超过的部分拆到后台或分帧 |
| 打开会话、冷启动后首屏 | 单段不超过 100 ms（即一次 hitch） | 超过 100 ms 的段会作为 `hitches` 上报（[performance.md](performance.md) §4） |
| 输入 | 每次按键单段不超过 16 ms | 输入框长高不重算页面 |
| 进行中的会话 | 单段不超过 50 ms；没变的行不重建 | 每次追加只做与新行成正比的工作 |
| 静止页面 | 无主线程工作 | 只有可见的动效（品牌标志、运行中的计时）可以出帧，看不见时停 |
| 后台与断线 | 不出帧；断线 30 秒 CPU 不超过 0.5 秒 | 重连退避，不轮询界面 |

数值在模拟器的 Debug 构建上量（§2.12），模拟器按 60 Hz 出帧；真机的 ProMotion 屏每帧只有一半时间，在模拟器上刚好卡在 16 ms 的段，到真机上就是掉帧。Debug 的 Swift 代码未经优化，数字是上限；但同一场景在模拟器上变慢的改动，在真机上同样是退步。

## 2. 规则

每条写明它防的是什么，以及这次排查里的实例。

### 2.1 主线程不做随内容大小增长的工作

解析、转义、拼接大字符串、diff、语法高亮、解码，都随输入变大。它们放在 `Task.detached` 里做，`body` 和 `updateUIView` 只读结果。小输入可以同步算，但要有明确的阈值。

- 图表预览在 `makeUIView` 和每次 `updateUIView` 里都在主线程上把渲染页转义、拼成整页 HTML，冷开一次 326 ms。改为在 `.task` 里于后台拼好，`updateUIView` 只比较拼好的文档（`ConversationWebContent.swift` 的 `ConversationWebPage`）。
- 3000 个会话的排序在 Swift 里调 Kotlin 的比较函数，每次比较都过一次桥、解析两个时间戳：主线程上约 400 ms。改为在 Kotlin 侧先取键再排序（`SessionOrder.kt` 的 `sortSessions`），并按列表对象的身份缓存结果（`HomeView.swift` 的 `SessionOrder`）。进入列表的卡顿从 1.44 s 降到 0.73–0.96 s。
- 会话页每次重算要找好几次自己的会话，每次都在 3000 个会话里经桥线性查找：打开一次约 100 ms。改为按列表身份建一次 id 索引（`Workbench.swift` 的 `listedSession`）。
- 输入框是 `TextField(axis: .vertical)`，外面的栈为了知道它能伸缩多少，会再用零宽和无限宽各量一次，每次都排版整段草稿，无限宽时排成一行：草稿 1000 字时每次按键 40–57 ms。改为外面套一层只按实际宽度量它的布局（`ConversationComposer.swift` 的 `ComposerFieldLayout`，新建任务页同用），同样的草稿 150 次按键只剩 4 次超过 17 ms。会长高的输入框都套这一层。转录每次更新都会让输入框再排一次版，没在编辑时按宽度、正文和字号缓存量得的高度；编辑中不缓存，输入法正在组字的文字还不在绑定里，却会改变高度。
- 运行中的命令输出为了只显示末 6 行，每次重算都把整段输出按行切开；改为从末尾往前找（`ConversationActivity.swift` 的 `conversationLastLines`）。代码预览每次重算都把整段源码百分号编码进地址，改为按源码和主题缓存地址（`ConversationCodePreview`）。
- 发件箱每次读取都在主线程上列一次目录；改为第一次列出后在内存里维护文件名（`Outbox.ios.kt` 的 `OutboxNames`），写入和删除时同步更新。

### 2.2 使用中反复写的状态不进 `UserDefaults.standard`

对 `UserDefaults.standard` 的任何一次写入，都会让 App 里每一个 `@AppStorage` 报告变化，于是从 `RiffetApp` 起每一页的 `body` 都重算，包括正在显示的会话页。草稿、阅读位置、学到的图片比例这类在使用中不断改写的状态，写进 `AppStateDefaults`（`Drafts.swift`，独立的 suite）；`@AppStorage` 只留给用户的偏好。`pnpm check:perf` 的 `standardDefaults` 拦截新增的写入。

- 每次按键都把草稿写进 `UserDefaults.standard`，于是每次按键都重建会话页的 491 行。输入 150 个字：37 次卡顿共 1833 ms，改后 16 次共 431 ms。

### 2.3 页面的 `body` 只读它要画的值

`body` 读到的每个值（`@State`、`@Environment`、`@Observable` 的属性）变化时，整个 `body` 重算。高频变化、只有一小块用到的值，放进一个 `@Observable` 盒子，由用到它的那一小块（修饰符、子视图或 UIKit 控制器里的 `withObservationTracking`）去读；页面只持有盒子，不读里面的值。

- 输入框长高时写进页面的 `@State`，页面随之重算、重建全部行。改为写进 `ConversationComposerHeight`，只有提示条的避让修饰符和转录列表的底部留白读它（`ConversationTranscriptList.swift`）。
- `@Environment(\.dismiss)` 在导航栈每次变化时都让页面失效。改为放进一个只在会话被删除时调用它的修饰符（`ConversationView.swift` 的 `DismissOnRemoval`）。
- `body` 里调用的方法也不改被观察的状态：`DraftStore.draft()` 第一次取某个草稿时写进被观察的字典，于是所有取过草稿的视图（包括正在打开的会话页）再整页重算一遍。字典改为不被观察，只让读「有无草稿」的列表行在下一轮更新（`Drafts.swift`）。
- 闭包不做子视图的属性：每次父视图重算都是一个新闭包，SwiftUI 比不出相等，子视图的 `body` 跟着重算（`_logChanges` 写出 `@self changed`）。从 3000 个会话的列表打开会话时，推入页面让任务页重算，列表因此重走一遍全部行，单段 590–690 ms。改为传一个身份不变的引用，父视图重算时只替换它里面的闭包（`HomeView.swift` 的 `RouteAction`），最长一段降到 146–244 ms。
- 排查时在 `body` 第一行临时加 `let _ = Self._logChanges()`，控制台会写出是哪个值让它重算。查完删掉。

### 2.4 派生值按输入的身份缓存

流式更新时每次都有一份新的行列表；只要某一行的输入没变，就沿用上次为它建好的结果，不按整份列表重算每一行。

- `State(initialValue:)` 的参数在每次 `init` 都会求值，只是结果被丢掉。贵的初始值用 `StateObject(wrappedValue:)`：它的参数是自动闭包，同一视图身份只求值一次。Markdown 段落原来每次父视图重算都重新解析一遍（`ConversationMarkdown.swift` 的 `ConversationMarkdownHolder`）。
- 进行中的会话每追加一行，`transcriptRows` 都重建全部行的 `AnyView`，而列表只会重新配置版本变化的那几格。改为按行 id 和版本沿用之前建好的行，内容用自动闭包延迟构造，环境只在每轮哈希一次（`ConversationView.swift` 的 `TranscriptRowCache`）；查找用的两张映射表改为第一次读取时才建（`ConversationTranscriptProbe`）；列表判断哪些行变了时每行只查一次已应用的版本（`applyLatestRows`）。8 秒内 `transcriptRows` 的主线程时间从 462 ms 降到 227 ms；每 0.5 秒追加一轮、持续 10 秒，卡顿合计从 1.9 s 降到 1.2–1.4 s，最长一段从 70–80 ms 降到约 50 ms，而会话从 491 行长到了约 700 行。
- 只用到一个字段时，不订阅整份数据：工具卡要项目根目录，原来读整份会话列表，列表每变一次所有工具卡都重算（`Workbench.swift` 的 `projectRoot`）。
- 行的版本只放这一行画出来的东西。输出速度随运行记录在行之后才到，原来算在每个回答行的版本里，每次打开会话都把 120 个回答重新配置、重新量高；而 iPhone 只在终端结果的页脚画速度（`ConversationRenderPlan.swift` 的 `revision`）。同理，列表的可视高度一变，原来所有行都重新量高（打开时 400 ms，输入框每长一行再来一次）；实际只有代码块按可视高度的 0.65 封顶，矮于这个高度的行量出来不变，现在只重量高于它的行（`ConversationTranscriptList.swift` 的 `updateViewportHeight`）。
- `List` 里 `ForEach` 的内容闭包在列表的 `body` 每次重算时对每个元素都执行一遍，只有闭包返回的子视图的 `body` 是按需求值的。每行要算的东西（时间、状态、副标题）写在行自己的 `View` 的 `body` 里，闭包只构造这个视图（`HomeView.swift` 的 `SessionRowLabel`）。改前每次重算 3000 行都把这些算一遍。
- 列表第一次定位之前，不向页面报告「离开底部」：那时它从顶部排起，报告出去会让页面在「阅读历史」和「贴底」之间切换一次，所有过程行的版本跟着变。

### 2.5 格式化器与正则是静态的

`DateFormatter`、`ISO8601DateFormatter`、`NumberFormatter`、`RelativeDateTimeFormatter`、`NSRegularExpression` 的构造比使用贵得多，而它们常在 `body` 里。写成 `static let` 或文件级常量；需要跟随语言时更新它的 `locale`，不新建。服务端时间统一用 `ServerTime.date`（带缓存）。`pnpm check:perf` 的 `formatterPerCall` 拦截新增的写法。

### 2.6 不在 UIKit 的布局或 KVO 回调里改滚动位置

在 `layoutSubviews`、`contentOffset` 的 KVO 或 `scrollViewDidScroll` 里同步设 `contentOffset`，会让 UIKit 再布局一次，再触发回调。改到 `DispatchQueue.main.async`，并合并同一轮里的多次请求。日志里出现 `stuck in an update/layout feedback loop`，就是这类问题。

- 设置页首次打开时，搜索框折叠在 KVO 里同步吸附到顶，触发反馈循环，主线程卡 1.5 s。改为布局结束后合并吸附一次（`RiffetControls.swift` 的 `snapAfterLayout`），降到 0.25–0.33 s。

### 2.7 计时器和动画只在需要时运行

倒计时、相对时间、轮询只在可见且还有意义时运行：用 `.task(id:)` 绑定到它依赖的值，条件不再成立就结束循环；页面消失时 `.task` 自动取消。

- 审批卡片的倒计时在只读、已过期时仍每秒触发一次（`InteractionCard.swift`）。

### 2.8 失败要退避，流要能重连

请求失败后按指数退避再试，不按固定间隔轮询。长连接的流结束后重新加载、重新订阅，同样退避。

- 服务状态页失败后仍每 5 秒请求一次；改为失败时翻倍，最多 60 秒（`ServiceStatusView.swift`）。
- Git 面板的变更流断开后不再恢复；改为从 1 秒翻倍到 30 秒地重连（`GitPanelModel.swift` 的 `watch`）。

### 2.9 图片在后台按显示尺寸解码

图片用 `ConversationImageDecoder.decode(_:maximumPixelSize:)` 在 `Task.detached` 里解码，尺寸取自 `BudgetsKt`（`IMAGE_DISPLAY_EDGE_PX_PHONE`）或显示尺寸，不用 `UIImage(data:)` 在主线程上解出原图。

- 头像在主线程上解出原图（`OwnerAvatar.swift`）；刚上传的图片在列表里再从网络取一遍缩略图。改为后台按 300 px 解码头像；上传成功后从本地文件解出 160 px 的缩略图存进缓存（`Drafts.swift` 的 `uploadPending`）。
- 转录里的图片原来按 2048 px 解码，查看器直接放大这张位图。现在行内按 1080 px（`ConversationImageDecoder.displayEdge`）；查看器先显示它，再自己取一次原始数据，按最长 4096 px 解码后替换（`ConversationMarkdown.swift` 的 `ConversationImageViewer`）。
- 附件的内容不会变，下载后存进磁盘缓存，下次启动不再下载（`ResourceClient.swift`，上限 `IMAGE_CACHE.phone.diskBytes`）；失败的响应从缓存里删掉，不会被重放。项目文件会在同一地址下变化，不进磁盘缓存。

### 2.10 推入的页面声明自己的标签栏

`TabView` 里推入的页面要声明标签栏是否显示，用 `PushedPageTabBar`（`HomeView.swift`）：窄屏隐藏，宽屏保留。不声明时标签栏会盖住页面底部的控件。

- 终端页的按键行被标签栏盖住；文件、改动页同样（`NewTaskView.swift`）。

### 2.11 重量级视图共用或复用，不按行新建

WKWebView、`UITextView` 这类视图的创建本身就贵。同类内容共用一个渲染器，产出图片或文本附件；必须按行持有的，离开时放回池里给下一行用。

- 每个块公式各建一个 WKWebView。改为和行内公式共用一个渲染器，产出图片（`ConversationWebContent.swift` 的 `ConversationMath`）；渲染器画不了的才退回独立页面。
- 段落的 `UITextView` 每次新建：打开长会话时创建花了 384 ms，排版只要 177 ms。改为离开时放回一个最多 48 个的池，内存警告时清空（`ConversationRendering.swift` 的 `ConversationParagraphTextView.recycle`）。

### 2.12 量的时候不挂 XCTest

XCTest 一挂到 App 上，无障碍自动化就一直开着，长转录上每帧多出约 40 ms 的工作，滑动和打字的结论全部失真。量帧、量卡顿用 App 自己的 `StallMonitor` 和 `PerfProbe`（§3），由 `pnpm perf:ios` 驱动；UI 测试只用来验证行为。Instruments 的 `xctrace` 在模拟器上处理录制时会卡住，主线程热点用 `sample`。

### 2.13 Kotlin 来的字符串先转成原生字符串，再做键

共享层的 `String` 到 Swift 是桥接的 `NSString`。对它求哈希或比较相等，Swift 要逐字符取出并做 Unicode 规范化，比原生字符串慢一到两个数量级。每次更新都要查的字典、集合，键先复制成原生字符串（`ConversationRenderPlan.swift` 的 `nativeKey`，用 `utf8String` 整段复制，`makeContiguousUTF8` 是逐个标量复制）；能不查的就不查。

- 进行中的会话每次更新都按行 id 查行缓存、速度表和审批记录，id 都是 Kotlin 的行键：约 1000 行时每次更新约 12 ms 花在哈希上。渲染计划改为每行复制一次原生键；速度表的键同样先复制；过程行的展开状态只在有过程刚停下的那一轮才按键查。转录每次更新的主线程时间从每 8 秒 490 ms 降到 189 ms。

## 3. 测量

需要 Xcode 和一台已启动的模拟器；`RIFFET_SIMULATOR_ID` 指定模拟器，默认取已启动的那台。

### 3.1 构建

```bash
cd apps/mobile/iosApp
xcodebuild -project Riffet.xcodeproj -scheme Riffet -configuration Debug \
  -destination 'platform=iOS Simulator,id=<模拟器>' -derivedDataPath /tmp/riffet-ios-dd \
  CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- -skipPackagePluginValidation -skipMacroValidation build
xcrun simctl install <模拟器> /tmp/riffet-ios-dd/Build/Products/Debug-iphonesimulator/Riffet.app
```

要用临时签名（`CODE_SIGN_IDENTITY=-`）：不签名时钥匙串读取失败（`-34018`），App 连不上服务器。`PerfProbe` 只在 Debug 构建里。

### 3.2 数据、卡顿、滑动与采样

```bash
pnpm perf:ios seed /tmp/riffet-perf --server http://127.0.0.1:4399   # 与 Android 同一份数据
pnpm perf:ios launch --open <会话 id>                                 # 重启 App，记下超过 17 ms 的段，打开会话
pnpm perf:ios open <会话 id>                                          # 在运行中的 App 里打开会话，汇总之后 6 秒的卡顿
pnpm perf:ios type 150,60                                             # 往屏幕上的输入框打 150 个字，每 60 ms 一个
pnpm perf:ios stalls 10                                               # 10 秒内操作 App，汇总卡顿
pnpm perf:ios history                                                 # 把屏幕上的会话的更早历史全部读完，滑动才经过没见过的行
pnpm perf:ios scroll 1500,3000,2 9000,12000,1                         # 匀速滑动屏幕中央的列表：速度、距离、来回次数
pnpm perf:ios sample 8 ConversationView                               # 采样主线程 8 秒，按包含时间列出 App 的帧
```

- 服务端以 `CLAUDE_CONFIG_DIR=<目录>/claude RIFFET_ENV_KEEP=CLAUDE_CONFIG_DIR` 和 `--no-auth` 启动，不碰正式服务，不调用任何 Agent。往转录文件里追加行，服务端会实时读到，可以模拟进行中的会话。
- `StallMonitor` 一直在运行（前台时），超过 100 ms 的段计入上报的 `hitches`；`-riffet.perf.stallMs <毫秒>` 让这一次启动把更短的段也写进统一日志（类别 `perf`）。
- `scroll` 由 `PerfProbe` 用 `CADisplayLink` 每帧移动滚动位置，输出帧数、迟到帧、丢帧、p95 与最长间隔。它滑的是屏幕中央的手指会拖动的那个滚动视图。迟到和丢帧按屏幕的刷新间隔算。
- 滑转录前先跑 `history`：只加载了最近一页时，滑动到顶就停，经过的行都已量过，测不出一行第一次进屏的成本（第四轮之前的「长转录」场景就是这样漏掉的）。首次滑过和再次滑过各量一遍：后者是格子复用的成本。
- `open` 和 `type` 同样经 `PerfProbe` 在 App 里完成。不要用 `simctl openurl` 打开 `riffet://` 链接：模拟器会弹出系统确认框，App 停在后面，量到的是空闲。`launch --open` 量到的包含启动本身，比较打开会话时用 `open`。
- 看到某个函数占比高，用 `sample` 的完整输出（`sample <pid> 8 1 -file <文件>`）看它的调用方和子调用。

### 2.14 音频会话和录音引擎不在主线程上启停

`AVAudioSession` 的 `setCategory`、`setActive` 和 `AVAudioEngine` 的 `start` 是同步调用，在真机上要 130–240 ms，蓝牙耳机切到通话模式时更久。放在主线程上，按下后要等它们返回浮层才出现。启停放进同一个串行队列（`Platform/DictationMicrophone.swift` 的 `audio`），停止的关闭排在下一次开始的激活前面；回调里只用加锁的状态和线程安全的接收方。

### 2.15 屏幕底部的按压不用 SwiftUI 手势

靠近屏幕底边时，系统要先排除上滑回主屏，才把触摸交给 SwiftUI 手势：真机上按下约 0.8 s 后 `DragGesture` 才开始，更短的按压收不到；模拟器的触摸不经过这一步，测不出来。挂在视图上的 UIKit 手势识别器不受影响，按下 20–30 ms 内就收到。贴底的按住类控件（按住说话）用 `UIGestureRecognizerRepresentable` 接一个自己的识别器（`Design/RiffetVoiceHold.swift` 的 `RiffetHoldPress`）；`defersSystemGestures(on: .bottom)` 只能让部分按压提前，而且改了回主屏的手势，不用。

### 2.16 转录行在后台排好，格子只摆放

长回答是一个格子，高 1000–1500 pt。格子用 `UIHostingConfiguration` 承载 SwiftUI 时，它第一次进屏、以及之后每次被复用来显示它，SwiftUI 都要建整棵视图树、为每段新建 `UITextView` 并排版、量整行的高：一条 1086 pt 的回答首次量高 12 ms，1456 pt 的 26 ms，加上建视图，每条进屏就是一段 30–45 ms 的卡顿。记住的行高只省掉了量高这一步，第二次滑过同一段历史仍然卡（10 次，最长 43 ms）。

- 正文（回答的段落、标题、列表、引用）在后台队列上解析、生成富文本、用 TextKit 1 排版并量高（`TranscriptProse`，排版用与 Mac 共用的 `TextLayout`），结果按行的版本和宽度缓存；列表在格子进屏前就拿到行高，格子只把排好的片段摆上去、直接画字形，不再经 SwiftUI。
- 一行里只为可见区附近的片段建视图，滑出去的片段视图放回池里；再长的回答，每帧的成本也只与屏幕上的部分成正比。可见区不只在滚动时变：上方的行定下高度后，这一行被挪动而列表没有滚动，所以格子在每次被摆放时（`apply(_:)` 拿到新的布局属性）也要按列表的边界重算；只在滚动和 `willDisplay` 里算，重开会话时贴底的几行会一直是空白。
- 代码块同样在后台排好（不换行，高度精确），格子里由原生视图画：标题栏、块内双向滚动、展开与收起；画布只盖住块内可见的那一片，再宽再长的代码也不会有超过视口的图层。语法高亮先查高亮器的缓存，没有就先画无色的，高亮完再在后台重排这一行。
- 能预览的代码块（图表、HTML、SVG、Markdown）、表格、公式、图片各自由一个小的 SwiftUI 片段承载，只在接近屏幕时才建，高度先用记住的值，变了再更新这一行。
- 选中文字：正文和代码默认只绘制；长按时这一块原地换成复用池里的 `UITextView`，内容是同一份富文本，系统的选择手柄、放大镜和「引用」都在。
- 解析、富文本和排版都不在主线程上做；后台队列上不建 UIKit 视图，只用 TextKit 1、`UIFont`、`UIColor` 和图片这些线程安全的类型。排好的 `TextLayout` 交给主线程后只由主线程读，需要的度量（高度、查找标记、是否有链接）在后台一次读好。

实测（模拟器，491 行的会话读完全部 503 行历史后）：程序滑动 3000 与 9000 pt/s 各一趟，没有迟到的帧、没有超过 17 ms 的卡顿（改前首次滑过 12 次、最长 46 ms，再次滑过 10 次、最长 43 ms）；手指快滑十次，卡顿从 14 次、合计 588 ms、最长 79 ms 降到 0–4 次、合计不超过 85 ms、最长 28 ms。

### 2.17 滑动中不建 WKWebView，预览先出图

图表（mermaid、dot、plantuml 等）和 HTML、SVG 代码块默认显示预览，原来每块新建一个带独立配置的 WKWebView，在滑动中进屏就当场建。现在共用一个离屏渲染器排队渲染并截图，按源码、主题和宽度缓存图片、记住尺寸；转录里只放图片，点开才是可交互的页面（与 Mac 的 `MermaidRenderer` 同一做法）。

### 2.18 列表行里不放 SwiftUI `Menu`

SwiftUI 的 `Menu` 在行建好时就生成整个菜单，并按名字到资源目录里解析每个菜单项的 SF Symbol；每条回答下方都有一个，每次进屏都查一遍（采样里约占 5%）。行里的菜单用点开时才构建的 UIKit 菜单（`UIDeferredMenuElement`，见 `RiffetDeferredMenuButton`）。Mac 的工具栏菜单因为同样的原因改过（[MACOS.md](../MACOS.md)「2026-10-14 实测」）。

### 2.19 不另起逐帧的滚动监听

每条回答的复制反馈（`ConversationFeedbackProbe`）原来常驻在行里，监听转录的 `contentOffset`，每帧为每条可见回答派发一次可见性计算。现在它只在复制后显示对勾的两秒里挂上，KVO 回调合并到下一次主线程循环。要跟随滚动的东西，只在需要的那段时间里监听，回调合并后再算；能由列表的 `scheduleCallbacks` 一次算出的，交给列表。

## 4. 场景回归清单

改动涉及下列任一页面时，跑对应场景，结果写进 PR 描述。

| 场景 | 操作 | 通过 |
|---|---|---|
| 任务列表 | 3000 个会话；`scroll 1500,3000,2` 与 `scroll 9000,12000,1` | §1 滑动预算 |
| 长转录 | `open` 491 行以上的会话；`history` 读完全部历史；`scroll 3000,9000,1` 首次与再次滑过各一遍；慢滑、快滑 | 打开单段 ≤ 100 ms；滑动预算；不跳动 |
| 图表与表格 | 快滑经过含 mermaid、公式、表格的回答 | 滑动中不建 WKWebView；停下后出图 |
| 大编辑与长输出 | 展开大编辑、6000 行输出 | 单次展开 ≤ 50 ms；块内滑动符合预算 |
| 图片 | 展开成组截图，打开查看器，缩放，平移，保存 | 解码不在主线程 |
| 输入与附件 | `type 150,60`，空草稿和 1000 字的草稿各一次；输入 `@` 和 `/`；添加 3 张照片 | 每次按键 ≤ 16 ms，不随草稿长度变慢；上传中可继续输入 |
| 语音输入 | 真机上，冷启动后在发过消息的会话里第一次按住说话；在助理页和会话页（输入框贴底）快按、长按各三次 | 按下当帧出现浮层，松开即转写；不闪退 |
| 进行中的会话 | 每 0.5 秒追加一轮，持续 10 秒 | 单段 ≤ 50 ms；没变的行不重建 |
| 发送 | 用真实 Agent 新建任务，再在会话里连发两条，等流式回复结束 | 发出后立刻出现待发送的行；流式期间单段 ≤ 50 ms |
| 终端、文件、Git | 打开 shell，输出 20 万行；打开文件、改动 | 按键行不被遮挡；单段 ≤ 50 ms |
| 设置与统计 | 逐个打开子页并上下滑；切换统计的范围与筛选 | 日志里没有 `feedback loop`；单段 ≤ 50 ms |
| 断线与恢复 | 停掉服务 30 秒，再启动；切到后台再回来 | §1 断线预算；恢复后数据补齐 |
| 冷启动 | `pnpm perf:ios launch` 三次 | 首屏前单段 ≤ 100 ms |

## 5. 检查

- `pnpm check:perf`：缓存上限、流队列（[performance.md](performance.md) §3），以及本文的 `formatterPerCall`（§2.5）和 `standardDefaults`（§2.2）。确实要破例的，在该行或上一行写 `perf-rules: allow <原因>`。
- `scripts/stack-report.py`：SwiftUI 改动后主线程的栈（[iOS](../design/system/ios.md) §2.0）。
- 代码审查时按 §2 逐条看：新出现的「随内容增长的工作」在哪个线程上，`body` 读了哪些值，派生值按什么缓存，滚动位置在哪里改，计时器何时停，失败后多久再试。

## 6. 现状

与规则不符的现有代码。改掉哪条就删哪条；新留下的不一致也记进来。

- §1：打开会话最长一段仍超过 100 ms：从列表打开 146–244 ms，冷打开（服务端派生缓存和 App 的转录缓存都清掉）135–201 ms，合计 0.3–0.45 s。剩下的主要在 SwiftUI 推入页面和转录列表首次布局里，不在 App 自己的代码里。
- §2.4：进行中的会话每次更新，`transcriptRows`、`applyLatestRows` 和快照 diff 仍按全部行走一遍，只是每行的开销已降到查一次原生字符串的字典；约 1400 行、每 0.5 秒追加 4 行时，10 秒内卡顿合计约 1.1 s，最长一段 50 ms 左右。要降到与新行成正比，需要表现层给出变化的行。真实 Agent 一次 42 秒的流式回复，卡顿合计约 1.0 s，最长一段 125 ms。
- §1：3000 个会话的列表在 9000 pt/s 快滑时，4–12% 的帧迟到一帧，每段卡顿 17–21 ms（改前合计 1.4 s，最长一段 108 ms）；1500 与 4500 pt/s 时一趟里迟到 0–1 帧。时间在 SwiftUI `List` 的行自适应高度里。
- §2.16：读历史时仍会卡：读完 16 页（503 行）有 21–31 次卡顿，最长一段在 61–250 ms 之间、波动大，装完首次启动就读还出现过 962 ms（改前 26–28 次，最长 108–144 ms）。没有定位，先用 `sample` 看应用快照和行高失效。
- §2.16：转录里仍由 SwiftUI 承载的行：用户消息（带 `.contextMenu`）、回合的过程标题和工具行、能预览的代码块、表格、公式、图片；它们进屏仍要建 SwiftUI 视图树，单行 5–18 ms。
- §2.17：离屏渲染器的 WKWebView 在第一次需要预览图时才建，这一次约 10 ms。
- §2.1：没复现出冷打开时分批应用快照、反复整表量高。清掉两端缓存后打开三个长会话，各只有一段超过 100 ms；如再遇到，先看 `applyLatestRows` 被调用的次数。
