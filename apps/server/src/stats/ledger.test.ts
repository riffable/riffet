import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UsageObservation } from './types.js';
import { Store } from '../store.js';
import { StatsLedger } from './ledger.js';
import { StatsQuery, type ResolvedFilter } from './query.js';

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
  const observation = (patch: Partial<UsageObservation> = {}): UsageObservation => ({
    nativeSessionId: 'native-chat', nativeTurnId: 'native-turn', requestId: 'request-1', scope: 'agent-turn', agentKind: 'main',
    startedAt: 1_000, endedAt: 3_000, status: 'completed',
    usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 0 }, ...patch,
  });

  it('durably replays native observations across sessions without duplicating totals', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'riffet-usage-observation-'));
    let store: Store | undefined;
    let ledger: StatsLedger | undefined;
    try {
      const filename = join(directory, 'state.db');
      store = new Store(filename);
      const project = store.createProject('/tmp/usage', 'usage');
      const session = store.createSession({ projectId: project.id, kind: 'native', backendId: 'cursor' });
      ledger = new StatsLedger(store);
      const listener = vi.fn();
      ledger.subscribeObservations(listener, 'cursor');
      expect(ledger.recordObservation(session.id, undefined, observation())).toBe(true);
      const first = (await ledger.readObservations('cursor'))[0]!;
      expect(first).toMatchObject({ coverage: 'complete', cwd: '/tmp/usage', sessionId: session.id });
      expect(first.usage.reasoningTokens).toBeUndefined();
      expect(steps(store)[0]).toMatchObject({ model: null, requested_model: null, observation_id: first.id });
      ledger.close(); store.close();
      store = new Store(filename); ledger = new StatsLedger(store);
      const reimport = store.createSession({ projectId: project.id, kind: 'native', backendId: 'cursor' });
      const repeated = vi.fn(); ledger.subscribeObservations(repeated);
      expect(ledger.recordObservation(reimport.id, undefined, observation())).toBe(true);
      expect(await ledger.readObservations('cursor')).toEqual([first]);
      expect(await ledger.readObservations('claude')).toEqual([]);
      expect(steps(store)).toHaveLength(1);
      expect(repeated).not.toHaveBeenCalled();
      expect(listener).toHaveBeenCalledTimes(1);
    } finally { ledger?.close(); store?.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  it('keeps partial counters out of totals, enriches missing values, and retracts conflicting facts', async () => {
    const { store, session, run } = setup('cursor');
    const ledger = new StatsLedger(store);
    const partial = observation({ usage: { inputTokens: 10, outputTokens: 20 } });
    expect(ledger.recordObservation(session.id, run.id, partial)).toBe(true);
    expect((await ledger.readObservations('cursor'))[0]?.coverage).toBe('partial');
    expect(steps(store)).toHaveLength(0);
    expect(ledger.recordObservation(session.id, run.id, observation())).toBe(true);
    expect((await ledger.readObservations('cursor'))[0]?.coverage).toBe('complete');
    expect(steps(store)).toHaveLength(1);
    expect(ledger.recordObservation(session.id, run.id, observation({ requestId: 'another-request' }))).toBe(true);
    expect((await ledger.readObservations('cursor'))[0]?.coverage).toBe('conflict');
    expect(steps(store)).toHaveLength(0);
    ledger.recordObservation(session.id, run.id, observation());
    expect((await ledger.readObservations('cursor'))[0]?.coverage).toBe('conflict');
    expect(steps(store)).toHaveLength(0);
    const evidence = store.db.prepare('SELECT conflicts_json FROM usage_observations').get() as { conflicts_json: string };
    expect(JSON.parse(evidence.conflicts_json)).toEqual(expect.arrayContaining([expect.objectContaining({ requestId: 'another-request' })]));
    for (const usage of [
      { ...observation().usage, inputTokens: -1 }, { ...observation().usage, outputTokens: 1.5 },
      { ...observation().usage, cacheReadTokens: Number.MAX_SAFE_INTEGER + 1 },
      { ...observation().usage, reasoningTokens: 21 },
    ]) {
      const nativeTurnId = `invalid-${JSON.stringify(usage)}`;
      expect(ledger.recordObservation(session.id, run.id, observation({ nativeTurnId, usage }))).toBe(true);
    }
    expect((await ledger.readObservations('cursor')).slice(1).every(value => value.coverage === 'partial')).toBe(true);
    expect(steps(store)).toHaveLength(0);
    expect(ledger.recordObservation(session.id, run.id, observation({ nativeSessionId: '' }))).toBe(false);
    ledger.close();
  });

  it('retains captures for retry while another reader prevents a durable checkpoint', () => {
    const directory = mkdtempSync(join(tmpdir(), 'riffet-usage-checkpoint-'));
    const store = new Store(join(directory, 'state.db'));
    const reader = new DatabaseSync(store.path);
    const project = store.createProject('/tmp/usage', 'usage');
    const session = store.createSession({ projectId: project.id, kind: 'native', backendId: 'cursor' });
    const ledger = new StatsLedger(store);
    try {
      reader.exec('BEGIN');
      reader.prepare('SELECT COUNT(*) FROM usage_observations').get();
      expect(ledger.recordObservation(session.id, undefined, observation())).toBe(false);
      reader.exec('ROLLBACK');
      expect(ledger.recordObservation(session.id, undefined, observation())).toBe(true);
      expect(steps(store)).toHaveLength(1);
    } finally { ledger.close(); reader.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  it('replaces only the matching owner estimates, preserves recovery, and never treats turn wall time as TPS', async () => {
    const { store, session, run } = setup('cursor');
    const ledger = new StatsLedger(store);
    const estimate = { stepId: 'estimate', outputTokens: 7, tokenSource: 'estimated' as const, startedAt: 1_000, endedAt: 3_000 };
    ledger.recordUsage(session.id, run.id, estimate);
    ledger.recordUsage(session.id, run.id, { ...estimate, stepId: 'child-1', agentKind: 'subagent', nativeSessionId: 'child-1' });
    ledger.recordUsage(session.id, run.id, { ...estimate, stepId: 'child-2', agentKind: 'subagent', nativeSessionId: 'child-2' });
    ledger.recordObservation(session.id, run.id, observation());
    ledger.recordUsage(session.id, run.id, { ...estimate, outputTokens: 9 }); // a later transcript pass
    ledger.recordObservation(session.id, run.id, observation({ nativeSessionId: 'child-1', agentKind: 'subagent', parentNativeSessionId: 'native-chat' }));
    complete(store, run.id, {});
    expect(facts(store, run.id)).toMatchObject({ output_tokens: 47, estimated_output_tokens: 7, measured_ms: null, speed_output_tokens: null, steps: 0 });
    expect(ledger.sessionMetrics(session.id)).toEqual([]);
    const filter: ResolvedFilter = { from: 1, to: 5_000, tz: 'UTC', backends: [], models: [], projects: [], profiles: [], agentKind: 'all', includeArchived: true, includeEstimated: true };
    const query = new StatsQuery(store.db, { projectName: () => undefined, profileLabel: () => undefined });
    expect(query.summary(filter).current.tokens.output).toBe(47);
    ledger.recordObservation(session.id, run.id, observation({ usage: { ...observation().usage, outputTokens: 21 } }));
    expect(facts(store, run.id)).toMatchObject({ output_tokens: 36, estimated_output_tokens: 16, measured_ms: 2_000, speed_output_tokens: 9 });
    ledger.close();
  });

  it('keeps another agent migration estimate when a child total arrives', () => {
    const { store, session, run } = setup('cursor');
    store.saveRunMetrics(run.id, { outputTokens: 7, durationMs: 2_000, tokens: 'estimated', window: 'observed', steps: 1 });
    const ledger = new StatsLedger(store);
    ledger.recordObservation(session.id, run.id, observation({ nativeSessionId: 'child', agentKind: 'subagent' }));
    complete(store, run.id, {});
    expect(facts(store, run.id)).toMatchObject({ output_tokens: 27, estimated_output_tokens: 7 });
    expect(steps(store).find(row => row.ingest === 'migration')).toMatchObject({ suppressed_by: null, output_tokens: 7 });
    ledger.close();
  });

  it('suppresses a live estimate when backfill later binds its exact receipt', () => {
    const { store, session, run } = setup('cursor');
    const ledger = new StatsLedger(store);
    const estimate = { stepId: 'late-estimate', outputTokens: 7, tokenSource: 'estimated' as const, startedAt: 1_000 };
    ledger.recordUsage(session.id, undefined, estimate);
    expect(steps(store)[0]?.run_id).toBeNull();
    ledger.recordObservation(session.id, run.id, observation());
    store.updateRun(run.id, { native: { ...run.native!, nativeMessageId: 'late-receipt' } });
    ledger.recordUsage(session.id, undefined, { ...estimate, nativeMessageId: 'late-receipt' }, 'backfill');
    complete(store, run.id, {});
    expect(steps(store).find(row => row.step_key === `cursor:${session.id}:late-estimate`)).toMatchObject({ run_id: run.id, suppressed_by: expect.any(String) });
    expect(facts(store, run.id)).toMatchObject({ output_tokens: 20, estimated_output_tokens: 0 });
    ledger.close();
  });

  it('binds late native receipts without assigning orphan child turns by time', async () => {
    const { store, session, run } = setup('cursor');
    const ledger = new StatsLedger(store);
    ledger.recordUsage(session.id, run.id, { stepId: 'estimate', outputTokens: 7, tokenSource: 'estimated' });
    ledger.recordObservation(session.id, undefined, observation());
    ledger.recordObservation(session.id, undefined, observation({ nativeSessionId: 'orphan-child', agentKind: 'subagent' }));
    expect((await ledger.readObservations('cursor')).every(value => value.runId === undefined)).toBe(true);
    expect(steps(store).filter(row => row.observation_id).every(row => row.run_id === null)).toBe(true);
    store.updateRun(run.id, { native: { ...run.native!, nativeSessionId: 'native-chat', nativeTurnId: 'native-turn' } });
    const recorded = await ledger.readObservations('cursor');
    expect(recorded.find(value => value.agentKind === 'main')?.runId).toBe(run.id);
    expect(recorded.find(value => value.agentKind === 'subagent')?.runId).toBeUndefined();
    expect(steps(store).find(row => row.token_source === 'estimated')?.suppressed_by).toBeTruthy();
    ledger.recordObservation(session.id, undefined, observation({ nativeTurnId: 'bound-during-restart' }));
    ledger.close();
    store.updateRun(run.id, { native: { ...store.getRun(run.id).native!, nativeTurnId: 'bound-during-restart' } });
    const recovered = new StatsLedger(store);
    expect((await recovered.readObservations('cursor')).find(value => value.nativeTurnId === 'bound-during-restart')?.runId).toBe(run.id);
    recovered.close();
  });

  it('acknowledges only a committed transaction and does not publish rolled-back observations', async () => {
    const { store, session } = setup('cursor');
    const ledger = new StatsLedger(store);
    const listener = vi.fn(); ledger.subscribeObservations(listener);
    expect(() => store.transaction(() => {
      expect(ledger.recordObservation(session.id, undefined, observation())).toBe(false);
      throw new Error('rollback');
    })).toThrow('rollback');
    expect(await ledger.readObservations('cursor')).toEqual([]);
    expect(listener).not.toHaveBeenCalled();
    expect(ledger.recordObservation(session.id, undefined, observation())).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    ledger.close();
    expect(ledger.recordObservation(session.id, undefined, observation())).toBe(false);
  });

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

  it('keeps total output tokens while excluding implausible single-step bursts from speed totals', () => {
    const { store, session, run } = setup();
    const ledger = new StatsLedger(store);
    ledger.recordUsage(session.id, run.id, { stepId: 'good', outputTokens: 200, startedAt: 1_000, endedAt: 5_000, tokenSource: 'provider', window: 'stream' });
    ledger.recordUsage(session.id, run.id, { stepId: 'corrupt-burst', outputTokens: 500, startedAt: 6_000, endedAt: 6_002, tokenSource: 'provider', window: 'stream' });
    complete(store, run.id, {});
    expect(facts(store, run.id)).toMatchObject({ output_tokens: 700, measured_ms: 4_000, speed_output_tokens: 200 });
    ledger.close();
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

  it('upgrades a legacy non-partial usage_steps_observation index so sessionMetrics avoids scanning NULL rows', () => {
    const { store, session } = setup();
    new StatsLedger(store);
    store.db.exec('DROP INDEX usage_steps_observation; CREATE INDEX usage_steps_observation ON usage_steps(observation_id);');
    new StatsLedger(store);
    const indexRow = store.db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='usage_steps_observation'").get() as { sql?: string } | undefined;
    expect(indexRow?.sql).toContain('WHERE observation_id IS NOT NULL');
    const plan = store.db.prepare(
      `EXPLAIN QUERY PLAN SELECT output_tokens, duration_ms, token_source, window, at
       FROM usage_steps
       WHERE session_id=? AND agent_kind='main' AND observation_id IS NULL
       ORDER BY at`,
    ).all(session.id) as Array<{ detail?: string }>;
    expect(plan.map(row => row.detail ?? '').join('\n')).toContain('usage_steps_session_agent_at');
  });
});
