import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PENDING_ROW_POS } from '@contracts';
import type {
  NativeActivity, NativeContext, NativeInteraction, NativeJob, NativeRunDetails, NativeStatus, RowEvent, Run, RunMetrics, Session,
  StepMetrics, SyncFrame, TimelineChanges, TimelinePage, TimelineRow, TurnOutlineV3,
} from '@contracts';

/**
 * Generates the sync contract fixtures: v3 `SyncFrame`, `TimelineRow`, `TimelinePage` and
 * `TimelineChanges` written as TS values bound to `packages/contracts`, in `max`, `min` and `future`
 * sets, so a renamed or newly required field fails `pnpm typecheck` here and the Kotlin decoder is
 * tested against what the types actually allow (`SyncContractFixtureTest`). The timeline itself is
 * folded on the server (docs/SYNC-V3.md); its rules are tested in `packages/timeline`.
 *
 * Emitted as a Kotlin source in `commonTest`, so every target reads it without file I/O. `--check`
 * regenerates in memory and fails when the committed file differs.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const syncOut = resolve(root, 'apps/mobile/contracts/src/commonTest/kotlin/riffet/contracts/SyncContractFixtures.kt');
const checkOnly = process.argv.includes('--check');

const at = (second: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();
const ms = (second: number) => Date.parse(at(second));

const text = (value: string, extra: Record<string, unknown> = {}) => ({ content: { type: 'text', text: value }, ...extra });

function appRun(id: string, state: Run['state'], prompt: string, second = 0): Run {
  return { id, sessionId: 'session-1', commandId: `cmd-${id}`, prompt, state, createdAt: at(second), updatedAt: at(second) };
}

function nativeRun(id: string, state: Run['state'], prompt: string, second: number, native: Partial<NativeRunDetails>): Run {
  return {
    ...appRun(id, state, prompt, second),
    native: {
      input: { text: prompt, attachmentIds: [], context: [] }, config: { mode: 'default' },
      fingerprint: `fp-${id}`, delivery: 'observed', attempt: 1, configRevision: 1, ...native,
    },
  };
}

const fixtureRuns: Run[] = [
  nativeRun('run-a', 'running', '重构解析器', 1, {
    nativeMessageId: 'chat-1:t1:user', nativeSessionId: 'chat-1', nativeTurnId: 't1', backendId: 'codex', stage: 'executing',
    renderedText: '重构解析器', baselineSequence: 12, terminalId: 'term-1', terminalEpoch: 2, expectsTurnOutcome: true, slashCommand: false, checkpointAttempted: true,
    timings: { dispatchAt: ms(1), observedAt: ms(2) }, resolvedConfig: { model: 'gpt-5', mode: 'default', approval: 'on-request' },
    metrics: { outputTokens: 420, durationMs: 3100, tokens: 'provider', window: 'stream', steps: 2 },
  }),
  nativeRun('run-s', 'running', '顺便补测试', 3, { intent: 'steer', ownerRunId: 'run-a', sourceRunId: 'run-q', nativeTurnId: 't1', nativeSessionId: 'chat-1' }),
  { ...appRun('run-f', 'failed', 'old', 0), error: 'exit 1' },
];
const queuedRun = nativeRun('run-q', 'queued', '然后更新文档', 5, { delivery: 'queued' });
const fixtureInteraction: NativeInteraction = {
  id: 'ia-1', revision: 'r1', transport: 'protocol', requestId: 'req-1', kind: 'permission', title: '允许运行命令？', message: 'npm test',
  options: [{ id: 'allow', label: '允许', selected: false }], actions: [{ id: 'approve', label: '允许', tone: 'primary' }], questionIndex: 1, questionCount: 2,
};
const fixtureStatus: NativeStatus = {
  phase: 'busy', activeTurnId: 'run-a', activeTurn: { nativeSessionId: 'chat-1', turnId: 't1', ownerRunId: 'run-a' },
  activity: { compacting: true, background: 2 }, connection: { state: 'reconnecting', message: 'retrying' },
  history: { state: 'ready' }, model: 'gpt-5', approval: 'on-request', transcript: 'ok', notice: 'skipped',
  outputRate: { state: 'live', windowSeconds: 30, outputTokens: 900, tokensPerSecond: 41.5, durationMs: 21000, window: 'stream', tokens: 'provider' },
  interaction: fixtureInteraction,
};
const stepMetrics: StepMetrics = { stepId: 'step-1', outputTokens: 12, tokens: 'estimated', durationMs: 340, window: 'transcript', live: true, startedAt: ms(1), endedAt: ms(2), reasoningTokens: 4 };
const runMetrics: RunMetrics = { outputTokens: 120, durationMs: 3400, tokens: 'mixed', window: 'observed', steps: 3 };
const fixtureContext: NativeContext = { used: 1000, size: 200000, breakdown: [{ id: 'system', label: 'System', tokens: 300 }], limitKind: 'compaction', breakdownEstimated: true };
const fixtureJob: NativeJob = { toolCallId: 'bash-1', id: 'shell-3', title: 'npm test', command: 'npm test', status: 'failed', startedAt: at(1), runningMs: 4200, exitCode: 1, matched: 'FAIL', output: 'FAIL src/a.test.ts', truncated: true, outputPath: '/tmp/out' };

/**
 * Frames whose every field is one the types allow, picked for the fields the phone acts on.
 * Optional fields are filled in where the Kotlin model must read them; an optional field the phone
 * ignores is still listed when leaving it out could hide a rename.
 */
