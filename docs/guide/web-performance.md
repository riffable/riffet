# Web 流畅度规范

返回 [中文 README](../../README.zh-CN.md)。

本文规定 Web 客户端（桌面浏览器与手机浏览器）的帧预算、主线程上能做什么、怎么测，以及每次改动要跑的场景。内存、缓存、流队列这类资源预算在 [性能与资源规范](performance.md)，本文不重复；组件与样式的写法在 [apps/web/AGENTS.md](../../apps/web/AGENTS.md)。

规则来自 2026-11-21 的一次排查：在隔离的服务上造了 3004 个会话（一个 260 轮的长会话，700 行的编辑与 6000 行的命令输出，40 轮成组截图，4 个带改动的 Git 项目），用生产构建在无头 Chrome 里走遍首屏、侧栏、会话切换与打开、转录慢滑快滑、展开工具行、图片查看、输入框、命令面板与搜索、各个页面与设置分区、进行中的会话、断网与弱网。找到的问题和改法记在每条规则下面。

## 1. 预算

数字取自 `pnpm perf:web`（§3），在生产构建上量。桌面指 1440×900；手机指 `--mobile`（390×844 触屏）。

| 场景 | 预算 | 说明 |
|---|---|---|
| 滑动（侧栏、转录、页面、设置） | 无超过 50 ms 的长动画帧（LoAF）；慢滑时阅读行的可见跳动为 0 | 滑动途中不解析、不高亮、不整表遍历 |
| 一次交互（点击、按键、打开菜单、面板、弹窗） | INP ≤ 100 ms；单帧 ≤ 50 ms | 超过的部分分帧、延后或挪到 worker |
| 应用内打开会话 | 单帧 ≤ 100 ms | 打开路径只算窗口内的行 |
| 冷启动与刷新 | 单帧 ≤ 200 ms；壳层从缓存同步水合（apps/web/AGENTS.md「其他」） | 首帧不等网络 |
| 静止页面 | 无长动画帧；主线程忙碌 ≤ 1% | 只有可见的动效与计时器出帧 |
| 常驻规模 | 3000 个会话时任一页面的 DOM 节点 ≤ 5000；GC 后的 JS 堆不超过 `STEADY_FOOTPRINT_BYTES.web` | 节点数决定每次样式计算的价钱（§2.2） |
| 后台与断线 | 隐藏的标签页不轮询界面数据；断线不形成请求风暴；重连有抖动的退避 | §2.7、§2.8 |

`--cpu 4`（近似中端手机）下 CDP 靠暂停主线程来降速，帧间隔会出现与应用无关的长空档：这时以 LoAF 里的脚本时长和 `--profile` 的忙碌时间为准，不看帧间隔。

## 2. 规则

每条写明它防的是什么，以及这次排查里的实例。

### 2.1 长列表只挂载视口附近的行

条目可能过百的列表（侧栏、命令面板、搜索结果、选择器）只挂载视口附近的行。行高一致的列表用 `useListWindow`（`apps/web/src/lib/use-list-window.ts`）：每类条目一个高度，由第一个挂载的同类条目量出并随 ResizeObserver 更新，条目数不超过 `LIST_WINDOW_MIN` 时整表挂载。转录这类行高各异的列表用自己的窗口化（`app/session/virtualRows.ts`）。键盘移到未挂载的行时用 `reveal` 先滚到它。

下拉菜单不做窗口化：条目数有上限，超出的部分由搜索到达。

- 侧栏「按时间平铺」把 3000 个会话全部挂载：首页 48,269 个 DOM 节点、GC 前 JS 堆 325 MB，每次点击都要对整棵树做样式计算。改成窗口化后约 2000 个节点（`app/Sidebar.tsx` 的 `entries`），按项目分组时「展开其余」同样只挂载可见的行。
- 命令面板把每个会话都当作候选并全部挂载，打开时单帧 519 ms（强制布局 378 ms）；窗口化后 64 ms，无长动画帧（`app/CommandPalette.tsx`）。⌘K 的标题结果同样窗口化，内容搜索的会话范围菜单只列最近 `SCOPE_MENU_SESSIONS` 个（`app/SessionSearchDialog.tsx`）。

### 2.2 DOM 规模决定每次强制布局的价钱

`getAnimations()`、`offsetWidth`、`getBoundingClientRect()`、`getComputedStyle()` 在样式或布局失效时会先把整份文档算一遍，代价随节点数增长，而不是随读的那个元素。

