import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { AgentLaneWriter } from '@riffet/plugin-api/experimental/agent';
import { agyStepIdentity, AntigravityTranscriptSource, mapAgySnapshot } from './transcript.js';
import type { AgySnapshot } from './protocol.js';
const cid = '11111111-1111-1111-1111-111111111111',
  tid = '22222222-2222-2222-2222-222222222222';
function snapshot(): AgySnapshot {
  return {
    conversationId: cid,
    trajectoryId: tid,
    steps: [
      {
        type: 'CORTEX_STEP_TYPE_USER_INPUT',
        status: 'CORTEX_STEP_STATUS_DONE',
        metadata: md('run-a', 0),
        userInput: { userResponse: 'Same', clientMessageId: 'replayed-client-id' },
      },
      {
        type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
        status: 'CORTEX_STEP_STATUS_GENERATING',
        metadata: md('run-a', 1),
        plannerResponse: { messageId: 'message-a', response: 'Par' },
      },
    ],
    executors: [],
  };
}
function md(executionId: string, stepIndex: number) {
  return { executionId, createdAt: '2026-11-13T00:00:00Z', sourceTrajectoryStepInfo: { trajectoryId: tid, stepIndex, cascadeId: cid } };
}
function writer() {
  const batches: any[] = [],
    lifecycle: any[] = [],
    ended = new Map();
  const w = {
    lane: 'main',
    generation: 'original',
    cursor: null as string | null,
    commit(batch: any) {
      batches.push(batch);
      w.cursor = batch.cursor;
    },
    turnStarted(...args: any[]) {
      lifecycle.push(['started', ...args]);
    },
    turnEnded(id: string, status: string, ...args: any[]) {
      ended.set(id, status);
      lifecycle.push(['ended', id, status, ...args]);
    },
    turnEndStatus(id: string) {
      return ended.get(id);
    },
    turnReopened(id: string) {
      ended.delete(id);
      lifecycle.push(['reopened', id]);
    },
    retireSubagent() {},
    rebuild() {
      throw new Error('unexpected generation rebuild');
    },
  };
  return { w: w as unknown as AgentLaneWriter, batches, lifecycle };
}
function source(read: () => AgySnapshot) {
  return new AntigravityTranscriptSource({
    sessionId: 'session',
    nativeId: () => cid,
    geminiDir: () => '/tmp/riffet-agy-nonexistent-unit-root',
    live: read,
    watch: () => () => {},
  });
}
it('replays idempotently and settles a streamed draft under the same message identity', async () => {
  const s = snapshot(),
    f = writer(),
    reader = source(() => s),
    signal = new AbortController().signal;
  await reader.pull(f.w, signal);
  const before = f.batches.length,
    life = f.lifecycle.length;
  const draft = f.batches.flatMap(b => b.drafts ?? [])[0];
  await reader.pull(f.w, signal);
  expect(f.batches).toHaveLength(before);
  expect(f.lifecycle).toHaveLength(life);
  s.steps[1].status = 'CORTEX_STEP_STATUS_DONE';
  s.steps[1].plannerResponse.response = 'Partial done';
  s.executors.push({ executionId: 'run-a', lastStepIdx: 1, terminationReason: 'EXECUTOR_TERMINATION_REASON_NO_TOOL_CALL' });
  await reader.pull(f.w, signal);
  expect(
    f.batches
      .slice(before)
      .flatMap(b => b.events)
      .find(e => e.type === 'agent_message_chunk').nativeId,
  ).toBe(draft.finalId);
  expect(f.lifecycle.find(l => l[0] === 'ended')).toEqual(expect.arrayContaining(['run-a', 'completed']));
});
it('keeps the live view over a store it cannot read, and reads nothing yet as caught up', async () => {
  const root = mkdtempSync(join(tmpdir(), 'riffet-agy-store-'));
  try {
    mkdirSync(join(root, 'antigravity-cli', 'conversations'), { recursive: true });
    writeFileSync(join(root, 'antigravity-cli', 'conversations', `${cid}.db`), 'not a database');
    const open = (live: () => AgySnapshot | undefined, nativeId: () => string | undefined = () => cid) =>
      new AntigravityTranscriptSource({ sessionId: 'session', nativeId, geminiDir: () => root, live, watch: () => () => {} });
    const signal = new AbortController().signal;
    const f = writer();
    // The store only fills in envelopes of live steps; refusing it must not stop the conversation view.
    expect(await open(() => snapshot()).pull(f.w, signal)).toEqual({ caughtUp: true });
    expect(f.batches.flatMap(b => b.events ?? []).some(e => e.type === 'user_message_chunk')).toBe(true);
    // Without a live snapshot the store is the only source, and its refusal stands.
    await expect(open(() => undefined).pull(writer().w, signal)).rejects.toThrow();
    // Before agy names a conversation there is nothing to read; `false` would have the host pull again at once.
    expect(await open(() => undefined, () => undefined).pull(writer().w, signal)).toEqual({ caughtUp: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it('retains ancestor identities and retires removed turn end before its start on rewind', async () => {
  const s = snapshot();
  s.steps[1].status = 'CORTEX_STEP_STATUS_DONE';
  s.steps.push({
    type: 'CORTEX_STEP_TYPE_USER_INPUT',
    status: 'CORTEX_STEP_STATUS_DONE',
    metadata: md('run-b', 2),
    userInput: { userResponse: 'Same', clientMessageId: 'replayed-client-id' },
  });
  const f = writer(),
    reader = source(() => s),
    signal = new AbortController().signal;
  expect(
    mapAgySnapshot(s)
      .events.filter(e => e.type === 'user_message_chunk')
      .map(e => e.nativeId),
  ).toHaveLength(2);
  await reader.pull(f.w, signal);
  const before = f.batches.length,
    ancestor = mapAgySnapshot(s).events[0].nativeId;
  s.steps.splice(2);
  s.trajectoryId = '33333333-3333-3333-3333-333333333333';
  await reader.pull(f.w, signal);
  const retired = f.batches.slice(before).flatMap(b => b.retire ?? []);
  expect(retired.slice(0, 2)).toEqual(['meta:turn:run-b:ended', 'meta:turn:run-b:started']);
  expect(retired).not.toContain(ancestor);
  expect(f.w.generation).toBe('original');
});
it('uses executor outcomes and real call IDs without treating handled tool failures or idle as completed', () => {
  const s = snapshot();
  s.steps[1].status = 'CORTEX_STEP_STATUS_DONE';
  s.steps[1].plannerResponse.toolCalls = [{ id: 'call-real', name: 'run_command', argumentsJson: '{"command":"false"}' }];
  s.steps.push({
    type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
    status: 'CORTEX_STEP_STATUS_ERROR',
    metadata: { ...md('run-a', 2), toolCall: { id: 'call-real', name: 'run_command', argumentsJson: '{}' } },
    error: { shortError: 'denied' },
    runCommand: {},
  });
  s.fullyIdle = true;
  let m = mapAgySnapshot(s);
  expect(m.turns[0].status).toBeUndefined();
  expect(m.events.filter(e => e.type === 'tool_call')).toHaveLength(1);
  expect(m.events.find(e => e.type === 'tool_call_update')?.data).toMatchObject({ toolCallId: 'call-real', status: 'failed' });
  s.steps[2].error = { modelErrorMessage: 'Internal retry instructions' };
  const result = mapAgySnapshot(s).events.find(e => e.type === 'tool_call_update')!;
  expect(result.data.status).toBe('failed');
  expect(JSON.stringify(result.data.content)).not.toContain('Internal retry instructions');
  s.executors = [{ executionId: 'run-a', lastStepIdx: 2, terminationReason: 'EXECUTOR_TERMINATION_REASON_USER_CANCELED' }];
  expect(mapAgySnapshot(s).turns[0].status).toBe('cancelled');
  s.executors[0].terminationReason = 'EXECUTOR_TERMINATION_REASON_ERROR';
  s.executors[0].executionError = 'provider failed';
  expect(mapAgySnapshot(s).turns[0]).toMatchObject({ status: 'failed', error: 'provider failed' });
  // Any reason but UNSPECIFIED ends the turn; one this mapping does not know must not leave the run open.
  s.executors[0] = { executionId: 'run-a', lastStepIdx: 2, terminationReason: 'EXECUTOR_TERMINATION_REASON_UNSPECIFIED' };
  expect(mapAgySnapshot(s).turns[0].status).toBeUndefined();
  s.executors[0].terminationReason = 'EXECUTOR_TERMINATION_REASON_CHAINED';
  expect(mapAgySnapshot(s).turns[0].status).toBe('completed');
  s.executors[0].terminationReason = 'EXECUTOR_TERMINATION_REASON_UNKNOWN_99';
  s.executors[0].lastStepIdx = 9;
  expect(mapAgySnapshot(s).turns[0].status).toBe('interrupted');
});

it('separates executions at reused source coordinates and retains ancestor identity across branch changes', () => {
  const s = snapshot(),
    user = s.steps[0],
    original = agyStepIdentity(s, user, 0);
  expect(agyStepIdentity({ ...s, trajectoryId: '33333333-3333-3333-3333-333333333333' }, user, 0)).toBe(original);
  expect(agyStepIdentity(s, { ...user, metadata: { ...user.metadata, executionId: 'run-b' } }, 0)).not.toBe(original);
});

it('rebuilds when a step is inserted ahead of existing steps and commits in snapshot step order', async () => {
  const s = snapshot();
  s.steps[1].status = 'CORTEX_STEP_STATUS_DONE';
  const batches: any[] = [];
  let rebuilds = 0;
  const w = {
    lane: 'main',
    generation: 'g1',
    cursor: null as string | null,
    commit(batch: any) {
      batches.push(batch);
      w.cursor = batch.cursor;
    },
    turnStarted() {},
    turnEnded() {},
    turnEndStatus() { return undefined; },
    turnReopened() {},
    retireSubagent() {},
    rebuild() {
      rebuilds += 1;
      w.generation = `g${rebuilds + 1}`;
      w.cursor = null;
      batches.length = 0;
    },
  };
  const reader = source(() => s),
    signal = new AbortController().signal;
  await reader.pull(w as unknown as AgentLaneWriter, signal);
  expect(rebuilds).toBe(0);

  // Insert a user-facing notice before a previously committed planner response.
  s.steps.splice(1, 0, {
    type: 'CORTEX_STEP_TYPE_SYSTEM_MESSAGE',
    status: 'CORTEX_STEP_STATUS_DONE',
    metadata: { createdAt: '2026-11-13T00:00:00Z', sourceTrajectoryStepInfo: { trajectoryId: tid, stepIndex: 99, cascadeId: cid } },
    systemMessage: { message: 'For the model', renderInfo: { title: 'Review ready', markdown: 'Open the review.' } },
  });
  await reader.pull(w as unknown as AgentLaneWriter, signal);
  expect(rebuilds).toBe(1);
  const committedIds = batches.flatMap(b => (b.events ?? []).map((e: any) => e.nativeId));
  expect(committedIds).toEqual(mapAgySnapshot(s).order);
});

it('projects only user-facing notices and retires an already published system envelope on replay', async () => {
  const s = snapshot();
  const internal = '[Message] sender=system content=[Notice] Previous background tasks stopped';
  const presentation = { title: 'Review ready', contentBlocks: [{ markdown: 'Open the review.' }] };
  s.steps[0].userInput.userResponse = internal; // A user can quote the exact same text.
  const step = (payload: Record<string, unknown>) => ({
    status: 'CORTEX_STEP_STATUS_DONE', metadata: md('run-a', s.steps.length), ...payload,
  });
  s.steps.push(step({ systemMessage: { message: internal, renderInfo: { ...presentation, hidden: true } } }));
  const publishedId = `antigravity:${agyStepIdentity(s, s.steps[2], 2)}:notice`;
  s.steps.push(step({ systemMessage: { message: internal, renderInfo: presentation, agentMessage: { hideFromUser: true } } }));
  s.steps.push(step({ systemMessage: { message: internal } }));
  s.steps.push(step({ systemMessage: { message: internal, renderInfo: { showOnError: true } } }));
  s.steps.push(step({ ephemeralMessage: { content: internal } }));
  s.steps.push(step({ type: 'CORTEX_STEP_TYPE_NEW_INTERNAL_STEP' }));
  s.steps.push(step({ systemMessage: { message: internal, renderInfo: presentation } }));
  s.steps.push(step({ notifyUser: { notificationContent: 'Ready for feedback.' } }));
  s.steps.push(step({ status: 'CORTEX_STEP_STATUS_WAITING', notifyUser: { notificationContent: 'Review pending.' } }));
  s.steps.push(step({ status: 'CORTEX_STEP_STATUS_CANCELED', notifyUser: { notificationContent: 'Review withdrawn.' } }));
  s.steps.push(step({ errorMessage: { shouldShowModel: true, error: {} }, error: { userErrorMessage: internal } }));
  s.steps.push(step({ errorMessage: { shouldShowUser: true, error: { shortError: 'Diagnostics' } }, error: { userErrorMessage: 'Reconnect to continue.' } }));
  s.steps.push(step({ error: { shortError: 'Rate limited.' } }));
  s.steps.push(step({ error: { modelErrorMessage: 'Internal retry.' } }));

  const mapped = mapAgySnapshot(s);
  expect(mapped.events[0].data.content).toEqual({ type: 'text', text: internal });
  expect(mapped.events.slice(1).map(e => [e.type, e.data.title, e.data.detail, e.data.status])).toEqual([
    ['task_notification', 'Review ready', 'Open the review.', 'completed'],
    ['task_notification', 'Ready for feedback.', undefined, 'completed'],
    ['task_notification', 'Review withdrawn.', undefined, 'cancelled'],
    ['task_notification', 'Reconnect to continue.', undefined, 'failed'],
    ['task_notification', 'Rate limited.', undefined, 'failed'],
  ]);
  expect(mapped.drafts.filter(d => d.event.type === 'task_notification').map(d => d.event.data.status)).toEqual(['running']);
  expect(mapped.warnings).toEqual(['Unmapped Antigravity step CORTEX_STEP_TYPE_NEW_INTERNAL_STEP.']);

  const f = writer(), reader = source(() => s), signal = new AbortController().signal;
  // Older versions persisted the hidden step as a local_command activity.
  f.w.commit({ events: [], cursor: JSON.stringify({
    version: 1, conversationId: cid, events: [[publishedId, 'old-digest']], drafts: [], turns: [], children: [],
  }) });
  await reader.pull(f.w, signal);
  expect(f.batches.flatMap(b => b.retire ?? [])).toEqual([publishedId]);
  const count = f.batches.length;
  await reader.pull(f.w, signal);
  expect(f.batches).toHaveLength(count);
});
