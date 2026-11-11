package riffet.shared

import kotlin.concurrent.Volatile
import kotlin.time.TimeSource

/**
 * Phase timings for the host's performance monitor (the Mac's `PerfStore`). Nothing is timed while
 * [sink] is null, which is always, unless the monitor is recording.
 */
object ClientPerf {
    /** Receives a phase name and its milliseconds, from any thread. */
    @Volatile
    var sink: ((String, Double) -> Unit)? = null

    inline fun <T> measure(name: String, block: () -> T): T {
        val sink = sink ?: return block()
        val mark = TimeSource.Monotonic.markNow()
        try {
            return block()
        } finally {
            sink(name, mark.elapsedNow().inWholeMicroseconds / 1000.0)
        }
    }
}
