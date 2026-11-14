import type { NativeContext, Run } from '@contracts';

/*
 * The session view's shared vocabulary: the row and picker types every surface agrees on, and the
 * few event readers they all need. The rows and their readers come from `packages/timeline`, which
 * the server folds too; `toolView.ts` (tool rows) and `lineDiff.ts` (diffs) read them here.
 */

export type { ReasoningChannel, TaskNotificationResult, TaskNotificationStatus, UserAttachment } from '@contracts';
export { chunkText, nativeEventIds, nativeSourceIds, timelineItemTime, type TimelineItem } from '../../../../../packages/timeline/src/model';

/** `group` heads a run of adjacent choices, e.g. the provider a batch of models came from. */
export interface Choice { id: string; label: string; description?: string; group?: string; }
/** A `/` menu entry. `kind` absent means a command, which only works as the message's first token. */
export interface SlashCommand { name: string; description?: string; hint?: string; kind?: 'command' | 'skill'; path?: string; }

/**
 * A provider-reported meter, either window occupancy or the latest response against a compaction
 * budget. Estimated breakdowns have their own total. Absent when no measurement is reported.
 */
export interface ContextUsage extends Omit<NativeContext, 'breakdown'> {
  cost?: { amount: number; currency: string };
  breakdown?: NativeContext['breakdown'];
}

/** Only an explicit pre-delivery rejection can become a new sendable draft. */
export function canRestoreUnsentRun(run: Run | undefined): boolean {
  const native = run?.native;
  return run?.state === 'failed' && native?.delivery === 'failed'
    && (native.stage === 'steer_rejected' || native.stage === 'outbox_failure'
      || native.stage === 'prepare' && native.timings?.dispatchAt === undefined)
    && !native.nativeMessageId && native.timings?.observedAt === undefined && native.timings?.providerAcceptedAt === undefined;
}
