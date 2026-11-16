/**
 * Resource budgets every client and the server are held to (docs/guide/performance.md §2). One
 * definition: the web and the server import this file, and `pnpm gen:budgets` writes the same values
 * into `apps/mobile/contracts/.../Budgets.kt` for the Kotlin client, Android, iOS and the Mac app.
 *
 * A budget is a ceiling, not a target: a cache that needs less keeps less. Form factors: `mac` is the
 * Mac app, `web` a browser tab, `phone` Android and iOS.
 */

const KIB = 1024;
const MIB = 1024 * KIB;

/** Transcript rows one lane keeps in memory (docs/SYNC-V3.md 预算); past either cap the rows farthest from the reader go. */
export const LANE_WINDOW = {
  mac: { rows: 1_500, bytes: 6 * MIB },
  web: { rows: 2_000, bytes: 8 * MIB },
  phone: { rows: 800, bytes: 4 * MIB },
} as const;

/** Decoded images kept for drawing, and the encoded bytes kept for a viewer or a save. */
export const IMAGE_CACHE = {
  mac: { decodedBytes: 64 * MIB, encodedBytes: 32 * MIB },
  web: { decodedBytes: 64 * MIB, encodedBytes: 32 * MIB },
  phone: { decodedBytes: 32 * MIB, encodedBytes: 16 * MIB },
} as const;

/** Long edge, in pixels, of the copy an inline image is decoded to; the viewer decodes the original. */
export const IMAGE_DISPLAY_EDGE_PX = { mac: 1_600, web: 1_600, phone: 1_080 } as const;

/** Parsed and laid-out text kept for reuse: markdown, highlighted code, measured rows; all such caches together. */
export const TEXT_CACHE_BYTES = { mac: 32 * MIB, web: 32 * MIB, phone: 16 * MIB } as const;

/**
 * Scrollback rows a client emulator keeps. The server's seed carries `TERMINAL_SCROLLBACK_ROWS`
 * (terminal.ts); a phone keeps the newest of them.
 */
export const TERMINAL_KEPT_ROWS = { mac: 10_000, web: 10_000, phone: 3_000 } as const;

/**
 * Frames a client queues between the stream and the code that applies them. Past it the client drops
 * the queue and resumes from its last applied seq, which costs one delta or snapshot instead of memory.
 */
export const STREAM_QUEUE_FRAMES = 256;
/** The same queue's ceiling in bytes of frame text: a frame may carry up to 256 KB, so the count alone allows 64 MB. */
export const STREAM_QUEUE_BYTES = 8 * MIB;

/** Session-list polling, milliseconds: while the lists stream is live, while it is down, and in the background. */
export const LIST_POLL_MS = { pushed: 30_000, fallback: 5_000, background: 30_000 } as const;

/**
 * The storage page's scan, milliseconds: how often the page reads while a scan runs, how old a finished
 * scan gets before opening the page starts another, and how long a failed scan waits before the page
 * starts one on its own again (rescanning by hand always starts one).
 */
export const STORAGE_SCAN_MS = { poll: 2_000, stale: 24 * 60 * 60_000, retry: 60 * 60_000 } as const;

/**
 * Footprint after a day of ordinary use, in bytes: Activity Monitor's figure on a Mac, the JS heap in a
 * tab, phys_footprint on iOS, total PSS on Android, RSS for the server. Peak stays under 1.5×.
 */
export const STEADY_FOOTPRINT_BYTES = {
  mac: 400 * MIB,
  web: 200 * MIB,
  ios: 200 * MIB,
  android: 250 * MIB,
  server: 512 * MIB,
} as const;

/** The server's own budgets. */
export const SERVER_BUDGET = {
  /** Timeline rows of a session idle this long, and not held open, are dropped; they refold from the journal on open. */
  coldTimelineDays: 7,
  /** Largest single native transcript a background job (usage backfill) reads; larger ones are skipped. */
  backgroundReadBytes: 32 * MIB,
  /** Native transcripts kept parsed in memory for reuse, counted by file size. */
  parsedTranscriptBytes: 64 * MIB,
  /** An event-loop block this long is a defect: it is logged and profiled (`loop-health.ts`). */
  loopBlockMs: 200,
} as const;
