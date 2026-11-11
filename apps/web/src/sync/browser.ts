import { withClientFeatures, request } from '@/lib/api';
import { onTranscriptsCleared } from '@/lib/transcript-store';
import { idbBackend, SyncCache } from './cache';
import { FRAME_TYPES, type SyncTransport } from './protocol';
import type { Visibility } from './session';

/** The engine's transport in the browser: `EventSource` for the streams, the app's JSON request for the rest. */
export const browserTransport: SyncTransport = {
  stream(url, listener) {
    const source = new EventSource(withClientFeatures(url));
    source.onopen = () => listener.open();
    for (const type of FRAME_TYPES) {
      source.addEventListener(type, (event) => {
        // The server's `error` frame shares its name with the stream's own error event; only the frame has data.
        if (event instanceof MessageEvent && typeof event.data === 'string') listener.frame(type, event.data, event.lastEventId || undefined);
        else if (type === 'error') listener.error(source.readyState === EventSource.CLOSED);
      });
    }
    return { close: () => source.close() };
  },
  get: (path, signal) => request(path, signal ? { signal } : {}),
};

export const documentVisibility: Visibility = {
  hidden: () => document.visibilityState === 'hidden',
  subscribe(listener) {
    // A phone that froze the page may restore it without a visibility change, and a network that
    // came back says nothing to a stream that died with it; `pageshow` and `online` cover those.
    document.addEventListener('visibilitychange', listener);
    window.addEventListener('pageshow', listener);
    window.addEventListener('online', listener);
    return () => {
      document.removeEventListener('visibilitychange', listener);
      window.removeEventListener('pageshow', listener);
      window.removeEventListener('online', listener);
    };
  },
};

let cache: SyncCache | undefined;

/** The page's one cache, emptied with the stored transcripts when the browser signs out. */
export function browserCache(): SyncCache {
  if (!cache) {
    const created = new SyncCache(typeof indexedDB === 'undefined' ? undefined : idbBackend());
    onTranscriptsCleared(() => { void created.clear(); });
    cache = created;
  }
  return cache;
}
