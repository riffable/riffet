package riffet.ui.app

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.util.VelocityTracker
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import riffet.shared.LocalNativeFeatures
import riffet.shared.NativeFeature
import riffet.shared.PageAnimation
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.design.InterfaceStyleTokens
import riffet.ui.design.interfaceStyleTokens
import riffet.ui.timeline.rememberReducedMotion
import riffet.ui.theme.LocalRiffetPageMotion
import riffet.ui.theme.RiffetPageMotion
import kotlin.math.abs

internal enum class PageSwipeMode { FULL, EDGE, NONE }

/**
 * Content below a pushed page waits for every enclosing transition before mounting costly UI.
 * Only its readers recompose when the transition ends, not the whole page.
 */
internal val LocalPageContentReady = compositionLocalOf { true }

/**
 * A page's body: composed once every enclosing transition has finished, then briefly faded in
 * when page motion is enabled. A body ready on its first frame (a root page, a page
 * returned to, a page built under another) shows at once. [RiffetPageScaffold] wraps its body in
 * this; pages without the scaffold wrap their own.
 */
@Composable
internal fun PageBody(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    val ready = LocalPageContentReady.current
    val pageMotion = LocalRiffetPageMotion.current
    val reduced = rememberReducedMotion()
    val progress = remember { Animatable(if (ready) 0f else 1f) }
    LaunchedEffect(ready, pageMotion, reduced) {
        if (ready && progress.value > 0f) {
            if (reduced || !pageMotion.enabled) progress.snapTo(0f)
            else progress.animateTo(0f, pageMotion.motion.short())
        }
    }
    Box(modifier.graphicsLayer {
        val value = if (reduced) 0f else progress.value
        alpha = pageMotion.revealAlpha(value)
    }) {
        if (ready) content()
    }
}

/** A system back preview shrinks the page to this scale before it is let go. */
private const val PREVIEW_SCALE = 0.9f

/**
 * One page visit's motion. Three independent amounts, all 0 at rest:
 *  - [entering]: 1 → 0 while a pushed page enters with the device's page motion;
 *  - [amount]: the page's exit progress, following a finger or a tapped back;
 *  - [preview]: the system back gesture's progress, shown as Android's predictive back (the page
 *    shrinks toward the gesture's edge with rounded corners) rather than as a slide, so it reads as
 *    the platform's own gesture. A completed preview then slides the shrunken page out.
 */
@Stable
internal class PageBackState(private val scope: CoroutineScope, enterFromRight: Boolean = false) : PageBackTarget {
    var amount by mutableStateOf(0f)
        private set
    // The first composition must already be offscreen; moving it there in an effect flashes the page.
    var entering by mutableStateOf(if (enterFromRight) 1f else 0f)
        private set
    var preview by mutableStateOf(0f)
        private set
    var previewFromLeft by mutableStateOf(true)
        private set
    var dragging by mutableStateOf(false)
        private set
    var settling by mutableStateOf(false)
        private set
    var style: InterfaceStyleTokens = interfaceStyleTokens()
    var pageMotion by mutableStateOf(RiffetPageMotion())
    var reduced = false
    // Direct manipulation always follows the finger, regardless of the tapped navigation effect.
    var swiping by mutableStateOf(false)
        private set
    val slides: Boolean get() = swiping || preview > 0f || pageMotion.animation == PageAnimation.SLIDE
    var onBack: () -> Unit = {}
    var clearFocus: () -> Unit = {}
    var allowBack: () -> Boolean = { true }
    private var animation: Job? = null
    private var previewAnimation: Job? = null

    /** How much of the page is off screen: 0 covers whatever is underneath, 1 reveals it fully. */
    val revealed: Float get() = maxOf(amount, entering)

    suspend fun enter() {
        val motion = style.motion
        if (reduced || !pageMotion.enabled) { entering = 0f; return }
        if (entering == 0f) return
        val value = Animatable(entering)
        value.animateTo(0f, tween(style.pageEnterMillis, easing = motion.EmphasizedDecelerate)) { entering = this.value }
        entering = 0f
    }

    override fun start() {
        if (settling || entering > 0f) return
        animation?.cancel()
        previewAnimation?.cancel()
        swiping = false
        dragging = true
    }

    /** The system gesture. The in-app swipe moves the page itself through [drag]. */
    override fun progress(amount: Float, fromLeft: Boolean) {
        if (!dragging) return
        previewFromLeft = fromLeft
        preview = amount.coerceIn(0f, 1f)
    }

    fun drag(amount: Float) {
        if (dragging) {
            swiping = true
            this.amount = amount.coerceIn(0f, 1f)
        }
    }