type Max<T> = T extends unknown ? Required<T> : never;
type HelloFrame = Extract<SyncFrame, { type: 'hello' }>;
/** Hello's `control` snapshot joins this max fixture when clients consume it (M4). */
type SyncFrameMax = Exclude<Max<SyncFrame>, { type: 'hello' }> | (Required<Omit<HelloFrame, 'control'>> & { control?: HelloFrame['control'] });
/** Required fields only. */
type Min<T> = T extends unknown ? { [K in keyof T as {} extends Pick<T, K> ? never : K]: T[K] } : never;

/*
 * Sync v3 contract (`packages/contracts/src/sync.ts`). `max` carries every optional field of the v3
 * types (the shared types reuse the stream values above, plus a complete `Session` and activity),
 * `min` only the required ones, and `future` is what a newer server may send: an unknown field in
 * every object, an unknown row kind and frame type, and enum values this build does not know.
 */
const sessionMax = {
  id: 'session-1', projectId: 'project-1', kind: 'native', title: '重构解析器', displayTitle: '2026-01-01 重构解析器', tags: ['parser'], state: 'running', titleSource: 'generated',
  backendId: 'codex', backendProfileId: 'codex-default', nativeSessionId: 'chat-1', previousNativeSessionIds: ['chat-0'], quickExitCount: 1,
  nativeRuntime: { address: '127.0.0.1:4500', fingerprint: 'fp-runtime', attachment: { hook: 'acme.route', id: 'route-1' } }, cursorSessionId: 'chat-1', terminalId: 'term-1',
  resumePicker: false, model: 'gpt-5', mode: 'default', approval: 'on-request', archivedAt: at(9), error: 'exit 1', configRevision: 3, configPending: true,
  creationFingerprint: 'fp-create', lastActivityAt: at(8), seenActivityAt: at(7), activeSince: at(7), pinnedAt: at(6), pinRank: 1,
  origin: { kind: 'fork', sessionId: 'session-0', runId: 'run-0', groupId: 'group-1', templateId: 'template-1', scheduleId: 'schedule-1' },
  handedOffTo: 'session-2', toolGroups: ['riffet.core', 'device:phone-1'], extensionsOff: ['mcp:docs', 'skill:review'], terminalHold: { since: at(8), pid: 4242 },
  goal: { objective: '让解析器测试全部通过', status: 'budget_limited', reason: '还有两个用例失败', tokensUsed: 120000, tokenBudget: 100000, seconds: 900, updatedAt: at(8) }, workItemId: 'work-item-1', agentMemberId: 'default', createdAt: at(0), updatedAt: at(9),
  terminalAppearance: { foreground: '#202020', background: '#fafafa' },
} satisfies Required<Session>;
const sessionMin = { id: 'session-1', projectId: 'project-1', kind: 'native', title: '', tags: [], state: 'idle', mode: 'default', createdAt: at(0), updatedAt: at(0) } satisfies Min<Session>;
const activityMax = {
  id: 'claude:bg-1', kind: 'background_task', status: 'completed', title: 'npm test', detail: 'ok', blobRef: 'blob-activity', toolCallId: 'bash-1',
  startedAt: at(1), endedAt: at(5), durationMs: 4000, stop: { via: 'session' }, compaction: { trigger: 'auto', preTokens: 150000, postTokens: 30000 },
  task: { kind: 'shell', command: 'npm test', exitCode: 0 }, command: { name: 'compact' },
} satisfies Required<NativeActivity>;
const activityMin = { id: 'claude:c1', kind: 'compaction', status: 'running', title: '上下文压缩' } satisfies Min<NativeActivity>;

