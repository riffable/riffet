import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { SyncLane } from '../../../../packages/contracts/src/sync.js';
import { AppError } from '../errors.js';
import { encodingFor } from '../static-assets.js';
import { SyncConnection } from '../sync/connection.js';
import type { SyncService } from '../sync/service.js';
import type { SessionMedia } from '../timeline/media.js';
import type { Budget, TimelineService } from '../timeline/service.js';
import type { TurnSummaryService } from '../turn-summary/service.js';
import type { RouteDeps } from './deps.js';
import { clientSupportsFeature, sessionReferenceRowsForClient } from '../native/client-features.js';

/*
 * Sync protocol v3 (docs/SYNC-V3.md, 传输): one SSE stream per lane, and the timeline read by place, by
 * seq and by turn over plain requests. Auth, host and origin checks are the API's (`createApp`).
 * `budget` is in bytes and `rows` a row count; both are clamped to `SYNC_BUDGET`.
 */

type LaneQuery = { lane?: string; generation?: string };
type BudgetQuery = { budget?: string; rows?: string };

/** `main`, or `sub:<toolCallId>` with the id a v2 subagent page accepted. */
function laneOf(value: string | undefined): SyncLane {
  if (value === undefined || value === '' || value === 'main') return 'main';
  if (value.startsWith('sub:') && value.length > 4 && value.length <= 204) return value as SyncLane;
  throw new AppError('INVALID_SYNC_LANE', 'lane is main or sub:<toolCallId>');
}

function generationOf(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (value.length > 128) throw new AppError('INVALID_SYNC_GENERATION', 'generation is at most 128 characters');
  return value;
}

/** A lane seq or place; anything else reads as absent. */
function integerOf(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}

function budgetOf(query: BudgetQuery): Budget {
  const bytes = integerOf(query.budget), rows = integerOf(query.rows);
  return { ...(bytes !== undefined ? { bytes } : {}), ...(rows !== undefined ? { rows } : {}) };
}

/** Where the client holds the lane: `Last-Event-ID` (`<generation>:<seq>`, what EventSource resends) over the query. */
function resumeOf(request: FastifyRequest<{ Querystring: LaneQuery & { after?: string } }>): { generation?: string; after?: number } {
  const header = request.headers['last-event-id'];
  const id = Array.isArray(header) ? header[0] : header;
  const split = id ? id.lastIndexOf(':') : -1;
  if (id && split > 0 && split <= 128) {
    const after = integerOf(id.slice(split + 1));
    if (after !== undefined) return { generation: id.slice(0, split), after };
  }
  const generation = generationOf(request.query.generation), after = integerOf(request.query.after);
  return { ...(generation !== undefined ? { generation } : {}), ...(after !== undefined ? { after } : {}) };
}

