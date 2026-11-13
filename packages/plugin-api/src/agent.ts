// The Agent backend protocol (docs/design/plugin-system.md §5.1): what a plugin implements to connect
// one Agent's sessions and execution to Riffet, and the restricted host it gets for doing so.
//
// EXPERIMENTAL. This is the first cut, derived from the core's internal `NativeBackendDriver` and
// `NativeBackendHost`, which stay behind it as an adapter layer. Cursor (phase E2) is its first real
// implementation and `examples/plugins/echo` the minimal one. It may change without a version bump
// until implementations beyond Cursor have settled it; `AGENT_PROTOCOL_VERSION` moves once the shape
// is stable.
//
// The split of duties: a plugin detects its Agent, describes its profiles and capabilities, opens or
// resumes a native session, sends input, stops a turn, answers interactions, reads history and
// reports what it observes. The core keeps the command id, queueing, the durable delivery record,
// target checks, the journal, and session and project ownership. A plugin therefore never gets a
// store, a Fastify instance or a terminal service: every operation is named by intent, is
// asynchronous, and takes and returns plain data (so it can later cross a process boundary). Errors
// are made with `host.error`.
//
// Delivery is reported in three steps and a plugin must not claim a later one without evidence: a
// handover (stdin written, RPC returned) is only `submitted`; `accepted` needs something the Agent
// itself produced (an echo carrying the command id, a turn id in a reply); `completed` is the end of
// the turn.

import type {
  Attachment, CapabilityReport, CommandResult, ConfigFile, ExtensionActionRequest, ExtensionActionResult, ExtensionCreateTarget, ExtensionItem, ExtensionKind, ExtensionManagementCapabilities,
  ExtensionRuntimeReport, GatewayProtocol, ModelInfo, NativeActivity, NativeBackendCapabilities,
  NativeBackendId, NativeBackendUsage, NativeInteraction, NativeInteractionResponse, NativeInteractionResult, NativeJob, NativeRunConfig,
  NativeRunInput, NativeRuntimeActionRequest, NativeSlashItem, NativeStatus, NativeStopRequest, NativeStreamMessage, NativeTurnTarget, NativeWorkbenchEvent, Project,
  RunMetrics, Session, ShareModelInfo, ShareSelection, ShareTurn, SyncLane, TerminalAppearance, TerminalInfo,
} from '@riffet/contracts';
import type { RecordedUsageObservation, UsageObservation } from './kit/stats.js';
export type { RecordedUsageObservation, UsageObservation, UsageObservationTokens } from './kit/stats.js';

export const AGENT_PROTOCOL_VERSION = 1;

/** Closed to the core's `NATIVE_BACKEND_IDS` until the identity is opened to namespaced ids. */
export type AgentBackendId = NativeBackendId;

// ── What a plugin sees of the core ───────────────────────────────────────────

/** A session as the plugin may read it. No store object: a value read at the time of the call. */
export type AgentSessionView = Pick<Session,
  'id' | 'projectId' | 'title' | 'state' | 'backendProfileId' | 'nativeSessionId' | 'terminalId' | 'model' | 'mode' | 'approval'
  | 'configRevision' | 'configPending' | 'archivedAt' | 'error' | 'terminalAppearance' | 'resumePicker' | 'titleSource' | 'lastActivityAt' | 'toolGroups' | 'extensionsOff' | 'terminalHold'>;

export type AgentProjectView = Pick<Project, 'id' | 'name' | 'cwd' | 'archivedAt'>;

/** A profile of this Agent. `config` is the plugin's own JSON; the core strips it from what clients are shown. */
export interface AgentProfile {
  id: string;
  name: string;
  description?: string;
  isDefault?: boolean;
  config: Record<string, unknown>;
}

/** What `AgentHost.modelSources.resolve` answers: the address of one protocol of a source, with what a request to it carries. */
export interface AgentModelEndpoint {
  baseUrl: string;
  headers?: Record<string, string>;
  credential?: { kind: 'static'; key: string };
}

/** What one session operation is about, built by the host from its own records when the call is made. */
export interface AgentContext {
  session: AgentSessionView;
  project: AgentProjectView;
  profile: AgentProfile;
}

export type AgentCapabilities = Omit<NativeBackendCapabilities, 'backendId' | 'label'>;
export type AgentStatus = NativeStatus;
export type AgentModel = ModelInfo;

/** What `available` found. */
export interface AgentAvailability {
  available: boolean;
  reason?: string;
  /** Runnable, but the Agent's account is signed out: clients show one generic sign-in hint. */
  needsLogin?: boolean;
  /** The CLI's version output, when the probe read it. */
  version?: string;
}

/**
 * How a backend's turns and sessions behave, read by the dispatcher in place of checking which backend
 * it is. Static; an absent field means no.
 */
export interface AgentTraits {
  /**
   * The Agent takes input into its own inbox even while it starts, so a queued message waits for it to be
   * idle then as well. Every backend's queued messages wait while it runs.
   */
  acceptsInputWhileBusy?: boolean;
  /** A slash command is answered in the CLI's own pane: its successful submission completes the run. */
  settlesSlashOnSubmit?: boolean;
  /** The Agent's echo of a prompt carries no command id, so a receipt is matched by text. */
  untaggedEcho?: boolean;
  /** A hook reports each turn's end against the active turn. */
  reportsTurnOutcome?: boolean;
  /** The Agent's CLI keeps running while Riffet's service restarts (tmux, or a detached process), so its turns do not hold a restart back. */
  survivesRestart?: boolean;
  /** An idle status never completes a run bound to a native turn; the Agent's own turn-end event does. */
  completesOnTurnEvent?: boolean;
  /** Going offline does not prove the Agent stopped, so an unconfirmed run is fenced rather than left as it was. */
  offlineMayBeRunning?: boolean;
  /** A stop leaves a message held in the Agent's input box or queue. */
  stopKeepsPendingInput?: boolean;
  /** Subagents run on their own and do not keep the conversation busy. */
  detachedSubagents?: boolean;
  /** The plugin keeps session state, statistics and screen dialogs itself; only then may it write `state` and `error` of its sessions. */
  ownsSessionObservation?: boolean;
  /** `close` shuts the plugin's sessions down itself (detaching a reusable daemon), so the core does not stop each one first. */
  closesSessionsItself?: boolean;
  /** `listModels` answers from a catalog the plugin caches itself. */
  cachesModels?: boolean;
  /** What messages call this CLI (`<name> CLI`, for one that exits at launch, say); "CLI" when unset. */
  terminalName?: string;
  /** Relaunching with the stored `nativeSessionId` continues the same Agent thread, so an idle session's CLI can be reclaimed and resumed later. */
  resumesByNativeId?: boolean;
  /** Each launch can carry the Riffet MCP server (`host.riffetMcp`). */
  riffetTools?: boolean;
  /** The gateway protocols a profile of this Agent can be pointed at. A model source that serves one is offered to its profiles, whatever this Agent's id. */
  consumesProtocols?: readonly GatewayProtocol[];
}

