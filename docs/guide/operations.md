# 运行、部署与维护

返回 [中文 README](../../README.zh-CN.md)。本文是启动参数、后台运行与恢复、局域网与手机访问和备份更新的完整说明。

## 启动

需要 Node.js 24.19 或更高版本、pnpm，以及至少一个已经在本机完成登录或 API 配置的原生 CLI。使用 Cursor 或 CLI 终端视图时还需要 tmux。Cursor 安装见 [官方文档](https://cursor.com/docs/cli/installation)；Codex 需要支持 Unix socket App Server 和 `--remote` 的版本；DSH 桥按 `@deepseek-ai/dsh@0.2.0-rc.2` 的接口实现并验证，旧的 `0.1.x` 不兼容。工作台沿用 CLI 自己的认证方式，也可在「设置 → Agent 与模型」为独立配置填写入口、目录和只写入服务端的 API Key。

安装快捷命令 `riffet`（见下文）后，可以在任意目录运行：

```bash
riffet                 # 启动后台服务并打开浏览器
riffet start           # 启动后台服务
riffet status          # 查看状态、地址与数据目录（--json 机器可读）
riffet pair            # 输出局域网地址、一次性配对码与二维码
riffet pair --json     # 机器可读结果（含短期配对凭据）
riffet stop            # 关闭 Web 服务
riffet restart         # 按上次启动参数重启；--wait-idle <秒> 等待运行中的回合，--force 立即重启
riffet logs            # 查看最近 100 行日志，登录链接中的令牌会脱敏
riffet logs -f         # 持续查看日志，Ctrl+C 退出日志
riffet logs -n 30      # 查看最近 30 行日志
riffet logs --since 10m --scope codex,claude   # 按时间与范围过滤；--json 每行一个对象
riffet url             # 显示工作台地址
riffet token           # 显示访问令牌（登录页要求输入的就是它）
riffet url --login     # 显示带令牌的登录链接
riffet ls              # 列出会话，当前目录所属项目在前；-a 列出全部，-n 限制条数，--json 机器可读
riffet resume          # 在当前终端继续会话；终端中显示可搜索的选择器，也可传 ID 或标题
riffet service install # 登录时自动启动；另有 service status、service uninstall
riffet update          # 检查并安装新版本；--check 只检查
riffet completion zsh  # 命令补全；在终端运行会提示要加进 rc 文件的一行
riffet -v              # 版本号
riffet doctor          # 逐项检查 Node、tmux、各后端 CLI、端口和数据目录
riffet doctor --json   # 输出完整的环境与能力报告
riffet serve           # 前台运行，Ctrl+C 关闭 Web 服务
riffet --help          # 查看全部用法
```

`riffet` 单独运行等同 `riffet open`。命令名拼错时会提示 “Did you mean …”。`riffet` 与 `riffet-server` 是同一个入口，默认都使用 `http://127.0.0.1:4337/`、`cursor-agent` 和持久数据目录 `~/.local/share/riffet`。它不会因运行目录变化而切换数据或自动添加项目；需要添加当前目录时，使用 `riffet start --workspace .`。已经启动时，再次执行 `riffet` 会复用同一服务并打开页面。输出语言为英文；`--no-color` 关闭颜色，同时遵循 `NO_COLOR` 与 `FORCE_COLOR`。退出码：0 成功，1 失败，2 用法错误，130 被中断。

可用 `--state-dir`、`--port`、`--host`、`--cli`、`--workspace`、`--allow-host`、`--trust-network` 覆盖参数，或设置 `RIFFET_STATE_DIR`、`RIFFET_PORT`、`RIFFET_HOST`、`RIFFET_CLI` 环境变量；`--state-dir` 是全局选项，可写在子命令之前或之后。成功监听后，启动参数原子保存到 `<数据目录>/server-config.json`；`daemon.json` 只记录运行实例。`stop` 保留启动配置，之后 `start` 和 `restart` 都会恢复它。显式参数与环境变量覆盖保存值，例如 `riffet restart --host 0.0.0.0 --auth`。首次启动监听 127.0.0.1 且不要求令牌；任何非回环 `--host` 自动要求令牌，`--auth` / `--no-auth` 可覆盖，`--no-auth` 仅允许回环地址。非法端口、局域网免认证或不存在的 workspace 会在停止前被拒绝。`start`、`status` 和 `serve` 不显示令牌或登录链接；需要令牌时用 `riffet token`（只向标准输出打印令牌本身，可直接接 `pbcopy`），或用 `riffet url --login` 取得带令牌的登录链接。有新版本时，`status` 和启动输出会附一行提示；后台最多每天检查一次，`RIFFET_NO_UPDATE_NOTIFIER=1` 关闭。令牌读自 `<数据目录>/access-token`，服务停止时也能读取。

`riffet doctor` 默认按 Runtime / Agents / Server / Plugins 分组输出逐项清单：✓ 正常、! 可用但需留意、✗ 必须处理，每个非 ✓ 项后面附修复提示。检查项包括 Node 版本是否满足 `package.json` 的 `engines`、tmux、六个后端 CLI 能否解析（含「设置 → Agent 与模型」里各配置填写的入口；Cursor 还会检查登录状态）、目标端口是否空闲（已被本工作台占用视为正常）以及数据目录是否只有当前用户可访问。存在 ✗ 时退出码为 1，可用于脚本。`--json` 输出完整的环境与能力报告，并附带同一份检查结果，每项带 `group` 字段。`--compact` 压缩数据库（`workbench.db`、`journal.db`、`derived.db`）并去重存量 checkpoints，要求 Riffet 已停止。

命令实现在 `apps/server/src/cli/`；`scripts/riffet.mjs` 只是运行 `dist/cli.js` 的薄转发，本机通过 `~/.local/bin/riffet` 符号链接安装。移动项目后需要重新创建该链接。在其他 Mac 安装时，构建项目后执行（并确保 `~/.local/bin` 在 PATH 中）：

```bash
mkdir -p "$HOME/.local/bin"
ln -s /absolute/path/to/riffet/scripts/riffet.mjs "$HOME/.local/bin/riffet"
```

未安装快捷命令时，可在构建后直接调用 `dist/cli.js`（与 `riffet` 相同，默认端口 4337）：

```bash
cd /path/to/riffet
pnpm install
pnpm build
node dist/cli.js start --cli cursor-agent
```

启动命令打印工作台地址，不打印令牌；需要登录链接时用 `riffet url --login`，打开后 Web 将换取 HttpOnly 会话 Cookie，并移除地址中的令牌。令牌、数据库和备份保存在 `~/.local/share/riffet`，目录权限为 0700，数据文件权限为 0600。

```bash
node dist/cli.js status
node dist/cli.js stop
node dist/cli.js restart
node dist/cli.js doctor
node dist/cli.js doctor --json
```

前台启动可以使用 `node dist/cli.js serve`。`--state-dir`、`--port`、`--host`、`--cli` 可以覆盖默认值；`--workspace /absolute/project/path` 会添加一个项目。不同实例须使用不同状态目录和端口。

## 后台运行与恢复

`start` 启动后台服务，`stop` 停止 Web 服务并分离 tmux 客户端。原生 Cursor 和 Shell 由 tmux 持有，下一次启动可重新附着。Claude TUI 也由 tmux 持有；服务恢复后只读确认原终端状态，仍在运行或状态不明时继续把该会话视为占用中。重新打开会话时，工作台在确认原终端空闲后重启它并恢复同一原生会话，使 hooks 重新连接。Codex 会保存 App Server 的实际 Unix socket 地址；停止 Web 服务时只断开客户端，保留原生任务、子 Agent 和终端，下次启动复用同一个写入实例并恢复事件与审批订阅。只有保存的 socket 已不存在或拒绝连接时，才启动替代实例并按原 thread ID 恢复；仍存活的实例报错时不会再创建另一个写入者。DSH bridge 随 Web 服务关闭，之后按原生会话 ID 恢复。首次向后端写入前会持久化投递边界，网页断线和服务重启都不会自动重新发送结果不明的提示；未提交的排队任务需核对后继续。

数据库表结构升级到 v2 时会清除已移除的 ACP 后端留下的会话、运行记录与事件，并删除只服务于 ACP 的 `interactions` 表；原生会话、项目和设置不受影响。迁移只执行一次，失败时保留旧版本号，下次启动重试。

机器重启后 tmux 进程不再存在。工作台会将这些终端标记为退出，用户可以打开新终端或通过原生历史选择器恢复会话。电脑休眠和网络中断可能影响模型请求，恢复后应先查看任务状态。

通过原生历史选择器恢复会话时，会话标题会从「Untitled」自动回填：`plugins/riffet/cursor/title-watcher.ts` 只监听该终端输出，用其中的 `session id:` 之类标注推断你选中了哪个远端会话 id，并取一行保守的文本作为标题兜底。用户手动改过的标题永远不会被覆盖，观察窗口上限 2 分钟。CLI 的会话存储是私有格式且不带标题，所以这里的标题始终是文本推断的结果，不会声称来自结构化列表。

登录启动（macOS 使用 launchd，Linux 使用 `systemd --user`）：

```bash
riffet service install --cli cursor-agent
riffet service install --refresh-environment   # 安装新的 CLI 或 Node 后重新快照环境
riffet service status
riffet service uninstall
```

登录服务使用构建后的 CLI，并保留安装时的 PATH。更换 Node 安装位置或移动项目后，需要重新安装登录服务。Linux 上的用户服务只在登录期间运行，`loginctl enable-linger $USER` 可让它在注销后继续运行。

`riffet start`、登录服务和 Mac App 托管的服务都把输出追加到 `<数据目录>/server.log`，每行以 ISO 时间戳开头。日志超过 10 MB 时，服务把它复制为 `server.log.1` 再清空原文件，最多保留这两份，权限均为 0600。

事件循环单次阻塞 1 秒以上，或一分钟内阻塞 3 次时，服务采集随后 30 秒的 CPU profile，写入 `<数据目录>/diagnostics/stall-<时间>.cpuprofile`（每小时最多一次，保留最新 3 份，只含代码位置），并在日志中记录文件路径和自身耗时最多的 5 个函数。文件可在 Chrome DevTools 的 Performance 面板载入。

## 手机和另一台电脑

跨网络访问、主机名与反向代理、各客户端的连接方式见 [远程访问](remote-access.md)。

首次启动默认只监听本机。把现有实例开放给局域网并生成配对信息：

```bash
riffet restart --host 0.0.0.0 --auth
riffet pair
```

首次直接部署也可用 `riffet start --host 0.0.0.0`；快捷命令会启用认证。已经运行的 `start` 会复用原实例；要改变监听地址请用 `restart`。

`riffet pair` 从运行实例取得地址并发行一个 5 分钟有效、只能使用一次的配对码，终端同时打印二维码。每连接一个新客户端，重新执行该命令：

| 客户端 | 连接方式 | 保存的身份 |
| --- | --- | --- |
| 本机 Mac App | 自动读取本机服务信息并配对 | 系统钥匙串内的设备凭据 |
| iPhone / Android / 另一台 Mac 上的 App | 扫码或输入地址和配对码，可保存多台服务器并切换 | 各客户端的设备凭据 |
| 本机 / 局域网 Web | 打开地址，在登录页输入配对码 | HttpOnly Cookie；保留 CSRF、SSE、WebSocket 鉴权 |

Web 仍支持 `riffet token` / `riffet url --login` 的原有管理员登录方式。通过配对码连接的浏览器与原生客户端均可在设备列表撤销；撤销会立即断开该设备已有的实时流和终端连接，并拒绝后续请求及未执行的终端输入，其他设备不受影响。主令牌不进入二维码，浏览器也不把设备 bearer token 存入 localStorage。

`riffet pair --json` 返回 `localUrl`、`urls`、`code`、`expiresAt`（Unix 毫秒）和 `qrPayload`（v1 JSON 字符串）。此输出包含临时配对凭据，应只交给准备连接的客户端。`riffet status` 是只读状态查询，不生成配对码。仅绑定回环时，`pair` 会明确提示先启用局域网监听，不会输出手机无法使用的二维码。

同一实例的本机和 LAN 入口共用数据库、项目、原生会话、配置、设备管理与实时事件。地址选择以实际 listener 为准：具体 IP 仅广告该接口，`0.0.0.0` 提供有效 IPv4 和 Bonjour 候选；网络存在多个接口时仍需选双方可达的地址。当前 Bonjour 库无法按具体 IP 过滤地址记录，因此具体 IP 绑定不发布 mDNS，手动连接仍可用。Host、Origin、Cookie/设备身份及 CSRF 校验继续生效。

局域网 HTTP 不提供传输加密。跨网络使用可信私有网络、SSH 转发或 HTTPS 反向代理；将域名加入 `--allow-host`，反代保留实际 Host 并转发 WebSocket Upgrade。经已允许的 HTTPS 前门生成的配对信息会使用该域名、scheme 和端口，不把反代端口套到 LAN 地址。

正常 `riffet restart` 只重启服务进程。Cursor 的 tmux 会话与原进程继续执行；正在投递而尚未收到回执的消息会保留 journal，恢复时不会自动重复发送。这里不把所有 `running` Cursor 会话视为重启障碍，其他后端的恢复边界见上一节。启动入口已统一清洗调用方 Agent 的环境并解析用户 toolchain PATH。

`scripts/riffet-restart.sh` 是保留的运维辅助脚本：额外等待所有 running 会话、校验 LAN 健康，并维护自己的 host/port 默认值。它的等待比 server 生命周期本身更保守，并非普通重启所必需；日常使用 `riffet restart` 即可。

## 备份与更新

设置中的“创建备份”保存在线 SQLite 快照、附件、Checkpoint、工作台设置、原生后端配置、访问令牌、独立 Cookie 签名密钥和配置备份，并为每个文件生成校验和。备份目录具有私有权限；它可能包含历史代码和配置中的敏感值。

备份不包含项目完整工作树、各 CLI 自己的认证与原生会话存储、运行中的进程或 tmux socket。项目和原生历史仍由各自原有位置管理。

恢复必须使用一个空状态目录：

```bash
riffet restore --backup /absolute/backup/directory --state-dir /absolute/empty/state
riffet start --state-dir /absolute/empty/state --cli cursor-agent
```

恢复会验证清单、文件路径、符号链接与校验和，发现损坏时不写入最终目录。更新工作台前可创建备份。数据库若来自更新的工作台版本，旧版本会拒绝打开。

发布更新只比较源 clone 的 `origin` 中的稳定 `vX.Y.Z` tag：

```bash
riffet update --check                 # 只读检查
riffet update --check --json          # 机器可读结果
riffet update                        # 更新独立 Server / Web
riffet update --app --configuration Debug  # 更新 clone 内指定模式的 Mac App
```

自动更新要求源码干净、HEAD 对应发布 tag，并且没有其他实例使用同一 clone。独立服务会先停止，依赖安装与构建成功后按原配置恢复，再核对健康接口中的 tag 和 commit。Mac 更新前先在 App 中停止托管服务并退出 App；clone 外安装的副本需要手动替换。失败步骤与恢复命令保存在 `.riffet/update.log`，不自动 stash、reset 或回滚。

Web「设置 → 关于」检查 Server 更新；Mac「设置 → 关于」直接通过本机 Git 检查 App 更新，不要求 Server 运行。构建身份、发布规则和恢复边界见[更新机制](../UPDATE.md)。

## 版本与发布

服务端、Web、macOS、iPhone 与 Android 使用同一个版本号，唯一来源是根目录 `package.json`：

- `version`：stable 为 `MAJOR.MINOR.PATCH`，beta 为 `MAJOR.MINOR.PATCH-beta.N`；不允许前导零和其他预发布后缀。Apple `MARKETING_VERSION` 只取三段整数。
- `buildNumber`：构建号，格式 `yyMMddNN`（例如 `26101601` 表示 2026-10-16 当天第 1 个构建），同时用作 Android `versionCode` 与 Apple `CFBundleVersion`。两个平台都拒绝用更小的值覆盖安装，所以构建号只增不减，同一天最多 99 个。

Android 构建直接读取 `package.json`；XcodeGen 无法读取 JSON，两个 `project.yml` 里的 `MARKETING_VERSION` 与 `CURRENT_PROJECT_VERSION` 由脚本同步，不要手改。

```bash
pnpm version:bump                # 版本不变，生成下一个构建号（只重新出包时执行）
pnpm version:check               # 核对各端与 package.json 一致（CI 执行）
pnpm release:notes               # 上一个发布以来面向用户的提交，用来整理变更记录
pnpm release:prepare 0.8.0       # 预检、改版本、定稿变更记录、提交并打 tag（beta：0.8.0-beta.1）
git push origin main v0.8.0      # 触发发布工作流
```

变更记录分为 `CHANGELOG.md`（英文）和 `CHANGELOG.zh-CN.md`（中文），开发期间同步写在各自的未发布节。推送 tag 后，`.github/workflows/release.yml` 依次构建 npm 包、APK 和 macOS DMG，创建草稿 Release，执行冒烟测试，再发布（stable 需人工批准）。版本升级规则、渠道、各端产物、签名材料与回滚方式见[版本、发布与分发](../RELEASE.md)。

发布后的 tag 保持不可变。源码修正应升版本并创建新 tag。同一版本只修打包问题、重新出包时，只执行 `pnpm version:bump` 换构建号，不移动原 tag；这种重新打包不构成 Git 源码渠道的新版本。

Riffet 使用 Apache-2.0 许可（根目录 `LICENSE`、`NOTICE`）。第三方声明随构建生成，不手写：`pnpm build` 按 Web、分享页、预览与图表资源实际打包的 npm 包，以及 `dist/runtime-package.json` 的生产依赖树，写出 `dist/THIRD_PARTY_NOTICES.md`（版本、许可证、许可证与 NOTICE 全文）；Mac 包把它放在 `server/bin/`，与 Node 的许可证并列。App 自身的 Swift 包与 RiffetKit 的 Kotlin 库记在 `apps/macos/Riffet/Resources/Acknowledgements.md`，新增依赖时同步补上，CI 的 `apps/macos/scripts/check-acknowledgements.mjs` 会检查遗漏。

## 真实环境探针

真实测试使用隔离的临时工作区：

```bash
pnpm exec tsx scripts/probe-native-startup.ts
pnpm exec tsx scripts/probe-native-store.ts <项目目录>
```

前者启动真实 CLI 并核对启动参数与就绪判定，后者只读检查 CLI 会话存储的解析假设。两者都不会调用真实模型，也不会修改现有项目；输出不含 Key。
