package riffet.ui.timeline

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull
import riffet.contracts.NativeDeliveryState
import riffet.contracts.Run
import riffet.contracts.RunState
import riffet.i18n.L10n

/*
 * ============================================================================================
 * The transcript's formatting and untrusted-JSON readers
 * ============================================================================================
 *
 * `riffet.core` already has all of the readers below (`str`, `records`, `finiteNumber`,
 * `pixelEdge`, `parseMillis` in core/JsonUtils.kt) and this file deliberately reproduces their
 * contracts rather than inventing new ones:
 *
 *   - a string is absent when it is empty (`str`), never `""`;
 *   - a number is absent when it is a string, null, NaN or infinite (`finiteNumber`);
 *   - an unparseable instant is `null`, never a silently substituted epoch (`parseMillis`).
 *
 * They are duplicated because `core` declares them `internal`, and `internal` in Kotlin is
 * per-Gradle-module: `shared` is a different module, so it cannot call them. See the change report;
 * the clean fix is to publish them from `core` or to expose a small facade, which is not this
 * change's call to make.
 */

/** `str`: only a non-empty JSON string counts; numbers, booleans and null are absent. */
fun jsonText(value: JsonElement?): String? {
    val primitive = value as? JsonPrimitive ?: return null
    if (!primitive.isString) return null
    return primitive.content.takeIf { it.isNotEmpty() }
}

/** `finiteNumber(...).toLong()`: an integral JSON number, absent for strings and non-finite values. */
fun jsonLong(value: JsonElement?): Long? {
    val primitive = value as? JsonPrimitive ?: return null
    if (primitive is JsonNull || primitive.isString) return null
    val number = primitive.doubleOrNull ?: return null
    if (!number.isFinite()) return null
    return number.toLong()
}

/** `pixelEdge`: a usable pixel size, or absent. Values arrive already typed, so this only rejects. */
fun pixelEdge(value: Long?): Long? = value?.takeIf { it > 0 }

/* ---------------------------------------------------------------------------------------------
 * Instants
 *
 * The server writes ISO-8601 UTC stamps (`WorkbenchEvent.createdAt`, `Run.createdAt`, …). This
 * reader accepts exactly that shape plus an explicit numeric offset, and refuses everything else.
 *
 * Deliberately not a general date parser: a stamp it does not understand must render as *nothing*
 * rather than as some other day, which is the same rule `parseMillis` follows in `core`.
 * ------------------------------------------------------------------------------------------- */

private class Scanner(private val text: String) {
    var index = 0

    /** Between [min] and [max] ASCII digits, or null. Consumes what it reads only on success. */
    fun digits(min: Int, max: Int): Long? {
        val start = index
        while (index < text.length && text[index] in '0'..'9') index += 1
        val count = index - start
        if (count < min || count > max) {
            index = start
            return null
        }
        return text.substring(start, index).toLongOrNull()
    }

    fun take(char: Char): Boolean {
        if (index < text.length && text[index] == char) {
            index += 1
            return true
        }
        return false
    }

    fun peek(): Char? = text.getOrNull(index)

    fun atEnd(): Boolean = index == text.length
}

/**
 * `Date.parse` for the stamps this server writes: `YYYY-MM-DDTHH:MM:SS[.fff][Z|±HH:MM]`.
 *
 * Returns null for anything else — including a bare date, which has no instant.
 */
