package riffet.android

import android.content.Context
import android.content.Intent
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import riffet.contracts.Session
import riffet.shared.AppLog

/**
 * The launcher's long-press list: the three conversations with the latest activity on the paired
 * server. A shortcut opens its conversation
 * through the same extras a notification press uses, so a shortcut from another server is refused
 * the same way.
 */
internal object RiffetShortcuts {
    private const val LIMIT = 3
    private const val ID_PREFIX = "session:"

    /** What a shortcut shows; published only when this changes. */
    data class Entry(val id: String, val title: String)

    fun recent(sessions: List<Session>): List<Entry> = sessions
        .filter { it.archivedAt == null && it.handedOffTo == null }
        // ISO-8601 UTC from one server, so the strings sort as the instants do.
        .sortedByDescending { it.lastActivityAt ?: it.createdAt }
        .take(LIMIT)
        .map { Entry(it.id, it.shownTitle.ifBlank { "Riffet" }) }

    /** False when the launcher's rate limit refused the update; the caller tries again later. */
    fun publish(context: Context, entries: List<Entry>, origin: String): Boolean {
        val shortcuts = entries.mapIndexed { rank, entry ->
            val intent = Intent(context, RiffetActivity::class.java)
                .setAction(ACTION_OPEN_SESSION)
                .putExtra(RiffetActivity.EXTRA_SESSION, entry.id)
                .putExtra(RiffetNotificationReceiver.EXTRA_ORIGIN, origin)
            ShortcutInfoCompat.Builder(context, ID_PREFIX + entry.id)
                .setShortLabel(entry.title)
                .setLongLabel(entry.title)
                .setIcon(IconCompat.createWithResource(context, R.mipmap.ic_launcher))
                .setIntent(intent)
                .setRank(rank)
                .build()
        }
        return try {
            ShortcutManagerCompat.setDynamicShortcuts(context, shortcuts)
        } catch (failure: RuntimeException) {
            AppLog.log("app", "shortcuts failed ${failure::class.simpleName}: ${failure.message}")
            true
        }
    }

    fun clear(context: Context) {
        runCatching { ShortcutManagerCompat.removeAllDynamicShortcuts(context) }
    }

    /** A shortcut's action; [RiffetActivity] reads the extras, not the action. */
    const val ACTION_OPEN_SESSION = "riffet.android.action.OPEN_SESSION"
}
