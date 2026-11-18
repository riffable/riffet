import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { readFile, readlink, realpath } from 'node:fs/promises';
import { constants as osConstants, homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { TERMINAL_SCROLLBACK_ROWS, type NativeBackendId, type Project, type Session, type TerminalAppearance, type TerminalInfo, type TerminalServerMessage } from '../../../../packages/contracts/src/index.js';
import { normalizeWarmup } from '../session-identity.js';
import { terminalEnvironment } from '../environment.js';
import { AppError, requireString } from '../errors.js';
import { exec, ExecError } from '../exec.js';
import { assertTaskWorkspaceAvailable } from '../task-workspaces/identity.js';
import { Store } from '../store.js';
import { deriveSessionState, sessionStatePatch } from '../backends/service.js';
import { redactSensitiveText } from '../settings/config-documents.js';
import { stopProcessGroup } from '../backends/shared/codex-app-server.js';
import { parsePsCommandLine } from './ps-argv.js';
import { OuterTerminalState } from './protocol-state.js';
import { ControlClient, sendKeysLines, tmuxTooOld, TMUX_MIN_VERSION } from './control.js';
import { assembleSeed, seedCommands, seedLine, SEED_BLOCKS, type Seed } from './seed.js';
import { resolveTerminalAppearance, sameTerminalAppearance } from './appearance.js';
import { claimTmuxServerCommands } from './orphans.js';
import { launchArgAccepted, tmuxArgument } from './launch-args.js';
import { stripTerminalSequences } from '../../../../packages/plugin-api/src/kit/terminal-text.js';

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

interface TerminalRuntime {
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

interface InteractionTransaction {
  runtime: TerminalRuntime;
  epoch: number;
  authorize?: () => void;
  beforeWrite?: () => void;
  writeStarted?: boolean;
}

/** One websocket watching a terminal. Its output is gated while a seed is in flight, and metered by the client's acks. */
interface Viewer {
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

/**
 * Raw output kept per attached pane, whether or not anyone watches it. Viewers are seeded from
 * `capture-pane`; this only feeds startup-error parsing and observers, so it stays small:
 * a hundred-odd live CLIs at a few megabytes each was much of the server's heap.
 */
const MAX_OUTPUT_CHARS = 512 * 1024;
/**
 * How long one plain capture of a pane answers every reader. Several pollers watch the same CLI
 * (status, dialogs, stop verification, submission checks); within this window they share a single
 * `tmux capture-pane` instead of each forking one. Any write to the pane, and any output from it,
 * ends the window early.
 */
const SCREEN_CACHE_MS = 120;
const MAX_INPUT_CHARS = 128 * 1024;
const SNAPSHOT_OUTPUT_QUIET_MS = 150;
/** A CLI nobody is viewing renders at this size, so its dialogs fit unclipped for the web parser. */
const BACKGROUND_COLS = 100;
const BACKGROUND_ROWS = 40;
const BACKGROUND_RESIZE_DELAY_MS = 3000;
const REATTACH_DELAY_MS = 250;
/** How far back a dead pane is read for a startup error the stream did not carry. */
const STARTUP_SCAN_LINES = 500;
/**
 * Scrollback kept per pane: what a seed carries and `GET /history` reads. tmux's default of 2000 lines is a few screens of
 * an agent turn. Set on Riffet's private tmux server before a session is created, because a pane's
 * limit is fixed when the pane is.
 */
const HISTORY_LIMIT = TERMINAL_SCROLLBACK_ROWS;
/** A protocol 3 viewer this far behind its client's acks (beyond its own snapshot) is dropped to a fresh seed instead of queueing further. */
const MAX_UNACKED_CHARS = 2_000_000;
const SEED_RETRY_MS = 250;
const SEED_RETRY_MAX_MS = 5000;
/** A resize reseed waits for the pane to go quiet, but not longer than this: a spinner never does. */
const RESEED_MAX_WAIT_MS = 1000;
/** Full ANSI scrollback routinely exceeds the 1 MiB budget used for small tmux commands. */
const HISTORY_CAPTURE_BYTES = 32 * 1024 * 1024;
/** Rows a history tail may grow by between the version check and its capture and still append. */
const HISTORY_TAIL_SLACK = 512;
const REATTACH_MAX_DELAY_MS = 30_000;
/** A tmux client that exits sooner than this counts as a failed attach and backs off the next one. */
const ATTACH_STABLE_MS = 5000;
/** How long a stopped pane's CLI gets to exit on the hang-up before it is signalled outright. */
const PANE_HANGUP_GRACE_MS = 1000;
/** tmux option holding a native launch's marker; the name predates other drivers and live panes still carry it. */
const LAUNCH_MARKER_OPTION = '@riffet-codex-launch';
/** tmux option holding the pane process the marker was written for; a pane whose process is another one has no record. */
const LAUNCH_PID_OPTION = '@riffet-launch-pid';
const LAUNCH_MARKER = /^[a-f0-9]{64}$/;
/** How long one read of every pane's launch record answers later readers; tmux is asked once for all of them. */
const LAUNCH_RECORDS_FRESH_MS = 750;
const MAX_PANE_PROCESSES = 32;
/**
 * Per-command cap inside a pane lookup's budget. A cold `lsof` or a tmux server busy with a
 * restart's reconnects can take a few hundred milliseconds; a tighter cap reads as "unverified"
 * and blocks writes to a terminal that was never wrong.
 */
const LOOKUP_STEP_MS = 1000;

function lookupStepTimeout(deadline: number): number {
  return Math.max(1, Math.min(LOOKUP_STEP_MS, deadline - Date.now()));
}

/** A process found in a native terminal's pane, running in the terminal's own project directory. */
export interface PaneProcess {
  pid: number;
  argv: string[];
  /** The pane's own process, the one tmux started, rather than one of its descendants. */
  root?: boolean;
}

/** A pane as tmux reports it, with the launch record written beside it. */
interface PaneLaunchRecord {
  panePid: number;
  dead: boolean;
  marker?: string;
  launchPid?: number;
}

function validDimension(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 2 || value > 1000) throw new AppError('INVALID_TERMINAL_SIZE', 'Terminal columns and rows must be integers between 2 and 1000');
  return value;
}

/** `env` absent is the server's current environment. */
async function run(command: string, args: string[], timeout = 5000, env?: NodeJS.ProcessEnv, maxBuffer = 1024 * 1024): Promise<string> {
  try { return (await exec(command, args, { timeout, maxBuffer, ...(env ? { env } : {}) })).stdout; }
  catch (error) {
    // Only tmux's own answer that the target is gone means gone; a timeout or any other failure says nothing.
    const missing = error instanceof ExecError && !error.killed && TMUX_TARGET_MISSING.test(error.stderr);
    throw new AppError('TMUX_COMMAND_FAILED', 'tmux could not complete the terminal operation', 503, missing ? { missing } : undefined);
  }
}

function defaultShell(): string {
  return process.env.SHELL || '/bin/sh';
}

const TMUX_TARGET_MISSING = /can't find (?:session|window|pane)|no server running|error connecting to/;

function tmuxTargetMissing(error: unknown): boolean {
  return error instanceof AppError && error.code === 'TMUX_COMMAND_FAILED' && (error.details as { missing?: boolean } | undefined)?.missing === true;
}

function terminalName(id: string): string {
  return `cw-${id.replaceAll('-', '').slice(0, 20)}`;
}

/**
 * A plain capture holds the whole pane, so a CLI that has not filled it yet trails blank rows below
 * its last line. Readers look at "the last few lines", which must mean the last lines drawn.
 */
function trimTrailingBlankLines(text: string): string {
  return text.replace(/\r?\n\s*$/, '');
}

interface ScreenRead {
  /** Write generation the capture started under; a later write makes it unusable. */
  generation: number;
  runtime?: TerminalRuntime;
  sequence?: number;
  startedAt: number;
  task: Promise<string | undefined>;
  text?: string;
  settled: boolean;
}

/**
 * The last `MAX_OUTPUT_CHARS` characters a pane printed. Chunks are kept as they arrived and the
 * excess is dropped from the front, so a chunk costs its own length: concatenating onto one string
 * and slicing its tail flattened the whole buffer (a copy and allocation of its full size) per chunk.
 */
class OutputTail {
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

export class TerminalService {
  private readonly socketPath: string;
  private readonly stateDir: string;
  private readonly socketDirectory: string;
  /** Capability of the tmux server on our socket, not the version of a different CLI binary. */
  private tmuxPaneFeatures?: Promise<boolean>;
  private tmuxVersion?: Promise<string>;
  private launchRecordRead?: { at: number; read: Promise<Map<string, PaneLaunchRecord> | undefined> };
  /** Kept as a resolved compatibility barrier; restoration is now scoped to one terminal. */
  private readonly ready = Promise.resolve();
  private readonly restorations = new Map<string, Promise<void>>();
  private readonly finalizations = new Map<string, Promise<void>>();
  private runtime = new Map<string, TerminalRuntime>();
  /** Consecutive tmux clients that exited right after attaching, keyed by terminal id. */
  private readonly attachFailures = new Map<string, number>();
  /** Debounced post-resize snapshot pushes, keyed by terminal id. */
  private readonly snapshotTimers = new Map<string, NodeJS.Timeout>();
  private listeners = new Map<string, Set<Viewer>>();
  private observers = new Map<string, Set<TerminalObserver>>();
  /** Terminals being created with `reuseLive`, by session. */
  private readonly liveCreations = new Map<string, Promise<TerminalInfo>>();
  /** Every environment name any Agent has declared since the service started, so one withdrawn later is still kept out of panes. */
  private readonly seenLaunchEnv = { managed: new Set<string>(), secrets: new Set<string>() };
  private readonly interactions = new Map<string, InteractionTransaction>();
  private readonly externalMutations = new Map<string, number>();
  private readonly pasteBuffers = new Set<string>();
  /** The latest plain capture per terminal, shared by concurrent readers (see `SCREEN_CACHE_MS`). */
  private readonly screenReads = new Map<string, ScreenRead>();
  /** Bumped on every write to a pane, so no reader is answered with a capture taken before it. */
  private readonly screenGenerations = new Map<string, number>();
  private readonly operationWaiters = new Map<string, Set<() => void>>();
  private readonly stopping = new Set<string>();
  private shuttingDown = false;

  private previousWarmupsEnded?: Promise<void>;

  constructor(private readonly store: Store, private readonly options: TerminalServiceOptions) {
    const stateDir = resolve(options.stateDir);
    this.stateDir = stateDir;
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    chmodSync(stateDir, 0o700);
    const candidate = join(stateDir, 'tmux.sock');
    if (Buffer.byteLength(candidate) <= 90) {
      this.socketPath = candidate;
      this.socketDirectory = stateDir;
    } else {
      this.socketDirectory = join(tmpdir(), `riffet-${process.getuid?.() ?? 'user'}-${createHash('sha256').update(stateDir).digest('hex').slice(0, 12)}`);
      this.socketPath = join(this.socketDirectory, 'tmux.sock');
      mkdirSync(this.socketDirectory, { recursive: true, mode: 0o700 });
      chmodSync(this.socketDirectory, 0o700);
    }
  }

  async create(project: Project, input: TerminalCreateInput = {}): Promise<TerminalInfo> {
    await this.ready;
    const currentProject = this.store.getProject(project.id);
    if (currentProject.cwd !== project.cwd) throw new AppError('PROJECT_MISMATCH', 'Project directory changed before terminal creation', 409);
    const kind = input.kind ?? 'shell';
    if (this.shuttingDown) throw new AppError('TERMINAL_SERVICE_CLOSED', 'Terminal service is shutting down', 503);
    if (input.sessionId) {
      const session = this.store.getSession(input.sessionId);
      if (session.projectId !== currentProject.id) throw new AppError('PROJECT_SESSION_MISMATCH', 'Conversation does not belong to this project', 409);
    }
    if (kind === 'native' && !input.sessionId) throw new AppError('NATIVE_LAUNCH_REQUIRED', 'A native terminal needs a linked session and an adapter launch specification', 400);
    this.assertLaunchSpec(kind, input, currentProject);
    if (input.reuseLive && input.sessionId) {
      const currentCreation = this.liveCreations.get(input.sessionId);
      if (currentCreation) return currentCreation;
      const existing = this.store.listTerminals().find(item => item.sessionId === input.sessionId && item.kind === kind && item.state !== 'exited');
      if (existing) {
        await this.ensureRestored(existing.id);
        const restored = this.store.getTerminal(existing.id);
        if (restored.state !== 'exited') return restored;
      }
      const creation = this.createTerminal(currentProject, { ...input, kind });
      this.liveCreations.set(input.sessionId, creation);
      try {
        return await creation;
      } finally {
        if (this.liveCreations.get(input.sessionId) === creation) this.liveCreations.delete(input.sessionId);
      }
    }
    return await this.createTerminal(currentProject, { ...input, kind });
  }

  /** Every kind but a shell runs a process an adapter chose; it is checked here, whoever asks. */
  private assertLaunchSpec(kind: TerminalInfo['kind'], input: TerminalCreateInput, project: Project): void {
    if (kind === 'shell') return;
    const spec = input.launchSpec;
    if (!spec) throw new AppError('NATIVE_LAUNCH_REQUIRED', 'A native terminal needs a linked session and an adapter launch specification', 400);
    if (spec.cwd !== project.cwd) throw new AppError('NATIVE_LAUNCH_CWD_INVALID', 'Native terminal cwd must match its project workspace', 400);
    if (!spec.command || spec.command.length > 4096 || /[\0\r\n]/.test(spec.command)
      || !Array.isArray(spec.args) || spec.args.length > 200 || !spec.args.every(launchArgAccepted)) {
      throw new AppError('NATIVE_LAUNCH_INVALID', 'Native terminal launch command is invalid', 400);
    }
    for (const [key, value] of Object.entries({ ...spec.env, ...spec.secretEnv })) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string' || value.length > 64 * 1024 || /[\0\r\n]/.test(value)) {
        throw new AppError('NATIVE_LAUNCH_ENV_INVALID', 'Native terminal environment is invalid', 400);
      }
    }
  }

  private async createTerminal(currentProject: Project, input: TerminalCreateInput & { kind: TerminalInfo['kind'] }): Promise<TerminalInfo> {
    // A missing task directory is the more specific answer, and holds whether or not tmux is installed.
    await assertTaskWorkspaceAvailable(currentProject);
    await this.assertTmuxVersion();
    const kind = input.kind;
    const cols = validDimension(input.cols, isAgentTerminal(kind) ? BACKGROUND_COLS : 80);
    const rows = validDimension(input.rows, isAgentTerminal(kind) ? BACKGROUND_ROWS : 24);
    const appearance = resolveTerminalAppearance(input.appearance ?? (input.sessionId ? this.store.getSession(input.sessionId).terminalAppearance : undefined));
    const terminalId = randomUUID();
    const behaviour = this.behaviourFor(kind, input.sessionId, input.warmup?.backendId);
    const title = input.title?.trim().slice(0, 120) || behaviour?.title || (kind === 'shell' ? 'Shell' : kind === 'login' ? 'Login' : 'Native Agent');
    const info: TerminalInfo = {
      id: terminalId,
      projectId: currentProject.id,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      title,
      kind,
      state: 'running',
      persistent: true,
      epoch: 0,
      cols,
      rows,
      ...(appearance ? { appearance } : {}),
      createdAt: new Date().toISOString(),
      ...(input.warmup ? { warmup: input.warmup } : {}),
    };
    this.prepareSocketDirectory();
    const { command, args, tmuxEnv, env: commandEnv } = this.commandFor(kind, input);
    // A secret reaches the session through tmux's `update-environment` from this client's own
    // environment, which other users cannot read; `-e KEY=VALUE` would put it on the client's argv.
    const secretEnv = kind === 'shell' ? {} : input.launchSpec?.secretEnv ?? {};
    const env = Object.keys(secretEnv).length ? { ...commandEnv, ...secretEnv } : commandEnv;
    const launchMarker = kind !== 'shell' && LAUNCH_MARKER.test(input.launchSpec?.launchMarker ?? '') ? input.launchSpec!.launchMarker : undefined;
    try {
      // A persistent tmux server keeps the environment it was first started with, so a terminal
      // opened after a restart would otherwise inherit a stale PATH — or none of the toolchain the
      // user installed since. Every session states the daemon's own environment explicitly.
      const sessionEnv = { ...terminalEnvironment(), ...(tmuxEnv ?? {}) };
      // The markers go first: whatever else the command does, `ps` shows whose server this is (`terminal/orphans.ts`).
      const tmuxCommands=['start-server',';',...claimTmuxServerCommands(this.stateDir),...[...this.launchEnv().managed,...Object.keys(secretEnv)].flatMap(name=>[';','if-shell','-F',`#{m:*${name}*,#{update-environment}}`,'',`set-option -ga update-environment ${name}`]),';','set-option','-g','history-limit',String(HISTORY_LIMIT),';','set-option','-g','remain-on-exit','on',';','new-session'];
      await this.runTmux([
        ...tmuxCommands,
        // Every value that is not Riffet's own can end in `;`, which tmux would read as the end of the command.
        ...Object.entries(sessionEnv).flatMap(([key, value]) => ['-e', tmuxArgument(`${key}=${value}`)]), '-d', '-P', '-F', '#{session_id}',
        '-x', String(cols), '-y', String(rows), '-s', terminalName(terminalId), '-c', tmuxArgument(currentProject.cwd), tmuxArgument(command), ...args.map(tmuxArgument),
        // Per window, never `-g`: tmux 3.6b's server exits when a session is created while the global option is `manual`.
        ';', 'set-option', '-w', '-t', terminalName(terminalId), 'window-size', 'manual',
        // The driver's opaque launch fingerprint, bound to the pane process it describes in the same
        // command as the launch, so no reader can see one without the other (`paneLaunchMarker`).
        ...(launchMarker ? this.launchRecordCommands(terminalId, launchMarker) : []),
        ...(await this.paneFeatures().catch(() => false) ? this.appearanceCommands(terminalId, appearance) : []),
      ],5000,env);
      if (launchMarker) this.launchRecordRead = undefined;
      await this.runTmux(['set-hook', '-t', terminalName(terminalId), 'pane-died', `detach-client -s ${terminalName(terminalId)}`]);
      this.store.saveTerminal(info);
      if (input.sessionId) {
        const linked = this.store.getSession(input.sessionId);
        this.store.updateSession(input.sessionId, {
          terminalId,
          ...(isAgentTerminal(kind) ? sessionStatePatch(linked, deriveSessionState({ current: linked.state, phase: 'starting' })) : {}),
        });
      }
      await this.attach(info, currentProject);
      return this.store.getTerminal(terminalId);
    } catch (error) {
      await this.killSession(terminalId).catch(() => undefined);
      const stored = this.store.listTerminals().find(item => item.id === terminalId);
      if (stored) {
        const updated = this.store.updateTerminal(terminalId, { state: 'exited', ownerId: undefined, epoch: stored.epoch + 1 });
        this.emit(terminalId, { type: 'state', terminal: updated });
        this.clearObservers(terminalId);
        this.reportLinkedTerminal(updated, false);
      }
      if (error instanceof AppError) throw error;
      throw new AppError('TERMINAL_CREATE_FAILED', 'Could not create the persistent terminal', 503);
    }
  }

  async list(): Promise<TerminalInfo[]> {
    await this.ready;
    const terminals = this.listSnapshot();
    await this.restoreMany(terminals.map(item => item.id));
    return terminals.map(item => this.store.getTerminal(item.id)).filter(item => !isWarmupTerminal(item));
  }

  /** Read stored terminal metadata without attaching every persistent tmux session. */
  listSnapshot(): TerminalInfo[] {
    return this.store.listTerminals().filter(item => !isWarmupTerminal(item));
  }

  async get(id: string): Promise<TerminalInfo> {
    await this.ensureRestored(id);
    return this.store.getTerminal(id);
  }

  /** The kind is the launch's (`native` unless given); the reservation is a session's terminal once claimed. */
  async createWarmup(project: Project, input: Omit<TerminalCreateInput, 'sessionId' | 'warmup' | 'reuseLive'> & { warmup: TerminalWarmupMetadata }): Promise<WarmupTerminalInfo> {
    await this.endPreviousWarmupsOnce();
    await this.ready;
    if (this.shuttingDown) throw new AppError('TERMINAL_SERVICE_CLOSED', 'Terminal service is shutting down', 503);
    const currentProject = this.store.getProject(project.id);
    if (currentProject.cwd !== project.cwd) throw new AppError('PROJECT_MISMATCH', 'Project directory changed before terminal creation', 409);
    if (!input.warmup.nativeSessionId) {
      throw new AppError('WARMUP_CHAT_ID_REQUIRED', 'A native warmup needs its reserved conversation id', 409);
    }
    if (!input.warmup.ownerToken || !input.warmup.resourceKey || input.warmup.expiresAt <= Date.now()) {
      throw new AppError('INVALID_WARMUP', 'Native warmup reservation is invalid or expired', 409);
    }
    const kind = input.kind ?? 'native';
    if (kind === 'shell' || kind === 'login') throw new AppError('INVALID_WARMUP', 'Only an agent process can be held ahead of its session', 409);
    this.assertLaunchSpec(kind, input, currentProject);
    return await this.createTerminal(currentProject, { ...input, kind }) as WarmupTerminalInfo;
  }

  async listWarmups(ownerToken?: string): Promise<WarmupTerminalInfo[]> {
    return this.store.listTerminals().filter(isWarmupTerminal)
      .filter(item => item.state !== 'exited')
      .filter(item => ownerToken === undefined || item.warmup.ownerToken === ownerToken)
      .map(item => ({ ...item, warmup: warmupOf(item) }));
  }

  async extendWarmup(id: string, input: { ownerToken: string; resourceKey: string; expiresAt: number }): Promise<WarmupTerminalInfo> {
    await this.ensureRestored(id);
    if (this.stopping.has(id)) throw new AppError('WARMUP_CLAIM_STALE', 'Native startup reservation is no longer available', 409);
    const info = this.store.getTerminal(id);
    if (!isWarmupTerminal(info) || info.warmup.ownerToken !== input.ownerToken || info.warmup.resourceKey !== input.resourceKey) {
      throw new AppError('WARMUP_CLAIM_STALE', 'Native startup reservation is no longer available', 409);
    }
    if (!Number.isFinite(input.expiresAt) || input.expiresAt <= Date.now()) {
      throw new AppError('INVALID_WARMUP', 'Native startup reservation expiry is invalid', 409);
    }
    const updated = this.store.saveTerminal({ ...info, warmup: { ...warmupOf(info), expiresAt: input.expiresAt } } as WarmupTerminalInfo);
    return updated as WarmupTerminalInfo;
  }

  /** Atomically converts an unused temporary CLI into the requested native session. */
  async claimWarmup(id: string, input: { ownerToken: string; resourceKey: string; sessionId: string }): Promise<TerminalInfo> {
    await this.ensureRestored(id);
    if (this.stopping.has(id)) throw new AppError('WARMUP_CLAIM_STALE', 'Native startup reservation is no longer available', 409);
    const info = this.store.getTerminal(id);
    if (!isWarmupTerminal(info) || info.warmup.ownerToken !== input.ownerToken || info.warmup.resourceKey !== input.resourceKey) {
      throw new AppError('WARMUP_CLAIM_STALE', 'Native startup reservation is no longer available', 409);
    }
    if (info.warmup.expiresAt <= Date.now()) {
      await this.stopWarmup(id, input.ownerToken);
      throw new AppError('WARMUP_EXPIRED', 'Native startup reservation expired', 409);
    }
    if (info.state !== 'running') throw new AppError('WARMUP_NOT_READY', 'Native startup reservation is not attached and ready', 409);
    const session = this.store.getSession(input.sessionId);
    if (session.projectId !== info.projectId || session.kind !== 'native') {
      throw new AppError('WARMUP_PROJECT_MISMATCH', 'Native startup reservation belongs to another project', 409);
    }
    if (!sameTerminalAppearance(session.terminalAppearance, info.appearance)) {
      throw new AppError('WARMUP_APPEARANCE_MISMATCH', 'Native startup reservation uses a different terminal appearance', 409);
    }
    if (session.terminalId && session.terminalId !== id) {
      const linked = this.store.getTerminal(session.terminalId);
      if (linked.state !== 'exited') throw new AppError('SESSION_TERMINAL_EXISTS', 'Conversation already has a running terminal', 409);
    }
    const { warmup: _warmup, ...claimed } = info;
    const updated = this.store.saveTerminal({ ...claimed, sessionId: input.sessionId, ownerId: undefined, epoch: info.epoch + 1 });
    this.store.updateSession(input.sessionId, {
      terminalId: id,
      nativeSessionId: warmupOf(info).nativeSessionId,
      state: 'running',
      error: undefined,
    });
    this.emit(id, { type: 'state', terminal: updated });
    return updated;
  }

  /** Stop only a temporary process carrying the caller's owner token. */
  /**
   * Every reservation that exists before this process makes its first was made by an earlier one: a
   * warm pool ends its own when it closes, and its owner token dies with its process. Ended once, for
   * every Agent, rather than by each plugin, which would end the others' as well: at start-up (the
   * service calls this), and before the first reservation in case that comes sooner.
   */
  endPreviousWarmupsOnce(): Promise<void> {
    return this.previousWarmupsEnded ??= this.endPreviousWarmups();
  }

  private async endPreviousWarmups(): Promise<void> {
    const previous = this.store.listTerminals().filter(info => info.state !== 'exited' && isWarmupTerminal(info));
    await Promise.allSettled(previous.map(info => this.stopWarmup(info.id, (info as WarmupTerminalInfo).warmup.ownerToken)));
  }

  async stopWarmup(id: string, ownerToken: string): Promise<boolean> {
    await this.ensureRestored(id);
    return await this.stopRestored(id, ownerToken);
  }

  /**
   * A viewer first gets a `snapshot` (the pane's scrollback, screen and modes, see `seed.ts`), then the
   * pane's output. Protocol 3 viewers ack what they have written; one that falls too far behind is
   * dropped to a fresh snapshot instead of being disconnected. Protocol 2 snapshots carry the
   * screen only, because those clients read the scrollback from `history()`.
   */
  subscribe(id: string, callback: (message: TerminalServerMessage) => void, options: { protocol?: number } = {}): TerminalSubscription {
    const viewer: Viewer = { send: callback, protocol: options.protocol ?? 2, unacked: 0, seedChars: 0, seeding: true, seedInFlight: false, seedTicket: 0, closed: false };
    const group = this.listeners.get(id) ?? new Set<Viewer>();
    group.add(viewer);
    this.listeners.set(id, group);
    void this.ensureRestored(id).then(async () => {
      if (viewer.closed) return;
      const info = this.store.getTerminal(id);
      if (info.state !== 'exited') await this.attach(info, this.store.getProject(info.projectId));
      if (viewer.closed) return;
      callback({ type: 'state', terminal: this.store.getTerminal(id) });
      // An attach that just happened has already seeded every viewer, this one included.
      if (viewer.seeding && !viewer.seedInFlight) this.seedViewers(id, [viewer]);
    }).catch(error => {
      callback({ type: 'error', code: error instanceof AppError ? error.code : 'TERMINAL_UNAVAILABLE', message: error instanceof AppError ? error.message : 'Terminal is unavailable' });
    });
    const unsubscribe = () => {
      viewer.closed = true;
      group.delete(viewer);
      if (group.size === 0 && this.listeners.get(id) === group) {
        this.listeners.delete(id);
        setTimeout(() => this.restoreBackgroundSize(id), BACKGROUND_RESIZE_DELAY_MS).unref?.();
      }
    };
    return Object.assign(unsubscribe, {
      ack: (chars: number) => {
        if (!Number.isFinite(chars) || chars <= 0) return;
        viewer.unacked = Math.max(0, viewer.unacked - chars);
        // The seed is acked first; once it is written, the allowance is output alone again.
        viewer.seedChars = Math.max(0, viewer.seedChars - chars);
      },
    });
  }

  /**
   * Bring viewers to the pane's present state with one seed (`seed.ts`). Output is withheld from each
   * until its seed is in: everything the pane printed before the seed's command is inside the seed, and
   * everything after it follows. The switch happens inside the control parser, between two lines,
   * so no output line can fall on the wrong side. `resume` first re-enables a paused pane.
   */
  private seedViewers(id: string, viewers: Iterable<Viewer>, options: { resume?: boolean; attempt?: number } = {}): void {
    const runtime = this.runtime.get(id);
    const targets = [...viewers].filter(viewer => !viewer.closed);
    if (!runtime || !targets.length || this.shuttingDown) return;
    const tickets = new Map(targets.map(viewer => { viewer.seeding = true; viewer.seedInFlight = true; return [viewer, ++viewer.seedTicket] as const; }));
    const current = (viewer: Viewer) => !viewer.closed && viewer.seedTicket === tickets.get(viewer);
    const retry = (pending: Viewer[]) => {
      const waiting = pending.filter(current);
      if (!waiting.length || this.runtime.get(id) !== runtime || this.shuttingDown) return;
      // A viewer without a seed shows nothing, so keep asking, backing off, for as long as this attach lives.
      const attempt = options.attempt ?? 0;
      setTimeout(() => {
        // A reattach, resize or pause may have seeded them meanwhile; a second seed would flash the screen.
        const still = waiting.filter(current);
        if (still.length && this.runtime.get(id) === runtime) this.seedViewers(id, still, { ...options, attempt: attempt + 1 });
      }, Math.min(SEED_RETRY_MS * 2 ** attempt, SEED_RETRY_MAX_MS)).unref?.();
    };
    const line = (options.resume ? `refresh-client -A '${runtime.pane}:continue' ; ` : '') + seedLine(runtime.pane);
    runtime.control.request(line, SEED_BLOCKS + (options.resume ? 1 : 0), all => {
      if (this.runtime.get(id) !== runtime) return;
      // Output read before the seed's reply is in the seed: deliver it to viewers that are live, drop it for these.
      this.flushOutput(id, runtime);
      const blocks = all.slice(all.length - SEED_BLOCKS);
      const seeds = new Map<boolean, Seed | undefined>();
      const failed: Viewer[] = [];
      for (const viewer of targets) {
        if (!current(viewer)) continue;
        const history = viewer.protocol >= 3;
        if (!seeds.has(history)) seeds.set(history, assembleSeed(blocks, runtime.modes, history));
        const seed = seeds.get(history);
        if (seed) this.sendSnapshot(viewer, runtime, seed); else failed.push(viewer);
      }
      retry(failed);
    }).catch(() => retry(targets));
  }

  /** The seed replaces everything this viewer shows, so it also replaces its debt of unacked output. */
  private sendSnapshot(viewer: Viewer, source: Pick<TerminalRuntime, 'sequence' | 'streamId'>, seed: Seed): void {
    viewer.seeding = false;
    viewer.seedInFlight = false;
    viewer.unacked = viewer.seedChars = seed.data.length;
    try { viewer.send({ type: 'snapshot', data: seed.data, cols: seed.cols, rows: seed.rows, sequence: source.sequence, streamId: source.streamId }); } catch { /* A disconnected browser does not own the tmux process. */ }
  }

  /** A phone that viewed the CLI leaves it narrow; widen it again once no browser is watching. */
  private restoreBackgroundSize(id: string): void {
    const runtime = this.runtime.get(id);
    if (!runtime || this.listeners.has(id) || this.hasExclusiveOperation(id) || this.shuttingDown) return;
    const info = this.store.listTerminals().find(item => item.id === id);
    if (!info || !isAgentTerminal(info.kind) || info.state !== 'running') return;
    const cols = Math.max(info.cols, BACKGROUND_COLS), rows = Math.max(info.rows, BACKGROUND_ROWS);
    if (cols === info.cols && rows === info.rows) return;
    void this.resizeWindow(id, cols, rows).then(() => {
      if (this.runtime.get(id) !== runtime || this.shuttingDown) return;
      this.invalidateScreen(id);
      this.emit(id, { type: 'state', terminal: this.store.updateTerminal(id, { cols, rows }) });
    }).catch(() => undefined);
  }

  /** The control client never sends a size, so the window size is set explicitly (`window-size manual`). */
  private async resizeWindow(id: string, cols: number, rows: number): Promise<void> {
    await this.tmux(['resize-window', '-t', terminalName(id), '-x', String(cols), '-y', String(rows)]);
  }

  /**
   * Register a server-side observer for a terminal. Unlike subscribe(), this does not
   * attach/replay through the browser protocol and does not affect websocket listeners.
   * When the terminal is already attached, the buffered output is replayed once so a
   * late observer still sees earlier output (e.g. a resume picker that already painted).
   * Returns a dispose function; observers are also dropped when the terminal exits.
   */
  observe(id: string, callback: TerminalObserver): () => void {
    const group = this.observers.get(id) ?? new Set<TerminalObserver>();
    group.add(callback);
    this.observers.set(id, group);
    const runtime = this.runtime.get(id);
    if (runtime?.output.length) this.deliver(id, { type: 'output', terminalId: id, data: runtime.output.text(), sequence: runtime.sequence });
    let closed = false;
    if (!runtime) void this.ensureRestored(id).then(() => {
      if (closed) return;
      const restored = this.runtime.get(id);
      if (restored?.output.length) this.deliver(id, { type: 'output', terminalId: id, data: restored.output.text(), sequence: restored.sequence });
    }).catch(() => undefined);
    return () => {
      if (closed) return;
      closed = true;
      group.delete(callback);
      if (group.size === 0) this.observers.delete(id);
    };
  }

  async claim(id: string, clientId: string, takeover = false): Promise<TerminalInfo> {
    await this.ensureRestored(id);
    requireString(clientId, 'clientId', 200);
    // No claim revokes the epoch of a server-owned composer/interrupt transaction: those are bounded,
    // and one cut off between its paste and its Enter leaves a message nobody can say was sent. The
    // browser opens every terminal with a takeover, so that is what an auto-opened drawer sends too;
    // a takeover only wins over another client's lease.
    do { await this.waitForExclusiveOperation(id); } while (this.hasExclusiveOperation(id));
    const info = this.store.getTerminal(id);
    if (info.state !== 'running') throw new AppError('TERMINAL_NOT_RUNNING', 'This terminal is not running', 409);
    if (info.ownerId && info.ownerId !== clientId && !takeover) throw new AppError('TERMINAL_CONTROLLED', 'Another browser currently controls this terminal', 409, { ownerId: info.ownerId, epoch: info.epoch });
    if (info.ownerId === clientId) return info;
    const updated = this.store.updateTerminal(id, { ownerId: clientId, epoch: info.epoch + 1 });
    this.emit(id, { type: 'state', terminal: updated });
    return updated;
  }

  /**
   * Run one exclusive, screen-aware interaction with the terminal. Browser input, composer
   * paste, resize, send-keys, and interrupt calls are rejected until the callback settles. The
   * callback's controls validate that the same PTY runtime and browser-control epoch still own
   * the transaction before and after every asynchronous terminal operation.
   */
  async withInteraction<T>(id: string, task: (control: TerminalInteractionControl) => Promise<T>, options: { authorize?: () => void; beforeWrite?: () => void } = {}): Promise<T> {
    await this.ensureRestored(id);
    if (this.shuttingDown || this.stopping.has(id)) throw new AppError('TERMINAL_NOT_RUNNING', 'This terminal is stopping', 409);
    const info = this.store.getTerminal(id);
    if (info.state !== 'running') throw new AppError('TERMINAL_NOT_RUNNING', 'This terminal is not running', 409);
    const runtime = this.runtime.get(id);
    if (!runtime) throw new AppError('TERMINAL_DETACHED', 'Terminal is reconnecting; interaction was not started', 409);
    if (this.interactions.has(id) || (this.externalMutations.get(id) ?? 0) > 0 || this.pasteBuffers.has(id)) {
      throw this.interactionBusy();
    }

    const transaction: InteractionTransaction = { runtime, epoch: info.epoch, ...options };
    this.interactions.set(id, transaction);
    let stepTail: Promise<void> = Promise.resolve();
    const step = <R>(runStep: () => Promise<R>): Promise<R> => {
      const result = stepTail.then(runStep);
      stepTail = result.then(() => undefined, () => undefined);
      return result;
    };
    const control: TerminalInteractionControl = {
      screen: options => step(async () => {
        this.assertInteractionCurrent(id, transaction);
        // A transaction reads the pane to judge its own writes, so it never takes a shared capture.
        const result = options?.styled
          ? await this.tmux(['capture-pane', '-p', '-e', '-t', terminalName(id)]).then(trimTrailingBlankLines, () => undefined)
          : await this.screen(id, { fresh: true });
        this.assertInteractionCurrent(id, transaction);
        return result;
      }),
      keys: keys => step(async () => {
        this.assertInteractionCurrent(id, transaction);
        try { if (keys.length) { this.beforeInteractionWrite(id, transaction); await this.tmux(['send-keys', '-t', terminalName(id), ...keys]); } }
        finally { this.invalidateScreen(id); }
        this.assertInteractionCurrent(id, transaction);
      }),
      paste: (text, submit) => step(async () => {
        this.assertInteractionCurrent(id, transaction);
        await this.pasteToTerminal(id, text, submit, transaction);
        this.assertInteractionCurrent(id, transaction);
      }),
    };

    try {
      return await task(control);
    } finally {
      // Do not release the lock while a control operation the caller started is still in flight.
      await stepTail.catch(() => undefined);
      if (this.interactions.get(id) === transaction) this.interactions.delete(id);
      this.notifyOperationWaiters(id);
    }
  }

  /** A paste (an attachment upload, or the terminal's own paste) never grants control; validate the original lease inside the write transaction. */
  async pasteAttachmentsWithLease(id: string, clientId: string, epoch: number, text: string, authorize?: () => void, beforeWrite?: () => void): Promise<void> {
    if (typeof text !== 'string' || text.length > MAX_INPUT_CHARS) throw new AppError('INVALID_TERMINAL_INPUT', `Terminal input must be a string up to ${MAX_INPUT_CHARS} characters`);
    await this.withInteraction(id, async control => {
      this.assertController(id, clientId, epoch);
      authorize?.();
      await control.paste(text, false);
    }, { authorize, beforeWrite });
  }

  async input(id: string, clientId: string, epoch: number, data: string): Promise<void> {
    await this.ensureRestored(id);
    this.assertNoInteraction(id);
    const info = this.assertController(id, clientId, epoch);
    if (typeof data !== 'string' || data.length > MAX_INPUT_CHARS) throw new AppError('INVALID_TERMINAL_INPUT', `Terminal input must be a string up to ${MAX_INPUT_CHARS} characters`);
    const attached = this.runtime.get(id);
    if (!attached) throw new AppError('TERMINAL_DETACHED', 'Terminal is reconnecting; input was not sent', 409);
    this.writeToPane(attached, Buffer.from(data, 'utf8'));
    this.invalidateScreen(id);
    void info;
  }

  /** Keys go through the control stream, in order and without forking tmux per keystroke. */
  private writeToPane(runtime: TerminalRuntime, bytes: Buffer): void {
    for (const line of sendKeysLines(runtime.pane, bytes)) void runtime.control.request(line).catch(() => undefined);
  }

  /**
   * The physical rows that scrolled off the pane, including their trailing background cells. The browser
   * terminal shows a tmux client, which keeps history to itself, so the browser renders this
   * above the live screen and scrolls it natively instead of driving tmux.
   */
  async history(id: string, known?: string, tail = false): Promise<{ version: string; cols: number; text?: string; append?: boolean }> {
    await this.ensureRestored(id);
    if (this.store.getTerminal(id).state === 'exited') throw new AppError('TERMINAL_NOT_RUNNING', 'This terminal is not running', 409);
    const name = terminalName(id);
    const preservesCells = await this.paneFeatures();
    // Line count alone stops changing once history is at its limit; the byte count still moves.
    const [stamp, limitText] = (await this.tmux(['display-message', '-p', '-t', name, '#{history_size}:#{history_bytes}:#{pane_width} #{history_limit}'])).trim().split(' ');
    // Invalidate text-only (-J) caches even when no new output arrived. Width is part of the
    // representation: never append physical rows captured at a different grid size.
    // tmux < 3.1 lacks -N. Keep its legacy text display usable, with a distinct format marker;
    // it cannot promise faithful empty background cells and must never share a cells cache.
    const version = `${stamp}:${preservesCells ? 'cells-v1' : 'text-v1'}`;
    const cols = Number(stamp.split(':')[2]);
    if (version === known) return { version, cols };
    // With no history, `-E -1` would still return the first screen line.
    if (version.startsWith('0:')) return { version, cols, text: '' };
    // `tail`: a client that holds the history up to `known` gets only the lines added since, as long as
    // lines were only added. At the limit the oldest lines fall off while new ones arrive, and a resize
    // re-wraps the history (the client drops `known` when the width changes), so both go back to a
    // full capture.
    const size = Number(version.split(':')[0]);
    const knownSize = Number(known?.split(':')[0]);
    const sameGrid = known?.split(':').slice(2).join(':') === version.split(':').slice(2).join(':');
    // -J implies -T and discards characterless background cells (for example an erased diff
    // row). -N preserves them as spaces; replay at the server's width keeps each row intact.
    let append = Boolean(tail && sameGrid && Number.isInteger(knownSize) && knownSize > 0 && size > knownSize && size < Number(limitText));
    const marker = '\u0001';
    const metadata = `${marker}#{history_size}:#{history_bytes}:#{pane_width}`;
    // The pane can scroll/resize between the initial version check and capture. Bracket capture
    // with metadata in one tmux command list; never apply a relative tail to a moved baseline.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      // Physical rows map one-to-one to captured lines, so a cells tail asks for spare rows and is
      // cut to the size the bracket reports: output arriving after the version check still appends.
      const slack = append && preservesCells ? HISTORY_TAIL_SLACK : 0;
      const output = await this.runTmux([
        'display-message', '-p', '-t', name, metadata,
        ';', 'capture-pane', '-p', '-e', preservesCells ? '-N' : '-J', '-S', append ? `-${size - knownSize + slack}` : '-', '-E', '-1', '-t', name,
        ';', 'display-message', '-p', '-t', name, metadata,
      ], 5000, undefined, HISTORY_CAPTURE_BYTES);
      const firstLine = output.indexOf('\n');
      const lastMarker = output.lastIndexOf(marker);
      const before = output.slice(1, firstLine).trim();
      const after = output.slice(lastMarker + 1).trim();
      const consistent = output.startsWith(marker) && lastMarker > firstLine && before === after;
      const text = output.slice(firstLine + 1, lastMarker);
      const result = (body: string, appended: boolean) => ({
        version: `${before}:${preservesCells ? 'cells-v1' : 'text-v1'}`,
        cols: Number(before.split(':')[2]),
        ...(appended ? { append: true } : {}),
        text: before.startsWith('0:') ? '' : body,
      });
      if (consistent && !append) return result(text, false);
      if (consistent && slack) {
        const [moved, , width] = before.split(':');
        const wanted = Number(moved) - knownSize;
        const rows = text.split('\n');
        if (rows.at(-1) === '') rows.pop();
        if (width === stamp.split(':')[2] && wanted > 0 && Number(moved) < Number(limitText) && rows.length >= wanted) {
          // tmux writes a style once and lets it run across rows, so the cut-off rows still decide
          // how the first kept row is drawn.
          const lead = new OuterTerminalState();
          lead.accept(rows.slice(0, rows.length - wanted).join('\n'));
          return result(lead.style() + rows.slice(rows.length - wanted).join('\n') + '\n', true);
        }
      } else if (consistent && before === stamp) return result(text, true);
      append = false;
    }
    throw new AppError('TERMINAL_HISTORY_CHANGED', 'Terminal history changed during capture; retry', 409);
  }

  async resize(id: string, clientId: string, epoch: number, cols: number, rows: number): Promise<TerminalInfo> {
    await this.ensureRestored(id);
    this.assertNoInteraction(id);
    this.assertController(id, clientId, epoch);
    cols = validDimension(cols, 80);
    rows = validDimension(rows, 24);
    const current = this.store.getTerminal(id);
    if (current.cols === cols && current.rows === rows) return current;
    const attached = this.runtime.get(id);
    if (!attached) throw new AppError('TERMINAL_DETACHED', 'Terminal is reconnecting; resize was not applied', 409);
    await this.resizeWindow(id, cols, rows);
    this.invalidateScreen(id);
    const updated = this.store.updateTerminal(id, { cols, rows });
    this.emit(id, { type: 'state', terminal: updated });
    this.scheduleSnapshot(id);
    return updated;
  }

  async release(id: string, clientId: string, epoch: number): Promise<TerminalInfo> {
    await this.ensureRestored(id);
    do { await this.waitForExclusiveOperation(id); } while (this.hasExclusiveOperation(id));
    const info = this.assertController(id, clientId, epoch);
    const updated = this.store.updateTerminal(id, { ownerId: undefined, epoch: info.epoch + 1 });
    this.emit(id, { type: 'state', terminal: updated });
    return updated;
  }

  async interrupt(id: string): Promise<void> {
    await this.ensureRestored(id);
    this.beginExternalMutation(id);
    try {
      const info = this.store.getTerminal(id);
      if (info.state !== 'running') throw new AppError('TERMINAL_NOT_RUNNING', 'This terminal is not running', 409);
      const attached = this.runtime.get(id);
      if (attached) this.writeToPane(attached, Buffer.from([0x03]));
      else await this.tmux(['send-keys', '-t', terminalName(id), 'C-c']);
    } finally {
      this.invalidateScreen(id);
      this.endExternalMutation(id);
    }
  }

  /**
   * Deliver text as one bracketed paste so multi-line prompts arrive intact instead of each
   * newline submitting early, then optionally press Enter. Bypasses the browser input lease:
   * the conversation composer is a separate, server-mediated channel into the same pane.
   */
  async paste(id: string, text: string, submit: boolean): Promise<void> {
    await this.ensureRestored(id);
    if (typeof text !== 'string' || text.length > MAX_INPUT_CHARS) throw new AppError('INVALID_TERMINAL_INPUT', `Terminal input must be a string up to ${MAX_INPUT_CHARS} characters`);
    this.beginExternalMutation(id, true);
    try {
      const info = this.store.getTerminal(id);
      if (info.state === 'exited') throw new AppError('TERMINAL_NOT_RUNNING', 'This terminal is not running', 409);
      await this.pasteToTerminal(id, text, submit);
    } finally {
      this.endExternalMutation(id, true);
    }
  }

  private async pasteToTerminal(id: string, text: string, submit: boolean, transaction?: InteractionTransaction): Promise<void> {
    if (typeof text !== 'string' || text.length > MAX_INPUT_CHARS) throw new AppError('INVALID_TERMINAL_INPUT', `Terminal input must be a string up to ${MAX_INPUT_CHARS} characters`);
    if (transaction) this.assertInteractionCurrent(id, transaction);
    const buffer = `${terminalName(id)}-paste`;
    let loaded = false;
    if (this.pasteBuffers.has(id)) throw this.interactionBusy();
    this.pasteBuffers.add(id);
    try {
      if (text) {
        await exec('tmux', ['-S', this.socketPath, 'load-buffer', '-b', buffer, '-'], { timeout: 5000, input: text })
          .catch(() => { throw new AppError('TMUX_COMMAND_FAILED', 'tmux could not complete the terminal operation', 503); });
        loaded = true;
        if (transaction) this.beforeInteractionWrite(id, transaction);
        await this.tmux(['paste-buffer', '-p', '-d', '-b', buffer, '-t', terminalName(id)]);
        loaded = false;
        if (transaction) this.assertInteractionCurrent(id, transaction);
      }
      if (submit) {
        if (text) {
          await new Promise((wait) => setTimeout(wait, 80));
          if (transaction) this.assertInteractionCurrent(id, transaction);
        }
        if (transaction) this.beforeInteractionWrite(id, transaction);
        await this.tmux(['send-keys', '-t', terminalName(id), 'Enter']);
        if (transaction) this.assertInteractionCurrent(id, transaction);
      }
    } finally {
      this.invalidateScreen(id);
      this.pasteBuffers.delete(id);
      if (loaded) await this.tmux(['delete-buffer', '-b', buffer]).catch(() => undefined);
    }
  }

  async sendKeys(id: string, keys: string[]): Promise<void> {
    await this.ensureRestored(id);
    this.beginExternalMutation(id);
    try {
      const info = this.store.getTerminal(id);
      if (info.state === 'exited') throw new AppError('TERMINAL_NOT_RUNNING', 'This terminal is not running', 409);
      if (keys.length) await this.tmux(['send-keys', '-t', terminalName(id), ...keys]);
    } finally {
      this.invalidateScreen(id);
      this.endExternalMutation(id);
    }
  }

  /**
   * Plain text of the visible pane, for reading the CLI's own status line, without the blank rows
   * below the last drawn line.
   *
   * Concurrent readers share one capture, and a capture answers later readers for `SCREEN_CACHE_MS`
   * as long as nothing was written to the pane and nothing new came out of it. `fresh` always takes
   * a new capture, for a caller that needs to see the effect of its own write.
   */
  async screen(id: string, options: { fresh?: boolean } = {}): Promise<string | undefined> {
    await this.ensureRestored(id);
    const generation = this.screenGenerations.get(id) ?? 0;
    const runtime = this.runtime.get(id);
    const cached = this.screenReads.get(id);
    if (!options.fresh && cached && cached.generation === generation) {
      if (!cached.settled) return await cached.task;
      if (Date.now() - cached.startedAt < SCREEN_CACHE_MS && cached.runtime === runtime && cached.sequence === runtime?.sequence) return cached.text;
    }
    const read: ScreenRead = {
      generation, runtime, sequence: runtime?.sequence, startedAt: Date.now(), settled: false,
      task: this.tmux(['capture-pane', '-p', '-t', terminalName(id)]).then(trimTrailingBlankLines, () => undefined),
    };
    this.screenReads.set(id, read);
    const text = await read.task;
    read.text = text;
    read.settled = true;
    if (this.screenReads.get(id) === read && (text === undefined || (this.screenGenerations.get(id) ?? 0) !== generation)) this.screenReads.delete(id);
    return text;
  }

  /** Forget any capture taken before a write, so the next reader sees the pane after it. */
  private invalidateScreen(id: string): void {
    this.screenGenerations.set(id, (this.screenGenerations.get(id) ?? 0) + 1);
    this.screenReads.delete(id);
  }

  /** The pane's own process, so callers can look at what the CLI inside it is doing. */
  async panePid(id: string): Promise<number | undefined> {
    await this.ensureRestored(id);
    return await this.livePanePid(id);
  }

  private async livePanePid(id: string, timeoutMs = 3000): Promise<number | undefined> {
    try {
      const pid = Number((await this.runTmux(['list-panes', '-t', terminalName(id), '-F', '#{pane_pid}'], timeoutMs)).trim());
      return Number.isInteger(pid) && pid > 0 ? pid : undefined;
    } catch { return undefined; }
  }

  /**
   * When each terminal last drew anything, from tmux's own record. It is kept whether or not this service
   * is attached, so after a restart it still tells a CLI working on its own (its spinner redraws) from one
   * resting at its prompt (which draws nothing). Read-only; no tmux server reads as no activity.
   */
  async paneActivity(timeoutMs = 2000): Promise<Map<string, number>> {
    const activity = new Map<string, number>();
    let output: string;
    try { output = await this.runTmux(['list-windows', '-a', '-F', '#{session_name} #{window_activity}'], timeoutMs); }
    catch { return activity; }
    const ids = new Map(this.store.listTerminals().map(terminal => [terminalName(terminal.id), terminal.id]));
    for (const line of output.split('\n')) {
      const [name, seconds] = line.trim().split(' ');
      const terminalId = ids.get(name ?? ''), at = Number(seconds) * 1000;
      if (terminalId && Number.isSafeInteger(at) && at > 0) activity.set(terminalId, Math.max(activity.get(terminalId) ?? 0, at));
    }
    return activity;
  }

  /** The pane's visible text, read-only: unlike `screen` it never attaches a terminal that is not. */
  async paneText(id: string, timeoutMs = 2000): Promise<string | undefined> {
    try { return trimTrailingBlankLines(await this.runTmux(['capture-pane', '-p', '-t', terminalName(id)], timeoutMs)); }
    catch { return undefined; }
  }

  /**
   * Ends tmux sessions no terminal record can reach: one whose record is gone or says it exited (a
   * stop that failed half way, a create that died before saving it). Younger than [minAgeMs] is left
   * alone, since a session is created before its record is saved. Returns the session names ended.
   */
  async reapStraySessions(minAgeMs: number, now = Date.now(), timeoutMs = 2000): Promise<string[]> {
    let output: string;
    try { output = await this.runTmux(['list-panes', '-a', '-F', '#{session_name} #{session_created} #{pane_pid}'], timeoutMs); }
    catch { return []; }
    const records = new Map(this.store.listTerminals().map(terminal => [terminalName(terminal.id), terminal]));
    const reaped: string[] = [];
    for (const line of output.split('\n')) {
      const [name, created, pane] = line.trim().split(' ');
      if (!name?.startsWith('cw-') || reaped.includes(name)) continue;
      const record = records.get(name), createdAt = Number(created) * 1000;
      if ((record && record.state !== 'exited') || !(createdAt > 0) || now - createdAt < minAgeMs) continue;
      try { await this.runTmux(['kill-session', '-t', name], timeoutMs); }
      catch (error) { if (!tmuxTargetMissing(error)) continue; }
      const pid = Number(pane);
      if (Number.isSafeInteger(pid) && pid > 0) await stopProcessGroup(pid, PANE_HANGUP_GRACE_MS).catch(() => undefined);
      reaped.push(name);
    }
    return reaped;
  }

  /**
   * The private tmux server and each pane's own process, for the service monitor. One read-only
   * round trip that never starts a server; none running reads as no panes.
   */
  async paneProcesses(timeoutMs = 2000): Promise<{ serverPid?: number; panes: Array<{ terminalId: string; pid: number }> }> {
    let output: string;
    try { output = await this.runTmux(['list-panes', '-a', '-F', '#{pid} #{session_name} #{pane_pid}'], timeoutMs); }
    catch { return { panes: [] }; }
    // Session names are derived from terminal ids one way, so map back through the records.
    const ids = new Map(this.store.listTerminals().map(terminal => [terminalName(terminal.id), terminal.id]));
    let serverPid: number | undefined;
    const panes: Array<{ terminalId: string; pid: number }> = [];
    for (const line of output.split('\n')) {
      const [server, name, pane] = line.trim().split(' ');
      if (Number(server) > 0) serverPid = Number(server);
      const terminalId = ids.get(name ?? ''), pid = Number(pane);
      if (terminalId && Number.isSafeInteger(pid) && pid > 0) panes.push({ terminalId, pid });
    }
    return { ...(serverPid ? { serverPid } : {}), panes };
  }

  /** Open terminal websockets: each is one `subscribe` listener. */
  viewerCount(): number {
    let count = 0;
    for (const group of this.listeners.values()) count += group.size;
    return count;
  }

  /** Whether a terminal websocket is open on this terminal right now. */
  hasViewer(id: string): boolean {
    return Boolean(this.listeners.get(id)?.size);
  }

  /**
   * The processes running in a live native terminal's pane, for a driver that has to recognise its
   * own CLI there. Only the session's own linked terminal is read, and only processes whose working
   * directory is its project. `select` sees each argv with the launch marker the driver left
   * (`launchMarker`) and picks those worth a directory lookup. Read-only: it never attaches a client,
   * starts or signals anything. Answers undefined when the link does not hold or the complete
   * tree, argv and working directories could not be verified before `deadline`.
   */
  async inspectPane(terminalId: string, sessionId: string, options: { deadline: number; select: (argv: string[], launchMarker: string | undefined) => boolean }): Promise<PaneProcess[] | undefined> {
    const { deadline, select } = options;
    await this.ready;
    if (Date.now() >= deadline) return undefined;
    const linked = () => this.linkedNativeSession(terminalId, sessionId);
    const session = linked();
    if (!session) return undefined;
    const expectedCwd = await realpath(this.store.getProject(session.projectId).cwd);
    if (!linked() || Date.now() >= deadline) return undefined;

    // Check the persistent tmux session directly. This is read-only and does not attach a
    // terminal client or change saved running/detached state as a side effect.
    await this.runTmux(['has-session', '-t', terminalName(terminalId)], lookupStepTimeout(deadline));
    if (Date.now() >= deadline) return undefined;
    const panePid = await this.livePanePid(terminalId, lookupStepTimeout(deadline));
    if (!panePid || Date.now() >= deadline) return undefined;
    const pids = await this.paneProcessTree(panePid, deadline);
    if (!pids.length || Date.now() >= deadline) return undefined;

    const marker = await this.readLaunchMarker(terminalId, lookupStepTimeout(deadline));
    const found: PaneProcess[] = [];
    for (const pid of pids) {
      if (Date.now() >= deadline) return undefined;
      const argv = await processArgv(pid, lookupStepTimeout(deadline));
      if (!argv || !select(argv, marker)) continue;
      if (Date.now() >= deadline) return undefined;
      const processCwd = await processWorkingDirectory(pid, lookupStepTimeout(deadline));
      if (!processCwd) continue;
      const canonicalProcessCwd = await realpath(processCwd).catch(() => undefined);
      if (canonicalProcessCwd !== expectedCwd) continue;
      found.push({ pid, argv, ...(pid === panePid ? { root: true } : {}) });
    }
    return Date.now() < deadline && linked() ? found : undefined;
  }

  /**
   * The launch marker of a session's linked native terminal, while the pane still runs the very
   * process the marker was written for. tmux starts the launch command as the pane's own process,
   * whose argv does not change, and Riffet never respawns a pane, so the marker and that process
   * together identify the launch without scanning the process tree. Every caller shares one
   * `list-panes` for all panes. Undefined when there is no such record, the link does not hold, or
   * tmux did not answer; a caller that needs certainty then falls back to `inspectPane`.
   */
  async paneLaunchMarker(terminalId: string, sessionId: string): Promise<string | undefined> {
    await this.ready;
    if (!this.linkedNativeSession(terminalId, sessionId)) return undefined;
    const record = (await this.launchRecords())?.get(terminalName(terminalId));
    if (!record || record.dead || !record.marker || record.launchPid !== record.panePid) return undefined;
    return this.linkedNativeSession(terminalId, sessionId) ? record.marker : undefined;
  }

  /**
   * Records [marker] for a pane whose own process [pid] a full `inspectPane` lookup just matched to
   * it, so later checks of a terminal launched without a record (before records existed, or by an
   * earlier build) can use `paneLaunchMarker`. Nothing is written once the pane runs another process.
   */
  async adoptPaneLaunch(terminalId: string, sessionId: string, marker: string, pid: number): Promise<void> {
    await this.ready;
    if (!LAUNCH_MARKER.test(marker) || !this.linkedNativeSession(terminalId, sessionId)) return;
    if (await this.livePanePid(terminalId, LOOKUP_STEP_MS) !== pid || !this.linkedNativeSession(terminalId, sessionId)) return;
    const name = terminalName(terminalId);
    await this.runTmux(['set-option', '-t', name, LAUNCH_MARKER_OPTION, marker, ';', 'set-option', '-t', name, LAUNCH_PID_OPTION, String(pid)], LOOKUP_STEP_MS)
      .catch(() => undefined);
    this.launchRecordRead = undefined;
  }

  private linkedNativeSession(terminalId: string, sessionId: string): Session | undefined {
    const terminal = this.store.getTerminal(terminalId);
    const session = this.store.getSession(sessionId);
    return terminal.kind === 'native' && terminal.state !== 'exited' && terminal.sessionId === sessionId
      && session.kind === 'native' && session.terminalId === terminalId ? session : undefined;
  }

  /** Written in the launching tmux command itself, so the marker is never there without the pane process it describes. */
  private launchRecordCommands(id: string, marker: string): string[] {
    const name = terminalName(id);
    return [';', 'set-option', '-t', name, LAUNCH_MARKER_OPTION, marker, ';', 'set-option', '-F', '-t', name, LAUNCH_PID_OPTION, '#{pane_pid}'];
  }

  /** Every pane's launch record from one tmux read, shared by the callers that ask while it is fresh. */
  private async launchRecords(): Promise<Map<string, PaneLaunchRecord> | undefined> {
    const current = this.launchRecordRead;
    if (current && Date.now() - current.at < LAUNCH_RECORDS_FRESH_MS) return await current.read;
    const read = this.runTmux(['list-panes', '-a', '-F', `#{session_name}\t#{pane_pid}\t#{pane_dead}\t#{${LAUNCH_MARKER_OPTION}}\t#{${LAUNCH_PID_OPTION}}`], 3000)
      .then(output => {
        const records = new Map<string, PaneLaunchRecord>();
        for (const line of output.split('\n')) {
          const [name, pane, dead, marker, launch] = line.trim().split('\t');
          const panePid = Number(pane), launchPid = Number(launch);
          if (!name || !Number.isSafeInteger(panePid) || panePid < 1) continue;
          // A session with more than one pane is not a launch this service made; it has no record.
          if (records.has(name)) { records.set(name, { panePid, dead: true }); continue; }
          records.set(name, {
            panePid,
            dead: dead === '1',
            ...(marker && LAUNCH_MARKER.test(marker) ? { marker } : {}),
            ...(Number.isSafeInteger(launchPid) && launchPid > 0 ? { launchPid } : {}),
          });
        }
        return records;
      })
      .catch(() => undefined);
    const entry = { at: Date.now(), read };
    this.launchRecordRead = entry;
    const records = await read;
    // A failed read is not kept: the next caller asks tmux again.
    if (!records && this.launchRecordRead === entry) this.launchRecordRead = undefined;
    return records;
  }

  private async paneProcessTree(rootPid: number, deadline: number): Promise<number[]> {
    const pending = [rootPid];
    const seen = new Set<number>();
    while (pending.length && seen.size < MAX_PANE_PROCESSES && Date.now() < deadline) {
      const pid = pending.shift()!;
      if (!Number.isSafeInteger(pid) || pid < 1 || seen.has(pid)) continue;
      seen.add(pid);
      let output: string;
      try {
        output = (await exec('pgrep', ['-P', String(pid)], { timeout: lookupStepTimeout(deadline), maxBuffer: 1024 * 1024 })
          // pgrep uses exit 1 for no children. Other failures leave this subtree unknown.
          .catch(error => { if (error instanceof ExecError && error.code === 1) return { stdout: '' }; throw error; })).stdout;
      } catch { return []; }
      for (const line of output.split(/\r?\n/)) {
        const child = Number(line.trim());
        if (Number.isSafeInteger(child) && child > 0 && !seen.has(child)) pending.push(child);
      }
    }
    // A partial tree cannot prove that the selected endpoint is unique.
    return pending.some(pid => !seen.has(pid)) ? [] : [...seen];
  }

  private async readLaunchMarker(id: string, timeoutMs: number): Promise<string | undefined> {
    try {
      const value = (await this.runTmux(['show-option', '-qv', '-t', terminalName(id), LAUNCH_MARKER_OPTION], timeoutMs)).trim();
      return LAUNCH_MARKER.test(value) ? value : undefined;
    } catch { return undefined; }
  }

  /**
   * Recolours a live pane's default foreground and background. Only for programs that do not cache
   * the colours they probed at startup; a CLI that does has to be relaunched to see the change.
   */
  async setAppearance(id: string, appearance: TerminalAppearance): Promise<TerminalInfo> {
    await this.ensureRestored(id);
    const info = this.store.getTerminal(id);
    if (info.state === 'exited' || sameTerminalAppearance(info.appearance, appearance)) return info;
    if (await this.paneFeatures()) await this.tmux(this.appearanceCommands(id, appearance).slice(1));
    const updated = this.store.updateTerminal(id, { appearance });
    this.emit(id, { type: 'state', terminal: updated });
    return updated;
  }

  async stop(id: string): Promise<void> {
    await this.ensureRestored(id);
    await this.stopRestored(id);
  }

  /** Recheck and reserve synchronously after restoration so a warmup claim cannot race a stop. */
  private async stopRestored(id: string, expectedWarmupOwner?: string): Promise<boolean> {
    const info = this.store.getTerminal(id);
    if (expectedWarmupOwner !== undefined && (!isWarmupTerminal(info) || info.warmup.ownerToken !== expectedWarmupOwner)) return false;
    if (info.state === 'exited') return false;
    if (this.stopping.has(id)) throw this.interactionBusy();
    this.stopping.add(id);
    const pendingSnapshot = this.snapshotTimers.get(id);
    if (pendingSnapshot) { clearTimeout(pendingSnapshot); this.snapshotTimers.delete(id); }
    const attached = this.runtime.get(id);
    if (attached) attached.snapshotGeneration += 1;
    // Bump the control epoch before the first await so any active interaction becomes stale
    // immediately, even if tmux takes time to stop the session.
    this.store.updateTerminal(id, { ownerId: undefined, epoch: info.epoch + 1 });
    try {
      const panePid = await this.livePanePid(id, 2000);
      await this.killSession(id);
      // Killing the session only hangs up the pane; a CLI that ignores SIGHUP would outlive it untracked.
      if (panePid) await stopProcessGroup(panePid, PANE_HANGUP_GRACE_MS).catch(() => undefined);
      const currentRuntime = this.runtime.get(id);
      if (currentRuntime) {
        this.runtime.delete(id);
        currentRuntime.control.kill();
      }
      const updated = this.store.updateTerminal(id, { state: 'exited', ownerId: undefined });
      this.emit(id, { type: 'state', terminal: updated });
      this.emit(id, { type: 'exit', exitCode: 0 });
      this.clearObservers(id);
      this.screenReads.delete(id);
      this.screenGenerations.delete(id);
      this.reportLinkedTerminal(updated, false);
      return true;
    } finally {
      this.stopping.delete(id);
    }
  }

  async closeAll(): Promise<void> {
    this.shuttingDown = true;
    await Promise.allSettled([...this.liveCreations.values(), ...this.restorations.values(), ...this.finalizations.values()]);
    const attachedIds = new Set(this.runtime.keys());
    for (const [id, attached] of this.runtime) {
      attached.snapshotGeneration += 1;
      const info = this.store.getTerminal(id);
      const updated = this.store.updateTerminal(id, { state: 'detached', ownerId: undefined, epoch: info.epoch + 1 });
      this.emit(id, { type: 'state', terminal: updated });
      attached.control.kill(); // Killing tmux's client detaches it; it does not kill the tmux session.
    }
    this.runtime.clear();
    for (const info of this.store.listTerminals()) {
      if (info.state === 'exited' || attachedIds.has(info.id)) continue;
      const updated = this.store.updateTerminal(info.id, { state: 'detached', ownerId: undefined, epoch: info.epoch + 1 });
      this.emit(info.id, { type: 'state', terminal: updated });
    }
    this.observers.clear();
    for (const timer of this.snapshotTimers.values()) clearTimeout(timer);
    this.snapshotTimers.clear();
    if (this.options.ephemeral) await this.runTmux(['kill-server'], 3000).catch(() => undefined);
  }

  /** The socket of this service's tmux server; the orphan sweep never ends it. */
  get socket(): string { return this.socketPath; }

  /**
   * Restates this service as the owner of its tmux server, which an earlier instance may have started
   * (`terminal/orphans.ts`). Starts nothing: without a running server the command fails and is ignored.
   */
  async claimServer(): Promise<void> {
    await this.runTmux(claimTmuxServerCommands(this.stateDir), 2000).catch(() => undefined);
  }

  private async restoreMany(ids: string[]): Promise<void> {
    let index = 0;
    const worker = async () => {
      for (;;) {
        const current = index++;
        if (current >= ids.length) return;
        await this.ensureRestored(ids[current]!);
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, ids.length) }, worker));
  }

  private async ensureRestored(id: string): Promise<void> {
    const finalizing = this.finalizations.get(id);
    if (finalizing) return finalizing;
    const first = this.store.getTerminal(id);
    if (first.state === 'exited' || this.runtime.has(id)) return;
    if (this.shuttingDown) throw new AppError('TERMINAL_SERVICE_CLOSED', 'Terminal service is shutting down', 503);
    const current = this.restorations.get(id);
    if (current) return current;
    const task = (async () => {
      const info = this.store.getTerminal(id);
      if (info.state === 'exited' || this.runtime.has(id)) return;
      if (isWarmupTerminal(info) && info.warmup.expiresAt <= Date.now()) {
        await this.killSession(id).catch(() => undefined);
        const updated = this.store.updateTerminal(id, { state: 'exited', ownerId: undefined, epoch: info.epoch + 1 });
        this.emit(id, { type: 'state', terminal: updated });
        this.emit(id, { type: 'exit', exitCode: info.exitCode });
        return;
      }
      try {
        if (await this.hasSession(id)) {
          const dead = await this.paneExitCode(id);
          if (dead !== undefined) { await this.finishExit(id, dead); return; }
          await this.attach(info, this.store.getProject(info.projectId));
        } else {
          const updated = this.store.updateTerminal(id, { state: 'exited', ownerId: undefined, epoch: info.epoch + 1 });
          this.emit(id, { type: 'state', terminal: updated });
          this.emit(id, { type: 'exit', exitCode: info.exitCode });
          this.clearObservers(id);
          this.reportLinkedTerminal(updated, false);
        }
      } catch {
        const fresh = this.store.getTerminal(id);
        if (fresh.state === 'exited') return;
        const updated = this.store.updateTerminal(id, { state: 'detached', ownerId: undefined, epoch: fresh.epoch + 1 });
        this.emit(id, { type: 'state', terminal: updated });
      }
    })();
    this.restorations.set(id, task);
    try { await task; }
    finally { if (this.restorations.get(id) === task) this.restorations.delete(id); }
  }

  /** Control mode needs `pause-after` and `refresh-client -A` (tmux 3.2); there is no older attach path. */
  private async assertTmuxVersion(): Promise<void> {
    const version = await (this.tmuxVersion ??= run('tmux', ['-V']).then(text => text.trim()).catch(error => { this.tmuxVersion = undefined; throw error; }));
    if (tmuxTooOld(version)) throw new AppError('TMUX_TOO_OLD', `${version} is too old: Riffet terminals need tmux ${TMUX_MIN_VERSION} or newer`, 503);
  }

  /**
   * Pane options and `capture-pane -N` both arrived in tmux 3.1. An older server keeps its default
   * pane colours, which viewers paint with the recorded appearance, and the legacy text capture.
   */
  private paneFeatures(): Promise<boolean> {
    return this.tmuxPaneFeatures ??= this.tmux(['start-server', ';', 'list-commands'])
      .then(commands => /^capture-pane\b[^\n]*\[-[^\]]*N[^\]]*\]/m.test(commands))
      .catch(error => { this.tmuxPaneFeatures = undefined; throw error; });
  }

  /** No appearance leaves the pane on tmux's defaults, which each viewer paints with its own theme. */
  private appearanceCommands(id: string, appearance: TerminalAppearance | undefined): string[] {
    const style = appearance ? `fg=${appearance.foreground},bg=${appearance.background}` : 'default';
    return [';', 'set-option', '-p', '-t', `${terminalName(id)}:0.0`, 'window-style', style, ';', 'set-option', '-p', '-t', `${terminalName(id)}:0.0`, 'window-active-style', style];
  }

  private async attach(info: TerminalInfo, project: Project): Promise<void> {
    // Every subscribe comes through here: an attached terminal has nothing to do, least of all a resize
    // from a stale record that would undo the controller's newer one.
    if (this.shuttingDown || this.runtime.has(info.id)) return;
    await this.assertTmuxVersion();
    const name = terminalName(info.id);
    await this.tmux(['set-option', '-w', '-t', name, 'remain-on-exit', 'on', ';', 'set-hook', '-t', name, 'pane-died', `detach-client -s ${name}`, ...(await this.paneFeatures().catch(() => false) ? this.appearanceCommands(info.id, info.appearance) : [])]);
    const dead = await this.paneExitCode(info.id);
    if (dead !== undefined) { await this.finishExit(info.id, dead); return; }
    // The window keeps the size its last viewer gave it; an attached control client never sets one.
    // `resize-window` also makes this window's `window-size` manual, which sessions created before
    // control mode lack.
    const size = this.store.getTerminal(info.id);
    const pane = (await this.tmux([
      'set-option', '-t', name, 'status', 'off',
      ';', 'resize-window', '-t', name, '-x', String(size.cols), '-y', String(size.rows),
      ';', 'display-message', '-p', '-t', name, '#{pane_id}',
    ])).trim();
    if (!/^%\d+$/.test(pane)) throw new AppError('TMUX_COMMAND_FAILED', 'tmux could not complete the terminal operation', 503);
    if (this.shuttingDown || this.runtime.has(info.id)) return;
    const control: ControlClient = new ControlClient(this.socketPath, name, {
      output: (from, data) => { if (from === pane) this.queueOutput(info.id, runtime, data); },
      pause: from => {
        if (from !== pane || this.runtime.get(info.id) !== runtime) return;
        // tmux stopped sending: the stream has a gap, so every viewer starts over from a seed. The pane
        // must be resumed even with no viewer: the tail, title and startup-error readers live on this stream.
        this.flushOutput(info.id, runtime);
        const viewers = [...this.listeners.get(info.id) ?? []];
        if (viewers.length) this.seedViewers(info.id, viewers, { resume: true });
        else void control.request(`refresh-client -A '${pane}:continue'`).catch(() => undefined);
      },
      exit: () => { void this.onAttachExit(info.id, runtime); },
    }, {
      // The client's cwd is irrelevant to the tmux session, but a missing one makes the spawn exit at once.
      cwd: existsSync(project.cwd) ? project.cwd : homedir(),
      env: this.tmuxProcessEnv(),
    });
    const runtime: TerminalRuntime = { terminalId: info.id, kind: info.kind, ...this.behaviourOf(info), control, pane, sequence: 0, streamId: randomUUID(), modes: new OuterTerminalState(), output: new OutputTail(), pending: [], lastOutputAt: Date.now(), attachedAt: Date.now(), snapshotGeneration: 0 };
    this.runtime.set(info.id, runtime);
    const current = this.store.getTerminal(info.id);
    const updated = this.store.updateTerminal(info.id, { state: 'running', ownerId: undefined, epoch: current.epoch + 1 });
    this.reportLinkedTerminal(updated, true);
    this.emit(info.id, { type: 'state', terminal: updated });
    // Viewers that were waiting for a pane (or watched the last attach) start over on this stream.
    this.seedViewers(info.id, this.listeners.get(info.id) ?? []);
    if (!this.listeners.has(info.id)) setTimeout(() => this.restoreBackgroundSize(info.id), BACKGROUND_RESIZE_DELAY_MS).unref?.();
  }

  /**
   * Output arrives as many short `%output` lines. The lines of one read of the control stream are
   * delivered as one chunk, at the end of that read or when a seed needs the stream up to date.
   */
  private queueOutput(id: string, runtime: TerminalRuntime, data: string): void {
    if (runtime.pending.push(data) === 1) queueMicrotask(() => this.flushOutput(id, runtime));
  }

  private flushOutput(id: string, runtime: TerminalRuntime): void {
    if (!runtime.pending.length) return;
    const data = runtime.pending.join('');
    runtime.pending.length = 0;
    if (this.runtime.get(id) !== runtime || this.shuttingDown) return;
    runtime.lastOutputAt = Date.now();
    runtime.sequence += 1;
    runtime.output.append(data);
    runtime.modes.accept(data);
    if (runtime.behaviour?.ready && !runtime.agentReady) runtime.agentReady = runtime.behaviour.ready(stripTerminalSequences(runtime.output.tail(16 * 1024)));
    this.emit(id, { type: 'output', data, sequence: runtime.sequence, streamId: runtime.streamId });
  }

  private async onAttachExit(id: string, runtime: TerminalRuntime): Promise<void> {
    if (this.runtime.get(id) !== runtime) return;
    runtime.snapshotGeneration += 1;
    const pendingSnapshot = this.snapshotTimers.get(id);
    if (pendingSnapshot) { clearTimeout(pendingSnapshot); this.snapshotTimers.delete(id); }
    if (this.shuttingDown) return;
    const dead = await this.paneExitCode(id).catch(() => undefined);
    if (this.shuttingDown) return;
    if (dead !== undefined) { await this.finishExit(id, dead, runtime); return; }
    if (this.runtime.get(id) === runtime) this.runtime.delete(id);
    // Unknown counts as alive: the reattach below asks again, and only a definite answer ends the terminal.
    const alive = await this.hasSession(id).catch(() => true);
    if (this.shuttingDown) return;
    if (alive) {
      const info = this.store.getTerminal(id);
      const updated = this.store.updateTerminal(id, { state: 'detached', ownerId: undefined });
      this.emit(id, { type: 'state', terminal: updated });
      const failures = Date.now() - runtime.attachedAt < ATTACH_STABLE_MS ? (this.attachFailures.get(id) ?? 0) + 1 : 0;
      this.attachFailures.set(id, failures);
      setTimeout(() => {
        if (this.shuttingDown || this.runtime.has(id)) return;
        void this.attach(info, this.store.getProject(info.projectId)).catch(() => undefined);
      }, Math.min(REATTACH_DELAY_MS * 2 ** Math.max(0, failures - 1), REATTACH_MAX_DELAY_MS)).unref();
      return;
    }
    this.attachFailures.delete(id);
    await this.finishExit(id, this.store.getTerminal(id).exitCode, runtime);
  }

  /** A retained dead pane is the authority; the outer tmux client's exit status is unrelated. */
  private async paneExitCode(id: string): Promise<number | null | undefined> {
    const result = await this.tmux(['display-message', '-p', '-t', terminalName(id), '#{pane_dead};#{pane_dead_status};#{pane_dead_signal}']);
    const [dead, status, signal] = result.trim().split(';');
    if (dead !== '1') return undefined;
    if (status && /^\d+$/.test(status)) return Number(status);
    if (signal && /^\d+$/.test(signal)) return 128 + Number(signal);
    const signalName = signal?.toUpperCase().replace(/^SIG/, '');
    const signalNumber = signalName ? osConstants.signals[`SIG${signalName}` as keyof typeof osConstants.signals] : undefined;
    if (signalNumber) return 128 + signalNumber;
    return null;
  }

  private finishExit(id: string, exitCode: number | null | undefined, runtime?: TerminalRuntime): Promise<void> {
    const current = this.finalizations.get(id);
    if (current) return current;
    const task = this.completeExit(id, exitCode, runtime).finally(() => {
      if (this.finalizations.get(id) === task) this.finalizations.delete(id);
    });
    this.finalizations.set(id, task);
    return task;
  }

  private async completeExit(id: string, exitCode: number | null | undefined, runtime?: TerminalRuntime): Promise<void> {
    if (this.shuttingDown) return;
    const info = this.store.getTerminal(id);
    if (info.state === 'exited' || this.stopping.has(id)) return;
    // A viewer still waiting for its seed would otherwise see no output at all from a short-lived
    // command, so deliver the retained final pane before announcing exit or destroying tmux's only
    // authoritative copy of the error output.
    const source = runtime ?? this.runtime.get(id);
    if (source) this.flushOutput(id, source);
    const viewers = [...(this.listeners.get(id) ?? [])];
    if (viewers.length) {
      const seeds = await this.captureSeed(id, source?.modes ?? new OuterTerminalState());
      if (this.shuttingDown || this.stopping.has(id)) return;
      const marker = { sequence: source?.sequence ?? 0, streamId: source?.streamId ?? randomUUID() };
      for (const viewer of viewers) {
        const seed = viewer.protocol >= 3 ? seeds.full : seeds.screenOnly;
        if (seed) this.sendSnapshot(viewer, marker, seed);
        else if (source?.output.length) this.sendSnapshot(viewer, marker, { data: '\u001bc' + source.output.text(), cols: info.cols, rows: info.rows });
      }
    }
    const behaviour = source?.behaviour ?? this.behaviourFor(info.kind, info.sessionId, isWarmupTerminal(info) ? warmupOf(info).backendId : undefined);
    let startupError = source && !source.agentReady
      ? behaviour?.startupError?.(redactSensitiveText(stripTerminalSequences(source.output.text()))) : undefined;
    // The stream starts at attach: a CLI that printed its error before then, or exited before Riffet
    // attached at all, left the words only on the retained pane, which `killSession` below destroys.
    if (!startupError && behaviour?.startupError && !source?.agentReady) {
      startupError = await this.paneStartupError(id, behaviour);
      if (this.shuttingDown || this.stopping.has(id)) return;
    }
    const updated = this.store.updateTerminal(id, { state: 'exited', exitCode: exitCode ?? undefined, ownerId: undefined, epoch: info.epoch + 1 });
    const attached = this.runtime.get(id);
    this.runtime.delete(id);
    if (attached) attached.control.kill();
    this.reportLinkedTerminal(updated, false, startupError);
    this.emit(id, { type: 'state', terminal: updated });
    this.emit(id, { type: 'exit', exitCode: exitCode ?? undefined });
    this.clearObservers(id);
    await this.killSession(id).catch(() => undefined);
  }

  /**
   * A dead pane's own text read as a startup failure. Without a stream there is no record of the Agent
   * having come up, so the pane answers that too; a start fails within a screenful or two, so the tail suffices.
   */
  private async paneStartupError(id: string, behaviour: TerminalBehaviour): Promise<string | undefined> {
    const captured = await this.tmux(['capture-pane', '-p', '-J', '-S', `-${STARTUP_SCAN_LINES}`, '-t', terminalName(id)]).catch(() => undefined);
    if (!captured?.trim()) return undefined;
    const text = redactSensitiveText(stripTerminalSequences(captured));
    if (behaviour.ready?.(text)) return undefined;
    return behaviour.startupError?.(text);
  }

  private commandFor(kind: TerminalInfo['kind'], input: TerminalCreateInput): { command: string; args: string[]; env?:NodeJS.ProcessEnv; tmuxEnv?: Record<string, string> } {
    if (kind === 'shell') return { command: defaultShell(), args: ['-i', ...(input.args ?? [])] };
    const spec = input.launchSpec;
    if (!spec) throw new AppError('NATIVE_LAUNCH_REQUIRED', 'A native terminal needs an adapter launch specification', 400);
    return { command: spec.command, args: [...spec.args], tmuxEnv: spec.env };
  }

  /** What the pane reader needs of the Agent behind a terminal, as fields of its runtime. */
  private behaviourOf(info: TerminalInfo): { behaviour?: TerminalBehaviour } {
    const behaviour = this.behaviourFor(info.kind, info.sessionId, isWarmupTerminal(info) ? warmupOf(info).backendId : undefined);
    return behaviour ? { behaviour } : {};
  }

  private behaviourFor(kind: TerminalInfo['kind'], sessionId: string | undefined, backendId: NativeBackendId | undefined): TerminalBehaviour | undefined {
    if (kind === 'shell' || kind === 'login') return undefined;
    return this.options.behaviour?.resolve({ kind, ...(sessionId ? { sessionId } : {}), ...(backendId ? { backendId } : {}) });
  }

  private launchEnv(): { managed: string[]; secrets: string[] } {
    const declared = this.options.behaviour?.launchEnv();
    for (const name of declared?.managed ?? []) this.seenLaunchEnv.managed.add(name);
    for (const name of declared?.secrets ?? []) this.seenLaunchEnv.secrets.add(name);
    return { managed: [...this.seenLaunchEnv.managed], secrets: [...this.seenLaunchEnv.secrets] };
  }

  /** The daemon's own credentials never reach a pane that does not set them itself. */
  private tmuxProcessEnv(extra?:NodeJS.ProcessEnv):NodeJS.ProcessEnv {
    const env={...process.env,...extra};
    for(const name of this.launchEnv().secrets)if(!extra||!Object.prototype.hasOwnProperty.call(extra,name))delete env[name];
    return env;
  }

  private async runTmux(args:string[],timeout=5000,extraEnv?:NodeJS.ProcessEnv,maxBuffer?:number):Promise<string> {
    return run('tmux',['-S',this.socketPath,...args],timeout,this.tmuxProcessEnv(extraEnv),maxBuffer);
  }

  private assertController(id: string, clientId: string, epoch: number): TerminalInfo {
    requireString(clientId, 'clientId', 200);
    const info = this.store.getTerminal(id);
    if (!Number.isInteger(epoch) || !info.ownerId || info.ownerId !== clientId || info.epoch !== epoch) {
      throw new AppError('TERMINAL_CONTROL_STALE', 'Terminal input lease is stale; claim control again', 409, { epoch: info.epoch, ownerId: info.ownerId });
    }
    if (info.state !== 'running') throw new AppError('TERMINAL_NOT_RUNNING', 'This terminal is not running', 409);
    return info;
  }

  private assertNoInteraction(id: string): void {
    if (this.interactions.has(id) || this.stopping.has(id) || (this.externalMutations.get(id) ?? 0) > 0 || this.pasteBuffers.has(id)) {
      throw this.interactionBusy();
    }
  }

  private beginExternalMutation(id: string, usesPasteBuffer = false): void {
    this.assertNoInteraction(id);
    if (usesPasteBuffer && this.pasteBuffers.has(id)) throw this.interactionBusy();
    this.externalMutations.set(id, (this.externalMutations.get(id) ?? 0) + 1);
  }

  private endExternalMutation(id: string, usesPasteBuffer = false): void {
    const remaining = (this.externalMutations.get(id) ?? 1) - 1;
    if (remaining > 0) this.externalMutations.set(id, remaining);
    else this.externalMutations.delete(id);
    if (usesPasteBuffer) this.pasteBuffers.delete(id);
    this.notifyOperationWaiters(id);
  }

  private hasExclusiveOperation(id: string): boolean {
    return this.interactions.has(id) || (this.externalMutations.get(id) ?? 0) > 0 || this.pasteBuffers.has(id);
  }

  private async waitForExclusiveOperation(id: string): Promise<void> {
    while (this.hasExclusiveOperation(id)) {
      await new Promise<void>(resolveWait => {
        const waiters = this.operationWaiters.get(id) ?? new Set<() => void>();
        waiters.add(resolveWait);
        this.operationWaiters.set(id, waiters);
      });
    }
  }

  private notifyOperationWaiters(id: string): void {
    if (this.hasExclusiveOperation(id)) return;
    const waiters = this.operationWaiters.get(id);
    if (!waiters) return;
    this.operationWaiters.delete(id);
    for (const resolveWait of waiters) resolveWait();
  }

  private assertInteractionCurrent(id: string, transaction: InteractionTransaction): void {
    const info = this.store.getTerminal(id);
    if (this.shuttingDown || this.stopping.has(id) || this.interactions.get(id) !== transaction || this.runtime.get(id) !== transaction.runtime || info.epoch !== transaction.epoch || info.state !== 'running') {
      throw new AppError('TERMINAL_INTERACTION_STALE', 'Terminal interaction lost control; read the current screen before continuing', 409, { epoch: info.epoch, ownerId: info.ownerId });
    }
    transaction.authorize?.();
  }

  private beforeInteractionWrite(id: string, transaction: InteractionTransaction): void {
    this.assertInteractionCurrent(id, transaction);
    if (!transaction.writeStarted) {
      transaction.beforeWrite?.();
      transaction.writeStarted = true;
    }
  }

  private interactionBusy(): AppError {
    return new AppError('TERMINAL_INTERACTION_BUSY', 'Another operation currently controls this terminal', 409);
  }

  /** Throws when tmux cannot answer: a slow or wedged server is not proof the CLI is gone. */
  private async hasSession(id: string): Promise<boolean> {
    try {
      await this.tmux(['has-session', '-t', terminalName(id)]);
      return true;
    } catch (error) {
      if (tmuxTargetMissing(error)) return false;
      throw error;
    }
  }

  /** Throws unless the session is gone, so a caller never records a stop that did not happen. */
  private async killSession(id: string): Promise<void> {
    try { await this.tmux(['kill-session', '-t', terminalName(id)]); }
    catch (error) {
      if (tmuxTargetMissing(error)) return;
      throw error;
    }
  }

  /**
   * Seed every viewer again once the pane has been quiet for a moment after a size change. Scrollback
   * is kept as physical rows at the width it was captured, so it cannot follow a new width by itself,
   * and a TUI drawn at the old size must not be repainted onto a grid of another shape.
   */
  private scheduleSnapshot(id: string): void {
    const runtime = this.runtime.get(id);
    if (!runtime) return;
    const pending = this.snapshotTimers.get(id);
    if (pending) clearTimeout(pending);
    const generation = ++runtime.snapshotGeneration;
    runtime.reseedBy ??= Date.now() + RESEED_MAX_WAIT_MS;
    this.armSnapshotTimer(id, runtime, generation, SNAPSHOT_OUTPUT_QUIET_MS);
  }

  private armSnapshotTimer(id: string, runtime: TerminalRuntime, generation: number, delay: number): void {
    const timer = setTimeout(() => {
      this.snapshotTimers.delete(id);
      if (this.shuttingDown || this.runtime.get(id) !== runtime || runtime.snapshotGeneration !== generation) return;
      const remainingQuietTime = SNAPSHOT_OUTPUT_QUIET_MS - (Date.now() - runtime.lastOutputAt);
      if (remainingQuietTime > 0 && Date.now() < (runtime.reseedBy ?? 0)) {
        this.armSnapshotTimer(id, runtime, generation, Math.min(remainingQuietTime, Math.max(0, (runtime.reseedBy ?? 0) - Date.now())));
        return;
      }
      runtime.reseedBy = undefined;
      this.seedViewers(id, this.listeners.get(id) ?? []);
    }, delay);
    timer.unref?.();
    this.snapshotTimers.set(id, timer);
  }

  /**
   * The same seed as a viewer gets, read with separate tmux calls: a finished pane has no control client
   * left to ask, and its screen no longer changes.
   */
  private async captureSeed(id: string, modes: OuterTerminalState): Promise<{ screenOnly?: Seed; full?: Seed }> {
    try {
      const blocks = await Promise.all(seedCommands(terminalName(id)).map(async tokens => {
        const text = await this.runTmux(tokens, 5000, undefined, HISTORY_CAPTURE_BYTES);
        return (text === '' ? [] : text.replace(/\n$/, '').split('\n')).map(line => Buffer.from(line, 'utf8'));
      }));
      return { full: assembleSeed(blocks, modes, true), screenOnly: assembleSeed(blocks, modes, false) };
    } catch { return {}; }
  }

  private async tmux(args: string[]): Promise<string> {
    return await this.runTmux(args);
  }

  private prepareSocketDirectory(): void {
    mkdirSync(this.socketDirectory, { recursive: true, mode: 0o700 });
    chmodSync(this.socketDirectory, 0o700);
  }

  /** Reports whether the session's own terminal is alive; `Session.state` itself is derived (see `deriveSessionState`). */
  private reportLinkedTerminal(terminal: TerminalInfo, live: boolean, startupError?: string): void {
    if (!terminal.sessionId || !isAgentTerminal(terminal.kind)) return;
    const session = this.store.getSession(terminal.sessionId);
    if (session.kind !== 'native' || session.archivedAt || session.terminalId !== terminal.id) return;
    const state = deriveSessionState({ current: session.state, terminalLive: live, startError: Boolean(startupError) });
    if (state === session.state && !(state !== 'failed' && session.error)) return;
    const updated = this.store.updateSession(session.id, { ...sessionStatePatch(session, state, startupError), terminalId: terminal.id });
    if (startupError) this.store.appendEvent(session.id, 'session', { session: updated });
  }

  private emit(id: string, message: TerminalServerMessage): void {
    for (const viewer of [...this.listeners.get(id) ?? []]) {
      if (message.type === 'output') {
        // What a viewer waiting for a seed would be sent is already in that seed.
        if (viewer.seeding) continue;
        if (viewer.protocol >= 3 && (viewer.unacked += message.data.length) > MAX_UNACKED_CHARS + viewer.seedChars) {
          // Not reading: stop queueing for it and start it over, rather than disconnect it.
          this.seedViewers(id, [viewer]);
          continue;
        }
      }
      try { viewer.send(message); } catch { /* Disconnected browsers do not own the tmux process. */ }
    }
    const observation = observationFor(id, message);
    if (observation) this.deliver(id, observation);
  }

  private deliver(id: string, observation: TerminalObservation): void {
    const group = this.observers.get(id);
    if (!group || group.size === 0) return;
    for (const callback of [...group]) {
      try { callback(observation); } catch { /* Observers are best-effort hints; they must not interrupt terminal handling. */ }
    }
  }

  private clearObservers(id: string): void {
    this.observers.delete(id);
  }
}

