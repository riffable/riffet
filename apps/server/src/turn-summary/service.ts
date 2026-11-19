import { createHash } from 'node:crypto';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { AuxiliaryModelRef } from '../../../../packages/contracts/src/index.js';
import { auxiliaryEndpoint, type GatewayProfiles } from '../auxiliary/models.js';
import type { CompletionMetrics } from '../auxiliary/gateway.js';
import type { AuxiliaryCallRecorder } from '../auxiliary/telemetry.js';
import { requestTurnSummary, type TurnSummaryRequest } from './request.js';

/** Model calls at once; the rest wait their turn. */
const DEFAULT_CONCURRENCY = 3;
/** After a failed attempt the same turn is not tried again for this long, so a view that re-asks does not hammer a failing gateway. */
const RETRY_AFTER_MS = 30_000;

export interface TurnSource { question: string; answer: string }

export interface TurnSummaryOptions {
  /** `workbench.db`; the table is created beside the others. */
  db: DatabaseSync;
  /** The model chosen for canvas summaries, read on every use so a settings change applies at once. */
  summaryModel(): AuxiliaryModelRef | undefined;
  gatewayProfiles: GatewayProfiles;
  /** The turn's question and final answer; undefined when it has not finished, is unknown or has no answer. */
  source(sessionId: string, turn: string): Promise<TurnSource | undefined>;
  maxConcurrent?: number;
  request?: (request: TurnSummaryRequest) => Promise<string>;
  /** A deleted conversation: a summary that arrives after it is not stored. */
  deleted?(sessionId: string): boolean;
  record?: AuxiliaryCallRecorder;
}

interface Job {
  waiters: number;
  promise: Promise<string | undefined>;
  start(): void;
  skip(): void;
}

const digest = (text: string) => createHash('sha256').update(text).digest('hex');

/**
 * The one-sentence summaries the canvas shows on its answer cards (`auxiliaryModels.summary`).
 *
 * Written on demand: nothing happens until a client asks for a turn, so the cost follows what a reader
 * looks at. A summary is kept per (conversation, turn) with a hash of the answer it was written from,
 * so it survives a restart and a turn whose answer changed is written again. The model that wrote it
 * is not part of the key: choosing another model leaves what exists alone.
 *
 * Asks for the same turn share one model call, which a caller giving up does not cancel — another may
 * be waiting, and the result is kept either way. Only a call that has not started is dropped, when no
 * caller is left to want it.
 */
export class TurnSummaryService {
  private readonly statements = new Map<string, StatementSync>();
  private readonly inflight = new Map<string, Job>();
  private readonly queue: Job[] = [];
  private readonly failed = new Map<string, number>();
  private running = 0;
  private closed = false;
  private readonly abortController = new AbortController();

  constructor(private readonly options: TurnSummaryOptions) {
    options.db.exec(`CREATE TABLE IF NOT EXISTS turn_summaries (
      session_id TEXT NOT NULL, turn TEXT NOT NULL, answer_hash TEXT NOT NULL, summary TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY (session_id, turn));`);
  }

  /** Whether a model is chosen; without one nothing is read or written. */
  enabled(): boolean {
    return Boolean(this.options.summaryModel());
  }

  /**
   * The turn's summary, from the store or written now. Undefined when no model is chosen, the turn has no
   * finished answer, or writing failed. Rejects with an `AbortError` when `signal` aborts first.
   */
  async get(sessionId: string, turn: string, signal?: AbortSignal): Promise<string | undefined> {
    if (this.closed || !this.options.summaryModel()) return undefined;
    signal?.throwIfAborted();
    const source = await this.options.source(sessionId, turn);
    signal?.throwIfAborted();
    if (!source || this.closed) return undefined;
    const hash = digest(source.answer);
    const stored = this.sql('SELECT answer_hash,summary FROM turn_summaries WHERE session_id=? AND turn=?').get(sessionId, turn) as { answer_hash: string; summary: string } | undefined;
    if (stored?.answer_hash === hash) return stored.summary;
    const key = `${sessionId}\n${turn}\n${hash}`;
    const retryAt = this.failed.get(key);
    if (retryAt !== undefined && Date.now() < retryAt) return undefined;
    const job = this.inflight.get(key) ?? this.enqueue(key, sessionId, turn, hash, source);
    const result = this.wait(job, signal);
    // After the caller is counted: a call nobody waits for is dropped rather than started.
    this.next();
    return await result;
  }

  close(): void {
    this.closed = true;
    this.abortController.abort();
    for (const job of this.queue.splice(0)) job.skip();
  }

  private enqueue(key: string, sessionId: string, turn: string, hash: string, source: TurnSource): Job {
    let begin!: () => void;
    let skip!: () => void;
    const started = new Promise<boolean>(resolve => { begin = () => resolve(true); skip = () => resolve(false); });
    const job: Job = {
      waiters: 0,
      start: begin,
      skip,
      promise: started.then(async go => {
        if (!go) return undefined;
        try {
          const summary = await this.write(sessionId, turn, hash, source);
          this.failed.delete(key);
          return summary;
        } catch {
          const now = Date.now();
          for (const [other, until] of this.failed) if (until <= now) this.failed.delete(other);
          this.failed.set(key, now + RETRY_AFTER_MS);
          return undefined;
        } finally {
          this.running -= 1;
          this.next();
        }
      }).finally(() => { if (this.inflight.get(key) === job) this.inflight.delete(key); }),
    };
    this.inflight.set(key, job);
    this.queue.push(job);
    return job;
  }

