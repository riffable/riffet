# 项目任务

任务是服务端为某个项目启动的一个进程，例如一次 Gradle 构建。进程、日志和结果归服务端，不属于发起它的客户端或提供它的插件：关掉面板、断开连接、重启服务或停用插件都不会终止它。设计见 [plugin-system.md](design/plugin-system.md) 第 7 节，插件接口见 [PLUGIN_ARCHITECTURE.md](PLUGIN_ARCHITECTURE.md)。

代码在 `apps/server/src/tasks/`，类型在 `packages/contracts/src/tasks.ts`，提供方接口在 `packages/plugin-api`，官方样本是独立外部插件仓库中的 Android 构建插件。

## 任务模型

`Task`：`id`、`requestId`、`projectId`、`pluginId`、`providerId`、`providerVersion`（开始时插件的版本）、`actionId`、`title`、`params`、`state`、`exitCode`、`startedAt`、`endedAt`、`cancelRequestedAt`、`logSize`、`diagnostics`、`artifacts`、`unknownReason`。

| 状态 | 含义 |
| --- | --- |
| `running` | 进程在运行 |
| `cancelling` | 已请求取消，尚未看到进程退出 |
| `succeeded` / `failed` | 退出码为 0 / 不为 0 |
| `cancelled` | 已请求取消，且进程已退出（退出码为 0 的仍记为 `succeeded`：以真实退出为准） |
| `unknown` | 重启后无法确认进程的结局，原因在 `unknownReason`；永不自动重跑，日志仍可读 |

开始时执行计划就固定下来（命令、参数、工作目录、锁、产物规则），连同插件版本一起保存；之后升级或停用插件都不改变这个任务。

## 开始、幂等与锁

`POST /api/tasks` 的 `requestId` 是客户端的幂等键。同一 `requestId` 且指纹相同（项目、提供方、操作和规范化后的参数）返回同一个任务，哪怕任务早已结束；指纹不同返回 409 `TASK_REQUEST_CONFLICT`。同一时刻开始的重复请求只启动一个进程。

计划里的 `lock` 与项目一起决定互斥：同一项目已有运行中的同锁任务，返回 409 `TASK_BUSY`，`details.taskId` 是它的 ID。不同项目互不影响；没有 `lock` 的任务不等待别的任务。`unknown` 的任务不占锁。

宿主从已验证的项目解析工作目录，客户端不能指定；计划的 `cwd` 只能是项目内的相对目录，`file` 只能是 PATH 里的命令名或项目内的 `./路径`，都经 realpath 检查，越界返回 502 `TASK_PLAN_INVALID` 且不会启动进程。环境变量取服务端进程的环境（用户的 PATH、`JAVA_HOME`、`ANDROID_HOME`），再叠加计划的 `env`。

## 进程与日志

进程用 `sh -c` 包装启动，独立进程组，标准输出与错误直接写到 `<stateDir>/tasks/<id>/log`，不经过服务端的管道，所以服务重启后输出不丢。包装脚本在命令退出后把退出码原子写入同目录的 `exit`，并在进程组收到 SIGTERM 时继续等命令退出，因此 `exit` 存在就表示命令已经退出。记录里保存 pid、pgid 和进程启动时间。

## 取消

`POST /api/tasks/:id/cancel`：向进程组发 SIGTERM，10 秒后仍未退出则发 SIGKILL；状态为 `cancelling`，直到看到进程退出才变为 `cancelled`。已结束的任务取消是空操作，返回该任务。发信号前先核对 pid 与启动时间，对不上的进程不会被发信号。

## 重启恢复

服务启动时（插件激活之后）对每个 `running` 或 `cancelling` 的任务：

1. `exit` 文件存在：按退出码收尾。
2. 否则 pid 存活且启动时间与记录一致：继续观察，轮询 `exit`；`cancelling` 的按剩余时间补上 SIGKILL。
3. 否则标为 `unknown` 并写明原因（进程已不在且没有退出码、pid 被别的进程占用、进程从未记录）；`cancelling` 且进程已不在的记为 `cancelled`。

任何情况都不重跑。服务关闭只停止观察，不终止任务。

## 产物与诊断

成功后按计划的 `artifacts`（项目相对的 glob，支持 `*`、`?`、`**`）在项目内查找：不跟随符号链接，限制遍历的条目、深度和结果数，找到的文件再做 realpath 检查，记录名称、大小和 sha256。`GET /api/tasks/:id/artifacts/:artifactId` 作为下载提供；下载时核对大小与修改时间，之后被重新构建覆盖的返回 409 `TASK_ARTIFACT_CHANGED`。

