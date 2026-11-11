package riffet.ui.timeline

import java.util.TimeZone

/**
 * Android reads the same JVM classes as the `jvm()` target. No `android.*` import is needed, so
 * this stays a plain Java-platform actual rather than an Android API.
 */
actual fun platformNowMillis(): Long = System.currentTimeMillis()

actual fun platformUtcOffsetMillis(epochMillis: Long): Long =
    TimeZone.getDefault().getOffset(epochMillis).toLong()

actual fun platformTimeZoneId(): String = TimeZone.getDefault().id
