# Riffet 运行环境契约

本文是**守护进程及其终端的环境契约**：回答三件事——**哪些变量必须被清洗、哪些必须被完整保留**（§4）、**PATH 与 node 从哪来、按什么顺序兜底**（§5、§6）、**换一台机器/换一个服务管理器怎么保证仍然成立**（§9）。

**边界**：本文只管进程环境与可执行文件解析。会话数据、协议、UI 不在本文范围。落点在 `apps/server/src/environment.ts`、`apps/server/src/backends/shared/cli-resolve.ts`、`apps/server/src/cli.ts`、`apps/server/src/terminal/service.ts`、`apps/server/src/backends/service.ts` 与 `scripts/riffet-restart.sh`。

状态：**已落地**（2026-10-09）。验收证据见 §11。

---

## 1. 判据

1. **凭证不外泄**：调用方（通常是某个 agent 会话）的环境不得进入守护进程，更不得进入它之后启动的每一个终端。
2. **工具链不丢失**：守护进程必须能跑到**用户自己装的**那套东西——node、dsh、cursor-agent、claude、codex、pnpm——不管它装在 homebrew、apt、nvm、asdf、mise、fnm、volta 还是某个自定义 npm prefix 下。
3. **绝不因为环境而启动失败**：没有登录 shell、没有缓存、PATH 为空、rc 文件挂死，都必须能起来，只是降级并**说明**降级到了什么。
4. **说真话**：后端可用性必须是探针的真实结果，不能是常量；失败必须给出原因和查过哪些目录。
5. **可诊断**：远端一台机器上重启失败，只看重启日志或一个 URL 就能定位，而不是靠猜。

判据 1 与判据 2 是最初被混为一谈的一对，见 §3。

## 2. 术语

- **清洗（scrub）**：从继承来的环境里**删除**若干名字，其余原样保留。
- **重建（rebuild）**：丢弃继承来的环境，从一个白名单**重新拼**一个。本文的前身就是重建，它是本次事故的成因。
- **解析（resolve）**：为一个后端 CLI 找出可执行的**绝对路径**，而不是把裸名丢给 PATH。

---

## 3. 事故与根因（2026-10-09）

`scripts/riffet-restart.sh` 用 `env -i` + 白名单重建守护进程的环境，再让守护进程在「干净的登录 shell」里启动。三个事实叠加：

1. 该机器上 `dsh` 只存在于 `~/.local/bin/node/bin/dsh`（自定义 npm prefix）。
2. 给这个目录加 PATH 的**只有 `~/.zshrc` 一行**；`~/.zprofile`、`~/.bash_profile`、`~/.bashrc`、`/etc/paths.d` 都没有。
3. 非交互登录 shell（`zsh -lc`）**不读 `.zshrc`**。

于是重启后守护进程的 PATH 里没有那个目录。代码里唯一的环境补丁是 `withCliInstallDir()`，它硬编码只追加 `~/.local/bin` —— 差一层目录，救不了 `dsh`。结果：DSH 后端 `available: false / Cannot find "dsh"`。

同一根因还有两个更隐蔽的后果：

- **守护进程换了 node**：登录环境解析到 homebrew node v26.7.0，而用户交互式使用的、装了全部全局 CLI 的是 `~/.local/bin/node/bin/node` v24.19.0。服务被静默换到了一个用户没有选择的运行时上。
- **Linux 上可能根本重启不了**：重启用例里的 `login_node` 在非交互登录环境里找不到 node 就 `fail 1`；而只靠 nvm/asdf/mise 提供 node 的机器，初始化恰恰写在 `.bashrc`/`.zshrc` 里。

`toolchain_prefix()` 里手工补 java、android、pnpm 三条路径，说明这一类事故此前已经发生过两次。**白名单不可能穷举一台机器怎么装东西**，所以修法是换策略，不是再加一条。

## 4. 契约一：清洗，不重建

