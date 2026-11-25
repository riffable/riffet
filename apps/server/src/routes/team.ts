import type { FastifyInstance } from 'fastify';
import { createReadStream, constants, openSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import {
  ASSISTANT_BUDGET,
  DEFAULT_AGENT_MEMBER_ID,
  OWNER_AVATAR_MAX_BYTES,
  type AgentMember,
  type AgentMemberCreate,
  type AgentMemberList,
  type AgentMemberUpdate,
  type AgentMemberUserProfile,
  type AssistantFile,
  type AssistantInstructions,
  type AssistantMemory,
  type Session,
} from '../../../../packages/contracts/src/index.js';
import { AppError } from '../errors.js';
import type { RouteDeps } from './deps.js';

/** Enough JSON body room for a 1 MiB base64 avatar upload alongside member metadata and rules. */
const TEAM_BODY_LIMIT = Math.ceil(OWNER_AVATAR_MAX_BYTES / 3) * 4 + 256 * 1024;

/** Team & members (docs/TEAM.md): class C entry-server routes, denied over server links. */
export function registerTeamRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const team = () => {
    const service = deps.team?.();
    if (!service) throw new AppError('SERVICE_STARTING', 'The workbench is starting', 503);
    return service;
  };

  app.get<{ Querystring: { includeArchived?: string } }>('/api/team/members', async (request): Promise<AgentMemberList> => ({
    members: team().list({ includeArchived: request.query.includeArchived === '1' || request.query.includeArchived === 'true' }),
  }));

  app.post<{ Body: AgentMemberCreate }>('/api/team/members', { bodyLimit: TEAM_BODY_LIMIT }, async (request, reply): Promise<AgentMember> => {
    const member = await team().create(request.body);
    reply.code(201);
    return member;
  });

  app.get<{ Params: { id: string } }>('/api/team/members/:id', async (request): Promise<AgentMember> => team().get(request.params.id));

  app.patch<{ Params: { id: string }; Body: AgentMemberUpdate }>('/api/team/members/:id', { bodyLimit: TEAM_BODY_LIMIT }, async (request): Promise<AgentMember> => (
    team().update(request.params.id, request.body ?? {})
  ));

  app.delete<{ Params: { id: string } }>('/api/team/members/:id', async (request, reply) => {
    team().delete(request.params.id);
    reply.code(204);
  });

  app.get('/api/team/user-profile', async (): Promise<AgentMemberUserProfile> => team().userProfile());

  app.put<{ Body: { text?: unknown } }>('/api/team/user-profile', async (request): Promise<AgentMemberUserProfile> => {
    const text = request.body?.text;
    if (typeof text !== 'string') throw new AppError('INVALID_ARGUMENT', 'text must be a string');
    return team().updateUserProfile(text);
  });

  app.get<{ Params: { id: string } }>('/api/team/members/:id/instructions', async (request): Promise<AssistantInstructions> => (
    team().instructions(request.params.id)
  ));

  app.put<{ Params: { id: string }; Body: { text?: unknown } }>('/api/team/members/:id/instructions', async (request): Promise<AssistantInstructions> => {
    const text = request.body?.text;
    if (text !== null && typeof text !== 'string') throw new AppError('INVALID_ARGUMENT', 'text must be text or null');
    return team().instructions(request.params.id, text);
  });

  app.get<{ Params: { id: string } }>('/api/team/members/:id/memory', async (request): Promise<AssistantMemory> => (
    team().memory(request.params.id)
  ));

  app.delete<{ Params: { id: string; name: string } }>('/api/team/members/:id/memory/:name', async (request, reply) => {
    try {
      await team().forgetMemory(request.params.id, request.params.name);
    } catch (error) {
      if ((error as { code?: string }).code === 'MEMORY_NOT_FOUND') throw new AppError('MEMORY_NOT_FOUND', 'No such memory', 404);
      throw error;
    }
    reply.code(204);
  });

  app.get<{ Params: { id: string } }>('/api/team/members/:id/avatar', async (request, reply) => {
    const found = team().avatarFile(request.params.id);
    if (!found) throw new AppError('FILE_NOT_FOUND', 'Avatar not found', 404);
    return reply.type(found.type)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'")
      .header('Cache-Control', 'private, max-age=31536000, immutable')
      .send(createReadStream(found.path, { fd: openSync(found.path, constants.O_RDONLY | constants.O_NOFOLLOW) }));
  });

  app.get<{ Params: { id: string } }>('/api/team/members/:id/files', async (request): Promise<{ files: AssistantFile[] }> => ({
    files: team().files(request.params.id),
  }));

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>('/api/team/members/:id/file', async (request, reply) => {
    const path = typeof request.query.path === 'string' ? request.query.path : '';
    const file = path && path.length <= 1024 ? team().filePath(request.params.id, path) : undefined;
    if (!file) throw new AppError('FILE_NOT_FOUND', 'No such file', 404);
    const size = (await stat(file)).size;
    if (size > ASSISTANT_BUDGET.servedFileBytes) throw new AppError('FILE_TOO_LARGE', 'This file is too large to download here', 413);
    const name = basename(file);
    reply.header('Content-Type', 'application/octet-stream')
      .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'no-store');
    return reply.send(createReadStream(file, { fd: openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW) }));
  });

  app.get<{ Params: { id: string }; Querystring: { includeArchived?: string; limit?: string } }>('/api/team/members/:id/sessions', async (request): Promise<{ sessions: Session[] }> => {
    const limit = request.query.limit ? Number(request.query.limit) : undefined;
    return {
      sessions: team().listSessions(request.params.id, {
        includeArchived: request.query.includeArchived === '1' || request.query.includeArchived === 'true',
        ...(limit && Number.isFinite(limit) ? { limit } : {}),
      }),
    };
  });

  app.get<{ Params: { id: string } }>('/api/team/members/:id/delegations', async (request) => {
    const member = team().get(request.params.id);
    if (member.id !== DEFAULT_AGENT_MEMBER_ID || !member.capabilities.delegations) return { delegations: [] };
    const delegations = deps.assistantDelegations?.();
    if (!delegations) throw new AppError('SERVICE_STARTING', 'The workbench is starting', 503);
    return { delegations: delegations.list() };
  });
}
