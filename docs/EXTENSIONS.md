# Agent 扩展管理

## 目标与边界

以当前 Riffet 服务器、后端配置和项目为上下文，查看、编辑并管理各 Agent 的 Skills、MCP、Plugins、Hooks，以及已有 Rules / Commands。原生配置是事实来源；目录扫描不启动 Agent、MCP 或 hook。磁盘配置状态与运行时状态分开显示，未知状态不能显示为已加载。

服务端复用后端 profile 解析和配置文件保护；客户端共享 HTTP 契约。插件缓存、内置组件、受管配置和 Riffet 自身桥接组件保持只读。所有写入通过已发现的资源 ID 或限定的新建目标定位，不接受任意文件路径或 CLI 参数。

## 实施顺序

1. **统一目录和文件服务**：六个后端配置根目录、资源来源和诊断；公共契约；文件详情、新建、编辑；保留冲突检测、脱敏和备份。验证跨 profile 隔离、越界与 symlink、密钥回填、无副作用发现。
2. **Web 编辑闭环**：Agent/profile、类别与作用域选择；详情、来源和只读原因；编辑差异、新建、冲突重读、未保存保护；修改后刷新扩展目录和 slash 缓存。
3. **原生管理接入**：按实际 CLI / RPC 能力开放操作，使用服务端动作白名单；明确操作结果和生效条件。Codex/TRAE 的 Skill 开关、MCP 重载与授权、运行状态复用 App Server 接缝；插件走已探测的 CLI，开发中 plugin RPC 不作为稳定接口。
4. **DSH 配置持久化**：用户扩展绑定稳定 profile 身份；Riffet 管理的桥接与模型补丁独立；重启或修改模型/网关后保留用户 bundles 与配置。
5. **原生客户端**：macOS 和移动端接入相同契约、资源详情与编辑流程，复用已有 API 和控件。
6. **整体验证**：服务端边界与路由测试、前端类型检查和构建、Kotlin 与 Swift 可用检查；记录实际覆盖范围和环境限制。

## 数据与操作

目录项标识包含原生来源，不能只按名称去重。scope 表达配置作用域，ownerPluginId 独立表达插件归属。目录项分别记录 enabled 和 runtimeState。文件读取返回 hash，保存要求 expectedHash；原生 revision 可用时使用原生 revision。

新 API 位于 `/api/backends/:id/extensions`，query 绑定 profileId、projectId 或 sessionId。子路由提供资源详情、documents 读写与新建，以及明确的 actions。旧 `/api/projects/:id/configs` 保持兼容。

编辑器只修改服务端文件。两个 profile 指向同一原生目录时会共享配置；保存回执说明生效方式。发现失败返回可见诊断，不能伪装成空目录。JSON 配置执行语法校验；原生格式与特殊字段由对应适配器处理。

## 验收场景

- 同名扩展来自不同作用域或插件时均可定位，禁用项可见。
- 用户目录、项目目录和安装缓存按真实来源限制操作；不能通过资源 ID、路径或 symlink 越界。
- CLI/IDE 与 Riffet 同时编辑时返回冲突；未修改的脱敏凭据保持原值。
- 配置保存后刷新目录，运行中会话未重载时明确显示生效限制。
- DSH 重启、修改模型或网关后用户扩展仍存在，桥接仍正常。
- 所有客户端用同一后端/profile/项目上下文操作，不因切换页面或迟到响应写错目标。

## 按对话开关 MCP 与 Skill（2026-11-10）

扩展管理改的是全局配置，影响所有会话；按对话开关只影响一个会话，放在输入框的「技能与工具」里，和选手机同一个入口（[DEVICES.md](DEVICES.md) §2）。

