package riffet.shared

import androidx.compose.runtime.Composable

/** Interface language is a device preference; conversation content keeps its original language. */
enum class AppLanguage(val tag: String) {
    SYSTEM(""),
    CHINESE("zh-Hans"),
    ENGLISH("en"),
}

expect val appLanguageSupported: Boolean

expect object AppLanguages {
    val current: AppLanguage @Composable get
    fun change(language: AppLanguage)
}

@Composable
internal expect fun AppLanguageEnvironment(content: @Composable () -> Unit)
