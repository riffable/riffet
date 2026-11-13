# 基于 Git tag 的更新机制

状态：已实现。本文说明发布约定、检查入口和源码更新的执行边界。

用户自行 clone Riffet、安装依赖并构建使用。更新来源是该 clone 的 `origin`，发布基准是 `vX.Y.Z` tag。检查和更新都在用户机器上执行，沿用用户自己的 Git 认证。第一期覆盖独立 Server、随 Server 提供的 Web，以及从同一 clone 构建的 macOS App。

## 发布约定

沿用根目录 `package.json` 的版本规范，每个源码发布版本对应一个 tag，例如 `v0.5.1`。tag 中的版本必须与该提交的 `package.json.version` 一致。

- 只识别稳定版本 `vMAJOR.MINOR.PATCH`，各段使用无前导零的非负整数。beta tag（`vMAJOR.MINOR.PATCH-beta.N`，见 [RELEASE.md](RELEASE.md)）不参与比较；从 beta tag 构建的程序按开发构建处理。
- 按三个版本段的数值比较新旧，例如 `v0.10.0` 高于 `v0.9.0`；提交时间、tag 创建时间和普通字符串排序不参与判断。
- 同时支持 annotated tag 和 lightweight tag，统一解析到最终 commit。
- 发布后的 tag 固定到原 commit。源码需要修正时升版本、发布新 tag。
- 分支上的日常提交不构成新发布。仅增加 `buildNumber` 的重新打包也不构成 Git 源码渠道的新版本。

发布者完成现有版本同步、变更记录和必要验证后，创建 tag 并推送到仓库。仓库平台只需提供 Git 访问能力。

## 当前版本如何确定

构建时生成一次版本信息，Server、Web 和 App 各自携带该次构建的信息：

```ts
type BuildInfo = {
  version: string;
  buildNumber: number;
  tag: string | null;
  commit: string | null;
  dirty: boolean;
};
```

`tag` 只在 HEAD 恰好对应合法发布 tag、版本字段一致且源码干净时填写。未打 tag、存在本地修改或缺少 Git 信息的构建显示为开发构建；commit 用于定位代码。构建过程中源码发生变化时，该次构建不能标为有效发布构建。

在 `pnpm build` 开始时生成版本信息，以本次构建独占的快照文件供 Vite 与 Server 共同使用，结束后清理。Mac 提供父级构建记录时，先校验并复制到本次快照，避免其他构建覆盖共享文件。信息写入产物后，运行期间保持不变。Server 扩展现有 `/health`，保留 `version`、`instanceId`、`managedBy`，增加构建信息；Web 注入自己的构建信息，App 将其作为 bundle 资源读取。缺少新字段的旧版本显示“未记录发布版本”。

检查结果分别展示当前运行版本、本地源码状态和最新发布版本。源码已经切到新 tag，而 Server 或 App 仍报告旧 tag 时，显示“源码已更新，程序尚未生效”。Web 页面仍加载旧构建时提示刷新。

源码位置单独处理：CLI 从入口的真实位置确定仓库根目录；App 在本机构建时记录源 clone 的路径，使用前验证目录与 Git 仓库身份。App 的「选择源 clone」可重新关联移动后的目录。该本机路径不进入公共健康响应或远端客户端的检查结果。

## 检查更新

第一期只在用户点击或执行命令时检查，查询该 clone 配置的 `origin`：

```bash
git ls-remote --tags origin 'refs/tags/v*'
```

