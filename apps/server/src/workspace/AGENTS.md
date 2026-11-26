---
module: server.workspace
verify:
  - npx vitest run apps/server/src/workspace
---

## 职责

项目目录里的文件操作：列目录、预览、搜索、下载、编辑与增删改名、附件、代码跳转和系统目录选择器，全部限定在项目范围内。行为说明见 `docs/guide/workspace.md`。

## 入口

- `index.ts#WorkspaceService`：对外的全部文件操作。
- `scope.ts#resolveReadablePath`：路径解析与读取边界的唯一入口。
- `write.ts#FileWrites`：保存、新建、移动、删除与撤销；`write.ts#resolveWritablePath` 是写入边界的唯一入口。
- `file-index.ts#FileIndex`：文件名搜索的路径清单，来自 git 或 ripgrep。
- `code-nav.ts#CodeNav`：基于搜索的定义与引用，不用编译器。
- `download.ts#zipStream`：文件夹打包。
- `symbols/indexes.ts#SymbolIndexes`：按项目持久化的 Kotlin / Java 声明、标识符倒排与 Android 资源索引，由 `WorkspaceService` 持有；比对、解析和写库都在 `symbols/parse-worker.mjs`（子进程，由 `symbols/pool.ts#WorkerPool` 拉起并回收；服务退出时子进程随 IPC 断开自行退出），主线程的 `symbols/store.ts#SymbolStore` 只建表和查询。

## 不变量