export function registerSyncRoutes(app: FastifyInstance, deps: RouteDeps & { sync: SyncService; timeline: TimelineService; turnSummaries: TurnSummaryService; sessionMedia: SessionMedia }): void {
  const { store, auth, streams, sync, timeline, turnSummaries, sessionMedia, allowOutsideRead } = deps;
  /** A page or outline asked for under a generation the lane no longer has would mix two of them in the client. */
  const sameGeneration = (sessionId: string, lane: SyncLane, generation: string | undefined) => {
    const current = timeline.head(sessionId, lane)?.generation;
    if (generation !== undefined && current !== undefined && generation !== current) throw new AppError('SYNC_GENERATION_CHANGED', 'The lane started over under a new generation', 409, { generation: current });
  };

  app.get<{ Params: { id: string }; Querystring: LaneQuery & BudgetQuery & { after?: string } }>('/api/v3/sessions/:id/sync', async (request, reply) => {
    const id = request.params.id;
    const session = store.getSession(id);
    if (session.kind !== 'native') throw new AppError('NOT_NATIVE', 'Only native conversations have a CLI transcript', 409);
    const syncRequest = { lane: laneOf(request.query.lane), budget: budgetOf(request.query), ...resumeOf(request) };
    const unwatch = auth.onRevoke(request, () => connection.destroy());
    reply.hijack();
    streams.add(reply.raw);
    const connection = new SyncConnection(reply.raw, { gzip: encodingFor(request.headers['accept-encoding'], ['gzip', 'identity']) === 'gzip', sessionReferences: clientSupportsFeature(request.headers, 'session-references-v1') });
    // A deleted conversation's stream ends; reconnecting answers 410.
    const unwatchDeleted = store.onSessionDeleted(id, () => connection.destroy());
    connection.onClose(() => { unwatch(); unwatchDeleted(); streams.delete(reply.raw); });
    await sync.open(connection, id, syncRequest);
  });

  app.get<{ Params: { id: string }; Querystring: LaneQuery & BudgetQuery & { before?: string; from?: string; around?: string } }>('/api/v3/sessions/:id/timeline', async request => {
    const id = store.getSession(request.params.id).id;
    const lane = laneOf(request.query.lane), generation = generationOf(request.query.generation);
    const places = (['before', 'from', 'around'] as const).flatMap(name => request.query[name] === undefined ? [] : [{ name, pos: integerOf(request.query[name]) }]);
    if (places.length !== 1 || places[0]!.pos === undefined) throw new AppError('INVALID_TIMELINE_POSITION', 'Give exactly one of before, from or around as a row position');
    const { name, pos } = places[0]!;
    await timeline.ready(id, lane);
    sameGeneration(id, lane, generation);
    const budget = budgetOf(request.query);
    const page = timeline.page(id, lane, name === 'before' ? { before: pos!, ...budget } : name === 'from' ? { from: pos!, ...budget } : { around: pos!, ...budget });
    return { ...page, rows: sessionReferenceRowsForClient(page.rows, clientSupportsFeature(request.headers, 'session-references-v1')) };
  });

  app.get<{ Params: { id: string }; Querystring: LaneQuery & BudgetQuery & { after?: string } }>('/api/v3/sessions/:id/timeline/changes', async request => {
    const id = store.getSession(request.params.id).id;
    const lane = laneOf(request.query.lane), generation = generationOf(request.query.generation);
    await timeline.ready(id, lane);
    // Without `after` the client holds nothing: it is sent the newest rows.
    const changes = timeline.changes(id, lane, { ...(generation !== undefined ? { generation } : {}), after: integerOf(request.query.after) ?? -1, ...budgetOf(request.query) });
    return { ...changes, rows: sessionReferenceRowsForClient(changes.rows, clientSupportsFeature(request.headers, 'session-references-v1')) };
  });

  app.get<{ Params: { id: string }; Querystring: LaneQuery }>('/api/v3/sessions/:id/outline', async request => {
    const id = store.getSession(request.params.id).id;
    const lane = laneOf(request.query.lane);
    await timeline.ready(id, lane);
    sameGeneration(id, lane, generationOf(request.query.generation));
    return timeline.outline(id, lane);
  });

  /** One sentence on what a finished turn came to; `{}` while no model is chosen or the turn has no answer. Written on the first request, then kept. */
  app.get<{ Params: { id: string; turn: string } }>('/api/sessions/:id/turns/:turn/summary', async (request, reply) => {
    const id = store.getSession(request.params.id).id;
    const turn = request.params.turn;
    if (!turn || turn.length > 300) throw new AppError('INVALID_TURN', 'turn is a turn key from the outline');
    const controller = new AbortController();
    const abort = () => controller.abort();
    reply.raw.once('close', abort);
    try {
      const summary = await turnSummaries.get(id, turn, controller.signal);
      return summary ? { summary } : {};
    } catch (error) {
      // The client left; nobody reads the answer.
      if (controller.signal.aborted) return {};
      throw error;
    } finally { reply.raw.off('close', abort); }
  });

  /** An image the conversation's own tool calls named, by its path; anything else is a plain 404. */
  app.get<{ Params: { id: string }; Querystring: { path?: string } }>('/api/sessions/:id/media', async (request, reply) => {
    const id = store.getSession(request.params.id).id;
    const image = typeof request.query.path === 'string' ? await sessionMedia.read(id, request.query.path, allowOutsideRead(request.headers)) : undefined;
    if (!image) throw new AppError('NOT_FOUND', 'Not found', 404);
    return reply.type(image.type).header('Cache-Control', 'private, max-age=60').header('X-Content-Type-Options', 'nosniff').send(image.bytes);
  });
}
