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

/**
 * Decoded images kept for drawing, and the encoded bytes kept for a viewer or a save. `diskBytes`:
 * attachment bytes the iPhone keeps on disk across launches (attachments never change); a response
 * over 5% of it is not kept.
 */
export const IMAGE_CACHE = {
  mac: { decodedBytes: 64 * MIB, encodedBytes: 32 * MIB },
  web: { decodedBytes: 64 * MIB, encodedBytes: 32 * MIB },
  phone: { decodedBytes: 32 * MIB, encodedBytes: 16 * MIB, diskBytes: 256 * MIB },
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
 * Operational ceilings for terminal connections, idle resource reclamation and protocol 4 framing
 * (docs/TERMINAL-SOTA.md).
 */
export const TERMINAL_BUDGET = {
  /** Detach the control client of an ordinary shell with no viewer or observer after this idle spell. */
  idleDetachMs: 60_000,
  /** Protocol 4 application-level WebSocket ping interval and pong timeout. */
  heartbeatMs: 15_000,
  heartbeatTimeoutMs: 10_000,
  /** Maximum inactive terminal instances kept alive across tab switches on desktop clients. */
  keepAliveLimit: 6,
  /** Minimum snapshot byte size before protocol 4 applies raw deflate compression. */
  compressMinBytes: 4 * KIB,
  /** Maximum uncompressed snapshot size accepted when inflating a protocol 4 deflate frame. */
  snapshotInflateMaxBytes: 32 * MIB,
  /** Maximum unterminated escape sequence buffered by `OuterTerminalState` before resetting. */
  protocolStatePendingBytes: 4 * KIB,
} as const;

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
  /** Bytes of a plugin event's payload (serialized JSON); a larger one is refused, not cut. */
  pluginEventBytes: 16 * KIB,
  /** Characters of an event's key, which names it for deduplication. */
  pluginEventKeyChars: 128,
  /** Queued or running runs of one delegation past which a plugin event is dropped (events are not kept for later). */
  pluginEventBacklog: 20,
  /** Files and bytes of a plugin's capability pack. */
  packFiles: 200,
  packBytes: 2 * MIB,
  /** Largest file of its `files/` folder handed out; a bigger one is listed but not served. */
  servedFileBytes: 50 * MIB,
} as const;

/** What session references (`@` another conversation) capture from their sources (docs/guide/performance.md §2). */
export const SESSION_REFERENCE_BUDGET = {
  /** References one message may carry. */
  references: 5,
  /** Messages one reference captures, and the largest single one. */
  messages: 20_000,
  messageBytes: 1 * MIB,
  /** Captured text of one reference, its serialized snapshot, and all references of one send together. */
  bytes: 8 * MIB,
  snapshotBytes: 12 * MIB,
  totalBytes: 16 * MIB,
  /** Journal bytes and rows one capture scans before giving up. */
  scanBytes: 64 * MIB,
  scanRows: 100_000,
  /** Tool-call events: the largest one summarized, and the total scanned per capture. */
  toolEventBytes: 256 * KIB,
  toolScanBytes: 16 * MIB,
  timeoutMs: 10_000,
  excerptTokens: 600,
} as const;

/** Workbench query pages and the owner's window to confirm an instance setting proposal. */
export const ASSISTANT_QUERY_BUDGET = { pageItems: 50, settingConfirmationMs: 5 * 60_000 } as const;

/** The server's own budgets. */
export const SERVER_BUDGET = {
  /** Timeline rows of a session idle this long, and not held open, are dropped; they refold from the journal on open. */
  coldTimelineDays: 7,
  /** Exited unreferenced terminal records older than this (days) are pruned during periodic maintenance. */
  exitedTerminalRetentionDays: 7,
  /** Folded lanes kept hot in memory by `TimelineService`; older idle lanes refold their open turn on demand. */
  timelineHotLanes: 16,
  /** Bounded LRU cap for subagent summaries and file-change digests cached in `TimelineService`. */
  timelineSummaryEntries: 256,
  /** Idle duration (ms) with no live streams, terminals or running turns before server caches & SQLite memory trim. */
  idleTrimMs: 5 * 60_000,
  /** Idle duration (ms) before the one-shot command worker (`exec.ts`) exits to free its V8 isolate. */
  execWorkerIdleMs: 120_000,
  /** Largest single native transcript a background job (usage backfill) reads; larger ones are skipped. */
  backgroundReadBytes: 32 * MIB,
  /** Native transcripts kept parsed in memory for reuse, counted by file size. */
  parsedTranscriptBytes: 64 * MIB,
  /** Largest Claude Code transcript a native fork copies; a larger one is not forked natively. */
  forkTranscriptBytes: 64 * MIB,
  /** An event-loop block this long is a defect: it is logged and profiled (`loop-health.ts`). */
  loopBlockMs: 200,
  /** A starting server that logs nothing new for this long is reported as stuck by the launching CLI, which leaves it running. */
  startupStallMs: 60_000,
} as const;

