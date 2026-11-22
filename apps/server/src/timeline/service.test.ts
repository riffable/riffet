import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NativeJob, NativeRunDetails, NativeWorkbenchEvent, Run, WorkbenchEvent } from '../../../../packages/contracts/src/index.js';
import { PENDING_ROW_POS, SYNC_BUDGET, type SyncLane, type TimelineRow } from '../../../../packages/contracts/src/sync.js';
import { buildTimeline } from '../../../../packages/timeline/src/buildTimeline.js';
import { projectEvents } from '../../../../packages/timeline/src/projectEvents.js';
import { timelineRuns } from './fold.js';
import { timelineRows } from '../../../../packages/timeline/src/rows.js';
import { JournalLaneWriter, subagentMetaId, turnMetaId } from '../journal/ingest.js';
import { Journal, laneKey } from '../journal/journal.js';
import { WorkspaceService } from '../workspace/index.js';
import { SessionMedia } from './media.js';
import { TimelineService, type TimelineChange } from './service.js';

const S = 'session-1';
const stamp = (index: number) => new Date(Date.UTC(2026, 9, 1) + index * 1000).toISOString();

let dir: string;
let tick = 0;
beforeEach(async () => { dir = await realpath(await mkdtemp(join(tmpdir(), 'riffet-timeline-'))); tick = 0; });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

/** One database, journal, writer and timeline service; `reopen` is a restart. */
function open(path = join(dir, 'state.db'), options: { debounceMs?: number; rebuildSettleMs?: number; jobs?: NativeJob[]; stepRows?: number; idleSince?: string; activity?: (id: string) => { at?: string; running: boolean } | undefined } = {}) {
  const db = new DatabaseSync(path);
  const journal = new Journal(db);
  const writer = JournalLaneWriter.open(journal, S);
  const runs: Run[] = [];
  const runListeners = new Set<(run: Run) => void>();
  const jobListeners = new Set<(sessionId: string, job: NativeJob) => void>();
  const ranges: number[] = [];
  const range = journal.range.bind(journal);
  journal.range = (key, after, limit) => { ranges.push(after); return range(key, after, limit); };
  const service = new TimelineService({
    db, journal, listRuns: () => runs, onRunChanged: listener => { runListeners.add(listener); return () => runListeners.delete(listener); },
    nativeChatId: () => 'chat-1', listJobs: () => options.jobs ?? [],
    onJobChanged: listener => { jobListeners.add(listener); return () => jobListeners.delete(listener); },
    coldSweep: false, busy: () => false, activity: options.activity ?? (() => ({ at: options.idleSince ?? new Date().toISOString(), running: false })),
    debounceMs: options.debounceMs ?? 5, ...(options.rebuildSettleMs !== undefined ? { rebuildSettleMs: options.rebuildSettleMs } : {}), ...(options.stepRows ? { stepRows: options.stepRows } : {}),
  });
  const frames: TimelineChange[] = [];
  return {
    db, journal, writer, runs, service, frames, ranges,
    setRun(run: Run) { const at = runs.findIndex(item => item.id === run.id); if (at >= 0) runs[at] = run; else runs.push(run); for (const listener of runListeners) listener(run); },
    setJob(job: NativeJob) { for (const listener of jobListeners) listener(S, job); },
    listen(lane: SyncLane = 'main') { return service.subscribe(S, lane, change => frames.push(change)); },
    ready: (lane: SyncLane = 'main') => service.ready(S, lane),
    all: (lane: SyncLane = 'main') => service.page(S, lane, { from: 0, rows: 500, bytes: 1024 * 1024 }).rows,
    close() { service.close(); db.close(); },
  };
}

function ev(nativeId: string, type: string, data: Record<string, unknown>, turn: string, extra: Partial<NativeWorkbenchEvent> = {}): NativeWorkbenchEvent {
  return { sequence: 0, sessionId: S, type, data, createdAt: stamp(++tick), nativeId, nativeTurnId: turn, ...extra };
}
const text = (value: string) => ({ content: { type: 'text', text: value } });
const user = (id: string, turn: string, value: string) => ev(id, 'user_message_chunk', text(value), turn);
const answer = (id: string, turn: string, value: string) => ev(id, 'agent_message_chunk', text(value), turn);
const tool = (id: string, turn: string, toolCallId: string, status: string, extra: Record<string, unknown> = {}) => ev(id, 'tool_call', { toolCallId, title: `run ${toolCallId}`, status, ...extra }, turn);

function nativeRun(id: string, state: Run['state'], prompt: string, native: Partial<NativeRunDetails>): Run {
  return {
    id, sessionId: S, commandId: `cmd-${id}`, prompt, state, createdAt: stamp(++tick), updatedAt: stamp(tick),
    native: { input: { text: prompt, attachmentIds: [], context: [] }, config: { mode: 'default' }, fingerprint: `fp-${id}`, delivery: 'observed', attempt: 1, configRevision: 1, ...native },
  };
}

let cursor = 0;
const commit = (env: ReturnType<typeof open>, ...events: NativeWorkbenchEvent[]) => env.writer.commit({ events, cursor: String(++cursor) });

/** A whole turn: its marks, a prompt, an answer and a tool call that completes. */
function turn(env: ReturnType<typeof open>, index: number): void {
  const id = `t${index}`;
  env.writer.turnStarted(id, stamp(++tick));
  commit(env, user(`u${index}`, id, `question ${index}`), tool(`k${index}`, id, `call-${index}`, 'in_progress'));
  commit(env, tool(`k${index}`, id, `call-${index}`, 'completed', { content: [{ type: 'content', content: { type: 'text', text: 'ok' } }] }), answer(`a${index}`, id, `answer ${index}`));
  env.writer.turnEnded(id, 'completed', stamp(++tick));
}

/** The rows a fold of the whole lane from scratch gives: what the service's rows must equal, whatever it folded when. */
function foldedFromScratch(env: ReturnType<typeof open>, lane: SyncLane = 'main'): unknown[] {
  const key = laneKey(S, lane);
  const latest = new Map<string, { identity: number; kind: string; payload: unknown; turnId?: string }>();
  const ended = new Set<string>();
  for (const row of env.journal.range(key, 0, 1_000_000)) {
    if (row.kind === 'meta.turn_ended') ended.add((row.payload as { turnId: string }).turnId);
    if (row.kind.startsWith('meta.')) continue;
    const identity = latest.get(row.nativeId)?.identity ?? row.seq;
    latest.set(row.nativeId, { identity, kind: row.kind, payload: row.payload, ...(row.turnId ? { turnId: row.turnId } : {}) });
  }
  const events = [...latest.values()]
    .filter(entity => entity.kind !== 'tombstone' && !(entity.kind === 'draft' && entity.turnId && ended.has(entity.turnId)))
    .sort((left, right) => left.identity - right.identity)
    .map(entity => ({ ...(entity.payload as object), sessionId: S, sequence: entity.identity }) as WorkbenchEvent);
  const runs = lane === 'main' ? timelineRuns(env.runs) : [];
  return timelineRows(buildTimeline(projectEvents(events), runs, undefined, undefined, lane === 'main' ? 'chat-1' : undefined));
}

const withoutSeq = (rows: TimelineRow[]) => rows.map(({ seq: _seq, rev: _rev, ...row }) => row);

/** Every rows frame continues the one before it, and together they reach the head. */
function expectContiguous(frames: TimelineChange[], headSeq: number, from = 1): void {
  let next = from;
  for (const frame of frames) {
    if (frame.type !== 'rows') continue;
    expect(frame.from).toBe(next);
    expect(frame.to).toBe(frame.from + frame.upserts.length + frame.deletes.length - 1);
    next = frame.to + 1;
  }
  expect(next - 1).toBe(headSeq);
}

