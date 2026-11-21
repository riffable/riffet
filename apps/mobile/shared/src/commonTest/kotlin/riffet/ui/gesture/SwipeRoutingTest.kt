package riffet.ui.gesture

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertSame

/** The routing table behind every horizontal swipe (innermost surface first). */
class SwipeRoutingTest {
    private val noDrag = object : SwipeDrag {
        override fun drag(delta: Float) = Unit
        override fun release(velocity: Float) = Unit
        override fun cancel() = Unit
    }
    private val tabs = SwipeVerdict.Take { noDrag }
    private val drawer = SwipeVerdict.Take { noDrag }
    private val edgeBack = SwipeVerdict.Take(overChildren = true) { noDrag }
    private val back = SwipeVerdict.Take { noDrag }

    private fun taken(vararg verdicts: SwipeVerdict) = (routeSwipe(verdicts.toList()) as? SwipeRoute.Surface)?.take

    @Test
    fun theInnermostSurfaceThatTakesItWins() {
        // A tab root: nothing inside takes it, the tabs before the drawers.
        assertSame(tabs, taken(SwipeVerdict.Pass, tabs, drawer))
        // The first tab passes a rightward swipe on to the drawer.
        assertSame(drawer, taken(SwipeVerdict.Pass, SwipeVerdict.Pass, drawer))
    }

    @Test
    fun aCoveringPageThatRefusesStopsEverythingBeneathIt() {
        assertEquals(SwipeRoute.Nobody, routeSwipe(listOf(SwipeVerdict.Refuse, tabs, drawer)))
        // Nobody outside takes it either: swallowed, not left to land as a tap.
        assertEquals(SwipeRoute.Nobody, routeSwipe(listOf(SwipeVerdict.Pass, SwipeVerdict.Pass)))
    }

    @Test
    fun aChildKeepsItUnlessAnEdgeSwipeTakesIt() {
        assertEquals(SwipeRoute.Child, routeSwipe(listOf(SwipeVerdict.Child, back, drawer)))
        assertEquals(SwipeRoute.Child, routeSwipe(listOf(SwipeVerdict.Child, SwipeVerdict.Refuse)))
        assertSame(edgeBack, taken(SwipeVerdict.Child, edgeBack, drawer))
        // A scroller at its start passes, and the page beneath takes it.
        assertSame(back, taken(SwipeVerdict.Pass, back))
    }

    @Test
    fun aBlockAnywhereOnThePathWins() {
        assertEquals(SwipeRoute.Blocked, routeSwipe(listOf(tabs, SwipeVerdict.Block)))
        assertEquals(SwipeRoute.Blocked, routeSwipe(listOf(SwipeVerdict.Block, edgeBack)))
    }
}
