# Code Studio

Code Studio 是一个工作台页面，按 IDE 的方式读一个项目：左侧是模块或文件夹，中间是标签页和打开的文件，右侧是结构，底部是查找结果。它面向在 Android Studio 里只用来看代码的场景：大仓库（抖音 Android：38.6 万个文件、2249 个 Gradle 模块）在 Studio 里同步和索引都很重，这里不需要 Gradle 同步，也不编译。

状态：**服务端与 Web 已实现（第一版）**；Mac 与手机不做（见「各端」）。

## 1. 组成

| 部分 | 位置 | 职责 |
| --- | --- | --- |
| 声明索引 | `apps/server/src/workspace/symbols/` | 子进程用 tree-sitter 解析 Kotlin 与 Java 并直接写进按项目的 SQLite，按文件大小与修改时间增量更新；服务主线程只分派路径、读进度和查询 |
| 跳转与引用 | `apps/server/src/workspace/code-nav.ts` | 原有的基于搜索的导航；索引就绪时先查索引，按类名查引用时只扫引用了它的文件 |
| 接口 | `apps/server/src/routes/workspace.ts` | `/api/projects/:id/code/{symbols,outline,index,modules,definition,references}` |
| 契约 | `packages/contracts/src/workspace.ts` | `CodeSymbol`、`CodeOutline`、`CodeIndexStatus`、`CodeModules` |
| 宿主组件 | `apps/web/src/plugins/CodeFile.tsx` | `UiKit.CodeFile`、`UiKit.FileIcon`：文件面板读文件的同一套实现（CodeMirror 与 Shiki、图片、二进制） |
| 页面 | `plugins/riffet/studio`（内置插件 `riffet.studio`） | `main` 位置的单实例视图 |

数据与读文件由核心提供，页面放在内置插件里，可以整体关掉。插件经 `WebPlugin.access.requests` 只声明项目的 `files`、`find`、`search`、`code/` 与 `git/{head,file,blame}` 路由。

## 2. 页面

- 布局不设单独的工具栏。左栏顶部：有互联服务器或多个项目时是服务器与项目两个下拉框（分开选，项目多时不用在一张合并的长列表里找；每台服务器记住自己上次打开的项目），下面是树的标题行：视图名、在树中定位当前文件、全部折叠、视图菜单（`list-filter` 图标，模块 / 文件，当前项打勾）。右侧第一行是标签栏，行尾是搜索与结构面板开关。
- 模块：构建文件（`build.gradle`、`package.json` 等）所在的目录按路径嵌套，只通向一个东西的目录并成一行。展开模块后依次是 `manifests`、源码根（`java`、`kotlin`，只含一个目录的包并成 `com.example.app` 一行；非 `main` 的源码集标在名字后）、`res`、`assets`、嵌套模块、其他目录和构建脚本。目录在展开时才读，列表只画看得见的行。
- 搜索：一个弹窗（`UiKit.QuickPanel`，与 ⌘P、⌘K 同一种），连按两次 Shift 或标签栏的搜索按钮打开。页签 All、Classes、Files、Symbols、Text、Actions，Tab / ⇧Tab 切换，查询在页签之间保留，再打开时选中上次的查询。
  - All 列出类、文件、符号与命令各前几条；查询为空时 All 与 Files 列出最近打开的文件。
  - 类名按整名、前缀、驼峰首字母（`FF`）和名字里后面的词（`Fragment` 找到 `FeedFragment`）匹配，符号只按前三种。`Name:120`（或 `Name:120:8`）打开到该行，`:120` 跳到当前文件的那一行。
  - Text 是 Find in Files：区分大小写（⌥C）、整词（⌥W）、正则（⌥X）、文件类型（`*.kt, *.java`，遵守 `.gitignore`）、项目或当前文件所在模块；下方预览选中的那一处。⌘/Ctrl+↵ 把全部结果放进底部面板。
  - 不把「没搜完」写成「没有」：索引没建好时类与符号给出提示；文本搜索到了时间或大小上限、有文件读不了、或还有更多结果时，列表末尾写明；搜索失败显示原因。
  - Actions：定位、引用到会话、结构面板、切换视图、折叠树、重建索引、关闭全部标签。
