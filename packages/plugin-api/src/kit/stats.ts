import type { MetricsTokenSource, MetricsWindow, NativeWorkbenchEvent } from '@riffet/contracts';

/**
 * One provider request as a backend measured it, normalised to the ledger's vocabulary.
 *
 * Every token field is optional and absent means "not reported", never zero. `inputTokens` is
 * input that missed the cache on every provider: a backend whose provider counts cached input
 * inside its input total (Codex) subtracts it before reporting.
 */
export interface UsageRecord {
  /** Backend-scoped identity of the request. Re-recording the same id replaces the earlier row. */
  stepId: string;
  /** Model that actually served the request, when the provider says so. */
  model?: string;
  agentKind?: 'main' | 'subagent';
  subagentType?: string;
  /** Step id of the parent request, for a subagent's steps. */
  parentStepId?: string;
  /** Epoch milliseconds. */
  startedAt?: number;
  endedAt?: number;
  /** Response time can be shorter than the absolute interval when tools run between requests. */
  durationMs?: number;
  nativeMessageId?: string;
  /** Native owner, when available; distinguishes independently metered child agents. */
  nativeSessionId?: string;
  inputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  tokenSource: MetricsTokenSource;
  window?: MetricsWindow;
}

/** How a record reached the ledger. */
export type UsageIngest = 'live' | 'backfill' | 'migration';

export interface UsageEntry { runId?: string; usage: UsageRecord }

/**
 * Settled usage read back from a provider's own stored transcript. `generation` identifies the
 * file state that was read, so the next pass can skip a transcript that has not changed.
 */
export interface UsageTranscript { generation: string; entries: UsageEntry[] }

/** Independent provider counters. Output includes reasoning; input excludes both cache counters. */
export interface UsageObservationTokens {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

/** A settled native turn total, rather than an individual provider request or speed sample. */
export interface UsageObservation {
  nativeSessionId: string;
  nativeTurnId: string;
  requestId: string;
  scope: 'agent-turn';
  agentKind: 'main' | 'subagent';
  parentNativeSessionId?: string;
  subagentType?: string;
  startedAt: number;
  endedAt: number;
  requestedModel?: string;
  model?: string;
  status: 'completed' | 'failed' | 'interrupted';
  usage: UsageObservationTokens;
  rawUsage?: UsageObservationTokens;
}

export interface RecordedUsageObservation extends UsageObservation {
  /** Stable across Riffet session re-imports: backend + native session + native turn. */
  id: string;
  coverage: 'complete' | 'partial' | 'conflict';
  backendId: string;
  sessionId: string;
  runId?: string;
  projectId: string;
  cwd: string;
}

/**
 * What the backends write statistics through. The ledger implements it; backends only ever see
 * this interface, and every call must be safe to repeat and must never throw into a stream.
 */
export interface StatsSink {
  /**
   * Record one settled provider request. `runId` is the workbench Run it belongs to when known;
   * the ledger attributes run-less records to the session's run active at `startedAt`/`endedAt`.
   */
  recordUsage(sessionId: string, runId: string | undefined, usage: UsageRecord, ingest?: UsageIngest): void;
  /** True only after durable storage, including observations with incomplete or conflicting counters. */
  recordObservation?(sessionId: string, runId: string | undefined, observation: UsageObservation): boolean;
  readObservations?(backendId: string): Promise<RecordedUsageObservation[]>;
  subscribeObservations?(listener: (observation: RecordedUsageObservation) => void, backendId?: string): () => void;
  /** Transcript events a backend emitted or read back; the ledger extracts tool calls from them. */
  observeEvents(sessionId: string, events: readonly NativeWorkbenchEvent[]): void;
}
