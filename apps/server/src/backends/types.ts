import type {
  CapabilityReport, CommandResult, ConfigFile, GatewayProtocol, LoadedExtensions, ModelInfo, NativeActivity, NativeBackendCapabilities, NativeBackendId, NativeBackendProfile, NativeBackendUsage, ExtensionRuntimeReport, ExtensionActionRequest, ExtensionActionResult, ExtensionItem, ExtensionManagementCapabilities,
  NativeInteraction, NativeInteractionResponse, NativeInteractionResult,
  NativeRunConfig, NativeRunInput, NativeRuntimeActionRequest, NativeStatus, NativeStopRequest, NativeStreamMessage, NativeWorkbenchEvent, NativeTurnTarget,
  NativeSlashItem, Project, Run, RunMetrics, Session, TerminalAppearance, TerminalInfo, ShareSelection, ShareTurn, ShareModelInfo,
} from '../../../../packages/contracts/src/index.js';
import type { StatsSink, UsageTranscript } from '../stats/types.js';
import type { Journal } from '../journal/journal.js';
import type { LaneWriter, TranscriptSource, TurnEndStatus } from '../journal/ingest.js';
import type { TerminalBehaviour, TerminalInteractionControl, TerminalLaunchEnv, TerminalObserver, TerminalService } from '../terminal/service.js';
import type { CliVersionRange } from './shared/cli-version.js';
import type { AgentExtensionLayout } from '@riffet/plugin-api';

export type NativeTerminalControls = Pick<TerminalService,
  'get' | 'screen' | 'paste' | 'sendKeys' | 'stop' | 'observe' | 'subscribe' | 'withInteraction' | 'panePid'
  | 'createWarmup' | 'claimWarmup' | 'extendWarmup' | 'listWarmups' | 'stopWarmup'>
  & Partial<Pick<TerminalService, 'inspectPane'>>;

/** Server-only profile settings. Keep secrets and provider command details out of HTTP responses. */
export interface NativeBackendProfileConfig extends NativeBackendProfile {
  config: Record<string, unknown>;
}

/** A backend's project config files: an `id` is the driver's own token for a file, and one it does not know fails `CONFIG_NOT_FOUND` (404). */
export interface NativeProjectConfigs {
  list(host: NativeBackendHost, project: Project, profile: NativeBackendProfileConfig): Promise<ConfigFile[]>;
  read(host: NativeBackendHost, project: Project, profile: NativeBackendProfileConfig, id: string): Promise<ConfigFile>;
  write(host: NativeBackendHost, project: Project, profile: NativeBackendProfileConfig, id: string, content: string, expectedHash: string): Promise<ConfigFile>;
  create(host: NativeBackendHost, project: Project, profile: NativeBackendProfileConfig, input: { kind: ConfigFile['kind']; path: string; content: string }): Promise<ConfigFile>;
}

/** An exact process launch selected by a trusted adapter, never accepted from an HTTP body. */
export interface NativePtyLaunchSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** Secrets the CLI reads from its environment; never placed on any command line. */
  secretEnv?: Record<string, string>;
  cwd: string;
  title?: string;
  /**
   * An opaque, secret-free fingerprint (64 hex digits) kept beside the pane, so the driver can tell
   * its own launch from a look-alike in `inspectPane` later.
   */
  launchMarker?: string;
  /** The terminal kind clients see; `native` unless the backend is the first one Riffet had (`cursor`, the value old clients know). */
  kind?: 'native' | 'cursor';
  /** A live terminal of the session is returned instead of launching another; concurrent launches share one start. */
  reuseLive?: boolean;
}

/** Values that identify the native execution endpoint whose input is about to be sent. */
export interface NativeDispatchBinding {
  backendId?: NativeBackendId;
  nativeSessionId?: string;
  nativeTurnId?: string;
  ownerRunId?: string;
  terminalId?: string;
  terminalEpoch?: number;
  baselineSequence?: number;
  renderedText?: string;
  /** Opaque native entry boundary, persisted with the no-replay fence before provider input. */
  nativeInputBoundary?: string;
  /** See `NativeRunDetails.slashCommand`; omit to let the text decide. */
  slashCommand?: boolean;
  resolvedConfig?: NativeRunConfig;
}

