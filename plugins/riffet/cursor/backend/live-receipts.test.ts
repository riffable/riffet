import { describe, expect, it } from 'vitest';
import type { AgentRunRef } from '@riffet/plugin-api/experimental/agent';
import { CursorLiveReceipts } from './live-receipts.js';
import type { CursorLiveStep } from '../native/live.js';
import { FakeHost } from '../testing/fake-host.js';

function receiptHost(runs: AgentRunRef[]) {
  const host = new FakeHost();
  host.runs.find = async (_id, query) => runs.filter(run => 'commandId' in query && run.commandId === query.commandId);
  return host;
}

describe('CursorLiveReceipts', () => {
  // A first prompt whose CLI refused its model is run by the relaunched CLI long after the send; the
  // launch looks for it again, and the step the live tap already wrote to disk is its receipt, once.
  it('confirms a prompt looked for again at a relaunch, from the step already on disk, once', async () => {
    const sentAt = Date.now() - 20 * 60_000;
    const step = { turn: 'turn-1', at: new Date(sentAt + 16 * 60_000).toISOString(), prompt: 'build the architecture' } as CursorLiveStep;
    const host = receiptHost([{ id: 'run-1', sessionId: 's', commandId: 'cmd-1', state: 'interrupted' }]);
    const receipts = new CursorLiveReceipts({ read: () => step, watch: () => () => {} });
    const entry = { host, sessionId: 's', chatId: 'chat', runId: 'run-1', commandId: 'cmd-1', text: 'build the architecture', sentAt };

    await receipts.expect(entry);
    expect(host.events).toHaveLength(0);

    await receipts.expect({ ...entry, waitFrom: Date.now() });
    await receipts.expect({ ...entry, waitFrom: Date.now() });
    expect(host.events).toMatchObject([{ type: 'native_input_receipt', runId: 'run-1', nativeTurnId: 'turn-1', data: { commandId: 'cmd-1' } }]);
  });

  it('assigns a repeated prompt to the later send after the previous hold was released', async () => {
    const sentAt = Date.now();
    const old: AgentRunRef = { id: 'old', sessionId: 's', commandId: 'first', state: 'interrupted' };
    const current = { id: 'current', sessionId: 's', commandId: 'second', state: 'queued' };
    const host = receiptHost([old, current]);
    let step: CursorLiveStep | undefined;
    const receipts = new CursorLiveReceipts({ read: () => step, watch: () => () => {} });
    const entry = { host, sessionId: 's', chatId: 'chat', text: 'continue', runId: old.id, commandId: old.commandId, sentAt: sentAt - 60_000 };
    await receipts.expect(entry);
    old.queueReleasedAt = new Date(sentAt - 1_000).toISOString();
    step = { turn: 'later', step: 'later:1', at: new Date(sentAt).toISOString(), prompt: entry.text, sealed: true, parts: [] };
    await receipts.expect({ ...entry, runId: current.id, commandId: current.commandId, sentAt });
    expect(host.events).toMatchObject([{ runId: current.id, nativeTurnId: 'later' }]);

    step = { ...step, turn: 'earlier', at: new Date(sentAt - 2_000).toISOString() };
    await receipts.expect(entry);
    expect(host.events).toMatchObject([{ runId: current.id }, { runId: old.id, nativeTurnId: 'earlier' }]);
  });
});
