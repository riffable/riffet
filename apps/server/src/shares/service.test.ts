import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { PublishedPreview, SharePublisher } from '@riffet/plugin-api';
import { Store } from '../store.js';
import { AppearanceService } from '../appearance/index.js';
import { THEME_ROLES, type ThemePalette, type CustomTheme, type ShareSnapshot } from '../../../../packages/contracts/src/index.js';
import type { NativeBackendService } from '../backends/service.js';
import type { OwnedSharePublisher } from '../plugins/registry.js';
import type { WorkspaceService } from '../workspace/index.js';
import { ThemeService } from '../themes/index.js';
import { OwnerService } from '../owner/index.js';
import { buildSharePackage, type SharePackageOptions } from './package.js';
import { ShareService } from './service.js';

const pageUrl = (alias: string) => `https://${alias}.pages.example.com/`;

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'riffet-share-service-'));
  const store = new Store(join(directory, 'workbench.db'));
  const session = store.createSession({ projectId: store.createProject(directory, 'Share').id, kind: 'native', backendId: 'claude' });
  let username = 'owner';
  let remote: PublishedPreview | undefined;
  let verified = true;
  const host: SharePublisher = {
    label: 'Example pages', audience: 'Anyone with the link',
    capability: vi.fn(async () => ({ available: true, username })),
    deploy: vi.fn(async (_directory, alias) => remote = { id: '42', url: pageUrl(alias), expiresAt: new Date(Date.now() + 86400_000).toISOString() }),
    find: vi.fn(async () => remote),
    remove: vi.fn(async () => { remote = undefined; }),
    verify: vi.fn(async () => verified),
  };
  let current: OwnedSharePublisher | undefined = { owner: 'acme.pages', publisher: host };
  const plugins = { sharePublisher: (owner: string) => current?.owner === owner ? current : undefined, sharePublishers: () => current ? [current] : [], defaultSharePublisher: () => current, refresh: async () => undefined, appearanceSources: () => [] };
  const themes = new ThemeService({ stateDir: directory });
  const owner = new OwnerService({ stateDir: directory });
  const deps = { themes, owner, store, stateDir: directory, nativeBackends: {} as NativeBackendService, workspace: {} as WorkspaceService, plugins };
  const capture = async (): Promise<ShareSnapshot> => ({ format: 'riffet-share-v1', title: 'Example', capturedAt: new Date().toISOString(), backendId: 'claude', events: [], runs: [], subagents: [], jobs: [], warnings: [], resources: {}, blobs: {}, diagramPages: {} });
  let version = 1;
  const build = vi.fn(async ({ outputDir }: SharePackageOptions) => {
    await mkdir(outputDir, { recursive: true }); await writeFile(join(outputDir, 'index.html'), '<html>example</html>');
    return { hash: `version-${version}`, bytes: 100, warnings: [] };
  });
  const options = { host, capture, build };
  const service = new ShareService(deps, options);
  cleanup.push(async () => { await service.settled(); service.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  return { service, deps, options, host, session, store, account: (value: string) => { username = value; }, verify: (value: boolean) => { verified = value; }, version: () => { version++; },
    publisher: (owner?: OwnedSharePublisher['owner']) => { current = owner ? { owner, publisher: host } : undefined; } };
}

it('publishes the reviewed draft once, rejects a different session, and keeps the receipt after restart', async () => {
  const { service, host, session, store, deps, options } = await setup();
  const draft = await service.draft(session.id);
  const other = store.createSession({ projectId: session.projectId, kind: 'native', backendId: 'claude' });
  await expect(service.publish(other.id, draft.id, 30)).rejects.toMatchObject({ code: 'SHARE_DRAFT_MISMATCH' });
  const first = await service.publish(session.id, draft.id, 30);
  await service.settled();
  const repeat = await service.publish(session.id, draft.id, 30);
  expect(repeat).toMatchObject({ id: first.id, state: 'published', publishedHash: 'version-1' });
  expect(host.deploy).toHaveBeenCalledTimes(1);
  service.close();
  const restarted = new ShareService(deps, options);
  expect(restarted.get(session.id)).toMatchObject({ state: 'published', id: first.id });
  restarted.close();
});

it('binds previews and management to the publishing user without making a remote write', async () => {
  const { service, host, session, account } = await setup();
  const draft = await service.draft(session.id);
  expect(host.capability).toHaveBeenLastCalledWith({ fresh: false });
  account('someone-else');
  await expect(service.publish(session.id, draft.id, 30)).rejects.toMatchObject({ code: 'SHARE_ACCOUNT_CHANGED' });
  expect(host.capability).toHaveBeenLastCalledWith({ fresh: true });
  expect(host.deploy).not.toHaveBeenCalled();
  account('owner');
  const share = await service.publish(session.id, draft.id, 30); await service.settled();
  account('someone-else');
  await expect(service.remove(share.id)).rejects.toMatchObject({ code: 'SHARE_ACCOUNT_CHANGED' });
  expect(host.capability).toHaveBeenLastCalledWith({ fresh: true });
  expect(host.remove).not.toHaveBeenCalled();
});

it('builds print drafts without a publisher or a working account and never accepts them for publishing', async () => {
  const { service, host, session, publisher, deps, options } = await setup();
  vi.mocked(host.capability).mockRejectedValue(new Error('expired login'));
  for (const owner of [undefined, 'acme.pages'] as const) {
    publisher(owner);
    const draft = await service.draft(session.id, false, { localOnly: true });
    await expect(service.previewDirectory(draft.id)).resolves.toContain(draft.id);
    // The local-only guard survives restart and is checked before touching the publisher.
    const restarted = new ShareService(deps, options);
    try {
      await expect(restarted.publish(session.id, draft.id, 30)).rejects.toMatchObject({ code: 'INVALID_SHARE_DRAFT' });
    } finally { restarted.close(); }
  }
  for (const method of [host.capability, host.deploy, host.find, host.remove, host.verify]) expect(method).not.toHaveBeenCalled();
  expect(service.get(session.id)).toBeNull();
});

it('prints while a remote write is unconfirmed without changing its receipt or checking the changed publisher', async () => {
  const { service, host, session, publisher, verify } = await setup();
  verify(false);
  const draft = await service.draft(session.id);
  await service.publish(session.id, draft.id, 30);
  await service.settled();
  const receipt = service.get(session.id);
  expect(receipt?.operation).toBe('uncertain');
  publisher('other.pages');
  vi.clearAllMocks();
  await expect(service.draft(session.id, false, { localOnly: true })).resolves.toHaveProperty('id');
  expect(service.get(session.id)).toEqual(receipt);
  await expect(service.draft(session.id)).rejects.toMatchObject({ code: 'SHARE_UNCONFIRMED' });
  for (const method of [host.capability, host.deploy, host.find, host.remove, host.verify]) expect(method).not.toHaveBeenCalled();
});

it('cleans an interrupted preview and releases its session lock for retry', async () => {
  const { service, session, options, host } = await setup();
  const controller = new AbortController();
  options.build.mockImplementationOnce(async ({ outputDir }) => {
    await mkdir(outputDir, { recursive: true });
    await writeFile(join(outputDir, 'partial'), 'incomplete');
    controller.abort();
    return { hash: 'incomplete', bytes: 10, warnings: [] };
  });
  await expect(service.draft(session.id, false, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  expect(await readdir(service.draftsRoot)).toEqual([]);
  await expect(service.draft(session.id)).resolves.toHaveProperty('id');
  expect(host.deploy).not.toHaveBeenCalled();
});

it('releases a cancelled identity wait without cancelling the shared capability check', async () => {
  const { service, session, host, options } = await setup();
  let release!: (value: { available: true; username: string }) => void;
  const check = new Promise<{ available: true; username: string }>(resolve => { release = resolve; });
  vi.mocked(host.capability).mockReturnValueOnce(check);
  const capture = vi.spyOn(options, 'capture');
  const controller = new AbortController();
  const waiting = service.draft(session.id, false, { signal: controller.signal });
  controller.abort();
  await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
  expect(capture).not.toHaveBeenCalled();
  // The next request can proceed while the original shared check is still pending.
  await expect(service.draft(session.id)).resolves.toHaveProperty('id');
  release({ available: true, username: 'owner' });
  await expect(check).resolves.toMatchObject({ username: 'owner' });
});

it('validates the selected scope before reading history and defaults to all reading content', async () => {
  const { service, session, options } = await setup();
  const capture = vi.spyOn(options, 'capture');
  for (const selection of [{ mode: 'recent', count: 0 }, { mode: 'recent', count: 1.5 }, { mode: 'selected', turnIds: [] }]) {
    await expect(service.draft(session.id, false, { selection })).rejects.toMatchObject({ code: 'INVALID_SHARE_SELECTION' });
  }
  expect(capture).not.toHaveBeenCalled();
  await service.draft(session.id);
  expect(capture).toHaveBeenLastCalledWith(expect.anything(), session.id, expect.objectContaining({ selection: { mode: 'all' } }));
  await service.draft(session.id, false, { selection: { mode: 'selected', turnIds: ['turn'], nativeChatId: 'thread' } });
  expect(capture).toHaveBeenLastCalledWith(expect.anything(), session.id, expect.objectContaining({ selection: { mode: 'selected', turnIds: ['turn'], nativeChatId: 'thread' } }));
});

it('serializes duplicate clicks and cancellation while deployment is in flight', async () => {
  const { service, host, session } = await setup();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  vi.mocked(host.deploy).mockImplementationOnce(async (_directory, alias) => { await gate; return { id: '42', url: pageUrl(alias) }; });
  const draft = await service.draft(session.id);
  const first = await service.publish(session.id, draft.id, 30);
  const repeat = await service.publish(session.id, draft.id, 30);
  expect(repeat.id).toBe(first.id);
  await expect(service.remove(first.id)).rejects.toMatchObject({ code: 'SHARE_BUSY' });
  release(); await service.settled();
  expect(host.deploy).toHaveBeenCalledTimes(1);
});

it('keeps the previous published version when an update is unconfirmed and reconciles without reuploading', async () => {
  const { service, host, session, verify, version } = await setup();
  const first = await service.draft(session.id, false, { appearance: { themeId: 'solarized', mode: 'light' } });
  const share = await service.publish(session.id, first.id, 30); await service.settled();
  version(); verify(false);
  const second = await service.draft(session.id, false, { appearance: { themeId: 'catppuccin', mode: 'dark' } });
  await service.publish(session.id, second.id, 30); await service.settled();
  expect(service.get(session.id)).toMatchObject({ state: 'published', operation: 'uncertain', publishedHash: 'version-1', appearance: { themeId: 'solarized', mode: 'light' }, url: pageUrl(share.alias) });
  await expect(service.publish(session.id, second.id, 30)).rejects.toMatchObject({ code: 'SHARE_UNCONFIRMED' });
  verify(true);
  expect(await service.reconcile(share.id)).toMatchObject({ state: 'published', publishedHash: 'version-2', appearance: { themeId: 'catppuccin', mode: 'dark' }, operation: undefined });
  expect(host.deploy).toHaveBeenCalledTimes(2);
});

it('retries a failed first upload with its retained draft and alias after restart', async () => {
  const { service, deps, options, host, session } = await setup();
  vi.mocked(host.deploy).mockRejectedValueOnce(new Error('network disconnected'));
  const draft = await service.draft(session.id);
  const share = await service.publish(session.id, draft.id, 90);
  await service.settled();
  expect(service.get(session.id)).toMatchObject({ operation: 'uncertain', state: 'unpublished' });
  service.close();
  const restarted = new ShareService(deps, options);
  const date = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2 * 86400_000);
  try {
    await restarted.sweepDrafts();
    await expect(restarted.previewDirectory(draft.id)).rejects.toMatchObject({ code: 'SHARE_DRAFT_EXPIRED' });
    const retry = await restarted.retry(share.id);
    const duplicate = await restarted.retry(share.id);
    expect(duplicate.id).toBe(retry.id);
    await restarted.settled();
    expect(restarted.get(session.id)).toMatchObject({ state: 'published', publishedHash: 'version-1' });
    expect(restarted.get(session.id)?.operation).toBeUndefined();
    expect(host.deploy).toHaveBeenCalledTimes(2);
    expect(host.deploy).toHaveBeenLastCalledWith(expect.stringContaining(draft.id), share.alias, 90, expect.objectContaining({ username: 'owner' }), true);
    expect(host.capability).toHaveBeenLastCalledWith({ fresh: true });
  } finally { date.mockRestore(); restarted.close(); }
});

it('verifies a committed upload on retry without sending it again', async () => {
  const { service, host, session } = await setup();
  vi.mocked(host.verify).mockRejectedValueOnce(new Error('verification disconnected'));
  const draft = await service.draft(session.id, false, { appearance: { themeId: 'kiln', mode: 'dark' } });
  const share = await service.publish(session.id, draft.id, 30);
  await service.settled();
  expect(service.get(session.id)?.operation).toBe('uncertain');
  await service.retry(share.id); await service.settled();
  expect(service.get(session.id)).toMatchObject({ state: 'published', publishedHash: 'version-1', appearance: { themeId: 'kiln', mode: 'dark' } });
  expect(service.get(session.id)?.operation).toBeUndefined();
  expect(host.deploy).toHaveBeenCalledTimes(1);
});

it('retries a pending removal without reviving its unconfirmed publication', async () => {
  const { service, host, session, verify } = await setup();
  verify(false);
  const draft = await service.draft(session.id);
  const share = await service.publish(session.id, draft.id, 30); await service.settled();
  vi.mocked(host.remove).mockRejectedValueOnce(new Error('removal disconnected'));
  await service.remove(share.id); await service.settled();
  expect(service.get(session.id)?.operation).toBe('uncertain');
  await service.retry(share.id); await service.settled();
  expect(service.get(session.id)?.state).toBe('removed');
  expect(service.get(session.id)?.operation).toBeUndefined();
  expect(host.remove).toHaveBeenCalledTimes(2);
  expect(host.deploy).toHaveBeenCalledTimes(1);
});

it('retains uncertain receipts over restart and only marks cancellation complete after remote absence', async () => {
  const { service, deps, options, host, session, store, verify } = await setup();
  verify(false);
  const draft = await service.draft(session.id);
  const share = await service.publish(session.id, draft.id, 30); await service.settled();
  const row = store.db.prepare('SELECT json FROM session_shares WHERE id=?').get(share.id) as { json: string };
  const record = JSON.parse(row.json); record.operation = 'publishing';
  store.db.prepare('UPDATE session_shares SET json=? WHERE id=?').run(JSON.stringify(record), share.id);
  service.close();
  const restarted = new ShareService(deps, options);
  expect(restarted.get(session.id)?.operation).toBe('uncertain');
  await restarted.remove(share.id); await restarted.settled();
  expect(restarted.get(session.id)?.state).toBe('removed');
  expect(restarted.get(session.id)?.operation).toBeUndefined();
  expect(host.remove).toHaveBeenCalledTimes(1);
  restarted.close();
});

it('does not mistake a temporarily absent listing for a failed or cancelled upload', async () => {
  const { service, host, session, verify } = await setup();
  verify(false);
  const draft = await service.draft(session.id);
  const share = await service.publish(session.id, draft.id, 30); await service.settled();
  vi.mocked(host.find).mockResolvedValueOnce(undefined);
  expect((await service.reconcile(share.id)).operation).toBe('uncertain');
  vi.mocked(host.find).mockResolvedValueOnce(undefined);
  await service.remove(share.id); await service.settled();
  expect(service.get(session.id)?.state).not.toBe('removed');
  expect(service.get(session.id)?.operation).toBe('uncertain');
  expect(host.remove).not.toHaveBeenCalled();
  await service.remove(share.id); await service.settled();
  expect(service.get(session.id)?.state).toBe('removed');
});

it('previews locally without a publisher and leaves earlier shares to the publisher that made them', async () => {
  const { service, host, session, store, publisher } = await setup();
  const publicUrl = vi.fn((alias: string) => `https://pages.example.com/${alias.replace(/^riffet-/, '')}`);
  host.publicUrl = publicUrl;
  publisher(undefined);
  expect(await service.capability()).toEqual({ available: false, reason: 'unavailable', message: expect.any(String) });
  const draft = await service.draft(session.id);
  await expect(service.previewDirectory(draft.id)).resolves.toContain(draft.id);
  await expect(service.publish(session.id, draft.id, 30)).rejects.toMatchObject({ code: 'SHARE_UNAVAILABLE' });
  expect(service.get(session.id)).toBeNull();
  const legacy = { id: 'a'.repeat(32), sessionId: session.id, title: 'Example', alias: `riffet-${'a'.repeat(32)}`, username: 'owner', url: pageUrl(`riffet-${'a'.repeat(32)}`), previewId: '42', state: 'published', publisher: 'acme.archive', publishedHash: 'version-1', updatedAt: new Date().toISOString() };
  store.db.prepare('INSERT INTO session_shares(id,session_id,json) VALUES(?,?,?)').run(legacy.id, legacy.sessionId, JSON.stringify(legacy));
  expect(service.list()).toEqual([legacy]);
  expect(service.get(session.id)?.url).toBe(legacy.url);
  expect((await service.status(session.id)).share?.url).toBe(legacy.url);
  expect(publicUrl).not.toHaveBeenCalled();
  await expect(service.reconcile(legacy.id)).rejects.toMatchObject({ code: 'SHARE_UNAVAILABLE' });
  publisher('acme.pages');
  expect(service.get(session.id)?.url).toBe(legacy.url);
  expect((await service.status(session.id)).share?.url).toBe(legacy.url);
  expect(publicUrl).not.toHaveBeenCalled();
  await expect(service.remove(legacy.id)).rejects.toMatchObject({ code: 'SHARE_PUBLISHER_UNAVAILABLE' });
  await expect(service.retry(legacy.id)).rejects.toMatchObject({ code: 'SHARE_PUBLISHER_UNAVAILABLE' });
  expect([host.find, host.deploy, host.remove].map(fn => vi.mocked(fn).mock.calls.length)).toEqual([0, 0, 0]);
  const row = store.db.prepare('SELECT json FROM session_shares WHERE id=?').get(legacy.id) as { json: string };
  expect(JSON.parse(row.json)).toEqual(legacy);
  publisher('acme.archive');
  expect(await service.capability()).toMatchObject({ available: true, publisher: { id: 'acme.archive', label: 'Example pages', audience: 'Anyone with the link' } });
  const shortUrl = `https://pages.example.com/${legacy.id}`;
  expect(service.get(session.id)?.url).toBe(shortUrl);
  expect(service.list()[0]?.url).toBe(shortUrl);
  expect((await service.status(session.id)).share?.url).toBe(shortUrl);
  expect(publicUrl).toHaveBeenCalledWith(legacy.alias);
  expect(JSON.parse((store.db.prepare('SELECT json FROM session_shares WHERE id=?').get(legacy.id) as { json: string }).json)).toEqual(legacy);
  publicUrl.mockImplementationOnce(() => { throw new Error('Projection unavailable'); });
  expect(service.get(session.id)?.url).toBe(legacy.url);
  const removing = await service.remove(legacy.id);
  expect(removing.url).toBe(shortUrl);
  await service.settled();
  expect(host.find).toHaveBeenCalledWith(legacy.alias, expect.objectContaining({ url: legacy.url }));
  expect(service.get(session.id)).toMatchObject({ state: 'removed', publisher: 'acme.archive' });
  // The local preview is bound to no account, so it is not published after the fact.
  await expect(service.publish(session.id, draft.id, 30)).rejects.toMatchObject({ code: 'SHARE_PUBLISHER_CHANGED' });
  expect(host.deploy).not.toHaveBeenCalled();
});


it('freezes only the selected theme and rejects stale custom choices before capture', async () => {
  const { service, deps, session, options } = await setup();
  const palette = Object.fromEntries(THEME_ROLES.map(role => [role, '#ffffff'])) as ThemePalette;
  const theme = (id: string): CustomTheme => ({ id, name: id, palette: { light: palette, dark: palette }, ansi: { light: Array(16).fill('#ffffff'), dark: Array(16).fill('#000000') } });
  const library = await deps.themes.replaceLibrary({ expectedRevision: deps.themes.getLibrary().revision, themes: [theme('custom-first-theme'), theme('custom-private-theme')] });
  const appearance = { themeId: 'custom-first-theme', mode: 'dark' as const, themeRevision: library.revision };
  const draft = await service.draft(session.id, false, { appearance });
  expect(draft.appearance).toEqual(appearance);
  const frozen = options.build.mock.calls[0]![0].snapshot.appearance;
  expect(frozen).toEqual({ themeId: 'custom-first-theme', mode: 'dark', customTheme: library.themes[0] });
  expect(JSON.stringify(frozen)).not.toContain('custom-private-theme');
  await deps.themes.replaceLibrary({ expectedRevision: library.revision, themes: [theme('custom-other-theme')] });
  expect(frozen?.customTheme?.id).toBe('custom-first-theme');
  await expect(service.draft(session.id, false, { appearance })).rejects.toMatchObject({ code: 'SHARE_THEME_CHANGED', statusCode: 409 });
  await expect(service.draft(session.id, false, { appearance: { ...appearance, themeRevision: undefined } })).rejects.toMatchObject({ code: 'SHARE_THEME_CHANGED' });
  expect(options.build).toHaveBeenCalledTimes(1);
});

it('freezes a painted plugin palette as a theme of its own, and refuses one no enabled plugin holds', async () => {
  const { deps, session, options } = await setup();
  const palette = Object.fromEntries(THEME_ROLES.map(role => [role, '#ffffff'])) as ThemePalette;
  const frozen: CustomTheme = { id: 'custom-plugin-0123456789abcdef', name: 'Plugin', palette: { light: palette, dark: palette }, ansi: { light: Array(16).fill('#ffffff'), dark: Array(16).fill('#000000') } };
  const service = new ShareService(deps, { ...options, appearance: { palette: async key => key === 'plugin-0123456789abcdef' ? frozen : undefined, shareAssets: async () => ({ files: [] }) } });
  cleanup.push(async () => { await service.settled(); service.close(); });
  const draft = await service.draft(session.id, false, { appearance: { themeId: 'plugin-0123456789abcdef', mode: 'dark' } });
  expect(draft.appearance).toEqual({ themeId: 'plugin-0123456789abcdef', mode: 'dark' });
  expect(options.build.mock.calls[0]![0].snapshot.appearance).toEqual({ themeId: frozen.id, mode: 'dark', customTheme: frozen });
  await expect(service.draft(session.id, false, { appearance: { themeId: 'plugin-fedcba9876543210', mode: 'dark' } })).rejects.toMatchObject({ code: 'SHARE_THEME_CHANGED', statusCode: 409 });
});

it('copies a redistributable plugin font into the frozen share and leaves out one that is not', async () => {
  const { deps, session, options } = await setup();
  const root = join(deps.stateDir, 'pack'), web = join(deps.stateDir, 'web');
  await mkdir(join(root, 'assets'), { recursive: true }); await mkdir(web);
  await writeFile(join(web, 'index.html'), '<html><head></head></html>');
  const open = Buffer.concat([Buffer.from('wOF2'), Buffer.alloc(64, 1)]), closed = Buffer.concat([Buffer.from('wOF2'), Buffer.alloc(64, 2)]);
  await writeFile(join(root, 'assets', 'open.woff2'), open); await writeFile(join(root, 'assets', 'closed.woff2'), closed);
  const font = (name: string, role: 'ui' | 'mono', license?: { redistributable: boolean }) => ({ id: `acme.pack/${name}`, title: { en: name }, role, family: name, fallback: ['sans-serif'], files: [{ path: `assets/${name}.woff2`, weight: '400' }], ...(license ? { license } : {}) });
  const appearance = new AppearanceService({ appearanceSources: () => [{ id: 'acme.pack', root, appearance: { fonts: [font('open', 'ui', { redistributable: true }), font('closed', 'mono')] } }] });
  const service = new ShareService(deps, { ...options, build: buildSharePackage, webAssetsDir: web, appearance });
  cleanup.push(async () => { await service.settled(); service.close(); });
  const draft = await service.draft(session.id, false, { appearance: { themeId: 'riffet', mode: 'light', uiFont: 'acme.pack/open', monoFont: 'acme.pack/closed' } });
  expect(draft.appearance).toEqual({ themeId: 'riffet', mode: 'light' });
  const publicDir = join(deps.stateDir, 'shares', 'drafts', draft.id, 'public');
  const sha = createHash('sha256').update(open).digest('hex');
  const data = (await readdir(join(publicDir, 'data'))).find(name => name.endsWith('.json'))!;
  const frozen = (JSON.parse(await readFile(join(publicDir, 'data', data), 'utf8')) as ShareSnapshot).appearance;
  expect(frozen?.fonts).toEqual({ ui: { fallback: ['sans-serif'], files: [{ url: `./appearance/${sha}.woff2`, sha256: sha, weight: '400' }] } });
  expect(await readdir(join(publicDir, 'appearance'))).toEqual([`${sha}.woff2`]);
});

it('freezes the owner into the package only when asked, and keeps the choice on the published share', async () => {
  const { service, deps, session, options } = await setup();
  const web = join(deps.stateDir, 'web');
  await mkdir(web); await writeFile(join(web, 'index.html'), '<html><head></head></html>');
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 7)]);
  deps.owner.update({ name: 'Ada' });
  const avatar = deps.owner.setAvatar({ type: 'image/png', data: png.toString('base64') }).avatar!;
  const real = new ShareService(deps, { ...options, build: buildSharePackage, webAssetsDir: web });
  cleanup.push(async () => { await real.settled(); real.close(); });
  const snapshotOf = async (id: string) => {
    const dir = join(deps.stateDir, 'shares', 'drafts', id, 'public');
    const data = (await readdir(join(dir, 'data'))).find(name => name.endsWith('.json'))!;
    return { dir, author: (JSON.parse(await readFile(join(dir, 'data', data), 'utf8')) as ShareSnapshot).author };
  };
  const off = await real.draft(session.id);
  expect(off.author).toBe(false);
  expect((await snapshotOf(off.id)).author).toBeUndefined();
  const on = await real.draft(session.id, false, { author: true });
  const file = `assets/owner-${avatar.sha256.slice(0, 16)}.png`;
  const frozen = await snapshotOf(on.id);
  expect(frozen.author).toEqual({ name: 'Ada', avatar: `./${file}` });
  expect(await readFile(join(frozen.dir, file))).toEqual(png);
  deps.owner.removeAvatar(); deps.owner.update({ name: null });
  expect((await snapshotOf(on.id)).author).toEqual({ name: 'Ada', avatar: `./${file}` });
  expect((await snapshotOf((await real.draft(session.id, false, { author: true })).id)).author).toBeUndefined();
  await expect(real.draft(session.id, false, { author: 'yes' })).rejects.toMatchObject({ code: 'INVALID_SHARE_AUTHOR' });
  await real.publish(session.id, on.id, 30);
  await real.settled();
  expect(real.get(session.id)).toMatchObject({ state: 'published', author: true });
});

