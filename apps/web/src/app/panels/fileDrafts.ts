import { useEffect } from 'react';
import { FILE_BUDGET, type FileVersion } from '@contracts';
import { createStore, useStore } from '@/lib/store';

/**
 * Unsaved edits of project files, kept in this page while the reader looks at other files, as an
 * editor keeps a modified tab. `base` is the version the edit started from: the save names it, and
 * a file read since at another version is a conflict. A draft goes when it is saved or discarded;
 * none outlives the page, which asks before it is closed while any is held.
 */
export interface FileDraft { base: string; text: string }

const store = createStore<{ drafts: Readonly<Record<string, FileDraft>> }>({ drafts: {} });
const key = (projectId: string, path: string) => `${projectId}\0${path}`;

type SavedListener = (event: { projectId: string; version: FileVersion; content: string }) => void;
// perf-rules: allow active editor mount listeners removed on unmount
const savedListeners = new Set<SavedListener>();

export const fileDrafts = {
  get: (projectId: string, path: string): FileDraft | undefined => store.get().drafts[key(projectId, path)],
  subscribe: (listener: () => void): (() => void) => store.subscribe(listener),
  /** All paths of `projectId` currently holding unsaved edits. */
  pathsOf(projectId: string): string[] {
    const prefix = `${projectId}\0`;
    return Object.keys(store.get().drafts).filter((id) => id.startsWith(prefix)).map((id) => id.slice(prefix.length));
  },
  /** `FILE_BUDGET.draftsKept` files hold unsaved edits: no other file can start one. */
  full: (): boolean => Object.keys(store.get().drafts).length >= FILE_BUDGET.draftsKept,
  /** False when `FILE_BUDGET.draftsKept` other files already hold unsaved edits; the edit is then not kept. */
  set(projectId: string, path: string, draft: FileDraft): boolean {
    const drafts = store.get().drafts;
    const id = key(projectId, path);
    if (!drafts[id] && Object.keys(drafts).length >= FILE_BUDGET.draftsKept) return false;
    store.set({ drafts: { ...drafts, [id]: draft } });
    return true;
  },
  drop(projectId: string, path: string): void {
    const id = key(projectId, path);
    const { [id]: _dropped, ...rest } = store.get().drafts;
    if (_dropped) store.set({ drafts: rest });
  },
  /** An entry moved: the drafts of it, and of anything inside it, move with it. */
  move(projectId: string, from: string, to: string): void {
    const old = key(projectId, from);
    store.set(({ drafts }) => ({ drafts: Object.fromEntries(Object.entries(drafts).map(([id, draft]) => [
      id === old ? key(projectId, to) : id.startsWith(`${old}/`) ? key(projectId, to) + id.slice(old.length) : id, draft,
    ])) }));
  },
  /** Whether [path], or anything inside it, holds unsaved edits. */
  heldUnder(projectId: string, path: string): boolean {
    const at = key(projectId, path);
    return Object.keys(store.get().drafts).some((id) => id === at || id.startsWith(`${at}/`));
  },
  /** An entry deleted: its draft, and those of anything inside it, go. */
  dropUnder(projectId: string, path: string): void {
    const gone = key(projectId, path);
    store.set(({ drafts }) => ({ drafts: Object.fromEntries(Object.entries(drafts).filter(([id]) => id !== gone && !id.startsWith(`${gone}/`))) }));
  },
  /** Broadcasts that a file was saved (e.g. by Save All) so mounted editors sync their preview hash. */
  notifySaved(projectId: string, version: FileVersion, content: string): void {
    for (const listener of savedListeners) listener({ projectId, version, content });
  },
  onSaved(listener: SavedListener): () => void {
    savedListeners.add(listener);
    return () => { savedListeners.delete(listener); };
  },
};

/** The draft of one file, following its changes. */
export function useDraft(projectId: string, path: string | undefined): FileDraft | undefined {
  return useStore(store, (state) => (path === undefined ? undefined : state.drafts[key(projectId, path)]));
}

/** The paths of [projectId] that hold unsaved edits. */
export function useDraftPaths(projectId: string): string[] {
  const prefix = `${projectId}\0`;
  return useStore(store, (state) => Object.keys(state.drafts).filter((id) => id.startsWith(prefix)).map((id) => id.slice(prefix.length)),
    (a, b) => a.length === b.length && a.every((value, index) => value === b[index]));
}

/** Asks before the page is closed or reloaded while any file has unsaved edits. */
export function useDraftsGuard(): void {
  const held = useStore(store, (state) => Object.keys(state.drafts).length > 0);
  useEffect(() => {
    if (!held) return;
    const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, [held]);
}