    /** Only a gesture this page took can be cancelled; a tapped back that is settling keeps going. */
    override fun cancel() {
        if (dragging) release(0f, back = false)
    }

    override fun request() {
        if (settling) return
        dragging = false
        if (!allowBack()) { settle(0f, 0f); unpreview(); return }
        leaveConfirmed()
    }

    /** A let-go swipe, [velocity] in screen widths per second: back if it went far or fast enough. */
    fun release(velocity: Float, back: Boolean) {
        dragging = false
        if (back) { if (allowBack()) { clearFocus(); settle(1f, velocity, onBack) } else settle(0f, 0f) }
        else { settle(0f, velocity); unpreview() }
    }

    fun leaveConfirmed() {
        dragging = false
        clearFocus()
        // A tap has no velocity to continue; use the page's exit timing rather than a spring's tail.
        settle(1f, null, onBack)
    }

    private fun settle(target: Float, velocity: Float?, after: () -> Unit = {}) {
        val motion = style.motion
        animation?.cancel()
        if (reduced || !pageMotion.enabled) {
            amount = target
            swiping = false
            settling = false
            after()
            return
        }
        animation = scope.launch {
            settling = true
            try {
                if (!reduced) {
                    val value = Animatable(amount)
                    if (velocity == null) value.animateTo(target, tween(style.pageExitMillis, easing = motion.Standard)) { amount = this.value }
                    else value.animateTo(target, motion.settle(), initialVelocity = velocity) { amount = this.value }
                }
                amount = target
                after()
            } finally {
                settling = false
                swiping = false
            }
        }
    }

    private fun unpreview() {
        val motion = style.motion
        if (preview == 0f) return
        previewAnimation?.cancel()
        if (reduced || !pageMotion.enabled) { preview = 0f; return }
        previewAnimation = scope.launch {
            if (!reduced) Animatable(preview).animateTo(0f, motion.settle()) { preview = this.value }
            preview = 0f
        }
    }
}

/**
 * Keeps each visited page mounted until it is popped. Previous pages retain drafts and scroll;
 * inactive pages neither handle back nor expose accessibility nodes, focus, or pointer events.
 * A covered page sits a quarter width to the left under a light scrim and follows the page above
 * it back into place, so pushing and returning read as one sheet sliding over another.
 */
@Composable
internal fun <T> PageHost(
    stack: PageStack<T>,
    modifier: Modifier = Modifier,
    swipeMode: (T) -> PageSwipeMode = { PageSwipeMode.FULL },
    content: @Composable (T, () -> Unit) -> Unit,
) {
    val entries = stack.entries
    val active = LocalPageActive.current
    val depth = LocalPageDepth.current
    // Inside a tab, a pushed page takes the bar away (see [TabChrome]).
    val chrome = LocalTabChrome.current
    if (chrome != null && entries.size > 1) {
        DisposableEffect(chrome) {
            chrome.pushed += 1
            onDispose { chrome.pushed -= 1 }
        }
    }
    // Entries already on the stack when the host appears (a restored folder, a handed-over preview)
    // are where it opens: none slides in, and those beneath the top are built after it has shown.
    val initial = remember(stack) { entries.mapTo(HashSet()) { it.id } }
    val unbuilt = remember(stack) { entries.dropLast(1).mapTo(mutableStateListOf()) { it.id } }
    val parentReady by rememberUpdatedState(LocalPageContentReady.current)
    val motion = LocalInterfaceStyle.current.motion
    if (unbuilt.isNotEmpty()) LaunchedEffect(unbuilt) {
        snapshotFlow { parentReady }.first { it }
        // After the top page's body has faded in, so building them does not stutter the fade.
        delay(motion.SHORT * 2L)
        // One page a frame, nearest the top first: it is the one a back gesture reveals.
        while (unbuilt.isNotEmpty()) {
            withFrameNanos { }
            unbuilt.removeAt(unbuilt.lastIndex)
        }
    }
    val states = entries.mapIndexed { index, entry -> key(entry.id) { rememberPageBackState(animateEntrance = index > 0 && entry.id !in initial) } }
    Box(modifier.fillMaxSize()) {
        entries.forEachIndexed { index, entry ->
            key(entry.id) {
                val top = index == entries.lastIndex
                CompositionLocalProvider(
                    LocalPageActive provides (active && top),
                    LocalPageDepth provides (depth + 1),
                    LocalTabMenu provides LocalTabMenu.current?.takeIf { index == 0 },
                ) {
                    SwipeBackPage(
                        canGoBack = index > 0,
                        onBack = { if (stack.entries.lastOrNull()?.id == entry.id) stack.pop() },
                        mode = swipeMode(entry.route),
                        state = states[index],
                        cover = states.getOrNull(index + 1),
                        deferred = entry.id in unbuilt,
                        onBuilt = { unbuilt.remove(entry.id) },
                    ) { back -> content(entry.route, back) }
                }
            }
        }
    }
}

