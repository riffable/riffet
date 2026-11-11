package riffet.ui.composer

import kotlin.random.Random
import riffet.ui.timeline.platformNowMillis

/*
 * Client-side identity and time for optimistic state.
 *
 * `commandId` (send) and `requestId` (interaction) only have to be unique and short: the server
 * validates both as a non-empty string of at most 100/200 characters, and treats a repeated value
 * as a retry of the *same* command, which is exactly the idempotency contract the outbox relies on.
 * `kotlin.uuid.Uuid` is still behind an experimental opt-in on this Kotlin version, so a
 * time-plus-random value is used instead — it is not a security token, and does not need to be.
 */

private var counter = 0

/** A fresh idempotency key. Never reuse one for a different request. */
fun newClientId(): String {
    val random = Random.nextLong().toULong().toString(16).padStart(16, '0')
    val sequence = (++counter) and 0xffff
    return "${platformNowMillis().toString(16)}-$sequence-$random"
}

/**
 * An ISO-8601 UTC stamp, matching the shape the server writes, so an optimistic run's `createdAt`
 * sorts correctly against the server's own runs.
 */
fun isoUtcNow(): String = isoUtc(platformNowMillis())

fun isoUtc(epochMillis: Long): String {
    val seconds = epochMillis / 1000
    var days = seconds / 86_400
    var remainder = seconds % 86_400
    if (remainder < 0) {
        remainder += 86_400
        days -= 1
    }
    val (year, month, day) = civilFromDays(days)
    val hour = remainder / 3600
    val minute = (remainder % 3600) / 60
    val second = remainder % 60
    return buildString {
        append(year.toString().padStart(4, '0'))
        append('-')
        append(month.toString().padStart(2, '0'))
        append('-')
        append(day.toString().padStart(2, '0'))
        append('T')
        append(hour.toString().padStart(2, '0'))
        append(':')
        append(minute.toString().padStart(2, '0'))
        append(':')
        append(second.toString().padStart(2, '0'))
        append(".000Z")
    }
}

/** Days since the Unix epoch to a civil date (Howard Hinnant's `civil_from_days`). */
private fun civilFromDays(days: Long): Triple<Long, Int, Int> {
    val shifted = days + 719_468
    val era = (if (shifted >= 0) shifted else shifted - 146_096) / 146_097
    val dayOfEra = shifted - era * 146_097
    val yearOfEra = (dayOfEra - dayOfEra / 1460 + dayOfEra / 36_524 - dayOfEra / 146_096) / 365
    val year = yearOfEra + era * 400
    val dayOfYear = dayOfEra - (365 * yearOfEra + yearOfEra / 4 - yearOfEra / 100)
    val monthPrime = (5 * dayOfYear + 2) / 153
    val day = dayOfYear - (153 * monthPrime + 2) / 5 + 1
    val month = if (monthPrime < 10) monthPrime + 3 else monthPrime - 9
    return Triple(if (month <= 2) year + 1 else year, month.toInt(), day.toInt())
}
