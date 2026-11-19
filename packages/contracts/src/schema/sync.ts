/*
 * Sync protocol v3 wire contracts as zod v4 schemas (docs/SYNC-V3.md).
 *
 * This mirrors `SyncFrame`, `TimelineRow`, `TimelinePage`, `TimelineChanges` and `LaneFind` in
 * `packages/contracts/src/sync.ts`; that file stays the source callers use. The Kotlin client
 * decodes an unknown frame type or row kind as `Unknown` and every enum it can reach through a
 * frame as `UNKNOWN`, so those enums are marked open. `Session`, `Run` and their strict enums stay
 * closed: the frames carry them, and a new strict value would fail decoding.
 */
import { z } from 'zod/v4';
import { CapturedSessionReferenceSchema, NativeRunInputSchema, RunMetricsSchema, RunSchema, RunMetricsTokenSourceSchema, StepMetricsSchema, MetricsWindowSchema, TextRefSchema } from './run.js';
import { SessionSchema } from './session.js';

/** `main`, or a subagent's lane keyed by the tool call that started it. */
export const SyncLaneSchema = z.union([z.literal('main'), z.string().regex(/^sub:/)]);
export const SyncModeSchema = z.enum(['delta', 'snapshot']).meta({ open: true });

/**
 * `id` is present for attachments uploaded through Riffet (`/api/attachments/:id`). `path` is the
 * native file a CLI recorded (for example a Cursor image), and `type` says what that file is.
 */
export const UserAttachmentSchema = z.object({
  name: z.string(),
  id: z.string().optional(),
  path: z.string().optional(),
  type: z.enum(['image', 'file']).meta({ open: true }).optional(),
  mimeType: z.string().optional(),
  size: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
});

export const ReasoningChannelSchema = z.enum(['thinking', 'narration']).meta({ open: true });
export const TaskNotificationStatusSchema = z.enum(['running', 'completed', 'failed', 'cancelled', 'unknown']).meta({ open: true });

export const TaskNotificationResultSchema = z.object({
  id: z.string(),
  status: z.enum(['running', 'succeeded', 'failed']).meta({ open: true }),
  exitCode: z.number().optional(),
  runningMs: z.number().optional(),
});

/** The event a row was folded from. */
export const RowEventSchema = z.object({
  type: z.string(),
  data: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
  lastAt: z.string(),
  runId: z.string().optional(),
  nativeId: z.string().optional(),
  nativeTurnId: z.string().optional(),
  sourceIds: z.array(z.string()),
});

export const NativeJobStatusSchema = z.enum(['running', 'succeeded', 'failed', 'unknown']).meta({ open: true });
export const NativeJobSchema = z.object({
  toolCallId: z.string(),
  id: z.string().optional(),
  title: z.string(),
  command: z.string(),
  status: NativeJobStatusSchema,
  startedAt: z.string().optional(),
  runningMs: z.number().optional(),
  exitCode: z.number().optional(),
  matched: z.string().optional(),
  output: z.string().optional(),
  truncated: z.boolean().optional(),
  outputPath: z.string().optional(),
});

export const NativeActivityKindSchema = z.enum(['compaction', 'background_task', 'local_command']).meta({ open: true });
export const NativeActivityStatusSchema = z.enum(['running', 'stopping', 'completed', 'failed', 'stopped', 'unknown']).meta({ open: true });
export const NativeActivityStopSchema = z.object({ via: z.enum(['protocol', 'session']).meta({ open: true }) });
export const NativeActivityCompactionSchema = z.object({
  trigger: z.enum(['manual', 'auto']).meta({ open: true }),
  preTokens: z.number().optional(),
  postTokens: z.number().optional(),
});
export const NativeActivityTaskSchema = z.object({
  kind: z.enum(['shell', 'monitor', 'agent', 'workflow', 'terminal']).meta({ open: true }),
  command: z.string().optional(),
  exitCode: z.number().optional(),
});
export const NativeActivitySchema = z.object({
  id: z.string(),
  kind: NativeActivityKindSchema,
  status: NativeActivityStatusSchema,
  title: z.string(),
  detail: z.string().optional(),
  blobRef: z.string().optional(),
  toolCallId: z.string().optional(),
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
  durationMs: z.number().optional(),
  stop: NativeActivityStopSchema.optional(),
  compaction: NativeActivityCompactionSchema.optional(),
  task: NativeActivityTaskSchema.optional(),
  command: z.object({ name: z.string() }).optional(),
});

