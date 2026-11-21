import type { NativeInteraction, NativeStatus } from '../../../../../packages/contracts/src/index.js';
import { estimateTokens } from '../../metrics/tokens.js';
import { measuredWindow } from '../../metrics/turn-metrics.js';
import type { DshContextBreakdown } from './context.js';
import type { DshSessionReadResult, DshConversation, DshAttempt } from './types.js';
import { KeyedTurnTrackers } from '../shared/turn-tracker.js';
import { nonEmpty, finiteToken, asRecord } from './util.js';
import { displayedPermission } from './selection.js';

/** A child window without turn markers counts as running while its newest record is this recent. */
const SUBAGENT_ACTIVE_MS = 60_000;
/** DSH's input total excludes cache. A missing cache field stays missing, including cache writes of an older record. */
export function readDshUsage(usage: Record<string, unknown> | undefined, model: string | undefined): DshAttempt['usage'] | undefined {
  if (!usage) return undefined;
  const outputTokens = finiteToken(usage.outputTokens);
  if (outputTokens === undefined) return undefined;
  const reasoningTokens = finiteToken(usage.reasoningTokens);
  const inputTokens = finiteToken(usage.inputTokens);
  const cacheReadTokens = finiteToken(usage.cacheReadTokens);
  const cacheWriteTokens = finiteToken(usage.cacheWriteTokens);
  const named = model ?? nonEmpty(usage.model);
  return {
    outputTokens,
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(named ? { model: named } : {}),
  };
}

export function mergeDshUsage(current: DshAttempt['usage'] | undefined, next: NonNullable<DshAttempt['usage']>): NonNullable<DshAttempt['usage']> {
  if (!current) return next;
  return {
    outputTokens: next.outputTokens,
    ...(next.reasoningTokens !== undefined ? { reasoningTokens: next.reasoningTokens } : current.reasoningTokens !== undefined ? { reasoningTokens: current.reasoningTokens } : {}),
    ...(next.inputTokens !== undefined ? { inputTokens: next.inputTokens } : current.inputTokens !== undefined ? { inputTokens: current.inputTokens } : {}),
    ...(next.cacheReadTokens !== undefined ? { cacheReadTokens: next.cacheReadTokens } : current.cacheReadTokens !== undefined ? { cacheReadTokens: current.cacheReadTokens } : {}),
    ...(next.cacheWriteTokens !== undefined ? { cacheWriteTokens: next.cacheWriteTokens } : current.cacheWriteTokens !== undefined ? { cacheWriteTokens: current.cacheWriteTokens } : {}),
    ...(next.model ? { model: next.model } : current.model ? { model: current.model } : {}),
  };
}

export function dshAttemptWindow(attempt: DshAttempt, now = Date.now()) {
  if (attempt.hasUnstreamed && attempt.startedWallAt) {
    return { startedAt: attempt.startedWallAt, endedAt: Math.max(now, attempt.lastAt || 0), window: 'observed' as const };
  }
  const outputTokens = attempt.usage?.outputTokens ?? (attempt.text ? Math.max(1, Math.round(estimateTokens(attempt.text))) : undefined);
  return measuredWindow({
    streamStart: attempt.startedAt || undefined,
    streamEnd: attempt.lastAt || undefined,
    fallbackStart: attempt.startedWallAt || undefined,
    outputTokens,
    now,
  });
}

export function sessionGeneration(nativeSessionId: string, result: DshSessionReadResult): string {
  const createdAt = result.session?.createdAt;
  return `${nativeSessionId}:${typeof createdAt === 'number' ? createdAt : 'unknown'}`;
}

/** Three integers, so a read that reports the same composition is not a change worth publishing. */
export function sameBreakdown(left: DshContextBreakdown | undefined, right: DshContextBreakdown | undefined): boolean {
  if (!left || !right) return left === right;
  return left.systemTokens === right.systemTokens
    && left.toolsTokens === right.toolsTokens
    && left.messageTokens === right.messageTokens;
}

/** Whether the records leave a turn open; undefined when they hold no turn marker at all. */
export function openTurn(rawEvents: readonly unknown[]): boolean | undefined {
  let open: boolean | undefined;
  for (const raw of rawEvents) {
    const type = asRecord(raw)?.type;
    if (type === 'turn/start') open = true;
    else if (type === 'turn/end') open = false;
  }
  return open;
}

export function recentRecord(rawEvents: readonly unknown[]): boolean {
  const time = asRecord(rawEvents.at(-1))?.time;
  return typeof time === 'number' && Date.now() - time < SUBAGENT_ACTIVE_MS;
}

/** The phase of a conversation goes through its tracker; DSH's protocol is the only channel. */
export const dshTurns = new KeyedTurnTrackers<object>();

export function statusFor(state: DshConversation, phase?: NativeStatus['phase']): NativeStatus {
  const sessionModel = state.session.model ?? nonEmpty(state.profile.config.defaultModel);
  return {
    phase: dshTurns.report(state, phase ?? (state.interaction ? 'attention' : state.status.phase)),
    ...(sessionModel ? { model: sessionModel } : {}),
    ...(state.session.approval ? { approval: displayedPermission(state.session.approval), permission: displayedPermission(state.session.approval) } : {}),
    ...(state.interaction ? { interaction: state.interaction } : {}),
  };
}

export function interactionRequestId(interaction: NativeInteraction): string | undefined {
  return typeof interaction.requestId === 'string' ? interaction.requestId : undefined;
}

export function pickRunId(params: Record<string, unknown>): string | undefined {
  return typeof params.runId === 'string' ? params.runId : undefined;
}
