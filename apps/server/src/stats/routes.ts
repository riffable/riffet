import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ServerResponse } from 'node:http';
import { z } from 'zod';
import type { StatsRunRow } from '../../../../packages/contracts/src/index.js';
import { AppError } from '../errors.js';
import type { Store } from '../store.js';
import type { Auth } from '../auth.js';
import { validZone } from './buckets.js';
import { AuxiliaryStats } from './auxiliary.js';
import { StatsQuery, type ResolvedFilter, type StatsLabels } from './query.js';
import { sendsQuickChat } from '../chat/quick-chat.js';
import { clientSupportsFeature, hiddenBackendIds, hidesPluginAgents } from '../native/client-features.js';

const DAY = 86_400_000;

export interface StatsRouteDeps {
  store: Store;
  auth: Pick<Auth,'onRevoke'>;
  /** Fires when recorded statistics change; drives `GET /api/stats/stream`. */
  subscribe(listener: () => void): () => void;
  profileLabel?(backendId: string, profileId: string): string | undefined;
  backendLabel?(backendId: string): string | undefined;
  /** Open SSE responses, so the server can end them on shutdown. */
  streams?: Set<ServerResponse>;
  now?(): number;
}

const many = z.union([z.string(), z.array(z.string())]).optional()
  .transform(value => (value === undefined ? [] : Array.isArray(value) ? value : [value]).map(item => item.trim()).filter(Boolean))
  .refine(values => values.length <= 100 && values.every(item => item.length <= 200), 'Too many or too long filter values');
const flag = (fallback: boolean) => z.enum(['true', 'false', '1', '0']).optional().transform(value => value === undefined ? fallback : value === 'true' || value === '1');

const FilterQuery = z.object({
  from: z.string().max(64).optional(),
  to: z.string().max(64).optional(),
  tz: z.string().max(100).optional(),
  backend: many, model: many, project: many, profile: many,
  agentKind: z.enum(['main', 'subagent', 'all']).optional(),
  includeArchived: flag(true),
  includeEstimated: flag(true),
});
const SeriesQuery = z.object({
  metric: z.enum(['totalTokens', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'runs', 'sessions', 'durationMs']).default('totalTokens'),
  granularity: z.enum(['hour', 'day', 'week', 'month']).optional(),
  split: z.enum(['backend', 'model', 'project']).default('backend'),
});
const BreakdownQuery = z.object({ dimension: z.enum(['backend', 'model', 'profile', 'project', 'mode', 'tool', 'effort']).default('backend') });
const LatencyQuery = z.object({ dimension: z.enum(['backend', 'model']).default('model') });
const LeaderboardQuery = z.object({
  category: z.enum(['short', 'stream', 'long', 'agent']).default('short'),
  source: z.enum(['all', 'live', 'probe']).default('all'),
  days: z.coerce.number().int().min(1).max(365).default(30),
});
const RunsQuery = z.object({ cursor: z.string().max(500).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) });
const ExportQuery = z.object({ format: z.enum(['csv', 'json']).default('csv') });

function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value ?? {});
  if (!result.success) throw new AppError('INVALID_STATS_QUERY', result.error.issues.map(issue => `${issue.path.join('.') || 'query'}: ${issue.message}`).join('; '));
  return result.data;
}

function instant(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new AppError('INVALID_STATS_QUERY', `${name} must be an ISO date-time`);
  return parsed;
}

export function parseFilter(query: unknown, now: number): ResolvedFilter {
  const raw = parse(FilterQuery, query);
  const to = instant(raw.to, 'to') ?? now + 1;
  const from = instant(raw.from, 'from') ?? to - 30 * DAY;
  if (from >= to) throw new AppError('INVALID_STATS_QUERY', 'from must be earlier than to');
  return {
    from, to, tz: validZone(raw.tz),
    backends: raw.backend, models: raw.model, projects: raw.project, profiles: raw.profile,
    agentKind: raw.agentKind ?? 'all', includeArchived: raw.includeArchived, includeEstimated: raw.includeEstimated,
  };
}

function decodeCursor(value: string | undefined): { createdAt: number; runId: string } | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (Array.isArray(parsed) && Number.isSafeInteger(parsed[0]) && typeof parsed[1] === 'string') return { createdAt: parsed[0], runId: parsed[1] };
  } catch { /* fall through */ }
  throw new AppError('INVALID_STATS_QUERY', 'cursor is invalid');
}

const CSV_COLUMNS: Array<[string, (row: StatsRunRow) => unknown]> = [
  ['run_id', row => row.runId], ['session_id', row => row.sessionId], ['session_title', row => row.sessionTitle],
  ['project', row => row.projectName], ['backend', row => row.backendId], ['model', row => row.model],
  ['state', row => row.state], ['created_at', row => row.createdAt], ['duration_ms', row => row.durationMs], ['ttft_ms', row => row.ttftMs],
  ['input_tokens', row => row.tokens.input], ['cache_read_tokens', row => row.tokens.cacheRead], ['cache_write_tokens', row => row.tokens.cacheWrite],
  ['output_tokens', row => row.tokens.output], ['reasoning_tokens', row => row.tokens.reasoning], ['estimated_output_tokens', row => row.tokens.estimatedOutput],
  ['tool_calls', row => row.toolCalls],
];

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(rows: readonly StatsRunRow[]): string {
  return [CSV_COLUMNS.map(([name]) => name).join(','), ...rows.map(row => CSV_COLUMNS.map(([, pick]) => csvCell(pick(row))).join(','))].join('\r\n') + '\r\n';
}