export const NativeContextSchema = z.object({
  used: z.number(),
  size: z.number(),
  breakdown: z.array(z.object({ id: z.string(), label: z.string(), tokens: z.number() })),
  limitKind: z.enum(['compaction']).meta({ open: true }).optional(),
  breakdownEstimated: z.boolean().optional(),
});

export const OutputRateSchema = z.object({
  state: z.enum(['no_data', 'live', 'zero', 'stale']).meta({ open: true }),
  windowSeconds: z.number(),
  outputTokens: z.number(),
  tokensPerSecond: z.number(),
  durationMs: z.number().optional(),
  window: MetricsWindowSchema.optional(),
  tokens: RunMetricsTokenSourceSchema.optional(),
});

const LocalizedTextSchema = z.record(z.string(), z.string());
export const NativeRuntimeActionSchema = z.object({
  id: z.string(),
  label: LocalizedTextSchema,
  hint: LocalizedTextSchema.optional(),
  disabled: z.boolean().optional(),
});
export const NativeRuntimeActionRequestSchema = z.object({ action: z.string().min(1).max(200), revision: z.string().max(200) });
export const NativeRuntimeControlSchema = z.object({
  owner: z.string(),
  revision: z.string(),
  notice: z.object({
    tone: z.enum(['neutral', 'progress', 'danger']).meta({ open: true }),
    label: LocalizedTextSchema.optional(),
    detail: z.string().optional(),
    action: NativeRuntimeActionSchema.optional(),
  }).optional(),
  actions: z.array(NativeRuntimeActionSchema).optional(),
});

export const NativeTurnTargetSchema = z.object({ nativeSessionId: z.string(), turnId: z.string() });
export const NativeActiveTurnSchema = NativeTurnTargetSchema.extend({ ownerRunId: z.string().optional() });

export const NativeInteractionSchema = z.object({
  id: z.string(),
  revision: z.string(),
  transport: z.enum(['terminal', 'protocol']).meta({ open: true }).optional(),
  terminalId: z.string().optional(),
  epoch: z.number().optional(),
  requestId: z.string().optional(),
  request: z.record(z.string(), z.unknown()).optional(),
  kind: z.enum(['question', 'permission', 'plan', 'confirmation', 'choice']).meta({ open: true }),
  title: z.string(),
  message: z.string().optional(),
  options: z.array(z.object({ id: z.string(), label: z.string(), selected: z.boolean() })),
  multiple: z.boolean().optional(),
  allowOther: z.boolean().optional(),
  otherValue: z.string().optional(),
  otherSelected: z.boolean().optional(),
  questionIndex: z.number().optional(),
  questionCount: z.number().optional(),
  actions: z.array(z.object({
    id: z.string(), label: z.string(), tone: z.enum(['primary', 'danger']).meta({ open: true }).optional(),
    shortLabel: z.string().optional(), detail: z.string().optional(),
  })),
  expiresAt: z.string().optional(),
  extendableUntil: z.string().optional(),
});

export const NativeQueueSchema = z.object({
  next: z.string().optional(),
  held: z.object({
    reason: z.enum(['turn_running', 'attention', 'stopping', 'sending', 'steering', 'unconfirmed', 'workspace', 'recovering', 'retrying']).meta({ open: true }),
    runId: z.string().optional(),
  }).optional(),
});