- **数据**：会话字段 `extensionsOff`，元素为 `mcp:<名称>` 或 `skill:<名称>`，默认空（用户装的都开着）。创建请求与 `PATCH /api/sessions/:id` 都可写，和 `toolGroups` 一样是会话快照，下次启动 CLI 时生效。新对话不沿用上次的关闭项；想对所有对话都关，去扩展管理。Riffet 自己的 `riffet` MCP 不列出、不能关。
- **列表**：`GET /api/backends/:id/loaded-extensions?profileId&projectId` 返回这个后端在这个项目里启动时实际会加载的 MCP 与 Skill，不用静态目录（目录含未安装的插件市场条目，也证明不了已加载）。
  - Claude Code：用该 profile 的环境在项目目录空跑一次 `claude -p --output-format stream-json --verbose`，`ANTHROPIC_BASE_URL` 指向不可达的本地端口、`--settings` 带 `disableAllHooks: true`，读到 `system/init` 的 `mcp_servers`、`skills` 后结束进程，不发模型请求、不跑用户的 hook。
  - Codex / TRAE：app-server 的 `mcpServerStatus/list`（不带线程）与 `skills/list {cwds}`。
  - 按 (profile, 项目) 缓存 5 分钟，扩展管理写入后失效。
- **启动时生效**：
  - Claude Code：启动覆盖文件（`--settings`）加 `skillOverrides: {"<名称>": "off"}` 与 `deniedMcpServers: [{"serverName": "<名称>"}]`。
  - Codex / TRAE：`thread/start` / `thread/resume` 的 `config` 加 `"mcp_servers.<名称>.enabled": false`；只写列表里出现过的名称。Skill 的线程级 `skills.config` 尚未验证，先不开放。
- **能力**：后端能力 `extensionToggles: {mcp, skills}` 说明哪类可关；都不支持时「技能与工具」只有手机。
- **界面**：分组「手机」「MCP」「Skills」，MCP 与 Skill 勾选表示开着，名称原样显示。

实测（2026-11-10，本机）：Claude Code 2.1.302 经 `--settings` 的 `skillOverrides`（含自带 Skill）、`deniedMcpServers` 均生效，`disabledMcpjsonServers` 只管项目 `.mcp.json`；`disableAllHooks` 下空跑不触发 hook。Codex 0.166.0 线程级 `mcp_servers.<名称>.enabled=false` 生效（该线程内工具数为 0）；`skills/list` 不分线程，无法据此验证线程级 Skill 关闭。

## Web 独立页面（2026-10-18）

侧栏「定时任务」下提供「扩展管理」入口，支持命令面板与 `/extensions` 直达。设置中原「Agent 扩展」分区已迁移。页面分为「概览」和「管理」，默认打开概览。概览复用统计页的卡片与图表工具，展示目录条目、Skills、插件、停用数量，以及 Agent 和类型分布；点击图表、图例或数量进入对应管理筛选。数字来自当前扫描目录，按 Agent/profile 分别计数，共享文件可能重复，不代表使用次数或已安装数量；未声明启停状态单独统计。

管理页默认隐藏长描述，保留搜索、类型、筛选入口和新建。Agent、配置、作用域、来源、状态与排序收进筛选弹层，启用的筛选显示为可移除标签。列表保留可视区渲染。详情以短标记展示只读、内置和插件来源，原始描述折叠；管理影响保留在操作确认中。详情内容与文件编辑器分别滚动，CodeMirror 的容器高度有界，长路径单行显示。布局按扩展工作区的实际宽度切换，窄工作区使用覆盖式详情，避免侧栏挤压列表。

目录项以 backend/profile/project 和原生 ID 联合标识；同名资源保留独立来源。目录最多三路并发读取，每个来源独立报告错误；返回页面时复用当前登录工作台内的内存目录，超过 30 秒后台刷新，手动刷新强制重读。退出登录后随工作台卸载清除缓存。列表仅渲染可视区及缓冲行，检索文本随目录建立；详情、文件和 CodeMirror 分别按需读取或加载。

运行状态需要显式检查已有会话，不能由静态发现或启用状态推断。详情逐会话显示状态和工具；无法与 TOML 文件逐项对应时标为当前配置的会话报告。能力探测按需读取，批量启停只处理适用项、顺序执行、不自动重试写入，并展示部分失败和生效说明。保存、新建及原生操作后刷新目录并失效 slash 缓存。

文件保存沿用原生目标、editable 限制、差异预览、expectedHash 冲突检查与服务端备份。冲突时保留草稿，可读取最新文件作为差异基准后合并。切换资源、项目或页面前检查未保存修改；保存和管理操作进行中阻止离开。页面停用会取消未完成的目录读取，迟到响应不能写入新的上下文。

