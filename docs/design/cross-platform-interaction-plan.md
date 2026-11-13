# Riffet 四端交互优化方案

日期：2026-11-12。范围：iOS 原生客户端、Android Compose、macOS 原生客户端、Web。依据当前工作区与 Astryx 源码；优先级和交互规则是本方案建议，现有行为以文中的代码证据为准。

优化重点是输入长材料、复用历史指令、查找会话和阅读混合内容。先修正搜索范围的一致性，再补输入历史与阅读宽度；长文本折叠在草稿、撤销和发送规则确定后推进。引用、目录、选择器和操作反馈沿用现有组件逐项改善。

方案参考 Astryx 的交互行为和设计方法，保持 Riffet 的原生组件、已有依赖与设计语言。现行约束见 [设计决定](DECISIONS.md)、[输入框](../COMPOSER.md)、[主题契约](../THEMES.md)。正文近无彩、原生主区满铺、输入框自身磨砂、设置页原有分类与输入框入口规则继续适用。图标按当前各端配置使用；Web 为 Lucide，Mac 默认 SF Symbols。

## 四端现状与工作重点

| 方向 | Web | macOS | iOS | Android |
| --- | --- | --- | --- | --- |
| 长文本输入 | textarea，原生文本粘贴与撤销；没有局部折叠 | 纯文本 NSTextView，原生撤销；没有局部折叠 | 多行 TextField 与展开 TextEditor；没有粘贴块 | BasicTextField 与 TextFieldValue；没有粘贴块 |
| 历史召回 | 未发现已提交消息召回 | 未发现已提交消息召回 | 有硬件键盘发送，未发现历史召回 | 有硬件键盘处理，未发现历史召回 |
| 搜索 | 标题／正文、单会话范围；正文走服务端索引 | 本机缓存与服务端正文结果合并；已有侧栏筛选 | 项目／状态／标签筛选；正文另进缓存搜索 | 已有项目／状态筛选与缓存正文搜索；两类结果范围不一致 |
| 阅读宽度 | 会话列可拖宽，正文和代码共用外层上限 | 会话列可调，后台排版向各类块传入同一宽度 | 行宽上限 760pt，代码折叠，表格内滚动 | 时间线默认上限 840dp，代码／表格独立渲染 |
| 选择器 | 已有弹层、移动 sheet／全屏和焦点返回 | 锚定弹层、原生菜单和可调整面板 | 系统 sheet 与 NavigationStack | 统一 PickerSheetFrame，已避让键盘和安全区域 |
| 流式阅读 | 跟随、选区保护、阅读锚点、窗口化已存在 | 原生转录测量、锚点、选择和 AX 操作已存在 | 阅读锚点、惯性滚动保护、VoiceOver 滚动处理已存在 | 跟随、选区保护、键盘变化补偿和 Markdown 预准备已存在 |
| 第一批重点 | 历史召回、正文宽度、操作反馈 | 历史召回、正文排版、焦点归还 | 最近输入入口、键盘与预览、大字号和 VoiceOver | 搜索范围修正、最近输入、TalkBack 语义 |

这里的“未发现”限定于正式客户端相关输入链路。系统输入法听写不属于缺失能力。原生 iOS 使用 SwiftUI／UIKit，通过 Kotlin `:client` 复用业务逻辑；Android 的 Compose 界面修改不会自动进入 iOS。

## 输入历史召回

目标是复用刚发过的指令，同时保护正在编辑的草稿。第一版使用当前服务器、当前会话中服务端已登记的用户提交，按提交时间排列；同一个 command／run 只出现一次，相同正文的不同提交仍保留各自记录。执行可以尚未开始，但只有本地 Outbox 接管、尚未确认服务端登记的输入不进入历史。

先使用当前已加载的 run／会话数据与本次已确认提交，不为打开菜单额外启动 Agent 或创建历史服务。菜单说明其“本机已有记录”范围；尚未关联会话的新任务页不混用其他会话的输入。后续需要更早记录时，复用既有只读历史加载。

规则如下：

