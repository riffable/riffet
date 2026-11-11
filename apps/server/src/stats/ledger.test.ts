import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../store.js';
import { StatsLedger } from './ledger.js';

const stores: Store[] = [];
afterEach(() => { vi.useRealTimers(); for (const store of stores.splice(0)) store.close(); });

function setup(backendId: 'claude' | 'cursor' = 'claude') {
  const store = new Store(':memory:');
  stores.push(store);
  const project = store.createProject('/tmp/stats', 'stats');
  const session = store.createSession({ projectId: project.id, kind: 'native', backendId, model: 'session-model' });
  const run = store.acceptNativeRun(session.id, `c-${Math.random()}`, { text: 'hello', attachmentIds: [], context: [] }, { mode: 'agent', model: 'requested-model' });
  return { store, session, run };
}

const steps = (store: Store) => store.db.prepare('SELECT * FROM usage_steps ORDER BY step_key').all() as Array<Record<string, unknown>>;
const facts = (store: Store, runId: string) => store.db.prepare('SELECT * FROM run_facts WHERE run_id=?').get(runId) as Record<string, unknown> | undefined;

function complete(store: Store, runId: string, timings: Record<string, number>) {
  return store.transitionNativeRun(runId, ['queued'], { delivery: 'observed', timings }, { state: 'completed' });
}

