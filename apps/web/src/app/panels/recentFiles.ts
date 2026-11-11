import { useCallback, useState } from 'react';

/**
 * The files last viewed in a project, in the order their tabs were opened, each with when it was
 * last shown. Kept in this browser's storage per project, so the tabs and "recent" survive a
 * reload; the least recently shown one gives way past the limit, as an IDE's tab limit does.
 */

export interface RecentFile { path: string; at: number }
const LIMIT = 12;
const key = (projectId: string) => `riffet.files.recent.v1.${projectId}`;

function read(projectId: string): RecentFile[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key(projectId)) ?? '[]');
    return Array.isArray(value) ? value.filter((item): item is RecentFile => typeof item?.path === 'string' && typeof item?.at === 'number').slice(0, LIMIT) : [];
  } catch { return []; }
}

export function useRecentFiles(projectId: string) {
  // Kept with the project they belong to, so another project's tabs never show for a render.
  const [state, setState] = useState(() => ({ projectId, files: read(projectId) }));
  const files = state.projectId === projectId ? state.files : read(projectId);
  const setFiles = useCallback((update: (current: RecentFile[]) => RecentFile[]) => setState((current) => {
    const base = current.projectId === projectId ? current.files : read(projectId);
    return { projectId, files: update(base) };
  }), [projectId]);
  const save = useCallback((next: RecentFile[]) => {
    try { localStorage.setItem(key(projectId), JSON.stringify(next)); } catch { /* storage full or off: the tabs still work for this page */ }
    return next;
  }, [projectId]);

  const touch = useCallback((path: string) => setFiles((current) => {
    const at = Date.now();
    if (current.some((file) => file.path === path)) return save(current.map((file) => (file.path === path ? { path, at } : file)));
    const next = [...current, { path, at }];
    if (next.length > LIMIT) {
      const oldest = next.reduce((least, file) => (file.at < least.at ? file : least));
      next.splice(next.indexOf(oldest), 1);
    }
    return save(next);
  }), [save, setFiles]);
  const remove = useCallback((path: string) => setFiles((current) => save(current.filter((file) => file.path !== path))), [save, setFiles]);

  /** Newest first, for "recent" lists. */
  const byRecency = [...files].sort((a, b) => b.at - a.at);
  return { files, byRecency, touch, remove };
}
