import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const MAX_HOOK_BODY = 1024 * 1024;

type HookPayload = Record<string, unknown>;
type HookHandler = (payload: HookPayload, deliveryId: string, signal: AbortSignal) => Promise<Record<string, unknown> | void>;

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const part of request) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
    size += chunk.length;
    if (size > MAX_HOOK_BODY) throw new Error('hook payload is too large');
    chunks.push(chunk);
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('hook payload is invalid');
  return parsed as Record<string, unknown>;
}

/** Private loopback bridge for trusted native CLI hooks. */
export class NativeHookServer {
  readonly token = randomBytes(32).toString('base64url');
  private server?: Server;

  constructor(private readonly handler: HookHandler) {}

  async start(): Promise<{ url: string; token: string }> {
    if (this.server) {
      const address = this.server.address();
      if (address && typeof address === 'object') return { url: `http://127.0.0.1:${address.port}`, token: this.token };
    }
    const server = createServer((request, response) => { void this.handle(request, response); });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => { server.off('listening', onListening); reject(error); };
      const onListening = () => { server.off('error', onError); resolve(); };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(0, '127.0.0.1');
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Native hook bridge did not bind a TCP port');
    return { url: `http://127.0.0.1:${address.port}`, token: this.token };
  }

  private authorized(request: IncomingMessage): boolean {
    const authorization = request.headers.authorization;
    if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return false;
    const candidate = Buffer.from(authorization.slice(7));
    const expected = Buffer.from(this.token);
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (request.method !== 'POST' || request.url !== '/hook') {
      response.statusCode = 404;
      response.end('{}');
      return;
    }
    if (!this.authorized(request)) {
      response.statusCode = 404;
      response.end('{}');
      return;
    }
    let body: Record<string, unknown>;
    try { body = await readJson(request); }
    catch {
      response.statusCode = 400;
      response.end('{}');
      return;
    }
    const deliveryId = typeof body.deliveryId === 'string' && body.deliveryId.length <= 100 ? body.deliveryId : '';
    const payload = body.payload;
    if (!deliveryId || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
      response.statusCode = 400;
      response.end('{}');
      return;
    }
    const controller = new AbortController();
    response.on('close', () => { if (!response.writableEnded) controller.abort(); });
    try {
      const result = await this.handler(payload as HookPayload, deliveryId, controller.signal);
      response.end(JSON.stringify(result ?? {}));
    } catch {
      // Hook diagnostics can contain prompts, tool arguments, or CLI secrets. Fail closed here
      // without echoing them to stdout/stderr or the transcript.
      response.end('{}');
    }
  }

  close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server?.listening) return Promise.resolve();
    return new Promise(resolve => server.close(() => resolve()));
  }
}
