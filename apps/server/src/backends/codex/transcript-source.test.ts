import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import type { NativeActivity, NativeWorkbenchEvent } from '../../../../../packages/contracts/src/index.js';
import { JOURNAL_PAYLOAD_LIMIT, Journal, laneKey } from '../../journal/journal.js';
import { JournalLaneWriter, pullLane } from '../../journal/ingest.js';
import { eventInput } from '../../journal/native-log.js';
import { checkSession, rowsOf, runIngestContract, type IngestContractFixture } from '../../journal/ingest-contract.js';
import { CodexTranscriptSource, type CodexLiveFeed, type CodexThreadReader, type CodexTurnsRequest } from './transcript-source.js';
import { CodexQuestionHistory } from './question-history.js';
import { CodexActivities, readCompaction } from './activities.js';
import { codexFlavor } from './flavors.js';
import type { RpcItem, RpcTurn } from './types.js';

/*
 * Threads as the app-server serves them: `thread/turns/list` pages in either direction behind an
 * opaque cursor, items named by their own ids, a running turn served with what it has so far, and
 * notifications to whoever is attached when something changes.
 */
class FakeThreads implements CodexThreadReader {
  current = 'thread-1';
  readonly threads = new Map<string, RpcTurn[]>();
  readonly feeds = new Set<CodexLiveFeed>();
  readonly requests: CodexTurnsRequest[] = [];

  async turnsPage(request: CodexTurnsRequest) {
    this.requests.push(request);
    await Promise.resolve();
    const turns = this.threads.get(request.threadId);
    if (!turns) return undefined;
    const full = request.itemsView === undefined || request.itemsView === 'full';
    const view = (turn: RpcTurn) => full ? structuredClone(turn) : { ...turn, items: [] };
    if (request.sortDirection === 'asc') {
      const start = request.cursor ? Number(request.cursor) : 0, end = Math.min(turns.length, start + request.limit);
      return { data: turns.slice(start, end).map(view), nextCursor: end < turns.length ? String(end) : null };
    }
    const end = request.cursor ? Number(request.cursor) : turns.length, start = Math.max(0, end - request.limit);
    return { data: turns.slice(start, end).reverse().map(view), nextCursor: start > 0 ? String(start) : null };
  }

  turns(threadId = this.current): RpcTurn[] {
    let turns = this.threads.get(threadId);
    if (!turns) this.threads.set(threadId, turns = []);
    return turns;
  }

  notify(method: string, params: Record<string, unknown>): void { for (const feed of this.feeds) feed.notification(method, { threadId: this.current, ...params }); }
}

const user = (id: string, text: string, extra: Record<string, unknown> = {}): RpcItem => ({ type: 'userMessage', id, content: [{ type: 'text', text }], ...extra });
const answer = (id: string, text: string): RpcItem => ({ type: 'agentMessage', id, text, phase: 'final_answer' });
const command = (id: string, output: string): RpcItem => ({ type: 'commandExecution', id, command: 'ls -la', cwd: '/work', status: 'completed', aggregatedOutput: output, exitCode: 0 });
const turn = (id: string, at: number, items: RpcItem[], status = 'completed'): RpcTurn => ({ id, status, startedAt: at, ...(status === 'inProgress' ? {} : { completedAt: at + 1 }), items });
const spawn = (id: string, child: string): RpcItem => ({ type: 'collabAgentToolCall', id, tool: 'spawnAgent', receiverThreadIds: [child], prompt: `Look into ${child}`, status: 'completed' });

function codexFixture(native = new FakeThreads()): IngestContractFixture & { native: FakeThreads } {
  native.threads.set('child-1', [turn('c1-t1', 100, [user('c1-u1', 'Look into child-1'), command('c1-cmd', 'files'), answer('c1-a1', 'Found it')])]);
  const turns = native.turns();
  for (let index = 1; index <= 25; index += 1) {
    const items: RpcItem[] = [user(`u-${index}`, `Question ${index}`, index === 5 ? { clientId: 'cmd-5' } : {})];
    if (index === 2) items.push(command('cmd-2', 'small output'));
    if (index === 3) items.push(command('cmd-big', 'x'.repeat(JOURNAL_PAYLOAD_LIMIT + 100)));
    if (index === 4) items.push({ type: 'contextCompaction', id: 'compact-4' });
    if (index === 8) items.push(spawn('spawn-8', 'child-1'));
    if (index === 9) items.push({ type: 'reasoning', id: 'rs-9', summary: ['Thinking it over'], content: [] });
    items.push(answer(`a-${index}`, `Answer ${index}`));
    turns.push(turn(`t${index}`, index * 10, items));
  }
  // The newest turn is still running: what it has so far is a question and the start of an answer.
  let open = 'open-0';
  turns.push(turn(open, 300, [user('u-open-0', 'Keep going'), answer('a-open-0', 'Work')], 'inProgress'));
  /** Ends the running turn, the way the app-server reports it, and opens the next one when asked. */
  const settle = (next?: string) => {
    const last = turns.at(-1)!;
    if (last.status === 'inProgress') {
      last.items = [...(last.items ?? []).filter(item => item.type !== 'agentMessage'), answer(`a-${last.id}`, `Done with ${last.id}`)];
      last.status = 'completed';
      last.completedAt = Number(last.startedAt) + 1;
      native.notify('item/completed', { turnId: last.id, item: last.items.at(-1) });
      native.notify('turn/completed', { turn: { id: last.id, status: 'completed', items: [] } });
    }
    if (!next) return;
    open = next;
    const at = turns.length * 10 + 1000;
    turns.push(turn(next, at, [user(`u-${next}`, `Next ${next}`), answer(`a-${next}`, 'Start')], 'inProgress'));
    native.notify('turn/started', { turn: { id: next, startedAt: at } });
  };
  let appended = 0;
  return {
    native,
    scratch: true,
    source: () => new CodexTranscriptSource({
      sessionId: 'contract-session', backend: 'codex',
      threadId: () => native.current,
      reader: async () => native,
      commandOf: item => typeof item.clientId === 'string' ? item.clientId : undefined,
      runOf: commandId => `run-${commandId}`,
      observe: feed => { native.feeds.add(feed); return () => { native.feeds.delete(feed); }; },
    }),
    append: () => { appended += 1; settle(`open-${appended}`); },
    // The running turn's answer grows under its own id, and the turn ends.
    update: () => {
      const last = turns.at(-1)!;
      last.items = [...(last.items ?? []).filter(item => item.type !== 'agentMessage'), answer(`a-${last.id}`, 'Start, and then the rest')];
      last.status = 'completed';
      last.completedAt = Number(last.startedAt) + 1;
    },
    // Typed into the TUI: no workbench command names it.
    terminalTurn: () => { settle(); turns.push(turn('typed', 5000, [user('u-typed', 'typed in the terminal'), command('cmd-typed', 'ok'), answer('a-typed', 'Typed answer')])); },
    // A subagent that spawns one of its own.
    subagent: () => {
      settle();
      native.threads.set('child-3', [turn('c3-t1', 6001, [user('c3-u1', 'Look into child-3'), answer('c3-a1', 'Deepest')])]);
      native.threads.set('child-2', [turn('c2-t1', 6000, [user('c2-u1', 'Look into child-2'), spawn('spawn-c2', 'child-3'), answer('c2-a1', 'Delegated')])]);
      turns.push(turn('t-sub', 6000, [user('u-sub', 'Ask a helper'), spawn('spawn-sub', 'child-2'), answer('a-sub', 'Helper answered')]));
    },
    changeIdentity: () => {
      native.current = 'thread-2';
      native.turns().push(turn('n1', 10, [user('u-n1', 'A new conversation'), answer('a-n1', 'Fresh')]));
    },
  };
}

