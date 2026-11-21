package riffet.ui.sessionlist

import riffet.contracts.Project
import riffet.contracts.Session
import riffet.contracts.SessionState
import riffet.i18n.L10n
import riffet.shared.isAssistant
import riffet.shared.isQuickChat
import riffet.ui.timeline.instantMillis

/*
 * The sidebar's data rules, ported from `apps/web/src/app/Sidebar.tsx`: both layouts (`groups` and
 * `timeline`), the search match, the activity ordering and the relative time label. The drawer
 * itself is `Sidebar.kt`.
 */

/**
 * A per-session change the sidebar asks the host to perform. The three cases are exactly the
 * writable fields of `RiffetApi.updateSession(id, SessionUpdate(title, tags, archived, pinned))`.
 */
sealed interface SessionAction {
    /** [pinned] is the desired state, not a toggle, so a retry cannot flip the wrong way. */
    data class Pin(val session: Session, val pinned: Boolean) : SessionAction

    /** [title] is already trimmed and non-blank. */
    data class Rename(val session: Session, val title: String) : SessionAction

    data class Archive(val session: Session, val archived: Boolean) : SessionAction

    /** Asks for the deletion preview and confirmation; nothing is deleted yet. */
    data class Delete(val session: Session) : SessionAction
}

/**
 * How the sidebar lays its conversations out: the web's `Sidebar.tsx` `SidebarLayout`. Project
 * groups or one flat list cut into time bands (the default, as on iOS).
 */
enum class SidebarLayout { PROJECT, TIME }

/**
 * The stored form of [SidebarLayout]. Anything unrecognized — an older build's value, an empty
 * saved slot — falls back to the web's default rather than failing to open the drawer.
 */
fun sidebarLayout(raw: String?): SidebarLayout =
    if (raw == SidebarLayout.PROJECT.name) SidebarLayout.PROJECT else SidebarLayout.TIME

/** One project and the sessions the current query and archive filter leave visible in it. */
data class ProjectGroup(
    val project: Project,
    val sessions: List<Session>,
    /** A query matched sessions inside this project (but not the project itself): keep it open. */
    val forceOpen: Boolean,
)

/**
 * The web sidebar's project layout, ported from `Sidebar.tsx`'s `groups` memo:
 *
 *  - a session matches on title + tags, a project on name + cwd (`matchesSession` / `matchesProject`);
 *  - a project the query matched shows **all** of its sessions, not just the matching ones;
 *  - a project whose sessions are all filtered out disappears entirely;
 *  - worktree conversations join their original project's group; checkout identities stay intact;
 *  - archiving a project hides its checkout descendants until archived projects are shown;
 *  - sessions are ordered by [compareSessions] — pinned first, then activity.
 *
 * The one deliberate difference from the web is the *project* order. The web keeps whatever order
 * `GET /api/bootstrap` returned, and the server's `listProjects()` does not sort at all (it is
 * insertion order). A phone screen is one glance tall, so projects are ordered by their most recent
 * conversation activity instead: the work that is actually moving is on the first screen. Ties keep
 * the server's order, because `sortedWith` is stable.
 */
fun visibleGroups(
    projects: List<Project>,
    sessions: List<Session>,
    query: String,
    showArchived: Boolean,
): List<ProjectGroup> {
    val needle = query.trim().lowercase()
    val projectMap = sidebarProjectMap(projects, showArchived)
    val byProject = sessions
        .filter { showArchived || it.archivedAt == null }
        .filter { it.projectId in projectMap }
        .groupBy { projectMap.getValue(it.projectId).id }
    return projectMap.values.distinctBy { it.id }
        .mapNotNull { project ->
            val scoped = byProject[project.id].orEmpty().sortedWith(sessionOrder)
            val projectHit = matchesProject(project, needle)
            val visible = if (projectHit) scoped else scoped.filter { matchesSession(it, needle) }
            if ((!projectHit || project.id == PROJECTLESS_GROUP_ID) && visible.isEmpty()) {
                null
            } else {
                ProjectGroup(project, visible, forceOpen = needle.isNotEmpty() && !projectHit)
            }
        }
        .sortedWith(projectOrder)
}