const rowEvent = (type: string, data: Record<string, unknown>): Required<RowEvent> => ({
  type, data, createdAt: at(2), lastAt: at(3), runId: 'run-a', nativeId: `chat-1:t1:${type}`, nativeTurnId: 't1', sourceIds: [`chat-1:t1:${type}`, `chat-1:t1:${type}:1`],
});
const maxHead = (key: string, pos: number, seq: number, event: RowEvent) => ({ key, pos, turn: 'turn:t1', seq, rev: 2, runId: 'run-a', event, truncated: { blobRef: `blob-${seq}`, bytes: 70_000 } });
const minHead = (key: string, seq: number) => ({ key, pos: seq, turn: 'turn:t1', seq, rev: 0, event: { type: 'session/update', data: {}, createdAt: at(1), lastAt: at(1), sourceIds: [] } });

const rowsMax: Array<Max<TimelineRow>> = [
  {
    ...maxHead('user:cmd-run-q', PENDING_ROW_POS, 1, rowEvent('user_message_chunk', text('然后更新文档'))), kind: 'user', text: '然后更新文档', references: [{ sessionId: 'reference-source', title: 'Earlier discussion', backendId: 'codex', projectName: 'Example', capturedAt: '2026-11-06T00:00:00.000Z', snapshotRef: 'a'.repeat(64), excerpt: 'Earlier context', coverage: { source: 'journal', completeness: 'partial', messages: 2, bytes: 100 } }],
    agents: [{ backendId: 'codex', backendProfileId: 'work', model: 'gpt-5.5[effort=high]' }],
    attachments: [{ name: 'shot.png', id: 'att-1', path: '/tmp/shot.png', type: 'image', mimeType: 'image/png', size: 2048, width: 640, height: 480 }], pending: 'unconfirmed',
  },
  { ...maxHead('assistant:1', 2, 2, rowEvent('agent_message_chunk', text('锁文件过期了。'))), kind: 'assistant', text: '锁文件过期了。', phase: 'final_answer' },
  { ...maxHead('thought:1', 3, 3, rowEvent('agent_thought_chunk', text('可能过期了'))), kind: 'thought', text: '可能过期了', channel: 'thinking' },
  {
    ...maxHead('tool:bash-1', 4, 4, rowEvent('tool_call', { toolCallId: 'bash-1', title: 'npm test', status: 'in_progress' })), kind: 'tool', job: fixtureJob, activity: activityMax,
    subagent: { lane: 'sub:bash-1', agentId: 'agent-7', running: false, title: 'review', subagentType: 'reviewer', model: 'sonnet', rows: 12, turnId: 'c1', status: 'completed', startedAt: at(1), endedAt: at(5) },
  },
  { ...maxHead('plan:1', 5, 5, rowEvent('plan', {})), kind: 'plan', entries: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }] },
  { ...maxHead('image:1', 6, 6, rowEvent('agent_message_chunk', {})), kind: 'image', src: '/api/sessions/session-1/blobs/sha-image' },
  { ...maxHead('status:1', 7, 7, rowEvent('run_failed', { error: 'exit 1' })), kind: 'status', tone: 'danger', text: '运行失败：exit 1', detail: 'exit 1' },
  {
    ...maxHead('task:bg-1', 8, 8, rowEvent('task_notification', {})), kind: 'task_notification', taskId: 'bg-1', taskKind: 'shell', status: 'completed',
    sourceStatus: 'completed', title: 'npm test', command: 'npm test', detail: 'ok', jobResult: { id: 'bg-1', status: 'succeeded', exitCode: 0, runningMs: 4200 },
    subagentToolCallId: 'task-1', tokens: 1200, durationMs: 5000,
  },
  { ...maxHead('activity:claude:bg-1', 9, 9, rowEvent('session/update', {})), kind: 'activity', activity: activityMax },
];
const rowsMin: Array<Min<TimelineRow>> = [
  { ...minHead('user:1', 1), kind: 'user', text: '', attachments: [] },
  { ...minHead('assistant:1', 2), kind: 'assistant', text: '' },
  { ...minHead('thought:1', 3), kind: 'thought', text: '', channel: 'narration' },
  { ...minHead('tool:1', 4), kind: 'tool' },
  { ...minHead('plan:1', 5), kind: 'plan', entries: [] },
  { ...minHead('image:1', 6), kind: 'image', src: '' },
  { ...minHead('status:1', 7), kind: 'status', tone: 'muted', text: '' },
  { ...minHead('task:1', 8), kind: 'task_notification', taskKind: 'shell', status: 'unknown', title: '' },
  { ...minHead('activity:1', 9), kind: 'activity', activity: activityMin },
];
const turnMax = { turn: 'turn:t1', turnId: 't1', startPos: 1, endPos: 9, status: 'completed', at: at(1), endedAt: at(9), preview: '重构解析器', hasUserMessage: true, hasAttachments: true, rows: 9, runId: 'run-a' } satisfies Required<TurnOutlineV3>;
const turnMin = { turn: 'turn:t2', turnId: 't2', startPos: 10, status: 'running', at: at(10), rows: 1 } satisfies Min<TurnOutlineV3>;

