package riffet.shared

import androidx.compose.runtime.Composable

actual val appLanguageSupported: Boolean = false

actual object AppLanguages {
    actual val current: AppLanguage @Composable get() = AppLanguage.SYSTEM
    actual fun change(language: AppLanguage) = Unit
}

@Composable
internal actual fun AppLanguageEnvironment(content: @Composable () -> Unit) = content()