/** One label band of the time layout: the shape `Sidebar.tsx`'s `timeline` memo builds. */
data class TimeBucket(val label: String, val sessions: List<Session>)

/**
 * The web's `timeBucket`: `置顶` / `进行中` / `今天` / `昨天` / `近 7 天` / `近 30 天` / `更早`.
 *
 * [dayStartMillis] is local midnight of *today*. The web derives it from
 * `new Date(now.getFullYear(), now.getMonth(), now.getDate())` inside the memo; here it is an
 * argument (`riffet.ui.timeline.localDayStart`) so that the band rule itself never touches the
 * platform's zone database and can be asserted off-device. The bands are otherwise exact web copy,
 * including the fixed 24-hour arithmetic — `Sidebar.tsx` also subtracts `86_400_000`, so a DST day
 * shifts both implementations by the same hour instead of only one of them.
 */
fun timeBucketLabel(session: Session, dayStartMillis: Long): String = L10n.uiText(timeBucketKey(session, dayStartMillis))

/** A band's identity stays stable when its title or first conversation changes. */
fun timeBucketKey(session: Session, dayStartMillis: Long): String {
    if (session.pinnedAt != null) return "sidebar.bucket.pinned"
    if (isActiveSession(session)) return "sidebar.bucket.active"
    val at = instantMillis(activityAt(session)) ?: return "sidebar.bucket.earlier"
    val day = 86_400_000L
    return when {
        at >= dayStartMillis -> "sidebar.bucket.today"
        at >= dayStartMillis - day -> "sidebar.bucket.yesterday"
        at >= dayStartMillis - 6 * day -> "sidebar.bucket.last7Days"
        at >= dayStartMillis - 29 * day -> "sidebar.bucket.last30Days"
        else -> "sidebar.bucket.earlier"
    }
}

/**
 * The web's `timeline` memo: every visible conversation in one list, ordered by [compareSessions],
 * cut into consecutive [timeBucketLabel] bands. A band appears once and only when its first member
 * is reached, because the order is pinned-first and then today → older.
 *
 * The differences from [visibleGroups] are the web's own, and each one is easy to "fix" into a
 * divergence:
 *
 *  - the match is evaluated per session, against `title` + tags + **its project's name**: a project
 *    matched only by its *cwd* — which [visibleGroups] does search — contributes nothing here, while
 *    a project matched by name keeps all of its conversations;
 *  - an archived project (with 显示已归档 off) takes its conversations with it;
 *  - there are no project rows and no collapse state here: a visible project with no matching
 *    session contributes nothing, so an empty list means an empty screen, not an empty group.
 */
fun timeBuckets(
    projects: List<Project>,
    sessions: List<Session>,
    query: String,
    showArchived: Boolean,
    dayStartMillis: Long,
): List<TimeBucket> {
    val needle = query.trim().lowercase()
    val visible = sidebarProjectMap(projects, showArchived)
    val matches = sessions
        .filter { session ->
            val project = visible[session.projectId] ?: return@filter false
            if (!showArchived && session.archivedAt != null) return@filter false
            needle.isEmpty() ||
                "${session.shownTitle} ${session.tags.joinToString(" ")} ${project.name}".lowercase().contains(needle)
        }
        .sortedWith(sessionOrder)

    return timeBands(matches, dayStartMillis)
}

/**
 * Cuts [sessions] into consecutive [timeBucketLabel] bands, pinned and active first as
 * [compareSessions] orders them. Used by the drawer's time layout and by the quick chat home's own
 * list, so both name their bands the same way.
 */
