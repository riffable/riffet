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

/** The 助理's background runs (docs/ASSISTANT.md §7). */
export const ASSISTANT_BUDGET = {
  /** Background runs going at once; the rest wait their turn. */
  concurrentRuns: 2,
  /** Background runs started in any 24 hours unless the owner set their own (`AssistantSettings.dailyRuns`). */
  dailyRuns: 30,
  /** The most the owner may set it to. */
  dailyRunsMax: 200,
  /** Finished run records kept; older ones and their archived conversations are dropped. */
  keptRuns: 200,
  /** Notes waiting for the main conversation; past it the oldest is dropped. */
  pendingNotices: 20,
  /** Characters of the main conversation a memory consolidation is handed; past it the newest are kept. */
  consolidationChars: 40_000,
  /** Delegations open at once. */
  delegations: 50,
  /** The shortest gap between two checks of a watched source. */
  watchMinMinutes: 15,
  /** Bytes read from a watched page or feed. */
  watchFetchBytes: 512 * KIB,
  /** Largest file of its `files/` folder handed out; a bigger one is listed but not served. */
  servedFileBytes: 50 * MIB,
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

/** Processes the server starts for conversations, and how long they may stay (docs/guide/performance.md §3.10). */
export const AGENT_PROCESS_BUDGET = {
  /** A conversation's CLI unused this long, with nothing retaining it, is stopped; `AppSettings.idleReclaimMinutes` overrides it. */
  idleMinutes: 360,
  /** Under memory pressure the idle threshold is divided by this. */
  pressureIdleDivisor: 2,
  /** Resident memory of all conversation CLIs together; past it the least recently used are stopped. `AppSettings.maxAgentMemoryMb` overrides it. */
  memoryBytes: 4 * 1024 * MIB,
  /** The memory budget never takes a CLI used more recently than this. */
  memoryMinIdleMinutes: 30,
  /** A CLI launched this recently is left alone: Claude Code reads a quick exit as a crashed launch. */
  minLaunchAgeMinutes: 10,
  /** How often the reclaimer passes. */
  passMinutes: 5,
  /** Droid and Pi stop their own process after this long without work (their busy state lives in the runtime). */
  headlessIdleMinutes: 10,
  /** The DSH bridge, shared by every DSH conversation, stops after this long without one. */
  bridgeIdleSeconds: 30,
  /** A service whose state directory is in the system temp directory exits after this long without a request or a running turn. */
  tempInstanceIdleMinutes: 240,
  /** An unreachable tmux server or session is at least this old before it is ended: creating one saves its record after. */
  orphanGraceMinutes: 10,
} as const;

/** Plugin commands run from a message's menu (docs/PLUGIN_ARCHITECTURE.md「消息菜单」). */
export const PLUGIN_COMMAND_BUDGET = {
  /** Longest message a client sends with a command; a longer message lists no plugin items. */
  messageChars: 48_000,
  /** Longest `text` a command answers; a longer one is refused as an invalid result. */
  resultChars: 96_000,
  /** What `riffet.translate` keeps of its translations for reuse, counted in characters of source and result; the oldest go first. */
  translationCacheChars: 2_000_000,
  /** `text` results a client keeps shown under their messages, in memory and across conversations; the oldest go first. */
  keptResults: 64,
} as const;

/** Plugin indexes the server reads (docs/PLUGINS.md「插件市场」). */
export const PLUGIN_MARKET_BUDGET = {
  /** Sources a user may add; the built-in one is not counted. */
  maxSources: 16,
  /** Largest index document read; a bigger one makes its source fail, not the others. */
  indexBytes: 16 * MIB,
  /** How long a read index, or a failed read, is reused; installs check content against the index either way. */
  cacheMs: 60_000,
  /** Indexes read at the same time. */
  concurrentReads: 4,
  /** How long one index read may take. */
  readMs: 10_000,
  /** How long listing every source may take; a source not read by then is reported as not read, the others are listed. Below the clients' market timeout. */
  listMs: 15_000,
} as const;
