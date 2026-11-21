package riffet.ui.sessionlist

import riffet.contracts.Session
import riffet.ui.timeline.instantMillis

/**
 * A list in [compareSessions] order, reading each session's timestamps once. Sorting thousands of
 * sessions with [compareSessions] parses two timestamps per comparison — and, from Swift, crosses the
 * bridge per comparison: 3000 sessions took ~400 ms on the iPhone's main thread. The order is the same,
 * and stable.
 */
fun sortSessions(sessions: List<Session>): List<Session> {
    class Keyed(val session: Session, val group: Int, val first: Long, val second: Long, val third: Long)
    fun time(value: String?): Long = instantMillis(value) ?: 0L
    return sessions.map { session ->
        val created = time(session.createdAt)
        when {
            // Pinned: latest pin first, then latest activity, then latest created.
            session.pinnedAt != null -> Keyed(session, 0, -time(session.pinnedAt), -time(activityAt(session)), -created)
            // A turn still open: by when it became active, then created.
            isActiveSession(session) -> Keyed(session, 1, -time(session.activeSince ?: session.createdAt), -created, 0)
            // The rest: latest activity, then latest created.
            else -> Keyed(session, 2, -time(activityAt(session)), -created, 0)
        }
    }.sortedWith(compareBy<Keyed>({ it.group }, { it.first }, { it.second }, { it.third })).map { it.session }
}