/** The upstream versions the plugin was built and verified against. Reported by `doctor`; refuses nothing. */
export interface AgentVersionRange {
  /** Below this the plugin is known to be broken. */
  readonly minimum?: string;
  /** The newest version actually verified; anything newer is untested, not refused. */
  readonly testedThrough?: string;
}

// ── Opening, sending, stopping ───────────────────────────────────────────────

export interface AgentOpenOptions {
  /** Replace exactly this launch binding; a retry must not stop a newer one. */
  restartFingerprint?: string;
  restartAddress?: string;
  /** Only given when capabilities declare `supportsInitialPromptArgs`. Call `host.beforeSpawn` right before the process that carries it starts. */
  initialPrompt?: string;
}

export interface AgentOpenResult {
  nativeSessionId?: string;
  terminalId?: string;
  status?: AgentStatus;
}

export interface AgentSendRequest {
  context: AgentContext;
  commandId: string;
  runId: string;
  input: NativeRunInput;
  /** Original user text, before the host appended session reference context. */
  sourceText?: string;
  config: NativeRunConfig;
  /** Replace the running turn with this message, the Agent's own way; only for backends declaring `sendsNow`. */
  now?: boolean;
}

/**
 * Identifies the endpoint an input goes to, given to `host.commitDispatchFence` right before the first
 * irreversible write. From that point the core never resends the input on its own.
 */
export interface AgentDispatchBinding {
  nativeSessionId?: string;
  nativeTurnId?: string;
  terminal?: { id: string; epoch?: number };
  /** For an additional input (a steer): the run whose turn it joins. */
  ownerRunId?: string;
  /** The text as the Agent will see it, for matching an echo that carries no command id. */
  renderedText?: string;
  /** An opaque boundary in the Agent's own records before the input, persisted with the fence. */
  nativeInputBoundary?: string;
  slashCommand?: boolean;
  /** The configuration the Agent actually received. */
  resolvedConfig?: NativeRunConfig;
}

/**
 * How far an input got when `send` returned. A plugin that cannot prove more reports `submitted` (or
 * returns nothing); the core then waits for the acceptance and the end to show in the transcript or
 * in events the plugin emits.
 */
export type AgentDelivery =
  | { state: 'submitted' }
  | { state: 'accepted'; nativeMessageId?: string; nativeTurnId?: string }
  | { state: 'completed'; status: 'completed' | 'failed' | 'cancelled'; nativeMessageId?: string; nativeTurnId?: string; error?: string };

export interface AgentStopOptions {
  /** Also drop a message the Agent holds in its input. */
  clearPrompt?: boolean;
  /** The turn the caller saw. The plugin calls `host.checkStopTarget` right before it writes. */
  expectedStop?: NativeStopRequest;
}

export interface AgentConfigurePatch { model?: string; mode?: string; approval?: string }
export interface AgentConfigureResult extends AgentConfigurePatch { nativeSessionId?: string; terminalId?: string }

export interface AgentModelQuery {
  project?: AgentProjectView;
  profile: AgentProfile;
  session?: AgentSessionView;
}

// ── Observation and history ──────────────────────────────────────────────────

/** An event a plugin writes: the journal numbers it and stamps the session, so neither is given. */
export type AgentEvent = Omit<NativeWorkbenchEvent, 'sequence' | 'sessionId' | 'raw'>;

export type AgentTurnStatus = 'completed' | 'failed' | 'cancelled' | 'interrupted';

/** A turn's edges, applied after the batch's events. A turn's start is implied by its first event. */
export type AgentTurnEdge =
  | { edge: 'started'; turnId: string; at: string; runId?: string }
  | { edge: 'ended'; turnId: string; at: string; status: AgentTurnStatus; error?: string };

/** One step of reading a conversation into the session journal. */
export interface AgentTranscriptBatch {
  /** In transcript order. An event identical to its entity's latest version writes nothing; a changed one is a new version. */
  events: AgentEvent[];
  /** Streamed chunks, each under the id its settled event will have. */
  drafts?: Array<{ finalId: string; event: AgentEvent }>;
  /** Entities that leave the transcript (a provisional row its settled copy replaced). */
  retire?: string[];
  turns?: AgentTurnEdge[];
  /** Where the next read starts, stored with the rows in one transaction. Opaque to the core. */
  cursor: string | null;
  /** Everything the Agent has recorded so far is in the journal. */
  caughtUp: boolean;
}

export interface AgentTranscriptRequest {
  /** The native conversation to read. When it changes the lane starts over and `cursor` is null. */
  nativeSessionId: string;
  cursor: string | null;
}

/**
 * The conversation as the journal reads it. Reading must not start the Agent: the same read serves the
 * history of a conversation nobody has opened. Tell the core the data moved with `host.transcript.wake`.
 */
export interface AgentTranscript {
  read(request: AgentTranscriptRequest, signal: AbortSignal): Promise<AgentTranscriptBatch>;
}

/** What a subagent's tool row shows of it besides its lane. */
export interface AgentSubagentInfo { title?: string; subagentType?: string; model?: string }
export interface AgentSubagentBinding extends AgentSubagentInfo { toolCallId: string; agentId: string }

/** One committed step of a lane: rows and the cursor are stored in one transaction. Events are full (`sessionId` set, `sequence` 0 when the source has none). */
export interface AgentLaneBatch {
  events: NativeWorkbenchEvent[];
  drafts?: Array<{ finalId: string; event: NativeWorkbenchEvent }>;
  retire?: string[];
  cursor: string | null;
  /** Rewrite existing entities after an adapter upgrade, keeping their identity, timing and turn ownership. */
  reproject?: true;
}

/**
 * The live state of a session's system activities (compaction, background tasks) and the rules every
 * Agent shares: an ended execution stays ended, a stop in flight is not undone by a late "running".
 * Each new state is written to the lane through the ledger's sink.
 */
