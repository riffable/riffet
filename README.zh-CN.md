<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/brand/lockup-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="docs/brand/lockup.svg">
  <img alt="Riffet" src="docs/brand/lockup.svg" height="52">
</picture>

### Keep the riff going.

自托管的 Agent CLI 工作台。

[![CI](https://github.com/riffable/riffet/actions/workflows/ci.yml/badge.svg)](https://github.com/riffable/riffet/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/riffable/riffet)](https://github.com/riffable/riffet/releases)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

[English](README.md) · 简体中文 · [主页](https://riffable.github.io/riffet/) · [插件市场](https://riffable.github.io/riffet/plugins/) · [Releases](https://github.com/riffable/riffet/releases) · [变更记录](CHANGELOG.zh-CN.md)

**8** 款 Agent CLI · **5** 个客户端（`Web`、`macOS`、`iPhone`、`Android`、`飞书`）· **本地**日志 · **插件** SDK

</div>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/hero-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/hero-light.png">
    <img alt="Riffet 网页工作台：五条会话以标签页打开，Agent 给出的设计方案与渲染出的时序图，右侧概览栏列出大纲、子 Agent 和产出文件，旁边是 iPhone 上的同一条会话" src="docs/assets/hero-light.png" width="100%">
  </picture>
</p>

Riffet 是自托管的工作台，用于驱动安装在 macOS 或 Linux 主机上的 Agent CLI。会话留在主机上，可以从任一已连接的客户端发起、阅读、引导和继续：Web 工作台，macOS、iPhone、Android 原生应用，或飞书（Lark）机器人。

- **Agent。** Riffet 驱动官方 CLI（Claude Code、Codex、Cursor、Antigravity、TRAE CLI、Factory Droid、DeepSeek Harness、pi），并就地读取各 CLI 自己的会话存储。各 Agent 支持的能力见[后端能力矩阵](#后端能力矩阵)。
- **数据。** 代码、终端、登录凭证和历史保存在服务端。客户端直连服务端。
- **许可证。** Apache-2.0，全部功能都在开源版本中。

---

## 安装

需要 **macOS 或 Linux**、**Node.js `>= 24.19.0`**、**`tmux >= 3.2`**（Cursor、Claude Code、Antigravity 会话及实时终端视图需要），并在主机上至少安装并登录一款[受支持的 Agent CLI](#后端能力矩阵)。

```bash
npm install -g riffet
riffet doctor                  # 检查 Node、tmux、各 Agent CLI、端口与权限
riffet start --workspace .     # 启动后台服务并添加当前代码库
riffet                         # 在浏览器打开 http://127.0.0.1:4337/
```

通过 npm 安装的实例使用 `riffet update` 升级（或 `npm i -g riffet@latest && riffet restart`）。不要通过 `npx` 运行：Hook 与 MCP 路径需要保持固定。

### 客户端

| 组件 | 获取方式 | 说明 |
| :--- | :--- | :--- |
| 服务端与 Web 工作台 | `npm install -g riffet` | 默认监听 `127.0.0.1:4337`，支持安装为 PWA |
| macOS 应用 | [GitHub Releases 下载 `Riffet.dmg`](https://github.com/riffable/riffet/releases) *（即将发布）* | macOS 15+，Apple Silicon；内置服务端运行时 |
| Android 应用 | [GitHub Releases 下载 `APK`](https://github.com/riffable/riffet/releases) | 扫描二维码，或输入地址与一次性配对码 |
| iPhone 应用 | 源码构建（`apps/mobile/iosApp`） | iOS 18+，使用自己的 Apple 团队 ID 签名（见[构建说明](apps/mobile/iosApp/README.md)） |
| 飞书 / Lark 机器人 | 服务端内置 | 在「设置 → 功能 → 机器人」连接（出站 WebSocket，无需公网 IP） |

### 连接其他设备

服务端默认只监听 `127.0.0.1`。需要经局域网、Tailscale / VPN 或 HTTPS 代理从其他设备访问时：

```bash
riffet restart --host 0.0.0.0 --auth
riffet pair                    # 打印可达地址、5 分钟有效的一次性配对码与二维码
```

iPhone 与 Android 应用扫描二维码，远端浏览器或 Mac 应用输入配对码。`--allow-host` 与用于隧道的 `riffet pair --url` 见[远程访问](docs/guide/remote-access.md)。

<details>
<summary><strong>从源码构建</strong></summary>

除 Node.js `>= 24.19.0` 外还需 `pnpm`：

```bash
git clone https://github.com/riffable/riffet.git ~/.local/src/riffet
cd ~/.local/src/riffet
pnpm install && pnpm build

mkdir -p "$HOME/.local/bin"
ln -s "$HOME/.local/src/riffet/scripts/riffet.mjs" "$HOME/.local/bin/riffet"
```

</details>

<details>
<summary><strong>CLI 命令、补全与默认值</strong></summary>

```bash
riffet                 # 启动后台服务（若未运行）并打开浏览器
riffet status          # 查看运行状态、监听地址、数据目录与可用更新
riffet pair            # 生成 5 分钟有效的一次性配对码与二维码（隧道可加 --url）
riffet stop            # 关闭 Web 服务；tmux 中的 Agent 终端继续运行
riffet restart         # 按已保存的监听与认证参数重启
riffet logs -f         # 持续查看服务日志，令牌已脱敏（支持 --since、--scope）
riffet token           # 向标准输出打印访问令牌（如 riffet token | pbcopy）
riffet url --login     # 输出一步登录链接
riffet ls              # 列出会话，当前目录所属项目在前（-a 列出全部）
riffet resume          # 在当前终端继续一个会话（可搜索的选择器）
riffet doctor          # 检查运行环境（--json 输出报告，--compact 压缩 workbench.db）
riffet service install # 登录时自动启动（launchd / systemd），另有 status、uninstall
riffet completion zsh  # zsh、bash、fish 的命令补全
riffet update --check  # 检查是否有更新的稳定版本
riffet update          # 升级 npm 安装或更新干净的发布 tag 源码目录并恢复服务
riffet restore         # 将已校验的备份恢复到空数据目录（--backup）
riffet plugin --help   # 开发、打包、安装、管理插件源与诊断插件
```

默认值：地址 `http://127.0.0.1:4337/`，默认后端 `cursor-agent`，私有数据目录 `~/.local/share/riffet`（目录权限 `0700`，密钥文件 `0600`），回环地址无需令牌。覆盖项：`--port`、`--host`、`--cli`、`--state-dir`、`--workspace`、`--allow-host`；前四项同时读取 `RIFFET_PORT`、`RIFFET_HOST`、`RIFFET_CLI`、`RIFFET_STATE_DIR`。

</details>

---

## 后端能力矩阵

| 后端 | CLI | 结构化对话 | 实时 TUI 终端 | 运行中引导 (Steer) | 子 Agent 详情页 | Riffet MCP / 自唤醒 | 按对话开关 MCP / Skill | @ 会话引用 | 终端导入 / 交还 |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Cursor** | `cursor-agent` | ✓ | ✓（`tmux`） | ✓ | ✓ | — | — | — | — |
| **Claude Code** | `claude` | ✓ | ✓（`tmux`） | ✓ | ✓ | ✓ | MCP + Skills | ✓ | ✓ |
| **Codex** | `codex` | ✓ | ✓（`--remote`） | ✓ | ✓ | ✓ | MCP | ✓ | ✓ |
| **Antigravity** | `agy`（`1.5.6+`） | ✓ | ✓（`tmux`） | — | ✓ | ✓ | — | ✓ | — |
| **TRAE CLI** | `traex` | ✓ | ✓（原生） | ✓ | ✓ | ✓ | MCP | — | — |
| **DeepSeek Harness** | `dsh`（`0.2.0-rc.2+`） | ✓ | — | — | ✓ | — | — | — | — |
| **Factory Droid** | `droid` | ✓ | — | — | ✓ | ✓ | — | — | — |
| **pi** | `pi`（`1.4.0+`） | ✓ | — | — | — | ✓ | — | — | — |

CLI 路径通过环境变量 `RIFFET_CLI`、`CLAUDE_CLI`、`CODEX_CLI`、`DSH_CLI`、`DROID_CLI`、`TRAEX_CLI`、`PI_CLI` 指定，或在「设置 → 模型」中按配置指定（含 `agy`）。其他后端、模型源、视图和主题以插件包的形式添加，使用 [`@riffet/plugin-api`](docs/PLUGINS.md) 开发。

---

## 工作台与核心流程

### 01 · 配对与多端同步

服务端运行在 Mac、Linux 机器或云服务器上，可手动启动、注册为 `launchd` / `systemd` 服务，或由 macOS 应用内置运行。手机扫码完成配对（`riffet pair`），浏览器与 Mac 应用输入一次性配对码，原生应用可保存多台服务器并随时切换。各端共享同一份会话转录与未读状态，服务重启后进行中的回合保持运行。

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/reel-connect-dark.gif">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/reel-connect-light.gif">
    <img alt="手机扫描桌面上的配对码，随后同一段回答在桌面和 iPhone 上同时输出，最后 Mac、iPhone 与 Android 应用并排" src="docs/assets/reel-connect-light.gif" width="100%">
  </picture>
</p>

### 02 · 会话、运行中引导与并行尝试

- **沿用官方 CLI 环境。** 每条会话各自选择 Agent 和模型，CLI 原有的登录、Rules、Skills、MCP 和订阅保持原样生效。空闲 CLI 按最近使用时间和可设置的内存上限回收。
- **终端会话导入与交还。** 在终端中开始的 Claude Code 或 Codex 会话可导入 Riffet 继续，并通过「在终端恢复」或 `riffet resume` 交还终端。同一时刻只有一方写入，转录不会交错。
- **并行尝试。** 同一条提示词可同时发给 2–4 个 Agent 或模型，每一路运行在独立的 Git worktree 中（非 Git 目录使用影子仓库），改动并排比较后采用其中一路。*（Web、macOS）*
- **运行中引导。** Agent 执行期间可随时追加指令而无需 `Ctrl+C`，也可排入下一轮。
- **侧边线程与快速对话。** 选中回答中的一段可在侧边线程讨论，不进入主时间线 *（Web）*。不属于任何项目的问题直接发给模型，支持联网搜索和附件（macOS 为 `⌃⌥Space`，Android 为快捷开关、分享菜单或选中文字）。*（Web、macOS、iPhone、Android）*

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/reel-start-dark.gif">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/reel-start-light.gif">
    <img alt="输入需求并选择 Agent，并行尝试逐个加入，可继续的终端会话列表，以及模型选择器" src="docs/assets/reel-start-light.gif" width="100%">
  </picture>
</p>

### 03 · 个人助理、任务看板与自动化

- **个人助理。** 跨项目常驻的个人助理，拥有独立页面、记忆（`USER.md` 与主题笔记）、规则、能力包与后台跟进委托（`/new` 重新开始）。运行在隔离的 Claude Code 或 Codex 上，不读取也不改动你的项目配置。*（Web、macOS、iPhone、Android、飞书私聊）*
- **任务看板。** 会话可归属到任务，支持一句话新建任务、可选完成标准与状态流转；收件箱只呈现需要人工审批、提问或验收的事项。*（Web、macOS、iPhone、Android）*
- **自动化。** 提示词可手动或按 cron 定时运行并保留最近 50 次记录，Agent 也可为自己安排定时唤醒。

### 04 · 时间线、托管浏览器、文件与 Git

- **时间线与划选工具栏。** 工具调用折叠为一行，修改展开为 Diff，子 Agent 拥有独立转录，任务目标在各端同步显示。Mermaid、D2、Graphviz、PlantUML、Vega-Lite 与 KaTeX 在本地渲染，代码高亮主题可选择和自定义。在回答或旁白中选中文字会弹出工具栏：引用到输入框、侧边聊天、悬停选色高亮、导出图片以及翻译等插件命令。
- **多视图与查找。** 会话可在时间线、实时终端与按回合铺开命令与文件的画布间切换 *（画布：Web、macOS）*。`⌘K` 全局搜索，会话内支持原地查找。
- **Riffet 浏览器。** 内置浏览器插件（`riffet.browser`）通过 `playwright-core` 驱动无头 Chromium，在侧边面板实时推流画面并支持人与 Agent 共同操作，遇到登录或付款时交由用户接手。*（Web、macOS）*
- **文件预览与 Git。** 本地预览 20 多种文件类型（沙箱 HTML、PDF、Office 文档、Jupyter Notebook、SQLite、3D 模型等）。Git 面板支持历史、按行暂存、提交、切分支、拉取推送、经 `gh` 创建 PR、每轮检查点回退或分叉，以及将 Diff 行批注发回给 Agent *（Web、macOS、iPhone、Android）*。

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/reel-session-dark.gif">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/reel-session-light.gif">
    <img alt="回答连同时序图逐行输出，视图翻到画布，搜索 redis，高亮一句话并在收藏里找到它，以及分享菜单" src="docs/assets/reel-session-light.gif" width="100%">
  </picture>
</p>

### 05 · 模型、引用、交接与导出

- **模型源与额度。** 通过接口地址、密钥与协议（OpenAI Chat Completions / Responses、Anthropic Messages、Google Generative AI）或模型源插件添加提供方。模型选择器显示 Codex 与模型源的剩余额度，会话实时显示上下文窗口占用。标题、快速对话、交接摘要、画布摘要及插件声明用途可分别指定辅助模型。
- **切换与交接。** 同系列模型或模型源可原地切换并继续；跨系列或额度耗尽时，连同结构化摘要交接给另一个 Agent。
- **引用、收藏与导出。** `@` 通过只读转录快照引用之前的会话 *（Claude Code、Codex、Antigravity）*。收藏可将高亮片段、整条回答、图片和文件保存为独立快照，原会话删除后仍可阅读 *（Web、macOS）*。任一会话可导出为 PDF，或经分享插件发布为带有效期的只读链接 *（Web、macOS）*。

### 06 · 插件与外观

- **插件。** 内置插件（`cursor`、`antigravity`、`canvas`、`browser`、`avatars`、`translate`）在服务进程内运行，安装的插件包默认在隔离进程中运行（见[插件架构](docs/PLUGIN_ARCHITECTURE.md)）。插件可提供 Agent 后端 *（实验性）*、模型源、工作台视图、项目任务、消息与选区菜单命令、分享发布、配色、图标包与字体。支持添加多个插件源并锁定安装来源，公开包索引见[插件市场](https://riffable.github.io/riffet/plugins/)。

```bash
riffet plugin dev ./my-plugin
riffet plugin pack ./my-plugin --out my-plugin.tgz
riffet plugin install my-plugin.tgz
```

- **标签页、概览栏与主题。** 会话以标签页保持打开，旁侧概览栏显示计划、大纲、子 Agent、后台任务和产出文件 *（标签页：Web，以及 macOS 的 Riffet 风格）*。内置 12 套配色与实时主题编辑器，支持替换图标包与各端界面风格（macOS：原生、Riffet、线条；Android：Material 3、iOS、Expressive、Miuix、Fluent）。

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/reel-shape-dark.gif">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/reel-shape-light.gif">
    <img alt="在主题面板上拖动色点，后面的页面随之换色，从浅色擦到深色，插件列表，以及用插件构建 Android 应用" src="docs/assets/reel-shape-light.gif" width="100%">
  </picture>
</p>

---

## 客户端

- **Web。** 由 Riffet 服务端提供的完整工作台，支持桌面标签页、移动端自适应布局与 PWA 安装。
- **macOS。** SwiftUI + AppKit 原生应用，内置服务端，支持原生会话画布、菜单栏常驻状态与审批、快捷指令、小组件与聚焦搜索。
- **iPhone。** 基于共享客户端核心构建的原生 SwiftUI 应用，支持推送通知、Diff、远端目录浏览、Git 面板与终端。
- **Android。** Kotlin Multiplatform + Compose 应用，支持五种界面风格、触控终端、Git 面板与系统入口快速对话。预览功能：Agent 可在会话开关与设备生物识别双重确认下读取并操作已配对手机。
- **飞书 / Lark。** 服务端建立出站 WebSocket 连接，不需要公网 IP、域名或内网穿透。支持在私聊或群话题中新建/继续项目会话、处理审批，以及在私聊中使用个人助理。

---

## 架构

Riffet 是单节点服务，位于客户端与同一主机上已安装的 agent CLI 之间。命令沿一条路径送达 agent；agent 的输出沿另一条路径返回，折叠成各客户端一致的行。

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/architecture/system-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/architecture/system-light.svg">
    <img alt="Riffet system architecture: clients, the server's Access, Session core (Delivery, Journal, Timeline, Sync) and Agent integration subsystems with Automation, Workspace, Derived views, Extension and Platform around them, and the agent CLI below; commands flow down, events and rows flow up" src="docs/assets/architecture/system-light.svg" width="100%">
  </picture>
</p>

设计原则：

1. **厂商 CLI 即 agent。** Riffet 通过 CLI 自身的接口驱动已安装的程序，不重新实现。
2. **单一会话模型。** agent 之间的差异止于驱动契约，契约之上不出现厂商名。
3. **命令与观测分离。** 消息以观测到回执为送达，不以写入为准。
4. **Journal 是唯一事实来源。** 时间线、状态、用量与搜索都是它的投影。
5. **服务端折叠，客户端渲染。** 客户端从游标续传，得到同一份行。
6. **单节点。** 一个进程、一个数据库文件、一个用户，不依赖外部服务。
7. **依赖向内。** 表面与驱动依赖核心，反向不成立；可选能力以插件提供。

| 子系统 | 职责 | 代码 |
| :--- | :--- | :--- |
| Clients | 渲染行，保存行的副本与缓存，发送命令 | `apps/web`、`apps/mobile`、`apps/macos` |
| Access | 设备鉴权，终结 HTTP、SSE、WebSocket，适配聊天通道 | `apps/server/src/auth.ts`、`apps/server/src/routes`、`apps/server/src/channels` |
| Session core：Delivery | 消息排队，一次放行一个回合，至多写入一次，跟踪到回执 | `apps/server/src/native` |
| Session core：Journal | 只追加的事件日志，按会话有序 | `apps/server/src/journal` |
| Session core：Timeline | 把事件折叠成客户端渲染的行 | `apps/server/src/timeline`、`packages/timeline` |
| Session core：Sync | 按各客户端的游标推送行 | `apps/server/src/sync` |
| Agent integration | 每个 agent 一个驱动，共用一份契约；终端宿主、hook 桥、工具桥 | `apps/server/src/backends`、`apps/server/src/terminal`、`apps/server/src/riffet-mcp` |
| Automation & Assistant | 个人助理、任务看板、定时自动化与交接 | `apps/server/src/assistant`、`apps/server/src/work-items`、`apps/server/src/orchestration`、`apps/server/src/tasks` |
| Workspace | agent 工作目录的文件、git 与工作树 | `apps/server/src/workspace`、`apps/server/src/git` |
| Derived views | 由 journal 派生的读模型：用量、搜索索引、标题、分享 | `apps/server/src/stats`、`apps/server/src/search`、`apps/server/src/shares` |
| Extension | 在声明的扩展点加载插件；安装包默认隔离运行 | `apps/server/src/plugins-host`、`packages/plugin-api` |
| Platform | SQLite 存储、设置、进程执行、服务生命周期 | `apps/server/src/store.ts`、`apps/server/src/exec.ts` |

各子系统、导入分层与运行时拓扑（进程、文件、接口）各有一张图，见 [docs/guide/architecture.md](docs/guide/architecture.md)。

---

## 开发

```bash
pnpm dev               # API 服务（:4317）
pnpm dev:web           # Vite Web 工作台（:5173）
pnpm typecheck
pnpm test
pnpm check:plugins
pnpm build
```

原生客户端位于 `apps/macos` 与 `apps/mobile`：

```bash
# 共享 Kotlin Multiplatform 与 Android JVM 测试（需 JDK 21+ 与 Android SDK）
cd apps/mobile
./gradlew :contracts:jvmTest :core:jvmTest :terminal:jvmTest :client:jvmTest :shared:jvmTest

# macOS 原生客户端（需 macOS 15+、Xcode 26、JDK 17+ 与 XcodeGen）
cd apps/macos
./scripts/build.sh dev        # 构建、安装到 build/Release 并重启应用
./scripts/release.sh          # 构建签名与公证后的 DMG
```

自动化测试遵循[仓库协作规范](AGENTS.md#测试与验证)：非必要不增加测试，只覆盖鉴权与数据隔离、外部协议契约、幂等、持久化、并发一致性与故障恢复，不维护 UI 展示、样式或简单格式化测试。提交 PR 前的完整检查与 npm 打包步骤见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 文档索引

- **使用指南**：[对话、模型与会话](docs/guide/conversation.md) · [Cursor 原生会话与自定义网关](docs/guide/cursor.md) · [工作区、多格式预览与 Git](docs/guide/workspace.md) · [远程访问](docs/guide/remote-access.md) · [运行、部署与维护](docs/guide/operations.md) · [代码结构与前端约定](docs/guide/architecture.md) · [版本、发布与分发](docs/RELEASE.md)
- **核心工作流**：[个人助理](docs/ASSISTANT.md) · [任务看板](docs/TASK-BOARD.md) · [审阅发布与会话编排](docs/ORCHESTRATION.md) · [运行中会话引导](docs/STEER.md) · [侧边聊天](docs/DISCUSSIONS.md) · [快速对话](docs/QUICK-CHAT.md) · [高亮与收藏](docs/MARKS.md) · [会话分享与 PDF 导出](docs/SHARES.md) · [用量与吞吐统计](docs/STATS.md)
- **多端与通道**：[设计体系](docs/design/system/README.md) · [Web 设计契约](docs/WEB.md) · [macOS 客户端](docs/MACOS.md) · [Android 与移动端](docs/MOBILE.md) · [iPhone 客户端](docs/IOS.md) · [移动端终端](docs/MOBILE-TERMINAL.md) · [飞书 / IM 通道](docs/design/channels.md) · [Riffet 浏览器](docs/BROWSER.md) · [设备操控与 Riffet MCP](docs/DEVICES.md) · [主题系统](docs/THEMES.md)
- **扩展与运维**：[扩展管理](docs/EXTENSIONS.md) · [插件开发指南](docs/PLUGINS.md) · [插件架构](docs/PLUGIN_ARCHITECTURE.md) · [Antigravity CLI](docs/ANTIGRAVITY.md) · [TRAE CLI](docs/TRAEX.md) · [pi RPC](docs/PI.md) · [更新机制](docs/UPDATE.md) · [安全模型](docs/SECURITY.md)

## 致谢与许可证

前端视觉参考了 [ZCode](https://github.com/zai-org/ZCode) 与 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)；DSH 后端桥接复用了 DeepSeek Harness 以 MIT 许可发布的原生接口，上游声明随桥接代码保留。

本项目基于 [Apache-2.0](LICENSE) 许可证开源，第三方归属声明见 [NOTICE](NOTICE)，安全漏洞请按 [SECURITY.md](SECURITY.md) 私密上报。
