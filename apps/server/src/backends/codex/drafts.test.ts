import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NativeWorkbenchEvent } from '../../../../../packages/contracts/src/index.js';
import { CodexDraftStream, type CodexDraftOptions } from './drafts.js';

function stream(timing?: CodexDraftOptions['timing']) {
  let sequence = 0;
  const sent: NativeWorkbenchEvent[] = [];
  const reserved = new Map<string, number>();
  const drafts = new CodexDraftStream({
    ...(timing ? { timing } : {}),
    nextSequence: () => ++sequence,
    reserveSequence: (nativeId, value) => reserved.set(nativeId, value),
    eventContext: () => ({ sessionId: 'session-1', runId: 'run-1', createdAt: new Date(0).toISOString() }),
    send: events => sent.push(...events),
  });
  return { drafts, sent, reserved };
}
const text = (event: NativeWorkbenchEvent) => (event.data.content as { text: string }).text;

describe('CodexDraftStream', () => {
  afterEach(() => vi.useRealTimers());

  it('flushes the entire burst at once and reports only timing metadata', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const timing = vi.fn();
    const { drafts, sent } = stream(timing);
    drafts.note('item/agentMessage/delta', { turnId: 'turn', itemId: 'msg', delta: 'private text' }, 'thread');
    vi.advanceTimersByTime(20);
    drafts.note('item/agentMessage/delta', { turnId: 'turn', itemId: 'msg', delta: ' tail' }, 'thread');
    vi.advanceTimersByTime(29);
    expect(sent).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(sent.map(text)).toEqual(['private text tail']);
    expect(timing).toHaveBeenCalledWith({ atMs: 50, deltas: 2, characters: 17,
      arrivalSpanMs: 20, flushDelayMs: 50, timerLateMs: 0, events: 1 });
    expect(JSON.stringify(timing.mock.calls)).not.toContain('private');
    vi.advanceTimersByTime(1_000);
    expect(sent).toHaveLength(1);
    drafts.clear();
  });

  it('synchronous flush sends all remaining text without later playback', () => {
    vi.useFakeTimers();
    const { drafts, sent } = stream();
    for (const delta of ['one', 'two', 'three']) {
      drafts.note('item/agentMessage/delta', { turnId: 'turn', itemId: 'msg', delta }, 'thread');
    }
    drafts.flush();
    expect(sent.map(text)).toEqual(['onetwothree']);
    vi.runAllTimers();
    expect(sent).toHaveLength(1);
    drafts.clear();
  });
  it('batches deltas into joinable chunks and reserves the committed id the first chunk\'s place', () => {
    const { drafts, sent, reserved } = stream();
    drafts.note('item/agentMessage/delta', { turnId: 'turn-1', itemId: 'msg-1', delta: 'Hel' }, 'thread');
    drafts.note('item/agentMessage/delta', { turnId: 'turn-1', itemId: 'msg-1', delta: 'lo' }, 'thread');
    drafts.flush();
    drafts.note('item/agentMessage/delta', { turnId: 'turn-1', itemId: 'msg-1', delta: '!' }, 'thread');
    drafts.flush();
    expect(sent.map(event => [event.nativeId, text(event)])).toEqual([
      ['0:thread:turn-1:msg-1:assistant-draft:0', 'Hello'],
      ['0:thread:turn-1:msg-1:assistant-draft:1', '!'],
    ]);
    expect(reserved.get('thread:turn-1:msg-1:assistant')).toBe(sent[0]!.sequence);
    expect(drafts.snapshot().map(event => [event.nativeId, text(event), event.sequence])).toEqual([
      ['0:thread:turn-1:msg-1:assistant-draft:0', 'Hello!', sent[0]!.sequence],
    ]);
  });

  it('retains known message phase through metadata-only updates and partial history recovery', () => {
    const { drafts, sent } = stream();
    drafts.note('item/agentMessage/delta', { turnId: 'turn', itemId: 'msg', delta: '', phase: 'commentary' }, 'thread');
    drafts.note('item/agentMessage/delta', { turnId: 'turn', itemId: 'msg', delta: 'Answer', phase: 'unknown' }, 'thread');
    drafts.flush();
    expect(sent[0]?.data.phase).toBe('commentary');
    drafts.note('item/agentMessage/delta', { turnId: 'turn', itemId: 'msg', delta: '', phase: 'final_answer' }, 'thread');
    drafts.flush();
    expect(sent.map(event => [text(event), event.data.phase])).toEqual([['Answer', 'commentary'], ['', 'final_answer']]);
    drafts.adoptPartial('thread:turn:msg:assistant', 'Answer', 'Answer', sent[0]!.sequence, 'unknown');
    drafts.note('item/agentMessage/delta', { turnId: 'turn', itemId: 'msg', delta: '!' }, 'thread');
    expect(drafts.snapshot()[0]).toMatchObject({ sequence: sent[0]!.sequence, data: { phase: 'final_answer', content: { text: 'Answer!' } } });
    drafts.clear();
  });

  it('follows the reasoning channel that streamed first and separates summary parts', () => {
    const { drafts } = stream();
    drafts.note('item/reasoning/summaryTextDelta', { turnId: 'turn-1', itemId: 'rs-1', summaryIndex: 0, delta: '**First**' }, 'thread');
    drafts.note('item/reasoning/textDelta', { turnId: 'turn-1', itemId: 'rs-1', contentIndex: 0, delta: 'raw thought' }, 'thread');
    drafts.note('item/reasoning/summaryTextDelta', { turnId: 'turn-1', itemId: 'rs-1', summaryIndex: 1, delta: '**Second**' }, 'thread');
    const [row] = drafts.snapshot();
    expect(row?.type).toBe('agent_thought_chunk');
    expect(row?.data.channel).toBe('narration');
    expect(text(row!)).toBe('**First**\n\n**Second**');
    // A model that writes no summary streams raw reasoning only, which the clients fold away.
    const raw = stream();
    raw.drafts.note('item/reasoning/textDelta', { turnId: 'turn-1', itemId: 'rs-2', contentIndex: 0, delta: 'raw thought' }, 'thread');
    expect(raw.drafts.snapshot()[0]?.data.channel).toBe('thinking');
    // A gateway relaying another model's chain of thought as a summary has no heading; it folds too.
    const relayed = stream();
    relayed.drafts.note('item/reasoning/summaryTextDelta', { turnId: 'turn-1', itemId: 'rs-3', summaryIndex: 0, delta: 'Need inspect cwd.' }, 'thread');
    expect(relayed.drafts.snapshot()[0]?.data.channel).toBe('thinking');
  });

  it('reports whether a settled item had been shown, and forgets a finished turn', () => {
    const { drafts } = stream();
    drafts.note('item/agentMessage/delta', { turnId: 'turn-1', itemId: 'msg-1', delta: 'shown' }, 'thread');
    drafts.flush();
    drafts.note('item/agentMessage/delta', { turnId: 'turn-1', itemId: 'msg-2', delta: 'buffered' }, 'thread');
    drafts.note('item/agentMessage/delta', { turnId: 'turn-2', itemId: 'msg-3', delta: 'next turn' }, 'thread');
    expect(drafts.settle('msg-1')).toBe(true);
    expect(drafts.settle('missing')).toBe(false);
    drafts.dropTurn('turn-1');
    expect(drafts.snapshot().map(text)).toEqual(['next turn']);
    drafts.clear();
  });

  it('preserves an unseeded tail even if it repeats the history suffix, until the final item settles it', () => {
    const { drafts } = stream();
    drafts.note('item/agentMessage/delta', { turnId: 'turn', itemId: 'msg', delta: ' world' }, 'thread');
    const before = drafts.texts();
    drafts.adoptPartial('thread:turn:msg:assistant', 'Hello world', before.get('thread:turn:msg:assistant'), 2);
    // The protocol has no offset: this can be either a delayed delta or a legitimate repeated word.
    expect(drafts.snapshot().map(text)).toEqual(['Hello world world']);
    expect(drafts.settle('msg')).toBe(true);
    expect(drafts.snapshot()).toEqual([]);
    drafts.clear();
  });

  it('uses its seeded baseline on later history reads and retains deltas arriving after the read starts', () => {
    const { drafts } = stream();
    drafts.note('item/agentMessage/delta', { turnId: 'turn', itemId: 'msg', delta: ' world' }, 'thread');
    drafts.adoptPartial('thread:turn:msg:assistant', 'Hello', undefined, 2);
    const before = drafts.texts();
    drafts.note('item/agentMessage/delta', { turnId: 'turn', itemId: 'msg', delta: '!' }, 'thread');
    drafts.adoptPartial('thread:turn:msg:assistant', 'Provider prefix', before.get('thread:turn:msg:assistant'), 2);
    expect(drafts.snapshot().map(event => [text(event), event.sequence])).toEqual([['Provider prefix!', 2]]);
    drafts.clear();
  });
});
