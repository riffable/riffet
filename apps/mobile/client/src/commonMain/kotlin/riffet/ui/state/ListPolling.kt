package riffet.ui.state

/**
 * How often a host in front re-reads the session list; the same rule for Android and iPhone.
 *
 * While the lists stream is live ([SessionStore.listsPushed]) the server pushes every change and the
 * read is only a fallback at [STREAM_COVERED_MILLIS]. Without it, the open session's stream carries that
 * session's `session` frames, so while it is live and no *other* conversation is mid-turn the read
 * runs at [STREAM_COVERED_MILLIS] as well. A conversation elsewhere that is running or waiting keeps the
 * short interval: its finish is news the reader should not wait half a minute for. Failed reads back
 * off exponentially up to [MAX_BACKOFF_MILLIS]; a poke (back in front, network restored) still reads
 * at once.
 */
object ListPolling {
    const val FOREGROUND_MILLIS = 5_000L
    const val STREAM_COVERED_MILLIS = 30_000L
    const val MAX_BACKOFF_MILLIS = 60_000L

    /** The wait before the next foreground read, after [failures] consecutive failed reads. */
    fun foregroundDelay(store: SessionStore, failures: Int): Long {
        val open = store.selected.value?.id
        if (store.listsPushed.value) return backoff(STREAM_COVERED_MILLIS, failures)
        val covered = store.connection.value == RiffetConnectionState.Live &&
            store.list.value.sessions.none { it.id != open && it.archivedAt == null && it.state.active }
        return backoff(if (covered) STREAM_COVERED_MILLIS else FOREGROUND_MILLIS, failures)
    }

    /** [interval] for a host that is away, at least [STREAM_COVERED_MILLIS] while the lists stream is live. */
    fun backgroundDelay(store: SessionStore, interval: Long): Long =
        if (store.listsPushed.value) maxOf(interval, STREAM_COVERED_MILLIS) else interval

    /** [base] doubled per consecutive failure, capped at [MAX_BACKOFF_MILLIS]. */
    fun backoff(base: Long, failures: Int): Long {
        if (failures <= 0) return base
        return (base shl failures.coerceAtMost(6)).coerceAtMost(maxOf(base, MAX_BACKOFF_MILLIS))
    }
}
