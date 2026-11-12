import type { NativeBackendId } from './agent-ids.js';
import type { GatewayProtocol } from './plugin-management.js';
export * from './extensions.js';
export * from './update.js';
export * from './theme.js';
export * from './share.js';
export * from './sync.js';
export * from './model-selection.js';
export * from './owner.js';
export type * from './plugin-management.js';
export type * from './plugins.js';
export type * from './plugin-packages.js';
export type * from './tasks.js';
export type * from './channels.js';
export type * from './appearance.js';
export { APPEARANCE_BACKGROUND_AREAS, APPEARANCE_BACKGROUND_FITS, APPEARANCE_DEFAULT, APPEARANCE_FONT_ROLES, APPEARANCE_FONT_STYLES, APPEARANCE_MAX_FONT_BYTES, APPEARANCE_MAX_IMAGE_BYTES, APPEARANCE_MAX_PALETTE_BYTES } from './appearance.js';
export { PLUGIN_CAPABILITIES, PLUGIN_WEB_API_VERSION } from './plugin-packages.js';
export { AGENT_ICON_ROUTE, COMMAND_SCOPES, PLUGIN_CLIENTS, PLUGIN_ID, VIEW_INSTANCES, VIEW_LOCATIONS, isContributionOf } from './plugins.js';
export { NATIVE_BACKEND_IDS, PLUGIN_AGENT_ID, PLUGIN_AGENT_ID_MAX, isAgentOfPlugin, isBuiltinBackendId, isNativeBackendId, isPluginAgentId } from './agent-ids.js';
export type { BuiltinBackendId, NativeBackendId, PluginAgentId } from './agent-ids.js';
export { isDoneUnseen, isRunningSession, isUnread, needsYou } from './session-attention.js';

/**
 * Wire-protocol capabilities, advertised by `GET /health` and `GET /api/bootstrap`. A server that
 * predates v2 omits it, so clients treat a missing `protocol` as version 1 with no features.
 * - `list-etag`: `GET /api/sessions` and `GET /api/terminals` answer `If-None-Match` with 304, and
 *   the lists stream's `changed` event carries `{revision}`.
 * - `sync-v3`: conversations sync over `/api/v3/sessions/:id/…` (docs/SYNC-V3.md); the v2 native
 *   stream, snapshot and history routes are gone.
 * - `integrations-v1`: `/api/integrations` serves built-in plugin descriptors and actions.
 * - `quick-chat`: quick chats exist (`backendId: 'chat'` in the project marked `system: 'quick-chat'`).
 *   Only a client that names the feature in {@link CLIENT_FEATURES_HEADER} is shown them or their
 *   project: an older phone cannot decode the backend id, and a client without the UI would list the
 *   project as an ordinary one.
 * - `pi-agent`: the client can decode and operate pi native sessions and their backend catalog.
 * - `plugin-agents`: the client can decode an Agent id that is not built in (`PluginAgentId`: namespaced
 *   by the providing plugin). Only a client that names it is sent a session, run, catalog entry, event or
 *   setting carrying one; the others see what they saw before, as with `pi-agent`.
 * - `session-references-v1`: messages can reference immutable snapshots of other sessions.
 * - `session-delete-v1`: `GET /api/sessions/:id/deletion` and `DELETE /api/sessions/:id` remove an idle
 *   conversation with its side chats (docs/design/session-deletion.md); a deleted id answers `410 SESSION_DELETED`.
 */
export type ProtocolFeature = 'list-etag' | 'sync-v3' | 'integrations-v1' | 'quick-chat' | 'pi-agent' | 'projectless-tasks' | 'plugin-agents' | 'session-references-v1' | 'session-delete-v1';
export interface ProtocolInfo { version: number; features: ProtocolFeature[]; }
export const PROTOCOL_INFO: ProtocolInfo = { version: 3, features: ['list-etag', 'sync-v3', 'integrations-v1', 'quick-chat', 'pi-agent', 'projectless-tasks', 'plugin-agents', 'session-references-v1', 'session-delete-v1'] };
/** Request header naming the features a client understands, comma-separated. */
export const CLIENT_FEATURES_HEADER = 'x-riffet-features';
/**
 * A set of Riffet tools a conversation's CLI is given through the Riffet MCP server.
 * `riffet.core` is the workbench's own (wake-ups, notices, devices); `device:<id>` is reserved for
 * the capabilities a paired device declares.
 */
export type ToolGroupId = 'riffet.core' | `device:${string}`;
export const RIFFET_TOOL_GROUPS = ['riffet.core'] as const satisfies readonly ToolGroupId[];
/**
 * A one-shot wake-up an agent scheduled for its own conversation (`schedule_wakeup`). It is marked
 * `fired` before the turn is sent, so it starts at most one turn; `failed` and `missed` carry `error`.
 */
export interface RiffetWakeup {
  id: string; sessionId: string; dueAt: string; note: string; createdAt: string;
  status: 'pending' | 'fired' | 'cancelled' | 'failed' | 'missed';
  firedAt?: string; runId?: string; error?: string;
}
/** Something an agent asked to show the user (`notify_user`); `wakeup` marks the workbench's own notice about a wake-up that could not run. */
export interface RiffetNotice { id: string; sessionId: string; title?: string; body: string; createdAt: string; source: 'agent' | 'wakeup'; }

/*
 * The device channel (docs/DEVICES.md §3). A paired device reports what it can do, keeps its own
 * stream open to receive calls and leases, and answers each call over HTTP.
 */
export const DEVICE_PLATFORMS = ['android', 'ios', 'mac'] as const;
export type DevicePlatform = typeof DEVICE_PLATFORMS[number];
/** T0 first, then T1. A device reports only those it can serve right now. */
export const DEVICE_CAPABILITIES = ['notify', 'clipboard.read', 'clipboard.write', 'location', 'photo', 'open_url', 'alarm', 'screen.observe', 'screen.act', 'app.launch'] as const;
export type DeviceCapability = typeof DEVICE_CAPABILITIES[number];
/**
 * `PUT /api/devices/me`, sent by the device before it opens its stream and whenever any of it changes.
 * `installationId` is random, made once per app installation: pairing again from the same installation
 * replaces the earlier record instead of adding another.
 */
export interface DeviceReport {
  platform: DevicePlatform; appVersion: string; capabilities: DeviceCapability[]; allowControl: boolean; installationId?: string;
  /** Absent leaves the stored registration as it is; `null` removes it. */
  push?: DevicePushRegistration | null;
}
/**
 * APNs registration an iOS device sends in `PUT /api/devices/me`. `topic` is the app's bundle id. The Live
 * Activity tokens are optional: `activityStartToken` is the push-to-start token, `activityToken` the running
 * summary activity's own; a report without `activityToken` means no activity is running.
 */
export interface DevicePushRegistration { token: string; topic: string; environment: 'production' | 'sandbox'; activityStartToken?: string; activityToken?: string; }
/**
 * How the server reaches a device in the background: `direct` pushes to APNs with the owner's key. `none` says
 * why not: the server holds no key, the device registered no token, or APNs refused the last push (`detail`).
 */
export interface DevicePushRoute { route: 'direct' | 'none'; reason?: 'no_key' | 'no_token' | 'failed'; detail?: string; }
/** `GET /api/devices`. A device that never reported has no capabilities and does not allow control. */
export interface DeviceInfo {
  id: string; name: string; platform?: DevicePlatform; appVersion?: string; createdAt: string; lastSeenAt?: string;
  /** Whether the device's stream is open now. */
  online: boolean; capabilities: DeviceCapability[]; allowControl: boolean;
  /** Present for iOS devices and any device that registered for push. */
  push?: DevicePushRoute;
}
/**
 * `GET /api/settings/push`: the APNs auth key this server pushes with. The key itself is never returned.
 * `status` is `invalid` once APNs refused a token signed with it.
 */
export interface PushKeyStatus { configured: boolean; keyId?: string; teamId?: string; status?: 'ok' | 'invalid'; detail?: string; }
/** `PUT /api/settings/push`: `key` is the `.p8` file's PEM text. */
export interface PushKeyInput { keyId: string; teamId: string; key: string; }
/**
 * `GET /api/backends/:id/loaded-extensions?profileId&projectId`: the MCP servers and skills a launch of
 * that backend profile in that project loads, as the CLI reports them. Riffet's own server is left out.
 */
export interface LoadedExtensions {
  mcp: Array<{ name: string; tools?: number }>;
  skills: Array<{ name: string; description?: string }>;
  checkedAt: string;
}
/** A request for a device, the stream's `call` event. `deadline` is when the server stops waiting. */
export interface DeviceCall { callId: string; sessionId: string; capability: DeviceCapability; args: Record<string, unknown>; deadline: string; createdAt: string; }
/** The device's answer to a call (`POST /api/devices/me/calls/:callId/result`). */
export type DeviceCallOutcome = { ok: true; result: Record<string, unknown> } | { ok: false; code: string; message?: string };
/** What the server kept of the first answer; a repeated answer receives the same receipt. */
export interface DeviceCallReceipt { callId: string; outcome: DeviceCallOutcome; receivedAt: string; }
/** A file a device attached to a call's result (`result.fileIds`). */
export interface DeviceFile { fileId: string; name: string; mimeType: string; size: number; }
/** The stream's `lease` event: be connected shortly before `at`. Its id is the wake-up's. */
export interface DeviceLease { id: string; sessionId: string; at: string; reason: string; }
/**
 * `GET /api/devices/me/adb?package=<id>`: whether this phone is also connected to the server's Mac over adb.
 * `ready` means an adb entry in state `device` carries this installation's id file; `unauthorized` that none
 * matched but one is waiting for the USB-debugging prompt to be accepted; `no-adb` that the Mac has no adb.
 */
export interface DeviceAdbStatus { state: 'ready' | 'unauthorized' | 'absent' | 'no-adb'; }
/**
 * `POST /api/devices/me/adb/grant` `{ packageName }`: `WRITE_SECURE_SETTINGS` was granted over adb;
 * `restrictedSettings` is whether Android 13+ restricted settings were also allowed (`unsupported` on older systems).
 * A refused grant is 409 `ADB_GRANT_FAILED`, an unavailable phone 409 `ADB_UNAVAILABLE`.
 */
