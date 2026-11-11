import { describe, expect, it } from 'vitest';
import type { NativeWorkbenchEvent } from '../../../../packages/contracts/src/index.js';
import { extractIndexable, likePattern, MAX_INDEXED_TEXT, normalizeQuery, snippet } from './messages.js';

const chunk = (sequence: number, type: string, nativeId: string, text: string): NativeWorkbenchEvent => ({
  sequence, sessionId: 'session-1', type, nativeId, createdAt: new Date(sequence * 1000).toISOString(),
  data: { sessionUpdate: type, content: { type: 'text', text } },
} as NativeWorkbenchEvent);

const tool = (sequence: number, nativeId: string, data: Record<string, unknown>): NativeWorkbenchEvent => ({
  sequence, sessionId: 'session-1', type: 'tool_call', nativeId, createdAt: new Date(sequence * 1000).toISOString(),
  data: { sessionUpdate: 'tool_call', ...data },
} as NativeWorkbenchEvent);

describe('extractIndexable', () => {
  it('indexes questions and answers as their own kinds', () => {
    const rows = extractIndexable('session-1', [chunk(1, 'user_message_chunk', '1:prompt:0', 'how do I build'), chunk(2, 'agent_message_chunk', '2:answer:0', 'run pnpm build')]);
    expect(rows).toEqual([
      { sessionId: 'session-1', messageId: '1:prompt:0', kind: 'user', text: 'how do I build', at: new Date(1000).toISOString() },
      { sessionId: 'session-1', messageId: '2:answer:0', kind: 'assistant', text: 'run pnpm build', at: new Date(2000).toISOString() },
    ]);
  });

  it('joins the chunks of one streamed answer instead of indexing fragments', () => {
    const rows = extractIndexable('session-1', [chunk(1, 'agent_message_chunk', '2:answer:0', 'first half '), chunk(2, 'agent_message_chunk', '2:answer:0', 'second half')]);
    expect(rows).toHaveLength(1);
    // The space the provider put between the chunks survives, so a phrase spanning them is found.
    expect(rows[0]!.text).toBe('first half second half');
  });

  it('indexes a tool call by what it acted on, which is how it is remembered', () => {
    const rows = extractIndexable('session-1', [tool(1, '3:tool:0', { toolName: 'Edit', filePath: 'apps/web/src/config.ts' })]);
    expect(rows[0]).toMatchObject({ kind: 'tool', text: 'Edit apps/web/src/config.ts' });
  });

  it('leaves thinking out, so answers are not buried under it', () => {
    expect(extractIndexable('session-1', [chunk(1, 'agent_thought_chunk', '2:thought:0', 'maybe I should consider…')])).toEqual([]);
  });

  it('ignores events with nothing to search', () => {
    const empty = { sequence: 1, sessionId: 'session-1', type: 'agent_message_chunk', nativeId: '1:a:0', createdAt: new Date(0).toISOString(), data: { content: { type: 'text', text: '   ' } } } as NativeWorkbenchEvent;
    expect(extractIndexable('session-1', [empty, tool(2, '2:t:0', { status: 'completed' })])).toEqual([]);
  });

  it('falls back to the sequence when an event has no native id', () => {
    const rows = extractIndexable('session-1', [{ ...chunk(7, 'agent_message_chunk', '', 'answer'), nativeId: '' } as NativeWorkbenchEvent]);
    expect(rows[0]!.messageId).toBe('7');
  });

  it('caps what it stores from one very long message', () => {
    const rows = extractIndexable('session-1', [chunk(1, 'agent_message_chunk', '1:a:0', 'x'.repeat(20_000))]);
    expect(rows[0]!.text).toHaveLength(MAX_INDEXED_TEXT);
  });
});

describe('normalizeQuery', () => {
  it('accepts a trimmed query and refuses the rest', () => {
    expect(normalizeQuery('  build  ')).toBe('build');
    expect(normalizeQuery('')).toBeUndefined();
    expect(normalizeQuery('   ')).toBeUndefined();
    expect(normalizeQuery(undefined)).toBeUndefined();
    expect(normalizeQuery(42)).toBeUndefined();
    expect(normalizeQuery('x'.repeat(201))).toBeUndefined();
  });
});

describe('likePattern', () => {
  it('escapes the wildcards so they are searched for literally', () => {
    expect(likePattern('100%')).toBe('%100\\%%');
    expect(likePattern('a_b')).toBe('%a\\_b%');
    expect(likePattern('c:\\x')).toBe('%c:\\\\x%');
    expect(likePattern('plain')).toBe('%plain%');
  });
});

describe('snippet', () => {
  const text = `${'a'.repeat(100)}NEEDLE${'b'.repeat(100)}`;

  it('cuts a window around the match and marks both ends', () => {
    const cut = snippet(text, 'NEEDLE', 20);
    expect(cut).toBe(`…${'a'.repeat(20)}NEEDLE${'b'.repeat(20)}…`);
  });

  it('matches without regard to ASCII case, and falls back to the head when it cannot', () => {
    expect(snippet('Hello World', 'hello')).toBe('Hello World');
    expect(snippet('abcdef', 'zzz', 2)).toBe('abcd');
  });

  it('does not mark an end it did not cut', () => {
    expect(snippet('NEEDLE', 'NEEDLE', 10)).toBe('NEEDLE');
  });
});
