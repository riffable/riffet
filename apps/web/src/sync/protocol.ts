import type { SyncFrame, SyncLane } from '@contracts';

/*
 * Sync protocol v3 on the wire (docs/SYNC-V3.md, 传输): one SSE stream per (session, lane) and plain
 * JSON reads for pages, the outline and blobs. The engine only sees this interface; `browser.ts`
 * implements it with `EventSource` and the app's request helper, the tests with a fake server.
 */

export const SYNC_PROTOCOL = 3;

export interface StreamListener {
  open(): void;
  /** One SSE event: `type` is its `event:` name, `id` its `id:` when it had one. */
  frame(type: string, data: string, id: string | undefined): void;
  /** `closed`: the stream gave up for good (an HTTP error, an answer that is not SSE); otherwise it redials on its own. */
  error(closed: boolean): void;
}

export interface SyncTransport {
  stream(url: string, listener: StreamListener): { close(): void };
  /** A JSON read with the app's sign-in; an HTTP failure rejects with an error carrying `status` and the server's `code`. */
  get<T>(path: string, signal?: AbortSignal): Promise<T>;
}

/** Every frame type this client reads, and the heartbeat. Anything else a newer server sends is skipped. */
export const FRAME_TYPES = ['hello', 'snapshot', 'rows', 'reset', 'status', 'interaction', 'runs', 'run', 'activities', 'outline', 'context', 'metrics', 'session', 'error', 'caughtUp', 'ping'] as const;
const KNOWN = new Set<string>(FRAME_TYPES);

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isSeq = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/**
 * A frame, or nothing for one this client cannot use: an unknown type, a body that is not JSON, or a
 * transcript frame missing the fields its ordering depends on. Loose by design, like the Kotlin
 * decoder: one bad frame must not end the stream.
 */
export function parseFrame(type: string, data: string): SyncFrame | undefined {
  if (!KNOWN.has(type) || type === 'ping') return undefined;
  let value: unknown;
  try { value = JSON.parse(data); } catch { return undefined; }
  if (!isRecord(value)) return undefined;
  const frame = { ...value, type } as Record<string, unknown>;
  switch (type) {
    case 'hello': return typeof frame.generation === 'string' && isSeq(frame.headSeq) && (frame.mode === 'delta' || frame.mode === 'snapshot') ? frame as SyncFrame : undefined;
    case 'snapshot': return typeof frame.generation === 'string' && isSeq(frame.asOfSeq) && isSeq(frame.part) && Array.isArray(frame.rows) ? frame as SyncFrame : undefined;
    case 'rows': return typeof frame.generation === 'string' && isSeq(frame.from) && isSeq(frame.to) && Array.isArray(frame.upserts) ? frame as SyncFrame : undefined;
    case 'reset': return typeof frame.generation === 'string' ? frame as SyncFrame : undefined;
    case 'caughtUp': return typeof frame.generation === 'string' && isSeq(frame.headSeq) ? frame as SyncFrame : undefined;
    default: return frame as SyncFrame;
  }
}

const sessionPath = (sessionId: string) => `/api/v3/sessions/${encodeURIComponent(sessionId)}`;

/** Where a lane's stream resumes: the generation and lane seq the client holds. */
export interface Resume { generation: string; after: number }

export function syncUrl(sessionId: string, lane: SyncLane, resume?: Resume): string {
  const query = new URLSearchParams({ lane });
  if (resume) {
    query.set('generation', resume.generation);
    query.set('after', String(resume.after));
  }
  return `${sessionPath(sessionId)}/sync?${query.toString()}`;
}

/** A page by place: rows before `before`, from `from` on, or around `around` (`pos` values). */
export type Place = { before: number } | { from: number } | { around: number };

export function timelineUrl(sessionId: string, lane: SyncLane, generation: string, place: Place): string {
  const query = new URLSearchParams({ lane, generation });
  for (const [name, pos] of Object.entries(place)) query.set(name, String(pos));
  return `${sessionPath(sessionId)}/timeline?${query.toString()}`;
}

export function outlineUrl(sessionId: string, lane: SyncLane, generation?: string): string {
  const query = new URLSearchParams({ lane, ...(generation ? { generation } : {}) });
  return `${sessionPath(sessionId)}/outline?${query.toString()}`;
}

export function blobPath(sessionId: string, blobRef: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/blobs/${encodeURIComponent(blobRef)}`;
}

/**
 * The server has no such route: a v2 server answers `/api/v3/...` with the framework's own 404,
 * which carries no app error code (a missing session does).
 */
export function routeMissing(error: unknown): boolean {
  const failure = error as { status?: unknown; code?: unknown } | undefined;
  return failure?.status === 404 && !failure.code;
}

/** The sync protocol a `/health` answer declares; a server from before the field speaks v2. */
export function healthProtocol(health: unknown): number {
  const protocol = isRecord(health) && isRecord(health.protocol) ? health.protocol.version : undefined;
  return typeof protocol === 'number' ? protocol : 2;
}
