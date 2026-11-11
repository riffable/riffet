package riffet.ui.timeline

import platform.Foundation.NSDate
import platform.Foundation.NSTimeZone
import platform.Foundation.dateWithTimeIntervalSince1970
import platform.Foundation.localTimeZone
import platform.Foundation.timeIntervalSince1970

/*
 * Shared by iOS and macOS. Compiled by the macOS framework build; the iOS app (P4) uses the same
 * Foundation calls.
 */

actual fun platformNowMillis(): Long = (NSDate().timeIntervalSince1970 * 1000.0).toLong()

actual fun platformUtcOffsetMillis(epochMillis: Long): Long {
    val date = NSDate.dateWithTimeIntervalSince1970(epochMillis.toDouble() / 1000.0)
    return NSTimeZone.localTimeZone.secondsFromGMTForDate(date).toLong() * 1000L
}

/** `NSTimeZone.name` is the IANA identifier, the same string `TimeZone.getID()` returns on Android. */
actual fun platformTimeZoneId(): String = NSTimeZone.localTimeZone.name
