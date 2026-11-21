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

/** Reads and writes of project files (`apps/server/src/workspace`). */
export const FILE_BUDGET = {
  /** Most bytes a preview reads; larger text is refused, a larger binary is named and downloaded. */
  previewReadBytes: 32 * MIB,
  /** Text a preview carries; past it the preview is cut short and the file cannot be edited from it. */
  previewTextBytes: 512 * KIB,
  /** Largest text one save writes. */
  saveBytes: 2 * MIB,
  /** A deletion larger than this is not kept for undo; the client asks before deleting it for good. */
  trashItemBytes: 256 * MIB,
  /** Deleted files kept for undo, all together, and for how long. */
  trashBytes: 1024 * MIB,
  trashRetentionMs: 24 * 60 * 60_000,
  /** Files a client holds unsaved edits of at once; a further one is refused rather than another dropped. */
  draftsKept: 20,
  /** A hex view reads a file in pages of this size, and keeps this many pages of one file. */
  hexPageBytes: 64 * KIB,
  hexPagesKept: 16,
  /** The end of a file a tail view reads and keeps; growth past it pushes out the oldest lines. */
  tailBytes: 256 * KIB,
  /** How often a followed file is asked whether it has grown, while the view shows it. */
  followMs: 2_000,
  /** A LibreOffice conversion of an office document to PDF is killed past this (`previews/office-convert.ts`). */
  officeConvertMs: 60_000,
  /** Conversions that may wait behind the one running; a preview asked for past this shows the extracted text. */
  officeConvertsWaiting: 4,
  /** Converted PDFs kept in memory, all together. */
  officePdfCacheBytes: 64 * MIB,
  /** Most pixels one PDF page a client draws natively may hold (about 12 MB as ARGB); a larger page is drawn smaller. */
  pdfPageMaxPixels: 3_000_000,
} as const;

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

/** Limits for a workbench connection and the expiring, single-use document proofs used to establish it. */
export const WORKBENCH_APPEARANCE_BUDGET = {
  connections: 32,
  bindingsPerConnection: 100,
  receiptsPerConnection: 32,
  documentProofs: 256,
  documentProofMs: 24 * 60 * 60_000,
  proofMs: 5_000,
  callMs: 5_000,
  pingMs: 30_000,
  receiptBytes: 64 * KIB,
  themes: 200,
} as const;

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
  /** Task status events consumed in one pass of a delegation. */
  taskStatusEvents: 64,
  /** Largest file of its `files/` folder handed out; a bigger one is listed but not served. */
  servedFileBytes: 50 * MIB,
} as const;

/** Workbench query pages and the owner's window to confirm an instance setting proposal. */
export const ASSISTANT_QUERY_BUDGET = { pageItems: 50, settingConfirmationMs: 5 * 60_000 } as const;

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

/** Database storage layout, compression, compaction and incremental reclaim budgets (docs/guide/performance.md §3.7). */
export const STORAGE_BUDGET = {
  /** Largest event payload kept inline in `journal_events` before spilling to CAS blobs (fits within one 4 KiB SQLite page). */
  journalInlineBytes: 2 * KIB,
  /** Maximum characters kept per preview field in an inline envelope of an oversized journal event. */
  journalPreviewChars: 512,
  /** Minimum blob payload size worth running Zstd on; smaller payloads stay raw. */
  blobCompressMinBytes: 512,
  /** Maximum JSON blob payload size compressed with the built-in static Zstd dictionary (`zstd-d1`); larger blobs use standard Zstd. */
  blobDictMaxBytes: 16 * KIB,
  /** Compressed blobs at or above this size live as immutable files under `blobs/aa/<hash>.<codec>` instead of SQLite pages. */
  blobExternalBytes: 128 * KIB,
  /** Maximum characters indexed for a `tool` call row in `message_index` / FTS5. */
  toolIndexChars: 256,
  /** Ceiling on total folded row payload bytes kept in `derived.db` (`timeline_rows`); oldest idle sessions evict first past this cap. */
  timelineMaxBytes: 256 * MIB,
  /** Latest full `session` snapshot events retained per conversation in L0 `events`. */
  sessionSnapshotsKept: 5,
  /** SQLite per-role page cache size in bytes (L0 control, L1 journal, L2 derived). */
  controlCacheBytes: 16 * MIB,
  journalCacheBytes: 32 * MIB,
  derivedCacheBytes: 16 * MIB,
  /** SQLite per-role memory-mapped I/O ceiling in bytes on disk-backed databases. */
  controlMmapBytes: 32 * MIB,
  journalMmapBytes: 64 * MIB,
  derivedMmapBytes: 32 * MIB,
  /** Free pages threshold (per database) before background maintenance runs incremental vacuum. */
  vacuumMinFreePages: 256,
  /** Maximum pages reclaimed per incremental vacuum step, so maintenance never blocks the event loop. */
  vacuumStepPages: 2_000,
  /** Maximum on-demand expanded truncated row payloads cached in memory (LRU). */
  expandedRowCacheEntries: 64,
  /** Maximum total bytes of on-demand expanded truncated row payloads cached in memory. */
  expandedRowCacheBytes: 16 * MIB,
  /** Minimum age (ms) after supersession before non-draft journal revisions are stripped by background maintenance. */
  supersededLagMs: 60_000,
  /** Archived conversations older than this (days) have oversized tool text outputs eligible for head+tail cold trimming. */
  archivedTrimDays: 30,
  /** Unarchived inactive conversations older than this (days) also become eligible for cold tool text output trimming. */
  inactiveTrimDays: 90,
  /** Active personal-assistant main conversation turns older than this (days), and past consolidation when enabled, are eligible for cold tool output trimming. */
  assistantTrimDays: 14,
  /** Bytes kept at the head and tail (combined) when trimming an oversized archived/inactive tool output blob. */
  archivedTrimKeepBytes: 32 * KIB,
} as const;

