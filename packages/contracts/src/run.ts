import type { NativeBackendId } from './agent-ids.js';
import type { CapturedSessionReference, Session, SessionReferenceInput } from './session.js';
import type { TextRef } from './settings.js';

export interface NativeRunInput {
  text: string;
  attachmentIds: string[];
  context: Array<{ path: string; line?: number }>;
  references?: SessionReferenceInput[];
  /** Agents the owner @-mentioned: this conversation may call them through Riffet (docs/AGENT-CALLS.md §3). */
  agents?: AgentMention[];
}
/**
 * An Agent named in a message; the conversation's Agent may call it (docs/AGENT-CALLS.md §3). What the owner picked
 * for it is binding on the call: the provider, and the model with its parameters (`model[effort=high,fast=true]`).
 * Left out, the calling Agent chooses.
 */
export interface AgentMention {
  backendId: NativeBackendId;
  backendProfileId?: string;
  model?: string;
  /** Team member id when `@`-mentioning a standing member (docs/TEAM.md §4.3). */
  memberId?: string;
  /** Display name snapshot as written in the message (`@<label>`). */
  label?: string;
}
/** A provider turn identity; unlike a display run id it can fence a mid-turn input. */
export interface NativeTurnTarget { nativeSessionId: string; turnId: string; }
/** A Stop belongs to the exact state the caller saw; retries preserve this identity. */
export interface NativeStopRequest {
  requestId: string; nativeSessionId: string; turnId?: string;
  terminalId?: string; terminalEpoch?: number;
}
export interface NativeRunRecovery { run: Run; canContinue: boolean; queuedRunIds: string[]; }
/** Config values keep the selected backend's own vocabulary and semantics. */
export interface NativeRunConfig { model?: string; mode: string; approval?: string; }
export type NativeDeliveryState = 'queued' | 'preparing' | 'dispatching' | 'input_sent' | 'observed' | 'uncertain' | 'failed' | 'cancelled';
export interface NativeRunDetails {
  /** Durable first-attempt marker: failed/late pre-turn snapshots must never be retaken later. */
  checkpointAttempted?: boolean;
  input: NativeRunInput;
  /** Immutable captured references, without their message bytes or materialized file paths. */
  contextSnapshots?: CapturedSessionReference[];
  config: NativeRunConfig;
  /** A message for this exact active turn, never a new queued task. */
  intent?: 'steer';
  nativeTurnId?: string;
  /** Stable execution owner when this submission is an additional input to a turn. */
  ownerRunId?: string;
  /** A queued submission atomically replaced by this steering input. */
  sourceRunId?: string;
  /** @deprecated Written by servers before every run waited for its turn's end; ignored. */
  expectsTurnOutcome?: boolean;
  /** Actual model selection after CLI capability normalization; config remains the request snapshot. */
  resolvedConfig?: NativeRunConfig;
  fingerprint: string;
  delivery: NativeDeliveryState;
  attempt: number;
  terminalId?: string;
  terminalEpoch?: number;
  nativeSessionId?: string;
  backendId?: NativeBackendId;
  cursorSessionId?: string;
  nativeMessageId?: string;
  stage?: string;
  timings?: Record<string, number>;
  /**
   * Where the input was recorded in the session journal when its write fence was committed: the main
   * lane log's generation and the `meta.input` seq. The timeline files the message there until the
   * CLI's echo joins it (docs/TURN-LIFECYCLE.md T1). Absent for runs from before this was recorded,
   * and stale once the log is rebuilt or its import window promoted (another generation).
   */
  inputEntry?: { generation: string; seq: number };
  /** Baseline native event sequence and the exact text delivered to the CLI, when known. */
  baselineSequence?: number;
  renderedText?: string;
  /** Driver-written, secret-free native entry boundary captured before the input was sent. */
  nativeInputBoundary?: string;
  /** Releases only the old uncertain-input fence, never current provider activity. */
  queueReleasedAt?: string;
  /** Technical cause retained separately from the user-facing status. */
  diagnostic?: { code?: string; message: string; stage?: string; at: string };
  /**
   * The provider's own verdict on whether the CLI answers this message inside its pane as a slash
   * command (`true`) or runs it as a turn (`false`, e.g. a skill invoked as `/name`). Absent means
   * the text decides: a leading `/` is a command.
   */
  slashCommand?: boolean;
  configRevision: number;
  /**
   * Model output speed for the whole turn. Persisted, because two of the four providers can only
   * be timed while they are being watched: a browser reload must not turn a measured turn into a
   * missing one. Absent means "this turn was not measured", never "zero".
   */
  metrics?: RunMetrics;
}

/** Where a token count came from. An estimate is always labelled as one in the UI. */
export type MetricsTokenSource = 'provider' | 'estimated';
/**
 * What the measured milliseconds actually bracket, which is what makes two providers comparable:
 * `stream` is first delta to last delta (true decode time), while `transcript` and `observed`
 * start at the previous committed record and therefore include the provider's time-to-first-token.
 */
export type MetricsWindow = 'stream' | 'transcript' | 'observed';
/** Token accounting for one assistant response step, as reported by a provider or estimated. */
export interface StepMetrics {
  /** Backend-scoped identity of one assistant response (one provider request). */
  stepId: string;
  outputTokens: number;
  tokens: MetricsTokenSource;
  durationMs: number;
  /** Epoch milliseconds of the observed output, so replayed history is never timed as new output. */
  startedAt?: number;
  endedAt?: number;
  window: MetricsWindow;
  /** True while this step is still streaming; a live step is replaced by its settled value. */
  live: boolean;
  /** Reasoning tokens when the provider accounts for them inside `outputTokens`. */
  reasoningTokens?: number;
}
/** Turn-to-date aggregate: the sum over the turn's assistant steps, so partial turns still read. */
export interface RunMetrics {
  outputTokens: number;
  durationMs: number;
  tokens: MetricsTokenSource | 'mixed';
  window: MetricsWindow;
  /** How many assistant steps contributed. Zero means the turn produced no measurable output. */
  steps: number;
}
/** Recent model output speed. The rolling window selects samples; measured response time is the denominator. */
export interface OutputRate {
  state: 'no_data' | 'live' | 'zero' | 'stale';
  windowSeconds: number;
  outputTokens: number;
  tokensPerSecond: number;
  /** Measured response time represented by the sampled output. Absent on older throughput servers. */
  durationMs?: number;
  window?: MetricsWindow;
  /** Absent when the window has no token samples. */
  tokens?: MetricsTokenSource | 'mixed';
}
export type NativeSessionInput = Pick<Session, 'projectId'> & Partial<Pick<Session, 'title' | 'tags' | 'model' | 'mode' | 'approval' | 'backendId' | 'backendProfileId' | 'nativeSessionId' | 'cursorSessionId' | 'resumePicker' | 'origin' | 'terminalAppearance' | 'toolGroups' | 'extensionsOff' | 'workItemId' | 'agentMemberId'>>;
export interface Run {
  id: string; sessionId: string; commandId: string; prompt: string;
  state: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  native?: NativeRunDetails;
  createdAt: string; updatedAt: string; error?: string; errorRef?: TextRef;
}
export interface WorkbenchEvent {
  sequence: number; sessionId: string; runId?: string; type: string;
  data: Record<string, unknown>; raw?: unknown; createdAt: string;
}
