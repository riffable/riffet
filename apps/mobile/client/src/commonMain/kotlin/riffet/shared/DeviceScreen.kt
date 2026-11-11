package riffet.shared

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonObjectBuilder
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/*
 * The screen as the agent sees it (docs/DEVICES.md §3「协议（R3，T1）」): windows of nodes with
 * stable `@eN` refs, bounds on a 0–999 grid, and a diff against the last observation sent. Pure, so
 * the platform only reads its accessibility tree into [ScreenNode]s. The format follows Mika's
 * `UiTreeJson` (Apache-2.0), flattened to the nodes worth naming.
 */

/** One accessibility node as the platform read it, bounds in pixels. [handle] is the platform's own object to act on. */
data class ScreenNode(
    val className: String? = null,
    val text: String? = null,
    val desc: String? = null,
    val hint: String? = null,
    val resourceId: String? = null,
    val left: Int = 0,
    val top: Int = 0,
    val right: Int = 0,
    val bottom: Int = 0,
    val clickable: Boolean = false,
    val longClickable: Boolean = false,
    val editable: Boolean = false,
    val scrollable: Boolean = false,
    val checkable: Boolean = false,
    val checked: Boolean = false,
    val selected: Boolean = false,
    val focused: Boolean = false,
    val enabled: Boolean = true,
    val password: Boolean = false,
    /** An empty field showing its hint as text. */
    val showingHint: Boolean = false,
    val children: List<ScreenNode> = emptyList(),
    val handle: Any? = null,
)

data class ScreenWindow(
    val id: Int,
    /** `app`, `ime`, `system`, `overlay` or `other`. */
    val type: String,
    val packageName: String?,
    val title: String? = null,
    val active: Boolean = false,
    val root: ScreenNode?,
)

/** One read of the main display; [windows] top first. */
data class ScreenRead(val windows: List<ScreenWindow>, val width: Int, val height: Int)

/** A node worth naming, as the agent sees it. [key] identifies it across reads; [label] is what it says. */
data class ScreenElement(
    val ref: String,
    val key: String,
    val windowId: Int,
    val packageName: String?,
    val role: String,
    val text: String?,
    val desc: String?,
    val hint: String?,
    val resourceId: String?,
    /** 0–999 grid: left, top, right, bottom. */
    val bounds: List<Int>,
    val centerX: Int,
    val centerY: Int,
    val parentRef: String?,
    val node: ScreenNode,
) {
    val clickable get() = node.clickable
    val editable get() = node.editable
    val scrollable get() = node.scrollable
    val secret get() = node.password

    /** What it says: its text, else its description. */
    val label: String get() = (text ?: desc ?: "").trim()

    fun json(): JsonObject = buildJsonObject {
        put("ref", ref)
        put("role", role)
        text?.let { put("text", it) }
        desc?.let { put("desc", it) }
        hint?.let { put("hint", it) }
        resourceId?.let { put("resourceId", it) }
        put("bounds", JsonArray(bounds.map(::JsonPrimitive)))
        parentRef?.let { put("in", it) }
        if (node.clickable) put("clickable", true)
        if (node.longClickable) put("longClickable", true)
        if (node.editable) put("editable", true)
        if (node.scrollable) put("scrollable", true)
        if (node.checkable) put("checked", node.checked)
        if (node.selected) put("selected", true)
        if (node.focused) put("focused", true)
        if (!node.enabled) put("disabled", true)
        if (node.password) put("secret", true)
    }
}

data class WindowView(val id: Int, val type: String, val packageName: String?, val title: String?, val active: Boolean)

