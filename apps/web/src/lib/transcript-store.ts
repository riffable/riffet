/**
 * Conversation copies kept on this device: the sync engine's lane cache (`sync/cache.ts`) and the
 * IndexedDB store older versions wrote transcripts to. Signing out drops both.
 */

const DB_NAME = 'riffet';
const STORE = 'transcripts';

const clearListeners = new Set<() => void>();

/** Registers an in-memory transcript copy that must be dropped together with the stored ones. */
export function onTranscriptsCleared(listener: () => void): () => void {
  clearListeners.add(listener);
  return () => clearListeners.delete(listener);
}

export async function clearTranscripts(): Promise<void> {
  for (const listener of clearListeners) listener();
  await new Promise<void>((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'sessionId' }).createIndex('savedAt', 'savedAt');
      request.onsuccess = () => {
        const db = request.result;
        try { db.transaction(STORE, 'readwrite').objectStore(STORE).clear(); } catch { /* Storage may be unavailable. */ }
        db.close();
        resolve();
      };
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    } catch { resolve(); }
  });
}