export interface DeviceAdbGrant { restrictedSettings: 'allowed' | 'unsupported'; }
/** One step of a recorded device action: `target` is the text of the control acted on, `code` a failed step's error. */
export interface RiffetDeviceActionStep { action: string; target?: string; effect?: string; code?: string; }
/**
 * `GET /api/sessions/:id/device-actions`: what a conversation did on a device's screen (`screen.act`,
 * `app.launch`), one record per call that reached the device. `category` and `authorizedBy` come from
 * the first irreversible step; `code` is why the call or its failing step did not succeed.
 */
export interface RiffetDeviceAction {
  id: string; sessionId: string; deviceId: string; createdAt: string;
  kind: 'act' | 'launch' | 'authorize'; package?: string; steps: RiffetDeviceActionStep[];
  category?: string; authorizedBy?: string; ok: boolean; code?: string;
}

export type SessionKind = 'native';
export type SessionState = 'idle' | 'starting' | 'running' | 'waiting' | 'cancelling' | 'interrupted' | 'failed' | 'archived';
/**
 * Where a conversation's title came from, weakest first. `provider` is a CLI's placeholder-grade
 * label (a resume-picker guess, DSH's clipped summary), `prompt` is the first human message,
 * `generated` is a model-written title — the CLI's own (Codex, Claude Code, Cursor) or the
 * workbench's — and `user` is what the reader typed. A title is only ever replaced by a stronger
 * source, and `generated` replaces `prompt` once, so a conversation is named instantly and then
 * upgraded without ever overriding a rename.
 */
export type SessionTitleSource = 'prompt' | 'provider' | 'generated' | 'user';
/**
 * How the native CLI approves tool calls, in the CLI's own vocabulary: `allowlist` asks per call
 * through its allowlist, `auto-review` lets Cursor's classifier run the safe ones, `unrestricted`
 * is "Run Everything". The launch flags (`--auto-review`, `--force`) are the only supported lever —
 * the CLI's own `approvalMode` setting is private state and is never written.
 */
export type ApprovalMode = 'allowlist' | 'auto-review' | 'unrestricted';
export interface Project {
  id: string; name: string; cwd: string; tags?: string[]; archivedAt?: string; createdAt: string; updatedAt: string;
  /**
   * Set when this project is a git worktree of another one, which is how a conversation gets a
   * checkout to itself. A session takes its directory from its project, so isolating one is a
   * matter of pointing it at a different project rather than teaching every backend about a
   * second kind of path.
   */
  worktree?: { originProjectId: string; branch: string };
  /** Internal directories stay out of the project picker. Each task workspace holds one independent task and its continuations. */
  system?: 'quick-chat' | 'task-workspace';
}
export interface TaskWorkspaceLocation {
  path: string;
  source: 'custom' | 'default';
  available: boolean;
  error?: string;
}
/** `GET /api/sessions/:id/deletion`: what deleting the conversation would remove, for the confirmation. */
export interface SessionDeletionPreview {
  /** The conversation and its side chats, root first; `DELETE` is sent the same set. */
  sessionIds: string[];
  /** Set while the conversation cannot be deleted (a turn, queue, approval or share operation is in progress). */
  blocker?: { code: string; message: string; params?: TextParams };
  effects: { discussions: number; schedules: number };
}
/** `DELETE /api/sessions/:id` answers with every id it removed. */
export interface SessionDeletionReceipt { sessionIds: string[]; deletedAt: string }
export interface Session {
  id: string; projectId: string; kind: SessionKind; title: string; tags: string[];
  /** Default colours for the next CLI launch; a running terminal keeps its own appearance. */
  terminalAppearance?: TerminalAppearance;
  state: SessionState;
  /** Provenance of `title`; missing on rows written before the workbench named conversations itself. */
  titleSource?: SessionTitleSource;
  /** Native provider routing. Missing backendId and backendProfileId mean the legacy default Cursor profile. */
  backendId?: NativeBackendId; backendProfileId?: string;
  /** Provider-owned resumable session reference. Cursor sessions mirror this into cursorSessionId for old clients. */
  nativeSessionId?: string;
  /**
   * Earlier provider session ids of this conversation, oldest first. Claude Code starts over under a
   * new id after repeated launch crashes; the old ids keep their transcripts readable.
   */
  previousNativeSessionIds?: string[];
  /** Consecutive Claude Code launches that exited within seconds; at two, the next launch starts fresh. */
  quickExitCount?: number;
  /**
   * Server-written connection binding; clients cannot set it when creating a conversation.
   * `profileId` identifies the actual writer while `backendProfileId` may name a pending choice.
   * `attachment` is a plugin's sidecar on the native process, under that plugin's id.
   */
  nativeRuntime?: { address: string; fingerprint: string; scopeFingerprint?: string; profileId?: string; attachment?: { hook: string; id: string } };
  /** Deprecated Cursor reference; retained while old clients or persisted sessions use it. */
  cursorSessionId?: string; terminalId?: string; resumePicker?: boolean;
  model?: string; mode: string; approval?: string; archivedAt?: string; error?: string;
  /** Incremented when native model/mode/approval settings change; Runs retain the accepted revision. */
  configRevision?: number;
  /**
   * A switch is recorded but the running CLI has not applied it yet.
   *
   * Cursor and Claude change a model or permission through launch flags, so a switch asked for while a turn
   * is running cannot be applied without killing that turn: it is recorded, and the CLI is relaunched
   * at the first idle moment. This flag is what keeps that promise across a workbench restart, when
   * the CLI itself is still running behind its persistent terminal. Codex also uses it while a provider
   * switch waits to resume the same thread on its new writer; model-only changes apply per turn.
   * DSH applies configuration per turn. TRAE also uses it for an offline
   * permission switch, so reconnecting does not adopt the old native mode over the pending choice.
   */
  configPending?: boolean;
  /** Immutable fingerprint for a client-created native session and its first submission. */
  creationFingerprint?: string;
  /** Most recent message activity; observing or editing session metadata does not change it. */
  lastActivityAt?: string;
  /**
   * How far the owner has read: the `lastActivityAt` a client last showed in the foreground, on any
   * device. Only moves forward. Missing on a server that predates read state, which reads as seen.
   */
  seenActivityAt?: string;
  /**
   * When the conversation last entered an active state (starting, running, waiting, cancelling).
   * Active conversations sort by it, so a streaming turn does not reshuffle them; only meaningful
   * while the state is active.
   */
  activeSince?: string;
  /** A pinned conversation sorts before other conversations in its project. */
  pinnedAt?: string;
  /** Pin order, smaller first. */
  pinRank?: number;
  /** Set when the workbench opened this conversation on someone's behalf rather than from the composer. */
  origin?: SessionOrigin;
  /** The conversation this one was handed off to; this one stays readable but is no longer the live thread. */
  handedOffTo?: string;
  /**
   * Riffet tool groups this conversation's CLI is launched with, resolved once from the creating
   * client's settings (docs/DEVICES.md §2). Missing or empty means no Riffet MCP server.
   */
  toolGroups?: ToolGroupId[];
  /**
   * MCP servers and skills switched off for this conversation, as `mcp:<name>` / `skill:<name>`
   * (docs/EXTENSIONS.md). A snapshot like `toolGroups`: the next launch of the CLI applies it.
   * Missing or empty means everything the user installed stays on.
   */
  extensionsOff?: string[];
  /**
   * The conversation was handed to a terminal (`riffet resume`): that CLI is its only writer, so
   * nothing here sends, launches or reclaims it until the hold is released (docs/TERMINAL-SESSIONS.md).
   */
  terminalHold?: SessionTerminalHold;
  /** The conversation's current goal, kept by the server from whichever backend owns it; missing when there is none. */
  goal?: SessionGoal;
  createdAt: string; updatedAt: string;
}
export type SessionGoalStatus = 'active' | 'paused' | 'blocked' | 'usage_limited' | 'budget_limited' | 'complete';
/** A completion condition the agent keeps working toward (Claude Code `/goal`, Codex thread goals, DSH goals). */
export interface SessionGoal {
  objective: string;
  status: SessionGoalStatus;
  /** Why it is blocked, or the latest check's verdict. */
  reason?: string;
  tokensUsed?: number;
  tokenBudget?: number;
  seconds?: number;
  updatedAt: string;
}
export interface SessionTerminalHold {
  since: string;
  /** The terminal CLI's process once `riffet resume` started it; missing while it is starting. */
  pid?: number;
}
/** Where a provider conversation found on this machine was started from. */
export type ExternalSessionSource = 'cli' | 'ide' | 'desktop' | 'exec' | 'sdk' | 'other';
/**
 * A provider conversation stored on the server's machine, as the import picker lists it
 * (docs/TERMINAL-SESSIONS.md). Read from the provider's own files; listing it starts nothing.
 */
export interface ExternalSession {
  backendId: NativeBackendId;
  backendProfileId: string;
  nativeSessionId: string;
  cwd: string;
  title: string;
  /** The first prompt, when the title is something else. */
  preview?: string;
  gitBranch?: string;
  updatedAt: string;
  source: ExternalSessionSource;
  /** Who runs it right now: a CLI outside Riffet, or this conversation's own. */
  live?: 'terminal' | 'riffet';
  liveStatus?: 'idle' | 'busy';
  /** The project whose directory is `cwd`. */
  projectId?: string;
  cwdExists: boolean;
}
export interface ExternalSessionPage {
  items: ExternalSession[];
  nextCursor?: string;
  /** Backends whose conversations could not be read this time; the rest are still listed. */
  failures?: Array<{ backendId: NativeBackendId; message: string }>;
}
export interface ExternalSessionDirectory {
  cwd: string;
  count: number;
  updatedAt: string;
  projectId?: string;
  exists: boolean;
}
/**
 * Why a conversation exists. `sessionId`/`runId` name the conversation (and turn) it continues;
 * `groupId` and `automationId` name what launched it.
 */
