import { describe, expect, it } from 'vitest';
import type { Run } from '@contracts';
import { canRestoreUnsentRun } from './model';
import { nativeDeliveryStatus } from './delivery';

describe('restoring a failed send', () => {
  it('restores preparation failures only before the input fence', () => {
    const run: Run = {
      id: 'run', sessionId: 'session', commandId: 'command', prompt: 'continue',
      state: 'failed', createdAt: '', updatedAt: '',
      native: {
        input: { text: 'continue', attachmentIds: ['attachment'], context: [] },
        config: { mode: 'agent' }, fingerprint: 'request', configRevision: 0,
        delivery: 'failed', stage: 'prepare', attempt: 1,
      },
    };
    expect(canRestoreUnsentRun(run)).toBe(true);
    // A launch-time prompt can fail during startup after it has already crossed the fence.
    expect(canRestoreUnsentRun({ ...run, native: { ...run.native!, timings: { dispatchAt: 1 } } })).toBe(false);
    expect(canRestoreUnsentRun({ ...run, native: { ...run.native!, nativeMessageId: 'receipt' } })).toBe(false);
    expect(canRestoreUnsentRun({ ...run, native: { ...run.native!, delivery: 'uncertain' } })).toBe(false);
  });
});

describe('nativeDeliveryStatus for steers', () => {
  const steerRun = (overrides: Partial<NonNullable<Run['native']>>, state: Run['state'] = 'queued'): Run => ({
    id: 'steer-1', sessionId: 'session', commandId: 'cmd-1', prompt: 'focus on login',
    state, createdAt: '', updatedAt: '',
    native: {
      input: { text: 'focus on login', attachmentIds: [], context: [] },
      config: { mode: 'agent' }, fingerprint: 'fp', configRevision: 0,
      delivery: 'input_sent', stage: 'steer_confirmation', intent: 'steer', attempt: 1,
      timings: { dispatchAt: 1, inputSentAt: 2 },
      ...overrides,
    },
  });

  it('does not treat parent turn output as delivery confirmation for an unreceipted steer', () => {
    expect(nativeDeliveryStatus(steerRun({ delivery: 'preparing', stage: 'steer_waiting_boundary' }), true, true)).toBe('sending');
    expect(nativeDeliveryStatus(steerRun({ delivery: 'input_sent', stage: 'steer_confirmation' }), true, true)).toBe('sending');
    expect(nativeDeliveryStatus(steerRun({ delivery: 'input_sent', stage: 'steer_confirmation' }, 'running'), true, true)).toBe('sending');
    expect(nativeDeliveryStatus(steerRun({ delivery: 'uncertain', stage: 'confirmation' }, 'interrupted'), true, true)).toBe('unconfirmed');
    expect(nativeDeliveryStatus(steerRun({ delivery: 'uncertain', stage: 'steer_stopped' }, 'interrupted'), true, true)).toBe('unconfirmed');
    expect(nativeDeliveryStatus(steerRun({ delivery: 'failed', stage: 'steer_rejected' }, 'failed'), true, true)).toBe('send_failed');
  });

  it('clears the sending status once a steer is accepted or observed', () => {
    expect(nativeDeliveryStatus(steerRun({ delivery: 'input_sent', timings: { dispatchAt: 1, inputSentAt: 2, providerAcceptedAt: 3 } }), true, true)).toBe('');
    expect(nativeDeliveryStatus(steerRun({ delivery: 'observed', nativeMessageId: 'steer:1', timings: { dispatchAt: 1, inputSentAt: 2, observedAt: 3 } }, 'running'), true, true)).toBe('');
  });

  it('still treats same-turn output as confirmation for ordinary non-steer prompts', () => {
    const ordinary = steerRun({ intent: undefined, delivery: 'input_sent', stage: 'confirmation' });
    expect(nativeDeliveryStatus(ordinary, true, true)).toBe('');
    expect(nativeDeliveryStatus(ordinary, true, false)).toBe('sending');
  });
});
