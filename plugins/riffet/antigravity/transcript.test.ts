import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it, vi } from 'vitest';
import type { AgentHost, AgentLaneWriter } from '@riffet/plugin-api/experimental/agent';
import { agyStepIdentity, AntigravityTranscriptSource, mapAgySnapshot, readAgyHistory } from './transcript.js';
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

function viEnc(n: number): Buffer {
  const out: number[] = [];
  do {
    out.push((n & 127) | (n > 127 ? 128 : 0));
    n = Math.floor(n / 128);
  } while (n);
  return Buffer.from(out);
}
function pbScalar(n: number, value: number): Buffer {
  return Buffer.concat([viEnc(n * 8), viEnc(value)]);
}
function pbBytes(n: number, value: string | Buffer): Buffer {
  const b = typeof value === 'string' ? Buffer.from(value) : value;
  return Buffer.concat([viEnc(n * 8 + 2), viEnc(b.length), b]);
}
function createAgyDb(
  root: string,
  conversationId: string,
  trajectoryId: string,
  steps: Array<{ type: number; status: number; metadata?: Buffer; field: number; body: Buffer }>,
  metaBlob?: Buffer,
) {
  const dir = join(root, 'antigravity-cli', 'conversations');
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, `${conversationId}.db`));
  try {
    db.exec(`PRAGMA user_version=1;
      CREATE TABLE trajectory_meta(trajectory_id TEXT,cascade_id TEXT);
      CREATE TABLE steps(idx INTEGER PRIMARY KEY,step_type INTEGER,status INTEGER,has_subtrajectory INTEGER,metadata BLOB,error_details BLOB,permissions BLOB,task_details BLOB,render_info BLOB,step_payload BLOB,step_format INTEGER);
      CREATE TABLE executor_metadata(idx INTEGER PRIMARY KEY,data BLOB);
      CREATE TABLE trajectory_metadata_blob(id TEXT,data BLOB);`);
    db.prepare('INSERT INTO trajectory_meta VALUES(?,?)').run(trajectoryId, conversationId);
    const ins = db.prepare('INSERT INTO steps VALUES(?,?,?,0,?,NULL,NULL,NULL,NULL,?,0)');
    steps.forEach((step, idx) => {
      const mdBuf = step.metadata ?? Buffer.alloc(0);
      const parts = [pbScalar(1, step.type), pbScalar(4, step.status), ...(step.metadata ? [pbBytes(5, mdBuf)] : []), pbBytes(step.field, step.body)];
      ins.run(idx, step.type, step.status, step.metadata ?? null, Buffer.concat(parts));
    });
    if (metaBlob) db.prepare('INSERT INTO trajectory_metadata_blob VALUES(?,?)').run('main', metaBlob);
  } finally {
    db.close();
  }
}

