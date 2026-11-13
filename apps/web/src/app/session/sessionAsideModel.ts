import { lineDiff } from './lineDiff';
import type { TimelineItem } from './model';
import { stripRoot, toolView } from './toolView';

export interface SessionOutput { path: string; added: number; removed: number; created: boolean }

export type EditRecord = readonly { path: string; added: number; removed: number; created: boolean }[];

/**
 * Every file this conversation's tools wrote or its commands were seen to change, with the lines each one gained and lost, newest
 * first. A tool row's event object is replaced whenever the row changes, so the per-row diff is
 * cached by event and a streamed append only costs the rows that are new.
 */
export function sessionOutputs(timeline: readonly TimelineItem[], root: string | undefined, cache: WeakMap<object, EditRecord>): SessionOutput[] {
  const byPath = new Map<string, SessionOutput>();
  for (const item of timeline) {
    if (item.kind !== 'tool') continue;
    let edits = cache.get(item.event);
    if (!edits) {
      const view = toolView(item.event, root);
      // A failed edit was not applied; what a failed command changed was seen on disk and stays.
      edits = view.contents.flatMap((content) => {
        if (content.type !== 'diff' || typeof content.path !== 'string') return [];
        if (view.status === 'failed' && content.observed !== true) return [];
        const before = typeof content.oldText === 'string' ? content.oldText : '';
        const after = String(content.newText ?? '');
        const diff = lineDiff(before, after, 0);
        const added = diff?.added ?? (after ? after.split('\n').length : 0);
        const removed = diff?.removed ?? (before ? before.split('\n').length : 0);
        return [{ path: stripRoot(content.path, root), added, removed, created: !before }];
      });
      cache.set(item.event, edits);
    }
    // A subagent's own rows sit in a lane of their own; the server sums what it changed onto the row that started it.
    const subagent = item.subagent?.changes?.map((change) => ({ ...change, path: stripRoot(change.path, root) })) ?? [];
    for (const edit of [...edits, ...subagent]) {
      const current = byPath.get(edit.path);
      byPath.delete(edit.path);
      byPath.set(edit.path, current
        ? { path: edit.path, added: current.added + edit.added, removed: current.removed + edit.removed, created: current.created }
        : { ...edit });
    }
  }
  return [...byPath.values()].reverse();
}