/** `/api/stats/*` (docs/STATS.md §3.4). Authentication is the app's global `/api/` hook. */
export function registerStatsRoutes(app: FastifyInstance, deps: StatsRouteDeps): void {
  const now = () => deps.now?.() ?? Date.now();
  const labels = (): StatsLabels => {
    const projects = new Map(deps.store.listProjects().map(project => [project.id, project.name]));
    return {
      projectName: id => projects.get(id),
      profileLabel: (backendId, profileId) => { try { return deps.profileLabel?.(backendId, profileId); } catch { return undefined; } },
      backendLabel: backendId => deps.backendLabel?.(backendId),
    };
  };
  const context = (request: FastifyRequest) => {
    const hidden = [...(sendsQuickChat(request) ? [] : ['chat']), ...hiddenBackendIds(request.headers)];
    return {
      filter: { ...parseFilter(request.query, now()), excludeTaskWorkspaces: !clientSupportsFeature(request.headers, 'projectless-tasks'), ...(hidden.length ? { hiddenBackends: hidden } : {}), ...(hidesPluginAgents(request.headers) ? { hidePluginAgents: true } : {}) },
      stats: new StatsQuery(deps.store.db, labels(), now),
    };
  };

  app.get('/api/stats/dashboard', async request => {
    const { filter, stats } = context(request);
    return stats.dashboard(filter);
  });
  app.get('/api/stats/series', async request => {
    const { filter, stats } = context(request);
    const { metric, granularity, split } = parse(SeriesQuery.passthrough(), request.query);
    return stats.series(filter, metric, granularity, split);
  });
  app.get('/api/stats/breakdown', async request => {
    const { filter, stats } = context(request);
    return stats.breakdown(filter, parse(BreakdownQuery.passthrough(), request.query).dimension);
  });
  app.get('/api/stats/latency', async request => {
    const { filter, stats } = context(request);
    return stats.latency(filter, parse(LatencyQuery.passthrough(), request.query).dimension);
  });
  app.get('/api/stats/leaderboard', async request => {
    const { category, source, days } = parse(LeaderboardQuery.passthrough(), request.query);
    const hidden = [...(sendsQuickChat(request) ? [] : ['chat']), ...hiddenBackendIds(request.headers)];
    const auxiliaryStats = new AuxiliaryStats(deps.store.db, { now });
    return auxiliaryStats.leaderboard({
      category,
      source,
      days,
      labels: labels(),
      ...(hidden.length ? { hiddenBackends: hidden } : {}),
      ...(hidesPluginAgents(request.headers) ? { hidePluginAgents: true } : {}),
    });
  });
  app.get('/api/stats/heatmap', async request => {
    const { filter, stats } = context(request);
    return stats.heatmap(filter);
  });
  app.get('/api/stats/runs', async request => {
    const { filter, stats } = context(request);
    const { cursor, limit } = parse(RunsQuery.passthrough(), request.query);
    return stats.runsPage(filter, decodeCursor(cursor), limit);
  });
  app.get('/api/stats/export', async (request, reply) => {
    const { filter, stats } = context(request);
    const { format } = parse(ExportQuery.passthrough(), request.query);
    const rows = stats.exportRows(filter);
    const name = `riffet-stats-${new Date(now()).toISOString().slice(0, 10)}.${format}`;
    reply.header('Content-Disposition', `attachment; filename="${name}"`);
    if (format === 'json') return reply.type('application/json; charset=utf-8').send(JSON.stringify(rows));
    return reply.type('text/csv; charset=utf-8').send(toCsv(rows));
  });
  app.get('/api/stats/stream', async (request, reply) => {
    const unwatch=deps.auth.onRevoke(request,()=>reply.raw.destroy());
    reply.raw.once('close',unwatch);
    reply.hijack();
    const response = reply.raw;
    deps.streams?.add(response);
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const send = () => {
      if (response.destroyed || response.writableEnded) return;
      response.write(`data: ${JSON.stringify({ type: 'stats_changed', at: new Date(now()).toISOString() })}\n\n`);
    };
    send();
    const unsubscribe = deps.subscribe(send);
    // Project names and managed-task visibility can change without another usage record.
    let projectRevision = deps.store.projectRevision;
    const unsubscribeProjects = deps.store.onListsChanged(() => {
      if (projectRevision === deps.store.projectRevision) return;
      projectRevision = deps.store.projectRevision;
      send();
    });
    const heartbeat = setInterval(() => { if (!response.destroyed) response.write(': ping\n\n'); }, 25_000);
    response.on('close', () => { clearInterval(heartbeat); unsubscribe(); unsubscribeProjects(); deps.streams?.delete(response); });
  });
}
