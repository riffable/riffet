import { afterEach, describe, expect, it } from 'vitest';
import { laneKey } from '../journal/journal.js';
import { inputMetaId } from '../journal/ingest.js';
import { Store } from '../store.js';
import { TranscriptIngest } from './ingest.js';
import { journalSentInputs } from './sent-input.js';

const config = { model: 'sim', mode: 'agent' };

describe('sent inputs in the journal (docs/TURN-LIFECYCLE.md T1)', () => {
  const stores: Store[] = [];
  afterEach(() => { for (const store of stores.splice(0)) store.close(); });

  it('records a message once, when its write fence is committed and before anything the CLI echoes', async () => {
    const store = new Store(':memory:');
    stores.push(store);
    const ingest = new TranscriptIngest({ journal: store.journal, source: () => undefined });
    const stop = journalSentInputs(store, ingest);
    const project = store.createProject('/tmp/sent-input', 'Sent input');
    const session = store.createSession({ projectId: project.id, kind: 'native', backendId: 'cursor', model: config.model, mode: config.mode, nativeSessionId: 'chat-1' });
    const run = store.acceptNativeRun(session.id, 'command-1', { text: 'hello', attachmentIds: [], context: [] }, config, 0);
    const key = laneKey(session.id, 'main');

    store.transitionNativeRun(run.id, ['queued'], { delivery: 'preparing' });
    expect(store.journal.locate(key, inputMetaId(run.id))).toBeUndefined();

    // The fence: the CLI is written to only after this returns.
    store.transitionNativeRun(run.id, ['preparing'], { delivery: 'dispatching', timings: { dispatchAt: Date.parse('2026-11-27T09:34:48.135Z') } });
    await Promise.resolve();
    const recorded = store.getRun(run.id).native!.inputEntry!;
    const row = store.journal.locate(key, inputMetaId(run.id))!;
    expect(recorded).toEqual({ generation: store.journal.head(key).generation, seq: row.identity });
    expect(row.kind).toBe('meta.input');
    const echo = store.journal.append(key, [{ kind: 'user_message_chunk', nativeId: 'echo-1', at: '2026-11-27T09:35:00.000Z', payload: { type: 'user_message_chunk', data: {} } }]);
    expect(echo.rows[0]!.seq).toBeGreaterThan(recorded.seq);

    // Later moves of the same run neither write it again nor move it.
    store.transitionNativeRun(run.id, ['dispatching'], { delivery: 'input_sent' });
    store.transitionNativeRun(run.id, ['input_sent'], { delivery: 'observed' });
    expect(store.getRun(run.id).native!.inputEntry).toEqual(recorded);
    expect(store.journal.head(key).lastSeq).toBe(echo.rows[0]!.seq);
    stop();
    ingest.close();
  });
});
