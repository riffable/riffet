package riffet.shared

/** The desktop build has no notification host and no system back gesture. */
actual val NativeFeature.supported: Boolean
    get() = when (this) {
        NativeFeature.ALERTS, NativeFeature.BACKGROUND_WATCH, NativeFeature.PREDICTIVE_BACK -> false
        NativeFeature.FADE_IN, NativeFeature.HAPTICS, NativeFeature.SWIPE_BACK -> true
    }
