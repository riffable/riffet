import { describe, expect, it } from 'vitest';
import { TurnTracker } from './turn-tracker.js';

describe('TurnTracker', () => {
  it('keeps a turn a stronger channel named from being closed by a weaker one, or by a report about another turn', () => {
    const turn = new TurnTracker('idle');
    expect(turn.observe({ source: 'hook', phase: 'running', turnId: 'p1' })).toBe(true);
    expect(turn.observe({ source: 'screen', phase: 'idle' })).toBe(false);
    expect(turn.nativePhase).toBe('busy');
    expect(turn.observe({ source: 'protocol', phase: 'idle', turnId: 'p0' })).toBe(false);
    expect(turn.observe({ source: 'hook', phase: 'idle', turnId: 'p1' })).toBe(true);
    expect(turn.nativePhase).toBe('idle');
  });

  it('leaves attention only for evidence at least as strong as what raised it', () => {
    const turn = new TurnTracker('idle');
    turn.observe({ source: 'protocol', phase: 'attention' });
    expect(turn.observe({ source: 'screen', phase: 'running' })).toBe(false);
    expect(turn.nativePhase).toBe('attention');
    expect(turn.observe({ source: 'protocol', phase: 'running' })).toBe(true);
    expect(turn.nativePhase).toBe('busy');
  });
});