/** A read with refs assigned. [foreground] is the package of the top app window. */
class ScreenSnapshot(
    val windows: List<WindowView>,
    val elements: List<ScreenElement>,
    val foreground: String?,
    val keyboard: Boolean,
    val width: Int,
    val height: Int,
) {
    val byRef: Map<String, ScreenElement> = elements.associateBy { it.ref }

    /** The top app window: a new one (another activity, a dialog) is a change of place. */
    val topAppWindow: Int? get() = windows.firstOrNull { it.type == "app" }?.id

    val hash: Long by lazy {
        var h = FNV_OFFSET
        for (w in windows) h = fnv(h, "${w.id}|${w.type}|${w.packageName}")
        for (e in elements) h = fnv(h, e.json().toString())
        h
    }

    /** The deepest element under a grid point: clickable first, then any. */
    fun at(x: Int, y: Int): ScreenElement? {
        val hits = elements.filter { x in it.bounds[0]..it.bounds[2] && y in it.bounds[1]..it.bounds[3] }
        val window = hits.firstOrNull()?.windowId
        val top = hits.filter { it.windowId == window }
        return top.lastOrNull { it.clickable } ?: top.lastOrNull()
    }

    /** Text of the elements inside [element] (those naming it as their clickable ancestor). */
    fun innerText(element: ScreenElement): String =
        elements.filter { it.parentRef == element.ref }.mapNotNull { it.label.takeIf(String::isNotEmpty) }.joinToString(" ")

    fun sameWindows(other: ScreenSnapshot): Boolean =
        windows.map { Triple(it.id, it.type, it.packageName) } == other.windows.map { Triple(it.id, it.type, it.packageName) }
}

/** What one action did, read off the trees before and after it. */
object ScreenEffect {
    const val DONE = "done"
    const val SMALL_CHANGE = "small_change"
    const val NO_EFFECT = "no_effect"
    const val PLACE_CHANGED = "place_changed"

    /** At most this many nodes changed is a small change. */
    const val SMALL = 3

    fun of(before: ScreenSnapshot, after: ScreenSnapshot): String {
        if (before.foreground != after.foreground || before.topAppWindow != after.topAppWindow) return PLACE_CHANGED
        if (before.hash == after.hash) return NO_EFFECT
        val old = before.elements.associate { it.key to it.json().toString() }
        val now = after.elements.associate { it.key to it.json().toString() }
        val changed = (old.keys + now.keys).count { old[it] != now[it] }
        return if (changed <= SMALL) SMALL_CHANGE else DONE
    }
}

/**
 * One conversation's view of the screen: refs that stay with a node across reads, and the last
 * observation it was sent, which a later `since` diffs against. Not thread-safe; the executor
 * serialises calls.
 */
class ScreenRefs {
    private val refs = LinkedHashMap<String, String>()
    private var next = 1
    private var sequence = 0

    /** The last snapshot sent to the agent, and its id. */
    var sent: ScreenSnapshot? = null
        private set
    var sentId: String? = null
        private set

    /** Turns a read into a snapshot, reusing the ref of every node seen before. */
    fun snapshot(read: ScreenRead): ScreenSnapshot {
        val elements = mutableListOf<ScreenElement>()
        for (window in read.windows) {
            val root = window.root ?: continue
            walk(window, root, "w${window.id}", null, read, elements, 0)
        }
        if (refs.size > MAX_REFS) {
            val live = elements.mapTo(HashSet()) { it.key }
            refs.keys.retainAll(live)
        }
        val views = read.windows.map { WindowView(it.id, it.type, it.packageName, it.title, it.active) }
        val foreground = read.windows.firstOrNull { it.type == "app" && it.active }?.packageName
            ?: read.windows.firstOrNull { it.type == "app" }?.packageName
        return ScreenSnapshot(views, elements, foreground, read.windows.any { it.type == "ime" }, read.width, read.height)
    }

    private fun walk(window: ScreenWindow, node: ScreenNode, path: String, clickableParent: String?, read: ScreenRead, out: MutableList<ScreenElement>, depth: Int) {
        if (out.size >= MAX_ELEMENTS || depth > MAX_DEPTH) return
        val text = node.text?.takeUnless { node.password || node.showingHint }?.clean()
        val desc = node.desc?.clean()
        val hint = (node.hint ?: node.text?.takeIf { node.showingHint })?.clean()
        val kept = text != null || desc != null || node.clickable || node.longClickable || node.editable || node.scrollable || node.checkable ||
            (hint != null && node.editable)
        var parent = clickableParent
        if (kept) {
            val key = "$path|${node.className}|${node.resourceId}"
            val ref = refs.getOrPut(key) { "@e${next++}" }
            val bounds = listOf(
                grid(node.left, read.width), grid(node.top, read.height),
                grid(node.right, read.width), grid(node.bottom, read.height),
            )
            out += ScreenElement(
                ref = ref, key = key, windowId = window.id, packageName = window.packageName,
                role = role(node.className), text = text, desc = desc, hint = hint?.takeIf { node.editable || text == null },
                resourceId = node.resourceId?.substringAfter(":id/")?.takeIf { it.isNotBlank() },
                bounds = bounds, centerX = (bounds[0] + bounds[2]) / 2, centerY = (bounds[1] + bounds[3]) / 2,
                parentRef = clickableParent, node = node,
            )
            if (node.clickable) parent = ref
        }
        node.children.forEachIndexed { index, child -> walk(window, child, "$path/$index", parent, read, out, depth + 1) }
    }

