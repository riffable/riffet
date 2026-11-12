/** Opaque RGB colours, normalized as #rrggbb. Bound to the CLI process, not a viewer's theme. */
export interface TerminalAppearance { foreground: string; background: string; }
export const TERMINAL_APPEARANCE_HEADER = 'x-riffet-terminal-appearance';
export interface TerminalInfo {
  id: string; projectId: string; sessionId?: string; title: string;
  kind: 'shell' | 'cursor' | 'native' | 'login'; state: 'running' | 'exited' | 'detached';
  persistent: boolean; ownerId?: string; epoch: number; cols: number; rows: number;
  createdAt: string; exitCode?: number;
  appearance?: TerminalAppearance;
}
/**
 * Terminal socket protocol 3 (docs/TERMINAL.md): `output` is the pane's own output and a
 * `snapshot` seeds one emulator with the pane's scrollback, screen, cursor and modes, so a
 * client keeps its own scrollback. Protocol 2 snapshots carry the screen only.
 */
export const TERMINAL_PROTOCOL = 3;
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
