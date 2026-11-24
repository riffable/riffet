import { constants as osConstants } from 'node:os';
import type {
  NativeBackendId, TerminalAppearance, TerminalInfo, TerminalServerMessage, TerminalServerSettings,
} from '../../../../packages/contracts/src/index.js';
import { TERMINAL_BUDGET, TERMINAL_SCROLLBACK_ROWS } from '../../../../packages/contracts/src/index.js';
import { normalizeWarmup } from '../session-identity.js';
import { AppError } from '../errors.js';
import { exec, ExecError } from '../exec.js';
import type { ControlClient } from './control.js';
import type { OuterTerminalState } from './protocol-state.js';

/**
 * How the terminal service reads the panes of an Agent: pure functions of the pane's recent text
 * (control sequences stripped, generic secrets redacted), supplied by the backend (`AgentBackend.terminal`).
 */
export interface TerminalBehaviour {
  /** The title of a terminal whose launch gave none. */
  title?: string;
  /** Whether the pane shows the Agent past its startup. Until it first does, an exit is read as a failed start. */
  ready?(paneText: string): boolean;
  /** The message for an Agent that exited before it was ready; undefined when the output explains nothing. */
  startupError?(paneText: string): string | undefined;
}

/** See `AgentLaunchEnv`: names handed to a pane through the host's environment, and the credentials among them. */
export interface TerminalLaunchEnv {
  readonly managed: readonly string[];
  readonly secrets?: readonly string[];
}

/** Which Agent a terminal belongs to is the host's knowledge, not the terminal service's: it asks. */
export interface TerminalBehaviourSource {
  /** The behaviour of the Agent behind a terminal of this kind, found through its session or, for a reservation, its backend. */
  resolve(target: { kind: TerminalInfo['kind']; sessionId?: string; backendId?: NativeBackendId }): TerminalBehaviour | undefined;
  /** The launch environment names of every Agent the host knows. */
  launchEnv(): TerminalLaunchEnv;
}

export interface TerminalServiceOptions {
  stateDir: string;
  behaviour?: TerminalBehaviourSource;
  /**
   * A temp instance (a test, a probe, a demo): `closeAll` also ends the tmux server and the CLIs in it,
   * since nothing comes back for them (docs/guide/performance.md §3.10).
   */
  ephemeral?: boolean;
  /** Override idle-detach delay for ordinary shells (defaults to `TERMINAL_BUDGET.idleDetachMs`). */
  idleDetachMs?: number;
  /** Server-local B-class terminal settings (default shell, shell integration, profiles). */
  shellSettings?: () => TerminalServerSettings | undefined;
}

export interface TerminalCreateInput {
  appearance?: TerminalAppearance;
  sessionId?: string;
  kind?: TerminalInfo['kind'];
  title?: string;
  cols?: number;
  rows?: number;
  /** Arguments of a shell; every other kind is launched from `launchSpec`. */
  args?: string[];
  /** Optional B-class server shell profile id (only for `kind === 'shell'`). */
  profileId?: string;
  /** Optional starting directory for a new shell (e.g. inherited from an active terminal's CWD). */
  cwd?: string;
  /** Trusted server adapter launch specification (kinds other than `shell`). Browser terminal requests cannot provide this. */
  launchSpec?: { command: string; args: string[]; env?: Record<string, string>; secretEnv?: Record<string, string>; cwd: string; launchMarker?: string };
  /** A live terminal of the session (same kind) is returned instead of launching another; concurrent creations of one session share one start. */
  reuseLive?: boolean;
  /** Private temporary agent runtime, omitted from normal terminal lists. */
  warmup?: TerminalWarmupMetadata;
}

export interface TerminalWarmupMetadata {
  ownerToken: string;
  resourceKey: string;
  /** The Agent conversation the reserved process was started with; the session adopts it on claim. */
  nativeSessionId: string;
  expiresAt: number;
  /** The backend that owns the reservation; rows written before it was recorded read as the legacy default (`normalizeWarmup`). */
  backendId?: NativeBackendId;
}

export type WarmupTerminalInfo = TerminalInfo & { warmup: TerminalWarmupMetadata };

