import type { DatabaseSync } from 'node:sqlite';
import type {
  MetricsWindow, NativeBackendId, StatsAgentKind, StatsBreakdown, StatsBreakdownRow, StatsDashboard, StatsDimension, StatsFilter,
  StatsGranularity, StatsHeatmap, StatsKeyInfo, StatsLatency, StatsLatencyRow, StatsPercentiles, StatsRunRow, StatsRunStates,
  StatsRunsPage, StatsSeries, StatsSeriesMetric, StatsSplit, StatsSummary, StatsTokens, StatsTotals,
} from '../../../../packages/contracts/src/index.js';
import { isNativeBackendId, isPluginAgentId } from '../../../../packages/contracts/src/index.js';
import { autoGranularity, boundedGranularity, bucketEdges, bucketIndex, localDate, localParts, previousDate } from './buckets.js';
import type { RunFactRow, ToolCallRow, UsageStepRow } from './schema.js';

/** A parsed, validated filter. Instants are epoch milliseconds; `to` is exclusive. */
export interface ResolvedFilter {
  from: number; to: number; tz: string;
  backends: string[]; models: string[]; projects: string[]; profiles: string[];
  agentKind: StatsAgentKind; includeArchived: boolean; includeEstimated: boolean;
  /** Backends a client cannot read (`chat` for one that never asked for quick chats): left out of every answer. */
  hiddenBackends?: string[];
  /** Also leaves out every plugin Agent (its id contains a dot; no built-in one does), for a client that cannot decode one. */
  hidePluginAgents?: boolean;
  excludeTaskWorkspaces?: boolean;
}

export interface StatsLabels {
  projectName(projectId: string): string | undefined;
  profileLabel(backendId: string, profileId: string): string | undefined;
  /** The name a provider gives itself; a backend that is not installed has none and shows by id. */
  backendLabel?(backendId: string): string | undefined;
}

/** Group keys standing in for NULL columns. Filters accept them too. */
export const UNKNOWN_MODEL = '__unknown__';
export const DEFAULT_PROFILE = 'default';
export const OTHER_KEY = '__other__';
const MIN_SPEED_WINDOW_MS = 2_000;
const MAX_PLAUSIBLE_TOKENS_PER_SECOND = 1_000;
const SERIES_KEYS = 8;

const BACKEND_LABELS: Record<string, string> = { codex: 'Codex', claude: 'Claude Code', dsh: 'DeepSeek Harness', droid: 'Droid', traex: 'TRAE CLI', chat: '快速对话' };

type StepRow = UsageStepRow & { run_mode: string | null };
type ToolRow = ToolCallRow & { project_id: string | null };
type Dimension = Exclude<StatsDimension, 'tool'>;

interface TokenLike {
  input_tokens: number | null; cache_read_tokens: number | null; cache_write_tokens: number | null;
  output_tokens: number | null; reasoning_tokens: number | null;
}

export function filterContract(filter: ResolvedFilter): StatsFilter {
  return {
    from: new Date(filter.from).toISOString(), to: new Date(filter.to).toISOString(), tz: filter.tz,
    ...(filter.backends.length ? { backends: filter.backends as NativeBackendId[] } : {}),
    ...(filter.models.length ? { models: filter.models } : {}),
    ...(filter.projects.length ? { projects: filter.projects } : {}),
    ...(filter.profiles.length ? { profiles: filter.profiles } : {}),
    agentKind: filter.agentKind, includeArchived: filter.includeArchived, includeEstimated: filter.includeEstimated,
  };
}

/** Sum of the reported values; null when nothing in the aggregate reported the field. */
function tokenTotals(rows: Iterable<TokenLike & { estimated: number }>): StatsTokens {
  const result: StatsTokens = { input: null, cacheRead: null, cacheWrite: null, output: null, reasoning: null, estimatedOutput: 0 };
  const add = (field: 'input' | 'cacheRead' | 'cacheWrite' | 'output' | 'reasoning', value: number | null) => {
    if (value === null) return;
    result[field] = (result[field] ?? 0) + value;
  };
  for (const row of rows) {
    add('input', row.input_tokens);
    add('cacheRead', row.cache_read_tokens);
    add('cacheWrite', row.cache_write_tokens);
    add('output', row.output_tokens);
    add('reasoning', row.reasoning_tokens);
    result.estimatedOutput += row.estimated;
  }
  return result;
}

