package riffet.shared

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.IO
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import riffet.cache.LocalFiles
import riffet.cache.createLogFiles
import riffet.ui.timeline.formatDateTime
import riffet.ui.timeline.platformNowMillis
import riffet.ui.timeline.platformUtcOffsetMillis

/**
 * The app's own log: what the stream, the store and the screen did, with millisecond times, kept
 * on the device so it can be exported from 设置 and read off the phone.
 *
 * [log] only queues the line, from any thread; a writer coroutine appends batches to
 * `logs/current.log` under the app's private directory and rolls it over to `logs/previous.log`
 * past [ROLL_BYTES], so two files bound the space it takes.
 */
object AppLog {
    private val queue = Channel<String>(Channel.UNLIMITED)

    /**
     * "Lines are waiting". The writer never takes a line out of [queue] before it holds [fileLock],
     * so an export or a clear always sees every line logged before it.
     */
    private val pending = Channel<Unit>(Channel.CONFLATED)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val fileLock = Mutex()
    private val files: LocalFiles by lazy { createLogFiles() }
    private val writer by lazy { scope.launch { drain() } }

    /**
     * Whether per-frame lines (each stream frame received and handled) are written. Off by default:
     * a streaming turn delivers many frames a second, and two lines per frame cost more than the
     * frame itself. Connection, send and failure lines are always written.
     */
    var frameLogging: Boolean = false

    /** A per-frame line, built only when [frameLogging] is on. */
    inline fun detail(tag: String, message: () -> String) {
        if (frameLogging) log(tag, message())
    }

    fun log(tag: String, message: String) {
        val now = platformNowMillis()
        queue.trySend("${timestamp(now)} [$tag] $message\n")
        pending.trySend(Unit)
        writer
    }

    /** Both files, oldest line first, with everything queued so far written out. */
    suspend fun export(): String = withContext(Dispatchers.IO) {
        fileLock.withLock {
            flushQueued()
            (files.read(PREVIOUS).orEmpty() + files.read(CURRENT).orEmpty())
        }
    }

    suspend fun clear() = withContext(Dispatchers.IO) {
        fileLock.withLock {
            while (queue.tryReceive().isSuccess) Unit
            files.delete(PREVIOUS)
            files.delete(CURRENT)
        }
    }

    private suspend fun drain() {
        while (true) {
            pending.receive()
            // A burst of frames becomes one append rather than one file write per line.
            delay(BATCH_MILLIS)
            fileLock.withLock { flushQueued() }
        }
    }

    private fun flushQueued() {
        val batch = StringBuilder()
        while (true) batch.append(queue.tryReceive().getOrNull() ?: break)
        if (batch.isNotEmpty()) write(batch.toString())
    }

    private fun write(text: String) {
        runCatching {
            files.append(CURRENT, text)
            if (files.size(CURRENT) > ROLL_BYTES) {
                files.write(PREVIOUS, files.read(CURRENT).orEmpty())
                files.delete(CURRENT)
            }
        }
    }

    /** A file name for an export made now, e.g. `riffet-log-10-6_1612-05.txt`. */
    fun exportName(): String {
        val now = platformNowMillis()
        val day = formatDateTime(now, platformUtcOffsetMillis(now)).replace('/', '-').replace(' ', '_').replace(":", "")
        return "riffet-log-$day-${timestamp(now).substring(6, 8)}.txt"
    }

    private fun timestamp(epochMillis: Long): String {
        val local = epochMillis + platformUtcOffsetMillis(epochMillis)
        val withinDay = ((local % DAY_MILLIS) + DAY_MILLIS) % DAY_MILLIS
        fun two(value: Long) = value.toString().padStart(2, '0')
        return "${two(withinDay / 3_600_000)}:${two(withinDay / 60_000 % 60)}:${two(withinDay / 1_000 % 60)}." +
            (withinDay % 1_000).toString().padStart(3, '0')
    }

    private const val CURRENT = "logs/current.log"
    private const val PREVIOUS = "logs/previous.log"
    private const val ROLL_BYTES = 2L * 1024 * 1024
    private const val BATCH_MILLIS = 300L
    private const val DAY_MILLIS = 86_400_000L
}

