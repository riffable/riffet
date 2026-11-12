import type { NativeBackendId } from './agent-ids.js';
import type { ToolGroupId } from './devices.js';
import type { MarkAnchor, MarkQuote } from './marks.js';
import type { TextParams } from './settings.js';
import type { TerminalAppearance } from './terminal.js';

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