const stepTokens = (rows: readonly StepRow[]) => tokenTotals(rows.map(row => ({ ...row, estimated: row.token_source === 'estimated' ? row.output_tokens ?? 0 : 0 })));
const runTokens = (rows: readonly RunFactRow[]) => tokenTotals(rows.map(row => ({ ...row, estimated: row.estimated_output_tokens })));
const totalOf = (tokens: StatsTokens) => (tokens.input ?? 0) + (tokens.cacheRead ?? 0) + (tokens.cacheWrite ?? 0) + (tokens.output ?? 0);
const rowTotal = (row: TokenLike) => (row.input_tokens ?? 0) + (row.cache_read_tokens ?? 0) + (row.cache_write_tokens ?? 0) + (row.output_tokens ?? 0);

function cacheHitRate(rows: readonly TokenLike[]): number | null {
  let input = 0;
  let cached = 0;
  for (const row of rows) {
    if (row.input_tokens === null || row.cache_read_tokens === null) continue;
    input += row.input_tokens;
    cached += row.cache_read_tokens;
  }
  return input + cached > 0 ? cached / (input + cached) : null;
}

/** Linear-interpolated percentiles, or null without samples. */
export function percentiles(values: readonly number[]): StatsPercentiles | null {
  const sorted = values.filter(value => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const at = (p: number) => {
    const position = (sorted.length - 1) * p;
    const low = Math.floor(position);
    const high = Math.ceil(position);
    return sorted[low]! + (sorted[high]! - sorted[low]!) * (position - low);
  };
  return { p50: at(0.5), p90: at(0.9), p99: at(0.99), samples: sorted.length };
}

const present = (values: ReadonlyArray<number | null>) => values.filter((value): value is number => value !== null);

function emptyStates(): StatsRunStates { return { completed: 0, failed: 0, cancelled: 0, interrupted: 0 }; }
function runStates(rows: readonly RunFactRow[]): StatsRunStates {
  const states = emptyStates();
  for (const row of rows) if (row.state in states) states[row.state] += 1;
  return states;
}

const STEP_KEY: Record<Dimension, (row: StepRow) => string> = {
  backend: row => row.backend_id,
  model: row => row.model ?? UNKNOWN_MODEL,
  profile: row => row.profile_id ?? DEFAULT_PROFILE,
  project: row => row.project_id,
  mode: row => row.run_mode ?? 'unknown',
};
const RUN_KEY: Record<Dimension, (row: RunFactRow) => string> = {
  backend: row => row.backend_id,
  model: row => row.model_resolved ?? row.model_requested ?? UNKNOWN_MODEL,
  profile: row => row.profile_id ?? DEFAULT_PROFILE,
  project: row => row.project_id,
  mode: row => row.mode ?? 'unknown',
};

function group<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const value = key(row);
    let list = groups.get(value);
    if (!list) groups.set(value, list = []);
    list.push(row);
  }
  return groups;
}

function nextDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + 1)).toISOString().slice(0, 10);
}

/**
 * Read-side aggregation over the ledger tables. One instance serves one request: rows loaded for a
 * window are memoised, so a dashboard reads each table once per window however many charts it has.
 */
export class StatsQuery {
  private readonly memo = new Map<string, unknown>();

  constructor(private readonly db: DatabaseSync, private readonly labels: StatsLabels, private readonly now: () => number = Date.now) {}

  dashboard(filter: ResolvedFilter): StatsDashboard {
    const start = this.dataStart(filter);
    return {
      filter: filterContract(filter),
      generatedAt: new Date(this.now()).toISOString(),
      summary: this.summary(filter),
      series: this.series(filter, 'totalTokens', autoGranularity(start, filter.to), 'backend'),
      backends: this.breakdown(filter, 'backend'),
      models: this.breakdown(filter, 'model'),
      tools: this.breakdown(filter, 'tool'),
      heatmap: this.heatmap(filter),
      options: this.options(filter.hiddenBackends, filter.excludeTaskWorkspaces, filter.hidePluginAgents),
    };
  }

  summary(filter: ResolvedFilter): StatsSummary {
    const length = filter.to - filter.from;
    return {
      current: this.totals(filter, filter.from, filter.to),
      previous: this.totals(filter, filter.from - length, filter.from),
      streakDays: this.streak(filter),
    };
  }

