import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Project, Session } from '../../../../../packages/contracts/src/index.js';
import type { NativeBackendHost, NativeBackendProfileConfig } from '../types.js';
import { DshProfileRuntime } from './runtime.js';
import type { DshConversation } from './types.js';
import { JOB_GRACE_MS, STOP_DEADLINE_MS } from './activities.js';
import { DshTranscriptSource } from './journal-source.js';
import type { DshLog, DshLogReader } from './log-store.js';
import { activityOfEvent } from '../../journal/activity.js';
import { rowsOf } from '../../journal/ingest-contract.js';
import { Journal } from '../../journal/journal.js';
import { TranscriptIngest } from '../../sync/ingest.js';

type Internals = {
  conversation(session: Session, project: Project, profile: NativeBackendProfileConfig, nativeSessionId: string): DshConversation;
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
};

const CWD = '/tmp/dsh-jobs';

/** DSH's stored log of the conversation, as its persistence reader returns it. */
class StoredLog implements DshLogReader {
  readonly events: Record<string, unknown>[] = [];
  push(type: string, data: Record<string, unknown> = {}): void { this.events.push({ type, seq: this.events.length, time: Date.UTC(2026, 9, 1) + this.events.length * 1000, data }); }
  async revision(): Promise<string> { return String(this.events.length); }
  async read(): Promise<DshLog> { return { createdAt: 1, cwd: CWD, events: [...this.events] }; }
}

/**
 * One server process: a DSH runtime with the conversation open in its bridge, and sync v3's ingest reading
 * the conversation into `journal`. A second one over the same journal is the server after a restart.
 */