    /** The observation for the agent: a diff when [since] is the last one sent and the windows held, else everything. Recorded as sent. */
    fun observe(snapshot: ScreenSnapshot, since: String?, extra: JsonObjectBuilder.() -> Unit = {}): JsonObject {
        val base = sent?.takeIf { since != null && since == sentId && it.sameWindows(snapshot) }
        val id = "s${++sequence}"
        val previousId = sentId
        sent = snapshot
        sentId = id
        return buildJsonObject {
            put("untrusted", true)
            put("snapshotId", id)
            snapshot.foreground?.let { put("package", it) }
            extra()
            if (snapshot.keyboard) put("keyboard", true)
            if (base != null) {
                put("base", previousId!!)
                put("diff", diff(base, snapshot))
            } else {
                put("windows", windows(snapshot))
            }
        }
    }

    /** Forgets what was sent, e.g. when the screen is withheld (a blocked app). */
    fun withheld() {
        sent = null
        sentId = null
    }

    private companion object {
        const val MAX_REFS = 5000
        const val MAX_ELEMENTS = 1500
        const val MAX_DEPTH = 80
        const val TEXT_LIMIT = 300
        fun String.clean(): String? = replace(Regex("\\s+"), " ").trim().take(TEXT_LIMIT).takeIf { it.isNotEmpty() }
    }
}

/** Pixels to the 0–999 grid and back; the inverse of each other up to rounding. */
fun grid(pixel: Int, size: Int): Int = if (size <= 1) 0 else min(999, max(0, (pixel * 999.0 / (size - 1)).roundToInt()))

fun pixel(grid: Int, size: Int): Int = if (size <= 1) 0 else min(size - 1, max(0, (grid * (size - 1) / 999.0).roundToInt()))

/** `android.widget.Button` → `button`. */
internal fun role(className: String?): String = className?.substringAfterLast('.')?.lowercase()?.takeIf { it.isNotEmpty() } ?: "view"

internal fun windows(snapshot: ScreenSnapshot): JsonArray = buildJsonArray {
    for (w in snapshot.windows) {
        val nodes = snapshot.elements.filter { it.windowId == w.id }
        if (nodes.isEmpty() && w.type != "app") continue
        add(buildJsonObject {
            put("id", w.id)
            put("type", w.type)
            w.packageName?.let { put("package", it) }
            w.title?.takeIf { it.isNotBlank() }?.let { put("title", it) }
            if (w.active) put("active", true)
            put("nodes", JsonArray(nodes.map { it.json() }))
        })
    }
}

internal fun diff(before: ScreenSnapshot, after: ScreenSnapshot): JsonObject {
    val old = before.elements.associate { it.ref to it.json() }
    val added = buildJsonArray { after.elements.filter { it.ref !in old }.forEach { add(it.json()) } }
    val changed = buildJsonArray { after.elements.filter { it.ref in old && old[it.ref] != it.json() }.forEach { add(it.json()) } }
    val removed = buildJsonArray { before.elements.filter { it.ref !in after.byRef }.forEach { add(JsonPrimitive(it.ref)) } }
    return buildJsonObject {
        put("added", added)
        put("changed", changed)
        put("removed", removed)
    }
}

private const val FNV_OFFSET = -0x340d631b7bdddcdbL
private const val FNV_PRIME = 0x100000001b3L

private fun fnv(seed: Long, value: String): Long {
    var h = seed
    for (c in value) {
        h = h xor c.code.toLong()
        h *= FNV_PRIME
    }
    // A separator, so "ab"+"c" and "a"+"bc" differ.
    return (h xor 0x1fL) * FNV_PRIME
}

/** A stable 64-bit FNV-1a hash as hex; for content matching, not for secrecy. */
fun contentHash(text: String): String = fnv(FNV_OFFSET, text.trim()).toULong().toString(16)
