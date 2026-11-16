package riffet.android

import android.os.Debug
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import riffet.contracts.ClientCacheSample
import riffet.contracts.ClientMetricsReport
import riffet.contracts.ClientMetricsSample
import riffet.shared.AppLog
import riffet.shared.RiffetApi
import riffet.shared.reportClientMetrics
import riffet.ui.platform.CacheRegistry

/**
 * The app's PSS, Java heap and registered caches for the service monitor every five minutes while
 * it is in front (docs/guide/performance.md §4). Numbers and cache names only; a failed report is
 * not retried.
 */
internal object MetricsReporter {
    private const val INTERVAL_MILLIS = 5 * 60_000L

    fun run(scope: CoroutineScope, inFront: StateFlow<Boolean>, api: () -> RiffetApi?): Job = scope.launch {
        inFront.collectLatest { front ->
            while (front) {
                delay(INTERVAL_MILLIS)
                api()?.let { report(it) }
            }
        }
    }

    private suspend fun report(api: RiffetApi) {
        val runtime = Runtime.getRuntime()
        // Debug.getPss walks the process's mappings: off the main thread.
        val pss = withContext(Dispatchers.Default) { Debug.getPss() * 1024L }
        val sample = ClientMetricsSample(
            footprintBytes = pss,
            managedHeapBytes = runtime.totalMemory() - runtime.freeMemory(),
            caches = CacheRegistry.snapshot().map { ClientCacheSample(it.name, bytes = it.sizeBytes(), limitBytes = it.limitBytes) },
        )
        try {
            api.reportClientMetrics(ClientMetricsReport("app", "android", BuildConfig.VERSION_NAME, sample))
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (error: Throwable) {
            AppLog.log("metrics", "report failed ${error::class.simpleName}")
        }
    }
}