fun instantMillis(value: String?): Long? {
    if (value.isNullOrEmpty()) return null
    val scanner = Scanner(value)
    val year = scanner.digits(4, 4) ?: return null
    if (!scanner.take('-')) return null
    val month = scanner.digits(1, 2) ?: return null
    if (!scanner.take('-')) return null
    val day = scanner.digits(1, 2) ?: return null
    val separator = scanner.peek()
    if (separator != 'T' && separator != ' ') return null
    scanner.index += 1
    val hour = scanner.digits(1, 2) ?: return null
    if (!scanner.take(':')) return null
    val minute = scanner.digits(1, 2) ?: return null
    if (!scanner.take(':')) return null
    val second = scanner.digits(1, 2) ?: return null

    var millis = 0L
    if (scanner.peek() == '.') {
        scanner.index += 1
        val start = scanner.index
        while (scanner.index < value.length && value[scanner.index] in '0'..'9') scanner.index += 1
        if (scanner.index == start) return null
        val fraction = value.substring(start, minOf(start + 3, scanner.index)).padEnd(3, '0')
        millis = fraction.toLongOrNull() ?: return null
    }

    var offsetMinutes = 0L
    when (scanner.peek()) {
        'Z', 'z' -> scanner.index += 1
        '+', '-' -> {
            val sign = if (scanner.peek() == '-') -1L else 1L
            scanner.index += 1
            val offsetHours = scanner.digits(1, 2) ?: return null
            scanner.take(':')
            val offsetSeconds = scanner.digits(1, 2) ?: return null
            offsetMinutes = sign * (offsetHours * 60L + offsetSeconds)
        }
        else -> Unit
    }
    if (!scanner.atEnd()) return null

    if (month !in 1..12 || day !in 1..31 || hour > 23 || minute > 59 || second > 60) return null
    val days = daysFromCivil(year, month, day)
    val epoch = (days * 86_400L + hour * 3_600L + minute * 60L + second) * 1_000L + millis
    return epoch - offsetMinutes * 60_000L
}

/**
 * Days since 1970-01-01 for a proleptic-Gregorian date. Howard Hinnant's `days_from_civil`: exact
 * for every date this server can produce, with no leap-second table and no library.
 */
private fun daysFromCivil(year: Long, month: Long, day: Long): Long {
    val y = if (month <= 2) year - 1 else year
    val era = (if (y >= 0) y else y - 399) / 400
    val yearOfEra = y - era * 400
    val dayOfYear = (153 * (if (month > 2) month - 3 else month + 9) + 2) / 5 + day - 1
    val dayOfEra = yearOfEra * 365 + yearOfEra / 4 - yearOfEra / 100 + dayOfYear
    return era * 146_097 + dayOfEra - 719_468
}

/** The inverse of [daysFromCivil]: `civil_from_days`, back to year/month/day. */
private fun civilFromDays(days: Long): Triple<Long, Long, Long> {
    val z = days + 719_468
    val era = (if (z >= 0) z else z - 146_096) / 146_097
    val dayOfEra = z - era * 146_097
    val yearOfEra = (dayOfEra - dayOfEra / 1_460 + dayOfEra / 36_524 - dayOfEra / 146_096) / 365
    val year = yearOfEra + era * 400
    val dayOfYear = dayOfEra - (365 * yearOfEra + yearOfEra / 4 - yearOfEra / 100)
    val monthPrime = (5 * dayOfYear + 2) / 153
    val day = dayOfYear - (153 * monthPrime + 2) / 5 + 1
    val month = if (monthPrime < 10) monthPrime + 3 else monthPrime - 9
    return Triple(if (month <= 2) year + 1 else year, month, day)
}

private fun floorDiv(value: Long, divisor: Long): Long {
    val quotient = value / divisor
    return if (value % divisor != 0L && (value xor divisor) < 0) quotient - 1 else quotient
}

private fun floorMod(value: Long, divisor: Long): Long {
    val remainder = value % divisor
    return if (remainder != 0L && (remainder xor divisor) < 0) remainder + divisor else remainder
}

private fun pad2(value: Long): String = if (value < 10) "0$value" else value.toString()

/**
 * `formatDateTime`: `D/M HH:mm` in the device's own zone, which is what the web's
 * `toLocaleString([], { month, day, hour, minute })` resolves to.
 *
 * Null when the stamp cannot be read, so a broken timestamp leaves a gap instead of claiming an
 * instant that never happened.
 */
fun formatDateTime(value: String?): String? {
    val epoch = instantMillis(value) ?: return null
    return formatDateTime(epoch, platformUtcOffsetMillis(epoch))
}

