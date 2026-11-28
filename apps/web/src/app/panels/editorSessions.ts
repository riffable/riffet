import type { EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { FILE_BUDGET } from '@contracts';

/**
 * Bounded LRU cache of detached CodeMirror `EditorState` instances (with scroll offsets) so
 * switching tabs in Code Studio preserves undo/redo history, folded blocks, multi-cursor
 * selections and scroll position. Bounded by `FILE_BUDGET.draftsKept`.
 */
interface SavedEditorSession {
  state: EditorState;
  doc: string;
  scrollTop: number;
  scrollLeft: number;
}

// perf-rules: allow bounded LRU capped at FILE_BUDGET.draftsKept in touch()
const sessions = new Map<string, SavedEditorSession>();

function touch(key: string, entry: SavedEditorSession): void {
  sessions.delete(key);
  sessions.set(key, entry);
  while (sessions.size > FILE_BUDGET.draftsKept) {
    const oldest = sessions.keys().next().value;
    if (oldest === undefined) break;
    sessions.delete(oldest);
  }
}

export const editorSessions = {
  /** Saves a view's state before unmounting so returning to the tab restores history & folds. */
  save(key: string, view: EditorView): void {
    touch(key, {
      state: view.state,
      doc: view.state.doc.toString(),
      scrollTop: view.scrollDOM.scrollTop,
      scrollLeft: view.scrollDOM.scrollLeft,
    });
  },
  /** Restores a cached session when its text still matches `expectedDoc`; drops stale entries. */
  take(key: string, expectedDoc: string): SavedEditorSession | undefined {
    const entry = sessions.get(key);
    if (!entry) return undefined;
    sessions.delete(key);
    if (entry.doc !== expectedDoc) return undefined;
    return entry;
  },
  drop(key: string): void {
    sessions.delete(key);
  },
  /** Re-keys cached sessions after a file or directory rename/move inside `projectId`. */
  move(projectId: string, from: string, to: string): void {
    const marker = `${projectId}\0`;
    const entries = [...sessions.entries()];
    for (const [key, value] of entries) {
      const idx = key.indexOf(marker);
      if (idx < 0) continue;
      const prefix = key.slice(0, idx + marker.length);
      const rel = key.slice(idx + marker.length);
      if (rel === from) {
        sessions.delete(key);
        sessions.set(`${prefix}${to}`, value);
      } else if (rel.startsWith(`${from}/`)) {
        sessions.delete(key);
        sessions.set(`${prefix}${to}${rel.slice(from.length)}`, value);
      }
    }
  },
  /** Drops cached sessions for a deleted file or directory inside `projectId`. */
  dropUnder(projectId: string, path: string): void {
    const marker = `${projectId}\0`;
    for (const key of [...sessions.keys()]) {
      const idx = key.indexOf(marker);
      if (idx < 0) continue;
      const rel = key.slice(idx + marker.length);
      if (rel === path || rel.startsWith(`${path}/`)) sessions.delete(key);
    }
  },
};