  series(filter: ResolvedFilter, metric: StatsSeriesMetric, requested: StatsGranularity | undefined, split: StatsSplit): StatsSeries {
    const start = this.dataStart(filter);
    const granularity = boundedGranularity(start, filter.to, requested ?? autoGranularity(start, filter.to));
    const edges = bucketEdges(start, filter.to, filter.tz, granularity);
    const fromSteps = metric === 'totalTokens' || metric === 'inputTokens' || metric === 'outputTokens' || metric === 'cacheReadTokens';
    // Each contribution is (key, bucket, value); `sessions` and `durationMs` are reduced per bucket afterwards.
    const contributions: Array<{ key: string; bucket: number; value: number; session?: string; backend: string }> = [];
    if (fromSteps) {
      for (const row of this.steps(filter, filter.from, filter.to)) {
        const bucket = bucketIndex(edges, row.at);
        if (bucket < 0) continue;
        const value = metric === 'totalTokens' ? rowTotal(row)
          : metric === 'inputTokens' ? row.input_tokens
          : metric === 'outputTokens' ? row.output_tokens
          : row.cache_read_tokens;
        if (value === null) continue;
        contributions.push({ key: STEP_KEY[split](row), bucket, value, backend: row.backend_id });
      }
    } else {
      for (const row of this.runs(filter, filter.from, filter.to)) {
        const bucket = bucketIndex(edges, row.created_at);
        if (bucket < 0) continue;
        if (metric === 'durationMs' && row.duration_ms === null) continue;
        contributions.push({ key: RUN_KEY[split](row), bucket, value: metric === 'durationMs' ? row.duration_ms! : 1, session: row.session_id, backend: row.backend_id });
      }
    }
    const weight = new Map<string, number>();
    const backends = new Map<string, Set<string>>();
    for (const item of contributions) {
      weight.set(item.key, (weight.get(item.key) ?? 0) + (metric === 'durationMs' || metric === 'sessions' ? 1 : item.value));
      let set = backends.get(item.key);
      if (!set) backends.set(item.key, set = new Set());
      set.add(item.backend);
    }
    const ranked = [...weight.entries()].sort((a, b) => b[1] - a[1]).map(([key]) => key);
    const kept = new Set(ranked.length > SERIES_KEYS ? ranked.slice(0, SERIES_KEYS - 1) : ranked);
    const keyOf = (key: string) => kept.has(key) ? key : OTHER_KEY;
    const sums = new Map<string, number>();
    const samples = new Map<string, number[]>();
    const sessions = new Map<string, Set<string>>();
    for (const item of contributions) {
      const cell = `${item.bucket}\u0000${keyOf(item.key)}`;
      if (metric === 'durationMs') {
        let list = samples.get(cell);
        if (!list) samples.set(cell, list = []);
        list.push(item.value);
      } else if (metric === 'sessions') {
        let set = sessions.get(cell);
        if (!set) sessions.set(cell, set = new Set());
        set.add(item.session!);
      } else {
        sums.set(cell, (sums.get(cell) ?? 0) + item.value);
      }
    }
    const points = edges.map((edge, bucket) => {
      const values: Record<string, number> = {};
      for (const key of [...kept, OTHER_KEY]) {
        const cell = `${bucket}\u0000${key}`;
        const value = metric === 'durationMs' ? percentiles(samples.get(cell) ?? [])?.p50
          : metric === 'sessions' ? sessions.get(cell)?.size
          : sums.get(cell);
        if (value !== undefined) values[key] = value;
      }
      return { start: new Date(edge).toISOString(), values };
    });
    const keys: StatsKeyInfo[] = ranked.filter(key => kept.has(key)).map(key => this.keyInfo(split, key, backends.get(key)));
    if (ranked.length > kept.size) keys.push({ key: OTHER_KEY, label: '其它' });
    return { metric, granularity, split, keys, points };
  }

