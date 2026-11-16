# 浏览器

日期：2026-11-12，2026-11-13 修订。状态：B1、B2 已实现（服务端插件、Web 与 Mac 面板、各端「技能与工具」条目）；B3 未做。

Agent 在对话里操作一个由 Riffet 托管的浏览器：打开网页、读页面、点击输入、截图、看控制台。用户在 Riffet 里实时看到这个浏览器，也可以随时直接操作；需要用户处理的事（登录、验证码）由 Agent 提出，用户做完点「完成」。典型场景有两类：验证自己正在开发的 Web 应用（localhost），以及替用户在网站上查资料或办事。

它是内置插件 `riffet.browser`，可以关闭。工具经 Riffet MCP 注入，和设备工具走同一条路（[DEVICES.md](DEVICES.md) §2）。

## 1. 结论

```
Agent CLI ─stdio─▶ riffet MCP shim ─HTTP─▶ 服务端 riffet-mcp：按会话工具组放行
                                              │ 插件工具组 riffet.browser/browser
                                              ▼
                               riffet.browser（服务进程内）：playwright-core
                               ├─ Chromium（无头，CDP 走管道，不开端口）
                               ├─ 按项目的持久资料目录，按会话的标签页
                               └─ 画面帧 / 输入回灌 ─WebSocket─▶ Web 右侧区 · Mac 原生面板
```

- **引擎**：Chromium，由服务端的插件经 `playwright-core`（≥ 1.64）驱动。WKWebView 不作引擎，App 内嵌的是「画面加输入」的视图，不是浏览器内核。
- **位置**：浏览器跑在服务所在的机器上，也就是 Agent 所在的机器。本机 Mac 托管服务时，它就在用户的 Mac 上；连远程服务器时，它在那台服务器上，各端看到的是同一个浏览器。
- **页面表示**：AI 模式的无障碍快照加 ref（`ariaSnapshot({ mode: 'ai' })` 和 `getByRef`），截图是补充手段，不靠坐标。
- **入口**：输入框「技能与工具」里的「Riffet 浏览器」（与 Agent 自带的其他浏览器工具区分开），按对话选择（DECISIONS 2026-11-10）。不勾选就没有浏览器工具，也不占上下文。

## 2. 插件形态

`plugins/riffet/browser/`，`defaultEnabled: true`，形态同画布：manifest 声明，服务端实现，Web 和 Mac 各自绘制。关闭插件后，「技能与工具」里不再有这一项，已选它的会话调用时得 `TOOL_NOT_AVAILABLE`（原因写明插件已关闭），面板也从各端消失。浏览器进程随停用一起关掉。资料目录保留，重新开启后登录状态还在。

```
plugins/riffet/browser/
  index.ts        manifest、activate：提供 agentTools、channels、actions、status、doctorChecks
  engine.ts       浏览器进程、按项目的资料、按会话的标签页、空闲回收
  tools.ts        工具定义（稳定）与参数白名单
  act.ts          批量步骤、风险判定、确认与交接
  live.ts         画面帧、输入回灌、「完成」
  web/            右侧面板（canvas 画面、标签条、地址栏、请求条）
apps/macos/Riffet/Features/Browser/   Mac 原生面板（按插件启用与否显示，同画布）
```

### 需要新增的插件扩展点

现在的插件不能提供 MCP 工具（工具表写死在 `apps/server/src/riffet-mcp/service.ts`），也没有长连接。浏览器需要两个可加性扩展点，`PLUGIN_API_VERSION` 不变：

| 扩展点 | 声明 | 作用 |
| --- | --- | --- |
| `agentTools` | `contributes.agentTools: [{ id: 'riffet.browser/browser', title, description }]` | 一个工具组：稳定的工具定义加 `call(ctx, name, args, signal)`。`ctx` 带会话、项目、`callId`、截止时间。结果是文本或图片内容块，可以标 `untrusted`。组 ID 就是声明 ID，作为 `ToolGroupId` 写进会话的 `toolGroups` |
| `channels` | `contributes.channels: [{ id: 'riffet.browser/live', scope: 'session' }]` | 挂在 `/api/integrations/:id/channels/:name` 的 WebSocket。只认用户登录（Web cookie 或设备令牌），不认 MCP 凭据。宿主核对会话归属后才交给插件 |

