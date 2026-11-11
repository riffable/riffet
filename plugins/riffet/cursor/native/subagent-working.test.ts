import { describe, expect, it } from 'vitest';
import { subagentWorking } from './service.js';
import { stateForPhase } from './watch.js';

const now = 1_000_000;

describe('subagentWorking', () => {
  it('keeps a subagent whose store the CLI holds open working however long it stays quiet', () => {
    expect(subagentWorking('call-1', now - 5 * 60_000, ['call-1', 'call-2'], now)).toBe(true);
  });

  it('settles a subagent the CLI no longer holds open even right after its last write', () => {
    expect(subagentWorking('call-1', now - 1_000, ['call-2'], now)).toBe(false);
    expect(subagentWorking('call-1', now - 1_000, [], now)).toBe(false);
  });

  it('falls back to recent writes when the open stores could not be read', () => {
    expect(subagentWorking('call-1', now - 5_000, undefined, now)).toBe(true);
    expect(subagentWorking('call-1', now - 20_000, undefined, now)).toBe(false);
  });

  it('keeps the session running after the main turn ends until all subagents settle', () => {
    expect(stateForPhase('idle', true)).toBe('running');
    expect(stateForPhase('offline', true)).toBeUndefined();
    expect(stateForPhase('idle', false)).toBe('idle');
    expect(stateForPhase('attention', true)).toBe('waiting');
  });
});