  breakdown(filter: ResolvedFilter, dimension: StatsDimension): StatsBreakdown {
    if (dimension === 'tool') {
      const tools = this.tools(filter, filter.from, filter.to);
      const total = tools.length;
      const rows: StatsBreakdownRow[] = [...group(tools, row => row.tool_name).entries()].map(([key, calls]) => {
        const backends = new Set(calls.map(call => call.backend_id));
        return {
          ...this.keyInfo('tool', key, backends),
          count: calls.length, sessions: new Set(calls.map(call => call.session_id)).size, states: emptyStates(),
          tokens: { input: null, cacheRead: null, cacheWrite: null, output: null, reasoning: null, estimatedOutput: 0 },
          totalTokens: 0, share: total ? calls.length / total : 0,
          failed: calls.filter(call => call.failed === 1).length,
          durationMs: null, outputTokensPerSecond: null,
        };
      });
      return { dimension, rows: rows.sort((a, b) => b.count - a.count || a.key.localeCompare(b.key)) };
    }
    const runs = group(this.runs(filter, filter.from, filter.to), RUN_KEY[dimension]);
    const steps = group(this.steps(filter, filter.from, filter.to), STEP_KEY[dimension]);
    const keys = new Set([...runs.keys(), ...steps.keys()]);
    const built = [...keys].map(key => {
      const keyRuns = runs.get(key) ?? [];
      const keySteps = steps.get(key) ?? [];
      const tokens = stepTokens(keySteps);
      const backends = new Set([...keyRuns.map(row => row.backend_id), ...keySteps.map(row => row.backend_id)]);
      return {
        ...this.keyInfo(dimension, key, backends),
        count: keyRuns.length, sessions: new Set(keyRuns.map(row => row.session_id)).size, states: runStates(keyRuns),
        tokens, totalTokens: totalOf(tokens), share: 0,
        durationMs: percentiles(present(keyRuns.map(row => row.duration_ms))),
        outputTokensPerSecond: percentiles(this.speeds(keyRuns, filter.includeEstimated)),
      } satisfies StatsBreakdownRow;
    });
    const total = built.reduce((acc, row) => acc + row.totalTokens, 0);
    for (const row of built) row.share = total ? row.totalTokens / total : 0;
    return { dimension, rows: built.sort((a, b) => b.totalTokens - a.totalTokens || b.count - a.count || a.key.localeCompare(b.key)) };
  }

  latency(filter: ResolvedFilter, dimension: 'backend' | 'model'): StatsLatency {
    const rows: StatsLatencyRow[] = [...group(this.runs(filter, filter.from, filter.to), RUN_KEY[dimension]).entries()]
      .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
      .map(([key, runs]) => ({
        ...this.keyInfo(dimension, key, new Set(runs.map(row => row.backend_id))),
        ttftMs: percentiles(present(runs.map(row => row.ttft_ms))),
        durationMs: percentiles(present(runs.map(row => row.duration_ms))),
        queueMs: percentiles(present(runs.map(row => row.queue_ms))),
        outputTokensPerSecond: percentiles(this.speeds(runs, filter.includeEstimated)),
        windows: [...new Set(runs.flatMap(row => row.windows ? row.windows.split(',') : []))].sort() as MetricsWindow[],
      }));
    return { dimension, rows };
  }

  heatmap(filter: ResolvedFilter): StatsHeatmap {
    const weekHour = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
    const runsByDate = new Map<string, number>();
    for (const row of this.runs(filter, filter.from, filter.to)) {
      const parts = localParts(row.created_at, filter.tz);
      weekHour[parts.weekday]![parts.hour]! += 1;
      const date = localDate(row.created_at, filter.tz);
      runsByDate.set(date, (runsByDate.get(date) ?? 0) + 1);
    }
    const tokensByDate = new Map<string, number>();
    for (const row of this.steps(filter, filter.from, filter.to)) {
      const date = localDate(row.at, filter.tz);
      tokensByDate.set(date, (tokensByDate.get(date) ?? 0) + rowTotal(row));
    }
    const calendar: StatsHeatmap['calendar'] = [];
    const last = localDate(filter.to - 1, filter.tz);
    for (let date = localDate(this.dataStart(filter), filter.tz); date <= last && calendar.length < 4_000; date = nextDate(date)) {
      calendar.push({ date, runs: runsByDate.get(date) ?? 0, totalTokens: tokensByDate.get(date) ?? 0 });
    }
    return { weekHour, calendar };
  }

