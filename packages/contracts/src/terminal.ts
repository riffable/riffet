/** Opaque RGB colours, normalized as #rrggbb. Bound to the CLI process, not a viewer's theme. */
export interface TerminalAppearance { foreground: string; background: string; }
export const TERMINAL_APPEARANCE_HEADER = 'x-riffet-terminal-appearance';
export interface TerminalInfo {
  id: string; projectId: string; sessionId?: string; title: string;
  kind: 'shell' | 'cursor' | 'native' | 'login'; state: 'running' | 'exited' | 'detached';
  persistent: boolean; ownerId?: string; epoch: number; cols: number; rows: number;
  createdAt: string; exitCode?: number;
  appearance?: TerminalAppearance;
  /** Current working directory reported by tmux or OSC 7 when known. */
  cwd?: string;
  /** Foreground process name reported by tmux (`pane_current_command`) when known. */
  foregroundCommand?: string;
  /** Dynamic title set by the running program (OSC 0/2 or tmux `pane_title`). */
  paneTitle?: string;
  /**
   * A shell's shell integration (OSC 133) reports a command started at the prompt that has not
   * finished. Absent until the shell reports a boundary, so a shell without integration stays unknown.
   */
  commandRunning?: boolean;
}
/** The live grid's dimensions and one-based row positions. Blank cells do not count as content. */
export interface TerminalGridDiagnostics {
  cols: number;
  rows: number;
  cursorRow: number;
  lastContentRow: number | null;
}
/**
 * Terminal socket protocol 3 (docs/TERMINAL.md): `output` is the pane's own output and a
 * `snapshot` seeds one emulator with the pane's scrollback, screen, cursor and modes, so a
 * client keeps its own scrollback. Protocol 2 snapshots carry the screen only.
 */
export const TERMINAL_PROTOCOL = 3;
/**
 * Terminal socket protocol 4 (docs/TERMINAL-SOTA.md): binary data frames for output, optionally
 * deflate-raw compressed snapshots, raw input, and application-level ping/pong heartbeats.
 * Control messages (`claim`, `release`, `resize`, `paste`, `ack`, `state`, `error`, `exit`) stay JSON.
 */
export const TERMINAL_BINARY_PROTOCOL = 4;
/** Leading type byte for protocol 4 binary WebSocket frames. */
export const TERMINAL_WIRE_FRAME = {
  OUTPUT: 0x01,
  SNAPSHOT_RAW: 0x02,
  SNAPSHOT_DEFLATE: 0x03,
  INPUT: 0x04,
  PING: 0x05,
  PONG: 0x06,
} as const;
/** Scrollback rows a seed carries and a client emulator keeps. */
export const TERMINAL_SCROLLBACK_ROWS = 10_000;
/** A client acks written output in steps of this many characters. */
export const TERMINAL_ACK_CHARS = 5_000;
export type TerminalClientMessage =
  | { type: 'claim'; clientId: string; takeover?: boolean }
  | { type: 'input'; clientId: string; epoch: number; data: string }
  | { type: 'resize'; clientId: string; epoch: number; cols: number; rows: number }
  | { type: 'release'; clientId: string; epoch: number }
  /** Protocol 3: characters of `output`/`snapshot` data the emulator has finished writing. */
  | { type: 'ack'; chars: number }
  /** Protocol 3: pasted text; the server lets tmux decide on bracketed paste. */
  | { type: 'paste'; clientId: string; epoch: number; data: string };
export type TerminalServerMessage =
  | { type: 'output'; data: string; sequence: number; streamId?: string }
  /** Replaces everything the client shows: reset, resize to `cols`×`rows`, then write `data`. */
  | { type: 'snapshot'; data: string; sequence: number; cols: number; rows: number; streamId: string }
  | { type: 'state'; terminal: TerminalInfo }
  | { type: 'error'; code: string; message: string }
  | { type: 'exit'; exitCode?: number };
/** A user paste into an existing terminal; preparation never submits a new conversation turn. */
export interface TerminalAttachmentPaste {
  clientId: string; epoch: number; requestId: string; attachmentIds: string[]; text?: string;
}
export interface TerminalPasteResult { requestId: string; status: 'completed' | 'unknown'; }
/** A server-configured shell launch preset (B-class setting, docs/TERMINAL-SOTA.md §3.3). */
export interface TerminalProfile {
  id: string;
  name: string;
  /** Executable path or shell binary; unset falls back to the server's default shell. */
  command?: string;
  args?: string[];
  /** Optional starting working directory; unset uses the project's workspace directory. */
  cwd?: string;
  env?: Record<string, string>;
}
/** Server-local terminal launch configuration (B-class setting). */
export interface TerminalServerSettings {
  /** Default interactive shell executable path; unset uses `$SHELL` or `/bin/sh`. */
  defaultShell?: string;
  /** Inject lightweight OSC 133/7 shell integration for zsh/bash/fish. Defaults to true when unset. */
  shellIntegration?: boolean;
  /** Named shell launch presets available when creating a new shell terminal. */
  profiles?: TerminalProfile[];
}
