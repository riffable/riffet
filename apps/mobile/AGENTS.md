# 移动客户端

补充根目录 [AGENTS.md](../../AGENTS.md)，那里的「改界面」同样适用。架构与设计说明在 [docs/MOBILE.md](../../docs/MOBILE.md)。

## 界面

- Android 的组件集中在 `shared/src/commonMain/kotlin/riffet/ui/design/`。业务代码用这里的组件，不直接用 Material 控件；缺的先在这里补。
- 颜色、字号、圆角由 `pnpm gen:theme` 和 `pnpm gen:tokens` 生成，不手工誊抄，也不改生成的文件。
- iPhone 用 iOS 的语义色、系统字体和原生控件，品牌与信息语义跟 Riffet 一致，不照搬 Material 的尺寸。取值在 `iosApp/Riffet/Design/` 和 `iosApp/Riffet/Theme/`。

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

## 排查

- 重建：`adb shell setprop log.tag.RiffetLifecycle DEBUG` 后重启 App，`adb logcat -s RiffetLifecycle` 里同一个标签无故出现 `-` 再 `+`，说明该子树被重新挂载了。
- 同一开关下出现 `shift <key> 旧高→新高`，说明一行已结束的内容在屏幕上变了高度（读者自己展开的除外），即首帧与稳定帧不一致。