describe('StatsLedger', () => {
  it('replays CLI turn metrics by exact receipt and retains independent model duration', () => {
    const { store, session, run } = setup();
    store.updateRun(run.id, { native: { ...run.native!, nativeMessageId: 'receipt-1' } });
    const ledger = new StatsLedger(store);
    ledger.recordUsage(session.id, run.id, { stepId: 'response-1', nativeMessageId: 'receipt-1', outputTokens: 100,
      startedAt: 1_000, endedAt: 123_000, durationMs: 2_000, tokenSource: 'provider', window: 'stream' });
    ledger.recordUsage(session.id, undefined, { stepId: 'cli-response', nativeMessageId: 'receipt-external', outputTokens: 90,
      startedAt: 125_000, endedAt: 127_000, tokenSource: 'provider', window: 'transcript' });
    expect(steps(store).find(row => row.native_message_id === 'receipt-1')).toMatchObject({ run_id: run.id, output_tokens: 100, duration_ms: 2_000 });
    expect(steps(store).find(row => row.native_message_id === 'receipt-external')?.run_id).toBeNull();
    const frames = ledger.sessionMetrics(session.id);
    expect(frames.find(frame => frame.nativeMessageId === 'receipt-1')).toMatchObject({ runId: run.id,
      run: { outputTokens: 100, durationMs: 2_000, steps: 1 } });
    expect(frames.find(frame => frame.nativeMessageId === 'receipt-external')).toMatchObject({ run: { outputTokens: 90, durationMs: 2_000 } });
    expect(frames.find(frame => frame.nativeMessageId === 'receipt-external')?.runId).toBeUndefined();
    expect(steps(store)[0]?.duration_ms).toBeGreaterThan(0);

    // An external CLI turn stamped after run.createdAt must still stay unattributed to run.id.
    const nowMs = Date.parse(run.createdAt) + 1_000;
    ledger.recordUsage(session.id, undefined, { stepId: 'cli-live', nativeMessageId: 'receipt-cli-live', outputTokens: 50,
      startedAt: nowMs, endedAt: nowMs + 1_000, tokenSource: 'provider', window: 'transcript' });
    expect(steps(store).find(row => row.step_key === `claude:${session.id}:cli-live`)?.run_id).toBeNull();
  });

  it('enriches old live identity without replacing its measured tokens or timing', () => {
    const { store, session, run } = setup();
    const ledger = new StatsLedger(store);
    ledger.recordUsage(session.id, run.id, { stepId: 'old', outputTokens: 100, startedAt: 1_000, endedAt: 3_000, tokenSource: 'provider', window: 'stream' });
    ledger.recordUsageBatch(session.id, [{ usage: { stepId: 'old', nativeMessageId: 'external-old', outputTokens: 900,
      startedAt: 1_000, endedAt: 100_000, tokenSource: 'estimated', window: 'observed' } }], 'backfill');
    expect(steps(store)[0]).toMatchObject({ native_message_id: 'external-old', output_tokens: 100, duration_ms: 2_000, window: 'stream', ingest: 'live' });
    expect(ledger.sessionMetrics(session.id)[0]?.run).toMatchObject({ outputTokens: 100, durationMs: 2_000 });
  });

  it('metrics backfill preserves the original run lifecycle timestamp', () => {
    const { store, run } = setup();
    const previous = store.getRun(run.id);
    store.saveRunMetrics(run.id, { outputTokens: 90, durationMs: 2_000, tokens: 'provider', window: 'stream', steps: 1 });
    expect(store.getRun(run.id)).toMatchObject({ updatedAt: previous.updatedAt, state: previous.state,
      native: { metrics: { outputTokens: 90, durationMs: 2_000 } } });
  });

  it('keeps untimed output and a child agent out of the measured main-agent rate', () => {
    const { store, session, run } = setup();
    const ledger = new StatsLedger(store);
    ledger.recordUsage(session.id, run.id, { stepId: 'main', outputTokens: 90, startedAt: 1_000, endedAt: 3_000, tokenSource: 'provider', window: 'stream' });
    ledger.recordUsage(session.id, run.id, { stepId: 'untimed', outputTokens: 200, tokenSource: 'provider' });
    ledger.recordUsage(session.id, run.id, { stepId: 'child', outputTokens: 10_000, startedAt: 1_000, endedAt: 101_000,
      agentKind: 'subagent', tokenSource: 'estimated', window: 'transcript' });
    complete(store, run.id, {});
    expect(facts(store, run.id)).toMatchObject({ output_tokens: 10_290, speed_output_tokens: 90,
      measured_ms: 2_000, speed_estimated_output_tokens: 0 });
  });

  it('keeps one row per step and stores the latest measurement', () => {
    const { store, session, run } = setup();
    const ledger = new StatsLedger(store);
    ledger.recordUsage(session.id, run.id, { stepId: 'msg_1', outputTokens: 10, tokenSource: 'provider', startedAt: Date.now() });
    ledger.recordUsage(session.id, run.id, { stepId: 'msg_1', outputTokens: 42, inputTokens: 7, tokenSource: 'provider', startedAt: Date.now(), model: 'claude-x' });
    const rows = steps(store);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ step_key: `claude:${session.id}:msg_1`, output_tokens: 42, input_tokens: 7, model: 'claude-x', requested_model: 'requested-model', ingest: 'live' });
  });

  it('writes a step handed over again unchanged only once', () => {
    const { store, session, run } = setup();
    const ledger = new StatsLedger(store);
    const step = { stepId: 'msg_1', outputTokens: 10, tokenSource: 'provider' as const, startedAt: 1_000, endedAt: 2_000 };
    ledger.recordUsage(session.id, run.id, step);
    const rebuilds = vi.spyOn(ledger, 'refreshRun');
    for (let poll = 0; poll < 3; poll += 1) ledger.recordUsage(session.id, run.id, { ...step });
    expect(ledger.recordUsageBatch(session.id, [{ runId: run.id, usage: { ...step } }], 'live')).toBe(0);
    expect(rebuilds).not.toHaveBeenCalled();
    ledger.recordUsage(session.id, run.id, { ...step, outputTokens: 11 });
    expect(rebuilds).toHaveBeenCalledTimes(1);
    expect(steps(store)[0]).toMatchObject({ output_tokens: 11 });
  });

  it('stores unreported token fields as NULL, not zero', () => {
    const { store, session, run } = setup('cursor');
    new StatsLedger(store).recordUsage(session.id, run.id, { stepId: 'blob', outputTokens: 12, tokenSource: 'estimated' });
    expect(steps(store)[0]).toMatchObject({ input_tokens: null, cache_read_tokens: null, output_tokens: 12, token_source: 'estimated', model: 'requested-model' });
  });

  it('attributes a run-less step to the run active at its start', () => {
    const { store, session, run } = setup();
    new StatsLedger(store).recordUsage(session.id, undefined, { stepId: 'late', outputTokens: 3, tokenSource: 'provider', startedAt: Date.now() + 1000 });
    expect(steps(store)[0]!.run_id).toBe(run.id);
  });

  it('writes run facts when a run settles, leaving unknown latencies NULL', () => {
    const { store, session, run } = setup();
    const ledger = new StatsLedger(store);
    const base = Date.parse(run.createdAt);
    ledger.recordUsage(session.id, run.id, { stepId: 'a', inputTokens: 100, cacheReadTokens: 900, outputTokens: 50, tokenSource: 'provider', startedAt: base + 200, endedAt: base + 1200, window: 'transcript' });
    expect(facts(store, run.id)).toBeUndefined();
    complete(store, run.id, { dispatchAt: base + 50, inputSentAt: base + 100, firstOutputAt: base + 600, completedAt: base + 2100 });
    expect(facts(store, run.id)).toMatchObject({
      state: 'completed', queue_ms: 50, ttft_ms: 500, duration_ms: 2000,
      input_tokens: 100, cache_read_tokens: 900, cache_write_tokens: null, output_tokens: 50,
      measured_ms: 1000, windows: 'transcript', steps: 1, model_resolved: 'requested-model', prompt_chars: 5,
    });

    const other = setup();
    new StatsLedger(other.store);
    complete(other.store, other.run.id, { inputSentAt: Date.parse(other.run.createdAt) + 10 });
    expect(facts(other.store, other.run.id)).toMatchObject({ ttft_ms: null, duration_ms: null, queue_ms: null, output_tokens: null });
  });

  it('records tool calls idempotently and never clears a failure', () => {
    const { store, session, run } = setup();
    const ledger = new StatsLedger(store);
    const event = (type: string, data: Record<string, unknown>) => ({ sequence: 1, sessionId: session.id, type, data, createdAt: new Date().toISOString(), nativeId: `${type}-${Math.random()}` });
    ledger.observeEvents(session.id, [event('tool_call', { toolCallId: 't1', toolName: 'Read', status: 'in_progress' })]);
    ledger.observeEvents(session.id, [event('tool_call_update', { toolCallId: 't1', status: 'failed' })]);
    ledger.observeEvents(session.id, [event('tool_call_update', { toolCallId: 't1', status: 'completed' }), event('agent_message_chunk', {})]);
    const rows = store.db.prepare('SELECT * FROM tool_calls').all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tool_name: 'Read', failed: 1, run_id: run.id, backend_id: 'claude' });
  });

  it('migrates stored run metrics once and drops the migration row when real steps arrive', () => {
    const { store, session, run } = setup();
    const base = Date.parse(run.createdAt);
    complete(store, run.id, { inputSentAt: base, completedAt: base + 4000 });
    const current = store.getRun(run.id);
    store.updateRun(run.id, { native: { ...current.native!, metrics: { outputTokens: 80, durationMs: 4000, tokens: 'provider', window: 'stream', steps: 2 } } });

    const ledger = new StatsLedger(store);
    expect(steps(store)).toEqual([expect.objectContaining({ step_key: `claude:${session.id}:migration:${run.id}`, output_tokens: 80, ingest: 'migration' })]);
    expect(facts(store, run.id)).toMatchObject({ output_tokens: 80 });
    expect(store.getSetting('stats-migration-v1', false)).toBe(true);

    new StatsLedger(store);
    expect(steps(store)).toHaveLength(1);

    ledger.recordUsage(session.id, run.id, { stepId: 'real', outputTokens: 90, tokenSource: 'provider', startedAt: base + 10 });
    expect(steps(store).map(row => row.ingest)).toEqual(['live']);
    expect(facts(store, run.id)).toMatchObject({ output_tokens: 90 });
  });

  it('logs a failed migration and leaves its marker unset so the next start retries', () => {
    const { store } = setup();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(store, 'getSetting').mockImplementationOnce(() => { throw new Error('database is locked'); });
    new StatsLedger(store);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('[riffet] stats migration stats-migration-v1 failed'), expect.objectContaining({ message: 'database is locked' }));
    logged.mockRestore();
    expect(store.getSetting('stats-migration-v1', false)).toBe(false);
    new StatsLedger(store);
    expect(store.getSetting('stats-migration-v1', false)).toBe(true);
  });

  it('never lets a backfilled step replace a live one', () => {
    const { store, session, run } = setup();
    const ledger = new StatsLedger(store);
    const at = Date.parse(run.createdAt) + 10;
    ledger.recordUsage(session.id, run.id, { stepId: 'msg_1', outputTokens: 42, tokenSource: 'provider', startedAt: at, window: 'stream' });
    expect(ledger.recordUsageBatch(session.id, [{ usage: { stepId: 'msg_1', outputTokens: 40, tokenSource: 'provider', startedAt: at } }], 'backfill')).toBe(0);
    expect(steps(store)[0]).toMatchObject({ output_tokens: 42, ingest: 'live', window: 'stream' });
    expect(ledger.recordUsageBatch(session.id, [{ usage: { stepId: 'msg_2', outputTokens: 5, tokenSource: 'provider', startedAt: at } }], 'backfill')).toBe(1);
    expect(ledger.recordUsageBatch(session.id, [{ usage: { stepId: 'msg_2', outputTokens: 6, tokenSource: 'provider', startedAt: at } }], 'backfill')).toBe(1);
    expect(steps(store)[1]).toMatchObject({ output_tokens: 6, ingest: 'backfill', run_id: run.id });
  });

  it('leaves a step outside every run unattributed instead of inflating an older run', () => {
    const { store, session, run } = setup();
    const ledger = new StatsLedger(store);
    const base = Date.parse(run.createdAt);
    complete(store, run.id, { inputSentAt: base, completedAt: base + 1000 });
    ledger.recordUsage(session.id, undefined, { stepId: 'late', outputTokens: 3, tokenSource: 'provider', startedAt: base + 30_000 });
    ledger.recordUsage(session.id, undefined, { stepId: 'unwatched', outputTokens: 9, tokenSource: 'provider', startedAt: base + 3_600_000 });
    const byStep = Object.fromEntries(steps(store).map(row => [String(row.step_key).split(':').pop(), row.run_id]));
    expect(byStep).toEqual({ late: run.id, unwatched: null });
    expect(facts(store, run.id)).toMatchObject({ output_tokens: 3 });
  });

  it('migrates a mixed metrics count as an estimate', () => {
    const { store, run } = setup();
    complete(store, run.id, {});
    const current = store.getRun(run.id);
    store.updateRun(run.id, { native: { ...current.native!, metrics: { outputTokens: 30, durationMs: 1000, tokens: 'mixed', window: 'observed', steps: 1 } } });
    new StatsLedger(store);
    expect(steps(store)[0]).toMatchObject({ token_source: 'estimated', output_tokens: 30 });
  });

  it('throttles change notifications', () => {
    vi.useFakeTimers();
    const { store, session, run } = setup();
    const ledger = new StatsLedger(store, { notifyMs: 1000 });
    const listener = vi.fn();
    ledger.subscribe(listener);
    for (let index = 0; index < 5; index += 1) ledger.recordUsage(session.id, run.id, { stepId: `s${index}`, outputTokens: index, tokenSource: 'provider' });
    expect(listener).not.toHaveBeenCalled();
    vi.advanceTimersByTime(0);
    expect(listener).toHaveBeenCalledTimes(1);
    ledger.recordUsage(session.id, run.id, { stepId: 'again', outputTokens: 1, tokenSource: 'provider' });
    vi.advanceTimersByTime(500);
    expect(listener).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(600);
    expect(listener).toHaveBeenCalledTimes(2);
    ledger.close();
  });

  it('never throws into the caller', () => {
    const { store } = setup();
    const ledger = new StatsLedger(store);
    expect(() => ledger.recordUsage('missing-session', undefined, { stepId: 'x', tokenSource: 'provider' })).not.toThrow();
    expect(() => ledger.observeEvents('missing-session', [{ sequence: 1, sessionId: 'missing-session', type: 'tool_call', data: { toolCallId: 'a' }, createdAt: '', nativeId: 'n' }])).not.toThrow();
  });
});
