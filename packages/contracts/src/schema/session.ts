/*
 * Session wire contract as a zod v4 schema.
 *
 * This mirrors `Session` in `packages/contracts/src/index.ts`; that interface stays the source
 * callers use. Only enums the Kotlin client keeps as strings (`SessionTitleSource`,
 * `SessionOrigin.kind`) are marked open: `SessionState`, `SessionKind` and `NativeBackendId` are
 * strict there, so a new value would fail decoding and must be negotiated instead.
 */
import { z } from 'zod/v4';
import { NativeBackendIdSchema } from './native.js';

export const SessionKindSchema = z.enum(['native']);
export const SessionStateSchema = z.enum([
  'idle', 'starting', 'running', 'waiting', 'cancelling', 'interrupted', 'failed', 'archived',
]);
/** Kotlin keeps this as a string, so a newer server may add a stronger source. */
export const SessionTitleSourceSchema = z.enum(['prompt', 'provider', 'agent', 'generated', 'user']).meta({ open: true });

export const SessionOriginKindSchema = z.enum(['fork', 'handoff', 'attempt', 'automation', 'template', 'schedule', 'discussion', 'channel', 'assistant', 'council', 'call', 'link']).meta({ open: true });

export const SessionOriginSchema = z.object({
  kind: SessionOriginKindSchema,
  sessionId: z.string().optional(),
  runId: z.string().optional(),
  groupId: z.string().optional(),
  automationId: z.string().optional(),
  serverId: z.string().optional(),
  templateId: z.string().optional(),
  scheduleId: z.string().optional(),
  channel: z.object({ kind: z.string(), account: z.string(), chatId: z.string() }).optional(),
  job: z.enum(['supervise', 'consolidate', 'delegation']).meta({ open: true }).optional(),
  assistantRunId: z.string().optional(),
  discussion: z.object({
    anchor: z.object({
      messageId: z.string(), aliases: z.array(z.string()).optional(),
      runId: z.string().optional(), nativeTurnId: z.string().optional(),
      sequence: z.number().int().optional(), generation: z.string().optional(),
    }),
    quote: z.object({ exact: z.string(), prefix: z.string(), suffix: z.string(), start: z.number().int().optional(), end: z.number().int().optional() }),
    capturedAt: z.string(), contextRef: z.string(), requestFingerprint: z.string(),
  }).optional(),
});

/** Server-written binding to an integration's sidecar on the native process. */
export const SessionNativeRuntimeSchema = z.object({
  address: z.string(),
  fingerprint: z.string(),
  scopeFingerprint: z.string().optional(),
  profileId: z.string().optional(),
  attachment: z.object({ hook: z.string(), id: z.string() }).optional(),
});

/** Kotlin keeps this as a string, so a newer server may add a status. */
export const SessionGoalStatusSchema = z.enum(['active', 'paused', 'blocked', 'usage_limited', 'budget_limited', 'complete']).meta({ open: true });

export const SessionGoalSchema = z.object({
  objective: z.string(),
  status: SessionGoalStatusSchema,
  reason: z.string().optional(),
  tokensUsed: z.number().int().optional(),
  tokenBudget: z.number().int().optional(),
  seconds: z.number().int().optional(),
  updatedAt: z.string(),
});

export const SessionSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  kind: SessionKindSchema,
  title: z.string(),
  tags: z.array(z.string()),
  state: SessionStateSchema,
  /** Missing on rows written before the workbench named conversations itself. */
  titleSource: SessionTitleSourceSchema.optional(),
  /** Set when a 会话标题规则 changes how `title` is shown; missing means `title` is shown as it is. */
  displayTitle: z.string().optional(),
  /** Missing `backendId`/`backendProfileId` mean the legacy default Cursor profile. */
  backendId: NativeBackendIdSchema.optional(),
  backendProfileId: z.string().optional(),
  nativeSessionId: z.string().optional(),
  previousNativeSessionIds: z.array(z.string()).optional(),
  quickExitCount: z.number().int().optional(),
  nativeRuntime: SessionNativeRuntimeSchema.optional(),
  cursorSessionId: z.string().optional(),
  terminalId: z.string().optional(),
  terminalAppearance: z.object({ foreground: z.string(), background: z.string() }).optional(),
  resumePicker: z.boolean().optional(),
  model: z.string().optional(),
  mode: z.string(),
  approval: z.string().optional(),
  archivedAt: z.string().optional(),
  error: z.string().optional(),
  configRevision: z.number().int().optional(),
  configPending: z.boolean().optional(),
  creationFingerprint: z.string().optional(),
  lastActivityAt: z.string().optional(),
  seenActivityAt: z.string().optional(),
  activeSince: z.string().optional(),
  pinnedAt: z.string().optional(),
  /** Pin order, smaller first. */
  pinRank: z.number().int().optional(),
  origin: SessionOriginSchema.optional(),
  handedOffTo: z.string().optional(),
  /** `riffet.core` or `device:<id>`; kept as strings so a newer group never fails decoding. */
  toolGroups: z.array(z.string()).optional(),
  /** `mcp:<name>` or `skill:<name>`; kept as strings so a newer kind never fails decoding. */
  extensionsOff: z.array(z.string()).optional(),
  terminalHold: z.object({ since: z.string(), pid: z.number().int().optional() }).optional(),
  goal: SessionGoalSchema.optional(),
  workItemId: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const SessionListDeltaSchema = z.object({
  revision: z.number().int(),
  full: z.literal(true).optional(),
  sessions: z.array(SessionSchema),
  removed: z.array(z.string()).optional(),
});
