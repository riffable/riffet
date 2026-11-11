import type { Readable, Writable } from 'node:stream';

const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const FACTORY_API_VERSION = '1.0.0';
const NOTIFICATION_METHOD = 'droid.session_notification';

/** Codes Droid documents for its JSON-RPC errors. */
export const DROID_RPC_ERRORS = {
  unauthorized: -32001,
  notFound: -32004,
  disconnected: -32005,
  conflict: -32006,
} as const;

export class DroidRpcError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
    this.name = 'DroidRpcError';
  }
}

interface PendingRequest { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout; }

/** Returned from `onRequest` for a request Droid already settled itself: no response is written. */
export const DROID_NO_REPLY: unique symbol = Symbol('droid.no-reply');

export interface DroidRpcHandlers {
  /** The `notification` object of a `droid.session_notification` frame. */
  onNotification(notification: Record<string, unknown>): void;
  /** A request Droid sends us (`droid.request_permission`, `droid.ask_user`); the value is its result. */
  onRequest(method: string, params: Record<string, unknown>, id: string): Promise<unknown>;
  /** The transport closed; later requests fail, so the process behind it is no longer usable. */
  onClose?(error: Error): void;
}

/**
 * Newline-delimited JSON-RPC over one `droid exec --input-format stream-jsonrpc` child's stdio.
 *
 * Droid wraps JSON-RPC in its own envelope: every frame names its `type` and the protocol version,
 * and ids are strings. Request ids are chosen by the caller because Droid echoes the id of
 * `droid.add_user_message` on the user message it creates, which is how a turn finds its command.
 */
export class DroidRpcClient {
  private readonly pending = new Map<string, PendingRequest>();
  private nextId = 0;
  private buffer = Buffer.alloc(0);
  private closed = false;

  constructor(private readonly input: Writable, output: Readable, private readonly handlers: DroidRpcHandlers) {
    output.on('data', (chunk: Buffer) => this.receive(chunk));
    input.on('error', (error: Error) => this.close(error));
  }

  get isClosed(): boolean { return this.closed; }

  request<T>(method: string, params: Record<string, unknown>, options: { id?: string; timeoutMs?: number } = {}): Promise<T> {
    if (this.closed) return Promise.reject(new DroidRpcError('Droid is not running', DROID_RPC_ERRORS.disconnected));
    const id = options.id ?? `riffet:${++this.nextId}`;
    if (this.pending.has(id)) return Promise.reject(new DroidRpcError(`Duplicate Droid request id ${id}`));
    const payload = JSON.stringify({ jsonrpc: '2.0', factoryApiVersion: FACTORY_API_VERSION, type: 'request', id, method, params });
    if (Buffer.byteLength(payload) > MAX_FRAME_BYTES) return Promise.reject(new DroidRpcError('The Droid request exceeds the frame limit'));
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new DroidRpcError(`Droid did not answer ${method} in time`));
      }, options.timeoutMs ?? 30_000);
      timer.unref();
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer });
      this.input.write(`${payload}\n`, (error?: Error | null) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(error);
      });
    });
  }

  /** Rejects every outstanding request; later calls fail fast. */
  close(error: Error = new DroidRpcError('Droid stopped', DROID_RPC_ERRORS.disconnected)): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.handlers.onClose?.(error);
  }

  private receive(chunk: Buffer): void {
    if (this.closed) return;
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset);
      if (newline < 0) {
        const tail = chunk.subarray(offset);
        if (this.buffer.length + tail.length > MAX_FRAME_BYTES) { this.close(new DroidRpcError('Droid sent a frame larger than the limit')); return; }
        this.buffer = this.buffer.length ? Buffer.concat([this.buffer, tail]) : tail;
        return;
      }
      const segment = chunk.subarray(offset, newline);
      const line = this.buffer.length ? Buffer.concat([this.buffer, segment]) : segment;
      this.buffer = Buffer.alloc(0);
      offset = newline + 1;
      if (line.length > MAX_FRAME_BYTES) { this.close(new DroidRpcError('Droid sent a frame larger than the limit')); return; }
      if (line.length) this.dispatch(line.toString('utf8'));
    }
  }

  private dispatch(line: string): void {
    let decoded: unknown;
    // Droid only writes frames to stdout, but a stray log line must not end the session.
    try { decoded = JSON.parse(line); } catch { return; }
    const frame = asRecord(decoded);
    if (!frame) return;
    const id = typeof frame.id === 'string' || typeof frame.id === 'number' ? String(frame.id) : undefined;
    if (frame.type === 'response' && id !== undefined) {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      const error = asRecord(frame.error);
      if (error) pending.reject(new DroidRpcError(typeof error.message === 'string' ? error.message : 'Droid request failed', typeof error.code === 'number' ? error.code : undefined));
      else pending.resolve(frame.result);
      return;
    }
    if (typeof frame.method !== 'string') return;
    const params = asRecord(frame.params) ?? {};
    if (frame.type === 'request' && id !== undefined) {
      void this.answer(frame.method, params, id);
      return;
    }
    if (frame.method !== NOTIFICATION_METHOD) return;
    const notification = asRecord(params.notification);
    if (!notification) return;
    try { this.handlers.onNotification(notification); } catch { /* one bad notification must not stop the stream */ }
  }

  private async answer(method: string, params: Record<string, unknown>, id: string): Promise<void> {
    let reply: Record<string, unknown>;
    try {
      const result = await this.handlers.onRequest(method, params, id);
      if (result === DROID_NO_REPLY) return;
      reply = { result };
    } catch (error) {
      reply = { error: { code: -32603, message: error instanceof Error ? error.message : String(error) } };
    }
    if (this.closed) return;
    this.input.write(`${JSON.stringify({ jsonrpc: '2.0', factoryApiVersion: FACTORY_API_VERSION, type: 'response', id, ...reply })}\n`);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
