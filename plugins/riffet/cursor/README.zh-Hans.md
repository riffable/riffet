在 Riffet 里运行 Cursor Agent（`cursor-agent`）会话。CLI 在会话的终端里运行，Riffet 跟随它的对话记录、屏幕和 hooks 显示对话，也可以直接在终端里操作。

## 准备

- 在服务器上安装 Cursor CLI 并登录，或在「模型提供商」里添加一个带 API Key 的网关。
- 「CLI 管理」显示检测到的 CLI 版本、路径、账户和模型。

## 配置

- 「模型提供商」：和其他 Agent 一样可以有多个，CLI 自带登录和自定义网关可以并存；会话在新建时选定提供商，之后不能切换。内置的「Cursor CLI」保存在服务器的 `cursor-cli.json`，不能删除或改名。
- 使用 CLI 自带登录的提供商用 `~/.cursor`，和终端里的 `cursor-agent` 是同一个账号。网关提供商的 CLI 状态（`cli-config.json`、对话记录）单独放在 Riffet 数据目录的 `cursor-profiles/<id>/`，Agent 请求走 HTTP/1。规则、技能、hooks 和 MCP 由所有提供商共用。
- 「CLI 管理」：CLI 入口、配置目录和自动更新，作用于内置提供商；其他提供商沿用它的 CLI 入口和自动更新设置。保存在服务器上，修改后需要重启 Riffet。
- 新建会话时，在 Agent 列表里选择 Cursor。

关闭插件后不能再新建 Cursor 会话；已经在运行的 CLI 会继续运行。
