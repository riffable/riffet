import { describe, expect, it, vi } from 'vitest';
import type { CouncilDiscussion, CouncilSeat, TimelineRow } from '../../../../packages/contracts/src/index.js';
import { Store } from '../store.js';
import { AgentSeats, type SeatDriver, type SeatTurn } from './seats.js';
import { CouncilService } from './service.js';
import { parseJsonObject } from './directive.js';
import { councilAwaitsReader } from '../../../../packages/contracts/src/index.js';

const agent = (model: string) => ({ backendId: 'claude' as const, profileId: 'default', model });
const profileName = () => 'Claude Code';

/**
 * Seat conversations in memory. Each turn's answer comes from `answer(seat, text)`; a turn can be held until `gate`
 * resolves. Records what each seat was sent, what was stopped and what was removed.
 */
function fakeSeats(answer: (seat: CouncilSeat, text: string) => string | Error, gate?: (seat: CouncilSeat, text: string) => Promise<void> | undefined) {
  const sent: Array<{ seatId: string; sessionId: string; runId: string; text: string }> = [];
  const stopped: string[] = [];
  const removed: string[] = [];
  const cancelled: string[] = [];
  const pending = new Map<string, Promise<SeatTurn>>();
  const opened = new Map<string, number>();
  let n = 0;
  const driver: SeatDriver = {
    async send(_d, seat, text) {
      // A seat's first conversation is `session-<seat>`; one opened after it (a swap, a reopen) gets a number.
      const opens = seat.sessionId ? 0 : (opened.get(seat.id) ?? 0) + 1;
      if (opens) opened.set(seat.id, opens);
      const sessionId = seat.sessionId ?? (opens > 1 ? `session-${seat.id}-${opens}` : `session-${seat.id}`);
      const runId = `run-${n += 1}`;
      sent.push({ seatId: seat.id, sessionId, runId, text });
      pending.set(runId, (async () => {
        await gate?.(seat, text);
        const out = answer(seat, text);
        return out instanceof Error ? { status: 'failed', text: '', error: out.message } : { status: 'done', text: out };
      })());
      return { sessionId, runId };
    },
    settle: (_sessionId, runId, signal) => Promise.race([
      pending.get(runId)!,
      new Promise<SeatTurn>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
    ]),
    stop: (_sessionId, runId) => { stopped.push(runId); },
    stopAll: sessionId => { cancelled.push(sessionId); },
    prompt: (_id, runId) => sent.find(turn => turn.runId === runId)?.text,
    sessionOf: (_id, runId) => sent.find(turn => turn.runId === runId)?.sessionId,
    watch: () => () => {},
    rows: async () => [],
    alive: sessionId => !removed.includes(sessionId),
    remove: async sessionId => { removed.push(sessionId); },
  };
  return { driver, sent, stopped, removed, cancelled };
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('never happened');
}

