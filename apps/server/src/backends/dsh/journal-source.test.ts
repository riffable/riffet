import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { activityOfEvent } from '../../journal/activity.js';
import { JournalLaneWriter, pullLane } from '../../journal/ingest.js';
import { checkSession, rowsOf, runIngestContract, type IngestContractFixture } from '../../journal/ingest-contract.js';
import { Journal } from '../../journal/journal.js';
import { DshTranscriptSource } from './journal-source.js';
import type { DshLog, DshLogReader } from './log-store.js';
import type { DshObserver } from './runtime.js';

/*
 * DSH sessions in the shape its persistence stores them (the records `events.test.ts` and the bridge
 * read): `seq` from 0, one clock tick per record, turns bracketed by `turn/start` / `turn/end`, a
 * `subagent` call whose result names the child session it started, and `ctx.jobs` records. Nothing
 * DSH stores changes in place; the one entity whose state does is an activity, a job that settles.
 */
const CWD = '/repo';
const BASE = Date.UTC(2026, 9, 1);

class StoredSession {
  readonly events: Record<string, unknown>[] = [];
  constructor(readonly createdAt: number) {}
  push(type: string, data: Record<string, unknown> = {}): number {
    const seq = this.events.length;
    this.events.push({ type, seq, time: this.createdAt + seq * 1000, data });
    return seq;
  }
}

class FakeDsh implements DshLogReader {
  readonly sessions = new Map<string, StoredSession>();
  private readonly observers = new Map<string, Set<DshObserver>>();

  session(id: string): StoredSession {
    let session = this.sessions.get(id);
    if (!session) this.sessions.set(id, session = new StoredSession(BASE + this.sessions.size * 7));
    return session;
  }

  async revision(id: string): Promise<string | undefined> {
    const session = this.sessions.get(id);
    return session ? `${session.createdAt}:${session.events.length}` : undefined;
  }

  async read(id: string): Promise<DshLog | undefined> {
    const session = this.sessions.get(id);
    return session ? { createdAt: session.createdAt, cwd: CWD, events: [...session.events] } : undefined;
  }

  observe(id: string, listener: DshObserver): () => void {
    let set = this.observers.get(id);
    if (!set) this.observers.set(id, set = new Set());
    set.add(listener);
    return () => { set.delete(listener); };
  }

  /** What the bridge sends for each record DSH commits. */
  committed(id: string): void {
    const last = this.session(id).events.at(-1);
    for (const listener of this.observers.get(id) ?? []) listener('session/event', { nativeSessionId: id, event: last });
  }
}

/** One turn as DSH records it; `rpcId` is the Riffet command that sent it, or DSH's own for one typed into its UI. */
function turn(log: StoredSession, n: number, options: { rpcId?: string; end?: string; extra?: (step: number) => void } = {}): void {
  log.push('turn/start', { turn: n });
  log.push('user/message', { id: `u-${n}`, role: 'user', content: [{ type: 'text', text: `question ${n}` }], source: { kind: 'user', rpcId: options.rpcId ?? `cmd-${n}` } });
  log.push('step/start', { turn: n, step: 0 });
  log.push('assistant/message', { turn: n, step: 0, message: { id: `m-${n}`, role: 'assistant', content: [{ type: 'reasoning', text: 'thinking' }, { type: 'text', text: `answer ${n}` }] } });
  log.push('tool/call', { turn: n, step: 0, callId: `call-${n}`, name: 'bash', arguments: JSON.stringify({ command: 'ls' }) });
  options.extra?.(0);
  log.push('tool/result', { turn: n, step: 0, message: { role: 'tool', toolCallId: `call-${n}`, content: [{ type: 'text', text: 'ok' }], isError: false } });
  log.push('step/end', { turn: n, step: 0 });
  log.push('turn/end', { turn: n, reason: { kind: options.end ?? 'completed' } });
}

/** A turn whose `subagent` call starts child session `childId`, and the child's own transcript. */
function subagentTurn(dsh: FakeDsh, log: StoredSession, n: number, childId: string): void {
  log.push('turn/start', { turn: n });
  log.push('user/message', { id: `u-${n}`, role: 'user', content: [{ type: 'text', text: 'delegate' }], source: { kind: 'user', rpcId: `cmd-${n}` } });
  log.push('tool/call', { turn: n, step: 0, callId: `agent-${n}`, name: 'subagent', arguments: JSON.stringify({ description: 'look around', prompt: 'read the repo' }) });
  log.push('tool/result', { turn: n, step: 0, message: { role: 'tool', toolCallId: `agent-${n}`, content: [{ type: 'text', text: `started subagent ${childId}` }], isError: false } });
  log.push('turn/end', { turn: n, reason: { kind: 'completed' } });
  turn(dsh.session(childId), 1, { rpcId: `delegated-${childId}` });
}

const job = (id: string, startedAt: number) => ({ jobId: id, kind: 'bash', label: 'npm run watch', owner: 'dsh-main', startedAt, toolCall: { callId: 'call-3', rootCallId: 'call-3' } });