/** Total host RAM ceiling (bytes) at or below which `--profile=auto` selects the low-footprint `lite` profile. */
export const SERVER_PROFILE_AUTO_RAM_BYTES = 4 * 1024 * MIB;

/**
 * Per-profile server memory & cache ceilings (`full` hub vs `lite` low-footprint peer node).
 * All values are integers so `pnpm gen:budgets` exports them cleanly across platforms.
 */
export const SERVER_PROFILE_BUDGET = {
  full: {
    controlCacheBytes: 16 * MIB,
    journalCacheBytes: 32 * MIB,
    derivedCacheBytes: 16 * MIB,
    controlMmapBytes: 32 * MIB,
    journalMmapBytes: 64 * MIB,
    derivedMmapBytes: 32 * MIB,
    timelineHotLanes: 16,
    timelineSummaryEntries: 256,
    expandedRowCacheEntries: 64,
    expandedRowCacheBytes: 16 * MIB,
    parsedTranscriptBytes: 64 * MIB,
    execWorkerIdleMs: 120_000,
    walWorkerIdleMs: 120_000,
    idleTrimMs: 5 * 60_000,
    managedSoftLimitBytes: 384 * MIB,
    steadyFootprintBytes: 512 * MIB,
    v8MaxOldSpaceMb: 0,
  },
  lite: {
    controlCacheBytes: 4 * MIB,
    journalCacheBytes: 6 * MIB,
    derivedCacheBytes: 2 * MIB,
    controlMmapBytes: 0,
    journalMmapBytes: 0,
    derivedMmapBytes: 0,
    timelineHotLanes: 4,
    timelineSummaryEntries: 32,
    expandedRowCacheEntries: 16,
    expandedRowCacheBytes: 4 * MIB,
    parsedTranscriptBytes: 16 * MIB,
    execWorkerIdleMs: 15_000,
    walWorkerIdleMs: 0,
    idleTrimMs: 2 * 60_000,
    managedSoftLimitBytes: 128 * MIB,
    steadyFootprintBytes: 160 * MIB,
    v8MaxOldSpaceMb: 192,
  },
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

/** Shared decoded-message cache and idle SQLite handle lifetime across Cursor `ChatReader` instances. */
export const CURSOR_CHAT_CACHE_BUDGET = {
  maxEntries: 512,
  maxBytes: 16 * MIB,
  /** Close a shared read-only `store.db` handle after this long without reads even if a caller did not close it. */
  idleDbCloseMs: 60_000,
  /** SQLite page cache ceiling (KiB) per shared Cursor `store.db` handle. */
  dbCacheKiB: 2_048,
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

/** Approvals plugins put in the inbox (`host.approvals`, docs/TASK-BOARD.md §7). */
export const PLUGIN_APPROVAL_BUDGET = {
  /** Open at once per plugin; a further request throws until one is decided, withdrawn or expires. */
  openPerPlugin: 20,
  /** Buttons on one approval. */
  actions: 4,
  idChars: 128,
  titleChars: 200,
  bodyChars: 4_000,
  labelChars: 40,
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

/** Structured data queries from an isolated plugin view (docs/PLUGINS.md). */
export const PLUGIN_QUERY_BUDGET = {
  requestBytes: 64 * KIB,
  resultBytes: MIB,
  timeoutMs: 30_000,
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
/** One conversation's Agent calling another (docs/AGENT-CALLS.md). */
export const AGENT_CALL_BUDGET = {
  /** Agents one message may @-mention. */
  mentions: 3,
  /** How long `agent_call` and `agent_wait` wait for the turn by default, and at most: under the shim's 330 s and Codex's `tool_timeout_sec`. */
  waitDefaultSeconds: 60,
  waitMaxSeconds: 300,
  /** Calls of one conversation running at once. */
  activePerCaller: 3,
  /** Calls and follow-ups one turn of the caller may make. */
  callsPerCallerTurn: 8,
  /** Turns one call may take before the caller has to start another. */
  turnsPerCall: 20,
  /** Longest request a caller may send. */
  promptChars: 100_000,
  /** Longest answer handed back; the rest stays in the called conversation. */
  answerChars: 24_000,
  /** How long `agent_list` waits on one provider's model list or quota before leaving it out. */
  readMs: 5_000,
  /** The line a call card shows of the work in progress. */
  latestChars: 240,
  /** How often a client asks for its calls while one of them is running and shown. */
  cardPollMs: 2_000,
} as const;

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

/** Outlines plugin views declare as their icon (`VIEW_ICON_ROUTE`), as the web client keeps them. */
export const PLUGIN_VIEW_ICON_BUDGET = {
  /** Views whose outline is kept, in memory and in local storage. */
  entries: 64,
  /** Shapes taken from one outline; a file with more is drawn with the fallback glyph. */
  shapes: 64,
} as const;

/** Server links (docs/SERVER-LINKS.md §6). */
export const LINK_BUDGET = {
  /** A link string is accepted this long after it was made, once. */
  inviteTtlMs: 5 * 60_000,
  /** Link strings waiting to be used at once; the oldest is dropped beyond this. */
  pendingInvites: 8,
  /** A tunnel's TLS handshake and its first control exchange must finish within this. */
  handshakeMs: 10_000,
  /** Tunnels not yet tied to a link (a handshake, or a join in progress) open at once; more are closed at once. */
  pendingTunnels: 16,
  /** HTTP/2 ping on each live tunnel; this many unanswered in a row drop it. */
  pingMs: 15_000,
  missedPings: 3,
  /** The dialing side retries a dropped tunnel with exponential backoff between these. */
  reconnectMinMs: 1_000,
  reconnectMaxMs: 60_000,
  /**
   * HTTP/2 session memory per tunnel, in megabytes. Node's default of 10 resets a stream while a large upload is in
   * flight (measured in `scripts/probe-link-tunnel.ts`); this covers the 36 MB request body limit with room.
   */
  sessionMemoryMb: 64,
  /** A forwarded WebSocket message, either way; a session stream frame stays far below it. */
  relayMessageBytes: 64 * 1024 * 1024,
  /** Messages a browser sends before the peer has answered the upgrade. */
  relayPendingBytes: 4 * 1024 * 1024,
  /** One tunnel WebSocket frame; each write is split below the receiving server's 256 KB payload limit. */
  tunnelFrameBytes: 128 * 1024,
  /** What the dialing side accepts from the tunnel WebSocket in one message. */
  tunnelMessageBytes: 4 * 1024 * 1024,
  /** Bytes a relayed WebSocket may have waiting for a slow receiver; past it the relay closes with 1013, as the terminal socket does. */
  relayBufferBytes: 8 * 1024 * 1024,
  /** A control request inside the tunnel (hello, join, state, remove). */
  controlBytes: 64 * 1024,
  /** Forwarded connections open on one tunnel at once; more are refused with 503. */
  maxStreams: 256,
  /** A control request inside the tunnel (hello, state, remove) gives up after this. */
  controlMs: 10_000,
  /** Entries of the record of what a peer did here, per link; the oldest is dropped beyond this. */
  auditEntries: 200,
  /** A peer's name, as it reports it. */
  nameChars: 64,
  /** A server's short local alias (`^[a-z0-9][a-z0-9._-]{0,31}$`) for CLI and multi-server labels. */
  aliasChars: 32,
  /** A one-line local note describing what a linked server is for. */
  noteChars: 120,
  /** Maximum characters of one command sent to `POST /api/remote/exec`. */
  execCommandChars: 16_384,
  /** Default and maximum wall-clock timeout for `POST /api/remote/exec`. */
  execTimeoutDefaultMs: 60_000,
  execTimeoutMaxMs: 10 * 60_000,
  /** Combined stdout + stderr byte cap returned by `POST /api/remote/exec`; output past it is truncated. */
  execOutputBytes: 256 * 1024,
  /** Concurrent remote commands / interactive shells allowed on one server at once. */
  execConcurrent: 8,
  /** 设置 › 互联 rereads the links this often while it is open, to show a tunnel coming up or dropping. */
  settingsPollMs: 5_000,
  /**
   * On opening the workbench, how long the lists wait for a linked server of which nothing is kept yet, so a link to
   * one of its conversations can open; a slower server's lists arrive later.
   */
  firstListWaitMs: 3_000,
  /** A search across linked servers stops waiting for one that has not answered by then; the others' results stand. */
  searchWaitMs: 8_000,
} as const;

/** TLS on the server's own port (docs/TRANSPORT-SECURITY.md §3). */
export const TRANSPORT_BUDGET = {
  /** A new connection must send its first byte, and a TLS one finish its handshake, within this. */
  handshakeMs: 10_000,
} as const;

/** A browser's sign-in (docs/TRANSPORT-SECURITY.md §4). */
export const SESSION_COOKIE_BUDGET = {
  /** Over an encrypted connection. */
  secureMaxAgeSeconds: 30 * 24 * 60 * 60,
  /** Over plain HTTP from another machine, where the cookie can be copied off the network: it stops working sooner. */
  insecureMaxAgeSeconds: 24 * 60 * 60,
} as const;

/** The security record (docs/TRANSPORT-SECURITY.md §7), kept in `security-audit.jsonl` in the state directory. */
export const SECURITY_AUDIT_BUDGET = {
  /** Entries kept; past it the oldest drop when the file is next compacted. */
  entries: 2_000,
  /** The file is rewritten down to `entries` once it holds this many lines. */
  compactAt: 2_500,
  /** Entries one read returns. */
  pageEntries: 200,
  /** The same refusal (address, capability, route) is recorded once in this window. */
  repeatWindowMs: 60_000,
  /** Refusals remembered for `repeatWindowMs`; the oldest is forgotten beyond this. */
  repeatKeys: 512,
  /** A recorded command or value is cut to this many characters. */
  detailChars: 300,
} as const;

/** The session trace view (docs/TRACE.md): journal rows read as an index, and one row's whole payload on demand. */
export const TRACE_BUDGET = {
  /** Index rows one request answers by default, and at most. */
  pageRows: 2_000,
  maxPageRows: 5_000,
  /** Characters of the one-line text an index row carries; the rest is read with the row. */
  previewChars: 160,
  /** Largest payload one row read answers parsed; past it the payload is the head of its text, marked truncated. */
  detailBytes: 4 * MIB,
  /** Model requests the summary lists, newest first past this. */
  usageSteps: 5_000,
  /** Index rows a web view keeps for one lane; it stops reading at this and says so. */
  webRows: 120_000,
  /** Whole payloads a web view keeps for reopening, by count and by their JSON size. */
  webDetailEntries: 64,
  webDetailBytes: 24 * MIB,
  /** How often a view of a running conversation reads the rows written since its last read. */
  livePollMs: 2_000,
  /** Model requests one requests read lists for a lane, the newest kept past it. */
  requestRecords: 20_000,
  /** Distinct prompts (system and tools) one requests read keeps, the newest past it. */
  requestPrompts: 64,
  /** Characters of one injected message or system block; the rest is cut and marked. */
  requestTextChars: 256 * 1024,
  /** Characters of injected messages one requests read carries in all, the newest first; older ones keep their label only. */
  requestContextChars: 4 * 1024 * 1024,
  /** Largest stored transcript the requests read parses; a larger one answers `tooLarge`. */
  requestFileBytes: 1024 * MIB,
} as const;

/** The code index of a project's declarations (`apps/server/src/workspace/symbols/`). */
export const CODE_INDEX_BUDGET = {
  /** Child processes that parse and write files while an index is built; each holds the grammars and one file's tree. */
  workers: 4,
  /** Files handed to a worker at once: it compares them with the index, parses what changed and writes it in one transaction. */
  batchFiles: 200,
  /** Files larger than this are listed but not parsed: generated code, not something to navigate. */
  fileBytes: 1 * MIB,
  /** Most source files one project's index covers; past it the rest are left out and the status says so. */
  maxFiles: 600_000,
  /** Indexes kept open at once; the least recently used one is closed past it. */
  openIndexes: 3,
  /** An open index nobody asked anything of for this long is closed, and its workers stopped. */
  idleCloseMs: 10 * 60_000,
  /** A watched index compares the project's files with itself again after this long: a pass stats every source file. */
  recheckMs: 5 * 60_000,
  /** A build or check runs only while a page watches the index: one watch keeps it going this long, and a build nobody renews is stopped. */
  watchMs: 15_000,
  /** Results of one symbol search, by default and at most. */
  searchResults: 50,
  maxSearchResults: 200,
  /** Declarations one outline returns. */
  outlineItems: 2_000,
  /** The worker that parses single files for outlines is stopped after this long without one. */
  outlineIdleMs: 60_000,
  /** Rows one search tier (exact, prefix, initials, contains) reads before ranking; the rest of a very common name is not considered. */
  candidateRows: 5_000,
  /** Declarations of one name that definition lookup considers. */
  definitionRows: 200,
  /** Files a member reference search reads at most when the word index names its candidates; a word in more files than this is searched with ripgrep instead. */
  referenceFiles: 20_000,
  /** Files changed since the last check that an index answer may add to its candidates (git diff against the checked commit, files dirty then, untracked files); more than this and the index is not trusted for that answer. */
  changedFiles: 2_000,
  /** `git diff` of the working tree against the index is given this long; on a timeout the answer is not narrowed by the index. */
  changedGitMs: 1_500,
  /** Comparing git's index with the checked commit walks every tracked file (a second on a monorepo) and only changes when the index does: it is redone, with this long, when the index file changed. */
  changedIndexMs: 15_000,
  /** Most output read from a `git diff` listing changed files; past it the list is not available. */
  changedListBytes: 16 * MIB,
  /** The changed-file list of a project is reused for this long. */
  changedTtlMs: 2_000,
  /** Files a worker parses before it is replaced, so its WebAssembly heap does not keep what a large index once needed. */
  workerRecycleFiles: 10_000,
} as const;

/** Read-only Git lookups for the code viewer (`apps/server/src/git/read.ts`): HEAD, a file at a commit, blame. */
export const GIT_READ_BUDGET = {
  /** `git rev-parse` and `symbolic-ref` for the head. */
  headMs: 10_000,
  /** One `cat-file` of a file at a commit; text past `FILE_BUDGET.previewTextBytes` is cut. */
  fileMs: 20_000,
  /** One `git blame` is killed past this; the request fails with `GIT_TIMEOUT` (a window of lines takes seconds on a monorepo, a whole file over a minute). */
  blameMs: 30_000,
  /** Lines one blame covers; a longer range is cut to this many from its start. */
  blameMaxLines: 400,
  /** Most output one blame is read for. */
  blameOutputBytes: 8 * MIB,
  /** Blames of one repository run one at a time; this many may wait behind the running one, a further request is refused. */
  blameWaiting: 8,
  /** Blame answers kept for scrolling back, by count and by size; the least recently used goes first, and an entry unused for `blameCacheTtlMs` is dropped. */
  blameCacheEntries: 64,
  blameCacheBytes: 2 * MIB,
  blameCacheTtlMs: 10 * 60_000,
} as const;

/** Team members and shared owner profile limits (docs/TEAM.md §8.2). */
export const TEAM_BUDGET = {
  /** Maximum active (non-archived) members per server. */
  maxMembers: 24,
  /** Soft/enforced character cap on the cross-member global USER.md profile. */
  globalUserProfileChars: 1_000,
  /** Maximum background runs active across all members at once. */
  concurrentRuns: 3,
  /** Maximum concurrent background runs for a single member. */
  memberConcurrentRuns: 1,
  /** Default 24-hour background run cap per member. */
  defaultDailyRuns: 30,
  /** Highest 24-hour background run cap a member may be configured to. */
  maxDailyRuns: 200,
} as const;

/** Model Chat (direct LLM workbench) limits (docs/QUICK-CHAT.md). */
export const MODEL_CHAT_BUDGET = {
  /** Maximum models dispatched in parallel for a single compare turn. */
  maxCompareModels: 3,
  /** Maximum serialized bytes for one redacted Wire request snapshot stored in session blobs. */
  maxWireBytes: 512 * KIB,
  /** Maximum pinned read-only context documents per Model Chat session. */
  maxPinnedDocs: 16,
  /** Maximum characters kept per pinned read-only context document. */
  maxPinnedDocChars: 200_000,
  /** Maximum characters kept in a manually edited or generated conversation summary. */
  maxSummaryChars: 16_000,
  /** Maximum buffered bytes on a Model Chat SSE response before dropping slow subscribers. */
  streamBackpressureBytes: 4 * MIB,
  /** Heartbeat interval for a Model Chat SSE stream. */
  streamHeartbeatMs: 15_000,
} as const;

/** Session outputs aggregation & per-file snapshot ledger limits (docs/SESSION-OUTPUTS.md). */
export const OUTPUT_BUDGET = {
  /** Largest single file body persisted into session_blobs for exact net-diff & snapshot viewing. */
  snapshotMaxFileBytes: 2 * MIB,
  /** Cumulative snapshot blob bytes per session (full profile) before falling back to stats-only. */
  sessionSnapshotTotalBytes: 32 * MIB,
  /** Cumulative snapshot blob bytes per session (lite profile). */
  liteSessionSnapshotTotalBytes: 8 * MIB,
  /** Maximum output file entries carried in Sync v3 `hello.outputs` and `outputs` frames. */
  maxOutputs: 500,
  /** Bounded LRU cache entries for `(preHash, postHash)` net line-diff stats (full profile). */
  diffCacheEntries: 256,
  /** Bounded LRU cache entries for `(preHash, postHash)` net line-diff stats (lite profile). */
  liteDiffCacheEntries: 64,
  /** Maximum changed files captured per shell command in `WorkspaceObserver`. */
  maxObservedFiles: 200,
} as const;