/**
 * What a driver reports of a conversation outside its transcript, on the control path (docs/SYNC-V3.md):
 * the provider's status, context and step metrics, a background job's state, a session record it just
 * wrote, and whether a subagent is running (which keeps the conversation busy unless the backend's
 * subagents are detached; `running` absent says nothing new). The transcript itself only reaches clients
 * through the session journal (`transcript`).
 */
export type NativeControlMessage =
  | Extract<NativeStreamMessage, { type: 'status' | 'context' | 'metrics' | 'job' | 'session' }>
  | { type: 'subagent'; toolCallId: string; agentId: string; running?: boolean };

/** A caller-owned, complete transcript read which neither starts nor observes an execution runtime. */
export interface NativeShareReadOptions {
  selection?: ShareSelection;
  catalogOnly?: boolean;
  messagesOnly?: boolean;
  signal?: AbortSignal;
}

export interface NativeShareTranscript {
  events: NativeWorkbenchEvent[];
  /** Historical model facts keyed by provider message identity. Never exported without filtering. */
  modelInfo?: Record<string, ShareModelInfo>;
  /** Historical facts available only at the native turn boundary. */
  turnModels?: Record<string, ShareModelInfo>;
  /** Conflicting historical contexts must not be replaced by an older dispatch configuration. */
  ambiguousModelTurns?: string[];
  subagents: Array<{ toolCallId: string; agentId: string; title?: string; prompt?: string; subagentType?: string; model?: string; events: NativeWorkbenchEvent[] }>;
  jobs?: import('../../../../packages/contracts/src/index.js').NativeJob[];
  warnings?: string[];
  turns?: ShareTurn[];
  selectedTurnIds?: string[];
}

/** Durable response fence for idempotent native protocol interactions. */
export interface NativeInteractionReceipt {
  fingerprint: string;
  interactionId: string;
  revision: string;
  result: NativeInteractionResult;
  createdAt: string;
}

export interface NativeBackendHost {
  getSession(sessionId: string): Session;
  /** Original input from the real journal or an unassigned new thread, never a partial tail index. */
  firstUserMessage?(sessionId: string): string | undefined;
  getProject(projectId: string): Project;
  /** Every session, for a driver that keeps a picture of its own; the plugin host narrows it to the plugin's. Absent in a bare test host. */
  listSessions?(): Session[];
  /** A terminal record as stored (reservations included), without restoring it; absent in a bare test host. */
  findTerminal?(terminalId: string): TerminalInfo | undefined;
  listTerminals?(): TerminalInfo[];
  /** The agent was active in the session at `at`: `lastActivityAt` moves forward only. Returns the session when it moved. */
  recordActivity?(sessionId: string, at: string): Session | undefined;
  /** Desired settings for a long-lived history reader after the profile is edited. */
  getProfile?(session: Session): NativeBackendProfileConfig;
  updateSession(sessionId: string, patch: Partial<Session>): Session;
  /** A settings change of meaning: applies `patch` and moves `configRevision` in one store write. */
  bumpConfig(sessionId: string, patch: Partial<Session>): Session;
  /** Writes the provider-owned id; the store keeps Cursor's legacy mirror of it in step. */
  setNativeSessionId(sessionId: string, nativeSessionId: string | undefined): Session;
  emit(sessionId: string, message: NativeControlMessage): void;
  /** An event outside the transcript (a steer receipt, a hook-reported turn end), for the dispatcher. */
  emitEvent(sessionId: string, event: NativeWorkbenchEvent): void;
  /**
   * Persist a turn's measured output speed. The Cursor and Claude providers can only be timed
   * while their transcript is being watched, so a reload has to find the number already stored
   * rather than recompute it. Callers pass the turn-to-date aggregate; later calls replace it.
   */
  saveRunMetrics(runId: string, metrics: RunMetrics): void;
  /**
   * The run a client command id belongs to. Claude identifies a turn by the prompt it saw in its
   * own transcript, so mapping that back onto the persisted run needs the store's lookup rather
   * than any provider-side identity.
   */
  findRunIdByCommand(sessionId: string, commandId: string): string | undefined;
  /** Recover the owner of a native user message after prompt delivery and process restarts. */
  findRunIdByNativeMessage(sessionId: string, nativeMessageId: string): string | undefined;
  /** Read durable input boundaries when a protocol reconnects before its input was receipted. */
  listRuns?(sessionId: string): Run[];
  /** Durable associations, including confirmed inputs, for a provider turn after reconnect. */
  findRunsByNativeTurn?(sessionId: string, nativeSessionId: string, turnId: string): Run[];
  /**
   * Statistics ledger. Always set: a process with no ledger installed passes a sink that records
   * nothing. Drivers write settled usage here; the backend service writes transcript events.
   */
  stats: StatsSink;
  /** The session journal, for the blobs a driver keeps beside it (an activity's full text); absent in a bare test host. */
  journal?: Journal;
  getInteractionReceipt(sessionId: string, requestId: string): NativeInteractionReceipt | undefined;
  saveInteractionReceipt(sessionId: string, requestId: string, receipt: NativeInteractionReceipt): NativeInteractionReceipt;
  readAttachment(id: string): Promise<{ attachment: import('../../../../packages/contracts/src/index.js').Attachment; data: Buffer }>;
  /** Used immediately before a send can cause an external side effect; persists the no-replay fence. */
  commitDispatchFence(runId: string, binding?: NativeDispatchBinding): Run;
  isRunCancelled(runId: string): boolean;
  /** A run as stored, for the plugin host's ownership checks; absent in a bare test host (which then refuses every run id). */
  getRun?(runId: string): Run;
  /** Adapter-only launch helper; validates that cwd belongs to the session workspace. */
  launchPty(session: Session, project: Project, spec: NativePtyLaunchSpec): Promise<TerminalInfo>;
  /** Server-side controls for a driver-launched TUI; never exposed as arbitrary browser commands. */
  terminal: NativeTerminalControls;
  /** Serializes start/configure/send/interrupt for a single session. */
  withSessionLock<T>(sessionId: string, operation: () => Promise<T> | T): Promise<T>;
  /** The same lock for work started from events and timers, which must not join an inherited scope. */
  withDetachedSessionLock?<T>(sessionId: string, operation: () => Promise<T> | T): Promise<T>;
  /** How conversations are read into the session journal (sync v3); absent in a bare test host. */
  transcript?: NativeTranscriptHost;
  /** The Riffet MCP server a launch carries; absent in a bare test host. */
  riffetMcp?: NativeRiffetMcpHost;
}

