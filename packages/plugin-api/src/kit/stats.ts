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
  /** Transcript events a backend emitted or read back; the ledger extracts tool calls from them. */
  observeEvents(sessionId: string, events: readonly NativeWorkbenchEvent[]): void;
}
