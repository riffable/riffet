import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

function loadSendPrompt() {
  const source = readFileSync(new URL('./index.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('async function sendPrompt(params) {');
  const end = source.indexOf('\nasync function interruptSession', start);
  if (start < 0 || end < 0) throw new Error('Could not locate the DSH bridge send handler');
  const declaration = source.slice(start, end);
  return new Function(
    'requiredString', 'handles', 'assertEntryScope', 'withSessionLock', 'promptExists',
    'applySessionConfig', 'admitContent', 'createUserMessage',
    `${declaration}\nreturn { sendPrompt };`,
  ) as (
    requiredString: (value: unknown, label: string) => string,
    handles: Map<string, unknown>,
    assertEntryScope: (entry: unknown, sessionId: unknown, cwd: unknown) => void,
    withSessionLock: (nativeSessionId: string, operation: () => Promise<unknown>) => Promise<unknown>,
    promptExists: (agent: unknown, commandId: string) => boolean,
    applySessionConfig: (entry: unknown, config: unknown) => Promise<void>,
    admitContent: (content: unknown) => Promise<unknown>,
    createUserMessage: (message: unknown) => { id: string },
  ) => {
    sendPrompt: (params: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function assertEntryScope(entry: unknown, sessionId: unknown, cwd: unknown): void {
  const scoped = entry as { workbenchSessionId: string; cwd: string };
  if (scoped.workbenchSessionId !== sessionId || scoped.cwd !== cwd) throw new Error('session scope mismatch');
}

function setup(followup: (message: unknown, inbox: unknown[]) => void) {
  const nativeSessionId = 'native-send';
  const inbox: unknown[] = [];
  const agent = { followup: vi.fn((message: unknown) => followup(message, inbox)) };
  const entry = {
    nativeSessionId,
    workbenchSessionId: 'session-send',
    cwd: '/tmp/dsh-send',
    agent,
    commandRuns: new Map<string, { runId: string; attachments: unknown[] }>(),
  };
  const handles = new Map<string, unknown>([[nativeSessionId, entry]]);
  const withSessionLock = async (_id: string, operation: () => Promise<unknown>) => await operation();
  // This models the race window: the accepted item has left the inbox but has not reached the log.
  const promptExists = vi.fn(() => false);
  const { sendPrompt: handler } = loadSendPrompt()(
    requiredString,
    handles,
    assertEntryScope,
    withSessionLock,
    promptExists,
    async () => undefined,
    async content => content,
    message => ({ id: 'message-1', ...(message as object) }),
  );
  const params = {
    nativeSessionId,
    sessionId: 'session-send',
    cwd: '/tmp/dsh-send',
    commandId: 'command-send',
    runId: 'run-send',
    content: [{ type: 'text', text: 'hello' }],
    attachments: [],
  };
  return { agent, entry, handler, inbox, params, promptExists };
}

describe('DSH bridge send idempotency', () => {
  it('returns duplicate for a command already admitted to the inbox before a snapshot exists', async () => {
    const h = setup((message, inbox) => { inbox.push(message); });

    const first = await h.handler(h.params);
    const duplicate = await h.handler(h.params);

    expect(first).toMatchObject({ accepted: true, messageId: 'message-1' });
    expect(duplicate).toEqual({ accepted: true, duplicate: true });
    expect(h.agent.followup).toHaveBeenCalledTimes(1);
    expect(h.inbox).toHaveLength(1);
    expect(h.promptExists).toHaveBeenCalledTimes(1);
  });

  it('removes a synchronously rejected command so the same id can be retried', async () => {
    let attempts = 0;
    const h = setup((message, inbox) => {
      attempts += 1;
      if (attempts === 1) throw new Error('inbox rejected');
      inbox.push(message);
    });

    await expect(h.handler(h.params)).rejects.toThrow('inbox rejected');
    expect(h.entry.commandRuns.has('command-send')).toBe(false);

    const retry = await h.handler(h.params);

    expect(retry).toMatchObject({ accepted: true, messageId: 'message-1' });
    expect(h.agent.followup).toHaveBeenCalledTimes(2);
    expect(h.inbox).toHaveLength(1);
  });
});
