package riffet.shared

import androidx.compose.runtime.Stable
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.staticCompositionLocalOf

/**
 * What the phone does beyond the web, each one a switch on the settings page. Stored on this
 * device like the theme, never on the server: another phone, or the web, is unaffected.
 */
enum class NativeFeature(internal val key: String, val defaultOn: Boolean) {
    /** A notification when a conversation finishes, fails, stops, or waits for an answer. */
    ALERTS("feature.alerts", true),

    /** Staying up in the background while a conversation is mid-turn, with its progress on show. */
    BACKGROUND_WATCH("feature.background-watch", true),

    /** The closing screen follows the system back gesture before it lets go. */
    PREDICTIVE_BACK("feature.predictive-back", true),

    /** Rightward dragging of an app page; independent of the Android system preview preference. */
    SWIPE_BACK("feature.swipe-back", true),

    /** New transcript rows, and each new chunk of a streaming answer, fade in. */
    FADE_IN("feature.fade-in", true),

    /** A tap felt on send, on answering, and when the open conversation finishes or needs you. */
    HAPTICS("feature.haptics", false),
}

/**
 * False where nothing on this platform acts on the switch — notifications and the back preview
 * live in the Android host — so the settings page does not offer it.
 */
expect val NativeFeature.supported: Boolean

/** The switches' current values; reads are snapshot state, so a flip reaches every reader at once. */
@Stable
class NativeFeatures(private val preferences: AppPreferences?) {
    // The first read may create this instance inside snapshotFlow's read-only snapshot.
    private val values = mutableStateOf(NativeFeature.entries.associateWith { feature ->
        preferences?.string(feature.key)?.toBooleanStrictOrNull() ?: feature.defaultOn
    })

    fun isOn(feature: NativeFeature): Boolean = values.value[feature] ?: feature.defaultOn

    fun set(feature: NativeFeature, on: Boolean) {
        values.value = values.value + (feature to on)
        preferences?.setString(feature.key, on.toString())
    }

    companion object {
        /** The device's switches, shared by the UI and the Android host's notifications. */
        val shared: NativeFeatures by lazy { NativeFeatures(createAppPreferences()) }
    }
}

/** Every switch at its default, unsaved: previews and tests that provide nothing. */
val LocalNativeFeatures = staticCompositionLocalOf { NativeFeatures(null) }