/** A terminal that runs an Agent's CLI for a conversation; `cursor` is the spelling the first Agent's terminals have always had on the wire. */
export const isAgentTerminal = (kind: TerminalInfo['kind']): boolean => kind === 'native' || kind === 'cursor';

export function isWarmupTerminal(info: TerminalInfo): info is WarmupTerminalInfo {
  const warmup = (info as WarmupTerminalInfo).warmup;
  return Boolean(warmup && typeof warmup.ownerToken === 'string' && typeof warmup.resourceKey === 'string');
}

/** A reservation's metadata with the stored row's older spellings read (see `normalizeWarmup`). */
export function warmupOf(info: WarmupTerminalInfo): TerminalWarmupMetadata & { backendId: NativeBackendId } {
  return normalizeWarmup(info.warmup);
}

/**
 * Server-side observation of a terminal, independent of browser websocket listeners.
 * Output observations carry the pane's decoded output (no parsing is done here). State and
 * exit observations mirror what subscribe() receives, so observers can stop watching
 * when the terminal disappears. Observers are advisory: a throwing observer never
 * interrupts terminal handling.
 */
export type TerminalObservation =
  | { type: 'output'; terminalId: string; data: string; sequence: number }
  | { type: 'state'; terminalId: string; terminal: TerminalInfo }
  | { type: 'exit'; terminalId: string; exitCode: number };

export type TerminalObserver = (observation: TerminalObservation) => void;

export interface TerminalInteractionControl {
  /** `styled` keeps the SGR sequences (`capture-pane -e`): for a focus a TUI draws only as styling. */
  screen(options?: { styled?: boolean }): Promise<string | undefined>;
  keys(keys: string[]): Promise<void>;
  paste(text: string, submit: boolean): Promise<void>;
}

export interface TerminalRuntime {
  terminalId: string;
  control: ControlClient;
  /** tmux's id of the session's pane (`%3`): the target of keys and the filter of control output. */
  pane: string;
  kind: TerminalInfo['kind'];
  sequence: number;
  streamId: string;
  /** Modes the pane's own output set that tmux has no format for. */
  modes: OuterTerminalState;
  output: OutputTail;
  /** Output decoded in one read of the control stream, delivered together (see `flushOutput`). */
  pending: string[];
  lastOutputAt: number;
  attachedAt: number;
  snapshotGeneration: number;
  /** When a pending resize reseed stops waiting for quiet. */
  reseedBy?: number;
  /** The Agent's pane behaviour, found when the pane was attached. */
  behaviour?: TerminalBehaviour;
  /** Once ready, transcript text must never be reinterpreted as a startup failure. */
  agentReady?: boolean;
}

export interface InteractionTransaction {
  runtime: TerminalRuntime;
  epoch: number;
  authorize?: () => void;
  beforeWrite?: () => void;
  writeStarted?: boolean;
}

/** One websocket watching a terminal. Its output is gated while a seed is in flight, and metered by the client's acks. */
export interface Viewer {
  send: (message: TerminalServerMessage) => void;
  protocol: number;
  /** Characters sent (protocol 3) that the client has not yet confirmed writing. */
  unacked: number;
  /** Length of the last snapshot sent: the client acks it too, and it is not a sign of falling behind. */
  seedChars: number;
  /** A seed is on its way and already contains whatever output arrives meanwhile. */
  seeding: boolean;
  seedInFlight: boolean;
  seedTicket: number;
  closed: boolean;
}

export type TerminalSubscription = (() => void) & { ack(chars: number): void };

/** A process found in a native terminal's pane, running in the terminal's own project directory. */
export interface PaneProcess {
  pid: number;
  argv: string[];
  /** The pane's own process, the one tmux started, rather than one of its descendants. */
  root?: boolean;
}

/** A pane as tmux reports it, with the launch record written beside it. */
export interface PaneLaunchRecord {
  panePid: number;
  dead: boolean;
  marker?: string;
  launchPid?: number;
}

export interface ScreenRead {
  /** Write generation the capture started under; a later write makes it unusable. */
  generation: number;
  runtime?: TerminalRuntime;
  sequence?: number;
  startedAt: number;
  task: Promise<string | undefined>;
  text?: string;
  settled: boolean;
}

