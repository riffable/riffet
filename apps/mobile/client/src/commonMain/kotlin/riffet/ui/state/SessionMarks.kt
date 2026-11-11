package riffet.ui.state

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlin.coroutines.CoroutineContext
import riffet.contracts.Mark
import riffet.contracts.MarkAnchor
import riffet.contracts.MarkCreateAsset
import riffet.contracts.MarkCreateRequest
import riffet.contracts.MarkCreateSnapshot
import riffet.contracts.MarkListQuery
import riffet.contracts.MarkQuote
import riffet.core.TimelineItem
import riffet.shared.AppLog
import riffet.shared.RiffetApi
import riffet.ui.composer.newClientId
import riffet.shared.createMark
import riffet.shared.deleteMarks
import riffet.shared.marks
import riffet.shared.marksIfChanged
import riffet.shared.updateMark

/**
 * The saved replies (收藏, docs/MARKS.md) of the conversations on screen, for one server.
 *
 * Kept current the way the session list is: [poll] reads the server's marks revision with
 * `If-None-Match` (304 while nothing changed anywhere), so a change made here, on the web or in
 * another window is seen at the host's poll cadence without a lists stream. A change re-reads the
 * watched conversations and bumps [revision], which a page listing marks of its own reloads on.
 * The host makes one per installed connection; a failed poll is retried by the next, and the first
 * one after it compares against the revision last seen, so nothing changed meanwhile is missed.
 */
