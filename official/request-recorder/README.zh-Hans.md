# 请求记录

`runtimeHooks` 扩展点的参考实现。对 Claude Code 对话，它在对话原本使用的模型网关前面运行一个本机 HTTP 代理，原样转发每个请求，并把请求和响应记录在服务器上，用来检查智能体实际发出了什么。

## 信任

必须显式信任安装：隔离安装不支持运行时钩子，因为钩子在服务进程内运行，并会启动自己的进程。

```sh
riffet plugin pack official/request-recorder --out /tmp/riffet-recorder.tgz
riffet plugin install /tmp/riffet-recorder.tgz --trusted --yes
```

默认关闭；在插件页开启后，新建的对话才会走代理，已在运行的 CLI 不会被改向。

## 行为

- 代理监听 `127.0.0.1` 的临时端口，路径带一段随机前缀，其他本机进程不能拿它当转发器。每个对话一个分离进程：CLI 在服务重启后仍使用启动时的地址，`recover` 会重新找到它。
- 上游依次取档案的 API 地址、服务进程环境的 `ANTHROPIC_BASE_URL`、`https://api.anthropic.com`。方法、路径、查询和正文按原样转发；响应（含 SSE）随到随回。
- CLI 进程消失、对话结束，或启动 60 秒后仍无人绑定时，代理退出。记录保留。
- 会话的更多菜单有「暂停记录 / 继续记录」，并显示本次运行的请求数。插件页列出有记录的对话、大小和服务器路径，可逐个清除。

## 记录内容

按对话保存在 `<状态目录>/plugin-data/riffet.request-recorder/recordings/<对话>/` 下，JSONL 分段（`000001.jsonl` 等）。每个请求一行：时间、方法、路径、状态、耗时、请求和响应大小、请求里的模型，以及两侧的头和正文。

- 不保存凭据：名称含 `authorization`、`cookie`、`api-key`、`token`、`secret`、`credential`、`signature`、`password` 的头和同类查询参数一律替换为 `[redacted]`。请求正文按发送原样保存，提示词里出现的密钥会进入记录。
- 每段正文截取前 64 KB（压缩的响应只为记录解压，发给客户端的不变）。
- 上限：每段 1 MB、每个对话 16 MB、总计 128 MB，先删最旧的段；14 天没有写入的对话整个删除。上限是 `recorder.ts` 里的常量，应迁入 `packages/contracts/src/budgets.ts`。

## 当前范围

服务端目前只在 Codex 系后端接入了运行时钩子；Claude Code 要等 Claude 后端调用 `prepare` 并把 `launchEnv` 合并进 CLI 的提供方设置后才会生效。Codex 不在范围内：它的地址由 `-c` 参数设定，环境变量覆盖不了。
