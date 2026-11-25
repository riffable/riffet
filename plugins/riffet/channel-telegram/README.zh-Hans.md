在 Telegram 私聊或群聊里和 Riffet 的会话对话。Riffet 会把思考、工具调用和回答流式写回 Telegram，支持审批、提问和模型切换的按钮交互，并与其他客户端保持同步。

## 准备

- 在 Telegram 向 `@BotFather` 发送 `/newbot` 创建机器人并复制 Bot Token。
- 服务器通过长轮询主动连出 `api.telegram.org`，不需要公网地址或 Webhook。如果服务器无法直连 Telegram，可在「设置 › 机器人」里填写代理地址或自建 Bot API 地址。
- 同一个 Bot Token 只能由一个 Riffet 实例连接；同时运行多个实例会触发 Telegram `409 Conflict`。
- 可选：在 `@BotFather` 里开启 **Threaded Mode**，让私聊里的每个话题成为独立会话。

## 配置

- 在「设置 › 机器人」添加 Telegram 机器人并填入 Bot Token，查看连接状态和回复显示项（标题、思考与工具、中断按钮、底部信息）。
- 只有绑定过的 Telegram 用户能使用机器人，其他人的消息会被忽略。在设置里生成一次性绑定码（5 分钟有效），在私聊里给机器人发 `/bind <码>` 完成绑定。
- 机器人启动时自动注册 `/` 菜单命令：`/new`、`/stop`、`/status`、`/model`、`/project`、`/help`（群里支持 `/flat on|off`，绑定用 `/bind <码>`）。

## 群聊与会话

- 在群里 `@机器人` 或回复机器人的消息开始会话。开启话题（Forum）的群中每个话题是一个独立会话；普通群中每条回复链是一个独立会话。`/flat on` 让整个群共用一个会话。
- 如希望绑定用户在已绑定的群话题里不用每次 `@机器人`，请在 `@BotFather` 中关闭 Group Privacy（`/setprivacy` → Disable）。
- 每个聊天绑定一个项目，首次使用时选择，用 `/project` 切换。

## 数据

Bot Token 保存在服务器的私有文件（`0600`）里，不会返回给客户端，设置里只显示是否已配置。你发送的图片和文件由服务器下载（受 Telegram Bot API 20 MB 限制）并作为附件加入会话。
