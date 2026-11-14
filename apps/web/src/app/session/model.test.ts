import { describe, expect, it } from 'vitest';
import type { Run } from '@contracts';
import { canRestoreUnsentRun } from './model';

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
