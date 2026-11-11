import { describe, expect, it } from 'vitest';
import type { NativeStreamMessage, NativeWorkbenchEvent, RunMetrics } from '@contracts';
import { CursorTranscriptMeter } from './cursor-metrics.js';
import { estimatedTokens, type UsageRecord } from '@riffet/plugin-api';

const at = (offsetMs: number) => new Date(1_700_000_000_000 + offsetMs).toISOString();

function event(overrides: Partial<NativeWorkbenchEvent> & { nativeId: string; type: string }): NativeWorkbenchEvent {
  return {
    sequence: 1,
    sessionId: 'session',
    runId: 'turn:1',
    data: {},
    createdAt: at(0),
    ...overrides,
  } as NativeWorkbenchEvent;
}

function meter() {
  const frames: NativeStreamMessage[] = [];
  const saved: Array<{ runId: string; metrics: RunMetrics }> = [];
  const usage: Array<{ sessionId: string; runId: string | undefined; usage: UsageRecord }> = [];
  const instance = new CursorTranscriptMeter(
    message => frames.push(message),
    (runId, metrics) => saved.push({ runId, metrics }),
    nativeMessageId => (nativeMessageId === '1:prompt:0' ? 'run-1' : undefined),
    runId => (runId === 'run-1' ? Date.parse(at(0)) : undefined),
    {
      recordUsage: (sessionId, runId, record) => { usage.push({ sessionId, runId, usage: record }); },
      observeEvents: () => undefined,
    },
    'session',
  );
  const steps = () => frames.flatMap(frame => frame.type === 'metrics' ? [frame.metrics] : []);
  return { instance, frames, saved, steps, usage };
}

