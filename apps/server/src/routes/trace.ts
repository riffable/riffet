import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { TRACE_BUDGET } from '../../../../packages/contracts/src/budgets.js';
import type { SyncLane } from '../../../../packages/contracts/src/sync.js';
import type { TraceLane, TracePage, TraceRequests, TraceRowDetail, TraceSummary } from '../../../../packages/contracts/src/trace.js';
import { AppError } from '../errors.js';
import { servingKey } from '../journal/ingest.js';
import { laneOfKey } from '../journal/journal.js';
import { traceDetailOf, traceRowOf } from '../journal/trace.js';
import { encodingFor } from '../static-assets.js';
import { sessionUsageSteps } from '../stats/query.js';
import type { RouteDeps } from './deps.js';

/*
 * The session trace (docs/TRACE.md): a conversation's journal read as written, for the trace view, and what its
 * model requests were sent with, read from the agent's own stored transcript. The journal reads are of this
 * server's own rows and the request read of the agent's files on this server; nothing is folded, cached or forwarded. Under `/api/sessions/:id`, so
 * the session visibility hook (`native/client-features.ts`) applies.
 */

const gzipAsync = promisify(gzip);
/** Answers smaller than this go uncompressed: gzip would cost more than it saves. */
const GZIP_MIN_BYTES = 16 * 1024;

type LaneQuery = { lane?: string; generation?: string };

function laneOf(value: string | undefined): SyncLane {
  if (value === undefined || value === '' || value === 'main') return 'main';
  if (value.startsWith('sub:') && value.length > 4 && value.length <= 204) return value as SyncLane;
  throw new AppError('INVALID_TRACE_LANE', 'lane is main or sub:<toolCallId>');
}

function countOf(value: string | undefined, fallback: number, max: number): number {
  if (value === undefined || value === '') return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new AppError('INVALID_TRACE_QUERY', 'Expected a non-negative integer');
  return Math.min(number, max);
}

/** JSON, gzipped when the client takes it and the answer is large: an index page of a long conversation is megabytes of repeated keys. */
async function sendJson(request: FastifyRequest, reply: FastifyReply, body: unknown): Promise<FastifyReply> {
  const text = JSON.stringify(body);
  reply.type('application/json; charset=utf-8').header('Cache-Control', 'no-store').header('Vary', 'Accept-Encoding');
  if (text.length < GZIP_MIN_BYTES || encodingFor(request.headers['accept-encoding'], ['gzip', 'identity']) !== 'gzip') return reply.send(text);
  return reply.header('Content-Encoding', 'gzip').send(await gzipAsync(text));
}

