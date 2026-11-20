import { describe, expect, it } from 'vitest';
import type { AgentHost } from '@riffet/plugin-api/experimental/agent';
import { CursorLiveReceipts } from './live-receipts.js';
import type { CursorLiveStep } from '../native/live.js';

describe('CursorLiveReceipts', () => {
  // A first prompt whose CLI refused its model is run by the relaunched CLI long after the send; the
  // launch looks for it again, and the step the live tap already wrote to disk is its receipt, once.
  it('confirms a prompt looked for again at a relaunch, from the step already on disk, once', () => {
    const sentAt = Date.now() - 20 * 60_000;
    const step = { turn: 'turn-1', at: new Date(sentAt + 16 * 60_000).toISOString(), prompt: 'build the architecture' } as CursorLiveStep;
    const events: Array<{ type: string; runId?: string; data: Record<string, unknown> }> = [];
    const host = { emitEvent: (_sessionId: string, event: never) => events.push(event) } as unknown as AgentHost;
    const receipts = new CursorLiveReceipts({ read: () => step, watch: () => () => {} });
    const entry = { host, sessionId: 's', chatId: 'chat', runId: 'run-1', commandId: 'cmd-1', text: 'build the architecture', sentAt };

    receipts.expect(entry);
    expect(events).toHaveLength(0);

    receipts.expect({ ...entry, waitFrom: Date.now() });
    receipts.expect({ ...entry, waitFrom: Date.now() });
    expect(events).toMatchObject([{ type: 'native_input_receipt', runId: 'run-1', nativeTurnId: 'turn-1', data: { commandId: 'cmd-1' } }]);
  });
});
