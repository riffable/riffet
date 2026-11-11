import type { NativeStreamMessage, NativeWorkbenchEvent, Run, RunMetrics, StepMetrics } from '../../../../packages/contracts/src/index.js';
import type { Store } from '../store.js';
import { ensureStatsSchema, type RunFactRow, type ToolCallRow, type UsageStepRow } from './schema.js';
import type { StatsSink, UsageEntry, UsageIngest, UsageRecord } from './types.js';

const TERMINAL_STATES = new Set<Run['state']>(['completed', 'failed', 'cancelled', 'interrupted']);
const MIGRATION_MARKER = 'stats-migration-v1';
/** How long after a run settles its provider may still report usage for it. */
const RUN_SETTLE_GRACE_MS = 120_000;

const epoch = (iso: string | undefined): number | undefined => {
  const value = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(value) ? value : undefined;
};
/** A token count, or null for anything that is not a finite non-negative number. */
const tokens = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
const instant = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : undefined;
const span = (start: number | undefined, end: number | undefined): number | null => start !== undefined && end !== undefined && end >= start ? Math.round(end - start) : null;
const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value : undefined;

function sum(rows: readonly UsageStepRow[], pick: (row: UsageStepRow) => number | null): number | null {
  let total = 0;
  let reported = false;
  for (const row of rows) {
    const value = pick(row);
    if (value === null) continue;
    total += value;
    reported = true;
  }
  return reported ? total : null;
}

function mostCommon(values: ReadonlyArray<string | null>): string | null {
  const counts = new Map<string, number>();
  for (const value of values) if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best: string | null = null;
  let bestCount = 0;
  for (const [value, count] of counts) if (count > bestCount) { best = value; bestCount = count; }
  return best;
}

/**
 * The statistics ledger (docs/STATS.md §3). Backends write provider requests and transcript events
 * into it through {@link StatsSink}; run summaries are derived whenever a run settles. Every public
 * method swallows its own failures: statistics must never break a stream or a run transition.
 */
export class StatsLedger implements StatsSink {
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribeRuns: () => void;
  private notifyTimer: ReturnType<typeof setTimeout> | undefined;
  private lastNotifyAt = Number.NEGATIVE_INFINITY;
  private closed = false;

  constructor(private readonly store: Store, private readonly options: { notifyMs?: number; now?: () => number } = {}) {
    try { ensureStatsSchema(store.db); } catch (error) { console.error('[riffet] stats schema setup failed; statistics stay unavailable until the next start:', error); }
    this.unsubscribeRuns = store.onRunChanged(run => { if (TERMINAL_STATES.has(run.state)) this.refreshRun(run.id); });
    this.migrate();
  }

  recordUsage(sessionId: string, runId: string | undefined, usage: UsageRecord, ingest: UsageIngest = 'live'): void {
    try {
      const result = this.store.transaction(() => this.writeUsage(sessionId, runId, usage, ingest));
      if (!result) return;
      if (result.runId) this.refreshRun(result.runId);
      this.changed();
    } catch { /* statistics are best-effort */ }
  }

  /** One transcript's worth of steps in a single transaction; returns how many rows were written. */
  recordUsageBatch(sessionId: string, entries: readonly UsageEntry[], ingest: UsageIngest): number {
    try {
      const owners = new Set<string>();
      let written = 0;
      this.store.transaction(() => {
        for (const entry of entries) {
          const result = this.writeUsage(sessionId, entry.runId, entry.usage, ingest);
          if (!result) continue;
          written += 1;
          if (result.runId) owners.add(result.runId);
        }
      });
      for (const owner of owners) this.refreshRun(owner);
      if (written) this.changed();
      return written;
    } catch { return 0; }
  }