/** A stdio MCP server for one conversation's CLI: the Riffet shim and its credential file. */
export interface RiffetMcpServerSpec { name: string; command: string; args: string[] }

export interface NativeRiffetMcpHost {
  /**
   * The server to launch this conversation's CLI with, issuing its credential when needed;
   * undefined when the conversation has no tool groups, so nothing is injected at all.
   */
  server(sessionId: string): RiffetMcpServerSpec | undefined;
}

/**
 * The journal side of a conversation for its driver (`sync/ingest.ts`): what a provider that learns of a
 * turn's end outside the transcript (its process exited, a hook) uses to record it, after the transcript.
 * Every call runs between the conversation's reads, never during one.
 */
export interface NativeTranscriptHost {
  /** Reads what is on disk into the log (G6). */
  drain(sessionId: string): Promise<void>;
  /** A turn the transcript will not end: drains first, then ends it on the log that serves, unless what was read ended it. */
  endTurn(sessionId: string, turnId: string, status: TurnEndStatus, at: string, error?: string): Promise<void>;
  /** Runs `task` with the conversation's source and main lane writer; undefined when it has no source or the task failed. */
  withSource<T>(sessionId: string, task: (source: TranscriptSource, w: LaneWriter) => Promise<T> | T): Promise<T | undefined>;
  /** The provider's data may have changed: the conversation is read again soon, if anything follows it. */
  wake(sessionId: string): void;
}

export interface NativeBackendSendRequest {
  session: Session;
  project: Project;
  profile: NativeBackendProfileConfig;
  commandId: string;
  runId: string;
  input: NativeRunInput;
  /** User-authored text before context injection; use for command and skill classification. */
  sourceText?: string;
  config: NativeRunConfig;
  /** Call once immediately before the first irreversible provider request or terminal write. */
  commitDispatchFence(binding?: NativeDispatchBinding): Run;
  /** Replace the running turn with this message, the provider's own way; only for drivers declaring `sendsNow`. */
  now?: boolean;
}