Skill 的管理能力由服务端逐条返回，源文件只读不再等同于不能启停。Codex/TRAE 通过原生 `skills/list` 回读配置开关，按路径关联已发现条目；相同 profile/project 的读取合并并缓存 30 秒，变更后失效。已被原生目录确认的插件 Skill 也可写入原生开关，仍不开放插件文件删除。`.system` 内置 Skill 保持只读。

Claude Code 2.1.129 起使用 `skillOverrides`，Droid 0.173.0 起使用 `disabledSkills`；操作前验证本机版本，按用户或项目来源写对应设置，并保留其他字段。读取遵循设置优先级；其他作用域或 Skill 元数据仍然禁用时，不报告已启用。Cursor 及未验证原生配置支持的版本采用 `SKILL.md` 与 `SKILL.md.riffet-disabled` 入口切换，保持支持文件及条目 ID，停用项仍可查看、编辑和恢复。文件切换会影响共用来源目录的 Agent。

Web 的「删除 Skill」将整个自有 Skill 目录移动到 `stateDir/skill-backups/<id>/skill`，保存原路径元数据，结果中返回备份位置。操作需要主文件的 `expectedHash`，与编辑器共用文件锁；目标冲突、共享链接、内嵌其他 Skill、非法目录边界及跨文件系统移动均明确失败，避免扩大删除范围。插件附属和内置目录不能独立删除。已加载进会话上下文的内容不会随文件删除而被撤回。

## Web 按 Agent 与类型管理（2026-10-23 修订）

分页与来源修订：Web 每页展示 20 项，多页时仅显示上一页、当前页/总页数和下一页，不再显示单独的底部总数。筛选和上下文变化回到第一页，目录缩短时页码收敛到末页；全选仅限本页，翻页清除勾选。移除 LLM Provider 选择和可见名称，扫描每个 Agent 的本地 `local` 配置，缺失时回退默认配置或首个可用配置；不跟随会话 Provider，也不合并不同 Provider 的扩展目录。

后续调整：Agent 改为明确的下拉选择器，与配置范围、搜索放在同一内容宽度内；类型导航和列表操作合并为一行，仅当前类型显示数量，批量选择放入列表菜单。首次进入默认「用户配置」，移除当前会话项目的初始化与重新激活同步，用户主动选择项目后保留该选择。「受管」不再出现在列表中；详情和筛选用「外部维护」，具体限制沿用 `readOnlyReason`。这包括插件缓存、共享链接、Agent/Riffet 维护项和原生安装策略限制，不等同于企业管理员配置，也不据此禁止原生 Skill 启停。

Web 采用「单个 Agent → 单个配置 → 单个扩展类型」导航，默认展示有效 Agent 的 Skill。Agent 与 Skill / MCP / 插件等类型是两层常驻导航，不提供跨 Agent 或跨类型的混排入口。搜索、作用域、来源和状态筛选只作用于当前上下文，重置筛选保留 Agent、配置和类型。切换上下文先检查未保存内容，并清理旧详情与批量选择。

目录改为 76px 两行列表，第一行名称、第二行简介；不在列表重复 Agent、类型和长路径。状态仅保留需要关注的信息，复选框与全选仅在批量模式显示。新建绑定当前 Agent / 配置 / 类型，插件安装绑定当前 Agent / 配置。

点击条目打开右侧 600px 详情抽屉，小屏占满窗口，背景目录保持原宽度与滚动位置。抽屉复用 Dialog 的焦点和退出行为，提供正文阅读、文件、运行状态与编辑；启停与编辑是主要操作，更新与删除收进更多菜单。操作反馈与授权链接在抽屉内部呈现。关闭与切换继续使用原有未保存保护，文件仍沿用 hash 冲突检查。

Skill 名称后的来源、文件只读、可删除分别呈现为独立胶囊，使用不同图标与颜色；可删除依据实际动作能力。诊断放在独立弹窗中，打开直接显示可滚动的记录，不再折叠。

修订验证：`pnpm typecheck`、`pnpm build`、`git diff --check` 通过；完成上下文隔离、弹层反馈和草稿保护的源码 review。未新增 UI 测试，尚未做浏览器视觉与交互验收。

## macOS 按 Agent 与类型管理（2026-10-23 修订）

