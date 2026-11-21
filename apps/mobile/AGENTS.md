# 移动客户端

补充根目录 [AGENTS.md](../../AGENTS.md)，那里的「改界面」同样适用。Android 的设计规范在 [Android](../../docs/design/system/android.md)：组件对照、页面与浮层、各风格的取值和迁移顺序；iPhone 的在 [iOS](../../docs/design/system/ios.md)；架构说明在 [docs/MOBILE.md](../../docs/MOBILE.md)。

## 界面

- 新的二级页面、浮层和面板先按 [移动端页面](../../docs/design/system/mobile.md) 定页面类型（目录、详情、编辑、设置分类、选择面板、弹窗、面板），再写代码。行里不放和标题同名的按钮；搜索、添加和低频工具进顶栏。
- Android 的组件集中在 `shared/src/commonMain/kotlin/riffet/ui/design/`。业务代码用这里的组件，不直接用 Material 控件；缺的先在这里补。
- 颜色、字号、圆角由 `pnpm gen:theme` 和 `pnpm gen:tokens` 生成，不手工誊抄，也不改生成的文件。
- iPhone 系统控件优先，系统没有的部件只在 `iosApp/Riffet/Design/` 画一份；颜色用主题角色（`palette`），不用 `.red`、`.secondary` 这类系统色；文字用 `riffetFont`，不写 `.font(.caption)` 或 `.font(.system(size:))`；不照搬 Material 的尺寸。取值在 `iosApp/Riffet/Design/` 和 `iosApp/Riffet/Theme/`，规则见 [iOS](../../docs/design/system/ios.md)。

## SwiftUI 约定

- 主线程的栈要省着用：SwiftUI 在主线程上解析整棵视图类型、计算 body，iOS 27 上用完就闪退。设计层的修饰符返回具体类型，不返回 `some View`；页面里的大块内容放在 `riffetTypeBoundary()` 后面（`RiffetList`、`RiffetForm` 已自带）；视图里不存几 KB 的值类型；`viewWillAppear` 和 SwiftUI 更新里不调会当场布局的 UIKit 方法。改完跑 `scripts/stack-report.py`，做法见 [iOS](../../docs/design/system/ios.md) §2.0。

## 流畅度

帧预算、主线程上能做什么、怎么测和每次要跑的场景在 [Android 流畅度规范](../../docs/guide/android-performance.md)。量帧和采样只用 benchmark 构建（`./gradlew :androidApp:assembleBenchmark`），debug 构建解释执行，数字不能用。

## Compose 约定

以下每条都对应过一次真机上的卡顿或闪烁；`pnpm check:compose` 会拦下其中能从文本识别的写法。

- 带返回值的 `@Composable` 函数里，可组合调用和 `.current` 读取不放在 `&&` / `||` 后面：先无条件读进 `val`，再组合判断。
- 同一个有状态组件（图片、列表、输入框）只保留一个调用点；状态变化时改参数，不在 `when` 的两个分支里各调一次。
- 布局位置和尺寸不写进 State 再在组合阶段读取；需要时在布局或绘制阶段使用，或只在确实需要时追踪（如 `trackForFolds`）。
- 随导航、滚动或动画变化的值用 `compositionLocalOf`；`staticCompositionLocalOf` 只给主题、窗口、宿主这类几乎不变的值。
- 页面状态变化时不增删修饰符节点：用参数切换节点内部的行为，保持修饰符链的结构不变。
- 能同步得到的首帧状态就同步给出，不默认写 `remember { Loading }` 加 `LaunchedEffect`。
- 会改变行高的派生（markdown 解析、异步元数据、测量）不放在行组合之后：在 presenter 的 `prepare` 钩子里于后台算好（见 `prepareTranscriptMarkdown`），做不到的先占住最终尺寸。在贴底的列表里，行的首帧高度与稳定后的高度不同，就是一次跳动。
- 页面主体放在 `RiffetPageScaffold`（或 `PageBody`）里，转场结束后再组合并淡入；不要逐页手写 `LocalPageContentReady` 判断。
- 骨架传给主体的内边距是同一个实例，数值在使用处读取：直接交给 `contentPadding` 或 `Modifier.padding`，要加边距用 `PaddingValues.plus(...)`。在组合阶段调 `calculateBottomPadding()` 再拼一份新的，输入框每变一次高度这段组合就重跑一次。
- 跟着键盘动的尺寸在布局阶段读 `WindowInsets.ime`（见 `rememberDockUnfold`），不另起动画；聚焦时才出现的内容提前组合好，用 `Modifier.unfolded` 露出。
- 随内容变大的工作（解析、diff、高亮、转义、解码）不在组合里做；行数可能过百的内容用 `LazyColumn` 并给有界高度，按最宽行对齐时量最长的几行定宽，不用 `IntrinsicSize.Max`。
- 列表里的 WebView 等重量级视图等列表停下（`LocalListSettled`）再创建，先占住尺寸。
- 按一份会整体换新的列表做 `remember` 键去算每一行，流式更新时每帧全部重算：按行键和对象身份记忆。

## 排查
- 横向手势只经窗口的横滑仲裁（`ui/gesture/HorizontalSwipes.kt`，规则见 [MOBILE.md](../../docs/MOBILE.md)「手势调度」）：要接横滑的表面加 `swipeSurface`，能横向滚动的子控件用 `riffetHorizontalScroll` / `horizontalSwipeChild`，暂时不接触摸的层用 `swallowTouches`。不自写横向拖动检测，也不从返回目标的类型推断谁能接横滑；新开一个弹窗窗口且里面有滑动返回时，在弹窗根上加 `horizontalSwipeArbiter()`。

- 重建：`adb shell setprop log.tag.RiffetLifecycle DEBUG` 后重启 App，`adb logcat -s RiffetLifecycle` 里同一个标签无故出现 `-` 再 `+`，说明该子树被重新挂载了。
- 同一开关下出现 `shift <key> 旧高→新高`，说明一行已结束的内容在屏幕上变了高度（读者自己展开的除外），即首帧与稳定帧不一致。
