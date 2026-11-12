/** Events a runtime keeps in memory; everything older is read from the journal when a page asks for it. */
export const RESIDENT_EVENTS = 1_000;
export const MAX_EVENTS = RESIDENT_EVENTS;
/** Turns a routine read asks for once the journal holds the thread; the rest of the history is already logged. */
export const ROUTINE_TURNS = 3;
/** Settled turns fetched and committed per step of a background import. */
export const IMPORT_PAGE_TURNS = 3;
/**
 * Turns asked for by a routine history poll. Settled turns older than these are taken from the last
 * complete read of the same thread over the same connection; a reconnect, or a page that does not
 * reach back into that read, reads the whole thread again.
 */
export const TAIL_TURNS = 20;
export const TURN_CACHE_THREADS = 8;
/**
 * Bytes of a rollout's tail read for the context meter; one `token_count` line is a few hundred. A
 * megabyte is chosen so the read survives the usual tail of a session — a large tool result or a
 * long answer after the last usage line — since this happens once per thread.
 */
export const CONTEXT_TAIL_BYTES = 1024 * 1024;
/** How often a thread whose provider states no window may have its rollout re-read. */
export const CONTEXT_WINDOW_RETRY_MS = 15_000;
export const THREAD_MATERIALIZATION_GRACE_MS = 60_000;
/** History read cadence: while notifications cannot be trusted, and as a backstop while they can. */
export const HISTORY_POLL_MS = 1_500;
export const HISTORY_FALLBACK_POLL_MS = 10_000;
/** How long an answer waits for the provider to report its request settled before it is left unconfirmed. */
export const ANSWER_CONFIRM_MS = 4_000;