export interface AgentActivityLedger {
  get(id: string): NativeActivity | undefined;
  list(): NativeActivity[];
  live(): NativeActivity[];
  /** Records a state; returns the state the ledger now holds. */
  apply(next: NativeActivity, now?: Date): NativeActivity;
  requestStop(id: string): NativeActivity;
  beginStop(id: string): { activity: NativeActivity; token?: number };
  stopFailed(id: string, token?: number): NativeActivity | undefined;
  /** Ends every live activity matching `predicate` (its owner is gone). */
  settleWhere(predicate: (activity: NativeActivity) => boolean, status: 'completed' | 'failed' | 'stopped' | 'unknown', now?: Date): void;
  /** Takes up states an earlier process already wrote, without writing them again. */
  restore(activities: Iterable<NativeActivity>): void;
  clear(): void;
}

/**
 * The one way into a lane of the session journal, for a source that reads a conversation itself
 * (`AgentTranscriptSource`). Structurally the core's lane writer, handed over as it is: every write
 * lands at once (joining an open transaction) and only `commit` moves the cursor. A write the control
 * path makes on its own (a turn a hook ended) goes to the log that serves: `w.scratch ?? w`.
 */
export interface AgentLaneWriter {
  readonly lane: SyncLane;
  readonly generation: string;
  /** What the last commit stored. A read starts here, never where the source's memory says it got to. */
  readonly cursor: string | null;
  /** Whether an upgrade still refers to the same live message occurrence rather than a retired or replaced entity. */
  canReproject(event: NativeWorkbenchEvent): boolean;
  commit(batch: AgentLaneBatch): void;
  /** Every turn, also one typed into the CLI directly. Writing it again writes nothing. */
  turnStarted(turnId: string, at: string, runId?: string): void;
  /** After the source has read what is on disk. `error` is what the Agent said of a failed turn, for whoever settles its run. */
  turnEnded(turnId: string, status: AgentTurnStatus, at: string, error?: string): void;
  turnEndStatus(turnId: string): AgentTurnStatus | undefined;
  /** Retracts an end when the transcript resumes or corrects the turn; `cursor` checkpoints the reread. */
  turnReopened(turnId: string, at: string, cursor?: string): void;
  readonly activities: AgentActivityLedger;
  /** The writer of lane `sub:<toolCallId>`; naming it again with more known writes a new version of its record. */
  child(toolCallId: string, agentId: string, info?: AgentSubagentInfo): AgentLaneWriter;
  readonly subagents: readonly AgentSubagentBinding[];
  /** Retracts a duplicate binding and its tool rows; the child's stored transcript is kept. */
  retireSubagent(toolCallId: string, replacementToolCallId?: string): void;
  /** The lane starts over under a new generation. Only for a change of identity. */
  rebuild(reason: 'identity-changed'): void;
  /** The scratch log serving this lane's tail while its history is imported; see `openScratch`. */
  readonly scratch: AgentLaneWriter | undefined;
  /** Serves the tail from its first commit until `promote`. A lane that has been read already cannot open one. */
  openScratch(): AgentLaneWriter;
  /** The import has caught up: the scratch log goes and this one serves. */
  promote(): void;
}

/**
 * A conversation read by the plugin itself, for an Agent whose data a batch reader (`AgentTranscript`)
 * cannot express: several lanes, drafts, activities, a first import of a long transcript in steps.
 * `pull` commits from `w.cursor` on and resolves `caughtUp: true` once everything on disk is in the log.
 * Reading must not start the Agent.
 */
export interface AgentTranscriptSource {
  /** The native conversation being read; a change starts the lane over. */
  identity(): string | undefined;
  pull(w: AgentLaneWriter, signal: AbortSignal): Promise<{ caughtUp: boolean }>;
  /** Calls `wake` when the data may have changed; returns how to stop. */
  watch?(w: AgentLaneWriter, wake: () => void): () => void;
  /** Reads everything already on disk into the log that serves; called before a turn is ended from outside the transcript. */
  drain(w: AgentLaneWriter): Promise<void>;
}

export interface AgentHistoryOptions {
  selection?: ShareSelection;
  catalogOnly?: boolean;
  messagesOnly?: boolean;
  signal?: AbortSignal;
}

/** A complete read of the stored conversation, for shares and search. Must never launch a process. */
export interface AgentHistory {
  events: AgentEvent[];
  modelInfo?: Record<string, ShareModelInfo>;
  turnModels?: Record<string, ShareModelInfo>;
  ambiguousModelTurns?: string[];
  subagents: Array<{ toolCallId: string; agentId: string; title?: string; prompt?: string; subagentType?: string; model?: string; events: AgentEvent[] }>;
  jobs?: NativeJob[];
  warnings?: string[];
  turns?: ShareTurn[];
  selectedTurnIds?: string[];
}

/**
 * What the plugin reports outside the transcript (`host.emit`); the transcript itself goes through
 * `AgentTranscript`. `session` says the plugin changed the session record and readers should look again.
 */
export type AgentControlMessage =
  | Extract<NativeStreamMessage, { type: 'status' | 'context' | 'metrics' | 'job' }>
  | { type: 'session' }
  | { type: 'subagent'; toolCallId: string; agentId: string; running?: boolean };

// ── Extensions on disk ───────────────────────────────────────────────────────

/** A document the extension inventory can create: one skill, rule or command directory, or one fixed file. */
export type AgentExtensionTarget = Pick<ExtensionCreateTarget, 'id' | 'label' | 'kind' | 'directory' | 'fileName' | 'template'>;

/**
 * Where an Agent keeps what the extension inventory lists (skills, rules, commands, MCP and hook
 * files, plugins) and how its CLI is run to manage them, so the inventory has no row for the Agent
 * itself. Every path is relative to the user root or to the project directory.
 */
export interface AgentExtensionLayout {
  /** The directory its user-level configuration lives in. `configDir` is the profile's own, `~` expanded, when it sets one. */
  userRoot(config: Record<string, unknown>, configDir: string | undefined): string;
  /** What changing one of its files needs before it takes effect, shown beside the document. */
  applyEffect: string;
  /** Configuration documents (MCP servers, hooks, settings) it reads. */
  configFiles: Record<'user' | 'project', Array<{ relative: string; kind: ExtensionKind }>>;
  /** Directories scanned for each kind of markdown document and for plugins. */
  directories: Record<'user' | 'project', Record<'skill' | 'rule' | 'command' | 'plugin', string[]>>;
  /** Single rule files read beside the directories. */
  ruleFiles: Record<'user' | 'project', string[]>;
  /** What the inventory offers to create, per scope. */
  create: Record<'user' | 'project', AgentExtensionTarget[]>;
  /** Skills and commands also read from directories under the home directory, shared with other Agents. */
  sharedRoot?: { directories: Record<'skill' | 'command', string[]>; create: AgentExtensionTarget[] };
  /** Its skills have no switch of their own: every one found is on. */
  skillsAlwaysEnabled?: boolean;
  /** The command that manages the Agent's configuration (`plugin`, `--version`), without credentials or trust flags. */
  command?(config: Record<string, unknown>, args: string[]): { command: string; args: string[]; env: NodeJS.ProcessEnv };
}