export interface NativeBackendConfigurePatch {
  model?: string;
  mode?: string;
  /** Provider's own permission/approval selector, kept verbatim. */
  approval?: string;
}

export interface NativeBackendConfigureResult extends NativeBackendConfigurePatch {
  nativeSessionId?: string;
  terminalId?: string;
}

export interface NativeBackendOpenOptions {
  /** Explicitly replace this exact launch binding; retries must not stop a newer backend. */
  restartFingerprint?: string;
  restartAddress?: string;
  initialPrompt?: string;
  /**
   * Called synchronously right before a process carrying `initialPrompt` is spawned; the caller
   * commits its no-replay fence here. A throw must abort the spawn (see `runBeforeSpawn`).
   */
  beforeSpawn?: () => void;
}

export interface NativeBackendOpenResult {
  nativeSessionId?: string;
  terminalId?: string;
  status?: NativeStatus;
}

/**
 * How a backend's turns and sessions behave, read by the dispatcher and the backend service in place
 * of checking which backend it is. Static per driver; an absent field means no.
 */
export interface NativeBackendTraits {
  /**
   * The provider takes input into its own inbox even while it starts, so a queued message waits for it to be
   * idle then as well. Every backend's queued messages wait while it runs.
   */
  acceptsInputWhileBusy?: boolean;
  /** A slash command is answered in the CLI's own pane: its successful submission completes the run. */
  settlesSlashOnSubmit?: boolean;
  /** The provider's prompt echo carries no command id, so a receipt is matched by text after the captured boundary. */
  untaggedEcho?: boolean;
  /** A hook reports each turn's end against the active turn, so a run whose turn was hooked waits for that outcome. */
  reportsTurnOutcome?: boolean;
  /**
   * The provider's CLI keeps running while Riffet's service restarts (tmux, or a detached app-server), so its turns
   * do not hold a restart back; `restartObservation` (session-identity.ts) picks up their observed runs afterwards.
   */
  survivesRestart?: boolean;
  /** An idle status never completes a run bound to a native turn; the provider's own turn-end event does. */
  completesOnTurnEvent?: boolean;
  /** Going offline does not prove the CLI stopped, so an unconfirmed run is fenced rather than left as it was. */
  offlineMayBeRunning?: boolean;
  /** A stop leaves a message held in the CLI's input box or queue; the CLI's own records settle that run. */
  stopKeepsPendingInput?: boolean;
  /** Subagents run on their own and do not keep the conversation busy. */
  detachedSubagents?: boolean;
  /** Session state, statistics and screen dialogs are kept by the driver's own service, not the backend service. */
  ownsSessionObservation?: boolean;
  /**
   * The provider-wide `close` shuts this backend's sessions down itself (detaching a reusable daemon);
   * disposing each session first would stop what close means to keep.
   */
  closesSessionsItself?: boolean;
  /**
   * `listModels` answers from a provider catalog the driver keeps itself, because its launch and
   * configuration checks read the same one; the backend service does not cache it a second time.
   */
  cachesModels?: boolean;
  /** What messages call this CLI (`<name> CLI`, for one that exits at launch, say); "CLI" when unset. */
  terminalName?: string;
  /** Relaunching with the stored `nativeSessionId` continues the same provider thread, so an idle conversation's CLI can be reclaimed and resumed later. */
  resumesByNativeId?: boolean;
  /**
   * Each launch can be given the Riffet MCP server without touching the CLI's own config files
   * (docs/DEVICES.md §2). Reported to clients as `supportsRiffetTools`.
   */
  riffetTools?: boolean;
  /**
   * A conversation's `extensionsOff` reaches this backend's launches: `mcp` switches MCP servers off, `skills` skills
   * (docs/EXTENSIONS.md). Reported to clients as `extensionToggles`.
   */
  extensionToggles?: { mcp: boolean; skills: boolean };
  /**
   * A session's `configPending` makes the driver relaunch its idle CLI and clear the flag, so a change that only a new launch
   * applies (tool groups, switched-off extensions) can be recorded that way. Absent: the change waits for the next launch.
   */
  relaunchesForPendingConfig?: boolean;
  /**
   * The gateway protocols a profile of this backend can be pointed at, so a model source serving one is offered to it
   * (no check of the backend's id). Reported to clients as `consumesProtocols`. Absent means no model source.
   */
  consumesProtocols?: readonly GatewayProtocol[];
}

