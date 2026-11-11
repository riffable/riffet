package riffet.ios

import kotlinx.coroutines.async
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import riffet.ui.state.SessionListState
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class IOSPollBootstrapTest {
    @Test fun aRestoredCacheDoesNotFinishTheInitialNetworkRead() = runTest {
        val list = MutableStateFlow(SessionListState())
        val revoked = MutableStateFlow(false)
        val gate = async { awaitIOSBootstrap(list, revoked) }
        runCurrent()
        assertFalse(gate.isCompleted)

        // restoreList() publishes this state before refresh() marks the network read as loading.
        list.value = SessionListState(loaded = true, cachedAt = 123L)
        runCurrent()
        assertFalse(gate.isCompleted)
        list.value = list.value.copy(loading = true)
        runCurrent()
        assertFalse(gate.isCompleted)

        list.value = list.value.copy(loading = false, cachedAt = null)
        runCurrent()
        assertTrue(gate.await())
    }

    @Test fun aFailedBootstrapWithAStoredCopyAllowsThePollToRecover() = runTest {
        val list = MutableStateFlow(SessionListState(loaded = true, loading = true, cachedAt = 123L))
        val revoked = MutableStateFlow(false)
        val gate = async { awaitIOSBootstrap(list, revoked) }
        runCurrent()
        assertFalse(gate.isCompleted)
        list.value = list.value.copy(loading = false, error = "offline")
        runCurrent()
        assertTrue(gate.await())
    }

    @Test fun revocationDoesNotWaitForAHangingBootstrap() = runTest {
        val list = MutableStateFlow(SessionListState(loading = true))
        val revoked = MutableStateFlow(false)
        val gate = async { awaitIOSBootstrap(list, revoked) }
        runCurrent()
        assertFalse(gate.isCompleted)
        revoked.value = true
        runCurrent()
        assertFalse(gate.await())
    }

    @Test fun foregroundReturnWithAnAlreadyLoadedNetworkListDoesNotWaitAgain() = runTest {
        val gate = async { awaitIOSBootstrap(MutableStateFlow(SessionListState(loaded = true)), MutableStateFlow(false)) }
        runCurrent()
        assertTrue(gate.isCompleted)
        assertTrue(gate.await())
    }
}