async function settled(service: CouncilService, id: string): Promise<CouncilDiscussion> {
  for (let i = 0; i < 200; i += 1) {
    const d = service.get(id);
    if (d.status !== 'running') return d;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('still running');
}

const LEDGER = '{"sides":{"pro":{"claim":"A"},"con":{"claim":"B"}},"crossExam":[{"asker":"pro","question":"Why?","answered":"dodged"}],"intensity":"clashing","action":"continue"}';

describe('CouncilService', () => {
  it('reads process rows from the original archived seat session and only for that run’s discussion', async () => {
    const store = new Store(':memory:');
    try {
      const project = store.createProject('/tmp/council', 'Council');
      const origin = { kind: 'council', groupId: 'discussion-1' } as const;
      const original = store.createSession({ projectId: project.id, kind: 'native', origin });
      const originalPrompt = '  Prompt\nSecond line\n';
      const run = store.createRun(original.id, 'command', originalPrompt);
      store.updateSession(original.id, { archivedAt: run.createdAt });
      const event = { type: 'agent_thought_chunk', data: {}, sourceIds: [], createdAt: run.createdAt, lastAt: run.createdAt };
      const thought: TimelineRow = { kind: 'thought', text: 'Process', channel: 'thinking', key: 'thought', pos: 20, turn: 'turn', seq: 2, rev: 1, event };
      const user: TimelineRow = { ...thought, kind: 'user', key: 'user', pos: 10, text: 'Prompt', attachments: [] };
      const ready = vi.fn(async () => ({ generation: 'g1', headSeq: 2 }));
      const seats = new AgentSeats({
        store,
        project: () => project,
        orchestration: { start: vi.fn(), message: vi.fn() },
        launch: vi.fn(),
        cancel: vi.fn(),
        delete: vi.fn(),
        timeline: {
          ready,
          outline: () => ({ generation: 'g1', turnCount: 1, turns: [{ turn: 'turn', turnId: 'turn', startPos: 10, status: 'completed', rows: 2, runId: run.id, at: run.createdAt }] }),
          page: () => ({ generation: 'g1', hasBefore: false, hasAfter: false, rows: [user, thought] }),
          subscribe: () => () => {},
          turnText: () => undefined,
        },
      });
      expect(seats.prompt('discussion-1', run.id)).toBe(originalPrompt);
      expect(seats.prompt('discussion-2', run.id)).toBeUndefined();
      expect(seats.prompt('discussion-1', 'missing-run')).toBeUndefined();
      await expect(seats.rows('discussion-2', run.id)).resolves.toEqual([]);
      expect(ready).not.toHaveBeenCalled();
      await expect(seats.rows('discussion-1', run.id)).resolves.toEqual([thought]);
      expect(ready).toHaveBeenCalledWith(original.id, 'main');
    } finally {
      store.close();
    }
  });

  it('runs an LD debate turn by turn, tells each seat only what is new, and records the ledger in a turn of its own', async () => {
    const seats = fakeSeats((seat, text) => text.includes('"crossExam"') ? LEDGER : `${seat.id} speaks.`);
    const service = new CouncilService({ db: new Store(':memory:').db, seats: seats.driver, profileName });
    const created = service.create({
      format: 'ld', topic: 'Resolution', maxRounds: 2, rhythm: 'pause',
      seats: [{ role: 'pro', model: agent('a') }, { role: 'con', model: agent('b') }, { role: 'judge', model: agent('c') }],
    });

    let d = await settled(service, created.id);
    expect(d.status).toBe('paused');
    expect(d.speeches.map(s => `${s.seatId}:${s.phase}`)).toEqual(['pro:opening', 'con:opening', 'judge:ledger']);
    expect(d.speeches[2]).toMatchObject({ text: 'judge speaks.', directive: { kind: 'ledger', crossExam: [{ answered: 'dodged' }] } });
    expect(d.seats.map(seat => seat.sessionId)).toEqual(['session-pro', 'session-con', 'session-judge']);
    // The judge's notes are a turn after its speech, in the same conversation.
    expect(seats.sent.map(turn => turn.seatId)).toEqual(['pro', 'con', 'judge', 'judge']);

    service.continue(created.id);
    d = await settled(service, created.id);
    expect(d.status).toBe('done');
    expect(d.speeches.slice(3).map(s => `${s.seatId}:${s.phase}`)).toEqual(['con:closing', 'pro:closing', 'judge:conclusion']);

    const ledger = d.speeches.find(s => s.phase === 'ledger')!;
    const originals = service.prompts(d.id, ledger.seatId, ledger.id);
    expect(originals.prompt).toBe(seats.sent.find(turn => turn.runId === ledger.runId)?.text);
    expect(originals.record).toBe(seats.sent.find(turn => turn.runId === ledger.recordRunId)!.text);
    const brief = service.prompts(d.id, 'pro').prompt!;
    expect(brief).toContain('辩题：Resolution');
    expect(() => service.prompts(d.id, 'con', ledger.id)).toThrow('Speech not found');

    const toPro = seats.sent.filter(turn => turn.seatId === 'pro');
    // The first turn opens with the brief; the next carries only what was said since, once each.
    expect(toPro[0]!.text).toContain(brief);
    expect(toPro[1]!.text).not.toContain(brief);
    expect(toPro[1]!.text.match(/con speaks\./g)).toHaveLength(2);
    expect(toPro[1]!.text).not.toContain('judge speaks.');
    // The question PRO asked and the judge counts as dodged is put to CON again.
    expect(seats.sent.filter(turn => turn.seatId === 'con')[1]!.text).toContain('- Why?');
    service.close();
  });

  it('skips a failed speech and goes on, and fails only when a whole step fails', async () => {
    const seats = fakeSeats((seat, text) => {
      if (text.includes('"positions"')) return '{"positions":[{"seatId":"s1","stance":"Supports the proposal."}]}';
      return seat.id === 's2' ? new Error('gateway down') : 'Statement.';
    });
    const service = new CouncilService({ db: new Store(':memory:').db, seats: seats.driver, profileName });
    const created = service.create({
      format: 'roundtable', topic: 'Topic', maxRounds: 2, rhythm: 'pause',
      seats: [{ role: 'debater', model: agent('a') }, { role: 'debater', model: agent('a') }, { role: 'moderator', model: agent('c') }],
    });
    const d = await settled(service, created.id);
    expect(d.status).toBe('paused');
    expect(d.speeches.find(s => s.seatId === 's2')).toMatchObject({ status: 'failed', error: 'gateway down' });
    expect(d.speeches.find(s => s.phase === 'summary')).toMatchObject({
      status: 'done', directive: { kind: 'moderation', positions: [{ seatId: 's1', stance: 'Supports the proposal.' }] },
    });
    const [summary, record] = seats.sent.filter(turn => turn.seatId === 'mod');
    expect(summary?.text).toContain('a #1');
    expect(summary?.text).toContain('a #2');
    expect(summary?.text).not.toMatch(/\bs[12]\b/);
    expect(record?.text).toContain('- s1：a #1\n- s2：a #2');

    const failing = new CouncilService({ db: new Store(':memory:').db, seats: fakeSeats(() => new Error('no login')).driver, profileName });
    const all = failing.create({
      format: 'prism', topic: 'Q',
      seats: [{ role: 'participant', model: agent('a') }, { role: 'participant', model: agent('b') }, { role: 'observer', model: agent('c') }],
    });
    expect(await settled(failing, all.id)).toMatchObject({ status: 'failed', error: 'no login' });
    service.close();
    failing.close();
  });

  it.each(['stop', 'restart'] as const)('recovers an unfinished judge record after a %s before advancing', async (interruption) => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const isRecord = (text: string) => text.includes('"crossExam"');
    const seats = fakeSeats((_seat, text) => isRecord(text) ? LEDGER : 'Speech.', (_seat, text) => isRecord(text) ? held : undefined);
    const store = new Store(':memory:');
    const deps = { db: store.db, seats: seats.driver, profileName };
    let service = new CouncilService(deps);
    try {
      const { id } = service.create({
        format: 'ld', topic: 'Q', maxRounds: 2, rhythm: 'pause',
        seats: [{ role: 'pro', model: agent('a') }, { role: 'con', model: agent('b') }, { role: 'judge', model: agent('c') }],
      });
      await vi.waitFor(() => expect(service.get(id).speeches.at(-1)?.recordRunId).toBeTruthy());
      if (interruption === 'restart') {
        service.close();
        service = new CouncilService(deps);
      } else {
        service.stop(id);
      }
      expect(service.get(id).speeches.at(-1)).toMatchObject({ phase: 'ledger', status: 'stopped' });
      release();
      service.continue(id);
      const resumed = await settled(service, id);
      expect(resumed).toMatchObject({ status: 'paused', round: 1 });
      expect(resumed.speeches.at(-1)).toMatchObject({ phase: 'ledger', status: 'done', directive: { kind: 'ledger' } });
      expect(seats.sent.filter(turn => isRecord(turn.text))).toHaveLength(2);
    } finally {
      release();
      service.close();
      store.close();
    }
  });

  it('honors the moderator’s follow-up at consensus and accepts a consensus record without an action', async () => {
    let summaries = 0;
    const seats = fakeSeats((seat, text) => {
      if (seat.role !== 'moderator' || !text.includes('"positions"')) return 'A contribution.';
      return JSON.stringify({ convergence: 'consensus', action: ++summaries === 1 ? 'continue' : undefined });
    });
    const store = new Store(':memory:');
    const service = new CouncilService({ db: store.db, seats: seats.driver, profileName });
    try {
      const { id } = service.create({
        format: 'roundtable', topic: 'Q', maxRounds: 4, rhythm: 'auto',
        seats: [{ role: 'debater', model: agent('a') }, { role: 'debater', model: agent('b') }, { role: 'moderator', model: agent('c') }],
      });
      const discussion = await settled(service, id);
      expect(discussion.status).toBe('done');
      expect(discussion.speeches.filter(s => s.phase === 'summary').map(s => s.round)).toEqual([1, 2]);
    } finally {
      service.close();
      store.close();
    }
  });

  it('keeps same-round answers private when a roundtable seat resumes, then shares them in the next round', async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const firstAnswer = 'The blue route takes twelve minutes.';
    const seats = fakeSeats(seat => seat.id === 's1' ? firstAnswer : 'Another view.', seat => seat.id === 's2' ? held : undefined);
    const store = new Store(':memory:');
    const service = new CouncilService({ db: store.db, seats: seats.driver, profileName });
    try {
      const { id } = service.create({
        format: 'roundtable', topic: 'Which route?', maxRounds: 2, rhythm: 'pause',
        seats: [{ role: 'debater', model: agent('a') }, { role: 'debater', model: agent('b') }, { role: 'moderator', model: agent('c') }],
      });
      await vi.waitFor(() => expect(service.get(id).speeches.find(s => s.seatId === 's1')?.status).toBe('done'));
      service.stop(id);
      release();
      service.continue(id);
      expect((await settled(service, id)).status).toBe('paused');
      const attempts = seats.sent.filter(turn => turn.seatId === 's2');
      expect(attempts).toHaveLength(2);
      for (const attempt of attempts) expect(attempt.text).not.toContain(firstAnswer);
      expect(seats.sent.find(turn => turn.seatId === 'mod')?.text).toContain(firstAnswer);

      service.continue(id);
      expect((await settled(service, id)).status).toBe('done');
      expect(seats.sent.findLast(turn => turn.seatId === 's2')?.text).toContain(firstAnswer);
    } finally {
      release();
      service.close();
      store.close();
    }
  });

  it('stops the seat turns in flight, drops their late answers, reruns them on continue and removes the seats with the discussion', async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let first = true;
    const seats = fakeSeats(() => 'Answer.', () => first ? held : undefined);
    const service = new CouncilService({ db: new Store(':memory:').db, seats: seats.driver, profileName });
    const created = service.create({
      format: 'prism', topic: 'Q', rhythm: 'pause',
      seats: [{ role: 'participant', model: agent('a') }, { role: 'participant', model: agent('b') }, { role: 'observer', model: agent('c') }],
    });
    await new Promise(resolve => setTimeout(resolve, 5));
    const stopped = service.stop(created.id);
    expect(stopped.status).toBe('paused');
    expect(stopped.speeches.map(s => s.status)).toEqual(['stopped', 'stopped']);
    expect(seats.stopped.sort()).toEqual(['run-1', 'run-2']);
    first = false;
    release();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(service.get(created.id).speeches.map(s => s.status)).toEqual(['stopped', 'stopped']);

    service.continue(created.id);
    const d = await settled(service, created.id);
    expect(d.speeches.map(s => `${s.seatId}:${s.phase}:${s.status}`)).toEqual(['p1:explore:done', 'p2:explore:done', 'obs:probe:done']);

    service.delete(created.id);
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(seats.removed.sort()).toEqual(['session-obs', 'session-p1', 'session-p2']);
    service.close();
  });

  it('keeps a speech persisted before its seat is sent, so a restart mid-launch leaves it stopped, and cancels the seats\' turns', async () => {
    const seats = fakeSeats(() => 'Answer.');
    let open!: () => void;
    const gate = new Promise<void>(resolve => { open = resolve; });
    const slow: SeatDriver = { ...seats.driver, send: async (d, seat, text, signal) => { await gate; return seats.driver.send(d, seat, text, signal); } };
    const store = new Store(':memory:');
    const first = new CouncilService({ db: store.db, seats: slow, profileName });
    try {
      const { id } = first.create({ format: 'prism', topic: 'Q', seats: [{ role: 'participant', model: agent('a') }, { role: 'participant', model: agent('b') }, { role: 'observer', model: agent('c') }] });
      first.close();
      const second = new CouncilService({ db: store.db, seats: seats.driver, profileName });
      const d = second.get(id);
      expect(d.status).toBe('paused');
      expect(d.speeches.map(s => s.status)).toEqual(['stopped', 'stopped']);
      expect(councilAwaitsReader(d)).toBe(true);
      second.close();
    } finally {
      open();
      store.close();
    }
  });

  it('cancels on restart the turns its seats left unfinished', async () => {
    const seats = fakeSeats(() => 'Answer.', () => new Promise<void>(() => {}));
    const store = new Store(':memory:');
    const first = new CouncilService({ db: store.db, seats: seats.driver, profileName });
    try {
      const { id } = first.create({ format: 'prism', topic: 'Q', seats: [{ role: 'participant', model: agent('a') }, { role: 'participant', model: agent('b') }, { role: 'observer', model: agent('c') }] });
      await until(() => first.get(id).seats.filter(seat => seat.sessionId).length === 2);
      first.close();
      const second = new CouncilService({ db: store.db, seats: seats.driver, profileName });
      expect(second.get(id).status).toBe('paused');
      expect(seats.cancelled.sort()).toEqual(['session-p1', 'session-p2']);
      second.close();
    } finally {
      store.close();
    }
  });

  it('reads a JSON object whose strings hold a code fence', () => {
    const raw = '{"edits":[{"para":"P1","after":"Use ```js\\ncode\\n``` here"}]}';
    expect(parseJsonObject(raw)).toMatchObject({ edits: [{ para: 'P1' }] });
    expect(parseJsonObject('Notes:\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('marks missing notes, records them again on request and lets a finished review without edits retry', async () => {
    let attempts = 0;
    let hold: Promise<void> | undefined;
    let release = () => {};
    const edits = '{"edits":[{"para":"P1","title":"T","before":"","after":"New."}]}';
    const notes = (text: string) => text.includes('"edits"') && text.includes('JSON');
    const seats = fakeSeats((_seat, text) => notes(text) ? (++attempts === 1 ? 'not json' : edits) : 'Review.', (_seat, text) => notes(text) ? hold : undefined);
    const store = new Store(':memory:');
    const service = new CouncilService({ db: store.db, seats: seats.driver, profileName });
    try {
      const { id } = service.create({ format: 'review', topic: '', document: 'Paragraph one.', rhythm: 'auto', seats: [{ role: 'reviewer', model: agent('a') }, { role: 'editor', model: agent('b') }] });
      let d = await settled(service, id);
      // With no notes there are no edits, so an `auto` review ends without a revision.
      expect(d.status).toBe('done');
      const speech = d.speeches[0]!;
      expect(speech).toMatchObject({ status: 'done', recordError: expect.any(String) });
      expect(() => service.continue(id, 'record', 'nope')).toThrow('Speech not found');

      // Stopped midway, the notes turn leaves the finished discussion finished.
      hold = new Promise<void>(resolve => { release = resolve; });
      service.continue(id, 'record', speech.id);
      expect(service.get(id).status).toBe('done');
      expect(() => service.supplement(id, 'note')).toThrow('ended');
      expect(service.stop(id).status).toBe('done');
      release();
      hold = undefined;

      service.continue(id, 'record', speech.id);
      await until(() => !service.get(id).speeches[0]!.recordError);
      d = service.get(id);
      expect(d.speeches[0]!.directive).toMatchObject({ kind: 'edits' });
      // Its edits are now there to accept, before the revision is written.
      expect(d).toMatchObject({ status: 'paused', round: 1 });
      expect(() => service.continue(id, 'record', speech.id)).toThrow('no missing notes');
      expect(() => service.patch(id, { edit: { id: 'r1-1', accepted: true } })).not.toThrow();
    } finally {
      service.close();
      store.close();
    }
  });

  it('asks again only for the notes of a seat\'s latest speech', async () => {
    let ledgers = 0;
    const seats = fakeSeats((seat, text) => text.includes('"crossExam"') ? (++ledgers === 1 ? 'not json' : LEDGER) : `${seat.id} speaks.`);
    const store = new Store(':memory:');
    const service = new CouncilService({ db: store.db, seats: seats.driver, profileName });
    try {
      const { id } = service.create({ format: 'ld', topic: 'R', maxRounds: 3, seats: [{ role: 'pro', model: agent('a') }, { role: 'con', model: agent('b') }, { role: 'judge', model: agent('c') }] });
      const first = (await settled(service, id)).speeches.find(s => s.phase === 'ledger')!;
      expect(first.recordError).toEqual(expect.any(String));
      service.continue(id);
      await settled(service, id);
      // The notes request asks about the speech just given, which is now the judge's second.
      expect(() => service.continue(id, 'record', first.id)).toThrow('spoken since');
    } finally {
      service.close();
      store.close();
    }
  });

  it('swaps a seat after a failed 1v1 step, reruns the step in a new conversation and tells it its own speeches', async () => {
    let failCon = false;
    const seats = fakeSeats((seat, text) => text.includes('"crossExam"') ? LEDGER : seat.id === 'con' && failCon ? new Error('down') : `${seat.id} speaks.`);
    const store = new Store(':memory:');
    const service = new CouncilService({ db: store.db, seats: seats.driver, profileName });
    try {
      const { id } = service.create({ format: 'ld', topic: 'R', maxRounds: 3, seats: [{ role: 'pro', model: agent('a') }, { role: 'con', model: agent('b') }, { role: 'judge', model: agent('c') }] });
      expect((await settled(service, id)).status).toBe('paused');
      failCon = true;
      service.continue(id);
      expect((await settled(service, id)).status).toBe('failed');
      failCon = false;
      // Round 2 fails on con; give con another model.
      service.patch(id, { seat: { id: 'con', model: agent('z') } });
      const afterSwap = service.get(id);
      expect(afterSwap.seats[1]).toMatchObject({ model: { model: 'z' }, heard: [] });
      expect(afterSwap.seats[1]!.sessionId).toBeUndefined();
      // Its failed speech of this round goes; the old conversation stays, its earlier speeches read from it.
      expect(afterSwap.speeches.some(s => s.seatId === 'con' && s.status === 'failed')).toBe(false);
      expect(seats.removed).not.toContain('session-con');
      expect(service.holds(id, 'session-con')).toBe(true);
      service.continue(id);
      const d = await settled(service, id);
      expect(d.status).toBe('paused');
      expect(d.seats[1]!.sessionId).toBe('session-con-2');
      const reopened = seats.sent.findLast(turn => turn.seatId === 'con')!.text;
      expect(reopened).toContain('你此前的发言');
      expect(reopened).toContain('con speaks.');
      // Deleting the discussion takes both conversations.
      service.delete(id);
      await until(() => seats.removed.includes('session-con') && seats.removed.includes('session-con-2'));
    } finally {
      service.close();
      store.close();
    }
  });

  it('tracks when it settled and when the reader saw it, and tells the list about it', async () => {
    const seats = fakeSeats((seat, text) => text.includes('"positions"') ? '{"convergence":"partial","action":"conclude"}' : `${seat.id} speaks.`);
    const store = new Store(':memory:');
    const service = new CouncilService({ db: store.db, seats: seats.driver, profileName });
    const changes = vi.fn();
    service.onChange(changes);
    try {
      const { id } = service.create({ format: 'roundtable', topic: 'Q', maxRounds: 4, seats: [{ role: 'debater', model: agent('a') }, { role: 'debater', model: agent('b') }, { role: 'moderator', model: agent('c') }] });
      let d = await settled(service, id);
      expect(d.settledAt).toBeTruthy();
      expect(councilAwaitsReader(d)).toBe(true);
      await vi.waitFor(() => expect(changes).toHaveBeenCalled());
      const before = changes.mock.calls.length;
      service.patch(id, { seen: true });
      expect(councilAwaitsReader(service.get(id))).toBe(false);
      expect(service.list()[0]).toMatchObject({ settledAt: d.settledAt, seenAt: expect.any(String) });
      await vi.waitFor(() => expect(changes.mock.calls.length).toBeGreaterThan(before));
      // Concluding writes the conclusion in the round that ended, not in a new one.
      service.continue(id, 'conclude');
      d = await settled(service, id);
      expect(d.status).toBe('done');
      expect(d.speeches.find(s => s.phase === 'conclusion')!.round).toBe(1);
      expect(d.round).toBe(1);
    } finally {
      service.close();
      store.close();
    }
  });
});