- 首次进入历史前，保留当前草稿的正文、附件、引用及编辑位置。选择历史只填入该条正文，不自动带回旧附件、文件引用或模型配置；退出历史时能恢复完整原草稿。
- 在历史正文上编辑不会改写原消息；发送仍是一次新提交。已有 Outbox 接管、失败恢复和发送期间继续编辑的规则继续适用。
- 普通上下键仅在输入为空，或光标已经位于完整文本起点／终点且没有选区时进入历史；不抢占视觉行内移动、Shift 扩选、修饰键、IME 组合和候选菜单。多行内容更快捷的召回使用菜单。
- 历史浏览期间保留“回到当前草稿”的操作；向下越过最新历史也回到原草稿。选择历史时暂存当前附件与引用，历史草稿明确呈现为空附件状态，避免无意发送当前附件。
- 切换服务器、会话或删除会话时清除对应历史浏览状态。未提交、提交前被拒绝、仅排定未来发送的内容不混入已发送历史。

暂存原草稿进入同一作用域的现有本地草稿记录，不能只放在视图 State 中。切会话、重载或后台恢复后仍可取回；发送召回内容只清理本次发送的输入，原草稿仍可恢复。正文替换和返回草稿需要可撤销，附件与引用的暂存恢复跟随同一操作。删除会话才删除该作用域的暂存草稿。

| 平台 | 实施方式 | 主要接缝 |
| --- | --- | --- |
| Web | 在现有候选菜单之后处理历史按键；已有输入菜单加入“最近输入”；保持 textarea | [Composer.tsx](../../apps/web/src/app/session/Composer.tsx)、[composerKeyboard.ts](../../apps/web/src/app/session/composerKeyboard.ts) |
| macOS | NSTextView 的命令委托先处理 marked text 和候选，再处理历史；正文替换走原生编辑事务 | [ComposerTextView.swift](../../apps/macos/Riffet/Features/Composer/ComposerTextView.swift)、[ComposerModel.swift](../../apps/macos/Riffet/Features/Composer/ComposerModel.swift) |
| iOS | 触屏通过现有加号菜单打开最近输入；iPad 外接键盘增加边界召回。先使用 iOS 18 已有的选择范围接口验证 | [ConversationComposer.swift](../../apps/mobile/iosApp/Riffet/Features/Conversation/ConversationComposer.swift)、[NewTaskView.swift](../../apps/mobile/iosApp/Riffet/Features/Home/NewTaskView.swift) |
| Android | 使用现有 TextFieldValue 的选区和 composition；触屏入口放输入菜单，硬件键盘走现有按键链 | [Composer.kt](../../apps/mobile/shared/src/commonMain/kotlin/riffet/ui/composer/Composer.kt)、[ComposerDrafts.kt](../../apps/mobile/shared/src/commonMain/kotlin/riffet/ui/composer/ComposerDrafts.kt) |

验收包括：输入未发草稿后往返历史、中文候选选择、多行与长行折行、选区扩展、历史文本修改、附件暂存恢复、发送失败，以及切服务器／会话后不出现另一范围的输入。历史中引用的文件名或命令只是原文，不能据此自动授予能力或恢复过期附件。

## 长文本粘贴与折叠

用户粘贴日志、代码或文档后，长材料占据一个可预览的折叠块，周围的指令继续编辑。点开预览不等于编辑；只有选择“展开编辑”才将材料恢复到原位置。触屏预览不自动升起键盘。

首轮原型可用“超过 12 个逻辑行，或超过 2000 个 Unicode 字符”作为候选阈值。这是待比较的起点，不是已经验证的最佳值。只对明确的粘贴操作触发，连续输入、系统听写和没有折叠信息的旧草稿不自动折叠；已有合法折叠信息随草稿恢复。图文混合粘贴保持现有文本与附件各自接收的语义。

### 草稿与发送规则

继续以完整原文为唯一正文来源，在各端现有草稿记录中增加可选的折叠范围信息。范围描述显示方式，不能承担唯一的原文存储职责。

1. 粘贴原文先进入正文；折叠只改变显示。提交仍读取完整正文，沿用原有发送规范化。折叠前后发送结果必须与普通粘贴一致，材料内部空白、顺序、代码围栏不变。
2. 折叠范围随编辑事务映射；编辑触及范围内部时展开该块。范围越界、版本不匹配或旧客户端不识别时显示完整原文，不能丢弃正文。
3. 范围使用明确的 UTF-16 偏移，与 JavaScript、Kotlin String、Swift NSRange 对齐；范围边界不得切开代理对，光标还要遵循平台字符簇规则。
4. 复制全文得到原文。删除折叠块是一次可撤销的正文删除；仅展开／折叠不制造一次文本修改。粘贴自成编辑事务，不能靠直接赋值假定撤销栈正确。
5. 折叠信息与正文一起持久化，沿用本机草稿存储和服务器／会话隔离。Outbox 只保存发送快照需要的完整输入；确认后仅清理该次提交拥有的正文 revision、附件和引用。
6. 预览、折叠摘要和原文编辑共用同一份材料；不上传临时“日志文件”来替代普通文本发送，也不将显示标签发给 Agent。