export interface ExternalSessionScan {
  includeNonInteractive: boolean;
  limit: number;
  signal: AbortSignal;
}

/** One stored provider conversation, as a driver found it. */
export interface ExternalSessionEntry {
  nativeSessionId: string;
  cwd: string;
  title: string;
  preview?: string;
  gitBranch?: string;
  /** Epoch milliseconds. */
  updatedAt: number;
  source: import('../../../../packages/contracts/src/index.js').ExternalSessionSource;
  live?: ExternalHolder;
}

export interface ExternalHolder {
  pid: number;
  status?: 'idle' | 'busy';
  /** The process runs in one of Riffet's own terminals. */
  ours?: boolean;
}

/** What `available` found. */
export interface NativeBackendAvailability {
  available: boolean;
  reason?: string;
  /** Runnable, but the account is signed out; listed on the catalog entry as `needsLogin`. */
  needsLogin?: boolean;
  /** The CLI's `--version` output, when the probe read it; the service rates it against `cliVersions`. */
  version?: string;
}

/** A request to start the backend's unused process ahead of a new session. The profile is the backend's own id for it; unknown ones are skipped. */
export interface NativePrewarmRequest {
  project: Project;
  backendProfileId?: string;
  appearance?: TerminalAppearance;
  model?: string;
  mode?: string;
  approval?: string;
}

export interface NativePrewarmResult {
  state: 'ready' | 'preparing' | 'skipped';
  claimId?: string;
  reason?: string;
  expiresAt?: number;
}

export interface NativeBackendDriver {
  readonly id: NativeBackendId;
  readonly label: string;
  readonly traits?: NativeBackendTraits;
  /** How the terminal service reads this backend's panes (title, ready test, startup failure). */
  readonly terminal?: TerminalBehaviour;
  /** Environment names the terminal service handles for this backend's launches. */
  readonly launchEnv?: TerminalLaunchEnv;
  /**
   * The upstream CLI versions this adapter was built and verified against. Reported with the
   * backend list and by `doctor`; it refuses nothing by itself.
   */
  readonly cliVersions?: CliVersionRange;

  /** Profile objects are server side; the core strips config before building the public catalog. */
  profiles(host: NativeBackendHost): NativeBackendProfileConfig[];
  capabilities(host: NativeBackendHost, profile: NativeBackendProfileConfig): NativeBackendCapabilities | Promise<NativeBackendCapabilities>;
  available(host: NativeBackendHost, profile: NativeBackendProfileConfig): Promise<NativeBackendAvailability>;
  normalizeModel?(model: string, profile: NativeBackendProfileConfig): string;
  /** Validates an API-supplied persisted provider reference before it is stored. */
  validateNativeSessionId?(nativeSessionId: string): void;
  /**
   * Rejects a profile config this driver could not launch with (a relative directory, a malformed endpoint)
   * before the settings store it; `config` is the merged config `profiles` hands the driver, secrets included.
   * Synchronous and free of I/O. The stored structure itself is checked by the settings.
   */
  validateProfileConfig?(config: Record<string, unknown>): void;
  /** What the profile list shows for a profile that stores nothing for these fields: the values the launch uses. Replaces the config in `NativeBackendService.profileSettings`. */
  describeProfile?(profile: NativeBackendProfileConfig): Partial<{ executable: string; configDir: string; sourceDir: string; apiEndpoint: string; agentEndpoint: string; defaultModel: string; disableAutoUpdate: boolean }>;
  /**
   * Where this profile keeps its conversations. Two profiles with the same key read and write the
   * same native session, so a conversation can move between them in place (`configure` with a
   * `backendProfileId`). A driver without it never switches profiles under a conversation.
   */
  continuationKey?(profile: NativeBackendProfileConfig): string;
  /**
   * Declares that `readShareTranscript` only reads the provider's own stored files, so the search index
   * may read the provider's conversations speculatively. Any other backend's conversations are indexed
   * only from the journal, as they are read for a client: reading one could start the agent process,
   * which a search must never do.
   */
  readonly readOnlyTranscript?: boolean;
  /**
   * The conversation's transcript as the journal reads it (`journal/ingest.ts`): the service pulls it
   * into the session's lanes, and the timeline and every reader are served from those.
   */
  transcript(host: NativeBackendHost, session: Session, profile: NativeBackendProfileConfig): TranscriptSource;
  /**
   * The provider can stop its running turn and start a new message in one step of its own (`send`
   * with `now`), so "send now" does not have to interrupt and then send as two separate actions.
   */
  readonly sendsNow?: boolean;
  /**
   * Settled usage parsed from the provider's own stored transcript, for the statistics backfill.
   * It may only read files — never start the agent or its server. A transcript whose generation
   * equals `known` returns `undefined` unparsed; a missing one is an empty result, and a failed
   * read throws so the caller retries later.
   */
  usageTranscript?(host: NativeBackendHost, session: Session, profile: NativeBackendProfileConfig, known?: string): Promise<UsageTranscript | undefined>;

