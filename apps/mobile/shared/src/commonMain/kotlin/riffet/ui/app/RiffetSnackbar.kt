package riffet.ui.app

import riffet.ui.design.LocalInterfaceStyle
import androidx.compose.foundation.layout.padding
import riffet_mobile.shared.generated.resources.pickers_close
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.SnackbarVisuals
import androidx.compose.ui.platform.LocalAccessibilityManager
import androidx.compose.runtime.withFrameNanos
import kotlinx.coroutines.delay
import riffet.ui.feedback.FeedbackTiming
import riffet.ui.composer.feedbackNowMillis
import riffet.ui.theme.visualWorkActive
import riffet.ui.theme.rememberVisualWorkVisibility
import riffet.ui.theme.visualWorkVisibility
import kotlin.math.ceil
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

/** One queue for foreground feedback, owned by the app shell rather than a retained page. */
@Stable
internal class RiffetSnackbar(private val scope: CoroutineScope) {
    val hostState = SnackbarHostState()
    private val jobs = mutableSetOf<Job>()
    private val bottomBars = mutableStateMapOf<Any, Dp>()
    val bottomPadding: Dp get() = bottomBars.values.maxOrNull() ?: 0.dp

    fun show(
        message: String,
        actionLabel: String? = null,
        duration: SnackbarDuration = if (actionLabel == null) SnackbarDuration.Short else SnackbarDuration.Long,
        onAction: (() -> Unit)? = null,
    ): Job {
        val job = scope.launch {
            // Material owns queueing and cancellation. The visible host owns a pausable timeout.
            if (hostState.showSnackbar(RiffetSnackbarVisuals(message, actionLabel, duration)) == SnackbarResult.ActionPerformed) {
                onAction?.invoke()
            }
        }
        jobs += job
        job.invokeOnCompletion { jobs -= job }
        return job
    }

    fun clear() { jobs.toList().forEach { it.cancel() } }

    fun bottomBar(owner: Any, height: Dp?) {
        if (height == null) bottomBars.remove(owner) else bottomBars[owner] = height
    }
}

private class RiffetSnackbarVisuals(
    override val message: String,
    override val actionLabel: String?,
    val requestedDuration: SnackbarDuration,
) : SnackbarVisuals {
    override val duration = SnackbarDuration.Indefinite
    override val withDismissAction = requestedDuration == SnackbarDuration.Indefinite
}

internal val LocalRiffetSnackbar = staticCompositionLocalOf<RiffetSnackbar?> { null }

/** Consume success notices once; covered pages must not replay them over the current page. */
@Composable
internal fun SnackbarNotice(message: String?, onConsumed: (String) -> Unit) {
    val snackbar = LocalRiffetSnackbar.current
    val active = LocalPageActive.current
    LaunchedEffect(snackbar, message, active) {
        if (snackbar != null && message != null && active) {
            snackbar.show(message)
            onConsumed(message)
        }
    }
}

/** Keep feedback above active bottom controls, including a multiline composer or pending question. */
@Composable
internal fun Modifier.snackbarBottomBar(): Modifier {
    val snackbar = LocalRiffetSnackbar.current ?: return this
    val active = LocalPageActive.current
    val density = LocalDensity.current
    val owner = remember { Any() }
    var height by remember { mutableStateOf(0.dp) }
    SideEffect { snackbar.bottomBar(owner, if (active) height else null) }
    DisposableEffect(snackbar, owner) {
        onDispose { snackbar.bottomBar(owner, null) }
    }
    return onSizeChanged { height = with(density) { it.height.toDp() } }
}

/** Preserve Material's queue and recommended timeout while pausing when the host is hidden. */
@Composable
internal fun StyleSnackbar(data: androidx.compose.material3.SnackbarData) {
    val requestedDuration = (data.visuals as? RiffetSnackbarVisuals)?.requestedDuration ?: data.visuals.duration
    val duration = when (requestedDuration) {
        SnackbarDuration.Short -> 4000L
        SnackbarDuration.Long -> 10000L
        SnackbarDuration.Indefinite -> null
    }
    val accessibility = LocalAccessibilityManager.current
    val recommended = duration?.let {
        accessibility?.calculateRecommendedTimeoutMillis(it, containsIcons = true, containsText = true, containsControls = data.visuals.actionLabel != null) ?: it
    }
    val clock = remember(data, recommended) { recommended?.let { FeedbackTiming(it.toDouble() + 200.0) } }
    val visibility = rememberVisualWorkVisibility()
    val active = visualWorkActive(visibility.visible)
    LaunchedEffect(data, active, clock) {
        val timing = clock ?: return@LaunchedEffect
        timing.update(feedbackNowMillis(), false)
        if (!active) return@LaunchedEffect
        withFrameNanos { }
        try {
            timing.update(feedbackNowMillis(), true)
            delay(ceil(timing.remainingMillis).toLong().coerceAtLeast(1L))
            timing.update(feedbackNowMillis(), true)
            if (timing.complete) data.dismiss()
        } finally {
            timing.update(feedbackNowMillis(), false)
        }
    }
    val metrics = LocalInterfaceStyle.current.metrics
    val colors = riffet.ui.theme.LocalRiffetColors.current
    val shape = androidx.compose.foundation.shape.RoundedCornerShape(riffet.ui.design.LocalInterfaceStyle.current.menuRadius)
    androidx.compose.material3.Snackbar(
        modifier = Modifier.padding(metrics.controlInset).visualWorkVisibility(visibility),
        shape = shape,
        containerColor = riffet.ui.design.LocalRiffetSurfaces.current.floating,
        contentColor = colors.fg,
        action = data.visuals.actionLabel?.let { label -> {
            riffet.ui.design.RiffetTextButton(onClick = data::performAction) {
                androidx.compose.material3.Text(label, style = riffet.ui.theme.LocalRiffetTypography.current.button)
            }
        } },
        dismissAction = if (data.visuals.withDismissAction) ({
            riffet.ui.design.RiffetIconButton(onClick = data::dismiss) {
                riffet.ui.icons.Icon(riffet.ui.icons.RiffetIcons.Close,
                    org.jetbrains.compose.resources.stringResource(riffet_mobile.shared.generated.resources.Res.string.pickers_close))
            }
        }) else null,
    ) { androidx.compose.material3.Text(data.visuals.message, style = riffet.ui.theme.LocalRiffetTypography.current.bodySmall) }
}