- 先写后读要成对出现在同一处，不在循环里交替读写。
- 滑动时的读取合并到每帧一次（`requestAnimationFrame`），不在每个 scroll 事件里逐行读。
- 实例：标签栏的新标签在挂载时调 `getAnimations()` 再读 `offsetWidth`（`app/tabs/TabBar.tsx` 的 `growIn`），在 48K 节点的页面上，打开会话那一帧的强制布局为 175 ms。侧栏窗口化之后，同一读取不到 10 ms，代码没有改。

### 2.3 派生值的输入要稳定

`useMemo` 的依赖每次渲染都是新对象时，它和没写一样。父组件传下去的数组和对象，在源头用 `useMemo` 做一次；只有用到它的子组件才订阅整份列表，子组件里用选择器取自己需要的字段。

- `Workbench` 每次渲染都把 `projects.filter(...)` 的新数组传给侧栏，侧栏的分组和排序（对 3000 个会话过滤再按活动排序）因此每次都重算；改为 `sidebarProjects`（`app/Workbench.tsx`）。

### 2.4 随内容增长的工作要有上限

解析、高亮、对齐 diff、序列化都随输入变大。小输入可以同步算，但要有命名的阈值常量；超过的部分降级、延后到空闲时，或放进 worker。

- 代码块高亮（refractor 加 `toHtml`）约 0.3 ms/KB，6000 行的块在主线程上要 200 ms，而且无法让出；超过 `HIGHLIGHT_MAX_CHARS`（100 KB）的块显示为纯等宽文本（`lib/highlight.ts`）。
- 折叠的工具行也在挂载时对齐 diff 来显示 +N −M（最多 120 万格的 LCS）。改为一侧为空或已有缓存时立即计算，其余在空闲时计算（`app/session/Timeline.tsx` 的 `useDiffStats`）。行滚回窗口时命中缓存，计数不会闪。

### 2.5 每次按键只做与这次按键有关的事

输入框的按键路径上只做随文本变化的事。草稿状态留在输入框组件里，不提升到会让转录重渲染的地方；草稿持久化做防抖。

- 自动增高的测量镜像每次按键都复制 35 个计算样式（`app/session/useComposerAutosize.ts`）。改为只在宽度、文字缩放、主题、字体或模式变化时重新复制，按键时只换文本、读一次 `scrollHeight`。

### 2.6 缓存登记、按预算设上限

见 [performance.md](performance.md) §3.1。Web 的缓存登记到 `lib/cache-registry.ts`，上限取自 `budgets.ts`：所有文本类缓存合计不超过 `TEXT_CACHE_BYTES.web`，按用途分份。

- 这次补登记的有 `highlighted-code`、`line-diff-alignments`、`image-natural-sizes`、`shown-previews`。对齐缓存原来只限 48 项、不计重量，而它的键里就带着两份全文。

### 2.7 看不见就不轮询

隐藏的标签页里，轮询界面数据的定时器停下，回到前台时补一次。组件里的定时器用 `useVisibleInterval`（`lib/use-visible-interval.ts`）。确实要在后台跑的（指标上报、推送断开时的列表兜底轮询），在该行或上一行写 `perf-rules: allow <原因>`。`pnpm check:perf` 的 `webInterval` 不允许 `setInterval` 的数量增加。

- 分享状态（每 2 秒）、文件尾随、并行尝试、服务状态、通道健康这几处原本在后台照常轮询，已改。

### 2.8 断线与恢复：退避、合并、可取消

- 重连用 `lib/utils.ts` 的 `reconnectDelay`（指数退避加抖动），不写不带抖动的 `1000 * 2 ** n`；服务重启后，所有标签页不会在同一时刻重连。
- 重试计数在连接稳定一段时间后才清零。流反复「打开又断开」时，每次打开都清零，退避就永远停在第一档。
- 重连后的补读合并成一次。焦点、`visibilitychange`、`online` 在切回标签页时一起到达，只读一次；`online` 不参与去重。
- 被新请求取代、或界面已经不需要的请求要中止（`AbortSignal`）：@ 文件搜索、上传、被移除的附件。
- 实例：列表流每次打开都会清零重试，并补发约 6 个请求（`app/state/listsStore.ts`）；终端与车道的缺口重试没有抖动（`app/terminal/TerminalView.tsx`、`sync/lane.ts`）。另外，手机上终端保留的回滚行改为 `TERMINAL_KEPT_ROWS.phone`。

### 2.9 补偿滚动不算跳动，跳动要看阅读行

窗口化的列表在上方挂载行时，会在同一帧里调整 `scrollTop` 来保住阅读位置。Layout Instability 也把这种补偿计入 CLS，所以转录快速上滑时 CLS 会到 10 以上，而读者并没有看到跳动。判断是否跳动，看阅读行在屏幕上的位移是否偏离手势的速度（`perf:web` 输出的「visible jumps」），不看 CLS 和 `scrollTop` 的差值。

