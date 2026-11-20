import type { NativeStreamMessage, Session } from '../../../../../packages/contracts/src/index.js';
import { RunMetricsTracker, runTracker } from '../../metrics/turn-metrics.js';
import type { UsageRecord } from '../../stats/types.js';
import type { NativeBackendHost } from '../types.js';
import type { ClaudeStepMeasurement } from './step-meter.js';

/**
 * One settled Claude request for the ledger. `stepId` for a parent response is `message.id` from
 * the JSONL; a subagent notice uses `subagent:<tool-use-id>`, else the task id, else the row uuid.
 */
export function claudeUsageRecord(step: ClaudeStepMeasurement): UsageRecord {
  return {
    stepId: step.stepId,
    ...(step.nativeMessageId ? { nativeMessageId: step.nativeMessageId } : {}),
    ...(step.model ? { model: step.model } : {}),
    ...(step.agentKind === 'subagent' ? { agentKind: 'subagent' as const } : {}),
    ...(step.subagentType ? { subagentType: step.subagentType } : {}),
    ...(step.parentStepId ? { parentStepId: step.parentStepId } : {}),
    startedAt: step.startedAt,
    endedAt: step.endedAt,
    ...(step.inputTokens === undefined ? {} : { inputTokens: step.inputTokens }),
    ...(step.cacheReadTokens === undefined ? {} : { cacheReadTokens: step.cacheReadTokens }),
    ...(step.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: step.cacheWriteTokens }),
    outputTokens: step.outputTokens,
    ...(step.reasoningTokens === undefined ? {} : { reasoningTokens: step.reasoningTokens }),
    tokenSource: 'provider',
    window: 'transcript',
  };
}

export function runForClaudeStep(host: NativeBackendHost, sessionId: string, step: ClaudeStepMeasurement): string | undefined {
  return (step.commandId ? host.findRunIdByCommand(sessionId, step.commandId) : undefined)
    ?? (step.nativeMessageId ? host.findRunIdByNativeMessage?.(sessionId, step.nativeMessageId) : undefined);
}

/** Rebuild only measured transcript windows, never an entire turn's tool/wait duration. */
export function claudeHistoryMetrics(host: NativeBackendHost, session: Session, steps: ClaudeStepMeasurement[]): NativeStreamMessage[] {
  const trackers = new Map<string, RunMetricsTracker>();
  const frames = new Map<string, NativeStreamMessage>();
  for (const step of steps) {
    if (step.agentKind === 'subagent' || !step.nativeMessageId) continue;
    const runId = runForClaudeStep(host, session.id, step);
    const key = runId ?? `native:${step.nativeMessageId}`;
    let tracker = trackers.get(key);
    if (!tracker) {
      tracker = new RunMetricsTracker((metrics, run) => {
        frames.set(key, { type: 'metrics', metrics, run, nativeMessageId: step.nativeMessageId, ...(runId ? { runId } : {}) });
        if (runId) host.saveRunMetrics(runId, run);
      });
      trackers.set(key, tracker);
    }
    tracker.update({ ...step, window: 'transcript' }, true);
  }
  return [...frames.values()];
}


/**
 * The speed meters and ledger rows of one Claude conversation, fed from its transcript's own
 * measurements. Every change of the transcript offers all of its responses again, so only what moved
 * is forwarded, and each settled request reaches the ledger once.
 */
export class ClaudeStepMetering {
  /** One speed tracker per run, and the last measurement published for each response. */
  private readonly trackers = new Map<string, RunMetricsTracker>();
  /**
   * Every change hands over all of the transcript's steps, in order, so these two are not capped: an
   * LRU smaller than the transcript evicts each step just before it comes round again, and every
   * change then rewrites the whole history to the ledger. They grow with the rows the transcript
   * already holds in memory.
   */
  private readonly publishedSteps = new Map<string, { signature: string; settled: boolean }>();
  /** Usage already handed to the ledger, so a step offered again does not write the same row again. */
  private readonly recordedUsage = new Map<string, string>();
  /** The measurements last handed to `publish`, and whether the turn had ended then. */
  private publishedMeasurements?: { steps: ClaudeStepMeasurement[]; turnEnded: boolean };

  constructor(private readonly host: NativeBackendHost, private readonly sessionId: string, private readonly emit: (message: Extract<NativeStreamMessage, { type: 'metrics' }>) => void) {}

  /**
   * Feed the transcript's own measurements into the speed meters.
   *
   * Every change of the transcript offers all of its responses again, and a full re-read re-maps
   * them from the start. Republishing an unchanged live response would put a write to the run store on a 300ms
   * timer, so a step is only forwarded when its numbers actually moved, and a settled step is
   * dropped once it has been published.
   */
  publish(steps: ClaudeStepMeasurement[], turnEnded: boolean): void {
    // An unchanged transcript hands back the very same list: nothing in it can have moved.
    if (this.publishedMeasurements?.steps === steps && this.publishedMeasurements.turnEnded === turnEnded) return;
    this.publishedMeasurements = { steps, turnEnded };
    for (const step of steps) {
      const settled = step.agentKind === 'subagent' || !step.live || turnEnded;
      this.recordClaudeUsage(step, settled);
      if (step.agentKind === 'subagent') continue;
      const signature = `${step.outputTokens}:${step.reasoningTokens ?? ''}:${Math.round(step.startedAt)}:${Math.round(step.endedAt)}:${step.live ? 1 : 0}`;
      const previous = this.publishedSteps.get(step.stepId);
      if (previous?.settled) continue;
      // An unfinished response reports a growing end time, so it always differs; a settled one
      // only needs publishing when its final numbers arrive.
      if (previous && previous.signature === signature) continue;
      const runId = runForClaudeStep(this.host, this.sessionId, step);
      const tracker = this.metricsFor(runId, step.stepId, step.nativeMessageId);
      tracker.update({
        stepId: step.stepId,
        outputTokens: step.outputTokens,
        text: step.text,
        ...(step.reasoningTokens === undefined ? {} : { reasoningTokens: step.reasoningTokens }),
        startedAt: step.startedAt,
        endedAt: step.endedAt,
        window: 'transcript',
        live: step.live,
      }, !step.live);
      this.publishedSteps.set(step.stepId, { signature, settled: !step.live });
    }
  }

  /**
   * One settled Claude request. `stepId` for a parent response is `message.id` from the JSONL.
   * A subagent notice uses `subagent:<tool-use-id>`, else the task id, else the row uuid.
   */
  private recordClaudeUsage(step: ClaudeStepMeasurement, settled: boolean): void {
    if (!settled) return;
    const signature = [
      step.outputTokens, step.inputTokens ?? '', step.cacheReadTokens ?? '', step.cacheWriteTokens ?? '',
      step.reasoningTokens ?? '', step.model ?? '', Math.round(step.startedAt), Math.round(step.endedAt),
    ].join(':');
    if (this.recordedUsage.get(step.stepId) === signature) return;
    this.recordedUsage.set(step.stepId, signature);
    const runId = runForClaudeStep(this.host, this.sessionId, step);
    try {
      this.host.stats?.recordUsage(this.sessionId, runId, claudeUsageRecord(step));
    } catch { /* statistics must never affect the stream */ }
  }

  private metricsFor(runId: string | undefined, stepId: string, nativeMessageId?: string): RunMetricsTracker {
    return runTracker(this.trackers, runId ?? (nativeMessageId ? `native:${nativeMessageId}` : `step:${stepId}`), { runId, nativeMessageId: () => nativeMessageId }, {
      emit: message => this.emit(message), save: (id, run) => this.host.saveRunMetrics(id, run),
    });
  }
}