// ── The backend ──────────────────────────────────────────────────────────────

/**
 * One Agent. Only the first group is required (the minimal integration: detection, profiles, opening,
 * sending and basic output); everything after it is an optional capability, and a method that is not
 * implemented is not offered whatever the manifest says.
 */
export interface AgentBackend {
  readonly protocolVersion: typeof AGENT_PROTOCOL_VERSION;
  /** Declared in the manifest's `contributes.agentBackends`. */
  readonly id: AgentBackendId;
  readonly label: string;
  readonly traits?: AgentTraits;
  readonly cliVersions?: AgentVersionRange;

  /** A pure description: the host merges saved settings into it and calls it wherever a profile list is needed, so it must be cheap and synchronous. */
  profiles(host: AgentHost): AgentProfile[];
  capabilities(host: AgentHost, profile: AgentProfile): AgentCapabilities | Promise<AgentCapabilities>;
  /** Whether this machine can run the Agent. May spawn a probe; the core caches the answer briefly. */
  available(host: AgentHost, profile: AgentProfile): Promise<AgentAvailability>;
  /**
   * Opens a new native session or resumes `context.session.nativeSessionId`. The core persists the
   * returned ids. After it resolves, the plugin reports state through `host.emit` and the transcript.
   */
  open(host: AgentHost, context: AgentContext, options?: AgentOpenOptions): Promise<AgentOpenResult>;
  /**
   * Delivers the input. Call `host.commitDispatchFence` once, immediately before the first
   * irreversible write: if it throws, the run was cancelled and nothing may be written.
   */
  send(host: AgentHost, request: AgentSendRequest): Promise<AgentDelivery | void>;

  /**
   * Appends to exactly this active turn; never starts a turn or falls back to a queued send. A steer the
   * Agent takes at its next boundary (a hook) resolves `{ deferred: true }`: its fence then stays open for
   * `host.commitDispatchFence` until it is committed, and the plugin reports a refusal with `native_input_rejected`.
   */
  steer?(host: AgentHost, request: AgentSendRequest & { target: NativeTurnTarget }): Promise<AgentDelivery | { deferred: true } | void>;
  /** Stops the running turn. Without it the core refuses to stop this Agent's sessions. */
  interrupt?(host: AgentHost, context: AgentContext, options?: AgentStopOptions): Promise<void>;
  /** A notice before the session lock is taken, so a send waiting for its receipt can release the lock. Must not write or start anything. */
  requestInterrupt?(host: AgentHost, sessionId: string): void;
  /** Applies a model, mode or permission change. Without it the core records the change and the next open reads it. */
  configure?(host: AgentHost, context: AgentContext, patch: AgentConfigurePatch): Promise<AgentConfigureResult>;
  /** The request currently waiting for an answer. */
  interaction?(host: AgentHost, context: AgentContext): Promise<NativeInteraction | undefined>;
  respond?(host: AgentHost, context: AgentContext, response: NativeInteractionResponse): Promise<NativeInteractionResult>;
  /**
   * Starts observing a session on behalf of one subscriber; returns how to stop. `report` reaches that
   * subscriber alone (an initial replay of the current status goes only there), `host.emit` reaches
   * everyone following the session. Stopping only detaches: it must not end a native process that can
   * outlive Riffet.
   */
  observe?(host: AgentHost, context: AgentContext, report: AgentReport): Promise<() => void> | (() => void);
  /** The conversation as batches the core writes into the journal. Without it, and without `transcriptSource`, the plugin reports through events only. */
  transcript?(host: AgentHost, context: AgentContext): AgentTranscript;
  /** The conversation read by the plugin itself, written against the lane writer; takes the place of `transcript` when both exist. */
  transcriptSource?(host: AgentHost, context: AgentContext): AgentTranscriptSource;
  /** Declares that `readHistory` and `transcript` only read the Agent's own stored files, so the search index may read them speculatively. */
  readonly readOnlyHistory?: boolean;
  readHistory?(host: AgentHost, context: AgentContext, options?: AgentHistoryOptions): Promise<AgentHistory>;
  /** A catalog that cannot be read throws `MODEL_CATALOG_UNAVAILABLE` (503), whose message reaches the client; `details.reason` is set when the Agent can say why. */
  listModels?(host: AgentHost, query: AgentModelQuery): Promise<AgentModel[]>;
  slashItems?(host: AgentHost, project: AgentProjectView | undefined, profile: AgentProfile): Promise<NativeSlashItem[]>;
  /** Stop and send in one step of the Agent's own (`send` with `now`). */
  readonly sendsNow?: boolean;
  /** Pure mapping of a stored model string to the Agent's canonical one. Synchronous because pickers call it in loops. */
  normalizeModel?(model: string, profile: AgentProfile): string;
  /** Validates a client-supplied native session id before it is stored. */
  validateNativeSessionId?(nativeSessionId: string): void;
  /**
   * Rejects a profile config the Agent could not launch with (a relative directory, a malformed endpoint)
   * before the core stores it. `config` is the whole merged config as `profiles` will see it, secrets
   * included. Synchronous and free of I/O; the structure of what is stored is checked by the core.
   */
  validateProfileConfig?(config: Record<string, unknown>): void;
  /** What a profile list shows of a profile that stores nothing for these fields: the values the launch actually uses (resolved executable and directory, endpoints, auto-update). Synchronous and free of I/O. */
  describeProfile?(profile: AgentProfile): Partial<{ executable: string; configDir: string; sourceDir: string; apiEndpoint: string; agentEndpoint: string; defaultModel: string; disableAutoUpdate: boolean }>;

  /** The core stops watching this session (disabled plugin, idle release). Release observation only; never end the native process. */
  detach?(host: AgentHost, sessionId: string): void | Promise<void>;
  /** The session is closed for good (archived, deleted, closed by the user): end its native process. */
  stop?(host: AgentHost, sessionId: string): void | Promise<void>;
  /** The server is shutting down. Provider-wide resources only; a native process that outlives Riffet stays. */
  close?(host: AgentHost): void | Promise<void>;
  /**
   * Called once per activation, as soon as the core has registered this backend (the server started with the plugin on, or the
   * plugin was turned on), with the host it will be called with and the default profile as configured now. Starts what has
   * to run while nobody uses the Agent: a sweep over sessions left running, a warm pool, the reaping of what an earlier run
   * left. A rejection is logged and does not withdraw the backend; `close` ends what this started.
   */
  start?(host: AgentHost, profile: AgentProfile): void | Promise<void>;

