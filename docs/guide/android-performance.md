# Android 流畅度规范

返回 [中文 README](../../README.zh-CN.md)。

本文规定 Android 客户端的帧预算、主线程上能做什么、怎么测，以及每次改动要跑的场景。内存、缓存、流队列这类资源预算在 [性能与资源规范](performance.md)，本文不重复；Compose 写法的细则在 [apps/mobile/AGENTS.md](../../apps/mobile/AGENTS.md)「Compose 约定」，本文给出它们背后的预算和验证方法。

规则来自 2026-11-21 的一次排查：在模拟器上造了 48 个会话（一个 260 轮、带图表与表格的长会话，700 行的编辑，6000 行的命令输出，成组的截图），走遍列表、转录、终端、文件、Git、图片、设置与断网恢复。找到的问题和改法记在每条规则下面。

## 1. 预算

主线程时间按「输入到提交渲染」计（`SyncQueued − HandleInputStart`，见 §3.2），在 benchmark 构建上量。

| 场景 | 每帧主线程 | 说明 |
|---|---|---|
| 滑动与拖动（列表、转录、面板、图片平移） | p99 ≤ 8 ms，单帧不超过 16 ms | 滑动途中不建 WebView、不解析、不解码 |
| 一次点击引起的变化（展开、切页、打开面板） | 单帧不超过 32 ms | 超过的部分拆到后台或分帧 |
| 打开会话、冷启动后首屏 | 单帧不超过 50 ms；冷启动 `TotalTime` ≤ 400 ms | 模拟器数值，真机应更低 |
| 静止页面 | 0 帧 | 只有可见的动效（品牌标志、运行中的计时）可以出帧，看不见时停 |
| 后台与断线 | 不出帧；断线 30 秒 CPU 不超过 0.5 秒 | 重连按 `RetryPolicy` 退避，不轮询界面 |

模拟器（`readme_pixel`，SwiftShader）的渲染线程很慢，总帧时没有参考价值，只看主线程时间。真机结论以真机为准；模拟器上主线程时间翻倍的改动，在真机上同样是退步。

## 2. 规则

每条写明它防的是什么，以及这次排查里的实例。

### 2.1 主线程不做随内容大小增长的工作

解析、diff、语法高亮、转义、解压、UTF-8 解码、图片解码都随输入变大。它们放在 `Dispatchers.Default` 上做，或在 presenter 的 `prepare` 钩子里做；组合阶段只读结果。小输入可以同步算，但要有明确的阈值常量。

- 图表预览每块都在主线程上把 5 MB 的渲染页解码、转义四遍、再交给 WebView：快速滑过时单帧 120–218 ms。改为后台解码、单遍转义，并按引擎缓存转义后的渲染页（`ServerContentPreview.kt` 的 `RendererShells`）。
- 编辑的 diff（最多 120 万格的 LCS）和逐行高亮在组合里算：超过 `SYNC_DIFF_CHARS` 的改到后台，先占住块的高度（`DiffBlock.kt`）。

### 2.2 能变大的内容只组合可见的部分

行数可能过百的内容用 `LazyColumn`，嵌套在转录里时给出有界高度（`heightIn(max = …)`）。需要按最宽行对齐时，量最长的几行定宽，不用 `IntrinsicSize.Max` 让每一行都量两遍。

- 700 行的编辑展开时一次组合 1100 行，单帧 845 ms；改成懒加载、量最长 8 行定宽后 27 ms，块内快滑每帧不超过 9 ms。

### 2.3 重量级视图等列表停下再创建

WebView、视频、地图这类视图的创建和加载都在主线程上有固定开销。在列表里，它们等列表停止滚动（`LocalListSettled`）再创建，之前显示同尺寸的占位；同类视图共用的大资源只取一次。

### 2.4 派生值按输入的身份缓存，不按列表的身份

流式更新时，每帧都有一份新的行列表；只要某一行的对象没变，它的派生值就不重算。按行键加对象身份做记忆（`ToolRun.kt` 的展示缓存），不要用整份列表做 `remember` 的键去算每一行。

### 2.5 每次按键、每帧只算用得到的东西

输入框的每次按键、流的每一帧，只算当前会显示的结果。正则写成顶层常量，不在函数里每次编译。

