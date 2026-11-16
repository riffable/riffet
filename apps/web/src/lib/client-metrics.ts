import type { ClientMetricsReport } from '@contracts';
import { request } from './api';
import { cacheSnapshot } from './cache-registry';

/*
 * The tab's own figures for the service monitor (docs/guide/performance.md §4): JS heap, the
 * registered caches, and how many frames were held up past 100 ms since the last report. Numbers
 * and cache names only. Best effort: a report that fails is not retried.
 */

const REPORT_EVERY_MS = 5 * 60_000;
const HITCH_MS = 100;
const CLIENT_KEY = 'riffet.metrics-client';

/** One id per tab, kept across reloads, so two tabs on one sign-in are two clients. */
function clientId(): string {
  try {
    const known = sessionStorage.getItem(CLIENT_KEY);
    if (known) return known;
    const id = crypto.randomUUID();
    sessionStorage.setItem(CLIENT_KEY, id);
    return id;
  } catch { return 'tab'; }
}

let started = false;

export function startClientMetrics(): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  const id = clientId();
  let hitches = 0;
  try {
    if (PerformanceObserver.supportedEntryTypes?.includes('long-animation-frame')) {
      new PerformanceObserver((list) => { for (const entry of list.getEntries()) if (entry.duration >= HITCH_MS) hitches += 1; })
        .observe({ type: 'long-animation-frame' });
    }
  } catch { /* Unsupported here; the report leaves the field out. */ }
  const report = (keepalive = false) => {
    try {
      const heap = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize;
      const body: ClientMetricsReport = {
        clientId: id, platform: 'web',
        sample: {
          ...(heap === undefined ? {} : { footprintBytes: heap, managedHeapBytes: heap }),
          hitches,
          caches: cacheSnapshot().map(({ name, size, weight, maxWeight }) => ({
            name, count: size, ...(weight === undefined ? {} : { bytes: weight }), ...(maxWeight === undefined ? {} : { limitBytes: maxWeight }),
          })),
        },
      };
      hitches = 0;
      void request<void>('/api/system/client-metrics', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), keepalive }).catch(() => {});
    } catch { /* Best effort. */ }
  };
  window.setTimeout(() => report(), 60_000);
  window.setInterval(() => report(), REPORT_EVERY_MS);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') report(true); });
}
