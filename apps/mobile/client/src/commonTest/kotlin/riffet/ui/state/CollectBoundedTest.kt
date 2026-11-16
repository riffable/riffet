package riffet.ui.state

import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/** A consumer that falls behind loses its queue, so the caller can resume from what it applied (performance.md §3.2). */
class CollectBoundedTest {
    @Test
    fun aSlowConsumerKeepsAnUnbrokenPrefixThenOverflows() = runTest {
        val seen = mutableListOf<Int>()
        var emitted = 0
        // Paced at first, so the consumer keeps up; then a burst it cannot drain.
        val source = flow {
            repeat(1_000) {
                if (it < 10) delay(5)
                emitted += 1
                emit(it)
            }
        }
        val overflowed = source.collectBounded(4) { seen += it; delay(1) }
        assertTrue(overflowed)
        assertTrue(seen.size >= 5, "the paced frames were applied: $seen")
        assertEquals((0 until seen.size).toList(), seen)
        assertTrue(emitted < 1_000, "the upstream stopped at the overflow, emitted $emitted")
    }

    @Test
    fun aQueueOverItsByteCeilingOverflows() = runTest {
        val seen = mutableListOf<Int>()
        val overflowed = flow { repeat(100) { emit(it) } }.collectBounded(64, maxBytes = 10, weigh = { 4 }) { seen += it; delay(1) }
        assertTrue(overflowed)
        assertEquals((0 until seen.size).toList(), seen)
    }

    @Test
    fun aFlowThatFitsIsDeliveredWholeAndInOrder() = runTest {
        val seen = mutableListOf<Int>()
        assertEquals(false, flowOf(1, 2, 3).collectBounded(4) { seen += it; delay(1) })
        assertEquals(listOf(1, 2, 3), seen)
    }

    @Test
    fun anErrorArrivesAfterTheFramesBeforeIt() = runTest {
        val seen = mutableListOf<Int>()
        assertFailsWith<IllegalStateException> {
            flow { emit(1); emit(2); error("boom") }.collectBounded(4) { seen += it }
        }
        assertEquals(listOf(1, 2), seen)
    }
}