it('hydrates persisted GENERIC steps with live snapshots without triggering identity-changed rebuilds', async () => {
  const root = mkdtempSync(join(tmpdir(), 'riffet-agy-generic-'));
  try {
    const md0 = Buffer.concat([pbBytes(12, 'run-a'), pbBytes(20, Buffer.concat([pbBytes(1, tid), pbScalar(2, 0), pbBytes(4, cid)]))]);
    const toolBuf = Buffer.concat([pbBytes(1, 'call-1'), pbBytes(2, 'run_command'), pbBytes(3, '{"command":"echo hi"}')]);
    const md1 = Buffer.concat([pbBytes(12, 'run-a'), pbBytes(4, toolBuf), pbBytes(20, Buffer.concat([pbBytes(1, tid), pbScalar(2, 1), pbBytes(4, cid)]))]);
    const runCmd = Buffer.concat([pbBytes(6, 'echo hi'), pbBytes(7, '/tmp')]);
    const genericBody = pbBytes(2, Buffer.concat([pbBytes(1, 'hi'), pbBytes(6, Buffer.concat([pbBytes(1, 'type.googleapis.com/exa.cortex.core.tools.RunCommand'), pbBytes(2, runCmd)]))]));
    createAgyDb(root, cid, tid, [
      { type: 14, status: 3, metadata: md0, field: 19, body: pbBytes(2, 'Run it') },
      { type: 132, status: 3, metadata: md1, field: 140, body: genericBody },
    ]);

    const liveSnap: AgySnapshot = {
      conversationId: cid,
      trajectoryId: tid,
      steps: [
        { type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE', metadata: md('run-a', 0), userInput: { userResponse: 'Run it' } },
        // Live stream carries CORTEX_STEP_TYPE_GENERIC without the persisted runCommand envelope.
        { type: 'CORTEX_STEP_TYPE_GENERIC', status: 'CORTEX_STEP_STATUS_DONE', metadata: { ...md('run-a', 1), toolCall: { id: 'call-1', name: 'run_command', argumentsJson: '{"command":"echo hi"}' } }, generic: { result: { result: 'hi' } } },
      ],
      executors: [],
    };
    const f = writer();
    const reader = new AntigravityTranscriptSource({
      sessionId: 'session',
      nativeId: () => cid,
      geminiDir: () => root,
      live: () => liveSnap,
      watch: () => () => {},
    });
    const signal = new AbortController().signal;
    await reader.pull(f.w, signal);
    await reader.pull(f.w, signal);
    expect(f.w.generation).toBe('original');
    const resultEvent = f.batches.flatMap(b => b.events ?? []).find(e => e.type === 'tool_call_update');
    expect(resultEvent?.data).toMatchObject({ toolCallId: 'call-1', status: 'completed' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('does not rebuild when plannerResponse streams thinking/toolCalls before late answer or late messageId and preserves inputTokens with cache', async () => {
  const s: AgySnapshot = {
    conversationId: cid,
    trajectoryId: tid,
    steps: [
      { type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE', metadata: md('run-a', 0), userInput: { userResponse: 'Check' } },
      {
        type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
        status: 'CORTEX_STEP_STATUS_GENERATING',
        metadata: md('run-a', 1),
        plannerResponse: { thinking: 'Checking…', toolCalls: [{ id: 'tool-1', name: 'view_file', argumentsJson: '{"path":"a.ts"}' }] },
      },
    ],
    executors: [],
  };
  const f = writer(),
    reader = source(() => s),
    signal = new AbortController().signal;
  await reader.pull(f.w, signal);

  // Frame 2: messageId arrives late AND answer arrives ahead of the already-committed tool_call.
  s.steps[1].plannerResponse.messageId = 'late-msg-1';
  s.steps[1].plannerResponse.response = 'Reading file';
  await reader.pull(f.w, signal);
  const answerDraft = f.batches.flatMap(b => b.drafts ?? []).find(d => d.event.type === 'agent_message_chunk')!;
  expect(answerDraft).toBeDefined();

  // Frame 3: step settles with cached + input tokens; answer keeps the exact same nativeId without rebuild.
  s.steps[1].status = 'CORTEX_STEP_STATUS_DONE';
  s.steps[1].plannerResponse.response = 'Reading file done';
  s.steps[1].metadata.modelUsage = { inputTokens: 120, cacheReadTokens: 80, outputTokens: 30 };
  const beforeSettle = f.batches.length;
  await reader.pull(f.w, signal);
  const settledAnswer = f.batches.slice(beforeSettle).flatMap(b => b.events ?? []).find(e => e.type === 'agent_message_chunk');
  expect(settledAnswer?.nativeId).toBe(answerDraft.finalId);
  expect(f.w.generation).toBe('original');

  const mapped = mapAgySnapshot(s);
  expect(mapped.usage[0]?.usage).toMatchObject({ inputTokens: 120, cacheReadTokens: 80, outputTokens: 30 });
});

it('settles open drafts atomically before turnEnded via settleTurnEnd and does not falsely reopen on subsequent pull', async () => {
  const s = snapshot();
  const txOps: string[] = [];
  const f = writer();
  const baseCommit = f.w.commit.bind(f.w);
  const baseEnded = f.w.turnEnded.bind(f.w);
  let inTx = 0;
  f.w.transaction = (task: () => void) => {
    inTx += 1;
    txOps.push('tx:start');
    try {
      task();
    } finally {
      txOps.push('tx:end');
      inTx -= 1;
    }
  };
  f.w.commit = (batch: any) => {
    expect(inTx).toBeGreaterThan(0);
    if (batch.events?.some((e: any) => e.type === 'agent_message_chunk')) txOps.push('commit:answer');
    baseCommit(batch);
  };
  f.w.turnEnded = (id: string, status: any, at: string, err?: string) => {
    expect(inTx).toBeGreaterThan(0);
    txOps.push(`ended:${id}:${status}`);
    baseEnded(id, status, at, err);
  };

  let statsCalls = 0;
  const host = {
    stats: { observeEvents: () => { statsCalls += 1; }, recordUsage: () => {} },
    emit: () => {},
  } as unknown as AgentHost;
  const reader = new AntigravityTranscriptSource({
    sessionId: 'session',
    nativeId: () => cid,
    geminiDir: () => '/tmp/riffet-agy-nonexistent-unit-root',
    live: () => s,
    watch: () => () => {},
    host,
  });
  const signal = new AbortController().signal;
  await reader.pull(f.w, signal);
  expect(statsCalls).toBe(1);
  // Idle pull does not re-emit stats.
  await reader.pull(f.w, signal);
  expect(statsCalls).toBe(1);

  txOps.length = 0;
  expect(await reader.settleTurnEnd(f.w, { turnId: 'unknown-turn', status: 'interrupted', at: '2026-11-13T00:01:00.000Z' })).toBe(false);
  expect(await reader.settleTurnEnd(f.w, { turnId: 'run-a', status: 'interrupted', at: '2026-11-13T00:01:00.000Z' })).toBe(true);
  // Draft promoted to committed event BEFORE turnEnded inside one transaction (D1).
  expect(txOps).toEqual(['tx:start', 'commit:answer', 'ended:run-a:interrupted', 'tx:end']);

  const batchesAfterSettle = f.batches.length;
  const lifeAfterSettle = f.lifecycle.length;
  const statsAfterSettle = statsCalls;
  // Next pull with unchanged snapshot must NOT reopen the settled turn or commit anything.
  await reader.pull(f.w, signal);
  expect(f.batches).toHaveLength(batchesAfterSettle);
  expect(f.lifecycle).toHaveLength(lifeAfterSettle);
  expect(f.lifecycle.some(l => l[0] === 'reopened')).toBe(false);
  expect(statsCalls).toBe(statsAfterSettle);

  // If Antigravity genuinely resumes and appends new output, the turn reopens.
  s.steps[1].plannerResponse.response = 'Par resumed';
  await reader.pull(f.w, signal);
  expect(f.lifecycle.some(l => l[0] === 'reopened' && l[1] === 'run-a')).toBe(true);
});

it('binds multiple subagents for one tool call, skips unchanged child stores, isolates corrupt children, and does not register a 750ms timer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'riffet-agy-children-'));
  try {
    const child1 = '44444444-4444-4444-4444-444444444444';
    const child2 = '55555555-5555-5555-5555-555555555555';
    const badChild = '66666666-6666-6666-6666-666666666666';
    const childTid1 = '77777777-7777-7777-7777-777777777777';
    const childTid2 = '88888888-8888-8888-8888-888888888888';
    createAgyDb(
      root,
      child1,
      childTid1,
      [{ type: 14, status: 3, metadata: pbBytes(12, 'sub-1'), field: 19, body: pbBytes(2, 'Task 1') }],
      pbBytes(5, cid),
    );
    createAgyDb(
      root,
      child2,
      childTid2,
      [{ type: 14, status: 3, metadata: pbBytes(12, 'sub-2'), field: 19, body: pbBytes(2, 'Task 2') }],
      pbBytes(5, cid),
    );
    writeFileSync(join(root, 'antigravity-cli', 'conversations', `${badChild}.db`), 'corrupt');

    const s: AgySnapshot = {
      conversationId: cid,
      trajectoryId: tid,
      steps: [
        { type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE', metadata: md('run-a', 0), userInput: { userResponse: 'Spawn' } },
        {
          type: 'CORTEX_STEP_TYPE_GENERIC',
          status: 'CORTEX_STEP_STATUS_DONE',
          metadata: { ...md('run-a', 1), toolCall: { id: 'call-sub', name: 'invoke_subagent', argumentsJson: '{}' } },
          invokeSubagent: {
            subagents: [{ role: 'Alpha' }, { role: 'Beta' }, { role: 'Corrupt' }, { role: 'Missing' }],
            results: [{ conversationId: child1 }, { conversationId: child2 }, { conversationId: badChild }, {}],
          },
        },
      ],
      executors: [],
    };
    const mapped = mapAgySnapshot(s);
    expect(mapped.warnings).toEqual([]);
    expect(mapped.children.map(c => [c.toolCallId, c.agentId, c.title])).toEqual([
      ['call-sub', child1, 'Alpha'],
      ['call-sub:1', child2, 'Beta'],
      ['call-sub:2', badChild, 'Corrupt'],
    ]);

    const childCalls: string[] = [];
    const childLanes = new Map<string, ReturnType<typeof writer>>();
    const f = writer();
    (f.w as any).child = (toolCallId: string, agentId: string) => {
      childCalls.push(`${toolCallId}:${agentId}`);
      let lane = childLanes.get(toolCallId);
      if (!lane) {
        lane = writer();
        childLanes.set(toolCallId, lane);
      }
      return lane.w;
    };
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const reader = new AntigravityTranscriptSource({
      sessionId: 'session',
      nativeId: () => cid,
      geminiDir: () => root,
      live: () => s,
      watch: () => () => {},
    });
    const stop = reader.watch(f.w, () => {});
    stop();
    expect(setIntervalSpy).not.toHaveBeenCalled();
    setIntervalSpy.mockRestore();

    const signal = new AbortController().signal;
    await reader.pull(f.w, signal);
    expect(childCalls).toEqual([`call-sub:${child1}`, `call-sub:1:${child2}`]);
    // Second pull with unchanged child DBs skips w.child() entirely.
    childCalls.length = 0;
    await reader.pull(f.w, signal);
    expect(childCalls).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('filters readAgyHistory by selection, extracts modelInfo/turnModels, and respects abort signal', () => {
  const root = mkdtempSync(join(tmpdir(), 'riffet-agy-history-'));
  try {
    const child1 = '44444444-4444-4444-4444-444444444444';
    const childTid = '77777777-7777-7777-7777-777777777777';
    createAgyDb(
      root,
      child1,
      childTid,
      [{ type: 14, status: 3, metadata: pbBytes(12, 'sub-run'), field: 19, body: pbBytes(2, 'Sub work') }],
      pbBytes(5, cid),
    );
    const stepMd = (exec: string, idx: number, extra: Buffer[] = []) =>
      Buffer.concat([pbBytes(12, exec), pbBytes(20, Buffer.concat([pbBytes(1, tid), pbScalar(2, idx), pbBytes(4, cid)])), ...extra]);
    const usage = (inp: number, out: number) => pbBytes(9, Buffer.concat([pbScalar(2, inp), pbScalar(3, out)]));
    const model = (name: string) => pbBytes(24, pbBytes(12, name));
    const toolMd = pbBytes(4, Buffer.concat([pbBytes(1, 'call-sub'), pbBytes(2, 'invoke_subagent'), pbBytes(3, '{}')]));
    const invokeGeneric = pbBytes(
      2,
      pbBytes(
        6,
        Buffer.concat([
          pbBytes(1, 'type.googleapis.com/exa.cortex.core.tools.InvokeSubagent'),
          pbBytes(2, Buffer.concat([pbBytes(1, pbBytes(2, 'Helper')), pbBytes(2, pbBytes(1, child1))])),
        ]),
      ),
    );
    createAgyDb(root, cid, tid, [
      { type: 14, status: 3, metadata: stepMd('run-1', 0), field: 19, body: pbBytes(2, 'First') },
      { type: 15, status: 3, metadata: stepMd('run-1', 1, [usage(10, 5), model('gemini-2.5-pro')]), field: 20, body: pbBytes(1, 'Answer 1') },
      { type: 132, status: 3, metadata: stepMd('run-1', 2, [toolMd]), field: 140, body: invokeGeneric },
      { type: 14, status: 3, metadata: stepMd('run-2', 3), field: 19, body: pbBytes(2, 'Second') },
      { type: 15, status: 3, metadata: stepMd('run-2', 4, [usage(20, 8), model('gemini-2.5-flash')]), field: 20, body: pbBytes(1, 'Answer 2') },
    ]);

    const full = readAgyHistory(root, cid, 'session');
    expect(full.turns?.map(t => t.id)).toEqual(['run-1', 'run-2']);
    expect(full.selectedTurnIds).toEqual(['run-1', 'run-2']);
    expect(full.subagents).toHaveLength(1);
    expect(full.turnModels).toEqual({
      'run-1': { model: 'gemini-2.5-pro', source: 'history' },
      'run-2': { model: 'gemini-2.5-flash', source: 'history' },
    });
    const ans2Id = full.events.find(e => e.nativeTurnId === 'run-2' && e.type === 'agent_message_chunk')!.nativeId;
    expect(full.modelInfo?.[ans2Id]).toEqual({ model: 'gemini-2.5-flash', source: 'history' });

    const selected = readAgyHistory(root, cid, 'session', { selection: { mode: 'selected', turnIds: ['run-2'] } });
    expect(selected.selectedTurnIds).toEqual(['run-2']);
    expect(selected.events.every(e => e.nativeTurnId === 'run-2')).toBe(true);
    expect(selected.subagents).toEqual([]);
    expect(selected.turnModels).toEqual({ 'run-2': { model: 'gemini-2.5-flash', source: 'history' } });

    const recent = readAgyHistory(root, cid, 'session', { selection: { mode: 'recent', count: 1 } });
    expect(recent.selectedTurnIds).toEqual(['run-2']);

    const catalog = readAgyHistory(root, cid, 'session', { catalogOnly: true });
    expect(catalog.events).toEqual([]);
    expect(catalog.turns?.map(t => t.id)).toEqual(['run-1', 'run-2']);

    expect(() => readAgyHistory(root, cid, 'session', { selection: { mode: 'selected', turnIds: ['missing'] } })).toThrow();
    const aborted = new AbortController();
    aborted.abort(new Error('aborted'));
    expect(() => readAgyHistory(root, cid, 'session', { signal: aborted.signal })).toThrow('aborted');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