describe('timeline service', () => {
  it('merges a falsely split continuation back into its original turn across restart', async () => {
    let env = open(undefined, { stepRows: 1 });
    commit(env, user('original', 't1', 'work'));
    env.writer.turnEnded('t1', 'failed', stamp(++tick), 'transient error');
    const continued = answer('continued', 't2', 'still working');
    commit(env, continued);
    const head = await env.ready();
    env.writer.transaction(() => {
      env.writer.turnReopened('t1', stamp(++tick));
      env.writer.commit({ events: [{ ...continued, nativeTurnId: 't1' }], retire: [turnMetaId('t2', 'started'), turnMetaId('t2', 'ended')], cursor: String(++cursor) });
    });
    await env.ready();
    expect(env.journal.projection(S)).toMatchObject({ state: 'running', activeTurnId: 't1', turnCount: 1 });
    expect(env.journal.projection(S).turns[0]?.events).toBe(2);
    expect(env.service.outline(S, 'main').turns).toHaveLength(1);
    expect(env.service.outline(S, 'main').turns[0]).toMatchObject({ turnId: 't1', status: 'running' });
    env.writer.turnEnded('t1', 'completed', stamp(++tick));
    await env.ready();
    const rows = env.all();
    env.close();
    env = open();
    expect((await env.ready()).generation).toBe(head.generation);
    expect(env.all()).toEqual(rows);
    expect(env.service.outline(S, 'main').turns).toHaveLength(1);
    env.close();
  });

  it('serves an image only when a tool call of the session named its path, and only if its bytes are an image', async () => {
    const env = open();
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from('IHDR'), Buffer.from([0, 0, 0, 1, 0, 0, 0, 1])]);
    const named = join(dir, 'named.png'), viaContent = join(dir, 'content.png'), unnamed = join(dir, 'unnamed.png'), notImage = join(dir, 'notes.png');
    await Promise.all([named, viaContent, unnamed].map(path => writeFile(path, png)));
    await writeFile(notImage, 'not an image');
    env.writer.turnStarted('t1', stamp(++tick));
    commit(env, user('u1', 't1', 'look'), tool('k1', 't1', 'call-1', 'completed', { locations: [{ path: named }, { path: notImage }] }),
      tool('k2', 't1', 'call-2', 'completed', { content: [{ type: 'content', content: { type: 'image', path: viaContent } }] }));
    env.writer.turnEnded('t1', 'completed', stamp(++tick));
    await env.ready();

    const workspace = new WorkspaceService({ stateDir: join(dir, '.state') });
    const mediaFor = (project: string) => new SessionMedia(id => env.service.namedPaths(id), id => env.service.revision(id), () => env.ready(), (_id, path, allowOutside) => workspace.readPreviewImage(project, path, { allowOutside }));
    const media = mediaFor(dir);
    expect(await media.read(S, named, false)).toMatchObject({ type: 'image/png' });
    expect(await media.read(S, viaContent, false)).toMatchObject({ type: 'image/png' });
    // An image the conversation never named, a named file that is no image, and another conversation's path are all absent.
    expect(await media.read(S, unnamed, false)).toBeUndefined();
    expect(await media.read(S, notImage, false)).toBeUndefined();
    expect(await media.read('other-session', named, false)).toBeUndefined();
    expect(await media.read(S, `${dir}/../${dir.split('/').at(-1)}/named.png`, false)).toBeUndefined();
    // A named file outside the project is read only where the request may read outside it.
    await mkdir(join(dir, 'project'));
    const inside = mediaFor(join(dir, 'project'));
    expect(await inside.read(S, named, false)).toBeUndefined();
    expect(await inside.read(S, named, true)).toMatchObject({ type: 'image/png' });
    // An image named after the set was built is found without waiting.
    const later = join(dir, 'later.png');
    await writeFile(later, png);
    expect(await media.read(S, later, false)).toBeUndefined();
    env.writer.turnStarted('t2', stamp(++tick));
    commit(env, user('u2', 't2', 'again'), tool('k3', 't2', 'call-3', 'completed', { locations: [{ path: later }] }));
    env.writer.turnEnded('t2', 'completed', stamp(++tick));
    expect(await media.read(S, later, false)).toMatchObject({ type: 'image/png' });
    env.close();
  });

  it('numbers every changed or deleted row with the next lane seq, contiguous across appends, versions and deletes', async () => {
    const env = open();
    env.writer.turnStarted('t1', stamp(++tick));
    commit(env, user('u1', 't1', 'hello'), tool('k1', 't1', 'call-1', 'in_progress'));
    const start = await env.ready();
    env.listen();
    commit(env, tool('k1', 't1', 'call-1', 'completed'));
    await env.ready();
    commit(env, answer('a1', 't1', 'draft answer'));
    await env.ready();
    env.writer.commit({ events: [answer('a2', 't1', 'final answer')], retire: ['a1'], cursor: String(++cursor) });
    const head = await env.ready();

    expectContiguous(env.frames, head.headSeq, start.headSeq + 1);
    const rows = env.frames.flatMap(frame => frame.type === 'rows' ? frame.upserts : []);
    expect(rows.filter(row => row.key === 'tool:call-1').map(row => [row.rev, (row.event.data as { status: string }).status])).toEqual([[2, 'completed']]);
    expect(env.frames.flatMap(frame => frame.type === 'rows' ? frame.deletes : [])).toEqual(['event:a1']);
    // A delta from any seq the client held is the rows that changed since, ending at the head.
    const delta = env.service.changes(S, 'main', { generation: head.generation, after: 2 });
    expect(delta).toMatchObject({ mode: 'delta', from: 3, to: head.headSeq, deletes: ['event:a1'] });
    expect(withoutSeq(env.all())).toEqual(foldedFromScratch(env));
    // A stale generation, or more changes than twice the budget, is answered with a snapshot.
    expect(env.service.changes(S, 'main', { generation: 'stale', after: 2 }).mode).toBe('snapshot');
    env.close();
  });

  it('keeps rows and seqs across a restart and folds only the open turn again', async () => {
    let env = open();
    for (let index = 1; index <= 4; index += 1) turn(env, index);
    env.writer.turnStarted('t5', stamp(++tick));
    commit(env, user('u5', 't5', 'open question'), answer('a5', 't5', 'thinking about it'));
    const before = await env.ready();
    const rows = env.all();
    const outline = env.service.outline(S, 'main');
    expect(outline.turns.map(item => [item.turnId, item.status, item.rows])).toEqual([
      ['t1', 'completed', 3], ['t2', 'completed', 3], ['t3', 'completed', 3], ['t4', 'completed', 3], ['t5', 'running', 2],
    ]);
    const foldedThrough = (env.db.prepare('SELECT folded_through FROM timeline_heads WHERE session_id=? AND lane=?').get(S, 'main') as { folded_through: number }).folded_through;
    // The window moved to the open turn: everything before its prompt is folded for good.
    expect(foldedThrough).toBe(env.journal.locate(S, 'u5')!.identity - 1);
    env.close();

    env = open();
    const after = await env.ready();
    expect(after).toEqual(before);
    expect(env.all()).toEqual(rows);
    expect(Math.min(...env.ranges)).toBeGreaterThanOrEqual(foldedThrough);
    // A restart then carries on numbering where it was.
    commit(env, answer('a6', 't5', 'done'));
    const next = await env.ready();
    expect(next.headSeq).toBe(before.headSeq + 1);
    expect(withoutSeq(env.all())).toEqual(foldedFromScratch(env));
    env.close();
  });

  it('restores a reopened turn and its live draft in place, including a frozen turn after restart', async () => {
    let env = open();
    const run = nativeRun('r1', 'interrupted', 'question', { nativeMessageId: 'u1', nativeSessionId: 'chat-1', nativeTurnId: 't1' });
    env.runs.push(run);
    env.writer.turnStarted('t1', stamp(++tick), 'r1');
    commit(env, user('u1', 't1', 'question'));
    env.writer.commit({ events: [], drafts: [{ finalId: 'a1', event: answer('a1', 't1', 'working') }], cursor: String(++cursor) });
    const head = await env.ready();
    const first = env.all().find(row => row.key === 'event:a1')!;
    expect(first).toBeDefined();
    env.writer.turnEnded('t1', 'interrupted', stamp(++tick));
    await env.ready();
    expect(env.all().some(row => row.key === first.key)).toBe(false);
    expect(env.service.outline(S, 'main').turns[0]?.status).toBe('interrupted');

    // No new draft row is needed: a replay of the same native chunk is deduplicated by the journal.
    env.writer.turnReopened('t1', stamp(++tick));
    await env.ready();
    expect(env.all().find(row => row.key === first.key)).toMatchObject({ key: first.key, pos: first.pos, text: 'working' });
    const resumed = env.service.outline(S, 'main').turns[0]!;
    expect(resumed.status).toBe('running');
    expect(resumed).not.toHaveProperty('endedAt');
    expect(resumed).not.toHaveProperty('endPos');
    env.writer.commit({ events: [], drafts: [{ finalId: 'a1', event: answer('a1', 't1', 'still working') }], cursor: String(++cursor) });
    await env.ready();
    expect(env.all().find(row => row.key === first.key)).toMatchObject({ pos: first.pos, text: 'still working' });
    const rows = env.all();
    const beforeRestart = await env.ready();
    env.close();

    env = open();
    env.runs.push(run);
    expect(await env.ready()).toEqual(beforeRestart);
    expect(env.all()).toEqual(rows);
    env.writer.turnEnded('t1', 'completed', stamp(++tick));
    commit(env, user('u2', 't2', 'next question'));
    await env.ready();
    const foldedThrough = (env.db.prepare('SELECT folded_through FROM timeline_heads WHERE session_id=? AND lane=?').get(S, 'main') as { folded_through: number }).folded_through;
    expect(env.journal.locate(S, 'u1')!.identity).toBeLessThanOrEqual(foldedThrough);
    env.close();

    // A restart must invalidate an already frozen outline without changing the lane's generation.
    env = open(undefined, { stepRows: 1 });
    env.runs.push(run);
    env.writer.turnReopened('t1', stamp(++tick));
    env.writer.commit({ events: [], drafts: [{ finalId: 'a1', event: answer('a1', 't1', 'recovered') }], cursor: String(++cursor) });
    const recovered = await env.ready();
    expect(recovered.generation).toBe(head.generation);
    expect(env.all().find(row => row.key === first.key)).toMatchObject({ pos: first.pos, text: 'recovered' });
    expect(env.service.outline(S, 'main').turns.find(turn => turn.turnId === 't1')).toMatchObject({ status: 'running' });
    env.close();
  });

  it('derives one durable failure per native turn, including autonomous turns, frozen corrections and reopening', async () => {
    let env = open(undefined, { stepRows: 1 });
    env.writer.turnStarted('t1', stamp(++tick));
    commit(env, user('u1', 't1', 'CLI question'));
    const endedAt = stamp(++tick);
    env.writer.turnEnded('t1', 'failed', endedAt, 'provider failed');
    const firstHead = await env.ready();
    const failure = env.all().find(row => row.kind === 'status')!;
    expect(failure).toMatchObject({ kind: 'status', text: 'provider failed', turn: `native:${S}:t1`, event: { nativeTurnId: 't1' } });
    // Riffet command/steer outcomes settle runs but do not repeat the turn's failure.
    commit(env, ev('outcome-1', 'run_failed', { error: 'provider failed' }, 't1'), ev('outcome-2', 'run_failed', { error: 'provider failed' }, 't1'));
    await env.ready();
    expect(env.all().filter(row => row.kind === 'status')).toHaveLength(1);
    turn(env, 2);
    const before = await env.ready();
    const oldRows = env.all();
    env.close();
    env = open(undefined, { stepRows: 1 });
    expect(await env.ready()).toEqual(before);
    expect(env.all()).toEqual(oldRows);
    env.writer.turnEnded('t1', 'failed', endedAt, 'specific provider failure');
    await env.ready();
    expect(env.all().filter(row => row.kind === 'status')).toEqual([expect.objectContaining({ key: failure.key, pos: failure.pos, text: 'specific provider failure' })]);
    const stable = await env.ready();
    env.writer.turnEnded('t1', 'failed', endedAt, 'specific provider failure');
    expect(await env.ready()).toEqual(stable);
    env.writer.turnReopened('t1', stamp(++tick));
    await env.ready();
    // Reopened turn has no terminal error, including legacy outcomes read from its former end.
    expect(env.all().filter(row => row.kind === 'status')).toEqual([]);
    env.writer.turnEnded('t1', 'completed', stamp(++tick));
    const completed = await env.ready();
    expect(completed.generation).toBe(firstHead.generation);
    expect(env.service.outline(S, 'main').turns.find(turn => turn.turnId === 't1')?.status).toBe('completed');

    // The original end identity survives an interrupted -> reopened -> failed execution.
    env.writer.turnStarted('t3', stamp(++tick));
    commit(env, user('u3', 't3', 'resume after interruption'));
    commit(env, ev('cancelled-3', 'run_cancelled', { reason: 'interrupted' }, 't3'));
    env.writer.turnEnded('t3', 'interrupted', stamp(++tick));
    await env.ready();
    expect(env.all().filter(row => row.kind === 'status')).toHaveLength(1);
    env.writer.turnReopened('t3', stamp(++tick));
    await env.ready();
    expect(env.all().filter(row => row.kind === 'status')).toEqual([]);
    commit(env, answer('a3-resumed', 't3', 'new content after the original end'));
    const failedAgainAt = stamp(++tick);
    env.writer.turnEnded('t3', 'failed', failedAgainAt, 'resumed provider failure');
    await env.ready();
    const resumedRows = env.all();
    const resumedContent = resumedRows.find(row => row.key === 'event:a3-resumed')!;
    const resumedFailure = resumedRows.find(row => row.kind === 'status')!;
    expect(resumedRows.filter(row => row.kind === 'status')).toHaveLength(1);
    expect(resumedFailure).toMatchObject({ text: 'resumed provider failure', turn: resumedContent.turn });
    expect(Number.isInteger(resumedFailure.pos)).toBe(true);
    expect(resumedFailure.pos).toBeGreaterThan(resumedContent.pos);
    // Later turn metadata and a text-only error correction must not move the historical failure.
    turn(env, 4);
    await env.ready();
    env.writer.turnEnded('t3', 'failed', failedAgainAt, 'resumed provider failure detail');
    const correctedHead = await env.ready();
    expect(env.all().find(row => row.key === resumedFailure.key)).toMatchObject({ pos: resumedFailure.pos, text: 'resumed provider failure detail' });
    const correctedRows = env.all();
    env.close();
    env = open(undefined, { stepRows: 1 });
    expect(await env.ready()).toEqual(correctedHead);
    expect(env.all()).toEqual(correctedRows);
    env.close();
  });

  it('projects a bare failed end after its tools and recovers the exact owner Run error after reopening', async () => {
    let env = open(undefined, { stepRows: 1 });
    const owner = nativeRun('owner', 'running', 'run the tool', {
      nativeSessionId: 'chat-1', nativeTurnId: 't1', nativeMessageId: 'u1',
    });
    env.setRun(owner);
    commit(env, user('u1', 't1', owner.prompt), tool('k1', 't1', 'call-1', 'completed'));
    const endedAt = stamp(++tick);
    env.writer.turnEnded('t1', 'failed', endedAt);
    await env.ready();
    const bare = env.all().find(row => row.kind === 'status');
    expect(bare).toMatchObject({ kind: 'status', tone: 'danger', text: '任务失败', turn: 'run:owner' });
    const storedBare = env.db.prepare('SELECT payload,digest,bytes FROM timeline_rows WHERE session_id=? AND key=?')
      .get(S, bare!.key) as { payload: string; digest: string; bytes: number };

    const error = 'Network Error\nThe model provider did not respond.';
    const failed = { ...owner, state: 'failed' as const, error, native: { ...owner.native!, delivery: 'failed' as const, stage: 'provider_failed' as const } };
    env.setRun(failed);
    await env.ready();
    const rows = env.all().filter(row => row.turn === 'run:owner');
    expect(rows.map(row => row.kind)).toEqual(['user', 'tool', 'status']);
    expect(rows.at(-1)).toMatchObject({ key: bare!.key, pos: bare!.pos, text: 'Network Error', detail: error, event: { data: { error }, nativeTurnId: 't1' } });
    turn(env, 2);
    await env.ready();

    // A steering Run and an older chat cannot supply this native turn's error.
    env.setRun({ ...nativeRun('steer', 'failed', 'keep working', { ...failed.native, nativeMessageId: 'steer-message', intent: 'steer', ownerRunId: owner.id }), error: 'steering failed' });
    env.setRun({ ...nativeRun('other-chat', 'failed', 'old question', { ...failed.native, nativeMessageId: 'old-message', nativeSessionId: 'chat-0' }), error: 'other chat failed' });
    env.setRun({ ...nativeRun('unsent', 'failed', 'could not send', { nativeSessionId: 'chat-1', delivery: 'failed' }), error: 'send failed' });
    await env.ready();
    expect(env.all().filter(row => row.kind === 'status')).toEqual([expect.objectContaining({ key: bare!.key, detail: error })]);

    // A previously folded cache omitted this row altogether. Reopening derives it from the Run.
    env.db.prepare('DELETE FROM timeline_rows WHERE key=?').run(bare!.key);
    env.db.prepare("UPDATE timeline_heads SET generation='old-fold',fold_version=10 WHERE session_id=? AND lane='main'").run(S);
    env.close();
    env = open(undefined, { stepRows: 1 });
    env.runs.push(failed);
    await env.ready();
    const replayed = env.all().filter(row => row.turn === 'run:owner');
    expect(replayed.map(row => row.kind)).toEqual(['user', 'tool', 'status']);
    expect(replayed.at(-1)).toMatchObject({ key: bare!.key, pos: bare!.pos, detail: error });
    env.close();

    // Restore a current-generation cache whose frozen failure was written before the Run error.
    env = open();
    env.db.prepare('UPDATE timeline_rows SET payload=?,digest=?,bytes=? WHERE session_id=? AND key=?')
      .run(storedBare.payload, storedBare.digest, storedBare.bytes, S, bare!.key);
    env.runs.push(failed);
    await env.ready();
    expect(env.all().filter(row => row.kind === 'status')).toEqual([expect.objectContaining({ key: bare!.key, pos: bare!.pos, detail: error })]);
    // A later journal failure takes precedence over the Run without duplicating or moving the row.
    commit(env, ev('late-provider-failure', 'run_failed', { error: 'More specific provider failure' }, 't1'), ev('bare-command-end', 'run_failed', {}, 't1'));
    const legacyHead = await env.ready();
    expect(env.all().filter(row => row.kind === 'status')).toEqual([expect.objectContaining({ key: bare!.key, pos: bare!.pos, text: 'More specific provider failure' })]);
    env.close();

    env = open();
    env.runs.push(failed);
    expect(await env.ready()).toEqual(legacyHead);
    expect(env.ranges[0]).toBeGreaterThan(env.journal.locate(S, turnMetaId('t1', 'started'))!.identity);
    env.close();
  });

  it('folds a long log a bounded step per turn of the event loop, to the same rows, and resumes a fold cut short by a restart', async () => {
    const path = join(dir, 'state.db');
    let env = open(path, { stepRows: 7 });
    for (let index = 1; index <= 12; index += 1) turn(env, index);
    env.writer.turnStarted('t13', stamp(++tick));
    commit(env, user('u13', 't13', 'open question'), answer('a13', 't13', 'thinking'));
    env.listen();
    // The first step folds part of the log and the rest follows; nobody waiting is answered before the end.
    let steps = 0;
    const range = env.journal.range.bind(env.journal);
    env.journal.range = (key, after, limit) => { steps += 1; return range(key, after, limit); };
    const head = await env.ready();
    expect(steps).toBeGreaterThan(5);
    expect(head.headSeq).toBeGreaterThan(0);
    expectContiguous(env.frames, head.headSeq);
    expect(withoutSeq(env.all())).toEqual(foldedFromScratch(env));
    env.close();

    // A restart in the middle of a fold: the stored head says how far it got, the next open goes on from there.
    env = open(path, { stepRows: 7 });
    for (let index = 14; index <= 20; index += 1) turn(env, index);
    env.service.subscribe(S, 'main', () => undefined);
    await new Promise(resolve => setImmediate(resolve));
    env.close();
    env = open(path, { stepRows: 7 });
    await env.ready();
    expect(withoutSeq(env.all())).toEqual(foldedFromScratch(env));
    env.close();
  });

  it('announces the turn of a queued message replaced by its steer as gone, with no rows', async () => {
    const env = open();
    env.writer.turnStarted('t1', stamp(++tick));
    commit(env, user('u1', 't1', 'hello'));
    env.runs.push(nativeRun('r0', 'running', 'hello', { nativeMessageId: 'u1', nativeSessionId: 'chat-1', nativeTurnId: 't1' }));
    await env.ready();
    env.listen();
    let queued = nativeRun('q0', 'queued', 'again', { delivery: 'queued' });
    env.setRun(queued);
    await env.ready();
    // Each steer replaces the queued row and, not reaching the turn, comes back as the next message (`requeueSteer`).
    for (const id of ['s1', 's2']) {
      const steer = nativeRun(id, 'queued', 'again', { intent: 'steer', delivery: 'queued', stage: 'steer_pending', nativeSessionId: 'chat-1', nativeTurnId: 't1', sourceRunId: queued.id });
      env.setRun(steer);
      env.setRun({ ...queued, state: 'cancelled', updatedAt: stamp(++tick), native: { ...queued.native!, delivery: 'cancelled', stage: 'steer_replaced' } });
      await env.ready();
      queued = { ...steer, updatedAt: stamp(++tick), native: { ...steer.native!, intent: undefined, nativeTurnId: undefined, delivery: 'queued', stage: 'steer_fallback' } };
      env.setRun(queued);
      await env.ready();
    }
    const announced = new Map<string, number>();
    for (const frame of env.frames) if (frame.type === 'outline') for (const turn of frame.turns) announced.set(turn.turn, turn.rows);
    expect(Object.fromEntries(announced)).toMatchObject({ 'run:q0': 0, 'run:s1': 0 });
    expect(announced.get('run:s2')).toBeGreaterThan(0);
    expect(env.service.outline(S, 'main').turns.map(turn => turn.turn)).toEqual(['run:r0', 'run:s2']);
    env.close();
  });

  it('takes up a run that changed while the lane was not folded (a restart) even in a turn folded for good', async () => {
    const path = join(dir, 'state.db');
    let env = open(path);
    for (let index = 1; index <= 3; index += 1) turn(env, index);
    await env.ready();
    const foldedThrough = (env.db.prepare('SELECT folded_through FROM timeline_heads WHERE session_id=? AND lane=?').get(S, 'main') as { folded_through: number }).folded_through;
    expect(env.journal.locate(S, 'u1')!.identity).toBeLessThanOrEqual(foldedThrough);
    expect(env.all().some(row => row.runId)).toBe(false);
    env.close();

    // The first prompt's receipt was recorded before the timeline came back up (`recoverInterruptedRuns`, a
    // debounce cut short by the shutdown): its row, in a turn folded for good, now belongs to the run.
    env = open(path);
    const reference = {
      sessionId: 'source-session', title: 'Database research', backendId: 'claude' as const, projectName: 'Riffet',
      capturedAt: stamp(tick), snapshotRef: 'a'.repeat(64), excerpt: 'SQLite keeps the data local.',
      coverage: { source: 'journal' as const, completeness: 'partial' as const, messages: 2, bytes: 90 },
    };
    env.runs.push({ ...nativeRun('r1', 'completed', 'The original user request', {
      nativeMessageId: 'u1', nativeSessionId: 'chat-1', nativeTurnId: 't1', contextSnapshots: [reference],
    }), updatedAt: new Date(Date.now() + 1000).toISOString() });
    await env.ready();
    const referenced = env.all().find(row => row.runId === 'r1');
    expect(referenced).toMatchObject({ text: 'The original user request', references: [reference] });
    expect(referenced?.event.data.content).not.toHaveProperty('text');
    expect(withoutSeq(env.all())).toEqual(foldedFromScratch(env));
    env.close();
    // The stored row owns the reference even when the recent Run list no longer carries this message.
    env = open(path);
    expect(env.all().find(row => row.runId === 'r1')).toMatchObject({ references: [reference] });
    env.close();
  });

  it('folds back into a finished turn when something reaches it, and patches an activity in place', async () => {
    const env = open();
    turn(env, 1);
    env.writer.turnStarted('t2', stamp(++tick));
    env.writer.activities.apply({ id: 'claude:c1', kind: 'background_task', status: 'running', title: 'npm test', startedAt: stamp(++tick) });
    commit(env, user('u2', 't2', 'second'));
    env.writer.turnEnded('t2', 'completed', stamp(++tick));
    env.writer.turnStarted('t3', stamp(++tick));
    commit(env, user('u3', 't3', 'third'), answer('a3', 't3', 'on it'));
    await env.ready();
    // Late: a new version of turn 1's tool card, and the activity of turn 2 finishing.
    commit(env, tool('k1', 't1', 'call-1', 'failed'));
    env.writer.activities.apply({ id: 'claude:c1', kind: 'background_task', status: 'completed', title: 'npm test', startedAt: stamp(tick), endedAt: stamp(++tick) });
    await env.ready();
    const rows = env.all();
    expect(rows.find(row => row.key === 'tool:call-1')?.event.data.status).toBe('failed');
    expect(rows.find(row => row.kind === 'activity')).toMatchObject({ activity: { status: 'completed' } });
    expect(withoutSeq(rows)).toEqual(foldedFromScratch(env));
    env.close();
  });

  it('keeps a compaction Claude logged before its `/compact` when the window moves to that command', async () => {
    const env = open();
    turn(env, 1);
    // Claude 2.1.322: the compaction (its hook, boundary, summary) is logged before the command, which keeps when it was typed.
    const typed = stamp(++tick);
    env.writer.activities.apply({ id: 'claude:compaction:c1', kind: 'compaction', status: 'running', title: 'compact', startedAt: stamp(++tick), compaction: { trigger: 'manual' } });
    env.writer.activities.apply({ id: 'claude:compaction:c1', kind: 'compaction', status: 'completed', title: 'compact', startedAt: stamp(tick), endedAt: stamp(++tick), compaction: { trigger: 'manual' } });
    env.writer.turnStarted('t2', typed);
    commit(env, { ...user('u2', 't2', '/compact'), createdAt: typed });
    env.writer.turnEnded('t2', 'completed', stamp(++tick));
    await env.ready();
    const rows = env.all();
    expect(rows.slice(-2).map(row => [row.kind, row.turn])).toEqual([['user', 'native:session-1:t2'], ['activity', 'native:session-1:t2']]);
    expect(withoutSeq(rows)).toEqual(foldedFromScratch(env));
    env.close();
  });

  it('drops the rows of a cold session, and refolds them from the journal under another generation', async () => {
    let env = open(join(dir, 'state.db'), { idleSince: stamp(0) });
    for (let index = 1; index <= 3; index += 1) turn(env, index);
    const before = await env.ready();
    const rows = withoutSeq(env.all());
    const now = Date.now() + 8 * 86_400_000;
    // A lane held in memory is kept; after a restart nothing holds it and it is dropped.
    expect(await env.service.sweepCold(now)).toBe(0);
    env.close();
    env = open(join(dir, 'state.db'), { idleSince: stamp(0) });
    expect(await env.service.sweepCold(now)).toBe(1);
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM timeline_rows').get()).toEqual({ n: 0 });
    env.close();

    env = open(join(dir, 'state.db'), { idleSince: stamp(0) });
    const after = await env.ready();
    expect(after.generation).not.toBe(before.generation);
    expect(withoutSeq(env.all())).toEqual(rows);
    expect(env.service.changes(S, 'main', { generation: before.generation, after: before.headSeq }).mode).toBe('snapshot');
    expect(env.service.changes(S, 'main', { generation: after.generation, after: after.headSeq }).mode).toBe('delta');
    env.close();
  });

  it('drops both main and subagent lanes when cold, and refolds main with persisted subagent summaries intact', async () => {
    let env = open(join(dir, 'state.db'), { idleSince: stamp(0) });
    const now = Date.now() + 8 * 86_400_000;
    expect(await env.service.sweepCold(now)).toBe(0); // nothing folded yet
    env.writer.turnStarted('t1', stamp(++tick));
    commit(env, user('u1', 't1', 'review'), tool('k1', 't1', 'task-1', 'in_progress'));
    const child = env.writer.child('task-1', 'agent-7');
    child.turnStarted('c1', stamp(++tick));
    child.commit({ events: [answer('c-a1', 'c1', 'looking'), tool('c-t1', 'c1', 'sh-1', 'failed', { content: [{ type: 'diff', path: '/repo/a.ts', oldText: 'one', newText: 'two', observed: true }] })], cursor: '1' });
    child.turnEnded('c1', 'completed', stamp(++tick));
    env.writer.commit({ events: [tool('k1', 't1', 'task-1', 'completed')], cursor: '2' });
    env.writer.turnEnded('t1', 'completed', stamp(++tick));
    await env.ready('sub:task-1');
    const before = await env.ready();
    const parent = () => withoutSeq(env.all()).find(row => row.kind === 'tool' && row.event.data.toolCallId === 'task-1');
    const summary = parent();
    expect(summary).toMatchObject({ subagent: { rows: 2, changes: [{ path: '/repo/a.ts' }] } });
    env.close();

    env = open(join(dir, 'state.db'), { idleSince: stamp(0) });
    expect(await env.service.sweepCold(now)).toBe(1);
    // Both main and subagent lanes are cold-dropped; the subagent summary persists on its head.
    expect(env.db.prepare("SELECT COUNT(*) AS n FROM timeline_rows WHERE lane='main'").get()).toEqual({ n: 0 });
    expect(env.db.prepare("SELECT COUNT(*) AS n FROM timeline_rows WHERE lane='sub:task-1'").get()).toEqual({ n: 0 });
    env.close();

    env = open(join(dir, 'state.db'), { idleSince: stamp(0) });
    const after = await env.ready();
    expect(after.generation).not.toBe(before.generation);
    expect(parent()).toEqual(summary);
    env.close();
  });

  it('evicts the oldest idle sessions when folded timeline rows exceed the byte quota, even within the TTL window', async () => {
    const dbPath = join(dir, 'quota.db');
    const activities = new Map<string, { at: string; running: boolean }>([
      ['s-old', { at: stamp(1), running: false }],
      ['s-mid', { at: stamp(2), running: false }],
      ['s-new', { at: stamp(3), running: false }],
    ]);
    let env = open(dbPath, { activity: id => activities.get(id) });
    const seed = async (id: string, body: string) => {
      const w = JournalLaneWriter.open(env.journal, id);
      w.turnStarted('t1', stamp(++tick));
      w.commit({ events: [user('u1', 't1', 'q'), answer('a1', 't1', body)], cursor: '1' });
      w.turnEnded('t1', 'completed', stamp(++tick));
      await env.service.ready(id, 'main');
    };
    const body = 'x'.repeat(2000);
    await seed('s-old', body);
    await seed('s-mid', body);
    await seed('s-new', body);
    const perSession = (env.db.prepare("SELECT SUM(bytes) AS b FROM timeline_rows WHERE session_id='s-old'").get() as { b: number }).b;
    expect(perSession).toBeGreaterThan(1500);
    env.close();

    // Reopen with nothing held in memory; now is well within coldTimelineDays, yet quota forces LRU eviction of oldest first.
    env = open(dbPath, { activity: id => activities.get(id) });
    const dropped = await env.service.sweepCold(Date.now(), Math.floor(perSession * 1.5));
    expect(dropped).toBe(2);
    expect(env.db.prepare("SELECT COUNT(*) AS n FROM timeline_rows WHERE session_id='s-old'").get()).toEqual({ n: 0 });
    expect(env.db.prepare("SELECT COUNT(*) AS n FROM timeline_rows WHERE session_id='s-mid'").get()).toEqual({ n: 0 });
    expect((env.db.prepare("SELECT COUNT(*) AS n FROM timeline_rows WHERE session_id='s-new'").get() as { n: number }).n).toBeGreaterThan(0);
    env.close();
  });

  it('changes generation only when the log is rebuilt, a scratch window is promoted, or the fold rules change', async () => {
    let env = open();
    turn(env, 1);
    const first = await env.ready();
    env.listen();
    commit(env, answer('a9', 't1', 'more'));
    expect((await env.ready()).generation).toBe(first.generation);
    env.writer.rebuild('identity-changed');
    turn(env, 2);
    const rebuilt = await env.ready();
    expect(rebuilt.generation).not.toBe(first.generation);
    expect(env.frames.filter(frame => frame.type === 'reset')).toEqual([{ type: 'reset', generation: rebuilt.generation, reason: 'rebuilt' }]);
    expect(env.all().map(row => row.seq)).toEqual(env.all().map((_, index) => index + 1));
    env.close();

    // A fold rule change: the lane's rows were folded under another FOLD_VERSION.
    env = open();
    env.db.prepare("UPDATE timeline_heads SET generation='old', fold_version=0 WHERE session_id=?").run(S);
    env.listen();
    const refolded = await env.ready();
    expect(refolded.generation).not.toBe(rebuilt.generation); // every rebuild moves the epoch: a generation is never issued twice
    expect(env.frames).toEqual([{ type: 'reset', generation: refolded.generation, reason: 'fold' }]);
    env.close();

    // A first import served from a scratch tail, then promoted: one more generation, once.
    env = open(join(dir, 'scratch.db'));
    const scratch = env.writer.openScratch();
    scratch.commit({ events: [user('u2', 't2', 'tail question')], cursor: 'tail' });
    const tail = await env.ready();
    env.listen();
    commit(env, user('u1', 't1', 'old question'), user('u2', 't2', 'tail question'));
    expect((await env.ready()).generation).toBe(tail.generation);
    env.writer.promote();
    const promoted = await env.ready();
    expect(promoted.generation).not.toBe(tail.generation);
    expect(env.frames).toEqual([{ type: 'reset', generation: promoted.generation, reason: 'promoted' }]);
    expect(env.all().map(row => row.kind === 'user' && row.text)).toEqual(['old question', 'tail question']);
    env.close();
  });

  it('defers folding an empty rebuilt log and holds reset until multi-step refold catches up', async () => {
    const env = open(undefined, { stepRows: 2, rebuildSettleMs: 120 });
    turn(env, 1);
    await env.ready();
    env.listen();

    // Rebuilding empties the log before the source asynchronously writes replacement turns.
    env.writer.rebuild('identity-changed');
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(env.frames).toEqual([]);

    // Re-import writes multiple turns; with stepRows=2, folding takes multiple turns of the event loop,
    // and clients receive one `reset` only after every replacement row is folded (never an empty/partial snapshot).
    let rowsAtReset = -1;
    const stop = env.service.subscribe(S, 'main', change => {
      if (change.type === 'reset') rowsAtReset = env.all().length;
    });
    turn(env, 2);
    turn(env, 3);
    const rebuilt = await env.ready();
    stop();
    expect(env.frames).toEqual([{ type: 'reset', generation: rebuilt.generation, reason: 'rebuilt' }]);
    expect(rowsAtReset).toBe(env.all().length);
    expect(rowsAtReset).toBeGreaterThanOrEqual(4);

    // A rebuild that genuinely stays empty still emits `reset` once the grace window elapses.
    env.frames.length = 0;
    env.writer.rebuild('identity-changed');
    await new Promise(resolve => setTimeout(resolve, 180));
    expect(env.frames).toEqual([{ type: 'reset', generation: env.service.head(S, 'main')!.generation, reason: 'rebuilt' }]);
    expect(env.all()).toEqual([]);
    env.close();
  });

  it('files a run the transcript has not echoed after every row, and moves that row in place when the echo arrives', async () => {
    const env = open();
    turn(env, 1);
    await env.ready();
    env.listen();
    env.setRun(nativeRun('r2', 'queued', 'follow up', { delivery: 'queued' }));
    await new Promise(resolve => setTimeout(resolve, 30));
    const pending = env.all().at(-1)!;
    expect(pending).toMatchObject({ key: 'user:cmd-r2', kind: 'user', pending: 'queued', pos: PENDING_ROW_POS, runId: 'r2' });
    env.setRun(nativeRun('r2', 'running', 'follow up', { nativeMessageId: 'u2', nativeSessionId: 'chat-1', nativeTurnId: 't2' }));
    env.writer.turnStarted('t2', stamp(++tick), 'r2');
    commit(env, user('u2', 't2', 'follow up'));
    await new Promise(resolve => setTimeout(resolve, 30));
    const head = await env.ready();
    const echoed = env.all().find(row => row.key === 'user:cmd-r2')!;
    expect(echoed.pos).toBeLessThan(PENDING_ROW_POS);
    expect(echoed).not.toHaveProperty('pending');
    expect(echoed.rev).toBeGreaterThan(pending.rev);
    expect(env.frames.flatMap(frame => frame.type === 'rows' ? frame.deletes : [])).toEqual([]);
    expect(env.all().filter(row => row.kind === 'user')).toHaveLength(2);
    expectContiguous(env.frames, head.headSeq, pending.seq);
    env.close();
  });

  it('keeps a row within budget: long text as a preview with the whole row in a blob, tool output cut, images as blob URLs', async () => {
    const env = open();
    const long = 'x'.repeat(40 * 1024);
    env.writer.turnStarted('t1', stamp(++tick));
    commit(env,
      user('u1', 't1', 'go'),
      answer('a1', 't1', long),
      tool('k1', 't1', 'call-1', 'completed', { content: [{ type: 'content', content: { type: 'text', text: 'y'.repeat(40 * 1024) } }] }),
      ev('i1', 'agent_message_chunk', { content: { type: 'image', data: Buffer.from('png-bytes').toString('base64'), mimeType: 'image/png' } }, 't1'),
    );
    await env.ready();
    const rows = env.all();
    for (const row of rows) expect(Buffer.byteLength(JSON.stringify(row))).toBeLessThanOrEqual(SYNC_BUDGET.rowBytes);
    const text = rows.find(row => row.key === 'event:a1') as Extract<TimelineRow, { kind: 'assistant' }>;
    expect(Buffer.byteLength(text.text)).toBe(SYNC_BUDGET.previewBytes);
    // Truncated journal-backed rows are expanded on demand without duplicating full row JSON into `blobs`.
    expect(env.journal.getBlob(text.truncated!.blobRef)).toBeUndefined();
    const blob = env.journal.sessionBlob(S, text.truncated!.blobRef)!;
    expect(JSON.parse(blob.bytes().toString('utf8')).text).toBe(long);
    const output = rows.find(row => row.key === 'tool:call-1')!;
    expect(Buffer.byteLength(JSON.stringify(output.event.data))).toBeLessThan(SYNC_BUDGET.toolOutputBytes + 1024);
    expect(output.truncated).toBeDefined();
    expect(env.journal.getBlob(output.truncated!.blobRef)).toBeUndefined();
    expect(JSON.parse(env.journal.sessionBlob(S, output.truncated!.blobRef)!.bytes().toString('utf8')).event.data.content[0].content.text).toBe('y'.repeat(40 * 1024));
    const image = rows.find(row => row.kind === 'image') as Extract<TimelineRow, { kind: 'image' }>;
    const hash = image.src.split('/').at(-1)!;
    expect(image.src).toBe(`/api/sessions/${S}/blobs/${hash}`);
    expect(env.journal.sessionBlob(S, hash)?.bytes().toString()).toBe('png-bytes');
    expect(JSON.stringify(image.event.data)).not.toContain(Buffer.from('png-bytes').toString('base64'));
    // A cut row that changes invalidates its old truncated hash and expands to the new content, while images stay persisted.
    commit(env, answer('a1', 't1', `${long}more`));
    await env.ready();
    const next = env.all().find(row => row.key === 'event:a1')!;
    expect(next.truncated!.blobRef).not.toBe(text.truncated!.blobRef);
    expect(env.journal.sessionBlob(S, text.truncated!.blobRef)).toBeUndefined();
    expect(env.journal.getBlob(text.truncated!.blobRef)).toBeUndefined();
    expect(JSON.parse(env.journal.sessionBlob(S, next.truncated!.blobRef)!.bytes().toString('utf8')).text).toBe(`${long}more`);
    expect(env.journal.sessionBlob(S, hash)?.bytes().toString()).toBe('png-bytes');
    env.close();
  });

  it('folds a burst of run and job changes once, after the debounce', async () => {
    const env = open(undefined, { debounceMs: 40 });
    env.writer.turnStarted('t1', stamp(++tick));
    commit(env, user('u1', 't1', 'run the suite'), tool('k1', 't1', 'bash-1', 'in_progress'));
    const head = await env.ready();
    env.listen();
    await env.ready();
    for (const status of ['running', 'succeeded'] as const) env.setJob({ toolCallId: 'bash-1', title: 'npm test', command: 'npm test', status });
    env.setRun(nativeRun('r2', 'queued', 'a', { delivery: 'queued' }));
    env.setRun(nativeRun('r3', 'queued', 'b', { delivery: 'queued' }));
    await new Promise(resolve => setTimeout(resolve, 15));
    expect(env.frames).toEqual([]);
    await new Promise(resolve => setTimeout(resolve, 60));
    const rows = env.frames.filter(frame => frame.type === 'rows');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ from: head.headSeq + 1 });
    expect(env.all().find(row => row.key === 'tool:bash-1')).toMatchObject({ job: { status: 'succeeded' } });
    expect(env.all().filter(row => row.kind === 'user' && row.pending === 'queued')).toHaveLength(2);
    env.close();
  });

  it('summarises a subagent lane on its tool row, including a resumed execution after the parent was frozen and restarted', async () => {
    let env = open(undefined, { debounceMs: 5 });
    env.writer.turnStarted('t1', stamp(++tick));
    commit(env, user('u1', 't1', 'review'), tool('k1', 't1', 'task-1', 'in_progress'));
    let child = env.writer.child('task-1', 'agent-7');
    const startedAt = stamp(++tick);
    child.turnStarted('c1', startedAt);
    env.writer.activities.apply({ id: 'claude:agent-7', kind: 'background_task', status: 'running', title: 'review', toolCallId: 'task-1', task: { kind: 'agent' }, startedAt, stop: { via: 'session' } });
    // A failed command that was seen changing a file: the change counts toward the parent row's summary.
    const changed = tool('c-t1', 'c1', 'sh-1', 'failed', { content: [{ type: 'diff', path: '/repo/a.ts', oldText: 'one\ntwo', newText: 'one\nTWO\nthree', observed: true }] });
    child.commit({ events: [answer('c-a1', 'c1', 'looking'), changed, answer('c-a2', 'c1', 'found it')], cursor: '1' });
    await env.ready('sub:task-1');
    await env.ready();
    expect(env.all().find(row => row.key === 'tool:task-1')).toMatchObject({
      subagent: { lane: 'sub:task-1', agentId: 'agent-7', turnId: 'c1', status: 'running', startedAt, running: true, rows: 3, changes: [{ path: '/repo/a.ts', added: 2, removed: 1, created: false }] },
      activity: { id: 'claude:agent-7', status: 'running', stop: { via: 'session' } },
    });
    expect(env.service.outline(S, 'main').turns[0]).toMatchObject({ hasUserMessage: true, hasAttachments: false });
    expect(env.service.outline(S, 'sub:task-1').turns[0]).toMatchObject({ hasUserMessage: false, hasAttachments: false });
    expect(withoutSeq(env.all('sub:task-1'))).toEqual(foldedFromScratch(env, 'sub:task-1'));

    const failedAt = stamp(++tick);
    child.turnEnded('c1', 'failed', failedAt);
    env.writer.activities.apply({ id: 'claude:agent-7', kind: 'background_task', status: 'failed', title: 'review', endedAt: failedAt });
    env.writer.turnEnded('t1', 'completed', stamp(++tick));
    turn(env, 2); // The parent tool now lives before the fold's open window.
    await env.ready('sub:task-1');
    await env.ready();
    expect(env.all().find(row => row.key === 'tool:task-1')).toMatchObject({ subagent: { status: 'failed', running: false }, activity: { status: 'failed' } });
    env.close();

    env = open();
    await env.ready();
    child = env.writer.child('task-1', 'agent-7');
    const resumedAt = stamp(++tick);
    child.turnStarted('c2', resumedAt); // No visible child rows yet: the start alone must update the parent.
    child.commit({ events: [answer('late-c1', 'c1', 'late old result')], cursor: '2' });
    await env.ready('sub:task-1');
    await env.ready();
    const resumed = env.all().find(row => row.key === 'tool:task-1');
    expect(resumed).toMatchObject({ subagent: { turnId: 'c2', status: 'running', startedAt: resumedAt, running: true, rows: 5 } });
    expect(resumed).toMatchObject({ activity: { id: 'claude:agent-7', status: 'failed', endedAt: failedAt } }); // The link retains the actual activity; a wake must not invent a live one.
    child.turnEnded('c2', 'completed', stamp(++tick));
    await env.ready('sub:task-1');
    await env.ready();
    expect(env.all().find(row => row.key === 'tool:task-1')).toMatchObject({ subagent: { turnId: 'c2', status: 'completed', running: false } });
    // Retract only a disproven binding/activity, retaining the actual tool and stored child history.
    env.writer.commit({ events: [], retire: [subagentMetaId('task-1'), 'claude:agent-7'], cursor: env.writer.cursor });
    await env.ready();
    expect(env.all().find(row => row.key === 'tool:task-1')).not.toHaveProperty('subagent');
    expect(env.all().find(row => row.key === 'tool:task-1')).not.toHaveProperty('activity');
    env.close();
    env = open();
    await env.ready();
    expect(env.all().find(row => row.key === 'tool:task-1')).not.toHaveProperty('subagent');
    expect(env.all().find(row => row.key === 'tool:task-1')).not.toHaveProperty('activity');
    env.writer.child('task-1', 'agent-7'); // Later authoritative metadata can establish the binding again.
    env.writer.activities.apply({ id: 'claude:agent-7', kind: 'background_task', status: 'completed', title: 'review', toolCallId: 'task-1', task: { kind: 'agent' }, startedAt, endedAt: stamp(++tick) });
    await env.ready();
    expect(env.all().find(row => row.key === 'tool:task-1')).toHaveProperty('subagent');
    env.close();
    env = open();
    await env.ready();
    expect(env.all().find(row => row.key === 'tool:task-1')).toHaveProperty('subagent');
    expect(env.all().find(row => row.key === 'tool:task-1')).toHaveProperty('activity');
    env.close();
  });

  it('links a shell background task to the tool row that started it, including after that row was frozen', async () => {
    const env = open();
    env.writer.turnStarted('t1', stamp(++tick));
    commit(env, user('u1', 't1', 'serve'), tool('k1', 't1', 'bash-1', 'completed'));
    const task = { id: 'claude:bg-1', kind: 'background_task', title: 'npm run dev', toolCallId: 'bash-1', task: { kind: 'shell', command: 'npm run dev' }, startedAt: stamp(++tick), stop: { via: 'protocol' } } as const;
    env.writer.activities.apply({ ...task, status: 'running' });
    await env.ready();
    const linked = env.all().find(row => row.key === 'tool:bash-1');
    expect(linked).toMatchObject({ activity: { id: 'claude:bg-1', status: 'running' } });
    expect(linked).not.toHaveProperty('subagent');
    env.writer.turnEnded('t1', 'completed', stamp(++tick));
    turn(env, 2); // The tool row now lives before the fold's open window.
    await env.ready();
    env.writer.activities.apply({ ...task, status: 'completed', endedAt: stamp(++tick) });
    await env.ready();
    const rows = env.all();
    expect(rows.find(row => row.key === 'tool:bash-1')).toMatchObject({ activity: { id: 'claude:bg-1', status: 'completed' } });
    // Its own row stays: a client hides it only while the linked tool row is loaded.
    expect(rows.find(row => row.kind === 'activity')).toMatchObject({ activity: { id: 'claude:bg-1', status: 'completed' } });
    env.close();
  });

  it('pages by place and cuts a snapshot into frames read one at a time', async () => {
    const env = open();
    for (let index = 1; index <= 40; index += 1) turn(env, index);
    const head = await env.ready();
    const all = env.all();
    // More changes than twice the budget: a snapshot of the newest rows instead of a delta.
    expect(env.service.changes(S, 'main', { generation: head.generation, after: 0, rows: 50 })).toMatchObject({ mode: 'snapshot', rows: all.slice(-50), hasBefore: true });
    expect(env.service.changes(S, 'main', { generation: head.generation, after: head.headSeq - 3, rows: 50 })).toMatchObject({ mode: 'delta', from: head.headSeq - 2, to: head.headSeq });
    const snapshot = env.service.snapshot(S, 'main', { rows: 50 });
    const parts = [...snapshot.parts()];
    expect(parts.at(-1)!.final).toBe(true);
    expect(parts.flatMap(part => part.rows)).toEqual(all.slice(-50));
    expect(snapshot.hasBefore).toBe(true);
    const page = env.service.page(S, 'main', { before: all.at(-50)!.pos, rows: 10 });
    expect(page.rows).toEqual(all.slice(-60, -50));
    expect(page).toMatchObject({ hasBefore: true, hasAfter: true });
    const around = env.service.page(S, 'main', { around: all[20]!.pos, rows: 10 });
    expect(around.rows).toEqual(all.slice(15, 25));
    env.close();
  });

  it('finds a query across the whole lane in place order, by what each row shows, and follows the lane as it changes', async () => {
    const env = open();
    for (let index = 1; index <= 30; index += 1) turn(env, index);
    env.writer.turnStarted('t31', stamp(++tick));
    commit(env, user('u31', 't31', 'Where is NEEDLE?'), answer('a31', 't31', '**Needle** one, `needle` two'),
      tool('k31', 't31', 'call-31', 'completed', { title: 'Read /work/app/needle.ts', locations: [{ path: '/work/app/needle.ts' }] }));
    env.writer.turnEnded('t31', 'completed', stamp(++tick));
    const head = await env.ready();
    const found = await env.service.find(S, 'main', 'needle', '/work/app');
    expect(found).toMatchObject({ generation: head.generation, headSeq: head.headSeq, total: 4 });
    expect(found.hits.map(hit => hit.count)).toEqual([1, 2, 1]);
    expect(found.hits.map(hit => hit.pos)).toEqual([...found.hits.map(hit => hit.pos)].sort((a, b) => a - b));
    // Markdown syntax is not what the page shows, and a path shows under the project root.
    expect((await env.service.find(S, 'main', '**needle', '/work/app')).total).toBe(0);
    expect((await env.service.find(S, 'main', '/work/app', '/work/app')).total).toBe(0);
    expect((await env.service.find(S, 'main', '   ')).hits).toEqual([]);
    // A hit far from the newest rows is reached by paging around its place.
    const early = await env.service.find(S, 'main', 'question 2');
    expect(early.hits.length).toBeGreaterThan(1);
    expect(env.service.page(S, 'main', { around: early.hits[0]!.pos, rows: 10 }).rows.some(row => row.key === early.hits[0]!.key)).toBe(true);
    // Rows added since the last find are counted on the next.
    env.writer.turnStarted('t32', stamp(++tick));
    commit(env, user('u32', 't32', 'needle again'));
    env.writer.turnEnded('t32', 'completed', stamp(++tick));
    await env.ready();
    expect((await env.service.find(S, 'main', 'NEEDLE', '/work/app')).total).toBe(5);
    env.close();
  });
});