- 所有读取先过 `scope.ts#resolveReadablePath`，它做符号链接解析、项目范围检查和凭证路径拒绝。不要在 `index.ts` 里直接 `readFile` 用户给的路径。
- 所有写入先过 `write.ts#resolveWritablePath`：只在项目内，拒绝项目目录本身、任何 `.git` 路径段、状态目录与凭证目录；不要在别处对用户给的路径 `writeFile` / `rename` / `rm`。`.git` 按磁盘的匹配方式判断（不分大小写，忽略 Windows 会去掉的结尾点和空格），并且对写名和真实位置各判一次：不区分大小写的 macOS 卷上 `.GIT/config` 就是 `.git/config`，指向 `.git` 的链接也是；还不存在的路径按最深一层已存在的目录解析真实位置。
- 保存必须比对 `expectedHash` 与磁盘当前内容的 sha256，并在锁里写入；保存、新建、移动、删除、撤销共用按项目的一把锁（`write.ts#FileWrites.locked`），否则移动和保存交错会把文件写回旧路径，「目标是否已存在」的检查也会被另一次写入抢先；`FilePreview.editable` 的条件要和 `save` 接受的一致，否则界面给了编辑入口却存不进去。
- 删除先写回收区槽位里的记录再移入文件：清理（`write.ts#FileWrites.prune`）只删过期、超量或很久以前留下的无记录槽位，先移文件再写记录时，并发的清理会把刚删的文件连同撤销一起删掉。
- 写入后调用 `noteWrite`（接到 `apps/server/src/backends/shared/workspace-observer.ts#noteEdit`），否则同时在跑的 shell 命令会把用户的修改算进自己的产出。
- 项目外的绝对路径只在 `allowOutsideRead` 打开时放行，且只能是已存在的常规文件，没有列目录和搜索（`scope.ts#resolveExternalFile`）；凭证目录与文件无论开关都拒绝，包括经符号链接指向它们（`scope.ts#isSecretPath`）。仅在只读读取路径上，当前 `stateDir` 下 Antigravity 会话的 `plugin-data/riffet.antigravity/sessions/<sessionId>/native/antigravity-cli/brain/<conversationId>/`、Cursor 助理的 `cursor-standing/{plans,projects/<slug>/terminals,projects/<slug>/agent-tools}/` 与 `~/.trae/cli/plans/` 产物文件可放行，同级配置/数据库、`.env`/密钥文件名、符号链接逃逸与写入仍拒绝（包括项目根在 `$HOME` 之上时的只读与 `editable: false` 校验）。只读图片路由（`readPreviewImage`、`SessionMedia` 与分享图片冻结）额外按 `generatedImageHomes` 放行已配置 Codex 目录下 `generated_images/<thread>/<image>` 的图片产物，即便 `allowOutsideRead` 关闭仍可读，但不影响同目录其他文件与凭证拒绝。
- `~/` 要在解析前展开成服务进程用户的家目录，预览图片与普通预览走同一个入口，否则同一个路径在两条路径上结果不同（`scope.ts#expandHomePath`）。
- 图片 MIME 由文件字节判断，不信扩展名（`index.ts#previewImageMimeType`）；读文件有字节上限，并在读完后再核对大小（`index.ts#readFileBounded`）。
- 附件的 base64 校验必须线性：正则按四字符一组匹配在几 MB 的数据上会溢出 V8 的正则栈，表现为 500；格式错误应报 400（`index.ts#WorkspaceService`）。
- 打包在 git 工作区里只含 git 会显示的文件，不在 git 中时跳过符号链接和 `node_modules` 等目录；超过上限要报错而不是给出不完整的包（`download.ts#gitArchiveEntries`）。
- 取消系统目录选择器靠退出状态和哨兵值判断，不解析本地化的 stderr，否则取消会被当成失败并回退到应用内浏览器（`index.ts#pickerCancelled`）。
- 插件的 `host.code`（由 `createApp` 接到 `WorkspaceService`）只能走 `WorkspaceService` 的 `symbolSearch`、`outline`、`definition`、`references`、`codeIndexStatus`，它们各自过项目范围检查；不要给插件开直接读文件或绕过 `scope.ts` 的入口。`definition` 的 `column` 可省（取该行第一个同名词）。
- 代码索引的库在 `<stateDir>/code-index/<项目根 sha256 前 16 位>.db`；索引只由 `SymbolIndexes` 打开和关闭：数量受 `CODE_INDEX_BUDGET.openIndexes`、空闲 `idleCloseMs` 限制，关闭先中止建库、终止 worker，再关库；worker 只在建库或单文件大纲期间存在，建完即终止，不常驻。行只由 worker 写：主线程不碰百万级的行，也不承担提交与 WAL 检查点（放在主线程时每次检查点卡住事件循环数秒）；每批文件的声明与它们的 size / mtime 在 worker 的同一事务里写入，中止后可接着做；声明总数由 worker 在事务里维护在 `meta`。标识符倒排（`postings(chunk, word, bits)`，按块优先排序，一批文件的行写在一起）只增不减：改过的文件只把新出现的词并进去，旧词留作假阳性，整库重建（`rebuild`）时清空，清空到重读完之间文件算「未读」（`files.unread`），查询会把它们都当候选；读不了的文件（超过 `fileBytes`、含 NUL、worker 死在它上面）同样。取词时含 `$` 的词（Kotlin 模板里的 `"$name"`、`Outer$Inner`）连同按 `$` 拆开的各段一起记，因为 ripgrep 的 `-w` 把 `$` 当词边界。比对变动文件只用 `git diff-files`、`git diff-index --cached` 并带 `GIT_OPTIONAL_LOCKS=0`：`git diff` 会刷新并改写 `.git/index`，和用户自己的 `git commit` 抢 `index.lock`。词的键是 `symbols/store.ts#wordHash`，`symbols/parse-worker.mjs` 里有同一份实现，两处必须一致；关键字与最短长度由 `symbols/store.ts` 传给 worker，不另写。改了提取的内容或表结构要加大 `symbols/store.ts#SymbolStore` 里的 `SCHEMA_VERSION`。

## 外部行为

