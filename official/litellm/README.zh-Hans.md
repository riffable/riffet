# LiteLLM

把 [LiteLLM Proxy](https://docs.litellm.ai/docs/simple_proxy) 作为 Claude Code 与 Codex 连接的网关类型：提供模型目录，并把 Key 的预算显示为用量。它是 `role: "adapter"` 且 `usage: true` 的模型源参考实现。

以隔离包运行，能力为 `models.provide` 与 `network`。不声明 `hosts`：地址由用户输入，宿主直接接受。

## 安装

```sh
riffet plugin install riffet.litellm --grant models.provide,network
# 或从源码目录
riffet plugin pack official/litellm --out /tmp/riffet-litellm.tgz
riffet plugin install /tmp/riffet-litellm.tgz --grant models.provide,network
```

在 Claude Code 或 Codex 的提供商连接中选择 API 接入，网关类型选 LiteLLM。

## 设置

连接自己的地址和 API Key 优先；连接留空时使用插件设置的「Proxy address」和「API key」。地址填代理根地址，可带末尾 `/v1`。远程地址必须为 HTTPS，回环地址允许 HTTP；地址中不得含凭据、query 或 fragment。

## 协议

- `anthropic-messages`：`<root>/v1/messages`（Claude Code）。
- `openai-responses`：`<root>/v1/responses`（Codex）。

模型目录来自 `/v1/models`。

## 用量

用连接的 Key 请求 `GET /key/info`。`spend` 与 `max_budget` 转为一个窗口（已用百分比），`budget_duration` 为窗口长度，`budget_reset_at` 为重置时间。没有 `max_budget` 的 Key 不显示额度条；不读取按模型的预算。请求超时 15 秒，拒绝重定向，结果由宿主缓存。