`PluginHost.sessions`（只给声明了 `agentTools` 或 `channels` 的进程内插件）：`get`（会话、项目目录，只读）、`wake`（往会话发一轮，同一次性唤醒）、`notify`（同 `notify_user`）。截图直接作为图片内容块返回，不经文件通道；需要本人回答的确认在插件自己的面板里完成（§5），核心不新增交互类型。

核心侧的改动：

- `packages/contracts`：`ToolGroupId` 增加插件的声明 ID（带 `/`，与 `device:` 不冲突）；`PluginDeclarations.agentTools`、`channels`；跑 `pnpm gen:contracts`。
- `riffet-mcp/service.ts`：`tools()` 合并会话选中、且此刻已注册的插件组；`handle()` 每次复核，规则同设备组。各组的工具名不能重复，插件工具名必须以它声明的前缀开头（`browser_`），加载时校验；Riffet 自己的前缀（`device_`、`read_`、`schedule_`…）不能声明。插件组来自 `app.ts` 传入的 `PluginToolSource`（riffet-mcp 与 plugins 同层，不互相导入）。核心测试：`riffet-mcp/plugin-tools.test.ts`（只有选了组的会话看得到、调得到，插件关闭后立即 `TOOL_NOT_AVAILABLE`）。
- `PATCH /api/sessions/:id`：接受格式合法的插件组 ID。插件关闭时原样保留、只是不注入，插件回来后恢复，做法同会话视图偏好。
- 「技能与工具」（Web、Mac、iOS、Android）：列出已启用插件声明的工具组，放在设备之前。
- 依赖：`playwright-core` 进 `dependencies` 和 `runtime-package.json`，不随包附带浏览器。

插件工具先只对进程内的包开放（内置、开发包、显式可信的安装包），隔离安装包以后经 IPC 再说。

## 3. 引擎与资料

- **浏览器来源**：默认用插件自己下载的 Chrome Headless Shell，放在 `<stateDir>/plugin-data/riffet.browser/browsers/`，版本与 `playwright-core` 配套，不碰用户日常的 Chrome，也不受它自动更新的影响。没有下载时，状态显示「需要下载浏览器」。插件页「设置」里的浏览器单选给出每个来源的检测结果：内置 Chromium 是否已下载（未下载时带「下载」按钮，在后台运行 `playwright-core install chromium-headless-shell`，页面显示进度），Chrome / Edge 是否已安装（未找到的不能选），以及「其他浏览器」加可执行文件路径。设置键是 `browser`（`bundled`、`chrome`、`msedge`、`custom`）和 `executablePath`，资料目录始终独立。首次调用工具时如果没有可用的浏览器，返回 `BROWSER_NOT_INSTALLED` 并指向这个页面，不在后台静默下载。
- **`PLAYWRIGHT_BROWSERS_PATH`**：Playwright 只在注册表初始化时读一次。插件在首次加载 Playwright 的那一刻设置它，随即恢复，所以服务之后启动的 Agent 和终端不会继承 Riffet 的浏览器目录。
- **自动化标记**：登录页（Google 等）会拒绝声明了自动化的浏览器，提示「此浏览器或应用可能不安全」。启动时去掉 `--enable-automation`、关闭 `AutomationControlled`（`navigator.webdriver` 为 false），并把用户代理里的 `HeadlessChrome` 换成 `Chrome`，客户端提示（`Sec-CH-UA`）保持浏览器自己的值。用户代理要等浏览器跑起来才知道，所以服务启动后每种浏览器的第一次启动会重启一次。这只是让用户能登录，不是反检测：站点仍可能凭其他特征拒绝，那时交给用户在自己的浏览器里完成。
- **进程**：每个项目一个持久上下文（`launchPersistentContext`，资料目录 `profiles/<projectId>`），首次调用时才启动，空闲 15 分钟关闭。CDP 走管道（Playwright 的默认方式），不开 TCP 端口，本机其他进程接不进来。
- **会话与标签页**：每个会话有自己的一组标签页，Agent 只看得到、只操作得到本会话的标签页。同一项目的会话共享 cookie 和登录状态，这是有意的：登录一次，整个项目都能用。快速对话和没有项目的会话用临时上下文，结束即丢。
- **视口**：每个标签页固定视口，默认 1280×800，`browser_open` 可以指定。面板按比例缩放显示，不跟面板尺寸重排页面，以免 Agent 看到的布局和截图对不上。
- **下载与上传**：下载落在 `plugin-data/riffet.browser/downloads/<sessionId>/`，结果里给出路径；上传只接受项目目录内的文件。
- **数据**：插件页按项目列出资料目录和大小，项目名取自 `projects.json`（首次启动该项目的浏览器时记下项目目录）。可以逐个清除，也可以删除下载的文件；两者都不可撤销，执行前先确认。