  /** Starts queued calls up to the limit, skipping ones nobody waits for any more. */
  private next(): void {
    const limit = this.options.maxConcurrent ?? DEFAULT_CONCURRENCY;
    while (!this.closed && this.running < limit && this.queue.length) {
      const job = this.queue.shift()!;
      if (job.waiters > 0) { this.running += 1; job.start(); } else job.skip();
    }
  }

  /** A deleted conversation's summaries. */
  forget(sessionId: string): void { this.sql('DELETE FROM turn_summaries WHERE session_id=?').run(sessionId); }

  private async write(sessionId: string, turn: string, hash: string, source: TurnSource): Promise<string> {
    const ref = this.options.summaryModel();
    if (!ref) throw new Error('no summary model');
    const authStartedAt = Date.now();
    const { profileName: _name, ...endpoint } = await auxiliaryEndpoint(ref, this.options.gatewayProfiles, this.abortController.signal);
    const authMs = Math.max(0, Date.now() - authStartedAt);
    let metrics: CompletionMetrics | undefined;
    const startedAt = Date.now();
    let summary: string;
    try {
      summary = await (this.options.request ?? requestTurnSummary)({
        ...endpoint, question: source.question, answer: source.answer, signal: this.abortController.signal,
        onMetrics: recorded => { metrics = recorded; },
      });
      this.options.record?.({
        kind: 'summary', preset: 'short', source: 'live',
        backendId: ref.backendId, profileId: ref.profileId, model: ref.model,
        transport: (endpoint.executeComplete || endpoint.executeStreamChat) ? 'cli-process' : 'http',
        protocol: endpoint.protocol,
        ok: metrics?.ok ?? true, authMs, ttftMs: metrics?.ttftMs ?? null,
        durationMs: metrics?.durationMs ?? Math.max(0, Date.now() - startedAt),
        inputTokens: metrics?.inputTokens ?? null, outputTokens: metrics?.outputTokens ?? null,
        reasoningTokens: metrics?.reasoningTokens ?? null, reasoningChars: metrics?.reasoningChars ?? 0,
        thinkingDetected: metrics?.thinkingDetected ?? false, streaming: metrics?.streaming ?? false,
      });
    } catch (error) {
      if (!this.abortController.signal.aborted) {
        this.options.record?.({
          kind: 'summary', preset: 'short', source: 'live',
          backendId: ref.backendId, profileId: ref.profileId, model: ref.model,
          transport: (endpoint.executeComplete || endpoint.executeStreamChat) ? 'cli-process' : 'http',
          protocol: endpoint.protocol,
          ok: false, authMs, ttftMs: metrics?.ttftMs ?? null,
          durationMs: metrics?.durationMs ?? Math.max(0, Date.now() - startedAt),
          inputTokens: metrics?.inputTokens ?? null, outputTokens: metrics?.outputTokens ?? null,
          reasoningTokens: metrics?.reasoningTokens ?? null, reasoningChars: metrics?.reasoningChars ?? 0,
          thinkingDetected: metrics?.thinkingDetected ?? false, streaming: metrics?.streaming ?? false,
          errorCode: metrics?.errorCode ?? 'ERROR',
        });
      }
      throw error;
    }
    if (!this.closed && !this.options.deleted?.(sessionId)) {
      this.sql(`INSERT INTO turn_summaries(session_id,turn,answer_hash,summary,created_at) VALUES(?,?,?,?,?)
        ON CONFLICT(session_id,turn) DO UPDATE SET answer_hash=excluded.answer_hash, summary=excluded.summary, created_at=excluded.created_at`)
        .run(sessionId, turn, hash, summary, new Date().toISOString());
    }
    return summary;
  }

  /** Waits for the job on behalf of one caller; a caller that aborts stops waiting, the job goes on for the others. */
  private wait(job: Job, signal: AbortSignal | undefined): Promise<string | undefined> {
    job.waiters += 1;
    const release = () => { job.waiters -= 1; };
    if (!signal) return job.promise.finally(release);
    return new Promise<string | undefined>((resolve, reject) => {
      const abort = () => { release(); reject(signal.reason ?? new DOMException('Aborted', 'AbortError')); };
      if (signal.aborted) return abort();
      signal.addEventListener('abort', abort, { once: true });
      // The job's promise never rejects: a failed write resolves to undefined.
      void job.promise.then(value => { signal.removeEventListener('abort', abort); if (!signal.aborted) { release(); resolve(value); } });
    });
  }

  private sql(text: string): StatementSync {
    let statement = this.statements.get(text);
    if (!statement) this.statements.set(text, statement = this.options.db.prepare(text));
    return statement;
  }
}
