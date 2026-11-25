import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from './deps.js';

/**
 * The shim's entry. It takes only a conversation-bound Riffet MCP credential, checked by the
 * service, even on a loopback binding without a sign-in; that credential opens nothing else.
 */
export const RIFFET_MCP_ROUTE = '/api/riffet-mcp';
/**
 * Standard MCP Streamable HTTP JSON-RPC 2.0 endpoint for CLIs that connect directly over HTTP
 * without spawning a per-session Node stdio shim (~40 MB RSS saved per session).
 * Authenticated by the same conversation-bound `Bearer wkm_...` credential.
 */
export const RIFFET_MCP_HTTP_ROUTE = '/api/riffet-mcp/http';

const SUPPORTED_MCP_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;
const RIFFET_MCP_INSTRUCTIONS = 'Use only tools offered to this conversation. The personal assistant can discover read-only workbench capabilities with capability_find and run them with capability_read. Other tools read saved session references already delivered here, schedule a later wake-up of this same conversation, notify the user, list paired devices, and use the capabilities of the devices this conversation was given (device_* tools).';

type JsonRpcResponse = { jsonrpc: '2.0'; id: unknown; result?: unknown; error?: { code: number; message: string } };

async function handleJsonRpcMessage(
  raw: unknown,
  authorization: string | undefined,
  riffetMcp: RouteDeps['riffetMcp'],
  signal: AbortSignal,
): Promise<JsonRpcResponse | undefined> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } };
  }
  const { id, method, params } = raw as { id?: unknown; method?: unknown; params?: unknown };
  const isRequest = id !== undefined && id !== null;
  if (typeof method !== 'string') {
    return isRequest ? { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid request' } } : undefined;
  }
  // Notifications (`notifications/initialized`, `notifications/cancelled`) need no response body.
  if (!isRequest) return undefined;
  switch (method) {
    case 'initialize': {
      const requested = (params && typeof params === 'object' ? (params as { protocolVersion?: unknown }).protocolVersion : undefined);
      const protocolVersion = typeof requested === 'string' && (SUPPORTED_MCP_VERSIONS as readonly string[]).includes(requested)
        ? requested
        : SUPPORTED_MCP_VERSIONS[0];
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'riffet', version: '1' },
          instructions: RIFFET_MCP_INSTRUCTIONS,
        },
      };
    }
    case 'ping': return { jsonrpc: '2.0', id, result: {} };
    case 'resources/list': return { jsonrpc: '2.0', id, result: { resources: [] } };
    case 'prompts/list': return { jsonrpc: '2.0', id, result: { prompts: [] } };
    case 'tools/list':
    case 'tools/call':
      try {
        return { jsonrpc: '2.0', id, result: await riffetMcp.handle(authorization, method, params, signal) };
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        if (method === 'tools/call') return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: true } };
        return { jsonrpc: '2.0', id, error: { code: -32603, message: text } };
      }
    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

export function registerRiffetMcpRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { store, orchestration, riffetMcp, notices } = deps;
  app.post<{ Body: { method?: unknown; params?: unknown } }>(RIFFET_MCP_ROUTE, async (request, reply) => {
    // A device call waits for the device; the shim giving up (the agent was interrupted) cancels it.
    const aborted = new AbortController();
    reply.raw.once('close', () => { if (!reply.raw.writableFinished) aborted.abort(); });
    return { result: await riffetMcp.handle(request.headers.authorization, request.body?.method, request.body?.params, aborted.signal) };
  });
  app.post(RIFFET_MCP_HTTP_ROUTE, async (request, reply) => {
    riffetMcp.authenticate(request.headers.authorization);
    const aborted = new AbortController();
    reply.raw.once('close', () => { if (!reply.raw.writableFinished) aborted.abort(); });
    const body = request.body;
    if (Array.isArray(body)) {
      if (body.length === 0) return reply.code(400).send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } });
      const responses = (await Promise.all(body.map(item => handleJsonRpcMessage(item, request.headers.authorization, riffetMcp, aborted.signal))))
        .filter((item): item is JsonRpcResponse => item !== undefined);
      if (responses.length === 0) return reply.code(202).send();
      return responses;
    }
    const response = await handleJsonRpcMessage(body, request.headers.authorization, riffetMcp, aborted.signal);
    if (!response) return reply.code(202).send();
    return response;
  });
  // Stateless Streamable HTTP server: no server-initiated SSE stream on GET, clean 204 on DELETE.
  app.get(RIFFET_MCP_HTTP_ROUTE, async (request, reply) => {
    riffetMcp.authenticate(request.headers.authorization);
    return reply.code(405).header('Allow', 'POST, DELETE').send();
  });
  app.delete(RIFFET_MCP_HTTP_ROUTE, async (request, reply) => {
    riffetMcp.authenticate(request.headers.authorization);
    return reply.code(204).send();
  });
  app.get<{ Params: { id: string } }>('/api/sessions/:id/wakeups', async request => {
    store.getSession(request.params.id);
    return orchestration.wakeups(request.params.id);
  });
  app.post<{ Params: { id: string; wakeupId: string } }>('/api/sessions/:id/wakeups/:wakeupId/cancel', async request => {
    store.getSession(request.params.id);
    return orchestration.cancelWakeup(request.params.wakeupId, request.params.id);
  });
  app.get<{ Params: { id: string } }>('/api/sessions/:id/notices', async request => {
    store.getSession(request.params.id);
    return notices.list(request.params.id);
  });
}
