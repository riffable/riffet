import type { MarkQuote, WorkbenchEvent } from '@contracts';
import type { TimelineItem } from './model';

/** What a search result (or a 收藏) asks the transcript to show. */
export interface MessageFocus {
  /** The message's own id, matched against the native ids an event carries. */
  messageId: string;
  /** Other ids the same message was known by, tried after [messageId]: a mark's original anchor. */
  aliases?: string[];
  /** Set when the hit came from a run, whose turn the timeline keys as `user:<runId>`. */
  runId?: string;
  /** A highlight's words: the transcript scrolls to them rather than to the whole answer. */
  quote?: MarkQuote;
  /** A row the transcript itself points at (a notice's launching call), by its timeline key rather than a message id. */
  itemKey?: string;
}

function hasNativeId(event: WorkbenchEvent, messageIds: readonly string[]): boolean {
  const { nativeId, nativeAliases } = event as WorkbenchEvent & { nativeId?: unknown; nativeAliases?: unknown };
  if (typeof nativeId === 'string' && messageIds.includes(nativeId)) return true;
  return Array.isArray(nativeAliases) && nativeAliases.some((alias) => messageIds.includes(alias));
}

/**
 * The row key of the message a search result matched, or nothing when the loaded transcript does
 * not contain it — it may be in an older page the reader has not loaded, which the transcript then
 * pages back through.
 */
export function rowKeyForMessage(timeline: readonly TimelineItem[], focus: MessageFocus): string | undefined {
  if (focus.itemKey) return timeline.some((item) => item.key === focus.itemKey) ? focus.itemKey : undefined;
  if (focus.runId) {
    const key = `user:${focus.runId}`;
    if (timeline.some((item) => item.key === key)) return key;
  }
  const ids = [focus.messageId, ...(focus.aliases ?? [])];
  return timeline.find((item) => item.event.sourceEvents.some((event) => hasNativeId(event, ids)))?.key;
}
