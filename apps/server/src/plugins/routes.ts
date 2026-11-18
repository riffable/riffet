import { createReadStream } from 'node:fs';
import { basename } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PluginMarketList, PluginsResponse } from '../../../../packages/contracts/src/index.js';
import { AppError } from '../errors.js';
import { clientKinds } from './page.js';
import { localRequest } from '../auth.js';
import type { RouteDeps } from '../routes/deps.js';
import { MAX_ARCHIVE_BYTES } from '../plugins-host/archive.js';
import { parseMultipart } from '../plugins-host/multipart.js';
import { addMarketSource, checkMarketReference, downloadMarketPackage, installedPackages, listMarket, marketOffer, marketRecord, marketSources, removeMarketSource, resolveMarketPackage, setMarketSourceEnabled, type MarketOptions } from '../plugins-host/market.js';

const onServiceMachine = (request: FastifyRequest) => localRequest(request);

/** A grant is a JSON list of capability names, or a comma-separated line of them. */
function grantOf(text: string): string[] {
  const value = text.trim();
  if (value.startsWith('[')) {
    try { const parsed: unknown = JSON.parse(value); if (Array.isArray(parsed)) return parsed.map(String); } catch { /* falls through to the error */ }
    throw new AppError('INVALID_INPUT', 'grant must be a list of capability names');
  }
  return value ? value.split(',').map(item => item.trim()).filter(Boolean) : [];
}

