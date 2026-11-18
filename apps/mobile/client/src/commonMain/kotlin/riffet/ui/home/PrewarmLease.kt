package riffet.ui.home

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import riffet.contracts.PREWARM_BUDGET_RENEW_MS
import riffet.contracts.PREWARM_BUDGET_START_DELAY_MS
import riffet.shared.PrewarmBody
import riffet.shared.PrewarmReleaseBody
import riffet.shared.RiffetApi
import riffet.shared.prewarm
import riffet.shared.releasePrewarm

/**
 * Holds a warm CLI for the new-task page's choice, as the web page does (`ProjectHome.tsx`). A CLI takes
 * seconds to start, longer than most first messages take to write. While the page shows an Agent that
 * keeps one (`supportsPrewarm`), it is asked for when the page opens, renewed while the page stays open,
 * and released when the page closes or the choice changes; a send hands it to the new conversation
 * instead. The server ends one whose page vanished on its own, after its lease runs out.
 *
 * Each page holds its own; calls may come from any thread, and the state is kept on one.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class PrewarmLease {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default.limitedParallelism(1))
    private var held: PrewarmBody? = null
    private var api: RiffetApi? = null
    private var job: Job? = null
    /** The warm CLI the server last answered with. */
    private var claimId: String? = null
    /** The one a send handed to the new conversation, which claims it; never released from here. */
    private var handedOff: String? = null
    /** A send came before the first answer: that answer is the conversation's. */
    private var handOffPending = false

    /** The page shows [body]'s choice, on [api]'s server; null when it shows an Agent that keeps no warm CLI. */
    fun hold(api: RiffetApi?, body: PrewarmBody?) {
        scope.launch { holdNow(api, body.takeIf { api != null }) }
    }

    /** The page sent its first message: the warm CLI is now the new conversation's. */
    fun sent() {
        scope.launch { if (claimId != null) handedOff = claimId else handOffPending = true }
    }

    /** The send failed; the warm CLI stays the page's. */
    fun sendFailed() {
        scope.launch { handedOff = null; handOffPending = false }
    }

    /** The page closed. */
    fun close() = hold(null, null)

    private fun holdNow(api: RiffetApi?, body: PrewarmBody?) {
        if (body == held && api === this.api) return
        release()
        held = body
        this.api = api
        if (api == null || body == null) return
        job = scope.launch {
            delay(PREWARM_BUDGET_START_DELAY_MS.toLong())
            while (isActive) {
                // A renewal names the page's warm CLI: it never takes the one slot from another page.
                val next = runCatching { api.prewarm(body.copy(claimId = claimId)) }.getOrNull()?.claimId
                if (next != null) {
                    if (handOffPending) { handedOff = next; handOffPending = false }
                    claimId = next
                }
                delay(PREWARM_BUDGET_RENEW_MS.toLong())
            }
        }
    }

    private fun release() {
        job?.cancel()
        job = null
        val id = claimId
        val body = held
        val api = api
        claimId = null
        if (id == null || body == null || api == null || id == handedOff) return
        scope.launch { runCatching { api.releasePrewarm(PrewarmReleaseBody(claimId = id, backendId = body.backendId, agentId = body.agentId)) } }
    }
}
