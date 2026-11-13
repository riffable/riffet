import { resourceName } from './browser-diagnostics';
import { api } from './api';

/*
 * Long Animation Frames and growth figures from a long-lived tab, uploaded to the server so a hang
 * that DevTools cannot attach to can still be read afterwards. Like browser-diagnostics, only shipped
 * asset names are kept: no routes, queries, fragments or content.
 */

const MIN_FRAME_MS = 200;
const MAX_SCRIPTS = 3;
// Small enough that a full batch fits the 64 KB a keepalive request may carry.
const MAX_BATCH = 30;
const MAX_PER_MINUTE = 10;
const SNAPSHOT_EVERY_MS = 10 * 60_000;
/** Six hours of snapshots: they ride along with a slow frame, so the growth before it can be read. */
const MAX_SNAPSHOTS = 36;
const UPLOAD_EVERY_MS = 5 * 60_000;

/** The Long Animation Frames API's entries; not in the DOM typings. */
interface FrameScript { invoker: string; invokerType: string; sourceURL: string; sourceFunctionName: string; sourceCharPosition: number; duration: number; forcedStyleAndLayoutDuration: number }
interface LongAnimationFrame extends PerformanceEntry { blockingDuration: number; renderStart: number; styleAndLayoutStart: number; scripts: readonly FrameScript[] }

const round = (value: number) => Math.round(value);

function growth() {
  const heap = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize;
  return { uptimeMs: round(performance.now()), elements: document.getElementsByTagName('*').length, ...(heap === undefined ? {} : { heapBytes: heap }) };
}

function frameRecord(frame: LongAnimationFrame) {
  return {
    type: 'frame',
    startTime: round(frame.startTime),
    duration: round(frame.duration),
    blockingDuration: round(frame.blockingDuration),
    renderDelay: frame.renderStart ? round(frame.renderStart - frame.startTime) : undefined,
    styleAndLayoutDelay: frame.styleAndLayoutStart ? round(frame.styleAndLayoutStart - frame.startTime) : undefined,
    scripts: [...frame.scripts].sort((a, b) => b.duration - a.duration).slice(0, MAX_SCRIPTS).map((script) => ({
      invoker: script.invoker.slice(0, 120),
      invokerType: script.invokerType,
      source: script.sourceURL ? resourceName(script.sourceURL) : undefined,
      function: script.sourceFunctionName.slice(0, 120),
      position: script.sourceCharPosition,
      duration: round(script.duration),
      forcedStyleAndLayout: round(script.forcedStyleAndLayoutDuration),
    })),
    ...growth(),
  };
}

let started = false;

/** Starts once; does nothing where Long Animation Frames are unsupported. Never throws into the app. */
export function startMainThreadMonitor(): void {
  if (started || typeof PerformanceObserver === 'undefined') return;
  try {
    if (!PerformanceObserver.supportedEntryTypes?.includes('long-animation-frame')) return;
    started = true;
    let frames: unknown[] = [];
    let snapshots: unknown[] = [];
    let minute = 0, inMinute = 0;
    const add = (entry: unknown) => {
      const now = Date.now();
      if (now - minute >= 60_000) { minute = now; inMinute = 0; }
      if (inMinute >= MAX_PER_MINUTE || frames.length >= MAX_BATCH) return;
      inMinute += 1;
      frames.push(entry);
    };
    // Only a slow frame is worth a file: the server keeps the newest few, and a quiet tab's snapshots
    // alone would push out the batches that explain a hang.
    const flush = (leaving = false) => {
      if (!frames.length) return;
      const report = { version: 1, at: new Date().toISOString(), entries: [...snapshots, ...frames] };
      frames = [];
      snapshots = [];
      try { void api.uploadJankReport(report, leaving).catch(() => {}); } catch { /* Diagnostics are best effort. */ }
    };
    new PerformanceObserver((list) => {
      try {
        for (const entry of list.getEntries() as LongAnimationFrame[]) if (entry.duration >= MIN_FRAME_MS) add(frameRecord(entry));
      } catch { /* A malformed entry must not reach the app. */ }
    }).observe({ type: 'long-animation-frame', buffered: true });
    setInterval(() => { try { snapshots = [...snapshots, { type: 'snapshot', ...growth() }].slice(-MAX_SNAPSHOTS); } catch { /* Best effort. */ } }, SNAPSHOT_EVERY_MS);
    setInterval(() => flush(), UPLOAD_EVERY_MS);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(true); });
    window.addEventListener('pagehide', () => flush(true));
  } catch { /* Unsupported or restricted environment. */ }
}
