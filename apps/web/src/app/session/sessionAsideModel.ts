import type { FileChange, FileChangeStatus } from '@contracts';
import { toolFileChanges } from '../../../../../packages/timeline/src/lineDiff';
import type { TimelineItem } from './model';
import { stripRoot } from './toolView';

export type SessionOutput = FileChange;

export interface EditCacheEntry {
  root: string | undefined;
  edits: readonly SessionOutput[];
}

/**
 * Fallback client-side output aggregation for older servers that do not send Sync v3 `outputs`.
 * Keyed by `(event, root)` so late-arriving project roots never reuse unstripped absolute paths.
 */
export function sessionOutputs(timeline: readonly TimelineItem[], root: string | undefined, cache: WeakMap<object, EditCacheEntry>): SessionOutput[] {
  const byPath = new Map<string, SessionOutput>();
  for (const item of timeline) {
    if (item.kind !== 'tool') continue;
    let cached = cache.get(item.event);
    if (!cached || cached.root !== root) {
      const edits: SessionOutput[] = toolFileChanges(item.event.data).map((change) => ({
        path: stripRoot(change.path, root),
        added: change.added,
        removed: change.removed,
        created: change.created,
        status: change.status,
        ...(change.binary ? { binary: true } : {}),
        ...(change.accuracy ? { accuracy: change.accuracy } : {}),
      }));
      cached = { root, edits };
      cache.set(item.event, cached);
    }
    const subagent: SessionOutput[] = item.subagent?.changes?.map((change) => ({
      ...change,
      path: stripRoot(change.path, root),
    })) ?? [];
    for (const edit of [...cached.edits, ...subagent]) {
      const current = byPath.get(edit.path);
      byPath.delete(edit.path);
      if (current) {
        const nextStatus: FileChangeStatus | undefined = edit.status === 'deleted'
          ? 'deleted'
          : current.status === 'created' || current.created
            ? 'created'
            : edit.status ?? current.status;
        if ((current.status === 'created' || current.created) && edit.status === 'deleted') continue;
        byPath.set(edit.path, {
          ...current,
          path: edit.path,
          added: current.added + edit.added,
          removed: current.removed + edit.removed,
          created: nextStatus === 'created',
          ...(nextStatus ? { status: nextStatus } : {}),
          ...(current.binary || edit.binary ? { binary: true } : {}),
        });
      } else {
        byPath.set(edit.path, { ...edit });
      }
    }
  }
  return [...byPath.values()].reverse();
}
