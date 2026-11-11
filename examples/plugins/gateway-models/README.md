# example.gateway-models

An OpenAI-compatible gateway as a model source for Codex. It runs out of process, so it is installed
(not loaded as a development package).

| | |
|---|---|
| Capabilities | `models.provide` (offers a model source), `network` (asks the gateway for its models) |
| Settings | Gateway address (`baseUrl`), Secret key (`apiKey`, never leaves the server) |
| Shows | `resolve()` answering synchronously from what the async `prepare()` fetched |

```sh
riffet plugin pack examples/plugins/gateway-models --out /tmp/gateway-models.tgz
riffet plugin install /tmp/gateway-models.tgz --yes
```

Then set the address and key in Settings, and pick `Example gateway` as the model source of a Codex
profile. See `docs/PLUGINS.md`.