fun timeBands(sessions: List<Session>, dayStartMillis: Long): List<TimeBucket> {
    val labels = mutableListOf<String>()
    val bands = mutableListOf<MutableList<Session>>()
    for (session in sessions.sortedWith(sessionOrder)) {
        val label = timeBucketLabel(session, dayStartMillis)
        if (labels.lastOrNull() != label) {
            labels.add(label)
            bands.add(mutableListOf())
        }
        bands.last().add(session)
    }
    return labels.indices.map { TimeBucket(labels[it], bands[it]) }
}

/**
 * The web's `compareSessionsByActivity`: pinned conversations first (most recently pinned first),
 * then active ones by when they became active, then the rest by conversation activity, then by
 * creation. Active conversations ignore their latest output so several streaming turns keep their
 * places instead of trading the top row on every update.
 *
 * Timestamps are compared as *instants*, not as strings. The server writes one format today, so a
 * string compare happens to work, but the web's own comment says why that is not enough: two
 * records with different precision (`...:00Z` vs `...:00.000Z`) break as soon as the format drifts.
 * `instantMillis` is `riffet.ui.timeline`'s parser for exactly the stamps this server writes.
 *
 * This does not fight the server: `listSessions()` already orders by activity descending, and this
 * only ever lifts pinned conversations above that order.
 */
fun compareSessions(a: Session, b: Session): Int {
    val aPinned = a.pinnedAt != null
    val bPinned = b.pinnedAt != null
    if (aPinned != bPinned) return if (aPinned) -1 else 1
    if (aPinned && bPinned) {
        val byPin = instant(b.pinnedAt).compareTo(instant(a.pinnedAt))
        if (byPin != 0) return byPin
    }
    if (!aPinned && !bPinned) {
        val aActive = isActiveSession(a)
        val bActive = isActiveSession(b)
        if (aActive != bActive) return if (aActive) -1 else 1
        if (aActive) {
            // A server that predates `activeSince` falls back to creation, which is at least stable.
            val byActive = instant(b.activeSince ?: b.createdAt).compareTo(instant(a.activeSince ?: a.createdAt))
            if (byActive != 0) return byActive
            return instant(b.createdAt).compareTo(instant(a.createdAt))
        }
    }
    val byActivity = instant(activityAt(b)).compareTo(instant(activityAt(a)))
    if (byActivity != 0) return byActivity
    return instant(b.createdAt).compareTo(instant(a.createdAt))
}

private val activeStates = setOf(SessionState.STARTING, SessionState.RUNNING, SessionState.WAITING, SessionState.CANCELLING)

/** Starting, running, waiting on the reader or being cancelled: a turn is still open. */
fun isActiveSession(session: Session): Boolean = session.state in activeStates

/** The conversation's activity time, separate from metadata edits and session views. */
fun activityAt(session: Session): String = session.lastActivityAt ?: session.createdAt

// What a conversation asks of its reader; mirrors packages/contracts/src/session-attention.ts.

/** Waiting on the reader: a permission, a question or a plan to approve. */
fun needsYou(session: Session): Boolean = session.state == SessionState.WAITING

/** A turn is underway and nothing is asked of the reader. */
fun isRunningSession(session: Session): Boolean =
    session.state == SessionState.STARTING || session.state == SessionState.RUNNING || session.state == SessionState.CANCELLING

/**
 * Activity arrived after the owner last saw the conversation. A missing `seenActivityAt` comes from a
 * server without read state and reads as seen; archived conversations are never unread.
 */
fun isUnread(session: Session): Boolean {
    val seen = session.seenActivityAt ?: return false
    return session.archivedAt == null && instant(activityAt(session)) > instant(seen)
}

/** Finished, failed or stopped with output the owner has not seen yet: the rows the Unread filter lists. */
fun isDoneUnseen(session: Session): Boolean =
    (session.state == SessionState.IDLE || session.state == SessionState.FAILED || session.state == SessionState.INTERRUPTED) && isUnread(session)