export interface SessionOrigin {
  kind: 'fork' | 'handoff' | 'attempt' | 'automation' | 'template' | 'schedule' | 'discussion' | 'channel';
  /** An IM chat the conversation was opened from (docs/design/channels.md). */
  channel?: { kind: string; account: string; chatId: string };
  sessionId?: string; runId?: string; groupId?: string; automationId?: string;
  /** Set on conversations opened before templates and schedules became automations (0.7). */
  templateId?: string; scheduleId?: string;
  /** A discussion keeps its source separately from its own visible messages. */
  discussion?: DiscussionOrigin;
}
export interface DiscussionSource { anchor: MarkAnchor; quote: MarkQuote }
export interface DiscussionOrigin extends DiscussionSource {
  capturedAt: string;
  /** Immutable parent context, owned by the discussion in the existing session blob store. */
  contextRef: string;
  requestFingerprint: string;
}
export interface DiscussionCreateRequest extends DiscussionSource {
  clientSessionId: string;
  commandId: string;
  text: string;
  model?: string;
}
/** User-selected session identity; `fromRunId` restores a snapshot owned by the receiving session. */
export interface SessionReferenceInput {
  kind: 'session';
  sessionId: string;
  fromRunId?: string;
}
/** Metadata of captured reference data. The message bytes remain in the receiving session's blob store. */
export interface CapturedSessionReference {
  sessionId: string;
  title: string;
  backendId: NativeBackendId;
  projectName: string;
  capturedAt: string;
  snapshotRef: string;
  excerpt: string;
  coverage: {
    source: 'native' | 'journal';
    completeness: 'complete' | 'partial';
    messages: number;
    bytes: number;
    from?: string;
    through?: string;
    activeTurnIncomplete?: boolean;
    reason?: string;
  };
}
export interface NativeRunInput {
  text: string;
  attachmentIds: string[];
  context: Array<{ path: string; line?: number }>;
  references?: SessionReferenceInput[];
}
/** A provider turn identity; unlike a display run id it can fence a mid-turn input. */
export interface NativeTurnTarget { nativeSessionId: string; turnId: string; }
/** A Stop belongs to the exact state the caller saw; retries preserve this identity. */
export interface NativeStopRequest {
  requestId: string; nativeSessionId: string; turnId?: string;
  terminalId?: string; terminalEpoch?: number;
}
export interface NativeRunRecovery { run: Run; canContinue: boolean; queuedRunIds: string[]; }
/** Config values keep the selected backend's own vocabulary and semantics. */
export interface NativeRunConfig { model?: string; mode: string; approval?: string; }
export type NativeDeliveryState = 'queued' | 'preparing' | 'dispatching' | 'input_sent' | 'observed' | 'uncertain' | 'failed' | 'cancelled';
export interface NativeRunDetails {
  /** Durable first-attempt marker: failed/late pre-turn snapshots must never be retaken later. */
  checkpointAttempted?: boolean;
  input: NativeRunInput;
  /** Immutable captured references, without their message bytes or materialized file paths. */
  contextSnapshots?: CapturedSessionReference[];
  config: NativeRunConfig;
  /** A message for this exact active turn, never a new queued task. */
  intent?: 'steer';
  nativeTurnId?: string;
  /** Stable execution owner when this submission is an additional input to a turn. */
  ownerRunId?: string;
  /** A queued submission atomically replaced by this steering input. */
  sourceRunId?: string;
  /** This execution was observed through live native turn hooks; idle alone cannot settle it. */
  expectsTurnOutcome?: boolean;
  /** Actual model selection after CLI capability normalization; config remains the request snapshot. */
  resolvedConfig?: NativeRunConfig;
  fingerprint: string;
  delivery: NativeDeliveryState;
  attempt: number;
  terminalId?: string;
  terminalEpoch?: number;
  nativeSessionId?: string;
  backendId?: NativeBackendId;
  cursorSessionId?: string;
  nativeMessageId?: string;
  stage?: string;
  timings?: Record<string, number>;
  /** Baseline native event sequence and the exact text delivered to the CLI, when known. */
  baselineSequence?: number;
  renderedText?: string;
  /** Driver-written, secret-free native entry boundary captured before the input was sent. */
  nativeInputBoundary?: string;
  /** Releases only the old uncertain-input fence, never current provider activity. */
  queueReleasedAt?: string;
  /** Technical cause retained separately from the user-facing status. */
  diagnostic?: { code?: string; message: string; stage?: string; at: string };
  /**
   * The provider's own verdict on whether the CLI answers this message inside its pane as a slash
   * command (`true`) or runs it as a turn (`false`, e.g. a skill invoked as `/name`). Absent means
   * the text decides: a leading `/` is a command.
   */
  slashCommand?: boolean;
  configRevision: number;
  /**
   * Model output speed for the whole turn. Persisted, because two of the four providers can only
   * be timed while they are being watched: a browser reload must not turn a measured turn into a
   * missing one. Absent means "this turn was not measured", never "zero".
   */
  metrics?: RunMetrics;
}

/** Where a token count came from. An estimate is always labelled as one in the UI. */
export type MetricsTokenSource = 'provider' | 'estimated';
/**
 * What the measured milliseconds actually bracket, which is what makes two providers comparable:
 * `stream` is first delta to last delta (true decode time), while `transcript` and `observed`
 * start at the previous committed record and therefore include the provider's time-to-first-token.
 */
export type MetricsWindow = 'stream' | 'transcript' | 'observed';
/** Token accounting for one assistant response step, as reported by a provider or estimated. */
export interface StepMetrics {
  /** Backend-scoped identity of one assistant response (one provider request). */
  stepId: string;
  outputTokens: number;
  tokens: MetricsTokenSource;
  durationMs: number;
  /** Epoch milliseconds of the observed output, so replayed history is never timed as new output. */
  startedAt?: number;
  endedAt?: number;
  window: MetricsWindow;
  /** True while this step is still streaming; a live step is replaced by its settled value. */
  live: boolean;
  /** Reasoning tokens when the provider accounts for them inside `outputTokens`. */
  reasoningTokens?: number;
}
/** Turn-to-date aggregate: the sum over the turn's assistant steps, so partial turns still read. */
export interface RunMetrics {
  outputTokens: number;
  durationMs: number;
  tokens: MetricsTokenSource | 'mixed';
  window: MetricsWindow;
  /** How many assistant steps contributed. Zero means the turn produced no measurable output. */
  steps: number;
}
/** Recent model output speed. The rolling window selects samples; measured response time is the denominator. */
export interface OutputRate {
  state: 'no_data' | 'live' | 'zero' | 'stale';
  windowSeconds: number;
  outputTokens: number;
  tokensPerSecond: number;
  /** Measured response time represented by the sampled output. Absent on older throughput servers. */
  durationMs?: number;
  window?: MetricsWindow;
  /** Absent when the window has no token samples. */
  tokens?: MetricsTokenSource | 'mixed';
}
export type NativeSessionInput = Pick<Session, 'projectId'> & Partial<Pick<Session, 'title' | 'tags' | 'model' | 'mode' | 'approval' | 'backendId' | 'backendProfileId' | 'nativeSessionId' | 'cursorSessionId' | 'resumePicker' | 'origin' | 'terminalAppearance' | 'toolGroups' | 'extensionsOff'>>;
export interface Run {
  id: string; sessionId: string; commandId: string; prompt: string;
  state: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  native?: NativeRunDetails;
  createdAt: string; updatedAt: string; error?: string; errorRef?: TextRef;
}
export interface WorkbenchEvent {
  sequence: number; sessionId: string; runId?: string; type: string;
  data: Record<string, unknown>; raw?: unknown; createdAt: string;
}
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
/** A provider-reported context meter. `size` is a window unless `limitKind` identifies a budget. */
export interface NativeContext {
  used: number;
  size: number;
  breakdown: Array<{ id: string; label: string; tokens: number }>;
  /** Compaction usage from the latest model response, against the automatic compaction threshold. */
  limitKind?: 'compaction';
  /** Estimated category counts have their own total and must not be added to the measured usage. */
  breakdownEstimated?: boolean;
}
/**
 * A shell task of a native conversation. It may be a foreground tool call, a background shell,
 * or a task whose final result is not yet confirmed in the CLI store.
 */
export interface NativeJob {
  /** The tool call that started it: the timeline row this job belongs to. */
  toolCallId: string;
  /** The CLI's own shell id, once its launch result has been read. */
  id?: string;
  title: string;
  command: string;
  status: 'running' | 'succeeded' | 'failed' | 'unknown';
  startedAt?: string;
  runningMs?: number;
  exitCode?: number;
  /** What the agent waited for, when it awaited this job with a pattern. */
  matched?: string;
  output?: string;
  truncated?: boolean;
  outputPath?: string;
}
/**
 * Something the CLI does on its own inside a conversation: compacting the context, running a background
 * task, printing the output of a local command. It travels as a `session/update` event with
 * `sessionUpdate: 'activity'`; later states of the same `id` arrive as further events, which a client
 * applies in place at the position of the first one. See docs/SESSION-JOURNAL.md, 系统活动.
 */
export interface NativeActivity {
  /** Stable across states and restarts: `${backend}:${nativeId}`. */
  id: string;
  kind: 'compaction' | 'background_task' | 'local_command';
  status: 'running' | 'stopping' | 'completed' | 'failed' | 'stopped' | 'unknown';
  title: string;
  /** A preview of at most 2KB, without ANSI escapes or CLI tags. */
  detail?: string;
  /** The full text, fetched on demand from `GET /api/sessions/:id/blobs/:blobRef`. */
  blobRef?: string;
  /** The tool row that started it, to place it on the timeline. */
  toolCallId?: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  /** Absent when it cannot be stopped. `session` stops every background task of the conversation. */
  stop?: { via: 'protocol' | 'session' };
  compaction?: { trigger: 'manual' | 'auto'; preTokens?: number; postTokens?: number };
  /** A `background_task`'s process; on a `local_command`, the shell command the reader ran with `!` (its output is `detail`). */
  task?: { kind: 'shell' | 'monitor' | 'agent' | 'workflow' | 'terminal'; command?: string; exitCode?: number };
  /** For `local_command`: the command it printed for, without the slash. */
  command?: { name: string };
}
/**
 * What a runtime hook's sidecar shows on its conversation (docs/PLUGIN_ARCHITECTURE.md). The plugin
 * decides every word and state; clients render it as given and send an action back with `revision`.
 */