## 4. 工具

保持稳定、数量少（7 个）；详细用法写进工具描述，必要时再配一个 skill，规则同设备（DEVICES §2）。所有读到的页面内容都标 `untrusted: true`，并用定界符包起来。

| 工具 | 参数 | 结果 |
| --- | --- | --- |
| `browser_open` | `url`、`tab?`（`new` / 标签 ID）、`viewport?` | 标签 ID、标题、URL、可交互元素快照 |
| `browser_snapshot` | `tab?`、`ref?`（只看某个子树）、`depth?`、`full?` | AI 模式快照。默认只保留可交互元素和标题、地标；`full` 给全量 |
| `browser_act` | `tab?`、`steps[]`，每步 `{ action, … }`：`click {ref}` / `fill {ref, text}` / `type {ref, text}` / `press {key, ref?}` / `select {ref, values}` / `check {ref, checked?}` / `hover {ref}` / `scroll {ref?, deltaY?}` / `drag {ref, to}` / `upload {ref, paths}` / `wait {text? url? ms?}` / `back` / `forward` / `reload`，最多 30 步，多余的键直接拒绝 | 逐步结果。在第一个失败处停下（`stoppedAt`，`isError: true`），并附上执行后的快照。批量设计同 `device_act` |
| `browser_screenshot` | `tab?`、`ref?`、`fullPage?` | JPEG，长边 1024（复用 `service.ts` 里的缩放） |
| `browser_tabs` | `action`：`list` / `select` / `close` | 本会话的标签页 |
| `browser_inspect` | `tab?`、`kind`：`console` / `network` / `errors`、`since?` | 控制台、失败的请求、页面异常。验证 localhost 应用时最常用 |
| `browser_handoff` | `reason`、`tab?` | 请用户亲自处理（登录、验证码、付款），见 §5 |

不提供执行任意 JS 的工具。Agent 有 shell，真需要脚本可以自己写 Playwright 脚本；浏览器工具只负责常见的、可审计的动作。

## 5. 画面与共同操作