- 跳转：⌘/Ctrl 点击标识符跳到声明；有多处时在底部列出；点在声明本身上列出引用。右键直接查引用，结果可在模块与项目之间切换。
- 路径栏：把文件引用到会话；在树里定位在树的标题行（两种读法都展开到该文件）。点行号引用那一行。引用会转到该项目的新会话页并加进输入框（`NavigationService.quote`）。
- 结构：当前文件的声明，按嵌套缩进；滚到哪一段就标出哪一个声明。
- 状态栏：索引进度或符号数，可重建；当前可见的首行。
- 快捷键只在页面内生效：⇧⇧ 打开搜索（All），⌘/Ctrl+O 找类，⌘/Ctrl+⇧+O 找文件，⌘/Ctrl+⌥+O 找符号，⌘/Ctrl+⇧+F 全文搜索。⌘B 留给工作台的侧栏开关。
- 页面文字整块英文，与 Git 面板、Trace 相同；页面名 Code Studio 各语言相同，与工具名保留英文的做法一致。

打开的标签、当前文件、最近打开的文件、文本搜索的选项、树的读法和结构面板开关按服务器与项目记在这个浏览器里（`localStorage` 的 `riffet.studio.v1`），不同步。

## 3. 索引

- 位置：数据目录下 `code-index/<项目根路径的哈希>.db`，可随时删除，下次查询时重建。
- 何时建：只在 Code Studio 页面可见时建。页面每 `CODE_INDEX_BUDGET.watchMs / 3` 续一次「观察」（`POST .../code/index/watch`），索引没有或距上次核对超过 `recheckMs` 时开始建或增量核对；离开页面（切到别的页面、浏览器标签进后台、关闭）时页面撤销观察，或 `watchMs`（15 秒）内没有续约，服务端立即中止建库并杀掉解析子进程，已写完的批次保留，下次接着做。查询（页面的搜索、Files 面板的跳转与引用、Agent 的 `code_*` 工具）只读现有索引，不会开始建或核对。
- 离开页面时页面上进行中的请求都中止：引用与文本搜索（服务端随之杀掉 ripgrep，回到页面重跑）、blame 与提交版本读取（杀掉 git，回到页面接着读）、搜索弹窗；模块列表读过后不重读。
- 新鲜度：索引是上次核对时的内容；用它回答时再加上自上次核对以来变过的文件（与核对时的 git HEAD 比较的差异、核对时就未提交的文件、未跟踪文件），这些文件直接读。取不到这份清单（非 git 仓库、git 超时、超过 `changedFiles`、服务刚重启还没做完第一次核对）时索引不回答「没有」，退回扫描。刚创建且没 `git add` 的文件最长 20 秒看不到。
- 释放：`CODE_INDEX_BUDGET.idleCloseMs` 无人查询就关库；同时打开的库至多 `openIndexes` 个；解析子进程建完即退出，内存全部还给系统。
- 范围：文件清单里的 `.kt`、`.kts`、`.java`，以及 `res/<目录>/<文件>` 形式的 Android 资源文件；超过 `fileBytes` 的源文件不解析，但会作为每次成员引用查找的候选。除声明外还存每个源文件出现的标识符（倒排）和资源定义位置。其他语言的结构面板为空，跳转仍走原来的搜索。
- 整词文本搜索走倒排（抖音，索引就绪后，2026-11-23）：`mFollowType`（2 个文件）限 `*.kt,*.java` 整词 39 ms–1 秒（首次含变动文件清单约 1 秒），原先全仓扫描 20 秒仍不完整；`getContext` 读满 50 条 0.2–0.4 秒；事件循环最长卡顿 20–50 ms。`include` 含其他类型或不是整词标识符时仍全仓。文件名搜索（`rankPaths`）改分片后事件循环卡顿由 130–200 ms 降到 8–15 ms，耗时不变（100–250 ms）。
- 文件名候选与未跟踪清单（抖音，51.6 万条路径，2026-11-23）：构建文件名候选原先一次同步算完约 0.75 秒，整个服务停住；现分片让出事件循环，总耗时约 0.45 秒，事件循环最长卡顿 12–18 ms。未跟踪清单改用 `git status -unormal` 加新目录展开，约 2–5 秒（`ls-files -o` 约 15 秒），刷新间隔由 60 秒缩短到 20 秒。内容搜索（限 `*.kt,*.java`、整词、区分大小写）首页 7–11 秒（冷盘），常见词 0.1 秒；找不到的罕见词扫完全仓会撞 20 秒上限，响应标 `incomplete: 'time'`。
- 实测（抖音 Android，34.1 万个文件：27.6 万个源文件加 6.6 万个资源文件，2026-11-23）：全量建索引约 5 分钟（不含倒排与资源时约 3.5 分钟），库 1.43 GB（其中倒排 157 MB、939 万行；声明 412 万个、资源 32 万行）；服务进程常驻内存建库前后都在 250–350 MB，事件循环最长卡顿不到 1 秒；无变化的核对约 7 秒；类名搜索 1–30 ms；类的引用按 import 收窄时 14 ms（全仓扫描 13 秒以上；之后改为按倒排读，见下）；跳转到库里的类 73 ms。成员引用：罕见方法名 6 ms（ripgrep 16 秒），`onViewCreated`、`getContext` 这类常见名读满 1000 条约 110–140 ms（ripgrep 1.5–2.3 秒，倒排查询本身 13–20 ms）；`R.layout`、`R.string`、`R.id` 与 xml 里的 `@+id` 跳转 0–10 ms。变动文件清单（`changedSince`）：暂存区没变时约 100 ms，2 秒内重复调用走缓存；加上它之后，罕见名引用冷启动约 100–270 ms、常见名读满 1000 条 240–280 ms；库里的类（`Bundle`）定义跳转 105 ms（取不到清单时要扫描全仓，18 秒）。解析子进程的内存主要是 tree-sitter 的 wasm 堆，随解析的文件数增长（1 万个文件约 770 MB，取词与资源解析只多约 13 MB），所以每个子进程解析 `workerRecycleFiles`（1 万）个文件后换掉，建库时四个子进程合计约 3 GB。
- 上限都在 `packages/contracts/src/budgets.ts#CODE_INDEX_BUDGET`。

