import type { FastifyInstance } from 'fastify';
import { AppError, requireString } from '../errors.js';
import { isNativeBackendId } from '../backends/registry.js';
import { ExtensionService } from '../extensions/service.js';
import { ExtensionManagement } from '../extensions/management.js';
import { requireBackendVisibleToClient, requireSessionVisibleToClient } from '../native/client-features.js';
import type { ExtensionActionRequest, ExtensionItem, ExtensionRuntimeReport } from '../../../../packages/contracts/src/index.js';
import type { RouteDeps } from './deps.js';

interface Selection { profileId?: string; projectId?: string; sessionId?: string; }
interface Params { id: string; itemId: string; documentId: string; }

/** All resource IDs are resolved again inside the selected server-side profile. */
export function registerExtensionRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const service = new ExtensionService(deps.stateDir);
  const management = new ExtensionManagement();
  const context = (backend: string, query: Selection, headers: import('node:http').IncomingHttpHeaders) => {
    requireBackendVisibleToClient(headers, backend);
    if (!isNativeBackendId(backend) || backend === 'chat') throw new AppError('INVALID_BACKEND', 'Choose a supported native backend');
    const session = query.sessionId ? deps.store.getSession(requireString(query.sessionId, 'sessionId', 100)) : undefined;
    requireSessionVisibleToClient(headers, session);
    if (session && session.backendId !== backend) throw new AppError('NATIVE_BACKEND_MISMATCH', 'The conversation uses a different native backend', 409);
    if (session && query.profileId && session.backendProfileId && query.profileId !== session.backendProfileId) throw new AppError('NATIVE_BACKEND_MISMATCH', 'The conversation uses a different profile', 409);
    if (session && query.projectId && query.projectId !== session.projectId) throw new AppError('NATIVE_BACKEND_MISMATCH', 'The conversation belongs to a different project', 409);
    const profile = deps.nativeBackends.catalog.validateProfile(backend, session ? session.backendProfileId : query.profileId);
    if (session && query.profileId && query.profileId !== profile.id) throw new AppError('NATIVE_BACKEND_MISMATCH', 'The conversation uses a different profile', 409);
    const projectId = session?.projectId ?? query.projectId;
    const layout = deps.nativeBackends.registry.require(backend).extensions?.layout?.(profile);
    return { backendId: backend, profile, ...(layout ? { layout } : {}), ...(projectId ? { project: deps.store.getProject(requireString(projectId, 'projectId', 100)) } : {}) };
  };
  const skillStates = async (ctx: ReturnType<typeof context>, items: ExtensionItem[]) => {
    const result = await management.skillStates(ctx, deps.nativeBackends.registry.require(ctx.backendId), deps.nativeBackends.host);
    return { items: await service.applySkillStates(ctx, items, result.states), diagnostics: result.diagnostics };
  };
  const detail = async (ctx: ReturnType<typeof context>, id: string) => {
    try {
      const result = await service.detail(ctx, id);
      if (result.item.kind === 'skill') return { ...result, item: (await skillStates(ctx, [result.item])).items[0] };
      return result;
    }
    catch (error) {
      if (!(error instanceof AppError) || error.code !== 'EXTENSION_NOT_FOUND') throw error;
      const item = (await management.installedPlugins(ctx)).items.find(value => value.id === id);
      if (!item) throw error;
      return { item, files: [] };
    }
  };
  app.get<{ Params: Params; Querystring: Selection }>('/api/backends/:id/extensions', async request => {
    const ctx = context(request.params.id, request.query, request.headers);
    const [inventory, installed] = await Promise.all([service.list(ctx), management.installedPlugins(ctx)]);
    const skills = inventory.items.some(item => item.kind === 'skill') ? await skillStates(ctx, inventory.items) : { items: inventory.items, diagnostics: [] };
    return { ...inventory, items: [...skills.items, ...installed.items], diagnostics: [...inventory.diagnostics, ...installed.diagnostics, ...skills.diagnostics] };
  });
  // What a launch in this project loads, for the per-conversation switches (docs/EXTENSIONS.md); not the static catalog.
  app.get<{ Params: Params; Querystring: Selection }>('/api/backends/:id/loaded-extensions', request => {
    const ctx = context(request.params.id, request.query, request.headers);
    if (!ctx.project) throw new AppError('INVALID_PROJECT', 'projectId is required');
    return deps.nativeBackends.catalog.loadedExtensions(ctx.backendId, ctx.project, ctx.profile.id);
  });
  app.get<{ Params: Params; Querystring: Selection }>('/api/backends/:id/extensions/capabilities', request => {
    const ctx = context(request.params.id, request.query, request.headers);
    return management.capabilities(ctx, deps.nativeBackends.registry.require(ctx.backendId), deps.nativeBackends.host);
  });
  app.get<{ Params: Params; Querystring: Selection }>('/api/backends/:id/extensions/runtime', async request => {
    const ctx = context(request.params.id, request.query, request.headers);
    const driver = deps.nativeBackends.registry.require(ctx.backendId);
    const report = await driver.extensions?.runtime?.(deps.nativeBackends.host, ctx.project, ctx.profile) ?? { entries: [], diagnostics: ['当前适配器未提供运行时查询；磁盘配置不代表当前会话已加载。'], checkedAt: new Date().toISOString() } satisfies ExtensionRuntimeReport;
    try { return await service.normalizeRuntimeReport(ctx, report); }
    catch { return { ...report, diagnostics: [...report.diagnostics, '未能将运行时路径对应到扩展目录；保留原始会话报告。'] }; }
  });
  app.post<{ Params: Params; Querystring: Selection; Body: ExtensionActionRequest }>('/api/backends/:id/extensions/actions', async request => {
    const ctx = context(request.params.id, request.query, request.headers);
    const body = request.body;
    if (!body || typeof body !== 'object') throw new AppError('INVALID_EXTENSION_ACTION', 'An extension action is required');
    let item = body.itemId ? (await detail(ctx, body.itemId)).item : undefined;
    const driver = deps.nativeBackends.registry.require(ctx.backendId);
    try {
      if (item?.kind === 'skill') {
        if (!item.actions?.includes(body.action)) {
          const reason = item.managementNote ?? item.readOnlyReason;
          throw new AppError('EXTENSION_READ_ONLY', reason ?? 'This skill does not support this action', 403, undefined, reason ? { subject: 'reason', reason } : { subject: 'action' });
        }
        if (body.action === 'uninstall' || !driver.extensions?.setSkillEnabled || item.sourcePath?.endsWith('.riffet-disabled')) {
          const result = await service.manageSkillFiles(ctx, body, body.action !== 'uninstall' && await management.supportsSkillSettings(ctx));
          if (body.action !== 'enable' || !driver.extensions?.setSkillEnabled || !result.success) return result;
          // A shared file may have been disabled through another Agent. Restore its
          // entry point before asking the native provider to enable the same Skill.
          service.invalidate(ctx);
          item = (await service.detail(ctx, item.id)).item;
        }
        if (item.documentId && ['enable', 'disable'].includes(body.action)) {
          item = { ...item, sourcePath: await service.resolveDocumentPath(ctx, item.documentId, true) };
        }
      }
      return await management.apply(ctx, driver, deps.nativeBackends.host, body, item);
    } finally {
      // Shared Skill files and name-based settings can affect several profiles/agents.
      service.invalidate();
      management.invalidateSkillStates();
      deps.nativeBackends.catalog.invalidateSlashCatalogs();
    }
  });
  app.get<{ Params: Params; Querystring: Selection }>('/api/backends/:id/extensions/:itemId', request => detail(context(request.params.id, request.query, request.headers), request.params.itemId));
  app.get<{ Params: Params; Querystring: Selection }>('/api/backends/:id/extensions/documents/:documentId', request => service.readDocument(context(request.params.id, request.query, request.headers), request.params.documentId));
  app.put<{ Params: Params; Querystring: Selection; Body: { content: string; expectedHash: string } }>('/api/backends/:id/extensions/documents/:documentId', async request => {
    const result = await service.writeDocument(context(request.params.id, request.query, request.headers), request.params.documentId, request.body);
    service.invalidate();
    management.invalidateSkillStates();
    deps.nativeBackends.catalog.invalidateSlashCatalogs();
    return result;
  });
  app.post<{ Params: Params; Querystring: Selection; Body: { targetId: string; path: string; content: string } }>('/api/backends/:id/extensions/documents', async request => {
    const result = await service.createDocument(context(request.params.id, request.query, request.headers), request.body);
    deps.nativeBackends.catalog.invalidateSlashCatalogs();
    return result;
  });
}