/**
 * A warm Agent resource held for a new session's first message (`WarmPool` in the plugin kit,
 * docs/PLUGIN_ARCHITECTURE.md「预热」). One per Agent; a page asks for it, renews it and releases it.
 */
export const PREWARM_BUDGET = {
  /** A page asks this long after it shows the choice, so a page passed through starts nothing. */
  startDelayMs: 700,
  /** How often an open page renews it. */
  renewMs: 30_000,
  /** Unrenewed this long, it ends: three renewals missed. */
  leaseMs: 90_000,
  /** A start not ready by then fails. */
  readyTimeoutMs: 60_000,
  /** After a failed start, the same configuration is not tried again for this long. */
  failureBackoffMs: 5_000,
  /** A session waits at most this long for one still starting, then starts its own. */
  takeWaitMs: 15_000,
  /** A pane that is starting is read at most this often, and only after it printed. */
  screenReadMs: 120,
} as const;

/**
 * The Cursor API front's answers to cursor-agent's startup queries (`plugins/riffet/cursor/backend/api-cache.ts`).
 * Memory only, dropped when the backend closes; past either cap the least recently used goes.
 */
export const CURSOR_API_CACHE_BUDGET = {
  maxEntries: 64,
  maxBytes: 4 * MIB,
  /** An answer older than this is not served; the start waits for a fresh one. */
  maxStaleMs: 24 * 60 * 60_000,
  /** An access token with more than this left is handed out again; above the CLI's own five-minute renewal. */
  tokenReuseMarginMs: 15 * 60_000,
} as const;

/** Extra tmux rows read only when a visible Cursor approval needs its preview or batch header. */
export const CURSOR_APPROVAL_SCROLLBACK_ROWS = 128;

/**
 * Claude's answer read off its terminal while the CLI draws it (`apps/server/src/backends/claude/live/`). Only while a turn
 * this service watched open runs; nothing is kept past the last few turns.
 */
export const CLAUDE_LIVE_SCREEN_BUDGET = {
  /** Rows read back per look, scrollback included: an answer taller than this is not drafted. */
  tailRows: 2_000,
  /** A pane is looked at most this often, however much it prints. */
  readMs: 250,
  /** Turns whose committed text is remembered, to tell an answer already written from one in flight. */
  turns: 4,
  /** A draft less than this percent of which is in its transcript text is reported, at most once per `reportMs` per session. */
  driftPercent: 90,
  reportMs: 10 * 60_000,
} as const;