export interface NativeRuntimeControl {
  /** The plugin that owns the sidecar. */
  owner: string;
  /** Changes whenever what an action acts on changes; an action carrying an older one is refused. */
  revision: string;
  /** Shown beside the conversation's status; absent shows nothing there. */
  notice?: NativeRuntimeNotice;
  /** Entries in the conversation's more menu. */
  actions?: NativeRuntimeAction[];
}
export interface NativeRuntimeNotice {
  /** `progress` puts a spinner before the label; `danger` shows it as an error. */
  tone: 'neutral' | 'progress' | 'danger';
  label?: Record<string, string>;
  /** The full text behind the label, such as an error message. */
  detail?: string;
  action?: NativeRuntimeAction;
}
export interface NativeRuntimeAction {
  id: string;
  label: Record<string, string>;
  /** A short qualifier beside a menu entry. */
  hint?: Record<string, string>;
  disabled?: boolean;
}
export interface NativeRuntimeActionRequest { action: string; revision: string; }

/** What the CLI screen currently shows: working, waiting at its prompt, or a dialog that needs the terminal. */
export interface NativeStatus {
  /** The connected process keeps its launch settings until explicitly restarted or it exits. */
  profilePending?: boolean;
  runtimeControl?: NativeRuntimeControl;
  /** Activities in progress, independent of the main turn: whether it is compacting, and how many background tasks run. */
  activity?: { compacting: boolean; background: number };
  phase: 'offline' | 'starting' | 'busy' | 'idle' | 'attention';
  /** The active turn's event runId: an app Run id, or a provider turn id for autonomous work. */
  activeTurnId?: string;
  /** Exact provider identity for steering; absent when an active turn cannot be verified. */
  activeTurn?: NativeTurnTarget & { ownerRunId?: string };
  /** Server-sampled throughput; distinct from the persisted average of an individual turn. */
  outputRate?: OutputRate;
  /** Whether Riffet can currently use the provider session. This is separate from the CLI phase. */
  connection?: { state: 'connected' | 'disconnected' | 'reconnecting' | 'conflict' | 'failed'; message?: string; messageRef?: TextRef };
  /** Result of loading the conversation transcript, independent of the provider's execution phase. */
  history?: { state: 'loading' | 'ready' | 'error'; message?: string; messageRef?: TextRef };
  model?: string;
  permission?: string;
  /** The approval mode the CLI's footer reports, when it is one we recognise. */
  /** The provider's own permission setting, when it reports one we recognise. */
  approval?: string;
  /**
   * Whether the CLI chat store could be read. `unavailable` means the store file is missing;
   * `unparsed` that it exists but no longer decodes. Surfacing this turns a CLI format change
   * into an actionable message instead of a silently empty transcript.
   */
  transcript?: 'ok' | 'unavailable' | 'unparsed';
  /**
   * A current session-scoped explanation, cleared by its producer when its condition ends.
   * Connection/history diagnostics belong to their structured status above; completed turn
   * failures belong to the durable timeline, rather than being mirrored here.
   */
  notice?: string;
  /** Omitted by older servers; clients treat an unclassified notice as a warning. */
  noticeLevel?: 'info' | 'warning' | 'error';
  interaction?: NativeInteraction;
  /** Where the conversation's queued messages stand. Sent on the sync stream only; absent from older servers. */
  queue?: NativeQueue;
}
/**
 * Why queued messages wait: the CLI is working or showing a dialog, a stop is in progress, an earlier
 * message is still on its way in (`sending`, `steering`) or has an unconfirmed delivery (`unconfirmed`),
 * the workspace is reserved, a recovery action is running, or the next one is retrying shortly.
 */
export type NativeQueueHoldReason = 'turn_running' | 'attention' | 'stopping' | 'sending' | 'steering' | 'unconfirmed' | 'workspace' | 'recovering' | 'retrying';
/**
 * The server's own answer to "what starts next, and why not yet", so clients place a message without
 * inferring it from delivery fields: `next` is the queued run that starts first; without `held` it is
 * starting now. `held.runId` names the earlier message holding the queue, when one does.
 */
export interface NativeQueue { next?: string; held?: { reason: NativeQueueHoldReason; runId?: string } }
/** A verified, currently visible dialog belonging to one native terminal instance. */
export interface NativeInteraction {
  id: string; revision: string;
  /** `terminal` preserves Cursor's epoch/revision guard; `protocol` identifies server-mediated requests. */
  transport?: 'terminal' | 'protocol'; terminalId?: string; epoch?: number;
  requestId?: string; request?: Record<string, unknown>;
  kind: 'question' | 'permission' | 'plan' | 'confirmation' | 'choice';
  title: string; message?: string;
  options: Array<{ id: string; label: string; selected: boolean }>;
  multiple?: boolean; allowOther?: boolean; otherValue?: string; otherSelected?: boolean;
  /** Position of this question in its group, **1-based** like the counter both clients render. */
  questionIndex?: number; questionCount?: number;
  actions: Array<{ id: string; label: string; tone?: 'primary' | 'danger' }>;
  /** ISO time after which the backend stops waiting and denies the request on its own. Claude no longer sets it: its requests wait as long as the CLI does. */
  expiresAt?: string;
  /** The latest `expiresAt` that 延长 can reach; absent when the deadline cannot be moved (always, for Claude). */
  extendableUntil?: string;
}
export interface NativeInteractionResponse {
  interactionId: string; revision: string; requestId: string; action: string;
  selectedIds?: string[]; otherText?: string;
}
export interface NativeInteractionResult {
  status: 'advanced' | 'completed' | 'uncertain';
  interaction?: NativeInteraction; message?: string;
}
/** Where a client holds a transcript: its generation, and whether older rows are still to load. */
export interface NativeHistoryState { generation: string; cursor?: string; hasMore: boolean; contextIncomplete?: boolean; }
/** Native event identity includes the absolute message position, blob id, and mapped part. */
export type NativeWorkbenchEvent = WorkbenchEvent & { nativeId: string; nativeAliases?: string[]; nativeTurnId?: string };
/**
 * What a provider reports of a conversation outside its transcript, on the control path (docs/SYNC-V3.md):
 * the transcript itself reaches clients as timeline rows of `/api/v3/sessions/:id/sync`.
 */
export type NativeStreamMessage =
  | { type: 'context'; context?: NativeContext }
  /**
   * Live output-speed reporting. `runId` is the workbench Run the step belongs to, which is also
   * the identity the browser derives its turn keys from; `run` is the turn's aggregate so a client
   * never has to re-add the steps itself. Settled aggregates are also stored on the Run, which is
   * what a reload reads instead of waiting for a number that can no longer be measured.
   */
  | { type: 'metrics'; metrics: StepMetrics; run?: RunMetrics; runId?: string; nativeMessageId?: string }
  | { type: 'status'; status: NativeStatus }
  | { type: 'session'; session: Session }
  | { type: 'job'; job: NativeJob };
export interface FileEntry { path: string; name: string; kind: 'file' | 'directory'; size?: number; modifiedAt?: string; }
export interface FilePreview { path: string; content: string; hash: string; size: number; binary: boolean; truncated: boolean; image?: { mimeType: string }; render?: { kind: string }; }
export interface SearchHit { path: string; line: number; text: string; }
/** A place in a project file that code navigation points at; `line` and `column` are 1-based, `text` is the line. */
export interface CodeLocation { path: string; line: number; column: number; text: string; }
/** Where a symbol may be declared, best guess first; empty when nothing was found. */
export interface CodeDefinitions { locations: CodeLocation[]; }
/** Lines that use a symbol; `complete` is false when the search stopped at its limit or time budget. */
export interface CodeReferences { locations: CodeLocation[]; complete: boolean; }
/** `added`/`removed` count lines against HEAD; both are absent for binary or uncounted files. */
export interface GitEntry { path: string; originalPath?: string; index: string; worktree: string; added?: number; removed?: number; }
/**
 * `base` is the main line the branch can be compared with (`origin/main`, say), absent on that line
 * itself. An untracked directory with a great many files is one entry whose path ends in `/`.
 */
export interface GitStatus { branch: string; entries: GitEntry[]; root: string; added?: number; removed?: number; base?: string; }
/**
 * `version` names the two contents compared. It is present when their lines can be staged, unstaged
 * or discarded one range at a time, and has to be sent back with such a request: the request is
 * refused if either content has changed since.
 */
