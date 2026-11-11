import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

function loadInterruptSession() {
  const source = readFileSync(new URL('./index.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('async function interruptSession(params) {');
  const end = source.indexOf('\nasync function configureSession', start);
  if (start < 0 || end < 0) throw new Error('Could not locate the DSH bridge interrupt handler');
  const declaration = source.slice(start, end);
  return new Function('requiredString', 'handles', 'assertEntryScope', `${declaration}\nreturn interruptSession;`) as (
    requiredString: (value: unknown, label: string) => string,
    handles: Map<string, unknown>,
    assertEntryScope: (entry: unknown, sessionId: unknown, cwd: unknown) => void,
  ) => (params: Record<string, unknown>) => Promise<{ interrupted: boolean }>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function assertEntryScope(entry: unknown, sessionId: unknown, cwd: unknown): void {
  const scoped = entry as { workbenchSessionId: string; cwd: string };
  if (scoped.workbenchSessionId !== sessionId || scoped.cwd !== cwd) throw new Error('session scope mismatch');
}

describe('DSH bridge interrupt inbox behavior', () => {
  it('clears queued prompts for a normal stop and waits for the agent to become idle', async () => {
    const handles = new Map<string, unknown>();
    const handler = loadInterruptSession()(requiredString, handles, assertEntryScope);
    const inbox = ['queued follow-up'];
    let releaseIdle!: () => void;
    const idle = new Promise<void>(resolve => { releaseIdle = resolve; });
    const agent = {
      cancel: vi.fn((_cause: unknown, options: { keepInbox: boolean }) => {
        if (!options.keepInbox) inbox.length = 0;
      }),
      whenIdle: vi.fn(() => idle),
    };
    handles.set('native-1', {
      nativeSessionId: 'native-1', workbenchSessionId: 'session-1', cwd: '/tmp/project', agent,
    });

    let settled = false;
    const stopping = handler({ nativeSessionId: 'native-1', sessionId: 'session-1', cwd: '/tmp/project' })
      .then(result => { settled = true; return result; });
    await Promise.resolve();

    expect(agent.cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: false });
    expect(inbox).toEqual([]);
    expect(agent.whenIdle).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    releaseIdle();
    await expect(stopping).resolves.toEqual({ interrupted: true });
    expect(settled).toBe(true);
  });
});