  observeEvents(sessionId: string, events: readonly NativeWorkbenchEvent[]): void {
    try {
      const calls = events.filter(event => event.type === 'tool_call' || event.type === 'tool_call_update');
      if (!calls.length) return;
      const touched = new Set<string>();
      let changed = false;
      this.store.transaction(() => {
        const session = this.store.getSession(sessionId);
        const backendId = session.backendId;
        const select = this.store.db.prepare('SELECT * FROM tool_calls WHERE session_id=? AND tool_call_id=?');
        const upsert = this.store.db.prepare(`INSERT INTO tool_calls(session_id,tool_call_id,run_id,backend_id,tool_name,failed,at) VALUES(?,?,?,?,?,?,?)
          ON CONFLICT(session_id,tool_call_id) DO UPDATE SET run_id=excluded.run_id,backend_id=excluded.backend_id,tool_name=excluded.tool_name,failed=excluded.failed,at=excluded.at`);
        for (const event of calls) {
          const data = (event.data ?? {}) as Record<string, unknown>;
          const toolCallId = text(data.toolCallId);
          if (!toolCallId) continue;
          const existing = select.get(sessionId, toolCallId) as ToolCallRow | undefined;
          const toolName = text(data.toolName) ?? existing?.tool_name ?? text(data.title) ?? 'unknown';
          const failed: 0 | 1 = existing?.failed === 1 || data.status === 'failed' ? 1 : 0;
          const seen = epoch(event.createdAt) ?? this.now();
          const at = existing ? Math.min(existing.at, seen) : seen;
          const runId = existing?.run_id ?? this.resolveRun(sessionId, event.runId, at)?.id ?? null;
          if (existing && existing.tool_name === toolName && existing.failed === failed && existing.at === at && existing.run_id === runId) continue;
          upsert.run(sessionId, toolCallId, runId, backendId, toolName, failed, at);
          changed = true;
          if (runId) touched.add(runId);
        }
      });
      for (const runId of touched) this.refreshRun(runId);
      if (changed) this.changed();
    } catch { /* statistics are best-effort */ }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Recompute one run's summary. A run that has not settled has no summary yet. */
  refreshRun(runId: string): void {
    try {
      if (this.writeRunFacts(runId)) this.changed();
    } catch { /* statistics are best-effort */ }
  }

  getCursor(sessionId: string): { generation?: string; position?: string } | undefined {
    try {
      const row = this.store.db.prepare('SELECT generation,position FROM stats_cursor WHERE session_id=?').get(sessionId) as { generation: string | null; position: string | null } | undefined;
      if (!row) return undefined;
      return { ...(row.generation ? { generation: row.generation } : {}), ...(row.position ? { position: row.position } : {}) };
    } catch {
      return undefined;
    }
  }

  setCursor(sessionId: string, cursor: { generation?: string; position?: string }): void {
    try {
      this.store.db.prepare(`INSERT INTO stats_cursor(session_id,generation,position,updated_at) VALUES(?,?,?,?)
        ON CONFLICT(session_id) DO UPDATE SET generation=excluded.generation,position=excluded.position,updated_at=excluded.updated_at`)
        .run(sessionId, cursor.generation ?? null, cursor.position ?? null, this.now());
    } catch { /* statistics are best-effort */ }
  }

  /**
   * The measured main-agent turns of a session, one per native receipt, including turns typed in the
   * CLI that have no Run; a turn a Run owns carries its id and the Run's stored aggregate. A sync
   * stream sends these after its `hello`, so a reopened conversation shows every turn's speed.
   */
  sessionMetrics(sessionId: string): Extract<NativeStreamMessage, { type: 'metrics' }>[] {
    try {
      const rows = this.store.db.prepare(`SELECT * FROM usage_steps WHERE session_id=? AND agent_kind='main'
        AND native_message_id IS NOT NULL AND output_tokens IS NOT NULL
        AND COALESCE(duration_ms,ended_at-started_at)>0 AND window IN ('stream','transcript','observed') ORDER BY at`).all(sessionId) as unknown as UsageStepRow[];
      const turns = new Map<string, { metrics: StepMetrics; run: RunMetrics }>();
      for (const row of rows) {
        const id = row.native_message_id!;
        const durationMs = row.duration_ms ?? row.ended_at! - row.started_at!;
        const window = row.window as StepMetrics['window'];
        const existing = turns.get(id);
        if (existing) {
          existing.run.outputTokens += row.output_tokens!;
          existing.run.durationMs += durationMs;
          existing.run.steps++;
          if (existing.run.tokens !== row.token_source) existing.run.tokens = 'mixed';
          existing.run.window = existing.run.window === 'observed' || window === 'observed' ? 'observed'
            : existing.run.window === 'transcript' || window === 'transcript' ? 'transcript' : 'stream';
        } else {
          turns.set(id, {
            metrics: { stepId: row.step_key, outputTokens: row.output_tokens!, durationMs, tokens: row.token_source,
              ...(row.started_at === null ? {} : { startedAt: row.started_at }), ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
              window, live: false },
            run: { outputTokens: row.output_tokens!, durationMs, tokens: row.token_source, window, steps: 1 },
          });
        }
      }
      return [...turns].map(([nativeMessageId, aggregate]) => {
        const matched = this.store.findRunByNativeMessage(sessionId, nativeMessageId);
        const owner = matched ? this.executionOwner(matched) : undefined;
        return { type: 'metrics', nativeMessageId, ...aggregate, run: owner?.native?.metrics ?? aggregate.run,
          ...(owner ? { runId: owner.id } : {}) };
      });
    } catch { return []; }
  }

  close(): void {
    this.closed = true;
    this.unsubscribeRuns();
    this.listeners.clear();
    if (this.notifyTimer) clearTimeout(this.notifyTimer);
    this.notifyTimer = undefined;
  }

  /**
   * Writes one step and returns the run it was attributed to, or nothing when no row was written.
   * Throws; callers decide how to fail.
   */
  private writeUsage(sessionId: string, runId: string | undefined, usage: UsageRecord, ingest: UsageIngest): { runId?: string } | undefined {
    if (!usage || typeof usage.stepId !== 'string' || !usage.stepId) return undefined;
    const session = this.store.getSession(sessionId);
    const backendId = session.backendId;
    const startedAt = instant(usage.startedAt);
    const endedAt = instant(usage.endedAt);
    const nativeMessageId = text(usage.nativeMessageId);
    const run = this.resolveRun(sessionId, runId, startedAt ?? endedAt ?? this.now(), nativeMessageId, usage.agentKind === 'subagent');
    const at = startedAt ?? endedAt ?? epoch(run?.createdAt) ?? this.now();
    const key = (stepId: string) => `${backendId}:${sessionId}:${stepId}`;
    if (ingest === 'backfill') {
      // A live row was measured while it happened; a transcript read afterwards only knows less.
      const existing = this.store.db.prepare('SELECT ingest,native_message_id,run_id FROM usage_steps WHERE step_key=?')
        .get(key(usage.stepId)) as { ingest: UsageIngest; native_message_id: string | null; run_id: string | null } | undefined;
      if (existing?.ingest === 'live') {
        // Older live measurements retain their better timing/counts, but a newly read exact
        // receipt can fill identity fields that did not exist before the metrics migration.
        if (!existing.native_message_id && nativeMessageId) {
          const matched = this.store.findRunByNativeMessage(sessionId, nativeMessageId);
          const owner = matched ? this.executionOwner(matched) : undefined;
          this.store.db.prepare('UPDATE usage_steps SET native_message_id=?,run_id=COALESCE(run_id,?) WHERE step_key=?')
            .run(nativeMessageId, owner?.id ?? null, key(usage.stepId));
          return owner ? { runId: owner.id } : {};
        }
        return undefined;
      }
    }
    const model = text(usage.model) ?? text(run?.native?.resolvedConfig?.model) ?? text(run?.native?.config.model) ?? text(session.model) ?? null;
    // A row that already says the same is left alone and reported as unwritten, so a caller that hands
    // over the same step again (a transcript re-read, a backfill pass) costs a lookup, not a write and
    // a run summary rebuild.
    const { changes } = this.store.db.prepare(`INSERT INTO usage_steps(step_key,session_id,run_id,project_id,backend_id,profile_id,model,requested_model,agent_kind,subagent_type,parent_step_key,
        started_at,ended_at,duration_ms,native_message_id,at,input_tokens,cache_read_tokens,cache_write_tokens,output_tokens,reasoning_tokens,token_source,window,ingest)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(step_key) DO UPDATE SET run_id=excluded.run_id,project_id=excluded.project_id,backend_id=excluded.backend_id,profile_id=excluded.profile_id,
        model=excluded.model,requested_model=excluded.requested_model,agent_kind=excluded.agent_kind,subagent_type=excluded.subagent_type,parent_step_key=excluded.parent_step_key,
        started_at=excluded.started_at,ended_at=excluded.ended_at,duration_ms=excluded.duration_ms,native_message_id=excluded.native_message_id,
        at=excluded.at,input_tokens=excluded.input_tokens,cache_read_tokens=excluded.cache_read_tokens,
        cache_write_tokens=excluded.cache_write_tokens,output_tokens=excluded.output_tokens,reasoning_tokens=excluded.reasoning_tokens,token_source=excluded.token_source,
        window=excluded.window,ingest=excluded.ingest
      WHERE (usage_steps.run_id,usage_steps.project_id,usage_steps.backend_id,usage_steps.profile_id,usage_steps.model,usage_steps.requested_model,
          usage_steps.agent_kind,usage_steps.subagent_type,usage_steps.parent_step_key,usage_steps.started_at,usage_steps.ended_at,usage_steps.duration_ms,
          usage_steps.native_message_id,usage_steps.at,usage_steps.input_tokens,usage_steps.cache_read_tokens,usage_steps.cache_write_tokens,
          usage_steps.output_tokens,usage_steps.reasoning_tokens,usage_steps.token_source,usage_steps.window,usage_steps.ingest)
        IS NOT (excluded.run_id,excluded.project_id,excluded.backend_id,excluded.profile_id,excluded.model,excluded.requested_model,
          excluded.agent_kind,excluded.subagent_type,excluded.parent_step_key,excluded.started_at,excluded.ended_at,excluded.duration_ms,
          excluded.native_message_id,excluded.at,excluded.input_tokens,excluded.cache_read_tokens,excluded.cache_write_tokens,
          excluded.output_tokens,excluded.reasoning_tokens,excluded.token_source,excluded.window,excluded.ingest)`).run(
      key(usage.stepId), sessionId, run?.id ?? null, session.projectId, backendId, session.backendProfileId ?? null,
      model, text(run?.native?.config.model) ?? null, usage.agentKind === 'subagent' ? 'subagent' : 'main', text(usage.subagentType) ?? null,
      usage.parentStepId ? key(usage.parentStepId) : null,
      startedAt ?? null, endedAt ?? null,
      typeof usage.durationMs === 'number' && Number.isFinite(usage.durationMs) && usage.durationMs > 0 ? usage.durationMs : span(startedAt, endedAt),
      text(usage.nativeMessageId) ?? null, at,
      tokens(usage.inputTokens), tokens(usage.cacheReadTokens), tokens(usage.cacheWriteTokens), tokens(usage.outputTokens), tokens(usage.reasoningTokens),
      usage.tokenSource === 'estimated' ? 'estimated' : 'provider', usage.window ?? null, ingest,
    );
    if (!changes) return undefined;
    // A run-level migration row only stands in until real steps arrive; keeping both would count the turn twice.
    if (ingest !== 'migration' && run) this.store.db.prepare('DELETE FROM usage_steps WHERE step_key=?').run(key(`migration:${run.id}`));
    return run ? { runId: run.id } : {};
  }

  /** Writes a settled run's summary; returns whether the stored row changed. Throws. */
  private writeRunFacts(runId: string): boolean {
    const run = this.store.getRun(runId);
    if (run.native?.intent === 'steer') return this.store.db.prepare('DELETE FROM run_facts WHERE run_id=?').run(runId).changes > 0;
    if (!TERMINAL_STATES.has(run.state)) return false;
    const session = this.store.getSession(run.sessionId);
    const db = this.store.db;
    const steps = db.prepare('SELECT * FROM usage_steps WHERE run_id=?').all(runId) as unknown as UsageStepRow[];
    const toolCalls = (db.prepare('SELECT COUNT(*) AS total FROM tool_calls WHERE run_id=?').get(runId) as { total: number }).total;
    const timings = run.native?.timings ?? {};
    const createdAt = epoch(run.createdAt) ?? this.now();
    const inputSentAt = instant(timings.inputSentAt);
    let measured = 0;
    let measuredAny = false;
    let speedTokens = 0;
    let speedEstimatedTokens = 0;
    for (const step of steps) {
      if (step.agent_kind !== 'main' || step.output_tokens === null) continue;
      const duration = step.duration_ms ?? span(step.started_at ?? undefined, step.ended_at ?? undefined);
      if (duration && duration > 0) {
        measured += duration; measuredAny = true;
        speedTokens += step.output_tokens;
        if (step.token_source === 'estimated') speedEstimatedTokens += step.output_tokens;
      }
    }
    const windows = [...new Set(steps.map(step => step.window).filter((value): value is string => Boolean(value)))].sort();
    const row: RunFactRow = {
      run_id: run.id, session_id: run.sessionId, project_id: session.projectId, backend_id: session.backendId,
      profile_id: session.backendProfileId ?? null,
      model_requested: text(run.native?.config.model) ?? null,
      model_resolved: text(run.native?.resolvedConfig?.model) ?? mostCommon(steps.filter(step => step.agent_kind === 'main').map(step => step.model)) ?? null,
      mode: text(run.native?.config.mode) ?? text(session.mode) ?? null,
      approval: text(run.native?.config.approval) ?? null,
      state: run.state as RunFactRow['state'], delivery: run.native?.delivery ?? null,
      created_at: createdAt,
      queue_ms: span(createdAt, instant(timings.dispatchAt)),
      ttft_ms: span(inputSentAt, instant(timings.firstOutputAt)),
      duration_ms: span(inputSentAt, instant(timings.completedAt) ?? instant(timings.interruptedAt)),
      input_tokens: sum(steps, step => step.input_tokens),
      cache_read_tokens: sum(steps, step => step.cache_read_tokens),
      cache_write_tokens: sum(steps, step => step.cache_write_tokens),
      output_tokens: sum(steps, step => step.output_tokens),
      reasoning_tokens: sum(steps, step => step.reasoning_tokens),
      estimated_output_tokens: sum(steps.filter(step => step.token_source === 'estimated'), step => step.output_tokens) ?? 0,
      measured_ms: measuredAny ? measured : null,
      speed_output_tokens: measuredAny ? speedTokens : null,
      speed_estimated_output_tokens: measuredAny ? speedEstimatedTokens : null,
      windows: windows.length ? windows.join(',') : null,
      steps: steps.filter(step => step.agent_kind === 'main').length,
      tool_calls: toolCalls,
      subagents: steps.filter(step => step.agent_kind === 'subagent').length,
      attachments: run.native?.input.attachmentIds.length ?? 0,
      prompt_chars: run.prompt.length,
      error_code: (run.state === 'failed' || run.state === 'interrupted') && run.error ? run.error.slice(0, 60) : null,
    };
    const columns = Object.keys(row) as Array<keyof RunFactRow>;
    const existing = db.prepare('SELECT * FROM run_facts WHERE run_id=?').get(runId) as Record<string, unknown> | undefined;
    if (existing && columns.every(column => existing[column] === row[column])) return false;
    db.prepare(`INSERT OR REPLACE INTO run_facts(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`).run(...columns.map(column => row[column]));
    return true;
  }

  /** The named run when it belongs to the session, otherwise the session's run active at `at`. */
  private resolveRun(sessionId: string, runId: string | undefined, at: number, nativeMessageId?: string, isSubagent = false): Run | undefined {
    if (runId) {
      try {
        const run = this.store.getRun(runId);
        if (run.sessionId === sessionId) return this.executionOwner(run);
      } catch { /* not a workbench run id; fall back to receipt or time */ }
    }
    if (nativeMessageId) {
      const matched = this.store.findRunByNativeMessage(sessionId, nativeMessageId);
      if (matched) return this.executionOwner(matched);
      // An explicit native message receipt that does not belong to any run is a CLI-initiated or
      // task-notification turn; never hand it to an earlier run by timestamp.
      if (!isSubagent) return undefined;
    }
    const row = this.store.db.prepare(`SELECT json FROM runs WHERE session_id=? AND COALESCE(json_extract(json,'$.native.intent'),'')!='steer' AND json_extract(json,'$.createdAt')<=?
      ORDER BY json_extract(json,'$.createdAt') DESC, rowid DESC LIMIT 1`).get(sessionId, new Date(at).toISOString()) as { json: string } | undefined;
    if (!row) return undefined;
    const run = JSON.parse(row.json) as Run;
    if (!TERMINAL_STATES.has(run.state)) return run;
    // A turn typed while nobody watched has no run of its own. Handing it to whichever run came
    // before would inflate that run, so a settled run only takes steps from its own lifetime.
    const timings = run.native?.timings ?? {};
    const endedAt = instant(timings.completedAt) ?? instant(timings.interruptedAt) ?? epoch(run.updatedAt);
    return endedAt !== undefined && at <= endedAt + RUN_SETTLE_GRACE_MS ? run : undefined;
  }

  private executionOwner(run: Run): Run | undefined {
    if (run.native?.intent !== 'steer') return run;
    if (!run.native.ownerRunId) return undefined;
    try {
      const owner = this.store.getRun(run.native.ownerRunId);
      return owner.sessionId === run.sessionId && owner.native?.intent !== 'steer' ? owner : undefined;
    } catch { return undefined; }
  }

  /**
   * One-time import of what runs already stored: each measured run becomes one run-level row that
   * real steps replace later, and every settled run gets its summary. The marker is written in the
   * same transaction, so a failure leaves it unset and the next start retries.
   */
  private migrate(): void {
    try {
      if (this.store.getSetting(MIGRATION_MARKER, false)) return;
      const runs = (this.store.db.prepare('SELECT json FROM runs ORDER BY rowid').all() as Array<{ json: string }>).map(row => JSON.parse(row.json) as Run);
      const hasSteps = this.store.db.prepare('SELECT 1 FROM usage_steps WHERE run_id=? LIMIT 1');
      this.store.transaction(() => {
        for (const run of runs) {
          if (run.native?.intent === 'steer') continue;
          const metrics = run.native?.metrics;
          if (!metrics || !metrics.steps || hasSteps.get(run.id)) continue;
          const startedAt = instant(run.native?.timings?.inputSentAt) ?? epoch(run.createdAt);
          this.writeUsage(run.sessionId, run.id, {
            stepId: `migration:${run.id}`,
            outputTokens: metrics.outputTokens,
            tokenSource: metrics.tokens === 'provider' ? 'provider' : 'estimated',
            window: metrics.window,
            ...(startedAt !== undefined ? { startedAt, endedAt: startedAt + Math.max(0, metrics.durationMs) } : {}),
          }, 'migration');
        }
        for (const run of runs) if (TERMINAL_STATES.has(run.state)) this.writeRunFacts(run.id);
        this.store.setSetting(MIGRATION_MARKER, true);
      });
      this.changed();
    } catch (error) { console.error(`[riffet] stats migration ${MIGRATION_MARKER} failed; retrying on next start:`, error); }
  }

  /** Trailing-edge throttle: at most one notification per `notifyMs`. */
  private changed(): void {
    if (this.closed || !this.listeners.size || this.notifyTimer) return;
    const wait = Math.max(0, (this.options.notifyMs ?? 1000) - (this.now() - this.lastNotifyAt));
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = undefined;
      this.lastNotifyAt = this.now();
      for (const listener of this.listeners) { try { listener(); } catch { /* one subscriber must not starve the rest */ } }
    }, wait);
    this.notifyTimer.unref?.();
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}