  /** `initialPrompt` is only supplied to backends whose capabilities declare `supportsInitialPromptArgs`. */
  openOrResume(host: NativeBackendHost, session: Session, project: Project, profile: NativeBackendProfileConfig, options?: NativeBackendOpenOptions): Promise<NativeBackendOpenResult>;
  /** Bounded cold history used by explicit references; must not start a runtime or follow children. */
  readContextTranscript?(host: NativeBackendHost, session: Session, profile: NativeBackendProfileConfig, options: { maxBytes: number; signal: AbortSignal }): Promise<NativeWorkbenchEvent[]>;
  send(host: NativeBackendHost, request: NativeBackendSendRequest): Promise<void>;
  /** Append to exactly this active turn; never starts a turn or falls back to a queued send. */
  steer?(host: NativeBackendHost, request: NativeBackendSendRequest & { target: NativeTurnTarget }): Promise<void | { deferred: true }>;
  /**
   * Synchronous notice before the session lock: release a send's receipt wait so Stop can acquire
   * the lock. Must not write to the terminal, claim a stop, or start a runtime.
   */
  requestInterrupt?(host: NativeBackendHost, session: Session): void;
  /** Read-only proof that this exact input cannot still run from a native queue or composer. */
  canReleaseInput?(host: NativeBackendHost, session: Session, profile: NativeBackendProfileConfig, run: Run): Promise<boolean>;
  interrupt(host: NativeBackendHost, session: Session, profile: NativeBackendProfileConfig, options?: { clearPrompt?: boolean; expectedStop?: NativeStopRequest; beforeWrite?: (allowEnded?: boolean) => void }): Promise<void>;
  /** Runs an action from the session's `runtimeControl`. */
  runtimeAction?(host: NativeBackendHost, session: Session, profile: NativeBackendProfileConfig, request: NativeRuntimeActionRequest): Promise<void>;
  respond(host: NativeBackendHost, session: Session, profile: NativeBackendProfileConfig, response: NativeInteractionResponse): Promise<NativeInteractionResult>;
  /**
   * Asks the provider to stop a system activity that declares `stop` (a background task). The driver first
   * publishes the activity as `stopping`, then performs the native stop, and publishes `stopped` only once
   * the provider's own evidence says it ended; it returns the state at that moment (usually `stopping`).
   * Throws `ACTIVITY_NOT_FOUND` / `ACTIVITY_NOT_STOPPABLE` / `ACTIVITY_ENDED` for an activity it cannot stop.
   */
  stopActivity?(host: NativeBackendHost, session: Session, profile: NativeBackendProfileConfig, activityId: string): Promise<NativeActivity>;
  /** Pushes back the deadline of a request that carries `extendableUntil`; only backends that time requests out themselves. */
  extendInteraction?(host: NativeBackendHost, session: Session, profile: NativeBackendProfileConfig, interactionId: string): Promise<NativeInteraction>;
  configure(host: NativeBackendHost, session: Session, profile: NativeBackendProfileConfig, patch: NativeBackendConfigurePatch): Promise<NativeBackendConfigureResult>;
  /**
   * Relaunches the terminal client of a CLI that probes the terminal colours once at startup, so it
   * picks up `session.terminalAppearance`. Without it the pane is recoloured in place instead.
   */
  relaunchForAppearance?(host: NativeBackendHost, session: Session, profile: NativeBackendProfileConfig): Promise<void>;
  /**
   * Hands the conversation's current title to a provider that keeps names of its own, so its other
   * clients show the same one. Only reaches a provider that is already running; never starts one.
   */
  rename?(host: NativeBackendHost, session: Session, profile: NativeBackendProfileConfig): Promise<void>;