- **画面**：`page.screencast.start({ onFrame })` 推 JPEG 帧，经 `riffet.browser/live` 频道发给正在看的客户端。没有人看就不推帧；有多个人看时共用一路帧。开着 `screencast.showActions({ cursor: 'pointer' })`，Agent 点了哪里、输入了什么，画面上能直接看到；用户自己输入时这些标注暂时隐藏（停手 1.5 秒后恢复），因为它们描述的是 Agent 的动作。
- **面板**：视图位置 `sidebar`（Web 右侧上下文面板的页签，Mac 详情栏，`InspectorViewRegistry.pluginRenderers` 里的原生渲染器）。内容是后退、前进、刷新、地址栏，多个标签页时有标签条（当前和悬停的标签显示关闭按钮，Web 上中键也可关闭），Agent 有请求时显示请求条（确认用「拒绝 / 允许」，`browser_handoff` 用「完成」）。面板打开时才连接频道；没有自动打开（待做：首次 `browser_open` 时提示）。
- **共同操作**：没有控制权之分，用户的输入随时送达页面，不中止 Agent 正在执行的步骤，Agent 也不必等用户。用户点击、滚动、按键或导航之后（单纯移动指针不算），Agent 的下一次调用结果会附一句「用户操作过页面，ref 可能失效，请重新取快照」。两边同时操作可能互相干扰，这里取宽松：由 Agent 根据提示重新读页面。风险操作的确认（§6）不受影响。
- **输入回灌**：Web 用 canvas 加一个隐藏的 textarea，Mac 用 `NSView` 实现 `NSTextInputClient`。指针、滚轮、按键经 Playwright 的 `mouse`、`keyboard` 发给页面，按会话依次执行；排队中还没执行的指针移动只留最后一个、滚轮增量累加，触控板的连续事件不会积压成滚动滞后；输入法上屏和粘贴用 `insertText`。坐标按视口缩放换算。
- **`browser_handoff`**：面板里显示原因，同时发通知（复用 `notify_user`），然后最多等 300 秒（MCP 调用上限 330 秒）。用户在这段时间内点「完成」，就直接返回；超时返回 `BROWSER_HANDOFF_PENDING`，等用户点「完成」时，Riffet 往这个会话发一条消息让它继续（复用一次性唤醒的投递）。付款永远走这一步，不会由 Agent 代点。
- **Mac 原生**：画面用 CALayer 显示解码后的帧，不用 WKWebView 套一层 Web 面板（遵循 Mac 先原生）。按插件是否启用决定显示，同 `Workbench.canvasAvailable`。
- **移动端**：先不做；B3 做会话内只读画面。

## 6. 安全

前提：Agent 和浏览器在同一台机器上，Agent 有 shell，完全可以绕开插件，自己启动浏览器。所以这里的规则是防误操作和防 prompt injection 的安全带，不是隔离边界。真正限制影响范围的，是资料目录与用户日常的 Chrome 分开：默认情况下，Agent 碰不到用户自己的登录状态和标签页。

- **页面内容不可信**：所有快照、文本、控制台输出都标 `untrusted: true`，工具描述里写明不要执行页面里出现的指令。
- **风险判定**（`plugins/riffet/browser/risk.ts`）：根据点击或回车目标的可访问名称、文字、`id`/`name` 和是否提交表单分类：`send`、`submit`、`delete`、`order`、`pay`。词表移植自 Android 的 `RiskClassifier`。
  - `pay`：拒绝执行（`BROWSER_HANDOFF_REQUIRED`），要求 Agent 调 `browser_handoff`。
  - `order`：每次都要本人确认。
  - 其余类别：`localhost`、`127.0.0.1`、`*.localhost` 和插件页「无需确认」里的站点（设置 `allowSites`）直接放行，否则请本人确认。
  - 确认：面板顶部显示类别和目标文字，带「允许 / 拒绝」，同时发一条通知；120 秒无人回答为 `BROWSER_CONFIRM_TIMEOUT`，拒绝为 `BROWSER_DENIED`。允许后按 ref 重新定位再执行。
- **站点策略**：插件页「禁止访问」（设置 `blockSites`，JSON 数组，也接受逗号分隔的旧值；`*.example.com` 含子域）。在网络层（`context.route`）拦截，重定向也拦得住；`browser_open` 到被禁止的站点返回 `BROWSER_BLOCKED_SITE`。路由会关闭 HTTP 缓存，所以只在列表非空时安装。
- **审计**：每个改变页面的动作写一条记录（目标、类别、放行依据），格式同 `device-actions`；B3 补前后缩略图，进会话时间线。
- **不开放的能力**：不连接用户日常的浏览器、不导入它的 cookie、不开 CDP 端口、不执行任意 JS、不读其他会话的标签页。

## 7. 各端分工

| 端 | 选择 | 画面 | 操作 |
| --- | --- | --- | --- |
| Web | 「技能与工具」 | 右侧区 | 是 |
| Mac | 「技能与工具」 | 详情栏，原生 | 是 |
| iOS / Android | 「技能与工具」（`ToolGroups.picks`、`pluginGroups`，共享在 `apps/mobile/client`） | B3 只读 | 否（收到交接通知后跳到 Web 或 Mac） |

