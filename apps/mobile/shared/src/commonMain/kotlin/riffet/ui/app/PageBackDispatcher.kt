package riffet.ui.app

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.backhandler.BackHandler

internal interface PageBackTarget {
    fun start() {}
    fun progress(amount: Float, fromLeft: Boolean) {}
    fun cancel() {}
    fun request()
}

/** A back step that is not a layer (e.g. leaving search): it never stops the drawers' swipe. */
internal interface InlineBackTarget : PageBackTarget

/**
 * The deepest visible page wins; at the same depth the latest registration does, so a drawer opened
 * over a page's own back step (search, say) closes first. A system gesture pins its target until
 * finish/cancel.
 */
@Stable
internal class PageBackDispatcher {
    private data class Registration(val target: PageBackTarget, val depth: Int)
    private val registrations = mutableStateListOf<Registration>()
    private var gestureTarget by mutableStateOf<PageBackTarget?>(null)
    val current: PageBackTarget? get() = registrations.lastOrNull { entry -> registrations.none { it.depth > entry.depth } }?.target
    val canGoBack: Boolean get() = current != null
    fun isGestureTarget(target: PageBackTarget): Boolean = gestureTarget === target

    fun register(target: PageBackTarget, depth: Int) { registrations += Registration(target, depth) }
    fun unregister(target: PageBackTarget) {
        registrations.removeAll { it.target === target }
        if (gestureTarget === target) { target.cancel(); gestureTarget = null }
    }
    fun begin() { cancel(); gestureTarget = current; gestureTarget?.start() }
    fun progress(amount: Float, fromLeft: Boolean) { gestureTarget?.progress(amount, fromLeft) }
    fun finish() {
        val target = gestureTarget
        gestureTarget = null
        if (registrations.any { it.target === target }) target?.request()
    }
    fun cancel() { gestureTarget?.cancel(); gestureTarget = null }
}

internal val LocalPageBackDispatcher = staticCompositionLocalOf<PageBackDispatcher?> { null }
// Flips on every push and pop: only its readers recompose, not the whole covered page.
internal val LocalPageActive = compositionLocalOf { true }
internal val LocalPageDepth = staticCompositionLocalOf { 0 }
internal val LocalPageBack = staticCompositionLocalOf<PageBackState?> { null }

@Composable
internal fun RegisterPageBackTarget(target: PageBackTarget, enabled: Boolean) {
    val active = LocalPageActive.current
    val dispatcher = LocalPageBackDispatcher.current
    val depth = LocalPageDepth.current
    DisposableEffect(dispatcher, target, enabled && active, depth) {
        if (enabled && active) dispatcher?.register(target, depth)
        onDispose { dispatcher?.unregister(target) }
    }
    // Standalone previews and a future host without the Android adapter still get ordinary back.
    BackHandler(enabled = enabled && active && dispatcher == null, onBack = target::request)
}

/**
 * A transient state (e.g. an open drawer) takes precedence over its enclosing page. [inline] marks a
 * step inside the page itself rather than a layer over it (see [InlineBackTarget]).
 */
@Composable
internal fun PageBackHandler(enabled: Boolean = true, inline: Boolean = false, onBack: () -> Unit): PageBackTarget {
    val callback = rememberUpdatedState(onBack)
    val target = remember(inline) {
        if (inline) object : InlineBackTarget { override fun request() { callback.value() } }
        else object : PageBackTarget { override fun request() { callback.value() } }
    }
    val dispatcher = LocalPageBackDispatcher.current
    val depth = LocalPageDepth.current + 1
    val active = LocalPageActive.current
    DisposableEffect(dispatcher, target, enabled && active, depth) {
        if (enabled && active) dispatcher?.register(target, depth)
        onDispose { dispatcher?.unregister(target) }
    }
    BackHandler(enabled = enabled && active && dispatcher == null, onBack = target::request)
    return target
}