- 依赖 git（`ls-files`、`archive`）与 ripgrep（`file-index.ts#ripgrepSearch`）；两者都不可用时调用方自己遍历目录。已跟踪文件清单随 git index 的 mtime 重读，未跟踪文件按 `UNTRACKED_TTL_MS`（20 秒）在后台刷新：用 `git status -unormal`（走 untracked cache，抖音约 2–5 秒；`ls-files -o` 要 15 秒）取文件和新目录，只把新目录再逐文件列出，目录超过 200 个时退回 `ls-files -o`。文件名候选（`file-index.ts#candidates`）与文件名排序（`rankPaths`）分片、让出事件循环，单片约 8 ms，不要改回一次同步算完（抖音 51 万条路径一次算要 0.75 秒，整个服务停住）。
- 内容搜索 `GET /api/projects/:id/search`（`WorkspaceService.search`，`file-index.ts#ripgrepSearch`，选项在 `search-options.ts`）：`q`、`limit`、`offset`、`path`（项目内目录）、`case=1`（区分大小写，默认不区分）、`word=1`、`regex=1`（默认按字面量）、`include`（逗号分隔的文件掩码）、`exclude`（掩码或目录），布尔值用 `1`/`true`。不带 `detail=1` 返回 `SearchHit[]`；带上返回 `SearchResults`：`more`（本页之后还有匹配）与 `incomplete`（`time` 超过 20 秒、`budget` 无 ripgrep 的遍历撞到文件或字节上限、`error` ripgrep 失败）。`incomplete` 时结果可能不全，不要当成「没有」。`include` 用 ripgrep 的文件类型（`--type-add mask:<glob> -t mask`）实现，不用 `-g`：`-g` 的包含模式会盖过 .gitignore，把被忽略的构建目录带进来；`exclude` 用 `-g '!…'`。带 `/` 的 include 掩码文件类型匹配不了，改成逐条命中过滤。整词标识符搜索走倒排（`index.ts#narrowedSearch`）：`word=1`、非正则、`q` 是单个标识符、`include` 只含 `*.kt` / `*.kts` / `*.java`（倒排只覆盖这些文件，别的类型必须全仓扫描）、索引完整且 `changedSince` 取得到、候选不超过 `CODE_INDEX_BUDGET.referenceFiles` 时，只对「倒排候选 ∪ 变动文件」（按 `path`、`include`、`exclude` 过滤，剔除已删除文件和符号链接）分批（500 个一批）跑 ripgrep；任一条件不满足就照旧全仓搜索。倒排的键是小写词的哈希（`symbols/store.ts#wordHash`，worker 里同一份），所以区分大小写与否共用一次查找，大小写在读文件时由 ripgrep 判定；关键字与短词按小写判断。无效正则返回 400 `INVALID_QUERY`，消息是 ripgrep 的；没有 ripgrep 时用 JS 正则（长度不超过 200）和同一套掩码语义。
- 大仓库预算：列目录页大小、遍历条目与深度、归档 2 万文件与 2 GiB、定义搜索的时间预算，均为 `index.ts`、`download.ts`、`code-nav.ts` 顶部的常量。
- 音视频不读进内存也不受预览上限约束：预览页的播放器经只含这一个文件的 file-site 地址按字节范围取（`apps/server/src/routes/workspace.ts#sendFile`，单段 `Range`，多段按整文件回答）；AVPlayer 不支持范围请求的地址不播放。
- macOS 用 osascript 唤起 Finder 选择器，其他平台回退到内置浏览器（`index.ts#directoryPickerCommand`）。
- 引用查找（类型、成员、字段、常量，`code-nav.ts#indexedWordScan`）：索引就绪且完整（无 `error`，即未被 `maxFiles` 截断）时，只读倒排给出的候选文件（与 `scope=module` 的模块目录取交集），候选超过 `CODE_INDEX_BUDGET.referenceFiles`、词短于三个字符或是关键字时退回 ripgrep。类型名同样只按倒排读：按 import 收窄会漏掉经 `import Outer` 写成 `Outer.Inner` 的嵌套类和写全限定名的用法，又报成完整。**新鲜度**：索引是上次核对时的内容，凡用索引回答（引用、定义第 4a 步、资源跳转）都再加上「自上次核对以来变过的文件」（`symbols/indexes.ts#SymbolIndexes.changedSince`）：核对开始时记下 git HEAD 与当时和 HEAD 不同的文件（只在内存里），之后取工作区对暂存区的 `git diff-files --name-only`（限时 `changedGitMs`，结果缓存 `changedTtlMs`）∪ 暂存区对那个 HEAD 的比较（要走遍全部跟踪文件，大仓库约一秒，所以 git 的 index 文件没变就沿用核对时的结果，变了才重算，限时 `changedIndexMs`）∪ 核对时就有改动的文件 ∪ `FileIndex.untracked`（沿用它 60 秒刷新一次的未跟踪清单，不另走 git；服务刚启动、第一次未跟踪遍历没完成时也算取不到），按索引覆盖的扩展名过滤；这些文件的内容直接读，不信索引里的旧行。取不到（不是 git 仓库、git 超时、变动文件多过 `changedFiles`、服务重启后第一次核对还没做完）时索引不能回答「没有」：引用退回 ripgrep，定义跳过第 4a 步，资源跳转走原路径。未跟踪的新文件最长 20 秒看不到；已 `git add` 的立刻可见。
- Android 资源：路径形如 `res/<目录>/<文件>` 的文件进清单；`values*/` 里的元素、任何 xml 里的 `@+id/x`、其他目录的文件名记入 `resources`。定义查找在光标前是 `R.<类型>.`（`android.R.` 直接返回空）或 xml 里的 `@类型/`、`@+id/`、`?attr/` 时先查这张表：默认目录排在带限定符目录前，查不到（库里的资源）或索引没好就走原来的路径。
- 索引就绪后，Kotlin / Java 的定义查找在索引和变动文件里都没有这个名字时直接返回空，不再做全仓扫描（那是库里的类，扫描只会耗尽时间预算）；无法确定变动文件时不返回空，照常扫描（`code-nav.ts#findDefinitions` 第 4a 步）。
- 代码索引按 `git ls-files`（同 `FileIndex`）的 .kt/.kts/.java 与 Android 资源目录（`res/<目录>/<文件>`）的清单与库里的 size + mtime 比对增量更新。建库与核对只由 `SymbolIndexes.watch`（页面的观察续约）开始，每 `recheckMs` 最多核对一次，观察撤销或 `watchMs` 内没续约就中止并杀掉 worker；查询（`search`、`declarations`、`wordFiles`、`changedSince` 等，含 Files 面板和 Agent 工具）不能开始建库，否则离开页面后风扇还在转；超过 `fileBytes` 或含 NUL 的文件只记行不解析；语法 wasm 与 worker 脚本由 `scripts/build.ts` 复制进 dist（与 `symbols/` 下同名同相对位置）。

