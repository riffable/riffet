import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerExtensionRoutes } from './extensions.js';
import type { RouteDeps } from './deps.js';
import { AppError } from '../errors.js';
import { ExtensionService } from '../extensions/service.js';
import type { NativeBackendDriver } from '../backends/types.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function harness(backend: 'claude' | 'traex' = 'claude', driver: Partial<NativeBackendDriver> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'riffet-extension-route-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const user = join(root, 'claude');
  const project = { id: 'project', name: 'test', cwd: join(root, 'workspace') };
  await mkdir(join(user, 'skills', 'example'), { recursive: true });
  await mkdir(project.cwd);
  await writeFile(join(user, 'skills', 'example', 'SKILL.md'), '---\nname: example\ndescription: Test\n---\nbody');
  const invalidate = vi.fn();
  const profile = { id: 'local', backendId: backend, name: 'Fixture', config: { configDir: user, executable: join(root, 'unavailable-agent') } };
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => reply.code(error instanceof AppError ? error.statusCode : 500).send({ code: error instanceof AppError ? error.code : 'ERROR', message: error.message }));
  registerExtensionRoutes(app, { stateDir: root, store: { getProject: () => project, getSession: () => ({ projectId: 'project', backendId: 'codex', backendProfileId: 'local' }) }, nativeBackends: { catalog: { validateProfile: (_backend: string, id?: string) => { if (id && id !== 'local') throw new AppError('NOT_FOUND', 'profile', 404); return profile; }, invalidateSlashCatalogs: invalidate }, registry: { require: () => driver }, host: {} } } as unknown as RouteDeps);
  cleanups.push(() => app.close());
  return { app, user, invalidate };
}

describe('extension routes', () => {
  it('keeps a document edit in its profile and invalidates derived slash menus', async () => {
    const { app, user, invalidate } = await harness();
    const url = '/api/backends/claude/extensions';
    const inventory = await app.inject(`${url}?profileId=local&projectId=project`);
    expect(inventory.statusCode).toBe(200);
    const item = inventory.json().items.find((row: { name: string; kind: string }) => row.name === 'example' && row.kind === 'skill');
    expect(item).toBeTruthy();
    const documentUrl = `${url}/documents/${item.documentId}?profileId=local&projectId=project`;
    const before = (await app.inject(documentUrl)).json();
    const save = await app.inject({ method: 'PUT', url: documentUrl, payload: { content: 'changed', expectedHash: before.hash } });
    expect(save.statusCode).toBe(200);
    expect(await readFile(join(user, 'skills/example/SKILL.md'), 'utf8')).toBe('changed');
    expect(invalidate).toHaveBeenCalledOnce();
    const stale = await app.inject({ method: 'PUT', url: documentUrl, payload: { content: 'wrong', expectedHash: before.hash } });
    expect(stale.statusCode).toBe(409);
    expect((await app.inject(documentUrl.replace('profileId=local', 'profileId=other'))).statusCode).toBe(404);
  });
  it('rejects a cross-backend session selection before discovery', async () => {
    const { app } = await harness();
    const response = await app.inject('/api/backends/claude/extensions?sessionId=codex-session');
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe('NATIVE_BACKEND_MISMATCH');
  });
  it('returns native state on every concurrent inventory response without mutating another snapshot', async () => {
    let release!: (states: Array<{ path: string; enabled: boolean }>) => void;
    const pending = new Promise<Array<{ path: string; enabled: boolean }>>(resolve => { release = resolve; });
    const skillStates = vi.fn().mockReturnValue(pending);
    const { app, user } = await harness('traex', { extensions: { skillStates } });
    let scanned = 0;
    let bothScanned!: () => void;
    const ready = new Promise<void>(resolve => { bothScanned = resolve; });
    const original = ExtensionService.prototype.list;
    vi.spyOn(ExtensionService.prototype, 'list').mockImplementation(async function (this: ExtensionService, ctx) {
      const result = await original.call(this, ctx);
      if (++scanned === 2) bothScanned();
      return result;
    });
    const responses = Promise.all([app.inject('/api/backends/traex/extensions?profileId=local'), app.inject('/api/backends/traex/extensions?profileId=local')]);
    await ready;
    release([{ path: join(user, 'skills/example/SKILL.md'), enabled: false }]);
    for (const response of await responses) {
      expect(response.statusCode).toBe(200);
      expect(response.json().items.find((item: { kind: string }) => item.kind === 'skill')).toMatchObject({ enabled: false });
    }
    expect(skillStates).toHaveBeenCalledOnce();
  });
  it('persists file disable/restore and removes the complete skill with a backup and stale-hash protection', async () => {
    const { app, user } = await harness();
    const url = '/api/backends/claude/extensions';
    const selection = '?profileId=local&projectId=project';
    const inventory = () => app.inject(url + selection).then(response => response.json());
    const before = (await inventory()).items.find((item: { kind: string }) => item.kind === 'skill');
    const manifest = (await app.inject(`${url}/documents/${before.documentId}${selection}`)).json();
    const action = (value: string, expectedHash = manifest.hash) => app.inject({ method: 'POST', url: `${url}/actions${selection}`, payload: { action: value, itemId: before.id, expectedHash } });
    expect((await action('disable', '0'.repeat(64))).statusCode).toBe(409);
    expect((await action('disable')).statusCode).toBe(200);
    const disabled = (await inventory()).items.find((item: { id: string }) => item.id === before.id);
    expect(disabled).toMatchObject({ enabled: false, documentId: before.documentId });
    expect(await readFile(join(user, 'skills/example/SKILL.md.riffet-disabled'), 'utf8')).toBe(manifest.content);
    expect((await action('enable')).statusCode).toBe(200);
    expect((await inventory()).items.find((item: { id: string }) => item.id === before.id)).toMatchObject({ enabled: true });
    await writeFile(join(user, 'skills/example/helper.py'), 'print("support")');
    const removed = await action('uninstall');
    expect(removed.statusCode).toBe(200);
    expect(removed.json().success).toBe(true);
    const backupPath = removed.json().output.replace('备份目录：', '');
    expect(await readFile(join(backupPath, 'helper.py'), 'utf8')).toBe('print("support")');
    expect(await readFile(join(backupPath, 'SKILL.md'), 'utf8')).toBe(manifest.content);
    expect((await inventory()).items.some((item: { id: string }) => item.id === before.id)).toBe(false);
    expect((await action('uninstall')).statusCode).toBe(404);
  });
});