- 输入框每次按键都对全部会话做一次过滤和四键排序，即使没有打开 @ 提及；改为只在提及打开时、按查询记忆（`Composer.kt`）。
- 运行中通知的「当前步骤」每个流帧在主线程上算一次；改到 `Dispatchers.Default`（`RiffetHost.kt`）。

### 2.6 组合和高频路径上不调系统服务

Binder 调用（`LocaleManager`、`PackageManager`、`ConnectivityManager`）和 `createConfigurationContext` 都可能耗毫秒。结果在状态变化的回调里取一次，用时读缓存。

- 每个宿主字符串都经过 `AppLanguages.localize`，每次两个 Binder 调用加一个新的配置上下文，包括组合阶段；改为在 `refresh` 时解析一次。

### 2.7 失败的网络结果不缓存

磁盘缓存只存成功的响应。失败要能被下一次请求或「点按重试」恢复。

- Coil 3 的默认策略把 404 存进磁盘缓存并在以后每次重放：Agent 提到、但当时还没写出的图片，此后永远显示「图片加载失败」，重试也一样。改为只存 2xx 与 304（`TimelineImages.kt` 的 `SuccessOnlyCacheStrategy`）。这个问题在 debug 包上不出现，只因 debug 包里恰好没缓存过失败。

### 2.8 截断的数据要能取全

服务端按同步预算截断的行（`truncated`）在读者打开时取全行（`SessionStore.expandRow`）。在取全之前，不把截断后的内容当成完整数据去计算统计和 diff。

- 截断的编辑只剩旧文本的开头、新文本为空，显示成「整段删除，−194」；打开时取全行后为 +466 −466。取全行的解码曾因服务端的行内容不带 `seq`、`rev` 而对工具行全部失败（`SessionSync.kt` 的 `expandedRow`，`ExpandedRowTest` 覆盖）。

### 2.9 看不见的不画

隐藏的页面、标签页和后台不出帧（`visualWorkActive`、`rememberVisualWorkVisibility`）。无限动效只在可见时运行。

### 2.10 只在 benchmark 构建上下结论

debug 构建可调试，代码大多解释执行，帧时是 release 的数倍，热点分布也不同。量、比、写进文档的数字都来自 benchmark 构建（§3.1）。

## 3. 测量

需要 `adb` 在 `PATH` 里。模拟器可以无窗口启动（`emulator -avd <名字> -no-window -no-audio`），App 经 `adb reverse tcp:<App 里的端口> tcp:<服务端口>` 连到本机的测试服务。

### 3.1 构建

```bash
cd apps/mobile && ./gradlew :androidApp:assembleBenchmark
adb install -r androidApp/build/outputs/apk/benchmark/androidApp-benchmark.apk
adb shell cmd package compile -m speed -f io.github.riffable.android.benchmark   # 免去 JIT 预热，前后对比时先做
```

benchmark 是 release 的代码（R8 收缩、不可调试），用仓库的 debug 签名、单独的包名 `io.github.riffable.android.benchmark`，可以和 debug 包并存；关掉了 R8 的混淆与优化（`benchmark-rules.pro`），并在清单里声明 `profileable`，所以 simpleperf 能看到真实的类名和方法名。

### 3.2 数据、帧与采样

```bash
pnpm perf:android seed /tmp/riffet-perf --server http://127.0.0.1:4399   # 造会话、项目、图片并导入
pnpm perf:android frames reset
# 操作 App
pnpm perf:android frames report 转录快滑
pnpm perf:android profile 8 'riffet\.ui\.timeline'                        # 采样主线程 8 秒，期间操作 App
```

- `seed` 写的是 Claude Code 的转录文件，服务端以 `CLAUDE_CONFIG_DIR=<目录>/claude RIFFET_ENV_KEEP=CLAUDE_CONFIG_DIR` 启动，`--no-auth`，不碰正式服务。不调用任何 Agent。往某个转录文件追加行，服务端会实时读到，可以模拟进行中的会话。
- `frames` 读 `dumpsys gfxinfo` 最后 120 帧。帧数超过 120 的场景拆开量。
- `profile` 用 simpleperf 的 `cpu-clock`（模拟器没有硬件计数器），按包含时间列出 App 的帧。看到某个函数占比高，再用 `simpleperf report --symbols '<名字>' -g callee` 看调用方。
- 需要完整时间线时用 `pnpm trace:android`（Perfetto），把包名作为第二个参数传 benchmark 包。