private val sessionOrder = Comparator<Session> { a, b -> compareSessions(a, b) }

private val projectOrder = Comparator<ProjectGroup> { a, b ->
    val byActivity = newestActivity(b).compareTo(newestActivity(a))
    if (byActivity != 0) {
        byActivity
    } else {
        instant(b.project.updatedAt).compareTo(instant(a.project.updatedAt))
    }
}

/** The project's newest conversation activity; a project with no visible sessions ranks last. */
private fun newestActivity(group: ProjectGroup): Long =
    group.sessions.maxOfOrNull { instant(activityAt(it)) } ?: Long.MIN_VALUE

private fun instant(value: String?): Long = instantMillis(value) ?: 0L

private fun matchesSession(session: Session, needle: String): Boolean =
    needle.isEmpty() ||
        "${session.shownTitle} ${session.tags.joinToString(" ")}".lowercase().contains(needle)

private fun matchesProject(project: Project, needle: String): Boolean =
    needle.isEmpty() || "${project.name} ${project.cwd}".lowercase().contains(needle)

/** Execution stays in each checkout; sidebar groups and project names belong to its original project. */
private const val PROJECTLESS_GROUP_ID = "__projectless__"

private fun sidebarProjectMap(projects: List<Project>, showArchived: Boolean): Map<String, Project> {
    val byId = projects.associateBy { it.id }
    val unassociated = projects.firstOrNull { it.system == "task-workspace" }?.copy(
        id = PROJECTLESS_GROUP_ID, name = L10n.uiText("sidebar.projectless"), cwd = "",
        tags = emptyList(), archivedAt = null, worktree = null,
    )
    return buildMap {
        for (project in projects) {
            // The quick chat project has its own section above the projects; the assistant is not a project.
            if (project.isQuickChat || project.isAssistant) continue
            var current = project
            val visited = mutableSetOf<String>()
            var hidden = false
            while (true) {
                if (!showArchived && current.archivedAt != null) {
                    hidden = true
                    break
                }
                visited.add(current.id)
                val origin = current.worktree?.originProjectId?.let(byId::get) ?: break
                // Malformed peer data must not make a checkout inaccessible or loop forever.
                if (origin.id in visited) {
                    current = project
                    break
                }
                current = origin
            }
            if (!hidden) put(project.id, if (current.system == "task-workspace") unassociated ?: current else current)
        }
    }
}

/**
 * The web's `relativeTime`: `刚刚`, `12 分钟`, `3 小时`, `2 天`, `5 个月`, `1 年`.
 *
 * Null when the stamp cannot be read, so a broken timestamp leaves a gap rather than claiming an
 * instant that never happened.
 */
fun relativeLabel(value: String?, now: Long): String? = instantMillis(value)?.let { relativeLabel(it, now) }

/** [relativeLabel] for an epoch-millisecond instant. */
fun relativeLabel(at: Long, now: Long): String {
    val minutes = (now - at).coerceAtLeast(0L) / 60_000L
    return when {
        minutes < 1L -> L10n.uiText("sidebar.relative.justNow")
        minutes < 60L -> L10n.uiText("sidebar.relative.minutes", minutes)
        minutes < 1_440L -> L10n.uiText("sidebar.relative.hours", minutes / 60L)
        minutes < 43_200L -> L10n.uiText("sidebar.relative.days", minutes / 1_440L)
        minutes < 525_600L -> L10n.uiText("sidebar.relative.months", minutes / 43_200L)
        else -> L10n.uiText("sidebar.relative.years", minutes / 525_600L)
    }
}

/** Project ids are UUIDs, so a comma-joined set is an unambiguous `rememberSaveable` value. */
fun toggleCollapsed(raw: String, id: String): String {
    val current = raw.split(',').filter { it.isNotEmpty() }
    return if (id in current) {
        current.filterNot { it == id }.joinToString(",")
    } else {
        (current + id).joinToString(",")
    }
}