export const NativeStatusSchema = z.object({
  profilePending: z.boolean().optional(),
  runtimeControl: NativeRuntimeControlSchema.optional(),
  activity: z.object({ compacting: z.boolean(), background: z.number() }).optional(),
  phase: z.enum(['offline', 'starting', 'busy', 'idle', 'attention']).meta({ open: true }),
  activeTurnId: z.string().optional(),
  activeTurn: NativeActiveTurnSchema.optional(),
  outputRate: OutputRateSchema.optional(),
  connection: z.object({ state: z.enum(['connected', 'disconnected', 'reconnecting', 'conflict', 'failed']).meta({ open: true }), message: z.string().optional(), messageRef: TextRefSchema.optional() }).optional(),
  history: z.object({ state: z.enum(['loading', 'ready', 'error']).meta({ open: true }), message: z.string().optional(), messageRef: TextRefSchema.optional() }).optional(),
  model: z.string().optional(),
  permission: z.string().optional(),
  approval: z.string().optional(),
  transcript: z.enum(['ok', 'unavailable', 'unparsed']).meta({ open: true }).optional(),
  notice: z.string().optional(),
  noticeLevel: z.enum(['info', 'warning', 'error']).meta({ open: true }).optional(),
  interaction: NativeInteractionSchema.optional(),
  queue: NativeQueueSchema.optional(),
});

export const FileChangeSchema = z.object({ path: z.string(), added: z.number(), removed: z.number(), created: z.boolean() });
export const TurnOutlineStatusSchema = z.enum(['running', 'completed', 'failed', 'cancelled', 'interrupted', 'outcome_unknown']).meta({ open: true });

const RowBaseSchema = z.object({
  key: z.string(),
  pos: z.number(),
  turn: z.string(),
  seq: z.number(),
  rev: z.number(),
  runId: z.string().optional(),
  event: RowEventSchema,
  truncated: z.object({ blobRef: z.string(), bytes: z.number() }).optional(),
});

export const TimelineRowSchema = z.discriminatedUnion('kind', [
  RowBaseSchema.extend({
    kind: z.literal('user'),
    text: z.string(),
    attachments: z.array(UserAttachmentSchema),
    references: z.array(CapturedSessionReferenceSchema).optional(),
    pending: z.enum(['queued', 'preparing', 'unconfirmed', 'failed']).meta({ open: true }).optional(),
  }),
  RowBaseSchema.extend({
    kind: z.literal('assistant'),
    text: z.string(),
    phase: z.enum(['commentary', 'final_answer']).meta({ open: true }).optional(),
  }),
  RowBaseSchema.extend({ kind: z.literal('thought'), text: z.string(), channel: ReasoningChannelSchema }),
  RowBaseSchema.extend({
    kind: z.literal('tool'),
    job: NativeJobSchema.optional(),
    activity: NativeActivitySchema.optional(),
    subagent: z.object({
      lane: SyncLaneSchema,
      agentId: z.string(),
      running: z.boolean(),
      title: z.string().optional(),
      subagentType: z.string().optional(),
      model: z.string().optional(),
      rows: z.number(),
      turnId: z.string().optional(),
      status: TurnOutlineStatusSchema.optional(),
      startedAt: z.string().optional(),
      endedAt: z.string().optional(),
      changes: z.array(FileChangeSchema).optional(),
    }).optional(),
  }),
  RowBaseSchema.extend({ kind: z.literal('plan'), entries: z.array(z.record(z.string(), z.unknown())) }),
  RowBaseSchema.extend({ kind: z.literal('image'), src: z.string() }),
  RowBaseSchema.extend({ kind: z.literal('status'), tone: z.enum(['danger', 'muted']).meta({ open: true }), text: z.string(), detail: z.string().optional() }),
  RowBaseSchema.extend({
    kind: z.literal('task_notification'),
    taskId: z.string().optional(),
    taskKind: z.string(),
    status: TaskNotificationStatusSchema,
    sourceStatus: z.string().optional(),
    title: z.string(),
    command: z.string().optional(),
    detail: z.string().optional(),
    jobResult: TaskNotificationResultSchema.optional(),
    subagentToolCallId: z.string().optional(),
    tokens: z.number().optional(),
    durationMs: z.number().optional(),
  }),
  RowBaseSchema.extend({ kind: z.literal('activity'), activity: NativeActivitySchema }),
]);

