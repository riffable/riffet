import { describe, expect, it } from 'vitest';
import type { NativeStatus, Run, Session } from '../../../../packages/contracts/src/index.js';
import { buildSessionControlSnapshot, type ControlSnapshotInput } from './control.js';

const at = '2026-11-19T00:00:00.000Z';
const session: Session = {
  id: 's1', projectId: 'p1', kind: 'native', title: 'Chat', tags: [], state: 'idle', mode: 'agent',
  backendId: 'claude', createdAt: at, updatedAt: at,
};
const capable = { supportsInterrupt: true, supportsTargetedStop: true, supportsSteer: true };

function queued(id: string): Run {
  return {
    id, sessionId: session.id, commandId: `cmd-${id}`, prompt: 'hello', state: 'queued', createdAt: at, updatedAt: at,
    native: {
      input: { text: 'hello', attachmentIds: [], context: [] },
      config: { mode: 'agent' }, fingerprint: 'fp', delivery: 'queued', attempt: 1, configRevision: 0,
    },
  };
}

function snap(patch: Partial<ControlSnapshotInput> & Pick<ControlSnapshotInput, 'status' | 'queue' | 'runs'>): ReturnType<typeof buildSessionControlSnapshot> {
  return buildSessionControlSnapshot({ revision: 1, session, capabilities: capable, ...patch });
}

const running: NativeStatus = { phase: 'busy', activeTurn: { nativeSessionId: 'native-1', turnId: 'turn-1' } };

describe('buildSessionControlSnapshot', () => {
  it('places a new session first run as sending and does not offer send_now', () => {
    const run = queued('run-1');
    const snapshot = snap({ status: { phase: 'idle' }, queue: { next: run.id }, runs: [run] });
    expect(snapshot.activeTurn).toBeNull();
    expect(snapshot.inbox).toHaveLength(1);
    expect(snapshot.inbox[0]).toMatchObject({ id: run.id, placement: 'sending', status: 'queued' });
    expect(snapshot.inbox[0]!.actions).toEqual(['cancel']);
    expect(snapshot.inbox[0]!.actions).not.toContain('send_now');
    expect(snapshot.capabilities.canSendNow).toBe(false);
  });

  it('places a run behind a live turn in the queue and offers send_now, plus steer only when the turn can be steered', () => {
    const run = queued('run-q');
    const held = { next: run.id, held: { reason: 'turn_running' as const } };
    const steered = snap({ status: running, queue: held, runs: [run] });
    expect(steered.activeTurn).toMatchObject({ phase: 'running', canStop: true, canSteer: true });
    expect(steered.inbox[0]).toMatchObject({ placement: 'queued' });
    expect(steered.inbox[0]!.actions).toEqual(['send_now', 'steer', 'edit', 'cancel']);

    const plain = snap({ status: running, queue: held, runs: [run], capabilities: { supportsInterrupt: true, supportsTargetedStop: true } });
    expect(plain.activeTurn?.canSteer).toBe(false);
    expect(plain.inbox[0]!.actions).toEqual(['send_now', 'edit', 'cancel']);
    expect(plain.inbox[0]!.actions).not.toContain('steer');
  });

  it('withholds send_now and steer while an unconfirmed delivery holds the queue', () => {
    const run = queued('run-q');
    const snapshot = snap({
      status: running,
      queue: { next: run.id, held: { reason: 'unconfirmed', runId: 'run-u' } },
      runs: [run],
    });
    expect(snapshot.activeTurn).toMatchObject({ canStop: true, canSteer: false });
    expect(snapshot.inbox[0]).toMatchObject({ placement: 'queued' });
    expect(snapshot.inbox[0]!.actions).toEqual(['edit', 'cancel']);
    expect(snapshot.inbox[0]!.actions).not.toContain('send_now');
    expect(snapshot.inbox[0]!.actions).not.toContain('steer');
    expect(snapshot.capabilities.canSendNow).toBe(false);
  });

  it('keeps uncertain and restorable failed deliveries inline (placement sending), never in the queue dock', () => {
    const uncertain: Run = {
      ...queued('run-u'),
      state: 'interrupted',
      error: '暂时无法确认是否已发送',
      native: { ...queued('run-u').native!, delivery: 'uncertain', stage: 'confirmation', timings: { dispatchAt: 1, inputSentAt: 2 } },
    };
    const restorableFailed: Run = {
      ...queued('run-f'),
      createdAt: '2026-11-19T00:00:01.000Z',
      state: 'failed',
      error: 'CLI failed before sending',
      native: { ...queued('run-f').native!, delivery: 'failed', stage: 'prepare' },
    };
    const snapshot = snap({
      status: running,
      queue: { held: { reason: 'unconfirmed', runId: uncertain.id } },
      runs: [uncertain, restorableFailed],
    });
    expect(snapshot.inbox.map(entry => [entry.id, entry.placement, entry.status, entry.actions])).toEqual([
      [uncertain.id, 'sending', 'uncertain', ['check']],
      [restorableFailed.id, 'sending', 'failed', ['restore']],
    ]);
    expect(snapshot.capabilities.canSendNow).toBe(false);
  });
});