function dshFixture(dsh = new FakeDsh()): IngestContractFixture & { dsh: FakeDsh; native: () => string } {
  let native = 'dsh-main';
  const main = dsh.session(native);
  let n = 0;
  // Long enough that the first import serves a tail window first (G4).
  for (; n < 260; n += 1) {
    if (n === 3) {
      // A job that outlives its grace and one DSH waited for, which is no background task.
      turn(main, n, { extra: () => { main.push('job/registered', job('bash-long', main.createdAt + main.events.length * 1000)); } });
      const quick = main.createdAt + main.events.length * 1000;
      main.push('job/registered', { ...job('bash-quick', quick) });
      main.push('job/settled', { ...job('bash-quick', quick), status: 'completed', cause: 'producer', detail: 'exit code: 0', finishedAt: quick + 500 });
    } else if (n === 5) turn(main, n, { end: 'error' });
    else if (n === 8) subagentTurn(dsh, main, n, 'child-1');
    else turn(main, n);
  }
  // The newest turn is still running when the import reads it, so the next read starts inside it.
  let open: number | undefined = n++;
  main.push('turn/start', { turn: open });
  main.push('user/message', { id: `u-${open}`, role: 'user', content: [{ type: 'text', text: 'still going' }], source: { kind: 'user', rpcId: `cmd-${open}` } });
  main.push('assistant/message', { turn: open, step: 0, message: { id: `m-${open}`, role: 'assistant', content: [{ type: 'text', text: 'working' }] } });
  const startedLong = (main.events.find(event => event.type === 'job/registered')!.data as { startedAt: number }).startedAt;
  return {
    dsh,
    native: () => native,
    scratch: true,
    source: () => new DshTranscriptSource({
      sessionId: 'wb-1', nativeSessionId: () => native, cwd: () => CWD, logs: dsh,
      runOf: commandId => /^cmd-\d+$/.test(commandId) ? `run-${commandId.slice(4)}` : undefined,
      observe: (id, listener) => dsh.observe(id, listener),
    }),
    append: () => {
      const log = dsh.session(native);
      if (open !== undefined) {
        log.push('tool/call', { turn: open, step: 1, callId: `call-${open}`, name: 'read', arguments: JSON.stringify({ path: '/repo/a.ts' }) });
        log.push('tool/result', { turn: open, step: 1, message: { role: 'tool', toolCallId: `call-${open}`, content: [{ type: 'text', text: 'file' }], isError: false } });
        log.push('turn/end', { turn: open, reason: { kind: 'completed' } });
        open = undefined;
      }
      turn(log, n++);
      dsh.committed(native);
    },
    // The job settles: the activity a turn reported gets its next state, under its own id (G2, G10).
    update: () => {
      dsh.session(native).push('job/settled', { ...job('bash-long', startedLong), status: 'completed', cause: 'producer', detail: 'exit code: 0', finishedAt: startedLong + 60_000 });
      dsh.committed(native);
    },
    // Typed into DSH's own UI: no Riffet command, the turn is still the log's (G3).
    terminalTurn: () => { turn(dsh.session(native), n++, { rpcId: 'dsh-ui-1' }); },
    subagent: () => { subagentTurn(dsh, dsh.session(native), n++, 'child-2'); dsh.committed(native); },
    changeIdentity: () => { native = 'dsh-other'; turn(dsh.session(native), 0); },
  };
}

describe('DSH transcript source', () => {
  it('meets the write contract over DSH\'s stored sessions', async () => {
    const report = await runIngestContract(dshFixture(), { watchMs: 3000, openLastTurn: true });
    expect(report.served.map(item => item.scratch)).toEqual([true, false]);
    expect(Object.keys(report.lanes)).toEqual(['main']);
  });

  it('reads turns, runs, jobs and children as DSH recorded them', async () => {
    const fixture = dshFixture();
    const db = new DatabaseSync(':memory:');
    try {
      const journal = new Journal(db);
      const writer = JournalLaneWriter.open(journal, 'wb-1');
      const source = fixture.source();
      while (!(await pullLane(source, writer, new AbortController().signal)).caughtUp) { /* a bounded step per pull */ }
      checkSession(journal, 'wb-1', { openLastTurn: true });
      const rows = rowsOf(journal, 'wb-1');
      const meta = (kind: string, turnId: string) => rows.find(row => row.kind === kind && row.turnId === turnId)?.payload;
      // A turn sent from Riffet names its run; a failed one ends failed.
      expect(meta('meta.turn_started', 'turn-1')).toEqual({ turnId: 'turn-1', runId: 'run-1' });
      expect(meta('meta.turn_ended', 'turn-5')).toEqual({ turnId: 'turn-5', status: 'failed' });
      expect(rows.find(row => row.nativeId === '11:m-1:1')).toMatchObject({ kind: 'agent_message_chunk', turnId: 'turn-1', payload: { runId: 'run-1' } });
      // Only the job that outlived its grace is a background task.
      const jobs = rows.flatMap(row => activityOfEvent(row.payload) ?? []);
      expect([...new Set(jobs.map(activity => activity.id))]).toEqual(['dsh:job:bash-long']);
      expect(jobs.at(-1)).toMatchObject({ status: 'running', kind: 'background_task' });
      // The child session is the lane of the call that started it, named by what the call asked of it.
      expect(rows.find(row => row.kind === 'meta.subagent')?.payload).toEqual({ toolCallId: 'agent-8', agentId: 'child-1', lane: 'sub:agent-8', title: 'look around' });
      expect(rowsOf(journal, 'wb-1#sub:agent-8').filter(row => row.kind === 'user_message_chunk')).toHaveLength(1);
    } finally { db.close(); }
  });
});
