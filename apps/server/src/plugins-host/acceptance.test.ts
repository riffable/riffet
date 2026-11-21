import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PLUGIN_QUERY_BUDGET, PLUGIN_QUERY_ROUTE, type AppearanceCatalog, type PluginDescriptor, type PluginsResponse } from '../../../../packages/contracts/src/index.js';
import { packPlugin, tarball } from '../../../../scripts/pack-plugin.js';
import { readDirectory } from './archive.js';
import { createApp } from '../app.js';

// Phase F acceptance (docs/design/plugin-system.md): the sample packages in examples/plugins/, installed and
// run through the HTTP API of a real app, the way a user or the CLI would.

const examples = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../../examples/plugins');
const cleanups: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function temp(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'riffet-accept-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function boot(devPlugins: string[] = [], existingStateDir?: string, auth = false) {
  const stateDir = existingStateDir ?? await temp();
  if (devPlugins.length) vi.stubEnv('RIFFET_DEV_PLUGINS', devPlugins.join(':'));
  const { app, plugins } = await createApp({ stateDir, auth, cliPath: '/nonexistent/cursor-agent' });
  cleanups.push(() => app.close());
  const status = await app.inject({ method: auth ? 'POST' : 'GET', url: auth ? '/api/auth/login' : '/api/auth/status', headers: { host: '127.0.0.1:4317' }, ...(auth ? { payload: { token: (await readFile(join(stateDir, 'access-token'), 'utf8')).trim() } } : {}) });
  const cookie = String(status.headers['set-cookie']).split(';')[0]!;
  const csrf = (status.json() as { csrfToken: string }).csrfToken;
  const authHeaders = { cookie, 'x-csrf-token': csrf };
  const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown, headers: Record<string, string> = {}, remoteAddress?: string) => app.inject({
    method, url, headers: { host: '127.0.0.1:4317', ...authHeaders, ...headers }, ...(payload === undefined ? {} : { payload: payload as object }),
    ...(remoteAddress ? { remoteAddress } : {}),
  });
  const upload = (archive: Buffer, grant: string[], name = 'package.tgz', fields: Record<string, string> = {}, options: { remoteAddress?: string; headers?: Record<string, string> } = {}) => {
    const boundary = '----riffet-accept';
    const part = (header: string, body: Buffer | string) => [Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; ${header}\r\n\r\n`), Buffer.from(body), Buffer.from('\r\n')];
    const payload = Buffer.concat([...part(`name="package"; filename="${name}"`, archive), ...part('name="grant"', JSON.stringify(grant)), ...Object.entries(fields).flatMap(([name, value]) => part(`name="${name}"`, value)), Buffer.from(`--${boundary}--\r\n`)]);
    return app.inject({ method: 'POST', url: '/api/integrations/install', headers: { host: '127.0.0.1:4317', cookie, 'x-csrf-token': csrf, 'content-type': `multipart/form-data; boundary=${boundary}`, ...options.headers }, ...(options.remoteAddress ? { remoteAddress: options.remoteAddress } : {}), payload });
  };
  const list = async () => ((await call('GET', '/api/integrations')).json() as PluginsResponse).integrations;
  const row = async (id: string) => (await list()).find(item => item.id === id) as PluginDescriptor;
  return { app, stateDir, call, upload, list, row, plugins, authHeaders };
}

/** A copy of a sample with one file replaced and a new version, packed (without the packer's own checks, so the server's are what is tested). */
async function variant(sample: string, version: string, files: Record<string, string> = {}): Promise<Buffer> {
  const directory = join(await temp(), sample);
  await cp(join(examples, sample), directory, { recursive: true });
  const manifestFile = join(directory, 'riffet-plugin.json');
  await writeFile(manifestFile, JSON.stringify({ ...JSON.parse(await readFile(manifestFile, 'utf8')), version }));
  for (const [path, body] of Object.entries(files)) await writeFile(join(directory, path), body);
  return tarball(await readDirectory(directory));
}
const sample = async (name: string) => (await packPlugin(join(examples, name))).archive;
const palettesOf = (catalog: AppearanceCatalog) => catalog.palettes.filter(item => item.plugin === 'example.graphite-theme');

/** An OpenAI-compatible gateway that lists two models and remembers how it was asked. */
async function gateway(): Promise<{ url: string; asked: string[] }> {
  const asked: string[] = [];
  const server: Server = createServer((request, response) => {
    asked.push(`${request.url} ${request.headers.authorization ?? ''}`);
    response.setHeader('content-type', 'application/json').end(JSON.stringify({ data: [{ id: 'gw-large' }, { id: 'gw-small' }] }));
  }).listen(0, '127.0.0.1');
  await new Promise(done => server.once('listening', done));
  cleanups.push(() => new Promise(done => server.close(done)));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, asked };
}

describe('the sample packages, installed through the HTTP API', () => {
  it('runs a declared query in the installed package and reports changes to its views', async () => {
    const { app, call, upload, plugins } = await boot([], undefined, true);
    const pluginId = 'example.workbench-sample';
    const query = PLUGIN_QUERY_ROUTE(pluginId, 'summary');
    expect((await upload(await sample('workbench-sample'), [])).statusCode).toBe(200);
    expect((await call('PATCH', `/api/integrations/${pluginId}`, { enablement: 'on' })).statusCode).toBe(200);
    const denied = await app.inject({ method: 'POST', url: query, headers: { host: '127.0.0.1:4317' }, payload: {} });
    expect(denied.statusCode).toBe(401);
    expect((await call('POST', query, {})).json()).toMatchObject({ count: 0 });

    const notify = vi.fn();
    cleanups.push(plugins.onViewData(notify));
    const bump = await call('POST', `/api/integrations/${pluginId}/commands/bump`, { requestId: 'bump' });
    expect(bump.statusCode).toBe(200);
    expect(notify).toHaveBeenCalledExactlyOnceWith({ pluginId, topic: 'summary' });
    expect((await call('POST', query, {})).json()).toMatchObject({ count: 1 });
    expect((await call('POST', PLUGIN_QUERY_ROUTE(pluginId, 'missing'), {})).statusCode).toBe(404);
  });

  it('sends JSON query results and cancels just the disconnected caller inside the plugin process', async () => {
    const { app, call, upload, authHeaders } = await boot([], undefined, true);
    const query = PLUGIN_QUERY_ROUTE('example.workbench-sample', 'summary');
    const archive = await variant('workbench-sample', '1.0.0', { 'server/index.mjs': `
      export default { activate() {
        let state = 'idle';
        return { queries: { 'example.workbench-sample/summary': { run({ params, signal }) {
          if (params.invalid) return () => state;
          if (params.large) return '界'.repeat(${Math.ceil(PLUGIN_QUERY_BUDGET.resultBytes / 3)});
          if (!params.wait) return state;
          state = 'running';
          return new Promise(resolve => signal.addEventListener('abort', () => { state = 'cancelled'; resolve(null); }, { once: true }));
        } } } };
      } };
    ` });
    expect((await upload(archive, [])).statusCode).toBe(200);
    expect((await call('PATCH', '/api/integrations/example.workbench-sample', { enablement: 'on' })).statusCode).toBe(200);
    const readState = async () => (await call('POST', query, {})).json();
    expect(await readState()).toBe('idle');
    expect((await call('POST', query, { params: { invalid: true } })).json().error.code).toBe('QUERY_FAILED');
    expect((await call('POST', query, { params: { large: true } })).json().error.code).toBe('QUERY_TOO_LARGE');

    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const controller = new AbortController();
    const disconnected = fetch(new URL(query, address), {
      method: 'POST', headers: { ...authHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ params: { wait: true } }), signal: controller.signal,
    }).catch((error: unknown) => error);
    try {
      await vi.waitFor(async () => { expect(await readState()).toBe('running'); });
    } finally {
      controller.abort();
      await disconnected;
    }
    await vi.waitFor(async () => { expect(await readState()).toBe('cancelled'); });
  });

  it('protects management writes, rejects stale configuration, and retains metadata in recovery', async () => {
    const { app, call, upload, row } = await boot();
    for (const url of ['/api/integrations/recovery', '/api/integrations/development', '/api/integrations/example.gateway-models/reload', '/api/integrations/example.gateway-models/diagnostics']) {
      const denied = await app.inject({ method: 'POST', url, headers: { host: '127.0.0.1:4317' }, payload: { enabled: true } });
      expect(denied.statusCode).toBe(401);
      expect((await call('POST', url, { enabled: true }, { 'x-csrf-token': '' })).statusCode).toBe(403);
    }
    expect((await upload(await sample('gateway-models'), ['models.provide', 'network'])).statusCode).toBe(200);
    const before = await row('example.gateway-models');
    expect((await call('PATCH', '/api/integrations/example.gateway-models', { configRevision: before.configRevision, settings: { apiKey: 'secret-cas' } })).statusCode).toBe(200);
    const stale = await call('PATCH', '/api/integrations/example.gateway-models', { configRevision: before.configRevision, settings: { apiKey: 'lost' } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('PLUGIN_CONFIG_CONFLICT');
    expect((await call('POST', '/api/integrations/recovery', { enabled: true })).json().recovery).toBe(true);
    expect(await row('example.gateway-models')).toMatchObject({ enabled: false, declared: { modelSources: [{ id: 'example.gateway-models.gateway' }] } });
    expect(JSON.stringify(await row('example.gateway-models'))).not.toContain('secret-cas');
    expect((await call('POST', '/api/integrations/example.gateway-models/diagnostics')).json()).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'warn' })]));
    expect((await call('POST', '/api/integrations/recovery', { enabled: false })).statusCode).toBe(200);
    expect((await call('POST', '/api/integrations/example.gateway-models/reload')).json().enabled).toBe(true);
  });

  it('links and unlinks development packages only through authenticated local requests', async () => {
    const { app, call, row, stateDir } = await boot();
    const pkg = join(examples, 'graphite-theme');
    const url = '/api/integrations/development';
    const remoteHeaders: Record<string, string>[] = [{ 'x-forwarded-for': '203.0.113.9' }, { forwarded: 'for=203.0.113.9' }, { 'tailscale-user-login': 'remote@example.com' }];
    for (const headers of remoteHeaders) {
      expect((await call('POST', url, { path: pkg }, headers)).statusCode).toBe(403);
    }
    expect((await call('POST', url, { path: pkg }, {}, '203.0.113.9')).statusCode).toBe(403);
    expect(await row('example.graphite-theme')).toBeUndefined();
    const linked = await call('POST', url, { path: pkg });
    expect(linked.statusCode).toBe(200);
    expect(linked.json()).toMatchObject({ id: 'example.graphite-theme', source: 'development', enabled: true });
    expect(JSON.parse(await readFile(join(stateDir, 'plugins.json'), 'utf8')).development).toMatchObject({ 'example.graphite-theme': expect.any(String) });
    const unlink = '/api/integrations/development/example.graphite-theme';
    expect((await app.inject({ method: 'DELETE', url: unlink, headers: { host: '127.0.0.1:4317' } })).statusCode).toBe(401);
    expect((await call('DELETE', unlink, undefined, { 'x-csrf-token': '' })).statusCode).toBe(403);
    expect((await call('DELETE', unlink, undefined, { 'x-forwarded-for': '203.0.113.9' })).statusCode).toBe(403);
    expect((await call('DELETE', unlink, undefined, {}, '203.0.113.9')).statusCode).toBe(403);
    expect((await call('DELETE', unlink)).statusCode).toBe(200);
    expect(await row('example.graphite-theme')).toBeUndefined();
    expect(JSON.parse(await readFile(join(stateDir, 'plugins.json'), 'utf8')).development).toEqual({});
  });

  it('uninstalls environment development packages through the authenticated local management route', async () => {
    const pkg = join(examples, 'graphite-theme');
    const { app, call, row, stateDir } = await boot([pkg], undefined, true);
    const selected = await row('example.graphite-theme');
    expect(selected).toMatchObject({ source: 'development', developmentPath: expect.any(String) });
    const url = '/api/integrations/example.graphite-theme?' + new URLSearchParams({ source: 'development', path: selected.developmentPath! });
    // A caller cannot label a development target as installed to bypass its local-only guard.
    expect((await call('DELETE', '/api/integrations/example.graphite-theme?source=installed', undefined, {}, '203.0.113.9')).statusCode).toBe(404);
    expect((await call('DELETE', '/api/integrations/example.graphite-theme?source=development&path=/not-a-known-plugin')).statusCode).toBe(404);
    expect((await call('DELETE', '/api/integrations/example.graphite-theme?source=builtin')).statusCode).toBe(400);
    expect(await row('example.graphite-theme')).toMatchObject({ source: 'development' });
    const before = await readFile(join(pkg, 'riffet-plugin.json'), 'utf8');
    expect((await app.inject({ method: 'DELETE', url, headers: { host: '127.0.0.1:4317' } })).statusCode).toBe(401);
    expect((await call('DELETE', url, undefined, { 'x-csrf-token': '' })).statusCode).toBe(403);
    const remoteHeaders: Record<string, string>[] = [{ 'x-forwarded-for': '203.0.113.9' }, { forwarded: 'for=203.0.113.9' }, { 'tailscale-user-login': 'remote@example.com' }];
    for (const headers of remoteHeaders) {
      const denied = await call('DELETE', url, undefined, headers);
      expect(denied.statusCode).toBe(403);
      expect(denied.json().error.code).toBe('PLUGIN_DEVELOPMENT_LOCAL_ONLY');
    }
    const remote = await call('DELETE', url, undefined, {}, '203.0.113.9');
    expect(remote.statusCode).toBe(403);
    expect(remote.json().error.code).toBe('PLUGIN_DEVELOPMENT_LOCAL_ONLY');
    expect(await row('example.graphite-theme')).toMatchObject({ source: 'development' });
    expect((await call('DELETE', url)).statusCode).toBe(200);
    expect(await row('example.graphite-theme')).toBeUndefined();
    expect(await readFile(join(pkg, 'riffet-plugin.json'), 'utf8')).toBe(before);
    await app.close();
    expect(await (await boot([pkg], stateDir)).row('example.graphite-theme')).toBeUndefined();
  });

  it('lists the model source of the gateway sample and the palette of the theme sample', async () => {
    const { call, upload, row } = await boot();
    const models = await sample('gateway-models');

    // A grant that is not exactly what the package asks for installs nothing and says what to confirm.
    const refused = await upload(models, ['models.provide']);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatchObject({ code: 'PLUGIN_GRANT_REQUIRED', details: { id: 'example.gateway-models', capabilities: ['models.provide', 'network'] } });
    expect(await row('example.gateway-models')).toBeUndefined();

    const installed = await upload(models, ['models.provide', 'network']);
    expect(installed.statusCode).toBe(200);
    expect(installed.json()).toMatchObject({ id: 'example.gateway-models', source: 'installed', enabled: true, capabilities: ['models.provide', 'network'], contributes: { modelSources: [{ id: 'example.gateway-models.gateway', backends: ['codex'] }] } });

    // The source answers through the process it runs in, which asks the gateway the user configured.
    const gw = await gateway();
    expect((await call('PATCH', '/api/integrations/example.gateway-models', { settings: { baseUrl: gw.url, apiKey: 'sk-test' } })).statusCode).toBe(200);
    const probed = await call('POST', '/api/backends/codex/model-probe', { modelSource: 'example.gateway-models.gateway' });
    expect(probed.statusCode).toBe(200);
    expect((probed.json().models as Array<{ value: string }>).map(model => model.value)).toEqual(expect.arrayContaining(['gw-large', 'gw-small']));
    expect(gw.asked.every(request => request.endsWith('Bearer sk-test'))).toBe(true);
    expect((await row('example.gateway-models')).settings).toEqual([
      expect.objectContaining({ key: 'baseUrl', value: gw.url }),
      expect.objectContaining({ key: 'apiKey', set: true }),
    ]);
    expect(JSON.stringify(await call('GET', '/api/integrations').then(reply => reply.json()))).not.toContain('sk-test');

    // The theme asks for nothing, and its palette and preset are in the appearance catalog with a servable asset.
    const theme = await upload(await sample('graphite-theme'), []);
    expect(theme.statusCode).toBe(200);
    const catalog = (await call('GET', '/api/appearance')).json() as AppearanceCatalog;
    expect(palettesOf(catalog)).toEqual([expect.objectContaining({ id: 'example.graphite-theme/graphite' })]);
    expect(catalog.presets.filter(item => item.plugin === 'example.graphite-theme')).toEqual([expect.objectContaining({ id: 'example.graphite-theme/standard', palette: 'example.graphite-theme/graphite' })]);
    const asset = await call('GET', palettesOf(catalog)[0]!.asset.url);
    expect(asset.statusCode).toBe(200);
    expect(asset.json()).toMatchObject({ name: 'Graphite' });
  });

  it('keeps the previous version active and served when a newer one is broken', async () => {
    const { call, upload, row } = await boot();
    const gw = await gateway();
    await upload(await sample('gateway-models'), ['models.provide', 'network']);
    await call('PATCH', '/api/integrations/example.gateway-models', { settings: { baseUrl: gw.url, apiKey: 'sk-test' } });
    await upload(await sample('graphite-theme'), []);

    // A version that starts and then throws: rolled back, with the reason on the row.
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const broken = await upload(await variant('gateway-models', '1.1.0', { 'server/index.mjs': "export default { activate() { throw new Error('this version is broken'); } };" }), ['models.provide', 'network']);
    expect(broken.statusCode).toBe(409);
    expect(broken.json().error).toMatchObject({ code: 'PLUGIN_ACTIVATION_FAILED', message: expect.stringContaining('this version is broken') });
    expect(await row('example.gateway-models')).toMatchObject({
      version: '1.0.0', enabled: true, status: { state: 'attention', message: expect.stringContaining('1.1.0 could not start') },
      installed: { selected: '1.0.0', versions: [{ version: '1.1.0', selected: false }, { version: '1.0.0', selected: true }] },
    });
    const probed = await call('POST', '/api/backends/codex/model-probe', { modelSource: 'example.gateway-models.gateway' });
    expect((probed.json().models as Array<{ value: string }>).map(model => model.value)).toContain('gw-large');

    // A version whose palette is not a theme never gets in, so the working palette stays in the catalog.
    const invalid = await upload(await variant('graphite-theme', '1.1.0', { 'assets/graphite.json': '{"not":"a theme"}' }), []);
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json().error.message).toContain('assets/graphite.json');
    expect((await row('example.graphite-theme')).installed!.versions.map(version => version.version)).toEqual(['1.0.0']);
    expect(palettesOf((await call('GET', '/api/appearance')).json() as AppearanceCatalog)).toHaveLength(1);
  });

  it('serves the previous version\'s asset addresses after an upgrade, until that version is removed', async () => {
    const { call, upload } = await boot();
    await upload(await sample('graphite-theme'), []);
    const before = palettesOf((await call('GET', '/api/appearance')).json() as AppearanceCatalog)[0]!.asset;

    const palette = JSON.parse(await readFile(join(examples, 'graphite-theme/assets/graphite.json'), 'utf8')) as { palette: { light: Record<string, string> } };
    palette.palette.light.accent = '#2f5d8a';
    expect((await upload(await variant('graphite-theme', '1.1.0', { 'assets/graphite.json': JSON.stringify(palette) }), [])).statusCode).toBe(200);
    const after = palettesOf((await call('GET', '/api/appearance')).json() as AppearanceCatalog)[0]!.asset;
    expect(after.sha256).not.toBe(before.sha256);

    // A client that still holds the old catalog asks for the old address: it gets the old bytes, not the new ones.
    const old = await call('GET', before.url);
    expect(old.statusCode).toBe(200);
    expect(old.json().palette.light.accent).not.toBe('#2f5d8a');
    expect((await call('GET', after.url)).json().palette.light.accent).toBe('#2f5d8a');

    // The version is removed: its files go, and so does its address.
    expect((await call('DELETE', '/api/integrations/example.graphite-theme/versions/1.0.0')).statusCode).toBe(200);
    expect((await call('GET', before.url)).statusCode).toBe(404);
    expect((await call('GET', after.url)).statusCode).toBe(200);
  });
});

/** Minimal local packages exercise trust without external CLIs, networks or credentials. */
async function localPackage(id: string, version: string, body: string, extra: Record<string, unknown> = {}) {
  const directory = await temp();
  await writeFile(join(directory, 'riffet-plugin.json'), JSON.stringify({ id, vendor: 'Acceptance', name: id, apiVersion: 1, version, defaultEnabled: true, entries: { server: 'index.mjs' }, ...extra }));
  await writeFile(join(directory, 'index.mjs'), body);
  return { directory, archive: tarball(await readDirectory(directory)) };
}

describe('the public plugin index', () => {
  /** An index at a loopback address that lists one release of the theme sample, served with `served` as its archive. */
  async function index(listed: { integrity: string }, served: Buffer, redirect?: string, extra: unknown[] = []) {
    const server: Server = createServer((request, response) => {
      if (request.url === '/plugins/index.json') {
        response.setHeader('content-type', 'application/json').end(JSON.stringify({ schemaVersion: 1, plugins: [{ id: 'example.graphite-theme', manifest: { title: { en: 'Graphite' } }, versions: [{ version: '1.0.0', archive: 'packages/graphite.tgz', integrity: listed.integrity, capabilities: [] }] }, ...extra] }));
      } else if (request.url === '/plugins/packages/graphite.tgz') { if (redirect) response.writeHead(302, { location: redirect }).end(); else response.end(served); }
      else response.writeHead(404).end();
    }).listen(0, '127.0.0.1');
    await new Promise(done => server.once('listening', done));
    cleanups.push(() => new Promise(done => server.close(done)));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/plugins/index.json`;
    vi.stubEnv('RIFFET_PLUGIN_INDEX', url);
    return url;
  }

  it('installs the release the index lists and refuses content it does not vouch for', async () => {
    const packed = await packPlugin(join(examples, 'graphite-theme'));
    await index(packed, await variant('graphite-theme', '1.0.0', { 'README.md': 'changed' }));
    const { call, row } = await boot();
    const offer = await call('GET', '/api/integrations/market/example.graphite-theme');
    expect(offer.json()).toMatchObject({ id: 'example.graphite-theme', version: '1.0.0', capabilities: [] });
    const refused = await call('POST', '/api/integrations/install', { market: { id: 'example.graphite-theme' }, grant: [] });
    expect(refused.statusCode, refused.body).toBe(422);
    expect(refused.json().error.code).toBe('PLUGIN_MARKET_MISMATCH');
    expect(await row('example.graphite-theme')).toBeUndefined();

    await index(packed, packed.archive);
    const installed = await call('POST', '/api/integrations/install', { market: { id: 'example.graphite-theme', version: '1.0.0' }, grant: [] });
    expect(installed.statusCode, installed.body).toBe(200);
    expect((await row('example.graphite-theme')).installed?.versions[0]).toMatchObject({ version: '1.0.0', source: 'market:riffet/example.graphite-theme@1.0.0', integrity: packed.integrity });
  });

  it('lists several sources, pins an install to its source and refuses the same id from another', async () => {
    const packed = await packPlugin(join(examples, 'graphite-theme'));
    // Entries with the wrong types are someone else's mistake: they are left out, the rest of the source is listed.
    const added = await index(packed, packed.archive, undefined, [
      { id: 'acme.broken', versions: [{ version: '1.0.0', archive: 'b.tgz', integrity: 'sha256-0', hostApi: { server: 1 } }] },
      { id: 'acme.untitled', manifest: { title: { en: 7 } }, versions: [{ version: '1.0.0', archive: 'u.tgz', integrity: 'sha256-0' }] },
    ]);
    await index(packed, packed.archive);
    const { call, row } = await boot();
    const sourceId = ((await call('POST', '/api/integrations/sources', { url: added })).json() as { sources: Array<{ id: string }> }).sources[1]!.id;
    expect((await call('POST', '/api/integrations/sources', { url: added })).json().error.code).toBe('PLUGIN_SOURCE_EXISTS');
    const listed = (await call('GET', '/api/integrations/market')).json() as { plugins: Array<{ sourceId: string; id: string; title?: unknown }>; sources: unknown[] };
    expect(listed.plugins.map(item => `${item.sourceId} ${item.id}`).sort()).toEqual([`riffet example.graphite-theme`, `${sourceId} acme.untitled`, `${sourceId} example.graphite-theme`].sort());
    expect(listed.plugins.find(item => item.id === 'acme.untitled')?.title).toBeUndefined();
    const ambiguous = await call('POST', '/api/integrations/install', { market: { id: 'example.graphite-theme' }, grant: [] });
    expect(ambiguous.json().error.code).toBe('PLUGIN_MARKET_AMBIGUOUS');
    expect((await call('POST', '/api/integrations/install', { market: { source: sourceId, id: 'example.graphite-theme' }, grant: [] })).statusCode).toBe(200);
    expect((await row('example.graphite-theme')).installed?.versions[0]?.source).toBe(`market:${sourceId}/example.graphite-theme@1.0.0`);
    const other = await call('POST', '/api/integrations/install', { market: { source: 'riffet', id: 'example.graphite-theme' }, grant: [] });
    expect([other.statusCode, other.json().error.code]).toEqual([409, 'PLUGIN_SOURCE_CONFLICT']);
    const after = (await call('GET', '/api/integrations/market')).json() as { plugins: Array<{ sourceId: string; installed?: { sameSource: boolean } }> };
    expect(after.plugins.map(item => [item.sourceId, item.installed?.sameSource])).toEqual(expect.arrayContaining([['riffet', false], [sourceId, true]]));
    expect((await call('DELETE', `/api/integrations/sources/${sourceId}`)).statusCode).toBe(200);
    expect(await row('example.graphite-theme')).toBeDefined();
  });

  it('checks every redirect hop of a download before requesting it', async () => {
    const packed = await packPlugin(join(examples, 'graphite-theme'));
    await index(packed, packed.archive, 'http://download.example/graphite.tgz');
    const { call, row } = await boot();
    const requested: string[] = [];
    const real = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => { requested.push(String(input)); return real(input, init); });
    const refused = await call('POST', '/api/integrations/install', { market: { id: 'example.graphite-theme', version: '1.0.0' }, grant: [] });
    expect(refused.statusCode).toBe(502);
    expect(requested.some(url => url.includes('download.example'))).toBe(false);
    expect(requested.some(url => url.endsWith('/plugins/packages/graphite.tgz'))).toBe(true);
    expect(await row('example.graphite-theme')).toBeUndefined();
  });
});

