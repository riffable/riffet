import type { FastifyInstance } from 'fastify';
import type { InboxNoticeList, PluginApprovalDecision, PluginApprovalList, PluginApprovalResult, RiffetNotice } from '../../../../packages/contracts/src/index.js';
import { AppError } from '../errors.js';
import type { RouteDeps } from './deps.js';

/**
 * Riffet Inbox endpoints: plugin write approvals (`GET /api/plugin-approvals`) and explicit user-facing
 * notices (`GET /api/inbox/notices`, e.g. from team members calling `notify_user`). Global scope:
 * the link policy denies both to peers, and clients read only their entry server's inbox.
 */
export function registerPluginApprovalRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { pluginApprovals, notices, store } = deps;
  const enrichNotice = (notice: RiffetNotice): RiffetNotice => {
    if (notice.senderName || !notice.sessionId) return notice;
    try {
      const session = store.getSession(notice.sessionId);
      const project = store.getProject(session.projectId);
      const member = deps.team?.()?.resolveFor(project, session);
      const senderName = member?.name || session.displayTitle || session.title;
      return senderName ? { ...notice, senderName } : notice;
    } catch {
      return notice;
    }
  };

  app.get('/api/plugin-approvals', async (): Promise<PluginApprovalList> => ({ approvals: pluginApprovals.list() }));
  /** The plugin does the write; its refusal is the answer and the approval stays. */
  app.post<{ Params: { pluginId: string; id: string }; Body: Partial<PluginApprovalDecision> }>('/api/plugin-approvals/:pluginId/:id/decide',
    async (request): Promise<PluginApprovalResult> => pluginApprovals.decide(request.params.pluginId, request.params.id, request.body?.actionId));

  app.get('/api/inbox/notices', async (): Promise<InboxNoticeList> => ({ notices: notices.listAll().map(enrichNotice) }));
  app.post<{ Params: { id: string } }>('/api/inbox/notices/:id/read', async (request) => {
    const updated = notices.markRead(request.params.id);
    if (!updated) throw new AppError('NOTICE_NOT_FOUND', 'Notice not found', 404);
    return { notice: enrichNotice(updated) };
  });
  app.post('/api/inbox/notices/read-all', async () => ({ count: notices.markAllRead() }));
  app.delete<{ Params: { id: string } }>('/api/inbox/notices/:id', async (request) => {
    if (!notices.remove(request.params.id)) throw new AppError('NOTICE_NOT_FOUND', 'Notice not found', 404);
    return { ok: true };
  });
}