export const KIB = 1024;
export const MIB = KIB * KIB;
export const MAX_OUTPUT_CHARS = 512 * KIB;
/**
 * How long one plain capture of a pane answers every reader. Several pollers watch the same CLI
 * (status, dialogs, stop verification, submission checks); within this window they share a single
 * `tmux capture-pane` instead of each forking one. Any write to the pane, and any output from it,
 * ends the window early.
 */
export const SCREEN_CACHE_MS = 120;
export const MAX_INPUT_CHARS = 128 * KIB;
export const SNAPSHOT_OUTPUT_QUIET_MS = 150;
/** A CLI nobody is viewing renders at this size, so its dialogs fit unclipped for the web parser. */
export const BACKGROUND_COLS = 100;
export const BACKGROUND_ROWS = 40;
export const BACKGROUND_RESIZE_DELAY_MS = 3000;
export const REATTACH_DELAY_MS = 250;
/** How far back a dead pane is read for a startup error the stream did not carry. */
export const STARTUP_SCAN_LINES = 500;
export const HISTORY_LIMIT = TERMINAL_SCROLLBACK_ROWS;
/** A protocol 3 viewer this far behind its client's acks (beyond its own snapshot) is dropped to a fresh seed instead of queueing further. */
export const MAX_UNACKED_CHARS = 2_000_000;
export const SEED_RETRY_MS = 250;
export const SEED_RETRY_MAX_MS = 5000;
/** A resize reseed waits for the pane to go quiet, but not longer than this: a spinner never does. */
export const RESEED_MAX_WAIT_MS = 1000;
/** Full ANSI scrollback routinely exceeds the 1 MiB budget used for small tmux commands. */
// perf-rules: allow tmux capture-pane buffer ceiling moved from service.ts
export const HISTORY_CAPTURE_BYTES = 32 * MIB;
/** Rows a history tail may grow by between the version check and its capture and still append. */
export const HISTORY_TAIL_SLACK = 512;
export const REATTACH_MAX_DELAY_MS = 30_000;
/** A tmux client that exits sooner than this counts as a failed attach and backs off the next one. */
export const ATTACH_STABLE_MS = 5000;
/** How long a stopped pane's CLI gets to exit on the hang-up before it is signalled outright. */
export const PANE_HANGUP_GRACE_MS = 1000;
/** tmux option holding a native launch's marker; the name predates other drivers and live panes still carry it. */
export const LAUNCH_MARKER_OPTION = '@riffet-codex-launch';
/** tmux option holding the pane process the marker was written for; a pane whose process is another one has no record. */
export const LAUNCH_PID_OPTION = '@riffet-launch-pid';
export const LAUNCH_MARKER = /^[a-f0-9]{64}$/;
/** How long one read of every pane's launch record answers later readers; tmux is asked once for all of them. */
export const LAUNCH_RECORDS_FRESH_MS = 750;
export const MAX_PANE_PROCESSES = 32;
/**
 * Per-command cap inside a pane lookup's budget. A cold `lsof` or a tmux server busy with a
 * restart's reconnects can take a few hundred milliseconds; a tighter cap reads as "unverified"
 * and blocks writes to a terminal that was never wrong.
 */
export const LOOKUP_STEP_MS = 1000;
export const IDLE_DETACH_DEFAULT_MS = TERMINAL_BUDGET.idleDetachMs;
export const TMUX_TARGET_MISSING = /can't find (?:session|window|pane)|no server running|error connecting to/;

export function lookupStepTimeout(deadline: number): number {
  return Math.max(1, Math.min(LOOKUP_STEP_MS, deadline - Date.now()));
}

export function validDimension(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 2 || value > 1000) throw new AppError('INVALID_TERMINAL_SIZE', 'Terminal columns and rows must be integers between 2 and 1000');
  return value;
}

