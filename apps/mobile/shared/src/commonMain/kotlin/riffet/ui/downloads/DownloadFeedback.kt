package riffet.ui.downloads

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import kotlinx.coroutines.Job
import org.jetbrains.compose.resources.getString
import riffet_mobile.shared.generated.resources.*
import riffet.shared.APK_MIME_TYPE
import riffet.shared.DownloadCenter
import riffet.shared.DownloadState
import riffet.shared.RiffetApi
import riffet.shared.downloadMimeType
import riffet.shared.openDownload
import riffet.ui.app.LocalRiffetSnackbar

/** A download's latest state replaces its own pending feedback in the shared snackbar queue. */
@Composable
internal fun DownloadFeedback(
    api: RiffetApi?,
    downloadsVisible: Boolean,
    onOpenDownloads: () -> Unit,
    center: DownloadCenter = DownloadCenter.shared,
) {
    val snackbar = LocalRiffetSnackbar.current ?: return
    val latestApi by rememberUpdatedState(api)
    val latestVisible by rememberUpdatedState(downloadsVisible)
    val latestOpenDownloads by rememberUpdatedState(onOpenDownloads)
    LaunchedEffect(center, snackbar) {
        val pending = mutableMapOf<String, Job>()
        try {
            center.events.collect { event ->
                pending.entries.removeAll { it.value.isCompleted }
                val item = event.item
                val name = if (item.name.isBlank()) getString(Res.string.downloads_unnamed_file) else item.name
                pending.remove(item.id)?.cancel()
                pending[item.id] = when (item.state) {
                    DownloadState.RUNNING -> snackbar.show(
                        getString(Res.string.downloads_started, name),
                        actionLabel = if (latestVisible) null else getString(Res.string.downloads_view),
                        onAction = { latestOpenDownloads() },
                    )
                    DownloadState.SAVED -> {
                        val openFailed = getString(Res.string.downloads_open_list_failed)
                        val viewLabel = getString(Res.string.downloads_view)
                        snackbar.show(
                            getString(Res.string.downloads_completed, name),
                            actionLabel = if (downloadMimeType(item.name, item.mimeType) == APK_MIME_TYPE) getString(Res.string.downloads_install) else getString(Res.string.downloads_open),
                            onAction = {
                                if (!openDownload(item)) {
                                    snackbar.show(openFailed, actionLabel = viewLabel, onAction = { latestOpenDownloads() })
                                }
                            },
                        )
                    }
                    DownloadState.FAILED -> snackbar.show(
                        getString(Res.string.downloads_failed, name),
                        actionLabel = if (latestApi != null) getString(Res.string.downloads_retry_short) else getString(Res.string.downloads_view),
                        onAction = {
                            val currentApi = latestApi
                            if (currentApi != null) center.retry(currentApi, item) else latestOpenDownloads()
                        },
                    )
                    DownloadState.CANCELLED -> snackbar.show(getString(Res.string.downloads_cancelled_toast, name))
                }
            }
        } finally {
            pending.values.forEach { it.cancel() }
        }
    }
}