  runsPage(filter: ResolvedFilter, cursor: { createdAt: number; runId: string } | undefined, limit: number): StatsRunsPage {
    const where = this.conditions(filter, 'r.backend_id', 'COALESCE(r.model_resolved,r.model_requested)', 'r.project_id', 'r.profile_id');
    const parameters: Array<string | number> = [filter.from, filter.to, ...where.parameters];
    let extra = '';
    if (cursor) {
      extra = 'AND (r.created_at<? OR (r.created_at=? AND r.run_id<?))';
      parameters.push(cursor.createdAt, cursor.createdAt, cursor.runId);
    }
    const rows = this.db.prepare(`SELECT r.*, json_extract(s.json,'$.title') AS session_title FROM run_facts r LEFT JOIN sessions s ON s.id=r.session_id
      WHERE r.created_at>=? AND r.created_at<? ${where.sql} ${extra} ORDER BY r.created_at DESC, r.run_id DESC LIMIT ?`)
      .all(...parameters, limit + 1) as unknown as Array<RunFactRow & { session_title: string | null }>;
    const page = rows.slice(0, limit).map(row => this.runRow(row));
    const lastRow = rows.length > limit ? rows[limit - 1] : undefined;
    return { rows: page, ...(lastRow ? { nextCursor: Buffer.from(JSON.stringify([lastRow.created_at, lastRow.run_id])).toString('base64url') } : {}) };
  }

  options(hidden: readonly string[] = [], excludeTaskWorkspaces = false, hidePluginAgents = false): StatsDashboard['options'] {
    const hiddenProjects = new Set(excludeTaskWorkspaces ? (this.db.prepare("SELECT id FROM projects WHERE json_extract(json,'$.system')='task-workspace'").all() as Array<{id:string}>).map(row => row.id) : []);
    const pairs = (sql: string) => (this.db.prepare(sql).all() as Array<{ key: string | null; backend_id: string; project_id: string }>).filter(row => !hidden.includes(row.backend_id) && !(hidePluginAgents && isPluginAgentId(row.backend_id)) && !hiddenProjects.has(row.project_id));
    const collect = (dimension: Dimension, rows: Array<{ key: string | null; backend_id: string }>, nullKey: string) => {
      const backends = new Map<string, Set<string>>();
      for (const row of rows) {
        const key = row.key ?? nullKey;
        let set = backends.get(key);
        if (!set) backends.set(key, set = new Set());
        set.add(row.backend_id);
      }
      return [...backends.entries()].map(([key, set]) => this.keyInfo(dimension, key, set)).sort((a, b) => a.label.localeCompare(b.label));
    };
    return {
      backends: collect('backend', pairs('SELECT backend_id AS key, backend_id, project_id FROM run_facts UNION SELECT backend_id, backend_id, project_id FROM usage_steps'), ''),
      models: collect('model', pairs(`SELECT model AS key, backend_id, project_id FROM usage_steps WHERE model IS NOT NULL
        UNION SELECT COALESCE(model_resolved,model_requested), backend_id, project_id FROM run_facts WHERE COALESCE(model_resolved,model_requested) IS NOT NULL`), UNKNOWN_MODEL),
      projects: collect('project', pairs('SELECT project_id AS key, backend_id, project_id FROM run_facts UNION SELECT project_id, backend_id, project_id FROM usage_steps'), ''),
      profiles: collect('profile', pairs('SELECT profile_id AS key, backend_id, project_id FROM run_facts UNION SELECT profile_id, backend_id, project_id FROM usage_steps'), DEFAULT_PROFILE),
    };
  }

  /** Run rows for export, newest first. */
  exportRows(filter: ResolvedFilter, limit = 100_000): StatsRunRow[] {
    return this.runsPage(filter, undefined, limit).rows;
  }

  private totals(filter: ResolvedFilter, from: number, to: number): StatsTotals {
    const steps = this.steps(filter, from, to);
    const runs = this.runs(filter, from, to);
    const tokens = stepTokens(steps);
    return {
      sessions: new Set(runs.map(row => row.session_id)).size,
      runs: runs.length,
      states: runStates(runs),
      activeDays: new Set(runs.map(row => localDate(row.created_at, filter.tz))).size,
      tokens, totalTokens: totalOf(tokens),
      toolCalls: this.tools(filter, from, to).length,
      subagents: steps.filter(row => row.agent_kind === 'subagent').length,
      cacheHitRate: cacheHitRate(steps),
      ttftMs: percentiles(present(runs.map(row => row.ttft_ms))),
      durationMs: percentiles(present(runs.map(row => row.duration_ms))),
      outputTokensPerSecond: percentiles(this.speeds(runs, filter.includeEstimated)),
    };
  }

