package riffet.ui.theme

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.os.Build
import android.view.View
import android.view.WindowInsetsController
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.platform.LocalView

/**
 * Android owns a system bar to tint, and this is where the tint follows the palette.
 *
 * `APPEARANCE_LIGHT_STATUS_BARS` does **not** mean "use light icons" — it means "the bar's
 * background is light, so draw dark icons". That inversion is the whole job here, and it is why the
 * flag is set for the light palette and cleared for the dark one.
 *
 * The host's `WindowCompat.enableEdgeToEdge` makes the bars transparent without a system contrast
 * scrim. This function owns their icon appearance, following the palette Compose actually draws.
 */
@Composable
actual fun RiffetSystemBars(darkTheme: Boolean) {
    val view = LocalView.current
    SideEffect {
        // `LocalView.current.context` is frequently a ContextWrapper rather than the Activity (a
        // theme wrapper, a locale wrapper), and `as? Activity` on one of those returns null — which
        // made this whole function a silent no-op depending on how the host was set up.
        val window = view.context.findActivity()?.window ?: return@SideEffect
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val controller = window.insetsController ?: return@SideEffect
            val lightIcons = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or
                WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
            controller.setSystemBarsAppearance(if (darkTheme) 0 else lightIcons, lightIcons)
        } else {
            // The pre-30 flags live on the decor view, which is the one the window actually reads.
            val decor = window.decorView
            @Suppress("DEPRECATION")
            var flags = decor.systemUiVisibility
            @Suppress("DEPRECATION")
            flags = if (darkTheme) {
                // The pre-30 `View` flags are singular (`SYSTEM_UI_FLAG_LIGHT_STATUS_BAR`); only the
                // API-30 `WindowInsetsController` constants are plural.
                flags and View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR.inv() and
                    View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR.inv()
            } else {
                flags or View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR or
                    View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
            }
            @Suppress("DEPRECATION")
            decor.systemUiVisibility = flags
        }
    }
}

private fun Context.findActivity(): Activity? {
    var current: Context? = this
    while (current is ContextWrapper) {
        if (current is Activity) return current
        current = current.baseContext
    }
    return null
}
