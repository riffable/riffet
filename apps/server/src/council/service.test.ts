import { describe, expect, it } from 'vitest';
import type { CouncilDiscussion, CouncilSeat } from '../../../../packages/contracts/src/index.js';
import { Store } from '../store.js';
import type { SeatDriver, SeatTurn } from './seats.js';
import { CouncilService } from './service.js';

const agent = (model: string) => ({ backendId: 'claude' as const, profileId: 'default', model });
const profileName = () => 'Claude Code';

/**
 * Seat conversations in memory. Each turn's answer comes from `answer(seat, text)`; a turn can be held until `gate`
 * resolves. Records what each seat was sent, what was stopped and what was removed.
 */
function fakeSeats(answer: (seat: CouncilSeat, text: string) => string | Error, gate?: (seat: CouncilSeat) => Promise<void> | undefined) {
  const sent: Array<{ seatId: string; sessionId: string; runId: string; text: string }> = [];
  const stopped: string[] = [];
  const removed: string[] = [];
  const pending = new Map<string, Promise<SeatTurn>>();
  let n = 0;
  const driver: SeatDriver = {
    async send(_d, seat, text) {
      const sessionId = seat.sessionId ?? `session-${seat.id}`;
      const runId = `run-${n += 1}`;
      sent.push({ seatId: seat.id, sessionId, runId, text });
      pending.set(runId, (async () => {
        await gate?.(seat);
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
    watch: () => () => {},
    rows: async () => [],
    alive: sessionId => !removed.includes(sessionId),
    remove: async sessionId => { removed.push(sessionId); },
  };
  return { driver, sent, stopped, removed };
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
  it('runs an LD debate turn by turn, tells each seat only what is new, and records the ledger in a turn of its own', async () => {
    const seats = fakeSeats((seat, text) => text.includes('record your notes') ? LEDGER : `${seat.id} speaks.`);
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

    const toPro = seats.sent.filter(turn => turn.seatId === 'pro');
    // The first turn opens with the brief; the next carries only what was said since, once each.
    expect(toPro[0]!.text).toContain('Resolution: Resolution');
    expect(toPro[1]!.text).not.toContain('Resolution: Resolution');
    expect(toPro[1]!.text.match(/con speaks\./g)).toHaveLength(2);
    expect(toPro[1]!.text).toContain('judge speaks.');
    // The question PRO asked and the judge counts as dodged is put to CON again.
    expect(seats.sent.filter(turn => turn.seatId === 'con')[1]!.text).toContain('- Why?');
    service.close();
  });

  it('skips a failed speech and goes on, and fails only when a whole step fails', async () => {
    const seats = fakeSeats((seat, text) => seat.id === 's2' && !text.includes('record your notes') ? new Error('gateway down') : 'Statement.');
    const service = new CouncilService({ db: new Store(':memory:').db, seats: seats.driver, profileName });
    const created = service.create({
      format: 'roundtable', topic: 'Topic', maxRounds: 2, rhythm: 'pause',
      seats: [{ role: 'debater', model: agent('a') }, { role: 'debater', model: agent('b') }, { role: 'moderator', model: agent('c') }],
    });
    const d = await settled(service, created.id);
    expect(d.status).toBe('paused');
    expect(d.speeches.find(s => s.seatId === 's2')).toMatchObject({ status: 'failed', error: 'gateway down' });
    expect(d.speeches.find(s => s.phase === 'summary')?.status).toBe('done');

    const failing = new CouncilService({ db: new Store(':memory:').db, seats: fakeSeats(() => new Error('no login')).driver, profileName });
    const all = failing.create({
      format: 'prism', topic: 'Q',
      seats: [{ role: 'participant', model: agent('a') }, { role: 'participant', model: agent('b') }, { role: 'observer', model: agent('c') }],
    });
    expect(await settled(failing, all.id)).toMatchObject({ status: 'failed', error: 'no login' });
    service.close();
    failing.close();
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
});
