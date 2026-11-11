import type { NativeInteraction, NativeWorkbenchEvent } from '../../../../../packages/contracts/src/index.js';
import type { JsonRpcServerRequest } from '../shared/codex-app-server.js';

export type TerminalEndpointState = 'absent' | 'verified' | 'changed' | 'unknown';

export interface CodexPendingInteraction {
  request: JsonRpcServerRequest;
  interaction: NativeInteraction;
  currentQuestion: number;
  revisionCounter: number;
  answers: Record<string, { answers: string[] }>;
  candidateSent: boolean;
  candidateResponse?: { requestId: string; fingerprint: string };
  resolve?(value: unknown): void;
  /** Called once the provider reports the request settled, however it was answered. */
  onSettled?(): void;
}

export interface TurnRun {
  runId?: string;
  commandId?: string;
  createdAt: string;
}

export interface RpcThread {
  id: string;
  cwd?: string;
  status?: { type?: string };
  turns?: RpcTurn[];
  model?: string | null;
  name?: string | null;
  /** Present on a thread the shared app-server spawned as a subagent. */
  parentThreadId?: string | null;
  agentNickname?: string | null;
  agentRole?: string | null;
  /** Absolute rollout path, when the provider reports it. */
  path?: string | null;
}

export interface RpcTurn {
  id: string;
  status?: string | { type?: string };
  error?: unknown;
  startedAt?: number | null;
  completedAt?: number | null;
  items?: RpcItem[];
}

export interface RpcItem {
  type: string;
  id?: string;
  [key: string]: unknown;
}

export interface RpcQuestion {
  id?: string;
  header?: string;
  question?: string;
  isOther?: boolean;
  isSecret?: boolean;
  multiSelect?: boolean;
  options?: Array<{ label?: string; description?: string }> | null;
}

/**
 * A subagent thread followed so the `collabAgentToolCall` that spawned it can open it.
 *
 * The app-server names the child in the spawn item's `receiverThreadIds`, so its transcript is read
 * with the same `thread/turns/list` paging the parent uses — no screen reading, no rollout file.
 */
export interface CodexSubagentWatch {
  readonly toolCallId: string;
  readonly childId: string;
  subagentType?: string;
  /** The task's name and instructions from its spawn call, kept if the parent row is paged away. */
  taskTitle?: string;
  /** A spawn call's description outranks an activity path used as a task-name fallback. */
  taskTitlePriority?: 1 | 2;
  prompt?: string;
  /** The child thread's actual model, or the explicit spawn override while it is unresolved. */
  model?: string;
  /** A reported child-thread model outranks an explicit spawn override. */
  modelPriority?: 1 | 2;
  title?: string;
  /** The parent's last known `agentsStates` entry for this child. */
  agentStatus?: string;
  events: NativeWorkbenchEvent[];
  /** Identity of the last child event handed to listeners, for the next delta. */
  sentTailId?: string;
  /** The child's newest turn read so far, the boundary a live claim of new work must pass. */
  lastTurnId?: string;
  /** A live terminal's execution boundary; `pending` also binds the claimed turn not yet read. */
  settledTurn?: { id?: string; pending?: boolean };
  /**
   * A live collaboration call that claimed new work before the child's own turn was readable.
   * `known` says whether the tracker had read this child's history when the claim arrived, so an
   * empty history is a real boundary rather than a transcript that simply has not been read.
   */
  awaiting?: { turnId?: string; known: boolean; since: number };
  /** The last live collaboration call registered, so its started and completed copies are one claim. */
  lastClaimId?: string;
  /** Live running/terminal signals seen, so a read that began before one cannot settle the watch. */
  signalRevision?: number;
  loaded: boolean;
  metadataLoaded?: boolean;
  running: boolean;
  lastSyncAt: number;
  syncing?: Promise<void>;
}

/**
 * What the speed meter learns from one Codex turn's streaming notifications.
 *
 * `tokenUsage.last` describes one provider request, while the change in `total` supplies the turn's
 * token count. Request spans are measured separately so tools and approvals do not become model
 * generation time. Reasoning and visible answers can belong to the same request span.
 */
export interface CodexTurnMeter {
  runId?: string;
  text: string;
  nativeMessageId?: string;
  requestStartAt?: number;
  waiting?: boolean;
  activeWaits: Set<string>;
  requestAccounted?: boolean;
  pendingUsageInterval?: boolean;
  accountedTextLength?: number;
  unstreamedTokens?: number;
  request?: { start?: number; firstDeltaAt?: number; lastDeltaAt?: number; completedAt?: number; unstreamedStartAt?: number; streamedTypes?: Set<string> };
  durationMs: number;
  startedAt?: number;
  endedAt?: number;
  observed?: boolean;
  streamedItems: Set<string>;
  completedItems: Set<string>;
  /** Which reasoning channel this turn streams, so raw and summarized reasoning are not both counted. */
  reasoningChannel?: 'summary' | 'raw';
  /** Model that served this turn, when the thread or the usage notice named one. */
  model?: string;
  /**
   * Provider accounting for the turn. `inputTokens` is already uncached: Codex's own input total
   * includes the cached portion, and that portion is moved to `cacheReadTokens`. Codex does not
   * report cache writes, so that field is left absent.
   */
  usage?: { outputTokens: number; reasoningTokens?: number; inputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number };
}