macOS 同步单 Agent、单类型、默认用户配置的导航，来源选择与 Web 相同，不显示 LLM Provider。顶部依次放置 Agent、配置范围与搜索，下方为类型和列表操作；列表使用名称、简介两行，Skill 的来源、只读和删除能力分别展示胶囊。批量模式按需开启，每页 20 项，全选限本页，翻页清除选择，仅多页时显示分页控件。

详情使用独立原生 sheet，保留正文、文件、运行状态和编辑流程；编辑与启停直接显示，更新、删除收进更多菜单。关闭、切换和创建目标切换保留未保存保护。诊断也使用独立 sheet，记录直接显示，长内容滚动，提供复制与重新读取。刷新目录后同步重新获取管理能力。

点击弹窗外的当前窗口背景可关闭最上层弹窗，复用关闭按钮的未保存与执行中保护；预览关闭返回编辑，背景点击不触发底下的列表操作，也不影响其他 Riffet 窗口。

筛选改为弹出面板，按作用域、来源、状态直接选择；目录上方只展示生效条件，排序独立放在工具栏。详情明确使用 960×760pt 的阅读尺寸，并受所在屏幕可用范围限制，避免仅设置理想尺寸后退回 520pt 最小宽度。标题与操作合为一行，页签与文档控件合为一行，Markdown 直接呈现正文；来源与只读详情保留在文件页签。编辑、新建和保存预览使用正文优先的布局，动作留在底部。

修订验证：macOS Debug 构建与源码检查通过；未新增 UI 测试，未进行运行中客户端的视觉与交互验收。

## macOS / Web 阅读与管理布局（2026-10-23 首版，布局已由上述修订替代）

默认进入「管理」，「概览」保留为次级入口。目录展示名称、用途、状态和 Agent / 配置 / 来源，复选框单独负责批量选择，其余整行打开详情。搜索独占一行；筛选收起后仍显示已选条件。安装插件放在页面工具栏。

选中后，宽工作区将约 340–380pt / px 留给目录，其余用于阅读详情；macOS 工作区小于 840pt、Web 工作区小于 1040px 时隐藏目录并显示完整详情。切换宽窄保持同一 Inspector 实例，保留编辑草稿。Web 保留可视区渲染，固定 124px 行高与 CSS 同步。详情顶部直接呈现实际可用的编辑、启停、更新和卸载操作，继续复用服务端动作白名单、原生配置能力、未保存保护和 hash 冲突检查。

详情分为「内容」「文件」「运行状态」。首次打开按 `item.documentId` 读取主文件；Markdown 复用现有正文渲染器，其他文件复用只读代码视图（macOS CodeTextView / Web CodeMirror）。Markdown 可切换源码，编辑仍使用原有保存前预览流程，Web 保留差异预览。只有 Skill 主文件中可识别的 front matter 在阅读模式下省略，源码完整保留。没有主文件时展示描述、来源与文件入口，不把任意支持文件当成主文件。所属插件存在于目录时可直接跳转。

管理成功后重读当前文件，主文件改名时跟随新的文档 ID；读取失败保留实际请求的文件 ID，重试不会跳到其他文件。运行状态继续显式查询，静态「已启用」不代表已加载，查询失败在当前详情弹窗内显示。Web Markdown 的本地链接仅能打开当前扩展已发现的关联文件；未发现的本地资源不会被当成网站地址请求，不扩展文件访问范围。Mac Markdown 相对资源仍受现有阅读器解析能力限制。

