# Changelog

User-visible changes only. [简体中文](CHANGELOG.zh-CN.md)

## Unreleased

### Fixes

- With a title model chosen in Settings, it names every conversation, including the ones Cursor, Claude Code, Codex and Droid had already named themselves; a name you set, also with `/rename` in Claude Code, stays. Titles are shorter and more specific, start with what is being done, and keep your own terms such as review or prompt. Conversations the agent already named before this update keep their names.
- Links in replies carry a light underline on the web, Mac and iPhone, so they stand out in themes whose accent is the text colour, such as Pencil.
- The "Working" line at the bottom of a conversation shows for the whole turn, also while the agent is only thinking; it used to stay blank until the first tool call or reply.
- When a Cursor turn fails after running tools, the conversation shows the error once after that work. The error stays visible when the process is folded, including in earlier conversations.
- Cursor conversations keep showing the current turn as running while the agent thinks, and keep subsequent tool calls and replies in that turn.
- Scanning a pairing QR works when the Mac has several network addresses and the phone can reach only some of them, such as Wi-Fi that keeps wireless devices apart while the wired address answers: the QR carries every address and the phone pairs at the first that answers. Android also falls back to these addresses later if the one it uses stops answering.
- Sending a message to an agent no longer waits for the undo checkpoint: the checkpoint is saved while the message goes out, where each message in a project with many uncommitted changes used to wait 0.3–3.5 s. Files the turn changed before the checkpoint finished are listed when undoing the turn, which is then refused rather than restoring the wrong content.
- Cursor with an API gateway starts in about a second instead of 10–30: the queries the CLI makes before its prompt are answered from the server's memory and refreshed behind it, so a change to models or plugins shows one start later.
- Cursor: a slow-starting CLI no longer shows "the CLI has not shown its prompt bar" after 15 seconds, and a message sent while the warm CLI is still starting waits for it instead of starting a second one. A CLI waiting for login says so right away.
- Cursor: a first message with several lines, or one ending in `;`, no longer fails with "Native terminal launch command is invalid" when no warm CLI is ready.
- A conversation that failed while its first message was sending shows the error once, not twice.
- An agent that fails at startup (a wrong model, an invalid key) before Riffet has attached to its terminal now shows as failed with its reason, instead of going idle with no explanation.
- A failed conversation's mark on its sidebar row or tab (the red dot, "出错" on the Mac, "Failed" and the avatar mark on phones) clears once you have opened it.

### Workbench

- Pairing a phone with the Mac no longer needs a terminal: when the local server only accepts this computer, click "Allow devices on the same network" on the pairing page or in the first-launch guide, or switch it in Settings › Connection at any time. The server restarts once no conversation is running, and browsers on this computer will need to sign in afterwards.
- The Mac, Android and iPhone apps open their main window without a server: appearance, language, shortcuts and other settings kept on the device work as usual, and pages that need a server say so and take you to connect. The first launch walks you through starting or connecting a server, choosing the default agent and a starting folder, and pairing your phone, full screen and skippable at every step; whatever you skip is finished later from the new-conversation page.
- Voice input on the web, Android and iPhone: speak into the input box and the text appears at the caret. Choose a speech-to-text service that speaks the OpenAI format in Settings › Input on the web, or install the Local speech recognition plugin, which downloads its engine and models on demand and shows text as you speak. On a phone the mic switches to voice mode: hold to talk, release to insert, slide up to cancel, or tap to keep recording until you tap done. In a browser the microphone needs an HTTPS address; the phone apps do not.
- New Codex and Claude Code conversations start sooner: while the new-conversation page is open, the agent is started ahead of your first message, as Cursor already was. The first reply comes about 1.5–3 s sooner from Codex and about 0.6 s sooner from Claude Code. One started but not used ends when you leave the page.
- The model menu remembers each provider's last model with its effort and Fast settings: switching back to a provider starts on it, and picking another model keeps effort, Fast and the context window where that model offers them. Quota figures from the last reading show as soon as the menu opens, also after a reload, while a fresh reading loads.

## 0.8.0 - 2026-11-17

### Upgrade notes

- Workbench addresses are paths now (`/c/<conversation>`, `/p/<project>`, `/tasks`, `/stats` …). Links and bookmarks in the old `#s=…` form no longer open a conversation.
- Templates, schedules and agent wake-ups become one kind of record, Automations; existing ones are migrated on first start.
- `riffet` commands are renamed: `login-url` is now `url --login`, and `install-service` / `uninstall-service` are `service install` / `service uninstall`. `start` and `status` no longer print a sign-in link with the access token; use `riffet url --login` or `riffet token`.

### Tasks and the assistant

