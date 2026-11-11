package riffet.ui.state

/**
 * Trace sections around opening a session, for Perfetto / System Tracing on Android (names start
 * with `riffet.`); a no-op on every other platform. Keep them few: each one is on the open path.
 */
expect fun traceBegin(name: String)

expect fun traceEnd()

/** A span that may cross threads or suspensions, told apart from its siblings by [cookie]. */
expect fun traceAsyncBegin(name: String, cookie: Int)

expect fun traceAsyncEnd(name: String, cookie: Int)

/**
 * Whether composables log being created and disposed (see `TraceLifecycle`), for finding UI that
 * remounts when it should only recompose. Off unless a debugging host turns it on; read once.
 */
expect fun lifecycleTraceEnabled(): Boolean

expect fun lifecycleTrace(message: String)

inline fun <T> traced(name: String, block: () -> T): T {
    traceBegin(name)
    try {
        return block()
    } finally {
        traceEnd()
    }
}

/**
 * `riffet.open`: from opening a session to its first rows on screen. Begun by the store, ended by
 * the screen's first frame that draws rows; main thread only.
 */
object OpenTrace {
    private var open = false

    fun begin() {
        end()
        traceAsyncBegin(OPEN_SECTION, 0)
        open = true
    }

    fun end() {
        if (!open) return
        open = false
        traceAsyncEnd(OPEN_SECTION, 0)
    }
}

private const val OPEN_SECTION = "riffet.open"
