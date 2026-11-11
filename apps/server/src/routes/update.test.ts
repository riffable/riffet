import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpdateCheck } from '../../../../packages/contracts/src/index.js';
import { createApp } from '../app.js';

const fixtures = vi.hoisted(() => ({
  root: '/private/source/riffet' as string | undefined,
  current: { version: '0.5.0', buildNumber: 1, tag: 'v0.5.0', commit: 'a'.repeat(40), dirty: false },
  check: vi.fn(),
}));
vi.mock('../update.js', () => ({ checkForUpdates: fixtures.check }));
vi.mock('../version.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../version.js')>(),
  SERVER_BUILD: fixtures.current,
  get SOURCE_ROOT() { return fixtures.root; },
}));

const cleanups: Array<() => Promise<unknown>> = [];
beforeEach(() => { fixtures.root = '/private/source/riffet'; fixtures.check.mockReset(); });
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function boot() {
  const stateDir = await mkdtemp(join(tmpdir(), 'riffet-update-route-'));
  cleanups.push(() => rm(stateDir, { recursive: true, force: true }));
  const { app } = await createApp({ stateDir, token: 'test-update-token', cliPath: '/nonexistent/cursor-agent' });
  cleanups.push(() => app.close());
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'localhost' }, payload: { token: 'test-update-token' } });
  const cookie = String(login.headers['set-cookie']).split(';')[0]!;
  const headers = { host: 'localhost', cookie, 'x-csrf-token': login.json().csrfToken as string };
  return { app, headers };
}

describe('read-only update endpoint', () => {
  it('requires authentication before querying Git and exposes only the build on public health', async () => {
    const { app, headers } = await boot();
    const unauthorized = await app.inject({ method: 'GET', url: '/api/update', headers: { host: 'localhost' } });
    expect(unauthorized.statusCode).toBe(401);
    expect(fixtures.check).not.toHaveBeenCalled();
    const health = await app.inject({ method: 'GET', url: '/health', headers: { host: 'localhost' } });
    expect(health.json()).toMatchObject({ ok: true, build: fixtures.current });
    expect(health.body).not.toContain(fixtures.root);
    const write = await app.inject({ method: 'POST', url: '/api/update', headers });
    expect(write.statusCode).toBe(404);
    expect(fixtures.check).not.toHaveBeenCalled();
  });

  it('shares concurrent checks, drops private error details, and retries on a later request', async () => {
    const { app, headers } = await boot();
    let finish!: (result: UpdateCheck) => void;
    fixtures.check.mockImplementationOnce(() => new Promise<UpdateCheck>((resolve) => { finish = resolve; }));
    const first = app.inject({ url: '/api/update', headers });
    const second = app.inject({ url: '/api/update', headers });
    await vi.waitFor(() => expect(fixtures.check).toHaveBeenCalledOnce());
    finish({ status: 'unavailable', current: fixtures.current, latest: null, source: null, message: 'fatal: https://user:secret@example.test/repo /private/source/riffet' });
    const responses = await Promise.all([first, second]);
    for (const response of responses) {
      expect(response.statusCode).toBe(200);
      expect(response.json().status).toBe('unavailable');
      expect(response.body).not.toMatch(/secret|example\.test|\/private\/source/);
    }
    expect(fixtures.check).toHaveBeenCalledOnce();
    fixtures.check.mockResolvedValueOnce({ status: 'no-releases', current: fixtures.current, latest: null, source: null });
    expect((await app.inject({ url: '/api/update', headers })).json().status).toBe('no-releases');
    expect(fixtures.check).toHaveBeenCalledTimes(2);
  });

  it('does not query Git when the build has no source clone', async () => {
    fixtures.root = undefined;
    const { app, headers } = await boot();
    const response = await app.inject({ url: '/api/update', headers });
    expect(response.json()).toMatchObject({ status: 'unavailable', current: fixtures.current, latest: null, source: null });
    expect(fixtures.check).not.toHaveBeenCalled();
  });

  it('turns an unexpected checker failure into a safe response', async () => {
    const { app, headers } = await boot();
    fixtures.check.mockRejectedValueOnce(new Error('fatal: https://user:secret@example.test/private'));
    const response = await app.inject({ url: '/api/update', headers });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('unavailable');
    expect(response.body).not.toMatch(/secret|example\.test/);
  });
});
