import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  MODEL_CHAT_BUDGET,
  type ModelChatConfigPatch,
  type ModelChatSendRequest,
  type ModelChatStreamEvent,
  type Session,
} from '../../../../packages/contracts/src/index.js';
import type { ChatBackendAdapter } from '../backends/chat/index.js';
import { QUICK_CHAT_FEATURE } from '../chat/quick-chat.js';
import { AppError, requireString } from '../errors.js';
import { clientSupportsFeature, requireSessionVisibleToClient } from '../native/client-features.js';
import type { RouteDeps } from './deps.js';

export interface ChatRouteDeps extends RouteDeps {
  chat: ChatBackendAdapter;
}

const STREAM_BACKPRESSURE_BYTES = MODEL_CHAT_BUDGET.streamBackpressureBytes;
const STREAM_HEARTBEAT_MS = MODEL_CHAT_BUDGET.streamHeartbeatMs;

function requireChatSession(deps: ChatRouteDeps, request: FastifyRequest, sessionId: string): Session {
  if (!clientSupportsFeature(request.headers, QUICK_CHAT_FEATURE)) {
    throw new AppError('FEATURE_REQUIRED', 'Update the client to use Model Chat', 409);
  }
  const session = deps.store.getSession(sessionId);
  requireSessionVisibleToClient(request.headers, session, id => deps.store.getProject(id));
  if (session.backendId !== 'chat' || session.origin?.kind === 'discussion' || session.origin?.kind === 'council') {
    throw new AppError('NOT_MODEL_CHAT', 'This conversation is not a Model Chat session', 409);
  }
  return session;
}

function requireWritableChatSession(deps: ChatRouteDeps, request: FastifyRequest, sessionId: string): Session {
  const session = requireChatSession(deps, request, sessionId);
  if (session.archivedAt) {
    throw new AppError('SESSION_ARCHIVED', 'Restore this conversation before editing it', 409);
  }
  return session;
}

/**
 * HTTP + SSE routes for Model Chat (`/api/sessions/:id/chat/*`): full message tree, white-box
 * parameters, context orchestration, parallel multi-model streaming, branch selection, turn
 * pinning/muting, assistant editing, and redacted Wire inspection.
 */