  // Terminals the plugin's Agent runs in.
  /** How the host reads this Agent's panes; see `AgentTerminalBehaviour`. */
  readonly terminal?: AgentTerminalBehaviour;
  /** The environment names the host handles specially for this Agent's panes; see `AgentLaunchEnv`. */
  readonly launchEnv?: AgentLaunchEnv;
  /** The launch of the Agent's own login in a terminal, shown to the user (never a session's). `context` has no session. */
  loginLaunch?(host: AgentHost, project: AgentProjectView, profile: AgentProfile): AgentLaunchSpec | Promise<AgentLaunchSpec>;
  /** Starts an unused process ahead of the first message of a new session, held as a reservation (`host.terminals.reserve`). */
  prewarm?(host: AgentHost, project: AgentProjectView, profile: AgentProfile, request: AgentPrewarmRequest): Promise<AgentPrewarmResult>;
  /** Whether a screen that shows no dialog has the Agent back at its own prompt, which completes a dialog answer (`host.dialogs`) at once. */
  settledScreen?(screen: string): boolean;
  /** Whether a dialog recognised on the Agent's screen is backed by something it waits on; every dialog is accepted when absent. */
  endorsesScreenDialog?(host: AgentHost, context: AgentContext, dialog: NativeInteraction): boolean;

  // Session state the core shows or asks for, beyond what `observe` reports.
  /** The session's status now, read synchronously at every publish; the last one `emit` carried when absent. */
  status?(host: AgentHost, context: AgentContext): AgentStatus;
  /** Read-only proof that this exact input cannot still run from the Agent's queue or composer. */
  canReleaseInput?(host: AgentHost, context: AgentContext, run: AgentRunRef): Promise<boolean>;
  /** Runs an action from the `runtimeControl` its status carries; see `RuntimeAttachment.act`. */
  runtimeAction?(host: AgentHost, context: AgentContext, request: NativeRuntimeActionRequest): Promise<void>;
  /** Stops a system activity that declares `stop` (a background task); resolves with the state at that moment (usually `stopping`). */
  stopActivity?(host: AgentHost, context: AgentContext, activityId: string): Promise<NativeActivity>;
  /** Pushes back the deadline of a request that carries `extendableUntil`. */
  extendInteraction?(host: AgentHost, context: AgentContext, interactionId: string): Promise<NativeInteraction>;
  /** Relaunches a CLI that probes the terminal colours once at startup so it picks up `session.terminalAppearance`; without it the pane is recoloured in place. */
  relaunchForAppearance?(host: AgentHost, context: AgentContext): Promise<void>;
  /** Hands the conversation's current title to an Agent that keeps names of its own. Only reaches one that is already running. */
  rename?(host: AgentHost, context: AgentContext): Promise<void>;

  // Models, usage, statistics.
  /** Drops a model catalog the plugin caches itself (`traits.cachesModels`). */
  invalidateModels?(): void;
  /** Account quota and per-model load, read live. */
  usage?(host: AgentHost, query: AgentModelQuery): Promise<NativeBackendUsage>;
  /** Settled usage parsed from the Agent's stored transcript, for the statistics backfill. May only read files; `undefined` when `known` is still current. */
  usageTranscript?(host: AgentHost, context: AgentContext, known?: string): Promise<AgentUsageTranscript | undefined>;

  // Extensions (skills, MCP servers, plugins) of the Agent itself.
  /** Where the Agent keeps them on disk, for the inventory; an Agent without one has no inventory. */
  extensionLayout?(profile: AgentProfile): AgentExtensionLayout;
  /** Inspects existing connections only; must not launch the Agent, a thread, MCP or a hook. */
  extensionRuntime?(host: AgentHost, project: AgentProjectView | undefined, profile: AgentProfile): Promise<ExtensionRuntimeReport>;
  skillStates?(host: AgentHost, project: AgentProjectView | undefined, profile: AgentProfile): Promise<Array<{ path: string; enabled: boolean }>>;
  setSkillEnabled?(host: AgentHost, project: AgentProjectView | undefined, profile: AgentProfile, path: string, enabled: boolean): Promise<void>;
  reloadExtensions?(host: AgentHost, project: AgentProjectView | undefined, profile: AgentProfile): Promise<number>;
  /** Starts an MCP server's authorization; resolves with where to continue it. */
  authorizeMcp?(host: AgentHost, project: AgentProjectView | undefined, profile: AgentProfile, name: string): Promise<string>;
  extensionManagementCapabilities?(host: AgentHost, profile: AgentProfile): ExtensionManagementCapabilities;
  manageExtension?(host: AgentHost, profile: AgentProfile, input: ExtensionActionRequest, item?: ExtensionItem): Promise<ExtensionActionResult>;

  // Forwarded legacy endpoints (`/api/cursor/*`, `/api/native/runtime/stats`), for the first Agent.
  /** What this machine can do for the Agent: version, flags, account, models. */
  capabilityReport?(host: AgentHost, profile: AgentProfile): Promise<CapabilityReport>;
  /** Runs one of the Agent CLI's named management operations; `cwd` is an absolute project directory. */
  runCommand?(host: AgentHost, profile: AgentProfile, request: AgentCommandRequest): Promise<CommandResult>;
  /** Counters of the plugin's own runtime (warm-up hits, stage times); plain JSON. */
  runtimeStats?(host: AgentHost): Record<string, unknown> | Promise<Record<string, unknown>>;
  /** The project files the Agent reads its rules, skills, commands, MCP and hook settings from, listed and edited by the workbench (`/api/projects/:id/configs`). */
  readonly projectConfigs?: AgentProjectConfigs;
}

/**
 * Config files of a project. An `id` is the Agent's own opaque token for a file (stable for a path), so
 * the workbench can ask any Agent that has them; a token an Agent does not know fails `CONFIG_NOT_FOUND`
 * (404), which is how the core moves on to the next Agent.
 */
export interface AgentProjectConfigs {
  list(host: AgentHost, project: AgentProjectView, profile: AgentProfile): Promise<ConfigFile[]>;
  read(host: AgentHost, project: AgentProjectView, profile: AgentProfile, id: string): Promise<ConfigFile>;
  /** `expectedHash` is the hash `read` returned; a file changed since then fails `CONFIG_CONFLICT`. */
  write(host: AgentHost, project: AgentProjectView, profile: AgentProfile, id: string, content: string, expectedHash: string): Promise<ConfigFile>;
  create(host: AgentHost, project: AgentProjectView, profile: AgentProfile, input: { kind: ConfigFile['kind']; path: string; content: string }): Promise<ConfigFile>;
}

