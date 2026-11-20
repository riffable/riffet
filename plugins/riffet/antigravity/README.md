Runs Antigravity (`agy`) sessions in Riffet. One `agy` terminal UI runs per conversation; Riffet reads its local records and state to show the conversation, so the terminal and the conversation view are the same session and you can switch between them at any time.

## Before you start

- Install the Antigravity CLI (`agy`) on the server and sign in with it. A provider that uses Google sign-in follows the CLI's own login and configuration.
- Alternatively, add an Antigravity provider with a Gemini-protocol endpoint and API key under Model providers. The API key is kept on the server and passed to the CLI only through its environment.

## Configuration

- The Antigravity provider sets the CLI path, the service address and key, the models to offer and whether the CLI may update itself (off by default). Changes apply the next time the session is idle: Riffet restarts the terminal UI and resumes the same conversation.
- With a service address or model source set, the model list comes from that gateway. Without one, it comes from the CLI.
- To start a session, choose Antigravity in the Agent list.

## Data and limits

- Each session keeps its own private configuration directory under the plugin's data directory. Sign-in state is not copied into it; your own `agy` settings are not changed. Rules, skills, MCP and hooks configuration from your user directory are carried over as a snapshot.
- Riffet relies on private formats of `agy` 1.5.x. Untested versions may fall back to the terminal only.
- Approvals and single-choice questions can be answered in either view. Multiple-choice or free-text questions, sign-in and other secret input are handled in the terminal.
- Stopping, and sending a message while a task runs, are not targeted at a single execution.

With the plugin off, no new Antigravity sessions start.