补偿必须与挂载在同一帧完成：先记下阅读锚点（`preserveBeforeChange`），再挂载，在绘制前恢复。

### 2.10 图片异步解码、尺寸先定

转录与附件里的 `<img>` 带 `decoding="async"`；不在首屏的带 `loading="lazy"`。已知原始尺寸时先给出宽高，图片加载完不会把下面的内容推开。

### 2.11 只在生产构建上下结论

开发构建里的 React 慢好几倍，StrictMode 还会把 effect 执行两遍。量、比、写进文档的数字都来自生产构建；需要可读的函数名时，用不压缩的生产构建（`PERF_MINIFY=0`，§3.1）。

### 2.12 循环动画只交给合成器

运行中的会话一直挂着转圈、流光和呼吸点，循环动画每一帧都在跑。只有元素自身的 `transform` 和 `opacity` 由合成器执行；`background-position` 的动画，以及 `<svg>` 内部元素（`<g>`、`<circle>`）的变换，每帧都要在主线程上重新计算样式、绘制和栅格化，代价还会随页面的 DOM 规模和图层面积增长。

- 扫过的高光做成独立的子元素或伪元素，用 `transform` 平移；文字流光用 `ShimmerText`（`components/ui/controls.tsx`）：带遮罩的窗口与窗口里的文字副本反向平移，字形保持不动。
- SVG 里只有一部分要转时，把这部分拆成单独的 `<svg>` 叠在上面，旋转加在这个 `<svg>` 上（`work-items/parts.tsx` 的 `StatusIcon`）。
- `pnpm check:design` 拦下 `@keyframes` 里的 `background-position` 和 SVG 内部元素上的 `animate-*`。
- 实例：一个开了 5 天的会话页挂着 7 个循环动画，JS 几乎空闲，主线程却有约 28% 的时间花在样式与绘制上，渲染进程 CPU 持续约 40%。原因是文字流光（`background-clip: text` 加 `background-position`）和任务状态环（`<g>` 上的 `animate-spin`）。骨架屏和画布卡片的高光条也是同一种写法。全部改为 `transform` 之后，在只放这几种动画的页面上，5 秒内的绘制从 600 次降到 0 次，主线程忙碌从 2.3% 降到 0.1%。

## 3. 测量

### 3.1 环境

一套与正式服务互不影响的预览：独立的状态目录与端口、独立 profile 的无头 Chrome。端口与 `pnpm dev` 错开。

```bash
D=/tmp/riffet-web-perf
CLAUDE_CONFIG_DIR=$D/claude RIFFET_ENV_KEEP=CLAUDE_CONFIG_DIR npx tsx apps/server/src/cli.ts serve --dev \
  --state-dir $D/state --port 4417 --no-auth --no-mdns
pnpm perf:web seed $D --server http://127.0.0.1:4417 --sessions 3000     # 约 20 秒
```

```bash
pnpm perf:web build $D            # 生产构建到 $D/public，不压缩以保留函数名；--minify 得到发布时的体积
pnpm perf:web preview $D          # 5273 端口，代理到 4417
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --remote-debugging-port=9577 \
  --remote-debugging-address=127.0.0.1 --user-data-dir=$D/chrome --window-size=1440,900
```

`build` 和 `preview` 用的是 `node_modules/.cache/web-perf/` 下一份包装 `apps/web/vite.config.ts` 的配置。输出不写进 `dist/`，那是正式服务在用的目录。

`perf:web` 绕过 Service Worker：重新构建之后，页面不会从上一版的缓存里加载。要和改动之前比较，用 `git worktree add --detach` 检出 HEAD，把根目录的 `node_modules` 软链进去，在那里 `pnpm perf:web build` 到另一个目录，再用 `preview --port` 起在另一个端口上，`run --url` 指向它。

### 3.2 运行与读数

```bash
pnpm perf:web run                         # 全部场景
pnpm perf:web run longTranscript palette  # 指定场景；pnpm perf:web list 列出全部
pnpm perf:web run composer --mobile --cpu 4 --profile
pnpm perf:web run settings --section 服务管理 --alloc
pnpm perf:web stream $D --turns 20 --every 500   # 让「进行中」会话持续收到新的回合
```

每一步输出一行：

- 用时、帧数；
- 超过 33 ms 的帧、p95 与最长帧；
- 长动画帧的个数与阻塞时长（`LoAF n/ms`）；
- 最慢的一次输入（`INP`）、布局偏移（`CLS`）；
- GC 之后的 JS 堆和 DOM 节点数。

有超过 50 ms 的帧时，接着列出那一帧里最慢的脚本入口，以及它们的强制布局时长。