export const TurnOutlineV3Schema = z.object({
  turn: z.string(),
  turnId: z.string(),
  startPos: z.number(),
  endPos: z.number().optional(),
  status: TurnOutlineStatusSchema,
  at: z.string(),
  endedAt: z.string().optional(),
  preview: z.string().optional(),
  hasUserMessage: z.boolean().optional(),
  hasAttachments: z.boolean().optional(),
  rows: z.number(),
  runId: z.string().optional(),
});

export const SyncOutlineSchema = z.object({ turnCount: z.number(), turns: z.array(TurnOutlineV3Schema) });

const InboxActionSchema = z.enum(['send_now', 'steer', 'edit', 'cancel', 'retry', 'check', 'continue', 'restore']).meta({ open: true });
const ControlRuntimeSchema = z.enum(['offline', 'starting', 'ready', 'conflict', 'failed']).meta({ open: true });
const ActiveTurnPhaseSchema = z.enum(['starting', 'running', 'stopping', 'attention']).meta({ open: true });
const InboxKindSchema = z.enum(['message', 'steer']).meta({ open: true });
const InboxPlacementSchema = z.enum(['sending', 'queued']).meta({ open: true });
const InboxStatusSchema = z.enum(['queued', 'preparing', 'sending', 'uncertain', 'failed']).meta({ open: true });
const NoticeLevelSchema = z.enum(['info', 'warning', 'error']).meta({ open: true });
const TranscriptStateSchema = z.enum(['ok', 'unavailable', 'unparsed']).meta({ open: true });
const StatusActivitySchema = z.object({ compacting: z.boolean(), background: z.number() });
const NativeConnectionSchema = z.object({
  state: z.enum(['connected', 'disconnected', 'reconnecting', 'conflict', 'failed']).meta({ open: true }),
  message: z.string().optional(),
  messageRef: TextRefSchema.optional(),
});
const NativeHistorySchema = z.object({
  state: z.enum(['loading', 'ready', 'error']).meta({ open: true }),
  message: z.string().optional(),
  messageRef: TextRefSchema.optional(),
});
const QueueHeldSchema = z.object({
  reason: z.enum(['turn_running', 'attention', 'stopping', 'sending', 'steering', 'unconfirmed', 'workspace', 'recovering', 'retrying']).meta({ open: true }),
  runId: z.string().optional(),
});

export const ActiveTurnStateSchema = z.object({
  turnId: z.string().optional(),
  ownerRunId: z.string().optional(),
  nativeSessionId: z.string().optional(),
  nativeTurnId: z.string().optional(),
  phase: ActiveTurnPhaseSchema,
  startedAt: z.string().optional(),
  canStop: z.boolean(),
  canSteer: z.boolean(),
});

export const InboxEntrySchema = z.object({
  id: z.string(),
  commandId: z.string(),
  kind: InboxKindSchema,
  placement: InboxPlacementSchema,
  status: InboxStatusSchema,
  prompt: NativeRunInputSchema,
  contextSnapshots: z.array(CapturedSessionReferenceSchema).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  error: z.string().optional(),
  diagnostic: z.object({
    code: z.string().optional(),
    message: z.string(),
    stage: z.string().optional(),
    at: z.string(),
  }).optional(),
  actions: z.array(InboxActionSchema),
});

