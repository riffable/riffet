# 界面术语表

各端共用一份译法。新增界面文案先查这里；需要新词时先补一行再翻译，
避免「会话 / 对话」「回合 / 轮次」这类同义漂移。产品名与技术标识不翻译：Riffet、Cursor、Codex、
Claude、Droid、DSH、TRAE、Git、JSON、Markdown、URL。

| 中文 | English | 说明 |
| --- | --- | --- |
| 工作台 | Workbench | 整个应用 |
| 会话 | Session | 一条对话 |
| 会话列表 | Session list | 侧栏列表 |
| 回合 | Turn | 一次用户输入到结束 |
| 轮次 | Run | 统计里的运行次数，不是回合 |
| 运行 | Run | |
| 快捷对话 | Quick chat | 不启动 Agent 的对话 |
| 子 Agent | Subagent | 不改写为 child agent |
| 项目 | Project | 一个目录 |
| 工作树 | Worktree | Git worktree |
| 尝试 | Attempt | 并行尝试 |
| 交接 | Handoff | 跨后端继续 |
| 侧栏 | Sidebar | |
| 检查器 | Inspector | 右侧面板 |
| 终端 | Terminal | |
| 大纲 | Outline | 回合导航 |
| 活动 | Activity | 工具调用与状态行 |
| 标记 | Mark | 收藏/标记页 |
| 收藏 | Favorite | |
| 分享 | Share | |
| 发布 | Publish | 分享到外部 |
| 任务 | Task | 一件跨会话跟踪的工作（docs/TASK-BOARD.md），代码名 `WorkItem` |
| 收件箱 | Inbox | 唯一会打扰用户的地方：要回答的、要验收的、跟进推不动的 |
| 任务看板 | Task board | 任务的页面，导航和标题都用这个名字 |
| 个人助理 | Assistant | 用户自己的常驻 Agent（docs/ASSISTANT.md）：一条主对话加后台运行。导航、页头、标题都用「个人助理」；文档里说它的组成部分时可简称助理 |
| 跟进 | Follow-up | 助理在后台盯进行中任务的部分，不占主对话 |
| 自动化 | Automation | 模板加触发方式（计划、手动、后续）；页面名「自动化」。不叫定时任务，不译成 cron job |
| 扩展 | Extension | Agent 插件体系 |
| 插件 | Plugin | |
| 集成 | Plugin | 内置厂商功能 |
| 模型 | Model | |
| 模型源 | Model source | |
| 档案 | Profile | 后端配置档案 |
| 后端 | Backend | |
| 服务器 | Server | 客户端连接的 Riffet 服务器：地址、连接、配对、版本。不写「服务端」，也不单独写「服务」 |
| 本机服务器 | Local server | 运行在这台电脑上的服务器 |
| 服务 | Service | 只用于系统托管的后台服务（登录服务、launchd、systemd）、模型服务、分享服务；MCP 服务器沿用此写法 |
| 提示词 | Prompt | |
| 草稿 | Draft | |
| 队列 | Queue | |
| 审批 | Approval | |
| 发送 | Send | 用户消息操作；delivery 仅用于内部协议 |
| 检查状态 | Check status | 查询与修正原消息，不重新发送 |
| 暂时无法确认是否已发送 | Unable to confirm sending | 与任务结束状态未知分开 |
| 补充到当前任务 | Add to current task | Steer 操作，绑定原任务 |
| 中断 | Interrupt | |
| 上下文用量 | Context usage | |
| 用量 | Usage | |
| 统计 | Stats | |
| 通知 | Notification | |
| 目录 | Folder | 界面里的文件系统目录 |
| 文件 | File | |
| 默认 | Default | |
| 保存 | Save | |
| 取消 | Cancel | |
| 重试 | Retry | |
| 撤销 | Undo | |
| 删除 | Delete | |

## English style

- Sentence case for labels and buttons; no trailing period on labels, buttons or menu items.
- Actions use the verb the user performs: `Save`, `Stop`, `Retry`, not `Saving`/`Submission`.
- Status text is a state, not an instruction: `Running`, `Unconfirmed`.
- No marketing adjectives and no exclamation marks. Shortcuts and units stay as they are.
- Keep placeholders and rich-text tags exactly where the Chinese has them; translate the words around them.