  /** Consecutive local days with a run, ending on the day of `to` (or the day before when that one is empty). */
  private streak(filter: ResolvedFilter): number {
    const where = this.conditions(filter, 'r.backend_id', 'COALESCE(r.model_resolved,r.model_requested)', 'r.project_id', 'r.profile_id');
    const rows = this.db.prepare(`SELECT r.created_at FROM run_facts r LEFT JOIN sessions s ON s.id=r.session_id WHERE r.created_at<? ${where.sql}`)
      .all(filter.to, ...where.parameters) as Array<{ created_at: number }>;
    const days = new Set(rows.map(row => localDate(row.created_at, filter.tz)));
    let date = localDate(filter.to - 1, filter.tz);
    if (!days.has(date)) date = previousDate(date);
    let streak = 0;
    while (days.has(date)) { streak += 1; date = previousDate(date); }
    return streak;
  }

  /**
   * Output speed per run. An estimated count is left out when the filter excludes estimates.
   * A `stream` window brackets visible text deltas only, while the provider count also holds
   * tool-call arguments and hidden reasoning, so a short window can imply an impossible rate.
   * Such a run says nothing about decode speed and is dropped rather than clamped.
   */
  private speeds(runs: readonly RunFactRow[], includeEstimated: boolean): number[] {
    const result: number[] = [];
    for (const row of runs) {
      if (row.output_tokens === null) continue;
      if (!includeEstimated && (row.speed_estimated_output_tokens ?? row.estimated_output_tokens) > 0) continue;
      const window = row.measured_ms;
      if (!window || window < MIN_SPEED_WINDOW_MS) continue;
      const speed = (row.speed_output_tokens ?? row.output_tokens) / window * 1000;
      if (speed <= MAX_PLAUSIBLE_TOKENS_PER_SECOND) result.push(speed);
    }
    return result;
  }

  /**
   * The first instant worth drawing: `from`, unless no data exists that early. Without it an
   * "all time" window would chart years of empty buckets before the first recorded run.
   */
  private dataStart(filter: ResolvedFilter): number {
    return this.cached('start', () => {
      const row = this.db.prepare('SELECT MIN(at) AS first FROM (SELECT MIN(created_at) AS at FROM run_facts UNION ALL SELECT MIN(at) FROM usage_steps)').get() as { first: number | null };
      return row.first !== null && row.first > filter.from ? Math.min(row.first, filter.to - 1) : filter.from;
    });
  }

  private steps(filter: ResolvedFilter, from: number, to: number): StepRow[] {
    return this.cached(`steps:${from}:${to}`, () => {
      const where = this.conditions(filter, 'u.backend_id', 'u.model', 'u.project_id', 'u.profile_id');
      const extra = [
        filter.agentKind === 'all' ? '' : 'AND u.agent_kind=?',
        filter.includeEstimated ? '' : "AND u.token_source<>'estimated'",
      ].join(' ');
      return this.db.prepare(`SELECT u.*, r.mode AS run_mode FROM usage_steps u LEFT JOIN sessions s ON s.id=u.session_id LEFT JOIN run_facts r ON r.run_id=u.run_id
        WHERE u.at>=? AND u.at<? ${where.sql} ${extra}`)
        .all(from, to, ...where.parameters, ...(filter.agentKind === 'all' ? [] : [filter.agentKind])) as unknown as StepRow[];
    });
  }

  private runs(filter: ResolvedFilter, from: number, to: number): RunFactRow[] {
    return this.cached(`runs:${from}:${to}`, () => {
      const where = this.conditions(filter, 'r.backend_id', 'COALESCE(r.model_resolved,r.model_requested)', 'r.project_id', 'r.profile_id');
      return this.db.prepare(`SELECT r.* FROM run_facts r LEFT JOIN sessions s ON s.id=r.session_id WHERE r.created_at>=? AND r.created_at<? ${where.sql}`)
        .all(from, to, ...where.parameters) as unknown as RunFactRow[];
    });
  }

