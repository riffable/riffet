package riffet.ui.pickers

import riffet.contracts.AccountUsage
import riffet.contracts.ModelDailyQuota
import riffet.contracts.ModelQuota
import riffet.contracts.ModelStatus
import riffet.contracts.UsageWindow
import riffet.i18n.L10n
import riffet.ui.timeline.platformNowMillis
import riffet.ui.timeline.platformUtcOffsetMillis

/* Account usage, quota and load as the model pickers phrase them; shared by every client. */

enum class LoadTone { DANGER, WARNING, MUTED }

fun windowName(minutes: Int?): String = when {
    minutes == null || minutes == 0 -> L10n.uiText("modelUsage.window.quota")
    minutes == 300 -> L10n.uiText("modelUsage.window.fiveHours")
    minutes == 1440 -> L10n.uiText("modelUsage.window.daily")
    minutes == 10080 -> L10n.uiText("modelUsage.window.weekly")
    minutes in 40320..44640 -> L10n.uiText("modelUsage.window.monthly")
    minutes % 60 == 0 -> L10n.uiText("modelUsage.window.hours", minutes / 60)
    else -> L10n.uiText("modelUsage.window.minutes", minutes)
}

/** When a window resets: relative within a day, as a local date after that. */
fun resetLabel(iso: String?, now: Long = platformNowMillis(), offsetOf: (Long) -> Long = ::platformUtcOffsetMillis): String? {
    val at = iso?.let(::parseIsoMillis) ?: return null
    val left = at - now
    return when {
        left <= 0 -> L10n.uiText("modelUsage.reset.soon")
        left < 3_600_000 -> L10n.uiText("modelUsage.reset.inMinutes", maxOf(1L, (left + 30_000) / 60_000))
        left < 86_400_000 -> L10n.uiText("modelUsage.reset.inHours", (left + 1_800_000) / 3_600_000)
        else -> {
            val (_, month, day) = civilFromDays((at + offsetOf(at)).floorDiv(86_400_000L))
            L10n.uiText("modelUsage.reset.monthDay", month, day)
        }
    }
}

/** Above 100% the provider queues requests, which is what a reader needs to see. */
fun loadTone(percent: Int): LoadTone = when {
    percent > 100 -> LoadTone.DANGER
    percent >= 80 -> LoadTone.WARNING
    else -> LoadTone.MUTED
}

fun quotaLabel(quota: ModelQuota): String = when {
    quota.depleted -> L10n.uiText("modelUsage.quota.depleted")
    quota.remaining != null && quota.limit != null -> L10n.uiText("modelUsage.quota.remaining", quota.remaining, quota.limit)
    else -> L10n.uiText("modelUsage.quota.left", remainingPercent(quota.usedPercent))
}

/** Quotas read as what is left, which is what decides whether to keep using a model. */
fun remainingPercent(used: Int): Int = (100 - used).coerceAtLeast(0)

/** Up to two decimals, without a trailing `.0`: 9.5, 9.25, 10. */
fun formatQuotaAmount(value: Double): String {
    val cents = kotlin.math.round(kotlin.math.abs(value) * 100).toLong()
    val whole = groupThousands(cents / 100)
    val fraction = cents % 100
    val text = when {
        fraction == 0L -> whole
        fraction % 10 == 0L -> "$whole.${fraction / 10}"
        else -> "$whole.${fraction.toString().padStart(2, '0')}"
    }
    return if (value < 0) "-$text" else text
}

/** A daily allowance reads separately from the shared weekly quota beside it. */
fun dailyQuotaLabel(quota: ModelDailyQuota): String =
    L10n.uiText("modelUsage.daily.remaining", formatQuotaAmount(quota.remaining), formatQuotaAmount(quota.limit))

/** Exhausting the daily allowance lowers priority; the model stays usable. */
fun dailyQuotaLowPriorityLabel(): String = L10n.uiText("modelUsage.daily.lowPriority")

/** Why a model has no quota figure: the provider meters it but its snapshot did not arrive. */
fun quotaUnavailable(status: ModelStatus): Boolean =
    (status.quotaLimited == true && status.quota == null) ||
        (!status.dailyQuotaKey.isNullOrBlank() && status.dailyQuota == null)

fun quotaUnavailableLabel(): String = L10n.uiText("modelUsage.quota.unavailable")

/** One line for the account: plan, each metered window, then credits. */
fun accountSummary(account: AccountUsage, now: Long = platformNowMillis(), offsetOf: (Long) -> Long = ::platformUtcOffsetMillis): String {
    val plan = account.plan?.replace('_', ' ')?.replaceFirstChar { it.uppercaseChar() }
    val windows = account.windows.map { windowSummary(it, now, offsetOf) }
    val balance = account.credits?.balance
    val credits = when {
        account.credits?.unlimited == true -> L10n.uiText("modelUsage.credits.unlimited")
        balance != null -> L10n.uiText("modelUsage.credits.balance", groupThousands(balance.toLong()))
        else -> null
    }
    return (listOfNotNull(plan) + windows + listOfNotNull(credits)).joinToString(" · ")
}

private fun windowSummary(window: UsageWindow, now: Long, offsetOf: (Long) -> Long): String =
    listOfNotNull(
        L10n.uiText("modelUsage.window.left", windowName(window.windowMinutes), remainingPercent(window.usedPercent)),
        resetLabel(window.resetsAt, now, offsetOf),
    ).joinToString(" · ")

private fun groupThousands(value: Long): String = value.toString().reversed().chunked(3).joinToString(",").reversed()

/** `YYYY-MM-DDTHH:MM:SS(.fff)Z`, the only shape the server sends; anything else is no time. */
fun parseIsoMillis(value: String): Long? {
    val match = ISO_INSTANT.find(value) ?: return null
    val parts = match.groupValues
    val days = daysFromCivil(parts[1].toInt(), parts[2].toInt(), parts[3].toInt())
    val millis = parts[7].padEnd(3, '0').ifEmpty { "000" }.toInt()
    return ((days * 24 + parts[4].toLong()) * 60 + parts[5].toLong()) * 60_000 + parts[6].toLong() * 1000 + millis
}

private val ISO_INSTANT = Regex("""^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3})\d*)?Z$""")

// Howard Hinnant's civil-date algorithms: proleptic Gregorian, days since 1970-01-01.
private fun daysFromCivil(year: Int, month: Int, day: Int): Long {
    val y = (if (month <= 2) year - 1 else year).toLong()
    val era = y.floorDiv(400)
    val yoe = y - era * 400
    val doy = (153 * (if (month > 2) month - 3 else month + 9) + 2) / 5 + day - 1
    val doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
    return era * 146097 + doe - 719468
}

private fun civilFromDays(days: Long): Triple<Int, Int, Int> {
    val z = days + 719468
    val era = z.floorDiv(146097)
    val doe = z - era * 146097
    val yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365
    val doy = doe - (365 * yoe + yoe / 4 - yoe / 100)
    val mp = (5 * doy + 2) / 153
    val day = (doy - (153 * mp + 2) / 5 + 1).toInt()
    val month = (if (mp < 10) mp + 3 else mp - 9).toInt()
    return Triple((yoe + era * 400 + if (month <= 2) 1 else 0).toInt(), month, day)
}