/** Checking for a newer Riffet release (docs/UPDATE.md「提示」). */
export const UPDATE_CHECK_BUDGET = {
  /** A check result is reused this long by the CLI, the server and every client; a check runs out of band once it is older. */
  cacheHours: 24,
  /** A failed check, or one already started by another reader, is not repeated sooner than this. */
  retryMinutes: 30,
  /** A client open this long asks the server again (the server answers from its cache). */
  clientRefreshHours: 6,
  /** Largest CHANGELOG read for release notes. */
  changelogBytes: 2 * MIB,
  /** How long reading the CHANGELOG may take. */
  changelogReadMs: 10_000,
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

/** Dictation (docs/VOICE.md §8): one recording, the server's hold on it, and the local recognizer's worker. */
export const DICTATION_BUDGET = {
  /** Longest recording; at it the server finishes as if asked. Also what a client keeps of a recording for a retry. */
  maxDurationMs: 5 * 60_000,
  /** Largest audio frame, 100 ms of 16 kHz PCM16; a larger one closes the connection. */
  frameBytes: 3_200,
  /** Dictation connections one user holds at once. */
  maxConnectionsPerUser: 2,
  /** A dictation with no audio for this long is finished. */
  idleTimeoutMs: 30_000,
  /** A local recognizer's worker process exits after this long without a dictation. */
  workerIdleMs: 10 * 60_000,
  /** One request to a remote transcription service. */
  remoteTimeoutMs: 60_000,
  /** From the end of a recording to its text; past it the dictation fails and can be retried. */
  finishTimeoutMs: 2 * 60_000,
} as const;

/** The model picker's memory: the provider→model record in settings and what a client keeps to paint at once. */
export const MODEL_PICKER_BUDGET = {
  /** Providers per agent whose last model the server remembers (`NativeBackendDefaults.profileModels`); the oldest goes first. */
  rememberedProviders: 32,
  /** Model lists and quota readings a client keeps across restarts, each; the least recently read goes first. */
  storedScopes: 32,
  /** A kept model list or quota reading older than this is not shown; a newer one shows while the fresh read runs. */
  storedMaxAgeMs: 24 * 60 * 60_000,
} as const;

/** Multi-model discussions: stored list cap, input text caps, and per-speech turn limits. */
export const COUNCIL_BUDGET = {
  /** Discussions kept in the store; older ones are pruned on create. */
  keptDiscussions: 100,
  /** Longest topic / proposition text accepted on create. */
  topicChars: 4_000,
  /** Longest document text accepted for review. */
  documentChars: 64_000,
  /** Paragraphs a review document is split into at most. */
  documentParagraphs: 40,
  /** Longest reader supplement. */
  supplementChars: 4_000,
  /** Supplements one discussion keeps. */
  supplements: 20,
  /** Seats per discussion, judge or moderator included. */
  seats: 7,
  /** Rounds a debate may run. */
  minRounds: 2,
  maxRounds: 6,
  /** A speech is a turn of its seat's Agent, tools included; it is stopped after this long. */
  speechTimeoutMs: 15 * 60_000,
  /** The follow-up turn in which a seat records its notes as JSON. */
  recordTimeoutMs: 3 * 60_000,
  /** Rows of one speech's turn sent to a reader who opens it. */
  speechRows: 400,
  /** Deleting a discussion waits this long for a seat's turn to stop before giving up on its conversation. */
  removeWaitMs: 30_000,
} as const;

/** Integrity checks of the databases that cannot be rebuilt (`storage/integrity.ts`). */
export const INTEGRITY_BUDGET = {
  /** The background `quick_check` of `workbench.db` and `journal.db` starts this long after the server has started. */
  startDelayMs: 60_000,
  /** Most distinct `journal_events.blob_ref` hashes looked up in `blobs` by one run. */
  maxBlobRefs: 500_000,
  /** Most `blobs` rows tested for being referenced by one run. */
  maxBlobRows: 500_000,
  /** Most conversation ids compared across databases by one run. */
  maxSessionIds: 200_000,
  /** The worker is stopped after this long; `journal.db` of several gigabytes takes about 7 s. */
  timeoutMs: 10 * 60_000,
} as const;

/** Message search over `derived.db` (`store.ts#searchIndexedMessages`). */
export const MESSAGE_SEARCH_BUDGET = {
  /**
   * A query the trigram index cannot answer (under three characters, or holding a wildcard) reads at
   * most this many of the newest indexed messages across all conversations. It runs synchronously on
   * the main thread: measured at about 100 ms for 316,000 rows read through the time index, so this
   * bounds the stall near 150 ms and leaves an index of ordinary size searched in full.
   */
  scanRows: 500_000,
} as const;

/** Plugin detail page sections and subpages (docs/design/system/plugins.md §6.3, §6.5). */
export const PLUGIN_PAGE_BUDGET = {
  /** Extension-point rows shown inline before linking to a full-list subpage. */
  summaryRows: 5,
  /** Row count above which a subpage adds a local filter input. */
  filterThreshold: 12,
} as const;
