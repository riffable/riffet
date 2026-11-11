import net from 'node:net';

const MAX_FRAME_BYTES = 64 * 1024 * 1024;

interface JsonRpcError { code?: number; message?: string; }
interface JsonRpcMessage {
  jsonrpc?: unknown;
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: JsonRpcError;
}

interface PendingRequest { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout; }

export interface DshRpcPeerHandlers {
  onNotification(method: string, params: Record<string, unknown>): void;
  onRequest(method: string, params: Record<string, unknown>): Promise<unknown> | unknown;
  onClose(error: Error): void;
}

/** Authenticated loopback JSON-RPC peer between the server and one DSH base profile. */
export class DshRpcPeer {
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 0;
  private buffer = Buffer.alloc(0);
  private closed = false;

  constructor(private readonly socket: net.Socket, private readonly handlers: DshRpcPeerHandlers) {
    socket.on('data', (chunk: Buffer) => this.receive(chunk));
    socket.on('error', (error: Error) => this.fail(error));
    socket.on('close', () => this.fail(new Error('DeepSeek Harness bridge disconnected')));
  }

  request<T>(method: string, params: Record<string, unknown>, timeoutMs = 15_000): Promise<T> {
    if (this.closed || this.socket.destroyed) return Promise.reject(new Error('DeepSeek Harness bridge is offline'));
    const id = ++this.nextId;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    if (Buffer.byteLength(payload) > MAX_FRAME_BYTES) return Promise.reject(new Error('DeepSeek Harness bridge request exceeds the frame limit'));
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`DeepSeek Harness bridge request ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer });
      this.socket.write(`${payload}\n`, (error?: Error | null) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(error);
      });
    });
  }

  notify(method: string, params: Record<string, unknown>): void {
    if (this.closed || this.socket.destroyed) return;
    const payload = JSON.stringify({ jsonrpc: '2.0', method, params });
    if (Buffer.byteLength(payload) <= MAX_FRAME_BYTES) this.socket.write(`${payload}\n`);
  }

  destroy(): void {
    if (this.closed) return;
    this.socket.destroy();
    this.fail(new Error('DeepSeek Harness bridge stopped'));
  }

  private receive(chunk: Buffer): void {
    if (this.closed) return;
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset);
      if (newline < 0) {
        const tail = chunk.subarray(offset);
        if (this.buffer.length + tail.length > MAX_FRAME_BYTES) { this.destroy(); return; }
        this.buffer = this.buffer.length ? Buffer.concat([this.buffer, tail]) : tail;
        return;
      }
      const segment = chunk.subarray(offset, newline);
      const frame = this.buffer.length ? Buffer.concat([this.buffer, segment]) : segment;
      this.buffer = Buffer.alloc(0);
      if (frame.length > MAX_FRAME_BYTES) { this.destroy(); return; }
      offset = newline + 1;
      if (frame.length === 0) continue;
      let decoded: unknown;
      try { decoded = JSON.parse(frame.toString('utf8')) as unknown; } catch { this.destroy(); return; }
      const message = asMessage(decoded);
      if (!message || message.jsonrpc !== '2.0') { this.destroy(); return; }
      if (typeof message.method === 'string') {
        if (message.id === undefined) this.dispatchNotification(message);
        else void this.dispatchRequest(message);
      } else if (typeof message.id === 'number') {
        this.dispatchResponse(message);
      }
    }
  }

  private dispatchNotification(message: JsonRpcMessage): void {
    const params = asRecord(message.params) ?? {};
    try { this.handlers.onNotification(message.method as string, params); } catch { /* bridge notifications never own a request */ }
  }

  private async dispatchRequest(message: JsonRpcMessage): Promise<void> {
    const params = asRecord(message.params) ?? {};
    try {
      const result = await this.handlers.onRequest(message.method as string, params);
      this.writeResponse(message.id, { result });
    } catch (error) {
      this.writeResponse(message.id, { error: { code: -32000, message: error instanceof Error ? error.message : String(error) } });
    }
  }

  private dispatchResponse(message: JsonRpcMessage): void {
    const pending = this.pending.get(message.id as number);
    if (!pending) return;
    this.pending.delete(message.id as number);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(message.error.message ?? 'DeepSeek Harness bridge request failed'));
    else pending.resolve(message.result);
  }

  private writeResponse(id: string | number | undefined, result: { result: unknown } | { error: JsonRpcError }): void {
    if (id === undefined || this.closed || this.socket.destroyed) return;
    this.socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...result })}\n`);
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.handlers.onClose(error);
  }
}

function asMessage(value: unknown): JsonRpcMessage | undefined {
  return asRecord(value) as JsonRpcMessage | undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