守护进程的环境以**调用方继承来的环境**为起点，删除下列名字，其余保留：

- 前缀：`ANTHROPIC_`、`CLAUDE_`、`CLAUDE_CODE_`、`CURSOR_`、`MIRAGE_`、`SSH_`、`RIFFET_RESTART_`
- 精确名：`TMUX`、`TMUX_PANE`、`OLDPWD`、`SHLVL`、`_`、`PROMPT_COMMAND`、`RIFFET_RESTART_DETACHED`

身份类变量由我们自己声明，不继承调用方：`HOME`、`USER`、`LOGNAME`、`SHELL`、`TERM`、`LANG`。

**为什么不用 `*_API_KEY` 这类通配**：`DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` 是服务端自己的合法配置，`runtimeSettings()` 会读它们；一刀切会把正常配置删掉。清单只覆盖真正会泄漏的那批——即**agent 运行时导出、并被 restart 继承**的那些。

**为什么黑名单而不是白名单**：白名单漏掉一个目录就重演 §3；黑名单漏掉一个名字最多是多带一个变量。风险方向不同。

扩展方式：

| 变量 | 作用 |
|---|---|
| `RIFFET_ENV_DROP` | 追加要删除的名字或前缀（逗号或空格分隔） |
| `RIFFET_ENV_KEEP` | 豁免某个名字，例如 `CURSOR_CONFIG_DIR` |

同一份清单被三处共用，避免漂移：`environment.ts` 的 `LEAKED_*`、restart 脚本的 `LEAKED_*`，以及重启后的 `check_env_clean`（Linux 上读 `/proc/<pid>/environ` 复核）。

## 5. 契约二：PATH 与 node 的解析顺序

`resolveEnvironmentPath()` 按优先级取**第一个可用**的来源：

| 优先级 | 来源 | 说明 |
|---|---|---|
| 1 | `RIFFET_PATH` | 显式覆盖。systemd / docker / CI 里没有登录 shell，这是唯一确定答案。restart 脚本采集成功时也会把它钉住。 |
| 2 | 用户登录 shell 现采 | `"$SHELL" -ilc` → 失败再 `-lc`，**5 秒超时**，用标记包裹取值，见下。 |
| 3 | 上次成功采集的缓存 | `$STATE_DIR/environment.json`（0600）。开机早于登录、容器、cron 都走这条。 |
| 4 | 继承来的 `PATH` | 调用方给的，可用就用。 |
| 5 | 平台默认 | `/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin` + homebrew / linuxbrew / snap / nix-profile / `~/.local/bin`。 |

随后**无条件追加**（去重、保序）：`JAVA_HOME/bin`、`ANDROID_HOME|ANDROID_SDK_ROOT` 的 `platform-tools` 与 `tools`、`PNPM_HOME/bin`、`RIFFET_PATH_EXTRA`、`~/.local/bin`，以及**运行中 node 自己的目录**（`dirname(process.execPath)`、`<prefix>/bin`；Windows 另有 `<prefix>` 与 `<prefix>/node_modules/.bin`）。

采集为什么用 `-i`：bash/zsh **只在交互式下**读 `~/.bashrc` / `~/.zshrc`，而 nvm、asdf、mise、pnpm、自定义 npm prefix 通常都写在那里；`-lc` 只是更便宜的第二选择。为什么用标记（`__RIFFET_PATH_BEGIN__…__RIFFET_PATH_END__`）：交互式启动文件会打印横幅，取值必须只认标记之间。为什么要有"可用性"校验（单行、至少两个真实存在的目录）：`bash -ilc` 可能输出一句问候并返回 0，那不是 PATH。超时用后台看护进程实现，因为 macOS 根本没有 `timeout`。**任何一步失败都不致命**，只降级并在报告里写明原因。

采集成功（或走了显式覆盖）时写缓存；同一份缓存也让 §9 的服务管理器有一个可复用的快照。

