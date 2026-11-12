import type { CapturedSessionReference, NativeActivity, NativeJob, ReasoningChannel, Run, TaskNotificationResult, TaskNotificationStatus, UserAttachment, WorkbenchEvent, TimelineRow } from '../../contracts/src/index.js';
import type { ProjectedEvent } from './projectEvents.js';
import { isRecord } from './values.js';

/*
 * The rows a conversation's events fold into, and the few event readers every fold needs. What is
 * built from them lives beside it — `projectEvents.ts` (events joined into entries), `buildTimeline.ts`
 * (rows) and `timelineTurns.ts` (turn grouping) — and `rows.ts` turns rows into sync v3 `TimelineRow`s.
 */

/** Sync rows retain the server's folded turn identity; source Run ids are provenance, not grouping. */
export type TimelineItem = { turn?: string } & (
  | {
      kind: 'user'; key: string; text: string; event: ProjectedEvent; attachments: UserAttachment[]; references?: CapturedSessionReference[]; run?: Run;
      /** A loaded status row owns this failure. Client-only; the Run retains its outcome. */
      failureShown?: boolean;
    }
  | { kind: 'assistant'; key: string; text: string; phase?: 'commentary' | 'final_answer'; event: ProjectedEvent }
  | { kind: 'thought'; key: string; text: string; channel: ReasoningChannel; event: ProjectedEvent }
  | { kind: 'tool'; key: string; event: ProjectedEvent; job?: NativeJob; activity?: NativeActivity; subagent?: Extract<TimelineRow, { kind: 'tool' }>['subagent'] }
  | { kind: 'plan'; key: string; entries: Record<string, unknown>[]; event: ProjectedEvent }
  | { kind: 'image'; key: string; src: string; event: ProjectedEvent }
  | { kind: 'status'; key: string; tone: 'danger' | 'muted'; text: string; detail?: string; event: ProjectedEvent }
  | { kind: 'task_notification'; key: string; taskId?: string; taskKind: string; status: TaskNotificationStatus; sourceStatus?: string; title: string; command?: string; detail?: string; jobResult?: TaskNotificationResult; subagentToolCallId?: string; tokens?: number; durationMs?: number; event: ProjectedEvent }
  /** Something the CLI did on its own (compaction, background task, local command); later states of the same id replace it in place. */
  | { kind: 'activity'; key: string; activity: NativeActivity; event: ProjectedEvent });

/** A background task linked to its tool shares that tool row; retain its own row when the tool is outside the loaded window. */
export function withoutLinkedActivities(timeline: TimelineItem[]): TimelineItem[] {
  const link = (activity: NativeActivity) => JSON.stringify([activity.id, activity.toolCallId]);
  const linked = new Set(timeline.flatMap(item => item.kind === 'tool' && item.activity ? [link(item.activity)] : []));
  if (!linked.size) return timeline;
  return timeline.filter(item => item.kind !== 'activity' || !linked.has(link(item.activity)));
}

export function chunkText(event: WorkbenchEvent): string {
  const content = event.data.content;
  if (isRecord(content) && typeof content.text === 'string') return content.text;
  return typeof event.data.text === 'string' ? event.data.text : '';
}

export function timelineItemTime(item: TimelineItem): string {
  return item.event.sourceEvents.at(-1)?.createdAt ?? item.event.createdAt;
}

export function nativeEventIds(event: WorkbenchEvent): string[] {
  const native = event as WorkbenchEvent & { nativeId?: unknown; nativeAliases?: unknown };
  return [native.nativeId, ...(Array.isArray(native.nativeAliases) ? native.nativeAliases : [])]
    .filter((id): id is string => typeof id === 'string' && Boolean(id));
}

export function nativeSourceIds(event: ProjectedEvent): string[] {
  return [...new Set([event, ...event.sourceEvents].flatMap(nativeEventIds))];
}
