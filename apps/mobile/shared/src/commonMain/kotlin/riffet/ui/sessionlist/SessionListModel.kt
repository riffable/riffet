package riffet.ui.sessionlist

import riffet.contracts.Project
import riffet.contracts.Session
import riffet.contracts.SessionState
import riffet.shared.isQuickChat

/**
 * The list page's filter chips, the iPhone's `HomeFilter`. 已归档 is the old 显示已归档 toggle: it
 * shows what the live list hides (archived sessions and those of archived projects), nothing else.
 * 快速会话 is the quick chat history, which the other filters leave out as the drawer always did.
 */
enum class SessionFilter { ALL, RUNNING, WAITING, QUICK_CHAT, ARCHIVED }

/** The stored form of [SessionFilter]; anything unrecognized is 全部. */
fun sessionFilter(raw: String?): SessionFilter = SessionFilter.entries.firstOrNull { it.name == raw } ?: SessionFilter.ALL

/** What the list page draws: 待处理 and 置顶 above the layout's own groups or bands. */
data class SessionListContent(
    val waiting: List<Session>,
    val pinned: List<Session>,
    /** [SidebarLayout.PROJECT]: the remaining sessions by project. */
    val groups: List<ProjectGroup>,
    /** [SidebarLayout.TIME]: the remaining sessions in time bands. */
    val buckets: List<TimeBucket>,
) {
    val isEmpty: Boolean get() = waiting.isEmpty() && pinned.isEmpty() && groups.isEmpty() && buckets.isEmpty()
}

/**
 * The list page's rule, layered over the sidebar's: [visibleGroups] / [timeBuckets] decide what a
 * query matches and which archived projects take their sessions with them, exactly as before, so the
 * two layouts keep their different search scopes (cwd only in project groups). On top of that:
 *
 *  - [filter] keeps running / waiting sessions, or only what the live list hides;
 *  - [scope] keeps one sidebar group — a worktree's sessions count for their original project;
 *  - waiting sessions, then pinned ones, are lifted out into their own sections, and a project
 *    whose sessions all moved up leaves no empty group behind. Only a project that has no session
 *    at all (and only under 全部 without a query) keeps its 暂无会话 row, the way to start one there.
 */
fun sessionListContent(
    projects: List<Project>,
    sessions: List<Session>,
    query: String,
    filter: SessionFilter,
    scope: String?,
    layout: SidebarLayout,
    dayStartMillis: Long,
): SessionListContent {
    val archived = filter == SessionFilter.ARCHIVED
    val live = visibleGroups(projects, sessions, "", false).flatMapTo(mutableSetOf()) { group -> group.sessions.map { it.id } }
    val owner = buildMap {
        visibleGroups(projects, sessions, "", true).forEach { group -> group.sessions.forEach { put(it.id, group.project.id) } }
    }
    fun keep(session: Session): Boolean =
        (session.id in live) != archived &&
            (scope == null || owner[session.id] == scope) &&
            when (filter) {
                SessionFilter.RUNNING -> isActiveSession(session)
                SessionFilter.WAITING -> session.state == SessionState.WAITING
                SessionFilter.ALL, SessionFilter.ARCHIVED, SessionFilter.QUICK_CHAT -> true
            }
    fun lifted(matched: List<Session>): Pair<List<Session>, List<Session>> {
        val waiting = matched.filter { it.state == SessionState.WAITING }.sortedWith(::compareSessions)
        val pinned = matched.filter { it.pinnedAt != null && it.state != SessionState.WAITING }.sortedWith(::compareSessions)
        return waiting to pinned
    }

    // Quick chats have no project to scope by: 快速会话 lists the live ones, and 已归档 without a
    // project scope adds the archived ones.
    val chatProject = projects.firstOrNull { it.isQuickChat }
    val needle = query.trim().lowercase()
    val withChats = filter == SessionFilter.QUICK_CHAT || (archived && scope == null)
    val chats = if (chatProject == null || !withChats) emptyList()
    else sessions.filter { session ->
        session.projectId == chatProject.id && (session.archivedAt != null) == archived &&
            (needle.isEmpty() || "${session.title} ${session.tags.joinToString(" ")}".lowercase().contains(needle))
    }.sortedWith(::compareSessions)
    if (filter == SessionFilter.QUICK_CHAT) {
        val (waiting, pinned) = lifted(chats)
        val moved = (waiting + pinned).mapTo(mutableSetOf()) { it.id }
        val rest = chats.filter { it.id !in moved }
        return when (layout) {
            SidebarLayout.PROJECT -> SessionListContent(waiting, pinned, listOfNotNull(chatProject?.takeIf { rest.isNotEmpty() }?.let { ProjectGroup(it, rest, forceOpen = false) }), emptyList())
            SidebarLayout.TIME -> SessionListContent(waiting, pinned, emptyList(), timeBands(rest, dayStartMillis))
        }
    }

    return when (layout) {
        SidebarLayout.PROJECT -> {
            val groups = visibleGroups(projects, sessions, query, archived)
                .filter { scope == null || it.project.id == scope }
            val (waiting, pinned) = lifted(groups.flatMap { group -> group.sessions.filter(::keep) })
            val moved = (waiting + pinned).mapTo(mutableSetOf()) { it.id }
            val rest = groups.mapNotNull { group ->
                val remaining = group.sessions.filter { keep(it) && it.id !in moved }
                val keepEmpty = group.sessions.isEmpty() && filter == SessionFilter.ALL
                if (remaining.isEmpty() && !keepEmpty) null else group.copy(sessions = remaining)
            }
            val archivedChats = chatProject?.takeIf { chats.isNotEmpty() }?.let { ProjectGroup(it, chats, forceOpen = false) }
            SessionListContent(waiting, pinned, rest + listOfNotNull(archivedChats), emptyList())
        }
        SidebarLayout.TIME -> {
            val matched = (timeBuckets(projects, sessions, query, archived, dayStartMillis).flatMap { it.sessions }.filter(::keep) + chats)
                .sortedWith(::compareSessions)
            val (waiting, pinned) = lifted(matched)
            val moved = (waiting + pinned).mapTo(mutableSetOf()) { it.id }
            SessionListContent(waiting, pinned, emptyList(), timeBands(matched.filter { it.id !in moved }, dayStartMillis))
        }
    }
}

/** The 会话 tab's badge: conversations blocked on the reader, as on the iPhone. */
fun waitingCount(sessions: List<Session>): Int =
    sessions.count { it.state == SessionState.WAITING && it.archivedAt == null }