## 4. 场景回归清单

改动涉及下列任一页面时，在 benchmark 构建上跑对应场景，结果写进 PR 描述。

| 场景 | 操作 | 通过 |
|---|---|---|
| 任务列表 | 慢滑、快滑各 4 次，上下各半 | §1 滑动预算 |
| 长转录 | 打开 260 轮的会话；连续上滑 12 次（加载更早的页）；慢滑 | 打开 ≤ 50 ms；滑动预算；不跳到中间再跳回底部 |
| 图表与表格 | 快滑经过含 mermaid、公式、表格的回答 | 滑动中不建 WebView；停下后出图 |
| 大编辑与长输出 | 展开 700 行编辑、6000 行输出、2100 行读取 | 单次展开 ≤ 32 ms；块内快滑符合滑动预算；统计与内容完整 |
| 图片 | 展开成组截图，打开查看器，双击缩放，平移，下载 | 首次失败的图片在文件出现后能加载 |
| 输入框 | 聚焦（键盘起落）、连续输入 60 个字符、输入 `@` 和 `/` | 每帧 ≤ 16 ms |
| 进行中的会话 | 每 0.5 秒追加一轮，持续 10 秒 | 每帧 ≤ 16 ms；未变化的行不重算 |
| 终端、文件、Git | 打开 shell；打开 1 MB 日志并快滑；打开 diff | 打开 ≤ 50 ms；滑动预算 |
| 设置 | 逐个打开子页并上下滑 | 单帧 ≤ 32 ms |
| 断线与恢复 | 停掉服务 30 秒，再启动；切到后台 20 秒再回来 | §1 断线预算；恢复后数据补齐 |
| 冷启动 | `am force-stop` 后 `am start -W` 三次 | `TotalTime` ≤ 400 ms |

## 5. 检查

- `pnpm check:compose`：组合阶段的写法（`apps/mobile/AGENTS.md`）。`ui/timeline/` 下的 `withContext(Dispatchers.…)` 与 `produceState` 会被拦下，确实占住了最终尺寸的，在该行写 `compose-pitfalls: allow <原因>`。
- `pnpm check:perf`：缓存上限与流队列（[performance.md](performance.md) §3）。
- 代码审查时按 §2 逐条看：新出现的「随内容增长的工作」在哪个线程上、列表有没有回收、重量级视图何时创建、缓存键是不是对象身份、失败会不会被缓存。

## 6. 现状

与规则不符的现有代码。改掉哪条就删哪条；新留下的不一致也记进来。

- §2.4：`TimelinePresenter` 把输出速率放在输入里，速率每变一次就重新呈现整份转录（在后台线程上），会话页随之重组；输入框也随每次车道更新重组。速率应单独成流。
- §2.1：文件预览按 `\n` 切分整份文本在主线程上（`FilesPanel.kt` 的 `TextPreview`）；1 MB 日志打开时单帧约 17 ms，快滑时测量占主线程大头（行宽变化引起整列重测）。
- §2.2：斜杠菜单、项目选择面板、助理面板、配置选择器用 `Column + verticalScroll` 一次组合全部条目（`SlashMenu.kt`、`ProjectPickerSheet.kt`、`AssistantSheets.kt`、`ConfigPickers.kt`、`ToolsPicker.kt`）。
- §2.1：`CodeBlock` 与 `CodeLines` 在组合里高亮，上限 20 万字符（`TimelinePrimitives.kt`、`SyntaxHighlight.kt` 的 `MAX_HIGHLIGHT_CHARS`）。
- §2.8：服务端截断 diff 时旧文本先用完 16 KB 预算，新文本被截成空（`apps/server/src/timeline/budget.ts` 的 `clipped`），折叠行上的增删统计在读者打开前是错的；Web 与 iPhone 同样受影响。
- §2.5：统计页的图表动画每帧在组合里重采样所有曲线（`StatsCharts.kt` 的 `rememberMorphedTracks`）。
- 冷启动没有应用自己的 Baseline Profile，只有依赖库自带的。