/** Built-in plugins (docs/PLUGIN_ARCHITECTURE.md). Device codes stay in the registry; clients only see a flow id. */
export function registerPluginRoutes(app: FastifyInstance, deps: Pick<RouteDeps, 'plugins'> & Partial<Pick<RouteDeps, 'store' | 'auth'>>): void {
  const { plugins } = deps;
  if (deps.store && deps.auth) registerChannelRoute(app, plugins, deps.store, deps.auth);
  const install = async (request: FastifyRequest, input: Parameters<typeof plugins.install>[0], details: Record<string, unknown> = {}) => {
    try { return await plugins.install(input); }
    catch (error) {
      if (error instanceof AppError && (error.code === 'PLUGIN_GRANT_REQUIRED' || error.code === 'PLUGIN_TRUST_REQUIRED') && error.details && typeof error.details === 'object') {
        throw new AppError(error.code, error.message, error.statusCode, { ...error.details, ...details, trustedAllowed: onServiceMachine(request) });
      }
      throw error;
    }
  };
  const list = async (): Promise<PluginsResponse> => ({ integrations: await plugins.descriptors(), recovery: plugins.store.recovery() });
  // The sources to read and what is installed from them, as of now. A built-in or development plugin holds its id too, from no source.
  const marketOptions = async (fresh = false): Promise<MarketOptions> => ({
    sources: marketSources(plugins.store), ports: plugins.serverPorts(), fresh,
    installed: installedPackages((await plugins.descriptors()).map(item => item.source === 'installed' && item.installed
      ? { id: item.id, selected: item.installed.selected, versions: item.installed.versions }
      : { id: item.id, selected: item.version ?? '', versions: [{ version: item.version ?? '', source: item.source ?? 'builtin' }] })),
  });
  const marketList = async (request: FastifyRequest, fresh = false): Promise<PluginMarketList> => ({ ...await listMarket(await marketOptions(fresh)), trustedAllowed: onServiceMachine(request) });
  // The last evaluation: only `refresh` detects again.
  app.get('/api/integrations', list);
  app.post<{ Body: { enabled?: unknown } }>('/api/integrations/recovery', async request => {
    if (typeof request.body?.enabled !== 'boolean') throw new AppError('INVALID_INPUT', 'enabled must be a boolean');
    await plugins.setRecovery(request.body.enabled); return list();
  });
  app.post<{ Params: { id: string } }>('/api/integrations/:id/diagnostics', async request => plugins.diagnostics(request.params.id));
  app.get<{ Params: { id: string } }>('/api/integrations/:id/logs', async request => ({ logs: await plugins.logs(request.params.id) }));
  app.post<{ Params: { id: string }; Body: unknown }>('/api/integrations/:id/activate', { bodyLimit: 4096 }, async request => plugins.activateView(request.params.id, request.body));
  // The plugin's own page and README (docs/PLUGIN_ARCHITECTURE.md「插件页」).
  app.get<{ Params: { id: string }; Querystring: { locale?: string; kinds?: string } }>('/api/integrations/:id/page', async request => plugins.page(request.params.id, request.query.locale, clientKinds(request.query.kinds)));
  app.post<{ Params: { id: string }; Body: unknown; Querystring: { kinds?: string } }>('/api/integrations/:id/page', { bodyLimit: 64 * 1024 }, async request => plugins.changePage(request.params.id, request.body, clientKinds(request.query.kinds)));
  app.get<{ Params: { id: string }; Querystring: { locale?: string } }>('/api/integrations/:id/readme', async request => plugins.readme(request.params.id, request.query.locale));
  app.post<{ Params: { id: string } }>('/api/integrations/:id/reload', async request => plugins.reload(request.params.id));

  app.post<{ Body: { path?: unknown } }>('/api/integrations/development', { bodyLimit: 4096 }, async request => {
    if (!onServiceMachine(request)) throw new AppError('PLUGIN_DEVELOPMENT_LOCAL_ONLY', 'Development links are only available from this machine', 403);
    if (typeof request.body?.path !== 'string' || !request.body.path) throw new AppError('INVALID_INPUT', 'path must be text');
    return plugins.linkDevelopment(request.body.path);
  });
  app.delete<{ Params: { id: string } }>('/api/integrations/development/:id', async request => {
    if (!onServiceMachine(request)) throw new AppError('PLUGIN_DEVELOPMENT_LOCAL_ONLY', 'Development links are only available from this machine', 403);
    return { integrations: await plugins.unlinkDevelopment(request.params.id) };
  });

  // The plugin indexes (docs/PLUGINS.md「插件市场」): what can be installed from them, and one release before installing it.
  app.get<{ Querystring: { refresh?: string } }>('/api/integrations/market', async (request): Promise<PluginMarketList> => marketList(request, request.query.refresh === '1'));
  app.get<{ Params: { id: string }; Querystring: { version?: string; source?: string } }>('/api/integrations/market/:id', async request => {
    const found = await resolveMarketPackage(checkMarketReference({ id: request.params.id, version: request.query.version || undefined, source: request.query.source || undefined }), await marketOptions());
    return { ...marketOffer(found), ...(found.trustedRequired ? { trustedAllowed: onServiceMachine(request) } : {}) };
  });
  // Any signed-in client may manage sources: adding one decides what can be found, and every install still needs its grant.
  app.post<{ Body: { url?: unknown } }>('/api/integrations/sources', { bodyLimit: 4096 }, async request => {
    if (typeof request.body?.url !== 'string' || !request.body.url.trim()) throw new AppError('INVALID_INPUT', 'url must be text');
    await addMarketSource(plugins.store, request.body.url, { ports: plugins.serverPorts() });
    return marketList(request);
  });
  app.patch<{ Params: { id: string }; Body: { enabled?: unknown } }>('/api/integrations/sources/:id', { bodyLimit: 4096 }, async request => {
    if (typeof request.body?.enabled !== 'boolean') throw new AppError('INVALID_INPUT', 'enabled must be a boolean');
    setMarketSourceEnabled(plugins.store, request.params.id, request.body.enabled);
    return marketList(request);
  });
  app.delete<{ Params: { id: string } }>('/api/integrations/sources/:id', async request => {
    removeMarketSource(plugins.store, request.params.id);
    return marketList(request);
  });

  app.post('/api/integrations/refresh', { bodyLimit: 4096 }, async () => { await plugins.refresh(); return list(); });
  app.patch<{ Body: unknown }>('/api/integrations', { bodyLimit: 4096 }, async request => {
    const body = request.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError('INVALID_INTEGRATION_UPDATE', 'Expected an object');
    const { defaultSharePublisher, ...rest } = body as Record<string, unknown>;
    if (Object.keys(rest).length) throw new AppError('INVALID_INTEGRATION_UPDATE', `Unknown field ${Object.keys(rest)[0]}`);
    if (defaultSharePublisher !== undefined) plugins.setDefaultSharePublisher(defaultSharePublisher);
    return list();
  });

  // Installing: a multipart upload of a .tgz (`package`, with `grant`), `{ path, grant }` naming a
  // directory or .tgz on this machine, which only a request from this machine may do (the CLI), or
  // `{ market: { source?, id, version? }, grant }`, a release of a plugin index that the server downloads.
  // The parser is local to this scope so no other route accepts a multipart body.
  void app.register(async scope => {
    scope.addContentTypeParser('multipart/form-data', { parseAs: 'buffer', bodyLimit: MAX_ARCHIVE_BYTES + 1024 * 1024 }, (_request, body, done) => done(null, body));
    scope.post('/api/integrations/install', { bodyLimit: MAX_ARCHIVE_BYTES + 1024 * 1024 }, async (request: FastifyRequest) => {
      const type = request.headers['content-type'] ?? '';
      if (type.toLowerCase().startsWith('multipart/form-data')) {
        const parts = parseMultipart(request.body as Buffer, type);
        const file = parts.find(part => part.name === 'package' && part.filename !== undefined);
        if (!file) throw new AppError('INVALID_INPUT', 'Expected a file in the "package" field');
        const grant = parts.filter(part => part.name === 'grant').flatMap(part => grantOf(part.data.toString('utf8')));
        const trust = parts.filter(part => part.name === 'trusted');
        const choice = trust[0]?.data.toString('utf8').trim();
        if (trust.length > 1 || (choice !== undefined && choice !== 'true' && choice !== 'false')) throw new AppError('INVALID_INPUT', 'trusted must be true or false');
        if (choice === 'true' && (!onServiceMachine(request))) throw new AppError('PLUGIN_TRUST_LOCAL_ONLY', 'Trusted installation is only available directly on the service machine', 403);
        return install(request, { input: { archive: file.data }, source: `upload:${basename(file.filename!).slice(0, 120) || 'package.tgz'}`, grant, ...(choice === 'true' ? { trusted: true } : {}) });
      }
      const body = request.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError('INVALID_INPUT', 'Expected a multipart upload, { path, grant } or { market, grant }');
      const { path, grant, trusted, market } = body as Record<string, unknown>;
      if (trusted !== undefined && typeof trusted !== 'boolean') throw new AppError('INVALID_INPUT', 'trusted must be a boolean');
      // From the plugin index: any client may ask, trust stays with the service machine as for an upload.
      if (market !== undefined) {
        const reference = checkMarketReference(market);
        if (trusted === true && !onServiceMachine(request)) throw new AppError('PLUGIN_TRUST_LOCAL_ONLY', 'Trusted installation is only available directly on the service machine', 403);
        const options = await marketOptions();
        const found = await resolveMarketPackage(reference, options);
        const archive = await downloadMarketPackage(found, { ports: options.ports });
        return install(request, { input: { archive }, source: marketRecord(found), grant, expected: found, ...(trusted === true ? { trusted: true } : {}) }, { sourceId: found.sourceId });
      }
      if (typeof path !== 'string' || !path) throw new AppError('INVALID_INPUT', 'path must be text');
      if (!onServiceMachine(request)) throw new AppError('PLUGIN_PATH_INSTALL_LOCAL_ONLY', 'Installing from a path is only available from this machine; upload the package instead', 403);
      return install(request, { input: { path }, source: `path:${path}`, grant, ...(trusted === true ? { trusted: true } : {}) });
    });
  });

  app.patch<{ Params: { id: string }; Body: unknown }>('/api/integrations/:id', { bodyLimit: 256 * 1024 }, async request => plugins.update(request.params.id, request.body));
  app.post<{ Params: { id: string; version: string } }>('/api/integrations/:id/versions/:version/select', { bodyLimit: 4096 }, async request => plugins.selectVersion(request.params.id, request.params.version));
  app.delete<{ Params: { id: string; version: string } }>('/api/integrations/:id/versions/:version', async request => ({ integrations: await plugins.uninstallVersion(request.params.id, request.params.version) }));
  app.delete<{ Params: { id: string }; Querystring: { source?: string; path?: string } }>('/api/integrations/:id', async request => {
    const { source, path } = request.query;
    if (source !== undefined && source !== 'installed' && source !== 'development') throw new AppError('INVALID_INPUT', 'source must be installed or development');
    if (path !== undefined && typeof path !== 'string') throw new AppError('INVALID_INPUT', 'path must be text');
    return { integrations: await plugins.uninstall(request.params.id, { source, path, allowDevelopment: onServiceMachine(request) }) };
  });
  app.delete<{ Params: { id: string } }>('/api/integrations/:id/data', async request => ({ integrations: await plugins.deleteData(request.params.id) }));
  app.post<{ Params: { id: string; action: string } }>('/api/integrations/:id/actions/:action', { bodyLimit: 4096 }, async request => plugins.runAction(request.params.id, request.params.action));
  app.post<{ Params: { id: string; flowId: string } }>('/api/integrations/:id/flows/:flowId/poll', { bodyLimit: 4096 }, async request => plugins.pollFlow(request.params.id, request.params.flowId));
  // The files of a development or installed package, such as its web entry. Never a built-in's.
  app.get<{ Params: { id: string; '*': string } }>('/api/integrations/:id/files/*', async (request, reply) => {
    const { file, type } = await plugins.developmentFile(request.params.id, request.params['*']);
    // Package bytes on the app's own origin: opened as a page (an SVG with a script, say) they would run with the user's session.
    // Every client fetches these or loads them as subresources, where the sandbox does not apply.
    return reply.type(type).header('Cache-Control', 'no-cache').header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "sandbox; default-src 'none'").send(createReadStream(file));
  });
}