describe('explicitly trusted local installations', () => {
  it('activates lazy commands, login, task discovery and views through public entry points', async () => {
    const { call, row } = await boot();
    const id = 'acme.lazy-http';
    const fixture = await localPackage(id, '1.0.0', `export default { activate(host) {
      host.logger.info('Activation with ' + host.secrets.get('token'));
      return {
        modelSources:[{id:'acme.lazy-http.gateway',label:'Gateway',protocols:['openai-responses'],resolve:()=>({}),catalog:async()=>[]}],
        commands:{'acme.lazy-http/ping':{run:async()=>({kind:'done'})}},
        actions:{login:{label:'Login',kind:'run',run:async()=>({kind:'done'})}},
        taskProviders:[{id:'acme.lazy-http/jobs',detect:async project=>project.exists('settings.gradle'),actions:async()=>[{id:'build',title:{en:'Build'}}],plan:async()=>{throw new Error('fixture must not run')}}]
      }; } };`, { activation: ['command', 'model-source', 'task', 'view'], settings: [{ key: 'token', label: 'Token', kind: 'secret' }], contributes: {
      modelSources: [{ id: 'acme.lazy-http.gateway', title: { en: 'Gateway' }, protocols: ['openai-responses'], loginAction: 'login' }],
      actions: [{ id: 'login', label: 'Login', kind: 'run' }],
      commands: [{ id: 'acme.lazy-http/ping', title: { en: 'Ping' }, scope: 'global' }],
      tasks: [{ id: 'acme.lazy-http/jobs', title: { en: 'Jobs' }, projectType: 'android' }],
      views: [{ id: 'acme.lazy-http/view', title: { en: 'View' }, locations: ['sidebar'], clients: ['web'], instances: 'single' }],
    } });
    expect((await call('POST', '/api/integrations/install', { path: fixture.directory, grant: [], trusted: true })).statusCode).toBe(200);
    await call('PATCH', `/api/integrations/${id}`, { settings: { token: 'private-fixture-token' } });
    expect(await row(id)).toMatchObject({ enabled: true, active: false, actions: [{ id: 'login' }] });
    expect((await call('GET', `/api/integrations/${id}/logs`)).json().logs).toEqual([]);
    expect((await call('POST', `/api/integrations/${id}/commands/ping`, { requestId: 'lazy-ping' })).json()).toEqual({ kind: 'done' });
    const idle = async () => { await call('PATCH', `/api/integrations/${id}`, { enablement: 'off' }); await call('PATCH', `/api/integrations/${id}`, { enablement: 'on' }); expect(await row(id)).toMatchObject({ enabled: true, active: false }); };
    await idle();
    expect((await call('POST', `/api/integrations/${id}/actions/login`, {})).json()).toEqual({ kind: 'done' });
    await idle();
    const projectRoot = await temp(); await writeFile(join(projectRoot, 'settings.gradle'), '// fixture');
    const project = (await call('POST', '/api/projects', { cwd: projectRoot, name: 'Lazy' })).json();
    expect((await call('GET', `/api/projects/${project.id}/task-actions`)).json()).toMatchObject({ projectTypes: ['android'], actions: [{ providerId: `${id}/jobs`, id: 'build' }] });
    await idle();
    expect((await call('POST', `/api/integrations/${id}/activate`, { kind: 'view', id: 'acme.other/view' })).statusCode).toBe(400);
    expect(await row(id)).toMatchObject({ active: false });
    expect((await call('POST', `/api/integrations/${id}/activate`, { kind: 'view', id: `${id}/view` })).json()).toMatchObject({ active: true });
    const logs = (await call('GET', `/api/integrations/${id}/logs`)).json().logs;
    expect(logs.some((entry: { phase: string }) => entry.phase === 'runtime')).toBe(true);
    expect(JSON.stringify(logs)).not.toContain('private-fixture-token');
  });

  it('keeps manifest trust claims isolated, accepts explicit local upload trust and rejects remote trust changes', async () => {
    const { call, upload, row } = await boot([], undefined, true);
    const fixture = await localPackage('acme.trust-request', '1.0.0', `
      export default { activate() { return { status: async () => ({ state: 'ready', message: String(process.pid) }) }; } };
    `, { trusted: true });
    const uploaded = await upload(fixture.archive, [], 'trust.tgz');
    expect(uploaded.statusCode).toBe(200);
    const isolated = await row('acme.trust-request');
    expect(isolated.enabled).toBe(true);
    expect(isolated.status?.message).not.toBe(String(process.pid));
    expect(isolated.installed!.versions[0]!.trusted).toBeUndefined();

    const proxied = await call('POST', '/api/integrations/install', { path: fixture.directory, grant: [], trusted: true }, { 'x-forwarded-for': '192.0.2.10' });
    expect(proxied.statusCode).toBe(403);
    expect(proxied.json().error.code).toBe('PLUGIN_PATH_INSTALL_LOCAL_ONLY');
    const conflict = await call('POST', '/api/integrations/install', { path: fixture.directory, grant: [], trusted: true });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('PLUGIN_TRUST_CONFLICT');
    expect((await row('acme.trust-request')).installed!.versions[0]!.trusted).toBeUndefined();
    expect((await call('DELETE', '/api/integrations/acme.trust-request')).statusCode).toBe(200);
    const remoteRequests: Array<{ remoteAddress?: string; headers?: Record<string, string> }> = [{ remoteAddress: '203.0.113.9' }, { headers: { 'x-forwarded-for': '203.0.113.9' } }, { headers: { forwarded: 'for=203.0.113.9' } }, { headers: { 'tailscale-user-login': 'remote@example.com' } }];
    for (const options of remoteRequests) {
      const rejected = await upload(fixture.archive, [], 'trust.tgz', { trusted: 'true' }, options);
      expect(rejected.statusCode).toBe(403);
      expect(rejected.json().error.code).toBe('PLUGIN_TRUST_LOCAL_ONLY');
    }
    const trusted = await upload(fixture.archive, [], 'trust.tgz', { trusted: 'true' });
    expect(trusted.statusCode).toBe(200);
    expect(await row('acme.trust-request')).toMatchObject({ status: { message: String(process.pid) }, installed: { versions: [{ trusted: true }] } });
  });

  it('asks for explicit trust before legacy model IDs or declared host requirements and leaves failed imports uninstalled', async () => {
    const { app, call, upload, row } = await boot([], undefined, true);
    for (const [id, extra] of [
      ['acme.gateway', { capabilities: ['models.provide'], activation: ['model-source'], contributes: { modelSources: [{ id: 'gateway', title: { en: 'Gateway' }, protocols: ['openai-responses'] }] } }],
      ['acme.native-host', { requiresTrustedHost: true, capabilities: [] }],
    ] as const) {
      const fixture = await localPackage(id, '1.0.0', 'export default { activate() { return {}; } };', extra);
      const grant = [...extra.capabilities];
      const pending = await upload(fixture.archive, grant);
      expect(pending.statusCode).toBe(409);
      expect(pending.json().error).toMatchObject({ code: 'PLUGIN_TRUST_REQUIRED', details: { id, capabilities: grant, trustedRequired: true, trustedAllowed: true } });
      expect(await row(id)).toBeUndefined();
      const remote = await upload(fixture.archive, grant, 'plugin.tgz', {}, { remoteAddress: '203.0.113.9' });
      expect(remote.json().error.details.trustedAllowed).toBe(false);
      const installed = await upload(fixture.archive, grant, 'plugin.tgz', { trusted: 'true' });
      expect(installed.statusCode).toBe(200);
      expect(installed.json()).toMatchObject({ id, installed: { versions: [{ trusted: true }] } });
      if (id === 'acme.gateway') expect(installed.json().declared.modelSources[0].id).toBe('gateway');
      const url = '/api/integrations/' + id;
      expect((await app.inject({ method: 'DELETE', url, headers: { host: '127.0.0.1:4317' } })).statusCode).toBe(401);
      expect((await call('DELETE', url, undefined, { 'x-csrf-token': '' })).statusCode).toBe(403);
      expect((await call('DELETE', url)).statusCode).toBe(200);
      expect(await row(id)).toBeUndefined();
    }
  });

  it('persists local trust and recovery, preserves legacy source IDs and rolls failed data upgrades back', async () => {
    const first = await boot();
    const id = 'riffet.acceptance-trusted';
    const working = await localPackage(id, '1.0.0', `
      import { readFile, writeFile } from 'node:fs/promises';
      import { join } from 'node:path';
      export default { async activate(host) {
        const file = join(await host.stateDir(), 'format.txt');
        const previous = await readFile(file, 'utf8').catch(() => 'stable');
        if (previous !== 'stable') throw new Error('incompatible data was not restored');
        await writeFile(file, 'stable');
        return {
          modelSources: [{ id: 'acceptance-legacy-source', label: 'Legacy', protocols: ['openai-responses'], resolve: () => ({ endpoints: { 'openai-responses': { baseUrl: 'https://example.invalid/v1' } } }), catalog: async () => [{ value: 'trusted-model', name: 'Trusted model', configOptions: [] }] }],
          status: async () => ({ state: 'ready', message: String(process.pid) + ':' + await readFile(file, 'utf8') })
        };
      } };
    `, { capabilities: ['models.provide'], dataVersion: 1, contributes: { modelSources: [{ id: 'acceptance-legacy-source', title: { en: 'Legacy' } }] } });
    expect((await first.upload(working.archive, ['models.provide'])).json().error.code).toBe('PLUGIN_TRUST_REQUIRED');
    const installed = await first.call('POST', '/api/integrations/install', { path: working.directory, grant: ['models.provide'], trusted: true });
    expect(installed.statusCode).toBe(200);
    expect(await first.row(id)).toMatchObject({ enabled: true, version: '1.0.0', status: { state: 'ready', message: `${process.pid}:stable` }, installed: { versions: [{ trusted: true }] } });
    expect((await first.call('POST', '/api/backends/codex/model-probe', { modelSource: 'acceptance-legacy-source' })).json().models).toEqual([expect.objectContaining({ value: 'trusted-model' })]);

    await first.call('POST', '/api/integrations/recovery', { enabled: true });
    await first.app.close();
    const restarted = await boot([], first.stateDir);
    expect(await restarted.row(id)).toMatchObject({ enabled: false, installed: { versions: [{ trusted: true }] } });
    expect((await restarted.call('GET', '/api/integrations')).json().recovery).toBe(true);
    await restarted.call('POST', '/api/integrations/recovery', { enabled: false });
    expect(await restarted.row(id)).toMatchObject({ enabled: true, status: { message: `${process.pid}:stable` } });

    const broken = await localPackage(id, '1.1.0', `
      import { writeFile } from 'node:fs/promises';
      import { join } from 'node:path';
      export default { async activate(host) { await writeFile(join(await host.stateDir(), 'format.txt'), 'broken-format'); throw new Error('trusted upgrade failed'); } };
    `, { capabilities: ['models.provide'], dataVersion: 2 });
    const failure = await restarted.call('POST', '/api/integrations/install', { path: broken.directory, grant: ['models.provide'], trusted: true });
    expect(failure.statusCode).toBe(409);
    expect(failure.json().error.code).toBe('PLUGIN_ACTIVATION_FAILED');
    expect(await restarted.row(id)).toMatchObject({ enabled: true, version: '1.0.0', installed: { selected: '1.0.0', dataVersion: 1 } });
    expect(await readFile(join(first.stateDir, 'plugin-data', id, 'format.txt'), 'utf8')).toBe('stable');
    expect((await restarted.call('POST', '/api/backends/codex/model-probe', { modelSource: 'acceptance-legacy-source' })).json().models).toEqual([expect.objectContaining({ value: 'trusted-model' })]);
  });

  it('refuses changed code under an already imported trusted version after uninstall and reinstall', async () => {
    const { call, row } = await boot();
    const id = 'acme.trusted-cache';
    const fixture = await localPackage(id, '1.0.0', "export default { activate() { return { status: async () => ({ state: 'ready', message: 'first content' }) }; } };");
    expect((await call('POST', '/api/integrations/install', { path: fixture.directory, grant: [], trusted: true })).statusCode).toBe(200);
    expect(await row(id)).toMatchObject({ enabled: true, status: { message: 'first content' } });
    expect((await call('DELETE', `/api/integrations/${id}/versions/1.0.0`)).statusCode).toBe(200);
    await writeFile(join(fixture.directory, 'index.mjs'), "export default { activate() { return { status: async () => ({ state: 'ready', message: 'different content' }) }; } };");
    await call('POST', '/api/integrations/install', { path: fixture.directory, grant: [], trusted: true });
    expect(await row(id)).toMatchObject({ enabled: false, status: { message: expect.stringContaining('already imported with different content') } });
  });
});