@Composable
internal fun rememberPageBackState(animateEntrance: Boolean): PageBackState {
    val scope = rememberCoroutineScope()
    val reduced = rememberReducedMotion()
    val style = LocalInterfaceStyle.current
    val pageMotion = LocalRiffetPageMotion.current
    return remember { PageBackState(scope, enterFromRight = animateEntrance && !reduced && pageMotion.enabled) }.also {
        it.reduced = reduced
        it.style = style
        it.pageMotion = pageMotion
    }
}

/**
 * The parallax and scrim a covered surface shows under [cover], the page above it. Shared with the
 * tabs under an open session, which are not a [PageHost] entry.
 *
 * The shift only plays while the page above is sliding (in, out, or under a finger). At rest it is
 * fully covered and sits in place, so a system back preview, which shrinks the page above instead of
 * sliding it, reveals this page whole rather than a shifted one with a bare strip beside it. The
 * scrim is drawn outside the shift for the same reason.
 */
@Composable
internal fun Modifier.coveredBy(cover: PageBackState?): Modifier {
    if (cover == null) return this
    val scrim = MaterialTheme.colorScheme.scrim
    return drawWithContent {
        drawContent()
        val covered = (1f - cover.revealed) * (1f - cover.preview * 0.5f)
        if (covered > 0f) drawRect(scrim, alpha = cover.style.coveredPageDim * covered)
    }.graphicsLayer {
        val sliding = cover.slides && cover.revealed > 0f && cover.preview == 0f
        translationX = if (sliding) -size.width * cover.style.coveredPageShift * (1f - cover.revealed) else 0f
    }
}

