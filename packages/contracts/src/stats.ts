import type { NativeBackendId } from './agent-ids.js';
import type { MetricsWindow, Run } from './run.js';

/*
 * Usage statistics (docs/STATS.md). Every aggregate is computed on the server; clients only render.
 *
 * Filters travel as query parameters on every `/api/stats/*` endpoint: `from` and `to` (ISO
 * instants, `to` exclusive), `tz` (IANA zone the buckets are cut in), and the repeatable
 * `backend`, `model`, `project`, `profile`, plus `agentKind`, `includeArchived` and
 * `includeEstimated`. A missing `from`/`to` means the last 30 days ending now.
 */
export type StatsGranularity = 'hour' | 'day' | 'week' | 'month';
export type StatsDimension = 'backend' | 'model' | 'profile' | 'project' | 'mode' | 'tool';
export type StatsSplit = 'backend' | 'model' | 'project';
export type StatsAgentKind = 'main' | 'subagent' | 'all';
/** `totalTokens` is input + cache read + cache write + output, counting only the parts that were reported. */
export type StatsSeriesMetric = 'totalTokens' | 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'runs' | 'sessions' | 'durationMs';
export interface StatsFilter {
  from: string; to: string; tz: string;
  backends?: NativeBackendId[]; models?: string[]; projects?: string[]; profiles?: string[];
  agentKind?: StatsAgentKind; includeArchived?: boolean; includeEstimated?: boolean;
}
/**
 * Token totals. `input` is input that missed the cache, on every provider. A field is `null` when
 * no record in the aggregate reported it at all (Cursor never reports input), never when it is
 * zero. `estimatedOutput` is the part of `output` that was estimated from text rather than reported.
 */
export interface StatsTokens {
  input: number | null; cacheRead: number | null; cacheWrite: number | null;
  output: number | null; reasoning: number | null; estimatedOutput: number;
}
export interface StatsRunStates { completed: number; failed: number; cancelled: number; interrupted: number; }
/** Display identity of one group. `backendId` is set when the group belongs to a single backend. */
export interface StatsKeyInfo { key: string; label: string; backendId?: NativeBackendId; }
export interface StatsPercentiles { p50: number; p90: number; p99: number; samples: number; }
export interface StatsTotals {
  sessions: number; runs: number; states: StatsRunStates; activeDays: number;
  tokens: StatsTokens; totalTokens: number;
  toolCalls: number; subagents: number;
  /** cacheRead / (input + cacheRead) over the records that reported both; null when none did. */
  cacheHitRate: number | null;
  ttftMs: StatsPercentiles | null; durationMs: StatsPercentiles | null; outputTokensPerSecond: StatsPercentiles | null;
}
/** `previous` is the window of equal length immediately before `from`. */
export interface StatsSummary { current: StatsTotals; previous: StatsTotals; streakDays: number; }
export interface StatsSeriesPoint { start: string; values: Record<string, number>; }
export interface StatsSeries {
  metric: StatsSeriesMetric; granularity: StatsGranularity; split: StatsSplit;
  keys: StatsKeyInfo[]; points: StatsSeriesPoint[];
}
export interface StatsBreakdownRow extends StatsKeyInfo {
  /** Runs for every dimension except `tool`, where it is the number of calls. */
  count: number; sessions: number; states: StatsRunStates;
  tokens: StatsTokens; totalTokens: number; share: number;
  /** Tool dimension only: calls that reported a failure. */
  failed?: number;
  durationMs: StatsPercentiles | null; outputTokensPerSecond: StatsPercentiles | null;
}
export interface StatsBreakdown { dimension: StatsDimension; rows: StatsBreakdownRow[]; }
export interface StatsLatencyRow extends StatsKeyInfo {
  ttftMs: StatsPercentiles | null; durationMs: StatsPercentiles | null;
  queueMs: StatsPercentiles | null; outputTokensPerSecond: StatsPercentiles | null;
  /** Measurement windows that contributed to `outputTokensPerSecond`. */
  windows: MetricsWindow[];
}
export interface StatsLatency { dimension: 'backend' | 'model'; rows: StatsLatencyRow[]; }
/** `weekHour[weekday][hour]` counts runs, Monday first, in the requested zone. */
export interface StatsHeatmap {
  weekHour: number[][];
  calendar: Array<{ date: string; runs: number; totalTokens: number }>;
}
export interface StatsRunRow {
  runId: string; sessionId: string; sessionTitle: string; projectId: string; projectName: string;
  backendId: NativeBackendId; model?: string; state: Run['state']; createdAt: string;
  durationMs: number | null; ttftMs: number | null; tokens: StatsTokens; totalTokens: number; toolCalls: number;
}
export interface StatsRunsPage { rows: StatsRunRow[]; nextCursor?: string; }
/** Everything the first paint needs, so a phone makes one request. */
export interface StatsDashboard {
  filter: StatsFilter; generatedAt: string;
  summary: StatsSummary; series: StatsSeries;
  backends: StatsBreakdown; models: StatsBreakdown; tools: StatsBreakdown;
  heatmap: StatsHeatmap;
  /** Choices for the filter bar, drawn from all recorded data regardless of the current filter. */
  options: { backends: StatsKeyInfo[]; models: StatsKeyInfo[]; projects: StatsKeyInfo[]; profiles: StatsKeyInfo[] };
}
/** Frames of `GET /api/stats/stream`: a hint to refetch, carrying no data of its own. */
export type StatsStreamMessage = { type: 'stats_changed'; at: string };