- `--profile`：CPU 采样，按自身时间列出最热的函数，再按包含时间列出应用自己的函数，改动就落在后者。
- `--alloc`：按函数列出分配量。
- 滑动类场景另外输出阅读行的可见跳动（§2.9）。

## 4. 场景回归清单

改动涉及下列任一页面时，跑对应场景，结果写进 PR 描述。

| 场景 | 名字 | 通过 |
|---|---|---|
| 冷启动 | `startup` | 单帧 ≤ 200 ms；DOM ≤ 5000 |
| 侧栏 | `sidebar` | 慢滑、快滑无长动画帧 |
| 长转录 | `longTranscript` | 打开后慢滑与快滑无长动画帧；慢滑时可见跳动为 0 |
| 大 diff 与长输出 | `bigOutputs` | 打开单帧 ≤ 100 ms；展开工具行 INP ≤ 100 ms |
| 图片 | `images` | 快滑无长动画帧；查看器打开与关闭单帧 ≤ 50 ms |
| 输入框 | `composer` | 连续输入、`@`、`/`、粘贴 200 KB 时 INP ≤ 100 ms |
| 应用内切换 | `switching`、`openInApp` | 切换会话与页面时单帧 ≤ 100 ms |
| 命令面板与搜索 | `palette` | 打开与输入时 INP ≤ 100 ms |
| 设置 | `settings` | 每个分区打开与滑动时单帧 ≤ 50 ms |
| 统计 | `stats` | 切换范围时单帧 ≤ 100 ms |
| 进行中的会话 | `streaming` | 每 0.4 秒到达一轮时无长动画帧 |
| 断线与弱网 | `offline` | 断线 20 秒、恢复、弱网打开会话，都无请求风暴，恢复后数据补齐 |
| 静止 | `idle --seconds 65` | 主线程忙碌 ≤ 1% |

手机布局另跑一遍 `--mobile`，手势和抽屉相关的改动加 `--cpu 4`。

## 5. 检查

- `pnpm check:perf`：Web 的 `webInterval`（§2.7）、`moduleCollection`（模块级 Map/Set，[performance.md](performance.md) §3.1）与 `byteLiteral`（手写字节数）。
- 代码审查时按 §2 逐条看：
  - 新列表的条目数有没有上限；没有时是否窗口化；
  - 滚动和按键路径上读了哪些布局；
  - 传给子组件的对象是否稳定；
  - 随内容增长的工作在哪个线程上，有没有阈值；
  - 新缓存是否登记；
  - 新定时器在后台是否停下；
  - 新请求能否中止、重连是否带抖动。

## 6. 现状

与规则不符的现有代码。改掉哪条就删哪条；新留下的不一致也记进来。

- §1、§2.4：打开会话时，转录在一帧里渲染出整个窗口（`app/session/useSessionSync.ts` 的 `coalesced` flush）。图片会话桌面 46 ms，`--cpu 4` 下 310 ms；刷新后打开 260 轮的会话，首个长帧约 200 ms，在会话流的 `hello` 之后。可以把首次挂载分帧，或用 transition 让它可中断，但要先确认阅读锚点在可中断的渲染下仍然成立。
- §2.2：转录滑动时，每个 scroll 事件都要逐行读一遍挂载行的矩形（`TranscriptView.tsx` 的 `ensureWindow` → `syncMounted`，`readingAnchor.ts` 的 `captureReadingAnchor`）。桌面每帧约 1.5 ms，`--cpu 4` 下约 6 ms。应合并到每帧一次，滚动路径上不重复 ResizeObserver 已经量过的高度。
- §2.3：`Workbench` 订阅整份会话列表，每次列表更新都要做几件 O(n) 的事（`keepSessionPanels` 的 Set、`recentModel` 的日期解析、收件箱计数、侧栏会话筛选与未读计数），侧栏的每一行订阅 6 个 store。按现在的数据量测下来不贵（进行中的会话 9 秒里忙碌 198 ms），但开销随会话数增长。
- §2.4：上传把文件读成 base64 放进 JSON（`app/session/image-upload.ts`、`lib/api.ts` 的 `upload`），内存里的副本约为文件大小的 1.33 倍，序列化时还要再复制一次。改成二进制上传需要服务端配合。
- §2.4：每张 Mermaid 图起一个 iframe，各自加载渲染器（`app/session/MermaidDiagram.tsx`），没有共享的渲染器，也没有并发上限。
- §2.4：转录分组每次发布都对整个窗口做几遍扫描（[performance.md](performance.md) §6 的 `transcriptTurns`）：打开 260 轮的会话时，桌面自身时间 18 ms，`--cpu 4` 下 77 ms。
- Service Worker 安装时预缓存全部按需加载的分块（`sw.ts`），与首屏的请求抢带宽。
