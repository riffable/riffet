import { describe, expect, it } from 'vitest';
import type { NativeStreamMessage, NativeWorkbenchEvent, RunMetrics } from '@contracts';
import { CursorTranscriptMeter } from './cursor-metrics.js';
import { estimatedTokens, type UsageRecord } from '@riffet/plugin-api/kit';

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

  it('does not anchor post-restart drafts or commits to minute-precise historical replay timestamps', () => {
    const { instance, steps, usage } = meter();
    // Server restarted 10 minutes into a running turn: the reset replay carries only the prompt's time.
    instance.observe([
      event({ nativeId: '1:prompt:0', type: 'user_message_chunk', createdAt: at(0) }),
      event({ nativeId: '2:old-answer:0', type: 'agent_message_chunk', createdAt: at(0), data: { content: { type: 'text', text: 'earlier work' } } }),
      event({ nativeId: '3:old-tool:0', type: 'tool_call_update', createdAt: at(0) }),
    ], { historical: true });

    // The first draft/commit after restart started before we were watching: skip instead of logging a 10m duration.
    instance.observeDraft([
      event({ nativeId: '4:draft:0', type: 'agent_thought_chunk', createdAt: at(600_000), data: { content: { type: 'text', text: 'mid-flight after restart' } } }),
      event({ nativeId: '4:draft:1', type: 'tool_call', createdAt: at(600_000), data: { rawInput: { path: 'a.ts' } } }),
    ], Date.parse(at(600_000)));
    expect(steps()).toHaveLength(0);

    instance.observe([
      event({ nativeId: '4:call:0', type: 'agent_thought_chunk', createdAt: at(605_000), data: { content: { type: 'text', text: 'mid-flight after restart' } } }),
      event({ nativeId: '4:call:1', type: 'tool_call', createdAt: at(605_000), data: { rawInput: { path: 'a.ts' } } }),
      event({ nativeId: '5:toolresult:0', type: 'tool_call_update', createdAt: at(605_000) }),
    ]);
    expect(usage).toHaveLength(0);

    // Subsequent steps now have a real observed anchor (605s) and measure accurately.
    instance.observe([
      event({ nativeId: '6:answer:0', type: 'agent_message_chunk', createdAt: at(608_000), data: { content: { type: 'text', text: 'done' } } }),
    ]);
    expect(usage).toHaveLength(1);
    expect(usage[0]!.usage.endedAt! - usage[0]!.usage.startedAt!).toBe(3_000);
  });

  it('resolves runId and promptSentAt via request:<nativeTurnId> alias and pre-warms async lookups on prompt', () => {
    const frames: NativeStreamMessage[] = [];
    const saved: Array<{ runId: string; metrics: RunMetrics }> = [];
    const usage: Array<{ sessionId: string; runId: string | undefined; usage: UsageRecord }> = [];
    let lookups = 0;
    const instance = new CursorTranscriptMeter(
      message => frames.push(message),
      (runId, metrics) => saved.push({ runId, metrics }),
      nativeMessageId => {
        if (nativeMessageId !== 'request:req-42') return undefined;
        // Mimic CursorPort's async cache: first call triggers lookup, second returns the cached run id.
        lookups += 1;
        return lookups >= 2 ? 'run-42' : undefined;
      },
      runId => (runId === 'run-42' ? Date.parse(at(1_000)) : undefined),
      { recordUsage: (sessionId, runId, record) => { usage.push({ sessionId, runId, usage: record }); }, observeEvents: () => undefined },
      'session',
    );
    instance.observe([
      event({ nativeId: '2:blobhash:0', nativeTurnId: 'req-42', type: 'user_message_chunk', createdAt: at(0) }),
    ]);
    instance.observe([
      event({ nativeId: '3:answer:0', nativeTurnId: 'req-42', type: 'agent_message_chunk', createdAt: at(4_000), data: { content: { type: 'text', text: 'hello world' } } }),
    ]);
    expect(saved.at(-1)).toMatchObject({ runId: 'run-42', metrics: { durationMs: 3_000, steps: 1 } });
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ runId: 'run-42', usage: { nativeMessageId: 'request:req-42', startedAt: Date.parse(at(1_000)), endedAt: Date.parse(at(4_000)) } });
  });

  it('streams live-tap deltas over a true stream window without double-counting when SQLite commits', () => {
    const frames: NativeStreamMessage[] = [];
    const saved: Array<{ runId: string; metrics: RunMetrics }> = [];
    const usage: Array<{ sessionId: string; runId: string | undefined; usage: UsageRecord }> = [];
    const instance = new CursorTranscriptMeter(
      message => frames.push(message),
      (runId, metrics) => saved.push({ runId, metrics }),
      nativeMessageId => (nativeMessageId === 'request:req-9' ? 'run-9' : undefined),
      runId => (runId === 'run-9' ? Date.parse(at(0)) : undefined),
      { recordUsage: (sessionId, runId, record) => { usage.push({ sessionId, runId, usage: record }); }, observeEvents: () => undefined },
      'session',
    );
    const t0 = Date.parse(at(0));
    instance.observe([event({ nativeId: '1:prompt:0', nativeTurnId: 'req-9', type: 'user_message_chunk', createdAt: at(0) })]);

    // A stale already-sealed snapshot from before restart is ignored.
    instance.observeLiveStep({ turn: 'req-9', at: at(0), step: 'req-9:0', sealed: true, parts: [{ type: 'text', text: 'stale' }] }, t0 + 1_000);
    expect(frames).toHaveLength(0);

    // Live tap starts streaming after 2s of TTFT: stream window is [t0+2000, t0+4000] = 2s (not 4s).
    instance.observeLiveStep({
      turn: 'req-9', at: at(0), step: 'req-9:1', sealed: false,
      firstDeltaAt: t0 + 2_000, lastDeltaAt: t0 + 2_600,
      parts: [{ type: 'text', text: 'a'.repeat(120) }],
    }, t0 + 2_600);
    instance.observeLiveStep({
      turn: 'req-9', at: at(0), step: 'req-9:1', sealed: true,
      firstDeltaAt: t0 + 2_000, lastDeltaAt: t0 + 4_000,
      parts: [{ type: 'text', text: 'a'.repeat(400) }],
    }, t0 + 4_000);
    // SQLite commits the same message 500ms later.
    instance.observe([
      event({ nativeId: '2:answer:0', nativeTurnId: 'req-9', type: 'agent_message_chunk', createdAt: at(4_500), data: { content: { type: 'text', text: 'a'.repeat(400) } } }),
    ]);

    expect(saved.at(-1)?.metrics).toMatchObject({
      outputTokens: estimatedTokens('a'.repeat(400)),
      durationMs: 2_000,
      window: 'stream',
      steps: 1,
    });
    expect(usage).toHaveLength(1);
    expect(usage[0]!.usage).toMatchObject({
      stepId: '2:answer',
      startedAt: t0 + 2_000,
      endedAt: t0 + 4_000,
      window: 'stream',
    });
  });

  it('measures incremental live-tap deltas for already-running CLIs that lack tap timestamps', () => {
    const frames: NativeStreamMessage[] = [];
    const instance = new CursorTranscriptMeter(
      message => frames.push(message),
      () => undefined,
      () => undefined,
    );
    const t0 = Date.parse(at(0));
    // First observation records existing prefix as baseline without emitting a 0ms burst.
    instance.observeLiveStep({ turn: 'req-old', at: at(0), step: 'req-old:1', sealed: false, parts: [{ type: 'reasoning', text: 'existing prefix ' }] }, t0);
    expect(frames).toHaveLength(0);
    // Subsequent delta measures only the newly generated tail over [t0, t0+2000].
    instance.observeLiveStep({ turn: 'req-old', at: at(0), step: 'req-old:1', sealed: true, parts: [{ type: 'reasoning', text: 'existing prefix ' + 'b'.repeat(200) }] }, t0 + 2_000);
    const step = frames.flatMap(frame => frame.type === 'metrics' ? [frame.metrics] : []).at(-1);
    expect(step).toMatchObject({
      stepId: 'live:req-old:1',
      outputTokens: estimatedTokens('b'.repeat(200)),
      durationMs: 2_000,
      window: 'stream',
      live: false,
    });
  });
});