export function registerTraceRoutes(app: FastifyInstance, deps: Pick<RouteDeps, 'store' | 'nativeBackends'>): void {
  const { store, nativeBackends } = deps;
  const journal = store.journal;

  /** The log a lane is served from, refusing a generation the reader no longer holds. */
  const logOf = (sessionId: string, lane: SyncLane, generation: string | undefined) => {
    const { key, scratch } = servingKey(journal, sessionId, lane);
    const head = journal.peek(key);
    if (!head) throw new AppError('TRACE_LANE_NOT_FOUND', 'This conversation has no such lane', 404);
    if (generation !== undefined && generation !== '' && generation !== head.generation) {
      throw new AppError('TRACE_GENERATION_CHANGED', 'The lane started over under a new generation', 409, { generation: head.generation });
    }
    return { key, scratch, head };
  };

  app.get<{ Params: { id: string } }>('/api/sessions/:id/trace', async (request, reply) => {
    const session = store.getSession(request.params.id);
    const subagents = new Map<string, { toolCallId?: string; title?: string; subagentType?: string; model?: string }>();
    for (const row of journal.subagentEntities(session.id)) {
      const payload = row.payload as Record<string, unknown> | null;
      const lane = typeof payload?.lane === 'string' ? payload.lane : undefined;
      if (!lane) continue;
      const pick = (name: string) => typeof payload?.[name] === 'string' && payload[name] ? { [name]: payload[name] as string } : {};
      subagents.set(lane, { ...pick('toolCallId'), ...pick('title'), ...pick('subagentType'), ...pick('model') });
    }
    const lanes: TraceLane[] = [];
    const seen = new Set<SyncLane>();
    for (const key of journal.keysOf(session.id)) {
      const named = laneOfKey(key);
      if (!named || seen.has(named.lane)) continue;
      seen.add(named.lane);
      const { key: serving, scratch, head } = logOf(session.id, named.lane, undefined);
      lanes.push({
        lane: named.lane, generation: head.generation, lastSeq: head.lastSeq, rows: journal.rowCount(serving),
        ...(scratch ? { importing: true as const } : {}), ...(subagents.get(named.lane) ?? {}),
      });
    }
    lanes.sort((a, b) => a.lane === 'main' ? -1 : b.lane === 'main' ? 1 : 0);
    const { steps, truncated } = sessionUsageSteps(store.db, session.id, TRACE_BUDGET.usageSteps);
    const summary: TraceSummary = { sessionId: session.id, lanes, steps, ...(truncated ? { stepsTruncated: true as const } : {}) };
    return sendJson(request, reply, summary);
  });

  app.get<{ Params: { id: string }; Querystring: LaneQuery & { after?: string; limit?: string } }>('/api/sessions/:id/trace/rows', async (request, reply) => {
    const session = store.getSession(request.params.id);
    const lane = laneOf(request.query.lane);
    const { key, head } = logOf(session.id, lane, request.query.generation);
    const after = countOf(request.query.after, 0, Number.MAX_SAFE_INTEGER);
    const limit = Math.max(1, countOf(request.query.limit, TRACE_BUDGET.pageRows, TRACE_BUDGET.maxPageRows));
    const stored = journal.storedRange(key, after, limit);
    const last = stored.at(-1)?.seq;
    const page: TracePage = {
      lane, generation: head.generation, lastSeq: head.lastSeq, rows: stored.map(traceRowOf),
      ...(stored.length === limit && last !== undefined && last < head.lastSeq ? { next: last } : {}),
    };
    return sendJson(request, reply, page);
  });

  app.get<{ Params: { id: string; seq: string }; Querystring: LaneQuery }>('/api/sessions/:id/trace/rows/:seq', async (request, reply) => {
    const session = store.getSession(request.params.id);
    const lane = laneOf(request.query.lane);
    const { key } = logOf(session.id, lane, request.query.generation);
    const seq = countOf(request.params.seq, 0, Number.MAX_SAFE_INTEGER);
    const row = journal.storedRow(key, seq);
    if (!row) throw new AppError('TRACE_ROW_NOT_FOUND', 'This lane has no such row', 404);
    const detail: TraceRowDetail = traceDetailOf(row);
    return sendJson(request, reply, detail);
  });

  // The lane's request context (docs/TRACE.md §2.1). Read whole on each call: the view reads it when first opened and on reload.
  app.get<{ Params: { id: string }; Querystring: { lane?: string } }>('/api/sessions/:id/trace/requests', async (request, reply) => {
    const session = store.getSession(request.params.id);
    const lane = laneOf(request.query.lane);
    const binding = lane === 'main' ? undefined : journal.entity(session.id, `meta:subagent:${lane.slice(4)}`)?.payload as Record<string, unknown> | null | undefined;
    const agentId = typeof binding?.agentId === 'string' ? binding.agentId : undefined;
    const abort = new AbortController();
    const onClose = () => { if (!reply.raw.writableEnded) abort.abort(); };
    request.raw.once('close', onClose);
    try {
      const answer: TraceRequests = await nativeBackends.traceRequests(session.id, lane, agentId, abort.signal);
      return await sendJson(request, reply, answer);
    } finally {
      request.raw.off('close', onClose);
    }
  });
}
