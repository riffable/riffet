<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/brand/lockup-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="docs/brand/lockup.svg">
  <img alt="Riffet" src="docs/brand/lockup.svg" height="52">
</picture>

### Keep the riff going.

A self-hosted workbench for agent CLIs. Run it on any host and continue sessions from any device.

[![CI](https://github.com/riffable/riffet/actions/workflows/ci.yml/badge.svg)](https://github.com/riffable/riffet/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/riffable/riffet)](https://github.com/riffable/riffet/releases)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

English · [简体中文](README.zh-CN.md) · [Homepage](https://riffable.github.io/riffet/) · [Plugins](https://riffable.github.io/riffet/plugins/) · [Releases](https://github.com/riffable/riffet/releases) · [Changelog](CHANGELOG.md)

</div>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/hero-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/hero-light.png">
    <img alt="The Riffet web workbench showing an agent’s answer about per-key rate limiting, with the sidebar of sessions, next to the same session in the Android app" src="docs/assets/hero-light.png" width="100%">
  </picture>
</p>

Riffet is a self-hosted workbench for agent CLIs, built around deep support for Claude Code, Codex, Cursor, Antigravity, TRAE CLI, and more. It drives the official CLIs directly, keeping each one's sign-in, rules, skills, MCP, and subscription, and provides structured conversations and live terminals, instructions added mid-turn, and importing terminal sessions and handing them back. Sessions live on your own host and can be followed and continued from a browser, macOS, iPhone, Android, and IM bots; linked hosts are managed together from one web workbench.

On top of this, Riffet can set agents up as team members: each has a fixed role, remembers what it learned on earlier jobs, gets only the permissions it needs, and can start work on a schedule or when something happens. In any session, you can ask the agent to turn the current conversation into a new member.

Claude Code, Codex, and other agents run independently of the server process, so restarts do not interrupt running turns, and clients resume automatically after a disconnect. Code, credentials, and history stay on your host. Riffet is open source under the Apache-2.0 license.

---

## Install

Requires macOS or Linux, Node.js 24.19+, tmux 3.2+, and at least one [supported agent CLI](#agent-matrix) installed and signed in on the host.

```bash
npm install -g riffet
riffet doctor                  # checklist for Node, tmux, the agent CLIs, port, and permissions
riffet start --workspace .     # start the background daemon and register the current repository
riffet                         # open http://127.0.0.1:4337/ in a browser
```

Upgrade with `riffet update`. Hooks and MCP depend on a fixed install path, so install globally rather than running through `npx`.

### Clients

| Component | Channel | Notes |
| :--- | :--- | :--- |
| Server and web workbench | `npm install -g riffet` | Default listener `127.0.0.1:4337`; also serves as a PWA |
| macOS app | [`Riffet.dmg` on Releases](https://github.com/riffable/riffet/releases) *(upcoming)* | macOS 15+, Apple Silicon; bundles the server runtime |
| Android app | [`APK` on Releases](https://github.com/riffable/riffet/releases) | Pairs by QR code, or by address and one-time code |
| iPhone app | Source build (`apps/mobile/iosApp`) | iOS 18+; signed with your own Apple team ID ([guide](apps/mobile/iosApp/README.md)) |

### Connect other devices

The server listens only on loopback by default. To reach it over a LAN, Tailscale, or an HTTPS proxy, restart it with authentication and generate a pairing code:

```bash
riffet restart --host 0.0.0.0 --auth
riffet pair                    # prints reachable URLs, a five-minute single-use code, and a QR code
```

The mobile apps pair by scanning the QR code; browsers and the Mac app enter the code. Pages opened from other devices over plain HTTP are read-only; Tailscale and HTTPS addresses are not restricted. Tunnels and reverse proxies are covered in [Remote Access](docs/guide/remote-access.md).

### Link servers

```bash
riffet link invite             # on one server: print a link string
riffet link join <string>      # on the other: join (or paste it in Settings › Server links)
riffet link ssh devbox         # link over SSH when the ports are not reachable
```

Each server sets whether the other may operate it (off by default); removing the link on either side removes it for both. See [Server Links](docs/SERVER-LINKS.md).

<details>
<summary><strong>Build from source</strong></summary>

Requires `pnpm` in addition to Node.js `>= 24.19.0`:

```bash
git clone https://github.com/riffable/riffet.git ~/.local/src/riffet
cd ~/.local/src/riffet
pnpm install && pnpm build

mkdir -p "$HOME/.local/bin"
ln -s "$HOME/.local/src/riffet/scripts/riffet.mjs" "$HOME/.local/bin/riffet"
```

</details>

<details>
<summary><strong>CLI commands, completions, and defaults</strong></summary>

```bash
riffet                 # start the background server (if stopped) and open a browser
riffet status          # show daemon status, listen address, state directory, and available updates
riffet pair            # generate a five-minute single-use pairing code and QR code (--url for tunnels)
riffet link            # link with another server: invite, join, ssh, list, rename, remove
riffet ssh <server>    # open a shell or run a command on a linked server
riffet stop            # stop the web server; live tmux agent terminals keep running
riffet restart         # restart with the saved listener and auth settings
riffet logs -f         # tail server logs; tokens are redacted (--since, --scope)
riffet token           # print the access token to stdout (e.g. riffet token | pbcopy)
riffet url --login     # print a one-step browser login URL
riffet ls              # list conversations, this directory's project first (-a for all)
riffet resume          # continue a conversation in this terminal (searchable picker)
riffet doctor          # inspect the environment (--json for report, --compact to shrink workbench.db)
riffet service install # start at login (launchd / systemd); also status, uninstall
riffet completion zsh  # tab completion for zsh, bash, or fish
riffet update --check  # check for a newer stable release
riffet update          # update an npm install or a clean source release checkout and restore the daemon
riffet restore         # restore a verified backup into an empty state directory (--backup)
riffet plugin --help   # develop, pack, install, manage sources, and diagnose plugins
```

Defaults: `http://127.0.0.1:4337/`, Cursor executable `cursor-agent`, private state directory `~/.local/share/riffet` (`0700` directory, `0600` secrets), no token on loopback. Overrides: `--port`, `--host`, `--cli`, `--state-dir`, `--workspace`, `--allow-host`; `--port`, `--host`, `--cli`, and `--state-dir` also read `RIFFET_PORT`, `RIFFET_HOST`, `RIFFET_CLI`, and `RIFFET_STATE_DIR`.

</details>

---

## Features

### 01 · Agent sessions

Riffet drives the official CLIs directly and keeps each CLI's own sign-in, rules, skills, MCP, and subscription. Output parsing, the live terminal, and message delivery are adapted to each CLI one by one; see the [agent matrix](#agent-matrix) for what each supports.

- **Agents and models**: Each session picks its own agent, model, and model provider, and can be handed to another agent to continue.
- **Mid-turn steering**: Add instructions while the agent is running, or queue them for the next turn.
- **Terminal round trip**: Claude Code and Codex sessions in a terminal can be imported into Riffet and handed back to the terminal.
- **Views**: One session can be shown as a conversation, a live terminal, a canvas, or a trace. The canvas lays the answer out as cards by output type; the trace lists every model request with its token usage and tool calls.
- **Files and Git**: Previews for PDF, Office, notebooks, and many other formats, text editing, and line-level staging and commits. Every turn saves a checkpoint you can roll back to or fork from, and diffs can be annotated and sent back to the agent.
- **Code Studio**: IDE-style code browsing with go to definition, find references, and line-by-line blame.
- **Built-in browser**: People and agents work on the same web page together.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/reel-views-dark.gif">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/reel-views-light.gif">
    <img alt="One session as the conversation streaming in, the live terminal, the canvas filling in card by card, and the trace of model requests arriving" src="docs/assets/reel-views-light.gif" width="100%">
  </picture>
</p>

### 02 · Team

Team members are agents with a fixed role and long-term memory. Give recurring work its own member: a QA reviewer for a project, a release engineer who packages builds, or a personal finance assistant. Members remember what they learn on each job, so you do not have to explain the background again.

- **Create members from a conversation**: In any session, ask the agent to turn the current conversation into a team member. It writes the role, the lessons distilled from the conversation, the projects it owns, the agent it runs on, and its permissions in one step. Keep refining it the same way, or create members by hand on the team page.
- **Role and memory**: Each member's role lives in its own `AGENTS.md`, and what it learns goes into its own memory files, which are consolidated and deduplicated every night.
- **Scope**: A member can handle personal matters only, own specific code projects, or work across projects. The code, tasks, and sessions it can see are limited to that scope.
- **Permissions**: Editing code, managing tasks, running in the background, calling other members, and using the browser and MCP tools are each enabled per member. Every member has its own models, MCP servers, and skills.
- **Background runs**: Members can work on a schedule, or start on their own when a web page changes, a GitHub release ships, or a task changes status, with a cap on runs per day.
- **Conversation mode**: A member can keep one ongoing conversation, or start each job in a new session, with past runs collected on its page.
- **@ members**: In any session, `@member` asks it a question or hands it a job. The member works in its own session and the result comes back to the current conversation.
- **Inbox**: Actions a member needs you to approve and important updates it reports are collected in the inbox, with a notification to let you know.

Members run on Claude Code, Codex, Cursor, or Antigravity. Every job a member does is a real CLI session that you can open, interject in, or take over at any time. See [Team and members](docs/TEAM.md).

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/reel-team-dark.gif">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/reel-team-light.gif">
    <img alt="In a pocket-android release session, the agent is asked to turn the work into a member that owns releases, and Release appears in the team list; its rules written from the conversation and its permissions open; then @QA in atlas-api is asked to verify the limiter change before merging, and QA's reply comes back to the session" src="docs/assets/reel-team-light.gif" width="100%">
  </picture>
</p>

### 03 · Agents together

- **Agent calls**: `@` another agent in a session to ask it a question or have it make changes. It runs in its own session, which you can watch and join at any time.
- **Model discussions**: Several models can debate, hold a roundtable, cross-examine each other, or review a document around the same question, and reach a conclusion.
- **Parallel attempts**: Hand one task to several agents at once, each implementing it in its own Git worktree, then compare and keep the best result.
- **Task board**: Tasks can depend on each other: once one is accepted, the next starts on its own, and another agent can be assigned to verify a delivery.
- **Automations**: Scheduled and recurring tasks; agents can also arrange to come back to the current session later and continue.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/reel-agents-dark.gif">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/reel-agents-light.gif">
    <img alt="Mentioning Codex in a prompt, Claude calling it inside the turn, a one-on-one debate between two models with a verdict, and accepting a review that starts the next task on the board" src="docs/assets/reel-agents-light.gif" width="100%">
  </picture>
</p>

### 04 · Devices and linked servers

- **Every device in sync**: The browser, macOS, iPhone, and Android stay in sync on the same session live. Phones pair by QR code, and one client can connect to several servers.
- **IM bots**: Talk to agents and answer permission prompts through Feishu and Telegram bots, with each chat bound to a project.
- **Linked servers**: Once servers are linked, one web workbench shows and creates sessions on all of them, and agents can be authorized to run commands on the other servers.
- **Connection security**: The apps reach the server over TLS end to end. Device credentials are kept in the phone's secure hardware and do not work if copied elsewhere. Linked servers show the same verification code on both ends, so you can confirm no one is in the middle, and existing devices are notified when a new one joins.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/reel-link-dark.gif">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/reel-link-light.gif">
    <img alt="A terminal runs riffet link ssh devbox; on the web, devbox is picked as the server on the new-task page and the session runs there; then a pairing code on the web is scanned by the Android app, which opens on the task list" src="docs/assets/reel-link-light.gif" width="100%">
  </picture>
</p>

### 05 · Plugins and appearance

Riffet has a complete plugin system that extends agent backends, model sources, session views, side panels, pages, commands, themes, and IM channels, with custom themes, wallpapers, and logos. Built-in plugins run inside the server process; third-party plugins run isolated by default. Public plugins are listed in the [plugin marketplace](https://riffable.github.io/riffet/plugins/); see the [plugin guide](docs/PLUGINS.md) to write one.

```bash
riffet plugin dev ./my-plugin
riffet plugin pack ./my-plugin --out my-plugin.tgz
riffet plugin install my-plugin.tgz
```

| Extension point | Built in | Official and examples |
| :--- | :--- | :--- |
| Agent backend *(experimental)* | `cursor`, `antigravity` | `example.echo` |
| Model source | — | `riffet.litellm`, `example.gateway-models` |
| Session view | `canvas`, `trace` | — |
| Side panel | `browser` | `riffet.android`, `example.session-stats` |
| Page | `code-studio` | `example.workbench-sample` |
| Command | `translate` | — |
| Appearance | `avatars` | `riffet.appearance-paper`, `example.tux-theme`, `example.graphite-theme`, `example.mono-icons` |
| IM channel, sharing, speech | `channel-feishu`, `channel-telegram`, `speech-local` | `riffet.share-s3` |

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/reel-plugins-dark.gif">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/reel-plugins-light.gif">
    <img alt="The plugin page and a source’s catalog, the Android build panel beside a session running its log up close, and Code Studio opening a definition from a search" src="docs/assets/reel-plugins-light.gif" width="100%">
  </picture>
</p>

---

## Agent matrix

| Agent | CLI | Structured Chat | Live TUI | Mid-Turn Steer | Subagent View | Riffet MCP & Wakeups | Per-Chat MCP / Skill Toggle | @ Session | Callable as @ Agent | Terminal Import / Resume | Team Member |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| Claude Code | `claude` | ✓ | ✓ (`tmux`) | ✓ | ✓ | ✓ | MCP + Skills | ✓ | consult, work | ✓ | ✓ |
| Codex | `codex` | ✓ | ✓ (`--remote`) | ✓ | ✓ | ✓ | MCP | ✓ | consult, work | ✓ | ✓ |
| Cursor | `cursor-agent` | ✓ | ✓ (`tmux`) | ✓ | ✓ | ✓ | — | ✓ | work | — | ✓ |
| Antigravity | `agy` (`1.5.6+`) | ✓ | ✓ (`tmux`) | — | ✓ | ✓ | — | ✓ | work | — | ✓ |
| TRAE CLI | `traex` | ✓ | ✓ (native) | ✓ | ✓ | ✓ | MCP | ✓ | consult, work | — | — |
| DeepSeek Harness | `dsh` (`0.2.0-rc.2+`) | ✓ | — | — | ✓ | — | — | ✓ | work | — | — |
| Factory Droid | `droid` | ✓ | — | — | ✓ | ✓ | — | ✓ | work | — | — |
| pi | `pi` (`1.4.0+`) | ✓ | — | — | — | ✓ | — | ✓ | work | — | — |

**Callable as @ Agent**: `consult` is read-only; `work` runs in a new Git worktree and can edit files. Any agent with Riffet MCP can make the call.

CLI paths can be set through `RIFFET_CLI`, `CLAUDE_CLI`, `CODEX_CLI`, `DSH_CLI`, `DROID_CLI`, `TRAEX_CLI`, or `PI_CLI`, or under **Settings → Models** (including `agy`); other backends plug in through [`@riffet/plugin-api`](docs/PLUGINS.md).

---

## Reliability

| Capability | Implementation | Reference |
| :--- | :--- | :--- |
| Process isolation | Claude Code and Cursor run in Riffet-managed `tmux`, and Codex and TRAE CLI in a separate app-server, so a server restart does not interrupt their turns; Droid, pi, and DeepSeek Harness exit with the server. | [Delivery](docs/DELIVERY.md) |
| At-most-once delivery | Each session’s inputs are queued serially and confirmed by a transcript or hook receipt from the agent; unconfirmed messages are not resent after a crash. | `apps/server/src/native/dispatch.property.test.ts` |
| Resumable sync | Session content and sync progress are written in one transaction; after a disconnect, clients continue from where they left off with no gaps or duplicates. | [Sync](docs/SYNC-V3.md) |
| CLI regression detection | Real CLI sessions are recorded and replayed in tests; `pnpm record <cli> all --check` re-records with the installed version and compares. | `scripts/record.ts` |
| Integrity checks and restore | Session records are append-only; database integrity is checked at startup, `riffet doctor` reports missing and orphaned data, and checksummed backups restore with `riffet restore`. | [Operations](docs/guide/operations.md) |
| Resource limits | Limits for caches, storage, and CLI processes are defined in one place and shared with the mobile apps; idle CLIs are reclaimed by last use and a memory budget. | [Performance](docs/guide/performance.md) |

---

## How the clients differ

The web client has the full feature set and installs as a PWA; the team is available on the web, iPhone, and Android; linked servers, agent calls, model collaboration, the task board, trace, and Code Studio are currently web-only.

- **macOS**: native SwiftUI + AppKit app with a bundled server, permission prompts in the menu bar, Shortcuts, widgets, and Spotlight; once authorized, agents can capture windows, use the clipboard, and post notifications.
- **iPhone**: native SwiftUI app with answering permission prompts and replying from push notifications (bring your own APNs key), widgets, and a terminal.
- **Android**: Kotlin Multiplatform + Compose app with a touch terminal; with per-session authorization and biometric confirmation, agents can operate the phone (preview).

---

## Architecture

Riffet is a single-node server between its clients and the agent CLIs installed on the same host. A command takes one path to the agent; what the agent does returns on another, assembled into one timeline that every client renders alike.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/architecture/system-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/architecture/system-light.svg">
    <img alt="Riffet system architecture: clients, the server's Access, Session core (Delivery, Journal, Timeline, Sync) and Agent integration subsystems with Automation, Workspace, Derived views, Extension and Platform around them, and the agent CLI below; commands flow down, events and rows flow up" src="docs/assets/architecture/system-light.svg" width="100%">
  </picture>
</p>

Design principles:

1. **The vendor CLI is the agent.** Riffet drives the installed program through its own interface and does not reimplement it.
2. **One session model.** Differences between agents end at the driver contract; nothing above it names a vendor.
3. **Commands and observations are separate paths.** A message is delivered when its receipt is observed, not when it was written.
4. **The journal is the source of truth.** Timeline, status, usage, and search are projections of it.
5. **The server folds, clients render.** Every client resumes from a cursor and receives the same rows.
6. **Single node.** One process with embedded SQLite (three databases and a blob store) and one user; no external service is required. Linked servers are peers and share no data.
7. **Dependencies point inward.** Client-facing layers and drivers depend on the core, never the reverse; optional capability arrives as a plugin.

Each subsystem, the import layering, and the runtime topology (processes, files, interfaces) have a figure of their own in [docs/guide/architecture.md](docs/guide/architecture.md).

---

## Development

```bash
pnpm dev               # API server on :4317
pnpm dev:web           # Vite web workbench on :5173
pnpm typecheck
pnpm test
pnpm check:plugins
pnpm build
```

Native clients live in `apps/macos` and `apps/mobile`:

```bash
# Shared Kotlin Multiplatform & Android JVM tests (JDK 21+ and Android SDK)
cd apps/mobile
./gradlew :contracts:jvmTest :core:jvmTest :terminal:jvmTest :client:jvmTest :shared:jvmTest

# Native macOS app (macOS 15+, Xcode 26, JDK 17+, XcodeGen)
cd apps/macos
./scripts/build.sh dev        # build, install to build/Release, and relaunch
./scripts/release.sh          # build signed & notarized DMG
```

The checks to run before opening a pull request, and the npm packaging steps, are in [CONTRIBUTING.md](CONTRIBUTING.md).

## Documentation

Design and operations documents under `docs/` are written mainly in Chinese:

- **Guides**: [Conversations, Models & Sessions](docs/guide/conversation.md) · [Cursor CLI & Custom Gateways](docs/guide/cursor.md) · [Workspace, Previews & Git](docs/guide/workspace.md) · [Remote Access](docs/guide/remote-access.md) · [Operations & Deployment](docs/guide/operations.md) · [Architecture](docs/guide/architecture.md) · [Release & Distribution](docs/RELEASE.md)
- **Workflows**: [Team & Members](docs/TEAM.md) · [Task Board](docs/TASK-BOARD.md) · [Review & Orchestration](docs/ORCHESTRATION.md) · [Agent Calls](docs/AGENT-CALLS.md) · [Mid-Turn Steering](docs/STEER.md) · [Side Chats](docs/DISCUSSIONS.md) · [Quick Chat](docs/QUICK-CHAT.md) · [Bookmarks & Highlights](docs/MARKS.md) · [Session Sharing & PDF](docs/SHARES.md) · [Usage & Throughput Stats](docs/STATS.md)
- **Surfaces & Channels**: [Design System](docs/design/system/README.md) · [Web](docs/WEB.md) · [macOS](docs/MACOS.md) · [Android & Mobile](docs/MOBILE.md) · [iPhone](docs/IOS.md) · [Mobile Terminal](docs/MOBILE-TERMINAL.md) · [IM Channels](docs/design/channels.md) · [Riffet Browser](docs/BROWSER.md) · [Code Studio](docs/CODE-STUDIO.md) · [Trace](docs/TRACE.md) · [Voice Input](docs/VOICE.md) · [Devices & Riffet MCP](docs/DEVICES.md) · [Server Links](docs/SERVER-LINKS.md) · [Themes](docs/THEMES.md)
- **Extensibility & Ops**: [Extensions](docs/EXTENSIONS.md) · [Plugin Guide](docs/PLUGINS.md) · [Plugin Architecture](docs/PLUGIN_ARCHITECTURE.md) · [Antigravity CLI](docs/ANTIGRAVITY.md) · [TRAE CLI](docs/TRAEX.md) · [pi RPC](docs/PI.md) · [Updates](docs/UPDATE.md) · [Delivery](docs/DELIVERY.md) · [Sync](docs/SYNC-V3.md) · [Security Model](docs/SECURITY.md) · [Transport & Identity Security](docs/TRANSPORT-SECURITY.md)

## Acknowledgements and license

Visual design draws inspiration from [ZCode](https://github.com/zai-org/ZCode) and [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness); the DSH backend bridge adapts portions of DeepSeek Harness's MIT-licensed native interfaces with upstream notices preserved alongside the code.

Licensed under [Apache-2.0](LICENSE). Third-party notices are listed in [NOTICE](NOTICE); security vulnerabilities are reported privately as described in [SECURITY.md](SECURITY.md).