## 3.1 Git

只读，供行号旁的作者标注和与 HEAD 的对比用；路由在 `apps/server/src/routes/git.ts`，实现在 `apps/server/src/git/{index,read}.ts`，契约 `GitHead`、`GitFileAtRev`、`GitBlame`，上限 `GIT_READ_BUDGET`。

- `GET /api/projects/:id/git/head` 返回 `{ branch?, head, short }`（游离 HEAD 没有 `branch`）。不是仓库时 `NOT_A_GIT_REPOSITORY`（422），没有提交时 `GIT_NO_COMMITS`（409）。
- `GET .../git/file?path=&rev=HEAD`：`rev` 只能是 `HEAD` 或 7–64 位十六进制哈希，其他表达式 `INVALID_REV`。一次 `cat-file --batch`；文本超过 `FILE_BUDGET.previewTextBytes` 时截断并带 `truncated`，二进制只带 `binary`，该提交里没有这个文件带 `missing`。
- `GET .../git/blame?path=&start=&end=`：对工作区文件执行 `git blame --porcelain -L`，未提交的行哈希全零（不在 `commits` 里）；范围超过 `blameMaxLines` 时从 `start` 起截断，超过文件行数时截到文件末尾，返回的 `end` 是实际范围。超过 `blameMs` 杀掉子进程，返回 `GIT_TIMEOUT`（504）；抖音上整文件 blame 超过一分钟，120 行的窗口冷缓存 4–21 秒，同一窗口再读约 4 秒。
- 同一仓库的 blame 一次只跑一个，后来的排队（至多 `blameWaiting` 个，再多返回 `GIT_BUSY` 429）；请求断开时排队的退出、运行中的子进程被杀。结果按（仓库、HEAD、路径、文件修改时间与大小、范围）缓存在一个按条数、字节和空闲时间限制的 LRU 里，滚回去不再调用 git。
- 不联网：读取都带 `--no-optional-locks` 与 `GIT_NO_LAZY_FETCH=1`（git 2.44 起），部分克隆里缺的对象返回 `GIT_OBJECT_UNAVAILABLE`，不去远端拉。

