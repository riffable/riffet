Runs Cursor Agent (`cursor-agent`) sessions in Riffet. The CLI runs in the conversation's terminal; Riffet follows its chat store, screen and hooks to show the conversation, and you can work in the terminal directly.

## Before you start

- Install the Cursor CLI on the server and sign in, or add a gateway with an API key under Model Providers.
- CLI Management shows the CLI version, path, account and models it found.

## Configuration

- Model Providers: as for other Agents, there can be several, so the CLI's own login and custom gateways sit side by side. A session picks its provider when it starts and keeps it. The built-in "Cursor CLI" is kept in `cursor-cli.json` on the server and cannot be removed or renamed.
- A provider on the CLI's own login uses `~/.cursor`, the same account a terminal `cursor-agent` uses. A gateway provider keeps its CLI state (`cli-config.json`, chats) in `cursor-profiles/<id>/` under Riffet's data directory and sends agent requests over HTTP/1. Rules, skills, hooks and MCP servers are shared by every provider.
- CLI Management: the CLI entry, configuration directory and auto-update of the built-in provider; other providers take its CLI entry and auto-update setting. They are kept on the server and take effect after Riffet restarts.
- To start a session, choose Cursor in the Agent list.

With the plugin off, no new Cursor sessions start; a CLI that is already running keeps running.