/** What a subscriber is told: the same messages `host.emit` broadcasts, to one subscriber only. */
export type AgentReport = (message: AgentControlMessage) => void;

export interface AgentCommandRequest { operation: string; args?: string[]; cwd?: string }

/** Settled usage read back from an Agent's own stored transcript; `generation` identifies the file state that was read. */
export interface AgentUsageTranscript { generation: string; entries: Array<{ runId?: string; usage: AgentUsageRecord }> }

/**
 * How the host reads this Agent's panes. All three are pure functions of the pane's text (recent
 * output, control sequences stripped and generic secrets redacted), so they run in the output path.
 */
export interface AgentTerminalBehaviour {
  /** The title of a terminal of this Agent when its launch gave none. */
  title?: string;
  /** Whether the pane shows the Agent past its startup (its prompt, or a turn in flight). Until it first does, an exit is read as a failed start. */
  ready?(paneText: string): boolean;
  /** The message for an Agent that exited before it was ready, from its output; undefined when the output explains nothing. Redact anything specific to this Agent's own secrets first. */
  startupError?(paneText: string): string | undefined;
}

/**
 * Environment names a launch of this Agent hands over through the host process's environment, never
 * its command line. The terminal host imports `managed` names into every pane it starts (and clears a
 * stale copy from a long-lived terminal server when a launch does not set one), and never lets a
 * `secrets` name inherit the host process's own value: only a launch's `env`/`secretEnv` can set it.
 */
export interface AgentLaunchEnv {
  readonly managed: readonly string[];
  /** A subset of `managed`: names that carry a credential. */
  readonly secrets?: readonly string[];
}

export interface AgentPrewarmRequest {
  appearance?: TerminalAppearance;
  model?: string;
  mode?: string;
  approval?: string;
}

/** `ready`: a reservation exists and is idle; `preparing`: it is being started; `skipped`: nothing was started, and `reason` says why. */
export interface AgentPrewarmResult {
  state: 'ready' | 'preparing' | 'skipped';
  claimId?: string;
  reason?: string;
  expiresAt?: number;
}

// ── The host ─────────────────────────────────────────────────────────────────

export interface AgentLaunchSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** Secrets the Agent reads from its environment; never placed on a command line. */
  secretEnv?: Record<string, string>;
  /** Must be the session's project directory; the host refuses anything else. */
  cwd: string;
  title?: string;
  /** A secret-free fingerprint (64 hex digits) kept beside the pane, to tell this launch from a look-alike later. */
  launchMarker?: string;
  /**
   * The terminal kind clients see. `native` unless the Agent is the first one Riffet had: `cursor` is the
   * value older clients and stored terminals know for it, kept so they keep working.
   */
  kind?: 'native' | 'cursor';
  /** A live terminal of the session is returned instead of launching another; concurrent launches of one session share one start. */
  reuseLive?: boolean;
}

/** A terminal the plugin launched. Handles from another plugin's sessions are refused. */
export interface AgentTerminalHandle {
  id: string;
  epoch: number;
  state: 'running' | 'exited' | 'detached';
}

/** A terminal as the plugin may read it: the wire record, without the host's private reservation bookkeeping. */
export type AgentTerminalView = TerminalInfo;

/** What the host sees of a terminal, in order: `output` carries the pane's decoded text, `state` the record after a change, `exit` ends it. */
export type AgentTerminalObservation =
  | { type: 'output'; terminalId: string; data: string; sequence: number }
  | { type: 'state'; terminalId: string; terminal: AgentTerminalView }
  | { type: 'exit'; terminalId: string; exitCode: number };

/** The screen and keys of a terminal while `interact` holds it: no other writer (a browser, a stop) gets in until it returns. */
export interface AgentTerminalControl {
  /** `styled` keeps the SGR sequences, for a focus a TUI draws only as styling. */
  screen(options?: { styled?: boolean }): Promise<string | undefined>;
  keys(keys: string[]): Promise<void>;
  paste(text: string, submit: boolean): Promise<void>;
}

/**
 * An unused process started ahead of time for a session that does not exist yet (`AgentBackend.prewarm`).
 * The host holds it, hides it from terminal lists, and ends it at `expiresAt`; only a call with its
 * `ownerToken` and `resourceKey` extends or releases it, and only `claim` hands it to a session.
 */
export interface AgentReservation {
  terminal: AgentTerminalHandle;
  ownerToken: string;
  /** What a claim has to match: the plugin's own identity of the launch configuration. */
  resourceKey: string;
  /** The Agent's conversation id the process was started with; the session adopts it on claim. */
  nativeSessionId: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

export interface AgentReservationRequest {
  projectId: string;
  ownerToken: string;
  resourceKey: string;
  nativeSessionId: string;
  expiresAt: number;
  appearance?: TerminalAppearance;
  /** `cwd` must be the project's directory. */
  spec: AgentLaunchSpec;
}

export interface AgentTerminals {
  launch(sessionId: string, spec: AgentLaunchSpec): Promise<AgentTerminalHandle>;
  get(terminalId: string): Promise<AgentTerminalHandle>;
  screen(terminalId: string, options?: { fresh?: boolean }): Promise<string | undefined>;
  paste(terminalId: string, text: string, submit: boolean): Promise<void>;
  sendKeys(terminalId: string, keys: string[]): Promise<void>;
  stop(terminalId: string): Promise<void>;
  /** Runs `task` with the pane to itself: a sequence of screen reads and keys that must not interleave with any other writer. `authorize` is checked before it starts, `beforeWrite` before every write; either throws to refuse. */
  interact<T>(terminalId: string, task: (control: AgentTerminalControl) => Promise<T>, options?: { authorize?: () => void; beforeWrite?: () => void }): Promise<T>;
  /** Server-side observation of a terminal, independent of any browser; the output already printed is replayed once. Returns how to stop; ends with the terminal. */
  observe(terminalId: string, callback: (observation: AgentTerminalObservation) => void): () => void;
  /** The pid of the pane's process, for matching it against the Agent's own records; undefined when there is none. */
  panePid(terminalId: string): Promise<number | undefined>;
  /**
   * Verifies the linked pane, project cwd, launch marker and exact argv tokens before returning matching descendant pids.
   * `command` is compared by file name only: a launcher script that `exec`s the real binary leaves that binary's path
   * in argv[0], so a per-launch secret among `args` has to carry the identity. No argv or environment is exposed.
   */
  inspect(terminalId: string, expected: { command: string; args: string[]; launchMarker: string }): Promise<number[] | undefined>;

