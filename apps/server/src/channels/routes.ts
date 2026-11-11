import type { FastifyInstance } from 'fastify';
import type { ChannelAccountInput, ChannelRegistrationInput } from '../../../../packages/contracts/src/channels.js';
import { AppError } from '../errors.js';
import type { ChannelService } from './service.js';

/** The settings page's side of the channels (docs/design/channels.md); login is checked for every `/api` route. */
export function registerChannelRoutes(app: FastifyInstance, deps: { channels: ChannelService }): void {
  const { channels } = deps;
  const body = <T>(value: unknown): T => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError('INVALID_INPUT', 'A JSON object is required');
    return value as T;
  };
  app.get('/api/channels', async () => channels.state());
  app.post('/api/channels/accounts', async request => channels.createAccount(body<ChannelAccountInput>(request.body)));
  app.patch<{ Params: { id: string } }>('/api/channels/accounts/:id', async request => channels.updateAccount(request.params.id, body<Partial<ChannelAccountInput>>(request.body)));
  app.delete<{ Params: { id: string } }>('/api/channels/accounts/:id', async request => { await channels.deleteAccount(request.params.id); return { ok: true }; });
  app.post<{ Params: { id: string } }>('/api/channels/accounts/:id/bind-code', async request => channels.bindCode(request.params.id));
  app.delete<{ Params: { id: string } }>('/api/channels/identities/:id', async request => { channels.unbind(request.params.id); return { ok: true }; });
  app.patch<{ Params: { key: string } }>('/api/channels/chats/:key', async request => channels.patchChat(request.params.key, body<{ projectId?: string | null; flat?: boolean }>(request.body)));
  app.delete<{ Params: { key: string } }>('/api/channels/chats/:key', async request => { channels.deleteChat(request.params.key); return { ok: true }; });
  app.get<{ Params: { id: string }; Querystring: { refresh?: string } }>('/api/channels/accounts/:id/health', async request => channels.health(request.params.id, request.query.refresh === '1'));
  app.post('/api/channels/registrations', async request => channels.startRegistration(body<ChannelRegistrationInput>(request.body)));
  app.get<{ Params: { id: string } }>('/api/channels/registrations/:id', async request => channels.registration(request.params.id));
  app.delete<{ Params: { id: string } }>('/api/channels/registrations/:id', async request => { channels.cancelRegistration(request.params.id); return { ok: true }; });
}
