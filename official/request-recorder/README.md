# Request Recorder

Reference implementation of the `runtimeHooks` extension point. For a Claude Code conversation it runs a local HTTP proxy in front of the model gateway the conversation already uses, forwards every request unchanged, and records the requests and responses on the server so you can inspect what the agent sent.

## Trust

The package needs an explicit trusted install: isolated installs do not support runtime hooks, because the hook runs in the server process and starts a process of its own.

```sh
riffet plugin pack official/request-recorder --out /tmp/riffet-recorder.tgz
riffet plugin install /tmp/riffet-recorder.tgz --trusted --yes
```

It is off by default; turn it on in the plugin page, then start a new conversation. A running CLI is not redirected.

## Behavior

- The proxy listens on `127.0.0.1` on an ephemeral port, under a random secret path prefix, so other local processes cannot use it as a forwarder. It is a detached process per conversation, because the CLI keeps its launch address across a server restart; `recover` finds it again.
- The upstream is the profile's API endpoint, else `ANTHROPIC_BASE_URL` of the server's environment, else `https://api.anthropic.com`. Method, path, query and body are forwarded as received; responses, server-sent events included, are streamed back as they arrive.
- The proxy ends when the CLI process it was bound to is gone, when the conversation ends, or 60 seconds after start if nothing bound to it. Recordings stay.
- The session more menu has Pause recording / Resume recording, with the request count of this run. The plugin page lists conversations with their size and server path, and clears each one.

## Recorded

Per conversation, under `<state dir>/plugin-data/riffet.request-recorder/recordings/<conversation>/`, as JSONL segments (`000001.jsonl`, ...). One line per request: time, method, path, status, duration, request and response sizes, model when the request names one, and the headers and the body of each side.

- Credentials are not stored: headers named like `authorization`, `cookie`, `api-key`, `token`, `secret`, `credential`, `signature` or `password` are replaced by `[redacted]`, and so are such query parameters. Request bodies are stored as sent, so a secret typed into a prompt is in the recording.
- Each body is cut at 64 KB (compressed responses are decoded for the copy, not for the client).
- Limits: 1 MB per segment, 16 MB per conversation, 128 MB in total; the oldest segments are deleted first. A conversation with no write for 14 days is deleted. The limits are constants in `recorder.ts` and should move into `packages/contracts/src/budgets.ts`.

## Current scope

The server wires runtime hooks into the Codex family of backends only; Claude Code conversations get an attachment once the Claude backend calls `prepare` and merges `launchEnv` into the CLI's provider settings. Codex is not covered: its endpoint is set by `-c` arguments that an environment variable cannot override.