  /** Starts a process for `request.spec` and holds it as this Agent's reservation. */
  reserve(request: AgentReservationRequest): Promise<AgentReservation>;
  /** Gives the reservation to `sessionId` (which must be this Agent's, in the reservation's project, with the same appearance); refused when it expired, is not ready or is no longer there. */
  claim(terminalId: string, claim: { ownerToken: string; resourceKey: string; sessionId: string }): Promise<AgentTerminalHandle>;
  extendReservation(terminalId: string, extension: { ownerToken: string; resourceKey: string; expiresAt: number }): Promise<AgentReservation>;
  /** This Agent's live reservations; every one when `ownerToken` is not given (a restart reaps what an earlier process left). */
  reservations(ownerToken?: string): Promise<AgentReservation[]>;
  /** Ends a reservation of the given owner; false when there is none to end. */
  releaseReservation(terminalId: string, ownerToken: string): Promise<boolean>;
}

/**
 * Blocking dialogs on an Agent's screen (a trust prompt, a question), read and answered through the
 * pane. The ids of what `observe` returns stay the same while the dialog does. Answers are idempotent
 * per `requestId`, and the host never writes into the transcript.
 */
export interface AgentDialogs {
  observe(screen: string | undefined, terminal: { id: string; epoch: number }): NativeInteraction | undefined;
  /** The dialog the session's terminal shows now. */
  current(sessionId: string): Promise<NativeInteraction | null>;
  /** Answers it with the CLI's own keys. `guard` is re-checked right before each write; false refuses it. */
  respond(sessionId: string, response: NativeInteractionResponse, guard?: (interaction: NativeInteraction) => boolean | Promise<boolean>): Promise<NativeInteractionResult>;
  /** The result of an answer already given (or in flight) under this `requestId`. */
  replay(sessionId: string, response: NativeInteractionResponse): Promise<NativeInteractionResult> | undefined;
  /** An answer is being typed into this terminal now. */
  isResponding(terminalId: string): boolean;
  /** Whether `interactionId` was issued by `observe`. */
  owns(interactionId: string): boolean;
}

/**
 * A read-only, synchronous look at this Agent's records, for code that keeps a picture of its sessions
 * in loops and handlers that cannot await. Plain data read at the call; a foreign or unknown id is
 * `undefined`. Writes made through the host (`updateSession`, `setNativeSessionId`, `recordActivity`)
 * are visible here as soon as the call returns, in call order: the promise only reports failure.
 */
export interface AgentView {
  session(sessionId: string): AgentSessionView | undefined;
  /** Every session of this Agent. */
  sessions(): AgentSessionView[];
  project(projectId: string): AgentProjectView | undefined;
  terminal(terminalId: string): AgentTerminalView | undefined;
  /** The terminals of this Agent's sessions; reservations are not among them. */
  terminals(): AgentTerminalView[];
  firstUserMessage(sessionId: string): string | undefined;
  /** The session's runs bound to one native turn, oldest first: `host.runs.find` for code that cannot await (a hook's receipt check, a status poll). */
  runsOfTurn(sessionId: string, nativeSessionId: string, nativeTurnId: string): AgentRunRef[];
}

export interface AgentRunRef {
  id: string;
  sessionId: string;
  commandId: string;
  state: string;
  delivery?: string;
  intent?: string;
  nativeSessionId?: string;
  nativeTurnId?: string;
  nativeMessageId?: string;
  /** The run's own failure text. */
  error?: string;
  /** Where the delivery stands in the core's finer vocabulary (`steer_rejected`, `acknowledged`, ...). */
  stage?: string;
  /** The text the Agent was given, once the dispatch fence recorded it. */
  renderedText?: string;
  /** The user's text. */
  inputText?: string;
  /** The run whose turn an additional input (a steer) joined. */
  ownerRunId?: string;
  config?: NativeRunConfig;
  resolvedConfig?: NativeRunConfig;
  /** When the core finished handing the input over (epoch ms), on whichever path it took. */
  inputSentAt?: number;
  /** Opaque native boundary saved with the input fence; needed to reconcile an interrupted handover without resending. */
  nativeInputBoundary?: string;
}

export type AgentRunQuery =
  | { commandId: string }
  | { nativeMessageId: string }
  | { nativeSessionId: string; nativeTurnId: string }
  /** The session's unfinished runs. */
  | { unfinished: true };

/** A settled provider request, in the statistics ledger's vocabulary. Absent means "not reported", never zero. */
export interface AgentUsageRecord {
  /** Backend-scoped identity of the request; recording it again replaces the row. */
  stepId: string;
  model?: string;
  agentKind?: 'main' | 'subagent';
  subagentType?: string;
  parentStepId?: string;
  /** Epoch milliseconds. */
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  nativeMessageId?: string;
  nativeSessionId?: string;
  /** Input that missed the cache. */
  inputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  tokenSource: 'provider' | 'estimated';
  window?: 'stream' | 'transcript' | 'observed';
}

/** Durable response fence of an idempotent interaction: the same request answers the same way. */
export interface AgentInteractionReceipt {
  fingerprint: string;
  interactionId: string;
  revision: string;
  result: NativeInteractionResult;
  createdAt: string;
}

/**
 * The fields of a session a plugin may write about its own session. `state` and `error` are the
 * session's run state: only a backend declaring `traits.ownsSessionObservation` may write them (the host
 * refuses otherwise), because for any other the core derives them. `error: undefined` clears the error.
 * `nativeSessionId` is what `setNativeSessionId` writes (and is refused the same way when another live
 * conversation owns the chat); in a patch it lands in the same write as the other fields.
 */
export type AgentSessionPatch = Partial<Pick<Session, 'model' | 'mode' | 'approval' | 'configPending' | 'terminalId' | 'title' | 'titleSource' | 'nativeSessionId' | 'state' | 'error'>>;

/**
 * What the core offers a plugin. A call is asynchronous and made on behalf of the session it names; a
 * session that is not this Agent's is refused. The exceptions are `view`, the reads of code that cannot
 * await, and the reports and observers that return at once.
 */
export interface AgentHost {
  /** An error whose message reaches the client unchanged when `statusCode` is below 500. */
  error(code: string, message: string, statusCode?: number): Error;

