# Changelog

User-visible changes only. [简体中文](CHANGELOG.zh-CN.md)

## Unreleased

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