  listModels(host: NativeBackendHost, project: Project | undefined, profile: NativeBackendProfileConfig, session?: Session): Promise<ModelInfo[]>;
  /** Drops a model catalog the driver keeps itself (see `cachesModels`), so the next listing reads the provider again. */
  invalidateModels?(): void;
  /**
   * Account quota and per-model load, read live from the provider. Optional: a backend whose CLI
   * reports neither leaves it out, and the picker then shows models without either.
   */
  usage?(host: NativeBackendHost, project: Project | undefined, profile: NativeBackendProfileConfig, session?: Session): Promise<NativeBackendUsage>;
  /**
   * Skills and custom commands the provider offers in this project, for the composer's `/` menu.
   * Static built-ins stay in `capabilities().slashCommands`. Must not start or touch a conversation.
   */
  slashItems?(host: NativeBackendHost, project: Project | undefined, profile: NativeBackendProfileConfig): Promise<NativeSlashItem[]>;
  /** Called once per registration of a plugin's backend, with its default profile: starts what has to run with nobody using it (sweeps, a warm pool). */
  start?(host: NativeBackendHost, profile: NativeBackendProfileConfig): Promise<void>;
  /** Starts an unused process held for the next session of this project; `skipped` with the reason when it cannot. */
  prewarm?(host: NativeBackendHost, project: Project, profile: NativeBackendProfileConfig, request: Omit<NativePrewarmRequest, 'project' | 'backendProfileId'>): Promise<NativePrewarmResult>;
  /**
   * The provider's conversations stored for this profile, newest first, for the import picker
   * (docs/TERMINAL-SESSIONS.md). Reads the provider's own files or index only: it must not launch a
   * conversation, a model request or a hook. Subagent threads are left out, and so are non-interactive
   * runs (`-p`, SDK, `exec`) unless `includeNonInteractive`. Bounded by `limit`.
   */
  listExternalSessions?(host: NativeBackendHost, profile: NativeBackendProfileConfig, options: ExternalSessionScan): Promise<ExternalSessionEntry[]>;
  /**
   * A live CLI process holding this provider conversation, whoever started it; `undefined` when none
   * is known. Read-only and cheap: the core asks before every launch of a conversation it has no live CLI for.
   */
  externalHolder?(host: NativeBackendHost, profile: NativeBackendProfileConfig, nativeSessionId: string): Promise<ExternalHolder | undefined>;
  /**
   * How a terminal continues this conversation as its only writer (`riffet resume`). `keepsRuntime`:
   * the command joins the runtime Riffet keeps (a shared app-server), so only Riffet's own terminal
   * client is stopped and the conversation stays live here; otherwise the core disposes the runtime first.
   */
  terminalLaunch?(host: NativeBackendHost, session: Session, project: Project, profile: NativeBackendProfileConfig): Promise<{ spec: NativePtyLaunchSpec; keepsRuntime?: boolean }>;
  /**
   * The command a reader types to continue this conversation in a terminal of their own: the provider's
   * CLI and its resume argument, with the environment that finds the same stored conversation. Nothing
   * secret: credentials Riffet supplies (a gateway key, its headers) are left out and `credentialsOmitted` says so.
   * Pure; it starts nothing.
   */
  resumeCommand?(session: Session, profile: NativeBackendProfileConfig): { argv: string[]; env: Record<string, string>; credentialsOmitted?: boolean };
  /**
   * While a terminal holds the conversation, wakes its transcript reader when the CLI there writes,
   * so the timeline follows it. Returns how to stop. Not needed by a backend whose runtime stays live.
   */
  followExternal?(host: NativeBackendHost, session: Session, profile: NativeBackendProfileConfig): () => void;
  /** The launch of the backend's own login in a terminal; `cwd` is the project's directory. */
  loginLaunch?(host: NativeBackendHost, project: Project, profile: NativeBackendProfileConfig): NativePtyLaunchSpec | Promise<NativePtyLaunchSpec>;
  /** What this machine can do for the backend, behind `/api/cursor/capabilities`. */
  capabilityReport?(host: NativeBackendHost, profile: NativeBackendProfileConfig): Promise<CapabilityReport>;
  /** One of the CLI's named management operations, behind `/api/cursor/command`. */
  runCommand?(host: NativeBackendHost, profile: NativeBackendProfileConfig, request: { operation: string; args?: string[]; cwd?: string }): Promise<CommandResult>;
  /** Counters of the driver's own runtime, behind `/api/native/runtime/stats`. */
  runtimeStats?(host: NativeBackendHost): Record<string, unknown> | Promise<Record<string, unknown>>;
  /** The project files the backend's CLI reads its configuration from, behind `/api/projects/:id/configs`. */
  readonly projectConfigs?: NativeProjectConfigs;
  /** Where the provider keeps its skills, rules, MCP and hook files and plugins, and the command that manages them; read by the extension inventory (`extensions/discovery.ts`). */
  extensionLayout?(profile: NativeBackendProfileConfig): AgentExtensionLayout;
  /**
   * The MCP servers and skills a launch in `project` would load, as the CLI reports them (Riffet's own server left out).
   * May start a short-lived probe process; it must send no model request and run no user hook. Behind `/api/backends/:id/loaded-extensions`.
   */
  loadedExtensions?(host: NativeBackendHost, project: Project, profile: NativeBackendProfileConfig): Promise<Omit<LoadedExtensions, 'checkedAt'>>;
  /** Inspect existing connections only. Must not launch a provider, thread, MCP or hook. */
  extensionRuntime?(host: NativeBackendHost, project: Project | undefined, profile: NativeBackendProfileConfig): Promise<ExtensionRuntimeReport>;
  /** Read native skill configuration through a short-lived management connection, without opening a conversation. */
  skillStates?(host: NativeBackendHost, project: Project | undefined, profile: NativeBackendProfileConfig): Promise<Array<{ path: string; enabled: boolean }>>;
  /** Explicit user actions; unlike discovery these may open a short-lived management connection. */
  setSkillEnabled?(host: NativeBackendHost, project: Project | undefined, profile: NativeBackendProfileConfig, path: string, enabled: boolean): Promise<void>;
  reloadExtensions?(host: NativeBackendHost, project: Project | undefined, profile: NativeBackendProfileConfig): Promise<number>;
  authorizeMcp?(host: NativeBackendHost, project: Project | undefined, profile: NativeBackendProfileConfig, name: string): Promise<string>;
  extensionManagementCapabilities?(host: NativeBackendHost, profile: NativeBackendProfileConfig): ExtensionManagementCapabilities;
  manageExtension?(host: NativeBackendHost, profile: NativeBackendProfileConfig, input: ExtensionActionRequest, item?: ExtensionItem): Promise<ExtensionActionResult>;
  /** A complete read of the stored transcript; must never launch a process or change live emission state. */
  readShareTranscript?(host: NativeBackendHost, session: Session, profile: NativeBackendProfileConfig, options?: NativeShareReadOptions): Promise<NativeShareTranscript>;
  interaction(host: NativeBackendHost, session: Session, profile: NativeBackendProfileConfig): Promise<NativeInteraction | undefined> | NativeInteraction | undefined;
  /**
   * Whether a dialog recognized on the CLI's screen is backed by something the driver knows the CLI waits on.
   * A driver that leaves this out accepts every dialog the screen shows.
   */
  endorsesScreenDialog?(host: NativeBackendHost, session: Session, dialog: NativeInteraction): boolean;
  status(host: NativeBackendHost, session: Session, profile: NativeBackendProfileConfig): NativeStatus;
  /** Starts an adapter-owned control pump (see `NativeControlMessage`); the core owns its lifetime. */
  subscribe(host: NativeBackendHost, session: Session, profile: NativeBackendProfileConfig, listener: (message: NativeControlMessage) => void): () => void;
  dispose?(host: NativeBackendHost, sessionId: string): void | Promise<void>;
  close?(host: NativeBackendHost): void | Promise<void>;
}

export type { TerminalInteractionControl, TerminalObserver };
