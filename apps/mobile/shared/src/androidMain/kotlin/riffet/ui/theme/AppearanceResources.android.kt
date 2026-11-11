package riffet.ui.theme

import android.graphics.BitmapFactory
import android.graphics.Typeface
import android.graphics.fonts.Font as NativeFont
import android.graphics.fonts.FontFamily as NativeFontFamily
import android.graphics.fonts.FontStyle as NativeFontStyle
import android.os.Build
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import com.github.khoben.libwoff2dec.Woff2Decoder
import java.io.File
import java.security.MessageDigest
import java.util.Locale
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import riffet.contracts.AppearanceAsset
import riffet.contracts.AppearanceFont
import riffet.shared.RiffetAndroid
import riffet.shared.RiffetApi
import riffet.shared.appearanceAsset
import riffet.shared.serverOrigin

private const val MAX_FONT_BYTES = 16 * 1024 * 1024L
private const val MAX_EXPANDED_BYTES = 32 * 1024 * 1024L
private val appearanceLock = Mutex()
private fun digest(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
private fun root(scopeKey: String): File = File(RiffetAndroid.requireContext().noBackupFilesDir,
    "appearance-resources/" + digest(scopeKey.encodeToByteArray())).apply { mkdirs() }
internal actual fun appearanceLocaleTag(): String = Locale.getDefault().toLanguageTag()
internal actual suspend fun platformAppearanceScope(api: RiffetApi): String? = withContext(Dispatchers.IO) {
    val origin = serverOrigin(api.baseUrl) ?: return@withContext null
    val identity = api.resourceHeaders(api.baseUrl)["Authorization"] ?: "anonymous"
    digest((origin + "\n" + identity).encodeToByteArray())
}

internal actual suspend fun appearanceResourceBytes(api: RiffetApi, scopeKey: String, asset: AppearanceAsset, maxBytes: Long): ByteArray =
    withContext(Dispatchers.IO) { appearanceLock.withLock {
        require(asset.sha256.matches(Regex("[a-f0-9]{64}")) && asset.size in 1..maxBytes)
        require(asset.url.matches(Regex("/api/appearance/assets/[a-z0-9][a-z0-9.-]*/" + asset.sha256)))
        val directory = root(scopeKey)
        val file = File(directory, asset.sha256 + ".asset")
        if (file.isFile && file.length() == asset.size) {
            val cached = file.readBytes()
            if (digest(cached) == asset.sha256) { file.setLastModified(System.currentTimeMillis()); return@withLock cached }
        }
        val bytes = api.appearanceAsset(asset.url, asset.size)
        require(bytes.size.toLong() == asset.size && digest(bytes) == asset.sha256) { "Invalid appearance asset" }
        val temporary = File.createTempFile("asset-", ".tmp", directory)
        try {
            temporary.outputStream().use { it.write(bytes) }
            check(temporary.renameTo(file)) { "Cannot cache appearance asset" }
        } finally { temporary.delete() }
        var total = directory.listFiles()?.sumOf { it.length() } ?: 0L
        directory.listFiles().orEmpty().filter { it != file }.sortedBy { it.lastModified() }.forEach {
            if (total > 128 * 1024 * 1024L) { val size = it.length(); if (it.delete()) total -= size }
        }
        bytes
    } }

private data class FontFile(val file: File, val weight: Int, val italic: Boolean, val variable: Boolean)
internal actual suspend fun loadAppearanceFont(api: RiffetApi, scopeKey: String, font: AppearanceFont): FontFamily = withContext(Dispatchers.IO) {
    require(font.files.isNotEmpty() && font.files.size <= 64 && font.files.sumOf { it.size } <= MAX_FONT_BYTES)
    val directory = root(scopeKey)
    var expandedTotal = 0L
    val files = mutableListOf<FontFile>()
    for (entry in font.files) {
        require(entry.type == "font/woff2")
        val bytes = appearanceResourceBytes(api, scopeKey, AppearanceAsset(entry.url, entry.sha256, entry.size, entry.type), MAX_FONT_BYTES)
        val expanded = validateWoff2(bytes)
        expandedTotal += expanded
        require(expandedTotal <= MAX_EXPANDED_BYTES)
        val output = File(directory, entry.sha256 + ".ttf")
        appearanceLock.withLock {
            val checksum = File(directory, entry.sha256 + ".ttf.sha256")
            val cached = output.isFile && output.length() in 1..MAX_EXPANDED_BYTES &&
                checksum.isFile && checksum.length() == 64L && checksum.readText() == digest(output.readBytes())
            if (!cached) {
                val input = File.createTempFile("font-", ".woff2", directory)
                val temporary = File.createTempFile("font-", ".ttf", directory)
                try {
                    input.writeBytes(bytes)
                    val decoded = try { Woff2Decoder.decodeFile(input.path, temporary.path) }
                    catch (failure: LinkageError) { throw IllegalStateException("Font decoder unavailable", failure) }
                    check(decoded) { "Cannot decode WOFF2 font" }
                    require(temporary.length() in 1..MAX_EXPANDED_BYTES)
                    val hash = digest(temporary.readBytes())
                    check(temporary.renameTo(output))
                    checksum.writeText(hash)
                } finally { input.delete(); temporary.delete() }
            }
            output.setLastModified(System.currentTimeMillis())
            checksum.setLastModified(System.currentTimeMillis())
        }
        val weights = entry.weight?.split(Regex("\\s+")).orEmpty().mapNotNull { it.toIntOrNull()?.coerceIn(100, 900) }
        val variable = weights.size == 2 && weights[0] < weights[1]
        val choices = if (variable) ((100..900 step 100).map { it.coerceIn(weights[0], weights[1]) } + weights).distinct()
            else listOf(weights.firstOrNull() ?: 400)
        for (weight in choices) files += FontFile(output, weight, entry.style == "italic", variable)
    }
    if (Build.VERSION.SDK_INT >= 29) {
        val families = mutableListOf<NativeFontFamily.Builder>()
        val styles = mutableListOf<MutableSet<Pair<Int, Boolean>>>()
        for (entry in files) {
            val builder = NativeFont.Builder(entry.file).setWeight(entry.weight).setSlant(if (entry.italic) NativeFontStyle.FONT_SLANT_ITALIC else NativeFontStyle.FONT_SLANT_UPRIGHT)
            if (entry.variable) builder.setFontVariationSettings("'wght' " + entry.weight)
            val value = builder.build()
            val style = entry.weight to entry.italic
            val index = styles.indexOfFirst { style !in it }
            if (index < 0) { families += NativeFontFamily.Builder(value); styles += mutableSetOf(style) }
            else { families[index].addFont(value); styles[index] += style }
        }
        val native = Typeface.CustomFallbackBuilder(families.first().build())
        families.drop(1).forEach { native.addCustomFallback(it.build()) }
        native.setSystemFallback(if (font.role == "mono") "monospace" else "sans-serif")
        FontFamily(native.build())
    } else {
        FontFamily(files.map { Font(it.file, FontWeight(it.weight), if (it.italic) FontStyle.Italic else FontStyle.Normal) })
    }
}

internal actual suspend fun loadAppearanceBackground(bytes: ByteArray): ImageBitmap = withContext(Dispatchers.IO) {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    require(bounds.outWidth in 1..16384 && bounds.outHeight in 1..16384 && bounds.outWidth.toLong() * bounds.outHeight <= 64 * 1024 * 1024L)
    val options = BitmapFactory.Options()
    while (bounds.outWidth.toLong() * bounds.outHeight / (options.inSampleSize.coerceAtLeast(1).toLong() * options.inSampleSize.coerceAtLeast(1)) > 4 * 1024 * 1024L) {
        options.inSampleSize = options.inSampleSize.coerceAtLeast(1) * 2
    }
    requireNotNull(BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)).asImageBitmap()
}
