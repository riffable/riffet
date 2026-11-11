import type { Readable, Writable } from 'node:stream';

/*
 * pi's RPC mode is newline-delimited JSON, not JSON-RPC 2.0 (docs/PI.md): every command names its
 * `type`, and every answer is `{type:"response", command, success, data|error}`. Records are split on
 * LF only — U+2028/U+2029 are legal inside JSON strings — and a CR before LF is accepted.
 */

/** A request or record larger than this is a protocol fault, not a slow model. */
const MAX_FRAME_BYTES = 64 * 1024 * 1024;

export class PiRpcError extends Error {
  constructor(message: string, readonly command?: string) {
    super(message);
    this.name = 'PiRpcError';
  }
}

interface PendingRequest {
  resolve(value: Record<string, unknown>): void;
  reject(error: Error): void;
  timer?: NodeJS.Timeout;
}

interface QueueEntry {
  readonly id?: string;
  readonly payload: string;
  expired: boolean;
  /** Present for a frame whose caller needs to know whether it reached stdin. */
  write?: { resolve(): void; reject(error: Error): void };
}

export interface PiRpcHandlers {
  /** Every record that is not a command response: session events and extension UI requests. */
  onEvent(frame: Record<string, unknown>): void;
  /** The transport closed; later requests fail and the process behind it is unusable. */
  onClose?(error: Error): void;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** pi reports a refusal either as `{message}` or as a plain string. */
function errorText(error: unknown): string | undefined {
  if (typeof error === 'string' && error.trim()) return error.trim();
  const value = asRecord(error);
  const message = value?.message;
  if (typeof message === 'string' && message.trim()) return message.trim();
  if (typeof value?.error === 'string' && value.error.trim()) return value.error.trim();
  return undefined;
}

/**
 * The JSONL endpoint of one `pi --mode rpc` child.
 *
 * Writes are serialized and honour stdin backpressure: a prompt carrying images can be larger than
 * the pipe buffer, and interleaving two half-written frames would corrupt the stream. A frame that
 * times out while still queued is dropped before it can reach pi; one already written is never
 * replayed, so its outcome stays unknown. Request ids are chosen here (`riffet:<n>`) so a retried
 * command cannot silently reuse an in-flight id.
 */
export class PiRpcTransport {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly queue: QueueEntry[] = [];
  private nextId = 0;
  private buffer = Buffer.alloc(0);
  private writing = false;
  private current?: QueueEntry;
  private closed = false;

  constructor(private readonly input: Writable, output: Readable, private readonly handlers: PiRpcHandlers) {
    output.on('data', (chunk: Buffer) => this.receive(chunk));
    output.on('end', () => this.close(new PiRpcError('pi closed its output')));
    output.on('close', () => this.close(new PiRpcError('pi closed its output')));
    output.on('error', (error: Error) => this.close(error));
    input.on('error', (error: Error) => this.close(error));
    input.on('close', () => this.close(new PiRpcError('pi closed its input')));
  }

  get isClosed(): boolean { return this.closed; }