export interface GitDiff { path: string; before: string; after: string; patch: string; binary: boolean; truncated?: boolean; version?: string; }
/** Lines of a diff's `before` and the lines of its `after` that replace them: zero-based, end exclusive, either range may be empty. */
export interface GitLineChange { before: [number, number]; after: [number, number]; }
/** `backup` is the checkpoint saved before a discard; restoring it undoes the discard. Absent when nothing could be saved. */
export interface GitDiscardResult { status: GitStatus; backup?: Checkpoint; }
/** `runId` marks the checkpoint taken just before that turn started, which is what "undo this turn" restores. */
export interface Checkpoint {
  id: string; projectId: string; sessionId?: string; runId?: string; title: string; createdAt: string; files: number; excluded: string[];
  /** Holds only the files it lists, so restoring it leaves every other file alone. Taken before a discard. */
  partial?: boolean;
}
export interface CheckpointChange { path: string; kind: 'added' | 'modified' | 'deleted'; beforeHash?: string; afterHash?: string; }
export interface WorktreeInfo {
  path: string; branch?: string; head: string; bare?: boolean;
  /** Resolved against the checkout root, including projects opened through a symlink or subdirectory. */
  current?: boolean;
  /** Created in Riffet's managed directory or associated with a registered Riffet project. */
  managed?: boolean;
  createdAt?: string;
}
/** `upstream` is absent until the branch is first pushed; `ahead`/`behind` then count against it. */
export interface BranchInfo { branch: string; head?: string; upstream?: string; ahead: number; behind: number; remotes: string[]; }
export interface PushResult { branch: BranchInfo; output: string; }
/** A name pointing at a commit, as the history shows it. `head` is the checkout itself when it is on no branch. */
export interface GitRefLabel { kind: 'head' | 'branch' | 'remote' | 'tag'; name: string; /** The branch that is checked out. */ current?: boolean; }
export interface GitCommit { hash: string; parents: string[]; subject: string; author: string; email: string; date: string; refs: GitRefLabel[]; }
/** One page of history, newest first. `more` says an older page exists. */
export interface GitLog { commits: GitCommit[]; more: boolean; }
/** A commit's whole message and what it changed against its first parent. */
/** `filesTotal` is set when the commit changed more files than are listed. Line counts are absent from a very wide commit. */
export interface GitCommitDetail extends GitCommit { body: string; files: Array<{ path: string; originalPath?: string; status: string; added?: number; removed?: number }>; filesTotal?: number; }
export interface GitBranchRef {
  name: string; hash: string; upstream?: string; current?: boolean;
  /** Checked out in another worktree, so it cannot be switched to here. */
  elsewhere?: boolean;
}
/**
 * `head` is absent when the checkout is on no branch. `remotes` are the remote branches without a
 * local one, named with their remote as in `origin/main`; only the first few are listed, out of
 * `remoteCount`, and a search narrows them.
 */
export interface GitRefs { head?: string; branches: GitBranchRef[]; remotes: Array<{ name: string; hash: string }>; remoteCount: number; tags: Array<{ name: string; hash: string }>; }
export interface MergeResult { merged: boolean; strategy: 'merge' | 'squash'; branch: string; into: string; head?: string; commits: number; removedWorktree?: boolean; }
export type CheckState = 'pending' | 'success' | 'failure' | 'neutral' | 'skipped';
export interface PullRequestCheck { name: string; state: CheckState; url?: string; }
export interface PullRequestInfo {
  number: number; url: string; title: string; state: 'OPEN' | 'CLOSED' | 'MERGED'; isDraft: boolean;
  headRefName: string; baseRefName: string; mergeable?: string; reviewDecision?: string;
  /** `none` when the repository runs no checks on this pull request. */
  checks: { state: CheckState | 'none'; items: PullRequestCheck[] };
}
/** `pullRequest` is null when the branch has none yet. */
export interface PullRequestStatus { branch: BranchInfo; pullRequest: PullRequestInfo | null; }
/** The change of one worktree against the commit its attempt started from, committed or not. */
export interface WorktreeComparison { base: string; /** The branch `base` was found on, when the comparison chose it. */ ref?: string; head?: string; commits: number; files: Array<{ path: string; status: string; added?: number; removed?: number }>; /** Set when more files changed than are listed. */ filesTotal?: number; added: number; removed: number; }
/** A backend choice for a launch; unset fields take the backend's saved defaults, as in the composer. */
export interface LaunchTarget { backendId?: NativeBackendId; backendProfileId?: string; model?: string; mode?: string; approval?: string; }
/**
 * The opening message proposed for a handoff, for the reader to edit before it is sent. `generatedBy`
 * names the auxiliary model that wrote it; without one it was assembled from the transcript, and
 * `fallbackReason` says why when a configured model could not write it.
 */
export interface HandoffDraft { text: string; generatedBy?: AuxiliaryModelOption; fallbackReason?: string; }
/**
 * One prompt run by several backends side by side, each in a worktree cut from the same commit, so
 * the results can be compared and one of them merged back.
 */
export interface AttemptGroup {
  id: string; projectId: string; prompt: string; base: string; createdAt: string;
  attempts: Array<{ sessionId: string; projectId: string; branch: string; target: LaunchTarget; discardedAt?: string }>;
  adopted?: { sessionId: string; at: string; head?: string };
}
/** What adopting one attempt does to the others: leave them, archive their conversations, or archive and remove their worktrees. */
export type AttemptCleanup = 'keep' | 'archive' | 'remove';
export interface AttemptComparison {
  sessionId: string; projectId: string; branch: string; target: LaunchTarget;
  state?: SessionState; title?: string; comparison?: WorktreeComparison; error?: string;
}
/**
 * When an automation runs by itself. `once` fires a single time; `cron` repeats (five fields, see
 * docs/ORCHESTRATION.md §5). `timeZone` is the IANA zone of whoever set it, not the server's: cron
 * is read in it, and `{{date}}` is filled in by it.
 */
export type AutomationTrigger =
  | { kind: 'once'; at: string; timeZone?: string }
  | { kind: 'cron'; cron: string; timeZone: string };
export type AutomationRunResult = 'started' | 'skipped' | 'missed' | 'failed';
/**
 * Saved work: what to run (prompt, backend, project), when it runs by itself (`triggers`; none means
 * by hand only, what used to be a template) and where each run goes. `{{date}}` and `{{project}}`
 * in the prompt are filled in when it runs. A run whose previous conversation is still working is
 * skipped, not queued.
 */
export interface Automation extends LaunchTarget {
  id: string; name: string; prompt: string;
  /** Where runs start. Unset: chosen at each run by hand; a trigger needs one. */
  projectId?: string;
  /** Run each time in a fresh worktree of the project instead of its own checkout. */
  isolate?: boolean;
  triggers: AutomationTrigger[];
  /** `new` opens a conversation per run; `same` continues the conversation of the last run. */
  delivery: 'new' | 'same';
  /** A time passed while the server was off: `latest` runs the most recent one once (up to 7 days late), `skip` records it missed. */
  catchUp: 'latest' | 'skip';
  enabled: boolean;
  /**
   * A follow-up of one conversation: a single `once` trigger whose run is a turn in `sessionId`, never a new conversation.
   * `agent` ones come from `schedule_wakeup` and are framed as the agent's own wake-up; `user` ones
   * (send later) send `prompt` as typed. Settled follow-ups are removed after a week.
   */
  followUp?: { sessionId: string; by: 'agent' | 'user' };
  /** What a user follow-up sends besides `prompt`, as the composer gave it; references are frozen when it is scheduled. */
  input?: Omit<NativeRunInput, 'text'>;
  /** The conversation whose agent set this up (`schedule_task`). */
  createdBySessionId?: string;
  nextRunAt?: string;
  lastRunAt?: string; lastResult?: AutomationRunResult; lastError?: string; lastSessionId?: string;
  createdAt: string; updatedAt: string;
}
/** One firing of an automation; the latest 50 of each are kept. */
export interface AutomationRun {
  id: string; automationId: string;
  cause: 'schedule' | 'catch-up' | 'manual';
  /** The trigger time this run stands for; absent for a run by hand. */
  scheduledFor?: string;
  at: string;
  result: AutomationRunResult;
  /** Why it was skipped or missed: the last conversation was busy, the server was off, or the project or conversation is gone or archived. */
  reason?: 'busy' | 'offline' | 'project-unavailable' | 'session-unavailable';
  /** What a failed run failed with. */
  error?: string;
  sessionId?: string; runId?: string;
}
/** One review remark on a diff line or range, sent back to the agent as a message. */
export interface ReviewComment { path: string; line?: number; endLine?: number; body: string; quote?: string; }
export interface ConfigFile { id: string; label: string; path: string; scope: 'project' | 'user'; kind: 'rules' | 'skills' | 'commands' | 'mcp' | 'hooks' | 'cli' | 'worktrees'; exists: boolean; content?: string; hash?: string; }
export interface CommandResult { code: number | null; stdout: string; stderr: string; timedOut?: boolean; truncated?: boolean; }
export interface TailscaleCapability {
  present: boolean; loggedIn?: boolean; ip?: string; version?: string; message: string;
}
export interface CapabilityReport {
  cliPath: string; cliVersion?: string; authenticated: boolean; authMessage?: string;
  tmux: boolean; nativePersistence: string; models: string[];
  tailscale: TailscaleCapability;
  checkedAt: string; warnings: string[];
}
/** What the machine offers every Agent (`GET /api/system/machine`): tmux for their terminals, and the tailnet. Not an Agent's own fact, so it is there while any Agent plugin is off. */
export interface MachineReport { tmux: boolean; tailscale: TailscaleCapability; warnings: string[]; checkedAt: string; }
export interface ModelConfigOption { id: string; name: string; description?: string; category?: string; type: 'select'; currentValue: string; options: Array<{ value: string; name: string; description?: string }>; }
export interface NativeModelVariant { value: string; name: string; }
export interface ModelInfo {
  value: string; name: string; configOptions: ModelConfigOption[];
  /** Provider-declared identities for this model, including selectors saved before a rename. */
  aliases?: string[];
  /** Exact CLI-listed variants behind the generated controls. */
  nativeVariants?: NativeModelVariant[];
  /** Provider-declared context/input token limit; absent when the catalog declares none. */
  contextWindow?: number;
  /**
   * The catalog lists this model as its long-context variant (Claude Code's `[1m]` suffix on a
   * discovered gateway id), so the client may offer the 1M request even without a token limit.
   */
  longContext?: boolean;
}

/** One metered usage window, as the share of it already used. */
export interface UsageWindow {
  usedPercent: number;
  /** Length of the window (300 is five hours, 10080 a week); absent when the provider does not say. */
  windowMinutes?: number;
  /** ISO time the window resets. */
  resetsAt?: string;
}
/** A daily soft quota. Exhaustion lowers request priority rather than disabling the model. */
export interface ModelDailyQuota extends UsageWindow {
  remaining: number;
  limit: number;
  depleted?: boolean;
}
/** A model's live standing at its provider. Every field is absent when the provider did not report it. */
export interface ModelStatus {
  /** Load as the provider measures it; above 100 means requests wait in the provider's queue. */
  loadPercent?: number;
  /** A metered quota this model draws from; several models may share one. */
  quota?: UsageWindow & { remaining?: number; limit?: number; depleted?: boolean };
  /** Whether the provider applies the shared weekly quota; true without a snapshot means unavailable. */
  quotaLimited?: boolean;
  /** The provider's exact daily quota binding; present without dailyQuota when its read is unavailable. */
  dailyQuotaKey?: string;
  dailyQuota?: ModelDailyQuota;
}
/** What the signed-in account may still use with a backend, and how busy each of its models is. */
export interface NativeBackendUsage {
  account?: { plan?: string; windows: UsageWindow[]; credits?: { balance?: number; unlimited?: boolean }; limitReached?: boolean };
  /** Keyed by `ModelInfo.value`; provider aliases also resolve older cached catalogs. */
  models: Record<string, ModelStatus>;
  fetchedAt: string;
}