export const SessionControlSnapshotSchema = z.object({
  revision: z.number(),
  runtime: ControlRuntimeSchema,
  activeTurn: ActiveTurnStateSchema.nullable(),
  inbox: z.array(InboxEntrySchema),
  held: QueueHeldSchema.optional(),
  capabilities: z.object({ canStop: z.boolean(), canSteer: z.boolean(), canSendNow: z.boolean() }),
  interaction: NativeInteractionSchema.nullable(),
  activity: StatusActivitySchema,
  outputRate: OutputRateSchema.optional(),
  connection: NativeConnectionSchema.optional(),
  history: NativeHistorySchema.optional(),
  runtimeControl: NativeRuntimeControlSchema.optional(),
  notice: z.string().optional(),
  noticeLevel: NoticeLevelSchema.optional(),
  model: z.string().optional(),
  permission: z.string().optional(),
  approval: z.string().optional(),
  profilePending: z.boolean().optional(),
  transcript: TranscriptStateSchema.optional(),
});

export const SyncFrameSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello'),
    protocol: z.literal(3),
    lane: SyncLaneSchema,
    generation: z.string(),
    headSeq: z.number(),
    mode: SyncModeSchema,
    session: SessionSchema,
    status: NativeStatusSchema,
    interaction: NativeInteractionSchema.nullable(),
    runs: z.array(RunSchema),
    activities: z.array(NativeActivitySchema),
    context: NativeContextSchema.optional(),
    outline: SyncOutlineSchema,
    catchingUp: z.boolean().optional(),
    control: SessionControlSnapshotSchema.optional(),
  }),
  z.object({ type: z.literal('caughtUp'), generation: z.string(), headSeq: z.number() }),
  z.object({
    type: z.literal('snapshot'),
    generation: z.string(),
    asOfSeq: z.number(),
    part: z.number(),
    final: z.boolean(),
    rows: z.array(TimelineRowSchema),
    hasBefore: z.boolean(),
  }),
  z.object({
    type: z.literal('rows'),
    generation: z.string(),
    from: z.number(),
    to: z.number(),
    upserts: z.array(TimelineRowSchema),
    deletes: z.array(z.string()).optional(),
  }),
  z.object({
    type: z.literal('reset'),
    generation: z.string(),
    reason: z.enum(['rebuilt', 'promoted', 'fold']).meta({ open: true }),
  }),
  z.object({ type: z.literal('status'), status: NativeStatusSchema }),
  z.object({ type: z.literal('interaction'), interaction: NativeInteractionSchema.nullable() }),
  z.object({ type: z.literal('runs'), runs: z.array(RunSchema) }),
  z.object({ type: z.literal('run'), run: RunSchema }),
  z.object({ type: z.literal('activities'), live: z.array(NativeActivitySchema) }),
  z.object({ type: z.literal('outline'), turnCount: z.number(), turns: z.array(TurnOutlineV3Schema) }),
  z.object({ type: z.literal('context'), context: NativeContextSchema.optional() }),
  z.object({
    type: z.literal('metrics'),
    metrics: StepMetricsSchema,
    run: RunMetricsSchema.optional(),
    runId: z.string().optional(),
    nativeMessageId: z.string().optional(),
  }),
  z.object({ type: z.literal('session'), session: SessionSchema }),
  z.object({ type: z.literal('control'), control: SessionControlSnapshotSchema }),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string(), retryable: z.boolean() }),
]);

export const TimelinePageSchema = z.object({
  generation: z.string(),
  rows: z.array(TimelineRowSchema),
  hasBefore: z.boolean(),
  hasAfter: z.boolean(),
});

export const TimelineChangesSchema = z.object({
  generation: z.string(),
  headSeq: z.number(),
  mode: SyncModeSchema,
  from: z.number().optional(),
  to: z.number().optional(),
  rows: z.array(TimelineRowSchema),
  deletes: z.array(z.string()).optional(),
  hasBefore: z.boolean().optional(),
});

export const LaneFindHitSchema = z.object({ key: z.string(), pos: z.number(), turn: z.string(), count: z.number() });

export const LaneFindSchema = z.object({
  generation: z.string(),
  headSeq: z.number(),
  total: z.number(),
  hits: z.array(LaneFindHitSchema),
  truncated: z.boolean().optional(),
});