这些规则扩展现有 [Web 草稿与提交](../../apps/web/src/app/session/Composer.tsx)、[Mac Submission](../../apps/macos/Riffet/Features/Composer/ComposerModel.swift)、[iOS MessageDraft](../../apps/mobile/iosApp/Riffet/App/Drafts.swift) 和 [Android ComposerDraft](../../apps/mobile/shared/src/commonMain/kotlin/riffet/ui/composer/ComposerDrafts.kt)。各端本地格式可以不同，共享相同的恢复和发送行为。

### 各端实现选择

| 平台 | 已核实的能力 | 推荐实施路径 |
| --- | --- | --- |
| Web | 项目已有 CodeMirror。Decoration.replace 能以 widget 隐藏原文范围，atomicRanges 能调整光标跨越范围 | 先在现有全屏输入区域做局部原型，验证折叠、IME、原生粘贴、撤销和现有 @／斜杠行为。通过后才替换统一输入组件；不自建 contenteditable。textarea 保留到替代实现验收完成 |
| macOS | NSTextView 已开启 undo，原生文本系统支持附件和自定义布局；当前编辑器配置为纯文本 | 在原生编辑层验证显示投影与编辑事务。若使用 attachment，必须有原文序列化、选择和复制映射；优先共用原有 NSTextView 实例与输入委托 |
| iOS | 最低 iOS 18；SwiftUI TextField／TextEditor 已有选择范围接口，UIKit 有 paste delegate 与文本附件 | 先验证薄 UIKit 输入适配是否足以处理粘贴与折叠投影，保留现有 SwiftUI 宿主。不能把 iOS 26 的 attributed TextEditor 当作全部支持版本的实现 |
| Android | 当前 CMP 依赖已有 TextFieldState、InputTransformation、OutputTransformation 类型；现有输入仍用 TextFieldValue | 先验证 Android 实际依赖中的输入／输出变换、offset mapping、composition 和 undo。按能力选择文本形式的折叠投影或现有轨道中的预览入口，不为任意富文本 chip 重写编辑器 |

输入 API 的存在不等于四端已具备完整折叠编辑能力。这个功能的交付条件是上述数据语义与平台输入检查同时通过；未通过的实现不开启自动折叠，继续保留普通粘贴和全屏编辑。外置预览轨可以复用样式，但不能将原文静默移到末尾，改变材料与指令的顺序。

