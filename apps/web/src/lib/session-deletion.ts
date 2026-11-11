import { api, HttpError, onSessionDeletedResponse } from './api';
import { browserCache } from '@/sync/browser';

/**
 * Conversations the server has deleted, as far as this page knows. A deleted id is never rebuilt:
 * anything still holding it (a stream, a draft save, a cache write) finds it here and lets go.
 */
const deleted = new Set<string>();
const listeners = new Set<(ids: string[]) => void>();

/** Whether a storage key or id still refers to a conversation known deleted. */
export const mentionsDeletedSession = (text: string): boolean => { for (const id of deleted) if (text.includes(id)) return true; return false; };

export const isSessionDeleted = (sessionId: string): boolean => deleted.has(sessionId);

/** Calls [listener] once with the ids that were newly found deleted, after their caches are gone. */
export function onSessionsDeleted(listener: (ids: string[]) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Drafts, pending sends and side-chat state this browser keeps under a conversation's id. */
function purgeStorage(ids: readonly string[]): void {
  for (const kind of ['localStorage', 'sessionStorage'] as const) {
    try {
      const storage = globalThis[kind];
      const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter((key): key is string => Boolean(key?.startsWith('riffet.') || key?.startsWith('riffet:')));
      for (const key of keys) {
        const selected = key.startsWith('riffet.discussion-selected.') && ids.includes(storage.getItem(key) ?? '');
        // A pending create (outbox, discussion) names its new id only inside the record.
        const pending = /outbox|discussion-create|native-create/.test(key) && ids.some((id) => (storage.getItem(key) ?? '').includes(id));
        if (selected || pending || ids.some((id) => key.includes(id))) storage.removeItem(key);
      }
    } catch { /* Storage may be unavailable; what it held cannot be reached from here either. */ }
  }
}

/** Marks [ids] deleted and drops everything this device kept for them; the whole workbench stays. */
export function forgetSessions(ids: readonly string[]): void {
  const fresh = ids.filter((id) => !deleted.has(id));
  if (!fresh.length) return;
  for (const id of fresh) deleted.add(id);
  for (const id of fresh) void browserCache().forget(id);
  purgeStorage(fresh);
  for (const listener of [...listeners]) listener(fresh);
}

/**
 * Whether the server says [sessionId] is deleted. Only its `410 SESSION_DELETED` counts: offline, a
 * failed request or a plain 404 prove nothing, so none of them clean anything up.
 */
export async function confirmSessionGone(sessionId: string): Promise<boolean> {
  if (deleted.has(sessionId)) return true;
  try { await api.sessionDeletion(sessionId); return false; }
  catch (error) {
    const gone = error instanceof HttpError && error.status === 410 && error.code === 'SESSION_DELETED';
    if (gone) forgetSessions([sessionId]);
    return gone;
  }
}

// Any request that answers 410 SESSION_DELETED names the deleted id; registered once, with the module.
onSessionDeletedResponse((sessionId) => forgetSessions([sessionId]));