/** `shortLabel` is the name a toolbar shows when the full label would not fit beside the model. */
export interface NativeBackendOption { id: string; label: string; shortLabel?: string; description?: string; }
/** Input types one model accepts. DSH names the DeepSeek catalog field `inputModalities`. */
export type ModelInputModality = 'text' | 'image';
/** Declared input types per model id, at least one type per entry. */
export type ModelInputModalities = Record<string, ModelInputModality[]>;
/** Context window in tokens, by model id. */
export type ModelContextWindows = Record<string, number>;
/**
 * A named model source a profile can be pointed at, provided by an integration.
 *
 * Each one has a canonical endpoint and a credential the user cannot reasonably type: an SSO token
 * in another tool's cache, a JWT minted per request by a CLI, a key that lives in the environment.
 * Naming the source is what lets the server resolve it, and what tells the driver which injection
 * path to take. Sources come from plugins, so the set is open: a name nothing provides on this
 * server is kept as saved and resolves to nothing.
 */
export type NativeModelSource = string;
/** Wire API used by a custom model provider. Omitted keeps the backend's existing default. */
export const NATIVE_MODEL_API_PROTOCOLS = ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai'] as const;
export type NativeModelApiProtocol = typeof NATIVE_MODEL_API_PROTOCOLS[number];
/** Public profile metadata. Runtime secrets and provider-specific settings stay on the server. */
export interface NativeBackendProfile { id: string; backendId: NativeBackendId; name: string; description?: string; isDefault?: boolean; }
/** Safe editable profile fields. Credentials are write-only; responses report only `hasApiKey`. */
export interface NativeBackendProfileSettings extends NativeBackendProfile {
  executable?: string; configDir?: string; sourceDir?: string;
  apiEndpoint?: string; agentEndpoint?: string; disableAutoUpdate?: boolean;
  apiProtocol?: NativeModelApiProtocol;
  defaultModel?: string; hasApiKey?: boolean;
  /**
   * Model ids offered in session pickers. `undefined` means the whole catalog, so a freshly
   * configured endpoint is usable before anyone curates it; `[]` is an explicit empty selection
   * and is honoured as such. The two are not interchangeable.
   */
  enabledModels?: string[];
  /**
   * What each model accepts, for the ids a user had to answer for.
   *
   * A gateway is the only authority on the ids it serves and almost never publishes what a model
   * takes, so a human has to state it. DSH is the one consumer: an id missing from its own catalog
   * is treated as text-only, and every image is swapped for a text placeholder *before the request
   * leaves* — the transcript then shows a missing image nobody can diagnose from the app. Absent
   * entries are left to the backend's own answer, so declaring nothing changes nothing.
   */
  modelInputModalities?: ModelInputModalities;
  /**
   * Context window in tokens per model id, for the ids whose gateway does not say. Claude Code is the
   * consumer: a window is what offers a model's 1M variant and what the CLI is told to budget for. A
   * gateway's own declaration is not overridden by an absent entry, so declaring nothing changes nothing.
   */
  modelContextWindows?: ModelContextWindows;
  /**
   * Where this profile's models and credentials come from. Absent means what the profile has always
   * meant: the CLI's own login, or the `apiEndpoint` + `apiKey` the user typed. A source supplies
   * both the catalog and the credential, so `apiEndpoint` is only an override of its default
   * address, and `apiKey` only an override of its key.
   */
  modelSource?: NativeModelSource;
}
/** `null` clears a field: it drops the stored credential, or restores the uncurated full catalog. */
export type NativeBackendProfileSettingsUpdate = Partial<Omit<NativeBackendProfileSettings, 'id' | 'backendId' | 'hasApiKey' | 'isDefault' | 'enabledModels' | 'modelInputModalities' | 'modelContextWindows' | 'modelSource' | 'apiProtocol'>> & { apiKey?: string | null; enabledModels?: string[] | null; modelInputModalities?: ModelInputModalities | null; modelContextWindows?: ModelContextWindows | null; modelSource?: NativeModelSource | null; apiProtocol?: NativeModelApiProtocol | null };
export interface NativeBackendProfilesResponse { profiles: NativeBackendProfileSettings[]; defaultProfileId?: string; }
export interface NativeBackendCapabilities {
  backendId: NativeBackendId;
  label: string;
  modes: NativeBackendOption[];
  permissions: NativeBackendOption[];
  interactionTransport: 'terminal' | 'protocol' | 'both' | 'none';
  supportsResume: boolean;
  supportsInterrupt: boolean;
  /** Missing means unsupported; never fall back to interrupting or queuing. */
  supportsSteer?: boolean;
  supportsRecovery?: boolean;
  supportsTargetedStop?: boolean;
  supportsHistory: boolean;
  supportsModelSelection: boolean;
  supportsModeSelection: boolean;
  supportsPermissionSelection: boolean;
  supportsTerminal?: boolean;
  /**
   * The conversation lives in its terminal: it is live, and takes a message, only while that terminal
   * runs, and a stopped one is resumed on request. Missing means it is live while its status is not `offline`.
   */
  requiresLiveTerminal?: boolean;
  supportsPrewarm?: boolean;
  /** The backend can take a brand-new session's first user message as a launch argument. */
  supportsInitialPromptArgs?: boolean;
  slashCommands?: Array<{ name: string; description?: string; hint?: string }>;
  /**
   * A skill named mid-message (`… /name …`) is invoked, not only one that opens the message.
   * Commands only ever work as the leading token.
   */
  inlineSkills?: boolean;
  /**
   * A conversation's tool groups reach this backend: each launch is given the Riffet MCP server
   * without editing the CLI's own config. Missing means the backend runs without Riffet tools.
   */
  supportsRiffetTools?: boolean;
  /**
   * Which kinds of the user's installed extensions a conversation can switch off for itself
   * (`Session.extensionsOff`). Missing means neither.
   */
  extensionToggles?: { mcp: boolean; skills: boolean };
  /** This backend/profile can read a referenced session's materialized snapshot on the execution host. */
  supportsSessionReferences?: boolean;
  /**
   * The gateway protocols this backend's launches can be pointed at. A model source is offered to it when the source's
   * `protocols` intersect these. Missing from a server that predates it: match the source's `backends` then.
   */
  consumesProtocols?: GatewayProtocol[];
}
/** One entry of the composer's `/` menu. */
export interface NativeSlashItem {
  name: string;
  description?: string;
  hint?: string;
  /** A `command` only works as the message's first token; a `skill` may also be named mid-message. */
  kind: 'command' | 'skill';
  /** The skill's instruction file, when the provider reports one. */
  path?: string;
}
/** What `/` offers for one backend profile in one project: built-in commands plus discovered skills. */
export interface NativeSlashCatalog {
  items: NativeSlashItem[];
  inlineSkills: boolean;
  /** Set when discovery failed and only the built-in commands are listed. */
  reason?: string;
}
/**
 * How the installed CLI compares with the versions its adapter declares: `too-old` is below a
 * version known to break it, `untested` newer than any verified, `unknown` unreadable. Only a
 * check the adapter already makes refuses a version; `untested` never does.
 */
export type NativeCliVersionStatus = 'supported' | 'untested' | 'too-old' | 'unknown';
export interface NativeCliVersion {
  /** The version the CLI printed (`2.1.302`, `2026.10.01-e373342`); absent when it could not be read. */
  version?: string;
  status: NativeCliVersionStatus;
  minimum?: string;
  /** The newest version actually verified with this adapter. */
  testedThrough?: string;
}
export interface NativeBackendCatalogEntry {
  backendId: NativeBackendId;
  label: string;
  available: boolean;
  reason?: string;
  /** The Agent is installed but its account is not signed in; `reason` may say more. A client shows one generic hint for it. */
  needsLogin?: boolean;
  profiles: NativeBackendProfile[];
  capabilities: NativeBackendCapabilities;
  models: ModelInfo[];
  defaultModel?: string;
  /** The described profile's CLI version, as its availability probe read it. */
  cliVersion?: NativeCliVersion;
  /**
   * Only on a conversation's catalog: the backend's other profiles that keep conversations where this
   * one does and serve the model line it runs on (Claude, GPT…), so it continues on them in place. Each
   * lists its models of that line; picking one is a `configure` carrying both `backendProfileId` and
   * `model`. Absent when there are none, or from a server that predates it.
   */
  continuations?: NativeProfileContinuation[];
}
export interface NativeProfileContinuation { profile: NativeBackendProfile; models: ModelInfo[]; }
/**
 * One uploaded attachment. Image dimensions are captured at upload time so a transcript can size
 * its thumbnail before the bytes arrive: without them an unloaded `<img>` has no intrinsic size
 * and the message would collapse to nothing, then jump once the image decodes.
 */
export interface Attachment { id: string; name: string; mimeType: string; size: number; path: string; width?: number; height?: number; }
/** What a message's `{name}` placeholders are filled with. */
export type TextParams = Record<string, string | number>;
/**
 * Text a client words in its own language: `code` names the message in `i18n/errors/*.json`, which
 * every client's catalogs are generated from. Sits beside an older string field, which stays the
 * English fallback (or the Chinese a record stored before the field existed).
 */
export interface TextRef { code: string; params?: TextParams; }
/**
 * `message` is English, for developers and logs; clients show the text `code` names, filled with
 * `params` (docs/guide/architecture.md, 界面语言).
 */
