package riffet.cache

import riffet.contracts.LANE_WINDOW_MAC_BYTES
import riffet.contracts.LANE_WINDOW_MAC_ROWS
import riffet.contracts.LANE_WINDOW_PHONE_BYTES
import riffet.contracts.LANE_WINDOW_PHONE_ROWS

/**
 * How much of one lane a client holds, in memory and on the device (docs/SYNC-V3.md, 预算): past
 * either cap the rows farthest from the reader are let go, and the server pages them back. The
 * request sizes are null for the server's defaults.
 */
data class SyncWindow(
    val rows: Int,
    val bytes: Long,
    val snapshotRows: Int? = null,
    val snapshotBytes: Long? = null,
    val pageRows: Int? = null,
    val pageBytes: Long? = null,
) {
    companion object {
        /** A Mac shows long conversations whole, and asks for larger snapshots and pages. */
        val MAC = SyncWindow(
            rows = LANE_WINDOW_MAC_ROWS,
            bytes = LANE_WINDOW_MAC_BYTES,
            snapshotRows = 600,
            snapshotBytes = 1L * MIB,
            pageRows = 200,
            pageBytes = 512L * KIB,
        )

        val PHONE = SyncWindow(rows = LANE_WINDOW_PHONE_ROWS, bytes = LANE_WINDOW_PHONE_BYTES)
    }
}

/** This platform's [SyncWindow]: [SyncWindow.MAC] on macOS and the desktop JVM, [SyncWindow.PHONE] on a phone. */
internal expect val platformSyncWindow: SyncWindow

private const val KIB = 1024L
private const val MIB = 1024L * KIB