describe('CursorTranscriptMeter', () => {
  it('records an estimated settled step and nothing while the turn is still only a prompt', () => {
    const { instance, usage } = meter();
    const text = 'a'.repeat(400);
    instance.observe([event({ nativeId: '1:prompt:0', type: 'user_message_chunk', createdAt: at(0) })]);
    expect(usage).toEqual([]);
    instance.observe([
      event({ nativeId: '2:answer:0', type: 'agent_message_chunk', createdAt: at(4_000), data: { content: { type: 'text', text } } }),
    ]);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      sessionId: 'session',
      runId: 'run-1',
      usage: {
        stepId: '2:answer',
        outputTokens: estimatedTokens(text),
        tokenSource: 'estimated',
        window: 'observed',
        startedAt: Date.parse(at(0)),
        endedAt: Date.parse(at(4_000)),
      },
    });
    expect(usage[0]!.usage.inputTokens).toBeUndefined();
  });

  it('times a response between the prompt and the record that answered it', () => {
    const { instance, saved, steps } = meter();
    instance.observe([
      event({ nativeId: '1:prompt:0', type: 'user_message_chunk', createdAt: at(0) }),
      event({ nativeId: '2:answer:0', type: 'agent_message_chunk', createdAt: at(4_000), data: { content: { type: 'text', text: 'a'.repeat(400) } } }),
    ]);
    expect(steps()).toHaveLength(1);
    expect(steps()[0]).toMatchObject({ stepId: '2:answer', tokens: 'estimated', durationMs: 4_000, window: 'observed' });
    // The observation exists only while the conversation is watched, so it must be stored too.
    expect(saved).toHaveLength(1);
    expect(saved[0]!.runId).toBe('run-1');
  });

  it('measures each response of a turn, not the whole turn', () => {
    const { instance, steps } = meter();
    instance.observe([
      event({ nativeId: '1:prompt:0', type: 'user_message_chunk', createdAt: at(0) }),
      event({ nativeId: '2:answer:0', type: 'agent_message_chunk', createdAt: at(2_000), data: { content: { type: 'text', text: 'first answer' } } }),
      event({ nativeId: '3:toolresult:0', type: 'tool_call_update', createdAt: at(9_000) }),
      event({ nativeId: '4:answer:0', type: 'agent_message_chunk', createdAt: at(11_000), data: { content: { type: 'text', text: 'second answer' } } }),
    ]);
    const durations = steps().map(step => step.durationMs).sort((left, right) => left - right);
    // 2s for the first answer and 2s for the second; the 7s tool call between them is excluded.
    expect(durations).toEqual([2_000, 2_000]);
  });

  it('carries the previous record across batches so a later batch is still timed', () => {
    const { instance, steps } = meter();
    instance.observe([event({ nativeId: '1:prompt:0', type: 'user_message_chunk', createdAt: at(0) })]);
    instance.observe([
      event({ nativeId: '2:answer:0', type: 'agent_message_chunk', createdAt: at(3_000), data: { content: { type: 'text', text: 'answer' } } }),
    ]);
    expect(steps()).toHaveLength(1);
    expect(steps()[0]!.durationMs).toBe(3_000);
  });

  it('leaves a response unmeasured when the window has no duration', () => {
    const { instance, steps } = meter();
    // A history rebuild stamps every message of a turn with the prompt's own timestamp.
    instance.observe([
      event({ nativeId: '1:prompt:0', type: 'user_message_chunk', createdAt: at(0) }),
      event({ nativeId: '2:answer:0', type: 'agent_message_chunk', createdAt: at(0), data: { content: { type: 'text', text: 'replayed answer' } } }),
    ]);
    expect(steps()).toHaveLength(0);
  });

  it('leaves a tool-calling response unmeasured, because it is committed only after the tool ran', () => {
    const { instance, steps } = meter();
    instance.observe([
      event({ nativeId: '1:prompt:0', type: 'user_message_chunk', createdAt: at(0) }),
      event({ nativeId: '2:call:0', type: 'agent_thought_chunk', createdAt: at(30_000), data: { content: { type: 'text', text: 'run the build' } } }),
      event({ nativeId: '2:call:1', type: 'tool_call', createdAt: at(30_000), data: { rawInput: { command: 'pnpm build' } } }),
      event({ nativeId: '3:toolresult:0', type: 'tool_call_update', createdAt: at(30_000) }),
      event({ nativeId: '4:answer:0', type: 'agent_message_chunk', createdAt: at(33_000), data: { content: { type: 'text', text: 'built' } } }),
    ]);
    expect(steps().map(step => step.stepId)).toEqual(['4:answer']);
    expect(steps()[0]!.durationMs).toBe(3_000);
  });

  it('times a response after the prompt from when the prompt was really sent', () => {
    const { instance, steps } = meter();
    instance.observe([
      // The prompt quotes a minute-precise time, which is what its record is stamped with.
      event({ nativeId: '1:prompt:0', type: 'user_message_chunk', createdAt: at(-40_000) }),
      event({ nativeId: '2:answer:0', type: 'agent_message_chunk', createdAt: at(4_000), data: { content: { type: 'text', text: 'answer' } } }),
    ]);
    expect(steps()[0]!.durationMs).toBe(4_000);
  });

  it('leaves a response after the prompt unmeasured when the send time is unknown', () => {
    const { instance, steps } = meter();
    instance.observe([
      event({ nativeId: '9:typed-in-terminal:0', type: 'user_message_chunk', createdAt: at(0) }),
      event({ nativeId: '10:answer:0', type: 'agent_message_chunk', createdAt: at(4_000), data: { content: { type: 'text', text: 'answer' } } }),
    ]);
    expect(steps()).toHaveLength(0);
  });

  it('does not publish the same record twice when a batch is re-read', () => {
    const { instance, frames } = meter();
    const batch = [
      event({ nativeId: '1:prompt:0', type: 'user_message_chunk', createdAt: at(0) }),
      event({ nativeId: '2:answer:0', type: 'agent_message_chunk', createdAt: at(2_000), data: { content: { type: 'text', text: 'answer' } } }),
    ];
    instance.observe(batch);
    const afterFirst = frames.length;
    instance.observe(batch);
    expect(frames.length).toBe(afterFirst);
  });

  it('forgets every turn when the chat root changes', () => {
    const { instance, steps } = meter();
    instance.observe([
      event({ nativeId: '1:prompt:0', type: 'user_message_chunk', createdAt: at(0) }),
      event({ nativeId: '2:answer:0', type: 'agent_message_chunk', createdAt: at(2_000), data: { content: { type: 'text', text: 'answer' } } }),
    ]);
    instance.reset();
    instance.observe([event({ nativeId: '3:answer:0', type: 'agent_message_chunk', createdAt: at(4_000), data: { content: { type: 'text', text: 'orphan' } } })]);
    // Without a preceding record there is no window, so nothing may be reported for the orphan.
    expect(steps()).toHaveLength(1);
  });

  it('measures an in-flight draft before its tool runs and settles on the pre-tool timestamp', () => {
    const { instance, steps, usage } = meter();
    instance.observe([event({ nativeId: '1:prompt:0', type: 'user_message_chunk', createdAt: at(0) })]);
    instance.observeDraft([
      event({ nativeId: '2:draft:0', type: 'agent_thought_chunk', createdAt: at(2_000), data: { content: { type: 'text', text: 'I will run the build now.' } } }),
      event({ nativeId: '2:draft:1', type: 'tool_call', createdAt: at(2_000), data: { rawInput: { command: 'pnpm build' } } }),
    ], Date.parse(at(2_000)));
    expect(steps().at(-1)).toMatchObject({ stepId: '2:draft', durationMs: 2_000, live: true });

    // The tool finishes 28 seconds later; the committed step keeps the 2-second generation window.
    instance.observe([
      event({ nativeId: '2:call:0', type: 'agent_thought_chunk', createdAt: at(30_000), data: { content: { type: 'text', text: 'I will run the build now.' } } }),
      event({ nativeId: '2:call:1', type: 'tool_call', createdAt: at(30_000), data: { rawInput: { command: 'pnpm build' } } }),
      event({ nativeId: '3:toolresult:0', type: 'tool_call_update', createdAt: at(30_000) }),
      event({ nativeId: '4:answer:0', type: 'agent_message_chunk', createdAt: at(33_000), data: { content: { type: 'text', text: 'Build finished.' } } }),
    ]);
    expect(usage.map(entry => [entry.usage.stepId, entry.usage.endedAt! - entry.usage.startedAt!])).toEqual([
      ['2:call', 2_000],
      ['4:answer', 3_000],
    ]);
  });
});
