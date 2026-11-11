# 插件开发指南

写一个 Riffet 插件包：声明它贡献什么，决定它以什么信任级别运行，把它打包安装。内置插件的接口和机制见 [PLUGIN_ARCHITECTURE.md](PLUGIN_ARCHITECTURE.md)，设计取舍见 [plugin-system.md](design/plugin-system.md)。本文只写已经存在的功能；Agent 协议是实验性的，见最后一节。

SDK 的源码命名已统一为 `@riffet/plugin-api`；旧开发包的导入迁移和保持不变的协议名称见 [命名与兼容](PLUGIN_ARCHITECTURE.md#命名与兼容)。

## 快速开始

`examples/plugins/` 下有可以直接运行的样例，每个目录有自己的 README：

| 样例 | 运行方式 | 展示什么 |
| --- | --- | --- |
| `gateway-models` | 安装（独立进程） | 兼容 OpenAI 的网关作为模型源；设置项与密钥；`models.provide`、`network`；异步 `prepare()` 配同步 `resolve()` |
| `graphite-theme` | 安装（只有资源） | 配色（明暗各一套）与预设；不需要任何能力 |
| `echo` | 开发包（`riffet plugin dev`） | 非内置 ID 的最小 Agent：描述、打开、发送、回复、停止 |
| `session-stats` | 开发包或安装 | 自定义 Web 视图：在隔离框架里经消息桥读会话（`sessions.read`） |

```sh
# 自动构建、校验、打包；无需调用仓库脚本
riffet plugin pack examples/plugins/graphite-theme --out /tmp/graphite-theme.tgz
riffet plugin install /tmp/graphite-theme.tgz

# 构建、关联正在运行的本机服务、监听修改并重载
riffet plugin dev examples/plugins/echo
# 结束监听后，按需解除持久开发关联
riffet plugin unlink example.echo
```

带能力的安装包加 `--yes` 或 `--grant models.provide,network`。开发代码在服务进程内执行，拥有 Riffet 的权限；服务停止时 `dev` 只登记目录，下次启动生效，不另起服务。

最小的包是一个目录：`riffet-plugin.json` 加它引用的文件。

```
my-plugin/
  riffet-plugin.json
  server/index.mjs        可选，服务端入口
  assets/…                可选，图标、配色、字体
```

## 管理入口

Web 和 macOS 的工作台侧栏 →「插件」，无需打开项目或模型设置。入口位于「收藏夹」下方；列表按静态能力分为「Agent 与模型」「工作台」「服务与分享」，内置包、开发包和安装包采用同一分组。每行展示简介、发布者、版本和来源，并可直接启停。点击名称打开独立详情面板的「功能」，点击配置按钮进入「配置」；从视图的「管理插件」入口进入时打开「管理」，从模型设置进入某个配置页时直接定位到「配置」中的对应子页。

详情分为四个页签：「功能」展示用途、静态贡献声明和使用入口；「配置」承载插件字段、登录和专属配置子页；「管理」承载发布者、版本、来源、插件 ID、权限、启用策略、版本切换、卸载和删除数据；「诊断」承载状态、兼容性、依赖、日志、诊断、重载及等待任务结束时的立即处理。Cursor 的提供商和 CLI 管理都是插件贡献的配置子页，区别于 Riffet 对插件包的管理。停用后仍能查看静态贡献声明，切换页签和配置子页时保护未保存的字段。

管理页顶部的「卸载插件」适用于安装包和开发包，内置插件不可卸载。卸载开发包保留源目录、设置和数据，并在当前服务中持久排除该目录的自动发现；显式重新关联同一目录后恢复。安装包卸载保留设置和数据。

暂停或恢复所有外部插件属于服务级操作，位于列表工具栏。安装与启停作用于当前连接的服务，外观选择和视图排列属于客户端偏好。

保存配置使用 configRevision 防止覆盖其他客户端的修改；冲突后重新读取再编辑。恢复模式暂停外部插件并保留原启用策略，重启后仍生效。服务无法正常启动时先运行 riffet plugin recovery on，再启动排查；recovery off 恢复原策略。riffet plugin diagnostics <id> 与 reload <id> 操作正在运行的服务。

当前通过本地包安装；公共市场、签名来源验证和远程更新未开放。

## Manifest

`riffet-plugin.json` 是一个 JSON 对象。打包与安装共用 manifest 校验定义和包资源检查；不合格的包两边都被拒绝并写明原因。

| 字段 | 说明 |
| --- | --- |
| `id`、`vendor`、`name` | 必需。`id` 是 `<vendor>.<name>`，小写字母、数字、`-`、`.`，至多 64 字符；默认隔离安装不能用 `riffet.` 命名空间；本机显式可信安装可以保留官方外部包身份，但任何安装都不能与内置或开发包同 ID |
| `apiVersion` | 必需，等于 `PLUGIN_API_VERSION`（当前 1）；其他值不加载 |
| `defaultEnabled` | 必需，`true`、`false` 或 `"auto"`（交给服务端入口的 `detect()`） |
| `requiresTrustedHost` | 可选布尔值，要求显式可信安装以使用宿主 CLI、进程或其他同进程接口；声明本身不会授予信任 |
| `activation` | 可选事件数组：`startup`、`command`、`model-source`、`task`、`view`。缺省按启动激活；其余事件须有对应静态贡献，模型源须声明协议。启用与正在运行分别由 `enabled`、`active` 表达 |
| `version` | 独立包必需，semver；同一版本不能换内容 |
| `title`、`description` | `LocalizedText`：BCP-47 标签到文本，如 `{ "zh-Hans": "…", "en": "…" }`；缺失时用 `name` |
| `settings` | `[{ key, label, kind: "text" \| "secret" }]`。文本值在插件管理页可见，密钥只在服务端读取，接口只返回是否已设置 |
| `requires` | `[{ id, optional? }]`：必需的依赖未启用时本插件保持关闭；循环依赖被拒绝；可选依赖上线或下线时本插件先关再开。同进程的内置、开发包与可信安装包可以在运行时贡献 `services: { [名称]: { version, ...方法 } }`，依赖方用 `host.services.get(提供方 id, 名称, semver 范围)` 取得对象：提供方没开、版本不符、没有这个服务或可选依赖缺席时是 `undefined`，提供方没有列在 `requires` 里则抛错；调用不带额外权限。隔离安装包不提供也拿不到服务，`host.services` 不存在 |
| `hostApi` | `{ server?, web?, agent? }`，semver 范围，对照宿主的 `PLUGIN_API_VERSION`、`PLUGIN_WEB_API_VERSION`、`AGENT_PROTOCOL_VERSION`。入口不兼容时不使用，原因显示在插件管理页 |
| `dataVersion` | 包在状态目录里保存的数据格式版本，见「版本、回滚与数据」 |
| `capabilities` | 包要求的能力，见「能力与授权」 |
| `entries` | `{ server?, web? }`，包内相对路径。`server` 是 `.js/.mjs/.cjs/.ts` 模块，默认导出 `{ detect?, activate(host, scope) }`；`web` 是打包好的单文件脚本，在隔离框架里运行（见 PLUGIN_ARCHITECTURE.md「自定义视图」） |
| `contributes` | 静态声明，见下。不执行包代码即可读取，所以插件关闭时仍然列出 |

服务端入口返回的 `Contributions`（`modelSources`、`taskProviders`、`actions`、`status`、`doctorChecks`、`agentBackends` 等）是运行时贡献，接口在 `packages/plugin-api/src/index.ts`。manifest 的 `contributes.modelSources` 可以声明协议、覆盖项与登录入口；`contributes.actions` 声明操作标签和类型，首次登录不需要先失败一次。运行时贡献和静态声明是两件事：声明让客户端知道有什么，贡献才真正提供它。

模型源的 ID 存在档案里，档案带 API Key，所以隔离安装的包只能提供 `<插件 id>.<名称>`（名称为小写字母、数字、连字符，全长至多 64 个字符），否则激活失败；不能是内置源的 ID，也不会与别的包重名。样例 `gateway-models` 用 `` `${host.id}.gateway` ``。内置包、开发包和可信安装包只需不与已有的重名，迁出的官方模型源保留旧 ID。

## 声明

`contributes` 里的每个贡献 ID 是 `<插件 id>/<名称>`（名称小写字母、数字、`.`、`-`，至多 64 字符），在所有插件间唯一；不合格的包不加载，原因写在插件管理页和 `riffet doctor`。Agent 的 ID 是例外，见下。

| 种类 | 字段 | 说明 |
| --- | --- | --- |
| `views` | `id`、`title`、`icon?`（`{ svg?, sfSymbol? }`，`svg` 是包内路径）、`locations`、`defaultLocation?`、`clients`（`web`、`macos`）、`instances`（`single`、`per-session`、`per-project`）、`when?`、`renderer?` | 工作台视图。位置取自 `session-view`、`sidebar`、`panel`、`main`、`navigation`、`settings`。`renderer` 可为 `tasks`、`list`、`form`、`detail`；由 Web/Mac 宿主绘制，操作复用本包声明的命令，不需要自定义 Web 入口。`requires` 声明客户端能力，缺失时显示不可用原因。非内置包的自定义视图位置只能是 `session-view` 或 `sidebar` |
| `commands` | `id`、`title`、`when?`、`keybinding?`、`scope?`（`global`、`project`、`session`，缺省 `project`）、`params?`（与任务操作相同的字段列表） | 命令面板与快捷键引用它。代码在运行时贡献 `commands: { [id]: { run(context) } }`，`context` 是 `{ projectId?, sessionId?, args, confirm?, signal }`，返回 `{ kind: 'done', message? }`、`{ kind: 'open', view?, sessionId?, path? }` 或 `{ kind: 'task', taskId }`；要启动任务用 `host.tasks.start(projectId, actionId, params?, { providerId? })`，只能是自己的任务提供方。执行路径是 `POST /api/integrations/:id/commands/:name`，服务端按插件开启、声明与处理函数、作用域和项目会话归属、`when`、`params` 的顺序重新检查，同一 `requestId` 十分钟内只执行一次。隔离安装的包也能贡献命令：处理函数在它自己的进程里运行，宿主逐字段检查返回的结果（不合格是协议错误），调用期限 60 秒，`signal` 在期限前 5 秒与插件关闭时中止；它没有 `host.tasks`，命令不能启动任务。包的视图经消息桥的 `commands.execute` 执行本包声明的命令，结果原样交给视图 |
| `appearance` | `palettes`、`fonts`、`backgrounds`、`presets`、`iconPacks` | 配色是与自定义主题同结构的 JSON（53 个角色 × 明暗 + 各 16 个 ANSI）；字体是 woff2；背景是 PNG、JPEG 或 WebP；预设引用它们的贡献 ID；图标包为 Android 使用的单色矢量 JSON。细节和限制见 [THEMES.md](THEMES.md) §7 |
| `tasks` | `[{ id, title, projectType? }]` | 项目任务提供方的声明，代码在运行时贡献 `taskProviders`，见 [TASKS.md](TASKS.md) |
| modelSources | [{ id, title }] | 模型源的静态元数据；id 与运行时模型源相同，停用时也能列出。声明不授予 models.provide 能力 |
| sharePublisher | { title } | 分享发布方的静态元数据；由内置、可信开发包与可信安装包提供运行时实现 |
| `agentBackends` | `[{ id, title, icon? }]` | 插件提供的 Agent。`id` 是 `<插件 id>` 或 `<插件 id>.<名称>`（至多 64 字符）；内置 ID 只有官方 `riffet` 插件能声明 |
| `avatarStyles` | `[{ id, title, credit?, needsName? }]` | 个人资料的随机头像风格，`id` 是 `<插件 id>/<名称>`，`credit`（至多 300 字）是署名。代码贡献 `avatarStyles: { [id]: { generate({ seed, size, ink, paper, name? }) } }`，返回 SVG；核心校验后栅格化，见 [OWNER.md](OWNER.md)「随机头像」。隔离安装的包也能提供 |

`when` 是结构化条件，不是表达式：`hasProject`、`hasSession`、`projectType`、`capability`。它只决定可见性，不授予任何权限。

## 能力与授权

包在 manifest 的 `capabilities` 里列出它需要的能力。取值只有这些，不认识的名字使安装被拒绝：

| 能力 | 允许 | 由谁约束 |
| --- | --- | --- |
| `models.provide` | 提供模型源，刷新模型目录 | 宿主按贡献检查；缺少则激活失败 |
| `tasks.run` | 提供项目任务提供方；它的计划是在项目里以用户身份运行的命令，所以每条新计划先经用户确认，环境变量受名单限制（[TASKS.md](TASKS.md)「已安装包的计划」） | 宿主按贡献检查，并在每条新计划运行前向用户确认 |
| `projects.read` | 在一次任务调用内，经宿主发的句柄读该项目的文件（`exists`、`readText`、`list`） | 宿主：句柄绑定那次调用，路径限定在项目内，包看不到绝对路径 |
| `sessions.read` | 自定义视图经消息桥读它所属项目里的会话：大纲和时间线行（含工具输入输出） | 宿主：桥的身份绑在端口上，每个请求检查 |
| `network` | 独立进程的对外 IP 连接；`gateway.fetchModels` | macOS 由操作系统沙箱约束；其他平台只约束经宿主的 `gateway.fetchModels` |

授权按版本记录，必须等于包要求的集合：多一个或少一个都得 409 `PLUGIN_GRANT_REQUIRED`，`details` 带包要求的列表。新版本增加能力就需要新的授权，旧授权不沿用。Web 与 macOS 插件管理页弹出确认，命令行用 `--yes`（接受包要求的全部）或 `--grant a,b`。授权只是用户的同意，能不能做到取决于上面的「由谁约束」：能力声明只有经宿主或操作系统边界执行，才是权限保证。

## 信任级别

执行位置由宿主根据安装记录决定，包不能自称受信；`vendor`、插件 ID 和完整性摘要都不会自动赋予信任。

| 来源与方式 | 服务端执行 | 可提供的贡献 | 版本管理 |
| --- | --- | --- | --- |
| 内置 Cursor、Canvas | 服务进程 | 公共接口内全部能力 | 随应用发布 |
| `riffet plugin dev` 或 `RIFFET_DEV_PLUGINS` | 服务进程，与 Riffet 同权限 | 公共接口内全部能力 | 修改后自动重建与重载 |
| 默认安装 | 独立 Node 进程，按平台能力隔离 | 模型源、任务、命令、操作、诊断与静态声明 | 固定版本、切换、失败回退、卸载 |
| 本机 CLI `install --trusted` | 服务进程，与 Riffet 同权限 | 包括 CLI、命令凭据、分享发布器、运行时钩子、Agent 后端与服务 | 同默认安装；信任按版本保存 |

可信安装只接受服务所在设备上、无代理的路径或显式确认上传请求；Web/Mac 默认使用隔离安装，按需请求信任。`--trusted` 是本机操作员对代码的信任选择，不是能力沙箱。能力集合仍需准确授权，可信代码实际可以访问服务的文件、网络、凭据与进程。升级不能从 manifest 继承信任，安装每个新版本都必须再次显式传入 `--trusted`；切回旧版本使用旧版本已有的记录。同版本不能改变信任模式，需先卸载。可信包有独立的数据和版本管理，但仍受 Node 模块缓存影响：同一服务进程已导入过某版本后，不能用不同内容替换该路径；应增加版本号或重启。

所有非内置包的自定义界面继续走隔离消息桥，服务端可信不会获得应用内 React/原生界面入口。可信安装包的项目任务仍由宿主管理，并保留安装包的计划确认和环境变量限制。

## 打包与安装

`riffet plugin pack [目录] [--out 文件] [--format tgz|tar|zip]` 每次从当前源码构建，校验成功后归档；默认目录为当前目录，输出 `dist/<插件ID>-<版本>.tgz`。无需先运行 build/check，不读取旧的 `dist/package` 来替代源码。显式传入 `dist/package` 时则校验并打包已有产物，供高级工作流使用。

构建在插件自己的临时目录完成，成功后替换 `dist/package/`；归档也先写临时文件再原子替换。编译或校验失败保留上次成功产物。`--out` 可指定文件，未指定格式时按 `.zip` / `.tar` 后缀推断；`tar.gz` 是 `tgz` 的别名。安装器按文件内容识别归档。

| 格式 | 安装 | 打包 |
| --- | --- | --- |
| `.tgz`、`.tar.gz` | 支持 gzip 压缩的 tar | `--format tgz` |
| `.tar` | 支持未压缩 tar | `--format tar` |
| `.zip` | 支持 Store、DEFLATE，保留执行位 | `--format zip` |
| RAR、7z、XZ、加密/分卷/ZIP64 | 当前不支持 | 当前不支持 |

条目按路径排序、固定修改时间和文件权限；同样的文件产生同样的归档字节。安装和打包都不运行包脚本，不执行 `npm install/prepack`，运行依赖必须随包分发。限制保持为归档 32 MB、解包 96 MB、4000 个文件，禁止路径穿越、链接、设备与重复文件；ZIP 另校验目录、文件头、CRC 和真实解压大小。配色、字体和图片继续各自校验。

```sh
riffet plugin pack examples/plugins/graphite-theme --out /tmp/graphite.zip
riffet plugin install /tmp/graphite.zip

cd <外部插件仓库>/android-project-build
pnpm install --frozen-lockfile
riffet plugin pack . --out dist/android.tgz
riffet plugin install "$PWD/dist/android.tgz" --trusted --yes
```

安装入口：

- `riffet plugin uninstall <id> [version]`：省略版本时卸载全部安装版本；保留设置、密钥和数据，运行中的相关任务会阻止整插件卸载。Web/Mac 插件详情直接提供“卸载插件”；内置包不提供卸载。
- 开发包在详情的“管理”中使用“卸载插件”，保留源目录、设置和数据，并持久排除该目录的自动发现；显式重新关联后恢复。`unlink` 仍用于仅解除保存的开发关联。监听中的 dev 不会重新建立已移除的关联。
- `riffet plugin install <路径> [--yes | --grant a,b] [--trusted]`：接受目录或上述归档；服务运行时经接口生效，停止时直接记录，下次启动生效。无能力包无需 `--yes`，有能力包需精确授权。
- `POST /api/integrations/install`：`multipart/form-data` 上传归档，`grant` 为能力名数组或 JSON，`trusted` 是显式确认的布尔字符串；或本机 JSON `{ path, grant, trusted? }`。路径安装拒绝非本机和代理请求；上传可带 `trusted=true`，只允许直接来自服务所在设备的请求。
- 安装先在临时目录校验声明、入口、资源与兼容性，再计算内容完整性摘要。不同归档格式包含同样的路径、文件字节和执行位时得到同一摘要；摘要只证明内容未变，不认证发布者。

其余插件位于独立的外部插件仓库，每个目录单独持有 manifest、源码和资源。它们保留原插件/模型源/贡献 ID，因此已有配置、档案、分享和外观引用保持有效；应用不再内置这些包，需要单独安装。构建产物包含运行依赖（含插件自带的附属进程），不依赖 Riffet 的 dist 目录。

Riffet 自带构建与打包工具，不依赖插件安装 CLI 或相邻源码 checkout。代码插件的 SDK 作为开发依赖，暂以各自 `vendor/` 中的固定版本归档提供；运行包不包含 vendor 和 Node 工程。纯资源插件不需要 SDK。当前 SDK 在 npm registry 不可获取，尚未发布，registry 与发布身份确定后可改用固定版本依赖。

## 版本、回滚与数据

- 版本：`<stateDir>/plugins/<id>/<版本>/` 存文件。同一版本同样内容再装是幂等的，同一版本不同内容得 409 `PLUGIN_VERSION_CONFLICT`。
- 升级：新版本装入后自动选中，先关闭旧版本、换版本、再激活。新版本没有启动，就回到之前的版本，失败原因留在该行（`attention`），请求得 409 `PLUGIN_ACTIVATION_FAILED`；新版本仍是已安装、可再选。`select` 在版本间切换，同样会在失败时回到原版本。
- 资产：升级前的版本只要还装着，它的内容寻址资产地址（`/api/appearance/assets/:pluginId/:sha256`）就继续可用，持有旧目录的客户端不会 404；卸载那个版本后才失效。仍被未结束的任务使用的版本，文件等任务结束才清理。
- 数据：状态目录 `<stateDir>/plugin-data/<id>/` 与版本分开，升级、回滚、卸载都不动它。manifest 声明 `dataVersion` 后，宿主在激活前核对目录里的 `.riffet-data-version`：声明的版本更高时先把整个目录复制为 `<id>.backup-v<旧版本>`（最多两份）再写新版本号；更低时拒绝激活，错误里写出应当恢复的备份。恢复旧代码不等于数据可以回滚，所以要回到格式更旧的版本，先把备份移回数据目录。新版本自己没能启动时不用这样：宿主在重新启动上一个版本前，已把这次升级做的备份放回数据目录。
- 删除：卸载包、清除缓存、删除数据是分开的。`DELETE /api/integrations/:id/data` 是唯一删除数据（连同备份）的操作。

## 隔离的限制

默认隔离安装的服务端代码在独立 Node 进程里运行，进程有两层约束；纯资源包不启动进程，本节不适用于显式可信安装。`install.test.ts` 和 `acceptance.test.ts` 逐项断言下面写的内容。

| | macOS | 其他平台 |
| --- | --- | --- |
| 能否激活安装包 | 能：第一次激活前用同一份配置实际跑一次，失败则按不可用处理 | 不能，激活失败并写明原因。设环境变量 `RIFFET_UNSAFE_PLUGIN_PROCESS=1` 才允许，此时只剩 Node 权限模型，状态一直显示警告，`riffet doctor` 有一条 warn |
| 文件 | 只能读运行时垫片、包目录和自己的状态目录，只能写自己的状态目录；其余路径（包括 `~/.ssh`、别的项目目录）读取、`stat` 都被拒绝，Node 权限模型再拒绝一次 | Node 权限模型：只读这三处、只写状态目录 |
| 进程 | 只能执行 Node 本身，没有 `fork`，没有子进程；另外没有 Worker、原生扩展、WASI | 权限模型拒绝子进程、Worker、原生扩展、WASI、Inspector |
| 信号 | 只能发给自己；发给服务进程或任何别的进程得 `EPERM` | 不受限：包可以向服务进程发信号，包括 `SIGKILL`；`SIGUSR1` 靠服务端的监听挡住 |
| 网络 | 默认拒绝一切。持有 `network` 才放开对外 IP 连接（含回环）和名称解析；不能监听，不能连接别的 unix socket（tmux、ssh-agent、Docker），服务自己的端口也始终关闭 | 不受限，`network` 只约束经宿主的 `gateway.fetchModels` |
| 环境 | 只有 `NODE_ENV`、`LANG`、`TZ`、`OPENSSL_CONF=/dev/null`，没有令牌和 `PATH` | 同左 |

两个平台都没有的限制：CPU 和磁盘用量（内存只限制 V8 堆为 256 MB）；包经授权合法读到的内容——`projects.read` 读到的项目文件、模型源收到的 `overrides`、它自己的密钥——持有 `network` 的包可以把它们送出去。`sessions.read` 在 Web 上同理：框架的 CSP 拦不住所有外送途径（见 PLUGIN_ARCHITECTURE.md「自定义视图」），所以持有它的包能读到什么就能送出什么。在支持的平台上这些是已知的、没有设上限的，不要把安装包当作可信代码。

## 实验性：Agent 协议

`AgentBackend`（`packages/plugin-api/src/agent.ts`，`AGENT_PROTOCOL_VERSION` 为 1）还会变，只做可加性变更。内置、开发包与显式可信安装包可以提供 Agent；隔离安装包声明 `contributes.agentBackends` 仍被拒绝，目前没有跨进程 Agent 实现。

`examples/plugins/echo/` 是最小形状，按这个顺序读：

1. `profiles`、`capabilities`、`available`：描述 Agent；没有声明的能力不会被开放。
2. `open`：打开或恢复原生会话，返回的 ID 由核心保存。
3. `send`：在第一次不可逆写入之前调用 `host.commitDispatchFence`；之后上报三步，每一步只在成立时才说：已提交（写入完成）、已接受（Agent 自己产生的证据，如带 `commandId` 的回显）、完成（回合结束）。输出通过 `host.transcript.ingest` 推给核心，回合的起止用 `turns` 边表达。
4. `interrupt`：没有它，核心拒绝停止这个 Agent 的会话。

核心保存的是 commandId、排队、投递记录、journal 和会话归属，所以插件不会拿到 store、路由或终端服务。不需要改核心枚举、Web 选择器或 Mac 的显示代码：客户端从 `GET /api/backends` 取名称，声明 `X-Riffet-Features: plugin-agents` 的客户端才会收到带插件 Agent ID 的会话（移动端从不声明，看到的与以前一样）。需要终端、审批、历史导入的 Agent 要实现更多可选成员，见 PLUGIN_ARCHITECTURE.md「Agent 协议」。


## 开发、配置与 SDK

日常开发使用 `riffet plugin dev [目录]`，分发使用 `riffet plugin pack [目录]`。集合根目录不持有脚本、依赖或产物，每个插件自己的 `dist/` 承接构建目录和归档。

- 纯资源插件（如 `appearance-paper`）只需 manifest、资源和许可文件；不需要 package.json、锁文件、SDK、TypeScript 或测试配置。
- 代码插件使用 `index.ts` 作为默认服务端源码、`web/index.ts` 作为默认 Web 源码，也可提供 JS 或 manifest 已指向的现成模块。构建使用 Riffet 自带的 esbuild；运行依赖打入入口，SDK 与编译工具放在 devDependencies。
- 只收集运行入口、资源、声明引用的图标/外观文件和许可证；不会把测试、vendor、node_modules 和构建配置塞进运行包。打包不执行插件生命周期脚本。
- TRAE 这类额外入口在 package.json 中声明一次，`dev` 与 `pack` 共用：

```json
{
  "riffetPlugin": {
    "build": { "entries": { "route-daemon": "route-daemon.ts" } }
  }
}
```

额外入口输出到 `entries.server` 同一目录并使用相同扩展名。`--entry 名称=源码` 可用于临时覆盖；代码检查和测试仍可单独执行，无需作为每次打包的手动前置步骤。

`dev` 首次成功构建后，通过带认证与 CSRF 的本机接口注册构建目录，后续成功构建自动重载。服务停止时取得状态目录锁，只持久登记目录；后续构建会重新探测服务是否已启动。开发关联保存在 `<stateDir>/plugins.json`，退出监听仍保留，下次服务启动可继续加载；`riffet plugin unlink <id>` 解除关联并保留设置和数据。操作非默认服务时给 `dev` / `unlink` 加 `--state-dir <目录>`。同 ID 内置、已安装或其他目录的开发包会报冲突，先解除原关联或卸载已安装版本。开发包保持原启用策略，恢复模式仍能暂停它。

源码编译失败保留上次构建和正在使用的模块。重载成功时宿主以内容快照导入新代码及依赖，避免 Node 缓存复用旧实现。首次构建或关联失败退出，监听过程中的错误会报告并继续等待修改。

固定版本 `@riffet/plugin-api` 提供编译后的 ESM、类型、manifest Schema 和兼容的 `riffet-plugin` CLI。后者的 pack 使用同一实现，dev 默认委托 Riffet；独立 `build`、`check`、`dev --build-only` 留作高级调试。`scripts/pack-plugin.ts` 只是源码仓库兼容包装，不是独立插件的前置依赖。

宿主仓库的 `pnpm build:plugin-sdk -- --out <目录>` 生成 contracts、服务端 SDK、Web SDK 的可发布归档，命令不会发布到 registry。稳定接口使用包根；Agent 另提供 `@riffet/plugin-api/experimental/agent`。编辑器 Schema 为 `@riffet/plugin-api/riffet-plugin.schema.json`；未安装 SDK 的纯资源包可省略 `$schema`。运行时校验、打包校验和 Schema 共用公共定义，命名空间等关联规则在同一校验器中补充。

## 按需激活、诊断与执行位置

懒插件启用后先进入 idle，读取目录不运行入口或探测。首次模型目录/模型调用、命令/登录操作、项目任务发现或视图挂载触发对应事件；依赖先激活，同一插件并发触发只启动一次。停用和恢复模式仍拒绝触发。缺省 `activation` 的既有包维持启动行为。运行中升级立即验证新版本；空闲升级第一次使用失败时，宿主从持久安装记录恢复最近成功激活的版本及升级前数据。

描述符的 `execution` 给出服务端位置、实际执行模式与服务平台；连接的服务地址由现有客户端连接上下文显示。外部视图通过 `host.info` 协商当前客户端的 Web API、桥版本、renderer 和方法，客户端自己验证 `hostApi.web`。`projects.list`、`sessions.list` 和 `sessions.runs` 限当前项目并分页；单请求可以取消，数据变动发送不含正文的失效事件，视图再按自身授权读取。

```sh
riffet plugin logs acme.example-provider --limit 100
riffet plugin diagnostics acme.example-provider
riffet plugin reload acme.example-provider
```

日志位于宿主状态目录的 `plugin-logs/`，按 ID、版本和激活代次记录阶段、耗时与失败，提供 `GET /api/integrations/:id/logs`；读取不会激活插件，停止服务后 CLI 仍可读取。每个插件最多保留两份约 128 KiB 文件，查询最多 256 条；已知配置密钥与常见认证字段脱敏。插件可通过 `host.logger` 写有限日志，隔离进程的 stderr 也归属到对应插件，插件无权读取其他插件日志。

## 页面导入与卸载

页面导入默认走隔离安装。包声明 `requiresTrustedHost: true`，或旧包保留官方命名空间、历史模型源 ID、Agent / 分享发布器贡献时，服务返回 `PLUGIN_TRUST_REQUIRED` 及包 ID、版本、能力和本次请求是否允许本机信任；Web/Mac 显示默认未勾选的“信任此插件”，确认后重新上传。可信选择属于版本安装记录，manifest、vendor 或 `trusted` 自称都不能授信。远端或代理连接只显示服务所在设备的安装引导，不能提交可信安装。

保留历史模型源 ID 的插件若需要宿主 CLI 与命令凭据，改成命名空间 ID 也不能在隔离模式运行。若此前通过 dev 建立了同 ID 开发关联，应先在插件详情的“管理”中卸载开发包，再导入正式归档。

`DELETE /api/integrations/:id?source=installed` 一次卸载该插件的全部安装版本；已有按版本 DELETE 路径保留。开发包使用 `source=development&path=<目录>`，目录来自描述符的 `developmentPath`，以区分同 ID 的不同来源和目录。省略来源但目标存在歧义时拒绝卸载。卸载先检查相关运行任务、原子保存移除记录，再停用匹配目标的作用域和依赖方；保存失败时保留运行状态，仍被引用的文件沿用延迟回收。设置、密钥、数据和备份均保留，“删除数据”仍是独立操作。损坏而被拒绝加载的安装包同样可以卸载。

详情正在编辑或运行操作时，目录更新不会被动关闭页面；插件被其他客户端移除后保留草稿，禁止对失效目标发起新的保存或管理写入，并由用户确认关闭。重复打开同一配置链接会重新定位到指定子页。管理操作以来源和开发目录精确定位，损坏或校验失败的包仍可移除；同 ID 的健康插件不受影响。
