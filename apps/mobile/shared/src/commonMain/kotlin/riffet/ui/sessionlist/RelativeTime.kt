package riffet.ui.sessionlist

import androidx.compose.runtime.Composable
import org.jetbrains.compose.resources.stringResource
import riffet.ui.timeline.instantMillis
import riffet.ui.timeline.platformUtcOffsetMillis
import riffet_mobile.shared.generated.resources.Res
import riffet_mobile.shared.generated.resources.session_activity_ago
import riffet_mobile.shared.generated.resources.session_activity_just_now
import riffet_mobile.shared.generated.resources.session_relative_ago
import riffet_mobile.shared.generated.resources.session_relative_days
import riffet_mobile.shared.generated.resources.session_relative_hours
import riffet_mobile.shared.generated.resources.session_relative_just_now
import riffet_mobile.shared.generated.resources.session_relative_minutes
import riffet_mobile.shared.generated.resources.session_relative_months
import riffet_mobile.shared.generated.resources.session_relative_years

/*
 * The sidebar model's `relativeLabel` is written in the source locale, but it lives in the client
 * module, outside the Compose resource catalogs. These wrappers re-derive the same buckets from the
 * timestamp and render each one through `Res`, so screens in this module can show a localized label
 * without the model carrying translations.
 */

internal fun relativeMinutes(at: Long, now: Long): Long = (now - at).coerceAtLeast(0L) / 60_000L

/** Whether the stamp reads as `刚刚` in the source locale. */
internal fun isJustNow(at: Long, now: Long): Boolean = relativeMinutes(at, now) < 1L

/** The bare relative time: `刚刚` / `12 分钟` / `3 小时`. */
@Composable
internal fun relativeTimeLabel(at: Long, now: Long): String {
    val minutes = relativeMinutes(at, now)
    return when {
        minutes < 1L -> stringResource(Res.string.session_relative_just_now)
        minutes < 60L -> stringResource(Res.string.session_relative_minutes, minutes)
        minutes < 1_440L -> stringResource(Res.string.session_relative_hours, minutes / 60L)
        minutes < 43_200L -> stringResource(Res.string.session_relative_days, minutes / 1_440L)
        minutes < 525_600L -> stringResource(Res.string.session_relative_months, minutes / 43_200L)
        else -> stringResource(Res.string.session_relative_years, minutes / 525_600L)
    }
}

/** Local wall-clock `HH:mm` of an epoch instant. */
internal fun clockLabel(epochMillis: Long): String {
    val minutes = ((epochMillis + platformUtcOffsetMillis(epochMillis)) / 60_000).mod(24 * 60L)
    return "${(minutes / 60).toString().padStart(2, '0')}:${(minutes % 60).toString().padStart(2, '0')}"
}

/** The clock for a stamp of today, else [relativeTimeLabel]: for rows already grouped by day. */
@Composable
internal fun dayTimeLabel(value: String?, now: Long, dayStart: Long): String? =
    instantMillis(value)?.let { if (it >= dayStart) clockLabel(it) else relativeTimeLabel(it, now) }

/** [relativeTimeLabel] for a stored timestamp; null when the stamp cannot be parsed. */
@Composable
internal fun relativeTimeLabel(value: String?, now: Long): String? =
    instantMillis(value)?.let { relativeTimeLabel(it, now) }

/** The bare relative time with the source locale's past suffix: `刚刚` / `12 分钟前`. */
@Composable
internal fun relativeTimeAgo(at: Long, now: Long): String =
    if (isJustNow(at, now)) stringResource(Res.string.session_relative_just_now)
    else stringResource(Res.string.session_relative_ago, relativeTimeLabel(at, now))

/** [relativeTimeAgo] for a stored timestamp; null when the stamp cannot be parsed. */
@Composable
internal fun relativeTimeAgo(value: String?, now: Long): String? =
    instantMillis(value)?.let { relativeTimeAgo(it, now) }

/** The activity row's phrasing: `刚刚活动` / `12 分钟前活动`. */
@Composable
internal fun relativeTimeActivity(value: String?, now: Long): String? {
    val at = instantMillis(value) ?: return null
    return if (isJustNow(at, now)) stringResource(Res.string.session_activity_just_now)
    else stringResource(Res.string.session_activity_ago, relativeTimeLabel(at, now))
}
