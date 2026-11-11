package riffet.ui.app

import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.window.DialogProperties

@OptIn(ExperimentalComposeUiApi::class)
internal actual fun adaptiveDialogProperties(properties: DialogProperties): DialogProperties = DialogProperties(
    dismissOnBackPress = properties.dismissOnBackPress,
    dismissOnClickOutside = properties.dismissOnClickOutside,
    usePlatformDefaultWidth = false,
    usePlatformInsets = false,
    useSoftwareKeyboardInset = properties.useSoftwareKeyboardInset,
    scrimColor = properties.scrimColor,
    animateTransition = properties.animateTransition,
)