**node 的选择属于同一件事**：restart 脚本不再单独探测 node，而是先解析 PATH，再从中取 node，并做一次 `node <ENTRY> --version` 预检——node 版本不匹配或原生模块（`node-pty`）加载不了时，**在停掉旧服务之前**就失败，而不是把服务留在"已停未起"。

## 6. 契约三：后端可执行文件解析

`resolveCliExecutable()` 的顺序：

1. **配置里给了绝对路径**（或 `~` / 相对路径）→ 直接用它。用户已经回答过这个问题，不再二次猜测；文件不存在时仍返回该路径，好让错误信息说的是用户填的那个。
2. **`shell:<函数名>`** → 交给**用户自己的 shell**（`$SHELL`，zsh/bash/fish）；不再是硬编码 `/bin/zsh`（Linux 上常常没有 zsh）。
3. **裸名** → 依次搜：守护进程 `PATH` → 已知安装目录（`~/.local/bin`、`~/.local/bin/node/bin`、`~/.npm-global/bin`、`~/.yarn/bin`、`~/.bun/bin`、`~/.volta/bin`、`~/.asdf/shims`、mise shims、`/usr/local/bin`、`/opt/homebrew/bin`、`/home/linuxbrew/.linuxbrew/bin`、`/snap/bin`、`/usr/bin`、`/bin`）→ **运行中 node 的目录**（全局 npm 包通常就落在那里）。
4. 找不到 → 保留裸名，并把**搜过的目录**一并带出去，用于生成原因文本。

四个后端（`dsh` / `claude` / `codex` / `cursor-agent`）全部走这一条路径，因此"某台机器上只有一个后端挂了"这类不对称结果不再由 PATH 碰运气决定。

## 7. 契约四：终端环境不依赖陈旧的 tmux server

tmux server 会保留它第一次启动时继承的环境，而 riffet 的持久终端跨重启存活——也就是说 tmux server 一旦起来就不再更新。此前终端能看见 `dsh` 纯属运气：它的环境来自更早一次富环境启动。

现在每次 `new-session` 都显式 `-e KEY=value` 注入守护进程的权威环境：`PATH`、`JAVA_HOME`、`ANDROID_HOME`、`ANDROID_SDK_ROOT`、`PNPM_HOME`、`LANG`、`LC_ALL`、`TZ`、`DISPLAY`、`WAYLAND_DISPLAY`、`XDG_RUNTIME_DIR`、`SSH_AUTH_SOCK`。后端自己的变量（如 `CURSOR_CONFIG_DIR`）仍然优先。含换行的值一律不注入（`-e` 参数承载不了）。

## 8. 契约五：可用性说真话，且可诊断

`/api/backends` 曾经把 `available` 写死为 `true`，所以一个 CLI 都找不到的后端在 UI 里仍然是健康的，直到有人真的去开会话。现在它调用各后端自己的 `available()` 探针（30 秒缓存，避免每个打开的页面都去 spawn 一次 CLI），`available: false` 必定带 `reason`。

诊断入口：

- `riffet doctor`：打印环境报告（PATH 来源、补齐的目录、清洗掉的变量、服务化会写进 unit 的变量清单）+ tmux/Tailscale 能力（`--json` 的 `capabilities`）；各 Agent 的 CLI 版本与登录状态是 `checks` 里的行。
- `GET /api/doctor`：同一份环境报告 + 后端列表。需要登录（和其它 API 一样：令牌部署用令牌，免令牌部署先访问 `/api/auth/status` 拿会话 cookie）。
- **restart 脚本把这份报告写进自己的日志**（`PATH 来源`、`node`、`补齐目录数`、`清洗变量`），远端失败只看日志即可定位。

## 9. 各平台与服务管理器