实现依据：[CodeMirror 官方 decorations 说明](https://github.com/codemirror/website/blob/main/site/examples/decoration/index.md)、[NSTextView](https://developer.apple.com/documentation/appkit/nstextview)、[UITextInput markedTextRange](https://developer.apple.com/documentation/uikit/uitextinput/markedtextrange)、[Compose 文本输入](https://developer.android.com/develop/ui/compose/text/user-input)。Web 的 [setRangeText](https://developer.mozilla.org/en-US/docs/Web/API/HTMLTextAreaElement/setRangeText) 能替换文本与设置选区，其接口说明没有提供跨浏览器撤销一致性保证，不能据此跳过编辑验证。

## 搜索条件与结果范围

### 先修正已有范围

Android 当前会话结果使用项目和状态筛选，正文查询则只将关键词传给本机索引，结果直接追加。相关链路在 [SessionList.kt](../../apps/mobile/shared/src/commonMain/kotlin/riffet/ui/sessionlist/SessionList.kt)、[SessionListModel.kt](../../apps/mobile/shared/src/commonMain/kotlin/riffet/ui/sessionlist/SessionListModel.kt)。当项目筛选显示为选中时，正文仍可能命中其他项目。

修正时先得到符合项目、状态、标签和客户端可见性要求的会话集合，再在该范围查询正文。条件必须在结果数量截断前生效；拿到前 50 条再过滤会遗漏后面的匹配。空集合表示没有匹配，不能回退为全范围。

iOS 的缓存正文搜索入口目前没有继承首页全部条件，应同时传递当前搜索范围。两端继续以本机已缓存内容为搜索对象。Mac 已合并本机与服务端命中；Web 使用服务端索引。这些覆盖范围不同，离线或索引未完成时不能显示成“全部历史已搜索”。

### 再增加可编辑条件

第一版条件保留关键词、项目、Agent、状态、标签与会话最近活动日期。不同字段之间取交集，同一字段多个值取并集。复用既有项目家族映射，选择主项目时仍包含它的 worktree 会话。快速会话和归档沿用现有可见性规则。

日期明确表示会话的“最近活动时间”；不能把它描述为“这段时间发送的消息”。用户按本机时区选日期，查询转换为 UTC 的起点包含、终点不包含区间，不能以每天固定 24 小时计算跨夏令时日期。若以后加入消息日期，另用清楚的字段名称。状态依据 [统一关注状态](../../packages/contracts/src/session-attention.ts) 与 Kotlin 对应规则，使用当前会话状态；未读不能另造一套含义。

当前本机索引按空白拆分关键词并要求全部包含，服务端正文检索使用整段子串。组合搜索实施时同步统一关键词语义：正文按空白分词、全部包含；短中文词仍按子串匹配。标题的既有模糊排序可以保留，但标题／正文模式应明确。首版不引入查询语言，条件通过控件编辑。

| 平台 | 展示方式 | 查询改动 |
| --- | --- | --- |
| Web | 现有搜索框继续直接输入；筛选入口展开条件，已用条件可删除；命令模式继续用原入口 | 扩展现有 search API 参数、请求取消、查询状态与缓存键 |
| macOS | 在 ⌘K／搜索面板内编辑条件，键盘可以遍历和移除；保留命令范围 | 本机与服务端用同一条件，先各自筛选再合并去重 |
| iOS | 复用首页项目／状态／标签入口，补 Agent 和日期；缓存正文页带入条件 | 将条件传到 KMP 本机搜索，明确缓存覆盖范围 |
| Android | 修正标题和正文范围，再在已有筛选面板内补条件 | 扩展索引查询边界，禁止在截断后过滤；条件变化取消旧查询 |

服务端复用 [workspace.ts 搜索路由](../../apps/server/src/routes/workspace.ts)、[store.ts 查询](../../apps/server/src/store.ts) 与现有消息索引；本机复用 [TranscriptIndex](../../apps/mobile/client/src/commonMain/kotlin/riffet/cache/TranscriptIndex.kt)、[TimelineCache](../../apps/mobile/client/src/commonMain/kotlin/riffet/cache/TimelineCache.kt) 和平台索引实现。新增可选过滤参数，不另起搜索服务。

查询条件包含在请求、取消身份和结果键中。服务端 prompts、indexed messages、待索引计数和后台补索引使用一致的会话范围；仍只读允许安全读取的后端。离线结果与在线结果合并时，消息身份去重保持原有规则。新客户端连接不支持条件的旧服务端时，使用明确的能力判断；不发送会被静默忽略的条件并展示为完整结果。

验收用包含多个项目、worktree、Agent、归档和待处理会话的数据，确保符合条件的较旧命中不会被条件外的新命中挤掉；核对空范围、日期边界、切换服务器、慢请求回写、离线结果与后台索引补齐。复用现有搜索与隔离核心测试扩展最少代表场景。

## 正文宽度与长回答导航

### 分开控制阅读行长

保留现有会话外层列宽，在其中给段落、标题和列表正文增加舒适行长上限；代码、表格和预览可使用外层可用宽度。所有块保持共同的左对齐基准。短手机屏幕使用当前可用宽度，不加卡片或多一层左右边距。

Web 原型可比较 60～75 个拉丁字符或约 30～40 个全角字符的行长。原生端按字体度量和实际窗口验证，不直接把 CSS ch 换算成固定 dp／pt。字号改变会重新计算，避免文字变大以后反而变成极短的一列。

| 平台 | 实施范围 | 必须保持的行为 |
| --- | --- | --- |
| Web | [Markdown.tsx](../../apps/web/src/app/session/Markdown.tsx) 的块分类与 [index.css](../../apps/web/src/styles/index.css) 的列宽规则 | 外层拖宽仍控制代码／表格；标题、搜索定位、选区、收藏与嵌套列表不漂移 |
| macOS | [TranscriptLayout.swift](../../apps/macos/Riffet/Features/Transcript/TranscriptLayout.swift) 在 prose、code、table 排版入口分别取宽度 | 宽度进入后台测量与缓存键，首帧就有最终高度；拖动侧栏和检查器后保留阅读位置 |
| iOS | [ConversationMarkdown.swift](../../apps/mobile/iosApp/Riffet/Features/Conversation/ConversationMarkdown.swift) 与 [ConversationTranscriptList.swift](../../apps/mobile/iosApp/Riffet/Features/Conversation/ConversationTranscriptList.swift) | iPhone 满宽；iPad 按剩余窗口宽度区分正文和代码；Dynamic Type、代码展开和表格内滚动有效 |
| Android | [ProseBlocks.kt](../../apps/mobile/shared/src/commonMain/kotlin/riffet/ui/timeline/ProseBlocks.kt) 与 [MarkdownRender.kt](../../apps/mobile/shared/src/commonMain/kotlin/riffet/ui/timeline/MarkdownRender.kt) | 使用双栏或铰链分区后的剩余宽度；沿用 presenter prepare，不在行显示后改变解析与行高 |

列表或引用中的代码使用该容器扣除缩进后的宽度，不穿过父容器；表格横向滚动由现有表格容器负责，页面不横滚。动态内容仍交给现有滚动所有者处理，不引入另一套弹簧跟随。

### 复用解析结果提供目录和来源

Web 已从实际 Markdown 渲染维护标题索引；Mac 已有原文及章节导航。iOS 的“会话目录”目前主要列提问摘要，可以在现有入口里增加当前长回答的标题。Android 可复用 Markdown AST 在回答菜单提供目录，并为标题增加 TalkBack heading 语义。

目录目标使用消息身份、正文 revision 和解析源位置，处理重复标题、代码围栏里的井号及流式未完成标题。跳转沿用已有虚拟列表定位和阅读锚点，不用标题文字全局搜索。普通短回答不显示多余目录入口。

外部来源引用放在后续批次。只有后端给出明确来源元数据时才渲染编号或来源标题；普通 Markdown 链接继续是链接。首版可消费后端已经提供的来源信息；缺少来源身份、URL 或文本关联时不推断来源。

实现前先核查当前各后端输出和契约，优先复用已有结构；必要时添加可选的消息级来源元数据。来源缺失时回退为可读文本或普通链接。文件路径继续使用现有文件导航，不能和网络来源统一改成外部链接。复制、搜索和收藏仍映射到同一份源内容，装饰用编号不能污染原文定位。

## 选择器和大屏布局

选择器内容与宿主分开，复用同一份选项、搜索结果、当前选择和滚动状态。改变窗口或输入方式只改变呈现，不重建草稿或重复创建有状态列表。

| 场景 | 建议行为 |
| --- | --- |
| iPhone | 保留系统 sheet；预览默认不自动聚焦文本，只有用户进入编辑才弹出键盘 |
| iPad | 小窗口继续 sheet；有足够空间且存在稳定锚点时使用 popover；键盘与指针操作均可完成选择 |
| Android 手机 | 保留现有 PickerSheetFrame；返回先关闭内层选项／参数，再关闭面板；IME 避让由现有宿主统一处理 |
| Android Pad 和展开屏 | 基于可用窗口、铰链和实际输入方式选择锚定弹层或面板，不按设备名称判断；两个宿主共用一个列表调用点 |
| Mac | 保留锚定弹层和原生菜单；面板隐藏时焦点回到可见入口，拖动与键盘／辅助技术调整都可用 |
| Web | 复用现有 mobileSheet／mobileFullscreen 与 Radix 弹层；触摸、鼠标和窄横屏使用相同内容，保持嵌套 Escape 和焦点返回 |

现有实现已覆盖相当部分安全区域与键盘问题，验收发现具体缺口后再改。iOS 的系统键盘布局可参考 [UIKeyboardLayoutGuide](https://developer.apple.com/documentation/uikit/uikeyboardlayoutguide)，不以新增一组键盘高度 State 作为默认方案。

## 操作反馈和辅助技术

区分提交锁定与反馈显示。点击后立即阻止重复副作用；转圈可以延迟出现，快速完成的操作无需闪一次。Web 已有 WAIT_GRACE_MS 和 useLingering，先复用适当场景；按钮与加载占位保持尺寸。原生端先复用现有反馈宿主，不为所有按钮引入第二套异步执行框架。

输入框在运行、上传或网络重连时保持可编辑；只限制确实不可执行的操作。发送、停止、排队和重试继续走现有业务状态与 Outbox，不由新按钮组件自行重试或取消业务。

| 平台 | 具体优化 | 验收方法 |
| --- | --- | --- |
| Web | 当前转录已有 aria-busy，但不能据此假定完成消息会自动播报。补必要的独立完成／失败状态区域；校准忙碌按钮焦点与重复触发 | 键盘完整操作；VoiceOver／NVDA 核查流式与完成播报、菜单返回、错误后重试 |
| macOS | 现有 AX 文本和自定义动作继续使用；面板、对话框和删除附件后返回可见焦点；按需要播报重要结束状态 | VoiceOver 导航、复制、折叠、发送失败和多窗口切换 |
| iOS | 复用已有 44pt 发送命中区、Dynamic Type 和加载占位；预览不抢焦点，完成与错误按平台方式播报 | VoiceOver、大字号、外接键盘、横竖屏与系统听写 |
| Android | 为自绘面板增加 paneTitle、折叠控件增加 stateDescription、Markdown 标题增加 heading；重要结果用低频 liveRegion | TalkBack、外接键盘、大字体、IME 和面板返回；复用已有至少 48dp 控件命中保护 |

流式正文和倒计时不设高频通知。完成事件以稳定消息／run 身份去重，不在重连、历史加载或切回会话时重播整段。用户正在阅读其他消息时不抢读、也不自动改变焦点。状态信息通过辅助技术语义提供，不为正常状态增加常驻解释文案。

参考：[Android 语义](https://developer.android.com/develop/ui/compose/accessibility/semantics)、[Android 默认可访问性](https://developer.android.com/develop/ui/compose/accessibility/api-defaults)、[Apple 可访问性](https://developer.apple.com/design/human-interface-guidelines/accessibility)、[Dynamic Type](https://developer.apple.com/documentation/uikit/scaling-fonts-automatically)。这些 API 和规范支持实现选择，不能代替真机上的朗读与操作验收。

## 设计关系与组件资料

在已有 [主题契约](../THEMES.md)、[Mac 设计](macos-native.md) 和 [界面风格样例](interface-styles/index.html) 中补充组件适用场景、状态行为和现有实现入口。资料紧邻当前规则，不新建独立设计系统包或通用设计 CLI。

每次修改用一个真实界面同时检查默认、聚焦、按下、加载、失败和禁用状态：同组控件高度是否协调，分组间距是否大于组内间距，嵌套圆角是否相互协调，加载是否挤动文字，深浅主题与大字号是否仍然可读。

Web 继续使用现有 tokens；Mac 继续使用 Space／Motion 与原生／自绘配方；Android 继续使用 DesignMetrics 和 prepare 约束；iOS 继续使用 RiffetDesign 与动态字号。界面风格的差异体现在已有组件范式中，不增加一组只改变几个参数的风格。

工具调用摘要可在实际页面比较“当前操作是否足够清楚”，但四端已有分组、折叠和稳定行身份，不以重写分组为本轮前置任务。字号、圆角、状态和主题的检查使用已有脚本，实际设计判断用渲染结果，不新增长期维护的 UI 快照测试。

## 听写的后续范围

四端先验证系统听写输入后的编辑、撤销、候选确认和发送。原生输入可继续使用系统能力；Web SpeechRecognition 浏览器覆盖有限，部分浏览器会把音频交给在线服务，不能当作四端统一离线语音能力。

如果后续确定需要应用内听写，再单独定义未确认转写、已确认正文、停止、取消与中断恢复；录音仅由用户操作开始，暂态文字不自动发送。入口优先放现有输入菜单，常驻入口仍遵守默认关闭的设计决定。处理位置、权限或计费信息各用必要的一句话说明。[Web SpeechRecognition 边界](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition)

## 实施顺序与依赖

工作量是相对改动范围，不是工期承诺。小表示单端局部修改；中表示跨模块或多端同步；大表示涉及输入内核或数据契约。

| 批次 | 工作 | 端与顺序 | 依赖与完成条件 | 范围 |
| --- | --- | --- | --- | --- |
| 第一批 | 搜索范围一致性 | Android 先修正文范围，iOS 继承首页条件；共享本机索引一起改 | 筛选在 LIMIT 前，空范围正确，旧查询不回写；不扩大缓存搜索覆盖承诺 | 中 |
| 第一批 | 输入历史召回 | Web／Mac 先做；iOS／Android 补菜单与外接键盘 | 当前草稿往返不丢；不误召回附件；保持 IME、原生按键和提交幂等 | 中 |
| 第一批 | 正文与宽内容分开排版 | Web／Mac 先比较，iPad／Android 宽窗跟进 | 使用现有列宽和测量缓存；旧行稳定，定位和选择不变 | 中 |
| 第一批 | 焦点、加载和辅助技术 | 各端随受影响控件一起改善 | 复用已有语义，按实际问题补充；不逐 token 播报 | 小至中 |
| 第二批 | 长文本折叠 | 先确定草稿语义，四端分别做最小输入原型，再进入正式输入 | 复制／撤销／恢复／发送一致；旧草稿可读；未过验收不自动折叠 | 大 |
| 第二批 | Agent／日期等组合搜索 | 共享查询规则先完成，再扩展四端界面 | 本机／服务端规则和取消键一致，旧服务端能力可判断 | 中至大 |
| 第三批 | 回答目录与来源 | iOS／Android 补目录；四端按真实后端来源数据增加引用 | 共用解析位置；重复标题稳定；来源缺失有普通链接回退 | 中 |
| 第三批 | 大屏选择器 | iPad、Android Pad／折叠屏、触屏 Web | 复用同一状态与内容，实际窗宽／指针／键盘验证通过 | 中 |
| 贯穿 | 设计关系与资料 | 随对应组件修改 | 现有文档记录规则、反例与入口；使用真实界面验收 | 小 |
| 后续 | 应用内听写 | 先验证系统能力，再确定产品范围 | 识别服务、权限、音频处理位置和中断规则明确 | 另行评估 |

首轮实施可拆为四个可独立 review 的改动：搜索范围修正；Web／Mac 历史召回；正文排版；受影响控件的焦点与语义。原生端与 Web 可以并行，涉及 KMP 索引或共享契约的改动由一个任务先完成，避免多个端各自定义查询含义。

## 验证与交付标准

### 核心行为

自动化验证只覆盖数据和副作用风险，优先扩展现有用例：

- 草稿：旧格式恢复、折叠信息损坏时原文仍在、保存失败、应用重启、服务器隔离、发送期间继续编辑。
- 提交：完整原文一致、相同 command 不重复发送、Outbox 接管后的清理归属、失败后可恢复。
- 搜索：范围在截断前生效、空集合、日期边界、关键词规则、客户端可见性、本机与服务端合并、取消旧请求和索引恢复。
- 来源若扩展契约：可选字段兼容、未知字段回退、来源与原消息身份关联。

现有入口包括 [服务端搜索测试](../../apps/server/src/search/index.test.ts)、[搜索路由测试](../../apps/server/src/app.test.ts)、[Android 草稿测试](../../apps/mobile/shared/src/commonTest/kotlin/riffet/ui/composer/ComposerDraftsTest.kt) 和 [iOS 草稿耐久测试](../../apps/mobile/iosApp/RiffetTests/DraftDurabilityTests.swift)。选择受影响测试运行，不把历史测试数量作为本次覆盖承诺。

### 各端实际检查

| 平台 | 场景 |
| --- | --- |
| Web | Chromium、Safari、Firefox；Windows／macOS 键盘；iOS Safari 与 Android Chrome；中文／日文 IME、缩放、混合粘贴、刷新恢复 |
| macOS | 主窗口与独立会话窗口；原生和自绘风格；NSTextView 撤销、系统听写、VoiceOver、拖动列宽与检查器 |
| iOS | iPhone 竖横屏、iPad 全宽和窄分屏；最低支持系统与当前系统；外接键盘、Dynamic Type、VoiceOver、后台后恢复 |
| Android | 手机、Pad、折叠屏两种姿态与分屏；Gboard 与至少一种中文输入法；硬件键盘、TalkBack、字体放大、Activity 重建 |

阅读样本包含长中文、英文、混排、列表里的代码、宽表格、重复标题、未闭合围栏和持续输出。输入样本包含多次粘贴、替换选区、emoji 字符簇、CRLF、图文混合与超出正常长度的日志。

比较优化前后的完成步骤、误操作、阅读跳动、漏结果和内容损失，不预设百分比收益。纯 UI 修改使用类型检查／编译与按需实际界面检查，不新增 UI 展示、截图、布局或文案测试。浏览器控制只在明确请求时使用。

Web／Server 使用受影响核心测试、typecheck 与必要构建；Android 使用受影响的 client／shared 核心测试、check:compose 与 Debug 编译；Mac 使用 Debug 编译、现有 perf-lint 和本地化检查；iOS 按 [正式工程验证说明](../../apps/mobile/iosApp/README.md) 编译，并在涉及草稿时运行现有耐久测试。改动 theme 或契约时才运行对应生成一致性检查。

### 拟用文案

本方案本身没有新增应用字符串。实施时先复用本地化资源；下表限定新增文案的用途，具体字词随现有界面统一。

| 文案 | 保留原因 |
| --- | --- |
| 最近输入 | 历史召回需要一个可发现的菜单入口 |
| 回到当前草稿 | 用户需要取回召回前暂存的正文、附件和引用 |
| 本机已有记录 | 限定最近输入的覆盖范围；不把缓存不全描述成完整历史 |
| 本机暂无最近输入 | 区分本机没有记录与加载失败 |
| 粘贴内容 · N 行 | 识别折叠块及其体量；单行长文本可改为字符数 |
| 展开编辑 | 区分查看预览与将原文恢复为可编辑内容 |
| Agent、最近活动 | 区分新增条件的对象，避免把会话日期误读成消息日期 |
| 仅搜索本机已缓存的消息 | 说明 iOS／Android 正文结果的覆盖范围 |
| 当前回答目录 | 区分提问目录与回答内部标题 |

项目、状态、标签、复制、删除、重试、取消、清除筛选等操作复用既有文案。屏幕阅读器需要的名称和状态使用语义属性提供，不额外显示操作说明或分组副标题。

## 主要证据

Astryx 参考固定于 commit `08b751a6dfe84d3d3216745b3eb65194187299e9`。这里只参考行为和接口组织，未复制库实现。

| 参考能力 | 上游证据 |
| --- | --- |
| 粘贴折叠、历史、IME | [ChatComposerInput](https://github.com/meta/astryx/blob/08b751a6dfe84d3d3216745b3eb65194187299e9/packages/core/src/Chat/ChatComposerInput.doc.mjs)、[粘贴预览](https://github.com/meta/astryx/blob/08b751a6dfe84d3d3216745b3eb65194187299e9/packages/core/src/Chat/ChatPastedTextToken.tsx) |
| 可编辑搜索条件 | [PowerSearch](https://github.com/meta/astryx/blob/08b751a6dfe84d3d3216745b3eb65194187299e9/packages/core/src/PowerSearch/PowerSearch.doc.mjs) |
| 阅读宽度与来源 | [Markdown](https://github.com/meta/astryx/blob/08b751a6dfe84d3d3216745b3eb65194187299e9/packages/core/src/Markdown/Markdown.doc.mjs)、[Citation](https://github.com/meta/astryx/blob/08b751a6dfe84d3d3216745b3eb65194187299e9/packages/core/src/Citation/Citation.doc.mjs) |
| 选择器适配 | [Selector](https://github.com/meta/astryx/blob/08b751a6dfe84d3d3216745b3eb65194187299e9/packages/core/src/Selector/Selector.doc.mjs) |
| 异步反馈与朗读 | [Button](https://github.com/meta/astryx/blob/08b751a6dfe84d3d3216745b3eb65194187299e9/packages/core/src/Button/Button.tsx)、[ChatMessageList](https://github.com/meta/astryx/blob/08b751a6dfe84d3d3216745b3eb65194187299e9/packages/core/src/Chat/ChatMessageList.doc.mjs) |
| 设计关系 | [主题定义](https://github.com/meta/astryx/blob/08b751a6dfe84d3d3216745b3eb65194187299e9/packages/core/src/theme/defineTheme.ts)、[设计规范](https://github.com/meta/astryx/wiki/Design-Conventions) |

Riffet 核查覆盖正式四端的输入、草稿、提交、搜索、Markdown、选择器和辅助技术代码，以及现有平台文档；未运行四端应用或声称真机性能已达标。平台实测结果应随具体优化改动记录到各自现有文档。