function registerChannelRoute(app: FastifyInstance, plugins: RouteDeps['plugins'], store: RouteDeps['store'], auth: RouteDeps['auth']): void {
  // A plugin's per-session socket (`contributes.channels`, docs/BROWSER.md §5). The user is checked by the API hook; the
  // session, the plugin being on and the declaration here. Turning the plugin off or revoking the login closes it.
  app.get<{ Params: { id: string; name: string }; Querystring: { sessionId?: string } }>('/api/integrations/:id/channels/:name', { websocket: true }, (socket, request) => {
    let session: ReturnType<typeof store.getSession> | undefined;
    try { session = store.getSession(String(request.query.sessionId ?? '')); } catch { /* answered below */ }
    if (!session || session.archivedAt) { socket.close(4404, 'No such conversation'); return; }
    const found = plugins.channel(request.params.id, request.params.name);
    if (!found) { socket.close(4503, 'Channel unavailable'); return; }
    const controller = new AbortController();
    const close = () => { if (socket.readyState <= 1) socket.close(4503, 'Plugin turned off'); };
    found.signal.addEventListener('abort', close, { once: true });
    const unwatch = auth.onRevoke(request, () => socket.terminate());
    socket.once('close', () => { controller.abort(); unwatch(); found.signal.removeEventListener('abort', close); });
    let handlers: ReturnType<typeof found.handler.open>;
    try {
      handlers = found.handler.open({ sessionId: session.id, projectId: session.projectId, signal: controller.signal }, {
        send: data => { if (socket.readyState === 1) socket.send(data); },
        close: (code, reason) => socket.close(code ?? 1000, reason),
        get bufferedAmount() { return socket.bufferedAmount; },
      });
    } catch { socket.close(1011, 'Channel failed to open'); return; }
    socket.on('message', (raw: Buffer | ArrayBuffer | Buffer[], binary: boolean) => {
      try { auth.authenticate(request); } catch { socket.terminate(); return; }
      const bytes = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as ArrayBuffer);
      try { handlers?.message?.(binary ? new Uint8Array(bytes) : bytes.toString('utf8'), binary); } catch { /* the plugin's own failure */ }
    });
  });
}