任务结束后对日志末尾（至多 512 KB，从整行开始）调用提供方的 `diagnostics`，得到 `TaskDiagnostic[]`（`file` 为项目相对路径，至多 200 条）。读日志的是开始这个任务的那个版本（`providerVersion`）的提供方：该版本已不在运行（插件已停用，或换了别的版本）就没有诊断，任务上的 `diagnosticsNote` 记下原因。

## 停用插件

插件已停用：`taskProviders` 不再返回，新任务得到 409 `TASK_PROVIDER_UNAVAILABLE`，操作列表也为空；已在运行的任务继续到结束。注册表的 disposer 不涉及任务进程。

插件有运行中的任务时被停用，或被切换到另一个版本（设计第 8 节）：注册表进入 `stopping`，插件保持开启，不再提供操作，新任务得到 409 `TASK_PROVIDER_STOPPING`（命令得到 409 `COMMAND_UNAVAILABLE`），`PluginDescriptor` 带 `stopping: { running, version? }` 且 `status` 为 `attention`。任务全部结束（含 `cancelling` 到真正退出）后才停用或切换，这期间任务结束的诊断仍由原提供方读取。`PATCH /api/integrations/:id` 带 `force: true`（可与 `enablement` 同发）立即进行，任务不会被取消，之后的诊断按上一节跳过。等待只在内存里：服务重启后停用的选择保留，而待切换的版本丢失，旧版本继续运行。

## 已安装包的计划

来自已安装包的提供方（`source: 'installed'`；内置与开发包不受影响）的计划，在 `plan()` 之后多两道关：

- 环境变量与文本：名字须匹配 `^[A-Z][A-Z0-9_]{0,63}$`，不得是 `NODE_OPTIONS`、`NODE_PATH`、`DYLD_*`、`LD_*`、`PATH`、`HOME`、`SHELL`、`BASH_ENV`、`BASH_*`、`ENV`、`ZDOTDIR`、`SHELLOPTS`、`BASHOPTS`、`PS4`、`IFS`（任务外层的 `/bin/sh` 会读它们：`SHELLOPTS=xtrace` 加 `PS4='$(…)'` 在命令之前执行代码）、`PYTHONSTARTUP`、`PYTHONPATH`、`PYTHONHOME`、`RUBYOPT`、`RUBYLIB`、`PERL5OPT`、`PERL5LIB`、`PERLLIB`、`JAVA_TOOL_OPTIONS`、`_JAVA_OPTIONS`、`JDK_JAVA_OPTIONS`、`LUA_*`、`GIT_*`、`SSH_*`、`RIFFET_*`，值至多 4 KB；`file`、`args`、`env` 不得含控制、格式（双向覆盖、零宽）或行分隔字符，合计至多 8192 字符，使确认里看到的就是要运行的全部；否则 502 `TASK_PLAN_INVALID`。这是名单而非白名单：构建工具自己的变量（`GRADLE_OPTS`、`JAVA_OPTS`、`MAVEN_OPTS`、`RUSTC_WRAPPER`、`NPM_CONFIG_*` 等）仍可改变程序做什么，它们和其他变量一样显示在确认里。
- 确认：`(插件, 版本, 提供方, 操作, 计划指纹)` 第一次运行时，`POST /api/tasks` 得到 409 `TASK_CONFIRM_REQUIRED`，`details` 是 `{ fingerprint, plan: { file, args, cwd, env } }`（`cwd` 相对项目，`.` 是项目根；指纹是项目与这四项规范化后的 sha256，所以批准只对这个项目有效：另一个项目里的 `./gradlew` 是另一个文件，要重新确认）。客户端把计划给用户看，同意后用同一个请求体加 `confirm: <fingerprint>` 再发一次：服务端把批准记在任务数据库的 `task_approvals` 表里并运行。之后相同的计划不再询问；`file`、`args`、`cwd` 或 `env` 任何一项变了需要重新确认；插件版本变了，旧版本的批准即丢弃。`confirm` 与现在的指纹不符（计划在两次请求之间变了）仍然是 409。

经 `host.tasks.start`（命令里启动任务）的任务走同一条路；命令得到的是任务服务的原错误，`POST .../commands/:name` 带 `confirm` 重发即可，不另设状态。已安装包的宿主目前不提供 `host.tasks`，所以这只对将来的情形成立。

## 提供方接口

