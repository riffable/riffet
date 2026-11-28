import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { GateRegistry } from './gates.js';
import {
  handleAnthropicCountTokens,
  handleAnthropicMessages,
  isAnthropicModelsRequest,
  writeAnthropicModels,
} from './protocols/anthropic.js';
import {
  handleGeminiGenerateContent,
  isGeminiModelsRequest,
  matchGeminiActionPath,
  writeGeminiModels,
} from './protocols/gemini.js';
import {
  handleOpenAiChatCompletions,
  writeOpenAiModels,
} from './protocols/openai-chat.js';
import {
  attachOpenAiResponsesWebSocket,
  handleOpenAiResponsesHttp,
} from './protocols/openai-responses.js';
import {
  formatMismatchMessage,
  readRequestBody,
  safeJsonParse,
  writeJson,
  type MockErrorSpec,
  type MockModelInfo,
  type MockReplySpec,
  type MockRoute,
  type MockToolCallSpec,
  type NormalizedRequest,
  type ProtocolRuntimeContext,
} from './types.js';

export interface MockLlmHubOptions {
  host?: string;
  port?: number;
  models?: MockModelInfo[];
  strict?: boolean;
  auxiliaryDefaults?: boolean;
}

const DEFAULT_MODELS: MockModelInfo[] = [
  { id: 'claude-mock-4', displayName: 'Claude Mock 4', ownedBy: 'anthropic' },
  { id: 'gpt-5-mock', displayName: 'GPT-5 Mock', ownedBy: 'openai' },
  { id: 'gpt-4o-mock', displayName: 'GPT-4o Mock', ownedBy: 'openai' },
  { id: 'gemini-2.5-mock', displayName: 'Gemini 2.5 Mock', ownedBy: 'google' },
];

interface RegisteredRoute {
  route: MockRoute;
  order: number;
}

interface RequestWaiter {
  predicate: (req: NormalizedRequest) => boolean;
  resolve: (req: NormalizedRequest) => void;
  reject: (err: Error) => void;
}