class SessionMarks(
    private val api: RiffetApi,
    private val scope: CoroutineScope,
    private val background: CoroutineContext = Dispatchers.Default,
) {
    private val _bySession = MutableStateFlow<Map<String, List<Mark>>>(emptyMap())

    /** The marks of each watched conversation, newest first. */
    val bySession: StateFlow<Map<String, List<Mark>>> = _bySession.asStateFlow()

    private val _revision = MutableStateFlow(0L)

    /** Bumped whenever marks may have changed. */
    val revision: StateFlow<Long> = _revision.asStateFlow()

    private val _markedSessions = MutableStateFlow<Map<String, Set<String>>>(emptyMap())

    /** The conversations with at least one mark, per watched project. */
    val markedSessions: StateFlow<Map<String, Set<String>>> = _markedSessions.asStateFlow()

    private val watched = mutableMapOf<String, Int>()
    private val watchedProjects = mutableMapOf<String, Int>()
    private var followers = 0

    /** The validator of the last revision read, sent as `If-None-Match` by the next poll. */
    private var etag: String? = null

    /** Reads started per conversation: an answer overtaken by a later read or a write is dropped. */
    private val reads = mutableMapOf<String, Int>()
    private val projectReads = mutableMapOf<String, Int>()

    fun marks(sessionId: String): List<Mark> = _bySession.value[sessionId].orEmpty()

    /** The conversations of [projectId] that have at least one mark. */
    fun markedSessions(projectId: String): Set<String> = _markedSessions.value[projectId].orEmpty()

    /** A transcript showing [sessionId] appeared; its marks are read and kept current until it goes. */
    fun watch(sessionId: String) {
        val count = (watched[sessionId] ?: 0) + 1
        watched[sessionId] = count
        if (count == 1) load(sessionId)
    }

    fun unwatch(sessionId: String) {
        val count = watched[sessionId] ?: return
        if (count > 1) {
            watched[sessionId] = count - 1
            return
        }
        watched.remove(sessionId)
        // Bumped, not cleared: a read still in flight must not land on a later watch of the same session.
        reads[sessionId] = (reads[sessionId] ?: 0) + 1
        _bySession.update { it - sessionId }
    }

    /** A page that lists marks itself follows [revision]; nothing is polled while no one watches or follows. */
    fun follow() {
        followers++
    }

    fun unfollow() {
        if (followers > 0) followers--
    }

    /** A list showing [projectId]'s conversations appeared; their marked subset is kept current. */
    fun watchProject(projectId: String) {
        val count = (watchedProjects[projectId] ?: 0) + 1
        watchedProjects[projectId] = count
        if (count == 1) loadProject(projectId)
    }

    fun unwatchProject(projectId: String) {
        val count = watchedProjects[projectId] ?: return
        if (count > 1) {
            watchedProjects[projectId] = count - 1
            return
        }
        watchedProjects.remove(projectId)
        projectReads[projectId] = (projectReads[projectId] ?: 0) + 1
        _markedSessions.update { it - projectId }
    }

    /** One conditional read of the marks revision; a change re-reads what is watched. */
    @Throws(Exception::class)
    suspend fun poll() {
        if (watched.isEmpty() && watchedProjects.isEmpty() && followers == 0) return
        val answer = withContext(background) { api.marksIfChanged(MarkListQuery(limit = 1), etag) }
        etag = answer.etag
        if (answer.items != null) changed()
    }

    /** The whole-answer mark of [item] in [sessionId], when it has one. */
    fun messageMark(sessionId: String, item: TimelineItem): Mark? {
        val ids = markIds(item).toSet()
        return marks(sessionId).firstOrNull { it.isMessage && it.anchor.ids.any(ids::contains) }
    }

    /** The image or file mark of [name] at [path] in [item], when it has one. */
    fun assetMark(sessionId: String, item: TimelineItem, kind: String, name: String, path: String?): Mark? {
        val ids = markIds(item).toSet()
        return marks(sessionId).firstOrNull { mark ->
            mark.kind == kind && mark.asset?.name == name && (mark.asset?.path ?: "") == (path ?: "") && mark.anchor.ids.any(ids::contains)
        }
    }

    /**
     * Saves [item] of [sessionId] as a [kind] mark: the whole answer, a [quote] inside it, or an
     * [asset] it showed. [text] is the snapshot kept for when the message can no longer be found;
     * [generation] is the native history generation the item was read in.
     */
    @Throws(Exception::class)
    suspend fun create(
        sessionId: String,
        kind: String,
        item: TimelineItem,
        text: String,
        quote: MarkQuote? = null,
        asset: MarkCreateAsset? = null,
        color: String? = null,
        generation: String? = null,
    ): Mark? {
        val event = item.event
        val messageId = event.nativeId ?: return null
        val aliases = event.nativeAliases.orEmpty()
        val mark = api.createMark(
            MarkCreateRequest(
                id = newClientId(),
                sessionId = sessionId,
                kind = kind,
                anchor = MarkAnchor(
                    messageId = messageId,
                    aliases = aliases.ifEmpty { null },
                    runId = event.runId,
                    nativeTurnId = event.nativeTurnId,
                    sequence = event.sequence,
                    generation = generation,
                ),
                quote = quote,
                asset = asset,
                snapshot = MarkCreateSnapshot(text = text, at = event.createdAt),
                color = color,
            ),
        )
        applyWrite(mark)
        return mark
    }

    /** An empty [note] clears it; a null field stays as it is. */
    @Throws(Exception::class)
    suspend fun update(id: String, note: String? = null, color: String? = null): Mark {
        val mark = api.updateMark(id, note = note, color = color)
        applyWrite(mark)
        return mark
    }

    @Throws(Exception::class)
    suspend fun delete(ids: List<String>) {
        if (ids.isEmpty()) return
        api.deleteMarks(ids)
        val gone = ids.toSet()
        val current = _bySession.value
        val touched = current.filterValues { marks -> marks.any { it.id in gone } }.keys
        if (touched.isNotEmpty()) {
            touched.forEach(::overtake)
            _bySession.value = current.mapValues { (sessionId, marks) -> if (sessionId in touched) marks.filterNot { it.id in gone } else marks }
        }
        // A removed mark may have been a project list's only mark for that conversation.
        watchedProjects.keys.toList().forEach(::loadProject)
        _revision.update { it + 1 }
    }

    /** Shows a write at once, before the next poll reads it back. */
    private fun applyWrite(mark: Mark) {
        val current = _bySession.value
        current[mark.sessionId]?.let { marks ->
            overtake(mark.sessionId)
            _bySession.value = current + (mark.sessionId to listOf(mark) + marks.filterNot { it.id == mark.id })
        }
        if (mark.projectId in watchedProjects) {
            _markedSessions.update { it + (mark.projectId to (it[mark.projectId].orEmpty() + mark.sessionId)) }
        }
        _revision.update { it + 1 }
    }

    /** A read in flight for [sessionId] started before a write; its answer must not undo it. */
    private fun overtake(sessionId: String) {
        reads[sessionId]?.let { reads[sessionId] = it + 1 }
    }

    private fun changed() {
        _revision.update { it + 1 }
        watched.keys.toList().forEach(::load)
        watchedProjects.keys.toList().forEach(::loadProject)
    }

    private fun load(sessionId: String) {
        val read = (reads[sessionId] ?: 0) + 1
        reads[sessionId] = read
        scope.launch {
            val page = try {
                withContext(background) { api.marks(MarkListQuery(sessionId = sessionId, limit = 200)) }
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: Throwable) {
                AppLog.log("marks", "read failed ${error::class.simpleName}: ${error.message}")
                return@launch
            }
            if (reads[sessionId] != read || sessionId !in watched) return@launch
            if (_bySession.value[sessionId] != page.marks) _bySession.update { it + (sessionId to page.marks) }
        }
    }

    private fun loadProject(projectId: String) {
        val read = (projectReads[projectId] ?: 0) + 1
        projectReads[projectId] = read
        scope.launch {
            val page = try {
                withContext(background) { api.marks(MarkListQuery(projectId = projectId, limit = 200)) }
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: Throwable) {
                AppLog.log("marks", "project read failed ${error::class.simpleName}: ${error.message}")
                return@launch
            }
            if (projectReads[projectId] != read || projectId !in watchedProjects) return@launch
            val marked = page.marks.mapTo(mutableSetOf()) { it.sessionId }
            if (_markedSessions.value[projectId] != marked) _markedSessions.update { it + (projectId to marked) }
        }
    }
}

/** Every id [item]'s message is known by, as a mark's anchor names it. */
fun markIds(item: TimelineItem): List<String> = listOfNotNull(item.event.nativeId) + item.event.nativeAliases.orEmpty()

/**
 * Answers still being written carry provisional ids (Claude's contain `:run:`), which the
 * transcript replaces once the turn is stored: they cannot be marked.
 */
fun markable(item: TimelineItem): Boolean {
    val id = item.event.nativeId
    return !id.isNullOrEmpty() && ":run:" !in id
}