```ts
interface TaskProvider {
  id: string;                                   // `<插件 id>/<名称>`，须在 contributes.tasks 声明
  detect(project: ProjectContext): Promise<boolean>;   // 只读标志文件
  actions(project: ProjectContext): Promise<TaskActionSpec[]>;
  plan(actionId: string, params: TaskParams, project: ProjectContext): Promise<TaskPlan>;
  diagnostics?(logTail: string, context: DiagnosticsContext): TaskDiagnostic[];
}
interface TaskPlan { file: string; args: string[]; cwd?: string; env?: Record<string, string>; lock?: string; artifacts?: string[] }
```

`TaskActionSpec` 的呈现字段都可选，宿主不认识的字段会忽略：`group`（分区）、`primary`（主操作）、`icon`（固定的一组图标名）、`confirm`（每次开始前客户端询问的话；只是提示，服务端不据此拦截，执行前的把关仍是上一节的计划确认）和 `log`。`log.rules` 按第一条匹配的正则给日志行着色或折叠；`log.records` 声明日志行是记录（如 logcat）：`pattern` 的命名分组是字段，`levels` 从轻到重列出级别，`columns` 是显示在级别和消息前的字段。客户端按列显示，并用 Android Studio Logcat 的查询筛选：`tag:Foo` 包含、`tag=:Foo` 相等、`tag~:正则`、前缀 `-` 排除、`level:W` 为 W 及更重，裸词搜 `message`。服务端校验这些字段，编译不过或超出上限的部分丢弃，操作本身照常可用。

`ProjectContext` 提供 `id`、`name`、`exists`、`readText(relPath, maxBytes)` 和 `list(relDir)`，路径都相对项目、受 `workspace/scope.ts` 的检查约束，不暴露绝对路径。`DiagnosticsContext.relativize(path)` 把日志里的路径转成项目相对路径，项目之外返回 `undefined`。操作的 `params` 是字段列表（`text`、`boolean`、`choice`），宿主在 `plan` 之前校验。

声明：manifest 的 `contributes.tasks` 是 `{ id, title, projectType? }`；视图用 `renderer: { kind: 'tasks', provider }` 表示由宿主绘制该提供方的任务界面。客户端用 `projectTypes`（见下）判断视图 `when.projectType`。

## HTTP 接口

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/projects/:id/task-actions` | `{ actions, projectTypes }`：已启用且 `detect` 通过的提供方的操作，按项目缓存数秒 |
| `POST /api/tasks` | `{ requestId, projectId, providerId, actionId, params?, confirm? }`，返回 `Task`；409 `TASK_REQUEST_CONFLICT`、`TASK_BUSY`、`TASK_PROVIDER_UNAVAILABLE`、`TASK_PROVIDER_STOPPING`、`TASK_CONFIRM_REQUIRED` |
| `GET /api/tasks?projectId=&limit=` | 该项目最近的任务，新的在前，`limit` 至多 100 |
| `GET /api/tasks/:id` | `Task` |
| `POST /api/tasks/:id/cancel` | 返回 `Task` |
| `GET /api/tasks/:id/log?from=&limit=` | `TaskLogChunk { from, to, text, eof }`：字节区间 `[from, to)`，`limit` 至多 256 KB；`to` 落在字符边界，下一次用 `from = to`；任务结束且读到末尾时 `eof` 为 true |
| `GET /api/tasks/:id/artifacts/:artifactId` | 产物下载 |

状态变化时 `/api/lists/stream` 发 `task` 事件，数据为 `{ id, projectId, state }`，客户端再读任务；运行中的日志用 `log` 轮询。

## 客户端

声明了 `renderer: { kind: 'tasks', provider }` 的视图由宿主绘制，Web（`apps/web/src/plugins/TasksView.tsx`）和 macOS（`InspectorViewRegistry` 的 `tasks` 渲染器）各有实现：该提供方的操作按钮、运行中任务的状态与日志尾部、取消、最近任务、诊断（点文件在文件面板的该行打开）和产物下载。关闭面板、切换标签或项目只停止轮询，不影响任务；状态来自 `task` 事件，辅以对运行中任务的轮询。

视图的 `when.projectType` 用 `GET /api/projects/:id/task-actions` 的 `projectTypes` 判断，按项目缓存，项目或插件变化时重新读取；读不到时条件不成立，视图不显示。

## 保留与限制

已结束的任务每个项目保留最近 100 个，且不超过 30 天，超出的连同日志目录一起删除。运行中的日志由进程直接写入，不设上限；读取按窗口，单次至多 256 KB。Windows 不支持任务。
