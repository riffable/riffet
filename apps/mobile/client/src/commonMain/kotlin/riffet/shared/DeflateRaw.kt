package riffet.shared

import riffet.contracts.TERMINAL_BUDGET_SNAPSHOT_INFLATE_MAX_BYTES

/** Maximum uncompressed snapshot size accepted over protocol 4 (guards against corrupted deflate payloads). */
internal val MAX_INFLATE_BYTES: Int = TERMINAL_BUDGET_SNAPSHOT_INFLATE_MAX_BYTES.toInt()

/** Decompresses an RFC 1951 raw DEFLATE payload, or returns null if corrupted or oversized. */
internal expect fun inflateRaw(data: ByteArray): ByteArray?
