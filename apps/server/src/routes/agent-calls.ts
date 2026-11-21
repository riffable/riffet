import type { FastifyInstance } from 'fastify';
import type { AgentCall } from '../../../../packages/contracts/src/index.js';
import { requireSessionVisibleToClient } from '../native/client-features.js';
import type { Store } from '../store.js';

/** The Agent calls a conversation made (docs/AGENT-CALLS.md §7), for its call cards and session information. */
export function registerAgentCallRoutes(app: FastifyInstance, deps: { store: Store; agentCalls: { list(callerSessionId: string): AgentCall[] } }): void {
  app.get<{ Params: { id: string } }>('/api/sessions/:id/calls', async (request) => {
    const session = deps.store.getSession(request.params.id);
    requireSessionVisibleToClient(request.headers, session, id => deps.store.getProject(id));
    return { calls: deps.agentCalls.list(session.id) };
  });
}