it('returns shared allowed actions for local previews, busy and uncertain writes, and account conflicts', async () => {
  const { service, session, host, publisher, account, verify } = await setup();
  publisher(undefined);
  expect(await service.status(session.id)).toMatchObject({ actions: { preview: true, publish: false, remove: false, reconcile: false, retry: false } });
  publisher('acme.pages');
  expect(await service.status(session.id)).toMatchObject({ actions: { preview: true, publish: true, remove: false } });
  vi.mocked(host.capability).mockResolvedValueOnce({ available: false, reason: 'login_required' });
  expect(await service.status(session.id)).toMatchObject({ blocker: { code: 'SHARE_UNAVAILABLE' }, actions: { preview: false, publish: false } });
  verify(false);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  vi.mocked(host.deploy).mockImplementationOnce(async (...args) => { await gate; return { id: '42', url: pageUrl(args[1]) }; });
  const draft = await service.draft(session.id);
  const share = await service.publish(session.id, draft.id, 30);
  expect(await service.status(session.id)).toMatchObject({ blocker: { code: 'SHARE_BUSY' }, actions: { preview: false, publish: false, retry: false } });
  release();
  await service.settled();
  expect(await service.status(session.id)).toMatchObject({ blocker: { code: 'SHARE_UNCONFIRMED' }, actions: { preview: false, publish: false, remove: true, reconcile: true, retry: true } });
  account('another');
  expect(await service.status(session.id)).toMatchObject({ blocker: { code: 'SHARE_ACCOUNT_CHANGED' }, actions: { preview: false, remove: false, retry: false } });
  await expect(service.draft(session.id)).rejects.toMatchObject({ code: 'SHARE_UNCONFIRMED' });
  publisher('other.pages');
  expect(await service.status(session.id)).toMatchObject({ blocker: { code: 'SHARE_PUBLISHER_UNAVAILABLE' }, share: { id: share.id } });
});