  request(command: Record<string, unknown>, options: { id?: string; timeoutMs?: number; onWritten?(): void } = {}): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(new PiRpcError('pi is not running'));
    const type = typeof command.type === 'string' ? command.type : 'command';
    const id = options.id ?? `riffet:${++this.nextId}`;
    if (this.pending.has(id)) return Promise.reject(new PiRpcError(`Duplicate pi request id ${id}`, type));
    const payload = JSON.stringify({ ...command, id });
    if (Buffer.byteLength(payload) > MAX_FRAME_BYTES) return Promise.reject(new PiRpcError(`The pi ${type} request exceeds the frame limit`, type));
    const entry: QueueEntry = { id, payload, expired: false };
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = options.timeoutMs === 0 ? undefined : setTimeout(() => {
        this.pending.delete(id);
        // Still queued: drop it so a late timeout cannot send a prompt nobody waits for any more.
        entry.expired = true;
        const index = this.queue.indexOf(entry);
        if (index >= 0) this.queue.splice(index, 1);
        reject(new PiRpcError(`pi did not answer ${type} in time`, type));
      }, options.timeoutMs ?? 30_000);
      timer?.unref();
      this.pending.set(id, { resolve, reject, timer });
      if (options.onWritten) entry.write = { resolve: options.onWritten, reject };
      this.queue.push(entry);
      this.flush();
    });
  }

  /**
   * Writes a frame that has no response (an extension UI answer). The promise settles once the bytes
   * are handed to stdin, so a caller never reports an interaction as completed on a silent drop.
   */
  async send(frame: Record<string, unknown>): Promise<void> {
    if (this.closed) throw new PiRpcError('pi is not running');
    const payload = JSON.stringify(frame);
    if (Buffer.byteLength(payload) > MAX_FRAME_BYTES) throw new PiRpcError('The pi answer exceeds the frame limit');
    await new Promise<void>((resolve, reject) => {
      this.queue.push({ payload, expired: false, write: { resolve, reject } });
      this.flush();
    });
  }

  /** Rejects every outstanding request; later calls fail fast. */
  close(error: Error = new PiRpcError('pi stopped')): void {
    if (this.closed) return;
    this.closed = true;
    this.current?.write?.reject(error);
    this.current = undefined;
    for (const queued of this.queue) queued.write?.reject(error);
    this.queue.length = 0;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.handlers.onClose?.(error);
  }

  private flush(): void {
    if (this.writing || this.closed) return;
    const next = this.queue.shift();
    if (!next) return;
    if (next.expired) { this.flush(); return; }
    this.writing = true;
    this.current = next;
    let settled = false;
    const done = (error?: Error | null) => {
      if (settled) return;
      settled = true;
      this.writing = false;
      this.current = undefined;
      if (this.closed) return;
      const write = next.write;
      if (error) {
        write?.reject(error);
        this.close(error);
        return;
      }
      write?.resolve();
      this.flush();
    };
    try {
      this.input.write(`${next.payload}\n`, done);
    } catch (error) {
      done(error as Error);
    }
  }

  private receive(chunk: Buffer): void {
    if (this.closed) return;
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset);
      if (newline < 0) {
        const tail = chunk.subarray(offset);
        if (this.buffer.length + tail.length > MAX_FRAME_BYTES) { this.close(new PiRpcError('pi sent a frame larger than the limit')); return; }
        this.buffer = this.buffer.length ? Buffer.concat([this.buffer, tail]) : tail;
        return;
      }
      const segment = chunk.subarray(offset, newline);
      const line = this.buffer.length ? Buffer.concat([this.buffer, segment]) : segment;
      this.buffer = Buffer.alloc(0);
      offset = newline + 1;
      if (line.length > MAX_FRAME_BYTES) { this.close(new PiRpcError('pi sent a frame larger than the limit')); return; }
      const text = line.toString('utf8').replace(/\r$/, '');
      if (text) this.dispatch(text);
    }
  }

  private dispatch(line: string): void {
    let decoded: unknown;
    // stdout is reserved for JSONL, but a stray diagnostic must not end the conversation.
    try { decoded = JSON.parse(line); } catch { return; }
    const frame = asRecord(decoded);
    if (!frame) return;
    if (frame.type === 'response') {
      const id = typeof frame.id === 'string' || typeof frame.id === 'number' ? String(frame.id) : undefined;
      if (id === undefined) return;
      const pending = this.pending.get(id);
      // A response after its timeout is ignored: the request was already reported as unknown.
      if (!pending) return;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (frame.success === false) {
        const message = errorText(frame.error) ?? `${typeof frame.command === 'string' ? frame.command : 'pi'} was refused`;
        pending.reject(new PiRpcError(message, typeof frame.command === 'string' ? frame.command : undefined));
        return;
      }
      pending.resolve(asRecord(frame.data) ?? {});
      return;
    }
    try { this.handlers.onEvent(frame); } catch { /* one bad event must not stop the stream */ }
  }
}
