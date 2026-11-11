package riffet.ui.app

import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.window.DialogProperties

@OptIn(ExperimentalComposeUiApi::class)
internal actual fun adaptiveDialogProperties(properties: DialogProperties): DialogProperties = DialogProperties(
    dismissOnBackPress = properties.dismissOnBackPress,
    dismissOnClickOutside = properties.dismissOnClickOutside,
    securePolicy = properties.securePolicy,
    usePlatformDefaultWidth = false,
    decorFitsSystemWindows = false,
    windowTitle = properties.windowTitle,
    windowType = properties.windowType,
    windowToken = properties.windowToken,
)