export interface ApiError { error: { code: string; message: string; params?: TextParams; details?: unknown }; }
export interface CursorCliSettings {
  executable?: string;
  configDir?: string;
  apiEndpoint?: string;
  agentEndpoint?: string;
  disableAutoUpdate?: boolean;
  /** Read-only status of the server-saved key. */
  hasApiKey?: boolean;
}
export type CursorCliSettingsUpdate = Omit<CursorCliSettings, 'hasApiKey'> & { apiKey?: string | null; hasApiKey?: never };
export interface NativeBackendDefaults { profileId?: string; model?: string; mode?: string; approval?: string; }
export interface AppSettings {
  editorCommand?: string; defaultModel?: string; defaultMode?: string; notifications?: boolean; allowOutsideRead?: boolean; cursorCli?: CursorCliSettings;
  /** Server-side root for new task workspaces. An empty value restores the platform default. */
  taskWorkspaceRoot?: string;
  defaultBackendId?: NativeBackendId;
  nativeBackendDefaults?: Partial<Record<NativeBackendId, NativeBackendDefaults>>;
  /**
   * What Enter does in the composer, on every device signed in to this workbench: `'newline'`
   * (default) breaks the line and Cmd/Ctrl+Enter sends; `'send'` sends on Enter. Cmd/Ctrl+Enter
   * sends under both, so the setting can never leave the keyboard without a way to submit.
   */
  composerEnterBehavior?: 'newline' | 'send';
  /**
   * Where a new message goes while the agent is working. Unset means `'queue'`.
   * `'steer'` joins the current turn only when the backend exposes a live steer target;
   * otherwise the message follows the normal queue path.
   */
  composerRunningBehavior?: 'queue' | 'steer';
  /** Shows send later beside the composer's send button. Off unless set. */
  composerSendLater?: boolean;
  /**
   * Models the workbench calls itself, one per purpose, each picked from a gateway a backend profile
   * already holds credentials for, so no second key is stored. `title` names a conversation whose CLI
   * offers no title worth keeping; `handoff` condenses a conversation for the agent taking it over.
   * An unset purpose means the workbench does that job without a model, or not at all.
   */
  auxiliaryModels?: AuxiliaryModels;
  /**
   * Minutes a conversation's CLI may sit idle — no turn, nothing pending, nobody viewing it — before
   * its terminal and app-server are stopped. Reopening the conversation resumes it. Unset means
   * `DEFAULT_IDLE_RECLAIM_MINUTES`; 0 never reclaims for idleness.
   */
  idleReclaimMinutes?: number;
  /**
   * Most conversation CLIs kept running at once; past it the least recently active idle ones are
   * reclaimed first. Unset means `DEFAULT_MAX_LIVE_AGENTS`; 0 sets no limit.
   */
  maxLiveAgents?: number;
  quickChat?: QuickChatSettings;
}
export interface QuickChatSettings {
  /**
   * Days a quick chat may go without a new message before it is archived; unset means
   * `DEFAULT_QUICK_CHAT_RETENTION_DAYS`, 0 never. Pinned chats and chats holding a mark are kept.
   */
  retentionDays?: number;
  /** What a system entry (selected text, a share, a shortcut) opens: an overlay over the app in use, or the whole app. Unset is `sheet`. */
  openMode?: 'sheet' | 'page';
  /**
   * The instructions a chat can start with, offered as the chat backend's modes (`preset:<id>`).
   * `GET /api/settings` always carries the effective list; saving `null` restores the defaults.
   */
  presets?: QuickChatPreset[];
}
export interface QuickChatPreset { id: string; name: string; prompt: string }
export const DEFAULT_QUICK_CHAT_RETENTION_DAYS = 7;
export const DEFAULT_QUICK_CHAT_PRESETS: readonly QuickChatPreset[] = [
  { id: 'translate', name: '翻译', prompt: '翻译用户发来的内容：中文译成英文，其他语言译成简体中文。单个词或短语另给读音、词性和一个简短例句。只回复译文，不加评论。' },
  { id: 'explain', name: '解释', prompt: '用用户的语言简明解释用户发来的内容：先说它是什么，再说最要紧的一两点。不要开场白。' },
  { id: 'polish', name: '润色', prompt: '改写用户发来的文字，使其清楚自然，保持原有语言、意思和语气。只回复改写后的文字。' },
];
export const DEFAULT_IDLE_RECLAIM_MINUTES = 360;
export const DEFAULT_MAX_LIVE_AGENTS = 24;
/** A model behind one backend profile's gateway, as `AppSettings.auxiliaryModels` stores it. */
export interface AuxiliaryModelRef { backendId: NativeBackendId; profileId: string; model: string; }
/** One choice for an auxiliary model: a gateway model plus the profile name it is listed under. */
export interface AuxiliaryModelOption extends AuxiliaryModelRef { profileName: string; }
/** `chat` is the default model of a new quick chat; `summary` writes the one-sentence turn summaries of the canvas. */
export const AUXILIARY_MODEL_PURPOSES = ['title', 'handoff', 'chat', 'summary'] as const;
export type AuxiliaryModelPurpose = typeof AUXILIARY_MODEL_PURPOSES[number];
export type AuxiliaryModels = Partial<Record<AuxiliaryModelPurpose, AuxiliaryModelRef>>;
/** Only the purposes given change; `null` clears one. */
export type AuxiliaryModelsUpdate = Partial<Record<AuxiliaryModelPurpose, AuxiliaryModelRef | null>>;
/** Each field given replaces its own; `presets: null` restores the defaults. */
export type QuickChatSettingsUpdate = Omit<QuickChatSettings, 'presets'> & { presets?: QuickChatPreset[] | null };
export type AppSettingsUpdate = (Omit<Partial<AppSettings>, 'cursorCli' | 'auxiliaryModels' | 'quickChat'> & { cursorCli?: never; auxiliaryModels?: AuxiliaryModelsUpdate; quickChat?: QuickChatSettingsUpdate }) | { cursorCli: CursorCliSettingsUpdate };

/*
 * Usage statistics (docs/STATS.md). Every aggregate is computed on the server; clients only render.
 *
 * Filters travel as query parameters on every `/api/stats/*` endpoint: `from` and `to` (ISO
 * instants, `to` exclusive), `tz` (IANA zone the buckets are cut in), and the repeatable
 * `backend`, `model`, `project`, `profile`, plus `agentKind`, `includeArchived` and
 * `includeEstimated`. A missing `from`/`to` means the last 30 days ending now.
 */
export type StatsGranularity = 'hour' | 'day' | 'week' | 'month';
export type StatsDimension = 'backend' | 'model' | 'profile' | 'project' | 'mode' | 'tool';
export type StatsSplit = 'backend' | 'model' | 'project';
export type StatsAgentKind = 'main' | 'subagent' | 'all';
/** `totalTokens` is input + cache read + cache write + output, counting only the parts that were reported. */
export type StatsSeriesMetric = 'totalTokens' | 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'runs' | 'sessions' | 'durationMs';
export interface StatsFilter {
  from: string; to: string; tz: string;
  backends?: NativeBackendId[]; models?: string[]; projects?: string[]; profiles?: string[];
  agentKind?: StatsAgentKind; includeArchived?: boolean; includeEstimated?: boolean;
}
/**
 * Token totals. `input` is input that missed the cache, on every provider. A field is `null` when
 * no record in the aggregate reported it at all (Cursor never reports input), never when it is
 * zero. `estimatedOutput` is the part of `output` that was estimated from text rather than reported.
 */
export interface StatsTokens {
  input: number | null; cacheRead: number | null; cacheWrite: number | null;
  output: number | null; reasoning: number | null; estimatedOutput: number;
}
export interface StatsRunStates { completed: number; failed: number; cancelled: number; interrupted: number; }
/** Display identity of one group. `backendId` is set when the group belongs to a single backend. */
export interface StatsKeyInfo { key: string; label: string; backendId?: NativeBackendId; }
export interface StatsPercentiles { p50: number; p90: number; p99: number; samples: number; }
export interface StatsTotals {
  sessions: number; runs: number; states: StatsRunStates; activeDays: number;
  tokens: StatsTokens; totalTokens: number;
  toolCalls: number; subagents: number;
  /** cacheRead / (input + cacheRead) over the records that reported both; null when none did. */
  cacheHitRate: number | null;
  ttftMs: StatsPercentiles | null; durationMs: StatsPercentiles | null; outputTokensPerSecond: StatsPercentiles | null;
}
/** `previous` is the window of equal length immediately before `from`. */
export interface StatsSummary { current: StatsTotals; previous: StatsTotals; streakDays: number; }
export interface StatsSeriesPoint { start: string; values: Record<string, number>; }
export interface StatsSeries {
  metric: StatsSeriesMetric; granularity: StatsGranularity; split: StatsSplit;
  keys: StatsKeyInfo[]; points: StatsSeriesPoint[];
}
export interface StatsBreakdownRow extends StatsKeyInfo {
  /** Runs for every dimension except `tool`, where it is the number of calls. */
  count: number; sessions: number; states: StatsRunStates;
  tokens: StatsTokens; totalTokens: number; share: number;
  /** Tool dimension only: calls that reported a failure. */
  failed?: number;
  durationMs: StatsPercentiles | null; outputTokensPerSecond: StatsPercentiles | null;
}
export interface StatsBreakdown { dimension: StatsDimension; rows: StatsBreakdownRow[]; }
export interface StatsLatencyRow extends StatsKeyInfo {
  ttftMs: StatsPercentiles | null; durationMs: StatsPercentiles | null;
  queueMs: StatsPercentiles | null; outputTokensPerSecond: StatsPercentiles | null;
  /** Measurement windows that contributed to `outputTokensPerSecond`. */
  windows: MetricsWindow[];
}
export interface StatsLatency { dimension: 'backend' | 'model'; rows: StatsLatencyRow[]; }
/** `weekHour[weekday][hour]` counts runs, Monday first, in the requested zone. */
export interface StatsHeatmap {
  weekHour: number[][];
  calendar: Array<{ date: string; runs: number; totalTokens: number }>;
}
export interface StatsRunRow {
  runId: string; sessionId: string; sessionTitle: string; projectId: string; projectName: string;
  backendId: NativeBackendId; model?: string; state: Run['state']; createdAt: string;
  durationMs: number | null; ttftMs: number | null; tokens: StatsTokens; totalTokens: number; toolCalls: number;
}
export interface StatsRunsPage { rows: StatsRunRow[]; nextCursor?: string; }
/** Everything the first paint needs, so a phone makes one request. */
export interface StatsDashboard {
  filter: StatsFilter; generatedAt: string;
  summary: StatsSummary; series: StatsSeries;
  backends: StatsBreakdown; models: StatsBreakdown; tools: StatsBreakdown;
  heatmap: StatsHeatmap;
  /** Choices for the filter bar, drawn from all recorded data regardless of the current filter. */
  options: { backends: StatsKeyInfo[]; models: StatsKeyInfo[]; projects: StatsKeyInfo[]; profiles: StatsKeyInfo[] };
}
/** Frames of `GET /api/stats/stream`: a hint to refetch, carrying no data of its own. */
export type StatsStreamMessage = { type: 'stats_changed'; at: string };