| 场景 | 怎么做 | 环境从哪来 |
|---|---|---|
| 交互终端里 `riffet start` / `riffet restart` | 直接继承调用者环境 | 继承 + 追加 |
| `riffet-restart.sh` | 清洗后采集登录 shell PATH，从中取 node，预检后启动 | 采集（成功则钉 `RIFFET_PATH`） |
| macOS 登录服务 | `riffet install-service` → `~/Library/LaunchAgents/local.riffet.plist` | 安装时快照进 `EnvironmentVariables` |
| Linux 用户服务 | `riffet install-service` → `~/.config/systemd/user/riffet.service` | 安装时快照进 `Environment=` |
| 换了工具链之后 | `riffet install-service --refresh-environment` | 重新快照并 `daemon-reload` + `restart` |
| `systemd` 系统服务 / docker / CI | 前台运行 `riffet serve`，或用 `RIFFET_PATH` / `environment.json` 指定 | 显式配置或缓存 |

Linux 用户服务默认只在该用户登录期间运行；`loginctl enable-linger $USER` 可让它在登出后继续。

`RIFFET_PATH` 一旦设置就**优先于**现采，这是刻意的：服务管理器里没有可采的 shell，显式配置必须能赢。代价是它不会自动跟随新装工具——这正是 `--refresh-environment` 存在的原因。

## 10. 已知限制

- **Windows**：不做登录 shell 采集（`captureRequests()` 返回空），也没有服务化安装；PATH 走显式配置、继承与平台默认。文件查找带 `.cmd/.exe/.bat/.ps1`。
- **fish**：用 `fish -ilc` + `string join : $PATH` 采集；若某台机器的 fish 启动脚本挂死，5 秒超时后退到 `-lc`。
- **`~/.zshrc` 里定义了同名 shell 函数**（例如 `cursor-agent()`）：裸名解析到的是真实二进制；要跑函数请把配置写成 `shell:<函数名>`。
- 清洗 `CURSOR_*` 意味着 `CURSOR_CONFIG_DIR` 不再作为配置来源；需要的话用 `RIFFET_ENV_KEEP=CURSOR_CONFIG_DIR` 豁免。

## 11. 验收

**单元测试**（`pnpm test`）：

- `apps/server/src/environment.test.ts`（24 项）：清洗的保留/删除真值表、`RIFFET_ENV_DROP`/`KEEP`、PATH 合并与可用性判定、标记取值、`-ilc`→`-lc` 回退、超时/非零/垃圾输出都只降级、五级优先级各自命中、缓存读取、追加目录、幂等。
- `apps/server/src/backends/shared/cli-resolve.test.ts`（12 项）：绝对/`~`/相对配置、`shell:`、PATH 优先、安装目录、**node prefix**、找不到时带出搜索路径，以及**裸环境下四个后端全部可解析**（§3 事故的回归用例）。

**集成 smoke**（CI 两个平台都跑，`node --test scripts/environment-smoke.test.mjs`）：以 `PATH=/usr/bin:/bin` 启动真实生产 CLI，断言守护进程起得来、报告出自己解析的 PATH 且其中包含 `~/.local/bin`、四个后端都在列表里、`available: false` 必定带原因。

**实机证据**（2026-10-09，macOS arm64）：

| 检查 | 结果 |
|---|---|
| 裸 PATH（`PATH=/usr/bin:/bin`）启动守护进程 | `/api/doctor` 报 `PATH source: login-shell`，PATH 第三段即 `~/.local/bin/node/bin` |
| 该实例的四个后端 | `cursor/codex/claude/dsh` 全部 `available: true` |
| **dsh 模型目录** | `available: true`，2 个模型（与 profile 的 `enabledModels` 一致） |
| 负向对照：把 profile 的 executable 指向不存在的路径 | `available: false` + `Cannot find "/nonexistent/definitely-not-dsh"…`（旧实现会报 `true`） |
| restart 脚本 `--dry-run` | 采集到登录 shell PATH（33 个目录），解析出的 node 为用户的 v24.19.0 而非 homebrew v26.7.0 |
