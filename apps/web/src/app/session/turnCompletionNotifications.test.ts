import { describe, expect, it } from 'vitest';
import type { TurnOutlineV3 } from '@contracts';
import { TurnCompletionNotifications } from './turnCompletionNotifications';

const now = Date.parse('2026-11-04T04:00:00.000Z');
const at = (offset: number) => new Date(now + offset).toISOString();
const turn = (turnId: string, status: TurnOutlineV3['status'], endedAt?: string): TurnOutlineV3 => ({
  turn: `native:${turnId}`, turnId, startPos: 1, rows: 1, status, at: at(-1000), ...(endedAt ? { endedAt } : {}),
});

describe('main-lane completion notification eligibility', () => {
  it('baselines existing results and requires a successful explicit turn end', () => {
    const tracker = new TurnCompletionNotifications();
    expect(tracker.hello('thread', [turn('old', 'completed', at(-1)), turn('active', 'running'), turn('inferred', 'completed'), turn('inferred-old', 'completed')], now)).toBe(false);
    expect(tracker.outline([turn('old', 'completed', at(1)), turn('active', 'completed'), turn('inferred-old', 'completed', at(-1))])).toBe(false);
    expect(tracker.outline([turn('active', 'completed', at(1))])).toBe(true);
    expect(tracker.outline([turn('active', 'completed', at(1))])).toBe(false);
    expect(tracker.outline([turn('inferred', 'completed', at(2))])).toBe(true);
    expect(tracker.outline([turn('inferred', 'completed', at(2))])).toBe(false);
  });

  it('does not report failed or cancelled turns as completed', () => {
    const tracker = new TurnCompletionNotifications();
    tracker.hello('thread', [turn('failed', 'running'), turn('cancelled', 'running')], now);
    expect(tracker.outline([turn('failed', 'failed', at(1)), turn('cancelled', 'cancelled', at(1))])).toBe(false);
    expect(tracker.hello('thread', [turn('failed', 'failed', at(1)), turn('cancelled', 'cancelled', at(1))], now + 2)).toBe(false);
    expect(tracker.outline([turn('failed', 'completed', at(2)), turn('cancelled', 'completed', at(2))])).toBe(false);
    expect(tracker.outline([turn('cancelled', 'running')])).toBe(false);
    expect(tracker.outline([turn('cancelled', 'completed', at(3))])).toBe(true);
    expect(tracker.outline([turn('cancelled', 'completed', at(3))])).toBe(false);
  });

  it('supports fast CLI turns without a Run and rejects older history imports', () => {
    const tracker = new TurnCompletionNotifications();
    tracker.hello('thread', [], now);
    expect(tracker.outline([turn('imported', 'completed', at(-1))])).toBe(false);
    expect(tracker.outline([turn('fast', 'completed', at(1))])).toBe(true);
    expect(tracker.outline([{ ...turn('fast', 'completed', at(1)), turn: 'run:new-association', runId: 'run', preview: 'updated' }])).toBe(false);
  });

  it('keeps observed running turns eligible on reconnect without depending on clock alignment', () => {
    const tracker = new TurnCompletionNotifications();
    tracker.hello('thread', [turn('active', 'running')], now);
    expect(tracker.hello('thread', [turn('active', 'completed', at(-10))], now + 10)).toBe(true);
    // A generation rebuild reuses native turn identity, even when the displayed turn key changes.
    expect(tracker.hello('thread', [{ ...turn('active', 'completed', at(-10)), turn: 'run:rebuilt' }], now + 20)).toBe(false);
  });

  it('waits for a new thread baseline after an identity announcement', () => {
    const tracker = new TurnCompletionNotifications();
    tracker.hello('first', [turn('active', 'running')], now);
    tracker.setThread('second');
    expect(tracker.outline([turn('active', 'completed', at(1))])).toBe(false);
    expect(tracker.hello('second', [turn('active', 'completed', at(1)), turn('new', 'running')], now + 2)).toBe(false);
    expect(tracker.outline([turn('new', 'completed', at(3))])).toBe(true);
  });

  it('keeps the initially unnamed thread eligible and baselines replacements without a new hello', () => {
    const tracker = new TurnCompletionNotifications();
    tracker.hello(undefined, [turn('first', 'running')], now);
    tracker.setThread('first-thread');
    expect(tracker.outline([turn('first', 'completed', at(1))])).toBe(true);
    tracker.setThread('replacement');
    // The consumer waits for the replacement's confirmed generation before calling hello here.
    expect(tracker.hello('replacement', [turn('old', 'completed', at(2)), turn('new', 'running')], now + 2)).toBe(false);
    expect(tracker.outline([turn('new', 'completed', at(3))])).toBe(true);
    expect(tracker.hello('replacement', [turn('new', 'completed', at(3))], now + 4)).toBe(false);
  });

  it('consumes all results in one update before browser visibility or permission gates', () => {
    const tracker = new TurnCompletionNotifications();
    tracker.hello('thread', [], now);
    const completed = [turn('one', 'completed', at(1)), turn('two', 'completed', at(1))];
    expect(tracker.outline(completed)).toBe(true);
    expect(tracker.outline(completed)).toBe(false);
    expect(tracker.hello('thread', completed, now + 2)).toBe(false);
  });
});
