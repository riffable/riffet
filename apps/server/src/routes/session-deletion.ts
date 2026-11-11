import type { FastifyInstance } from 'fastify';
import type { SessionDeletion } from '../session-deletion.js';

/** `session-delete-v1` (docs/design/session-deletion.md): what a deletion would remove, then the deletion itself. */
export function registerSessionDeletionRoutes(app: FastifyInstance, deletion: SessionDeletion): void {
  app.get<{ Params: { id: string } }>('/api/sessions/:id/deletion', async request => deletion.preview(request.params.id, request.headers));
  app.delete<{ Params: { id: string }; Body: { sessionIds?: unknown } }>('/api/sessions/:id', async request => deletion.delete(request.params.id, request.body?.sessionIds, request.headers));
}