  private tools(filter: ResolvedFilter, from: number, to: number): ToolRow[] {
    return this.cached(`tools:${from}:${to}`, () => {
      const where = this.conditions(filter, 't.backend_id', 'COALESCE(r.model_resolved,r.model_requested)', 's.project_id', "COALESCE(r.profile_id,json_extract(s.json,'$.backendProfileId'))");
      return this.db.prepare(`SELECT t.*, s.project_id AS project_id FROM tool_calls t LEFT JOIN sessions s ON s.id=t.session_id LEFT JOIN run_facts r ON r.run_id=t.run_id
        WHERE t.at>=? AND t.at<? ${where.sql}`)
        .all(from, to, ...where.parameters) as unknown as ToolRow[];
    });
  }

  /** SQL for the dimension filters and the archive switch. Expects `sessions` joined as `s`. */
  private conditions(filter: ResolvedFilter, backend: string, model: string, project: string, profile: string): { sql: string; parameters: string[] } {
    const clauses: string[] = [];
    const parameters: string[] = [];
    const add = (column: string, values: readonly string[], nullKey?: string) => {
      if (!values.length) return;
      const concrete = values.filter(value => value !== nullKey);
      const parts: string[] = [];
      if (concrete.length) { parts.push(`${column} IN (${concrete.map(() => '?').join(',')})`); parameters.push(...concrete); }
      if (concrete.length !== values.length) parts.push(`${column} IS NULL`);
      clauses.push(`(${parts.join(' OR ')})`);
    };
    add(backend, filter.backends);
    if (filter.hiddenBackends?.length) { clauses.push(`${backend} NOT IN (${filter.hiddenBackends.map(() => '?').join(',')})`); parameters.push(...filter.hiddenBackends); }
    if (filter.hidePluginAgents) clauses.push(`${backend} NOT LIKE '%.%'`);
    add(model, filter.models, UNKNOWN_MODEL);
    add(project, filter.projects);
    if (filter.excludeTaskWorkspaces) clauses.push(`(${project} IS NULL OR ${project} NOT IN (SELECT id FROM projects WHERE json_extract(json,'$.system')='task-workspace'))`);
    add(profile, filter.profiles, DEFAULT_PROFILE);
    if (!filter.includeArchived) clauses.push(`json_extract(s.json,'$.archivedAt') IS NULL`);
    return { sql: clauses.map(clause => `AND ${clause}`).join(' '), parameters };
  }

  private keyInfo(dimension: StatsDimension, key: string, backends?: ReadonlySet<string>): StatsKeyInfo {
    const only = backends && backends.size === 1 ? [...backends][0]! : undefined;
    const backendId = dimension === 'backend' ? key : only;
    let label: string;
    switch (dimension) {
      case 'backend': label = BACKEND_LABELS[key] ?? this.labels.backendLabel?.(key) ?? key; break;
      case 'model': label = key === UNKNOWN_MODEL ? '未知模型' : key; break;
      case 'profile': label = key === DEFAULT_PROFILE ? '默认' : (only ? this.labels.profileLabel(only, key) : undefined) ?? key; break;
      case 'project': label = this.labels.projectName(key) ?? key; break;
      case 'mode': label = key === 'unknown' ? '未知' : key; break;
      case 'tool': label = key; break;
    }
    return { key, label, ...(backendId && isNativeBackendId(backendId) ? { backendId } : {}) };
  }

  private runRow(row: RunFactRow & { session_title: string | null }): StatsRunRow {
    const tokens = runTokens([row]);
    const model = row.model_resolved ?? row.model_requested;
    return {
      runId: row.run_id, sessionId: row.session_id, sessionTitle: row.session_title ?? '',
      projectId: row.project_id, projectName: this.labels.projectName(row.project_id) ?? '',
      // Stored ids are Agent ids, built-in or a plugin's; one this build has no provider for stays as it was stored, never another Agent's.
      backendId: row.backend_id as NativeBackendId,
      ...(model ? { model } : {}),
      state: row.state, createdAt: new Date(row.created_at).toISOString(),
      durationMs: row.duration_ms, ttftMs: row.ttft_ms, tokens, totalTokens: totalOf(tokens), toolCalls: row.tool_calls,
    };
  }

  private cached<T>(key: string, load: () => T): T {
    if (!this.memo.has(key)) this.memo.set(key, load());
    return this.memo.get(key) as T;
  }
}