支持的后端就是支持 Riffet MCP 按次注入的那些：Claude、Codex、Droid、Pi。Cursor、DSH 显示该能力不可用。

## 8. 分期

- **B1 工具**：`agentTools` 扩展点、`riffet.browser` 插件、引擎与资料、7 个工具、风险判定与确认、「技能与工具」各端条目、设置页（下载、资料、站点策略）、doctor（浏览器是否可用；Linux 上缺系统库时给出提示）。这一期还没有画面，Agent 靠截图工作。
- **B2 画面与共同操作**：`channels` 扩展点、Web 面板、Mac 原生面板、用户输入、`browser_handoff` 与「完成」后续投。
- **B3**：审计缩略图和时间线回放、移动端只读画面、开发诊断补强（性能、请求详情）。还有远程服务器场景下用本机 Mac 的浏览器：Mac App 用自带的 node 运行同一个引擎模块，作为 `platform: 'mac'` 的设备上报 `browser.*` 能力，工具经设备通道转发，界面上选「浏览器 · 这台 Mac」。

## 9. 否决的做法

- **WKWebView 作引擎**：没有 CDP；safaridriver 驱动不了 App 内的 WKWebView；`evaluateJavaScript` 合成的点击不是可信事件，有时静默失效；只有 Mac 能用，远程服务器场景还要多绕一层。
- **在 Mac 里内嵌 CEF**：包体增加 200 MB 以上，签名与公证成本高，Web 端仍然要另一套方案。
- **默认连接用户日常的 Chrome**（扩展或 `--autoConnect`）：Agent 能碰到全部标签页和登录状态；扩展守护进程只听 localhost，远程服务器连不上。
- **另外注入一个 playwright-mcp**：绕过会话工具组、风险判定、`untrusted` 标注和审计；工具名和生命周期不受 Riffet 控制；和画面不是同一个浏览器实例时，用户看到的不是 Agent 在操作的页面。
- **agent-browser 作底层**：多一个 Rust 守护进程要分发和监管；它的快照加 ref 方案 Playwright 1.64 已经公开提供。
- **单独的「浏览器开关」或按端配置**：违背 DECISIONS 2026-11-10，统一放进「技能与工具」。
- **面板跟随尺寸重排视口**：Agent 的快照、截图和用户看到的布局会对不上。

## 10. 待定与风险

- 资料目录按项目共享还是按会话隔离：按项目更省事（登录一次），按会话更干净。当前选按项目。
- 无头 Chromium 不支持 passkey 和浏览器扩展，碰到这类网站只能交接给用户，在用户自己的浏览器里完成。
- `page.screencast` 是 1.59 起的公开 API，帧率与延迟要实测；不够时再退回 CDP 的 `Page.startScreencast`（只限 Chromium）。
- Droid、Pi 的 MCP 调用超时未确认（DEVICES §2 同样待确认），影响 `browser_handoff` 的等待时长。
- Linux 服务器缺少 Chromium 依赖的系统库和字体，靠 doctor 提示，不替用户安装。

## 11. 参考

| 项目 | 许可 | 借鉴点 |
| --- | --- | --- |
| [microsoft/playwright](https://playwright.dev/docs/api/class-locator) | Apache-2.0 | `ariaSnapshot({ mode: 'ai' })`、`getByRef`（1.64）、`page.screencast` 的 `onFrame` 与 `showActions` |
| [microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp) | Apache-2.0 | 工具划分、快照模式、`--allowed-origins` 不是安全边界 |
| [vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser) | Apache-2.0 | 只保留可交互元素的快照、按会话隔离、实时预览 |
| [ChromeDevTools/chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp) | Apache-2.0 | 控制台、网络、性能诊断 |
| [dsh-browser](https://github.com/Noext/dsh-browser)、[glassbox](https://github.com/nikolasss4/glassbox) | — | 交接工具、接手期间禁止 Agent 读写、画面回放 |
| [Sunalamye/MCPWebKit](https://github.com/Sunalamye/MCPWebKit) | — | WKWebView 加 JS 注入的上限（作为否决依据） |