检查只读取远端引用，不拉取分支、不改本地 tag 或工作树。解析结果时合并 annotated tag 的 `^{}` 条目，严格筛选发布版本并选出最高版本。Git 官方文档说明了远端引用查询及 tag 的展开格式，见 [git-ls-remote](https://git-scm.com/docs/git-ls-remote)。

| 情况 | 显示与处理 |
| --- | --- |
| 当前是有效发布构建，远端存在更高版本 | 显示可更新版本 |
| 当前发布版本与远端最高版本一致，commit 一致 | 当前为最新发布版本 |
| 当前版本高于该 origin 的最高发布版本 | 显示当前版本较新，不自动降级 |
| 当前是开发构建或旧构建未记录 tag | 展示最新发布信息，引导手动处理，不标为已是最新版 |
| 当前 tag 与远端同名 tag 的 commit 不同，或已有本地 tag 的对象或 commit 与远端不同 | 报告发布 tag 已变化，停止自动更新 |
| 远端没有合法发布 tag | 显示尚无发布版本 |
| Git 认证、网络或 origin 配置失败 | 显示无法检查并提示在终端排查，不回传 Git 原始错误，也不复用旧结果声称已是最新版 |

本地源码已经更新时，仍以各个运行产物自己的构建信息判断是否生效。本地同名 tag 与远端冲突，也必须作为异常报告。

## 操作入口

```bash
riffet update --check          # 检查独立 Server 的版本与该 clone 的最新发布
riffet update --check --json   # 同一检查结果，供本机客户端读取
riffet update                 # 更新源码并构建独立 Server / Web
riffet update --app            # 更新源码并构建 repo 内的 macOS App
riffet update --app --configuration Debug  # 同时存在两个 App 时明确选择
```

未安装快捷命令时，在 clone 内使用 `node scripts/riffet.mjs update ...`。自定义数据目录沿用 `--state-dir`。`--json` 只与 `--check` 一起使用，`--configuration` 只用于 `--app`。

Web 的「设置 → 关于」展示 Web 自身和 Server 的构建版本，点击「检查更新」后调用受现有认证保护的 `GET /api/update`。检查发生在 Server 所在机器，只提供读取能力。CLI 检查时，活跃 Server 的当前版本以健康接口为准；服务未运行时使用该 CLI 自身嵌入的构建记录。JSON 结果包含当前构建、本地源码和远端最新发布信息。

Mac 的「设置 → 关于 → 检查更新」由 App 原生代码直接执行本机 Git，读取关联 clone 的 `origin` tag，并与 bundle 内 App 自身的构建信息比较。此过程不调用 Server 或 CLI，Server 未启动、连接远程 Server 时都可检查 App 更新。「复制 App 更新命令」包含源码路径和构建模式。所连接 Server 的版本继续在「诊断」中查看；原有发行包更新入口独立保留。

CLI 与 Server 的进程执行复用 `apps/server/src/git/exec.ts`。Mac 使用 Foundation Process，并限制时间与输出量。检查采用非交互 Git 认证，保留用户已有 Git SSH 配置；用户可在终端修复认证后重试。面向客户端的结果只返回版本和处理状态，不返回远端认证 URL 或本机源码路径。

## 独立 Server 更新流程

第一期采用原地更新，允许安装依赖和构建期间短暂停服。自动更新适用于一个 clone 对应一个运行安装的使用方式；多实例共用源码的情况沿用手动维护。

1. **预检。** 确认源码根目录、origin 和目标发布版本；检查当前 Git、Node 与 pnpm 能否执行；确认工作树没有已暂存、未暂存和未忽略的未跟踪文件。HEAD 必须恰好对应合法发布 tag。开发分支包含额外提交时，只提供检查结果和手动指引。重复执行允许源码已在目标 tag、运行程序仍旧或已经停止的情况。
2. **获取目标。** 只 fetch 选中的 tag，禁止强制覆盖。解析 commit 后核对检查时取得的远端引用、已有同名本地 tag，以及目标 `package.json` 中的版本和工具链要求。目标工具链验证通过后才进入停服阶段。检查和 fetch 之间 tag 发生变化时退出。获取阶段保持原服务运行。[git-fetch](https://git-scm.com/docs/git-fetch) 说明了显式 refspec 和 tag 更新规则。
3. **停止原实例。** 先确认运行服务属于本 clone 和所选状态目录，记录原 commit、分支及启动配置。有运行中任务时退出，待任务结束后重试。由原托管方式停止服务，并确认进程退出；停服失败时不修改源码。
4. **更新并构建。** 切到目标 commit 的 detached HEAD，原分支引用保留。依次运行 `pnpm install --frozen-lockfile`、`pnpm version:check`、`pnpm build`，每一步成功才继续。构建完成后再次核对源码状态及产物中的 tag、commit。
5. **恢复与验收。** 本次命令开始时服务在运行，则按原状态目录、端口、监听与认证配置恢复启动；原本停止时只更新产物。启动成功后核对 `/health` 的目标 tag、commit 和新的 `instanceId`。命令退出成功不能替代运行版本核对。

CLI 托管实例复用现有启动与配置恢复逻辑。launchd / systemd 托管实例经原服务管理器停止并启动，避免 KeepAlive 在构建期间重启程序。更新前核对服务配置中的源码入口和状态目录；没有可核对实例但仍已加载的同 clone 登录服务，也会阻止更新。无法确认托管方式时停止自动更新。App 托管的服务使用下节流程。

更新前记录原状态，在现有忽略目录 `.riffet` 下保存 `update.log` 与 `update.lock`；同时只允许一个更新进程修改同一 clone。预检和停服后分别检查是否仍有其他状态目录的服务使用同一源码。停服前后重新检查 HEAD 与工作树，构建后再次核对目标身份。操作使用独立子进程参数，不把远端输出拼接为 shell 命令。

同一 clone 的 `start` 和 `serve` 也读取更新锁。源码切换、依赖安装与构建期间拒绝启动；全部构建及版本核对完成后，更新进程把锁标记为 `ready`，才允许恢复服务或重新打开 App。锁继续阻止第二个更新进程，直到本次命令退出。已完成构建后遗留的 `ready` 锁允许启动服务，但仍需人工核对并移除后才能再次更新。

## macOS App 更新流程

App 更新使用同样的 tag 规则。自动替换范围限定为该 clone 下的 `apps/macos/build/Debug/Riffet.app` 和 `apps/macos/build/Release/Riffet.app`，沿用已记录的构建模式。两者都存在时，必须用 `--configuration Debug` 或 `--configuration Release` 选择。

执行 `riffet update --app` 前，用户在现有服务设置中停止 App 托管的 Server，并退出目标 App。独立 Server 若也从同 clone 运行，须先停止，更新后单独恢复。CLI 检测到目标 App、同 clone 的服务仍运行，或本机仍有已注册的 App 托管服务时，给出停用步骤并退出。远程机器上的 Server 不受本机 App 更新影响，继续由原方式管理。

通过预检并切到目标 tag 后，复用现有构建流程：Debug 先构建 clone 的 Server / Web，再构建 App；Release 重建包含目标 Server / Web 的 payload，再构建 App。构建信息必须进入 payload 指纹，防止错误复用旧版本。

`apps/macos/scripts/build.sh update-debug|update-release` 在独立构建目录中生成 `apps/macos/build/update/Riffet.app`。CLI 核对其版本、源码路径和构建模式，成功后才替换目标 App 并重新打开。App 构建替换成功与 Server 恢复分别报告。原来由 App 托管的服务，由用户重开后通过现有启动入口恢复；服务恢复后还需核对健康接口中的 tag 和 commit。

复制到 `/Applications` 或其他目录的 App 仍可检查版本，更新命令只生成和替换 clone 内的 App，用户需自行安装到外部目录。没有构建记录的旧 App，先手动构建一次。源码关联失效的 App 仍能展示自身构建版本。iPhone 与 Android 保留现有构建安装方式。

## 失败与恢复

网络、认证、版本校验和工具链预检失败时，源码与原服务保持原状。停服后的安装、构建或启动失败，则保留失败步骤、原 commit、当前源码状态和可执行的恢复说明，不能报告更新成功。

原地更新不承诺失败后原服务持续可用。依赖目录或构建产物可能已部分改写，恢复原 commit 后需要重新安装依赖、构建并启动；不自动 stash、reset、清理用户文件或切回分支。重复执行命令可重试构建；若上次失败已经停服，构建成功后按日志中的恢复命令，使用原状态目录的现有启动配置或原服务管理器配置恢复服务。若依赖或 CLI 构建损坏导致更新命令无法运行，则从源 clone 手动安装依赖、构建，再恢复服务。日志提供这些恢复命令。

更新进程正常退出时释放自己的锁。被强制结束后可能留下 `.riffet/update.lock`；程序不会自动删除它。确认记录的 PID 已退出、没有其他更新正在进行，再检查日志并手动移除遗留锁。

数据库、配对凭据和启动配置继续留在原状态目录。数据库若已被新版本迁移，旧程序可能无法打开，需使用现有备份恢复流程；源码回退不等于数据库回退。用户可在更新前使用现有备份能力。

## 代码位置与验证

实现复用现有入口，不增加运行时依赖：

- `scripts/build-info.mjs` 生成构建记录，Vite、esbuild 和 Mac 构建入口共享同一快照；`packages/contracts/src/update.ts` 定义公开字段。
- `apps/server/src/update.ts` 负责 Git tag 解析、远端查询、冲突检测和目标 tag 获取。
- `apps/server/src/cli-update.ts` 负责源码更新、锁、日志及 App 替换；`cli.ts` 对接原服务管理器与健康核对，`scripts/riffet.mjs` 转发命令。
- `apps/server/src/routes/update.ts` 与 Web 关于页提供手动检查；Mac 的 `Services/GitUpdates.swift` 独立实现本机检查。

核心验证使用临时本地 Git 仓库，覆盖两类 tag、版本排序、tag 变化、只读检查、脏工作树、分支保留、更新互斥、跨状态目录占用和构建失败恢复。CLI 隔离验证实际执行停服与重启，核对新实例的 tag、commit 和原启动配置；依赖安装在该验证中使用替身。Server / Web 做类型检查与正式构建，Mac 做独立 Debug 构建、测试目标编译及本机 Git 协议验证。真实登录服务停启、已安装 App 的替换重开与完整 Release 出包不在本次自动验证范围。

首次采用本机制时，发布一个包含这些能力的新 tag。旧安装通过现有手动流程切到该 tag 并构建一次，之后使用新命令。仓库没有发布 tag 时，保持“尚无发布版本”状态。
