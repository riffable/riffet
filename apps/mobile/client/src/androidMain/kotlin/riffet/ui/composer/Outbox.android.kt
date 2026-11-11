package riffet.ui.composer

import android.content.Context
import riffet.shared.RiffetAndroid
import riffet.shared.serverOrigin

/**
 * Android outbox persistence.
 *
 * The web uses `sessionStorage`; the closest single-process store here is a private
 * `SharedPreferences` file. `commit()` rather than `apply()` is deliberate: `apply()` is
 * asynchronous and a process death between the POST and the queued write would lose the only copy
 * of the request whose result is unknown, which is exactly the case the outbox exists to protect.
 */
private const val PREFS = "riffet.sends"
private const val LEGACY_PREFIX = "send."
private const val PREFIX = "send.v2."
private const val MIGRATED = "send.origin-migrated"

/** Bind unscoped requests once, before pairing or an override can replace the restored server. */
@Synchronized
fun migrateLegacyOutbox(serverUrl: String?) {
    val preferences = RiffetAndroid.requireContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    if (preferences.contains(MIGRATED)) return
    val origin = serverUrl?.let(::serverOrigin)
    val edit = preferences.edit()
    // Without an old server the owner is unknown. Leave the bytes quarantined, never adopting
    // them later for a newly paired service just because its session id happens to match.
    if (origin != null) {
        preferences.all.filterKeys { it.startsWith(LEGACY_PREFIX) && !it.startsWith(PREFIX) }.forEach { (key, value) ->
            if (value is String) {
                val destination = "$PREFIX$origin.${key.removePrefix(LEGACY_PREFIX)}"
                check(!preferences.contains(destination) || preferences.getString(destination, null) == value) {
                    "待发送请求存在冲突，无法迁移"
                }
                edit.putString(destination, value).remove(key)
            }
        }
    }
    check(edit.putBoolean(MIGRATED, true).commit()) { "无法迁移发送请求" }
}

private class AndroidOutboxStore(private val context: Context, origin: String) : OutboxStore {

    private val sendPrefix = "$PREFIX$origin."
    private val steerPrefix = "steer.v2.$origin."

    private fun prefs() = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun key(sessionId: String, commandId: String) = "$sendPrefix$sessionId.$commandId"

    override fun list(sessionId: String): List<OutboxEntry> {
        val prefix = "$sendPrefix$sessionId."
        return prefs().all.entries
            .filter { (key, _) -> key.startsWith(prefix) || key.startsWith("$steerPrefix$sessionId.") }
            .mapNotNull { (key, value) -> (value as? String)?.let(OutboxJson::decode)?.let { entry -> if (key.startsWith(steerPrefix) && entry.version == 1) entry.copy(version = 2) else entry } }
    }

    override fun save(entry: OutboxEntry) {
        val entryKey = if (entry.version != 1 || entry.steerTarget != null) "$steerPrefix${entry.sessionId}.${entry.body.commandId}" else key(entry.sessionId, entry.body.commandId)
        check(prefs().edit().putString(entryKey, OutboxJson.encode(entry)).commit()) { "无法保存发送请求" }
    }

    override fun remove(sessionId: String, commandId: String) {
        prefs().edit().remove(key(sessionId, commandId)).remove("$steerPrefix$sessionId.$commandId").commit()
    }
}

actual fun createOutboxStore(serverUrl: String?): OutboxStore =
    serverUrl?.let(::serverOrigin)?.let { origin ->
        runCatching { AndroidOutboxStore(RiffetAndroid.requireContext(), origin) }.getOrElse { InMemoryOutboxStore() }
    } ?: InMemoryOutboxStore()
