在 Riffet 里运行 Cursor Agent（`cursor-agent`）会话。CLI 在会话的终端里运行，Riffet 跟随它的对话记录、屏幕和 hooks 显示对话，也可以直接在终端里操作。

## 准备

- 在服务器上安装 Cursor CLI 并登录，或在「Cursor 提供商」里填写 API Key。
- 「CLI 管理」显示检测到的 CLI 版本、路径、账户和模型。

## 配置

- 「Cursor 提供商」：模型网关、API Key、CLI 入口、配置目录和新会话的默认模型。配置保存在服务器上，连接与启动参数修改后需要重启 Riffet。
- 新建会话时，在 Agent 列表里选择 Cursor。

关闭插件后不能再新建 Cursor 会话；已经在运行的 CLI 会继续运行。