/** Also wraps the session: its root is the session list rather than another stack entry. */
@Composable
internal fun SwipeBackPage(
    canGoBack: Boolean,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
    mode: PageSwipeMode = PageSwipeMode.FULL,
    animateEntrance: Boolean = false,
    state: PageBackState = rememberPageBackState(animateEntrance),
    /** The page above this one, if any: this page shifts and dims under it. */
    cover: PageBackState? = null,
    /** Leaves [content] out until this page is active or [cover] starts to leave it; [onBuilt] then ends the deferral. */
    deferred: Boolean = false,
    onBuilt: () -> Unit = {},
    content: @Composable (() -> Unit) -> Unit,
) {
    val callback = rememberUpdatedState(onBack)
    val focus = LocalFocusManager.current
    val active = LocalPageActive.current
    val parentReady = LocalPageContentReady.current
    val dispatcher = LocalPageBackDispatcher.current
    val colors = LocalRiffetColors.current
    val gestures = LocalNativeFeatures.current.isOn(NativeFeature.SWIPE_BACK)
    state.onBack = { callback.value() }
    state.clearFocus = { focus.clearFocus() }
    RegisterPageBackTarget(state, canGoBack)
    LaunchedEffect(state, state.pageMotion, state.reduced) { state.enter() }
    val canDrag = rememberUpdatedState(active && canGoBack && gestures && mode != PageSwipeMode.NONE)
    val contentReady by remember(state, parentReady) { derivedStateOf { parentReady && state.entering == 0f } }
    val uncovering by remember(cover) {
        derivedStateOf { cover != null && (cover.dragging || cover.settling || cover.revealed > 0f || cover.preview > 0f) }
    }
    val built = !deferred || active || uncovering
    if (deferred && built) SideEffect { onBuilt() }

    BoxWithConstraints(modifier.fillMaxSize()) {
        val widthPx = constraints.maxWidth.toFloat().coerceAtLeast(1f)
        val density = LocalDensity.current.density
        val edgePx = 24f * density
        // This sibling sits above the entire previous page, including the exposed strip. It also
        // prevents a covered page from catching a drag when the foreground rejects the gesture.
        if (active) {
            Box(Modifier.fillMaxSize().pointerInput(Unit) {
                awaitEachGesture {
                    awaitFirstDown(requireUnconsumed = false)
                    do {
                        val event = awaitPointerEvent()
                        event.changes.forEach { it.consume() }
                    } while (event.changes.any { it.pressed })
                }
            })
        }
        val accessibility = if (active) Modifier else Modifier.clearAndSetSemantics { }
        // Track the pointer in the stationary parent. Measuring on the translated page subtracts
        // its own movement from the next event and makes the page lag behind the finger.
        Box(
            Modifier.fillMaxSize().pointerInput(state, mode, widthPx, density) {
                awaitEachGesture {
                    val down = awaitFirstDown(requireUnconsumed = false)
                    if (!canDrag.value || state.settling || state.entering > 0f) return@awaitEachGesture
                    if (dispatcher != null && dispatcher.current !== state) return@awaitEachGesture
                    val edge = down.position.x <= edgePx
                    if (mode == PageSwipeMode.EDGE && !edge) return@awaitEachGesture
                    // Edge swipes own the edge; elsewhere children (pager, selection, horizontal
                    // scrolling) see the Main pass first and can keep their gesture.
                    val pass = if (edge) PointerEventPass.Initial else PointerEventPass.Main
                    val tracker = VelocityTracker()
                    tracker.addPosition(down.uptimeMillis, down.position)
                    var locked = false
                    var origin = down.position
                    try {
                        while (true) {
                            val event = awaitPointerEvent(pass)
                            val change = event.changes.firstOrNull { it.id == down.id } ?: break
                            if (event.changes.count { it.pressed } > 1 || (!edge && change.isConsumed)) break
                            tracker.addPosition(change.uptimeMillis, change.position)
                            val delta = change.position - down.position
                            if (!locked) {
                                if (!change.pressed) break
                                if (abs(delta.y) > viewConfiguration.touchSlop && abs(delta.y) >= abs(delta.x)) break
                                if (delta.x < -viewConfiguration.touchSlop) break
                                if (delta.x <= viewConfiguration.touchSlop || delta.x < abs(delta.y) * 1.2f) continue
                                locked = true
                                origin = down.position.copy(x = down.position.x + viewConfiguration.touchSlop)
                                state.start()
                            }
                            change.consume()
                            state.drag((change.position.x - origin.x) / widthPx)
                            if (!change.pressed) {
                                val velocity = tracker.calculateVelocity().x
                                state.release(velocity / widthPx, back = completesBackSwipe(state.amount, velocity / density))
                                locked = false
                                break
                            }
                        }
                    } finally {
                        if (locked) state.cancel()
                    }
                }
            },
        ) {
            val corner = with(LocalDensity.current) { PreviewCorner.toPx() }
            val edgeShift = with(LocalDensity.current) { (widthPx / 20f - 8.dp.toPx()).coerceAtLeast(0f) }
            Box(Modifier.fillMaxSize().then(accessibility).focusProperties { canFocus = active }.graphicsLayer {
                val preview = state.preview
                val revealed = state.revealed
                val pageMotion = state.pageMotion
                val sliding = state.slides
                translationX = if (sliding) widthPx * revealed else pageMotion.translation(revealed, widthPx)
                alpha = if (sliding) 1f else pageMotion.alpha(revealed)
                scaleX = if (sliding) 1f else pageMotion.scale(revealed)
                scaleY = scaleX
                shape = RectangleShape
                clip = false
                if (preview > 0f) {
                    val scale = 1f - (1f - PREVIEW_SCALE) * preview
                    scaleX = scale
                    scaleY = scale
                    translationX += (if (state.previewFromLeft) 1f else -1f) * edgeShift * preview
                    shape = RoundedCornerShape(corner * preview)
                    clip = true
                }
                shadowElevation = if (revealed > 0f || preview > 0f) 8.dp.toPx() else 0f
            }.coveredBy(cover).pageBackground(colors.bg)) {
                if (built) CompositionLocalProvider(LocalPageBack provides state, LocalPageContentReady provides contentReady) {
                    TraceLifecycle("page")
                    content(state::request)
                }
                // A second finger, accessibility action or tap cannot act on a page while it settles.
                if (active && (state.dragging || state.settling || state.entering > 0f)) {
                    Box(Modifier.fillMaxSize().pointerInput(Unit) {
                        awaitEachGesture {
                            awaitFirstDown(requireUnconsumed = false)
                            do {
                                val event = awaitPointerEvent(PointerEventPass.Initial)
                                event.changes.forEach { it.consume() }
                            } while (event.changes.any { it.pressed })
                        }
                    })
                }
            }
        }
    }
}

/** The corner a page reaches at the end of a system back preview. */
private val PreviewCorner = 28.dp

/** Install a page's unsaved/in-flight guard for every way of returning, including the title bar. */
@Composable
internal fun PageLeaveGuard(allowLeave: () -> Boolean) {
    val state = LocalPageBack.current
    val callback = rememberUpdatedState(allowLeave)
    DisposableEffect(state) {
        state?.allowBack = { callback.value() }
        onDispose { state?.allowBack = { true } }
    }
}