describe('Codex transcript source', () => {
  it('projects native review entry and final output with distinct identities across live history and restart', async () => {
    const fixture = codexFixture();
    const { native } = fixture;
    native.threads.set(native.current, []);
    const journal = new Journal(new DatabaseSync(':memory:'));
    const writer = JournalLaneWriter.open(journal, 's');
    const source = fixture.source();
    const stop = source.watch!(writer, () => undefined);
    const signal = new AbortController().signal;
    try {
      await pullLane(source, writer, signal);
      const entered: RpcItem = { type: 'enteredReviewMode', id: 'review-turn', review: 'current changes' };
      const exited: RpcItem = { type: 'exitedReviewMode', id: 'review-turn', review: 'Review result with findings' };
      const items = [user('review-turn', 'Review current changes'), entered, exited];
      native.notify('turn/started', { turn: { id: 'review-turn', startedAt: 10 } });
      native.notify('item/completed', { turnId: 'review-turn', item: items[0] });
      native.notify('item/started', { turnId: 'review-turn', item: entered });
      native.notify('item/started', { turnId: 'review-turn', item: { ...exited, review: 'Review result' } });
      native.notify('item/completed', { turnId: 'review-turn', item: exited });
      await pullLane(source, writer, signal);
      const entryId = 'thread-1:review-turn:review-turn:review:entered';
      const resultId = 'thread-1:review-turn:review-turn:review:result';
      expect(journal.entity('s', entryId)).toMatchObject({ kind: 'agent_thought_chunk', payload: { data: { channel: 'narration', content: { text: entered.review } } } });
      const result = journal.entity('s', resultId);
      expect(result).toMatchObject({ kind: 'agent_message_chunk', payload: { data: { phase: 'final_answer', content: { text: exited.review } } } });

      native.turns().push(turn('review-turn', 10, items));
      native.notify('turn/completed', { turn: { id: 'review-turn', status: 'completed', items: [] } });
      await pullLane(source, writer, signal);
      expect(journal.entity('s', resultId)?.identity).toBe(result!.identity);
      const lastSeq = journal.head('s').lastSeq;
      await pullLane(fixture.source(), JournalLaneWriter.open(journal, 's'), signal);
      expect(journal.head('s').lastSeq).toBe(lastSeq);
      expect(rowsOf(journal, 's').filter(row => row.rev === 1 && (row.nativeId === entryId || row.nativeId === resultId))).toHaveLength(2);
      checkSession(journal, 's');
    } finally { stop(); }
  });

  it('requires success evidence when reading historical compaction outcomes', () => {
    const item: RpcItem = { type: 'contextCompaction', id: 'compact-1' };
    for (const [status, expected] of [['completed', 'completed'], ['failed', 'failed'], ['interrupted', 'stopped'], [undefined, 'unknown']] as const) {
      const nativeTurn = { id: 't1', status, items: [user('u1', 'Work'), item, answer('a1', 'Later output')] };
      expect(readCompaction('codex', item, nativeTurn, true)).toMatchObject({ status: expected, compaction: { trigger: 'auto' } });
      expect(readCompaction('codex', { ...item, completedAtMs: 12_000 }, nativeTurn, true).status).toBe('completed');
    }
    for (const nativeTurn of [
      { id: 'missing-start', status: 'completed', startedAt: null, completedAt: 1_800_000_000, items: [item] },
      { id: 'missing-times', status: 'completed', items: [item] },
    ]) {
      const activity = readCompaction('codex', item, nativeTurn, true);
      expect(activity.startedAt).toBeUndefined();
      expect(activity.durationMs).toBeUndefined();
      expect(activity.endedAt).toBe(nativeTurn.completedAt === undefined ? undefined : new Date(nativeTurn.completedAt * 1000).toISOString());
    }
    expect(readCompaction('codex', item, { id: 'manual', items: [item] }, false)).toMatchObject({ status: 'running', compaction: { trigger: 'manual' } });
    expect(readCompaction('codex', item, { id: 'auto', items: [user('u1', 'Work'), item, answer('a1', 'Later output')] }, false).status).toBe('unknown');
  });

  it('settles only unconfirmed compactions from native turn outcomes and retains successful details', () => {
    const journal = new Journal(new DatabaseSync(':memory:'));
    const written: NativeActivity[] = [];
    const activities = new CodexActivities({
      flavor: codexFlavor, sessionId: 's', threadId: () => 'thread-1', transport: () => undefined,
      journal: () => journal, contextUsed: () => 100, rolloutFile: async () => undefined,
      write: activity => { written.push(activity); }, hasListeners: () => false,
    });
    for (const [status, expected] of [['completed', 'completed'], ['failed', 'failed'], ['interrupted', 'stopped'], [undefined, 'unknown']] as const) {
      const turnId = `turn-${status}`;
      const item: RpcItem = { type: 'contextCompaction', id: turnId };
      activities.compactionStarted(item, turnId, 10_000);
      activities.turnCompleted(turnId, status);
      expect(written.at(-1)).toMatchObject({ status: expected, compaction: { trigger: 'manual', preTokens: 100 } });

      const readId = `read-${status}`;
      const readItem: RpcItem = { type: 'contextCompaction', id: readId };
      activities.compactionStarted(readItem, readId, 10_000);
      activities.noteTurn({ id: readId, status, completedAt: 20, items: [readItem] }, true, true);
      expect(written.at(-1)?.status).toBe(expected);
      if (status === 'interrupted') {
        for (const corrected of ['failed', 'completed'] as const) {
          activities.noteTurn({ id: readId, status: corrected, completedAt: 30, items: [readItem] }, true, true);
          expect(written.at(-1)).toMatchObject({ status: corrected, endedAt: new Date(30_000).toISOString(), durationMs: 20_000 });
        }
      }
    }
    activities.noteUserMessage('auto-turn');
    const confirmed: RpcItem = { type: 'contextCompaction', id: 'confirmed' };
    activities.compactionStarted(confirmed, 'auto-turn', 10_000);
    activities.compactionCompleted(confirmed, 'auto-turn');
    activities.noteContext(40);
    const successful = written.at(-1)!;
    activities.ledger.apply({ ...successful, detail: 'Persisted compaction summary' });
    const writes = written.length;
    activities.noteTurn({ id: 'auto-turn', status: 'failed', items: [confirmed] }, true, true);
    activities.turnCompleted('auto-turn', 'failed');
    expect(written).toHaveLength(writes);
    expect(written.at(-1)).toMatchObject({ status: 'completed', detail: 'Persisted compaction summary', compaction: { trigger: 'auto', preTokens: 100, postTokens: 40 } });
    const recorded: RpcItem = { type: 'contextCompaction', id: 'recorded', completedAtMs: 12_000 };
    activities.noteTurn({ id: 'recorded-turn', status: 'inProgress', items: [recorded] }, false, true);
    activities.turnCompleted('recorded-turn', 'interrupted');
    expect(written.at(-1)).toMatchObject({ id: 'codex:compaction:recorded', status: 'completed' });
    for (const provisional of ['unknown', 'stopped'] as const) {
      const pending: RpcItem = { type: 'contextCompaction', id: `pending-${provisional}` };
      activities.compactionStarted(pending, pending.id!, 10_000);
      activities.noteTurn({ id: pending.id!, status: provisional === 'stopped' ? 'interrupted' : 'inProgress', completedAt: 20, items: [pending, answer('later', 'Output')] }, provisional === 'stopped', true);
      const notification = { item: pending, threadId: 'thread-1', turnId: pending.id!, completedAtMs: 30_000 };
      activities.compactionCompleted(notification.item, notification.turnId, notification.completedAtMs);
      expect(written.at(-1)).toMatchObject({ status: 'completed', endedAt: new Date(30_000).toISOString(), durationMs: 20_000 });
    }
    activities.dispose();
  });

  it.each(['failed', 'interrupted'])('preserves confirmed successful compaction details across writer restart and %s history', async status => {
    const fixture = codexFixture();
    const { native } = fixture;
    const item: RpcItem = { type: 'contextCompaction', id: 'confirmed-restart' };
    native.threads.set(native.current, [turn('t1', 10, [user('u1', 'Work'), item], 'inProgress')]);
    const journal = new Journal(new DatabaseSync(':memory:'));
    const writer = JournalLaneWriter.open(journal, 's');
    const source = fixture.source();
    const stop = source.watch!(writer, () => undefined);
    const activities = new CodexActivities({
      flavor: codexFlavor, sessionId: 's', threadId: () => native.current, transport: () => undefined,
      journal: () => journal, contextUsed: () => 100, rolloutFile: async () => undefined,
      write: activity => { for (const feed of native.feeds) feed.activity(activity); }, hasListeners: () => false,
    });
    const signal = new AbortController().signal;
    try {
      await pullLane(source, writer, signal);
      activities.noteUserMessage('t1');
      activities.compactionStarted(item, 't1', 10_000);
      activities.compactionCompleted(item, 't1');
      activities.noteContext(40);
      const confirmed = activities.ledger.get('codex:compaction:confirmed-restart')!;
      activities.ledger.apply({ ...confirmed, detail: 'Persisted successful summary', blobRef: 'summary-blob' });
      await pullLane(source, writer, signal);
      const saved = journal.entity('s', confirmed.id)!;
      stop();
      native.turns()[0] = turn('t1', 10, [user('u1', 'Work'), item], status);
      const reopened = JournalLaneWriter.open(journal, 's');
      await pullLane(fixture.source(), reopened, signal);
      expect(journal.entity('s', confirmed.id)?.payload).toEqual(saved.payload);
      expect(reopened.activities.get(confirmed.id)).toMatchObject({ status: 'completed', detail: 'Persisted successful summary', blobRef: 'summary-blob', compaction: { preTokens: 100, postTokens: 40 } });
      // The runtime tracker must take up the same persisted evidence before another history read.
      const restarted = new CodexActivities({
        flavor: codexFlavor, sessionId: 's', threadId: () => native.current, transport: () => undefined,
        journal: () => journal, contextUsed: () => undefined, rolloutFile: async () => undefined,
        write: () => undefined, hasListeners: () => false,
      });
      restarted.noteTurn(native.turns()[0]!, true, true);
      expect(restarted.presented(item, native.turns()[0]!, true)).toEqual(reopened.activities.get(confirmed.id));
      restarted.dispose();
    } finally { stop(); activities.dispose(); }
  });

  it.each([10, null])('replays unchanged unfinished unknown compaction history idempotently across writer restarts (start %s)', async startedAt => {
    const fixture = codexFixture();
    const item: RpcItem = { type: 'contextCompaction', id: 'unfinished' };
    fixture.native.threads.set('thread-1', [{ ...turn('t1', 10, [user('u1', 'Work'), item, answer('a1', 'Later output')], 'inProgress'), startedAt }]);
    const journal = new Journal(new DatabaseSync(':memory:'));
    const signal = new AbortController().signal;
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(100_000);
      await pullLane(fixture.source(), JournalLaneWriter.open(journal, 's'), signal);
      const saved = journal.entity('s', 'codex:compaction:unfinished')!;
      expect(saved.payload).toMatchObject({ data: { activity: { status: 'unknown', endedAt: new Date(100_000).toISOString() } } });
      const savedActivity = (saved.payload as NativeWorkbenchEvent).data.activity as NativeActivity;
      expect(savedActivity.startedAt).toBe(startedAt === null ? undefined : new Date(10_000).toISOString());
      expect(savedActivity.durationMs).toBe(startedAt === null ? undefined : 90_000);
      const lastSeq = journal.head('s').lastSeq;
      for (const time of [200_000, 300_000]) {
        vi.setSystemTime(time);
        await pullLane(fixture.source(), JournalLaneWriter.open(journal, 's'), signal);
        expect(journal.entity('s', saved.nativeId)?.payload).toEqual(saved.payload);
        expect(journal.head('s').lastSeq).toBe(lastSeq);
      }
      // A reconnect can read a current running snapshot without replaying item/started.
      const current: RpcTurn = { id: 't1', status: 'inProgress', startedAt, items: [item] };
      fixture.native.turns()[0] = current;
      const restarted = new CodexActivities({
        flavor: codexFlavor, sessionId: 's', threadId: () => 'thread-1', transport: () => undefined,
        journal: () => journal, contextUsed: () => undefined, rolloutFile: async () => undefined,
        write: () => undefined, hasListeners: () => false,
      });
      try {
        restarted.noteTurn(current, false, true);
        const recovered = restarted.ledger.get(saved.nativeId)!;
        expect(recovered.status).toBe('running');
        expect(recovered.endedAt).toBeUndefined();
        expect(recovered.durationMs).toBeUndefined();
        expect(restarted.ledger.live()).toContainEqual(recovered);
        const reopened = JournalLaneWriter.open(journal, 's');
        await pullLane(fixture.source(), reopened, signal);
        expect(reopened.activities.get(saved.nativeId)).toEqual(recovered);
      } finally { restarted.dispose(); }
    } finally { vi.useRealTimers(); }
  });

  it.each(['failed', 'completed'])('corrects interrupted compaction history to %s with a matching duration', async status => {
    const fixture = codexFixture();
    const item: RpcItem = { type: 'contextCompaction', id: 'corrected' };
    fixture.native.threads.set('thread-1', [{ ...turn('t1', 10, [item], 'interrupted'), completedAt: 20 }]);
    const journal = new Journal(new DatabaseSync(':memory:'));
    const writer = JournalLaneWriter.open(journal, 's');
    const signal = new AbortController().signal;
    await pullLane(fixture.source(), writer, signal);
    expect(writer.activities.get('codex:compaction:corrected')).toMatchObject({ status: 'stopped', durationMs: 10_000 });
    fixture.native.turns()[0] = { ...turn('t1', 10, [item], status), completedAt: 30 };
    await pullLane(fixture.source(), writer, signal);
    expect(writer.activities.get('codex:compaction:corrected')).toMatchObject({ status, endedAt: new Date(30_000).toISOString(), durationMs: 20_000 });
    const lastSeq = journal.head('s').lastSeq;
    await pullLane(fixture.source(), JournalLaneWriter.open(journal, 's'), signal);
    expect(journal.head('s').lastSeq).toBe(lastSeq);
  });

  it.each([true, false])('serves pending live history only with a confirmed empty baseline (%s), then recovers without duplicates', async baseline => {
    const fixture = codexFixture();
    const { native } = fixture;
    native.threads.delete(native.current);
    const reader = Object.assign(native, { hasEmptyHistoryBaseline: (threadId: string) => baseline && threadId === native.current });
    const turnsPage = reader.turnsPage.bind(reader);
    let notified = false;
    reader.turnsPage = async request => {
      const page = await turnsPage(request);
      if (!page && request.threadId === native.current && !notified) {
        notified = true;
        native.notify('turn/started', { turn: { id: 't1', startedAt: 10 } });
        native.notify('item/completed', { turnId: 't1', item: user('u-1', 'Hello') });
        native.notify('item/agentMessage/delta', { turnId: 't1', itemId: 'a-1', delta: 'Hi' });
      }
      return page;
    };
    const journal = new Journal(new DatabaseSync(':memory:'));
    const writer = JournalLaneWriter.open(journal, 's');
    const source = fixture.source();
    const stop = source.watch!(writer, () => undefined);
    const signal = new AbortController().signal;
    try {
      await pullLane(source, writer, signal);
      const draft = journal.entity('s', 'thread-1:t1:a-1:assistant');
      if (baseline) {
        expect(JSON.parse(writer.cursor!)).toMatchObject({ phase: 'ready', open: 't1', turns: 0 });
        expect(journal.entity('s', 'thread-1:t1:u-1:user')).toBeDefined();
        expect(draft?.kind).toBe('draft');
      } else {
        expect(writer.cursor).toBeNull();
        expect(rowsOf(journal, 's')).toHaveLength(0);
      }
      const reads = native.requests.length;
      const pendingSeq = journal.head('s').lastSeq;
      for (const delta of [' there', ', still', ' streaming']) {
        native.notify('item/agentMessage/delta', { turnId: 't1', itemId: 'a-1', delta });
        await pullLane(source, writer, signal);
      }
      if (baseline) {
        expect(native.requests.length).toBe(reads);
        expect(journal.entity('s', 'thread-1:t1:a-1:assistant')?.payload).toMatchObject({ data: { content: { text: 'Hi there, still streaming' } } });
        expect(journal.head('s').lastSeq).toBeGreaterThan(pendingSeq);
      } else {
        expect(writer.cursor).toBeNull();
        expect(journal.head('s').lastSeq).toBe(pendingSeq);
      }
      // A completion may also precede its disk flush. Further deltas still use the live feed.
      native.notify('turn/completed', { turn: { id: 't1', status: 'completed', items: [] } });
      await pullLane(source, writer, signal);
      const completionReads = native.requests.length;
      native.notify('item/agentMessage/delta', { turnId: 't1', itemId: 'a-1', delta: '.' });
      await pullLane(source, writer, signal);
      if (baseline) {
        expect(completionReads).toBeGreaterThan(reads);
        expect(native.requests.length).toBe(completionReads);
        expect(journal.entity('s', 'thread-1:t1:a-1:assistant')?.payload).toMatchObject({ data: { content: { text: 'Hi there, still streaming.' } } });
      }

      native.threads.set(native.current, [turn('t1', 10, [user('u-1', 'Hello'), answer('a-1', 'Hi, recovered')])]);
      native.notify('turn/completed', { turn: { id: 't1', status: 'completed', items: [] } });
      await pullLane(source, writer, signal);
      expect(writer.turnEndStatus('t1')).toBe('completed');
      expect(journal.entity('s', 'thread-1:t1:a-1:assistant')?.payload).toMatchObject({ data: { content: { text: 'Hi, recovered' } } });
      if (draft) expect(journal.entity('s', 'thread-1:t1:a-1:assistant')?.identity).toBe(draft.identity);
      const rows = rowsOf(journal, 's');
      expect(rows.filter(row => row.nativeId === 'thread-1:t1:u-1:user')).toHaveLength(1);
      expect(rows.filter(row => row.nativeId === 'thread-1:t1:a-1:assistant' && row.kind === 'agent_message_chunk')).toHaveLength(1);
      const recoveredSeq = journal.head('s').lastSeq;
      await pullLane(source, writer, signal);
      expect(journal.head('s').lastSeq).toBe(recoveredSeq);
      checkSession(journal, 's');
    } finally { stop(); }
  });

  it('holds the write contract: a tail window first, item ids, turn marks, subagent lanes and ledger activities', async () => {
    const report = await runIngestContract(codexFixture(), { openLastTurn: true });
    expect(report.served.map(item => item.scratch)).toEqual([true, false]);
    // The subagent lanes of the conversation that followed the first thread went with it (G8).
    expect(Object.keys(report.lanes)).toEqual(['main']);
  });

  it('writes streamed text as drafts, commits the item under the same id, and ends the turn only after its settled copy', async () => {
    const fixture = codexFixture();
    const { native } = fixture;
    native.threads.set('thread-1', [turn('t1', 10, [user('u-1', 'Hello'), answer('a-1', 'Hi')])]);
    const journal = new Journal(new DatabaseSync(':memory:'));
    const writer = JournalLaneWriter.open(journal, 's');
    const source = fixture.source();
    let wakes = 0;
    const unwatch = source.watch!(writer, () => { wakes += 1; });
    const signal = new AbortController().signal;
    await pullLane(source, writer, signal);
    const reads = () => native.requests.filter(request => request.sortDirection === 'desc').length;
    // A turn typed into the attached TUI: the feed carries it while it runs, without a read of the thread.
    native.notify('turn/started', { turn: { id: 't2', startedAt: 20 } });
    // The history API can report an interrupted, empty turn before its first user item lands.
    // Execution evidence must keep that turn open; otherwise the cursor loses all later output.
    native.turns().push(turn('t2', 20, [], 'interrupted'));
    await source.drain(writer);
    expect(writer.turnEndStatus('t2')).toBeUndefined();
    expect(JSON.parse(writer.cursor!)).toMatchObject({ settled: 't1', open: 't2' });
    const readsBefore = reads();
    native.notify('item/completed', { turnId: 't2', item: user('u-2', 'Explain') });
    native.notify('item/agentMessage/delta', { turnId: 't2', itemId: 'a-2', delta: 'Becau' });
    await pullLane(source, writer, signal);
    expect(reads()).toBe(readsBefore);
    const draft = journal.entity('s', 'thread-1:t2:a-2:assistant');
    expect(draft).toMatchObject({ kind: 'draft', turnId: 't2' });
    native.turns()[1] = turn('t2', 20, [user('u-2', 'Explain'), answer('a-2', 'Because.')]);
    native.notify('item/completed', { turnId: 't2', item: answer('a-2', 'Because.') });
    native.notify('turn/completed', { turn: { id: 't2', status: 'completed', items: [] } });
    await pullLane(source, writer, signal);
    unwatch();
    expect(wakes).toBeGreaterThan(0);
    expect(journal.entity('s', 'thread-1:t2:a-2:assistant')).toMatchObject({ kind: 'agent_message_chunk', identity: draft!.identity });
    const rows = rowsOf(journal, 's');
    const end = rows.findIndex(row => row.kind === 'meta.turn_ended' && row.turnId === 't2');
    expect(end).toBeGreaterThan(rows.findIndex(row => row.nativeId === 'thread-1:t2:a-2:assistant' && row.kind === 'agent_message_chunk'));

    // The app-server dies mid-turn: no turn/completed follows, so its start no longer outranks history.
    const restop = source.watch!(writer, () => undefined);
    native.notify('turn/started', { turn: { id: 't3', startedAt: 30 } });
    native.turns().push(turn('t3', 30, [user('u-3', 'More')], 'interrupted'));
    await source.drain(writer);
    expect(writer.turnEndStatus('t3')).toBeUndefined();
    for (const feed of native.feeds) feed.lost?.();
    await source.drain(writer);
    restop();
    expect(writer.turnEndStatus('t3')).toBe('interrupted');
    checkSession(journal, 's');
  });

  it('goes on in the next thread after a new topic, keeps the earlier rows, and reads the threads again in order', async () => {
    const native = new FakeThreads();
    native.threads.set('thread-1', [turn('t1', 10, [user('u-1', 'Remember PLUM'), answer('a-1', 'OK')])]);
    const earlier: string[] = [];
    const source = () => new CodexTranscriptSource({ sessionId: 's', backend: 'codex', threadId: () => native.current,
      earlierThreads: () => earlier,
      topicAfter: threadId => threadId === 'thread-1' ? { commandId: 'cmd-new', runId: 'run-new', text: '/new', at: new Date(15_000).toISOString() } : undefined,
      reader: async () => native, commandOf: () => undefined, runOf: () => undefined,
      observe: feed => { native.feeds.add(feed); return () => { native.feeds.delete(feed); }; },
    });
    const journal = new Journal(new DatabaseSync(':memory:'));
    const writer = JournalLaneWriter.open(journal, 's');
    const signal = new AbortController().signal;
    const users = () => [...new Set(rowsOf(journal, 's').filter(row => row.kind === 'user_message_chunk').map(row => row.nativeId))];
    const live = source();
    const unwatch = live.watch!(writer, () => undefined);
    await pullLane(live, writer, signal);
    // The conversation moves to thread-2, whose first turn is heard on the feed before any read of it.
    earlier.push('thread-1');
    native.current = 'thread-2';
    native.notify('turn/started', { turn: { id: 'n1', startedAt: 20 } });
    native.notify('item/completed', { turnId: 'n1', item: user('u-n1', 'Which word?') });
    native.turns().push(turn('n1', 20, [user('u-n1', 'Which word?'), answer('a-n1', 'UNKNOWN')]));
    native.notify('turn/completed', { turn: { id: 'n1', status: 'completed', items: [] } });
    await pullLane(live, writer, signal);
    unwatch();
    const expected = ['thread-1:t1:u-1:user', 'thread-1:topic:web:cmd-new:user', 'thread-2:n1:u-n1:user'];
    expect(users()).toEqual(expected);
    expect(writer.turnEndStatus('n1')).toBe('completed');
    expect(writer.identity).toBe('thread-1');
    checkSession(journal, 's');

    // Read again from scratch: the earlier thread first, then the message that ended it, then the current one.
    writer.rebuild('identity-changed');
    const fresh = source();
    for (let pulls = 0; pulls < 10 && !(await pullLane(fresh, writer, signal)).caughtUp; pulls += 1) { /* a bounded import step per pull */ }
    expect(users()).toEqual(expected);
    expect(writer.turnEndStatus('t1')).toBe('completed');
    expect(writer.turnEndStatus('n1')).toBe('completed');
    checkSession(journal, 's');
  });

  // Recovery guarantee: a persisted erroneous end must converge without changing identity or
  // replaying execution. Existing streaming coverage only starts with an unpoisoned cursor.
  it('reconciles a persisted interrupted boundary, streams again and survives another reader restart', async () => {
    const fixture = codexFixture();
    const { native } = fixture;
    const compact: RpcItem = { type: 'contextCompaction', id: 'recovered-compaction' };
    native.threads.set('thread-1', [turn('t1', 10, [user('u-1', 'Hello'), answer('a-1', 'Hi')]), turn('t2', 20, [compact], 'interrupted')]);
    const journal = new Journal(new DatabaseSync(':memory:'));
    let writer = JournalLaneWriter.open(journal, 's');
    const signal = new AbortController().signal;
    await pullLane(fixture.source(), writer, signal);
    const generation = writer.generation;
    expect(writer.turnEndStatus('t2')).toBe('interrupted');
    expect(writer.activities.get('codex:compaction:recovered-compaction')?.status).toBe('stopped');

    // A restarted source finds new content in the same boundary turn, with no live start notification.
    native.turns()[1] = turn('t2', 20, [compact, user('u-2', 'Explain', { clientId: 'cmd-2' })], 'inProgress');
    const source = fixture.source();
    const stop = source.watch!(writer, () => undefined);
    await pullLane(source, writer, signal);
    expect(writer.turnEndStatus('t2')).toBeUndefined();
    expect(JSON.parse(writer.cursor!)).toMatchObject({ settled: 't1', open: 't2', turns: 1 });
    native.notify('item/agentMessage/delta', { turnId: 't2', itemId: 'a-2', delta: 'Recovered' });
    await pullLane(source, writer, signal);
    expect(journal.entity('s', 'thread-1:t2:a-2:assistant')?.kind).toBe('draft');
    stop();

    native.turns()[1] = { ...turn('t2', 20, [compact, user('u-2', 'Explain', { clientId: 'cmd-2' }), answer('a-2', 'Recovered answer')]), completedAt: 30 };
    writer = JournalLaneWriter.open(journal, 's');
    await pullLane(fixture.source(), writer, signal);
    expect(writer.turnEndStatus('t2')).toBe('completed');
    expect(writer.activities.get('codex:compaction:recovered-compaction')).toMatchObject({ status: 'completed', endedAt: new Date(30_000).toISOString() });
    expect(journal.entity('s', 'thread-1:t2:a-2:assistant')?.payload).toMatchObject({ data: { content: { text: 'Recovered answer' } } });
    expect(writer.generation).toBe(generation);
    expect(JSON.parse(writer.cursor!)).toMatchObject({ settled: 't2', turns: 2 });
    const lastSeq = journal.head('s').lastSeq;
    await pullLane(fixture.source(), writer, signal);
    expect(journal.head('s').lastSeq).toBe(lastSeq);
    checkSession(journal, 's');
  });

  it('keeps a running subagent in the cursor, so a restarted reader goes on reading its lane', async () => {
    const fixture = codexFixture();
    const { native } = fixture;
    native.threads.set('child-9', [turn('c9-t1', 1, [user('c9-u1', 'Work'), answer('c9-a1', 'Started')], 'inProgress')]);
    native.threads.set('thread-1', [turn('t1', 10, [user('u-1', 'Delegate'), spawn('spawn-9', 'child-9'), answer('a-1', 'Delegated')])]);
    const journal = new Journal(new DatabaseSync(':memory:'));
    const signal = new AbortController().signal;
    await pullLane(fixture.source(), JournalLaneWriter.open(journal, 's'), signal);
    expect(JSON.parse(journal.peek('s')!.ingestCursor!)).toMatchObject({ phase: 'ready', settled: 't1', agents: [['spawn-9', 'child-9']] });
    // The child finishes while nobody reads; the parent's turns do not change.
    native.threads.get('child-9')![0] = turn('c9-t1', 1, [user('c9-u1', 'Work'), answer('c9-a1', 'Finished')]);
    await pullLane(fixture.source(), JournalLaneWriter.open(journal, 's'), signal);
    const child = laneKey('s', 'sub:spawn-9');
    expect(journal.entity(child, 'child-9:c9-t1:c9-a1:assistant')?.payload).toMatchObject({ data: { content: { text: 'Finished' } } });
    expect(JSON.parse(journal.peek('s')!.ingestCursor!).agents).toBeUndefined();
    checkSession(journal, 's');
  });

  it.each(['connected', 'late reader'])('redacts output-only child secret answers using %s native request metadata', async connection => {
    const fixture = codexFixture();
    const { native } = fixture;
    const known = new CodexQuestionHistory();
    const secret = 'native-child-secret-not-collected-on-web';
    const params = { threadId: 'child-secret', turnId: 'child-turn', itemId: 'shared-call',
      questions: [{ id: 'token', header: 'Token', question: '', isSecret: true }] };
    const output = (value: string): RpcItem => ({ type: 'functionCallOutput', id: 'shared-call', name: 'request_user_input',
      output: JSON.stringify({ answers: { token: { answers: [value] } } }) });
    native.threads.set('thread-1', [turn('parent-turn', 10, [spawn('spawn-secret', 'child-secret'), output('public-parent')])]);
    native.threads.set('child-secret', [turn('child-turn', 11, [], 'inProgress')]);
    const reader: CodexThreadReader = { turnsPage: request => native.turnsPage(request), questionRequests: threadId => known.requests(threadId) };
    const source = () => new CodexTranscriptSource({ sessionId: 's', backend: 'codex', threadId: () => native.current,
      reader: async () => reader, commandOf: () => undefined, runOf: () => undefined,
      observe: feed => { native.feeds.add(feed); return () => { native.feeds.delete(feed); }; },
    });
    const journal = new Journal(new DatabaseSync(':memory:'));
    const writer = JournalLaneWriter.open(journal, 's');
    const signal = new AbortController().signal;
    let current = source();
    let stop: (() => void) | undefined;
    if (connection === 'connected') {
      stop = current.watch(writer, () => undefined);
      await pullLane(current, writer, signal);
    }
    // A real native request knows isSecret, but no workbench candidate/answer is ever supplied.
    known.request(params);
    if (connection === 'connected') native.notify('item/tool/requestUserInput', params);
    // Older metadata must never downgrade a secret identity.
    known.request({ ...params, questions: [{ id: 'token', question: 'Older copy' }] });
    native.threads.set('child-secret', [turn('child-turn', 11, [output(secret)])]);
    await pullLane(current, writer, signal);
    stop?.();
    const childLane = laneKey('s', 'sub:spawn-secret');
    const child = journal.entity(childLane, 'child-secret:child-turn:shared-call:call');
    expect(child?.payload).toMatchObject({ data: { status: 'completed', content: [{ answers: ['[REDACTED]'] }] } });
    expect(JSON.stringify(rowsOf(journal, childLane))).not.toContain(secret);
    expect(journal.entity('s', 'thread-1:parent-turn:shared-call:call')?.payload).toMatchObject({ data: { content: [{ answers: ['public-parent'] }] } });
    // A new source has no live feed history. Native metadata replay still protects its first child read.
    const freshJournal = new Journal(new DatabaseSync(':memory:'));
    current = source();
    await pullLane(current, JournalLaneWriter.open(freshJournal, 's'), signal);
    expect(JSON.stringify(rowsOf(freshJournal, childLane))).not.toContain(secret);
    expect(freshJournal.entity(childLane, 'child-secret:child-turn:shared-call:call')?.payload).toMatchObject({ data: { content: [{ answers: ['[REDACTED]'] }] } });
    checkSession(journal, 's');
    checkSession(freshJournal, 's');
  });

  it('writes one child lane for the two TRAE spawn announcements and keeps the spawn metadata', async () => {
    const fixture = codexFixture();
    const { native } = fixture;
    native.threads.set('thread-1', [turn('t1', 10, [
      { ...spawn('spawn-1', 'child-1'), model: 'child-model', agentRole: 'explorer' },
      { type: 'subAgentActivity', id: 'subagent-activity:spawn-1', kind: 'started', agentThreadId: 'child-1', agentPath: '/root/review' },
    ])]);
    const journal = new Journal(new DatabaseSync(':memory:'));
    const writer = JournalLaneWriter.open(journal, 's');
    await pullLane(fixture.source(), writer, new AbortController().signal);
    expect(writer.subagents).toEqual([{ toolCallId: 'spawn-1', agentId: 'child-1', title: 'Look into child-1', model: 'child-model', subagentType: 'explorer' }]);
    expect(rowsOf(journal, 's').filter(row => row.kind === 'tool_call')).toHaveLength(1);
    expect(journal.keysOf('s')).toEqual(['s', laneKey('s', 'sub:spawn-1')]);
    checkSession(journal, 's');
  });

  it('uses a finished child transcript after restart until the parent names new work for it', async () => {
    const fixture = codexFixture();
    const { native } = fixture;
    native.threads.set('thread-1', [turn('t1', 10, [spawn('spawn-1', 'child-1')])]);
    native.turns('child-1')[0]!.items!.push(spawn('nested-1', 'grandchild'));
    native.threads.set('grandchild', [turn('g1', 1, [answer('g-a', 'Working')], 'inProgress')]);
    const journal = new Journal(new DatabaseSync(':memory:'));
    const signal = new AbortController().signal;
    await pullLane(fixture.source(), JournalLaneWriter.open(journal, 's'), signal);
    native.requests.length = 0;
    const restarted = fixture.source();
    const writer = JournalLaneWriter.open(journal, 's');
    await pullLane(restarted, writer, signal);
    expect(native.requests.some(request => request.threadId === 'child-1')).toBe(false);
    const childKey = laneKey('s', 'sub:spawn-1');
    expect(journal.entity(childKey, 'child-1:c1-t1:c1-a1:assistant')?.kind).toBe('agent_message_chunk');
    // The parent finished, but its background child still streams through a restarted reader.
    native.turns('grandchild')[0]!.items = [answer('g-a', 'Still working')];
    await pullLane(restarted, writer, signal);
    expect(journal.entity(laneKey('s', 'sub:nested-1'), 'grandchild:g1:g-a:assistant')?.payload).toMatchObject({ data: { content: { text: 'Still working' } } });

    native.turns().push(turn('t2', 20, [{ type: 'collabAgentToolCall', id: 'follow-1', tool: 'followupTask', receiverThreadIds: ['child-1'], status: 'completed' }]));
    native.turns('child-1').push(turn('c1-t2', 30, [answer('c1-a2', 'New work')], 'inProgress'));
    await pullLane(restarted, writer, signal);
    expect(native.requests.some(request => request.threadId === 'child-1')).toBe(true);
    expect(journal.entity(childKey, 'child-1:c1-t2:c1-a2:assistant')?.payload).toMatchObject({ data: { content: { text: 'New work' } } });
    checkSession(journal, 's', { openLastTurn: true });
  });

  it('repairs stored duplicate children and follows a finished child again after restart without replacing history', async () => {
    const fixture = codexFixture();
    const { native } = fixture;
    native.threads.set('thread-1', [turn('t1', 10, [spawn('spawn-9', 'child-1')], 'inProgress')]);
    const journal = new Journal(new DatabaseSync(':memory:'));
    let writer = JournalLaneWriter.open(journal, 's');
    const signal = new AbortController().signal;
    await pullLane(fixture.source(), writer, signal);
    const generation = writer.generation;
    const alias = 'subagent-activity:spawn-9';
    const childKey = laneKey('s', 'sub:spawn-9');
    const aliasKey = laneKey('s', `sub:${alias}`);
    // An older reader wrote the same child twice, before the parent turn was ended.
    writer.child(alias, 'child-1');
    writer.commit({ events: journal.toolEntities('s', 'spawn-9').map(row => {
      const event = row.payload as NativeWorkbenchEvent;
      return { ...event, sessionId: 's', sequence: 0, nativeId: row.nativeId.replace(':spawn-9:', `:${alias}:`), data: { ...event.data, toolCallId: alias } };
    }), cursor: writer.cursor });
    const copied = rowsOf(journal, childKey).map(row => row.kind.startsWith('meta.')
      ? { kind: row.kind, nativeId: row.nativeId, turnId: row.turnId, at: row.at, payload: row.payload }
      : eventInput({ ...(row.payload as NativeWorkbenchEvent), sessionId: 's', sequence: 0 }));
    journal.append(aliasKey, copied, { cursor: journal.peek(childKey)!.ingestCursor });
    writer.turnEnded('t1', 'completed', new Date(11_000).toISOString());
    writer.commit({ events: [], cursor: JSON.stringify({ v: 1, threadId: 'thread-1', phase: 'ready', settled: 't1', turns: 1 }) });
    const original = journal.entity(childKey, 'child-1:c1-t1:c1-a1:assistant')!;
    native.threads.set('thread-1', [turn('t1', 10, [spawn('spawn-9', 'child-1')]), turn('t2', 20, [
      { type: 'collabAgentToolCall', id: 'followup-1', tool: 'sendInput', receiverThreadIds: ['child-1'], status: 'completed', agentsStates: { 'child-1': { status: 'running' } } },
    ])]);
    native.turns('child-1').push(turn('c1-t2', 30, [user('c1-u2', 'Continue'), answer('c1-a2', 'Continuing')], 'inProgress'));
    writer = JournalLaneWriter.open(journal, 's');
    await pullLane(fixture.source(), writer, signal);
    expect(writer.subagents.map(binding => [binding.toolCallId, binding.agentId])).toEqual([['spawn-9', 'child-1']]);
    expect(journal.entity('s', `meta:subagent:${alias}`)?.kind).toBe('tombstone');
    expect(journal.toolEntities('s', alias)).toEqual([]);
    expect(journal.peek(aliasKey)).toBeUndefined();
    expect(journal.entity(childKey, original.nativeId)).toMatchObject({ identity: original.identity, digest: original.digest });
    expect(journal.entity(childKey, 'child-1:c1-t2:c1-a2:assistant')?.payload).toMatchObject({ data: { content: { text: 'Continuing' } } });
    expect(writer.generation).toBe(generation);
    expect(JSON.parse(writer.cursor!).agents).toEqual([['spawn-9', 'child-1']]);
    const lastSeq = journal.head('s').lastSeq;
    await pullLane(fixture.source(), JournalLaneWriter.open(journal, 's'), signal);
    expect(journal.head('s').lastSeq).toBe(lastSeq);
    checkSession(journal, 's', { openLastTurn: true });
  });

  it('reconciles a live Trae message before a lagging positional history copy, including after restart', async () => {
    const fixture = codexFixture();
    const { native } = fixture;
    native.threads.set('thread-1', []);
    const journal = new Journal(new DatabaseSync(':memory:'));
    let writer = JournalLaneWriter.open(journal, 's');
    const signal = new AbortController().signal;
    let source = fixture.source();
    const stop = source.watch!(writer, () => undefined);
    await pullLane(source, writer, signal);
    native.notify('item/completed', { turnId: 't1', item: answer('msg_1', 'Same answer') });
    await pullLane(source, writer, signal);
    stop();

    // Only history is available after restart; its running-turn ids lag behind the live feed.
    native.turns().push(turn('t1', 10, [answer('item-1', 'Same answer'), answer('item-2', 'Same answer')], 'inProgress'));
    source = fixture.source();
    writer = JournalLaneWriter.open(journal, 's');
    await pullLane(source, writer, signal);
    expect(journal.entity('s', 'thread-1:t1:item-1:assistant')).toBeUndefined();
    expect(journal.entity('s', 'thread-1:t1:item-2:assistant')?.kind).toBe('agent_message_chunk');
    expect(journal.entity('s', 'thread-1:t1:msg_1:assistant')?.kind).toBe('agent_message_chunk');
    const lastSeq = journal.head('s').lastSeq;
    await pullLane(source, writer, signal);
    expect(journal.head('s').lastSeq).toBe(lastSeq);
    checkSession(journal, 's', { openLastTurn: true });
  });

  it('retires persisted Trae positional rows when their lasting copies arrive after restart', async () => {
    const fixture = codexFixture();
    const { native } = fixture;
    native.threads.set('thread-1', [turn('t1', 10, [answer('item-1', 'Same answer'), command('item-2', 'files'), answer('item-3', 'Same answer')], 'inProgress')]);
    const journal = new Journal(new DatabaseSync(':memory:'));
    const signal = new AbortController().signal;
    await pullLane(fixture.source(), JournalLaneWriter.open(journal, 's'), signal);
    expect(journal.entity('s', 'thread-1:t1:item-1:assistant')?.kind).toBe('agent_message_chunk');

    const writer = JournalLaneWriter.open(journal, 's');
    const source = fixture.source();
    const stop = source.watch!(writer, () => undefined);
    await pullLane(source, writer, signal);
    native.notify('item/completed', { turnId: 't1', item: answer('msg_1', 'Same answer') });
    await pullLane(source, writer, signal);
    expect(journal.entity('s', 'thread-1:t1:item-1:assistant')?.kind).toBe('tombstone');
    expect(journal.entity('s', 'thread-1:t1:item-3:assistant')?.kind).toBe('agent_message_chunk');
    expect(journal.entity('s', 'thread-1:t1:msg_1:assistant')?.kind).toBe('agent_message_chunk');
    stop();

    // Replaying the first permanent message after another restart must not consume the second
    // identical provisional message, which has not acquired its own permanent id yet.
    const replayWriter = JournalLaneWriter.open(journal, 's');
    const replaySource = fixture.source();
    const stopReplay = replaySource.watch!(replayWriter, () => undefined);
    await pullLane(replaySource, replayWriter, signal);
    native.notify('item/completed', { turnId: 't1', item: answer('msg_1', 'Same answer') });
    await pullLane(replaySource, replayWriter, signal);
    expect(journal.entity('s', 'thread-1:t1:item-3:assistant')?.kind).toBe('agent_message_chunk');
    stopReplay();

    // Tool rows wait for lasting ids; their command text cannot identify aliases safely.
    native.turns()[0] = turn('t1', 10, [answer('msg_1', 'Same answer'), command('fc_1', 'files'), answer('msg_2', 'Same answer')]);
    await pullLane(fixture.source(), JournalLaneWriter.open(journal, 's'), signal);
    for (const part of ['call', 'result']) expect(journal.entity('s', `thread-1:t1:item-2:${part}`)).toBeUndefined();
    expect(journal.entity('s', 'thread-1:t1:item-3:assistant')?.kind).toBe('tombstone');
    // Two lasting messages with the same words are legitimate separate messages.
    expect(journal.entity('s', 'thread-1:t1:msg_2:assistant')?.kind).toBe('agent_message_chunk');
    const lastSeq = journal.head('s').lastSeq;
    await pullLane(fixture.source(), JournalLaneWriter.open(journal, 's'), signal);
    expect(journal.head('s').lastSeq).toBe(lastSeq);
    checkSession(journal, 's');
  });

  it.each(['interrupted', 'failed', 'completed'])('keeps %s positional identities until lasting history arrives after restart', async status => {
    const fixture = codexFixture();
    const { native } = fixture;
    native.threads.set('thread-1', [turn('t1', 10, [answer('item-1', 'Same answer'), command('item-2', 'files')], status)]);
    const journal = new Journal(new DatabaseSync(':memory:'));
    const signal = new AbortController().signal;
    await pullLane(fixture.source(), JournalLaneWriter.open(journal, 's'), signal);
    expect(journal.entity('s', 'thread-1:t1:item-1:assistant')?.kind).toBe('agent_message_chunk');
    expect(JSON.parse(journal.peek('s')!.ingestCursor!)).toMatchObject({ open: 't1', copies: [{ turnId: 't1' }] });

    // Even a newer durable turn cannot move the history boundary past unresolved aliases.
    native.turns().push(turn('t2', 20, [answer('msg_2', 'Next answer')]));
    await pullLane(fixture.source(), JournalLaneWriter.open(journal, 's'), signal);
    native.turns()[0] = turn('t1', 10, [answer('msg_1', 'Same answer'), command('fc_1', 'files')], status);
    // Resolving t1 after t2 was already persisted rebuilds so t1's lasting rows stay before t2.
    const recovery = fixture.source();
    const recoveryWriter = JournalLaneWriter.open(journal, 's');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if ((await pullLane(recovery, recoveryWriter, signal)).caughtUp) break;
    }
    expect(journal.entity('s', 'thread-1:t1:item-1:assistant')).toBeUndefined();
    for (const part of ['call', 'result']) expect(journal.entity('s', `thread-1:t1:item-2:${part}`)).toBeUndefined();
    expect(journal.entity('s', 'thread-1:t1:msg_1:assistant')?.kind).toBe('agent_message_chunk');
    const orderedIds = rowsOf(journal, 's').map(row => row.nativeId);
    expect(orderedIds.indexOf('thread-1:t1:msg_1:assistant')).toBeLessThan(orderedIds.indexOf('thread-1:t2:msg_2:assistant'));
    expect(orderedIds.indexOf('thread-1:t1:fc_1:call')).toBeLessThan(orderedIds.indexOf('thread-1:t2:msg_2:assistant'));
    expect(JSON.parse(journal.peek('s')!.ingestCursor!)).toMatchObject({ settled: 't2' });
    expect(JSON.parse(journal.peek('s')!.ingestCursor!).copies).toBeUndefined();
    const lastSeq = journal.head('s').lastSeq;
    await pullLane(fixture.source(), JournalLaneWriter.open(journal, 's'), signal);
    expect(journal.head('s').lastSeq).toBe(lastSeq);
    checkSession(journal, 's');
  });

  it.each(['history', 'live'])('does not insert a positional row retired by the same %s batch', async input => {
    const fixture = codexFixture();
    const { native } = fixture;
    native.threads.set('thread-1', []);
    const journal = new Journal(new DatabaseSync(':memory:'));
    const writer = JournalLaneWriter.open(journal, 's');
    const signal = new AbortController().signal;
    const source = fixture.source();
    const stop = input === 'live' ? source.watch!(writer, () => undefined) : () => undefined;
    await pullLane(source, writer, signal);
    const items = [answer('item-1', 'Same answer'), answer('msg_1', 'Same answer')];
    native.turns().push(turn('t1', 10, items, 'inProgress'));
    if (input === 'live') for (const item of items) native.notify('item/completed', { turnId: 't1', item });
    await pullLane(source, writer, signal);
    stop();
    expect(journal.entity('s', 'thread-1:t1:item-1:assistant')).toBeUndefined();
    expect(journal.entity('s', 'thread-1:t1:msg_1:assistant')?.kind).toBe('agent_message_chunk');
    const lastSeq = journal.head('s').lastSeq;
    await pullLane(fixture.source(), JournalLaneWriter.open(journal, 's'), signal);
    expect(journal.head('s').lastSeq).toBe(lastSeq);
    checkSession(journal, 's', { openLastTurn: true });
  });

  it('keeps a positional history boundary across import pages until a restart reads lasting ids', async () => {
    const fixture = codexFixture();
    const { native } = fixture;
    native.threads.set('thread-1', Array.from({ length: 30 }, (_, index) => turn(`t${index}`, index + 10, [answer(index === 0 ? 'item-1' : `msg_${index}`, `Answer ${index}`)])));
    const journal = new Journal(new DatabaseSync(':memory:'));
    const signal = new AbortController().signal;
    const source = fixture.source();
    const writer = JournalLaneWriter.open(journal, 's');
    await pullLane(source, writer, signal);
    // The completed first turn has not materialized; later pages may be served without
    // claiming that all preceding turns have their lasting identities.
    await pullLane(source, writer, signal);
    expect(JSON.parse(writer.cursor!)).toMatchObject({ open: 't0' });
    expect(JSON.parse(writer.cursor!).settled).toBeUndefined();
    native.turns()[0] = turn('t0', 10, [answer('msg_0', 'Answer 0')]);
    const restarted = fixture.source();
    const recovered = JournalLaneWriter.open(journal, 's');
    for (let attempt = 0; attempt < 6 && JSON.parse(recovered.cursor ?? '{}').settled !== 't29'; attempt += 1) await pullLane(restarted, recovered, signal);
    expect(JSON.parse(recovered.cursor!)).toMatchObject({ settled: 't29' });
    expect(journal.entity('s', 'thread-1:t0:item-1:assistant')).toBeUndefined();
    expect(journal.entity('s', 'thread-1:t0:msg_0:assistant')?.kind).toBe('agent_message_chunk');
    const orderedIds = rowsOf(journal, 's').map(row => row.nativeId);
    expect(orderedIds.indexOf('thread-1:t0:msg_0:assistant')).toBeLessThan(orderedIds.indexOf('thread-1:t1:msg_1:assistant'));
    checkSession(journal, 's');
  });

  it.each([
    spawn('item-3', 'child-1'),
    { type: 'subAgentActivity', id: 'subagent-activity:item-3', kind: 'started', agentThreadId: 'child-1', agentPath: '/root/review' },
  ])('waits for lasting $type identities and retains repeated commands and a single spawned lane', async announcement => {
    const fixture = codexFixture();
    const { native } = fixture;
    native.threads.set('thread-1', [turn('t1', 10, [command('item-1', 'files'), command('item-2', 'files'), announcement], 'inProgress')]);
    const journal = new Journal(new DatabaseSync(':memory:'));
    const signal = new AbortController().signal;
    const writer = JournalLaneWriter.open(journal, 's');
    const source = fixture.source();
    const stop = source.watch!(writer, () => undefined);
    await pullLane(source, writer, signal);
    expect(rowsOf(journal, 's').filter(row => row.kind === 'tool_call')).toHaveLength(0);
    expect(journal.entity(laneKey('s', 'sub:item-3'), 'child-1:c1-t1:c1-a1:assistant')).toBeUndefined();

    const stable = [command('fc_1', 'files'), command('fc_2', 'files'), spawn('ctc_1', 'child-1')];
    for (const item of stable) native.notify('item/completed', { turnId: 't1', item });
    await pullLane(source, writer, signal);
    stop();
    // The lagging history remains positional even after live committed tools arrived.
    await pullLane(fixture.source(), JournalLaneWriter.open(journal, 's'), signal);
    expect(rowsOf(journal, 's').filter(row => row.kind === 'tool_call')).toHaveLength(3);
    for (const id of ['fc_1', 'fc_2', 'ctc_1']) expect(journal.entity('s', `thread-1:t1:${id}:call`)?.kind).toBe('tool_call');
    for (const id of ['item-1', 'item-2', 'item-3']) expect(journal.entity('s', `thread-1:t1:${id}:call`)).toBeUndefined();
    expect(journal.entity(laneKey('s', 'sub:ctc_1'), 'child-1:c1-t1:c1-a1:assistant')?.kind).toBe('agent_message_chunk');
    native.turns()[0] = turn('t1', 10, stable);
    await pullLane(fixture.source(), JournalLaneWriter.open(journal, 's'), signal);
    checkSession(journal, 's');
  });

  it('rebuilds when a provisional item resolves to a lasting id ahead of an already-committed lasting item in the same turn', async () => {
    const fixture = codexFixture();
    const { native } = fixture;
    native.threads.set('thread-1', [turn('t1', 10, [answer('item-1', 'Before tool'), command('fc_1', 'files')], 'inProgress')]);
    const journal = new Journal(new DatabaseSync(':memory:'));
    const signal = new AbortController().signal;
    const writer = JournalLaneWriter.open(journal, 's');
    const source = fixture.source();
    await pullLane(source, writer, signal);
    const gen1 = writer.generation;

    // Resolving item-1 -> msg_1 after fc_1 was already committed would put msg_1 after fc_1 without a rebuild.
    native.turns()[0] = turn('t1', 10, [answer('msg_1', 'Before tool'), command('fc_1', 'files')], 'completed');
    const recovery = fixture.source();
    const recoveryWriter = JournalLaneWriter.open(journal, 's');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if ((await pullLane(recovery, recoveryWriter, signal)).caughtUp) break;
    }
    expect(recoveryWriter.generation).not.toBe(gen1);
    const orderedIds = rowsOf(journal, 's').map(row => row.nativeId);
    expect(orderedIds.indexOf('thread-1:t1:msg_1:assistant')).toBeLessThan(orderedIds.indexOf('thread-1:t1:fc_1:call'));
    checkSession(journal, 's');
  });
});
