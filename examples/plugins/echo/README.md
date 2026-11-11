# example.echo

The smallest Agent: a non-built-in id (`example.echo`) that answers every message with the same text.
It is documentation by example for the Agent protocol (`packages/plugin-api/src/agent.ts`):

| Member | What it does here |
|---|---|
| `profiles`, `capabilities`, `available` | describe the Agent, no CLI to look for |
| `open` | returns a native session id |
| `send` | commits the delivery fence, pushes the user message (the acceptance), and pushes the reply 150 ms later, then the turn ends |
| `interrupt` | ends the pending turn as cancelled |

No enum, selector or display code in the core or the clients mentions it; they learn the name from
`GET /api/backends`, and a client that sends `X-Riffet-Features: plugin-agents` receives its sessions.

Agent backends need a trusted package. This example uses a local development link:

```sh
riffet plugin dev examples/plugins/echo
# Remove the persistent link when finished:
riffet plugin unlink example.echo
```

The Agent protocol is experimental. See `docs/PLUGINS.md`.
