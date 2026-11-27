import { Agent, request, type IncomingMessage } from 'node:http';
import { agyConversationId, agyRecord, agySnapshot, type AgyRecord, type AgySnapshot } from './protocol.js';

const SERVICE = '/exa.language_server_pb.LanguageServerService/';
// Loopback from the verified agy process. A reconnect's first frame and GetCascadeTrajectory both carry the whole
// branch (≈24 KB per executor record, inline file and command output), so a long session passes tens of MB.
const MAX_RESPONSE = 256 * 1024 * 1024;
const MAX_FRAME = 256 * 1024 * 1024;
const MAX_REQUEST = 4 * 1024 * 1024;
const RPC_METHOD = /^[A-Z][A-Za-z0-9]{0,100}$/;
const decoder = new TextDecoder('utf-8', { fatal: true });
function errorMessage(value: unknown): string {
  // Runtime errors sometimes include the configured gateway's credentials. Diagnostics expose no raw response body.
  if (
    agyRecord(value) &&
    typeof value.code === 'string' &&
    /^(canceled|unknown|invalid_argument|deadline_exceeded|not_found|already_exists|permission_denied|resource_exhausted|failed_precondition|aborted|out_of_range|unimplemented|internal|unavailable|data_loss|unauthenticated)$/.test(
      value.code,
    )
  )
    return `Antigravity RPC rejected the request (${value.code})`;
  return 'Antigravity RPC rejected the request';
}
function parsedJson(bytes: Uint8Array): AgyRecord {
  const result: unknown = JSON.parse(decoder.decode(bytes));
  if (!agyRecord(result)) throw new Error('Antigravity RPC returned invalid JSON');
  return result;
}
export class AgyRpcError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'AgyRpcError';
  }
}
/** A framed Connect stream may split a header/body across TCP chunks or combine several frames in one chunk. */
export class AgyFrameDecoder {
  private buffer = Buffer.alloc(0);
  /** Chunks of a frame still arriving, joined once it is complete: re-joining per chunk is quadratic in a large frame. */
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private needed = 5;
  ended = false;
  constructor(private readonly onMessage: (message: AgyRecord) => void) {}
  push(chunk: Uint8Array): void {
    if (this.ended && chunk.byteLength) throw new AgyRpcError('Antigravity stream continued after its trailer');
    this.pending.push(Buffer.from(chunk));
    this.pendingBytes += chunk.byteLength;
    if (this.buffer.length + this.pendingBytes > MAX_FRAME + 5) throw new AgyRpcError('Antigravity stream buffering exceeds its limit');
    if (this.pendingBytes < this.needed) return;
    this.buffer = Buffer.concat([this.buffer, ...this.pending]);
    this.pending = [];
    this.pendingBytes = 0;
    let offset = 0;
    while (this.buffer.length - offset >= 5) {
      const flag = this.buffer[offset]!;
      const length = this.buffer.readUInt32BE(offset + 1);
      if (flag & ~3 || flag & 1) throw new AgyRpcError('Antigravity stream encoding is unsupported');
      if (length > MAX_FRAME) throw new AgyRpcError('Antigravity stream frame exceeds its limit');
      if (this.buffer.length - offset - 5 < length) break;
      let value: AgyRecord;
      try {
        value = flag & 2 && length === 0 ? {} : parsedJson(this.buffer.subarray(offset + 5, offset + 5 + length));
      } catch {
        throw new AgyRpcError('Antigravity stream frame is invalid');
      }
      offset += 5 + length;
      if (flag & 2) {
        this.ended = true;
        if (value.error !== undefined) throw new AgyRpcError(errorMessage(value.error));
        if (offset !== this.buffer.length) throw new AgyRpcError('Antigravity stream continued after its trailer');
        break;
      }
      this.onMessage(value);
    }
    this.buffer = offset === this.buffer.length ? Buffer.alloc(0) : this.buffer.subarray(offset);
    if (this.buffer.length > 0 && this.buffer.buffer.byteLength > Math.max(64 * 1024, this.buffer.length * 4)) {
      this.buffer = Buffer.from(this.buffer);
    }
    this.needed = this.buffer.length >= 5 ? 5 + this.buffer.readUInt32BE(1) - this.buffer.length : 5 - this.buffer.length;
  }
  finish(): void {
    if (this.buffer.length || this.pendingBytes) throw new AgyRpcError('Antigravity stream ended in a partial frame');
    if (!this.ended) throw new AgyRpcError('Antigravity stream ended without a trailer');
  }
}
export class AgyRpc {
  readonly port: number;
  readonly #token: string;
  readonly #agent: Agent;
  constructor(options: { port: number; token: string }) {
    if (!Number.isSafeInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error('Invalid Antigravity RPC port');
    if (!options.token || options.token.length > 4096 || /[\r\n\0]/.test(options.token))
      throw new Error('Invalid Antigravity RPC credential');
    this.port = options.port;
    this.#token = options.token;
    this.#agent = new Agent({ keepAlive: true, maxSockets: 4 });
    this.#agent.on('free', socket => socket.unref());
  }
  close(): void {
    this.#agent.destroy();
  }
  private response(method: string, body: Uint8Array, contentType: string, signal?: AbortSignal): Promise<IncomingMessage> {
    if (!RPC_METHOD.test(method)) return Promise.reject(new Error('Invalid Antigravity RPC method'));
    if (body.byteLength > MAX_REQUEST) return Promise.reject(new Error('Antigravity RPC request exceeds its limit'));
    return new Promise((resolve, reject) => {
      const req = request(
        {
          hostname: '127.0.0.1',
          port: this.port,
          method: 'POST',
          path: SERVICE + method,
          agent: this.#agent,
          signal,
          headers: {
            'Content-Type': contentType,
            'Content-Length': body.byteLength,
            'Connect-Protocol-Version': '1',
            'x-codeium-csrf-token': this.#token,
          },
        },
        resolve,
      );
      const timer = setTimeout(() => req.destroy(new AgyRpcError('Antigravity RPC did not connect in time')), 10_000);
      req.once('response', () => clearTimeout(timer));
      req.once('error', error => {
        clearTimeout(timer);
        reject(signal?.aborted ? signal.reason ?? error : new AgyRpcError('Antigravity RPC connection failed'));
      });
      req.end(body);
    });
  }
  async call(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<AgyRecord> {
    const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
    const response = await this.response(method, Buffer.from(JSON.stringify(body)), 'application/json', combined);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const raw of response) {
      const chunk = Buffer.from(raw as Uint8Array);
      size += chunk.length;
      if (size > MAX_RESPONSE) {
        response.destroy();
        throw new AgyRpcError('Antigravity RPC response exceeds its limit');
      }
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    const status = response.statusCode ?? 0;
    if (status < 200 || status >= 300) {
      let detail: unknown;
      try {
        detail = parsedJson(bytes);
      } catch {
        /* raw HTML/errors never leave the adapter */
      }
      throw new AgyRpcError(errorMessage(detail), status);
    }
    try {
      return parsedJson(bytes);
    } catch {
      throw new AgyRpcError('Antigravity RPC returned invalid JSON');
    }
  }
  async snapshot(conversationId: string, signal?: AbortSignal): Promise<AgySnapshot> {
    agyConversationId(conversationId);
    return agySnapshot(await this.call('GetCascadeTrajectory', { cascadeId: conversationId }, signal), conversationId);
  }
  async stream(conversationId: string, onUpdate: (update: AgyRecord) => void, signal: AbortSignal): Promise<void> {
    agyConversationId(conversationId);
    const json = Buffer.from(JSON.stringify({ conversationId }));
    const body = Buffer.alloc(5 + json.length);
    body.writeUInt32BE(json.length, 1);
    json.copy(body, 5);
    const response = await this.response('StreamAgentStateUpdates', body, 'application/connect+json', signal);
    if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300) {
      response.destroy();
      throw new AgyRpcError('Antigravity stream request was refused', response.statusCode);
    }
    if (!/^application\/connect\+json(?:\s*;|$)/i.test(response.headers['content-type'] ?? '')) {
      response.destroy();
      throw new AgyRpcError('Antigravity stream content type is unsupported');
    }
    const frames = new AgyFrameDecoder(message => {
      if (!agyRecord(message.update)) throw new AgyRpcError('Antigravity stream update is invalid');
      if (message.update.conversationId !== conversationId) throw new AgyRpcError('Antigravity stream belongs to another conversation');
      onUpdate(message.update);
    });
    try {
      for await (const raw of response) {
        frames.push(Buffer.from(raw as Uint8Array));
        if (frames.ended) break;
      }
      if (!signal.aborted) frames.finish();
    } finally {
      response.destroy();
    }
  }
}