fun formatDateTime(epochMillis: Long, utcOffsetMillis: Long): String {
    val local = epochMillis + utcOffsetMillis
    val days = floorDiv(local, 86_400_000L)
    val withinDay = floorMod(local, 86_400_000L)
    val (_, month, day) = civilFromDays(days)
    return "${month}/${day} ${pad2(withinDay / 3_600_000L)}:${pad2((withinDay / 60_000L) % 60L)}"
}

/** The web's duration copy: `42s`, then `3m 12s`. Never negative, never a bare `0m`. */
fun formatElapsed(seconds: Long): String {
    val safe = seconds.coerceAtLeast(0L)
    return if (safe >= 60) "${safe / 60}m ${safe % 60}s" else "${safe}s"
}

/** A job's own `runningMs`, which is already a duration rather than a pair of instants. */
fun formatDurationMs(millis: Long): String = formatElapsed(millis / 1_000L)

/*
 * ---------------------------------------------------------------------------------------------
 * Copy
 * ---------------------------------------------------------------------------------------------
 */

/** Message progress is silent after receipt; execution uncertainty never becomes a failed send. */
/**
 * What a prompt says about its delivery. A turn stopped after the prompt arrived is the turn's
 * outcome, not the prompt's: [stopShown] false leaves 已停止 to the row that ends the turn.
 */
fun deliveryLabel(run: Run?, stopShown: Boolean = true): String? =
    deliveryLabel(run, stopShown, hasTurnOutput = false)

fun deliveryLabel(run: Run?, stopShown: Boolean, hasTurnOutput: Boolean): String? {
    val native = run?.native ?: return null
    val recovery = riffet.ui.state.messageRecovery(run)
    if (recovery.needsCheck) return L10n.uiText(if (recovery.taskOutcomeUnknown) "delivery.resultUnknown" else "delivery.unconfirmed")
    val isSteer = native.intent == "steer"
    val received = (!isSteer && (hasTurnOutput || run.state == RunState.RUNNING))
        || native.nativeMessageId != null
        || native.timings?.get("observedAt") != null
        || native.timings?.get("providerAcceptedAt") != null
        || native.delivery == NativeDeliveryState.OBSERVED
        || native.stage == "provider_failed"
        || native.stage == "turn_outcome_unknown"
    return when (native.delivery) {
        NativeDeliveryState.QUEUED -> if (received) null else L10n.uiText("delivery.sending")
        NativeDeliveryState.PREPARING, NativeDeliveryState.DISPATCHING -> if (received) null else L10n.uiText("delivery.sending")
        NativeDeliveryState.INPUT_SENT -> if (received || run.state == RunState.COMPLETED) null else L10n.uiText("delivery.sending")
        NativeDeliveryState.OBSERVED -> if (native.intent == "steer") L10n.uiText("delivery.steer.sent") else null
        NativeDeliveryState.UNCERTAIN -> L10n.uiText("delivery.unconfirmed")
        NativeDeliveryState.FAILED -> L10n.uiText(if (native.nativeMessageId != null || native.stage == "provider_failed") "delivery.sentTurnFailed" else "delivery.sendFailed")
        NativeDeliveryState.CANCELLED -> if (native.nativeMessageId != null || run.state == RunState.INTERRUPTED) {
            if (stopShown) L10n.uiText("delivery.stopped") else null
        } else L10n.uiText("delivery.cancelled")
    }
}

/** 已停止 / Stopped, said once by whatever row ends a stopped turn. */
fun stoppedLabel(): String = L10n.uiText("delivery.stopped")

/** Raw diagnostic evidence is available only in an explicitly expanded message detail. */
fun deliveryErrorDetails(run: Run?): String? {
    val native = run?.native ?: return null
    val diagnostic = native.diagnostic
    if (diagnostic == null && native.delivery != NativeDeliveryState.FAILED) return null
    return listOfNotNull(
        run.error?.takeIf { it.isNotBlank() },
        diagnostic?.let { listOfNotNull(it.code, it.stage).joinToString(" / ").takeIf { it.isNotBlank() }?.let { code -> "$code: ${it.message}" } ?: it.message },
    ).distinct().joinToString("\n").takeIf { it.isNotBlank() }
}
