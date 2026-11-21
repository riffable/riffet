import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NativeWorkbenchEvent } from '../../../../packages/contracts/src/index.js';
import { createApp } from '../app.js';
import { builtinPluginsWithout } from '../plugins/registry.js';
import { JournalLaneWriter } from '../journal/ingest.js';

/**
 * The core built without the Cursor plugin: it starts, what Cursor left behind (its sessions, their history, the
 * stored `cursor-cli.json`) is still there, and whatever would need the CLI is refused with the backend named.
 */

const cleanups: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const CURSOR_CLI = JSON.stringify({ executable: '/opt/cursor/cursor-agent', apiKey: 'secret-key' });

async function boot(plugins = builtinPluginsWithout('riffet.cursor')) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'riffet-no-cursor-')));
  const stateDir = join(directory, 'state');
  const projectDir = join(directory, 'project');
  mkdirSync(stateDir); mkdirSync(projectDir);
  writeFileSync(join(stateDir, 'cursor-cli.json'), CURSOR_CLI, { mode: 0o600 });
  const services = await createApp({ stateDir, auth: false, cliPath: '/nonexistent/cursor-agent', plugins });
  cleanups.push(async () => { await services.app.close(); rmSync(directory, { recursive: true, force: true }); });
  const origin = { host: '127.0.0.1:4337', origin: 'http://127.0.0.1:4337' };
  const auth = await services.app.inject({ url: '/api/auth/status', headers: origin });
  const headers = { ...origin, cookie: String(auth.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': auth.json().csrfToken as string };
  const call = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: Record<string, unknown>) => services.app.inject({ url, method, headers, ...(payload ? { payload } : {}) });
  return { ...services, call, stateDir, project: services.store.createProject(projectDir, 'no cursor') };
}

const event = (sessionId: string, id: string, type: string, text: string): NativeWorkbenchEvent => ({ sequence: 0, sessionId, type, nativeId: id, nativeTurnId: 'turn-1', createdAt: '2026-10-01T00:00:01.000Z', data: { content: { type: 'text', text } } });
const unavailable = { error: { code: 'NATIVE_BACKEND_UNAVAILABLE', details: { backendId: 'cursor' } } };

describe('the core without the Cursor plugin', () => {
  it('starts, keeps Cursor sessions and settings readable, and refuses what needs the CLI', async () => {
    const { call, store, project, stateDir } = await boot();
    // A session Cursor wrote before backends had ids (no `backendId`, the `cursorSessionId` mirror), with its history already journaled.
    const legacy = store.createSession({ projectId: project.id, kind: 'native', title: 'Legacy chat', cursorSessionId: 'legacy-chat' });
    JournalLaneWriter.open(store.journal, legacy.id).commit({ events: [event(legacy.id, '1:0', 'user_message_chunk', 'old question'), event(legacy.id, '2:0', 'agent_message_chunk', 'old answer')], cursor: '2' });

    expect((await call('GET', '/api/sessions')).json()).toContainEqual(expect.objectContaining({ id: legacy.id, backendId: 'cursor', nativeSessionId: 'legacy-chat', cursorSessionId: 'legacy-chat' }));
    const page = await call('GET', `/api/v3/sessions/${legacy.id}/timeline?lane=main&before=999999999`);
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('old question');
    expect(page.body).toContain('old answer');

    // The catalog has no Cursor entry, the other backends stay; the plugin list has no Cursor either.
    const backends = (await call('GET', '/api/backends')).json() as Array<{ backendId: string }>;
    expect(backends.map(item => item.backendId)).toEqual(expect.arrayContaining(['claude', 'codex']));
    expect(backends.map(item => item.backendId)).not.toContain('cursor');
    expect(((await call('GET', '/api/integrations')).json() as { integrations: Array<{ id: string }> }).integrations.map(item => item.id)).not.toContain('riffet.cursor');

    // Nothing that launches the CLI: a new session that names it, a start, a send, and the legacy forwards.
    for (const [method, url, payload] of [
      ['POST', '/api/sessions', { projectId: project.id, kind: 'native', backendId: 'cursor' }],
      ['POST', `/api/sessions/${legacy.id}/start`],
      ['POST', `/api/sessions/${legacy.id}/native/send`, { commandId: 'c1', text: 'hello' }],
      ['GET', '/api/cursor/capabilities'],
      ['GET', '/api/cursor/models'],
      ['POST', '/api/cursor/command', { operation: 'status' }],
      ['GET', '/api/native/runtime/stats'],
    ] as const) {
      const refused = await call(method, url, payload);
      expect([url, refused.statusCode, refused.json().error.code, refused.json().error.details]).toEqual([url, 503, unavailable.error.code, unavailable.error.details]);
    }
    // The default is the user's saved choice only while it is offered: with Cursor off a new session starts on the first installed backend (Claude when none is) and the setting says so.
    expect((await call('GET', '/api/settings')).json().defaultBackendId).toBe('claude');
    const fallback = await call('POST', '/api/sessions', { projectId: project.id, kind: 'native' });
    expect([fallback.statusCode, fallback.json().backendId]).toEqual([200, 'claude']);
    // Refused before it is queued: no run is left behind, and the conversation stays as it was.
    expect(store.findRunByCommand(legacy.id, 'c1')).toBeUndefined();
    expect(store.getSession(legacy.id).state).toBe('idle');

    // The stored compat shape still reads; a save is validated by the driver that is not there, so it is refused and nothing is written.
    const shape = { executable: '/opt/cursor/cursor-agent', hasApiKey: true };
    expect((await call('GET', '/api/settings')).json().cursorCli).toEqual(shape);
    const saved = await call('PATCH', '/api/settings', { cursorCli: { executable: '/opt/other/cursor-agent' } });
    expect([saved.statusCode, saved.json().error.code]).toEqual([503, 'NATIVE_BACKEND_UNAVAILABLE']);
    expect(readFileSync(join(stateDir, 'cursor-cli.json'), 'utf8')).toBe(CURSOR_CLI);
    expect((await call('GET', '/api/settings')).json().cursorCli).toEqual(shape);
  }, 30_000);

  it('boots with no built-in plugins and still answers the catalogs', async () => {
    const { call } = await boot([]);
    expect((await call('GET', '/api/integrations')).statusCode).toBe(200);
    expect((await call('GET', '/api/backends')).statusCode).toBe(200);
  }, 30_000);
});