设计参考：[VS Code 的列表与 README / Contributions 详情](https://code.visualstudio.com/docs/configure/extensions/extension-marketplace)、[JetBrains 的插件详情与管理操作](https://www.jetbrains.com/help/idea/managing-plugins.html)、[Raycast 的扩展详情与独立配置](https://developers.raycast.com/basics/install-an-extension)。Riffet 按真实 Agent / 配置 / 来源管理已发现条目，不引入缺少数据来源的市场排行、评分或推荐分类。

本轮验证：`pnpm typecheck`、`pnpm build`、macOS Debug 构建、`perf-lint` 与 `git diff --check` 通过；复用扩展路由、Skill 文件和 Skill 设置三个测试文件，23 项通过。未新增依赖或 UI 测试；未进行真实插件变更和两端完整交互验收。

## 原有多端覆盖（2026-10-13）

移动端扩展设置复用 SettingsGroup / SettingsRow，macOS 使用 grouped Form。列表使用完整内容宽度；进入条目后查看详情和文件，macOS 再进入独立编辑页。完整路径、加载诊断和运行状态放在详情或折叠区域。

Web 旧目录曾按自有文件和所属插件分组、分批展示，并将部分同名资源归并后逐一选择来源。独立页面改为保留独立来源的平铺目录和可视区渲染，不推断生效版本。下拉控件继续复用统一 Select，窄屏点击高度为 44px。

UI 修订通过 macOS 实际展示组件的离屏 PNG 检查，以设置页的 SettingsComponents 与外观页的色卡分区为参照，覆盖 664×640pt 内容区域的浅色列表、深色列表、详情与编辑。截图使用固定数据，不替代运行中客户端的端到端验收。对应 ExtensionSettingsSnapshotTests 通过；Web 类型/构建、Kotlin shared 编译及 35 项主题契约/对比度测试通过。

六个后端共享目录、详情、文档读写和新建 API；客户端按 Agent/profile 与当前项目查询。目录包含 Skill 支持文件、插件归属、只读原因和来源。所有客户端保存前提供预览；Web 复用 CodeMirror 行差异，移动端展示保存前后全文，macOS 提供待保存全文预览。切换上下文与退出编辑保留未保存保护。macOS 关闭设置窗口后保留进程内草稿，并保留原文件哈希；退出 Riffet 后未保存草稿会清除。

| Agent | 文件层覆盖 | 原生管理接入 |
| --- | --- | --- |
| Cursor | Skills、MCP、Hooks、Rules、Commands、插件清单 | 通过配置文件管理；不宣称支持未验证的插件 CLI |
| Codex | Skills、AGENTS.md / Rules、Prompts、hooks.json、config.toml、插件缓存与原生已安装清单 | Skill 开关、在线 MCP 重载/授权与目录查询；插件 add/remove 按本机 help 探测 |
| Claude Code | Skills、Rules、Commands、项目 MCP、settings hooks、插件清单 | 插件 install/uninstall/enable/disable/update 按本机 help 探测 |
| DSH | profile bundles、用户 patch、插件文件 | 原生 pluginManager 安装/启停/卸载、在线 bundle 状态 |
| Droid | Skills、Commands、MCP、独立/旧版 hooks 配置、插件清单 | 插件 install/uninstall/update 按本机 help 探测 |
| TRAE CLI | Skills、原生 TOML、插件清单 | 复用已支持的 App Server 接缝；插件操作按本机 help 探测 |

能力是适配器上限，具体按钮取决于条目动作、安装版本与 help 探测。CLI 不支持项目参数时拒绝项目动作，不静默扩大到用户级。安装只接受插件原生名称，不执行任意 shell 或任意 URL。内置、受管、插件缓存和共享 symlink 不能直接修改；自有插件源码可编辑，附属组件卸载需通过插件管理，原生支持的 Skill 配置开关单独开放。

Codex 用 `plugin list --json` 的 `installed` 记录补充原生插件身份，仅安装策略为 `AVAILABLE` 的条目开放管理。缓存目录始终只读，不能由缓存名称推断卸载目标。其他 Agent 只有在原生配置中取得可靠标识后才显示已有插件动作；TRAE/Droid 当前 CLI 没有 JSON 列表协议时，不解析终端展示文本。它们可以安装；未映射到可靠身份的已有插件需通过原生 CLI 管理。

Codex/TRAE 的静态 TOML 作为整份原文编辑，暂未引入 TOML 解析依赖；不伪造逐条 MCP/Hook 状态。JSON 在保存前验证语法；TOML/YAML 编辑器明确提示不做语法校验。无法可靠脱敏与回填的多行凭据拒绝展示和保存，提示使用原生编辑器。Claude 全局 `.claude.json` 仅暴露 `mcpServers` 投影，保存保留其他字段。Skill 开关写用户配置，可能影响其他引用同一技能的项目。

Droid 运行时未提供已验证的自定义 `configDir` 映射，因此扩展接口拒绝非默认目录 override，避免编辑器与原生管理命令写入不同目录。其他 profile 根目录与原生启动配置保持一致。

运行状态只读取已在线连接；Codex/TRAE 的 Skill 配置开关另外通过短期管理 App Server 查询，不创建对话。Skill/Hook 的原生目录返回只说明可发现，不能证明执行过；MCP 只有原生连接状态能表示已加载。DSH 管理动作可显式启动管理连接。OAuth 返回授权链接，由用户完成认证；Riffet 不自动打开浏览器。服务器与客户端不在同一台机器时，应在运行 Agent 的机器上完成回调。

DSH 用户扩展改为稳定 profile 身份；桥接与模型配置位于独立 overlay。升级时迁移当前旧身份对应的 profile，保留原目录；其他历史配置 hash 目录不自动合并。默认 session、storage 和 attachment 位于共享 DSH_HOME；用户自定义数据路径仍按原 patch 决定。相同 profile 变更配置时，活跃任务阻止第二个写入进程启动，空闲旧进程先关闭。

写入复用 1 MB 上限、脱敏字段回填、SHA-256 冲突检查、同路径保存串行化、原子替换和备份。修改成功使服务端和 Web slash 目录缓存失效，下一次菜单刷新读取新目录。编辑器只针对发现到的原生路径；扫描深度和文件数量有界。

## 验证与限制

服务端测试覆盖 profile/session 隔离、路径越界与 symlink、密钥与 Claude 投影、同 hash 并发保存、插件归属、原生模板、命令参数/作用域、MCP 分页、原生客户端清理、DSH 迁移与单 profile 运行锁。Kotlin 客户端测试覆盖 query 和 expectedHash 协议、扩展字段兼容。构建检查包括 TypeScript、Web/server、Kotlin JVM 和 macOS。

本轮没有在用户真实环境安装/卸载插件、执行 hook 或完成 OAuth；管理命令由隔离 fixture / mock 验证。本轮没有使用浏览器控制。插件市场检索、跨 Agent 自动转换、远端组织管理策略、TOML/YAML 结构化编辑不在本轮实现范围。

2026-10-13 验证结果：

- `pnpm test`：133 个文件、1333 项通过；最后的原生 Hook 模板调整另经扩展服务 11 项测试验证。
- `pnpm typecheck`、`pnpm build`：通过。
- `:contracts:jvmTest :client:jvmTest :shared:compileKotlinJvm`：通过。
- macOS `build.sh test`：最终源码编译通过；14 项单测通过、1 项失败。失败是 `LayoutTests.swift:22` 对会话输入框的宽度断言，实际 505、要求不超过 420，不覆盖扩展设置页。本轮未修改该断言或会话布局。
- 本机只读发现覆盖六种后端；Codex 原生 JSON 清单返回 19 个已安装插件，其中 14 个安装策略允许管理。未运行真实插件变更操作。

## 依据

- Codex 本机 0.160.0 与 TRAE CLI 0.209.1 的 App Server schema：`skills/list`、`skills/config/write`、`hooks/list`、`mcpServerStatus/list`、`config/mcpServer/reload`、`mcpServer/oauth/login`；CLI help 决定插件操作是否开放。
- [Codex Hooks](https://learn.chatgpt.com/docs/hooks)、[Codex Skills](https://developers.openai.com/codex/skills/)、[Codex MCP](https://developers.openai.com/codex/mcp/)。
- [Claude Code Plugins](https://code.claude.com/docs/en/plugins)、[MCP](https://code.claude.com/docs/en/mcp)、[Hooks](https://code.claude.com/docs/en/hooks)。
- [Claude Code Skill visibility](https://code.claude.com/docs/en/skills#override-skill-visibility-from-settings)、[官方版本记录](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md#21129)；[Cursor 官方人员说明的入口文件停用方式](https://forum.cursor.com/t/how-to-toggle-all-skills-at-once-instead-of-disabling-them-one-by-one/161306/6)。
- [Factory Plugins](https://docs.factory.com/harness/plugins)、[Skills](https://docs.factory.com/harness/skills)、[Hooks](https://docs.factory.com/harness/hooks)、[MCP](https://docs.factory.com/harness/mcp)。
- DSH 本机 `@deepseek-ai/dsh@0.2.0-rc.2` 的 plugin-manager 类型、profile/bundle 加载实现与默认 DSH_HOME 路径定义。
