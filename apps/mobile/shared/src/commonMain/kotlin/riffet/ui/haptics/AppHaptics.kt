package riffet.ui.haptics

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.hapticfeedback.HapticFeedback
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import riffet.shared.LocalNativeFeatures
import riffet.shared.NativeFeature

/**
 * The app's own haptics (send, answer, a turn ending on screen), silent unless 触觉反馈 is on.
 * The platform's (a long press, a text handle) do not go through here and are untouched.
 */
@Composable
internal fun rememberAppHaptics(): HapticFeedback {
    val system = LocalHapticFeedback.current
    val features = LocalNativeFeatures.current
    return remember(system, features) {
        object : HapticFeedback {
            override fun performHapticFeedback(hapticFeedbackType: HapticFeedbackType) {
                if (features.isOn(NativeFeature.HAPTICS)) system.performHapticFeedback(hapticFeedbackType)
            }
        }
    }
}
