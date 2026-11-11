import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../store.js';
import { WorkspaceService } from '../workspace/index.js';
import { AppError } from '../errors.js';
import { registerTerminalAttachmentRoutes } from './terminal-attachments.js';
import type { RouteDeps } from './deps.js';

const cleanup: Array<() => Promise<unknown> | void> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const task of cleanup.splice(0).reverse()) await task(); });

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'riffet-terminal-attachments-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const db = join(root, 'db.sqlite');
  const store = new Store(db);
  cleanup.push(() => store.close());
  store.saveTerminal({ id: 'terminal', projectId: 'project', title: 'test', kind: 'shell', state: 'running', persistent: true, ownerId: 'client', epoch: 3, cols: 80, rows: 24, createdAt: new Date().toISOString() });
  const workspace = new WorkspaceService({ stateDir: root });
  const attachment = await workspace.upload(undefined, { name: "截图 ' v2.png", mimeType: 'image/png', dataBase64: Buffer.from('fixture-image-bytes').toString('base64') });
  const paste = vi.fn(async (_id: string, _client: string, _epoch: number, _text: string, authorize: () => void, beforeWrite: () => void) => { authorize(); beforeWrite(); });
  const auth = { authenticate: vi.fn() };
  const mount = (saved = store) => {
    const app = Fastify();
    app.setErrorHandler((error, _request, reply) => reply.code(error instanceof AppError ? error.statusCode : 500).send({ code: error instanceof AppError ? error.code : 'ERROR' }));
    registerTerminalAttachmentRoutes(app, { store: saved, workspace, auth, terminal: { get: async (id: string) => saved.getTerminal(id), pasteAttachmentsWithLease: paste } } as unknown as RouteDeps);
    cleanup.push(() => app.close());
    return app;
  };
  const app = mount();
  const body = { clientId: 'client', epoch: 3, requestId: 'request', attachmentIds: [attachment.id] };
  const post = (payload = body, target = app) => target.inject({ method: 'POST', url: '/api/terminals/terminal/paste-attachments', payload });
  return { root, db, store, workspace, attachment, paste, auth, mount, app, body, post };
}

describe('terminal attachment paste contract', () => {
  it('materializes durable paths and writes once across concurrent retries and a reopened receipt store', async () => {
    const h = await harness();
    const responses = await Promise.all([h.post(), h.post()]);
    expect(responses.map(response => response.json())).toEqual(Array(2).fill({ requestId: 'request', status: 'completed' }));
    expect(h.paste).toHaveBeenCalledOnce();
    const path = join(h.root, 'attachments', 'materialized', h.attachment.id, h.attachment.name);
    expect(await readFile(path, 'utf8')).toBe('fixture-image-bytes');
    expect(h.paste.mock.calls[0]!.slice(0, 4)).toEqual(['terminal', 'client', 3, `'${path.replaceAll("'", "'\\''")}'`]);
    expect(h.store.referencedAttachmentIds(new Date().toISOString())).toContain(h.attachment.id);
    await h.workspace.pruneAttachments({ olderThan: Date.now() + 1000, keep: h.store.referencedAttachmentIds(new Date().toISOString()) });
    expect(await h.workspace.readAttachmentMetadata(h.attachment.id)).toMatchObject({ id: h.attachment.id });
    const reopened = new Store(h.db);
    cleanup.push(() => reopened.close());
    expect((await h.post(h.body, h.mount(reopened))).json()).toEqual({ requestId: 'request', status: 'completed' });
    expect(h.paste).toHaveBeenCalledOnce();
    expect((await h.post({ ...h.body, epoch: 4 })).statusCode).toBe(409);
  });

  it('rejects a changed lease or revoked authorization after attachment preparation, without writing', async () => {
    const h = await harness();
    const original = h.workspace.readAttachment.bind(h.workspace);
    const read = vi.spyOn(h.workspace, 'readAttachment').mockImplementation(async id => {
      const result = await original(id);
      h.store.updateTerminal('terminal', { ownerId: 'other', epoch: 4 });
      return result;
    });
    expect((await h.post()).statusCode).toBe(409);
    expect(h.paste).not.toHaveBeenCalled();
    read.mockRestore();
    h.store.updateTerminal('terminal', { ownerId: 'client', epoch: 3 });
    h.auth.authenticate.mockImplementation(() => { throw new AppError('UNAUTHORIZED', 'Revoked', 401); });
    expect((await h.post()).statusCode).toBe(401);
    expect(h.paste).not.toHaveBeenCalled();
  });

  it('retains uncertain receipts without replaying and rejects terminal escape bytes in filenames', async () => {
    const h = await harness();
    h.paste.mockImplementationOnce(async (_id, _client, _epoch, _text, authorize, beforeWrite) => { authorize(); beforeWrite(); throw new Error('Lost tmux acknowledgement'); });
    expect((await h.post()).json()).toEqual({ requestId: 'request', status: 'unknown' });
    const reopened = new Store(h.db);
    cleanup.push(() => reopened.close());
    expect((await h.post(h.body, h.mount(reopened))).json()).toEqual({ requestId: 'request', status: 'unknown' });
    expect(h.paste).toHaveBeenCalledOnce();
    const unsafe = await h.workspace.upload(undefined, { name: 'image\x1b[201~.png', mimeType: 'image/png', dataBase64: 'YQ==' });
    expect((await h.post({ ...h.body, requestId: 'unsafe', attachmentIds: [unsafe.id] })).statusCode).toBe(400);
    expect(h.paste).toHaveBeenCalledOnce();
  });
});
