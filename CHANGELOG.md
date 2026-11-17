# Changelog

User-visible changes only. [简体中文](CHANGELOG.zh-CN.md)

## Unreleased

### Upgrade notes

- Workbench addresses are paths now (`/c/<conversation>`, `/p/<project>`, `/tasks`, `/stats` …). Links and bookmarks in the old `#s=…` form no longer open a conversation.
- Templates, schedules and agent wake-ups become one kind of record, Automations; existing ones are migrated on first start.

### Tasks and the assistant

- Task board: a conversation can belong to a task, its status changes from the sidebar menu, and the task shows in the conversation's info.
- Assistant: one long-running personal assistant with its own page, memory, background runs and capability packs; `/new` starts it over. Available on the web, Mac, Android and iPhone.
- Automations run a prompt by hand or on a schedule and keep the last 50 runs.
- Work a turn delegated (subagents, background commands) stays visible after the turn ends.

### Backends

- Antigravity CLI is a supported agent.
- Codex conversations continue when switching to a compatible model provider; Codex CLI 0.167.2 is supported.
- Goals from Claude Code `/goal`, Codex and DeepSeek Harness show on every client.
- New Cursor conversations start on a warm CLI, and live output token counts reach the usage view.
- Fixes for Claude Code: `/clear` moving to a new session, auto-compaction placement, `!` commands sent from Riffet, fallback confirmations in auto mode, forked Skill subagents.
- Idle CLIs are reclaimed by last use and a memory budget you can set; settings show why each one is kept.

### Workbench

- Find within a conversation.
- Git panel: history, line-level staging and a live status stream, on every client.
- Plugins: a public plugin index, several plugin sources with installs pinned to their source, plugin pages, message-menu commands, and provider quota through model-source plugins. A Riffet browser plugin opens pages the agent can drive.
- Selectable and customizable code highlighting themes.
- Markdown: safe inline HTML tags, table alignment and copy, picture attachments.
- Tabs: new conversations can open as a temporary tab, and pinning or opening another conversation no longer drops the wrong one; tabs stay in step across windows.
- The side panel floats over the conversation and stays open per conversation. Skills and tools move into the composer's + menu; permission modes have names.
- Settings: a storage page with a breakdown of the data directory and scheduled compaction; agent defaults separate from model providers.
- Sidebar: pinned destinations with the rest under More, and footer actions in the avatar menu.
- The image viewer shows the image alone; on the web it grows from its thumbnail.

### Clients

- macOS: native conversation canvas; web parity for tabs, overview, code navigation and settings; beta updates through Sparkle (About → receive beta updates).
- iPhone: pages rebuilt on a shared design layer, push notifications, and fixes for main-thread crashes.
- Android: pull down for search on root pages, the full title in the details pane, and a composer that folds back when empty.
- Unread state is shared across clients.

### Performance

- The server keeps process spawns and database checkpoints off the event loop, drops cold timeline rows, and syncs sidebar lists by deltas.
- Caches on the server, web, Mac and phones have size limits; the service monitor shows each connected client's resource use.
- A server restart keeps running turns.

## 0.7.0 - 2026-11-12

First public release, open source under Apache-2.0.

### Backends

- Drives the official CLIs already installed and signed in on the machine, and reads their session stores in place: Cursor (`cursor-agent`), Claude Code (`claude`), Codex (`codex`), DeepSeek Harness (`dsh`), Factory Droid (`droid`), TRAE CLI (`traex`) and pi (`pi`). See the capability matrix in the README for what each backend supports.
- A CLI session already running in a terminal can be imported and continued; a Riffet session can be handed back to the terminal.
- `riffet doctor` shows each CLI's version and flags versions below the minimum supported or above the last verified one.

### Workbench

- The timeline folds consecutive tool calls, edits expand into diffs, and subagents get their own transcript page; Mermaid, D2, Graphviz, PlantUML, Vega-Lite and KaTeX render locally.
- Backends with a TUI can switch between the structured conversation and the terminal behind it; sessions keep running on the host after the client closes.
- Steering a running turn, side chats, quick chats, highlights and bookmarks, session sharing and PDF export, usage statistics.
- Review comments on diffs; 2–4 parallel attempts, each in its own Git worktree; handing a session to another backend, forking from any turn, restoring checkpoints; pushing branches and opening GitHub pull requests through the local `gh`.
- Local previews for more than 20 file formats, including PDF, Office documents, Jupyter notebooks, SQLite, 3D models and archives.
- Plugin API `@riffet/plugin-api`: model sources, workbench views, color themes and native runtime companion processes.

### Clients and channels

- Web: English and Chinese interface, installable as a PWA.
- macOS (15+): native SwiftUI + AppKit app with a bundled server, a menu bar presence and a global quick-ask shortcut.
- iPhone and Android: pairing by QR code, switching between several servers; approvals, diffs, remote folders and a touch terminal.
- Feishu / Lark bot: the server opens the connection outward, so no public endpoint is needed; new and continued sessions in direct messages or group topics, with approvals answered in the chat.
- Android preview: with two confirmations, an agent can read and operate a paired phone and schedule one-off wake-ups of its own session.

### Security

- Listens on the loopback address only by default; remote devices join with a one-time pairing code. Token scopes, plain HTTP on the LAN and key storage are described in [SECURITY.md](docs/SECURITY.md).

### Known limitations

- Source installation only for now; the npm package, macOS DMG and Android APK are not published yet.
- Windows is not supported.