function serverProcess(journal: Journal, log: StoredLog) {
  const session = { id: 'job-session', projectId: 'p', kind: 'native', title: 'DSH', tags: [], state: 'running', nativeSessionId: 'job-native', mode: 'agent', createdAt: '', updatedAt: '' } as Session;
  const project = { id: 'p', name: 'Project', cwd: CWD, createdAt: '', updatedAt: '' } as Project;
  const profile = { id: 'local', backendId: 'dsh', name: 'DSH', config: {} } as NativeBackendProfileConfig;
  const host = { getSession: () => session, updateSession: (_id: string, patch: Partial<Session>) => Object.assign(session, patch) } as unknown as NativeBackendHost;
  const runtime = new DshProfileRuntime(profile, host);
  const ingest = new TranscriptIngest({
    journal,
    source: id => new DshTranscriptSource({
      sessionId: id, nativeSessionId: () => 'job-native', cwd: () => CWD, logs: log, runOf: () => undefined,
      observe: (nativeSessionId, listener) => runtime.observe(nativeSessionId, listener),
    }),
  });
  host.transcript = {
    drain: id => ingest.drain(id),
    endTurn: (id, turnId, status, at, error) => ingest.endTurn(id, turnId, status, at, error),
    withSource: (id, task) => ingest.control(id, task),
    wake: id => ingest.wake(id),
  };
  const release = ingest.follow(session.id);
  const internal = runtime as unknown as Internals;
  const state = internal.conversation(session, project, profile, session.nativeSessionId!);
  state.active = true;
  state.status = { phase: 'idle' };
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  const job = (status: string, extra: Record<string, unknown> = {}) => ({ id: 'bash-1', kind: 'bash', label: 'npm run watch', status, startedAt: Date.now() - JOB_GRACE_MS - 10, ...extra });
  const emit = (type: string, jobFields: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    runtime.handleNotification('job/event', { nativeSessionId: state.nativeSessionId, sessionId: session.id, type, job: jobFields, ...extra });
  /** Every state of the job the conversation's journal lane holds, oldest first. */
  const lane = () => rowsOf(journal, session.id).flatMap(row => activityOfEvent(row.payload) ?? []).map(activity => activity.status);
  const settled = () => ingest.drain(session.id);
  const close = () => { release(); ingest.close(); };
  return { runtime, internal, state, session, requests, job, emit, lane, settled, close };
}

let open: Array<() => void> = [];
function harness(journal = new Journal(new DatabaseSync(':memory:')), log = new StoredLog()) {
  const process = serverProcess(journal, log);
  open.push(process.close);
  return { ...process, journal, log };
}

afterEach(() => {
  vi.useRealTimers();
  for (const close of open) close();
  open = [];
});

describe('DSH background jobs as activities', () => {
  it('reports a long-lived job, stops it only when DSH settles it as killed, and ignores a command that finished at once', async () => {
    const h = harness();
    await h.settled();
    // A foreground command that ends inside the grace period never shows.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    h.emit('registered', { ...h.job('running'), id: 'bash-0', startedAt: Date.now() });
    h.emit('settled', { ...h.job('completed', { detail: 'exit code: 0' }), id: 'bash-0' }, { cause: 'producer' });
    vi.advanceTimersByTime(JOB_GRACE_MS + 10);
    expect(h.lane()).toEqual([]);
    vi.useRealTimers();

    h.emit('registered', h.job('running'));
    expect(h.lane()).toEqual(['running']);

    h.internal.request = async (method, params) => {
      h.requests.push({ method, params });
      // DSH only marks the job stopping; the settlement comes later.
      h.emit('stopping', h.job('stopping'));
      return { result: 'requested', job: h.job('stopping') };
    };
    const reply = await h.runtime.stopActivity(h.session, 'dsh:job:bash-1');
    expect(h.requests).toEqual([{ method: 'job/kill', params: expect.objectContaining({ jobId: 'bash-1', nativeSessionId: 'job-native' }) }]);
    expect(reply.status).toBe('stopping');
    expect(h.lane()).toEqual(['running', 'stopping']);

    h.emit('settled', h.job('killed', { finishedAt: Date.now(), detail: 'signal: SIGTERM' }), { cause: 'kill' });
    expect(h.lane()).toEqual(['running', 'stopping', 'stopped']);
  });

  it('puts a failed kill back to running, and calls a non-zero exit a failure', async () => {
    const h = harness();
    await h.settled();
    h.emit('registered', h.job('running'));
    h.internal.request = async () => { throw new Error('boom'); };
    await expect(h.runtime.stopActivity(h.session, 'dsh:job:bash-1')).rejects.toMatchObject({ code: 'ACTIVITY_STOP_FAILED' });
    expect(h.lane()).toEqual(['running', 'stopping', 'running']);
    h.emit('settled', h.job('completed', { detail: 'exit code: 2', finishedAt: Date.now() }), { cause: 'producer' });
    expect(h.lane().at(-1)).toBe('failed');
    await expect(h.runtime.stopActivity(h.session, 'dsh:job:bash-1')).rejects.toMatchObject({ code: 'ACTIVITY_ENDED' });
  });

  it('stops a job the journal carried across a restart: one kill for a repeated request, evidence settles it, and a stop DSH never acts on rolls back', async () => {
    const before = harness();
    await before.settled();
    before.emit('registered', before.job('running'));
    expect(before.lane()).toEqual(['running']);
    before.close();

    // The server restarted; DSH (reopened) still runs the job, and announces it as old.
    const h = harness(before.journal, before.log);
    await h.settled();
    let kills = 0;
    h.internal.request = async () => { kills += 1; await new Promise(resolve => setTimeout(resolve, 20)); return { result: 'requested', job: h.job('mystery') }; };
    const [first, second] = await Promise.all([h.runtime.stopActivity(h.session, 'dsh:job:bash-1'), h.runtime.stopActivity(h.session, 'dsh:job:bash-1')]);
    expect(kills).toBe(1);
    expect([first.status, second.status]).toEqual(['stopping', 'stopping']);
    // This process never announced the job; the journal's ledger knows it, and the kill's settlement ends it.
    h.emit('settled', h.job('killed', { finishedAt: Date.now() }), { cause: 'kill' });
    expect(h.lane()).toEqual(['running', 'stopping', 'stopped']);

    const again = harness(h.journal, h.log);
    await again.settled();
    again.emit('registered', { ...again.job('running'), id: 'bash-2' });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    again.internal.request = async () => ({ result: 'requested', job: { ...again.job('stopping'), id: 'bash-2' } });
    expect((await again.runtime.stopActivity(again.session, 'dsh:job:bash-2')).status).toBe('stopping');
    // A still-running report does not undo the stop; only its deadline does.
    again.emit('registered', { ...again.job('running'), id: 'bash-2' });
    expect(again.lane().slice(-1)).toEqual(['stopping']);
    vi.advanceTimersByTime(STOP_DEADLINE_MS + 1);
    vi.useRealTimers();
    await vi.waitFor(() => expect(again.lane().slice(-2)).toEqual(['stopping', 'running']));
  });

  it('settles every job the journal holds as running once the DSH process is gone, and ends the turn it died in', async () => {
    const h = harness();
    h.log.push('turn/start', { turn: 0 });
    h.log.push('user/message', { id: 'u-0', role: 'user', content: [{ type: 'text', text: 'build' }], source: { kind: 'user', rpcId: 'cmd-0' } });
    await h.settled();
    h.emit('registered', h.job('running'));
    h.close();
    const after = harness(h.journal, h.log);
    await after.settled();
    after.runtime.handleClose(new Error('DeepSeek Harness exited (1)'));
    await vi.waitFor(() => expect(rowsOf(after.journal, after.session.id).find(row => row.kind === 'meta.turn_ended')?.payload)
      .toEqual({ turnId: 'turn-0', status: 'interrupted', error: 'DeepSeek Harness exited (1)' }));
    expect(after.lane()).toEqual(['running', 'unknown']);
  });
});
