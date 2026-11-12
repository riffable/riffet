# Riffet 2 · 原生 iPhone 交互 Demo

第二版独立 SwiftUI 应用，最低 iOS 18.0，支持 iOS 18.7.8。显示名称为 **Riffet 2**，bundle ID 为 `io.github.riffable.iphone.demo.v2`，可以与第一版 `io.github.riffable.iphone.demo` 并存。所有会话、设备、回复、工具与审批都是本地样例，不连接 Mac 或真实 Agent，不执行命令。

使用系统 NavigationStack、List、Form、Menu、sheet、SF Symbols 与语义颜色。iOS 18 保留该版本的系统外观，iOS 26 采用系统控件的新外观；消息正文保持平整、可读的内容背景。没有新增第三方依赖，不需要 Kotlin framework 或服务端。

## 本版的交互取舍

- **一个会话首页。** 项目是可搜索的范围选择，设置在右上角。取消会话、项目、设置三个 Tab，底部工具栏只保留筛选和新任务。
- **先看到需要做什么。** “需要你处理”与“最近”分组，行内显示任务、具体进展、更新时间；正常设备信息收为一行。内置 14 条会话、3 个项目、2 条待确认请求与长历史样例。
- **输入一次开始。** 新任务使用完整编辑页，项目与 Agent 可见、可修改。提交文本完整成为首条用户消息，标题从首行生成；返回直接回到会话列表。
- **阅读与写作有连续性。** 每条会话独立保存草稿和阅读锚点；回看时追加消息只显示“有新内容”，不强制滚到底部。新任务草稿同样保存。
- **审批留在上下文中。** 从待处理分组进入直接定位请求；离开该位置后可用“等待确认 · 查看”返回。决定在原卡片中显示，不追加假执行结果；普通拒绝使用中性样式。
- **归档可恢复。** 列表滑动或长按可置顶、归档；“已归档”筛选可找到并恢复会话。归档会话保留内容，但输入与待确认操作需恢复后再使用。

会话、草稿、阅读锚点、项目/Agent 选择和审批决定通过 Demo 专用的 UserDefaults 快照保留。这里的本机存储用于体验交互，不替代生产客户端的缓存、outbox 或同步实现。冷启动进入会话列表，重新打开某条会话时恢复该会话的草稿和阅读锚点。设置中的“还原演示内容”在确认后清除 Demo 草稿与新建会话，恢复样例。

## 建议体验的四条路径

1. 点“完善登录页的错误提示”，检查进入后是否直接看到请求与上下文；选择“允许本次”或“不执行”，观察原位结果。
2. 点首页右下角新任务，输入一段完整任务后开始，再继续发一条补充消息；返回应直接回到会话列表。
3. 打开任一普通会话，输入几句但不发送，返回列表再进入，检查草稿是否保留。
4. 打开“打磨长会话阅读体验”，向上回看，再从右上角菜单选择“插入演示进度”；页面应停留在阅读位置，点击“有新内容”才去最新处。返回列表再进入可检查阅读恢复。

## 构建与体验

验证工具为 Xcode 26.5 与 XcodeGen。开发 SDK 与部署基线分别配置；应用并不要求手机升级到 iOS 26。

```sh
cd apps/mobile/iosApp/Demo
xcodegen generate
xcodebuild -project RiffetDemo.xcodeproj -scheme RiffetDemo \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath /tmp/riffet-v2-build \
  CODE_SIGNING_ALLOWED=NO build
open RiffetDemo.xcodeproj
```

在 Xcode 中选择已安装的 iPhone 模拟器运行，并按前述四条路径体验。生成的 `.xcodeproj` 与 `build/` 已忽略。

遵循[仓库协作规范](../../../../AGENTS.md#测试与验证)，非必要不增加测试。Demo 的样例与 UI 测试、独立测试 target 已移除；通过必要的编译和实际体验验证修改，不另建 UI 自动化。下方测试数量属于 2026-10-15 的历史记录。

真机可以在 Xcode 的 Signing & Capabilities 中选择自己的开发团队，也可通过命令行传入，不把团队、账号或设备标识写进共享配置：

```sh
xcodebuild -project RiffetDemo.xcodeproj -scheme RiffetDemo \
  -configuration Debug -destination 'platform=iOS,id=<DEVICE_UDID>' \
  -derivedDataPath /tmp/riffet-v2-device \
  DEVELOPMENT_TEAM=<YOUR_TEAM_ID> CODE_SIGN_STYLE=Automatic \
  -allowProvisioningUpdates -allowProvisioningDeviceRegistration build
```

## 验证记录（2026-10-15）

- Xcode 26.5 完整签名构建通过，`codesign --verify --deep --strict` 通过；App 的 `MinimumOSVersion` 为 `18.0`，`UIDeviceFamily` 为 `[1]`。
- **iPhone 12 / iOS 18.7.8：Riffet 2 安装、启动成功，启动后查询进程确认仍在运行。** 第一版保留，未覆盖其 bundle。
- **iPhone 17 Pro / iOS 26.5 模拟器：8 项数据测试、4 项界面测试全部通过。** 新建流程另补强“输入栏在屏幕内、可点击并继续发送”的断言，定向复测通过。
- 已检查首页、审批前后、草稿恢复、长历史追加和新任务页面的模拟器截图。截图代表 iOS 26.5 的系统外观，不能代替 iOS 18 真机的逐屏验收。
- 尚未完成 iOS 18 真机全流程自动化、大字体、VoiceOver、横屏、中文输入法及生产网络场景验收。测试日志还记录了系统 `UIKitToolbar` 视图层级提示；当前核心界面测试通过，后续升级 SDK 时需继续观察。

最终签名产物：`/tmp/riffet-v2-device/Build/Products/Debug-iphoneos/RiffetDemo.app`。完整测试报告：`/tmp/riffet-v2-tests-2.xcresult`；新建流程补强报告：`/tmp/riffet-v2-newtask-check.xcresult`。这些是本机临时产物，可按上面的命令重新生成。

本次开发描述文件到期时间为 2026-10-22 15:28（北京时间），之后需要重新签名安装；不属于正式分发构建。

## 实现范围

`DemoModel.swift` 管理本地样例与交互快照；`RiffetRootView.swift` 管理导航与设置；`SessionListView.swift` 管理范围、分组和列表操作；`NewTaskView.swift` 管理任务编辑；`ConversationView.swift` 与 `MessageComposer.swift` 管理阅读、审批和输入。没有接入 KMP、真实设备认证、事件同步、后台恢复、附件或远端执行。正式集成路线见 [iPhone 方案](../../../../docs/IOS.md)。
