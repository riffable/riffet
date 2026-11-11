package riffet.ui.platform

import androidx.compose.runtime.Composable

/* The shipping iOS app is native SwiftUI and picks avatars with PHPicker; this Compose host has no picker. */
@Composable
actual fun rememberAvatarPicker(onError: (String) -> Unit, onPicked: (PreparedAvatar) -> Unit): AvatarPicker = UnavailableAvatarPicker