describe('a minimal Agent with a non-built-in id', () => {
  // The title is the contract: nothing in the core, the web selectors or the Mac display is edited for this Agent.
  it('completes a session flow over HTTP on example.echo with no core enum, web selector or Mac display branch', async () => {
    const { call, row } = await boot([join(examples, 'echo')]);
    const client = { 'x-riffet-features': 'plugin-agents' };
    expect(await row('example.echo')).toMatchObject({ source: 'development', enabled: true, declared: { agentBackends: [{ id: 'example.echo' }] } });

    // The directory a client builds its selector from lists it, for a client that can decode its id.
    const backends = (await call('GET', '/api/backends', undefined, client)).json() as Array<{ backendId: string; label: string; available?: boolean }>;
    expect(backends.find(entry => entry.backendId === 'example.echo')).toMatchObject({ label: 'Echo' });
    expect(((await call('GET', '/api/backends')).json() as Array<{ backendId: string }>).some(entry => entry.backendId === 'example.echo')).toBe(false);

    const project = (await call('POST', '/api/projects', { cwd: await temp(), name: 'echo' })).json() as { id: string };
    const created = await call('POST', '/api/sessions', { projectId: project.id, kind: 'native', backendId: 'example.echo', mode: 'agent' }, client);
    expect(created.statusCode).toBe(200);
    const session = created.json() as { id: string; backendId: string };
    expect(session.backendId).toBe('example.echo');

    const sent = await call('POST', `/api/sessions/${session.id}/native/send`, { commandId: 'echo-1', text: 'hello from a test' }, client);
    expect(sent.statusCode).toBe(202);

    // Delivery is reported as the Agent proves it: accepted by the echo of the command id, completed when the turn ends.
    await vi.waitFor(async () => {
      const runs = (await call('GET', `/api/sessions/${session.id}/runs`, undefined, client)).json() as Array<{ commandId: string; state: string; native: { delivery: string; nativeTurnId?: string; timings: Record<string, number> } }>;
      expect(runs).toEqual([expect.objectContaining({ commandId: 'echo-1', state: 'completed', native: expect.objectContaining({ delivery: 'observed', nativeTurnId: expect.stringMatching(/^turn-/) }) })]);
      expect(runs[0]!.native.timings).toMatchObject({ providerAcceptedAt: expect.any(Number), completedAt: expect.any(Number) });
    }, { timeout: 5000, interval: 50 });

    // The transcript holds the prompt and the echoed reply, and the outline ends the turn.
    const timeline = (await call('GET', `/api/v3/sessions/${session.id}/timeline?from=0`, undefined, client)).json() as { rows: Array<{ kind: string; text?: string }> };
    expect(timeline.rows.map(row => [row.kind, row.text])).toEqual([['user', 'hello from a test'], ['assistant', 'hello from a test']]);
    const outline = (await call('GET', `/api/v3/sessions/${session.id}/outline`, undefined, client)).json() as { turns: Array<{ status: string; preview: string }> };
    expect(outline.turns).toEqual([expect.objectContaining({ status: 'completed', preview: 'hello from a test' })]);
  });
});
