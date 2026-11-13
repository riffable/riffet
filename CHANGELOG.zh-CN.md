# 变更记录

只记录使用者能感知的变化。[English](CHANGELOG.md)

## 未发布

## 0.7.0 - 2026-11-12

首个公开版本，以 Apache-2.0 开源。

### 后端

- 驱动本机已安装、已登录的官方 CLI，并就地读取它们的会话存储：Cursor（`cursor-agent`）、Claude Code（`claude`）、Codex（`codex`）、DeepSeek Harness（`dsh`）、Factory Droid（`droid`）、TRAE CLI（`traex`）、pi（`pi`）。各后端能力见 README 的能力矩阵。
- 终端里已有的 CLI 会话可以导入后继续；Riffet 里的会话也可以交还到终端继续。
- `riffet doctor` 显示各 CLI 的版本，并标出低于最低可用版本或高于已验证版本的情况。

### 工作台

- 时间线折叠连续的工具调用，修改可展开为 Diff，子 Agent 有独立的转录页；Mermaid、D2、Graphviz、PlantUML、Vega-Lite 与 KaTeX 在本地渲染。
- 支持 TUI 的后端可在结构化对话与背后的终端之间切换；关闭客户端后会话在主机上继续运行。
- 运行中引导、侧边聊天、快速对话、高亮与收藏、会话分享与 PDF 导出、用量统计。
- 对着 Diff 写审阅批注；2–4 路并行尝试（每路一个 Git worktree）；会话交接给另一个后端、从任意回合分叉、恢复检查点；推送分支与创建 GitHub PR 通过本机 `gh` 完成。
- 20 多种文件格式本地预览，包括 PDF、Office 文档、Jupyter Notebook、SQLite、3D 模型与压缩包。
- 插件接口 `@riffet/plugin-api`：模型源、工作台视图、配色主题与原生运行时附属进程。

### 客户端与通道

- Web：中英文界面，可安装为 PWA。
- macOS（15+）：SwiftUI + AppKit 原生应用，内置服务端，菜单栏常驻与全局快速提问。
- iPhone 与 Android：扫码配对，可在多台服务器间切换；审批、Diff、远端目录与触控终端。
- 飞书 / Lark 机器人：服务端主动建立出站连接，不需要公网入口；私聊或群话题内新建与续聊会话，审批在聊天里完成。
- Android 预览：Agent 可在两道确认下读取和操作已配对的手机，并给自己的会话定一次性唤醒。

### 安全

- 默认只监听本机回环地址；远程设备经一次性配对码接入。令牌权限、局域网明文与密钥存储的边界见 [SECURITY.md](docs/SECURITY.md)。

### 已知限制

- 目前只提供源码安装；npm 包、macOS DMG 与 Android APK 尚未发布。
- 不支持 Windows。