/** argv is read directly on Linux so whitespace and quoting are never ambiguous. */
async function processArgv(pid: number, timeoutMs = 1500): Promise<string[] | undefined> {
  if (!Number.isSafeInteger(pid) || pid < 1) return undefined;
  if (process.platform === 'linux') {
    try {
      const bytes = await readFile(`/proc/${pid}/cmdline`);
      const argv = bytes.toString('utf8').split('\0').filter(Boolean);
      return argv.length ? argv : undefined;
    } catch { return undefined; }
  }
  try {
    const commandLine = await run('ps', ['-ww', '-p', String(pid), '-o', 'command='], timeoutMs);
    return parsePsCommandLine(commandLine);
  } catch { return undefined; }
}

async function processWorkingDirectory(pid: number, timeoutMs = 1500): Promise<string | undefined> {
  if (!Number.isSafeInteger(pid) || pid < 1) return undefined;
  if (process.platform === 'linux') {
    try { return await readlink(`/proc/${pid}/cwd`); }
    catch { return undefined; }
  }
  try {
    const output = await run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], timeoutMs);
    return output.split(/\r?\n/).find((line) => line.startsWith('n'))?.slice(1) || undefined;
  } catch { return undefined; }
}

function observationFor(id: string, message: TerminalServerMessage): TerminalObservation | undefined {
  if (message.type === 'output') return { type: 'output', terminalId: id, data: message.data, sequence: message.sequence };
  if (message.type === 'state') return { type: 'state', terminalId: id, terminal: message.terminal };
  if (message.type === 'exit') return { type: 'exit', terminalId: id, exitCode: message.exitCode ?? -1 };
  return undefined;
}
