import { describe, expect, it } from 'vitest';
import { scopeTopicTurns, type Turn } from './TurnRail';

const turn = (key: string, text: string, at?: string): Turn => ({ key, text, ...(at ? { at } : {}) });

describe('scopeTopicTurns', () => {
  const sample: Turn[] = [
    turn('outline-turn:0', 'old question 1', '2026-11-26T10:00:00Z'),
    turn('outline-turn:1', '/new', '2026-11-26T11:00:00Z'),
    turn('u2', 'old question 2', '2026-11-26T11:05:00Z'),
    turn('new-2', '/new', '2026-11-26T22:00:00Z'),
    turn('new-3', '/new', '2026-11-26T22:29:00Z'),
    turn('u3', '你是谁，你能做什么', '2026-11-26T22:30:00Z'),
    turn('u4', 'push 吧', '2026-11-26T22:40:00Z'),
  ];
  const settled = new Set(['new-2', 'new-3']);

  it('returns the original array untouched when topic dividers are disabled', () => {
    expect(scopeTopicTurns(sample, { enabled: false })).toBe(sample);
  });

  it('scopes to the current topic and restarts numbering at 1 when earlier topics are collapsed', () => {
    const scoped = scopeTopicTurns(sample, {
      enabled: true,
      settledBoundaryKeys: settled,
      collapseEarlier: true,
      latestBoundaryKey: 'new-3',
    });
    expect(scoped.map(({ key, number, startsTopic }) => ({ key, number, startsTopic }))).toEqual([
      { key: 'u3', number: 1, startsTopic: undefined },
      { key: 'u4', number: 2, startsTopic: undefined },
    ]);
  });

  it('returns empty when collapsed immediately after /new with no prompts yet', () => {
    const afterNew = sample.slice(0, 5);
    expect(scopeTopicTurns(afterNew, {
      enabled: true,
      settledBoundaryKeys: settled,
      collapseEarlier: true,
      latestBoundaryKey: 'new-3',
    })).toEqual([]);
  });

  it('keeps each topic numbered from 1 when expanded and collapses consecutive /new boundaries', () => {
    const expanded = scopeTopicTurns(sample, {
      enabled: true,
      settledBoundaryKeys: settled,
      collapseEarlier: false,
      latestBoundaryKey: 'new-3',
    });
    expect(expanded.map(({ key, number, startsTopic, topicStartedAt }) => ({ key, number, startsTopic, topicStartedAt }))).toEqual([
      { key: 'outline-turn:0', number: 1, startsTopic: undefined, topicStartedAt: undefined },
      { key: 'u2', number: 1, startsTopic: true, topicStartedAt: '2026-11-26T11:00:00Z' },
      { key: 'u3', number: 1, startsTopic: true, topicStartedAt: '2026-11-26T22:29:00Z' },
      { key: 'u4', number: 2, startsTopic: undefined, topicStartedAt: undefined },
    ]);
  });
});
