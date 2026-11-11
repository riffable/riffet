import type { NativeWorkbenchEvent, WorkbenchEvent } from '../../contracts/src/index.js';
import { describe, expect, it } from 'vitest';
import { appendProjectedEvents, projectEvents, projectionIndexes } from './projectEvents.js';

const event = (sequence: number, nativeId: string): NativeWorkbenchEvent => ({
  sequence, sessionId: 'session-1', type: 'agent_message_chunk', nativeId,
  data: { content: { type: 'text', text: `message ${sequence}` } }, createdAt: new Date(sequence * 1000).toISOString(),
});

describe('native message phase recovery', () => {
  it('preserves phase across streamed chunks and produces the same projection on recovery', () => {
    const chunk = (sequence: number, message: string, phase?: string): NativeWorkbenchEvent => ({
      ...event(sequence, `1:${message}:${sequence}`), runId: 'turn-1', nativeTurnId: 'turn-1',
      data: { content: { type: 'text', text: String(sequence) }, ...(phase ? { phase } : {}) },
    });
    const phaseOnly = { ...chunk(3, 'answer', 'final_answer'), data: { content: { type: 'text', text: '' }, phase: 'final_answer' } };
    const events = [chunk(1, 'progress', 'commentary'), chunk(2, 'answer'), phaseOnly, chunk(4, 'answer'), chunk(5, 'answer', 'unknown')];
    const projected = projectEvents(events.slice(0, 1));
    const indexes = projectionIndexes(projected, events[0]);
    for (let count = 1; count < events.length; count += 1) {
      appendProjectedEvents(projected, [events[count]!], indexes);
      expect(projected).toEqual(projectEvents(events.slice(0, count + 1)));
    }
    expect(projected.map(item => [item.data.phase, (item.data.content as { text: string }).text])).toEqual([
      ['commentary', '1'], ['final_answer', '245'],
    ]);
    const anonymous: WorkbenchEvent[] = events.slice(0, 2).map(({ nativeId: _id, ...item }, index) => ({ ...item, data: { ...item.data, phase: index ? 'final_answer' : 'commentary' } }));
    expect(projectEvents(anonymous)).toHaveLength(2);

    const answer = chunk(2, 'answer');
    const tool: NativeWorkbenchEvent = { ...chunk(3, 'tool'), type: 'tool_call', data: { toolCallId: 'tool-1', title: 'Read', status: 'completed' } };
    const metadata = { ...phaseOnly, sequence: 4, nativeId: '1:answer:4' };
    const interleaved = [answer, tool, metadata, chunk(5, 'answer'), chunk(6, 'answer', 'unknown')];
    const incremental = projectEvents(interleaved.slice(0, 2));
    const interleavedIndexes = projectionIndexes(incremental, tool);
    const originalAnswer = incremental[0]!;
    const originalTool = incremental[1]!;
    const update = appendProjectedEvents(incremental, [metadata], interleavedIndexes);
    expect(update).toMatchObject({ appended: 0, updated: 1, changedIndexes: [0] });
    expect(incremental).toEqual(projectEvents(interleaved.slice(0, 3)));
    expect(incremental[0]).toMatchObject({ projectionKey: originalAnswer.projectionKey, data: { phase: 'final_answer', content: { text: '2' } }, sourceEvents: [answer, metadata] });
    expect(incremental[1]).toBe(originalTool);
    for (let count = 3; count < interleaved.length; count += 1) {
      appendProjectedEvents(incremental, [interleaved[count]!], interleavedIndexes);
      expect(incremental).toEqual(projectEvents(interleaved.slice(0, count + 1)));
    }
    expect(incremental).toHaveLength(3);
    expect(incremental[0]!.data.content).toMatchObject({ text: '2' });
    expect(incremental[2]!.data.content).toMatchObject({ text: '56' });
    for (const isolated of [
      { ...metadata, nativeTurnId: 'turn-2' },
      { ...metadata, nativeId: '1:other:4' },
      { ...metadata, runId: 'turn-2', nativeTurnId: undefined },
    ]) {
      const separate = projectEvents([answer, tool]);
      appendProjectedEvents(separate, [isolated], projectionIndexes(separate, tool));
      expect(separate).toEqual(projectEvents([answer, tool, isolated]));
      expect(separate[0]!.data.phase).toBeUndefined();
      expect(separate).toHaveLength(3);
    }
  });
});
