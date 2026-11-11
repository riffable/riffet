import { describe, expect, it } from 'vitest';
import { contextOf, type ChatRecord } from './history.js';

const at = '2026-10-31T00:00:00.000Z';
const turn = (n: number, size = 10): ChatRecord[] => [
  { kind: 'user', id: `u${n}`, turnId: `t${n}`, at, text: `q${n} ${'x'.repeat(size)}`, commandId: `c${n}` },
  { kind: 'assistant', id: `a${n}`, turnId: `t${n}`, at, text: `a${n} ${'y'.repeat(size)}`, status: 'completed' },
];

describe('contextOf', () => {
  it('starts after a clear, then after the newest summary, and keeps the newest turns within the budget', () => {
    const records: ChatRecord[] = [...turn(1), { kind: 'clear', id: 'k', turnId: 'tk', at, commandId: 'ck' }, ...turn(2), ...turn(3), ...turn(4)];
    expect(contextOf(records, 'next', 10_000).messages.map(message => message.content.split(' ')[0])).toEqual(['q2', 'a2', 'q3', 'a3', 'q4', 'a4', 'next']);
    const summarized: ChatRecord[] = [...records, { kind: 'summary', id: 's', at, upTo: 'a3', text: 'earlier' }];
    const context = contextOf(summarized, 'next', 10_000);
    expect(context.summary).toBe('earlier');
    expect(context.messages.map(message => message.content.split(' ')[0])).toEqual(['q4', 'a4', 'next']);
    // A summary from before the last clear says nothing about what follows it.
    expect(contextOf([...summarized, { kind: 'clear', id: 'k2', turnId: 'tk2', at, commandId: 'ck2' }], 'next', 10_000)).toEqual({ messages: [{ role: 'user', content: 'next' }], dropped: 0 });
    const tight = contextOf([...turn(5, 400), ...turn(6, 400)], 'next', 400);
    expect(tight.dropped).toBe(1);
    expect(tight.messages.map(message => message.content.split(' ')[0])).toEqual(['q6', 'a6', 'next']);
  });
});
