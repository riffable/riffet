import type { FastifyInstance } from 'fastify';
import type { PluginApprovalDecision, PluginApprovalList, PluginApprovalResult } from '../../../../packages/contracts/src/index.js';
import type { RouteDeps } from './deps.js';

/**
 * What plugins ask the owner to approve (docs/TASK-BOARD.md §7), listed in the inbox of every client. Global scope: the
 * link policy denies these to a peer, and a client reads only its entry server's. `/api/lists/stream` announces a change as
 * `plugin-approvals`.
 */
export function registerPluginApprovalRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { pluginApprovals } = deps;
  app.get('/api/plugin-approvals', async (): Promise<PluginApprovalList> => ({ approvals: pluginApprovals.list() }));
  /** The plugin does the write; its refusal is the answer and the approval stays. */
  app.post<{ Params: { pluginId: string; id: string }; Body: Partial<PluginApprovalDecision> }>('/api/plugin-approvals/:pluginId/:id/decide',
    async (request): Promise<PluginApprovalResult> => pluginApprovals.decide(request.params.pluginId, request.params.id, request.body?.actionId));
}
