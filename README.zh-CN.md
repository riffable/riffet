<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/brand/lockup-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="docs/brand/lockup.svg">
  <img alt="Riffet" src="docs/brand/lockup.svg" height="52">
</picture>

### Keep the riff going.

自托管的编码 Agent 工作台：过程读得懂，中途插得上话，换块屏幕接着做。

[![CI](https://github.com/riffable/riffet/actions/workflows/ci.yml/badge.svg)](https://github.com/riffable/riffet/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/riffable/riffet)](https://github.com/riffable/riffet/releases)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

[English](README.md) · 简体中文 · [Releases](https://github.com/riffable/riffet/releases) · [Issues](https://github.com/riffable/riffet/issues) · [Discussions](https://github.com/riffable/riffet/discussions) · [变更记录](CHANGELOG.md)

</div>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/hero-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/hero-light.png">
    <img alt="Riffet 网页工作台：Agent 给出的设计方案与渲染出的时序图，旁边是 iPhone 上的同一条会话" src="docs/assets/hero-light.png" width="100%">
  </picture>
</p>

Riff 是乐手之间来回接的一小段乐句：一个人起头，下一个人接下去。Riffet 让和编码 Agent 的协作保持这个样子：每条会话都是留在你自己机器上的工作区，过程读得懂，中途插得上话，之后从浏览器、macOS / iPhone / Android 原生应用或飞书（Lark）机器人接着做。

把 `riffet` 跑在你的 Mac、开发机或无界面的 Linux 服务器上。它驱动的是你已经在用、已经付费的 Agent CLI；代码、终端、登录凭证和历史都留在这台机器里。

一个终端标签页只能跑一个 CLI、守一个分支，合上电脑就够不着了；云端的 Agent 平台则要你迁走代码库、再付一份订阅，或者放弃本机配好的工具。Riffet 两样都不要：Apache-2.0 开源，不经云端中继，没有付费功能。

## 40 秒看一遍

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/demo-dark.gif">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/demo-light.gif">
    <img alt="演示：阅读带时序图的设计方案，展开工具调用和内联 Diff，再在变更上写一条行内批注" src="docs/assets/demo-light.gif" width="100%">
  </picture>
</p>

<!-- 可以用更清晰的 .mp4 替换这张 GIF：把视频拖进任意 GitHub Issue / PR 的编辑框，再把得到的 https://github.com/user-attachments/assets/<uuid> 链接单独放一行。 -->

## 能做什么

### 读得懂

- **能读的时间线。** 连续的工具调用折叠成一行，每次修改都能展开成 Diff，子 Agent 有独立的转录页。Mermaid、D2、Graphviz、PlantUML、Vega-Lite 图表在本地渲染，另有 KaTeX 公式和 45 种语言的语法高亮。
- **整条会话一张图。** 画布把每一轮的提问、回答、执行的命令和写入的文件排在一起，分叉并列显示。*（Web）*
- **文件就地打开。** 20 多种文件格式在本地预览，包括 PDF、Office 文档、Jupyter Notebook、SQLite、3D 模型和压缩包。
- **高亮与收藏。** 高亮片段、收藏图片或文件都各自保存快照，原会话删除后仍然可读。
- **随时切回真终端。** 后端带 TUI 时，可以在结构化对话和背后的终端之间切换。关掉网页或合上笔记本，会话在主机上继续运行。

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/timeline-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/timeline-light.png">
    <img alt="展开工具调用的一个回合：一个子 Agent、四次文件修改及行数，其中一次修改的 Diff 直接显示在对话里" src="docs/assets/timeline-light.png" width="100%">
  </picture>
</p>

### 插得上话

- **运行中引导。** Agent 正在执行时可以直接补充要求，不用 `Ctrl+C`，已完成的工具调用也不会丢；也可以排到下一轮。
- **侧边聊天。** 选中回答里的一段，在侧边线程里追问。它带着这条会话的上下文，但不进主时间线；有结论后再带回输入框。
- **@ 另一条会话。** 输入 `@` 引用之前的对话：Agent 拿到一份简短导读和可继续读取的原文快照，被引用的会话不受影响。
- **对着 Diff 写批注。** 在任意变更里点行号，写下要改的地方，批注会一并发回给 Agent。

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/review-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/review-light.png">
    <img alt="src/server.ts 的 Diff，第 11 行上正在写一条审阅批注" src="docs/assets/review-light.png" width="86%">
  </picture>
</p>

### 换块屏幕接着做

- **macOS**：原生应用，内置服务端运行时，打开即可使用、无需配对；常驻菜单栏，`⌃⌥Space` 在任何地方发起快速提问。
- **iPhone** 与 **Android**：扫码配对，可在多台服务器间切换；批权限、看 Diff、浏览远端目录，或打开触控终端。
- **飞书 / Lark 机器人**：由服务端主动建立出站 WebSocket 连接，不需要公网 IP、域名或内网穿透。在私聊或群话题里新建、续聊项目会话，进度卡片实时更新，审批直接在聊天里点。
- **终端**：在终端里开始的会话可以导入 Riffet 继续，`riffet resume` 再把它交还终端。同一时刻只有一方写入，记录不会交错。
- **快速对话**：不属于任何项目的问题可以直接问，支持联网搜索和附件。

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/mac-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/mac-light.png">
    <img alt="macOS 原生应用中的同一条会话" src="docs/assets/mac-light.png" width="100%">
  </picture>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/devices-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/devices-light.png">
    <img alt="iPhone 与 Android 上的会话列表和对话页" src="docs/assets/devices-light.png" width="100%">
  </picture>
</p>

### 回退、分叉、发布

- **检查点与分叉。** 每一轮自动建立检查点，可以恢复到任意一个，或从任意回合分叉出新会话。
- **并行尝试。** 同一条需求同时发给 2–4 个后端或模型，每一路跑在自己的 Git worktree 里（非 Git 目录用影子仓库），并排比较改动后采用其中一路。
- **交接。** 额度用完或想换个模型看看时，把空闲的会话连同结构化摘要交给另一个后端。
- **提 PR。** 推送分支、创建 GitHub PR、查看 CI 都通过本机的 `gh` 完成。

### 把手机交给 Agent 用 *（Android 预览）*

运行在服务器上的 Agent 可以读取已配对 Android 手机的屏幕、在上面点击和输入、给你发通知，或者给自己的会话定一次性的唤醒（“20 分钟后再检查一次部署”）。这需要两道开关同时打开：会话里的开关，以及手机上的生物识别确认。

## 它不做什么

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/architecture-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/architecture.svg">
    <img alt="左侧的客户端（Web、macOS、iPhone、Android 和飞书 / Lark 机器人）连接到运行在你自己机器上的 Riffet 服务端，由它驱动本机安装的 Agent CLI 操作你的代码仓库" src="docs/assets/architecture.svg" width="100%">
  </picture>
</p>

- **不自带 Agent。** Riffet 没有自己的 Agent 和模型。它驱动官方 CLI，就地读取它们各自的会话存储，CLI 的登录、Rules、Skills、MCP 和订阅照常生效。
- **不是编辑器。** 代码仍在你自己的 IDE 里改；Riffet 负责阅读、审阅和引导。
- **不设云端。** 跑在你自己的 Mac 或远端服务器上。没有账号，不经中继，客户端直连，不运行 Agent 也不保存代码。默认只监听本机回环地址；其他设备通过局域网、VPN 或 HTTPS 代理访问。

目前接入了 Claude Code、Codex、Cursor、TRAE CLI、Factory Droid、DeepSeek Harness 和 pi，还在继续增加。各自支持的能力见[后端能力矩阵](#后端能力矩阵)。

---

## 快速上手

### 环境要求

- **macOS 或 Linux**，已安装 **Node.js `>= 24.19.0`**（从源码构建还需 `pnpm`）。
- **`tmux >= 3.2`**（Cursor / Claude Code 会话与实时终端视图需要）。
- 本机至少安装并登录一款[受支持的 Agent CLI](#后端能力矩阵)。

### 1. 安装 Riffet

<!-- TODO(release): npm 包与 GitHub Releases 客户端产物正式发布后，更新下方预留说明与直链。 -->

**方式 A — 从源码构建（当前立即可用）**

```bash
git clone https://github.com/riffable/riffet.git ~/.local/src/riffet
cd ~/.local/src/riffet
pnpm install && pnpm build

mkdir -p "$HOME/.local/bin"
ln -s "$HOME/.local/src/riffet/scripts/riffet.mjs" "$HOME/.local/bin/riffet"
```

**方式 B — npm 与预构建原生客户端 *（发布渠道预留）***

| 平台 | 获取方式 | 说明 |
| :--- | :--- | :--- |
| Server + Web CLI | `npm install -g riffet` *（即将发布）* | 升级运行 `npm i -g riffet@latest && riffet restart`（请勿用 `npx`，以免缓存清理导致 Hook/MCP 路径失效） |
| macOS 客户端 | [GitHub Releases 下载 `Riffet.dmg`](https://github.com/riffable/riffet/releases) *（即将发布）* | 支持 macOS 15+（Apple Silicon），内置服务端运行时，开箱即用 |
| Android 客户端 | [GitHub Releases 下载 `APK`](https://github.com/riffable/riffet/releases) *（即将发布）* | 扫码或输入地址 + 一次性配对码连接任意服务器 |
| iPhone 客户端 | 源码签名构建（`apps/mobile/iosApp`） | 支持 iOS 18+，使用个人或团队证书编译安装（见 [构建说明](apps/mobile/iosApp/README.md)） |

### 2. 检查环境并启动

```bash
riffet doctor                  # 输出 Node、tmux、各 Agent CLI、端口与权限的 ✅ / ⚠️ / ❌ 检查清单
riffet start --workspace .     # 启动后台服务并添加当前代码库
riffet                         # 在浏览器打开 http://127.0.0.1:4337/
```

### 3. 连接手机、其他电脑或飞书

服务默认仅监听本机 `127.0.0.1`。需要从局域网、Tailscale / VPN 或反向代理接入其他设备时，在服务器上执行：

```bash
riffet restart --host 0.0.0.0 --auth
riffet pair                    # 打印可达地址、5 分钟有效的一次性配对码与二维码
```

打开 iPhone / Android 客户端扫码，或在远端浏览器与 Mac App 输入配对码即可接入；飞书机器人在 Web「设置 → 机器人」中扫码创建即可连通（无需公网回调地址）。跨网域名与隧道配对见 [远程访问指南](docs/guide/remote-access.md)。

<details>
<summary><strong>展开查看常用 CLI 命令与默认配置</strong></summary>

```bash
riffet                 # 启动后台服务（若未运行）并打开浏览器
riffet status          # 查看运行状态、监听地址与数据目录
riffet pair            # 生成 5 分钟有效的一次性配对码与二维码（隧道可加 --url）
riffet stop            # 关闭 Web 服务；tmux 中的原生 Agent 终端继续保留
riffet restart         # 按上次保存的监听与认证参数重启
riffet logs -f         # 持续查看服务日志（URL 中的令牌自动脱敏）
riffet token           # 仅向标准输出打印管理员令牌（如 riffet token | pbcopy）
riffet login-url       # 输出带令牌的一步登录链接
riffet doctor          # 逐项检查运行环境（--json 输出完整机器可读报告）
riffet update --check  # 检查 origin 是否有更新的 vX.Y.Z 发布 tag
riffet update          # 更新干净的发布 tag 源码目录并按原配置恢复服务
riffet plugin --help   # 开发、打包、安装与诊断插件
```

默认值：地址 `http://127.0.0.1:4337/`，默认后端 `cursor-agent`，私有数据目录 `~/.local/share/riffet`（目录权限 `0700`、密钥文件 `0600`），回环地址免令牌访问。可通过 `--port`、`--host`、`--cli`、`--state-dir`、`--workspace`、`--allow-host` 覆盖，前四项同时支持 `RIFFET_PORT`、`RIFFET_HOST`、`RIFFET_CLI`、`RIFFET_STATE_DIR` 环境变量。

</details>

---

## 后端能力矩阵

| 后端 | CLI | 结构化对话 | 实时 TUI 终端 | 运行中引导 (Steer) | 子 Agent 详情页 | Riffet MCP / 自唤醒 | 按对话开关 MCP / Skill | @ 会话引用 | 终端导入 / 交还 |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| Cursor | `cursor-agent` | ✓ | ✓（`tmux`） | ✓ | ✓ | — | — | — | — |
| Claude Code | `claude` | ✓ | ✓（`tmux`） | ✓ | ✓ | ✓ | MCP + Skills | ✓ | ✓ |
| Codex | `codex` | ✓ | ✓（`--remote`） | ✓ | ✓ | ✓ | MCP | ✓ | ✓ |
| DeepSeek Harness | `dsh`（`0.2.0-rc.2+`） | ✓ | — | — | ✓ | — | — | — | — |
| Factory Droid | `droid` | ✓ | — | — | ✓ | ✓ | — | — | — |
| TRAE CLI | `traex` | ✓ | ✓（原生） | ✓ | ✓ | ✓ | MCP | — | — |
| pi | `pi`（`1.4.0+`） | ✓ | — | — | — | ✓ | — | — | — |

> 可通过环境变量（`RIFFET_CLI`、`CLAUDE_CLI`、`CODEX_CLI`、`DROID_CLI`、`TRAEX_CLI`、`PI_CLI`）或「设置 → 模型设置」按配置指定 CLI 路径。需要接入自建模型源、自定义工作台视图或配色主题时，可使用 [`@riffet/plugin-api`](docs/PLUGINS.md) 开发独立插件包。

---

## 本地开发与客户端构建

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

自动化测试遵循 [仓库协作规范](AGENTS.md#测试与验证)：非必要不增加测试，只覆盖鉴权与数据隔离、外部协议契约、幂等、持久化、并发一致性与故障恢复，不维护 UI 展示、样式或简单格式化测试。提交 PR 前的完整检查与 npm 打包步骤见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 文档索引

- **使用指南**：[对话、模型与会话](docs/guide/conversation.md) · [Cursor 原生会话与自定义网关](docs/guide/cursor.md) · [工作区、多格式预览与 Git](docs/guide/workspace.md) · [远程访问](docs/guide/remote-access.md) · [运行、部署与维护](docs/guide/operations.md) · [代码结构与前端约定](docs/guide/architecture.md)
- **核心工作流**：[审阅发布与会话编排](docs/ORCHESTRATION.md) · [运行中会话引导](docs/STEER.md) · [侧边聊天](docs/DISCUSSIONS.md) · [快速对话](docs/QUICK-CHAT.md) · [高亮与收藏](docs/MARKS.md) · [会话分享与 PDF 导出](docs/SHARES.md) · [用量与吞吐统计](docs/STATS.md)
- **多端与通道**：[Web 设计契约](docs/WEB.md) · [macOS 客户端](docs/MACOS.md) · [Android 与移动端](docs/MOBILE.md) · [iPhone 客户端](docs/IOS.md) · [移动端终端](docs/MOBILE-TERMINAL.md) · [飞书 / IM 通道](docs/design/channels.md) · [设备操控与 Riffet MCP](docs/DEVICES.md) · [主题系统](docs/THEMES.md)
- **扩展与运维**：[Agent 扩展管理](docs/EXTENSIONS.md) · [插件开发指南](docs/PLUGINS.md) · [插件架构](docs/PLUGIN_ARCHITECTURE.md) · [TRAE CLI](docs/TRAEX.md) · [pi RPC](docs/PI.md) · [更新机制](docs/UPDATE.md) · [安全模型](docs/SECURITY.md)

## 致谢与许可证

前端视觉参考了 [ZCode](https://github.com/zai-org/ZCode) 与 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)；DSH 后端桥接复用了 DeepSeek Harness 以 MIT 许可发布的原生接口，上游声明随桥接代码保留。

本项目基于 [Apache-2.0](LICENSE) 许可证开源，第三方归属声明见 [NOTICE](NOTICE)，安全漏洞请按 [SECURITY.md](SECURITY.md) 私密上报。