const framesMax: Array<SyncFrameMax> = [
  {
    type: 'hello', protocol: 3, lane: 'main', generation: 'gen-1', headSeq: 42, mode: 'delta', session: sessionMax, status: fixtureStatus, interaction: fixtureInteraction,
    runs: [...fixtureRuns, queuedRun], activities: [activityMax], context: fixtureContext, outline: { turnCount: 120, turns: [turnMax] }, catchingUp: true,
  },
  { type: 'snapshot', generation: 'gen-1', asOfSeq: 42, part: 2, final: true, rows: rowsMax, hasBefore: true },
  { type: 'rows', generation: 'gen-1', from: 43, to: 44, upserts: rowsMax.slice(1, 3), deletes: ['tool:bash-0'] },
  { type: 'reset', generation: 'gen-2', reason: 'promoted' },
  { type: 'status', status: fixtureStatus },
  { type: 'interaction', interaction: fixtureInteraction },
  { type: 'runs', runs: fixtureRuns },
  { type: 'run', run: queuedRun },
  { type: 'activities', live: [activityMax] },
  { type: 'outline', turnCount: 121, turns: [turnMax] },
  { type: 'context', context: fixtureContext },
  { type: 'metrics', metrics: stepMetrics, run: runMetrics, runId: 'run-a', nativeMessageId: 'chat-1:t1:user' },
  { type: 'session', session: sessionMax },
  { type: 'error', code: 'GENERATION_GONE', message: '会话已重建', retryable: true },
  { type: 'caughtUp', generation: 'gen-1', headSeq: 44 },
];
const framesMin: Array<Min<SyncFrame>> = [
  {
    type: 'hello', protocol: 3, lane: 'sub:task-1', generation: 'gen-1', headSeq: 0, mode: 'snapshot', session: sessionMin, status: { phase: 'idle' }, interaction: null,
    runs: [], activities: [], outline: { turnCount: 0, turns: [] },
  },
  { type: 'snapshot', generation: 'gen-1', asOfSeq: 0, part: 0, final: true, rows: rowsMin, hasBefore: false },
  { type: 'rows', generation: 'gen-1', from: 1, to: 1, upserts: [] },
  { type: 'reset', generation: 'gen-2', reason: 'rebuilt' },
  { type: 'status', status: { phase: 'offline' } },
  { type: 'interaction', interaction: null },
  { type: 'runs', runs: [] },
  { type: 'run', run: appRun('run-1', 'queued', '') },
  { type: 'activities', live: [] },
  { type: 'outline', turnCount: 1, turns: [turnMin] },
  { type: 'context' },
  { type: 'metrics', metrics: { stepId: 'step-1', outputTokens: 0, tokens: 'provider', durationMs: 0, window: 'stream', live: false } },
  { type: 'session', session: sessionMin },
  { type: 'error', code: 'INTERNAL', message: '', retryable: false },
  { type: 'caughtUp', generation: 'gen-1', headSeq: 0 },
];
const pageMax: Required<TimelinePage> = { generation: 'gen-1', rows: rowsMax, hasBefore: true, hasAfter: true };
const pageMin = { generation: 'gen-1', rows: [], hasBefore: false, hasAfter: false } satisfies Min<TimelinePage>;
const changesMax: Required<TimelineChanges> = { generation: 'gen-1', headSeq: 44, mode: 'delta', from: 43, to: 44, rows: rowsMax.slice(0, 2), deletes: ['tool:bash-0'], hasBefore: true };
const changesMin = { generation: 'gen-1', headSeq: 0, mode: 'snapshot', rows: [] } satisfies Min<TimelineChanges>;

type SyncFixture = [name: string, payload: unknown];
const syncFixtures = (frames: Array<{ type: string }>, rows: Array<{ kind: string }>, page: TimelinePage, changes: TimelineChanges): SyncFixture[] => [
  ...frames.map((frame): SyncFixture => [`frame:${frame.type}`, frame]),
  ...rows.map((row): SyncFixture => [`row:${row.kind}`, row]),
  ['page', page], ['changes', changes],
];
const syncMax = syncFixtures(framesMax, rowsMax, pageMax, changesMax);
const syncMin = syncFixtures(framesMin, rowsMin, pageMin, changesMin);