- Task board: a conversation can belong to a task, its status changes from the sidebar menu, and the task shows in the conversation's info.
- Assistant: one long-running personal assistant with its own page, memory, background runs and capability packs; `/new` starts it over. Available on the web, Mac, Android and iPhone.
- Automations run a prompt by hand or on a schedule and keep the last 50 runs.
- The assistant runs on Claude Code or Codex, the two agents that keep it apart from your own instructions, skills and MCP servers. On Codex it now has its directory's and packs' MCP servers, cannot edit your files, compacts at 200k tokens, and runs its background work there too.
- A new task takes one sentence, lets you pick the model, and is either added to To do or started right away; completion criteria are optional. A new Task board settings page sets the default agent and model, and whether new conversations become tasks (off by default).
- Settings are regrouped: new Features, Access and Server groups; bots, the assistant and quick chat sit under Features.
- Work a turn delegated (subagents, background commands) stays visible after the turn ends.
- A Claude Code subagent's report shows in the main conversation's notice and as the answer on the subagent's page; messages the main conversation sends a subagent mid-task show on both sides.

### Backends

- Antigravity CLI is a supported agent.
- Antigravity: a model the gateway serves under its own id (such as `gemini-4-hydrogen-sonar`) no longer turns into agy's default model when the conversation starts, and the conversation says so when agy still picks another; models offer a thinking effort; agy 1.5.10 is supported.
- Antigravity lists what a provider's own gateway serves, rather than agy's built-in models, and a model source that serves the Gemini protocol can be chosen as its gateway type. Model sources now give their model list per protocol, so a new agent needs no adaptation in them.
- A provider that uses a model source no longer shows as not ready right after Riffet or the source's plugin starts.
- After an agent's plugin is updated or reloaded, its open conversations keep showing new replies; before, they stopped updating and the message was reported as possibly unsent.
- Codex conversations continue when switching to a compatible model provider; Codex CLI 0.167.2 is supported.
- Codex has a Deny permission mode: it edits the workspace freely and refuses anything more instead of asking.
- Goals from Claude Code `/goal`, Codex and DeepSeek Harness show on every client.
- New Cursor conversations start on a warm CLI, and live output token counts reach the usage view.
- Fixes for Claude Code: `/clear` moving to a new session, auto-compaction placement, `!` commands sent from Riffet, fallback confirmations in auto mode, forked Skill subagents.
- Claude Code: a turn the agent wakes itself for (`/loop`, a scheduled wake-up) shows as working while it runs, and its working time counts from that turn rather than the one before.
- Idle CLIs are reclaimed by last use and a memory budget you can set; settings show why each one is kept.

### Workbench

- Find within a conversation.
- Git panel: history, line-level staging and a live status stream, on every client.
- Plugins: a public plugin index, several plugin sources with installs pinned to their source, plugin pages, message-menu commands, and provider quota through model-source plugins. A Riffet browser plugin opens pages the agent can drive.
- Selectable and customizable code highlighting themes.
- Markdown: safe inline HTML tags, table alignment and copy, picture attachments.
- Tables in answers on the web drop the frame and column lines for rules between rows, and a short label column no longer wraps one word per line.
- Tabs: new conversations can open as a temporary tab, and pinning or opening another conversation no longer drops the wrong one; tabs stay in step across windows.
- The side panel floats over the conversation and stays open per conversation. Skills and tools move into the composer's + menu; permission modes have names.
- Settings: a storage page with a breakdown of the data directory and scheduled compaction; agent defaults separate from model providers.
- Sidebar: pinned destinations with the rest under More, and footer actions in the avatar menu.
- Sidebar: a running conversation shows a spinner, set apart from the dot for a new result; a task conversation's status ring turns while it runs.
- Sidebar: when a newer release is out, its version shows at the bottom right and opens Settings › About Riffet, which lists what changed since your version.
- Sidebar: clicking a conversation's project name or agent icon opens the conversation; before, the click did nothing.
- The image viewer shows the image alone; on the web it grows from its thumbnail.
- Web on a phone: the image viewer no longer lets the page show through, flickers between two sizes, or covers the image with zoom buttons (pinch to zoom); scrolling the sidebar no longer opens a conversation's ⋯ menu; the avatar opens Settings; a conversation's header keeps an info button at its right end, and its details fit on one screen with every command under More; page titles sit closer to the menu button; the send and stop button is smaller.
- Plugins page: installed plugins and each plugin source are listed side by side, and plugins show as cards in up to three columns. Plugin sources are added, turned off and removed from that list; plugins with an update get their own entry.
- Selecting text in an answer or a progress note shows a compact toolbar that stays with the selection as you scroll: quote it into the composer (a chip there, a Markdown quote when sent), side chat, highlight with a color on hover, copy, export as an image, and plugin actions such as Translate, whose result opens beside the selection.

### Command line

- `riffet` is redone in English: help grouped by purpose, calm colors, and a suggestion for a mistyped command. New `ls`, `resume` with a searchable picker, `logs --since` / `--scope`, `service status`, and tab completion for zsh, bash and fish.
- An npm install updates itself with `riffet update`; `riffet status` notes when a newer release is out, and `riffet`, `riffet start` and `riffet resume` offer to update before running when a newer release is ready to install.

### Clients

- Installs without a source build: `npm install -g riffet`, and an Android APK on GitHub Releases. The macOS DMG is not published yet.
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
