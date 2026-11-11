# 终端会话：导入与交还

Riffet 能列出这台机器上 provider CLI（Claude Code、Codex）存下的会话，导入后在 Riffet 里继续；也能把 Riffet 的会话交给终端继续。两个方向共用一条规则：**同一会话同一时刻只有一个写入方**。Claude Code 两个进程同时 `--resume` 同一会话会把消息交错写进一个 transcript，官方也没有锁。

## 模型

一个 Riffet 会话绑定 provider 的一个会话：`(backendId, continuationKey(profile), nativeSessionId)`。store 保证一个未归档的绑定只属于一个会话（`NATIVE_SESSION_ID_IN_USE`）。导入就是带着 `nativeSessionId` 建会话，不新增实体。

## 发现（driver）

`listExternalSessions` 只读 provider 自己的文件或索引，不启动会话、不发模型请求、不跑 hook。

| | Claude Code | Codex |
|---|---|---|
| 来源 | `<configDir>/projects/*/<uuid>.jsonl`，跳过 `subagents/`、`tool-results/` | app-server `thread/list`（短命管理连接） |
| 读取 | 头尾各 256KB，按 `(ino,size,mtime)` 缓存 | 分页 cursor，结果缓存 15 秒 |
| 路径 | 行内 `cwd` 字段（目录名编码不可逆） | thread `cwd` |
| 标题 | 最后一个 `custom-title` > `ai-title` > 首条用户消息 | `name` > `preview` |
| 过滤 | 空会话；`sdk-*` 入口默认隐藏 | 子代理；默认只列 `cli`、`vscode` |
| 运行中 | `<configDir>/sessions/<pid>.json` + `kill(pid,0)` | `ps` 里带该线程 id 的 codex 进程 |

`externalHolder` 判断“有没有 Riffet 之外的进程正持有这个会话”。Claude 的登记文件按 `procStart` 核对进程，崩溃留下的旧文件不会因 pid 复用而误报。Codex 只能看到 argv 里带线程 id 的进程：由 IDE、桌面 App 的 app-server 或 `codex resume --last` 打开的线程查不到持有者。会话没有 Riffet 自己的存活终端时，每次启动 CLI 前都会问一次（`NativeBackendService.ensure`），持有则拒绝：`NATIVE_SESSION_HELD_EXTERNALLY`。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/external-sessions` | `scope=project\|directory\|all`、`projectId`、`cwd`、`backendId`、`q`、`cursor`、`limit`、`nonInteractive`、`refresh`；返回 `ExternalSessionPage` |
| GET | `/api/external-sessions/directories` | 每个目录的会话数、最近时间、对应项目；返回 `{ directories }` |
| POST | `/api/external-sessions/import` | `{ backendId, backendProfileId?, nativeSessionId }` → `{ session, created }`；已绑定则返回那个会话 |
| GET | `/api/sessions/:id/resume-command` | provider 会话 ID 与 `cd <目录> && <cli> --resume <id>`；不含凭据，`credentialsOmitted` 标明 Riffet 配置的接口与密钥未带上 |
| POST | `/api/sessions/:id/release-cli` | 停掉 Riffet 自己的 CLI（须空闲），让读者在终端起的 CLI 成为唯一写入方 |
| POST | `/api/sessions/:id/terminal-hold` | 仅本机：停掉 Riffet 自己的 CLI，记下 hold，返回终端启动命令 |
| PATCH | `/api/sessions/:id/terminal-hold` | 仅本机：`{ pid }`，终端 CLI 的进程 |
| DELETE | `/api/sessions/:id/terminal-hold` | 收回；终端 CLI 仍在运行时 409 `TERMINAL_STILL_RUNNING`，`?force=1` 先 SIGTERM 它 |

导入时，cwd 与某个项目目录完全一致就用它，否则用该目录新建项目：Claude Code 按启动目录找 transcript，目录不同 `--resume` 就找不到。导入不启动 CLI；打开会话只读历史，首次发送才启动。

## 在终端继续

`riffet resume [id|provider id|标题片段] [--all]`，不带参数时列出当前目录的会话。

1. 会话须处于空闲（`idle`/`interrupted`/`failed`）且没有未结束的 run。
2. 服务端拿到 driver 的 `terminalLaunch`，停掉 Riffet 自己的 CLI，写 `session.terminalHold`。
   - Claude：终端运行 `claude --resume <id>`，带 profile 的 `CLAUDE_CONFIG_DIR` 与凭据；Riffet 每秒看一次 transcript，有变化就唤醒 journal（`followExternal`）。
   - Codex：终端以 `--remote` 接入 Riffet 保持的 app-server，Riffet 的时间线照常实时。
3. hold 期间：`SessionCommands.admit` 拒绝发送（`SESSION_IN_TERMINAL`），`ensure` 拒绝启动，回收跳过它，Codex 不重拉 Riffet 的 TUI。
4. hold 以 pid 加进程启动时间认人：POST 返回一次性 token，`riffet resume` 用它报 pid；报上来之前 hold 视为启动中，不可收回或再交出；报 pid 失败时 `riffet resume` 结束自己启动的 CLI。终端 CLI 退出时 `riffet resume` 释放 hold；进程被直接关掉时，服务端每 5 秒检查 pid，已退出即释放；两分钟内没报 pid 的 hold 视为放弃。

启动命令带凭据，所以 POST/PATCH 只接受本机直连请求。服务端在远程时：`ssh host -t riffet resume <id>`。

## 客户端

- 导入：新建会话页「Shell 终端」「并行尝试」旁的「继续终端会话」卡片，是唯一入口。选择器与 @ 会话选择器同一范式：范围（当前项目 / 按目录 / 全部）、agent 筛选、搜索、“含非交互”。已在 Riffet 里继续的会话不列出（服务端过滤，分页与目录计数一致）；`live: 'terminal'` 的条目可以导入，但发送前需对方退出。
- 导出：会话更多菜单「在终端恢复…」打开弹窗，给出 provider 会话 ID 和恢复命令。复制命令时先 `release-cli`；之后 Riffet 再要启动 CLI 会因终端进程在跑而被拒（`NATIVE_SESSION_HELD_EXTERNALLY`）。
- `riffet resume` 走 hold：`terminalHold` 存在时输入框换成“在终端中”与“收回”。
