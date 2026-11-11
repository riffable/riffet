package riffet.ui.theme

import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.text.font.FontFamily
import riffet.contracts.AppearanceAsset
import riffet.contracts.AppearanceFont
import riffet.shared.RiffetApi
import platform.Foundation.NSLocale
import platform.Foundation.currentLocale
import platform.Foundation.localeIdentifier

internal actual fun appearanceLocaleTag(): String = NSLocale.currentLocale.localeIdentifier.replace('_', '-')
internal actual suspend fun platformAppearanceScope(api: RiffetApi): String? = null
internal actual suspend fun appearanceResourceBytes(api: RiffetApi, scopeKey: String, asset: AppearanceAsset, maxBytes: Long): ByteArray = error("Appearance resources require the Android host")
internal actual suspend fun loadAppearanceFont(api: RiffetApi, scopeKey: String, font: AppearanceFont): FontFamily = error("Appearance resources require the Android host")
internal actual suspend fun loadAppearanceBackground(bytes: ByteArray): ImageBitmap = error("Appearance resources require the Android host")