## 排障

- LibreOffice 转换后残留 `soffice.bin`：转换在自己的进程组里跑，超时和结束时整组杀掉（`apps/server/src/previews/office-convert.ts`）；Linux 上 `soffice` 是脚本，只杀它不会结束干活的子进程。
- 保存总是 409 `FILE_CHANGED`：客户端带的 `hash` 要来自整份文件的预览；有进程在持续改写这个文件（格式化工具、监听编译）时也会这样。

- 文件预览报 `PATH_DENIED` 或 `FILE_NOT_FOUND`：先看路径是否在项目外且 `allowOutsideRead` 关闭，再看是否命中凭证规则（`scope.ts#isSecretPath`）。
- 搜索结果缺文件：`file-index.ts#FileIndex` 的清单可能是 git index 变化前的，或未跟踪文件还没刷新（60 秒内）。
- 任务工作区不可用：`scope.ts#projectRoot` 会先检查任务工作区是否可用（`apps/server/src/task-workspaces/identity.ts#assertTaskWorkspaceAvailable`）。
- 下载的 ZIP 缺文件：对照 `git ls-files` 与 `.gitignore`，打包规则与「下载 ZIP」一致。

- 符号搜索一直返回空：`GET /api/projects/:id/code/index` 看状态，`building` 时只返回进度；`failed` 的 `error` 是原因（常见是项目既不在 git 里、也没有 ripgrep）；构建产物里缺 worker 脚本或语法文件时 worker 起不来，同样表现为 `failed`。