/** `env` absent is the server's current environment. */
export async function run(command: string, args: string[], timeout = 5000, env?: NodeJS.ProcessEnv, maxBuffer = MIB): Promise<string> {
  try { return (await exec(command, args, { timeout, maxBuffer, ...(env ? { env } : {}) })).stdout; }
  catch (error) {
    // Only tmux's own answer that the target is gone means gone; a timeout or any other failure says nothing.
    const missing = error instanceof ExecError && !error.killed && TMUX_TARGET_MISSING.test(error.stderr);
    throw new AppError('TMUX_COMMAND_FAILED', 'tmux could not complete the terminal operation', 503, missing ? { missing } : undefined);
  }
}

export function defaultShell(): string {
  return process.env.SHELL || '/bin/sh';
}

export function tmuxTargetMissing(error: unknown): boolean {
  return error instanceof AppError && error.code === 'TMUX_COMMAND_FAILED' && (error.details as { missing?: boolean } | undefined)?.missing === true;
}

export function terminalName(id: string): string {
  return `cw-${id.replaceAll('-', '').slice(0, 20)}`;
}

/**
 * A plain capture holds the whole pane, so a CLI that has not filled it yet trails blank rows below
 * its last line. Readers look at "the last few lines", which must mean the last lines drawn.
 */
export function trimTrailingBlankLines(text: string): string {
  return text.replace(/\r?\n\s*$/, '');
}

/** No appearance leaves the pane on tmux's defaults, which each viewer paints with its own theme. */
export function appearanceCommands(id: string, appearance: TerminalAppearance | undefined): string[] {
  const style = appearance ? `fg=${appearance.foreground},bg=${appearance.background}` : 'default';
  return [';', 'set-option', '-p', '-t', `${terminalName(id)}:0.0`, 'window-style', style, ';', 'set-option', '-p', '-t', `${terminalName(id)}:0.0`, 'window-active-style', style];
}

export function parsePaneExitCode(result: string): number | null | undefined {
  const [dead, status, signal] = result.trim().split(';');
  if (dead !== '1') return undefined;
  if (status && /^\d+$/.test(status)) return Number(status);
  if (signal && /^\d+$/.test(signal)) return 128 + Number(signal);
  const signalName = signal?.toUpperCase().replace(/^SIG/, '');
  const signalNumber = signalName ? osConstants.signals[`SIG${signalName}` as keyof typeof osConstants.signals] : undefined;
  if (signalNumber) return 128 + signalNumber;
  return null;
}

export function observationFor(id: string, message: TerminalServerMessage): TerminalObservation | undefined {
  if (message.type === 'output') return { type: 'output', terminalId: id, data: message.data, sequence: message.sequence };
  if (message.type === 'state') return { type: 'state', terminalId: id, terminal: message.terminal };
  if (message.type === 'exit') return { type: 'exit', terminalId: id, exitCode: message.exitCode ?? -1 };
  return undefined;
}

/**
 * The last `MAX_OUTPUT_CHARS` characters a pane printed. Chunks are kept as they arrived and the
 * excess is dropped from the front, so a chunk costs its own length: concatenating onto one string
 * and slicing its tail flattened the whole buffer (a copy and allocation of its full size) per chunk.
 */
export class OutputTail {
  private chunks: string[] = [];
  private head = 0;
  private size = 0;

  get length(): number { return this.size; }

  append(chunk: string): void {
    if (!chunk) return;
    this.chunks.push(chunk);
    this.size += chunk.length;
    let excess = this.size - MAX_OUTPUT_CHARS;
    while (excess > 0) {
      const first = this.chunks[this.head]!;
      if (first.length <= excess) {
        this.chunks[this.head++] = '';
        excess -= first.length;
        this.size -= first.length;
      } else {
        this.chunks[this.head] = first.slice(excess);
        this.size -= excess;
        excess = 0;
      }
    }
    if (this.head > 1024) { this.chunks = this.chunks.slice(this.head); this.head = 0; }
  }

  /** Joined on every call rather than cached: a quiet pane would otherwise hold its output twice. */
  text(): string {
    return this.chunks.slice(this.head).join('');
  }

  /** The last `count` characters, read from the newest chunks only. */
  tail(count: number): string {
    let text = '';
    for (let index = this.chunks.length - 1; index >= this.head && text.length < count; index -= 1) text = this.chunks[index]! + text;
    return text.length > count ? text.slice(-count) : text;
  }
}
