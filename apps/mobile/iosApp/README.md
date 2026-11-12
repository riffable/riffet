# Riffet iPhone

正式客户端位于 `Riffet/`，采用 **SwiftUI / UIKit 原生界面 + KMP 共享业务逻辑**，最低 **iOS 18.0**，覆盖 iOS 18.7.8。工程由 XcodeGen 生成，独立于 Gradle 的应用模块；Xcode 构建阶段会调用 `:client:embedAndSignAppleFrameworkForXcode` 生成并嵌入 `RiffetKit.framework`。主界面不嵌入 Compose 或 Web 工作台。

版本号与其他端统一，来自根目录 `package.json`（见[版本与发布](../../../docs/guide/operations.md#版本与发布)），正式 bundle ID 为 `io.github.riffable.iphone`。设计取舍、功能矩阵与验收边界见 [iPhone 方案](../../../docs/IOS.md)。`Demo/` 保留独立的 V1/V2 交互样例；V2 的显示名称为 Riffet 2、bundle ID 为 `io.github.riffable.iphone.demo.v2`。它与正式客户端的数据和设备授权分离。

## 已实现的链路

- 扫描一次性配对二维码、Bonjour 发现与手动连接；设备令牌与签发源保存在 Keychain，仅向对应源发送授权。失败配对不覆盖既有凭据；401 停止订阅和轮询并返回配对页。
- 原生会话首页、项目范围、状态筛选、标题/项目/标签搜索、本地缓存消息搜索、置顶、重命名、标签、归档及恢复；可浏览 Mac 目录并添加项目。首页选定项目后，可从「项目操作」直接访问文件、Git、检查点、Worktree 和终端，无须先创建会话。
- 一次输入开始任务，项目与短模型名直接可见；模型列表按服务商分组、支持搜索与参数选择，沿用 Web 保存的服务商默认值。选择 Agent、模式和审批策略；首条消息、附件与文件引用随请求提交。创建结果未知时保留原请求标识，重试复用它。
- 共享 Kotlin 时间线投影、异步原生 Markdown、Prism 代码高亮/换行/展开、原位行内公式与公式块、工具与思考、计划/待办/目标、可缩放图片、子 Agent、历史分页；正文以 UICollectionView 按行复用、SwiftUI 渲染每项内容；轮次目录和紧凑的回到最新入口，按会话保存草稿，普通打开会话默认到最新；搜索和审批保留显式定位，回看历史时停止跟随。草稿编辑合并为后台持久化，提交和前后台边界立即保存。
- 会话输入栏左侧保留附件，右侧依次为上下文图标、短模型名和发送/停止。上下文图标以 44 点触区打开模型面板，显示真实用量、窗口与后端分解；未上报明确显示未知。effort、Fast、Agent 等完整配置在模型或标题信息面板中查看。
- 发送、排队、立即发送、打断/停止、未确认请求重试、审批与单/多选问题；审批保留请求 ID 和修订号，处理未知结果与题目变化，并可选择提交前进行设备本人验证。
- 文件目录、文件名/内容搜索、文本行定位、Markdown 阅读/源码切换、大文件分段、代码高亮、可缩放图片、静态 HTML、下载分享与 Quick Look；Git diff、暂存/取消、提交、检查点及 Worktree；SwiftTerm 原生远程终端，回看由终端自身持有。
- 本机持久化缓存、搜索索引、outbox、待确认创建与交互提交；前后台恢复；系统外观、应用图标颜色、授权设备、通知设置、深链与「准备 Riffet 任务」快捷指令。
- 「设置 → Agent 配置与用量」提供真实服务管理：统计筛选、Token/任务概览、趋势、分布、延迟与速度、轮次分页和 CSV/JSON 导出；提供商增删改、默认项、模型目录/探测、Key 保留/更新/清除与 Cursor 网关；Rules/Skills/Commands/MCP/Hook/插件清单、能力约束下的创建/管理操作和带内容 hash 校验的配置编辑。

能力选项来自服务端 catalog；某个 Agent 不支持的终端、模型或停止能力不会作为可用能力展示。任务、文件、CLI 和终端进程始终运行在 Mac。

局部网页只用于公式与显式可视化：公开 `/math` 使用服务端 KaTeX/CSP；可视化在非持久化 WKWebView 的 opaque-origin iframe 内运行，允许本地交互与受限 CDN 静态资源，禁止连接应用 API、表单及外部导航，无应用 bridge。普通项目 HTML 预览关闭 JavaScript。

通知由 App 实际观察到的任务变化触发，经用户授权后发送本地通知；没有 APNs、公网推送中继或后台长期连接保证。锁屏或挂起后应重新打开恢复同步。

## 构建

需要 macOS、Xcode 及相应 iOS SDK / Simulator runtime、XcodeGen、JDK 17。首次构建需要取得 Gradle 与 Swift Package 依赖；共享 Gradle 工程还包含 Android 目标，若配置阶段提示缺少 Android SDK，按 `apps/mobile` 的开发环境配置 SDK。当前提供 arm64 真机与 Apple Silicon 模拟器目标。

```sh
cd apps/mobile/iosApp
xcodegen generate
xcodebuild -project Riffet.xcodeproj -scheme Riffet -configuration Debug \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath /tmp/riffet-iphone-build \
  CODE_SIGNING_ALLOWED=NO build
```

上面的无签名命令验证编译，不作为 Keychain 验收。真实 Keychain 测试需要 App-hosted XCTest 与签名后生成的应用身份；不能用独立 Kotlin/Native 测试进程替代。

真机构建在本机设置团队和设备变量，不把私人团队 ID、UDID、账号或开发证书写入工程：

```sh
export RIFFET_TEAM_ID='<your-development-team-id>'
export RIFFET_DEVICE_UDID='<your-iphone-udid>'
xcodebuild -project Riffet.xcodeproj -scheme Riffet -configuration Debug \
  -destination "platform=iOS,id=$RIFFET_DEVICE_UDID" \
  -derivedDataPath /tmp/riffet-iphone-device \
  DEVELOPMENT_TEAM="$RIFFET_TEAM_ID" CODE_SIGN_STYLE=Automatic \
  -allowProvisioningUpdates -allowProvisioningDeviceRegistration build
xcrun devicectl device install app --device "$RIFFET_DEVICE_UDID" \
  /tmp/riffet-iphone-device/Build/Products/Debug-iphoneos/Riffet.app
xcrun devicectl device process launch --device "$RIFFET_DEVICE_UDID" io.github.riffable.iphone
```

设备需要开启开发者模式，并在系统提示时信任本机开发签名。开发签名和设备配置描述文件的有效期由当前账号决定，不在仓库固定写入日期。

## 自动化验证

遵循[仓库协作规范](../../../AGENTS.md#测试与验证)：**非必要不增加测试**。`RiffetTests` 只保留关键草稿耐久与并发清理、创建恢复 ID、provider 配置及 origin 隔离、App-hosted Keychain，以及实际 WebKit/CSP 和公式资源隔离。UI 展示、布局、截图、滚动性能与 UI 驱动的重复业务测试已移除，工程不再包含 `RiffetUITests` target。

纯 UI 修改运行必要的编译检查，按需实际体验；网络协议、Outbox、发送/创建幂等及未知结果恢复优先复用 KMP 与服务端核心测试。无需为每次改动新增 XCTest 或重复全部平台构建。

真实 Keychain 与 WebKit 网络隔离测试仍使用独立的 loopback fixture。在仓库根目录另开终端启动：

```sh
node apps/mobile/iosApp/scripts/e2e-server.mjs
```

默认地址为 `http://127.0.0.1:19471`，只用于模拟器，不连接正式服务或真实 Agent。执行保留的 App-hosted 核心测试示例（在 `apps/mobile/iosApp`）：

```sh
export RIFFET_SIMULATOR_ID='<booted-arm64-simulator-udid>'
export RIFFET_TEAM_ID='<your-development-team-id>'
TEST_RUNNER_RIFFET_E2E_BASE_URL=http://127.0.0.1:19471 \
TEST_RUNNER_RIFFET_REQUIRE_E2E=1 \
xcodebuild -project Riffet.xcodeproj -scheme Riffet -configuration Debug \
  -destination "platform=iOS Simulator,id=$RIFFET_SIMULATOR_ID" \
  -parallel-testing-enabled NO \
  -derivedDataPath /tmp/riffet-iphone-tests \
  -resultBundlePath /tmp/riffet-iphone-tests.xcresult \
  -only-testing:RiffetTests \
  DEVELOPMENT_TEAM="$RIFFET_TEAM_ID" CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- test
```

模拟器的 ad hoc 签名也必须保留应用身份所需 entitlement。仅编译成功不能证明 Keychain 或 WebKit 隔离已经在运行时验证。依赖 fixture 的测试在未要求 E2E 且 fixture 不可用时会跳过，执行后需要核对通过、失败与跳过情况。设备和界面检查按实际需要手动执行，不保留 UI 测试 target。

共享核心测试可在 `apps/mobile` 中验证：

```sh
./gradlew :contracts:jvmTest :core:jvmTest :client:jvmTest
```

这些共享测试不覆盖 iPhone 的 Keychain、系统权限、相机、输入法或真实终端触控。

## 历史验收记录与边界

0.4.3（build 7）使用 iPhone 17 Pro / iOS 26.5 模拟器验收，构建产物的 `MinimumOSVersion` 为 18.0。用户设备下线后没有再操作真机，**这一版尚未安装或复验于 iOS 18.7.8**。实际截图、逐项报告、早期失败及后续修正执行记录见 [0.4.3 模拟器验收](build/acceptance/product-0.4.3/README.md)。测试通过不从旧版真机结果推定。

本轮覆盖 69 个 App-hosted 测试、7 个 HTTP/SSE 网络 UI 场景、7 个产品 UI 场景、2 个工具输出场景、4 个正文布局场景，以及 1 个固定起点滚动测量。正文检查包含冷/暖缓存下 120 轮长会话与 72 工具会话各不触摸持续观察 8 秒、三批长 narration 动态增高、busy→idle、工具文件跳转，以及展开/换行选择跨 cell 复用保留。最大辅助字号与横屏分别验收；横屏不仅检查高度，还要求输出实际可见、内部滚动确实改变源码位置，并实际点击收起。

72 工具场景每个文本输出 420 行，固定从第 36 个工具开始，四轮测量的平均 App CPU 时间为 2.0466 秒/每批四次外层手势，平均峰值物理内存约 171.9 MB。没有取得有效 FPS/hitch 数据；该 Debug 模拟器结果不代表真机帧率。新执行的 0.4.0 对照未通过测量前就绪检查，不用于计算性能改进百分比。

以下为 0.4 产品化阶段的历史记录：46 个 App-hosted 测试（原有 38 项与新增统计 8 项）、7 个网络 UI 场景和 5 个产品 UI 场景，修正后的各项最后执行均通过。模型相关两项各连续重复两轮通过；完整报告位置、模拟器性能值及真机只读验收单独记录在 [方案中的 0.4 记录](../../../docs/IOS.md#04-产品化改造)。不把早期含失败的组合报告称为全部通过。 iPhone 12 / iOS 18.7.8 另有四个只读真实服务场景通过，0 失败、0 跳过，覆盖首页与真实 README、模型目录、最大辅助字号/横屏，以及新增统计筛选/趋势/热力图。

以下为 0.3 与统一服务阶段的历史记录（2026-10-15）：

| 验证 | 结果 | 解释 |
| --- | --- | --- |
| 正式 App 签名模拟器测试（iOS 26.5） | 9 项 App-hosted + 7 项网络 UI，全部通过，无失败 | `/tmp/riffet-ios-full-signed-2.xcresult`；包括实际 Keychain、3 项 WKWebView 隔离、发送与创建幂等、草稿冷启动、审批未知结果杀 App 后同 requestId 重试、409 与 401 |
| 共享 JVM | 244 项通过 | 契约/投影/缓存/命令等共享规则 |
| 共享 iOS Native | 248 项中 247 项通过，1 项 standalone Keychain 跳过 | standalone 进程缺少 App 身份；真正 Keychain 由上面的 App-hosted 测试验证，不把该跳过当系统能力通过 |
| 独立真实服务 API | 基础 25 组、终端补强 9 组、管理补强 16 组全部通过 | 与 fixture 分开；管理覆盖 Provider CRUD / Key 三态、项目 Rule 创建、hash 409 与统计 CSV |
| macOS 回归 | 完整 Debug App 编译通过 | 验证共享层改动未破坏现有 macOS 编译；不等同 macOS 全部 UI 测试 |
| iPhone 12 / iOS 18.7.8 | 正式 App 已安装；1 项真实设备综合验收通过，0 失败 | `/tmp/riffet-iphone-live-8.xcresult`：配对、真实文件读取、冷启动恢复、Provider/统计/扩展读取、真实项目模型目录、最大辅助字号下编辑与横屏可用操作；测试草稿未发送且已清空 |

Riffet 2 Demo 保留作为比较，V1/V2 的源码保留；独立测试与测试 target 已在 2026-10-16 精简移除，下列 Demo 测试数量仅记录历史验收。正式客户端的设备安装成功也不等同所有流程在真实设备完成验收。

新任务布局与项目目录读取的最后调整后，首条消息和创建响应丢失恢复的 2 项定向 UI 回归再次通过（`/tmp/riffet-ios-task-editor-final.xcresult`）。大字号验收按实际截图调整布局，不以禁用按钮存在作为可操作的依据；横屏等待实际布局完成后验证已准备草稿的操作按钮。

此前独立验收服务使用端口 4347，state 与样本项目保留在 `/private/tmp/riffet-iphone-acceptance-state`、`/private/tmp/riffet-iphone-acceptance-workspace`。该服务现已停止。手机已切换到 Mac 原有的 4337 主服务，读取原有项目和会话；主服务采用带认证的局域网监听。第一版 Demo 已按授权移除，Riffet 2 与 Riffet 保留。

另做过一次隔离 Cursor/default 真实任务验收：首条消息创建返回 HTTP 202，Native SSE 返回 HTTP 200，但 CLI 停在 `Log in`，120 秒内未返回模型结果。验收任务已通过其专属终端的 interrupt 接口停止，测试目录内容未变；没有重试创建或切换后端。这证明真实提交与流连接能够建立，**不能证明模型完成与真实回答已通过**。这条记录仅描述此前隔离验收，不代表现在主服务的 CLI 登录状态；本次连接切换没有创建或发送新的 Agent 任务。

已读取 0.4（build 4）最终包的 provisioning profile，当前开发签名有效期截至 2026-10-22 16:33（Asia/Shanghai）。到期需要重新签名安装；这是本机签名状态，日期不写入工程配置。

管理模块接入真实 API。统计提供今天、近 7/30/90 天、一年、全部时间和自定义日期；项目、Agent 与模型支持多选，提供七项趋势指标、三种分组、每日与时段热力图、模型排行和延迟分位数。轮次分页及 CSV/JSON 导出使用与当前结果一致的筛选快照，过期请求不会覆盖新结果。扩展操作只展示服务端能力允许的动作；配置编辑的内容 hash 冲突要求重新读取，不静默覆盖。Key 不回显，编辑时留空保留原 Key，显式清除与更新分别提交。

fixture 证明协议状态和错误分支的客户端行为；真实服务 API 验证后端行为；真实设备 UI 验证相应页面和系统交互。三者的范围分别记录。实际 CLI 长任务、终端触控/中文输入法与租约、Git 写操作和大项目/大文件仍需按场景验收，不能从接口或 fixture 测试推定已经覆盖。

切换原有 Mac 服务的单独验收已通过：`RealServicePairingUITests/testPairExistingMacServiceAndRestoreConnection`，1 项通过、0 失败，结果 `/tmp/riffet-iphone-real-service-1.xcresult`。覆盖从已有连接切换、一次码配对、Keychain 冷启动恢复、读取原 `riffet` 项目及核对完整服务器 origin；不 reset fixture、不创建任务、不清空草稿。服务切换前后的 118 条会话、9 个项目均保留，19 个 tmux pane 的 PID 未变化。

统一服务版本随后部署到原 4337 实例：13 个文件、159 项 Server/Web 定向测试和 6 项 wrapper 测试通过；临时实例验证 stop/start 恢复配置、非法重启保留原进程及显式参数覆盖。真实实例 20 项连接检查通过，含 `riffet pair --json`、Web Cookie 与 native 凭据、CSRF、同一项目列表、保留原 Cursor pane，以及撤销后现有 SSE 立即断开。验收创建的浏览器与 native 临时身份已清理；iPhone 在最终部署后重新打开并持续请求真实服务，临时 UI runner 已移除。最终配对文案已改为 `riffet pair`，重新签名构建与真机安装成功。

后续只读切换验收可指定以下环境变量并只运行该 suite：`TEST_RUNNER_RIFFET_PAIR_BASE_URL`、`TEST_RUNNER_RIFFET_PAIR_CODE` 和可选 `TEST_RUNNER_RIFFET_PAIR_EXPECTED_PROJECT`。配对码应在运行前从 Mac 的 `riffet pair` 取得；每次兑换后失效。

真机已实际允许本地网络，并在开启无线数据权限后完成连接；网络受系统阻止时，配对页提供中文提示和系统设置入口。相机/Bonjour 独立发现、Face ID/密码、通知授权与点击、附件权限和系统分享、完整 VoiceOver、长历史流式滚动和切网/锁屏恢复仍需要逐项设备检查。本地通知只基于 App 收到的事件，没有 APNs 或后台长期执行保证。