const TITLE_SYSTEM_RE = /\b(?:concise|short|brief)\s+title\b|\btitle\s+for\s+this\s+(?:conversation|chat|session)\b|\bgenerate\s+(?:a\s+)?(?:short\s+|concise\s+)?title\b|\bisNewTopic\b|会话标题|生成.*标题/i;
const TITLE_JSON_RE = /\bjson\b|\bisNewTopic\b|\{\s*"title"/i;
const PROBE_SYSTEM_RE = /\b(?:connectivity|health\s*check|quota\s*check|warmup|preflight)\b/i;
const SUGGESTION_SYSTEM_RE = /\b(?:prompt\s+suggestion|follow-up\s+suggestions|next\s+user\s+prompt|suggest\s+next)\b/i;

function matchAuxiliaryRequest(req: NormalizedRequest): MockReplySpec | null {
  const sys = req.system;
  const user = req.lastUserText.trim();

  if (TITLE_SYSTEM_RE.test(sys) || (req.toolNames.length === 0 && TITLE_SYSTEM_RE.test(user) && !user.includes('[TCK:'))) {
    if (TITLE_JSON_RE.test(sys) || TITLE_JSON_RE.test(user)) {
      return replyText(JSON.stringify({ isNewTopic: true, title: 'Mock Session Title' }));
    }
    return replyText('Mock Session Title');
  }

  if (req.toolNames.length === 0 && PROBE_SYSTEM_RE.test(sys)) {
    return replyText('ok');
  }

  if (req.toolNames.length === 0 && SUGGESTION_SYSTEM_RE.test(sys)) {
    return replyText('');
  }

  return null;
}

export function replyText(text: string, extra?: Partial<MockReplySpec>): MockReplySpec {
  return { ...extra, text };
}

export function replyToolCall(
  calls: MockToolCallSpec | MockToolCallSpec[],
  extra?: Partial<MockReplySpec>,
): MockReplySpec {
  const list = Array.isArray(calls) ? calls : [calls];
  return { ...extra, toolCalls: list, stopReason: extra?.stopReason ?? 'tool_calls' };
}

export function replyError(
  status: number,
  message: string,
  extra?: Partial<Omit<MockErrorSpec, 'status' | 'message'>>,
): MockReplySpec {
  return {
    error: {
      status,
      message,
      ...extra,
    },
  };
}

export function replyDisconnect(
  text: string,
  afterChunks = 1,
  extra?: Partial<MockReplySpec>,
): MockReplySpec {
  return {
    chunkSize: 8,
    ...extra,
    text,
    streamFault: {
      afterChunks,
      mode: 'tcp-disconnect',
    },
  };
}

export const AUXILIARY_DEFAULT_PRIORITY = 50;

export function routeByTag(
  tag: string,
  handler: (req: NormalizedRequest) => MockReplySpec | Promise<MockReplySpec>,
  options?: { id?: string; priority?: number },
): MockRoute {
  return {
    id: options?.id ?? `tag:${tag}`,
    priority: options?.priority ?? 10,
    match: (req) => req.lastUserText.includes(tag),
    handle: handler,
  };
}

export class MockLlmHub {
  readonly gates = new GateRegistry();

  private readonly host: string;
  private readonly desiredPort: number;
  private _models: MockModelInfo[];
  private strictMode: boolean;
  private auxiliaryDefaultsEnabled: boolean;

  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private boundPort = 0;
  private readonly activeSockets = new Set<Socket>();
  private readonly activeWebSockets = new Set<WebSocket>();

  private routeOrderSeq = 0;
  private requestIdSeq = 0;
  private readonly registeredRoutes: RegisteredRoute[] = [];
  private readonly requestJournal: NormalizedRequest[] = [];
  private readonly requestWaiters = new Set<RequestWaiter>();

  constructor(options?: MockLlmHubOptions) {
    this.host = options?.host ?? '127.0.0.1';
    this.desiredPort = options?.port ?? 0;
    this._models = options?.models ? [...options.models] : [...DEFAULT_MODELS];
    this.strictMode = options?.strict ?? true;
    this.auxiliaryDefaultsEnabled = options?.auxiliaryDefaults ?? true;
  }

  get port(): number {
    return this.boundPort;
  }

  get url(): string {
    if (!this.server || !this.boundPort) {
      throw new Error('MockLlmHub is not started yet; call start() first');
    }
    return `http://${this.host}:${this.boundPort}`;
  }

  get wsUrl(): string {
    if (!this.server || !this.boundPort) {
      throw new Error('MockLlmHub is not started yet; call start() first');
    }
    return `ws://${this.host}:${this.boundPort}`;
  }

  get models(): MockModelInfo[] {
    return [...this._models];
  }

  setModels(models: MockModelInfo[]): void {
    this._models = [...models];
  }

  setStrict(enabled: boolean): void {
    this.strictMode = enabled;
  }

  enableAuxiliaryDefaults(enabled: boolean): void {
    this.auxiliaryDefaultsEnabled = enabled;
  }

  addRoute(route: MockRoute): () => void {
    const entry: RegisteredRoute = { route, order: this.routeOrderSeq++ };
    this.registeredRoutes.push(entry);
    return () => {
      const idx = this.registeredRoutes.indexOf(entry);
      if (idx >= 0) this.registeredRoutes.splice(idx, 1);
    };
  }

  removeRoute(id: string): boolean {
    const before = this.registeredRoutes.length;
    for (let i = this.registeredRoutes.length - 1; i >= 0; i--) {
      if (this.registeredRoutes[i].route.id === id) {
        this.registeredRoutes.splice(i, 1);
      }
    }
    return this.registeredRoutes.length !== before;
  }

  clearRoutes(): void {
    this.registeredRoutes.length = 0;
  }

  requests(filter?: (req: NormalizedRequest) => boolean): NormalizedRequest[] {
    if (!filter) return [...this.requestJournal];
    return this.requestJournal.filter(filter);
  }

  clearRequests(): void {
    this.requestJournal.length = 0;
  }

  waitForRequest(
    predicate: (req: NormalizedRequest) => boolean,
    timeoutMs = 15_000,
  ): Promise<NormalizedRequest> {
    const existing = this.requestJournal.find(predicate);
    if (existing) return Promise.resolve(existing);

    return new Promise<NormalizedRequest>((resolve, reject) => {
      const waiter: RequestWaiter = {
        predicate,
        resolve: (req) => {
          clearTimeout(timer);
          resolve(req);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      };

      const timer = setTimeout(() => {
        this.requestWaiters.delete(waiter);
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for matching mock LLM request`));
      }, timeoutMs);
      timer.unref?.();

      this.requestWaiters.add(waiter);
    });
  }

  async start(): Promise<{ url: string; wsUrl: string; port: number }> {
    if (this.server) {
      return { url: this.url, wsUrl: this.wsUrl, port: this.boundPort };
    }

    const ctx = this.createRuntimeContext();
    const wss = new WebSocketServer({ noServer: true });
    this.wss = wss;

    const server = http.createServer((req, res) => {
      void this.handleHttpRequest(req, res, ctx);
    });
    this.server = server;

    server.on('connection', (socket: Socket) => {
      this.activeSockets.add(socket);
      socket.once('close', () => {
        this.activeSockets.delete(socket);
      });
    });

    server.on('upgrade', (req, socket, head) => {
      const parsedUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      const pathname = parsedUrl.pathname;

      if (pathname === '/v1/responses' || pathname === '/responses') {
        wss.handleUpgrade(req, socket, head, (ws) => {
          this.activeWebSockets.add(ws);
          ws.once('close', () => {
            this.activeWebSockets.delete(ws);
          });
          attachOpenAiResponsesWebSocket(ws, req, pathname, ctx);
        });
        return;
      }

      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        server.off('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        server.off('error', onError);
        const addr = server.address() as AddressInfo | null;
        this.boundPort = addr?.port ?? this.desiredPort;
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.desiredPort, this.host);
    });

    return { url: this.url, wsUrl: this.wsUrl, port: this.boundPort };
  }

  async close(): Promise<void> {
    this.gates.releaseAll();

    const closeErr = new Error('MockLlmHub closed');
    for (const waiter of this.requestWaiters) {
      waiter.reject(closeErr);
    }
    this.requestWaiters.clear();

    for (const ws of this.activeWebSockets) {
      try {
        ws.terminate();
      } catch {
        // ignore close errors
      }
    }
    this.activeWebSockets.clear();

    for (const socket of this.activeSockets) {
      try {
        socket.destroy();
      } catch {
        // ignore socket destroy errors
      }
    }
    this.activeSockets.clear();

    const wss = this.wss;
    this.wss = null;
    if (wss) {
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
    }

    const server = this.server;
    this.server = null;
    this.boundPort = 0;
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  }

  private createRuntimeContext(): ProtocolRuntimeContext {
    return {
      nextRequestId: () => ++this.requestIdSeq,
      getModels: () => this.models,
      dispatch: (req) => this.dispatchRequest(req),
      arriveGate: (name, signal) => this.gates.arrive(name, signal),
    };
  }

  private async dispatchRequest(req: NormalizedRequest): Promise<MockReplySpec> {
    this.requestJournal.push(req);
    for (const waiter of Array.from(this.requestWaiters)) {
      if (waiter.predicate(req)) {
        this.requestWaiters.delete(waiter);
        waiter.resolve(req);
      }
    }

    const sorted = [...this.registeredRoutes].sort((a, b) => {
      const pa = a.route.priority ?? 0;
      const pb = b.route.priority ?? 0;
      if (pb !== pa) return pb - pa;
      return a.order - b.order;
    });

    for (const { route } of sorted) {
      if ((route.priority ?? 0) >= AUXILIARY_DEFAULT_PRIORITY && route.match(req)) {
        return await route.handle(req);
      }
    }

    if (this.auxiliaryDefaultsEnabled) {
      const aux = matchAuxiliaryRequest(req);
      if (aux) return aux;
    }

    for (const { route } of sorted) {
      if ((route.priority ?? 0) < AUXILIARY_DEFAULT_PRIORITY && route.match(req)) {
        return await route.handle(req);
      }
    }

    if (this.strictMode) {
      return replyError(417, formatMismatchMessage(req), {
        type: 'mock_route_mismatch',
        code: 'mock_route_mismatch',
      });
    }

    return replyText('mock-ok');
  }

  private async handleHttpRequest(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: ProtocolRuntimeContext,
  ): Promise<void> {
    try {
      const method = (req.method ?? 'GET').toUpperCase();
      const parsedUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      const pathname = parsedUrl.pathname;

      if (method === 'GET' && pathname === '/health') {
        writeJson(res, 200, { ok: true });
        return;
      }

      if (method === 'GET' && (pathname === '/v1/models' || pathname === '/models')) {
        if (isAnthropicModelsRequest(req)) {
          writeAnthropicModels(res, this._models);
        } else if (isGeminiModelsRequest(req, parsedUrl.searchParams)) {
          writeGeminiModels(res, this._models);
        } else {
          writeOpenAiModels(res, this._models);
        }
        return;
      }

      if (method === 'GET' && pathname === '/v1beta/models') {
        writeGeminiModels(res, this._models);
        return;
      }

      if (method === 'POST' && (pathname === '/v1/messages/count_tokens' || pathname === '/messages/count_tokens')) {
        const body = await this.parseJsonBody(req, res);
        if (body === undefined) return;
        handleAnthropicCountTokens(res, body);
        return;
      }

      if (method === 'POST' && (pathname === '/v1/messages' || pathname === '/messages')) {
        const body = await this.parseJsonBody(req, res);
        if (body === undefined) return;
        await handleAnthropicMessages(req, res, pathname, body, ctx);
        return;
      }

      if (method === 'POST' && (pathname === '/v1/responses' || pathname === '/responses')) {
        const body = await this.parseJsonBody(req, res);
        if (body === undefined) return;
        await handleOpenAiResponsesHttp(req, res, pathname, body, ctx);
        return;
      }

      if (method === 'POST' && (pathname === '/v1/chat/completions' || pathname === '/chat/completions')) {
        const body = await this.parseJsonBody(req, res);
        if (body === undefined) return;
        await handleOpenAiChatCompletions(req, res, pathname, body, ctx);
        return;
      }

      if (method === 'POST') {
        const geminiMatch = matchGeminiActionPath(pathname);
        if (geminiMatch) {
          const body = await this.parseJsonBody(req, res);
          if (body === undefined) return;
          await handleGeminiGenerateContent(
            req,
            res,
            pathname,
            parsedUrl.searchParams,
            geminiMatch.model,
            geminiMatch.action,
            body,
            ctx,
          );
          return;
        }
      }

      writeJson(res, 404, {
        error: {
          message: `MockLlmHub: unhandled route ${method} ${pathname}`,
          type: 'not_found_error',
        },
      });
    } catch (err) {
      if (!res.headersSent && !res.destroyed) {
        writeJson(res, 500, {
          error: {
            message: err instanceof Error ? err.message : String(err),
            type: 'server_error',
          },
        });
      } else {
        res.socket?.destroy();
      }
    }
  }

  private async parseJsonBody(req: IncomingMessage, res: ServerResponse): Promise<unknown> {
    const rawStr = await readRequestBody(req);
    if (!rawStr.trim()) return {};
    const parsed = safeJsonParse(rawStr);
    if (!parsed.ok) {
      writeJson(res, 400, {
        error: {
          message: 'Invalid JSON request body',
          type: 'invalid_request_error',
        },
      });
      return undefined;
    }
    return parsed.value;
  }
}
