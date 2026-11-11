package riffet.ui.theme

import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.text.font.FontFamily
import riffet.contracts.AppearanceAsset
import riffet.contracts.AppearanceFont
import riffet.shared.RiffetApi
import riffet.shared.appearanceAsset
import java.util.Locale
import java.security.MessageDigest

internal actual fun appearanceLocaleTag(): String = Locale.getDefault().toLanguageTag()
internal actual suspend fun platformAppearanceScope(api: RiffetApi): String? {
    val identity = api.resourceHeaders(api.baseUrl)["Authorization"] ?: "anonymous"
    return MessageDigest.getInstance("SHA-256").digest((api.baseUrl + "\n" + identity).encodeToByteArray()).joinToString("") { "%02x".format(it) }
}
internal actual suspend fun appearanceResourceBytes(api: RiffetApi, scopeKey: String, asset: AppearanceAsset, maxBytes: Long): ByteArray {
    require(asset.sha256.matches(Regex("[a-f0-9]{64}")) && asset.size in 1..maxBytes)
    require(asset.url.matches(Regex("/api/appearance/assets/[a-z0-9][a-z0-9.-]*/" + asset.sha256)))
    val bytes = api.appearanceAsset(asset.url, asset.size)
    require(bytes.size.toLong() == asset.size && MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) } == asset.sha256)
    return bytes
}
internal actual suspend fun loadAppearanceFont(api: RiffetApi, scopeKey: String, font: AppearanceFont): FontFamily = error("Font resources require the Android host")
internal actual suspend fun loadAppearanceBackground(bytes: ByteArray): ImageBitmap = error("Background resources require the Android host")
