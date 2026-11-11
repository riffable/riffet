package riffet.android

import androidx.activity.ComponentActivity
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.platform.LocalConfiguration
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.repeatOnLifecycle
import androidx.window.layout.FoldingFeature
import androidx.window.layout.WindowInfoTracker
import riffet.ui.app.LocalRiffetWindowInfo
import riffet.ui.app.RiffetWindowFold
import riffet.ui.app.RiffetWindowInfo

/** Activity-local collection: no retained Activity or subscription after the host stops. */
@Composable
internal fun RiffetAdaptiveWindow(activity: ComponentActivity, content: @Composable () -> Unit) {
    val configuration = LocalConfiguration.current
    var folds by remember(activity) { mutableStateOf<List<RiffetWindowFold>>(emptyList()) }
    LaunchedEffect(activity) {
        activity.lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            // Extensions can emit immediately, late, or never. The initial empty value safely
            // uses current Compose constraints instead of guessing the device's physical posture.
            WindowInfoTracker.getOrCreate(activity).windowLayoutInfo(activity).collect { layout ->
                folds = layout.displayFeatures.filterIsInstance<FoldingFeature>().map { feature ->
                    val bounds = feature.bounds
                    RiffetWindowFold(
                        bounds = Rect(bounds.left.toFloat(), bounds.top.toFloat(), bounds.right.toFloat(), bounds.bottom.toFloat()),
                        vertical = feature.orientation == FoldingFeature.Orientation.VERTICAL,
                        separating = feature.isSeparating,
                        occluding = feature.occlusionType == FoldingFeature.OcclusionType.FULL,
                        halfOpened = feature.state == FoldingFeature.State.HALF_OPENED,
                    )
                }
            }
        }
    }
    val window = remember(folds, configuration) {
        RiffetWindowInfo(folds = folds, inMultiWindow = activity.isInMultiWindowMode)
    }
    CompositionLocalProvider(LocalRiffetWindowInfo provides window, content = content)
}
