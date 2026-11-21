import type { NativeControlMessage } from '../types.js';
import type { NativeBackendHost } from '../types.js';
import { estimateTokens } from '../../metrics/tokens.js';
import { measuredWindow, runTracker, type RunMetricsTracker } from '../../metrics/turn-metrics.js';

/** One streamed Droid assistant message, measured from its first delta to its last or request start. */
export interface DroidStep {
  turnId?: string;
  text: string;
  requestStartAt?: number;
  startedAt: number;
  lastAt: number;
  hasUnstreamed?: boolean;
}

export interface DroidCallUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export interface DroidMeterState {
  readonly workbenchSessionId: string;
  readonly metrics: Map<string, RunMetricsTracker>;
  readonly steps: Map<string, DroidStep>;
  readonly turns: Map<string, { commandId: string; runId: string }>;
  activeTurn?: string;
  requestStartAt?: number;
  lastCallUsage?: DroidCallUsage;
  reported?: { modelId?: string };
}

export function droidStepWindow(step: DroidStep, outputTokens?: number, now = Date.now()) {
  const fallbackStart = step.requestStartAt ?? step.startedAt;
  if (step.hasUnstreamed) {
    return { startedAt: fallbackStart, endedAt: Math.max(now, step.lastAt), window: 'observed' as const };
  }
  const tokens = outputTokens ?? (step.text ? Math.max(1, Math.round(estimateTokens(step.text))) : undefined);
  return measuredWindow({
    streamStart: step.startedAt,
    streamEnd: step.lastAt,
    fallbackStart,
    outputTokens: tokens,
    now,
  });
}

function metricsFor(
  host: Pick<NativeBackendHost, 'saveRunMetrics'>,
  emit: (message: NativeControlMessage) => void,
  state: DroidMeterState,
  runId: string | undefined,
  key: string,
): RunMetricsTracker {
  return runTracker(state.metrics, runId ?? key, { runId }, {
    emit,
    save: (id, run) => host.saveRunMetrics(id, run),
  });
}

export function publishDroidStep(
  host: Pick<NativeBackendHost, 'saveRunMetrics'>,
  emit: (message: NativeControlMessage) => void,
  state: DroidMeterState,
  messageId: string,
  step: DroidStep,
  live: boolean,
  outputTokens?: number,
  now = Date.now(),
): void {
  const range = droidStepWindow(step, outputTokens, now);
  if (!range) return;
  const runId = step.turnId ? state.turns.get(step.turnId)?.runId : undefined;
  metricsFor(host, emit, state, runId, `turn:${step.turnId ?? messageId}`).update({
    stepId: messageId,
    text: step.text,
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...range,
    live,
  }, !live);
}

/** Publishes a finished Droid assistant message once, with the count Droid reported just before committing it. */
export function settleDroidStep(
  host: Pick<NativeBackendHost, 'saveRunMetrics' | 'stats'>,
  emit: (message: NativeControlMessage) => void,
  state: DroidMeterState,
  messageId: string,
  useCallUsage = true,
  hasToolUse = false,
): void {
  const now = Date.now();
  let step = state.steps.get(messageId);
  if (step) {
    state.steps.delete(messageId);
    if (hasToolUse) step.hasUnstreamed = true;
  } else if (hasToolUse && (state.requestStartAt !== undefined || (useCallUsage && state.lastCallUsage))) {
    // A pure tool_use assistant message emits no text deltas; still measure it from request start
    // and consume `lastCallUsage` so it is not misattributed to a later message.
    const start = state.requestStartAt ?? now;
    step = {
      ...(state.activeTurn ? { turnId: state.activeTurn } : {}),
      text: '',
      requestStartAt: start,
      startedAt: start,
      lastAt: now,
      hasUnstreamed: true,
    };
  } else {
    return;
  }
  // Aggregate call usage can already belong to the replacement turn when an old end arrives.
  const usage = useCallUsage ? state.lastCallUsage : undefined;
  if (useCallUsage) state.lastCallUsage = undefined;
  publishDroidStep(host, emit, state, messageId, step, false, usage?.outputTokens, now);
  const range = droidStepWindow(step, usage?.outputTokens, now);
  if (!range) return;
  const provider = usage?.outputTokens !== undefined;
  const outputTokens = provider ? usage!.outputTokens! : Math.max(0, Math.round(estimateTokens(step.text)));
  if (!provider && !step.text.trim()) return;
  try {
    host.stats.recordUsage(state.workbenchSessionId, step.turnId ? state.turns.get(step.turnId)?.runId : undefined, {
      stepId: messageId,
      ...(state.reported?.modelId ? { model: state.reported.modelId } : {}),
      startedAt: range.startedAt,
      endedAt: range.endedAt,
      window: range.window,
      tokenSource: provider ? 'provider' : 'estimated',
      outputTokens,
      ...(usage?.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
      ...(usage?.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
    });
  } catch { /* statistics must never affect the stream */ }
}
