package riffet.ui.app

import androidx.compose.runtime.Stable
import androidx.compose.runtime.mutableStateListOf

/** A visit has its own identity, even when the same route is opened twice. */
internal data class PageEntry<T>(val id: Long, val route: T)

/** Retained page history. Only explicit navigation changes it; a cancelled gesture never does. */
@Stable
internal class PageStack<T>(root: T) {
    private var nextId = 1L
    private val history = mutableStateListOf(PageEntry(0L, root))
    val entries: List<PageEntry<T>> get() = history.toList()
    val current: T get() = history.last().route
    val canPop: Boolean get() = history.size > 1

    fun push(route: T) {
        history += PageEntry(nextId++, route)
    }

    fun pop(): Boolean {
        if (!canPop) return false
        history.removeAt(history.lastIndex)
        return true
    }

    /** Refresh the current page's data without creating a second navigation step. */
    fun replace(route: T) {
        val current = history.last()
        history[history.lastIndex] = current.copy(route = route)
    }

    fun reset(root: T = history.first().route) {
        history.clear()
        history += PageEntry(nextId++, root)
    }

    /** Close overlays while retaining the workbench visit underneath them. */
    fun popToRoot() {
        while (canPop) pop()
    }

    /** Breadcrumb navigation reuses an existing ancestor, including its scroll state. */
    fun popTo(predicate: (T) -> Boolean): Boolean {
        val index = history.indexOfLast { predicate(it.route) }
        if (index < 0) return false
        while (history.size > index + 1) history.removeAt(history.lastIndex)
        return true
    }

    /** Close this visit and everything opened from it. */
    fun removeFrom(predicate: (T) -> Boolean) {
        val index = history.indexOfFirst { predicate(it.route) }
        if (index > 0) while (history.size > index) history.removeAt(history.lastIndex)
    }

    fun contains(predicate: (T) -> Boolean): Boolean = history.any { predicate(it.route) }
}

/** Values are in screen widths and dp/second, so the decision is independent of screen density. */
internal fun completesBackSwipe(progress: Float, velocity: Float): Boolean = when {
    velocity < -500f -> false
    velocity > 500f -> progress >= 0.05f
    else -> progress >= 0.33f
}
