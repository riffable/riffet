package riffet.ui.platform

import androidx.compose.runtime.Composable

@Composable
actual fun rememberAvatarPicker(onError: (String) -> Unit, onPicked: (PreparedAvatar) -> Unit): AvatarPicker = UnavailableAvatarPicker