  session(sessionId: string): Promise<AgentSessionView>;
  project(projectId: string): Promise<AgentProjectView>;
  /** The profile as it is configured now, which can differ from the one a long-lived reader started with. */
  profile(sessionId: string): Promise<AgentProfile>;
  /** The first message of the conversation, as the journal holds it. */
  firstUserMessage(sessionId: string): Promise<string | undefined>;
  setNativeSessionId(sessionId: string, nativeSessionId: string | undefined): Promise<AgentSessionView>;
  /** `bump` marks a change of meaning (model, mode, approval): the configuration revision moves with the write. */
  updateSession(sessionId: string, patch: AgentSessionPatch, options?: { bump?: boolean }): Promise<AgentSessionView>;
  /** The Agent did something in the session at `at` (an ISO time): moves `lastActivityAt` forward, never back. Resolves with the session when it moved. */
  recordActivity(sessionId: string, at: string): Promise<AgentSessionView | undefined>;
  /** Synchronous reads of this Agent's records; see `AgentView`. */
  view: AgentView;
  /** Blocking dialogs on this Agent's screens; see `AgentDialogs`. */
  dialogs: AgentDialogs;

  /** Reports status, context, metrics, jobs, session changes and subagent activity of a session. */
  emit(sessionId: string, message: AgentControlMessage): void;
  /** An event outside the transcript: an acceptance (`native_input_receipt` with the command id) or a turn outcome. */
  emitEvent(sessionId: string, event: AgentEvent): void;

  transcript: {
    /** The Agent's data may have changed: the conversation is read again soon, if anyone follows it. */
    wake(sessionId: string): void;
    /** Reads what is stored into the journal now, after any read in flight. */
    drain(sessionId: string): Promise<void>;
    /** A turn the transcript will not end (the process exited): what is stored is read first, then the end is recorded. */
    endTurn(sessionId: string, turnId: string, status: AgentTurnStatus, at: string, error?: string): Promise<void>;
    /** Writes events the plugin was told of (a stream, a hook) instead of being asked for them; the same batch as `AgentTranscript.read` returns, and `cursor` is stored with the rows, so a plugin that also implements `transcript` keeps one cursor meaning for both. */
    ingest(sessionId: string, batch: AgentTranscriptBatch): Promise<void>;
    /** Runs `task` with the session's `transcriptSource` and its main lane writer, between the conversation's reads: for a hook-driven write that must land beside what the source read. `undefined` when the session has no source or the task failed. */
    withSource<T>(sessionId: string, task: (source: AgentTranscriptSource, w: AgentLaneWriter) => Promise<T> | T): Promise<T | undefined>;
  };

  /** Throws when the run was cancelled or its target changed, in which case nothing may be written. */
  commitDispatchFence(runId: string, binding?: AgentDispatchBinding): Promise<void>;
  /** Right before the process that carries `initialPrompt` starts. Throws to abort the launch. */
  beforeSpawn(sessionId: string): Promise<void>;
  /** Right before a stop is written, when `expectedStop` was given; throws if the target changed. */
  checkStopTarget(sessionId: string, allowEnded?: boolean): Promise<void>;
  isRunCancelled(runId: string): Promise<boolean>;
  runs: { find(sessionId: string, query: AgentRunQuery): Promise<AgentRunRef[]> };

  /**
   * The model source a profile of this Agent names, as a wire address. A source's own secrets (a token another
   * tool keeps, a key it mints) reach the plugin only here, and only for its own profiles.
   */
  modelSources: {
    /**
     * Where the source named by the profile `profileId` (`config.modelSource`, with the profile's own overrides) is
     * reached over `protocol`. `undefined` when the profile names no source, the source is unavailable or does not
     * serve the protocol. A profile of another Agent is refused. A credential the source runs a command for is not
     * handed over: `credential` is present only for a static key.
     */
    resolve(profileId: string, protocol: GatewayProtocol): Promise<AgentModelEndpoint | undefined>;
  };

  terminals: AgentTerminals;
  /** Runs `operation` under the session's lock, the one start, configure, send and stop share. `detached` for work started from timers and events. */
  withSessionLock<T>(sessionId: string, operation: () => Promise<T> | T, options?: { detached?: boolean }): Promise<T>;

  stats: {
    recordUsage(sessionId: string, runId: string | undefined, usage: AgentUsageRecord): void;
    /** Durable ACK; partial/conflicting facts remain readable but do not enter accurate totals. */
    recordObservation?(sessionId: string, runId: string | undefined, observation: UsageObservation): boolean;
    /** Only observations belonging to this backend. */
    readObservations?(): Promise<RecordedUsageObservation[]>;
    subscribeObservations?(listener: (observation: RecordedUsageObservation) => void): () => void;
    /** A turn's measured output speed; later calls replace it. */
    saveRunMetrics(runId: string, metrics: RunMetrics): void;
    /** Transcript events the plugin read or wrote, for the ledger to extract tool calls from. Full events, as the lane writer takes them. */
    observeEvents(sessionId: string, events: readonly NativeWorkbenchEvent[]): void;
  };
  /**
   * What a shell command changed in the working tree, seen from outside the Agent: for an Agent whose CLI does not report
   * file edits made by a command. Absent when the host keeps no state directory to snapshot into.
   */
  workspaceChanges?: {
    /** Snapshots the working tree `cwd` belongs to before command `key` runs; resolves once taken or given up on (about 1.5s at most), so call it before the command is allowed to run. */
    begin(sessionId: string, key: string, cwd: string): Promise<void>;
    /** Compares the working tree with the snapshot of `key` and releases it; `undefined` when the command was not observed. Always call it once after `begin`. */
    end(sessionId: string, key: string): Promise<readonly Record<string, unknown>[] | undefined>;
    /** Releases the snapshot of a command that never ran. */
    discard(sessionId: string, key: string): void;
    /** Keeps `diffs` as what the call `callId` of the session changed; the transcript mapping reads them back with `changes`. */
    record(sessionId: string, callId: string, diffs: readonly Record<string, unknown>[]): void;
    /** What `record` kept; synchronous, so a transcript read can replay it. */
    changes(sessionId: string, callId: string): readonly Record<string, unknown>[] | undefined;
  };
  readAttachment(id: string): Promise<{ attachment: Attachment; data: Uint8Array }>;
  interactionReceipts: {
    get(sessionId: string, requestId: string): Promise<AgentInteractionReceipt | undefined>;
    save(sessionId: string, requestId: string, receipt: AgentInteractionReceipt): Promise<AgentInteractionReceipt>;
  };
  /** The Riffet MCP server a launch carries (`traits.riffetTools`); undefined for an archived session or a quick chat. */
  riffetMcp(sessionId: string): Promise<{ name: string; command: string; args: string[] } | undefined>;
  /** Installs a per-call runtime binding check. Once required, calls stay refused across restarts until a validator is registered again. Disposing removes the validator, not the requirement. */
  bindRiffetMcp(sessionId: string, validate: (metadata: Record<string, unknown>) => Promise<void>): () => void;
}
