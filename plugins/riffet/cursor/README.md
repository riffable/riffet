Runs Cursor Agent (`cursor-agent`) sessions in Riffet. The CLI runs in the conversation's terminal; Riffet follows its chat store, screen and hooks to show the conversation, and you can work in the terminal directly.

## Before you start

- Install the Cursor CLI on the server and sign in, or enter an API key under Cursor Provider.
- CLI Management shows the CLI version, path, account and models it found.

## Configuration

- Cursor Provider: the model gateway, API key, CLI entry, configuration directory and the default model for new sessions. They are kept on the server; connection and launch settings take effect after Riffet restarts.
- To start a session, choose Cursor in the Agent list.

With the plugin off, no new Cursor sessions start; a CLI that is already running keeps running.
