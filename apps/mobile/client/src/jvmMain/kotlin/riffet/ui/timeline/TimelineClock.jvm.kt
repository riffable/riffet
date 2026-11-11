package riffet.ui.timeline

import java.util.TimeZone

/** `System.currentTimeMillis()` and the JVM's own zone database. */
actual fun platformNowMillis(): Long = System.currentTimeMillis()

actual fun platformUtcOffsetMillis(epochMillis: Long): Long =
    TimeZone.getDefault().getOffset(epochMillis).toLong()

actual fun platformTimeZoneId(): String = TimeZone.getDefault().id
