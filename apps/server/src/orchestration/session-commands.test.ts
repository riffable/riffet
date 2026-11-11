import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../errors.js';
import { Store } from '../store.js';
import { SessionCommands } from './session-commands.js';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose(); });
function memory() {
  const store = new Store(':memory:');
  cleanup.push(() => store.close());
  return store;
}

describe('submission admission receipts', () => {
  it('shares concurrent preflight failure for normalized input and refuses another payload', async () => {
    const store = memory();
    const commands = new SessionCommands();
    let reject!: (error: Error) => void;
    const action = vi.fn(() => new Promise<never>((_resolve, fail) => { reject = fail; }));
    const first = commands.submit(store, 'not-created-yet', 'command', { input: { text: 'private prompt', context: [] }, kind: 'create' }, action);
    const repeated = commands.submit(store, 'not-created-yet', 'command', { kind: 'create', input: { context: [], text: 'private prompt' } }, action);
    expect(repeated).toBe(first);
    await expect(commands.submit(store, 'not-created-yet', 'command', { input: { text: 'different' } }, action)).rejects.toMatchObject({ code: 'COMMAND_ID_CONFLICT', statusCode: 409 });
    const failed = Promise.allSettled([first, repeated]);
    const error = new AppError('INVALID_INPUT', 'Rejected before acceptance', 400);
    reject(error);
    expect(await failed).toEqual([{ status: 'rejected', reason: error }, { status: 'rejected', reason: error }]);
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('replays a durable rejection after reopening without retaining input or credential text', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'riffet-submission-'));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, 'workbench.db');
    const first = new Store(path);
    const identity = { text: 'sensitive user prompt', context: [{ path: 'file.ts', line: 4 }] };
    try {
      await expect(new SessionCommands().submit(first, 'future-session', 'command', identity, async () => {
        throw new AppError('INVALID_INPUT', 'Cannot accept sensitive user prompt; token=credential-value', 422, { raw: 'never persisted' }, { count: 3, token: 'credential-value' });
      })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      const saved = first.db.prepare("SELECT json FROM settings WHERE key LIKE 'native-command-rejection:%'").all();
      expect(saved).toHaveLength(1);
      expect(JSON.stringify(saved)).not.toContain('sensitive user prompt');
      expect(JSON.stringify(saved)).not.toContain('credential-value');
      expect(JSON.stringify(saved)).not.toContain('never persisted');
    } finally { first.close(); }
    const restored = new Store(path);
    cleanup.push(() => restored.close());
    const action = vi.fn(async () => 'must not execute');
    const commands = new SessionCommands();
    await expect(commands.submit(restored, 'future-session', 'command', identity, action)).rejects.toMatchObject({ code: 'INVALID_INPUT', statusCode: 422, params: { count: 3, token: '[REDACTED]' } });
    await expect(commands.submit(restored, 'future-session', 'command', { ...identity, text: 'new input' }, action)).rejects.toMatchObject({ code: 'COMMAND_ID_CONFLICT' });
    expect(action).not.toHaveBeenCalled();
  });

  it('does not persist unknown transport, server or unconfirmed-stop failures', async () => {
    const store = memory();
    const commands = new SessionCommands();
    for (const error of [new Error('network'), new AppError('SERVER_UNAVAILABLE', 'Unavailable', 503), new AppError('NATIVE_STOP_UNCONFIRMED', 'Still stopping', 409), new AppError('REQUEST_TIMEOUT', 'No result', 408)]) {
      const action = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce('accepted');
      await expect(commands.submit(store, 'future-session', 'command', { text: 'same input' }, action)).rejects.toBe(error);
      await expect(commands.submit(store, 'future-session', 'command', { text: 'same input' }, action)).resolves.toBe('accepted');
      expect(action).toHaveBeenCalledTimes(2);
    }
    expect(store.db.prepare("SELECT json FROM settings WHERE key LIKE 'native-command-rejection:%'").all()).toHaveLength(0);
  });

  it('lets an existing Run own idempotency even after a recorded rejection or a later action error', async () => {
    const store = memory();
    const project = store.createProject('/tmp/riffet-submission-test', 'submission');
    const session = store.createSession({ projectId: project.id, kind: 'native', mode: 'agent' });
    const commands = new SessionCommands();
    await expect(commands.submit(store, session.id, 'command', { text: 'old input' }, async () => { throw new AppError('INVALID_INPUT', 'Rejected', 400); })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const run = store.createRun(session.id, 'command', 'authoritative input');
    const accepted = vi.fn(async () => run);
    await expect(commands.submit(store, session.id, 'command', { text: 'different input checked by accepted path' }, accepted)).resolves.toEqual(run);
    expect(accepted).toHaveBeenCalledTimes(1);

    await expect(commands.submit(store, session.id, 'accepted-during-action', { text: 'accepted' }, async () => {
      store.createRun(session.id, 'accepted-during-action', 'accepted');
      throw new AppError('ATTACHMENT_NOT_FOUND', 'Later validation failed', 404);
    })).rejects.toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' });
    const retry = vi.fn(async () => store.findRunByCommand(session.id, 'accepted-during-action'));
    await expect(new SessionCommands().submit(store, session.id, 'accepted-during-action', { text: 'accepted' }, retry)).resolves.toMatchObject({ commandId: 'accepted-during-action' });
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
