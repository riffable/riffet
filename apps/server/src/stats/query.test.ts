import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../store.js';
import { percentiles, StatsQuery, type ResolvedFilter } from './query.js';
import { ensureStatsSchema } from './schema.js';

const DAY = 86_400_000;
const T0 = Date.parse('2026-10-01T00:00:00Z');
const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

type Step = Partial<Record<string, unknown>> & { key: string; at: number };
type Fact = Partial<Record<string, unknown>> & { run: string; at: number };

function seed() {
  const store = new Store(':memory:');
  stores.push(store);
  ensureStatsSchema(store.db);
  const project = store.createProject('/tmp/q', 'Query project');
  const session = store.createSession({ projectId: project.id, kind: 'native', backendId: 'claude', title: 'A chat' });
  const step = (row: Step) => store.db.prepare(`INSERT INTO usage_steps(step_key,session_id,run_id,project_id,backend_id,model,at,started_at,ended_at,input_tokens,cache_read_tokens,cache_write_tokens,output_tokens,reasoning_tokens,token_source,agent_kind,ingest)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(row.key, session.id, (row.run as string) ?? null, project.id, (row.backend as string) ?? 'claude', (row.model as string) ?? null, row.at, row.at, null,
    (row.input as number) ?? null, (row.cacheRead as number) ?? null, null, (row.output as number) ?? null, null, (row.source as string) ?? 'provider', (row.kind as string) ?? 'main', 'live');
  const fact = (row: Fact) => store.db.prepare(`INSERT INTO run_facts(run_id,session_id,project_id,backend_id,model_resolved,state,created_at,ttft_ms,duration_ms,output_tokens,estimated_output_tokens,measured_ms,windows,tool_calls)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(row.run, session.id, project.id, (row.backend as string) ?? 'claude', (row.model as string) ?? null, (row.state as string) ?? 'completed', row.at,
    (row.ttft as number) ?? null, (row.duration as number) ?? null, (row.output as number) ?? null, (row.estimated as number) ?? 0, (row.measured as number) ?? null, (row.windows as string) ?? null, 0);
  const tool = (id: string, name: string, at: number, failed = 0) => store.db.prepare('INSERT INTO tool_calls(session_id,tool_call_id,run_id,backend_id,tool_name,failed,at) VALUES(?,?,?,?,?,?,?)').run(session.id, id, null, 'claude', name, failed, at);
  const query = new StatsQuery(store.db, { projectName: id => (id === project.id ? project.name : undefined), profileLabel: () => undefined }, () => T0 + 10 * DAY);
  return { store, project, session, step, fact, tool, query };
}

const filter = (patch: Partial<ResolvedFilter> = {}): ResolvedFilter => ({
  from: T0, to: T0 + 7 * DAY, tz: 'UTC', backends: [], models: [], projects: [], profiles: [],
  agentKind: 'all', includeArchived: true, includeEstimated: true, ...patch,
});

describe('StatsQuery', () => {
  it('keeps unreported token fields null and counts estimates separately', () => {
    const { step, query } = seed();
    step({ key: 'a', at: T0 + 1000, output: 30, source: 'estimated', backend: 'cursor' });
    const totals = query.summary(filter()).current;
    expect(totals.tokens).toEqual({ input: null, cacheRead: null, cacheWrite: null, output: 30, reasoning: null, estimatedOutput: 30 });
    expect(totals.cacheHitRate).toBeNull();
    expect(totals.totalTokens).toBe(30);
  });

  it('drops estimated rows when estimates are excluded', () => {
    const { step, query } = seed();
    step({ key: 'a', at: T0 + 1000, output: 30, source: 'estimated' });
    step({ key: 'b', at: T0 + 2000, output: 5, input: 1 });
    expect(new StatsQuery(query['db'], { projectName: () => undefined, profileLabel: () => undefined }).summary(filter({ includeEstimated: false })).current.tokens.output).toBe(5);
  });

  it('computes the cache hit rate only over rows reporting both input and cache reads', () => {
    const { step, query } = seed();
    step({ key: 'a', at: T0 + 1, input: 100, cacheRead: 300 });
    step({ key: 'b', at: T0 + 2, input: 1000 });
    expect(query.summary(filter()).current.cacheHitRate).toBe(0.75);
  });

  it('compares with the window of equal length before from', () => {
    const { fact, query } = seed();
    fact({ run: 'now', at: T0 + DAY });
    fact({ run: 'before1', at: T0 - DAY });
    fact({ run: 'before2', at: T0 - 2 * DAY });
    const summary = query.summary(filter());
    expect(summary.current.runs).toBe(1);
    expect(summary.previous.runs).toBe(2);
  });

  it('merges series keys beyond eight into other', () => {
    const { step, query } = seed();
    for (let index = 0; index < 10; index += 1) step({ key: `m${index}`, at: T0 + DAY + index, model: `model-${index}`, output: 100 - index });
    const series = query.series(filter(), 'outputTokens', 'day', 'model');
    expect(series.keys).toHaveLength(8);
    expect(series.keys.at(-1)).toEqual({ key: '__other__', label: '其它' });
    // The series starts at the first recorded data, not at an empty `from`.
    expect(series.points).toHaveLength(6);
    expect(series.points[0]!.values.__other__).toBe(91 + 92 + 93);
    expect(series.points[1]!.values).toEqual({});
  });

  it('reports tool calls with failures and call share', () => {
    const { tool, query } = seed();
    tool('1', 'Read', T0 + 1); tool('2', 'Read', T0 + 2); tool('3', 'Edit', T0 + 3, 1);
    const rows = query.breakdown(filter(), 'tool').rows;
    expect(rows.map(row => [row.key, row.count, row.failed])).toEqual([['Read', 2, 0], ['Edit', 1, 1]]);
    expect(rows[0]!.share).toBeCloseTo(2 / 3);
    expect(rows[0]!.tokens.input).toBeNull();
  });

  it('labels breakdown rows and splits token share', () => {
    const { step, fact, query } = seed();
    fact({ run: 'r1', at: T0 + 10, model: 'opus' });
    step({ key: 'a', at: T0 + 10, run: 'r1', model: 'opus', output: 75, input: 0 });
    step({ key: 'b', at: T0 + 20, model: null, output: 25 });
    const rows = query.breakdown(filter(), 'model').rows;
    expect(rows.map(row => [row.key, row.label, row.count, row.share, row.backendId])).toEqual([['opus', 'opus', 1, 0.75, 'claude'], ['__unknown__', '未知模型', 0, 0.25, 'claude']]);
  });

  it('normalizes model parameters and suffixes while aggregating thinking effort separately', () => {
    const { step, fact, query } = seed();
    fact({ run: 'r1', at: T0 + 10, backend: 'codex', model: 'gpt-6.1-sol[effort=high,fast=true]', ttft: 100, duration: 1000 });
    fact({ run: 'r2', at: T0 + 20, backend: 'codex', model: 'GPT-6.1-Sol[effort=xhigh,fast=false]', ttft: 300, duration: 3000 });
    fact({ run: 'r3', at: T0 + 30, backend: 'claude', model: 'passthrough/claude-opus-5-5[context=default,effort=high,fast=false]', ttft: 200, duration: 2000 });
    step({ key: 's1', run: 'r1', at: T0 + 10, backend: 'codex', model: 'gpt-6.1-sol[effort=high,fast=true]', input: 100, output: 50 });
    step({ key: 's2', run: 'r2', at: T0 + 20, backend: 'codex', model: 'gpt-6.1-sol[effort=xhigh,fast=false]', input: 200, output: 150 });
    step({ key: 's3', run: 'r3', at: T0 + 30, backend: 'claude', model: 'claude-opus-5-5', input: 500, output: 500 });

    const models = query.breakdown(filter(), 'model').rows;
    expect(models.map(row => [row.key, row.count, row.totalTokens])).toEqual([
      ['claude-opus-5-5', 1, 1000],
      ['gpt-6.1-sol', 2, 500],
    ]);
    const latency = query.latency(filter(), 'model').rows;
    expect(latency.map(row => [row.key, row.ttftMs?.p50, row.ttftMs?.samples])).toEqual([
      ['gpt-6.1-sol', 200, 2],
      ['claude-opus-5-5', 200, 1],
    ]);
    expect(query.options().models.map(item => item.key)).toEqual(['claude-opus-5-5', 'gpt-6.1-sol']);
    const filteredQuery = new StatsQuery(query['db'], { projectName: () => undefined, profileLabel: () => undefined });
    expect(filteredQuery.summary(filter({ models: ['gpt-6.1-sol'] })).current).toMatchObject({ runs: 2, totalTokens: 500 });

    const efforts = query.breakdown(filter(), 'effort').rows;
    expect(efforts.map(row => [row.key, row.count, row.totalTokens])).toEqual([
      ['high', 2, 1150],
      ['xhigh', 1, 350],
    ]);
  });

  it('fills every calendar day in the window and counts runs by local weekday and hour', () => {
    const { fact, query } = seed();
    fact({ run: 'r1', at: T0 + 2 * DAY + 3 * 3_600_000 });
    // Data starts on T0 itself so the calendar is not clipped to the first run.
    fact({ run: 'r0', at: T0 });
    const heatmap = query.heatmap(filter());
    expect(heatmap.calendar.map(day => day.runs)).toEqual([1, 0, 1, 0, 0, 0, 0]);
    // 2026-10-03 is a Saturday.
    expect(heatmap.weekHour[5]![3]).toBe(1);
  });

  it('computes latency percentiles and speed per model', () => {
    const { fact, query } = seed();
    fact({ run: 'r1', at: T0 + 1, model: 'm', ttft: 100, duration: 9000, output: 500, measured: 5000, windows: 'stream' });
    fact({ run: 'r2', at: T0 + 2, model: 'm', ttft: 300, duration: 3000, output: 30, windows: 'observed' });
    fact({ run: 'r3', at: T0 + 3, model: 'm', ttft: 200, duration: 9000, output: 900, measured: 600, windows: 'stream' });
    fact({ run: 'r4', at: T0 + 4, model: 'm', ttft: 200, duration: 9000, output: 9000, measured: 3000, windows: 'stream' });
    const [row] = query.latency(filter(), 'model').rows;
    expect(row!.ttftMs).toMatchObject({ p50: 200, samples: 4 });
    expect(row!.outputTokensPerSecond).toMatchObject({ p50: 100, samples: 1 });
    expect(row!.windows).toEqual(['observed', 'stream']);
  });

  it('paginates runs newest first', () => {
    const { fact, query } = seed();
    fact({ run: 'a', at: T0 + 1 }); fact({ run: 'b', at: T0 + 2 }); fact({ run: 'c', at: T0 + 3 });
    const first = query.runsPage(filter(), undefined, 2);
    expect(first.rows.map(row => row.runId)).toEqual(['c', 'b']);
    expect(first.rows[0]).toMatchObject({ sessionTitle: 'A chat', projectName: 'Query project', backendId: 'claude' });
    const cursor = JSON.parse(Buffer.from(first.nextCursor!, 'base64url').toString()) as [number, string];
    const second = query.runsPage(filter(), { createdAt: cursor[0], runId: cursor[1] }, 2);
    expect(second.rows.map(row => row.runId)).toEqual(['a']);
    expect(second.nextCursor).toBeUndefined();
  });

  it('interpolates percentiles', () => {
    expect(percentiles([])).toBeNull();
    expect(percentiles([1, 2, 3, 4])).toEqual({ p50: 2.5, p90: 3.7, p99: 3.9699999999999998, samples: 4 });
  });
});


it('excludes managed workspaces from totals and filter options until saved as a project', () => {
  const {store, project, fact, step} = seed();
  fact({run:'managed-run',at:T0+1,model:'managed-model'});
  step({key:'managed-step',run:'managed-run',at:T0+1,model:'managed-model',output:17});
  store.updateProject(project.id,{system:'task-workspace'});
  const dashboard = (excludeTaskWorkspaces:boolean) => new StatsQuery(store.db,{projectName:()=>project.name,profileLabel:()=>undefined}).dashboard(filter({excludeTaskWorkspaces}));
  const hidden=dashboard(true);
  expect(hidden.summary.current).toMatchObject({runs:0,totalTokens:0});
  expect(hidden.options.projects).toEqual([]);
  expect(hidden.options.models).toEqual([]);
  expect(dashboard(false).summary.current).toMatchObject({runs:1,totalTokens:17});
  store.promoteTaskWorkspace(project.id,'Saved');
  expect(dashboard(true).summary.current).toMatchObject({runs:1,totalTokens:17});
});
