<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/brand/lockup-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="docs/brand/lockup.svg">
  <img alt="Riffet" src="docs/brand/lockup.svg" height="52">
</picture>

### Keep the riff going.

Self-hosted server and clients for running coding-agent CLIs.

[![CI](https://github.com/riffable/riffet/actions/workflows/ci.yml/badge.svg)](https://github.com/riffable/riffet/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/riffable/riffet)](https://github.com/riffable/riffet/releases)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

English · [简体中文](README.zh-CN.md) · [Releases](https://github.com/riffable/riffet/releases) · [Issues](https://github.com/riffable/riffet/issues) · [Discussions](https://github.com/riffable/riffet/discussions) · [Changelog](CHANGELOG.md)

</div>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/hero-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/hero-light.png">
    <img alt="The Riffet web workbench with five sessions open as tabs, an agent’s design answer with a rendered sequence diagram, and the aside with outline, subagent, and output files, next to the same session on iPhone" src="docs/assets/hero-light.png" width="100%">
  </picture>
</p>

Riffet is a server for macOS and Linux that drives the coding-agent CLIs installed on its host. A session is stored on the server and can be started, read, steered, and resumed from any connected client: the web workbench, the native macOS, iPhone, and Android apps, or a Feishu / Lark bot.

- **Agents.** Riffet drives the official CLIs (Claude Code, Codex, Cursor, TRAE CLI, Factory Droid, DeepSeek Harness, pi) and reads each CLI’s native session store in place. Capabilities per agent are listed in the [agent matrix](#agent-matrix).
- **Data.** Code, terminals, credentials, and history stay on the server. Clients connect to it directly.
- **License.** Apache-2.0. Every feature is in the open-source build.

## Screenshots

**Pairing and multi-client sync.** A phone pairs by scanning one code; the session then updates on every connected client.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/reel-connect-dark.gif">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/reel-connect-light.gif">
    <img alt="A phone scans the pairing code on the desktop, then the same answer streams on the desktop and the iPhone at once, and the Mac, iPhone, and Android apps line up" src="docs/assets/reel-connect-light.gif" width="100%">
  </picture>
</p>

**Starting a session.** Agent selection, parallel attempts, import of a terminal session, model selection.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/reel-start-dark.gif">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/reel-start-light.gif">
    <img alt="Typing a prompt and choosing an agent, parallel attempts arriving one by one, the list of terminal sessions to continue, and the model picker" src="docs/assets/reel-start-light.gif" width="100%">
  </picture>
</p>

**Reading and keeping.** Streaming timeline, canvas, search, highlights saved to Favorites, sharing.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/reel-session-dark.gif">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/reel-session-light.gif">
    <img alt="An answer streams in with its sequence diagram, the view pages over to the canvas, a search for redis, a sentence highlighted and found in Favorites, and the share menu" src="docs/assets/reel-session-light.gif" width="100%">
  </picture>
</p>

**Appearance and plugins.** Palettes, light and dark modes, plugins.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/reel-shape-dark.gif">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/reel-shape-light.gif">
    <img alt="Dragging the colour point on a theme board recolours the page behind it, a light-to-dark wipe, the plugin list, and a plugin building an Android app" src="docs/assets/reel-shape-light.gif" width="100%">
  </picture>
</p>

## Features

### Deployment and pairing

- **Host.** The server runs on a Mac, a Linux machine, or a cloud VM, started by hand or as a launchd / systemd service. It listens on loopback by default and can be exposed to a LAN, a VPN, or an HTTPS reverse proxy.
- **Pairing.** `riffet pair` prints a single-use code valid for five minutes, and a QR code. A browser or the Mac app takes the code; the iPhone and Android apps scan the QR code.
- **Multiple servers.** The Mac, iPhone, and Android apps store several servers and switch between them.
- **Bundled server on macOS.** The macOS app bundles the server and connects to it without pairing.

### Sessions

- **Agent and model per session.** Each session selects its agent and model. Riffet drives the official CLI, so the CLI’s login, rules, skills, MCP servers, and subscription apply unchanged.
- **Terminal session import and hand-back.** A Claude Code or Codex session started in a terminal can be continued in Riffet and returned with **Resume in terminal** or `riffet resume`. One side writes at a time, so the transcript does not interleave.
- **Parallel attempts.** One prompt can be sent to 2–4 agents or models. Each attempt runs in its own Git worktree (a shadow repository for directories outside Git); the changes are compared side by side and one is adopted. *(Web, macOS)*
- **Steering.** An instruction can be added while a turn is running, without `Ctrl+C`, or queued for the next turn.
- **Side threads.** A selected part of an answer can be discussed in a side thread that stays out of the main timeline.
- **Quick chat.** A question that belongs to no project goes directly to a model, with web search and attachments. Entry points: `⌃⌥Space` on macOS; a tile, the share sheet, or selected text on Android. *(Web, macOS, Android)*
- **Scheduling.** A prompt can run once or on a cron schedule; agents can schedule their own wake-ups.
- **Search.** `⌘K` searches session titles and content.

### Models

- **Providers.** A provider is added by endpoint, key, and protocol (OpenAI Chat Completions or Responses, Anthropic Messages, Google Generative AI), or through a model-source plugin. Cursor can be routed through a custom gateway.
- **Quota and context.** The model picker shows the remaining quota of the Codex account; each session shows how much of its context window is used.
- **Auxiliary models.** Session titles, quick chat, handoff summaries, and canvas summaries each have their own model setting.
- **Switching.** A session can move to another model or provider of the same family and continue in place; across families it is handed off.

### Export, references, and handoff

- **Export.** Any session can be resumed in a terminal, exported as a PDF, or published through a share plugin as a read-only snapshot with an expiry. *(PDF and links: Web, macOS)*
- **Session references.** `@` cites an earlier session. The agent receives a short brief and a snapshot of the transcript that it can read further; the cited session is not modified. *(Claude Code, Codex)*
- **Handoff.** An idle session can be handed to another agent with a structured summary, for example when quota runs out.
- **Favorites.** Passages can be highlighted in four colors with a note; whole replies, images, and files can be saved. Each item keeps its own snapshot and stays readable after its session is deleted. *(Web, macOS)*

### Timeline, files, and Git

- **Timeline.** Tool calls fold into one line, edits open as diffs, and each subagent has its own transcript. Mermaid, D2, Graphviz, PlantUML, and Vega-Lite diagrams render locally, with KaTeX math and syntax highlighting for 45 languages.
- **Views.** A session can be shown as the timeline, the live terminal, or a canvas that lays out every turn with its commands and files. *(Web, macOS)*
- **File preview.** More than 20 file types preview locally, including sandboxed HTML, PDF, Office documents, Jupyter notebooks, SQLite, and 3D models.
- **Git.** Review changes, stage by line, commit, switch branches, pull, push, and open a pull request through `gh`. Every turn records a checkpoint to restore or fork from; comments on diff lines are sent back to the agent.

### Plugins

The canvas and the Cursor settings are plugins built on the public [plugin API](docs/PLUGINS.md). A plugin can contribute:

- agent backends *(experimental)* and model sources;
- views in the conversation, sidebar, side panel, main area, or settings *(Web, macOS)*;
- project tasks, for example building an Android app, installing and launching it, and following its Logcat;
- share publishers, commands, and actions such as a device-flow sign-in;
- palettes, icon packs, fonts, and backgrounds.

An installed package runs in an isolated process by default; built-in plugins run in the server process ([Plugin Architecture](docs/PLUGIN_ARCHITECTURE.md)). Published packages are listed in the [plugin market](https://riffable.github.io/riffet/plugins/). The CLI covers development, packaging, and installation:

```bash
riffet plugin dev ./my-plugin
riffet plugin pack ./my-plugin --out my-plugin.tgz
riffet plugin install my-plugin.tgz
```

### Interface

- **Tabs and aside.** Sessions stay open as tabs. The aside next to the conversation shows the plan, outline, subagents, background tasks, and output files. *(Tabs: Web, and macOS in the Riffet style)*
- **Themes.** Twelve built-in palettes (near-neutral ink on low-chroma paper) and a theme editor for custom ones.
- **Icons and interface styles.** The icon pack is replaceable. Interface styles: Native, Riffet, or Line on macOS; Material 3, iOS, Expressive, Miuix, or Fluent on Android.

### Clients

- **Web.** The complete workbench in a browser, served by the Riffet server.
- **macOS.** A native app with a bundled server. The menu bar lists running sessions and pending approvals; Shortcuts, widgets, and Spotlight are supported.
- **iPhone.** Permission prompts, diffs, remote folder browsing, and a terminal.
- **Android.** Five interface styles, a touch terminal, and quick chat from system entry points. In preview: an agent on the server can read and operate the phone, gated by a per-session switch and a biometric opt-in on the device.
- **Feishu / Lark.** The bot connects outbound over WebSocket and needs no public IP, domain, or tunnel. A project session is started or continued in a DM or a group topic, and approvals are answered in the chat.

---

## Quick start

### Prerequisites

- **macOS or Linux** with **Node.js `>= 24.19.0`** (`pnpm` is also required when building from source).
- **`tmux >= 3.2`**, required for Cursor and Claude Code sessions and for live terminal views.
- At least one [supported agent CLI](#agent-matrix), installed and signed in on the host.

### 1. Install

<!-- TODO(release): Uncomment/update download links once npm package and GitHub Release assets are published. -->

**Option A: build from source (available now)**

```bash
git clone https://github.com/riffable/riffet.git ~/.local/src/riffet
cd ~/.local/src/riffet
pnpm install && pnpm build

mkdir -p "$HOME/.local/bin"
ln -s "$HOME/.local/src/riffet/scripts/riffet.mjs" "$HOME/.local/bin/riffet"
```

**Option B: npm and prebuilt apps (not yet published)**

| Component | Channel | Notes |
| :--- | :--- | :--- |
| Server and web workbench | `npm install -g riffet` *(upcoming)* | Upgrade with `npm i -g riffet@latest && riffet restart`. Do not run it through `npx`: hook and MCP paths must stay permanent |
| macOS app | [`Riffet.dmg` on Releases](https://github.com/riffable/riffet/releases) *(upcoming)* | macOS 15+, Apple Silicon; bundles the server runtime |
| Android app | [`APK` on Releases](https://github.com/riffable/riffet/releases) *(upcoming)* | Pairs by QR code, or by address and one-time code |
| iPhone app | Source build (`apps/mobile/iosApp`) | iOS 18+; signed with your own Apple team ID ([guide](apps/mobile/iosApp/README.md)) |

### 2. Check the environment and start

```bash
riffet doctor                  # checklist for Node, tmux, the agent CLIs, port, and permissions
riffet start --workspace .     # start the background daemon and register the current repository
riffet                         # open http://127.0.0.1:4337/ in a browser
```

### 3. Connect other devices

The server listens on `127.0.0.1` by default. To reach it from other devices over a LAN, Tailscale / VPN, or an HTTPS proxy:

```bash
riffet restart --host 0.0.0.0 --auth
riffet pair                    # prints reachable URLs, a five-minute single-use code, and a QR code
```

The iPhone and Android apps scan the QR code; a remote browser or the Mac app takes the code. A Feishu / Lark bot is connected under **Settings → Bots** (outbound WebSocket, no public endpoint). `--allow-host` and `riffet pair --url` for tunnels are covered in [Remote Access](docs/guide/remote-access.md).

<details>
<summary><strong>CLI commands and defaults</strong></summary>

```bash
riffet                 # start the background server (if stopped) and open a browser
riffet status          # show daemon status, listen address, and state directory
riffet pair            # generate a five-minute single-use pairing code and QR code (--url for tunnels)
riffet stop            # stop the web server; live tmux agent terminals keep running
riffet restart         # restart with the saved listener and auth settings
riffet logs -f         # tail server logs; tokens are redacted
riffet token           # print the admin token to stdout (e.g. riffet token | pbcopy)
riffet login-url       # print a one-step browser login URL
riffet doctor          # inspect the environment (--json for a machine-readable report)
riffet update --check  # check origin for newer stable vX.Y.Z release tags
riffet update          # update a clean source release checkout and restore the daemon
riffet plugin --help   # develop, pack, install, and diagnose plugins
```

Defaults: `http://127.0.0.1:4337/`, default backend `cursor-agent`, private state directory `~/.local/share/riffet` (`0700` directory, `0600` secrets), no token on loopback. Overrides: `--port`, `--host`, `--cli`, `--state-dir`, `--workspace`, `--allow-host`; `--port`, `--host`, `--cli`, and `--state-dir` also read `RIFFET_PORT`, `RIFFET_HOST`, `RIFFET_CLI`, and `RIFFET_STATE_DIR`.

</details>

---

## Agent matrix

| Agent | CLI | Structured Chat | Live TUI | Mid-Turn Steer | Subagent View | Riffet MCP & Wakeups | Per-Chat MCP / Skill Toggle | @ Session | Terminal Import / Resume |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Cursor** | `cursor-agent` | ✓ | ✓ (`tmux`) | ✓ | ✓ | — | — | — | — |
| **Claude Code** | `claude` | ✓ | ✓ (`tmux`) | ✓ | ✓ | ✓ | MCP + Skills | ✓ | ✓ |
| **Codex** | `codex` | ✓ | ✓ (`--remote`) | ✓ | ✓ | ✓ | MCP | ✓ | ✓ |
| **DeepSeek Harness** | `dsh` (`0.2.0-rc.2+`) | ✓ | — | — | ✓ | — | — | — | — |
| **Factory Droid** | `droid` | ✓ | — | — | ✓ | ✓ | — | — | — |
| **TRAE CLI** | `traex` | ✓ | ✓ (native) | ✓ | ✓ | ✓ | MCP | — | — |
| **pi** | `pi` (`1.4.0+`) | ✓ | — | — | — | ✓ | — | — | — |

A CLI path is set with `RIFFET_CLI`, `CLAUDE_CLI`, `CODEX_CLI`, `DROID_CLI`, `TRAEX_CLI`, or `PI_CLI`, or per profile under **Settings → Models**. Other providers, views, and themes are added as plugin packages built with [`@riffet/plugin-api`](docs/PLUGINS.md).

---

## Architecture

Riffet is a single-node server between its clients and the agent CLIs installed on the same host. A command takes one path to the agent; what the agent does returns on another, folded into rows that every client renders alike.

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
4. **The journal is the source of truth.** Timeline, status, usage and search are projections of it.
5. **The server folds, clients render.** Every client resumes from a cursor and receives the same rows.
6. **Single node.** One process, one database file, one user; no external service is required.
7. **Dependencies point inward.** Surfaces and drivers depend on the core, never the reverse; optional capability arrives as a plugin.

| Subsystem | Responsibility | Code |
| :--- | :--- | :--- |
| Clients | Render rows, keep a replica and a cache of them, send commands | `apps/web`, `apps/mobile`, `apps/macos` |
| Access | Authenticates devices, terminates HTTP, SSE and WebSocket, adapts chat channels | `apps/server/src/auth.ts`, `apps/server/src/routes`, `apps/server/src/channels` |
| Session core: Delivery | Queues a message, admits one turn at a time, writes it at most once, tracks it to a receipt | `apps/server/src/native` |
| Session core: Journal | Append-only event log, ordered per session | `apps/server/src/journal` |
| Session core: Timeline | Folds events into the rows clients render | `apps/server/src/timeline`, `packages/timeline` |
| Session core: Sync | Streams rows to each client from its cursor | `apps/server/src/sync` |
| Agent integration | One driver per agent behind one contract; terminal host, hook bridge, tool bridge | `apps/server/src/backends`, `apps/server/src/terminal`, `apps/server/src/riffet-mcp` |
| Automation | Issues commands without a person: schedules, tasks, hand-offs | `apps/server/src/orchestration`, `apps/server/src/tasks` |
| Workspace | Files, git and working trees of the directories agents work in | `apps/server/src/workspace`, `apps/server/src/git` |
| Derived views | Read models built from the journal: usage, search index, titles, shares | `apps/server/src/stats`, `apps/server/src/search`, `apps/server/src/shares` |
| Extension | Loads plugins at declared extension points; installed packages run isolated | `apps/server/src/plugins-host`, `packages/plugin-api` |
| Platform | SQLite store, settings, process execution, service lifecycle | `apps/server/src/store.ts`, `apps/server/src/exec.ts` |

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

Automated tests follow [AGENTS.md](AGENTS.md): a test is added only when necessary, and tests cover authentication, data isolation, protocol contracts, idempotency, persistence, concurrency, and failure recovery, not UI snapshots or styling. The checks to run before opening a pull request are in [CONTRIBUTING.md](CONTRIBUTING.md).

## Documentation

Design and operations documents under `docs/` are written mainly in Chinese:

- **Guides**: [Conversations, Models & Sessions](docs/guide/conversation.md) · [Cursor CLI & Custom Gateways](docs/guide/cursor.md) · [Workspace, Previews & Git](docs/guide/workspace.md) · [Remote Access](docs/guide/remote-access.md) · [Operations & Deployment](docs/guide/operations.md) · [Architecture](docs/guide/architecture.md)
- **Workflows**: [Review & Orchestration](docs/ORCHESTRATION.md) · [Mid-Turn Steering](docs/STEER.md) · [Side Chats](docs/DISCUSSIONS.md) · [Quick Chat](docs/QUICK-CHAT.md) · [Bookmarks & Highlights](docs/MARKS.md) · [Session Sharing & PDF](docs/SHARES.md) · [Usage & Throughput Stats](docs/STATS.md)
- **Surfaces & Channels**: [Web](docs/WEB.md) · [macOS](docs/MACOS.md) · [Android & Mobile](docs/MOBILE.md) · [iPhone](docs/IOS.md) · [Mobile Terminal](docs/MOBILE-TERMINAL.md) · [Feishu / IM Channels](docs/design/channels.md) · [Devices & Riffet MCP](docs/DEVICES.md) · [Themes](docs/THEMES.md)
- **Extensibility & Ops**: [Extensions](docs/EXTENSIONS.md) · [Plugin Guide](docs/PLUGINS.md) · [Plugin Architecture](docs/PLUGIN_ARCHITECTURE.md) · [TRAE CLI](docs/TRAEX.md) · [pi RPC](docs/PI.md) · [Updates](docs/UPDATE.md) · [Security Model](docs/SECURITY.md)

## Acknowledgements and license

Visual design draws inspiration from [ZCode](https://github.com/zai-org/ZCode) and [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness); the DSH backend bridge adapts portions of DeepSeek Harness's MIT-licensed native interfaces with upstream notices preserved alongside the code.

Licensed under [Apache-2.0](LICENSE). Third-party notices are listed in [NOTICE](NOTICE); security vulnerabilities are reported privately as described in [SECURITY.md](SECURITY.md).