export function registerChatRoutes(app: FastifyInstance, deps: ChatRouteDeps): void {
  app.get<{ Params: { id: string } }>('/api/sessions/:id/chat/tree', async request => {
    const session = requireChatSession(deps, request, request.params.id);
    return deps.chat.getTree(session.id, session);
  });

  app.patch<{ Params: { id: string }; Body: ModelChatConfigPatch }>('/api/sessions/:id/chat/config', async request => {
    const initial = requireWritableChatSession(deps, request, request.params.id);
    return deps.sessionLock.withSession(initial.id, async () => {
      const session = requireWritableChatSession(deps, request, initial.id);
      return deps.chat.updateConfig(session.id, request.body ?? {}, session);
    });
  });

  app.post<{ Params: { id: string }; Body: ModelChatSendRequest }>('/api/sessions/:id/chat/send', async request => {
    const initial = requireWritableChatSession(deps, request, request.params.id);
    deps.sessionCommands.admit(initial);
    return deps.sessionLock.withSession(initial.id, async () => {
      const session = requireWritableChatSession(deps, request, initial.id);
      deps.sessionCommands.admit(session);
      return deps.chat.sendTree(deps.nativeBackends.host, session, request.body ?? ({ text: '' } as ModelChatSendRequest));
    });
  });

  app.post<{ Params: { id: string }; Body: { assistantId?: unknown } }>('/api/sessions/:id/chat/stop', async request => {
    const session = requireChatSession(deps, request, request.params.id);
    const rawAssistantId = request.body?.assistantId;
    if (rawAssistantId !== undefined && (typeof rawAssistantId !== 'string' || !rawAssistantId.trim() || rawAssistantId.length > 200)) {
      throw new AppError('INVALID_INPUT', 'assistantId must be a non-empty string', 400);
    }
    const snapshot = await deps.chat.stopStream(session.id, rawAssistantId?.trim(), session);
    return { snapshot };
  });

  app.post<{ Params: { id: string }; Body: { leafId?: unknown } }>('/api/sessions/:id/chat/branch', async request => {
    const initial = requireWritableChatSession(deps, request, request.params.id);
    const leafId = requireString(request.body?.leafId, 'leafId', 200);
    return deps.sessionLock.withSession(initial.id, async () => {
      const session = requireWritableChatSession(deps, request, initial.id);
      return deps.chat.selectBranch(deps.nativeBackends.host, session.id, leafId);
    });
  });

  app.patch<{ Params: { id: string; userId: string }; Body: { pinned?: unknown; muted?: unknown } }>('/api/sessions/:id/chat/turns/:userId', async request => {
    const initial = requireWritableChatSession(deps, request, request.params.id);
    const body = request.body ?? {};
    return deps.sessionLock.withSession(initial.id, async () => {
      const session = requireWritableChatSession(deps, request, initial.id);
      return deps.chat.setTurnFlags(
        session.id,
        request.params.userId,
        {
          ...(body.pinned !== undefined ? { pinned: body.pinned as boolean } : {}),
          ...(body.muted !== undefined ? { muted: body.muted as boolean } : {}),
        },
        session,
      );
    });
  });

  app.patch<{ Params: { id: string; assistantId: string }; Body: { text?: unknown } }>('/api/sessions/:id/chat/messages/:assistantId', async request => {
    const initial = requireWritableChatSession(deps, request, request.params.id);
    if (typeof request.body?.text !== 'string') {
      throw new AppError('INVALID_INPUT', 'text must be a string', 400);
    }
    const text = request.body.text;
    return deps.sessionLock.withSession(initial.id, async () => {
      const session = requireWritableChatSession(deps, request, initial.id);
      return deps.chat.editAssistant(deps.nativeBackends.host, session.id, request.params.assistantId, text);
    });
  });

  app.get<{ Params: { id: string; assistantId: string } }>('/api/sessions/:id/chat/wire/:assistantId', async request => {
    const session = requireChatSession(deps, request, request.params.id);
    const wire = deps.chat.getWire(session.id, request.params.assistantId);
    if (!wire) throw new AppError('WIRE_NOT_FOUND', 'Wire snapshot is not available for this message', 404);
    return wire;
  });

  app.get<{ Params: { id: string } }>('/api/sessions/:id/chat/stream', async (request, reply) => {
    const session = requireChatSession(deps, request, request.params.id);
    let cleaned = false;
    let heartbeat: NodeJS.Timeout | undefined;
    let unsubscribe: (() => void) | undefined;
    let unwatchRevoke: (() => void) | undefined;
    let unwatchDelete: (() => void) | undefined;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      if (heartbeat) { clearInterval(heartbeat); heartbeat = undefined; }
      unsubscribe?.();
      unsubscribe = undefined;
      unwatchRevoke?.();
      unwatchRevoke = undefined;
      unwatchDelete?.();
      unwatchDelete = undefined;
      deps.streams.delete(reply.raw);
    };

    reply.raw.once('close', cleanup);
    if (reply.raw.destroyed || reply.raw.closed) {
      cleanup();
      return;
    }

    unwatchRevoke = deps.auth.onRevoke(request, () => reply.raw.destroy());
    unwatchDelete = deps.store.onSessionDeleted(session.id, () => reply.raw.destroy());
    reply.hijack();
    deps.streams.add(reply.raw);
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write(': connected\n\n');

    const write = (event: ModelChatStreamEvent) => {
      if (reply.raw.destroyed || reply.raw.writableEnded) return;
      if (reply.raw.writableLength > STREAM_BACKPRESSURE_BYTES) { reply.raw.end(); return; }
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    try {
      // Subscribe before reading the initial snapshot so no delta is missed in between.
      unsubscribe = deps.chat.subscribeTree(session.id, write);
      write({ type: 'snapshot', snapshot: deps.chat.getTree(session.id, session) });
    } catch {
      cleanup();
      if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
      return;
    }

    if (reply.raw.destroyed || reply.raw.closed) {
      cleanup();
      return;
    }

    heartbeat = setInterval(() => {
      if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.write(': heartbeat\n\n');
    }, STREAM_HEARTBEAT_MS);
    heartbeat.unref?.();
  });
}
