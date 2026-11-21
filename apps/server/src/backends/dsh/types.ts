import type {
  NativeContext, NativeInteraction, NativeInteractionResponse, NativeStatus, NativeWorkbenchEvent, Project, Session,
} from '../../../../../packages/contracts/src/index.js';
import type { RunMetricsTracker } from '../../metrics/turn-metrics.js';
import type { NativeBackendHost, NativeBackendProfileConfig, NativeControlMessage } from '../types.js';
import type { DshContextBreakdown, DshContextFacts } from './context.js';

export interface DshModelInfo {
  provider: string;
  providerName: string;
  id: string;
  name: string;
  description?: string;
  reasoning?: {
    efforts: Array<{ id: string; name: string; description?: string }>;
    defaultEffort?: string;
  };
}

export interface DshSessionReadResult {
  found: boolean;
  nativeSessionId: string;
  session?: { id?: string; createdAt?: number; [key: string]: unknown };
  events: unknown[];
  start: number;
  before: number;
  total: number;
  hasMore: boolean;
  /**
   * `permission` is the live session's DSH permission preset, absent when the bridge cannot name one
   * (not live, or knob values matching no preset); `approval` is the raw policy, kept for older bridges.
   */
  status?: { status?: 'busy' | 'idle'; model?: string; provider?: string; reasoningEffort?: string; approval?: string; permission?: string };
  /** The live session's own system/tools/message composition, when the bridge could project one. */
  contextBreakdown?: DshContextBreakdown;
}

export interface PendingInteraction {
  interaction: NativeInteraction;
  resolve(value: NativeInteractionResponse): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export interface DshAttachmentInfo {
  id: string;
  name: string;
  mimeType: string;
  width?: number;
  height?: number;
}

export interface DshConversation {
  readonly workbenchSessionId: string;
  readonly nativeSessionId: string;
  session: Session;
  readonly project: Project;
  readonly profile: NativeBackendProfileConfig;
  readonly host: NativeBackendHost;
  /** The control path's listeners (`subscribe`). */
  readonly listeners: Set<(message: NativeControlMessage) => void>;
  /** Records of this conversation by identity, for what later ones need of them. */
  readonly events: Map<string, NativeWorkbenchEvent>;
  readonly interactionQueue: PendingInteraction[];
  readonly interactionRequests: Map<string, PendingInteraction>;
  status: NativeStatus;
  interaction?: NativeInteraction;
  active: boolean;
  /** DSH records of the session read so far; a poll reads on from here. */
  historyTotal: number;
  turnCommands: Map<number, string>;
  commandMap: Map<string, { runId: string; attachments?: DshAttachmentInfo[] }>;
  /** One speed tracker per run, so a turn's steps aggregate into a single published number. */
  readonly metrics: Map<string, RunMetricsTracker>;
  /** Live assistant attempts, keyed by the frame's attempt id: turn, window and streamed text. */
  readonly attempts: Map<string, DshAttempt>;
  /**
   * Turn opened by the latest durable `turn/start`. The transcript poll is what normally ties a
   * turn to its command, and a fast first response can outrun that poll, so the notification path
   * tracks it too.
   */
  activeTurn?: number;
  pump?: NodeJS.Timeout;
  pumpDelay?: number;
  /** A poll is in flight; it schedules the next one when it settles, so polls never overlap. */
  polling?: boolean;
  /**
   * Context-window occupancy, assembled only from DSH's own committed records. It stays absent
   * until the log has reported the provider's prompt accounting *and* the route's window, and a
   * conversation is bound to one native session for its whole life, so it never has to be unbound.
   */
  context?: NativeContext;
  /** Latest DSH window facts, each remembering the sequence that reported it. */
  readonly contextFacts: DshContextFacts;
  /**
   * Composition of the current surface, read off the live session by the bridge on every read: the
   * durable log carries the provider's usage but not DSH's own system/tools/message fold, so this
   * is the one context fact that cannot be recovered from a replay. Absent while the session has no
   * live projection, and dropped as soon as the bridge stops reporting one.
   */
  contextBreakdown?: DshContextBreakdown;
  /** Continuable child sessions, keyed by the parent `subagent` tool call that started them. */
  readonly subagents: Map<string, DshSubagent>;
}

/** A child session started by a `subagent` call, followed so its tool row can show its transcript. */
export interface DshSubagent {
  readonly toolCallId: string;
  readonly childId: string;
  /** Child records read so far; the next sync reads from here. */
  total: number;
  generation?: string;
  loaded: boolean;
  running: boolean;
  lastChangeAt: number;
  lastSyncAt: number;
  syncing?: Promise<void>;
}

/**
 * One streamed model attempt. DSH only names `turn` and `step` on the opening frame, so the
 * attempt id is the only handle the later chunks and the settlement share.
 */
export interface DshAttempt {
  turn: number;
  step: number;
  attemptId: string;
  /** Streamed text, exactly the concatenation of the deltas, used when no usage is reported. */
  text: string;
  /** Model-side timestamp of the first streamed chunk; zero until one arrives. */
  startedAt: number;
  /** Model-side timestamp of the most recent chunk. */
  lastAt: number;
  /**
   * Wall clock when the attempt opened. A response delivered as a single chunk has no stream
   * span to measure, so it is timed from here instead and reported over the wider window.
   */
  startedWallAt: number;
  /** True when the attempt carried non-streamed tool-call payloads whose generation preceded delivery. */
  hasUnstreamed?: boolean;
  /**
   * Provider accounting from the attempt's `usage` chunk or its committed message.
   * `inputTokens` is the cache miss; cache read and write are separate and are not subtracted.
   */
  usage?: {
    outputTokens: number;
    reasoningTokens?: number;
    inputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    model?: string;
  };
}
