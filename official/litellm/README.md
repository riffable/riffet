# LiteLLM

A [LiteLLM Proxy](https://docs.litellm.ai/docs/simple_proxy) as a gateway type for Claude Code and Codex connections. It supplies the model catalog and shows the key's budget as usage. It is the reference for a model source with `role: "adapter"` and `usage: true`.

Runs as an isolated package; capabilities are `models.provide` and `network`. No `hosts` are declared: the address is the one you enter, so the host accepts it without a fixed list.

## Install

```sh
riffet plugin install riffet.litellm --grant models.provide,network
# or from a checkout
riffet plugin pack official/litellm --out /tmp/riffet-litellm.tgz
riffet plugin install /tmp/riffet-litellm.tgz --grant models.provide,network
```

In a Claude Code or Codex provider connection, choose API access and the gateway type LiteLLM.

## Settings

The connection's own address and API key win. When it leaves them empty, the plugin settings `Proxy address` and `API key` are used. The address is the proxy root; a trailing `/v1` is accepted. Remote addresses must be HTTPS; HTTP is allowed for loopback. Credentials, query and fragment in the address are rejected.

## Protocols

- `anthropic-messages`: `<root>/v1/messages` (Claude Code).
- `openai-responses`: `<root>/v1/responses` (Codex).

The catalog comes from `/v1/models`.

## Usage

`GET /key/info` with the connection's key. `spend` and `max_budget` become one window (percent used); `budget_duration` gives the window length and `budget_reset_at` the reset time. A key without `max_budget` shows no meter. Per-model budgets are not read. Requests time out after 15 seconds, redirects are refused, and the host caches the result.
