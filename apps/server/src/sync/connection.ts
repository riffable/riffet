import type { ServerResponse } from 'node:http';
import { constants as zlibConstants, createGzip, type Gzip } from 'node:zlib';
import { SYNC_BUDGET, type SyncFrame } from '../../../../packages/contracts/src/sync.js';
import type { TimelineSnapshot } from '../timeline/service.js';
import { sessionReferenceRowsForClient } from '../native/client-features.js';

/*
 * One sync v3 stream (docs/SYNC-V3.md, 传输): an SSE response whose `event:` is the frame type and whose
 * `id:` (`<generation>:<seq>`) marks where a client holds the lane, on rows frames and on a snapshot's
 * final part.
 *
 * Two queues share the connection. A control frame (status, runs, outline, …) is written the moment it
 * arrives. Transcript frames (rows, reset, snapshot parts) are written one per turn of the event loop,
 * and only while what the socket still holds is under about one frame, so a control frame is never
 * queued behind more than one of them. A snapshot is read a part at a time as it goes out.
 *
 * A reader that cannot keep up is let go: over `slowBacklog` at two heartbeats running, or over
 * `maxBacklog` at any moment, counting what the socket, the encoder and the transcript queue hold.
 */

export interface SyncConnectionOptions {
  /** One gzip context for the stream's life, sync-flushed after every write so no frame waits in it. */
  gzip: boolean;
  pingMs?: number;
  slowBacklog?: number;
  maxBacklog?: number;
  sessionReferences?: boolean;
}

type RowsFrame = Extract<SyncFrame, { type: 'rows' }>;
type SnapshotParts = ReturnType<TimelineSnapshot['parts']>;
type Queued = { kind: 'frame'; text: string; bytes: number } | { kind: 'snapshot'; snapshot: TimelineSnapshot; parts: SnapshotParts };

const MB = 1024 * 1024;
/** What the socket may hold before the next transcript frame waits for it to drain. */
const HIGH_WATER = SYNC_BUDGET.frameBytes;
const DRAIN_POLL_MS = 100;
/** How long a reader that was let go has to take what was already written before the socket closes. */
const CLOSE_GRACE_MS = 3_000;

const sse = (frame: SyncFrame, id?: string): string => `event: ${frame.type}\n${id ? `id: ${id}\n` : ''}data: ${JSON.stringify(frame)}\n\n`;

export class SyncConnection {
  private readonly encoder: Gzip | undefined;
  private readonly queue: Queued[] = [];
  private queuedBytes = 0;
  private scheduled = false;
  private waiting = false;
  private lagging = false;
  private readonly heartbeat: ReturnType<typeof setInterval>;
  private closeTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly slowBacklog: number;
  private readonly maxBacklog: number;
  private readonly sessionReferences: boolean;

  /** Takes over `raw`, which the caller has hijacked from its framework, and writes the response head. */
  constructor(private readonly raw: ServerResponse, options: SyncConnectionOptions) {
    this.slowBacklog = options.slowBacklog ?? 8 * MB;
    this.maxBacklog = options.maxBacklog ?? 32 * MB;
    this.sessionReferences = options.sessionReferences ?? true;
    this.encoder = options.gzip ? createGzip() : undefined;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
      ...(this.encoder ? { 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' } : {}),
    });
    if (this.encoder) {
      // Forwarded by hand rather than piped: shutdown ends the response directly, and a piped encoder would then write after its end.
      this.encoder.on('data', (chunk: Buffer) => { if (!raw.destroyed && !raw.writableEnded) raw.write(chunk); });
      this.encoder.on('end', () => { if (!raw.destroyed && !raw.writableEnded) raw.end(); });
      this.encoder.on('error', () => raw.destroy());
    }
    this.heartbeat = setInterval(() => this.beat(), options.pingMs ?? SYNC_BUDGET.pingMs);
    raw.once('close', () => this.dispose());
    this.write('retry: 1000\n: connected\n\n');
  }

  get ended(): boolean { return this.raw.destroyed || this.raw.writableEnded || this.encoder?.writableEnded === true; }

  /** Bytes written but not yet sent, and the transcript frames queued behind them. */
  get backlog(): number { return this.raw.writableLength + (this.encoder?.writableLength ?? 0) + this.queuedBytes; }

  /** Runs `listener` once the response has closed; at once if it has. */
  onClose(listener: () => void): void {
    if (this.raw.destroyed || this.raw.closed) listener(); else this.raw.once('close', listener);
  }

  control(frame: SyncFrame): void {
    if (this.ended) return;
    this.write(sse(frame));
    this.limit();
  }