页面上：
- 状态栏显示分支（游离时显示短哈希）；窗口回到前台或页面重新可见时再读一次。不是仓库或 git 答不上来时不显示任何 git 内容。
- 行号右侧的改动标记：打开文件时读它在 HEAD 的版本（`UiKit.CodeFile` 的 `baseline`），新增的行绿条、改过的行强调色条、删掉的地方一道红线，在浏览器里比对，不再调 git。新文件整篇算新增；二进制或被截断的不标。最近 20 个文件的 HEAD 版本留在页面里。
- 作者标注（Annotate with Git Blame）：路径栏的提交图标或 Actions 打开，只对当前文件，换文件即关。按看得见的行每 200 行一块去读，滚到哪读到哪，同时只有一个在读；未提交的行留空。读的时候按钮转圈；失败先静默重试一次（被超时打断的那次已经把 git 的缓存焐热），再失败才提示并关掉。点一行复制它的提交哈希。
- 提交详情、分支比较、改动文件列表用右侧的 Git 面板，这里不重做；单个文件的历史在抖音上要十几秒，暂不做。

## 4. 多服务器

项目文件属于 A 类工作对象。页面列出所有互联服务器的项目（按服务器分开选，见「页面」），请求经按对象选服务器的请求层发到项目所在的服务器，索引建在那台服务器上；链接策略沿用 `/api/projects` 前缀的 `serve`。打开的标签等记录属于 C 类，只在本浏览器。

## 5. Agent 工具

内置插件 `riffet.studio` 声明工具组 `riffet.studio/code`（前缀 `code_`），把同一份索引给 Agent，与 `riffet.browser/browser` 一样在输入框「技能与工具」里按会话选择，选了才出现在这条会话的 Riffet MCP 里。实现在 `plugins/riffet/studio/tools.ts`，经 `host.code`（`PluginHost.code`，核心的只读代码导航，见 [PLUGINS.md](PLUGINS.md)）取数，不自己读文件。

| 工具 | 参数 | 回答 |
|---|---|---|
| `code_search` | `query`、`types?`、`limit?`（至多 40，默认 20） | 声明：`kind 名称 path:line (包名)`，好的在前 |
| `code_definition` | `path`、`line`、`word`、`column?` | `path:line  行文本`；`column` 缺省取该行第一个 `word`，同行出现两次时再传 |
| `code_references` | `path`、`word`、`scope?`（`module` 缺省、`project`）、`limit?`（至多 100，默认 40） | `path:line  行文本`，附总数 |
| `code_outline` | `path` | 一个文件的声明及行号，不要索引 |
| `code_index_status` | 无 | 索引状态与规模 |

- 只作用于这条会话所属的项目：没有项目参数，`projectId` 取自会话，经 `host.code` 走与项目路由相同的路径检查（`resolveScopedPath`），读不到项目外的文件。没有项目的会话得到 `NO_PROJECT`。
- 路径是项目相对路径，行列从 1 起；输出是单行 JSON，行文本截到 160 字符，列表有上限并写明还有多少没列出。
- 不把「没答出来」写成「没有」：每条结果带 `indexReady`（索引就绪且覆盖全部文件）与 `index`（`ready`、`building 35%`、`failed`、`partial` …），引用另带 `complete`；`code_search` 在索引没好、失败或被截断时附 `note`（如「Index building 35%; results may be missing, fall back to rg」）；跳转与引用在索引没好时由核心扫描项目作答，所以只在跳转为空（「confirm with rg」）或引用超出预算（`complete: false`）时附 `note`。Agent 的调用不会开始建索引：没建过时 `note` 说明索引只在 Code Studio 打开时建，让它退回 rg。
- 描述里写明：大型 Kotlin、Java、Android 仓库优先用它而不是 grep；其他语言只有文本扫描的跳转与引用，没有结构。
- 多服务器（[规范](guide/multi-server.md) §2）：属于 A 类工作对象。工具在会话运行的服务器上执行，查那台服务器上的项目与它的索引；没有跨服务器的参数，也不查别的项目（§3.6：普通会话的 Riffet MCP 不提供经链接的工具）。工具组的作用范围随 `agentTools` 的登记（对象）；对端离线时会话本身不可用，工具随之不可用。

## 6. 各端

- Web：已实现。
- Mac：W 类（会话中会读到的代码），暂不做原生页面；视图只声明 `web`。
- 手机：不做。手机上读代码用文件面板。

## 7. 不做

调试器、布局预览、实时编译诊断、重构、编辑（改代码在文件面板或交给 Agent）、LSP（kotlin-lsp 要导入 Gradle 模型，2800 个模块的仓库不可行）、借 Android Studio 的索引（要 Studio 开着）。