/**
 * A folder bookmarked on the server, shared by every device signed in to it. Without `projectId` it
 * is a host directory for the directory pickers, home page and add-project menus, and `path` is
 * absolute and canonical (symlinks resolved). With `projectId` it belongs to that project's files
 * panel and `path` is relative to the project's root (`/`-separated, never empty, no `..`).
 */
export interface FolderFavorite {
  id: string;
  path: string;
  /** Shown instead of the folder's name when set. */
  label?: string;
  projectId?: string;
  /** Ascending; new favorites go last. */
  sort: number;
  createdAt: string;
  /** Set when a project is opened at this folder, or a client reports using it. */
  lastUsedAt?: string;
  /** Whether the folder still exists, checked when the list is read. */
  exists: boolean;
}
/** `GET /api/folder-favorites[?projectId=]` and `PUT /api/folder-favorites/order`. */
export interface FolderFavoritesResponse { favorites: FolderFavorite[]; }
/** `POST /api/folder-favorites`: idempotent, an existing favorite for the same folder is returned. */
export interface CreateFolderFavoriteRequest { path: string; label?: string; projectId?: string; }
/** `PATCH /api/folder-favorites/:id`: `label: null` clears it, `used: true` stamps `lastUsedAt`. */
export interface UpdateFolderFavoriteRequest { label?: string | null; used?: true; }
/** `PUT /api/folder-favorites/order`: the favorites of one scope, in their new order. */
export interface ReorderFolderFavoritesRequest { ids: string[]; projectId?: string; }

/** One process the service started or hosts: the server itself, the private tmux server, the CLIs in its panes. */
export interface ServiceProcess {
  pid: number; ppid: number;
  /** `server` is this Node process, `tmux` the private tmux server, `agent` a CLI in a pane, `child` anything else under them or a conversation's app-server daemon. */
  kind: 'server' | 'tmux' | 'agent' | 'child';
  /** Executable name, e.g. `node`, `tmux`, `claude`. */
  name: string;
  /** The full command line, truncated; arguments that look like secrets are masked. */
  command: string;
  /** Share of one core, as `ps` reports it. */
  cpuPercent: number;
  rssBytes: number;
  elapsedSec: number;
  /** The terminal (tmux session) and Riffet session this pane process belongs to, when known. */
  terminalId?: string; sessionId?: string; sessionTitle?: string; backendId?: NativeBackendId;
  /** Only processes in the service's own tree that are not the server itself may be stopped. */
  canTerminate: boolean;
}
/** A 10-second bucket of the service's own load. */
export interface ServiceMonitorSample {
  at: number;
  cpuPercent: number; rssBytes: number; heapUsedBytes: number;
  /** Requests that finished in the bucket, and those of them with a 5xx status. */
  requests: number; errors: number;
  /** Mean latency of the bucket's requests, 0 when there were none. */
  avgMs: number;
  loopLagMs: number; load1: number;
}
export interface ServiceRouteStat { method: string; route: string; count: number; errors: number; avgMs: number; p95Ms: number; }
/** `GET /api/system/monitor`: the running service at a glance, for the settings page. */
export interface ServiceMonitorSnapshot {
  generatedAt: string;
  process: {
    pid: number; version: string; nodeVersion: string; platform: string; arch: string;
    startedAt: string; uptimeSec: number;
    cpuPercent: number; rssBytes: number; heapUsedBytes: number; heapTotalBytes: number; externalBytes: number;
  };
  host: { hostname: string; cpuModel: string; cpuCount: number; loadAvg: [number, number, number]; totalMemBytes: number; freeMemBytes: number; uptimeSec: number };
  eventLoop: { p50Ms: number; p99Ms: number; maxMs: number; utilization: number; stalls: number; lastStallAt?: string; recentLagMs: number };
  /** Since the service started. Long-lived streams (SSE, WebSocket) are counted as connections, not requests. */
  requests: {
    total: number; inFlight: number; perMinute: number; avgMs: number; p95Ms: number;
    byStatus: { '2xx': number; '3xx': number; '4xx': number; '5xx': number };
    topRoutes: ServiceRouteStat[];
  };
  connections: { eventStreams: number; terminalSockets: number };
  terminals: { total: number; live: number };
  sessions: { total: number; running: number; waiting: number };
  /** Oldest first, at most the last 30 minutes. */
  series: ServiceMonitorSample[];
  processes: ServiceProcess[];
}

/**
 * A saved reply (收藏): a whole assistant answer, or a highlighted span inside one. See docs/MARKS.md.
 *
 * Native message ids are only as stable as their backend makes them, so a mark keeps several ways back
 * to its message (anchor) plus a copy of the text (snapshot) that stays readable when none of them work.
 */
/** `image` and `file` save something an agent showed or touched on the way: a picture, a file it read or wrote. */
export type MarkKind = 'message' | 'span' | 'image' | 'file';
export type MarkColor = 'yellow' | 'green' | 'blue' | 'red';
export interface MarkAnchor {
  /** The message's `nativeId` when the mark was made. */
  messageId: string;
  /** `nativeAliases` of that message, e.g. Claude's transcript uuid, which outlives a provider session id change. */
  aliases?: string[];
  runId?: string; nativeTurnId?: string;
  /** Event sequence, for clients that focus by sequence. */
  sequence?: number;
  /** Native history generation at the time; a different one means positional ids may have shifted. */
  generation?: string;
}
/** A W3C TextQuoteSelector over the message's rendered plain text; offsets are hints only. */
export interface MarkQuote { exact: string; prefix: string; suffix: string; start?: number; end?: number }
export interface MarkSnapshot {
  /** The whole message (or the turn's answer) as plain text, capped by the server. */
  text: string;
  sessionTitle: string;
  /** When the marked message was written. */
  at: string;
}
/** What an `image` or `file` mark saved. */
export interface MarkAsset {
  /** File name, shown on the card. */
  name: string;
  /** Where it was: a path inside the project, or absolute. Absent for an image that only ever existed inline. */
  path?: string;
  mimeType?: string;
  bytes?: number;
  /** An image's copy, kept by the server so it outlives the file and the conversation: `GET /api/marks/:id/asset`. */
  stored?: boolean;
  /** For a file: what the agent did with it, e.g. `写入` or `+12 −3`. */
  detail?: string;
}
export interface Mark {
  id: string;
  sessionId: string; projectId: string; backendId?: NativeBackendId;
  kind: MarkKind;
  anchor: MarkAnchor;
  /** Present exactly when `kind` is `span`. */
  quote?: MarkQuote;
  /** Present exactly when `kind` is `image` or `file`. */
  asset?: MarkAsset;
  snapshot: MarkSnapshot;
  note?: string;
  color?: MarkColor;
  /** `orphaned` once the message can no longer be found, including after its conversation is deleted. */
  state: 'ok' | 'orphaned';
  createdAt: string; updatedAt: string;
}
/** `POST /api/marks`. `id` is client-generated and makes the request idempotent. */
export interface MarkCreateRequest {
  id: string; sessionId: string; kind: MarkKind;
  anchor: MarkAnchor; quote?: MarkQuote;
  /** For `image`: `data` is the picture, base64, at most 10 MiB; the server keeps it. */
  asset?: Omit<MarkAsset, 'stored' | 'bytes'> & { data?: string };
  snapshot: { text: string; at: string };
  note?: string; color?: MarkColor;
}
/** `PATCH /api/marks/:id`. `null` clears a field. */
export interface MarkUpdateRequest { note?: string | null; color?: MarkColor | null }
/** `GET /api/marks` query: every filter is optional; `q` searches snapshot, quote and note. */
export interface MarkListQuery {
  sessionId?: string; projectId?: string; backendId?: NativeBackendId;
  /** One kind, or several (`kind=image&kind=file`). */
  kind?: MarkKind | MarkKind[]; state?: Mark['state']; q?: string;
  limit?: number; cursor?: string;
}
/** Newest first. */
export interface MarkListPage { marks: Mark[]; nextCursor?: string; total: number }
/** `GET /api/marks/:id/locate`: where the message is now. `found: false` also marks it orphaned. */
export type MarkLocation =
  | { found: true; mark: Mark; messageId: string; runId?: string; sequence?: number }
  | { found: false; mark: Mark };
/** `GET /api/marks/:id/prompt`: the user message that led to the marked answer; `text` is absent when it is not known. */
export interface MarkPrompt { text?: string }

// Shared HTTP contract. JSON request/response fields are kept stable across workers.
export const API = {
  projects: '/api/projects', sessions: '/api/sessions', terminals: '/api/terminals',
  capabilities: '/api/cursor/capabilities', backends: '/api/backends', settings: '/api/settings',
  stats: '/api/stats', marks: '/api/marks', themes: '/api/themes',
} as const;

export { samePromptText } from './prompt-match';

export * from './icon-pack.js';

export { satisfies, validRange } from './semver.js';
