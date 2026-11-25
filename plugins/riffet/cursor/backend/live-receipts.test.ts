import { describe, expect, it } from 'vitest';
import type { AgentHost } from '@riffet/plugin-api/experimental/agent';
import { CursorLiveReceipts } from './live-receipts.js';
import type { CursorLiveStep } from '../native/live.js';

describe('CursorLiveReceipts', () => {
  // A first prompt whose CLI refused its model is run by the relaunched CLI long after the send; the
  // launch looks for it again, and the step the live tap already wrote to disk is its receipt, once.
  it('confirms a prompt looked for again at a relaunch, from the step already on disk, once', async () => {
    const sentAt = Date.now() - 20 * 60_000;
    const step = { turn: 'turn-1', at: new Date(sentAt + 16 * 60_000).toISOString(), prompt: 'build the architecture' } as CursorLiveStep;
    const events: Array<{ type: string; runId?: string; data: Record<string, unknown> }> = [];
    const host = { emitEvent: (_sessionId: string, event: never) => events.push(event) } as unknown as AgentHost;
    const receipts = new CursorLiveReceipts({ read: () => step, watch: () => () => {} });
    const entry = { host, sessionId: 's', chatId: 'chat', runId: 'run-1', commandId: 'cmd-1', text: 'build the architecture', sentAt };

    await receipts.expect(entry);
    expect(events).toHaveLength(0);

    await receipts.expect({ ...entry, waitFrom: Date.now() });
    await receipts.expect({ ...entry, waitFrom: Date.now() });
    expect(events).toMatchObject([{ type: 'native_input_receipt', runId: 'run-1', nativeTurnId: 'turn-1', data: { commandId: 'cmd-1' } }]);
  });

  it('does not assign a post-release identical prompt to an older released send', async () => {
    const sentAt = Date.now() - 10_000;
    const releasedAt = new Date(sentAt + 5_000).toISOString();
    let step: CursorLiveStep | undefined;
    let onWatch: ((chatId: string) => void) | undefined;
    const events: Array<{ type: string; runId?: string; data: Record<string, unknown> }> = [];
    const runs = new Map<string, { id: string; commandId: string; queueReleasedAt?: string }>([
      ['run-old', { id: 'run-old', commandId: 'cmd-old', queueReleasedAt: releasedAt }],
      ['run-new', { id: 'run-new', commandId: 'cmd-new' }],
    ]);
    const host = {
      emitEvent: (_sessionId: string, event: never) => events.push(event),
      runs: { find: async (_sid: string, q: { commandId?: string }) => [...runs.values()].filter(r => r.commandId === q.commandId) },
    } as unknown as AgentHost;
    const receipts = new CursorLiveReceipts({
      read: () => step,
      watch: cb => { onWatch = cb; return () => { onWatch = undefined; }; },
    });

    await receipts.expect({ host, sessionId: 's', chatId: 'chat', runId: 'run-old', commandId: 'cmd-old', text: 'continue', sentAt });
    await receipts.expect({ host, sessionId: 's', chatId: 'chat', runId: 'run-new', commandId: 'cmd-new', text: 'continue', sentAt: Date.parse(releasedAt) + 500 });

    step = { turn: 'turn-new', at: new Date(Date.parse(releasedAt) + 1_000).toISOString(), prompt: 'continue' } as CursorLiveStep;
    onWatch?.('chat');
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(events).toMatchObject([{ type: 'native_input_receipt', runId: 'run-new', nativeTurnId: 'turn-new', data: { commandId: 'cmd-new' } }]);
  });
});