/** A number, so it also fits the `Record<string, number>` maps (`timings`). */
function withFutureField(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withFutureField);
  if (!value || typeof value !== 'object') return value;
  return { ...Object.fromEntries(Object.entries(value).map(([key, field]) => [key, withFutureField(field)])), futureField: 4 };
}
const maxRow = (kind: TimelineRow['kind']) => rowsMax.find((row) => row.kind === kind)!;
const unknownKindRow = { ...maxHead('canvas:1', 20, 20, rowEvent('canvas', {})), kind: 'canvas', shapes: [{ type: 'rect', at: [0, 0] }] };
const syncFuture: SyncFixture[] = [
  ...syncMax.map(([name, payload]): SyncFixture => [name, withFutureField(payload)]),
  ['row:unknown-kind', unknownKindRow],
  ['frame:unknown-type', { type: 'presence', viewers: [{ id: 'mac', since: at(1) }] }],
  // In this order: one per lenient enum, a known kind that cannot be read (a job status this build lacks), an unknown kind.
  ['frame:unknown-values', {
    type: 'rows', generation: 'gen-1', from: 45, to: 51, upserts: [
      { ...maxRow('user'), pending: 'scheduled' },
      { ...maxRow('assistant'), phase: 'aside' },
      { ...maxRow('thought'), channel: 'summary' },
      { ...maxRow('status'), tone: 'warning' },
      { ...maxRow('task_notification'), status: 'paused', jobResult: { id: 'bg-1', status: 'paused' } },
      { ...maxRow('tool'), job: { ...fixtureJob, status: 'paused' } },
      unknownKindRow,
    ],
  }],
  ['frame:outline-unknown-status', { type: 'outline', turnCount: 121, turns: [{ ...turnMax, status: 'paused' }] }],
  ['frame:reset-unknown-reason', { type: 'reset', generation: 'gen-3', reason: 'migrated' }],
  ['changes:unknown-mode', { ...changesMin, mode: 'patch' }],
];

/** A Kotlin raw string cannot escape anything, so `$` becomes a template and `"""` cannot occur. */
function rawString(json: string): string {
  if (json.includes('"""')) throw new Error('fixture JSON contains """, which a Kotlin raw string cannot hold');
  return `"""${json.replace(/\$/g, '${"$"}')}"""`;
}

function kotlinFile(pkg: string, about: string[], ...lists: Array<[declaration: string, entries: string[]]>): string {
  return [
    `// Generated by scripts/gen-timeline-fixtures.ts — do not edit by hand. Run \`pnpm gen:timeline-fixtures\`.`,
    ...about.map((line) => `// ${line}`),
    `package ${pkg}`,
    ...lists.flatMap(([declaration, entries]) => ['', `${declaration} = listOf(`, ...entries.map((entry) => `    ${entry},`), ')']),
    '',
  ].join('\n');
}

const syncEntries = (fixtures: SyncFixture[]) => fixtures.map(([name, payload]) => `"${name}" to ${rawString(JSON.stringify(payload))}`);
const syncSource = kotlinFile('riffet.contracts', [
  '`max` and `min` are TS values bound to packages/contracts/src/sync.ts; `future` is what a newer',
  'server may send. The name prefix picks the type: frame, row, page or changes. See SyncContractFixtureTest.',
], ['internal val SYNC_MAX_FIXTURES: List<Pair<String, String>>', syncEntries(syncMax)],
['internal val SYNC_MIN_FIXTURES: List<Pair<String, String>>', syncEntries(syncMin)],
['internal val SYNC_FUTURE_FIXTURES: List<Pair<String, String>>', syncEntries(syncFuture)]);

let stale = false;
for (const [path, generated] of [[syncOut, syncSource]] as const) {
  const name = relative(root, path);
  if (checkOnly) {
    let current = '';
    try { current = readFileSync(path, 'utf8'); } catch { /* reported as stale below */ }
    if (current !== generated) {
      console.error(`gen:timeline-fixtures: ${name} is stale. Run \`pnpm gen:timeline-fixtures\` and commit the result.`);
      stale = true;
    }
  } else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, generated);
    console.log(`gen:timeline-fixtures: wrote ${name}`);
  }
}
if (stale) process.exit(1);
if (checkOnly) console.log('gen:timeline-fixtures: fixtures are up to date.');
