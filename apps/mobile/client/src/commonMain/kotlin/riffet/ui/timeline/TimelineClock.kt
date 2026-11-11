package riffet.ui.timeline

/*
 * Wall clock, declared the way docs/MOBILE.md declares every platform seam ("平台层"):
 * `expect` in commonMain, one `actual` per target. No business code in this package knows which
 * platform it runs on.
 *
 * Why this exists at all: `kotlinx-datetime` (which would give `Clock.System.now()` and
 * `TimeZone.currentSystemDefault()` in one line) is an `implementation` dependency of `:core`, so
 * it is not on this module's compile classpath, and adding a dependency to
 * `shared/build.gradle.kts` is out of scope for this change. The alternative — showing timestamps
 * in UTC, or showing none — would be a quiet lie about when something happened, and this project
 * would rather have one honest seam than a plausible-looking wrong clock.
 */

/**
 * Milliseconds since the Unix epoch, from the platform's wall clock.
 *
 * This is a *civil* time source: it can jump (NTP correction, the user changing the clock). It is
 * used for rendering and for the one-second "how long has this turn been running" ticker, never to
 * order events — ordering comes from the server's sequence numbers.
 */
expect fun platformNowMillis(): Long

/**
 * The device's offset from UTC at [epochMillis], in milliseconds, positive east of Greenwich.
 *
 * It takes an instant rather than returning "the current offset" because the offset is a property
 * of the instant, not of the device: a timestamp from before a DST transition must render with the
 * offset that was in force then.
 */
expect fun platformUtcOffsetMillis(epochMillis: Long): Long

/** The device's IANA zone id (`Asia/Shanghai`), sent as the stats query's `tz`. */
expect fun platformTimeZoneId(): String

/**
 * Local midnight of the day that contains [epochMillis], as an epoch instant.
 *
 * This is the web's `new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()`, written
 * against [platformUtcOffsetMillis] instead of a calendar library. It is what the sidebar's time
 * bands (riffet.ui.sessionlist.timeBucketLabel) compare against, and it deliberately lives here
 * with the rest of the clock seam rather than in the sidebar, because the calendar is the platform's
 * business and the band rule is not.
 *
 * It converts with the offset in force *at [epochMillis]*, while the web's `Date` constructor uses
 * the offset in force at the resulting local midnight. The two differ only on a DST day, only for
 * the hours between midnight and the transition, and then by that transition's size — both sides
 * afterwards subtract fixed 24-hour days, so no band boundary moves twice.
 */
fun localDayStart(epochMillis: Long): Long {
    val offset = platformUtcOffsetMillis(epochMillis)
    return (epochMillis + offset).floorDiv(86_400_000L) * 86_400_000L - offset
}
