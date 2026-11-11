/*
 * Run wire contract as a zod v4 schema.
 *
 * This mirrors `Run` and `NativeRunDetails` in `packages/contracts/src/index.ts`; that interface
 * stays the source callers use. `RunState` and `NativeDeliveryState` are closed because the Kotlin
 * client switches over them exhaustively; the metrics enums decode unknown spellings to `UNKNOWN`
 * and are marked open.
 */
import { z } from 'zod/v4';
import { NativeBackendIdSchema } from './native.js';

export const TextRefSchema = z.object({
  code: z.string(),
  params: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
});

export const MetricsTokenSourceSchema = z.enum(['provider', 'estimated']).meta({ open: true });
export const MetricsWindowSchema = z.enum(['stream', 'transcript', 'observed']).meta({ open: true });
export const RunMetricsTokenSourceSchema = z.enum(['provider', 'estimated', 'mixed']).meta({ open: true });

export const RunStateSchema = z.enum(['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted']);
export const NativeDeliveryStateSchema = z.enum([
  'queued', 'preparing', 'dispatching', 'input_sent', 'observed', 'uncertain', 'failed', 'cancelled',
]);

/** Token accounting for one assistant response step. */
export const StepMetricsSchema = z.object({
  stepId: z.string(),
  outputTokens: z.number(),
  tokens: MetricsTokenSourceSchema,
  durationMs: z.number(),
  startedAt: z.number().optional(),
  endedAt: z.number().optional(),
  window: MetricsWindowSchema,
  live: z.boolean(),
  reasoningTokens: z.number().optional(),
});

/** Turn-to-date aggregate over the turn's assistant steps. */
export const RunMetricsSchema = z.object({
  outputTokens: z.number(),
  durationMs: z.number(),
  tokens: RunMetricsTokenSourceSchema,
  window: MetricsWindowSchema,
  steps: z.number(),
});

export const SessionReferenceInputSchema = z.object({
  kind: z.literal('session'),
  sessionId: z.string(),
  fromRunId: z.string().optional(),
});

export const CapturedSessionReferenceSchema = z.object({
  sessionId: z.string(),
  title: z.string(),
  backendId: NativeBackendIdSchema,
  projectName: z.string(),
  capturedAt: z.string(),
  snapshotRef: z.string(),
  excerpt: z.string(),
  coverage: z.object({
    source: z.enum(['native', 'journal']).meta({ open: true }),
    completeness: z.enum(['complete', 'partial']).meta({ open: true }),
    messages: z.number(),
    bytes: z.number(),
    from: z.string().optional(),
    through: z.string().optional(),
    activeTurnIncomplete: z.boolean().optional(),
    reason: z.string().optional(),
  }),
});

export const NativeRunInputSchema = z.object({
  text: z.string(),
  attachmentIds: z.array(z.string()),
  context: z.array(z.object({ path: z.string(), line: z.number().optional() })),
  references: z.array(SessionReferenceInputSchema).optional(),
});

export const NativeRunConfigSchema = z.object({
  model: z.string().optional(),
  mode: z.string(),
  approval: z.string().optional(),
});

export const NativeRunDetailsSchema = z.object({
  checkpointAttempted: z.boolean().optional(),
  input: NativeRunInputSchema,
  contextSnapshots: z.array(CapturedSessionReferenceSchema).optional(),
  config: NativeRunConfigSchema,
  intent: z.literal('steer').optional(),
  nativeTurnId: z.string().optional(),
  ownerRunId: z.string().optional(),
  sourceRunId: z.string().optional(),
  expectsTurnOutcome: z.boolean().optional(),
  resolvedConfig: NativeRunConfigSchema.optional(),
  fingerprint: z.string(),
  delivery: NativeDeliveryStateSchema,
  attempt: z.number(),
  terminalId: z.string().optional(),
  terminalEpoch: z.number().optional(),
  nativeSessionId: z.string().optional(),
  backendId: NativeBackendIdSchema.optional(),
  cursorSessionId: z.string().optional(),
  nativeMessageId: z.string().optional(),
  stage: z.string().optional(),
  timings: z.record(z.string(), z.number()).optional(),
  baselineSequence: z.number().optional(),
  renderedText: z.string().optional(),
  nativeInputBoundary: z.string().optional(),
  queueReleasedAt: z.string().optional(),
  diagnostic: z.object({ code: z.string().optional(), message: z.string(), stage: z.string().optional(), at: z.string() }).optional(),
  slashCommand: z.boolean().optional(),
  configRevision: z.number(),
  metrics: RunMetricsSchema.optional(),
});

export const RunSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  commandId: z.string(),
  prompt: z.string(),
  state: RunStateSchema,
  native: NativeRunDetailsSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  error: z.string().optional(),
  errorRef: TextRefSchema.optional(),
});

export const NativeRunRecoverySchema = z.object({ run: RunSchema, canContinue: z.boolean(), queuedRunIds: z.array(z.string()) });
export const NativeStopRequestSchema = z.object({
  requestId: z.string().min(1).max(200), nativeSessionId: z.string().max(500),
  turnId: z.string().min(1).max(500).optional(), terminalId: z.string().min(1).max(200).optional(),
  terminalEpoch: z.number().int().nonnegative().optional(),
});
