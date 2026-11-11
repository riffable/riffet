import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { JOURNAL_PAYLOAD_LIMIT } from '../journal/journal.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function boot() {
  const root = await mkdtemp(join(tmpdir(), 'riffet-activities-'));
  const cwd = join(root, 'project');
  await mkdir(cwd);
  const { app, store } = await createApp({ stateDir: join(root, 'state'), auth: false, cliPath: '/nonexistent/cursor-agent' });
  cleanups.push(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const auth = await app.inject({ url: '/api/auth/status', headers: { host: '127.0.0.1:4317' } });
  const headers = { host: '127.0.0.1:4317', cookie: String(auth.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': auth.json().csrfToken as string };
  const project = store.createProject(cwd, 'p');
  const mine = store.createSession({ projectId: project.id, kind: 'native', backendId: 'cursor' });
  const other = store.createSession({ projectId: project.id, kind: 'native', backendId: 'cursor' });
  return { app, store, headers, mine, other };
}

describe('session blobs', () => {
  it('serves a session its own blob, immutable and typed, and nobody else', async () => {
    const { app, store, headers, mine, other } = await boot();
    const text = 'Summary of the work so far\n'.repeat(50);
    const hash = store.journal.putSessionBlob(mine.id, Buffer.from(text));
    const own = await app.inject({ url: `/api/sessions/${mine.id}/blobs/${hash}`, headers });
    expect(own.statusCode).toBe(200);
    expect(own.body).toBe(text);
    expect(own.headers['content-type']).toContain('text/plain');
    expect(own.headers['cache-control']).toContain('immutable');
    expect(own.headers.etag).toBe(`"${hash}"`);
    expect((await app.inject({ url: `/api/sessions/${mine.id}/blobs/${hash}`, headers: { ...headers, 'if-none-match': `"${hash}"` } })).statusCode).toBe(304);
    // Content addressing is not authorization: another conversation cannot read it by knowing the hash.
    expect((await app.inject({ url: `/api/sessions/${other.id}/blobs/${hash}`, headers })).statusCode).toBe(404);
    expect((await app.inject({ url: `/api/sessions/${mine.id}/blobs/not-a-hash`, headers })).statusCode).toBe(400);
    // An oversized journal payload is the session's too, as JSON.
    store.journal.append(mine.id, [{ kind: 'tool_call', nativeId: 'big', payload: { type: 'tool_call', data: { content: 'x'.repeat(JOURNAL_PAYLOAD_LIMIT + 10) } } }]);
    const row = store.journal.range(mine.id, 0, 10).find(item => item.nativeId === 'big')!;
    const payloadBlob = await app.inject({ url: `/api/sessions/${mine.id}/blobs/${row.blobRef}`, headers });
    expect(payloadBlob.headers['content-type']).toContain('application/json');
    expect((await app.inject({ url: `/api/sessions/${other.id}/blobs/${row.blobRef}`, headers })).statusCode).toBe(404);
    // A blob survives the sweep while its session refers to it.
    expect(store.journal.sweepBlobs()).toBe(0);
    store.journal.drop(mine.id);
    expect(store.journal.sweepBlobs()).toBeGreaterThan(0);
  });
});

describe('stopping an activity', () => {
  it('is refused with a clear error by a backend that cannot stop anything', async () => {
    const { app, headers, mine } = await boot();
    const response = await app.inject({ method: 'POST', url: `/api/sessions/${mine.id}/native/activities/cursor%3Ajob-1/stop`, headers });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('ACTIVITY_STOP_UNSUPPORTED');
  });
});

describe('native runtime control', () => {
  it('requires authenticated mutation and rejects malformed actions or unsupported backends', async () => {
    const { app, headers, mine } = await boot();
    const url = `/api/sessions/${mine.id}/native/runtime-control`;
    const action = { action: 'switch', revision: '1' };
    const unauthorized = await app.inject({ method: 'POST', url, headers: { host: headers.host, cookie: headers.cookie }, payload: action });
    expect(unauthorized.statusCode).toBe(403);
    const invalid = await app.inject({ method: 'POST', url, headers, payload: { action: '', revision: '1' } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe('INVALID_RUNTIME_CONTROL');
    const unsupported = await app.inject({ method: 'POST', url, headers, payload: action });
    expect(unsupported.statusCode).toBe(409);
    expect(unsupported.json().error.code).toBe('RUNTIME_CONTROL_UNAVAILABLE');
  });
});