  rows(frame: RowsFrame): void {
    this.enqueue(sse({ ...frame, upserts: sessionReferenceRowsForClient(frame.upserts, this.sessionReferences) }, `${frame.generation}:${frame.to}`));
  }

  snapshot(snapshot: TimelineSnapshot): void {
    if (this.ended) return;
    this.queue.push({ kind: 'snapshot', snapshot, parts: snapshot.parts() });
    this.pump();
  }

  /** The lane started over: nothing queued for the old generation goes out; the reset and then `snapshot` do. */
  reset(frame: Extract<SyncFrame, { type: 'reset' }>, snapshot: TimelineSnapshot): void {
    this.queue.length = 0;
    this.queuedBytes = 0;
    this.enqueue(sse(frame));
    this.snapshot(snapshot);
  }

  /** Ends the stream at once (a revoked credential, a reader too far behind). */
  destroy(): void {
    this.queue.length = 0;
    this.queuedBytes = 0;
    this.encoder?.destroy();
    this.raw.destroy();
  }

  // ---- writing -----------------------------------------------------------------------------

  private write(text: string): void {
    if (!this.encoder) { this.raw.write(text); return; }
    this.encoder.write(text);
    this.encoder.flush(zlibConstants.Z_SYNC_FLUSH);
  }

  private enqueue(text: string): void {
    if (this.ended) return;
    const bytes = Buffer.byteLength(text);
    this.queue.push({ kind: 'frame', text, bytes });
    this.queuedBytes += bytes;
    if (this.limit()) this.pump();
  }

  private pump(): void {
    if (this.scheduled || this.waiting || !this.queue.length || this.ended) return;
    this.scheduled = true;
    setImmediate(() => { this.scheduled = false; this.step(); });
  }

  /** Writes the next transcript frame, once the socket has taken what came before. */
  private step(): void {
    if (this.ended) return;
    if (this.raw.writableLength + (this.encoder?.writableLength ?? 0) > HIGH_WATER) { this.waitForDrain(); return; }
    const head = this.queue[0];
    if (!head) return;
    if (head.kind === 'frame') {
      this.queue.shift();
      this.queuedBytes -= head.bytes;
      this.write(head.text);
    } else {
      let next: ReturnType<SnapshotParts['next']>;
      try { next = head.parts.next(); }
      catch (error) {
        // The rows could not be read: the client reconnects and is sent a snapshot again.
        console.warn('[sync] reading a snapshot failed:', error);
        this.end();
        return;
      }
      if (next.done || next.value.final) this.queue.shift();
      if (!next.done) {
        const { generation, asOfSeq, hasBefore } = head.snapshot;
        const { part, final, rows } = next.value;
        this.write(sse({ type: 'snapshot', generation, asOfSeq, part, final, rows: sessionReferenceRowsForClient(rows, this.sessionReferences), hasBefore }, final ? `${generation}:${asOfSeq}` : undefined));
      }
    }
    this.pump();
  }

  private waitForDrain(): void {
    if (this.waiting) return;
    this.waiting = true;
    const resume = () => {
      clearTimeout(timer);
      this.raw.off('drain', resume);
      this.waiting = false;
      this.pump();
    };
    // The encoder's own buffer empties without a `drain` on the socket; the poll covers it.
    const timer = setTimeout(resume, DRAIN_POLL_MS);
    this.raw.once('drain', resume);
  }

  /** False, and the stream is gone, when the backlog is past the ceiling. */
  private limit(): boolean {
    if (this.backlog <= this.maxBacklog) return true;
    this.destroy();
    return false;
  }

  private beat(): void {
    if (this.ended) return;
    // A reader is slow only when it is still over the limit a full heartbeat later.
    const behind = this.backlog > this.slowBacklog;
    if (behind && this.lagging) { this.end(); return; }
    this.lagging = behind;
    // A named event rather than a comment: the browser only sees events, and uses this one to spot a dead stream.
    this.write('event: ping\ndata: {}\n\n');
  }

  /** Ends the stream after what was written; the socket goes if the reader does not take it in time. */
  private end(): void {
    if (this.ended) return;
    this.queue.length = 0;
    this.queuedBytes = 0;
    if (this.encoder) this.encoder.end(); else this.raw.end();
    this.closeTimer = setTimeout(() => this.raw.destroy(), CLOSE_GRACE_MS);
    this.closeTimer.unref();
  }

  private dispose(): void {
    clearInterval(this.heartbeat);
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.queue.length = 0;
    this.queuedBytes = 0;
    this.encoder?.destroy();
  }
}
